import { readFileSync } from 'node:fs';
import { parseCSVRaw, mapRawRecordsToIntervals } from '../src/utils/csv-parser';
import { searchOptimalHC } from '../src/utils/hc-search';
import { CalendarConfig, CategoryConfig, LaborConfig, SLAPolicyConfig } from '../src/types/wfm';

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
  confidenceLevelPct: 95,
};

const categories: CategoryConfig[] = [
  { id: 'cat_hs_billing', name: 'HS-Billing', ahtMinutes: 30, shrinkagePct: 0.3, priority: 1, primaryPct: 80, primaryWindow: 3, primaryUnit: 'hours' },
  { id: 'cat_hs_tech', name: 'HS-Tech', ahtMinutes: 30, shrinkagePct: 0.3, priority: 2, primaryPct: 80, primaryWindow: 5, primaryUnit: 'days' },
  { id: 'cat_ms_billing', name: 'MS-Billing', ahtMinutes: 30, shrinkagePct: 0.3, priority: 3, primaryPct: 80, primaryWindow: 2, primaryUnit: 'hours' },
  { id: 'cat_ms_tech', name: 'MS-Tech', ahtMinutes: 30, shrinkagePct: 0.3, priority: 4, primaryPct: 80, primaryWindow: 6, primaryUnit: 'hours' },
];

const rawCSV = readFileSync('test_complaint.csv', 'utf8');
const parsedRaw = parseCSVRaw(rawCSV);
const intervals = mapRawRecordsToIntervals(parsedRaw.rows, {
  intervalStartCol: 'Date',
  timeCol: 'time',
  volumeCol: 'Offered',
  categoryCol: 'Seg',
});

console.log('Total intervals:', intervals.length);
let totalVol = 0;
let nanCount = 0;
intervals.forEach((it) => {
  totalVol += it.volume;
  if (!it.start || Number.isNaN(it.start.getTime()) || Number.isNaN(it.volume)) nanCount++;
});
console.log('Total volume:', totalVol);
console.log('NaN/undefined intervals:', nanCount);

console.log('\n--- Running searchOptimalHC on test_complaint.csv ---');
const opt = searchOptimalHC({
  intervals,
  openingWIP: [],
  categories,
  calendar: cal,
  labor,
  sla,
  seed: 12345,
  replications: 5,
});

console.log('Search Optimal Result:');
console.log('  recommendedHC:', opt.recommendedHC);
console.log('  nMinAnalytical:', opt.nMinAnalytical);
console.log('  primaryDrivenHC:', opt.primaryDrivenHC);
console.log('  bindingConstraintType:', opt.bindingConstraintType);
console.log('  isInfeasible:', opt.isInfeasible);
console.log('  simPassed:', opt.finalDESResult?.allPassed);
console.log('  simPrimaryPct:', opt.finalDESResult?.primaryAchievedPct);
if (opt.finalDESResult?.categoryStats) {
  for (const [catName, stat] of Object.entries(opt.finalDESResult.categoryStats)) {
    console.log(`    ${catName}: Primary=${stat.primaryPct}%`);
  }
}
if (opt.recommendedHC === 266) {
  console.error('FAIL: recommendedHC still 266 (Horn floor not removed)');
  process.exit(1);
}
if (opt.recommendedHC != null && (Number.isNaN(opt.recommendedHC) || !Number.isFinite(opt.recommendedHC))) {
  console.error('FAIL: recommendedHC is NaN/undefined');
  process.exit(1);
}
