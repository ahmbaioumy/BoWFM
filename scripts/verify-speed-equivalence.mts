/**
 * Differential harness for Phase S (calendar day-window cache): the PRE-change engine (git rev below, extracted
 * to a temp dir at run time, never stored in the repo) and the CURRENT engine must produce BIT-IDENTICAL output.
 * Test tooling only — never reaches the bundle. Opt-in (a few minutes): `npm run test:speed-equiv`.
 *
 * What it does: for every grid cell, runs runBackofficeDES and searchOptimalHC through both engines on fresh,
 * identical inputs and deep-compares the FULL results (Dates by time, Maps/Sets/typed arrays by content,
 * numbers with Object.is so -0 / NaN differences count). Zero diffs required.
 * Grid: default Mon-Fri, 24x7, 24:00 close, window ending at midnight (20:00-24:00), 08:30-17:45 on Sun-Thu;
 * clockBasis x clockStartPolicy (4), min coverage ON/OFF, with/without a staggered start distribution,
 * a mid-horizon holiday on every calendar, opening backlog on one variant.
 * Runs in child processes under Europe/London, America/New_York (both have DST) and Etc/GMT-4 (no DST). In a DST
 * zone the tested horizon MUST contain a 23h or 25h local day, otherwise the child throws (so a mis-set TZ or a
 * moved fixture can never pass silently).
 *
 * Usage: npx tsx scripts/verify-speed-equivalence.mts [--quick] [--tz Europe/London,...] [--rev <git rev>]
 *   --quick  runBackofficeDES grid only (skips the searchOptimalHC grid)
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const isChild = argv.includes('--child');
const quick = argv.includes('--quick');
const BASELINE_REV = flag('--rev') ?? '873fe25'; // last commit before Phase S
const root = resolve(import.meta.dirname, '..');
const ZONES: Array<{ tz: string; dst: boolean }> = [
  { tz: 'Europe/London', dst: true },
  { tz: 'America/New_York', dst: true },
  { tz: 'Etc/GMT-4', dst: false },
];

// ------------------------------------------------------------------------------------------------ parent
if (!isChild) {
  const tzFilter = flag('--tz')?.split(',');
  const zones = ZONES.filter((z) => !tzFilter || tzFilter.includes(z.tz));
  const tmp = mkdtempSync(join(tmpdir(), 'bowfm-speedeq-'));
  const tarFile = join(tmp, 'base.tar');
  const baseDir = join(tmp, 'base');
  execFileSync('git', ['archive', '--format=tar', `--output=${tarFile}`, BASELINE_REV, 'src'], { cwd: root });
  execFileSync('node', ['-e', `require('fs').mkdirSync(${JSON.stringify(baseDir)},{recursive:true})`]);
  execFileSync('tar', ['-xf', 'base.tar', '-C', 'base'], { cwd: tmp }); // relative paths: GNU tar reads 'C:' as a host
  const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!existsSync(tsxCli)) throw new Error(`tsx not found at ${tsxCli}`);
  console.log(`Baseline engine = git ${BASELINE_REV} (extracted to ${baseDir})`);
  const runZone = (z: { tz: string; dst: boolean }) => new Promise<{ ok: boolean; line: string }>((done) => {
    const args = [tsxCli, resolve(import.meta.filename), '--child', '--base', baseDir, ...(z.dst ? ['--dst'] : []), ...(quick ? ['--quick'] : [])];
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, TZ: z.tz }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); if (argv.includes('--verbose')) process.stderr.write(d); });
    child.on('close', (code) => {
      const last = out.trim().split('\n').filter((l) => l.startsWith('RESULT ')).pop();
      if (code !== 0 || !last) return done({ ok: false, line: `${z.tz}: FAILED (exit ${code})\n${out.trim().split('\n').slice(-12).join('\n')}\n${err.trim().split('\n').slice(-8).join('\n')}` });
      const r = JSON.parse(last.slice(7));
      done({ ok: r.diffs === 0, line: `${z.tz}: ${r.desCases} DES cases + ${r.searchCases} search cases, diffs=${r.diffs} (non-trivial results ${r.nonTrivial}, both-threw ${r.bothThrew}), DST-length days seen=${r.oddDays} (${r.sec}s)${r.diffs ? '\n' + r.firstDiffs.join('\n') : ''}` });
    });
  });
  const results = await Promise.all(zones.map(runZone));
  rmSync(tmp, { recursive: true, force: true });
  for (const r of results) console.log(r.line);
  const ok = results.every((r) => r.ok);
  console.log(ok ? '\nSPEED-EQUIVALENCE: PASS (old engine == new engine, bit-identical, all zones)' : '\nSPEED-EQUIVALENCE: FAIL');
  process.exit(ok ? 0 : 1);
}

// ------------------------------------------------------------------------------------------------ child
const baseDir = flag('--base')!;
const expectDst = argv.includes('--dst');
const only = flag('--only'); // debug: run only search cells whose label contains this
const engineOnly = flag('--engine'); // debug: 'old' | 'new' = run that engine alone, no comparison
const t0 = Date.now();
const oldDes: any = await import(pathToFileURL(join(baseDir, 'src/utils/des-engine.ts')).href);
const oldSearch: any = await import(pathToFileURL(join(baseDir, 'src/utils/hc-search.ts')).href);
const newDes: any = await import('../src/utils/des-engine');
const newSearch: any = await import('../src/utils/hc-search');
const { DEFAULT_CATEGORIES, DEFAULT_LABOR, DEFAULT_SLA } = await import('../src/utils/default-config');
import type { CalendarConfig, OpeningWIPCase, ShiftDistributionByCategory, StandardInterval } from '../src/types/wfm';

// ---- deep equality (bit-exact)
function diffPath(a: any, b: any, path: string, out: string[]): void {
  if (out.length >= 5) return;
  if (typeof a === 'function' || typeof b === 'function') return; // closures are not data
  if (typeof a === 'number' || typeof b === 'number') { if (!Object.is(a, b)) out.push(`${path}: ${a} != ${b}`); return; }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') { if (!Object.is(a, b)) out.push(`${path}: ${String(a)} != ${String(b)}`); return; }
  if (a instanceof Date || b instanceof Date) {
    if (!(a instanceof Date && b instanceof Date) || !Object.is(a.getTime(), b.getTime())) out.push(`${path}: date ${a instanceof Date ? a.getTime() : a} != ${b instanceof Date ? b.getTime() : b}`);
    return;
  }
  if (Array.isArray(a) !== Array.isArray(b)) { out.push(`${path}: array/object mismatch`); return; }
  if (Array.isArray(a)) {
    if (a.length !== b.length) { out.push(`${path}.length: ${a.length} != ${b.length}`); return; }
    for (let i = 0; i < a.length; i++) diffPath(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    const x = a as any, y = b as any;
    if (x.length !== y.length) { out.push(`${path}.length`); return; }
    for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) { out.push(`${path}[${i}]: ${x[i]} != ${y[i]}`); return; }
    return;
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) { out.push(`${path}: Map size`); return; }
    for (const [k, v] of a) { if (!b.has(k)) { out.push(`${path}: Map key ${String(k)} missing`); return; } diffPath(v, b.get(k), `${path}.get(${String(k)})`, out); }
    return;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) { out.push(`${path}: Set size`); return; }
    for (const k of a) if (!b.has(k)) { out.push(`${path}: Set member ${String(k)} missing`); return; }
    return;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length || ka.some((k) => !(k in b))) {
    out.push(`${path}: keys differ [${ka.filter((k) => !(k in b)).join(',')}] vs [${kb.filter((k) => !(k in a)).join(',')}]`);
    return;
  }
  for (const k of ka) diffPath(a[k], b[k], `${path}.${k}`, out);
}

// ---- fixtures (built fresh per call: no object is ever shared between the two engines)
interface Win { name: string; start: Date; days: number }
function windows(): Win[] {
  const tz = process.env.TZ ?? '';
  const spring = tz === 'America/New_York' ? new Date(2026, 2, 2) : new Date(2026, 2, 23); // NY DST Sun 8 Mar; London Sun 29 Mar
  const fall = tz === 'America/New_York' ? new Date(2026, 9, 26) : new Date(2026, 9, 19); // NY Sun 1 Nov; London Sun 25 Oct
  return [{ name: 'spring', start: spring, days: 14 }, { name: 'fall', start: fall, days: 14 }];
}
const localKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function countOddDays(w: Win): number {
  let odd = 0;
  for (let i = 0; i < w.days + 5; i++) {
    const a = new Date(w.start); a.setDate(a.getDate() + i); a.setHours(0, 0, 0, 0);
    const b = new Date(a); b.setDate(b.getDate() + 1); b.setHours(0, 0, 0, 0);
    const hrs = (b.getTime() - a.getTime()) / 3600000;
    if (Math.abs(hrs - 24) > 1e-9) odd++;
  }
  return odd;
}

interface CalSpec { name: string; cal: () => CalendarConfig; hours: number; open: boolean[] /* per weekday 0..6 has demand */ }
const holidayOn = (w: Win, dayIdx: number) => { const d = new Date(w.start); d.setDate(d.getDate() + dayIdx); return localKey(d); };
function calSpecs(w: Win): CalSpec[] {
  const hol = () => [holidayOn(w, 9), holidayOn(w, 6)]; // a mid-horizon weekday + (for most zones) the DST Sunday
  return [
    { name: 'mon-fri 8-18', hours: 10, open: [false, true, true, true, true, true, false], cal: () => ({ workingDays: [1, 2, 3, 4, 5], dailyOpenHour: 8, dailyOpenMinute: 0, dailyCloseHour: 18, dailyCloseMinute: 0, holidays: hol() }) },
    { name: '24x7', hours: 24, open: [true, true, true, true, true, true, true], cal: () => ({ is24x7: true, workingDays: [0, 1, 2, 3, 4, 5, 6], dailyOpenHour: 0, dailyOpenMinute: 0, dailyCloseHour: 24, dailyCloseMinute: 0, holidays: hol() }) },
    { name: 'close 24:00 (06-24)', hours: 18, open: [false, true, true, true, true, true, true], cal: () => ({ workingDays: [1, 2, 3, 4, 5, 6], dailyOpenHour: 6, dailyOpenMinute: 0, dailyCloseHour: 24, dailyCloseMinute: 0, holidays: hol() }) },
    { name: 'window to midnight (20-24)', hours: 4, open: [true, true, true, true, true, true, true], cal: () => ({ workingDays: [0, 1, 2, 3, 4, 5, 6], dailyOpenHour: 20, dailyOpenMinute: 0, dailyCloseHour: 0, dailyCloseMinute: 0, holidays: hol() }) },
    { name: 'sun-thu 08:30-17:45', hours: 9.25, open: [true, true, true, true, true, false, false], cal: () => ({ workingDays: [0, 1, 2, 3, 4], dailyOpenHour: 8, dailyOpenMinute: 30, dailyCloseHour: 17, dailyCloseMinute: 45, holidays: hol() }) },
  ];
}
function makeIntervals(w: Win, spec: CalSpec): StandardInterval[] {
  const cats = DEFAULT_CATEGORIES.slice(0, 2).map((c) => c.name);
  const out: StandardInterval[] = [];
  let idx = 0;
  for (let d = 0; d < w.days; d++) {
    for (let slot = 0; slot < 48; slot++) {
      const start = new Date(w.start); start.setDate(start.getDate() + d); start.setHours(0, slot * 30, 0, 0);
      const end = new Date(start.getTime() + 30 * 60000);
      const h = start.getHours() + start.getMinutes() / 60;
      const dow = start.getDay();
      // demand lands in business hours on open weekdays, plus a thin off-hours trickle (exercises next_open vs arrival)
      const inBiz = spec.open[dow] && (spec.hours >= 24 || (h >= (spec.name.startsWith('window to midnight') ? 20 : spec.name.startsWith('close 24') ? 6 : 8) && h < (spec.name.startsWith('window to midnight') ? 24 : spec.name.startsWith('close 24') ? 24 : 18)));
      cats.forEach((category, ci) => {
        const vol = inBiz ? ((d * 7 + slot * 3 + ci * 5) % 4) : ((d + slot + ci) % 11 === 0 ? 1 : 0);
        if (vol > 0) out.push({ intervalIndex: idx++, start, end, volume: vol * (spec.hours <= 4 ? 4 : 1), category });
      });
    }
  }
  return out;
}
function backlog(w: Win): OpeningWIPCase[] {
  const a = new Date(w.start); a.setDate(a.getDate() - 2); a.setHours(15, 20, 0, 0);
  const c = DEFAULT_CATEGORIES[0].name;
  return [0, 1, 2, 3].map((i) => ({ id: `W${i}`, category: c, arrival: new Date(a.getTime() + i * 5400000), remainingWorkMinutes: 20 + i * 5 } as OpeningWIPCase));
}
interface Var { name: string; clockBasis: 'business_time' | 'wall_clock'; clockStartPolicy: 'arrival' | 'next_open'; minCov: boolean; dist: boolean; wip: boolean; hc: number }
function vars(): Var[] {
  const v: Var[] = [];
  for (const [clockBasis, clockStartPolicy] of [['business_time', 'arrival'], ['business_time', 'next_open'], ['wall_clock', 'arrival'], ['wall_clock', 'next_open']] as const)
    for (const minCov of [true, false]) for (const dist of [false, true])
      v.push({ name: `${clockBasis}/${clockStartPolicy}/minCov=${minCov}/dist=${dist}`, clockBasis, clockStartPolicy, minCov, dist, wip: clockStartPolicy === 'next_open' && !dist, hc: 5 });
  return v;
}
function laborFor(spec: CalSpec) { return { ...DEFAULT_LABOR, dailyProductiveHours: Math.min(DEFAULT_LABOR.dailyProductiveHours, spec.hours - 0.5) }; }
function slaFor(v: Var) { return { ...DEFAULT_SLA, clockBasis: v.clockBasis, clockStartPolicy: v.clockStartPolicy, minCoverageEnabled: v.minCov } as any; }
function distFor(spec: CalSpec, hc: number): ShiftDistributionByCategory {
  const offsets = spec.hours >= 18 ? [0, 120, 360] : spec.hours > 4.5 ? [0, 60] : [0, 30];
  const slaps = offsets.map((o, i) => ({ startMinutesFromOpen: o, agentCount: i === 0 ? hc - (offsets.length - 1) : 1 }));
  return { __POOLED__: { slapMinutes: 30, slaps } } as ShiftDistributionByCategory;
}

