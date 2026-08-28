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
  { id: 'a', name: 'HS-Billing', ahtMinutes: 30, shrinkagePct: 0.3, priority: 1, primaryPct: 80, primaryWindow: 3, primaryUnit: 'hours' },
  { id: 'b', name: 'HS-Tech', ahtMinutes: 30, shrinkagePct: 0.3, priority: 2, primaryPct: 80, primaryWindow: 5, primaryUnit: 'days' },
  { id: 'c', name: 'MS-Billing', ahtMinutes: 30, shrinkagePct: 0.3, priority: 3, primaryPct: 80, primaryWindow: 2, primaryUnit: 'hours' },
  { id: 'd', name: 'MS-Tech', ahtMinutes: 30, shrinkagePct: 0.3, priority: 4, primaryPct: 80, primaryWindow: 6, primaryUnit: 'hours' },
];

let intervals = mapRawRecordsToIntervals(parseCSVRaw(readFileSync('test_complaint.csv', 'utf8')).rows, {
  intervalStartCol: 'Date',
  timeCol: 'time',
  volumeCol: 'Offered',
  categoryCol: 'Seg',
});
const days = [...new Set(intervals.map((i) => i.start.toISOString().slice(0, 10)))].sort();
const keep = new Set(days.slice(0, 7));
intervals = intervals.filter((i) => keep.has(i.start.toISOString().slice(0, 10)));

const out: unknown[] = [];
for (const conf of [90, 95]) {
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
    replications: 8,
    userMaxHC: 500,
  });
  out.push({
    CI: conf,
    N_min: opt.nMinAnalytical,
    recommendedHC: opt.recommendedHC,
    stdDev: opt.primaryStatistical?.stdDev,
    ciLow: opt.primaryStatistical?.ci95Low,
    ciHigh: opt.primaryStatistical?.ci95High,
    binding: opt.bindingConstraintType,
  });
  writeFileSync('ci-90-95.txt', JSON.stringify(out, null, 2));
}
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
