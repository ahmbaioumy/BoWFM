import fs from 'fs';
import { parseCSVRaw, mapRawRecordsToIntervals } from './src/utils/csv-parser';
import { searchOptimalHC } from './src/utils/hc-search';
import { CalendarConfig, CategoryConfig, LaborConfig, SLAPolicyConfig } from './src/types/wfm';

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

const text = fs.readFileSync('test-data.csv', 'utf8');
const parsedRaw = parseCSVRaw(text);
const intervals = mapRawRecordsToIntervals(parsedRaw.rows, {
  intervalStartCol: 'Date',
  timeCol: 'Int',
  volumeCol: 'offered',
  categoryCol: 'Seg',
});
console.log('Intervals:', intervals.length);
console.log('Running search Optimal HC...');
const opt = searchOptimalHC({
  intervals,
  openingWIP: [],
  categories,
  calendar: cal,
  labor,
  sla,
  seed: 12345,
});
console.log('Result:', opt.recommendedHC);
console.log('nMinAnalytical:', opt.nMinAnalytical);
console.log('primaryDrivenHC:', opt.primaryDrivenHC);