let desCases = 0, searchCases = 0, diffs = 0, oddDays = 0, bothThrew = 0, nonTrivial = 0;
const firstDiffs: string[] = [];
function compare(label: string, a: any, b: any) {
  const out: string[] = [];
  diffPath(a, b, 'result', out);
  if (out.length) { diffs++; if (firstDiffs.length < 12) firstDiffs.push(`  DIFF ${label}: ${out.slice(0, 3).join(' ; ')}`); }
}
function guarded<T>(f: () => T): { ok: true; v: T } | { ok: false; e: string } { try { return { ok: true, v: f() }; } catch (e) { return { ok: false, e: String((e as Error).message) }; } }

const wins = windows();
for (const w of wins) {
  const odd = countOddDays(w);
  oddDays += odd;
  if (expectDst && odd === 0) throw new Error(`TZ ${process.env.TZ}: window ${w.name} (${localKey(w.start)} +${w.days}d) has no 23h/25h day - fixture or TZ is wrong, equivalence NOT proven`);
  if (!expectDst && odd !== 0) throw new Error(`TZ ${process.env.TZ}: expected a no-DST zone but window ${w.name} has ${odd} odd-length days`);
}
if (new Date(2026, 6, 1).getTimezoneOffset() === new Date(2026, 0, 1).getTimezoneOffset() === expectDst) throw new Error(`TZ ${process.env.TZ}: DST expectation (${expectDst}) contradicts the runtime offsets`);

