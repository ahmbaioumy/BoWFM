/**
 * Trusted-source ground-truth benchmark runner.
 *
 * Reads trusted-source-validation.json at runtime (the JSON stays the single
 * authoritative source of scenario data — nothing here is hardcoded) and
 * exercises the real engine entry points against it, grouping pass/fail by
 * authority tier (T0 invariant / T1 domain algebra / T2 hand-traced DES /
 * T3 characterization) so a T0 failure reads as "the engine is wrong" while
 * a T3 failure reads as "behavior drifted from a documented convention."
 *
 * Run: npx tsx scripts/verify-trusted-source.mts
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  computeAnalyticalNMin,
  searchOptimalHC,
  searchOptimalHCAsync,
  calculateStaffingRequirement,
  effectivePrimaryTarget,
} from '../src/utils/hc-search';
import { runBackofficeDES, allocateAgentsToCategories } from '../src/utils/des-engine';

let passedTests = 0;
let failedTests = 0;
const tierCounts: Record<string, { pass: number; fail: number }> = {};

function assert(condition: boolean, testName: string, tier: string | undefined, detail?: string) {
  const t = tier || 'untiered';
  if (!tierCounts[t]) tierCounts[t] = { pass: 0, fail: 0 };
  if (condition) {
    console.log(`  ✓ PASS [${t}]: ${testName}`);
    passedTests++;
    tierCounts[t].pass++;
  } else {
    console.error(`  ✗ FAIL [${t}]: ${testName}${detail ? ` - ${detail}` : ''}`);
    failedTests++;
    tierCounts[t].fail++;
  }
}

function approx(a: number, b: number, tol = 1e-6): boolean {
  return Math.abs(a - b) <= tol;
}

// ---------------------------------------------------------------
// TZ guard
// ---------------------------------------------------------------
const hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

// ---------------------------------------------------------------
// Helpers: convert JSON date literals / intervals to engine types
// ---------------------------------------------------------------
function toIntervals(raw: any[]): any[] {
  return raw.map((i) => ({ ...i, start: new Date(i.start), end: new Date(i.end) }));
}

function toOpeningWIP(raw: any[] | undefined): any[] {
  return (raw || []).map((w) => ({ ...w, arrival: w.arrival ? new Date(w.arrival) : undefined }));
}

// ---------------------------------------------------------------
// Load the trust file
// ---------------------------------------------------------------
const trustPath = resolve(process.cwd(), 'trusted-source-validation.json');
const trust: any = JSON.parse(readFileSync(trustPath, 'utf-8'));

console.log('\n==================================================');
console.log('  TRUSTED-SOURCE GROUND-TRUTH BENCHMARK RUNNER    ');
console.log('==================================================');

const requiredTz = trust._meta?.required_timezone;
if (requiredTz && requiredTz !== hostTz) {
  console.error(
    `\nABORT: trusted-source-validation.json requires TZ="${requiredTz}"; this machine resolves to "${hostTz}".\n` +
      `Re-run with the correct timezone, e.g.:\n` +
      `  TZ=${requiredTz} npx tsx scripts/verify-trusted-source.mts\n`
  );
  process.exitCode = 1;
  process.exit(1);
}
console.log(`TZ guard OK (${hostTz})`);

if (trust._meta?.known_discrepancies?.length) {
  console.log(`\n${trust._meta.known_discrepancies.length} known discrepancy(ies) recorded in _meta (see JSON for detail):`);
  for (const d of trust._meta.known_discrepancies) {
    console.log(`  - ${d.id}: ${d.finding.slice(0, 120)}...`);
  }
}

const scenarioKeys = Object.keys(trust).filter((k) => k !== '_meta');

for (const key of scenarioKeys) {
  const s = trust[key];
  const tier = s.tier;
  console.log(`\n--- ${key} [${tier}] ---`);

  try {
    switch (s.check) {
      case 'computeAnalyticalNMin': {
        for (const v of s.variants) {
          const params = { ...s.baseParams, ...(v.paramsOverride || {}) };
          const got = computeAnalyticalNMin(params);
          assert(got === v.expected, `${key}.${v.name}: nMinAnalytical === ${v.expected}`, tier, `got ${got}`);
        }
        break;
      }

      case 'searchOptimalHC': {
        const inputs = s.inputs;
        const params = {
          intervals: toIntervals(inputs.intervals),
          openingWIP: toOpeningWIP(inputs.openingWIP),
          categories: inputs.categories,
          calendar: inputs.calendar,
          labor: inputs.labor,
          sla: inputs.sla,
          seed: inputs.seed,
          userMaxHC: inputs.userMaxHC,
          replications: inputs.replications,
        };
        const res = searchOptimalHC(params as any);
        const exp = s.trustedExpected;
        for (const field of Object.keys(exp)) {
          if (field.startsWith('nMinAnalytical_if_')) continue; // informational only
          const got = (res as any)[field];
          assert(got === exp[field], `${key}: ${field} === ${JSON.stringify(exp[field])}`, tier, `got ${JSON.stringify(got)}`);
        }
        break;
      }

      case 'searchOptimalHCAsync': {
        const inputs = s.inputs;
        const params = {
          intervals: toIntervals(inputs.intervals),
          openingWIP: toOpeningWIP(inputs.openingWIP),
          categories: inputs.categories,
          calendar: inputs.calendar,
          labor: inputs.labor,
          sla: inputs.sla,
          seed: inputs.seed,
          userMaxHC: inputs.userMaxHC,
          replications: inputs.replications,
        };
        const res = await searchOptimalHCAsync(params as any);
        const exp = s.trustedExpected;
        for (const field of Object.keys(exp)) {
          if (field.startsWith('nMinAnalytical_if_')) continue; // informational only
          const got = (res as any)[field];
          assert(got === exp[field], `${key}: ${field} === ${JSON.stringify(exp[field])}`, tier, `got ${JSON.stringify(got)}`);
        }
        break;
      }

      case 'runBackofficeDES': {
        const inputs = s.inputs;
        const baseParams = {
          intervals: toIntervals(inputs.intervals),
          openingWIP: toOpeningWIP(inputs.openingWIP),
          categories: inputs.categories,
          calendar: inputs.calendar,
          labor: inputs.labor,
          sla: inputs.sla,
        };
        if (s.per_hc_table) {
          for (const hc of Object.keys(s.per_hc_table)) {
            const exp = s.per_hc_table[hc];
            const res = runBackofficeDES({ ...baseParams, operationalHC: Number(hc), seed: s.seed } as any);
            for (const field of Object.keys(exp)) {
              const got = (res as any)[field];
              const tol = field.toLowerCase().includes('pct') ? 0.1 : field.toLowerCase().includes('minutes') ? 0.5 : 0;
              const ok = typeof exp[field] === 'number' ? approx(got, exp[field], tol || 1e-9) : got === exp[field];
              assert(ok, `${key} HC=${hc}: ${field} ≈ ${exp[field]}`, tier, `got ${got}`);
            }
          }
        } else if (inputs.operationalHC !== undefined) {
          const res = runBackofficeDES({ ...baseParams, operationalHC: inputs.operationalHC, seed: inputs.seed } as any);
          const exp = s.trustedExpected;
          for (const field of Object.keys(exp)) {
            const got = (res as any)[field];
            const tol = field.toLowerCase().includes('pct') ? 0.1 : field.toLowerCase().includes('minutes') ? 0.5 : 0;
            const ok = typeof exp[field] === 'number' ? approx(got, exp[field], tol || 1e-9) : got === exp[field];
            assert(ok, `${key}: ${field} ≈ ${exp[field]}`, tier, `got ${got}`);
          }
        }
        if (s.trustedExpected_search) {
          const ts = s.trustedExpected_search;
          const searchRes = searchOptimalHC({ ...baseParams, seed: ts.seed, userMaxHC: ts.userMaxHC, replications: ts.replications } as any);
          assert(
            searchRes.recommendedHC === ts.recommendedHC,
            `${key}: search.recommendedHC === ${ts.recommendedHC}`,
            tier,
            `got ${searchRes.recommendedHC}`
          );
        }
        break;
      }

      case 'calculateStaffingRequirement': {
        const inputs = s.inputs;
        const res = calculateStaffingRequirement({
          operationalHC: inputs.operationalHC,
          categories: inputs.categories,
          intervals: toIntervals(inputs.intervals),
          openingWIP: toOpeningWIP(inputs.openingWIP),
          calendar: inputs.calendar,
          labor: inputs.labor,
          horizonStart: new Date(inputs.horizonStart),
          horizonEnd: new Date(inputs.horizonEnd),
          bindingConstraint: inputs.bindingConstraint,
        } as any);
        const exp = s.trustedExpected;
        for (const field of Object.keys(exp)) {
          if (field === 'perCategory') {
            for (const catName of Object.keys(exp.perCategory)) {
              const catExp = exp.perCategory[catName];
              const catGot = (res as any).perCategory.find((c: any) => c.category === catName);
              for (const cf of Object.keys(catExp)) {
                const got = catGot ? catGot[cf] : undefined;
                const ok = typeof catExp[cf] === 'number' ? approx(got, catExp[cf], 0.01) : got === catExp[cf];
                assert(ok, `${key}: perCategory.${catName}.${cf} ≈ ${catExp[cf]}`, tier, `got ${got}`);
              }
            }
            continue;
          }
          if (field.includes('would_be_under_ceil')) continue; // informational only
          const got = (res as any)[field];
          const ok = typeof exp[field] === 'number' ? approx(got, exp[field], 0.01) : got === exp[field];
          assert(ok, `${key}: ${field} ≈ ${JSON.stringify(exp[field])}`, tier, `got ${JSON.stringify(got)}`);
        }
        break;
      }

      case 'allocateAgentsToCategories': {
        const map = new Map<string, number>(Object.entries(s.workloadMinutes));
        for (const v of s.variants) {
          const seats = allocateAgentsToCategories(map, v.n);
          for (const catName of Object.keys(v.expectedSeats)) {
            const got = seats.get(catName);
            assert(got === v.expectedSeats[catName], `${key} N=${v.n}: seats[${catName}] === ${v.expectedSeats[catName]}`, tier, `got ${got}`);
          }
        }
        break;
      }

      case 'effectivePrimaryTarget': {
        for (const v of s.variants) {
          const got = effectivePrimaryTarget(v.officialPct, v.sla);
          assert(approx(got, v.expected, 0.01), `${key}.${v.name}: effectivePrimaryTarget === ${v.expected}`, tier, `got ${got}`);
        }
        break;
      }

      case 'invariant_conservation': {
        const inputs = s.inputs;
        const baseParams = {
          intervals: toIntervals(inputs.intervals),
          openingWIP: toOpeningWIP(inputs.openingWIP),
          categories: inputs.categories,
          calendar: inputs.calendar,
          labor: inputs.labor,
          sla: inputs.sla,
        };
        const totalOffered = s.totalOfferedWorkloadMinutes;
        const totalVolume = inputs.intervals.reduce((a: number, i: any) => a + i.volume, 0);
        for (const v of s.variants) {
          const res = runBackofficeDES({ ...baseParams, operationalHC: v.operationalHC, seed: v.seed } as any);
          const exp = s.trustedExpected.per_variant[v.name];
          for (const field of Object.keys(exp)) {
            assert((res as any)[field] === exp[field], `${key} ${v.name}: ${field} === ${exp[field]}`, tier, `got ${(res as any)[field]}`);
          }
          assert(res.totalHandlingMinutes <= totalOffered, `${key} ${v.name}: totalHandlingMinutes <= ${totalOffered}`, tier, `got ${res.totalHandlingMinutes}`);
          if (res.unfinishedCases === 0) {
            assert(res.totalHandlingMinutes === totalOffered, `${key} ${v.name}: unfinished=0 implies handling===offered`, tier);
          }
          assert(res.completedCases + res.unfinishedCases === res.totalCases, `${key} ${v.name}: completed+unfinished===total`, tier);
          assert(res.totalCases === totalVolume, `${key} ${v.name}: totalCases === sum(volume) (${totalVolume})`, tier, `got ${res.totalCases}`);
          assert(res.primaryAchievedPct >= 0 && res.primaryAchievedPct <= 100, `${key} ${v.name}: 0<=primaryAchievedPct<=100`, tier);
          assert(res.occupancyPct === Math.min(100, res.rawOccupancyPct), `${key} ${v.name}: occupancyPct===min(100,raw)`, tier);
        }
        break;
      }

      case 'invariant_monotonic_sweep': {
        const inputs = s.inputs;
        const baseParams = {
          intervals: toIntervals(inputs.intervals),
          openingWIP: toOpeningWIP(inputs.openingWIP),
          categories: inputs.categories,
          calendar: inputs.calendar,
          labor: inputs.labor,
          sla: inputs.sla,
        };
        let prev: number | null = null;
        let monotoneOk = true;
        const [lo, hi] = s.hcSweepRange;
        for (let hc = lo; hc <= hi; hc++) {
          const res = runBackofficeDES({ ...baseParams, operationalHC: hc, seed: s.seed } as any);
          const val = (res as any)[s.field];
          if (prev !== null && val < prev - 1e-9) monotoneOk = false;
          const known = s.trustedExpected.knownPoints[String(hc)];
          if (known !== undefined) {
            assert(approx(val, known, 0.1), `${key}: HC=${hc} ${s.field} ≈ ${known} (known point)`, tier, `got ${val}`);
          }
          prev = val;
        }
        assert(monotoneOk, `${key}: ${s.field} non-decreasing over HC ${lo}..${hi}`, tier);
        break;
      }

      case 'invariant_determinism': {
        const inputs = s.inputs;
        const params = {
          intervals: toIntervals(inputs.intervals),
          openingWIP: toOpeningWIP(inputs.openingWIP),
          categories: inputs.categories,
          calendar: inputs.calendar,
          labor: inputs.labor,
          sla: inputs.sla,
          operationalHC: inputs.operationalHC,
          seed: inputs.seed,
        };
        const r1 = runBackofficeDES(params as any);
        const r2 = runBackofficeDES(params as any);
        for (const field of s.fieldsMustBeIdentical) {
          assert((r1 as any)[field] === (r2 as any)[field], `${key}: ${field} identical across two runs`, tier, `${(r1 as any)[field]} vs ${(r2 as any)[field]}`);
        }
        break;
      }

      case 'invariant_house_monotonic_sweep': {
        const map = new Map<string, number>(Object.entries(s.workloadMinutes));
        const [lo, hi] = s.nRange;
        let prevSeats: Map<string, number> | null = null;
        let ok = true;
        let sumsOk = true;
        for (let n = lo; n <= hi; n++) {
          const seats = allocateAgentsToCategories(map, n);
          let sum = 0;
          for (const v of seats.values()) sum += v;
          if (sum !== n) sumsOk = false;
          if (prevSeats) {
            for (const [cat, prevVal] of prevSeats) {
              const nowVal = seats.get(cat) || 0;
              if (nowVal < prevVal) ok = false;
            }
          }
          prevSeats = seats;
        }
        assert(ok, `${key}: no category's seats ever decrease over N=${lo}..${hi}`, tier);
        assert(sumsOk, `${key}: seats sum to N at every step`, tier);
        break;
      }

      case 'invariant_seed_zero_coercion': {
        const inputs = s.inputs;
        const baseParams = {
          intervals: toIntervals(inputs.intervals),
          openingWIP: toOpeningWIP(inputs.openingWIP),
          categories: inputs.categories,
          calendar: inputs.calendar,
          labor: inputs.labor,
          sla: inputs.sla,
          operationalHC: inputs.operationalHC,
        };
        const rA = runBackofficeDES({ ...baseParams, seed: s.seedA } as any);
        const rB = runBackofficeDES({ ...baseParams, seed: s.seedB } as any);
        for (const field of s.fieldsMustBeIdentical) {
          assert((rA as any)[field] === (rB as any)[field], `${key}: seed=0 vs seed=123456789 -> ${field} identical`, tier, `${(rA as any)[field]} vs ${(rB as any)[field]}`);
        }
        break;
      }

      default:
        console.error(`  ! Unknown check type "${s.check}" for ${key} - skipped`);
    }
  } catch (err) {
    failedTests++;
    console.error(`  ✗ ERROR in ${key}: ${(err as Error).message}`);
  }
}

console.log('\n==================================================');
console.log('  RESULTS BY TIER');
console.log('==================================================');
for (const t of Object.keys(tierCounts).sort()) {
  const c = tierCounts[t];
  console.log(`  ${t}: ${c.pass} PASSED, ${c.fail} FAILED`);
}
console.log('==================================================');
console.log(`  TOTAL: ${passedTests} PASSED, ${failedTests} FAILED`);
console.log('==================================================\n');

if (failedTests > 0) {
  process.exitCode = 1;
}
