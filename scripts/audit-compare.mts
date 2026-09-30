/**
 * Sample-file audit regression check (test tooling only — never reaches the bundle).
 *
 * Re-runs the audit cells listed in a baseline JSONL (default: every file x cell in it — 4 files x
 * 6 cells = 24) by spawning scripts/audit-sample-hc.mts once per cell with bounded parallelism, then
 * diffs EVERY field of each fresh row against the baseline row keyed by (file, cell). Prints a table
 * and exits 1 on any difference or missing row. Opt-in (~30 min): `npm run test:audit`.
 *
 * Usage: npx tsx scripts/audit-compare.mts <baseline.jsonl> [--jobs 6] [--files a.csv,b.csv] [--cells BA,PON]
 * (--files / --cells narrow the run, e.g. a single-cell smoke run; the default is the full baseline.)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const baselinePath = args.find((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));
if (!baselinePath) throw new Error('usage: audit-compare.mts <baseline.jsonl> [--jobs N] [--files a.csv,b.csv] [--cells BA,PON]');
const jobs = Math.max(1, Number(flag('--jobs') ?? 6));
const fileFilter = flag('--files')?.split(',');
const cellFilter = flag('--cells')?.split(',');

const root = resolve(import.meta.dirname, '..');
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const auditScript = join(root, 'scripts', 'audit-sample-hc.mts');
if (!existsSync(tsxCli)) throw new Error(`tsx not found at ${tsxCli} (run npm install)`);

type Row = Record<string, unknown>;
const readRows = (path: string): Row[] =>
  readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as Row);
/** Stable stringify (sorted keys) so field order never causes a false diff. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val);

const baseline = readRows(resolve(baselinePath)).filter(
  (r) => (!fileFilter || fileFilter.includes(String(r.file))) && (!cellFilter || cellFilter.includes(String(r.cell))),
);
if (baseline.length === 0) throw new Error('no baseline rows match the --files / --cells filter');

const tmp = mkdtempSync(join(tmpdir(), 'bowfm-audit-'));
const runCell = (file: string, cell: string, idx: number): Promise<{ row?: Row; error?: string }> =>
  new Promise((done) => {
    const out = join(tmp, `${idx}.jsonl`);
    // node + tsx's cli.mjs (not the .bin shim): identical on Windows/POSIX, no shell, safe with spaces in paths.
    const child = spawn(process.execPath, [tsxCli, auditScript, out, file, cell], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (e) => done({ error: String(e) }));
    child.on('close', (code) => {
      if (code !== 0 || !existsSync(out)) return done({ error: `exit ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}` });
      done({ row: readRows(out)[0] });
    });
  });

const results: Array<{ base: Row; fresh?: Row; error?: string; ms: number }> = new Array(baseline.length);
let next = 0;
const worker = async () => {
  for (;;) {
    const i = next++;
    if (i >= baseline.length) return;
    const t = Date.now();
    const base = baseline[i];
    const r = await runCell(String(base.file), String(base.cell), i);
    results[i] = { base, fresh: r.row, error: r.error, ms: Date.now() - t };
    console.log(`  done ${base.file} ${base.cell} (${((Date.now() - t) / 1000).toFixed(0)}s)`);
  }
};
console.log(`Audit compare: ${baseline.length} cell(s), ${jobs} parallel, baseline ${baselinePath}`);
await Promise.all(Array.from({ length: Math.min(jobs, baseline.length) }, worker));
rmSync(tmp, { recursive: true, force: true });

let diffCount = 0;
console.log('\nfile                         cell  status   detail');
for (const r of results) {
  const label = `${String(r.base.file).padEnd(28)} ${String(r.base.cell).padEnd(5)}`;
  if (!r.fresh) {
    diffCount++;
    console.log(`${label} ERROR    ${r.error}`);
    continue;
  }
  const fields = Array.from(new Set([...Object.keys(r.base), ...Object.keys(r.fresh)])).sort();
  const diffs = fields.filter((f) => canon(r.base[f]) !== canon(r.fresh![f]));
  if (diffs.length === 0) console.log(`${label} same`);
  else {
    diffCount++;
    console.log(`${label} DIFF     ${diffs.map((f) => `${f}: ${canon(r.base[f])} -> ${canon(r.fresh![f])}`).join('; ')}`);
  }
}
console.log(`\n${diffCount === 0 ? 'PASS' : 'FAIL'}: ${baseline.length - diffCount}/${baseline.length} cells identical to baseline`);
if (diffCount > 0) process.exitCode = 1;