for (const w of engineOnly ? [] : wins) {
  for (const specTemplate of calSpecs(w)) {
    for (const v of vars()) {
      // ---- runBackofficeDES (case generation inside; both dispatch paths; coverage sampling)
      const mk = () => ({
        operationalHC: v.hc, intervals: makeIntervals(w, specTemplate), openingWIP: v.wip ? backlog(w) : [],
        categories: DEFAULT_CATEGORIES.slice(0, 2).map((c) => ({ ...c })), calendar: specTemplate.cal(), labor: laborFor(specTemplate),
        sla: slaFor(v), seed: 12345, queueArchitecture: 'pooled' as const,
        shiftDistribution: v.dist ? distFor(specTemplate, v.hc) : undefined,
      });
      const ro = guarded(() => oldDes.runBackofficeDES(mk()));
      const rn = guarded(() => newDes.runBackofficeDES(mk()));
      desCases++;
      const label = `DES ${w.name} ${specTemplate.name} ${v.name}`;
      if (ro.ok !== rn.ok) { diffs++; firstDiffs.push(`  DIFF ${label}: threw in one engine only (${ro.ok ? 'new' : 'old'}: ${(ro as any).e ?? (rn as any).e})`); }
      else if (!ro.ok && !rn.ok) { bothThrew++; if ((ro as any).e !== (rn as any).e) { diffs++; firstDiffs.push(`  DIFF ${label}: different errors`); } }
      else { if ((ro as any).v.caseResults?.length > 0) nonTrivial++; compare(label, (ro as any).v, (rn as any).v); }
    }
  }
}

