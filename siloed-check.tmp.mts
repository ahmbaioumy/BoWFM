import { loadSampleFile } from './scripts/sample-files';
import { searchOptimalHC } from './src/utils/hc-search';
import { DEFAULT_CALENDAR, DEFAULT_LABOR, DEFAULT_SIM_PARAMS, DEFAULT_SLA } from './src/utils/default-config';

const placement = process.argv[2] === 'on';
const { intervals, categories } = loadSampleFile('AJM_Simu.csv') as any;
const r = searchOptimalHC({
  intervals, openingWIP: [], categories, calendar: DEFAULT_CALENDAR,
  labor: { ...DEFAULT_LABOR, ...(placement ? { shiftPlacementEnabled: true, shiftSlapMinutes: 30 } : {}) },
  sla: DEFAULT_SLA, seed: DEFAULT_SIM_PARAMS.seed, userMaxHC: DEFAULT_SIM_PARAMS.maxHCSearch,
  replications: DEFAULT_SIM_PARAMS.replications, queueArchitecture: 'siloed',
});
const p = (r as any).rosterPolish;
process.stdout.write(JSON.stringify({
  placement, hc: r.recommendedHC, gross: r.staffing?.grossHCTotal, sla: r.finalDESResult?.primaryAchievedPct,
  status: p?.status, reason: p?.reason, moves: p ? `${p.movesApplied ?? 0}/${p.movesTotal ?? 0}` : undefined,
  orgMinOnShift: p ? `${p.current?.minOnShift} -> ${p.polished?.minOnShift}` : undefined,
  byCategory: p?.byCategory ? Object.fromEntries(Object.entries(p.byCategory).map(([k, v]: any) => [k, `${v.current.minOnShift} -> ${v.polished?.minOnShift ?? '-'}`])) : undefined,
  roster: r.finalDESResult?.shiftDistributionUsed ? Object.fromEntries(Object.entries(r.finalDESResult.shiftDistributionUsed).map(([k, d]: any) => [k, d.slaps.map((s: any) => `${s.startMinutesFromOpen}:${s.agentCount}`).join(' ')])) : 'uniform',
}, null, 1) + '\n');
