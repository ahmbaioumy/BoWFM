/**
 * Sample-file required-HC audit (test tooling only — never reaches the bundle).
 *
 * Runs searchOptimalHC on a test_files/ CSV with the app defaults (pooled, default seed and R)
 * across named config cells, appending one JSON row per cell to the output file so a
 * before/after pair of runs can be diffed.
 *
 * Usage: npx tsx scripts/audit-sample-hc.mts <out.jsonl> <csv file in test_files/> <cell,cell,...>
 * Cells: BA BN WA WN (clock basis x clock start), PON (placement ON), FOFF (N_min floor OFF).
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { parseCSVRaw, mapRawRecordsToIntervals, discoverAndSyncCategories } from '../src/utils/csv-parser';
import { searchOptimalHC } from '../src/utils/hc-search';
import { getDailyWindowLengthHours } from '../src/utils/calendar';
import {
  DEFAULT_CALENDAR, DEFAULT_CATEGORIES, DEFAULT_LABOR, DEFAULT_SIM_PARAMS, DEFAULT_SLA,
} from '../src/utils/default-config';
import type { LaborConfig, ShiftDistributionByCategory, SLAPolicyConfig } from '../src/types/wfm';

const [outFile, csvName, cellArg = 'BA,BN,WA,WN'] = process.argv.slice(2);
if (!outFile || !csvName) throw new Error('usage: audit-sample-hc.mts <out.jsonl> <csv> [cells]');

const CELLS: Record<string, { sla: Partial<SLAPolicyConfig>; labor?: Partial<LaborConfig> }> = {
  BA: { sla: { clockBasis: 'business_time', clockStartPolicy: 'arrival' } },
  BN: { sla: { clockBasis: 'business_time', clockStartPolicy: 'next_open' } },
  WA: { sla: { clockBasis: 'wall_clock', clockStartPolicy: 'arrival' } },
  WN: { sla: { clockBasis: 'wall_clock', clockStartPolicy: 'next_open' } },
  PON: { sla: {}, labor: { shiftPlacementEnabled: true, shiftSlapMinutes: 30 } },
  FOFF: { sla: { nMinFloorEnabled: false } as Partial<SLAPolicyConfig> },
};

/** Agents on shift per 30-min open bucket for a roster (undefined = everyone starts at open). */
function onShiftByBucket(dist: ShiftDistributionByCategory | undefined, hc: number): number[] {
  const windowMin = getDailyWindowLengthHours(DEFAULT_CALENDAR) * 60;
  const shiftMin = DEFAULT_LABOR.dailyProductiveHours * 60;
  const starts: number[] = [];
  if (dist) {
    for (const key of Object.keys(dist).sort()) {
      for (const s of dist[key].slaps) for (let i = 0; i < s.agentCount; i++) starts.push(s.startMinutesFromOpen);
    }
  }
  while (starts.length < hc) starts.push(0);
  const out: number[] = [];
  for (let t = 0; t < windowMin; t += 30) out.push(starts.filter((o) => t >= o && t < o + shiftMin).length);
  return out;
}

const raw = parseCSVRaw(readFileSync(`test_files/${csvName}`, 'utf8'));
const intervals = mapRawRecordsToIntervals(raw.rows, { intervalStartCol: 'Date', timeCol: 'int', volumeCol: 'Vol', categoryCol: 'Seg' } as any);
const categories = discoverAndSyncCategories(intervals, DEFAULT_CATEGORIES, DEFAULT_SLA);

for (const cell of cellArg.split(',')) {
  const spec = CELLS[cell];
  if (!spec) throw new Error(`unknown cell ${cell}`);
  const r = searchOptimalHC({
    intervals, openingWIP: [], categories, calendar: DEFAULT_CALENDAR,
    labor: { ...DEFAULT_LABOR, ...spec.labor },
    sla: { ...DEFAULT_SLA, ...spec.sla },
    seed: DEFAULT_SIM_PARAMS.seed, userMaxHC: DEFAULT_SIM_PARAMS.maxHCSearch,
    replications: DEFAULT_SIM_PARAMS.replications, queueArchitecture: 'pooled',
  });
  const des = r.finalDESResult;
  const roster = des?.shiftDistributionUsed;
  const onShift = r.recommendedHC != null ? onShiftByBucket(roster, r.recommendedHC) : [];
  const row = {
    file: csvName, cell,
    nMin: r.nMinAnalytical, nOcc: r.occupancyFeasibleFloor, recommendedHC: r.recommendedHC,
    grossHC: r.staffing?.grossHCTotal, binding: r.bindingConstraintType, infeasible: r.isInfeasible,
    slaPct: des?.primaryAchievedPct, occPct: des?.rawOccupancyPct, minCoverage: des?.minCoverageObserved,
    roster: roster ? Object.fromEntries(Object.entries(roster).map(([k, d]) => [k, d.slaps.map((s) => `${s.startMinutesFromOpen}:${s.agentCount}`).join(' ')])) : 'uniform',
    onShiftByHalfHour: onShift.join(' '),
    belowWorkloadFloor: (r as any).belowWorkloadFloor,
    rosterPolish: (r as any).rosterPolish?.status,
  };
  appendFileSync(outFile, JSON.stringify(row) + '\n');
}