if (!quick) {
  // searchOptimalHC is the expensive path (many DES runs per search): a trimmed 10-day horizon (still containing the DST day) and 4 variants.
  const w = { ...wins[0], days: 10 }, wf = { ...wins[1], days: 10 };
  for (const [win, specTemplate] of [[w, calSpecs(w)[0]], [w, calSpecs(w)[1]], [w, calSpecs(w)[2]], [wf, calSpecs(wf)[3]], [wf, calSpecs(wf)[4]]] as Array<[Win, CalSpec]>) {
    if (expectDst && countOddDays(win) === 0) throw new Error(`TZ ${process.env.TZ}: trimmed search window ${win.name} has no 23h/25h day`);
    const all = vars();
    const pick = (basis: string, pol: string, minCov: boolean) => all.find((x) => x.clockBasis === basis && x.clockStartPolicy === pol && x.minCov === minCov && !x.dist)!;
    const cells: Array<[Var, boolean]> = [[pick('business_time', 'arrival', true), false], [pick('business_time', 'next_open', true), false], [pick('wall_clock', 'next_open', false), false], [pick('business_time', 'next_open', true), true]];
    for (const [v, placement] of cells) {
      const mk = () => ({
        intervals: makeIntervals(win, specTemplate), openingWIP: v.wip ? backlog(win) : [],
        categories: DEFAULT_CATEGORIES.slice(0, 2).map((c) => ({ ...c })), calendar: specTemplate.cal(),
        labor: { ...laborFor(specTemplate), ...(placement ? { shiftPlacementEnabled: true, shiftSlapMinutes: 30 } : {}) },
        sla: slaFor(v), seed: 777, userMaxHC: 60, replications: 3, queueArchitecture: 'pooled' as const,
      });
      const label = `SEARCH ${win.name} ${specTemplate.name} ${v.name}${placement ? '/placement' : ''}`;
      const tc = Date.now();
      if (only && !label.includes(only)) continue;
      if (engineOnly) { process.stderr.write(`[${engineOnly}] start ${label}
`); const r = guarded(() => (engineOnly === 'old' ? oldSearch : newSearch).searchOptimalHC(mk())); process.stderr.write(`[${engineOnly}] done ${r.ok ? 'rec=' + (r as any).v.recommendedHC : (r as any).e} ${Date.now() - tc}ms
`); continue; }
      const ro = guarded(() => oldSearch.searchOptimalHC(mk()));
      const rn = guarded(() => newSearch.searchOptimalHC(mk()));
      searchCases++;
      process.stderr.write(`[${process.env.TZ}] ${label} ${Math.round((Date.now() - tc) / 100) / 10}s
`);
      if (ro.ok !== rn.ok) { diffs++; firstDiffs.push(`  DIFF ${label}: threw in one engine only`); }
      else if (!ro.ok && !rn.ok) { bothThrew++; if ((ro as any).e !== (rn as any).e) { diffs++; firstDiffs.push(`  DIFF ${label}: different errors`); } }
      else { if ((ro as any).v.recommendedHC != null) nonTrivial++; compare(label, (ro as any).v, (rn as any).v); }
    }
  }
}

console.log('RESULT ' + JSON.stringify({ tz: process.env.TZ, desCases, searchCases, diffs, oddDays, bothThrew, nonTrivial, firstDiffs, sec: Math.round((Date.now() - t0) / 1000) }));
process.exit(diffs === 0 ? 0 : 1);
