import { readFileSync, writeFileSync } from 'node:fs';
import { parseCSVRaw, mapRawRecordsToIntervals } from '../src/utils/csv-parser';
import { searchOptimalHC } from '../src/utils/hc-search';
import type { CalendarConfig, CategoryConfig, LaborConfig, SLAPolicyConfig } from '../src/types/wfm';

const cal: CalendarConfig = {
  workingDays: [1, 2, 3, 4, 5],
  dailyOpenHour: 8,
  dailyOpenMinute: 0,
  dailyCloseHour: 22,
  dailyCloseMinute: 0,
  holidays: [],
};

const labor: LaborConfig = {
  dailyProductiveHours: 8,
  adherencePct: 0.98,
  workingDaysPerWeek: 6,
  offDaysPerWeek: 1,
  contractualHoursSource: 'derived',
  shifts: [],
};

const categories: CategoryConfig[] = [
  { id: 'cat_hs_billing', name: 'HS-Billing', ahtMinutes: 30, shrinkagePct: 0.3, priority: 1, primaryPct: 80, primaryWindow: 3, primaryUnit: 'hours' },
  { id: 'cat_hs_tech', name: 'HS-Tech', ahtMinutes: 30, shrinkagePct: 0.3, priority: 2, primaryPct: 80, primaryWindow: 5, primaryUnit: 'days' },
  { id: 'cat_ms_billing', name: 'MS-Billing', ahtMinutes: 30, shrinkagePct: 0.3, priority: 3, primaryPct: 80, primaryWindow: 2, primaryUnit: 'hours' },
  { id: 'cat_ms_tech', name: 'MS-Tech', ahtMinutes: 30, shrinkagePct: 0.3, priority: 4, primaryPct: 80, primaryWindow: 6, primaryUnit: 'hours' },
];

const rawCSV = readFileSync('test_complaint.csv', 'utf8');
const parsedRaw = parseCSVRaw(rawCSV);
let intervals = mapRawRecordsToIntervals(parsedRaw.rows, {
  intervalStartCol: 'Date',
  timeCol: 'time',
  volumeCol: 'Offered',
  categoryCol: 'Seg',
});
const dayKeys = [...new Set(intervals.map((i) => i.start.toISOString().slice(0, 10)))].sort();
const keepDays = new Set(dayKeys.slice(0, 7));
intervals = intervals.filter((i) => keepDays.has(i.start.toISOString().slice(0, 10)));

const lines: string[] = [`intervals=${intervals.length}`];
for (const conf of [50, 99.9]) {
  const t0 = Date.now();
  const sla: SLAPolicyConfig = {
    primaryPct: 80,
    primaryWindow: 6,
    primaryUnit: 'hours',
    boAsaEnabled: false,
    boAsaTarget: 60,
    boAsaUnit: 'minutes',
    asaClockBasis: 'business_window',
    clockBasis: 'business_time',
    clockStartPolicy: 'arrival',
    occupancyCapEnabled: false,
    occupancyCapPct: 85,
    confidenceLevelPct: conf,
  };
  const opt = searchOptimalHC({
    intervals,
    openingWIP: [],
    categories,
    calendar: cal,
    labor,
    sla,
    seed: 12345,
    replications: 5,
    userMaxHC: 500,
  });
  const ps = opt.primaryStatistical;
  lines.push(
    JSON.stringify({
      CI: conf,
      ms: Date.now() - t0,
      N_min: opt.nMinAnalytical,
      recommendedHC: opt.recommendedHC,
      primaryDrivenHC: opt.primaryDrivenHC,
      binding: opt.bindingConstraintType,
      bindingDesc: opt.bindingConstraintDescription,
      ciLow: ps?.ci95Low,
      ciHigh: ps?.ci95High,
      median: ps?.achievedPctMedian,
      stdDev: ps?.stdDev,
      historyLen: opt.searchHistory.length,
      passNs: opt.searchHistory.filter((h) => h.passed).map((h) => h.hc),
      failNear: opt.searchHistory
        .filter((h) => !h.passed)
        .slice(-3)
        .map((h) => ({ hc: h.hc, pri: h.primaryPct, lo: h.primaryCiLow })),
    })
  );
  writeFileSync('ci-search-compare.txt', lines.join('\n') + '\n', 'utf8');
}
process.stdout.write(lines.join('\n') + '\n');
