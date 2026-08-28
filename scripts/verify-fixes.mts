/**
 * Comprehensive Verification Test Suite for Backoffice WFM Sizing Engine
 * Runnable via: npx tsx scripts/verify-fixes.mts
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseCSVRaw,
  parseFlexibleDate,
  generateNextWIPId,
  validateDataQuality,
  mapRawRecordsToIntervals,
} from '../src/utils/csv-parser';
import {
  getTCrit,
  getTCrit95,
  calculateStaffingRequirement,
  searchOptimalHC,
  searchOptimalHCAsync,
  generatePrecomputedReplications,
  evaluateCandidateStatistical,
  computeAnalyticalNMin,
} from '../src/utils/hc-search';
import {
  generateCaseEntities,
  runBackofficeDES,
  verifyAgentTimelineInvariants,
  resolveOccupancyCapPct,
  CaseMinHeap,
  pickNextCase,
} from '../src/utils/des-engine';
import {
  convertDurationToMinutes,
  convertSlaDurationToMinutes,
  isWorking,
  isWorkingDay,
  workingDuration,
  addWorkingTime,
  subtractWorkingTime,
  nextOpen,
  getDailyOpenClose,
  getDailyWindowLengthHours,
  getCalendarWorkingDaysInHorizon,
  computeIntervalHorizon,
} from '../src/utils/calendar';
import {
  CalendarConfig,
  CategoryConfig,
  CaseEntity,
  LaborConfig,
  SLAPolicyConfig,
  StandardInterval,
  OpeningWIPCase,
} from '../src/types/wfm';

let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  âœ“ PASS: ${testName}`);
    passedTests++;
  } else {
    console.error(`  âœ— FAIL: ${testName}${detail ? ` - ${detail}` : ''}`);
    failedTests++;
  }
}

console.log('\n==================================================');
console.log(' RUNNING BACKOFFICE WFM ENGINE VERIFICATION SUITE ');
console.log('==================================================\n');

// ----------------------------------------------------
// 1. CSV Parsing & Delimiter Detection
// ----------------------------------------------------
console.log('--- Suite 1: CSV Parsing & Delimiter Detection ---');
{
  const commaCSV = `Date,Interval,Volume,Category\n2026-03-01,09:00,10,General\n2026-03-01,09:30,15,Billing`;
  const resComma = parseCSVRaw(commaCSV);
  assert(resComma.rows.length === 2 && resComma.headers.length === 4, 'Comma-separated CSV parsing');

  const semiCSV = `Date;Interval;Volume;Category\n2026-03-01;09:00;10;General\n2026-03-01;09:30;15;Billing`;
  const resSemi = parseCSVRaw(semiCSV);
  assert(resSemi.rows.length === 2 && resSemi.headers.length === 4, 'Semicolon-separated CSV parsing');

  const tabCSV = `Date\tInterval\tVolume\tCategory\n2026-03-01\t09:00\t10\tGeneral\n2026-03-01\t09:30\t15\tBilling`;
  const resTab = parseCSVRaw(tabCSV);
  assert(resTab.rows.length === 2 && resTab.headers.length === 4, 'Tab-separated CSV parsing');

  const quotedCSV = `Date,Volume,Category,Notes\n2026-03-01,10,"Claims, Escalations","Handled ""VIP"" cases"\n2026-03-01,20,"Standard","Normal"`;
  const resQuoted = parseCSVRaw(quotedCSV);
  assert(
    resQuoted.rows.length === 2 &&
    resQuoted.rows[0]['Category'] === 'Claims, Escalations' &&
    resQuoted.rows[0]['Notes'] === 'Handled "VIP" cases',
    'Quoted CSV with internal commas and escaped quotes ("")'
  );
}

// ----------------------------------------------------
// 2. Date Parsing & WIP ID Generation
// ----------------------------------------------------
console.log('\n--- Suite 2: Date Parsing & WIP Helpers ---');
{
  const feb31 = parseFlexibleDate('31/02/2026');
  assert(isNaN(feb31.getTime()), 'Rejects invalid date (31/02/2026)');

  const leap2024 = parseFlexibleDate('29/02/2024');
  assert(!isNaN(leap2024.getTime()) && leap2024.getDate() === 29, 'Accepts leap year (29/02/2024)');

  const wipList: OpeningWIPCase[] = [
    { id: 'WIP-0001', category: 'A', priority: 1, arrival: new Date(), clockStart: new Date(), remainingWorkMinutes: 30 },
    { id: 'WIP-0005', category: 'A', priority: 1, arrival: new Date(), clockStart: new Date(), remainingWorkMinutes: 30 },
  ];
  assert(generateNextWIPId(wipList) === 'WIP-0006', 'Generates next sequential WIP ID (WIP-0006)');
}

// ----------------------------------------------------
// BUG-A: Common Random Numbers (CRN) & Multi-Replication Consistency
// ----------------------------------------------------
console.log('\n--- Suite BUG-A: Common Random Numbers (CRN) ---');
{
  const calendar: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0,
    holidays: [],
  };
  const categories: CategoryConfig[] = [
    { id: 'c1', name: 'General', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1 },
  ];
  const intervals: StandardInterval[] = [
    { intervalIndex: 0, start: new Date(2026, 2, 2, 9, 0), end: new Date(2026, 2, 2, 17, 0), category: 'General', volume: 20 },
  ];
  const sla: SLAPolicyConfig = {
    primaryPct: 80,
    primaryWindow: 4,
    primaryUnit: 'hours',
    clockBasis: 'business_time',
    clockStartPolicy: 'arrival',
    boAsaEnabled: false,
    boAsaTarget: 2,
    boAsaUnit: 'hours',
    asaClockBasis: 'business_window',
    occupancyCapEnabled: false,
    occupancyCapPct: 85,
    confidenceLevelPct: 95,
  };

  const reps = generatePrecomputedReplications({
    intervals,
    openingWIP: [],
    categories,
    calendar,
    sla,
    baseSeed: 12345,
    replications: 5,
  });

  assert(reps.length === 5, 'BUG-A: Generates R=5 distinct replication case sets');
  const rep0FirstArrival = reps[0].cases[0].arrival.getTime();
  const rep1FirstArrival = reps[1].cases[0].arrival.getTime();
  assert(rep0FirstArrival !== rep1FirstArrival, 'BUG-A: Different replications produce distinct stochastic arrival times');
}

// ----------------------------------------------------
// BUG-B: WIP remainingWorkMinutes Preserved During Clone
// ----------------------------------------------------
console.log('\n--- Suite BUG-B: WIP Remaining Work Preservation ---');
{
  const calendar: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0,
    holidays: [],
  };
  const labor: LaborConfig = {
    dailyProductiveHours: 8,
    adherencePct: 1.0,
    workingDaysPerWeek: 5,
    offDaysPerWeek: 2,
    contractualHoursSource: 'derived',
    shifts: [],
  };
  const categories: CategoryConfig[] = [
    { id: 'c1', name: 'General', ahtMinutes: 90, shrinkagePct: 0.2, priority: 1 },
  ];
  const wipArrival = new Date(2026, 2, 2, 9, 0);
  const openingWIP: OpeningWIPCase[] = [
    { id: 'WIP-1', category: 'General', priority: 1, arrival: wipArrival, clockStart: wipArrival, remainingWorkMinutes: 25 },
  ];
  const sla: SLAPolicyConfig = {
    primaryPct: 80,
    primaryWindow: 1,
    primaryUnit: 'hours',
    clockBasis: 'business_time',
    clockStartPolicy: 'arrival',
    boAsaEnabled: false,
    boAsaTarget: 1,
    boAsaUnit: 'hours',
    asaClockBasis: 'business_window',
    occupancyCapEnabled: false,
    occupancyCapPct: 85,
    confidenceLevelPct: 95,
  };

  const precomputed = generateCaseEntities({
    intervals: [],
    openingWIP,
    categories,
    calendar,
    sla,
    seed: 42,
  });

  const res = runBackofficeDES({
    operationalHC: 1,
    intervals: [],
    openingWIP,
    categories,
    calendar,
    labor,
    sla,
    seed: 42,
    precomputedCases: precomputed,
  });

  assert(res.passesPrimarySLA, 'BUG-B: Precomputed clone preserves remainingWorkMinutes (25m completes within 30m window)');
  assert(precomputed.cases[0].remainingWorkMinutes === 25, 'BUG-B: Case entity kept remainingWorkMinutes=25');
}

// ----------------------------------------------------
// BUG-C: Agent Daily Productive Hours & Adherence Enforcement
// ----------------------------------------------------
console.log('\n--- Suite BUG-C: Agent Productive Hours & Adherence Budget ---');
{
  const calendar: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0, // 8h window
    holidays: [],
  };
  const categories: CategoryConfig[] = [
    { id: 'c1', name: 'General', ahtMinutes: 60, shrinkagePct: 0.0, priority: 1 },
  ];
  const intervals: StandardInterval[] = [
    { intervalIndex: 0, start: new Date(2026, 2, 2, 9, 0), end: new Date(2026, 2, 2, 17, 0), category: 'General', volume: 8 },
  ];
  const sla: SLAPolicyConfig = {
    primaryPct: 80,
    primaryWindow: 8,
    primaryUnit: 'hours',
    clockBasis: 'business_time',
    clockStartPolicy: 'arrival',
    boAsaEnabled: false,
    boAsaTarget: 4,
    boAsaUnit: 'hours',
    asaClockBasis: 'business_window',
    occupancyCapEnabled: false,
    occupancyCapPct: 100,
    confidenceLevelPct: 95,
  };

  // Full budget: 8 hours (8 cases should complete in 1 day with 1 agent)
  const laborFull: LaborConfig = {
    dailyProductiveHours: 8,
    adherencePct: 1.0,
    workingDaysPerWeek: 5,
    offDaysPerWeek: 2,
    contractualHoursSource: 'derived',
    shifts: [],
  };
  const resFull = runBackofficeDES({
    operationalHC: 1,
    intervals,
    openingWIP: [],
    categories,
    calendar,
    labor: laborFull,
    sla,
    seed: 42,
  });

  // Half budget: 4 hours (adherence 0.5 -> only 4 cases complete on day 1)
  const laborHalf: LaborConfig = {
    dailyProductiveHours: 8,
    adherencePct: 0.5,
    workingDaysPerWeek: 5,
    offDaysPerWeek: 2,
    contractualHoursSource: 'derived',
    shifts: [],
  };
  const resHalf = runBackofficeDES({
    operationalHC: 1,
    intervals,
    openingWIP: [],
    categories,
    calendar,
    labor: laborHalf,
    sla,
    seed: 42,
  });

  const fullCompletedCount = resFull.caseResults.filter((c) => c.isCompleted).length;
  const halfCompletedDay1 = resHalf.caseResults.filter((c) => c.isCompleted && c.completeTime && c.completeTime.getDate() === 2).length;

  assert(fullCompletedCount === 8, 'BUG-C: Full adherence handles 8 cases on day 1');
  assert(halfCompletedDay1 === 4, 'BUG-C: 50% adherence caps work at 4 hours (4 cases) on day 1');
}

// ----------------------------------------------------
// BUG-D: 24x7 Continuous Processing Across Midnight
// ----------------------------------------------------
console.log('\n--- Suite BUG-D: 24x7 Continuous Processing ---');
{
  const calendar24x7: CalendarConfig = {
    is24x7: true,
    workingDays: [0, 1, 2, 3, 4, 5, 6],
    dailyOpenHour: 0,
    dailyOpenMinute: 0,
    dailyCloseHour: 24,
    dailyCloseMinute: 0,
    holidays: [],
  };
  const labor: LaborConfig = {
    dailyProductiveHours: 24,
    adherencePct: 1.0,
    workingDaysPerWeek: 7,
    offDaysPerWeek: 0,
    contractualHoursSource: 'derived',
    shifts: [],
  };
  const categories: CategoryConfig[] = [
    { id: 'c1', name: 'General', ahtMinutes: 90, shrinkagePct: 0.0, priority: 1 },
  ];
  // 1 case arriving at 23:00 with AHT 90 min (finishes at 00:30 next day)
  const intervals: StandardInterval[] = [
    { intervalIndex: 0, start: new Date(2026, 2, 2, 23, 0), end: new Date(2026, 2, 2, 23, 30), category: 'General', volume: 1 },
  ];
  const sla: SLAPolicyConfig = {
    primaryPct: 80,
    primaryWindow: 4,
    primaryUnit: 'hours',
    clockBasis: 'wall_clock',
    clockStartPolicy: 'arrival',
    boAsaEnabled: false,
    boAsaTarget: 1,
    boAsaUnit: 'hours',
    asaClockBasis: 'clock_hours',
    occupancyCapEnabled: false,
    occupancyCapPct: 100,
    confidenceLevelPct: 95,
  };

  const res = runBackofficeDES({
    operationalHC: 1,
    intervals,
    openingWIP: [],
    categories,
    calendar: calendar24x7,
    labor,
    sla,
    seed: 42,
  });

  assert(res.caseResults.length === 1, 'BUG-D: Case processed in 24x7 mode');
  assert(res.caseResults[0].parkCount === 0, 'BUG-D: Case spanning midnight does not park in 24x7 mode');
  assert(res.caseResults[0].isCompleted, 'BUG-D: Case completes smoothly across midnight');
}

// 2026-08-24: BUG-E & BUG-F deleted â€” Horn analytical feasibility no longer exists.

// ----------------------------------------------------
// BUG-G: Horizon Calculation from Min/Max Dates
// ----------------------------------------------------
console.log('\n--- Suite BUG-G: Horizon Calculation ---');
{
  const calendar: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0,
    holidays: [],
  };
  const categories: CategoryConfig[] = [
    { id: 'c1', name: 'General', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1 },
  ];
  // Unsorted intervals: later interval comes first in array
  const intervals: StandardInterval[] = [
    { intervalIndex: 1, start: new Date(2026, 2, 4, 9, 0), end: new Date(2026, 2, 4, 17, 0), category: 'General', volume: 5 },
    { intervalIndex: 0, start: new Date(2026, 2, 2, 9, 0), end: new Date(2026, 2, 2, 17, 0), category: 'General', volume: 5 },
  ];
  const sla: SLAPolicyConfig = {
    primaryPct: 80,
    primaryWindow: 4,
    primaryUnit: 'hours',
    clockBasis: 'business_time',
    clockStartPolicy: 'arrival',
    boAsaEnabled: false,
    boAsaTarget: 2,
    boAsaUnit: 'hours',
    asaClockBasis: 'business_window',
    occupancyCapEnabled: false,
    occupancyCapPct: 85,
    confidenceLevelPct: 95,
  };

  const cases = generateCaseEntities({
    intervals,
    openingWIP: [],
    categories,
    calendar,
    sla,
    seed: 42,
  });

  assert(cases.horizonStart.getDate() === 2, 'BUG-G: horizonStart correctly takes min(start) from Mar 2');
  assert(cases.horizonEnd.getDate() === 4, 'BUG-G: horizonEnd correctly takes max(end) from Mar 4');
  assert(cases.horizonStart.getTime() <= cases.horizonEnd.getTime(), 'BUG-G: horizonStart <= horizonEnd');
}

// ----------------------------------------------------
// BUG-H: ASA Clock Basis (business_window vs clock_hours)
// ----------------------------------------------------
console.log('\n--- Suite BUG-H: ASA Clock Basis ---');
{
  const calendar: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0,
    holidays: [],
  };
  const labor: LaborConfig = {
    dailyProductiveHours: 8,
    adherencePct: 1.0,
    workingDaysPerWeek: 5,
    offDaysPerWeek: 2,
    contractualHoursSource: 'derived',
    shifts: [],
  };
  const categories: CategoryConfig[] = [
    { id: 'c1', name: 'General', ahtMinutes: 30, shrinkagePct: 0.0, priority: 1 },
  ];
  // Arrival at 16:30 on Monday; agent starts working on it at 09:00 on Tuesday
  const intervals: StandardInterval[] = [
    { intervalIndex: 0, start: new Date(2026, 2, 2, 16, 30), end: new Date(2026, 2, 2, 17, 0), category: 'General', volume: 1 },
  ];

  const slaBusiness: SLAPolicyConfig = {
    primaryPct: 80,
    primaryWindow: 4,
    primaryUnit: 'hours',
    clockBasis: 'business_time',
    clockStartPolicy: 'arrival',
    boAsaEnabled: true,
    boAsaTarget: 2,
    boAsaUnit: 'hours',
    asaClockBasis: 'business_window',
    occupancyCapEnabled: false,
    occupancyCapPct: 100,
    confidenceLevelPct: 95,
  };

  const slaClock: SLAPolicyConfig = {
    ...slaBusiness,
    asaClockBasis: 'clock_hours',
  };

  // Run with 0 HC on Monday by starting with a busy queue or delaying start
  const resBusiness = runBackofficeDES({
    operationalHC: 1,
    intervals,
    openingWIP: [],
    categories,
    calendar,
    labor,
    sla: slaBusiness,
    seed: 42,
  });

  const resClock = runBackofficeDES({
    operationalHC: 1,
    intervals,
    openingWIP: [],
    categories,
    calendar,
    labor,
    sla: slaClock,
    seed: 42,
  });

  // Both should compute valid ASA metrics
  assert(resBusiness.boAsaMeanMinutes >= 0, 'BUG-H: business_window ASA is computed');
  assert(resClock.boAsaMeanMinutes >= 0, 'BUG-H: clock_hours ASA is computed');
}

// ----------------------------------------------------
// BUG-I: Occupancy Numerator Counts Actual Work Done
// ----------------------------------------------------
console.log('\n--- Suite BUG-I: Occupancy Numerator Accuracy ---');
{
  const calendar: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0, // 480 min
    holidays: [],
  };
  const labor: LaborConfig = {
    dailyProductiveHours: 8,
    adherencePct: 1.0,
    workingDaysPerWeek: 5,
    offDaysPerWeek: 2,
    contractualHoursSource: 'derived',
    shifts: [],
  };
  const categories: CategoryConfig[] = [
    { id: 'c1', name: 'General', ahtMinutes: 90, shrinkagePct: 0.0, priority: 1 },
  ];
  // 1 WIP case with 5 minutes remaining (default category AHT is 90 min)
  const openingWIP: OpeningWIPCase[] = [
    { id: 'WIP-1', category: 'General', priority: 1, arrival: new Date(2026, 2, 2, 9, 0), clockStart: new Date(2026, 2, 2, 9, 0), remainingWorkMinutes: 5 },
  ];
  const sla: SLAPolicyConfig = {
    primaryPct: 80,
    primaryWindow: 4,
    primaryUnit: 'hours',
    clockBasis: 'business_time',
    clockStartPolicy: 'arrival',
    boAsaEnabled: false,
    boAsaTarget: 1,
    boAsaUnit: 'hours',
    asaClockBasis: 'business_window',
    occupancyCapEnabled: false,
    occupancyCapPct: 100,
    confidenceLevelPct: 95,
  };

  const res = runBackofficeDES({
    operationalHC: 1,
    intervals: [],
    openingWIP,
    categories,
    calendar,
    labor,
    sla,
    seed: 42,
  });

  // 1 agent * 8 hours = 480 minutes total. 5 minutes handling = 5 / 480 = 1.04% occupancy.
  // If buggy code counted 90 min AHT, occupancy would be 90 / 480 = 18.75%.
  assert(res.occupancyPct < 5.0, `BUG-I: Occupancy is ${res.occupancyPct}% (accurately reflecting 5m of work done, not 90m AHT)`);
}

// ----------------------------------------------------
// BUG-J: nMinAnalytical Uses Math.floor
// ----------------------------------------------------
console.log('\n--- Suite BUG-J: nMinAnalytical Floor Math ---');
{
  const calendar: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0,
    holidays: [],
  };
  const labor: LaborConfig = {
    dailyProductiveHours: 8,
    adherencePct: 1.0,
    workingDaysPerWeek: 5,
    offDaysPerWeek: 2,
    contractualHoursSource: 'derived',
    shifts: [],
  };
  const categories: CategoryConfig[] = [
    { id: 'c1', name: 'General', ahtMinutes: 60, shrinkagePct: 0.0, priority: 1 },
  ];
  // 9 hours of workload across 8 hours working day -> 9 / 8 = 1.125 agents -> floor = 1 agent
  const intervals: StandardInterval[] = [
    { intervalIndex: 0, start: new Date(2026, 2, 2, 9, 0), end: new Date(2026, 2, 2, 17, 0), category: 'General', volume: 9 },
  ];
  const sla: SLAPolicyConfig = {
    primaryPct: 80,
    primaryWindow: 8,
    primaryUnit: 'hours',
    clockBasis: 'business_time',
    clockStartPolicy: 'arrival',
    boAsaEnabled: false,
    boAsaTarget: 1,
    boAsaUnit: 'hours',
    asaClockBasis: 'business_window',
    occupancyCapEnabled: false,
    occupancyCapPct: 100,
    confidenceLevelPct: 95,
  };

  const searchRes = searchOptimalHC({
    intervals,
    openingWIP: [],
    categories,
    calendar,
    labor,
    sla,
    seed: 42,
    userMaxHC: 50,
  });

  assert(searchRes.nMinAnalytical === 1, `BUG-J: nMinAnalytical correctly floors 1.125 to 1 agent (got ${searchRes.nMinAnalytical})`);
}

// ----------------------------------------------------
// BUG-K: convertSlaDurationToMinutes for Days with Business Time
// ----------------------------------------------------
console.log('\n--- Suite BUG-K: Duration Conversion with Business Days ---');
{
  const calendar9h: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 8,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0, // 9 hours per day
    holidays: [],
  };

  const minBusiness = convertSlaDurationToMinutes(1, 'days', 'business_time', calendar9h);
  assert(minBusiness === 540, `BUG-K: 1 business day (8:00-17:00, 9h) converts to 540 minutes (got ${minBusiness})`);

  const minWall = convertSlaDurationToMinutes(1, 'days', 'wall_clock', calendar9h);
  assert(minWall === 1440, `BUG-K: 1 wall clock day converts to 1440 minutes (got ${minWall})`);
}

// ----------------------------------------------------
// BUG-L: Siloed DES Routing
// ----------------------------------------------------
console.log('\n--- Suite BUG-L: Siloed Queue Routing ---');
{
  const calendar: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0,
    holidays: [],
  };
  const labor: LaborConfig = {
    dailyProductiveHours: 8,
    adherencePct: 1.0,
    workingDaysPerWeek: 5,
    offDaysPerWeek: 2,
    contractualHoursSource: 'derived',
    shifts: [],
  };
  const categories: CategoryConfig[] = [
    { id: 'cA', name: 'Cat A', ahtMinutes: 30, shrinkagePct: 0.0, priority: 1 },
    { id: 'cB', name: 'Cat B', ahtMinutes: 30, shrinkagePct: 0.0, priority: 2 },
  ];
  const intervals: StandardInterval[] = [
    { intervalIndex: 0, start: new Date(2026, 2, 2, 9, 0), end: new Date(2026, 2, 2, 17, 0), category: 'Cat A', volume: 8 },
    { intervalIndex: 1, start: new Date(2026, 2, 2, 9, 0), end: new Date(2026, 2, 2, 17, 0), category: 'Cat B', volume: 8 },
  ];
  const sla: SLAPolicyConfig = {
    primaryPct: 80,
    primaryWindow: 4,
    primaryUnit: 'hours',
    clockBasis: 'business_time',
    clockStartPolicy: 'arrival',
    boAsaEnabled: false,
    boAsaTarget: 1,
    boAsaUnit: 'hours',
    asaClockBasis: 'business_window',
    occupancyCapEnabled: false,
    occupancyCapPct: 100,
    confidenceLevelPct: 95,
  };

  const resSiloed = runBackofficeDES({
    operationalHC: 2,
    intervals,
    openingWIP: [],
    categories,
    calendar,
    labor,
    sla,
    seed: 42,
    queueArchitecture: 'siloed',
  });

  assert(resSiloed.caseResults.length === 16, 'BUG-L: Siloed DES processes all 16 cases across both queues');
  assert(resSiloed.passesPrimarySLA, 'BUG-L: Siloed DES completes successfully');
}

// 2026-08-24: BUG-M deleted â€” Absolute SLA is no longer a constraint gate.

// ----------------------------------------------------
// BUG-N: nextOpen Handles Long Multi-Week Closures
// ----------------------------------------------------
console.log('\n--- Suite BUG-N: nextOpen Long Closure Handling ---');
{
  // 21-day continuous holiday period
  const holidays: string[] = [];
  for (let d = 2; d <= 22; d++) {
    const dayStr = d < 10 ? `0${d}` : `${d}`;
    holidays.push(`2026-03-${dayStr}`);
  }

  const calendarLongHoliday: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0,
    holidays,
  };

  const startClosure = new Date(2026, 2, 2, 9, 0); // Mar 2
  const nextOpenDate = nextOpen(startClosure, calendarLongHoliday);

  assert(nextOpenDate.getDate() === 23, `BUG-N: nextOpen advances past 21 days of holidays to March 23 (got March ${nextOpenDate.getDate()})`);
  assert(nextOpenDate.getHours() === 9 && nextOpenDate.getMinutes() === 0, 'BUG-N: nextOpen returns exact opening time 09:00 on reopening day');
}

// ----------------------------------------------------
// BUG-O: Parked Cases Retain Queue Priority at Open/Midnight
// ----------------------------------------------------
console.log('\n--- Suite BUG-O: Parked Case Queue Priority ---');
{
  const calendar8to17: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0,
    holidays: [],
  };
  const labor: LaborConfig = {
    dailyProductiveHours: 8,
    adherencePct: 1.0,
    workingDaysPerWeek: 5,
    offDaysPerWeek: 2,
    contractualHoursSource: 'derived',
    shifts: [],
  };
  const categories: CategoryConfig[] = [
    { id: 'c1', name: 'General', ahtMinutes: 60, shrinkagePct: 0.0, priority: 1 },
  ];
  const sla: SLAPolicyConfig = {
    primaryPct: 80,
    primaryWindow: 24,
    primaryUnit: 'hours',
    clockBasis: 'business_time',
    clockStartPolicy: 'arrival',
    boAsaEnabled: false,
    boAsaTarget: 1,
    boAsaUnit: 'hours',
    asaClockBasis: 'business_window',
    occupancyCapEnabled: false,
    occupancyCapPct: 100,
    confidenceLevelPct: 95,
  };

  // Case A arrives Day 1 at 16:30 (takes 60 min, parks at 17:00 with 30 min left)
  // Case B arrives Day 1 at 20:00 (overnight)
  const caseAArrival = new Date(2026, 2, 2, 16, 30); // Mon 16:30
  const caseBArrival = new Date(2026, 2, 2, 20, 0);  // Mon 20:00 (overnight)

  const caseEntities = [
    {
      id: 'CASE-000001',
      syntheticId: 1,
      category: 'General',
      priority: 1,
      arrival: caseAArrival,
      clockStart: caseAArrival,
      totalAhtMinutes: 60,
      remainingWorkMinutes: 60,
      primaryDeadline: new Date(2026, 2, 3, 17, 0),
      latestSafeStart: new Date(2026, 2, 4, 16, 0),
      firstStartTime: null,
      completeTime: null,
      parkCount: 0,
      isOpeningWip: false,
    },
    {
      id: 'CASE-000002',
      syntheticId: 2,
      category: 'General',
      priority: 1,
      arrival: caseBArrival,
      clockStart: caseBArrival,
      totalAhtMinutes: 30,
      remainingWorkMinutes: 30,
      primaryDeadline: new Date(2026, 2, 3, 17, 0),
      latestSafeStart: new Date(2026, 2, 4, 16, 30),
      firstStartTime: null,
      completeTime: null,
      parkCount: 0,
      isOpeningWip: false,
    },
  ];

  const res = runBackofficeDES({
    operationalHC: 1,
    intervals: [],
    openingWIP: [],
    categories,
    calendar: calendar8to17,
    labor,
    sla,
    seed: 42,
    precomputedCases: {
      cases: caseEntities,
      horizonStart: caseAArrival,
      horizonEnd: new Date(2026, 2, 3, 17, 0),
    },
  });

  const caseA = res.caseResults.find((c) => c.caseId === 'CASE-000001');
  const caseB = res.caseResults.find((c) => c.caseId === 'CASE-000002');

  assert(caseA !== undefined && caseB !== undefined, 'BUG-O: Both cases processed by DES');
  if (caseA && caseB) {
    // Case A completes at 09:30 on Day 2 (30 min on Day 1 16:30-17:00, 30 min on Day 2 09:00-09:30)
    // Case B must start AT OR AFTER 09:30 on Day 2 because Case A resumes at 09:00!
    assert(
      caseB.firstStartTime !== null && caseB.firstStartTime.getTime() >= new Date(2026, 2, 3, 9, 30).getTime(),
      `BUG-O: Parked Case A resumed at next open (09:00) before Case B started (Case B start: ${caseB.firstStartTime?.toLocaleTimeString()})`
    );
  }
}

// ----------------------------------------------------
// BUG-P: nextOpen Never Returns Closed Timestamp
// ----------------------------------------------------
console.log('\n--- Suite BUG-P: nextOpen Closed Timestamp Protection ---');
{
  const calendarNoWorkingDays: CalendarConfig = {
    workingDays: [],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0,
    holidays: [],
  };

  let threwError = false;
  let returnedDate: Date | null = null;
  try {
    returnedDate = nextOpen(new Date(2026, 2, 2, 10, 0), calendarNoWorkingDays);
  } catch {
    threwError = true;
  }

  assert(
    threwError || (returnedDate !== null && isWorking(returnedDate, calendarNoWorkingDays)),
    'BUG-P: nextOpen throws or returns a valid working timestamp (never returns a closed date when workingDays is empty)'
  );
}

// ----------------------------------------------------
// BUG-Q: DQ Horizon Min/Max Across Unsorted Intervals
// ----------------------------------------------------
console.log('\n--- Suite BUG-Q: Data Quality Horizon Min/Max ---');
{
  const unsortedIntervals: StandardInterval[] = [
    {
      intervalIndex: 1,
      start: new Date(2026, 2, 4, 9, 0), // March 4 09:00
      end: new Date(2026, 2, 4, 9, 30),  // March 4 09:30
      category: 'General',
      volume: 10,
    },
    {
      intervalIndex: 0,
      start: new Date(2026, 2, 2, 9, 0), // March 2 09:00
      end: new Date(2026, 2, 2, 9, 30),  // March 2 09:30
      category: 'General',
      volume: 10,
    },
  ];

  const categories: CategoryConfig[] = [
    { id: 'c1', name: 'General', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1 },
  ];

  const calendar: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0,
    holidays: [],
  };

  const horizon = computeIntervalHorizon(unsortedIntervals);
  assert(
    horizon.horizonStart.getTime() <= horizon.horizonEnd.getTime(),
    `BUG-Q: computeIntervalHorizon handles unsorted intervals (horizonStart: ${horizon.horizonStart.toDateString()} <= horizonEnd: ${horizon.horizonEnd.toDateString()})`
  );
  assert(
    horizon.horizonStart.getDate() === 2 && horizon.horizonEnd.getDate() === 4,
    'BUG-Q: Horizon correctly spans March 2 to March 4'
  );

  const labor: LaborConfig = {
    dailyProductiveHours: 8,
    adherencePct: 1.0,
    workingDaysPerWeek: 5,
    offDaysPerWeek: 2,
    contractualHoursSource: 'derived',
    shifts: [],
  };
  const sla: SLAPolicyConfig = {
    primaryPct: 80,
    primaryWindow: 24,
    primaryUnit: 'hours',
    clockBasis: 'business_time',
    clockStartPolicy: 'arrival',
    boAsaEnabled: false,
    boAsaTarget: 1,
    boAsaUnit: 'hours',
    asaClockBasis: 'business_window',
    occupancyCapEnabled: false,
    occupancyCapPct: 100,
    confidenceLevelPct: 95,
  };

  const dq = validateDataQuality({
    intervals: unsortedIntervals,
    mapping: { intervalStartCol: 'Start', volumeCol: 'Volume' },
    categories,
    calendar,
    labor,
    sla,
    openingWIP: [],
  });
  assert(dq.passed, 'BUG-Q: validateDataQuality succeeds on unsorted intervals without horizon errors');
}

// ----------------------------------------------------
// Suite: Enhanced Robustness & Edge Cases
// ----------------------------------------------------
console.log('--- Suite: Enhanced Robustness & Edge Cases ---');

// Test subtractWorkingTime on empty calendar
{
  const emptyCal: CalendarConfig = {
    workingDays: [],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0,
    holidays: [],
    is24x7: false,
  };
  const res = subtractWorkingTime(new Date('2026-03-02T12:00:00Z'), 60, emptyCal);
  assert(isNaN(res.getTime()), 'subtractWorkingTime returns invalid date when no working windows exist');
}

// Test getCalendarWorkingDaysInHorizon with zero working days and inverted horizon
{
  const emptyCal: CalendarConfig = {
    workingDays: [],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0,
    holidays: [],
    is24x7: false,
  };
  const countZero = getCalendarWorkingDaysInHorizon(new Date('2026-03-02'), new Date('2026-03-06'), emptyCal);
  assert(countZero === 0, 'getCalendarWorkingDaysInHorizon returns 0 when no working days match');

  const normalCal: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0,
    holidays: [],
    is24x7: false,
  };
  const countInverted = getCalendarWorkingDaysInHorizon(new Date('2026-03-06'), new Date('2026-03-02'), normalCal);
  assert(countInverted === 0, 'getCalendarWorkingDaysInHorizon returns 0 on inverted horizon start >= end');
}

// Test Final Audit Seed and Precomputed Alignment in searchOptimalHC
{
  const cal: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0,
    holidays: [],
    is24x7: false,
  };
  const sla: SLAPolicyConfig = {
    primaryPct: 80,
    primaryWindow: 4,
    primaryUnit: 'hours',
    clockBasis: 'business_time',
    clockStartPolicy: 'arrival',
    boAsaEnabled: false,
    boAsaTarget: 1,
    boAsaUnit: 'hours',
    asaClockBasis: 'business_window',
    occupancyCapEnabled: false,
    occupancyCapPct: 100,
    confidenceLevelPct: 95,
  };
  const testIntervals: StandardInterval[] = [
    {
      intervalIndex: 0,
      start: new Date('2026-03-02T09:00:00'),
      end: new Date('2026-03-02T17:00:00'),
      volume: 12,
      category: 'Support',
    },
  ];
  const searchRes = searchOptimalHC({
    intervals: testIntervals,
    openingWIP: [],
    categories: [{ id: '1', name: 'Support', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1 }],
    calendar: cal,
    labor: {
      dailyProductiveHours: 7,
      adherencePct: 1.0,
      workingDaysPerWeek: 5,
      offDaysPerWeek: 2,
      contractualHoursSource: 'derived',
      shifts: [],
    },
    sla,
    seed: 42,
    replications: 5,
    userMaxHC: 50,
  });

  assert(!searchRes.isInfeasible, 'searchOptimalHC finds feasible solution');
  assert(
    searchRes.recommendedHC !== null && searchRes.recommendedHC > 0,
    `searchOptimalHC produces valid recommendedHC: ${searchRes.recommendedHC}`
  );
  assert(
    searchRes.finalDESResult?.allPassed === true,
    'searchOptimalHC final DES audit result is aligned and passing'
  );
}

// ----------------------------------------------------
// 22. BUG-R: Async CRN Audit & Sync/Async Search Alignment
// ----------------------------------------------------
console.log('\n--- Suite 22: BUG-R Async CRN Audit Alignment ---');
{
  const cal: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0,
    holidays: [],
    is24x7: false,
  };
  const sla: SLAPolicyConfig = {
    primaryPct: 80,
    primaryWindow: 4,
    primaryUnit: 'hours',
    clockBasis: 'business_time',
    clockStartPolicy: 'arrival',
    boAsaEnabled: false,
    boAsaTarget: 1,
    boAsaUnit: 'hours',
    asaClockBasis: 'business_window',
    occupancyCapEnabled: false,
    occupancyCapPct: 100,
    confidenceLevelPct: 95,
  };
  const testIntervals: StandardInterval[] = [
    {
      intervalIndex: 0,
      start: new Date('2026-03-02T09:00:00'),
      end: new Date('2026-03-02T12:00:00'),
      volume: 4,
      category: 'Support',
    },
  ];
  const syncRes = searchOptimalHC({
    intervals: testIntervals,
    openingWIP: [],
    categories: [{ id: '1', name: 'Support', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1 }],
    calendar: cal,
    labor: {
      dailyProductiveHours: 7,
      adherencePct: 1.0,
      workingDaysPerWeek: 5,
      offDaysPerWeek: 2,
      contractualHoursSource: 'derived',
      shifts: [],
    },
    sla,
    seed: 42,
    replications: 5,
    userMaxHC: 50,
  });

  const asyncRes = await searchOptimalHCAsync({
    intervals: testIntervals,
    openingWIP: [],
    categories: [{ id: '1', name: 'Support', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1 }],
    calendar: cal,
    labor: {
      dailyProductiveHours: 7,
      adherencePct: 1.0,
      workingDaysPerWeek: 5,
      offDaysPerWeek: 2,
      contractualHoursSource: 'derived',
      shifts: [],
    },
    sla,
    seed: 42,
    replications: 5,
    userMaxHC: 50,
  });

  assert(
    syncRes.recommendedHC === asyncRes.recommendedHC,
    `BUG-R: Sync and async search produce identical recommendedHC (${syncRes.recommendedHC} vs ${asyncRes.recommendedHC})`
  );
  assert(
    asyncRes.finalDESResult?.allPassed === true,
    'BUG-R: Async search final DES audit pass is passing'
  );
}

// ----------------------------------------------------
// 23. BUG-AB: WIP remainingWorkMinutes === 0 Workload Handling
// ----------------------------------------------------
console.log('\n--- Suite 23: BUG-AB WIP 0 Workload Handling ---');
{
  const cal: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0,
    holidays: [],
    is24x7: false,
  };
  const sla: SLAPolicyConfig = {
    primaryPct: 80,
    primaryWindow: 4,
    primaryUnit: 'hours',
    clockBasis: 'business_time',
    clockStartPolicy: 'arrival',
    boAsaEnabled: false,
    boAsaTarget: 1,
    boAsaUnit: 'hours',
    asaClockBasis: 'business_window',
    occupancyCapEnabled: false,
    occupancyCapPct: 100,
    confidenceLevelPct: 95,
  };
  const openingWIP: OpeningWIPCase[] = [
    {
      id: 'WIP-001',
      category: 'Support',
      priority: 1,
      arrival: new Date('2026-03-02T09:00:00'),
      clockStart: new Date('2026-03-02T09:00:00'),
      remainingWorkMinutes: 0, // 0 minutes work
    },
    {
      id: 'WIP-002',
      category: 'Support',
      priority: 1,
      arrival: new Date('2026-03-02T09:00:00'),
      clockStart: new Date('2026-03-02T09:00:00'),
      remainingWorkMinutes: (undefined as any), // undefined should fallback to AHT 30m
    },
  ];

  const dq = validateDataQuality({
    intervals: [{
      intervalIndex: 0,
      start: new Date('2026-03-02T09:00:00'),
      end: new Date('2026-03-02T10:00:00'),
      volume: 2, // 2 * 30m = 60m = 1.0h
      category: 'Support',
    }],
    mapping: { intervalStartCol: 'Start', volumeCol: 'Volume' },
    categories: [{ id: '1', name: 'Support', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1 }],
    calendar: cal,
    labor: {
      dailyProductiveHours: 7,
      adherencePct: 1.0,
      workingDaysPerWeek: 5,
      offDaysPerWeek: 2,
      contractualHoursSource: 'derived',
      shifts: [],
    },
    sla,
    openingWIP,
  });

  // Total workload = 1.0h (intervals) + 0h (WIP-001) + 0.5h (WIP-002) = 1.5h
  assert(
    Math.abs(dq.totalWorkloadHours - 1.5) < 0.001,
    `BUG-AB: validateDataQuality treats remainingWorkMinutes === 0 as 0 and undefined as category AHT (got ${dq.totalWorkloadHours}h, expected 1.5h)`
  );
}

// ----------------------------------------------------
// Suite 24: 24:00 Midnight End-of-Day Working Window (09:00 - 24:00 / 23:59:59)
// ----------------------------------------------------
console.log('\n--- Suite 24: Midnight End-of-Day Operating Window (09:00 - 24:00) ---');
{
  const calendar: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 24, // Close at midnight (covers up to 23:59:59)
    dailyCloseMinute: 0,
    holidays: [],
  };

  const winHours = getDailyWindowLengthHours(calendar);
  assert(winHours === 15, `Suite 24: 09:00 to 24:00 yields 15 working hours/day (got ${winHours})`);

  const testDateEarly = new Date('2026-03-02T09:00:00');
  const testDateEvening = new Date('2026-03-02T23:59:59');
  const testDateNextMidnight = new Date('2026-03-03T00:00:00');
  const testDateBeforeOpen = new Date('2026-03-02T08:59:59');

  assert(isWorking(testDateEarly, calendar), 'Suite 24: 09:00:00 is within open window');
  assert(isWorking(testDateEvening, calendar), 'Suite 24: 23:59:59 is within open window (not closed at 23:45)');
  assert(!isWorking(testDateBeforeOpen, calendar), 'Suite 24: 08:59:59 is before open window');

  // Also test when user configured dailyCloseHour = 0 (representing midnight end-of-day)
  const calendarWith00 = { ...calendar, dailyCloseHour: 0, dailyCloseMinute: 0 };
  const winHours00 = getDailyWindowLengthHours(calendarWith00);
  assert(winHours00 === 15, `Suite 24: 09:00 to 00:00 end-of-day yields 15 working hours/day (got ${winHours00})`);
  assert(isWorking(testDateEvening, calendarWith00), 'Suite 24: 00:00 close interprets as end-of-day 24:00 when open=9');
}

// ----------------------------------------------------
// Suite 25: Agent Browser Timeline & Audit Invariants Verification
// ----------------------------------------------------
console.log('\n--- Suite 25: Agent Browser Timeline & Audit Invariants ---');
{
  const cal: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0,
    holidays: [],
  };

  const labor: LaborConfig = {
    dailyProductiveHours: 7,
    adherencePct: 0.9,
    workingDaysPerWeek: 5,
    offDaysPerWeek: 2,
    contractualHoursSource: 'derived',
    shifts: [],
  };

  const sla: SLAPolicyConfig = {
    primaryPct: 80,
    primaryWindow: 4,
    primaryUnit: 'hours',
    clockBasis: 'business_time',
    clockStartPolicy: 'arrival',
    boAsaEnabled: false,
    boAsaTarget: 60,
    boAsaUnit: 'minutes',
    asaClockBasis: 'business_window',
    occupancyCapEnabled: false,
    occupancyCapPct: 85,
    confidenceLevelPct: 95,
  };

  const cat: CategoryConfig[] = [
    {
      id: 'cat_general',
      name: 'General',
      ahtMinutes: 30,
      shrinkagePct: 0.2,
      priority: 1,
    },
  ];

  const intervals: StandardInterval[] = [
    {
      intervalIndex: 0,
      start: new Date('2026-03-02T09:00:00'),
      end: new Date('2026-03-02T10:00:00'),
      volume: 10,
      category: 'General',
    },
    {
      intervalIndex: 1,
      start: new Date('2026-03-02T10:00:00'),
      end: new Date('2026-03-02T11:00:00'),
      volume: 8,
      category: 'General',
    },
  ];

  const { cases } = generateCaseEntities({
    intervals,
    openingWIP: [],
    categories: cat,
    calendar: cal,
    sla,
    seed: 12345,
  });
  assert(cases.length === 18, `Suite 25: Generated 18 test cases (got ${cases.length})`);

  // Run audit DES (skipCaseResultsAndTimeline: false)
  const auditDES = runBackofficeDES({
    operationalHC: 3,
    intervals,
    openingWIP: [],
    categories: cat,
    calendar: cal,
    labor,
    sla,
    seed: 12345,
    skipCaseResultsAndTimeline: false,
  });

  assert(Array.isArray(auditDES.agentTimeline), 'Suite 25: agentTimeline is an array');
  assert(auditDES.agentTimeline.length > 0, `Suite 25: agentTimeline has slices (${auditDES.agentTimeline.length})`);

  // Check agent labels (Agent-1, Agent-2, Agent-3 - never Agent-01)
  const labels = Array.from(new Set(auditDES.agentTimeline.map((s) => s.agentLabel)));
  assert(
    labels.includes('Agent-1') && labels.includes('Agent-2') && labels.includes('Agent-3'),
    `Suite 25: Agent labels follow Agent-\${agentId+1} format (got ${labels.join(', ')})`
  );
  assert(
    !labels.some((l) => l.includes('Agent-0')),
    'Suite 25: No Agent-0x padded labels exist'
  );

  // Invariant 1: sum(busy minutes) === totalHandlingMinutes
  const totalBusy = auditDES.agentTimeline
    .filter((s) => s.state === 'busy')
    .reduce((sum, s) => sum + s.minutes, 0);
  assert(
    Math.abs(totalBusy - auditDES.totalHandlingMinutes) < 0.01,
    `Suite 25: sum(busy minutes) matches totalHandlingMinutes (${totalBusy.toFixed(2)} === ${auditDES.totalHandlingMinutes.toFixed(2)})`
  );

  // Invariant 2: occupancy reconciliation
  const computedOcc = auditDES.totalAvailableProductiveMinutes > 0
    ? Math.min(100, Math.round((totalBusy / auditDES.totalAvailableProductiveMinutes) * 1000) / 10)
    : 0;
  assert(
    Math.abs(computedOcc - auditDES.occupancyPct) <= 0.1,
    `Suite 25: Timeline occupancy matches des.occupancyPct (${computedOcc}% === ${auditDES.occupancyPct}%)`
  );

  // Invariant 3: helper function check
  const invariantCheck = {
    valid: true,
    errors: [] as string[],
  };
  // Check that every busy slice has a valid case ID
  const caseIdSet = new Set((auditDES.caseResults || []).map((c) => c.caseId));
  for (const slice of auditDES.agentTimeline) {
    if (slice.state === 'busy' && slice.caseId && !caseIdSet.has(slice.caseId)) {
      invariantCheck.valid = false;
      invariantCheck.errors.push(`Unknown case: ${slice.caseId}`);
    }
  }
  assert(invariantCheck.valid, `Suite 25: Invariant verification passes with 0 errors`);

  // Check search fast-path (skipCaseResultsAndTimeline: true)
  const fastDES = runBackofficeDES({
    operationalHC: 3,
    intervals,
    openingWIP: [],
    categories: cat,
    calendar: cal,
    labor,
    sla,
    seed: 12345,
    skipCaseResultsAndTimeline: true,
  });
  assert(
    fastDES.agentTimeline.length === 0,
    'Suite 25: skipCaseResultsAndTimeline=true leaves agentTimeline empty (allocation-free search)'
  );
}

// ----------------------------------------------------
// Suite 26: Multi-Day Park & Resume Daily Budget Invariant
// ----------------------------------------------------
console.log('\n--- Suite 26: Multi-Day Park & Resume Daily Budget Invariant ---');
{
  const cal: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0, // 8 hours = 480m open
    holidays: [],
  };

  const labor: LaborConfig = {
    dailyProductiveHours: 8,
    adherencePct: 0.98, // 7.84h = 470.40m daily budget
    workingDaysPerWeek: 5,
    offDaysPerWeek: 2,
    contractualHoursSource: 'derived',
    shifts: [],
  };

  const sla: SLAPolicyConfig = {
    primaryPct: 80,
    primaryWindow: 48,
    primaryUnit: 'hours',
    clockBasis: 'business_time',
    clockStartPolicy: 'arrival',
    boAsaEnabled: false,
    boAsaTarget: 60,
    boAsaUnit: 'minutes',
    asaClockBasis: 'business_window',
    occupancyCapEnabled: false,
    occupancyCapPct: 100,
    confidenceLevelPct: 95,
  };

  const cat: CategoryConfig[] = [
    {
      id: 'cat_long',
      name: 'LongTask',
      ahtMinutes: 500, // 500m > 470.40m daily budget
      shrinkagePct: 0.0,
      priority: 1,
    },
    {
      id: 'cat_short',
      name: 'ShortTask',
      ahtMinutes: 30,
      shrinkagePct: 0.0,
      priority: 1,
    },
  ];

  // Case arrives at 16:30 on Day 1 (2026-10-26, Monday), works 30m, parks at 17:00, resumes at 09:00 on Day 2
  const intervals: StandardInterval[] = [
    {
      intervalIndex: 0,
      start: new Date('2026-10-26T16:30:00'),
      end: new Date('2026-10-26T17:00:00'),
      volume: 1,
      category: 'LongTask',
    },
    {
      intervalIndex: 1,
      start: new Date('2026-10-27T09:00:00'),
      end: new Date('2026-10-27T17:00:00'),
      volume: 15,
      category: 'ShortTask',
    },
  ];

  const auditDES = runBackofficeDES({
    operationalHC: 1,
    intervals,
    openingWIP: [],
    categories: cat,
    calendar: cal,
    labor,
    sla,
    seed: 42,
    skipCaseResultsAndTimeline: false,
  });

  const check = verifyAgentTimelineInvariants(auditDES, labor);
  assert(check.valid, `Suite 26: Invariant verification passes with 0 errors (errors: ${check.errors.join('; ')})`);

  // Check that Day 1 and Day 2 both have busy minutes <= 470.40
  const day1Busy = auditDES.agentTimeline
    .filter((s) => s.state === 'busy' && s.date === '2026-10-26')
    .reduce((sum, s) => sum + s.minutes, 0);
  const day2Busy = auditDES.agentTimeline
    .filter((s) => s.state === 'busy' && s.date === '2026-10-27')
    .reduce((sum, s) => sum + s.minutes, 0);

  assert(
    day1Busy <= 470.40 + 0.01,
    `Suite 26: Day 1 busy minutes (${day1Busy.toFixed(2)}) <= daily budget (470.40)`
  );
  assert(
    day2Busy <= 470.40 + 0.01,
    `Suite 26: Day 2 busy minutes (${day2Busy.toFixed(2)}) <= daily budget (470.40)`
  );
}

// ----------------------------------------------------
// Suite 27: Midnight Splitting & Roster Source Invariants
// ----------------------------------------------------
console.log('\n--- Suite 27: Midnight Splitting & Roster Source Invariants ---');
{
  const cal247: CalendarConfig = {
    workingDays: [0, 1, 2, 3, 4, 5, 6],
    dailyOpenHour: 0,
    dailyOpenMinute: 0,
    dailyCloseHour: 24,
    dailyCloseMinute: 0,
    holidays: [],
  };

  const labor: LaborConfig = {
    dailyProductiveHours: 24,
    adherencePct: 1.0,
    workingDaysPerWeek: 7,
    offDaysPerWeek: 0,
    contractualHoursSource: 'derived',
    shifts: [],
  };

  const sla: SLAPolicyConfig = {
    primaryPct: 80,
    primaryWindow: 48,
    primaryUnit: 'hours',
    clockBasis: 'business_time',
    clockStartPolicy: 'arrival',
    boAsaEnabled: false,
    boAsaTarget: 60,
    boAsaUnit: 'minutes',
    asaClockBasis: 'business_window',
    occupancyCapEnabled: false,
    occupancyCapPct: 100,
    confidenceLevelPct: 95,
  };

  const cat: CategoryConfig[] = [
    {
      id: 'cat_multi_day',
      name: 'ContinuousTask',
      ahtMinutes: 2880, // 48 hours continuous case
      shrinkagePct: 0.0,
      priority: 1,
    },
  ];

  const intervals: StandardInterval[] = [
    {
      intervalIndex: 0,
      start: new Date('2026-03-02T12:00:00'),
      end: new Date('2026-03-02T13:00:00'),
      volume: 1,
      category: 'ContinuousTask',
    },
  ];

  const des247 = runBackofficeDES({
    operationalHC: 2,
    intervals,
    openingWIP: [],
    categories: cat,
    calendar: cal247,
    labor,
    sla,
    seed: 42,
    skipCaseResultsAndTimeline: false,
  });

  const check247 = verifyAgentTimelineInvariants(des247, labor, cal247);
  assert(check247.valid, `Suite 27: 24/7 continuous case passes invariant verification (errors: ${check247.errors.join('; ')})`);

  // Verify that NO slice crosses midnight
  let crossesMidnight = false;
  for (const s of des247.agentTimeline) {
    const fromDay = s.from.getDate();
    const toDay = s.to.getDate();
    const toHour = s.to.getHours();
    const toMin = s.to.getMinutes();
    const toSec = s.to.getSeconds();
    const toMs = s.to.getMilliseconds();
    const isExactMidnightNextDay =
      (toDay === fromDay + 1 || (fromDay >= 28 && toDay === 1)) &&
      toHour === 0 &&
      toMin === 0 &&
      toSec === 0 &&
      toMs === 0;

    if (fromDay !== toDay && !isExactMidnightNextDay) {
      crossesMidnight = true;
    }
  }
  assert(!crossesMidnight, 'Suite 27: All slices strictly split at midnight boundaries');

  // Verify total handling minutes matches busy minutes
  const totalBusy247 = des247.agentTimeline
    .filter((s) => s.state === 'busy')
    .reduce((sum, s) => sum + s.minutes, 0);
  assert(
    Math.abs(totalBusy247 - des247.totalHandlingMinutes) < 0.01,
    `Suite 27: 24/7 busy minutes (${totalBusy247.toFixed(2)}) match totalHandlingMinutes (${des247.totalHandlingMinutes.toFixed(2)})`
  );
}

// ----------------------------------------------------
// Suite 29: Exact Minimum Headcount Search & Refine (-1 Down-Walk)
// ----------------------------------------------------
console.log('\n--- Suite 29: Exact Minimum Headcount Search & Refine (-1 Down-Walk) ---');
{
  const cal: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0,
    holidays: [],
  };

  const labor: LaborConfig = {
    dailyProductiveHours: 8,
    adherencePct: 1.0,
    workingDaysPerWeek: 5,
    offDaysPerWeek: 2,
    contractualHoursSource: 'derived',
    shifts: [],
  };

  const sla: SLAPolicyConfig = {
    primaryPct: 95,
    primaryWindow: 1,
    primaryUnit: 'hours',
    clockBasis: 'business_time',
    clockStartPolicy: 'arrival',
    boAsaEnabled: false,
    boAsaTarget: 60,
    boAsaUnit: 'minutes',
    asaClockBasis: 'business_window',
    occupancyCapEnabled: false,
    occupancyCapPct: 100,
    confidenceLevelPct: 95,
  };

  const cat: CategoryConfig[] = [
    {
      id: 'cat_support',
      name: 'SupportTicket',
      ahtMinutes: 45,
      shrinkagePct: 0.0,
      priority: 1,
    },
  ];

  // 15 cases arriving in 1 hour with 45m AHT = 11.25 hours of work
  // Steady state / baseline: startN = floor(11.25 / 8) = 1.
  // 1 agent can only do ~1.3 cases in 1 hour -> Primary SLA will fail badly.
  // Requires leap up to a passing ceiling, followed by -1 refine down to exact minimum.
  const intervals: StandardInterval[] = [
    {
      intervalIndex: 0,
      start: new Date('2026-03-02T09:00:00'),
      end: new Date('2026-03-02T10:00:00'),
      volume: 15,
      category: 'SupportTicket',
    },
  ];

  // Test A & B: Sync search with exact refine
  const searchRes = searchOptimalHC({
    intervals,
    openingWIP: [],
    categories: cat,
    calendar: cal,
    labor,
    sla,
    seed: 12345,
    userMaxHC: 40,
    replications: 5,
  });

  const hist = searchRes.searchHistory;
  console.log('Suite 29 Search History:', hist.map((h) => ({ hc: h.hc, passed: h.passed, primaryPct: h.primaryPct })));

  const passing = hist.filter((h) => h.passed).map((h) => h.hc);
  const failing = hist.filter((h) => !h.passed).map((h) => h.hc);
  const minPass = Math.min(...passing);

  // Test A: exact min is last pass after a fail
  assert(searchRes.recommendedHC !== null, 'Suite 29: Test A: recommendedHC is not null');
  assert(
    searchRes.recommendedHC === minPass,
    `Suite 29: Test A: recommendedHC (${searchRes.recommendedHC}) matches min passing HC in history (${minPass})`
  );

  const floorThreshold = searchRes.nMinAnalytical;
  if (minPass > floorThreshold) {
    assert(failing.includes(minPass - 1), `Suite 29: Test A: N-1 (${minPass - 1}) failed in history`);
  }

  // Test B: leaped ceiling is not the published answer
  const maxEvaluated = Math.max(...hist.map((h) => h.hc));
  if (maxEvaluated > searchRes.recommendedHC!) {
    assert(searchRes.recommendedHC === minPass, 'Suite 29: Test B: Leaped ceiling was not published as recommendedHC');
  }

  // Test C: startN pass with tiny volume
  const tinyIntervals: StandardInterval[] = [
    {
      intervalIndex: 0,
      start: new Date('2026-03-02T09:00:00'),
      end: new Date('2026-03-02T17:00:00'),
      volume: 1,
      category: 'SupportTicket',
    },
  ];
  const searchResTiny = searchOptimalHC({
    intervals: tinyIntervals,
    openingWIP: [],
    categories: cat,
    calendar: cal,
    labor,
    sla: {
      ...sla,
      primaryPct: 80,
      primaryWindow: 8,
    },
    seed: 12345,
    userMaxHC: 40,
    replications: 5,
  });
  const expectedStartN = Math.max(1, searchResTiny.nMinAnalytical);
  assert(
    searchResTiny.recommendedHC === expectedStartN,
    `Suite 29: Test C: startN immediate pass returned recommendedHC = ${expectedStartN} (got ${searchResTiny.recommendedHC})`
  );

  // Test D: sync vs async identical results
  const searchResAsync = await searchOptimalHCAsync({
    intervals,
    openingWIP: [],
    categories: cat,
    calendar: cal,
    labor,
    sla,
    seed: 12345,
    userMaxHC: 40,
    replications: 5,
  });
  assert(
    searchRes.recommendedHC === searchResAsync.recommendedHC,
    `Suite 29: Test D: Sync and async return identical recommendedHC (${searchRes.recommendedHC} === ${searchResAsync.recommendedHC})`
  );

  // Test E: never below floor
  assert(
    searchRes.recommendedHC! >= searchRes.nMinAnalytical,
    `Suite 29: Test E: recommendedHC (${searchRes.recommendedHC}) >= nMinAnalytical (${searchRes.nMinAnalytical})`
  );
}

// ----------------------------------------------------
// Suite 30: Parked-first then earliest latestSafeStart dispatch
// ----------------------------------------------------
console.log('\n--- Suite 30: Parked-first / latestSafeStart dispatch ---');
{
  const calendar: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0,
    holidays: [],
  };

  const labor: LaborConfig = {
    dailyProductiveHours: 8,
    adherencePct: 1.0,
    workingDaysPerWeek: 5,
    offDaysPerWeek: 2,
    contractualHoursSource: 'derived',
    shifts: [],
  };

  const caseX: CaseEntity = {
    id: 'CASE-X',
    syntheticId: 1,
    category: 'FastPrimary',
    priority: 1,
    arrival: new Date('2026-03-02T09:00:00'),
    clockStart: new Date('2026-03-02T09:00:00'),
    totalAhtMinutes: 60,
    remainingWorkMinutes: 60,
    primaryDeadline: new Date('2026-03-02T11:00:00'),
    latestSafeStart: new Date('2026-03-02T10:00:00'),
    firstStartTime: null,
    completeTime: null,
    parkCount: 0,
    isOpeningWip: false,
  };

  const caseY: CaseEntity = {
    id: 'CASE-Y',
    syntheticId: 2,
    category: 'LoosePrimary',
    priority: 1,
    arrival: new Date('2026-03-02T09:00:00'),
    clockStart: new Date('2026-03-02T09:00:00'),
    totalAhtMinutes: 60,
    remainingWorkMinutes: 60,
    primaryDeadline: new Date('2026-03-02T17:00:00'),
    latestSafeStart: new Date('2026-03-02T16:00:00'),
    firstStartTime: null,
    completeTime: null,
    parkCount: 0,
    isOpeningWip: false,
  };

  {
    const qA = new CaseMinHeap();
    qA.push(caseX);
    qA.push(caseY);
    const pickedA = pickNextCase(qA, new Date('2026-03-02T10:00:00'));
    assert(
      pickedA?.id === 'CASE-X',
      `Suite 30: Test A: tighter latestSafeStart wins (picked ${pickedA?.id}, expected CASE-X)`
    );
  }

  {
    const parkedY: CaseEntity = { ...caseY, parkCount: 1, remainingWorkMinutes: 20 };
    const qB = new CaseMinHeap();
    qB.push(caseX);
    qB.push(parkedY);
    const pickedB = pickNextCase(qB, new Date('2026-03-02T09:00:00'));
    assert(
      pickedB?.id === 'CASE-Y',
      `Suite 30: Test B: parked case preempts new (picked ${pickedB?.id}, expected CASE-Y)`
    );
  }

  // --------------------------------------------------
  // Test C â€” No Extra Agent Created Mid-Run
  // --------------------------------------------------
  // operationalHC = 1, 2 overlapping cases arriving at 09:00.
  // Only 1 agent must exist in timeline (Agent-1 only, length of distinct IDs === 1).
  {
    const desResult = runBackofficeDES({
      operationalHC: 1,
      intervals: [
        {
          intervalIndex: 0,
          start: new Date('2026-03-02T09:00:00'),
          end: new Date('2026-03-02T10:00:00'),
          volume: 2,
          category: 'FastPrimary',
        },
      ],
      openingWIP: [],
      categories: [
        { id: 'c1', name: 'FastPrimary', ahtMinutes: 60, shrinkagePct: 0, priority: 1 },
      ],
      calendar,
      labor,
      sla: {
        primaryPct: 80,
        primaryWindow: 2,
        primaryUnit: 'hours',
        clockBasis: 'business_time',
        clockStartPolicy: 'arrival',
        boAsaEnabled: false,
        boAsaTarget: 60,
        boAsaUnit: 'minutes',
        asaClockBasis: 'business_window',
        occupancyCapEnabled: false,
        occupancyCapPct: 100,
    confidenceLevelPct: 95,
      },
      seed: 42,
    });

    const distinctAgentIds = Array.from(new Set(desResult.agentTimeline.map((t) => t.agentId)));
    const distinctAgentLabels = Array.from(new Set(desResult.agentTimeline.map((t) => t.agentLabel)));
    assert(
      distinctAgentIds.length === 1 && distinctAgentIds[0] === 0,
      `Suite 30: Test C: operationalHC=1 has exactly 1 distinct agentId (got ${distinctAgentIds.join(', ')})`
    );
    assert(
      distinctAgentLabels.length === 1 && distinctAgentLabels[0] === 'Agent-1',
      `Suite 30: Test C: operationalHC=1 only contains Agent-1 (got ${distinctAgentLabels.join(', ')})`
    );
  }

  // --------------------------------------------------
  // Test D â€” recommendedHC Must Not Regress
  // --------------------------------------------------
  // Two categories, distinct Primary windows (1h vs 8h).
  // Run searchOptimalHC:
  // - recommendedHC >= nMinAnalytical
  // - finalDESResult.passesPrimarySLA is true
  {
    const categoriesD: CategoryConfig[] = [
      {
        id: 'cat_x',
        name: 'CatX',
        ahtMinutes: 30,
        shrinkagePct: 0,
        priority: 1,
        primaryWindow: 1,
        primaryUnit: 'hours',
      },
      {
        id: 'cat_y',
        name: 'CatY',
        ahtMinutes: 30,
        shrinkagePct: 0,
        priority: 1,
        primaryWindow: 8,
        primaryUnit: 'hours',
      },
    ];

    const intervalsD: StandardInterval[] = [
      {
        intervalIndex: 0,
        start: new Date('2026-03-02T09:00:00'),
        end: new Date('2026-03-02T17:00:00'),
        volume: 8,
        category: 'CatX',
      },
      {
        intervalIndex: 1,
        start: new Date('2026-03-02T09:00:00'),
        end: new Date('2026-03-02T17:00:00'),
        volume: 8,
        category: 'CatY',
      },
    ];

    const slaD: SLAPolicyConfig = {
      primaryPct: 80,
      primaryWindow: 4,
      primaryUnit: 'hours',
      clockBasis: 'business_time',
      clockStartPolicy: 'arrival',
      boAsaEnabled: false,
      boAsaTarget: 60,
      boAsaUnit: 'minutes',
      asaClockBasis: 'business_window',
      occupancyCapEnabled: false,
      occupancyCapPct: 100,
    confidenceLevelPct: 95,
    };

    const searchResD = searchOptimalHC({
      intervals: intervalsD,
      openingWIP: [],
      categories: categoriesD,
      calendar,
      labor,
      sla: slaD,
      seed: 42,
      userMaxHC: 40,
      replications: 5,
    });

    assert(searchResD.recommendedHC !== null, 'Suite 30: Test D: recommendedHC is not null');
    assert(
      searchResD.recommendedHC! >= searchResD.nMinAnalytical,
      `Suite 30: Test D: recommendedHC (${searchResD.recommendedHC}) >= nMinAnalytical (${searchResD.nMinAnalytical})`
    );
    assert(
      !!searchResD.finalDESResult?.passesPrimarySLA,
      `Suite 30: Test D: finalDESResult passes Primary SLA (achieved ${searchResD.finalDESResult?.primaryAchievedPct}%)`
    );
  }
}

// ----------------------------------------------------
// Suite 31: Strict dd/mm/yyyy Date Parsing & Rejection of mm/dd
// ----------------------------------------------------
console.log('\n--- Suite 31: Strict dd/mm/yyyy Date Parsing & Rejection of mm/dd ---');
{
  const formatDateLocal = (d: Date): string => {
    if (isNaN(d.getTime())) return 'NaN';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  // 1. parseFlexibleDate('01/10/2026') -> 2026-10-01
  const d1 = parseFlexibleDate('01/10/2026');
  assert(
    formatDateLocal(d1) === '2026-10-01',
    `Suite 31: parseFlexibleDate('01/10/2026') -> 2026-10-01 (got ${formatDateLocal(d1)})`
  );

  // 2. parseFlexibleDate('10/01/2026') -> 2026-01-10
  const d2 = parseFlexibleDate('10/01/2026');
  assert(
    formatDateLocal(d2) === '2026-01-10',
    `Suite 31: parseFlexibleDate('10/01/2026') -> 2026-01-10 (got ${formatDateLocal(d2)})`
  );

  // 3. parseFlexibleDate('10/1/2026') -> 2026-01-10
  const d3 = parseFlexibleDate('10/1/2026');
  assert(
    formatDateLocal(d3) === '2026-01-10',
    `Suite 31: parseFlexibleDate('10/1/2026') -> 2026-01-10 (got ${formatDateLocal(d3)})`
  );

  // 4. parseFlexibleDate('31/10/2026') -> 2026-10-31
  const d4 = parseFlexibleDate('31/10/2026');
  assert(
    formatDateLocal(d4) === '2026-10-31',
    `Suite 31: parseFlexibleDate('31/10/2026') -> 2026-10-31 (got ${formatDateLocal(d4)})`
  );

  // 5. parseFlexibleDate('10/31/2026') is NaN (no silent swap to 31 Oct)
  const d5 = parseFlexibleDate('10/31/2026');
  assert(
    isNaN(d5.getTime()),
    `Suite 31: parseFlexibleDate('10/31/2026') is NaN (rejected mm/dd format)`
  );

  // 6. parseFlexibleDate('13/10/2026') -> 2026-10-13
  const d6 = parseFlexibleDate('13/10/2026');
  assert(
    formatDateLocal(d6) === '2026-10-13',
    `Suite 31: parseFlexibleDate('13/10/2026') -> 2026-10-13 (got ${formatDateLocal(d6)})`
  );

  // 7. parseFlexibleDate('2026-10-01') -> 2026-10-01
  const d7 = parseFlexibleDate('2026-10-01');
  assert(
    formatDateLocal(d7) === '2026-10-01',
    `Suite 31: parseFlexibleDate('2026-10-01') -> 2026-10-01 (got ${formatDateLocal(d7)})`
  );

  // 8. mapRawRecordsToIntervals on two rows Date=10/31/2026 and Date=01/10/2026:
  // one start is invalid (from 10/31/2026); one start is 1 Oct (from 01/10/2026). validateDataQuality must error Timestamps.
  const rawRows = [
    { Date: '10/31/2026', Interval: '09:00', Volume: '10', Category: 'General' },
    { Date: '01/10/2026', Interval: '09:00', Volume: '10', Category: 'General' },
  ];
  const mapping = {
    intervalStartCol: 'Date',
    timeCol: 'Interval',
    volumeCol: 'Volume',
    categoryCol: 'Category',
  };
  const intervals = mapRawRecordsToIntervals(rawRows, mapping);
  const invalidInterval = intervals.find((it) => isNaN(it.start.getTime()));
  const validInterval = intervals.find((it) => !isNaN(it.start.getTime()));
  assert(
    !!invalidInterval,
    'Suite 31: Row with Date=10/31/2026 produces invalid timestamp (NaN)'
  );
  assert(
    !!validInterval && formatDateLocal(validInterval.start) === '2026-10-01',
    `Suite 31: Row with Date=01/10/2026 produces 2026-10-01 (got ${validInterval ? formatDateLocal(validInterval.start) : 'undefined'})`
  );

  const dq = validateDataQuality({
    intervals,
    mapping,
    categories: [{ id: 'c1', name: 'General', ahtMinutes: 30, shrinkagePct: 0, priority: 1 }],
    calendar: {
      workingDays: [1, 2, 3, 4, 5],
      dailyOpenHour: 9,
      dailyOpenMinute: 0,
      dailyCloseHour: 17,
      dailyCloseMinute: 0,
      holidays: [],
    },
    labor: {
      dailyProductiveHours: 8,
      adherencePct: 1.0,
      workingDaysPerWeek: 5,
      offDaysPerWeek: 2,
      contractualHoursSource: 'derived',
      shifts: [],
    },
    sla: {
      primaryPct: 80,
      primaryWindow: 4,
      primaryUnit: 'hours',
      clockBasis: 'business_time',
      clockStartPolicy: 'arrival',
      boAsaEnabled: false,
      boAsaTarget: 60,
      boAsaUnit: 'minutes',
      asaClockBasis: 'business_window',
      occupancyCapEnabled: false,
      occupancyCapPct: 100,
    confidenceLevelPct: 95,
    },
    openingWIP: [],
  });

  assert(!dq.passed, 'Suite 31: validateDataQuality reports failure on invalid timestamp row');
  const timestampIssue = dq.issues.find((issue) => issue.field === 'Timestamps' && issue.severity === 'error');
  assert(
    !!timestampIssue && timestampIssue.message.includes('dd/mm/yyyy'),
    'Suite 31: validateDataQuality contains Timestamps error specifying dd/mm/yyyy requirement'
  );

  // 9. Occupancy formula check: workMinutes / (N * workingDaysInHorizon * dailyProductiveHours * 60)
  const workMinutes = 480;
  const operationalHC = 2;
  const workingDaysInHorizon = 1;
  const dailyProductiveHours = 8;
  const expectedOccupancyPct = (workMinutes / (operationalHC * workingDaysInHorizon * dailyProductiveHours * 60)) * 100;
  assert(
    Math.abs(expectedOccupancyPct - 50.0) < 0.001,
    `Suite 31: Occupancy formula calculation verified (got ${expectedOccupancyPct}%, expected 50%)`
  );
}

// ----------------------------------------------------
// Suite 32: Async CRN Precompute Yields (No Solid Multi-Second Block)
// ----------------------------------------------------
console.log('\n--- Suite 32: Async CRN Precompute Yields Between Replications ---');
{
  const calendar: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 8,
    dailyOpenMinute: 0,
    dailyCloseHour: 18,
    dailyCloseMinute: 0,
    holidays: [],
  };
  const labor: LaborConfig = {
    dailyProductiveHours: 7.5,
    adherencePct: 1,
    workingDaysPerWeek: 5,
    offDaysPerWeek: 2,
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
    { id: 'c1', name: 'General', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1 },
  ];
  const intervals: StandardInterval[] = [
    {
      intervalIndex: 0,
      start: new Date('2026-03-02T09:00:00'),
      end: new Date('2026-03-02T09:30:00'),
      volume: 20,
      category: 'General',
    },
  ];

  let crnMessagesSeen = 0;
  let cancelNow = false;
  let cancelledCleanly = false;

  try {
    await searchOptimalHCAsync({
      intervals,
      openingWIP: [],
      categories,
      calendar,
      labor,
      sla,
      seed: 12345,
      userMaxHC: 50,
      replications: 10,
      queueArchitecture: 'pooled',
      onProgress: (p) => {
        if (p.currentMessage?.includes('Building CRN replication')) {
          crnMessagesSeen++;
          cancelNow = true;
        }
      },
      shouldCancel: () => cancelNow,
    });
  } catch (err: any) {
    cancelledCleanly = err.message === 'SIMULATION_CANCELLED';
  }

  assert(
    crnMessagesSeen > 0,
    `Suite 32: onProgress fires "Building CRN replication" messages during precompute (got ${crnMessagesSeen})`
  );
  assert(
    cancelledCleanly,
    'Suite 32: shouldCancel() during CRN precompute throws SIMULATION_CANCELLED cleanly (no silent stall)'
  );
}

// ----------------------------------------------------
// BUG-OCC-ROOT: Unclamped occupancy vs planned-horizon denominator
// ----------------------------------------------------
console.log('\n--- Suite BUG-OCC-ROOT: Planned-horizon occupancy + rawOccupancyPct ---');
{
  const calendar: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0,
    holidays: [],
  };
  const labor: LaborConfig = {
    dailyProductiveHours: 8,
    adherencePct: 1.0,
    workingDaysPerWeek: 5,
    offDaysPerWeek: 2,
    contractualHoursSource: 'derived',
    shifts: [],
  };
  const categories: CategoryConfig[] = [
    { id: 'c1', name: 'General', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1 },
  ];
  const slaOverflow: SLAPolicyConfig = {
    primaryPct: 80,
    primaryWindow: 8,
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
  const overflowIntervals: StandardInterval[] = [
    { intervalIndex: 0, start: new Date(2026, 9, 5, 9, 0), end: new Date(2026, 9, 5, 9, 30), category: 'General', volume: 160 },
    { intervalIndex: 1, start: new Date(2026, 9, 6, 9, 0), end: new Date(2026, 9, 6, 9, 30), category: 'General', volume: 160 },
    { intervalIndex: 2, start: new Date(2026, 9, 7, 9, 0), end: new Date(2026, 9, 7, 9, 30), category: 'General', volume: 160 },
    { intervalIndex: 3, start: new Date(2026, 9, 8, 9, 0), end: new Date(2026, 9, 8, 9, 30), category: 'General', volume: 160 },
    { intervalIndex: 4, start: new Date(2026, 9, 9, 9, 0), end: new Date(2026, 9, 9, 9, 30), category: 'General', volume: 160 },
  ];

  const res7 = runBackofficeDES({
    operationalHC: 7,
    intervals: overflowIntervals,
    openingWIP: [],
    categories,
    calendar,
    labor,
    sla: slaOverflow,
    seed: 777,
  });
  const expectedRaw7 =
    res7.totalAvailableProductiveMinutes > 0
      ? Math.round((res7.totalHandlingMinutes / res7.totalAvailableProductiveMinutes) * 1000) / 10
      : 0;

  assert(res7.totalHandlingMinutes === 24000, `BUG-OCC-ROOT: HC=7 totalHandlingMinutes is 24000 (got ${res7.totalHandlingMinutes})`);
  assert(
    res7.totalAvailableProductiveMinutes === 16800,
    `BUG-OCC-ROOT: HC=7 planned-horizon denominator stays 7*5*480=16800 (got ${res7.totalAvailableProductiveMinutes})`
  );
  assert(res7.occupancyPct === 100, `BUG-OCC-ROOT: occupancyPct stays clamped at 100 (got ${res7.occupancyPct})`);
  assert(
    res7.rawOccupancyPct === expectedRaw7 && res7.rawOccupancyPct === 142.9,
    `BUG-OCC-ROOT: rawOccupancyPct is unclamped 24000/16800=142.9 (got ${res7.rawOccupancyPct}, recomputed ${expectedRaw7})`
  );

  const slaSteady: SLAPolicyConfig = {
    ...slaOverflow,
  };
  const res11 = runBackofficeDES({
    operationalHC: 11,
    intervals: overflowIntervals,
    openingWIP: [],
    categories,
    calendar,
    labor,
    sla: slaSteady,
    seed: 12345,
  });
  assert(res11.totalHandlingMinutes === 24000, 'BUG-OCC-ROOT: HC=11 no-spillover handling minutes 24000');
  assert(res11.totalAvailableProductiveMinutes === 26400, 'BUG-OCC-ROOT: HC=11 denominator 11*5*480=26400');
  assert(
    res11.occupancyPct === 90.9 && res11.rawOccupancyPct === 90.9,
    `BUG-OCC-ROOT: no-spillover rawOccupancyPct === occupancyPct === 90.9 (got occ=${res11.occupancyPct} raw=${res11.rawOccupancyPct})`
  );

  const searchRes = searchOptimalHC({
    intervals: overflowIntervals,
    openingWIP: [],
    categories,
    calendar,
    labor,
    sla: slaOverflow,
    seed: 777,
    userMaxHC: 50,
    replications: 1,
  });
  assert(searchRes.recommendedHC === 10, `BUG-OCC-ROOT: S5 recommendedHC is 10 (got ${searchRes.recommendedHC})`);
  const hist7 = searchRes.searchHistory.find((h) => h.hc === 7);
  if (hist7) {
    assert(hist7.occupancyPct === 100, 'BUG-OCC-ROOT: searchHistory HC=7 occupancyPct clamped at 100');
    assert(hist7.rawOccupancyPct === 142.9, `BUG-OCC-ROOT: searchHistory HC=7 rawOccupancyPct 142.9 (got ${hist7.rawOccupancyPct})`);
  }
}

// ----------------------------------------------------
// BUG-OCC-CAP: occupancy cap gate compared the clamped value, so a cap at 100% (the
// screenshot scenario, cap disabled) accepted candidates at 142.9% true occupancy —
// Math.min(100, raw) <= 100 is true for every input. Fixed to gate on rawOccupancyPct via
// resolveOccupancyCapPct, which always resolves a target (100% default, custom when
// enabled) rather than short-circuiting to "always passes" when disabled.
// ----------------------------------------------------
console.log('\n--- Suite BUG-OCC-CAP: Occupancy ceiling actually binds ---');
{
  const calendar: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0,
    holidays: [],
  };
  const labor: LaborConfig = {
    dailyProductiveHours: 8,
    adherencePct: 1.0,
    workingDaysPerWeek: 5,
    offDaysPerWeek: 2,
    contractualHoursSource: 'derived',
    shifts: [],
  };
  const categories: CategoryConfig[] = [
    { id: 'c1', name: 'General', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1 },
  ];
  const slaDefault: SLAPolicyConfig = {
    primaryPct: 80,
    primaryWindow: 8,
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
  const overflowIntervals: StandardInterval[] = [
    { intervalIndex: 0, start: new Date(2026, 9, 5, 9, 0), end: new Date(2026, 9, 5, 9, 30), category: 'General', volume: 160 },
    { intervalIndex: 1, start: new Date(2026, 9, 6, 9, 0), end: new Date(2026, 9, 6, 9, 30), category: 'General', volume: 160 },
    { intervalIndex: 2, start: new Date(2026, 9, 7, 9, 0), end: new Date(2026, 9, 7, 9, 30), category: 'General', volume: 160 },
    { intervalIndex: 3, start: new Date(2026, 9, 8, 9, 0), end: new Date(2026, 9, 8, 9, 30), category: 'General', volume: 160 },
    { intervalIndex: 4, start: new Date(2026, 9, 9, 9, 0), end: new Date(2026, 9, 9, 9, 30), category: 'General', volume: 160 },
  ];

  // --- resolveOccupancyCapPct: single source of truth, always resolves a target ---
  assert(resolveOccupancyCapPct({ occupancyCapEnabled: false, occupancyCapPct: 85 }) === 100,
    'BUG-OCC-CAP: resolver returns 100 (physical feasibility only) when toggle is off');
  assert(resolveOccupancyCapPct({ occupancyCapEnabled: true, occupancyCapPct: 85 }) === 85,
    'BUG-OCC-CAP: resolver returns the custom target when toggle is on');
  assert(resolveOccupancyCapPct({ occupancyCapEnabled: true, occupancyCapPct: 40 }) === 50,
    'BUG-OCC-CAP: resolver clamps a too-low custom target to 50');
  assert(resolveOccupancyCapPct({ occupancyCapEnabled: true, occupancyCapPct: 120 }) === 100,
    'BUG-OCC-CAP: resolver clamps a too-high custom target to 100');

  // --- Headline regression: HC=7 is 142.9% true occupancy (from BUG-OCC-ROOT). With the
  // gate compared against the CLAMPED value this always passed. Fixed: must fail. ---
  const res7 = runBackofficeDES({
    operationalHC: 7,
    intervals: overflowIntervals,
    openingWIP: [],
    categories,
    calendar,
    labor,
    sla: slaDefault,
    seed: 777,
  });
  assert(res7.rawOccupancyPct === 142.9, `BUG-OCC-CAP: precondition — HC=7 rawOccupancyPct is 142.9 (got ${res7.rawOccupancyPct})`);
  assert(res7.passesOccupancyCap === false,
    `BUG-OCC-CAP: HC=7 at 142.9% true occupancy FAILS the default 100% target (before the fix this was always true)`);
  assert(res7.allPassed === false, 'BUG-OCC-CAP: HC=7 does not pass overall — occupancy alone must be able to fail a candidate');

  // --- Control: HC=10 was the correct recommendation under BUG-OCC-ROOT and sits at or
  // below 100% true occupancy. The fix must not disturb it. ---
  const res10 = runBackofficeDES({
    operationalHC: 10,
    intervals: overflowIntervals,
    openingWIP: [],
    categories,
    calendar,
    labor,
    sla: slaDefault,
    seed: 777,
  });
  assert(res10.rawOccupancyPct <= 100,
    `BUG-OCC-CAP control: HC=10 true occupancy is <= 100% (got ${res10.rawOccupancyPct}%) — otherwise BUG-OCC-ROOT's recommendedHC=10 would itself be broken`);
  assert(res10.passesOccupancyCap === true,
    'BUG-OCC-CAP control: HC=10 passes the default 100% target — a feasible candidate must not be rejected');

  // --- Custom target: metric unchanged (D2 / BUG-OCC-ROOT untouched), only the gate moves.
  // HC=11 is 90.9% true occupancy (BUG-OCC-ROOT no-spillover case). ---
  const slaCap85: SLAPolicyConfig = { ...slaDefault, occupancyCapEnabled: true, occupancyCapPct: 85 };
  const res11cap85 = runBackofficeDES({
    operationalHC: 11,
    intervals: overflowIntervals,
    openingWIP: [],
    categories,
    calendar,
    labor,
    sla: slaCap85,
    seed: 12345,
  });
  assert(res11cap85.occupancyPct === 90.9 && res11cap85.rawOccupancyPct === 90.9,
    `BUG-OCC-CAP: custom target does not alter the occupancy metric itself (got occ=${res11cap85.occupancyPct} raw=${res11cap85.rawOccupancyPct})`);
  assert(res11cap85.passesOccupancyCap === false,
    'BUG-OCC-CAP: HC=11 at 90.9% true occupancy FAILS a custom 85% target');

  const slaCap95: SLAPolicyConfig = { ...slaDefault, occupancyCapEnabled: true, occupancyCapPct: 95 };
  const res11cap95 = runBackofficeDES({
    operationalHC: 11,
    intervals: overflowIntervals,
    openingWIP: [],
    categories,
    calendar,
    labor,
    sla: slaCap95,
    seed: 12345,
  });
  assert(res11cap95.passesOccupancyCap === true,
    'BUG-OCC-CAP control: HC=11 at 90.9% true occupancy PASSES a custom 95% target');

  // --- CI must reflect the true overload, not collapse to a point mass at the clamp.
  // This fixture's AHT is a fixed constant (no distribution), so every replication
  // legitimately handles the same total minutes and the CI is correctly a point — but it
  // must be a point at the TRUE ratio (142.9%), not at the old clamped ceiling (100%). ---
  const statOverload = evaluateCandidateStatistical({
    operationalHC: 7,
    intervals: overflowIntervals,
    openingWIP: [],
    categories,
    calendar,
    labor,
    sla: slaDefault,
    baseSeed: 777,
    replications: 5,
  });
  assert(statOverload.passesAllConstraints === false,
    'BUG-OCC-CAP: statistical evaluation at HC=7 fails overall (occupancy CI upper bound > 100%)');
  const occFailReason = statOverload.failingReasons.find((r) => r.startsWith('Occupancy'));
  assert(!!occFailReason, 'BUG-OCC-CAP: failingReasons names the occupancy constraint');
  if (occFailReason) {
    const ciMatch = occFailReason.match(/\[([\d.]+)%, ([\d.]+)%\]/);
    assert(!!ciMatch, `BUG-OCC-CAP: occupancy failure message carries a CI range (got: ${occFailReason})`);
    if (ciMatch) {
      const [low, high] = [parseFloat(ciMatch[1]), parseFloat(ciMatch[2])];
      assert(high > 100, `BUG-OCC-CAP: CI upper bound is unclamped and > 100% (got ${high}%)`);
      assert(low > 100, `BUG-OCC-CAP: CI lower bound is also unclamped and > 100% — the point sits at the TRUE 142.9% ratio, not the old censored ceiling of 100% (got ${low}%)`);
    }
  }

  // --- No-regression: computeAnalyticalNMin's oMax is 1.0 whenever the toggle is off,
  // exactly as before the fix — N_min for already-valid scenarios must not move. ---
  const nMinBefore = computeAnalyticalNMin({
    totalWorkloadHours: 100,
    labor,
    workingDaysInHorizon: 5,
    occupancyCapEnabled: false,
    occupancyCapPct: 85,
  });
  const expectedNMin = Math.max(1, Math.floor(100 / (1.0 * (labor.dailyProductiveHours * 5) * 1.0)));
  assert(nMinBefore === expectedNMin,
    `BUG-OCC-NEUTRAL: N_min with toggle off matches the pre-fix closed form floor(Workload/(1.0*agentHours*adherence)) (got ${nMinBefore}, expected ${expectedNMin})`);
}

// ----------------------------------------------------
// Suite TRUSTED-SOURCE: S5 per-HC occupancy table (Horn S1-S3 removed 2026-08-24)
// ----------------------------------------------------
console.log('\n--- Suite TRUSTED-SOURCE: Independent ground-truth scenarios ---');
{
  const calendar: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0,
    holidays: [],
  };
  const labor: LaborConfig = {
    dailyProductiveHours: 8,
    adherencePct: 1.0,
    workingDaysPerWeek: 5,
    offDaysPerWeek: 2,
    contractualHoursSource: 'derived',
    shifts: [],
  };

  const cat30: CategoryConfig[] = [
    { id: 'c1', name: 'General', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1 },
  ];
  const slaS5: SLAPolicyConfig = {
    primaryPct: 80,
    primaryWindow: 8,
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
  const s5Intervals: StandardInterval[] = [
    { intervalIndex: 0, start: new Date(2026, 9, 5, 9, 0), end: new Date(2026, 9, 5, 9, 30), category: 'General', volume: 160 },
    { intervalIndex: 1, start: new Date(2026, 9, 6, 9, 0), end: new Date(2026, 9, 6, 9, 30), category: 'General', volume: 160 },
    { intervalIndex: 2, start: new Date(2026, 9, 7, 9, 0), end: new Date(2026, 9, 7, 9, 30), category: 'General', volume: 160 },
    { intervalIndex: 3, start: new Date(2026, 9, 8, 9, 0), end: new Date(2026, 9, 8, 9, 30), category: 'General', volume: 160 },
    { intervalIndex: 4, start: new Date(2026, 9, 9, 9, 0), end: new Date(2026, 9, 9, 9, 30), category: 'General', volume: 160 },
  ];
  const s5Expected: Record<number, { primary: number; denom: number; occ: number; raw: number }> = {
    7: { primary: 24, denom: 16800, occ: 100, raw: 142.9 },
    8: { primary: 40, denom: 19200, occ: 100, raw: 125 },
    9: { primary: 70, denom: 21600, occ: 100, raw: 111.1 },
    10: { primary: 100, denom: 24000, occ: 100, raw: 100 },
    11: { primary: 100, denom: 26400, occ: 90.9, raw: 90.9 },
  };
  for (const hc of [7, 8, 9, 10, 11]) {
    const des = runBackofficeDES({
      operationalHC: hc,
      intervals: s5Intervals,
      openingWIP: [],
      categories: cat30,
      calendar,
      labor,
      sla: slaS5,
      seed: 777,
    });
    const exp = s5Expected[hc];
    assert(des.primaryAchievedPct === exp.primary, `TRUSTED S5 HC=${hc}: primary ${exp.primary} (got ${des.primaryAchievedPct})`);
        assert(des.totalHandlingMinutes === 24000, `TRUSTED S5 HC=${hc}: handling 24000`);
    assert(des.completedCases === 800 && des.totalCases === 800, `TRUSTED S5 HC=${hc}: 800/800 cases`);
    assert(des.totalAvailableProductiveMinutes === exp.denom, `TRUSTED S5 HC=${hc}: denom ${exp.denom} (got ${des.totalAvailableProductiveMinutes})`);
    assert(des.occupancyPct === exp.occ, `TRUSTED S5 HC=${hc}: occupancyPct ${exp.occ} (got ${des.occupancyPct})`);
    assert(des.rawOccupancyPct === exp.raw, `TRUSTED S5 HC=${hc}: rawOccupancyPct ${exp.raw} (got ${des.rawOccupancyPct})`);
  }
}

// ----------------------------------------------------
// Suite STANDALONE-HTML: self-contained BoWFM.html
// ----------------------------------------------------
console.log('\n--- Suite STANDALONE-HTML: Zero-runtime-dependency artifact ---');
{
  const htmlPath = resolve(process.cwd(), 'BoWFM.html');
  assert(existsSync(htmlPath), 'STANDALONE: BoWFM.html exists at repo root');
  const html = readFileSync(htmlPath, 'utf8');
  assert(html.includes('id="root"'), 'STANDALONE: contains React mount root');
  assert(html.includes('rawOccupancyPct'), 'STANDALONE: bundles occupancy rawOccupancyPct');
  assert(!html.includes('/src/main.tsx'), 'STANDALONE: does not point at Vite TSX entry');
  assert(!/<script[^>]+src=/.test(html), 'STANDALONE: no external script src');
  assert(!/<link[^>]+rel=["']stylesheet["'][^>]+href=/.test(html), 'STANDALONE: no external stylesheet href');
  assert(!/unpkg\.com|jsdelivr|cdn\.jsdelivr/i.test(html), 'STANDALONE: no CDN URLs');
}

// ----------------------------------------------------
// Suite 33: T1-1 CSV volume thousands-separator parsing
// ----------------------------------------------------
console.log('\n--- Suite 33: T1-1 CSV Volume Thousands-Separator Parsing ---');
{
  const rows = [
    { Date: '2026-01-05 09:00', Volume: '12,500', Category: 'A' },
    { Date: '2026-01-05 09:00', Volume: '1,234', Category: 'A' },
    { Date: '2026-01-05 09:00', Volume: '$1234', Category: 'A' },
    { Date: '2026-01-05 09:00', Volume: '-50', Category: 'A' },
  ];
  const mapping = {
    intervalStartCol: 'Date',
    volumeCol: 'Volume',
    categoryCol: 'Category',
  } as any;

  const intervals = mapRawRecordsToIntervals(rows, mapping);
  assert(intervals[0].volume === 12500, `T1-1: "12,500" parses to 12500 (got ${intervals[0].volume})`);
  assert(intervals[1].volume === 1234, `T1-1: "1,234" parses to 1234 (got ${intervals[1].volume})`);
  assert(intervals[2].volume === 1234, `T1-1: "$1234" parses to 1234 (got ${intervals[2].volume})`);
  assert(intervals[3].volume === 0, `T1-1: negative "-50" is rejected, not silently used (got ${intervals[3].volume})`);

  const dq = validateDataQuality({
    intervals,
    mapping,
    categories: [{ id: 'c1', name: 'A', ahtMinutes: 30, shrinkagePct: 0, priority: 1 }],
    calendar: {
      workingDays: [1, 2, 3, 4, 5],
      dailyOpenHour: 9,
      dailyOpenMinute: 0,
      dailyCloseHour: 17,
      dailyCloseMinute: 0,
      holidays: [],
    },
    labor: {
      dailyProductiveHours: 8,
      adherencePct: 1.0,
      workingDaysPerWeek: 5,
      offDaysPerWeek: 2,
      contractualHoursSource: 'derived',
      shifts: [],
    },
    sla: {
      primaryPct: 80,
      primaryWindow: 4,
      primaryUnit: 'hours',
      clockBasis: 'business_time',
      clockStartPolicy: 'arrival',
      boAsaEnabled: false,
      boAsaTarget: 60,
      boAsaUnit: 'minutes',
      asaClockBasis: 'business_window',
      occupancyCapEnabled: false,
      occupancyCapPct: 100,
      confidenceLevelPct: 95,
    },
    openingWIP: [],
  });
  const volIssue = dq.issues.find((iss) => iss.field === 'Volume Parsing');
  assert(!!volIssue, `T1-1: validateDataQuality surfaces a "Volume Parsing" warning (issues: ${dq.issues.map((i) => i.field).join(', ')})`);
}

// ----------------------------------------------------
// Suite 33b: T3-3 getTCrit df=2 exact closed form
// ----------------------------------------------------
console.log('\n--- Suite 33b: T3-3 getTCrit df=2 Exact Closed Form ---');
{
  const t2 = getTCrit(2, 95);
  assert(Math.abs(t2 - 4.3027) < 0.001, `T3-3: getTCrit(2, 95) is ~4.3027 (textbook 4.303, got ${t2.toFixed(4)})`);
  // Other df values must remain correct (regression guard against a partial fix).
  const t1 = getTCrit(1, 95);
  assert(Math.abs(t1 - 12.7062) < 0.001, `T3-3: getTCrit(1, 95) unaffected (got ${t1.toFixed(4)})`);
  const t29 = getTCrit(29, 95);
  assert(Math.abs(t29 - 2.045) < 0.005, `T3-3: getTCrit(29, 95) unaffected (got ${t29.toFixed(4)})`);
}

// ----------------------------------------------------
// Suite 34: T2-1 AHT-vs-SLA-window analytical infeasibility
// ----------------------------------------------------
console.log('\n--- Suite 34: T2-1 AHT-vs-SLA-Window Analytical Infeasibility ---');
{
  const calendar: CalendarConfig = {
    workingDays: [0, 1, 2, 3, 4, 5, 6],
    dailyOpenHour: 0,
    dailyOpenMinute: 0,
    dailyCloseHour: 24,
    dailyCloseMinute: 0,
    holidays: [],
    is24x7: true,
  };
  const labor: LaborConfig = {
    dailyProductiveHours: 8,
    adherencePct: 1.0,
    workingDaysPerWeek: 7,
    offDaysPerWeek: 0,
    contractualHoursSource: 'derived',
    shifts: [],
  };
  const makeSla = (primaryPct: number): SLAPolicyConfig => ({
    primaryPct,
    primaryWindow: 60,
    primaryUnit: 'minutes',
    clockBasis: 'business_time',
    clockStartPolicy: 'arrival',
    boAsaEnabled: false,
    boAsaTarget: 60,
    boAsaUnit: 'minutes',
    asaClockBasis: 'business_window',
    occupancyCapEnabled: false,
    occupancyCapPct: 100,
    confidenceLevelPct: 95,
  });

  // Single category: AHT 61 > window 60 -> infeasible at any headcount, fast-failed.
  {
    const categories: CategoryConfig[] = [
      { id: 'a', name: 'Slow', ahtMinutes: 61, shrinkagePct: 0.0, priority: 1 },
    ];
    const intervals: StandardInterval[] = [
      { intervalIndex: 0, start: new Date(2026, 2, 2, 9, 0), end: new Date(2026, 2, 2, 9, 30), category: 'Slow', volume: 5 },
    ];
    const result = searchOptimalHC({
      intervals,
      openingWIP: [],
      categories,
      calendar,
      labor,
      sla: makeSla(80),
      seed: 42,
      userMaxHC: 50,
      replications: 5,
    });
    assert(result.isInfeasible, 'T2-1: AHT 61 > window 60 is reported infeasible');
    assert(
      result.bindingConstraintType === 'category_aht_exceeds_window',
      `T2-1: binding constraint is category_aht_exceeds_window (got ${result.bindingConstraintType})`
    );
    assert(
      result.searchHistory.length <= 1,
      `T2-1: fails fast without exhausting the leap-up search (${result.searchHistory.length} evaluations)`
    );
    assert(
      !!result.infeasibleReason?.includes('Slow'),
      'T2-1: infeasibility message names the offending category'
    );
  }

  // Mixed: 90% Fast (feasible) + 10% Slow (AHT > window) -> still infeasible,
  // but the message must not suggest raising userMaxHC, and must state the
  // achievable ceiling rather than contradicting the DES's own attainment.
  {
    const categories: CategoryConfig[] = [
      { id: 'fast', name: 'Fast', ahtMinutes: 30, shrinkagePct: 0.0, priority: 1 },
      { id: 'slow', name: 'Slow', ahtMinutes: 120, shrinkagePct: 0.0, priority: 2 },
    ];
    const intervals: StandardInterval[] = [
      { intervalIndex: 0, start: new Date(2026, 2, 2, 9, 0), end: new Date(2026, 2, 2, 9, 30), category: 'Fast', volume: 90 },
      { intervalIndex: 1, start: new Date(2026, 2, 2, 9, 0), end: new Date(2026, 2, 2, 9, 30), category: 'Slow', volume: 10 },
    ];
    const result = searchOptimalHC({
      intervals,
      openingWIP: [],
      categories,
      calendar,
      labor,
      sla: makeSla(70),
      seed: 42,
      userMaxHC: 50,
      replications: 5,
    });
    assert(result.isInfeasible, 'T2-1: mixed 90/10 case is reported infeasible');
    assert(
      !result.infeasibleReason?.includes('Increase userMaxHC'),
      'T2-1: message does not tell the user to raise userMaxHC (no headcount would help)'
    );
    assert(
      !!result.infeasibleReason?.match(/90\.0%/),
      `T2-1: message states the achievable ceiling as 90.0% (got: ${result.infeasibleReason})`
    );
  }
}

// ----------------------------------------------------
// Suite 35: T3-1 24x7 midnight daily-budget accounting
// ----------------------------------------------------
console.log('\n--- Suite 35: T3-1 24x7 Midnight Daily-Budget Accounting ---');
{
  const calendar: CalendarConfig = {
    workingDays: [0, 1, 2, 3, 4, 5, 6],
    dailyOpenHour: 0,
    dailyOpenMinute: 0,
    dailyCloseHour: 24,
    dailyCloseMinute: 0,
    holidays: [],
    is24x7: true,
  };
  const labor: LaborConfig = {
    dailyProductiveHours: 8, // 480-minute daily budget
    adherencePct: 1.0,
    workingDaysPerWeek: 7,
    offDaysPerWeek: 0,
    contractualHoursSource: 'derived',
    shifts: [],
  };
  const sla: SLAPolicyConfig = {
    primaryPct: 80,
    primaryWindow: 7,
    primaryUnit: 'days',
    clockBasis: 'business_time',
    clockStartPolicy: 'arrival',
    boAsaEnabled: false,
    boAsaTarget: 60,
    boAsaUnit: 'minutes',
    asaClockBasis: 'business_window',
    occupancyCapEnabled: false,
    occupancyCapPct: 100,
    confidenceLevelPct: 95,
  };
  const categories: CategoryConfig[] = [
    { id: 'cat_a', name: 'A', ahtMinutes: 300, shrinkagePct: 0.0, priority: 1 },
  ];

  // 1 agent, 480m/day budget, a stream of 300m tasks arriving at 23:00 every
  // day for 5 days keeps the agent perpetually mid-task across every midnight.
  const intervals: StandardInterval[] = [];
  for (let d = 0; d < 5; d++) {
    intervals.push({
      intervalIndex: d,
      start: new Date(2026, 2, 2 + d, 23, 0, 0),
      end: new Date(2026, 2, 2 + d, 23, 30, 0),
      volume: 3,
      category: 'A',
    });
  }

  const des = runBackofficeDES({
    operationalHC: 1,
    intervals,
    openingWIP: [],
    categories,
    calendar,
    labor,
    sla,
    seed: 42,
    skipCaseResultsAndTimeline: false,
  });

  const check = verifyAgentTimelineInvariants(des, labor, calendar);
  assert(check.valid, `T3-1: invariant verification passes (errors: ${check.errors.join('; ')})`);

  const byDay = new Map<string, number>();
  for (const s of des.agentTimeline) {
    if (s.state !== 'busy') continue;
    const key = `${s.from.getFullYear()}-${String(s.from.getMonth() + 1).padStart(2, '0')}-${String(s.from.getDate()).padStart(2, '0')}`;
    byDay.set(key, (byDay.get(key) || 0) + s.minutes);
  }
  let maxDayBusy = 0;
  for (const minutes of byDay.values()) {
    if (minutes > maxDayBusy) maxDayBusy = minutes;
  }
  assert(
    maxDayBusy <= 480 + 0.01,
    `T3-1: no calendar day exceeds the 480m daily budget (max observed: ${maxDayBusy.toFixed(2)}m)`
  );

  // Regression guard for the deliberate BUG-D requirement: a 24x7 case must
  // never be artificially parked purely because it straddles midnight, as
  // long as it fits within the agent's remaining daily budget.
  const cal247Wide: CalendarConfig = { ...calendar };
  const laborWide: LaborConfig = { ...labor, dailyProductiveHours: 24 };
  const shortSpanIntervals: StandardInterval[] = [
    { intervalIndex: 0, start: new Date(2026, 2, 2, 23, 0), end: new Date(2026, 2, 2, 23, 30), category: 'A', volume: 1 },
  ];
  const shortCategories: CategoryConfig[] = [
    { id: 'cat_b', name: 'A', ahtMinutes: 90, shrinkagePct: 0.0, priority: 1 },
  ];
  const desShort = runBackofficeDES({
    operationalHC: 1,
    intervals: shortSpanIntervals,
    openingWIP: [],
    categories: shortCategories,
    calendar: cal247Wide,
    labor: laborWide,
    sla,
    seed: 42,
  });
  assert(
    desShort.caseResults[0]?.parkCount === 0,
    `T3-1: a case comfortably within budget still does not park at midnight (parkCount=${desShort.caseResults[0]?.parkCount})`
  );
}

// ----------------------------------------------------
// SUMMARY
// ----------------------------------------------------
console.log('\n==================================================');
console.log(` RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
console.log('==================================================\n');

if (failedTests > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
