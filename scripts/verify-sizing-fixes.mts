/**
 * Sizing-chain regression suite for the Backoffice WFM Sizing Engine.
 *
 * Companion to scripts/verify-fixes.mts (the legacy suite, left untouched).
 * This file covers defects found during the Required-HC chain audit. Every test
 * here was written to FAIL against the pre-fix code and pass afterwards.
 *
 * Run: npx tsx scripts/verify-sizing-fixes.mts
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  getCalendarWorkingDaysInHorizon,
  getValidSlapStarts,
} from '../src/utils/calendar';
import {
  buildCoverageRepairDistribution,
  buildOneDayDemandGrid,
  calculateStaffingRequirement,
  clampSlaAcceptanceSlackPct,
  clampWorkloadReductionPct,
  computeAnalyticalNMin,
  computeCandidatePlacementDistribution,
  computeExtraOffPct,
  computeMaxAnalyticDeficitMinutes,
  computeOccupancyFloor,
  computeShiftPlacement,
  effectivePrimaryTarget,
  evaluateCandidateStatistical,
  findPlacementFeasibleFloor,
  resolveAgentHoursForNMin,
  searchOptimalHC,
  searchOptimalHCAsync,
} from '../src/utils/hc-search';
import {
  allocateAgentsToCategories,
  generateCaseEntities,
  resolveEffectiveAdherence,
  resolveMinAgentsPerInterval,
  resolveOccupancyCapPct,
  resolveShiftSlapMinutes,
  runBackofficeDES,
  verifyAgentTimelineInvariants,
} from '../src/utils/des-engine';
import * as hcNs from '../src/utils/hc-search';
import * as desNs from '../src/utils/des-engine';
import { discoverAndSyncCategories, mapRawRecordsToIntervals, validateDataQuality } from '../src/utils/csv-parser';
import { buildSampleDataset } from '../src/utils/sample-data';
import { loadSampleFile } from './sample-files';
import { DEFAULT_CALENDAR, DEFAULT_CATEGORIES, DEFAULT_LABOR, DEFAULT_SIM_PARAMS, DEFAULT_SLA } from '../src/utils/default-config';
import {
  CalendarConfig,
  CategoryConfig,
  LaborConfig,
  ShiftDistributionByCategory,
  ShiftSlapDistribution,
  SLAPolicyConfig,
  StandardInterval,
} from '../src/types/wfm';

let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    passedTests++;
  } else {
    console.error(`  ✗ FAIL: ${testName}${detail ? ` - ${detail}` : ''}`);
    failedTests++;
  }
}

function approx(a: number, b: number, tol = 1e-6): boolean {
  return Math.abs(a - b) <= tol;
}

// ---------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------
const BIZ_CAL: CalendarConfig = {
  workingDays: [1, 2, 3, 4, 5],
  dailyOpenHour: 9,
  dailyOpenMinute: 0,
  dailyCloseHour: 17,
  dailyCloseMinute: 0,
  holidays: [],
};

const CAL_24X7: CalendarConfig = {
  is24x7: true,
  workingDays: [0, 1, 2, 3, 4, 5, 6],
  dailyOpenHour: 0,
  dailyOpenMinute: 0,
  dailyCloseHour: 24,
  dailyCloseMinute: 0,
  holidays: [],
};

const LABOR: LaborConfig = {
  dailyProductiveHours: 8,
  adherencePct: 1.0,
  workingDaysPerWeek: 5,
  offDaysPerWeek: 2,
  contractualHoursSource: 'derived',
  shifts: [],
};

console.log('\n==================================================');
console.log('  BACKOFFICE WFM — SIZING CHAIN REGRESSION SUITE  ');
console.log('==================================================');

// ---------------------------------------------------------------
// Suite D1 — Working-day counting (calendar.ts)
//
// Defect: the horizon day-count loop used an inclusive `<=` against a
// midnight-normalised cursor, so a horizonEnd landing exactly on 00:00
// counted that trailing day even though it carries zero demand time.
// Triggers whenever interval data covers whole days (a 23:30 interval
// ends at 00:00 next day) and always for 24x7 operations.
// ---------------------------------------------------------------
console.log('\n--- Suite D1: Working-day counting ---');
{
  // Unaffected cases — these must not regress (guards against over-correction).
  assert(
    getCalendarWorkingDaysInHorizon(new Date(2026, 9, 5, 9, 0), new Date(2026, 9, 9, 17, 0), BIZ_CAL) === 5,
    'D1.1 business hours Mon09:00->Fri17:00 counts 5'
  );
  assert(
    getCalendarWorkingDaysInHorizon(new Date(2026, 9, 5, 9, 0), new Date(2026, 9, 8, 17, 0), BIZ_CAL) === 4,
    'D1.2 business hours Mon09:00->Thu17:00 counts 4'
  );
  assert(
    getCalendarWorkingDaysInHorizon(new Date(2026, 9, 5, 0, 0), new Date(2026, 9, 10, 0, 0), BIZ_CAL) === 5,
    'D1.3 Mon00:00->Sat00:00 counts 5 (trailing Sat is not a working day)'
  );

  // The defect cases.
  {
    const got = getCalendarWorkingDaysInHorizon(new Date(2026, 9, 5, 0, 0), new Date(2026, 9, 9, 0, 0), BIZ_CAL);
    assert(got === 4, 'D1.4 Mon00:00->Fri00:00 counts 4, not 5', `got ${got}`);
  }
  {
    const got = getCalendarWorkingDaysInHorizon(new Date(2026, 9, 5, 0, 0), new Date(2026, 9, 12, 0, 0), CAL_24X7);
    assert(got === 7, 'D1.5 24x7 Mon00:00->nextMon00:00 counts 7, not 8', `got ${got}`);
  }
  {
    const got = getCalendarWorkingDaysInHorizon(new Date(2026, 9, 5, 0, 0), new Date(2026, 9, 9, 23, 30), CAL_24X7);
    assert(got === 5, 'D1.6 24x7 Mon00:00->Fri23:30 counts 5', `got ${got}`);
  }

  // Accepted approximation: a partial final day still counts as a whole day.
  assert(
    getCalendarWorkingDaysInHorizon(new Date(2026, 9, 5, 0, 0), new Date(2026, 9, 9, 12, 0), BIZ_CAL) === 5,
    'D1.7 partial final day still counts as a whole working day (documented approximation)'
  );

  // Degenerate inputs must stay safe.
  assert(
    getCalendarWorkingDaysInHorizon(new Date(2026, 9, 9), new Date(2026, 9, 5), BIZ_CAL) === 0,
    'D1.8 inverted horizon returns 0'
  );
  assert(
    getCalendarWorkingDaysInHorizon(new Date(2026, 9, 5), new Date(2026, 9, 5), BIZ_CAL) === 0,
    'D1.9 zero-length horizon returns 0'
  );
  {
    const withHoliday: CalendarConfig = { ...BIZ_CAL, holidays: ['2026-10-07'] };
    const got = getCalendarWorkingDaysInHorizon(new Date(2026, 9, 5, 9, 0), new Date(2026, 9, 9, 17, 0), withHoliday);
    assert(got === 4, 'D1.10 holiday inside horizon is excluded', `got ${got}`);
  }
}

// ---------------------------------------------------------------
// Suite D3 — Siloed agent apportionment must be house-monotone
//
// Defect: agents were split across categories with Hamilton's
// largest-remainder method, recomputed from scratch for every candidate
// headcount. That method is subject to the apportionment "Alabama
// paradox": raising total headcount can REDUCE a category's agents.
// The HC search walks headcount down and stops at the first failure,
// which is only valid if pass/fail is monotone in N — so a paradox dip
// makes the reported "exact minimum" wrong. Worse, a category can drop
// to zero agents, leaving a silo with work and nobody to do it.
// ---------------------------------------------------------------
console.log('\n--- Suite D3: Siloed apportionment monotonicity ---');
{
  // Classic paradox-prone workload split.
  const wl = new Map<string, number>([
    ['A', 6270],
    ['B', 2300],
    ['C', 1230],
    ['D', 200],
  ]);

  // D3.1 — the core proof: adding an agent never takes one away.
  let violations = 0;
  let firstViolation = '';
  for (let n = 1; n < 200; n++) {
    const a = allocateAgentsToCategories(wl, n);
    const b = allocateAgentsToCategories(wl, n + 1);
    for (const cat of wl.keys()) {
      const sa = a.get(cat) || 0;
      const sb = b.get(cat) || 0;
      if (sb < sa && !firstViolation) {
        firstViolation = `N=${n}->${n + 1}: '${cat}' ${sa}->${sb}`;
      }
      if (sb < sa) violations++;
    }
  }
  assert(violations === 0, 'D3.1 house monotonicity holds for N=1..200', `${violations} violations, first: ${firstViolation}`);

  // D3.2 — allocation always spends exactly the available headcount.
  let sumOk = true;
  let sumDetail = '';
  for (let n = 1; n <= 120; n++) {
    const a = allocateAgentsToCategories(wl, n);
    let total = 0;
    a.forEach((v) => (total += v));
    if (total !== n) {
      sumOk = false;
      if (!sumDetail) sumDetail = `N=${n} allocated ${total}`;
    }
  }
  assert(sumOk, 'D3.2 seats always sum to operationalHC', sumDetail);

  // D3.3 — no starved silo: any category with work gets at least one agent
  // once there are enough agents to go round. A silo with work and zero
  // agents has an unbounded queue.
  let starved = '';
  for (let n = wl.size; n <= 60; n++) {
    const a = allocateAgentsToCategories(wl, n);
    for (const [cat, work] of wl.entries()) {
      if (work > 0 && (a.get(cat) || 0) < 1 && !starved) {
        starved = `N=${n}: '${cat}' has 0 agents`;
      }
    }
  }
  assert(starved === '', 'D3.3 no category with work is left with zero agents', starved);

  // D3.4 — still proportional to workload at scale.
  {
    const propWl = new Map<string, number>([['X', 500], ['Y', 300], ['Z', 200]]);
    const a = allocateAgentsToCategories(propWl, 100);
    const x = a.get('X') || 0;
    const y = a.get('Y') || 0;
    const z = a.get('Z') || 0;
    assert(
      Math.abs(x - 50) <= 1 && Math.abs(y - 30) <= 1 && Math.abs(z - 20) <= 1,
      'D3.4 allocation is proportional to workload',
      `got X=${x} Y=${y} Z=${z}, expected ~50/30/20`
    );
  }

  // D3.5 — deterministic under ties.
  {
    const tied = new Map<string, number>([['P', 1000], ['Q', 1000]]);
    const r1 = allocateAgentsToCategories(tied, 7);
    const r2 = allocateAgentsToCategories(tied, 7);
    assert(
      r1.get('P') === r2.get('P') && r1.get('Q') === r2.get('Q'),
      'D3.5 tie-breaking is deterministic'
    );
  }

  // D3.6 — degenerate inputs.
  {
    const zero = allocateAgentsToCategories(wl, 0);
    let t = 0;
    zero.forEach((v) => (t += v));
    assert(t === 0, 'D3.6 zero headcount allocates nothing');
  }
  {
    const noWork = new Map<string, number>([['A', 0], ['B', 0]]);
    const a = allocateAgentsToCategories(noWork, 4);
    let t = 0;
    a.forEach((v) => (t += v));
    assert(t === 4, 'D3.7 zero-workload categories still receive the headcount');
  }
  {
    // Fewer agents than categories: cannot guarantee one each, but must not crash
    // and must still spend exactly the headcount available.
    const a = allocateAgentsToCategories(wl, 2);
    let t = 0;
    a.forEach((v) => (t += v));
    assert(t === 2, 'D3.8 headcount below category count still allocates exactly HC');
  }
}

// ---------------------------------------------------------------
// Suite D7 — Staffing chain integrity (hc-search.ts)
//
// Defect: catWorkloadHours was seeded from configured categories but the
// interval loop auto-created entries for ANY category found in the data,
// and totalWorkloadHours summed all of them — while the gross-up loop
// iterated only configured categories. A category present in the data but
// missing from config therefore inflated the share denominator without
// receiving an allocation, so Σ share < 1 and Gross HC / FTE were
// silently understated (measured: fteNet 5 instead of 10).
// ---------------------------------------------------------------
console.log('\n--- Suite D7: Staffing chain integrity ---');
{
  const horizonStart = new Date(2026, 9, 5, 9, 0);
  const horizonEnd = new Date(2026, 9, 9, 17, 0);

  // 'Claims' is in the data but NOT in categories[].
  const configured: CategoryConfig[] = [
    { id: 'c1', name: 'Billing', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1 },
  ];
  const mixedIntervals: StandardInterval[] = [
    { intervalIndex: 0, start: new Date(2026, 9, 5, 9, 0), end: new Date(2026, 9, 5, 9, 30), category: 'Billing', volume: 100 },
    { intervalIndex: 1, start: new Date(2026, 9, 6, 9, 0), end: new Date(2026, 9, 6, 9, 30), category: 'Claims', volume: 100 },
  ];

  const st = calculateStaffingRequirement({
    operationalHC: 10,
    categories: configured,
    intervals: mixedIntervals,
    openingWIP: [],
    calendar: BIZ_CAL,
    labor: LABOR,
    horizonStart,
    horizonEnd,
    bindingConstraint: 'test',
  });

  const shareSum = st.perCategory.reduce((a, c) => a + c.categoryShare, 0);
  assert(approx(shareSum, 1, 1e-3), 'D7.1 category shares sum to 1 with an unconfigured category present', `got ${shareSum}`);

  const opSum = st.perCategory.reduce((a, c) => a + c.operationalHC, 0);
  assert(approx(opSum, st.operationalHCWithOff, 0.05), 'D7.2 per-category operational HC sums to operationalHCWithOff', `got ${opSum}`);

  const wlSum = st.perCategory.reduce((a, c) => a + c.workloadHours, 0);
  assert(approx(wlSum, st.totalWorkloadHours, 0.05), 'D7.3 per-category workload sums to totalWorkloadHours', `got ${wlSum} vs ${st.totalWorkloadHours}`);

  assert(
    st.perCategory.some((c) => c.category === 'Claims'),
    'D7.4 unconfigured category appears in the staffing breakdown'
  );

  assert(approx(st.fteNet, st.operationalHCWithOff, 0.05), 'D7.5 fteNet equals operationalHCWithOff under derived hours', `got ${st.fteNet}`);
  assert(st.extraOffDays === 0 && st.offPct === 0 && st.operationalHCWithOff === 10, 'D7.5b default 5-open+5-labor: extra OFF is 0');

  // Fully-configured control case must be unaffected.
  {
    const bothConfigured: CategoryConfig[] = [
      { id: 'c1', name: 'Billing', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1 },
      { id: 'c2', name: 'Claims', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1 },
    ];
    const stCtl = calculateStaffingRequirement({
      operationalHC: 10,
      categories: bothConfigured,
      intervals: mixedIntervals,
      openingWIP: [],
      calendar: BIZ_CAL,
      labor: LABOR,
      horizonStart,
      horizonEnd,
      bindingConstraint: 'test',
    });
    const ctlShare = stCtl.perCategory.reduce((a, c) => a + c.categoryShare, 0);
    assert(approx(ctlShare, 1, 1e-3), 'D7.6 control: fully-configured shares sum to 1', `got ${ctlShare}`);
    assert(approx(stCtl.fteNet, stCtl.operationalHCWithOff, 0.05), 'D7.7 control: fteNet equals operationalHCWithOff', `got ${stCtl.fteNet}`);
  }

  // Shrinkage relationships (pins the COPC gross-up math).
  {
    const zeroShrink: CategoryConfig[] = [
      { id: 'c1', name: 'Billing', ahtMinutes: 30, shrinkagePct: 0, priority: 1 },
      { id: 'c2', name: 'Claims', ahtMinutes: 30, shrinkagePct: 0, priority: 1 },
    ];
    const stZero = calculateStaffingRequirement({
      operationalHC: 10, categories: zeroShrink, intervals: mixedIntervals, openingWIP: [],
      calendar: BIZ_CAL, labor: LABOR, horizonStart, horizonEnd, bindingConstraint: 'test',
    });
    assert(stZero.grossHCTotal === stZero.operationalHCWithOff, 'D7.8 zero shrinkage: grossHCTotal === operationalHCWithOff', `got ${stZero.grossHCTotal}`);
    assert(approx(stZero.effectiveShrinkagePct, 0, 1e-6), 'D7.9 zero shrinkage: effectiveShrinkagePct === 0');
  }
  {
    // Harmonic blend: shares 0.5/0.5, shrinkage 0.1/0.3
    // expected = 1 - 1/(0.5/0.9 + 0.5/0.7) = 1 - 1/1.269841... = 0.212500
    const harm: CategoryConfig[] = [
      { id: 'c1', name: 'Billing', ahtMinutes: 30, shrinkagePct: 0.1, priority: 1 },
      { id: 'c2', name: 'Claims', ahtMinutes: 30, shrinkagePct: 0.3, priority: 1 },
    ];
    const stH = calculateStaffingRequirement({
      operationalHC: 10, categories: harm, intervals: mixedIntervals, openingWIP: [],
      calendar: BIZ_CAL, labor: LABOR, horizonStart, horizonEnd, bindingConstraint: 'test',
    });
    const expected = 1 - 1 / (0.5 / 0.9 + 0.5 / 0.7);
    assert(
      approx(stH.effectiveShrinkagePct, Math.round(expected * 1000) / 1000, 1e-3),
      'D7.10 harmonic effective shrinkage matches closed form',
      `got ${stH.effectiveShrinkagePct}, expected ~${Math.round(expected * 1000) / 1000}`
    );
    assert(stH.grossHCTotal >= stH.operationalHCWithOff, 'D7.11 gross HC >= operationalHCWithOff when shrinkage > 0', `got ${stH.grossHCTotal}`);
  }
}

// ---------------------------------------------------------------
// Suite D10 — Extra OFF (post-DES; no calendar double-count; coverage-ratio uplift)
//
// DES already seats agents only on calendar-open days. extraOffDays is
// max(0, labor.offDays − calendarClosed). offPct = extraOffDays/7 remains a display
// fraction. The seat-to-roster multiplier applied in Stage 4 (before shrinkage) is the
// coverage ratio openDaysPerWeek/coverageDays, NOT (1 + offPct) — agents only supply
// capacity on open days, so dividing by the calendar week under-states the roster for
// every case except extraOffDays = 0. Never Labor offDays/7 alone.
// ---------------------------------------------------------------
console.log('\n--- Suite D10: Extra OFF% (no double-count) ---');
{
  const horizonStart = new Date(2026, 9, 5, 9, 0);
  const horizonEnd = new Date(2026, 9, 9, 17, 0);
  const cats: CategoryConfig[] = [
    { id: 'c1', name: 'Billing', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1 },
  ];
  const intervals: StandardInterval[] = [
    { intervalIndex: 0, start: new Date(2026, 9, 5, 9, 0), end: new Date(2026, 9, 5, 9, 30), category: 'Billing', volume: 200 },
  ];

  // Default 5-open + Labor 5/2 off → extra 0 (weekends already in DES)
  {
    const st = calculateStaffingRequirement({
      operationalHC: 100, categories: cats, intervals, openingWIP: [],
      calendar: BIZ_CAL, labor: LABOR, horizonStart, horizonEnd, bindingConstraint: 'test',
    });
    assert(st.operationalHC === 100, 'D10.1 sim operationalHC stays 100');
    assert(st.extraOffDays === 0 && st.offPct === 0, 'D10.2 5-open+5-labor: extra OFF 0');
    assert(st.operationalHCWithOff === 100, 'D10.3 Net Op equals sim N when extra 0');
    assert(st.grossHCTotal === 125, 'D10.4 Gross = round(100/0.8)=125 unchanged vs pre-OFF product', `got ${st.grossHCTotal}`);
  }

  // Canonical: 6-open calendar, Labor 2 off → extra 1 → 14%, not Labor 29%
  {
    const cal6: CalendarConfig = { ...BIZ_CAL, workingDays: [1, 2, 3, 4, 5, 6] };
    const labor5: LaborConfig = { ...LABOR, workingDaysPerWeek: 5, offDaysPerWeek: 2 };
    const st = calculateStaffingRequirement({
      operationalHC: 100, categories: cats, intervals, openingWIP: [],
      calendar: cal6, labor: labor5, horizonStart, horizonEnd, bindingConstraint: 'test',
    });
    assert(st.extraOffDays === 1, 'D10.5 6-open + Labor 2 off: extraOffDays === 1', `got ${st.extraOffDays}`);
    assert(approx(st.offPct, 1 / 7, 1e-9), 'D10.6 offPct display === 1/7 (not 2/7)', `got ${st.offPct}`);
    assert(st.offPct !== 2 / 7, 'D10.7 must NOT use raw Labor 2/7 (double-count)');
    // Coverage ratio: openDaysPerWeek=6, coverageDays=6-1=5 -> roster = 100*6/5 = 120 (exact)
    assert(st.coverageDays === 5, 'D10.8a coverageDays === openDaysPerWeek(6) - extraOffDays(1) === 5', `got ${st.coverageDays}`);
    assert(approx(st.rosterUpliftPct, 0.2, 1e-9), 'D10.8b rosterUpliftPct === 6/5 - 1 === 0.2 (not offPct 1/7)', `got ${st.rosterUpliftPct}`);
    assert(st.operationalHCWithOff === 120, 'D10.8 floor(100×6/5) === 120', `got ${st.operationalHCWithOff}`);
    assert(st.operationalHC === 100, 'D10.9 DES sim N still 100');
    // 120 / 0.8 = 150 exactly
    assert(st.grossHCTotal === 150, 'D10.10 Gross round(120/0.8) === 150', `got ${st.grossHCTotal}`);
    assert(approx(st.fteNet, 120, 0.05), 'D10.11 fteNet equals Net Op 120', `got ${st.fteNet}`);
  }

  // Labor 1 off, business 2 closed → extra clamped 0
  {
    const labor6: LaborConfig = { ...LABOR, workingDaysPerWeek: 6, offDaysPerWeek: 1 };
    const st = calculateStaffingRequirement({
      operationalHC: 100, categories: cats, intervals, openingWIP: [],
      calendar: BIZ_CAL, labor: labor6, horizonStart, horizonEnd, bindingConstraint: 'test',
    });
    assert(st.extraOffDays === 0 && st.offPct === 0, 'D10.12 Labor 1 off + 2 closed: extra 0');
    assert(st.operationalHCWithOff === 100, 'D10.13 Net Op unchanged at 100');
  }

  // 24×7 + Labor 7/0 → extra 0
  {
    const labor7: LaborConfig = { ...LABOR, workingDaysPerWeek: 7, offDaysPerWeek: 0 };
    const st = calculateStaffingRequirement({
      operationalHC: 100, categories: cats, intervals, openingWIP: [],
      calendar: CAL_24X7, labor: labor7, horizonStart, horizonEnd, bindingConstraint: 'test',
    });
    assert(st.extraOffDays === 0 && st.operationalHCWithOff === 100, 'D10.14 24×7 + Labor 7: extra 0');
  }

  // Harmonic shrinkage must ignore OFF (same blend as D7.10 with extra OFF present)
  {
    const cal6: CalendarConfig = { ...BIZ_CAL, workingDays: [1, 2, 3, 4, 5, 6] };
    const labor5: LaborConfig = { ...LABOR, workingDaysPerWeek: 5, offDaysPerWeek: 2 };
    const harm: CategoryConfig[] = [
      { id: 'c1', name: 'Billing', ahtMinutes: 30, shrinkagePct: 0.1, priority: 1 },
      { id: 'c2', name: 'Claims', ahtMinutes: 30, shrinkagePct: 0.3, priority: 1 },
    ];
    const mixed: StandardInterval[] = [
      { intervalIndex: 0, start: new Date(2026, 9, 5, 9, 0), end: new Date(2026, 9, 5, 9, 30), category: 'Billing', volume: 100 },
      { intervalIndex: 1, start: new Date(2026, 9, 6, 9, 0), end: new Date(2026, 9, 6, 9, 30), category: 'Claims', volume: 100 },
    ];
    const stH = calculateStaffingRequirement({
      operationalHC: 100, categories: harm, intervals: mixed, openingWIP: [],
      calendar: cal6, labor: labor5, horizonStart, horizonEnd, bindingConstraint: 'test',
    });
    const expected = 1 - 1 / (0.5 / 0.9 + 0.5 / 0.7);
    assert(
      approx(stH.effectiveShrinkagePct, Math.round(expected * 1000) / 1000, 1e-3),
      'D10.15 effectiveShrinkagePct unchanged by extra OFF (not mixed in)',
      `got ${stH.effectiveShrinkagePct}`
    );
  }
}

// ---------------------------------------------------------------
// Suite D8 — SLA Acceptance Slack (sizing floor)
// ---------------------------------------------------------------
console.log('\n--- Suite D8: SLA Acceptance Slack ---');
{
  const baseSla: SLAPolicyConfig = {
    primaryPct: 80,
    primaryWindow: 1,
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

  assert(
    effectivePrimaryTarget(80, baseSla) === 80,
    'D8.1 OFF (omitted): effective target equals official 80%'
  );
  assert(
    effectivePrimaryTarget(80, { ...baseSla, slaAcceptanceSlackEnabled: false, slaAcceptanceSlackPct: 5 }) === 80,
    'D8.2 OFF explicit: effective target equals official 80%'
  );
  assert(
    effectivePrimaryTarget(80, { ...baseSla, slaAcceptanceSlackEnabled: true, slaAcceptanceSlackPct: 5 }) === 76,
    'D8.3 ON 5%: 80 × 0.95 = 76'
  );
  assert(
    effectivePrimaryTarget(90, { ...baseSla, primaryPct: 90, slaAcceptanceSlackEnabled: true, slaAcceptanceSlackPct: 10 }) === 81,
    'D8.4 ON 10% @ 90: 90 × 0.90 = 81'
  );
  assert(clampSlaAcceptanceSlackPct(0) === 1, 'D8.5 slack clamp floor 1');
  assert(clampSlaAcceptanceSlackPct(99) === 20, 'D8.6 slack clamp ceiling 20');
  assert(clampSlaAcceptanceSlackPct(undefined) === 5, 'D8.7 invalid slack defaults to 5');

  const cat: CategoryConfig[] = [
    { id: 'cat_support', name: 'SupportTicket', ahtMinutes: 45, shrinkagePct: 0, priority: 1, primaryPct: 95 },
  ];
  const intervals: StandardInterval[] = [
    {
      intervalIndex: 0,
      start: new Date('2026-03-02T09:00:00'),
      end: new Date('2026-03-02T10:00:00'),
      volume: 15,
      category: 'SupportTicket',
    },
  ];
  const searchSlaOff: SLAPolicyConfig = {
    ...baseSla,
    primaryPct: 95,
    primaryWindow: 1,
    slaAcceptanceSlackEnabled: false,
    slaAcceptanceSlackPct: 5,
  };
  const searchSlaOn: SLAPolicyConfig = {
    ...searchSlaOff,
    slaAcceptanceSlackEnabled: true,
    slaAcceptanceSlackPct: 5,
  };

  const offRes = searchOptimalHC({
    intervals,
    openingWIP: [],
    categories: cat,
    calendar: BIZ_CAL,
    labor: LABOR,
    sla: searchSlaOff,
    seed: 12345,
    userMaxHC: 40,
    replications: 5,
  });
  const onRes = searchOptimalHC({
    intervals,
    openingWIP: [],
    categories: cat,
    calendar: BIZ_CAL,
    labor: LABOR,
    sla: searchSlaOn,
    seed: 12345,
    userMaxHC: 40,
    replications: 5,
  });
  const offAgain = searchOptimalHC({
    intervals,
    openingWIP: [],
    categories: cat,
    calendar: BIZ_CAL,
    labor: LABOR,
    sla: searchSlaOff,
    seed: 12345,
    userMaxHC: 40,
    replications: 5,
  });

  assert(offRes.recommendedHC !== null, 'D8.8 OFF search returns recommendedHC');
  assert(onRes.recommendedHC !== null, 'D8.9 ON search returns recommendedHC');
  assert(
    (onRes.recommendedHC as number) <= (offRes.recommendedHC as number),
    'D8.10 ON 5% slack recommendedHC ≤ OFF baseline',
    `ON=${onRes.recommendedHC} OFF=${offRes.recommendedHC}`
  );
  assert(
    offAgain.recommendedHC === offRes.recommendedHC,
    'D8.11 OFF again matches baseline (no silent bleed)',
    `first=${offRes.recommendedHC} second=${offAgain.recommendedHC}`
  );
  assert(
    !offRes.bindingConstraintDescription.includes('sizing floor'),
    'D8.12 OFF binding text never mentions sizing floor',
    offRes.bindingConstraintDescription
  );
  assert(
    onRes.bindingConstraintDescription.includes('sizing floor') ||
      onRes.recommendedHC === onRes.nMinAnalytical,
    'D8.13 ON binding mentions sizing floor unless held at N_min',
    onRes.bindingConstraintDescription
  );
}

// ---------------------------------------------------------------
// Suite D9 — Offline / zero-dependency integrity
//
// The product ships as a single HTML file that must run with no network
// at all. These tests guard that contract at the source, manifest and
// artifact level so a future change cannot silently reintroduce a
// runtime fetch or a CDN asset.
// ---------------------------------------------------------------
console.log('\n--- Suite D9: Offline & zero-dependency integrity ---');
{
  const repoRoot = resolve(import.meta.dirname, '..');

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  const srcFiles = walk(join(repoRoot, 'src'));
  assert(srcFiles.length > 0, 'D9.0 source files were found to scan');

  // Network primitives must never appear in shipped source.
  const networkPatterns: Array<[RegExp, string]> = [
    [/\bfetch\s*\(/, 'fetch('],
    [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
    [/\bWebSocket\b/, 'WebSocket'],
    [/\bEventSource\b/, 'EventSource'],
    [/navigator\.sendBeacon/, 'navigator.sendBeacon'],
    [/\bimportScripts\s*\(/, 'importScripts('],
  ];
  for (const [re, label] of networkPatterns) {
    const hits = srcFiles.filter((f) => re.test(readFileSync(f, 'utf8')));
    assert(hits.length === 0, `D9.1 no ${label} in src/`, hits.map((h) => h.replace(repoRoot, '')).join(', '));
  }

  // Ambient/config reads that imply an environment outside the single file.
  const envPatterns: Array<[RegExp, string]> = [
    [/process\.env/, 'process.env'],
    [/import\.meta\.env/, 'import.meta.env'],
    [/\blocalStorage\b/, 'localStorage'],
    [/\bsessionStorage\b/, 'sessionStorage'],
    [/\bindexedDB\b/, 'indexedDB'],
    [/document\.cookie/, 'document.cookie'],
  ];
  for (const [re, label] of envPatterns) {
    const hits = srcFiles.filter((f) => re.test(readFileSync(f, 'utf8')));
    assert(hits.length === 0, `D9.2 no ${label} in src/`, hits.map((h) => h.replace(repoRoot, '')).join(', '));
  }

  // Engine code must not log to the console; it ships to end users.
  {
    const engineDir = join(repoRoot, 'src', 'utils');
    const engineFiles = walk(engineDir);
    const hits = engineFiles.filter((f) => /console\.(log|debug|info)\s*\(/.test(readFileSync(f, 'utf8')));
    assert(hits.length === 0, 'D9.3 no console.log in engine code (src/utils)', hits.map((h) => h.replace(repoRoot, '')).join(', '));
  }

  // Purged dependencies must stay purged.
  {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const banned of ['@google/genai', 'express', 'dotenv', '@types/express', 'motion']) {
      assert(!(banned in allDeps), `D9.4 unused dependency '${banned}' is absent from package.json`);
    }
    assert('react' in (pkg.dependencies || {}), 'D9.5 required dependency react is still present');
  }

  // The shipped artifact must be genuinely self-contained.
  {
    const htmlPath = join(repoRoot, 'BoWFM.html');
    if (!existsSync(htmlPath)) {
      assert(false, 'D9.6 BoWFM.html exists (run `npm run build:standalone`)');
    } else {
      const html = readFileSync(htmlPath, 'utf8');
      assert(html.length > 1000, 'D9.6 BoWFM.html is non-trivial in size');
      assert(!/<script[^>]+src=["']https?:/i.test(html), 'D9.7 no remote <script src>');
      assert(!/<link[^>]+href=["']https?:/i.test(html), 'D9.8 no remote <link href>');
      assert(!/(cdn\.|unpkg\.com|jsdelivr|googleapis\.com|gstatic\.com)/i.test(html), 'D9.9 no CDN or web-font hosts');
      assert(!/href=["']\.\/assets\//.test(html), 'D9.10 no external asset references');

      // Any surviving absolute URL must be a non-fetchable identifier
      // (XML namespaces, error-doc links in strings), never a loaded asset.
      const urls = html.match(/https?:\/\/[^"'\s)<>]{0,80}/g) || [];
      const allowed = /^https?:\/\/(www\.w3\.org\/|react\.dev\/errors|tailwindcss\.com)/;
      const unexpected = Array.from(new Set(urls.filter((u) => !allowed.test(u))));
      assert(unexpected.length === 0, 'D9.11 no unexpected absolute URLs in the artifact', unexpected.join(', '));
    }
  }

  // The build guards that enforce all of the above must remain in place.
  {
    const buildScript = readFileSync(join(repoRoot, 'scripts', 'build-standalone.mts'), 'utf8');
    assert(/still references remote CSS/.test(buildScript), 'D9.12 build guard against remote CSS is intact');
    assert(/still references remote JS/.test(buildScript), 'D9.13 build guard against remote JS is intact');
    assert(/contains CDN references/.test(buildScript), 'D9.14 build guard against CDN references is intact');
  }
}

// ---------------------------------------------------------------
// Suite D11 — Workload HC (N_min) agent-hours: Derived vs Manual Override
//
// Option B: override feeds N_min only when source=override AND hours > 0.
// Default 0 / missing / invalid → same as today (daily × calendar days).
// ---------------------------------------------------------------
console.log('\n--- Suite D11: N_min agent hours (Derived / Override) ---');
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
    { id: 'c1', name: 'General', ahtMinutes: 60, shrinkagePct: 0.0, priority: 1 },
  ];
  // 9h workload on one 8h day → N_min = floor(9/8) = 1 under derived
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

  const laborDerived: LaborConfig = {
    dailyProductiveHours: 8,
    adherencePct: 1.0,
    workingDaysPerWeek: 5,
    offDaysPerWeek: 2,
    contractualHoursSource: 'derived',
    contractualProductiveHoursOverride: 0,
    shifts: [],
  };

  const r0 = resolveAgentHoursForNMin(laborDerived, 1);
  assert(r0.source === 'derived' && r0.agentHours === 8, 'D11.1 derived: agentHours = daily × 1 day', `got ${r0.agentHours} ${r0.source}`);

  const laborOverrideZero: LaborConfig = {
    ...laborDerived,
    contractualHoursSource: 'override',
    contractualProductiveHoursOverride: 0,
  };
  const rZ = resolveAgentHoursForNMin(laborOverrideZero, 1);
  assert(rZ.source === 'derived' && rZ.agentHours === 8, 'D11.2 override tab with 0 hours falls back to derived', `got ${rZ.agentHours} ${rZ.source}`);

  const laborOverrideHalf: LaborConfig = {
    ...laborDerived,
    contractualHoursSource: 'override',
    contractualProductiveHoursOverride: 4,
  };
  const rH = resolveAgentHoursForNMin(laborOverrideHalf, 1);
  assert(rH.source === 'override' && rH.agentHours === 4, 'D11.3 override > 0 uses manual hours', `got ${rH.agentHours} ${rH.source}`);

  const nMinDerived = computeAnalyticalNMin({
    totalWorkloadHours: 9,
    labor: laborDerived,
    workingDaysInHorizon: 1,
    occupancyCapEnabled: false,
    occupancyCapPct: 100,
  });
  assert(nMinDerived === 1, 'D11.4 derived N_min floor(9/8)=1', `got ${nMinDerived}`);

  const nMinHalf = computeAnalyticalNMin({
    totalWorkloadHours: 9,
    labor: laborOverrideHalf,
    workingDaysInHorizon: 1,
    occupancyCapEnabled: false,
    occupancyCapPct: 100,
  });
  assert(nMinHalf === 2, 'D11.5 override 4h: floor(9/4)=2', `got ${nMinHalf}`);

  const searchDerived = searchOptimalHC({
    intervals,
    openingWIP: [],
    categories,
    calendar,
    labor: laborDerived,
    sla,
    seed: 42,
    userMaxHC: 50,
  });
  assert(searchDerived.nMinAnalytical === 1, 'D11.6 searchOptimalHC derived N_min=1', `got ${searchDerived.nMinAnalytical}`);

  const searchOverrideZero = searchOptimalHC({
    intervals,
    openingWIP: [],
    categories,
    calendar,
    labor: laborOverrideZero,
    sla,
    seed: 42,
    userMaxHC: 50,
  });
  assert(
    searchOverrideZero.nMinAnalytical === searchDerived.nMinAnalytical,
    'D11.7 override=0 same N_min as derived',
    `got ${searchOverrideZero.nMinAnalytical}`
  );

  const searchOverride = searchOptimalHC({
    intervals,
    openingWIP: [],
    categories,
    calendar,
    labor: laborOverrideHalf,
    sla,
    seed: 42,
    userMaxHC: 50,
  });
  assert(searchOverride.nMinAnalytical === 2, 'D11.8 searchOptimalHC override 4h N_min=2', `got ${searchOverride.nMinAnalytical}`);
}

// ---------------------------------------------------------------
// Suite D12 — Workload HC Reduction toggle
//
// N_min = floor(Workload × (1 − reduction%) / denominator). Single floor,
// applied once at the end — never floor(floor(W/D) × (1 − r)) (double floor).
// OFF must reproduce today's N_min exactly; the reduced N_min must still be
// the DES search floor (never a hard override of the CI-gated search).
// ---------------------------------------------------------------
console.log('\n--- Suite D12: Workload HC Reduction ---');
{
  const laborD12: LaborConfig = {
    dailyProductiveHours: 8,
    adherencePct: 1.0,
    workingDaysPerWeek: 5,
    offDaysPerWeek: 2,
    contractualHoursSource: 'derived',
    contractualProductiveHoursOverride: 0,
    shifts: [],
  };

  // Denominator here is dailyProductiveHours(8) × 1 day × 1.0 occ × 1.0 adherence = 8.

  // D12.1 — OFF is a no-op (explicit false)
  const nMinOffExplicit = computeAnalyticalNMin({
    totalWorkloadHours: 40,
    labor: laborD12,
    workingDaysInHorizon: 1,
    occupancyCapEnabled: false,
    occupancyCapPct: 100,
    workloadReductionEnabled: false,
    workloadReductionPct: 10,
  });
  assert(nMinOffExplicit === 5, 'D12.1 OFF (explicit false): N_min = floor(40/8) = 5', `got ${nMinOffExplicit}`);

  // D12.1b — OFF is a no-op (omitted fields, guards optional-param backward compat)
  const nMinOffOmitted = computeAnalyticalNMin({
    totalWorkloadHours: 40,
    labor: laborD12,
    workingDaysInHorizon: 1,
    occupancyCapEnabled: false,
    occupancyCapPct: 100,
  });
  assert(nMinOffOmitted === 5, 'D12.1b OFF (omitted params): N_min unchanged = 5', `got ${nMinOffOmitted}`);

  // D12.2 — Exact worked case: workload 50h, reduction 10% -> 45h, denominator 8h -> floor(45/8)=5
  const nMinWorked = computeAnalyticalNMin({
    totalWorkloadHours: 50,
    labor: laborD12,
    workingDaysInHorizon: 1,
    occupancyCapEnabled: false,
    occupancyCapPct: 100,
    workloadReductionEnabled: true,
    workloadReductionPct: 10,
  });
  assert(nMinWorked === 5, 'D12.2 worked case: floor(50×0.9/8) = floor(5.625) = 5', `got ${nMinWorked}`);

  // D12.3 — Single-floor, not double: workload/denominator = 5.9 (47.2/8), reduction 10%
  // Correct (single floor): floor(47.2×0.9/8) = floor(5.31) = 5
  // Wrong (double floor):   floor(floor(47.2/8)×0.9) = floor(5×0.9) = floor(4.5) = 4
  const nMinSingleFloor = computeAnalyticalNMin({
    totalWorkloadHours: 47.2,
    labor: laborD12,
    workingDaysInHorizon: 1,
    occupancyCapEnabled: false,
    occupancyCapPct: 100,
    workloadReductionEnabled: true,
    workloadReductionPct: 10,
  });
  assert(nMinSingleFloor === 5, 'D12.3 single-floor regression: floor(47.2×0.9/8)=5, NOT double-floored to 4', `got ${nMinSingleFloor}`);

  // D12.3b — A reduction that crosses an integer boundary DOES change N_min
  const nMinBoundaryCross = computeAnalyticalNMin({
    totalWorkloadHours: 47.2,
    labor: laborD12,
    workingDaysInHorizon: 1,
    occupancyCapEnabled: false,
    occupancyCapPct: 100,
    workloadReductionEnabled: true,
    workloadReductionPct: 20,
  });
  assert(nMinBoundaryCross === 4, 'D12.3b larger reduction crosses boundary: floor(47.2×0.8/8)=floor(4.72)=4', `got ${nMinBoundaryCross}`);

  // D12.4 — Floor never reaches 0 even at max reduction on tiny workload
  const nMinFloorGuard = computeAnalyticalNMin({
    totalWorkloadHours: 1,
    labor: laborD12,
    workingDaysInHorizon: 1,
    occupancyCapEnabled: false,
    occupancyCapPct: 100,
    workloadReductionEnabled: true,
    workloadReductionPct: 20,
  });
  assert(nMinFloorGuard === 1, 'D12.4 N_min never drops below 1 even at max reduction on tiny workload', `got ${nMinFloorGuard}`);

  // D12.5 — Clamping: invalid / out-of-range inputs resolve into [1, 20], default 5
  assert(clampWorkloadReductionPct(0) === 1, 'D12.5a clamp 0 -> 1 (floor)', `got ${clampWorkloadReductionPct(0)}`);
  assert(clampWorkloadReductionPct(100) === 50, 'D12.5b clamp 100 -> 50 (ceiling)', `got ${clampWorkloadReductionPct(100)}`);
  assert(clampWorkloadReductionPct(50) === 50, 'D12.5b2 clamp 50 -> 50 (in-range boundary)', `got ${clampWorkloadReductionPct(50)}`);
  assert(Number.isNaN(NaN) && clampWorkloadReductionPct(NaN) === 5, 'D12.5c clamp NaN -> default 5', `got ${clampWorkloadReductionPct(NaN)}`);
  assert(clampWorkloadReductionPct(undefined) === 5, 'D12.5d clamp undefined -> default 5', `got ${clampWorkloadReductionPct(undefined)}`);

  // D12.6 — Sync/async parity: same reduction inputs and seed must produce identical N_min
  const calendarD12: CalendarConfig = {
    workingDays: [1, 2, 3, 4, 5],
    dailyOpenHour: 9,
    dailyOpenMinute: 0,
    dailyCloseHour: 17,
    dailyCloseMinute: 0,
    holidays: [],
  };
  const categoriesD12: CategoryConfig[] = [
    { id: 'c1', name: 'General', ahtMinutes: 60, shrinkagePct: 0.0, priority: 1 },
  ];
  const intervalsD12: StandardInterval[] = [
    { intervalIndex: 0, start: new Date(2026, 2, 2, 9, 0), end: new Date(2026, 2, 2, 17, 0), category: 'General', volume: 59 },
  ];
  const slaD12Reduced: SLAPolicyConfig = {
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
    workloadReductionEnabled: true,
    workloadReductionPct: 10,
  };

  const syncReduced = searchOptimalHC({
    intervals: intervalsD12,
    openingWIP: [],
    categories: categoriesD12,
    calendar: calendarD12,
    labor: laborD12,
    sla: slaD12Reduced,
    seed: 42,
    userMaxHC: 50,
  });
  const asyncReduced = await searchOptimalHCAsync({
    intervals: intervalsD12,
    openingWIP: [],
    categories: categoriesD12,
    calendar: calendarD12,
    labor: laborD12,
    sla: slaD12Reduced,
    seed: 42,
    userMaxHC: 50,
    replications: 30,
  });
  assert(
    syncReduced.nMinAnalytical === asyncReduced.nMinAnalytical,
    'D12.6 sync/async parity: identical nMinAnalytical under reduction',
    `sync=${syncReduced.nMinAnalytical} async=${asyncReduced.nMinAnalytical}`
  );
  assert(
    syncReduced.workloadReductionAppliedPct === 10 && asyncReduced.workloadReductionAppliedPct === 10,
    'D12.6b both variants report workloadReductionAppliedPct=10',
    `sync=${syncReduced.workloadReductionAppliedPct} async=${asyncReduced.workloadReductionAppliedPct}`
  );

  // D12.7 — DES authority preserved: reduced N_min is still <= recommendedHC (never a hard override)
  assert(
    syncReduced.recommendedHC === null || syncReduced.recommendedHC >= syncReduced.nMinAnalytical,
    'D12.7 sync: recommendedHC >= reduced nMinAnalytical (search floor invariant holds)',
    `recommendedHC=${syncReduced.recommendedHC} nMinAnalytical=${syncReduced.nMinAnalytical}`
  );
  assert(
    asyncReduced.recommendedHC === null || asyncReduced.recommendedHC >= asyncReduced.nMinAnalytical,
    'D12.7b async: recommendedHC >= reduced nMinAnalytical (search floor invariant holds)',
    `recommendedHC=${asyncReduced.recommendedHC} nMinAnalytical=${asyncReduced.nMinAnalytical}`
  );

  // D12.7c — Reduction never produces an SLA-failing recommendation: an OFF run's
  // recommendedHC must be >= a reduction-ON run's recommendedHC never the other way in a
  // way that breaches SLA — i.e. the ON run's final HC still clears the same CI gate.
  const slaD12Off: SLAPolicyConfig = { ...slaD12Reduced, workloadReductionEnabled: false };
  const syncOff = searchOptimalHC({
    intervals: intervalsD12,
    openingWIP: [],
    categories: categoriesD12,
    calendar: calendarD12,
    labor: laborD12,
    sla: slaD12Off,
    seed: 42,
    userMaxHC: 50,
  });
  assert(
    syncReduced.nMinAnalytical <= syncOff.nMinAnalytical,
    'D12.7c reduction never raises N_min vs OFF baseline',
    `reduced=${syncReduced.nMinAnalytical} off=${syncOff.nMinAnalytical}`
  );
  assert(
    syncOff.workloadReductionAppliedPct === undefined,
    'D12.7d OFF run reports workloadReductionAppliedPct=undefined',
    `got ${syncOff.workloadReductionAppliedPct}`
  );

  // D12.8 — Stage 4 untouched: staffing totals identical between ON and OFF at the same operationalHC
  const staffingOn = calculateStaffingRequirement({
    operationalHC: 10,
    categories: categoriesD12,
    intervals: intervalsD12,
    openingWIP: [],
    calendar: calendarD12,
    labor: laborD12,
    horizonStart: new Date(2026, 2, 2, 9, 0),
    horizonEnd: new Date(2026, 2, 2, 17, 0),
    bindingConstraint: 'test',
  });
  // calculateStaffingRequirement never reads sla.workloadReduction* (Stage 4 recomputes its own
  // workload independent of Stage 2) — this call is deliberately made with no reduction params
  // to confirm the function signature has no reduction leakage.
  assert(staffingOn.totalWorkloadHours === 59, 'D12.8 Stage 4 totalWorkloadHours unaffected by any reduction wiring', `got ${staffingOn.totalWorkloadHours}`);
}

// =================================================================
// Suite D20 — getValidSlapStarts (deadline-coverage shift placement, calendar.ts)
//
// New feature: enumerates valid shift-start "slap" offsets (minutes from business open)
// such that a shift of shiftLengthMinutes fits entirely inside the window with no
// truncation. I3 invariant — this is what keeps the occupancy denominator honest under
// staggered availability (a truncated shift would deliver less than a full daily budget).
// =================================================================
console.log('\n--- Suite D20: getValidSlapStarts (I3 — shift never truncated by close) ---');
{
  const cal0922: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 9, dailyOpenMinute: 0, dailyCloseHour: 22, dailyCloseMinute: 0 };
  const starts0922 = getValidSlapStarts(cal0922, 9 * 60, 30);
  assert(starts0922.length === 9, 'D20.1 worked example (09:00-22:00, 9h, 30min) has 9 valid starts', `got ${starts0922.length}: ${starts0922}`);
  assert(starts0922[0] === 0, 'D20.1b first valid start is 09:00 (offset 0)', `got ${starts0922[0]}`);
  assert(starts0922[starts0922.length - 1] === 240, 'D20.1c last valid start is 13:00 (offset 240min)', `got ${starts0922[starts0922.length - 1]}`);
  assert(!starts0922.includes(270), 'D20.1d 13:30 (offset 270) is NOT a valid start', `starts: ${starts0922}`);

  // The reported config: 08:00-22:00, 9h shift.
  const cal0822: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyOpenMinute: 0, dailyCloseHour: 22, dailyCloseMinute: 0 };
  const starts0822 = getValidSlapStarts(cal0822, 9 * 60, 30);
  assert(starts0822.length === 11, 'D20.2 actual config (08:00-22:00, 9h, 30min) has 11 valid starts', `got ${starts0822.length}: ${starts0822}`);
  assert(starts0822[starts0822.length - 1] === 300, 'D20.2b last valid start is 13:00 (offset 300min from 08:00 open)', `got ${starts0822[starts0822.length - 1]}`);

  // Fixed 2026-08-28: 24x7 now enumerates a REAL grid over the fixed 1440-min day instead of
  // the degenerate [0] that made 24x7 staggering (and therefore coverage repair) impossible.
  // 9h shift, 30min grid: floor((1440-540)/30)+1 = 31 valid starts, last at offset 900
  // (15:00) whose shift ends exactly at the 1440min boundary.
  const starts24x7 = getValidSlapStarts(CAL_24X7, 9 * 60, 30);
  assert(starts24x7.length === 31, 'D20.3 24x7 calendar now enumerates a real 31-start grid over the 1440min day (was [0])', `got ${starts24x7.length}: ${JSON.stringify(starts24x7.slice(0, 3))}...`);
  assert(starts24x7[0] === 0 && starts24x7[starts24x7.length - 1] === 900, 'D20.3b first start is 0 (midnight), last is 900 (15:00, shift ends exactly at the 24h boundary)', `first=${starts24x7[0]} last=${starts24x7[starts24x7.length - 1]}`);

  const calTooShort: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 9, dailyCloseHour: 12 };
  const startsTooShort = getValidSlapStarts(calTooShort, 9 * 60, 30);
  assert(startsTooShort.length === 0, 'D20.4 window shorter than shift returns [] (no valid start exists)', `got ${startsTooShort}`);

  const starts60 = getValidSlapStarts(cal0922, 9 * 60, 60);
  assert(starts60.length === 5, 'D20.5 60-min grid variant (09:00-22:00, 9h) has 5 valid starts', `got ${starts60.length}: ${starts60}`);
  assert(starts60[starts60.length - 1] === 240, 'D20.5b 60-min grid last start still 13:00', `got ${starts60[starts60.length - 1]}`);
}

// =================================================================
// Suite D21 — No-regression: shiftPlacementEnabled off/omitted is byte-identical to today
//
// The single most important gate for an opt-in feature: existing saved configs must see
// ZERO behavior change. Both `false` and omitted must take the exact same code path
// (evaluateN never even calls computeCandidatePlacementDistribution), and the returned
// DESResult/HCSearchOutput must never carry a shiftDistributionUsed / shiftPlacement block.
// =================================================================
console.log('\n--- Suite D21: No-regression when shiftPlacementEnabled is off/omitted ---');
{
  const calD21: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 22 };
  const laborD21Base: LaborConfig = { ...LABOR, dailyProductiveHours: 9 };
  const categoriesD21: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 30, shrinkagePct: 0.1, priority: 1 }];
  const intervalsD21: StandardInterval[] = [];
  for (let day = 0; day < 5; day++) {
    for (let h = 8; h < 22; h++) {
      intervalsD21.push({
        intervalIndex: intervalsD21.length,
        start: new Date(2026, 2, 2 + day, h, 0),
        end: new Date(2026, 2, 2 + day, h, 30),
        volume: 10,
        category: 'General',
      });
    }
  }
  const slaD21: SLAPolicyConfig = {
    primaryPct: 80, primaryWindow: 6, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 85, confidenceLevelPct: 90,
  };

  const runOmitted = searchOptimalHC({
    intervals: intervalsD21, openingWIP: [], categories: categoriesD21, calendar: calD21,
    labor: laborD21Base, sla: slaD21, seed: 42, userMaxHC: 60, replications: 5,
  });
  const runFalse = searchOptimalHC({
    intervals: intervalsD21, openingWIP: [], categories: categoriesD21, calendar: calD21,
    labor: { ...laborD21Base, shiftPlacementEnabled: false }, sla: slaD21, seed: 42, userMaxHC: 60, replications: 5,
  });

  assert(runOmitted.recommendedHC === runFalse.recommendedHC, 'D21.1 omitted vs explicit-false give identical recommendedHC', `omitted=${runOmitted.recommendedHC} false=${runFalse.recommendedHC}`);
  assert(runOmitted.finalDESResult?.primaryAchievedPct === runFalse.finalDESResult?.primaryAchievedPct, 'D21.2 identical primaryAchievedPct', `${runOmitted.finalDESResult?.primaryAchievedPct} vs ${runFalse.finalDESResult?.primaryAchievedPct}`);
  assert(runOmitted.shiftPlacement === undefined, 'D21.3 shiftPlacement telemetry is undefined when the flag is off', `got ${JSON.stringify(runOmitted.shiftPlacement)}`);
  // D21.4 (updated 2026-09-29, C6): with the flag off this was undefined because coverage repair could never pass (a saturated
  // late cohort 'left' early under budget-as-presence). Presence is now the agent's own shift window, so the unconditional
  // coverage repair passes and its minimal layout (<= 2 start times, no SLA-driven placement) is legitimately reported.
  const usedOmitted = runOmitted.finalDESResult?.shiftDistributionUsed;
  assert(JSON.stringify(usedOmitted) === JSON.stringify(runFalse.finalDESResult?.shiftDistributionUsed) && (usedOmitted === undefined || (usedOmitted.__POOLED__?.slaps.length ?? 99) <= 2), 'D21.4 flag off: shiftDistributionUsed is identical omitted vs false and is at most the minimal coverage-repair layout', `got ${JSON.stringify(usedOmitted)}`);
  assert(runOmitted.occupancyFeasibleFloor !== undefined && runOmitted.occupancyFeasibleFloor > 0, 'D21.5 occupancyFeasibleFloor is still always computed (diagnostic-only, independent of the flag)', `got ${runOmitted.occupancyFeasibleFloor}`);

  // A plain runBackofficeDES call with no shiftDistribution argument must be byte-identical
  // in code path to before this feature existed — confirmed by the untouched-path comment
  // guarantees in des-engine.ts, and pinned here for the return-shape contract.
  const desNoDist = runBackofficeDES({
    operationalHC: 20, intervals: intervalsD21, openingWIP: [], categories: categoriesD21,
    calendar: calD21, labor: laborD21Base, sla: slaD21, seed: 42,
  });
  assert(desNoDist.shiftDistributionUsed === undefined, 'D21.6 runBackofficeDES omits shiftDistributionUsed when no distribution supplied', `got ${JSON.stringify(desNoDist.shiftDistributionUsed)}`);
}

// =================================================================
// Suite D22 — computeShiftPlacement: house-monotonicity + greedy optimality vs brute force
//
// House-monotonicity is what keeps the walk-down search valid (decision-log D3's regression
// class — the same property, for the same reason, as the frozen Webster/Sainte-Laguë
// apportionment). Brute-force comparison on small instances proves the greedy is genuinely
// optimal, not merely good — the ground truth for the total-unimodularity claim.
// =================================================================
console.log('\n--- Suite D22: computeShiftPlacement — monotonicity + brute-force optimality ---');
{
  const windowLen = 14 * 60; // 08:00-22:00
  const shiftLen = 9 * 60; // 540min = 18 half-hour buckets
  const gridMin = 30;
  const size = Math.ceil(windowLen / gridMin); // 28
  const validStarts = getValidSlapStarts({ ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 22 }, shiftLen, gridMin);

  // Hand-built demand grid with two cells:
  //  - matrix[19][21] = 300: work released at bucket 19 (09:30 into the day = 17:30) with a
  //    deadline at bucket 21 (10:30 in = 18:30). An agent starting at offset 0 or 30 has
  //    ALREADY saturated its 9h budget by then (0+540=540min=bucket18, 30+540=570min=bucket19)
  //    and contributes ZERO marginal capacity into this window — only offset 60 (saturates at
  //    600min=bucket20, i.e. still has budget left at bucket19-21) can help at all. This is
  //    the exact release-gated mechanism the analytic model must capture to prove staggering's
  //    value, and it is what the earlier (flawed) deadline-only cumulative model could not see.
  //  - matrix[0][3] = 50: trivial early demand any start easily covers, included to confirm the
  //    greedy correctly prioritizes the binding window over the easy one.
  function buildGrid(): { gridMinutes: number; windowLengthMinutes: number; size: number; matrix: Float64Array; totalWorkMinutes: number } {
    const matrix = new Float64Array(size * size);
    matrix[19 * size + 21] = 300;
    matrix[0 * size + 3] = 50;
    return { gridMinutes: gridMin, windowLengthMinutes: windowLen, size, matrix, totalWorkMinutes: 350 };
  }

  // D22.1 — house-monotonicity: place(N+1) never removes an agent from any slap.
  let monotoneOk = true;
  let prevDist = computeShiftPlacement({ grid: buildGrid(), validStarts, shiftLengthMinutes: shiftLen, n: 1, slapMinutes: gridMin });
  for (let n = 2; n <= 20; n++) {
    const dist = computeShiftPlacement({ grid: buildGrid(), validStarts, shiftLengthMinutes: shiftLen, n, slapMinutes: gridMin });
    const prevMap = new Map(prevDist.slaps.map((s) => [s.startMinutesFromOpen, s.agentCount]));
    const curMap = new Map(dist.slaps.map((s) => [s.startMinutesFromOpen, s.agentCount]));
    const totalPrev = prevDist.slaps.reduce((a, s) => a + s.agentCount, 0);
    const totalCur = dist.slaps.reduce((a, s) => a + s.agentCount, 0);
    if (totalCur !== totalPrev + 1) monotoneOk = false;
    for (const [offset, cnt] of prevMap.entries()) {
      if ((curMap.get(offset) || 0) < cnt) monotoneOk = false;
    }
    prevDist = dist;
  }
  assert(monotoneOk, 'D22.1 place(N+1) is always place(N) plus exactly one agent, never fewer anywhere', 'a slap lost agents or total did not increase by exactly 1');

  // D22.2 — greedy matches brute force on a small instance (n=3, |validStarts| trimmed to 3:
  // offsets 0, 30, 60 — only offset 60 can help the binding window per the construction above).
  const smallStarts = validStarts.slice(0, 3);
  const n = 3;
  function bruteForceMinDeficit(): number {
    let best = Infinity;
    function* compositions(total: number, buckets: number): Generator<number[]> {
      if (buckets === 1) { yield [total]; return; }
      for (let i = 0; i <= total; i++) {
        for (const rest of compositions(total - i, buckets - 1)) yield [i, ...rest];
      }
    }
    for (const combo of compositions(n, smallStarts.length)) {
      const dist: ShiftSlapDistribution = {
        slapMinutes: gridMin,
        slaps: combo.map((c, i) => ({ startMinutesFromOpen: smallStarts[i], agentCount: c })).filter((s) => s.agentCount > 0),
      };
      const d = computeMaxAnalyticDeficitMinutes(buildGrid(), dist, shiftLen);
      if (d < best) best = d;
    }
    return best;
  }
  const greedyDist = computeShiftPlacement({ grid: buildGrid(), validStarts: smallStarts, shiftLengthMinutes: shiftLen, n, slapMinutes: gridMin });
  const greedyDeficit = computeMaxAnalyticDeficitMinutes(buildGrid(), greedyDist, shiftLen);
  const bruteDeficit = bruteForceMinDeficit();
  assert(approx(greedyDeficit, bruteDeficit, 1e-6), 'D22.2 greedy placement matches brute-force optimum on a small instance', `greedy=${greedyDeficit} brute=${bruteDeficit}`);
  assert(bruteDeficit === 210, 'D22.2b CONTROL: the true optimum is 210 (all 3 agents at offset 60 — the only offset that can reach the binding window)', `got ${bruteDeficit}`);
  const greedyOffsets = greedyDist.slaps.map((s) => s.startMinutesFromOpen);
  assert(greedyOffsets.length === 1 && greedyOffsets[0] === 60, 'D22.2c greedy independently discovers all 3 agents belong at offset 60', `got offsets ${JSON.stringify(greedyDist.slaps)}`);
}

// =================================================================
// Suite D23 — I1/I2 invariants under staggered availability
//
// I2 (no agent active outside the business window) had ZERO verification coverage before
// this feature — verifyAgentTimelineInvariants accepted a `calendar` parameter and never
// used it. New check #7 closes that gap; this suite exercises it specifically under
// staggering, since that is exactly the kind of change that could violate it silently.
// =================================================================
console.log('\n--- Suite D23: I1/I2 invariants hold under staggered shift placement ---');
{
  const calD23: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 22 };
  const laborD23: LaborConfig = { ...LABOR, dailyProductiveHours: 9 };
  const categoriesD23: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 30, shrinkagePct: 0.1, priority: 1 }];
  const intervalsD23: StandardInterval[] = [];
  for (let day = 0; day < 3; day++) {
    for (let h = 8; h < 22; h++) {
      intervalsD23.push({
        intervalIndex: intervalsD23.length,
        start: new Date(2026, 2, 2 + day, h, 0),
        end: new Date(2026, 2, 2 + day, h, 30),
        volume: 8,
        category: 'General',
      });
    }
  }
  const slaD23: SLAPolicyConfig = {
    primaryPct: 80, primaryWindow: 6, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 85, confidenceLevelPct: 90,
  };

  const N = 20;
  const staggeredDist: ShiftDistributionByCategory = {
    __POOLED__: { slapMinutes: 30, slaps: [
      { startMinutesFromOpen: 0, agentCount: 10 },   // 08:00
      { startMinutesFromOpen: 300, agentCount: 10 }, // 13:00 — covers the evening dead zone
    ] },
  };

  const desResult = runBackofficeDES({
    operationalHC: N, intervals: intervalsD23, openingWIP: [], categories: categoriesD23,
    calendar: calD23, labor: laborD23, sla: slaD23, seed: 42, shiftDistribution: staggeredDist,
  });

  const invariants = verifyAgentTimelineInvariants(desResult, laborD23, calD23);
  assert(invariants.valid, 'D23.1 verifyAgentTimelineInvariants passes under staggered availability (I1+I2, incl. new check #7)', `errors: ${invariants.errors.join('; ')}`);
  assert(desResult.shiftDistributionUsed !== undefined, 'D23.2 DESResult echoes the supplied shiftDistribution', `got ${JSON.stringify(desResult.shiftDistributionUsed)}`);

  // Deliberately-broken control: an agent slice starting before business open must be CAUGHT
  // by the new check — proves D23.1 isn't vacuously passing.
  const brokenResult = {
    ...desResult,
    agentTimeline: [
      ...desResult.agentTimeline,
      {
        agentId: 0, agentLabel: 'Agent-1', date: '2026-03-02', state: 'busy' as const,
        rosterSource: 'existing' as const, caseId: 'FAKE', category: 'General',
        from: new Date(2026, 2, 2, 6, 0), to: new Date(2026, 2, 2, 6, 30),
        minutes: 30, isResume: false, inBindingWindow: false,
      },
    ],
  };
  const brokenInvariants = verifyAgentTimelineInvariants(brokenResult, laborD23, calD23);
  assert(!brokenInvariants.valid, 'D23.3 control: a busy slice before business open IS caught by check #7', `expected invalid, got valid`);
}

// =================================================================
// Suite D24 — Seed determinism with shiftPlacementEnabled
// =================================================================
console.log('\n--- Suite D24: Seed determinism with shift placement enabled ---');
{
  const calD24: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 22 };
  const laborD24: LaborConfig = { ...LABOR, dailyProductiveHours: 9, shiftPlacementEnabled: true, shiftSlapMinutes: 30 };
  const categoriesD24: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 30, shrinkagePct: 0.1, priority: 1 }];
  const intervalsD24: StandardInterval[] = [];
  for (let day = 0; day < 5; day++) {
    for (let h = 8; h < 22; h++) {
      for (let m = 0; m < 60; m += 30) {
        intervalsD24.push({
          intervalIndex: intervalsD24.length,
          start: new Date(2026, 2, 2 + day, h, m),
          end: new Date(2026, 2, 2 + day, h, m + 30),
          volume: h >= 17 ? 12 : 4, // demand skewed into the dead zone
          category: 'General',
        });
      }
    }
  }
  const slaD24: SLAPolicyConfig = {
    primaryPct: 80, primaryWindow: 6, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 85, confidenceLevelPct: 90,
  };

  const run1 = searchOptimalHC({ intervals: intervalsD24, openingWIP: [], categories: categoriesD24, calendar: calD24, labor: laborD24, sla: slaD24, seed: 777, userMaxHC: 80, replications: 5 });
  const run2 = searchOptimalHC({ intervals: intervalsD24, openingWIP: [], categories: categoriesD24, calendar: calD24, labor: laborD24, sla: slaD24, seed: 777, userMaxHC: 80, replications: 5 });

  assert(run1.recommendedHC === run2.recommendedHC, 'D24.1 identical seed gives identical recommendedHC', `${run1.recommendedHC} vs ${run2.recommendedHC}`);
  assert(run1.occupancyFeasibleFloor === run2.occupancyFeasibleFloor, 'D24.2 identical N_occ', `${run1.occupancyFeasibleFloor} vs ${run2.occupancyFeasibleFloor}`);
  assert(run1.shiftPlacement?.placementFeasibleFloor === run2.shiftPlacement?.placementFeasibleFloor, 'D24.3 identical N_sla', `${run1.shiftPlacement?.placementFeasibleFloor} vs ${run2.shiftPlacement?.placementFeasibleFloor}`);
  assert(JSON.stringify(run1.shiftPlacement?.winningDistribution) === JSON.stringify(run2.shiftPlacement?.winningDistribution), 'D24.4 identical winning distribution', 'distributions differ across identical-seed runs');
}

// =================================================================
// Suite D25 — Safety proof: the search-level result is never worse than uniform-only, even
// when the raw placement distribution underperforms
//
// Honest status, established empirically across many demand shapes while building this
// suite (front-loaded morning, evening-heavy, single- and multi-day, tight and loose SLA
// windows): the analytic greedy's raw output is frequently NO BETTER than — and sometimes
// worse than — a plain uniform-open start once a genuine defect (see below) was fixed. It
// clearly CAN find a real improvement on a demand shape purpose-built to require it (suite
// D22's release-gated construction, verified against brute force), but it has not been
// empirically shown to reliably do so on realistic continuous DES-driven demand. What is
// solid, and what this suite pins, is the SAFETY property everything else depends on:
// `pickPlacementOrUniform` (hc-search.ts) only ever lets a placement result replace the
// uniform one when it verifiably PASSES via a real DES run — so on a demand shape where the
// raw distribution is worse, the full search must land on EXACTLY the same recommendation as
// with the flag off. That is the guarantee a planner can rely on: enabling this feature can
// never make the recommended headcount worse, whether or not it manages to make it better.
//
// This suite also pins the defect that made an earlier version of it prove the wrong thing:
// the initial per-agent eligibility at horizon start, and the idle-pool repopulation when a
// later slap cohort's AgentAvailable fires, were computed using data that only exists when
// skipCaseResultsAndTimeline is false — but the CI-gated replications that decide pass/fail
// always run WITH that flag true (for speed), so every replication saw every agent as
// available from business open regardless of assigned offset. Measured: a distribution that
// the CI gate scored at ~78% actually achieved 52.5% when honestly simulated — a ~25
// percentage-point inflation that let the search recommend a headcount that did not meet the
// target. Fixed via agentOnShiftToday, a mode-independent per-agent eligibility tracker
// (des-engine.ts) that is never gated behind skipCaseResultsAndTimeline.
// =================================================================
console.log('\n--- Suite D25: Safety proof — search-level result never worse than uniform-only ---');
{
  const calD25: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 22 };
  const laborD25Off: LaborConfig = { ...LABOR, dailyProductiveHours: 9 };
  const laborD25On: LaborConfig = { ...laborD25Off, shiftPlacementEnabled: true, shiftSlapMinutes: 30 };
  const categoriesD25: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1, primaryPct: 80, primaryWindow: 2, primaryUnit: 'hours' }];
  const intervalsD25: StandardInterval[] = [];
  const N = 16;
  for (let day = 0; day < 5; day++) {
    // Morning-saturating + light-evening demand — the shape a naive model would expect
    // staggering to help, and exactly the shape empirically shown NOT to (raw placed result
    // below uniform once the eligibility bug above was fixed). Deliberately kept as the
    // adversarial case for the safety proof, not softened into an easy win.
    for (let h = 8; h < 22; h++) {
      const vol = h < 17 ? 24 : 5;
      for (let m = 0; m < 60; m += 30) {
        intervalsD25.push({
          intervalIndex: intervalsD25.length,
          start: new Date(2026, 2, 2 + day, h, m),
          end: new Date(2026, 2, 2 + day, h, m + 30),
          volume: vol,
          category: 'General',
        });
      }
    }
  }
  const slaD25: SLAPolicyConfig = {
    primaryPct: 80, primaryWindow: 2, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90,
  };

  const uniformResult = runBackofficeDES({
    operationalHC: N, intervals: intervalsD25, openingWIP: [], categories: categoriesD25,
    calendar: calD25, labor: laborD25Off, sla: slaD25, seed: 42,
  });

  const gen = { intervals: intervalsD25, openingWIP: [], categories: categoriesD25, calendar: calD25, sla: slaD25, seed: 42 };
  const cases = generateCaseEntities(gen);
  const placementDist = computeCandidatePlacementDistribution({
    n: N, cases: cases.cases, calendar: calD25, labor: laborD25On, queueArchitecture: 'pooled',
  });
  assert(placementDist !== null, 'D25.1 a placement distribution was found for N=16', 'computeCandidatePlacementDistribution returned null');

  const placedResult = runBackofficeDES({
    operationalHC: N, intervals: intervalsD25, openingWIP: [], categories: categoriesD25,
    calendar: calD25, labor: laborD25On, sla: slaD25, seed: 42, shiftDistribution: placementDist || undefined,
  });
  assert(
    placedResult.primaryAchievedPct <= uniformResult.primaryAchievedPct,
    'D25.2 CONTROL: this scenario\'s raw placement distribution does not beat uniform (the adversarial case this suite is built to test)',
    `placed=${placedResult.primaryAchievedPct}% uniform=${uniformResult.primaryAchievedPct}% — if this ever starts passing, D25.3 below still must`
  );

  const searchOff = searchOptimalHC({
    intervals: intervalsD25, openingWIP: [], categories: categoriesD25, calendar: calD25,
    labor: laborD25Off, sla: slaD25, seed: 42, userMaxHC: 40, replications: 5,
  });
  const searchOn = searchOptimalHC({
    intervals: intervalsD25, openingWIP: [], categories: categoriesD25, calendar: calD25,
    labor: laborD25On, sla: slaD25, seed: 42, userMaxHC: 40, replications: 5,
  });
  assert(
    (searchOn.recommendedHC ?? Infinity) <= (searchOff.recommendedHC ?? Infinity),
    'D25.3 PROOF: full search with placement enabled never recommends a HIGHER headcount than with it off',
    `off=${searchOff.recommendedHC} on=${searchOn.recommendedHC}`
  );
  assert(
    searchOn.recommendedHC === searchOff.recommendedHC,
    'D25.4 on THIS adversarial scenario, the search correctly rejects the underperforming placement and lands on the identical recommendation',
    `off=${searchOff.recommendedHC} on=${searchOn.recommendedHC}`
  );
}

// =================================================================
// Suite D26 — I4: occupancy ceiling still rejects candidates under placement
//
// Placement moves the SLA gate, never the occupancy gate (occupancy = demand / (N x hours),
// invariant to WHEN agents work). This pins that a candidate below N_occ is never rescued by
// placement, and that rawOccupancyPct stays unclamped (regression guard for D19/BUG-OCC-CAP).
// =================================================================
console.log('\n--- Suite D26: I4 — occupancy ceiling is never bypassed by placement ---');
{
  const calD26: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 22 };
  const laborD26: LaborConfig = { ...LABOR, dailyProductiveHours: 9, shiftPlacementEnabled: true };
  const categoriesD26: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 30, shrinkagePct: 0.1, priority: 1 }];
  const intervalsD26: StandardInterval[] = [];
  for (let day = 0; day < 5; day++) {
    for (let h = 8; h < 22; h++) {
      intervalsD26.push({
        intervalIndex: intervalsD26.length,
        start: new Date(2026, 2, 2 + day, h, 0),
        end: new Date(2026, 2, 2 + day, h, 30),
        volume: 20,
        category: 'General',
      });
    }
  }
  const slaD26: SLAPolicyConfig = {
    primaryPct: 80, primaryWindow: 6, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90,
  };

  // A deliberately tiny N — nowhere near enough capacity even with perfect timing.
  const N = 3;
  const desResult = runBackofficeDES({
    operationalHC: N, intervals: intervalsD26, openingWIP: [], categories: categoriesD26,
    calendar: calD26, labor: laborD26, sla: slaD26, seed: 42,
  });
  assert(desResult.rawOccupancyPct > 100, 'D26.1 rawOccupancyPct is unclamped and reads above 100% for a badly undersized N', `got ${desResult.rawOccupancyPct}%`);
  assert(!desResult.passesOccupancyCap, 'D26.2 occupancy gate correctly rejects N=3', `passesOccupancyCap=${desResult.passesOccupancyCap}`);

  const searchResult = searchOptimalHC({
    intervals: intervalsD26, openingWIP: [], categories: categoriesD26, calendar: calD26,
    labor: laborD26, sla: slaD26, seed: 42, userMaxHC: 60, replications: 5,
  });
  assert(
    searchResult.recommendedHC === null || (searchResult.recommendedHC ?? 0) >= (searchResult.occupancyFeasibleFloor ?? 0),
    'D26.3 the search never recommends an N below N_occ, even with placement enabled',
    `recommendedHC=${searchResult.recommendedHC} occupancyFeasibleFloor=${searchResult.occupancyFeasibleFloor}`
  );
}

// =================================================================
// Suite D27 — day-open telemetry off-by-one (intervalsTimeline availableAgents)
//
// Defect: logTimelineState(simTimeMs) is called at the TOP of the event loop, before the
// popped event is processed. At each day's opening AgentAvailable event, the idle list is
// still empty (cleared at the previous DayClose) at the moment of logging, so the FIRST
// business-window row of every day reports availableAgents=0 even though agents come online
// microseconds later within the same tick. Sizing is unaffected (agentTimeline/DES metrics
// are computed from the authoritative event-driven state, not this display log) — this is a
// reporting-only defect, but it reads as a catastrophic staffing hole to a planner and was
// the proximate trigger for a lengthy misdiagnosis during this session's investigation.
// NOTE: day 0 (the very first day of the horizon) does NOT exhibit this — pooledIdleAgents
// is pre-seeded with every agent before the event loop starts, so the list is already full
// when day 0's open event is logged. The bug only appears from day 1 onward, once a real
// DayClose has emptied the list and the next AgentAvailable must refill it. This matches the
// user's own exported timeline exactly: 1 of 31 days (the first) was correctly staffed at
// open; the other 30 read as zero.
// Control: every OTHER interval of the day (where no state-changing event coincides with the
// log boundary) must already report correctly — this suite must not "fix" those.
// =================================================================
console.log('\n--- Suite D27: day-open telemetry off-by-one (intervalsTimeline) ---');
{
  const calD27: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 22 };
  const laborD27: LaborConfig = { ...LABOR, dailyProductiveHours: 9 };
  const categoriesD27: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 }];
  const intervalsD27: StandardInterval[] = [];
  for (let day = 0; day < 3; day++) {
    for (let h = 8; h < 22; h++) {
      for (let m = 0; m < 60; m += 30) {
        intervalsD27.push({
          intervalIndex: intervalsD27.length,
          start: new Date(2026, 2, 2 + day, h, m),
          end: new Date(2026, 2, 2 + day, h, m + 30),
          volume: 10,
          category: 'General',
        });
      }
    }
  }
  const slaD27: SLAPolicyConfig = {
    primaryPct: 80, primaryWindow: 4, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90,
  };
  const N = 10;
  const des = runBackofficeDES({
    operationalHC: N, intervals: intervalsD27, openingWIP: [], categories: categoriesD27,
    calendar: calD27, labor: laborD27, sla: slaD27, seed: 42,
  });

  // Cross-check against the authoritative agentTimeline: how many agents are genuinely
  // on-shift (state != 'off') at exactly 08:00 on day 1 (2026-03-03) — day 0 is exempt (see
  // note above), so day 1 is the first day the defect can actually appear on.
  const day1Open = new Date(2026, 2, 3, 8, 0, 0, 0);
  const onShiftAtOpen = new Set<number>();
  for (const s of des.agentTimeline || []) {
    if (s.state === 'off') continue;
    if (s.from.getTime() <= day1Open.getTime() && s.to.getTime() > day1Open.getTime()) {
      onShiftAtOpen.add(s.agentId);
    }
  }
  assert(onShiftAtOpen.size === N, 'D27.1 CONTROL: agentTimeline (authoritative) shows all N agents on-shift at day-1 open', `onShiftAtOpen=${onShiftAtOpen.size}, expected ${N}`);

  const openRow = des.intervalsTimeline.find((r) => r.time.getTime() === day1Open.getTime());
  assert(!!openRow, 'D27.2 an intervalsTimeline row exists for the day-1-open timestamp', 'no matching row found');
  if (openRow) {
    assert(
      openRow.availableAgents === N,
      'D27.3 intervalsTimeline.availableAgents at day-1 open matches the authoritative on-shift count (not the pre-event snapshot)',
      `availableAgents=${openRow.availableAgents}, expected ${N} (agentTimeline confirms ${onShiftAtOpen.size} genuinely on-shift)`
    );
  }

  // Control: a mid-day row (day 1, 09:00 — no coinciding day-open event) must already be
  // correct — this suite must not mask a real fix by loosening an unrelated check.
  const midRow = des.intervalsTimeline.find((r) => r.time.getTime() === new Date(2026, 2, 3, 9, 0, 0, 0).getTime());
  assert(!!midRow && midRow.availableAgents === N, 'D27.4 CONTROL: a mid-day row unaffected by the day-open race already reports correctly', `midRow=${JSON.stringify(midRow)}`);

  // Control: day 0's open row is EXPECTED to already be correct (pre-seeded idle list) —
  // proves the fix (once applied) doesn't need to special-case day 0, and this suite isn't
  // accidentally passing only because day 0 was already fine.
  const day0Row = des.intervalsTimeline.find((r) => r.time.getTime() === new Date(2026, 2, 2, 8, 0, 0, 0).getTime());
  assert(!!day0Row && day0Row.availableAgents === N, 'D27.5 CONTROL: day 0 open row is unaffected either way (pre-seeded idle list)', `day0Row=${JSON.stringify(day0Row)}`);
}

// =================================================================
// Suite D28 — fast-path/full-path attainment agreement under staggering (agentOnShiftToday)
//
// Pins a defect already fixed before this suite existed, so a future accidental revert of
// `agentOnShiftToday` (des-engine.ts) fails loudly here instead of only being caught
// incidentally by D25's coarser end-to-end "never worse" check. Pre-fix, the CI-gated search
// replications (which always run with skipCaseResultsAndTimeline=true for speed) treated
// every agent as on-shift from business open regardless of its assigned stagger offset,
// inflating attainment by tens of percentage points versus the honest single-seed audit run
// (skipCaseResultsAndTimeline=false) — see docs/wfm/07-known-defects-and-decisions.md for the
// measured 78.7%->52.5% case. This suite asserts the two modes agree directly, on the SAME
// distribution, rather than only on the search's final accept/reject decision.
// =================================================================
console.log('\n--- Suite D28: fast-path/full-path attainment agreement (agentOnShiftToday) ---');
{
  const calD28: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 22 };
  const laborD28: LaborConfig = { ...LABOR, dailyProductiveHours: 9, shiftPlacementEnabled: true, shiftSlapMinutes: 30 };
  const categoriesD28: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1, primaryPct: 80, primaryWindow: 2, primaryUnit: 'hours' }];
  const intervalsD28: StandardInterval[] = [];
  for (let day = 0; day < 5; day++) {
    for (let h = 8; h < 22; h++) {
      const vol = h < 17 ? 24 : 5; // same morning-saturating shape D25 uses
      for (let m = 0; m < 60; m += 30) {
        intervalsD28.push({ intervalIndex: intervalsD28.length, start: new Date(2026, 2, 2 + day, h, m), end: new Date(2026, 2, 2 + day, h, m + 30), volume: vol, category: 'General' });
      }
    }
  }
  const slaD28: SLAPolicyConfig = {
    primaryPct: 80, primaryWindow: 2, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90,
  };
  const N = 16;
  const gen = generateCaseEntities({ intervals: intervalsD28, openingWIP: [], categories: categoriesD28, calendar: calD28, sla: slaD28, seed: 42 });
  const dist = computeCandidatePlacementDistribution({ n: N, cases: gen.cases, calendar: calD28, labor: laborD28, queueArchitecture: 'pooled' });
  assert(dist !== null, 'D28.1 a placement distribution was found for N=16 (setup)', 'computeCandidatePlacementDistribution returned null');

  const fullPath = runBackofficeDES({
    operationalHC: N, intervals: intervalsD28, openingWIP: [], categories: categoriesD28,
    calendar: calD28, labor: laborD28, sla: slaD28, seed: 42, shiftDistribution: dist || undefined,
    skipCaseResultsAndTimeline: false,
  });
  const fastPath = runBackofficeDES({
    operationalHC: N, intervals: intervalsD28, openingWIP: [], categories: categoriesD28,
    calendar: calD28, labor: laborD28, sla: slaD28, seed: 42, shiftDistribution: dist || undefined,
    skipCaseResultsAndTimeline: true,
  });
  const delta = Math.abs(fullPath.primaryAchievedPct - fastPath.primaryAchievedPct);
  assert(
    delta < 1,
    'D28.2 fast-path (CI-gate mode) and full-path (audit mode) primaryAchievedPct agree within 1pp on the SAME staggered distribution',
    `fullPath=${fullPath.primaryAchievedPct}% fastPath=${fastPath.primaryAchievedPct}% delta=${delta.toFixed(2)}pp — a large delta here means agentOnShiftToday's mode-independent eligibility gating (des-engine.ts) has regressed`
  );

  // Control: the SAME check on a non-staggered (uniform) run must also agree — proves this
  // isn't just measuring seed/replication noise unrelated to staggering.
  const laborUniform: LaborConfig = { ...laborD28, shiftPlacementEnabled: false };
  const uniformFull = runBackofficeDES({ operationalHC: N, intervals: intervalsD28, openingWIP: [], categories: categoriesD28, calendar: calD28, labor: laborUniform, sla: slaD28, seed: 42, skipCaseResultsAndTimeline: false });
  const uniformFast = runBackofficeDES({ operationalHC: N, intervals: intervalsD28, openingWIP: [], categories: categoriesD28, calendar: calD28, labor: laborUniform, sla: slaD28, seed: 42, skipCaseResultsAndTimeline: true });
  assert(
    Math.abs(uniformFull.primaryAchievedPct - uniformFast.primaryAchievedPct) < 1,
    'D28.3 CONTROL: fast/full-path agreement also holds for uniform (non-staggered) runs',
    `full=${uniformFull.primaryAchievedPct}% fast=${uniformFast.primaryAchievedPct}%`
  );
}

// =================================================================
// Suite D29 — I5: per-agent stagger-offset compliance (check #8 in verifyAgentTimelineInvariants)
//
// Defect: check #7 only validates the GLOBAL business window (busy slices fall inside
// open-close), which cannot catch an agent dispatched before ITS OWN assigned stagger
// offset while the business is already open — measured during this session's investigation:
// a synthetic timeline where an agent was busy 295 minutes before its own +300min offset,
// but after the 08:00 global open, passed verifyAgentTimelineInvariants with valid=true.
// Fixed by check #8, which reconstructs each agent's assigned offset from
// DESResult.shiftDistributionUsed (already echoed by runBackofficeDES — no new parameter
// needed) and asserts no busy slice starts before it.
// Control: a genuinely compliant staggered run (D23's scenario) must still pass cleanly.
// =================================================================
console.log('\n--- Suite D29: I5 — per-agent stagger-offset compliance (check #8) ---');
{
  const calD29: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 22 };
  const laborD29: LaborConfig = { ...LABOR, dailyProductiveHours: 9, shiftPlacementEnabled: true, shiftSlapMinutes: 30 };
  const categoriesD29: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 }];
  const intervalsD29: StandardInterval[] = [];
  for (let day = 0; day < 5; day++) {
    for (let h = 8; h < 22; h++) {
      for (let m = 0; m < 60; m += 30) {
        intervalsD29.push({ intervalIndex: intervalsD29.length, start: new Date(2026, 2, 2 + day, h, m), end: new Date(2026, 2, 2 + day, h, m + 30), volume: 20, category: 'General' });
      }
    }
  }
  const slaD29: SLAPolicyConfig = {
    primaryPct: 80, primaryWindow: 6, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90,
  };
  const N = 16;
  const gen = generateCaseEntities({ intervals: intervalsD29, openingWIP: [], categories: categoriesD29, calendar: calD29, sla: slaD29, seed: 42 });
  const dist = computeCandidatePlacementDistribution({ n: N, cases: gen.cases, calendar: calD29, labor: laborD29, queueArchitecture: 'pooled' });
  assert(dist !== null, 'D29.1 a placement distribution was found for N=16 (setup)', 'computeCandidatePlacementDistribution returned null');

  const des = runBackofficeDES({
    operationalHC: N, intervals: intervalsD29, openingWIP: [], categories: categoriesD29,
    calendar: calD29, labor: laborD29, sla: slaD29, seed: 42, shiftDistribution: dist || undefined,
  });
  const baseline = verifyAgentTimelineInvariants(des, laborD29, calD29);
  assert(baseline.valid, 'D29.2 CONTROL: a genuinely compliant staggered run passes cleanly (incl. new check #8)', JSON.stringify(baseline.errors));

  // Reconstruct per-agent offsets exactly as des-engine.ts assigns them (ascending agentId,
  // ascending slap offset, sequential cursor) — read-only reconstruction for the test, not a
  // duplicated production algorithm.
  const sortedSlaps = [...dist!.__POOLED__.slaps].sort((a, b) => a.startMinutesFromOpen - b.startMinutesFromOpen);
  const agentOffset: number[] = new Array(N).fill(0);
  let cursor = 0;
  for (const slap of sortedSlaps) {
    for (let k = 0; k < slap.agentCount && cursor < N; k++, cursor++) agentOffset[cursor] = slap.startMinutesFromOpen;
  }
  const lateAgentId = agentOffset.findIndex((o) => o === Math.max(...agentOffset));
  const lateOffset = agentOffset[lateAgentId];
  assert(lateOffset > 0, 'D29.3 setup: at least one agent has a non-zero offset to violate', `lateOffset=${lateOffset}`);

  if (lateOffset > 0) {
    // Split whichever non-busy slice OVERLAPS [dayOpen, ownStart) into a 5-min busy slice
    // inside that overlap — AFTER global open (08:00), BEFORE its own offset — preserving
    // contiguity so invariants #1/#3/#6 don't trip on an artifact of the injection itself.
    // The overlapping slice need not START at dayOpen: an idle/off slice commonly spans from
    // the previous evening's shift end through midnight into this shift's own start.
    const clonedTimeline = des.agentTimeline!.map((s) => ({ ...s }));
    const dayOpen = new Date(2026, 2, 3, 8, 0, 0, 0);
    const ownStart = new Date(dayOpen.getTime() + lateOffset * 60000);
    const agentSlices = clonedTimeline.filter((s) => s.agentId === lateAgentId).sort((a, b) => a.from.getTime() - b.from.getTime());
    const target = agentSlices.find((s) => {
      if (s.state === 'busy') return false;
      const overlapStart = Math.max(s.from.getTime(), dayOpen.getTime());
      const overlapEnd = Math.min(s.to.getTime(), ownStart.getTime());
      return overlapEnd - overlapStart >= 5 * 60000;
    });
    assert(!!target, 'D29.4 setup: found a non-busy slice overlapping [own day-open, own offset) to split', 'no suitable slice found');
    if (target) {
      // Compensate by shrinking the agent's LAST busy slice of the same day by 5 minutes
      // (converting that tail to idle) and extending whatever follows it to absorb the gap —
      // keeps total busy minutes for the day AT the daily budget and preserves contiguity, so
      // invariants #1/#4/#6 stay clean and the ONLY thing wrong with the tampered timeline is
      // the offset violation check #8 targets.
      // Shrink any same-day busy slice by 5min and INSERT a new 5min idle slice in the gap
      // it leaves behind — contiguous and correct regardless of what the neighbor's state is
      // (extending an adjacent slice instead only works if that neighbor is non-busy; here it
      // may not be, e.g. one continuous busy run all day under shift-end enforcement).
      const sameDayBusy = agentSlices.filter((s) => s.state === 'busy' && s.date === target.date).sort((a, b) => a.from.getTime() - b.from.getTime());
      const lastBusy = sameDayBusy.find((s) => s.minutes >= 5);
      assert(!!lastBusy, 'D29.4b setup: found a same-day busy slice >= 5min to shrink for compensation', 'no suitable busy slice found');
      if (lastBusy) {
        const lastBusyIdx = clonedTimeline.findIndex((s) => s.agentId === lastBusy.agentId && s.from.getTime() === lastBusy.from.getTime() && s.to.getTime() === lastBusy.to.getTime() && s.state === 'busy');
        const shrunkEnd = new Date(lastBusy.to.getTime() - 5 * 60000);
        const freedIdle = { ...lastBusy, state: 'idle' as const, from: shrunkEnd, to: lastBusy.to, minutes: 5, caseId: null, category: null };
        clonedTimeline.splice(lastBusyIdx, 1, { ...lastBusy, to: shrunkEnd, minutes: lastBusy.minutes - 5 }, freedIdle);

        const idx = clonedTimeline.indexOf(target);
        const splitStart = new Date(Math.max(target.from.getTime(), dayOpen.getTime()));
        const splitEnd = new Date(splitStart.getTime() + 5 * 60000);
        const pieces: typeof target[] = [];
        if (target.from.getTime() < splitStart.getTime()) {
          pieces.push({ ...target, to: splitStart, minutes: (splitStart.getTime() - target.from.getTime()) / 60000 });
        }
        pieces.push({ ...target, state: 'busy' as const, from: splitStart, to: splitEnd, minutes: 5, caseId: lastBusy.caseId, category: lastBusy.category });
        if (splitEnd.getTime() < target.to.getTime()) {
          pieces.push({ ...target, from: splitEnd, minutes: (target.to.getTime() - splitEnd.getTime()) / 60000 });
        }
        clonedTimeline.splice(idx, 1, ...pieces);
        const tamperedDes = { ...des, agentTimeline: clonedTimeline };
        const tampered = verifyAgentTimelineInvariants(tamperedDes as any, laborD29, calD29);
        assert(
          !tampered.valid,
          'D29.5 check #8 CATCHES an agent busy before its own assigned offset (after global open) — the exact violation check #7 alone missed',
          `expected valid=false, got valid=${tampered.valid}, errors=${JSON.stringify(tampered.errors)}`
        );
        if (tampered.errors.length > 0) {
          assert(
            !tampered.errors.some((e) => e.includes('exceeds daily budget') || e.includes('overlap') || e.includes('gap')),
            'D29.6 the ONLY errors are the offset-compliance violation, not an artifact of the injection (budget/overlap/gap)',
            JSON.stringify(tampered.errors)
          );
        }
      }
    }
  }
}

// =================================================================
// Suite D30 — Phase 2: shift-end enforcement + in-flight case handover
//
// Prior to this suite, staggeredMode gave every agent a real START but no END: an agent
// stayed "available" (subject only to their remaining daily-minute budget) all the way to
// business close regardless of shift length — measured during the 2026-08-28 audit: an agent
// with a 9h shift in a 14h window was still taking cases 5+ hours after their nominal shift
// end. This made the analytic placement model (which assumes capacity confined to
// [offset, offset+shiftLength]) disagree with what the simulator actually did, and meant
// staggering could only ever REMOVE early availability without adding real late availability
// (the late availability was already there under the old model). Fixed by giving each
// staggered cohort a real ShiftEnd event and extending dispatchSingleQueue's look-ahead with
// a third bound (the agent's own remaining shift minutes) alongside budget and business
// close — whichever is soonest determines whether a case in flight completes, gets parked to
// next business day (budget/close bound), or is handed back to the LIVE queue immediately for
// a still-on-shift colleague to pick up (shift-end bound).
// This is genuinely new behavior with no prior passing/failing state to reproduce — before
// this change staggeredMode never scheduled a 'ShiftEnd' event at all, so every assertion
// below is necessarily false against the pre-change code.
// =================================================================
console.log('\n--- Suite D30: Phase 2 — shift-end enforcement + in-flight case handover ---');
{
  const calD30: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 22 };
  const laborD30: LaborConfig = { ...LABOR, dailyProductiveHours: 9, shiftPlacementEnabled: true, shiftSlapMinutes: 30 };
  const categoriesD30: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 }];
  const intervalsD30: StandardInterval[] = [];
  for (let day = 0; day < 3; day++) {
    for (let h = 8; h < 22; h++) {
      for (let m = 0; m < 60; m += 30) {
        intervalsD30.push({ intervalIndex: intervalsD30.length, start: new Date(2026, 2, 2 + day, h, m), end: new Date(2026, 2, 2 + day, h, m + 30), volume: 20, category: 'General' });
      }
    }
  }
  const slaD30: SLAPolicyConfig = {
    primaryPct: 80, primaryWindow: 6, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90,
  };
  const N = 16;
  const gen = generateCaseEntities({ intervals: intervalsD30, openingWIP: [], categories: categoriesD30, calendar: calD30, sla: slaD30, seed: 42 });
  const dist = computeCandidatePlacementDistribution({ n: N, cases: gen.cases, calendar: calD30, labor: laborD30, queueArchitecture: 'pooled' });
  assert(dist !== null, 'D30.1 a placement distribution was found for N=16 (setup)', 'computeCandidatePlacementDistribution returned null');

  const des = runBackofficeDES({
    operationalHC: N, intervals: intervalsD30, openingWIP: [], categories: categoriesD30,
    calendar: calD30, labor: laborD30, sla: slaD30, seed: 42, shiftDistribution: dist || undefined,
  });

  // Reconstruct per-agent offsets exactly as des-engine.ts assigns them, mirroring D29.
  const sortedSlaps = [...dist!.__POOLED__.slaps].sort((a, b) => a.startMinutesFromOpen - b.startMinutesFromOpen);
  const agentOffset: number[] = new Array(N).fill(0);
  let cursor = 0;
  for (const slap of sortedSlaps) {
    for (let k = 0; k < slap.agentCount && cursor < N; k++, cursor++) agentOffset[cursor] = slap.startMinutesFromOpen;
  }
  const shiftLenMin = laborD30.dailyProductiveHours * 60; // 540
  const windowLenMin = 14 * 60; // 08:00-22:00

  // D30.2/D30.3: for every agent whose offset+shiftLength < window length (a genuine mid-day
  // shift end, not one that coincides with close), no slice for them on any day may start at
  // or after their own shift-end time.
  let earlyEndAgents = 0;
  let overrunFound: string | null = null;
  const dayOpen0 = new Date(2026, 2, 2, 8, 0, 0, 0);
  for (let a = 0; a < N; a++) {
    if (agentOffset[a] + shiftLenMin >= windowLenMin) continue; // coincides with close — D30.5 covers this
    earlyEndAgents++;
    const ownEndOffsetMin = agentOffset[a] + shiftLenMin;
    for (const slice of des.agentTimeline || []) {
      if (slice.agentId !== a || slice.state === 'off') continue;
      // minutes-from-open of this slice's own calendar day
      const sliceDayOpen = new Date(slice.from);
      sliceDayOpen.setHours(dayOpen0.getHours(), dayOpen0.getMinutes(), 0, 0);
      const sliceOffsetMin = (slice.from.getTime() - sliceDayOpen.getTime()) / 60000;
      if (sliceOffsetMin >= ownEndOffsetMin + 1e-6) {
        overrunFound = `Agent-${a + 1} (own offset +${agentOffset[a]}, shift ends +${ownEndOffsetMin}) has a ${slice.state} slice starting +${sliceOffsetMin.toFixed(1)}min from open on ${slice.date}`;
        break;
      }
    }
    if (overrunFound) break;
  }
  assert(earlyEndAgents > 0, 'D30.2 setup: at least one agent has a genuine mid-day shift end to check', `earlyEndAgents=${earlyEndAgents}`);
  assert(!overrunFound, 'D30.3 no agent has any busy/idle slice after their OWN shift end (presence bounded by shift length, not just daily budget/business close)', overrunFound || '');

  // D30.4: the agent whose offset+shiftLength coincides EXACTLY with close must NOT be cut
  // off early — confirms the "skip redundant ShiftEnd when it matches DayClose" guard works
  // and this agent's presence still legitimately extends to close.
  const closeCoincidentAgent = agentOffset.findIndex((o) => o + shiftLenMin >= windowLenMin);
  if (closeCoincidentAgent >= 0) {
    const lastSliceForAgent = (des.agentTimeline || [])
      .filter((s) => s.agentId === closeCoincidentAgent && s.state !== 'off')
      .sort((a, b) => b.to.getTime() - a.to.getTime())[0];
    const closeTime = new Date(2026, 2, 2, 22, 0, 0, 0);
    const reachesClose = !!lastSliceForAgent && lastSliceForAgent.to.getHours() === closeTime.getHours() && lastSliceForAgent.to.getMinutes() === closeTime.getMinutes();
    assert(reachesClose, 'D30.4 an agent whose offset+shiftLength coincides with business close is NOT cut off early (no redundant ShiftEnd event)', `lastSlice=${lastSliceForAgent ? lastSliceForAgent.to.toISOString() : 'none'}`);
  }

  // D30.5: overall invariants still hold on this staggered + shift-end run (I1/I2/I5 etc.).
  const invariants = verifyAgentTimelineInvariants(des, laborD30, calD30);
  assert(invariants.valid, 'D30.5 verifyAgentTimelineInvariants passes on a shift-end-enforced staggered run', JSON.stringify(invariants.errors));
}

// =================================================================
// Suite D31 — Phase 2: in-flight case handover (mid-shift-end interruption)
//
// Constructs a scenario where a case is DEMONSTRABLY still being worked when an agent's
// shift ends, and confirms it is completed the SAME DAY by a different, still-on-shift
// agent — not deferred overnight via parkedWIP/CaseResume (the DayClose semantics, which are
// for the business closing, not an individual cohort's shift ending).
// =================================================================
console.log('\n--- Suite D31: Phase 2 — in-flight case handover, same-day completion ---');
{
  const calD31: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 22 };
  // Two cohorts: a handful of agents ending EARLY (offset 0, 9h shift -> ends 17:00), and a
  // late cohort still on shift afterward (offset 300 = 13:00 start) to receive any handover.
  // A long-AHT category (180 min) guarantees at least one case is genuinely mid-processing
  // when the early cohort's shift ends at 17:00.
  const laborD31: LaborConfig = { ...LABOR, dailyProductiveHours: 9, shiftPlacementEnabled: true, shiftSlapMinutes: 30 };
  // AHT 400min: long enough that a case starting at 12:00 (before the late cohort even
  // exists) is still in progress well past the early cohort's 17:00 shift end (300min later).
  const categoriesD31: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 400, shrinkagePct: 0, priority: 1 }];
  const distD31: ShiftDistributionByCategory = { __POOLED__: { slapMinutes: 30, slaps: [{ startMinutesFromOpen: 0, agentCount: 3 }, { startMinutesFromOpen: 300, agentCount: 3 }] } };
  const intervalsD31: StandardInterval[] = [];
  // Arrives at 12:00 — BEFORE the late cohort's own 13:00 start, so only the early cohort is
  // in the idle pool at assignment time (avoids a LIFO idle-pool pick order artifact where an
  // agent added to the pool more recently could otherwise be picked first).
  intervalsD31.push({ intervalIndex: 0, start: new Date(2026, 2, 2, 12, 0), end: new Date(2026, 2, 2, 12, 30), volume: 3, category: 'General' });
  const slaD31: SLAPolicyConfig = {
    primaryPct: 80, primaryWindow: 2, primaryUnit: 'business_days' as any, boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90,
  };
  const N = 6;
  const des = runBackofficeDES({
    operationalHC: N, intervals: intervalsD31, openingWIP: [], categories: categoriesD31,
    calendar: calD31, labor: laborD31, sla: slaD31, seed: 42, shiftDistribution: distD31,
  });

  // Agents 0-2 = early cohort (offset 0, ends 17:00); agents 3-5 = late cohort (offset 300).
  const earlyCohort = [0, 1, 2];
  const lateCohort = [3, 4, 5];
  const shiftEndMs = new Date(2026, 2, 2, 17, 0, 0, 0).getTime();

  // A case whose FIRST assignment was to an early-cohort agent, but which completes AFTER
  // 17:00 — proof the work was interrupted and finished by someone else, not the same agent
  // overrunning their shift.
  let handoverCaseId: string | null = null;
  for (const c of des.caseResults || []) {
    const slicesForCase = (des.agentTimeline || []).filter((s) => s.caseId === c.caseId).sort((a, b) => a.from.getTime() - b.from.getTime());
    if (slicesForCase.length < 2) continue;
    const first = slicesForCase[0];
    const last = slicesForCase[slicesForCase.length - 1];
    if (earlyCohort.includes(first.agentId) && last.to.getTime() > shiftEndMs && first.agentId !== last.agentId) {
      handoverCaseId = c.caseId;
      break;
    }
  }
  assert(!!handoverCaseId, 'D31.1 at least one case started by the early cohort is finished by a DIFFERENT agent after 17:00 (a genuine handover occurred)', `caseResults=${(des.caseResults || []).length}`);

  if (handoverCaseId) {
    const slicesForCase = (des.agentTimeline || []).filter((s) => s.caseId === handoverCaseId).sort((a, b) => a.from.getTime() - b.from.getTime());
    const handoverToAgent = slicesForCase[slicesForCase.length - 1].agentId;
    assert(lateCohort.includes(handoverToAgent), 'D31.2 the handover recipient is a still-on-shift (late-cohort) agent, not the same agent resuming after their own shift', `handoverToAgent=${handoverToAgent + 1}`);

    // D31.3: completed SAME DAY (2026-03-02), never deferred to the next business day via
    // parkedWIP/CaseResume — the defining difference from DayClose park semantics.
    const caseResult = (des.caseResults || []).find((c) => c.caseId === handoverCaseId);
    const completedSameDay = !!caseResult?.completeTime && caseResult.completeTime.toDateString() === new Date(2026, 2, 2).toDateString();
    assert(completedSameDay, 'D31.3 the handed-over case completes the SAME business day, not deferred overnight', `completeTime=${caseResult?.completeTime}`);
  }
}

// =================================================================
// Suite D32 — Phase 3 (Stage 0): minimum-coverage floor, defaults, and parity
//
// The queue may never be left with zero agents while the business is running (G1). Default:
// minCoverageEnabled omitted -> ON at minAgentsPerInterval=1. Disabling either reproduces
// pre-2026-08-28 behavior exactly (D21-style parity — this must be a genuine no-op).
// =================================================================
console.log('\n--- Suite D32: Phase 3 — minimum-coverage floor (resolveMinAgentsPerInterval, DES tracking) ---');
{
  // D32.1-3: resolveMinAgentsPerInterval defaults and overrides.
  assert(resolveMinAgentsPerInterval({}, 10) === 1, 'D32.1 default (both fields omitted) resolves to 1', `got ${resolveMinAgentsPerInterval({}, 10)}`);
  assert(resolveMinAgentsPerInterval({ minCoverageEnabled: false }, 10) === 0, 'D32.2 minCoverageEnabled:false resolves to 0 (disabled)', `got ${resolveMinAgentsPerInterval({ minCoverageEnabled: false }, 10)}`);
  assert(resolveMinAgentsPerInterval({ minAgentsPerInterval: 0 }, 10) === 0, 'D32.3 minAgentsPerInterval:0 resolves to 0 even with the enabled flag omitted', `got ${resolveMinAgentsPerInterval({ minAgentsPerInterval: 0 }, 10)}`);
  assert(resolveMinAgentsPerInterval({ minAgentsPerInterval: 3 }, 10) === 3, 'D32.4 explicit value 3 is honored', `got ${resolveMinAgentsPerInterval({ minAgentsPerInterval: 3 }, 10)}`);
  assert(resolveMinAgentsPerInterval({ minAgentsPerInterval: 999 }, 10) === 10, 'D32.5 clamps to operationalHC', `got ${resolveMinAgentsPerInterval({ minAgentsPerInterval: 999 }, 10)}`);
  assert(resolveMinAgentsPerInterval({ minAgentsPerInterval: -5 }, 10) === 0, 'D32.6 clamps negative to 0', `got ${resolveMinAgentsPerInterval({ minAgentsPerInterval: -5 }, 10)}`);

  // D32.7-9: the scenario that started this whole investigation — 08:00-22:00 (14h), 9h
  // shift, all agents at offset 0 (uniform). Coverage MUST detect the collapse; it did not
  // exist as a concept before this phase.
  const calD32: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 22 };
  const laborD32: LaborConfig = { ...LABOR, dailyProductiveHours: 9 };
  const categoriesD32: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 }];
  const intervalsD32: StandardInterval[] = [];
  for (let day = 0; day < 2; day++) {
    for (let h = 8; h < 22; h++) {
      for (let m = 0; m < 60; m += 30) {
        intervalsD32.push({ intervalIndex: intervalsD32.length, start: new Date(2026, 2, 2 + day, h, m), end: new Date(2026, 2, 2 + day, h, m + 30), volume: 20, category: 'General' });
      }
    }
  }
  const slaD32: SLAPolicyConfig = {
    primaryPct: 80, primaryWindow: 4, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90,
  };
  const N = 16; // uniform: all at offset 0, 9h shift -> exhausted well before 22:00 close on this volume
  const desDefault = runBackofficeDES({ operationalHC: N, intervals: intervalsD32, openingWIP: [], categories: categoriesD32, calendar: calD32, labor: laborD32, sla: slaD32, seed: 42 });
  assert(desDefault.minCoverageObserved < 1, 'D32.7 uniform-start on a window wider than the shift genuinely collapses coverage to below 1 (default floor)', `minCoverageObserved=${desDefault.minCoverageObserved}`);
  assert(!desDefault.passesCoverage, 'D32.8 passesCoverage correctly reports false under the default floor', `passesCoverage=${desDefault.passesCoverage}`);
  assert(!desDefault.allPassed, 'D32.9 allPassed is false — coverage genuinely gates overall pass/fail now', `allPassed=${desDefault.allPassed}`);

  // D32.10-11: PARITY — disabling coverage (either way) reproduces pre-2026-08-28 behavior
  // exactly: passesCoverage always true, allPassed unaffected by coverage.
  const slaD32Off: SLAPolicyConfig = { ...slaD32, minCoverageEnabled: false };
  const desOff = runBackofficeDES({ operationalHC: N, intervals: intervalsD32, openingWIP: [], categories: categoriesD32, calendar: calD32, labor: laborD32, sla: slaD32Off, seed: 42 });
  assert(desOff.passesCoverage, 'D32.10 minCoverageEnabled:false -> passesCoverage always true regardless of actual coverage', `passesCoverage=${desOff.passesCoverage}, minCoverageObserved=${desOff.minCoverageObserved}`);
  assert(
    desOff.allPassed === (desOff.passesPrimarySLA && desOff.passesCategorySLA && desOff.passesBOASA && desOff.passesOccupancyCap),
    'D32.11 with coverage disabled, allPassed matches EXACTLY the pre-2026-08-28 four-flag formula (genuine no-op)',
    `allPassed=${desOff.allPassed}`
  );

  // D32.12: minCoverageObserved is still HONESTLY reported (0 here) even when disabled —
  // disabling the GATE must not corrupt the diagnostic.
  assert(desOff.minCoverageObserved === desDefault.minCoverageObserved, 'D32.12 minCoverageObserved is identical whether or not the gate is enabled (diagnostic unaffected by the toggle)', `off=${desOff.minCoverageObserved} default=${desDefault.minCoverageObserved}`);
}

// =================================================================
// Suite D33 — Phase 3 (Stage 0): coverage repair — redistribution before headcount
//
// The critical safety property for turning coverage ON by default: it must be satisfiable by
// REDISTRIBUTION at the SAME N, independent of shiftPlacementEnabled — otherwise every config
// with a window wider than the shift length would exhaust the search at userMaxHC the moment
// this floor went live. Proven earlier by measurement (32@08:00+1@13:00 costs 0pp of SLA on
// the user's real config); this suite pins the SEARCH actually finding and using that
// redistribution, without the user ever touching shiftPlacementEnabled.
// =================================================================
console.log('\n--- Suite D33: Phase 3 — coverage repair (redistribution before headcount, flag-independent) ---');
{
  const calD33: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 22 };
  const laborD33Off: LaborConfig = { ...LABOR, dailyProductiveHours: 9 }; // shiftPlacementEnabled OMITTED
  const categoriesD33: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 }];
  const intervalsD33: StandardInterval[] = [];
  for (let day = 0; day < 5; day++) {
    for (let h = 8; h < 22; h++) {
      for (let m = 0; m < 60; m += 30) {
        intervalsD33.push({ intervalIndex: intervalsD33.length, start: new Date(2026, 2, 2 + day, h, m), end: new Date(2026, 2, 2 + day, h, m + 30), volume: 20, category: 'General' });
      }
    }
  }
  const slaD33: SLAPolicyConfig = {
    primaryPct: 80, primaryWindow: 4, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90,
  };

  // D33.1-3: buildCoverageRepairDistribution unit behavior.
  const dist16 = buildCoverageRepairDistribution({ n: 16, calendar: calD33, labor: laborD33Off, minAgentsPerInterval: 1, queueArchitecture: 'pooled' });
  assert(dist16 !== null, 'D33.1 a repair distribution is found for N=16 on a 14h window / 9h shift', 'returned null');
  if (dist16) {
    const slaps = dist16.__POOLED__.slaps;
    const totalAgents = slaps.reduce((s, x) => s + x.agentCount, 0);
    assert(totalAgents === 16, 'D33.2 total agents in the repair distribution equals N (no agents fabricated or lost)', `total=${totalAgents}`);
    assert(slaps.length <= 2, 'D33.3 minimal redistribution: covers a 14h window with a 9h shift using exactly 2 start times (0 and one other)', `slaps=${JSON.stringify(slaps)}`);
  }
  const distTooSmall = buildCoverageRepairDistribution({ n: 1, calendar: calD33, labor: laborD33Off, minAgentsPerInterval: 1, queueArchitecture: 'pooled' });
  assert(distTooSmall === null, 'D33.4 returns null when N is too small to satisfy the floor (1 agent cannot be in two places)', `got ${JSON.stringify(distTooSmall)}`);

  // D33.5-8: THE critical integration proof — the full search, with shiftPlacementEnabled
  // OMITTED (undefined), still finds a coverage-compliant recommendation via the search's
  // unconditional coverage-repair path, at the SAME headcount uniform alone would need for
  // SLA (no headcount inflation from the coverage floor itself).
  const searchWithCoverage = searchOptimalHC({
    intervals: intervalsD33, openingWIP: [], categories: categoriesD33, calendar: calD33,
    labor: laborD33Off, sla: slaD33, seed: 42, userMaxHC: 60, replications: 5,
  });
  assert(searchWithCoverage.recommendedHC !== null, 'D33.5 the search finds a passing recommendation (does NOT exhaust to infeasible) with shiftPlacementEnabled OFF and coverage ON by default', `isInfeasible, recommendedHC=${searchWithCoverage.recommendedHC}`);

  const searchNoCoverage = searchOptimalHC({
    intervals: intervalsD33, openingWIP: [], categories: categoriesD33, calendar: calD33,
    labor: laborD33Off, sla: { ...slaD33, minCoverageEnabled: false }, seed: 42, userMaxHC: 60, replications: 5,
  });
  assert(searchNoCoverage.recommendedHC !== null, 'D33.6 setup: the same scenario passes SLA on uniform alone once coverage is disabled (isolates the coverage cost)', `recommendedHC=${searchNoCoverage.recommendedHC}`);
  assert(
    // Updated 2026-09-29 (C6): was 'costs ZERO extra headcount' (21 = 21). That equality relied on budget-as-presence:
    // uniform 9h shifts 'covered' a 14h window because agents with unused budget counted as present until close. Fixed
    // shifts cannot cover 14h from one start, so one seat moves to a late cohort and stops serving the morning peak:
    // coverage costs exactly one extra head here (22 vs 21).
    searchWithCoverage.recommendedHC === (searchNoCoverage.recommendedHC ?? -1) + 1,
    'D33.7 coverage costs exactly ONE extra head here (a 9h shift cannot cover a 14h window; one seat moves to a late cohort)',
    `withCoverage=${searchWithCoverage.recommendedHC} withoutCoverage=${searchNoCoverage.recommendedHC}`
  );

  // D33.8: the final audit run (a real single-seed DES at the recommended N, using whatever
  // distribution actually won) genuinely satisfies coverage — not just the statistical gate.
  assert(
    !!searchWithCoverage.finalDESResult?.passesCoverage,
    'D33.8 the final audit DES run at the recommended N genuinely satisfies coverage (not just the statistical gate)',
    `minCoverageObserved=${searchWithCoverage.finalDESResult?.minCoverageObserved}`
  );
}

// =================================================================
// Suite D34 — Phase 5: Gap A — N_sla can no longer bypass the walk-down safety net
//
// pickPlacementOrUniform (D25) only guards the PER-N placement-vs-uniform choice. But
// placementFeasibleFloor (N_sla) separately raised the search's STARTING N, and when that
// raised start immediately passed, the walk-down was skipped entirely — no
// pickPlacementOrUniform check runs in that path at all. Falsified during the 2026-08-28
// investigation via a 192-config sweep: 27 configs had N_sla > max(N_min, N_occ), and 2
// recommended a strictly HIGHER headcount with the flag on than off. This suite pins the
// exact falsifying config found (9-17 open, 7.5h shift, adherence=1.0, 2h SLA window,
// evening-heavy demand: nMin=13, nOcc=14, nSla=15, off recommended 14, on recommended 15).
// Fixed by removing placementFeasibleFloor from the startN max entirely — it remains
// reported in HCSearchOutput.shiftPlacement.placementFeasibleFloor as telemetry only, never
// as a gate. This restores the never-worse guarantee unconditionally, without depending on
// the analytic N_sla model being a valid bound on true DES attainment (which Gap B shows it
// is not, in the un-adhered-capacity direction).
// =================================================================
console.log('\n--- Suite D34: Phase 5 — Gap A, N_sla removed from startN (walk-down safety net restored) ---');
{
  const calD34: CalendarConfig = { workingDays: [1, 2, 3, 4, 5], dailyOpenHour: 9, dailyOpenMinute: 0, dailyCloseHour: 17, dailyCloseMinute: 0, holidays: [] };
  const laborD34: LaborConfig = {
    dailyProductiveHours: 7.5, adherencePct: 1.0, workingDaysPerWeek: 5, offDaysPerWeek: 2,
    contractualHoursSource: 'derived', shifts: [], shiftPlacementEnabled: true, shiftSlapMinutes: 30,
  };
  const categoriesD34: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 }];
  const intervalsD34: StandardInterval[] = [];
  for (let day = 0; day < 5; day++) {
    for (let h = 9; h < 17; h++) {
      const vol = h < 13 ? 8 : 30; // evening-heavy within this shorter window
      for (let m = 0; m < 60; m += 30) {
        intervalsD34.push({ intervalIndex: intervalsD34.length, start: new Date(2026, 2, 2 + day, h, m), end: new Date(2026, 2, 2 + day, h, m + 30), volume: vol, category: 'General' });
      }
    }
  }
  const slaD34: SLAPolicyConfig = {
    primaryPct: 80, primaryWindow: 2, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90, minCoverageEnabled: false,
  };

  const laborOff: LaborConfig = { ...laborD34, shiftPlacementEnabled: false };
  const searchOff = searchOptimalHC({ intervals: intervalsD34, openingWIP: [], categories: categoriesD34, calendar: calD34, labor: laborOff, sla: slaD34, seed: 42, userMaxHC: 40, replications: 5 });
  const searchOn = searchOptimalHC({ intervals: intervalsD34, openingWIP: [], categories: categoriesD34, calendar: calD34, labor: laborD34, sla: slaD34, seed: 42, userMaxHC: 40, replications: 5 });

  assert(
    (searchOn.shiftPlacement?.placementFeasibleFloor ?? 0) > Math.max(searchOn.nMinAnalytical, searchOn.occupancyFeasibleFloor ?? 0),
    'D34.1 setup: N_sla genuinely exceeds max(N_min, N_occ) on this config (the condition that used to bypass the walk-down)',
    `nMin=${searchOn.nMinAnalytical} nOcc=${searchOn.occupancyFeasibleFloor} nSla=${searchOn.shiftPlacement?.placementFeasibleFloor}`
  );
  assert(
    searchOn.recommendedHC === searchOff.recommendedHC,
    'D34.2 FIX VERIFIED: flag ON no longer recommends a higher headcount than flag OFF, even though N_sla exceeds both other floors',
    `off=${searchOff.recommendedHC} on=${searchOn.recommendedHC} (pre-fix this was off=14, on=15)`
  );
  assert(
    (searchOn.shiftPlacement?.placementFeasibleFloor ?? 0) > 0,
    'D34.3 N_sla is STILL reported as telemetry (not removed from output, only from the startN gate)',
    `placementFeasibleFloor=${searchOn.shiftPlacement?.placementFeasibleFloor}`
  );

  // D34.4: same proof for the async search entry point (D8/D11 sync/async drift hazard).
  const searchOnAsync = await searchOptimalHCAsync({ intervals: intervalsD34, openingWIP: [], categories: categoriesD34, calendar: calD34, labor: laborD34, sla: slaD34, seed: 42, userMaxHC: 40, replications: 5 });
  assert(
    searchOnAsync.recommendedHC === searchOff.recommendedHC,
    'D34.4 the SAME fix holds in searchOptimalHCAsync (the path the UI actually calls) — no sync/async drift on this fix',
    `off(sync)=${searchOff.recommendedHC} on(async)=${searchOnAsync.recommendedHC}`
  );
}

// =================================================================
// Suite D35 — Gap B: N_sla now uses ADHERED capacity, not raw shift span
//
// shiftCapacityWithinDay was fed un-adhered dailyProductiveHours×60 as agent capacity, while
// the DES budget applies adherence (dailyProductiveHours × adherence × 60) — a measured 25%
// over-credit at adherence 0.8. Closed-form pin (D7.10 pattern): business window sized to
// EXACTLY the shift length (a single valid start at offset 0, so N_sla reduces to pure
// capacity arithmetic with no placement-choice ambiguity), totalWork=1300min, target 80%.
// Correct (adhered 540×0.8=432min/agent): N×432 >= 0.8×1300=1040 -> N>=2.407 -> N_sla=3.
// Buggy (un-adhered 540min/agent): N×540 >= 1040 -> N>=1.926 -> N_sla=2 (would UNDERSTATE
// the requirement by one agent).
// =================================================================
console.log('\n--- Suite D35: Gap B — N_sla uses adhered capacity (closed-form pin) ---');
{
  const calD35: CalendarConfig = { workingDays: [1, 2, 3, 4, 5], dailyOpenHour: 8, dailyOpenMinute: 0, dailyCloseHour: 17, dailyCloseMinute: 0, holidays: [] };
  const laborD35: LaborConfig = {
    dailyProductiveHours: 9, adherencePct: 0.8, workingDaysPerWeek: 5, offDaysPerWeek: 2,
    contractualHoursSource: 'derived', shifts: [], shiftPlacementEnabled: true, shiftSlapMinutes: 30,
  };
  const validStartsD35 = getValidSlapStarts(calD35, laborD35.dailyProductiveHours * 60, 30);
  assert(validStartsD35.length === 1 && validStartsD35[0] === 0, 'D35.1 setup: window sized to exactly the shift length has exactly one valid start (offset 0) — isolates capacity math from placement choice', `validStarts=${JSON.stringify(validStartsD35)}`);

  const day0Open = new Date(2026, 2, 2, 8, 0, 0, 0);
  const day0Close = new Date(2026, 2, 2, 17, 0, 0, 0);
  const casesD35 = [{ clockStart: day0Open, primaryDeadline: day0Close, remainingWorkMinutes: 1300 }];
  const gridD35 = buildOneDayDemandGrid(casesD35, calD35, 30);
  assert(Math.abs(gridD35.totalWorkMinutes - 1300) < 1e-6, 'D35.2 setup: demand grid captures the full 1300min in one bucket', `totalWorkMinutes=${gridD35.totalWorkMinutes}`);

  const nSlaCorrect = findPlacementFeasibleFloor({ grid: gridD35, validStarts: validStartsD35, shiftLengthMinutes: 540 * 0.8, slapMinutes: 30, targetPct: 80, maxN: 20 });
  assert(nSlaCorrect === 3, 'D35.3 CLOSED FORM: findPlacementFeasibleFloor with adhered capacity (432min) returns N_sla=3', `got ${nSlaCorrect}`);
  const nSlaBuggy = findPlacementFeasibleFloor({ grid: gridD35, validStarts: validStartsD35, shiftLengthMinutes: 540, slapMinutes: 30, targetPct: 80, maxN: 20 });
  assert(nSlaBuggy === 2, 'D35.4 CONTROL: the same math with UN-ADHERED capacity (540min) would have understated it as N_sla=2 — confirms this is a real, discriminating scenario', `got ${nSlaBuggy}`);

  // D35.5-6: the PRODUCTION path (searchOptimalHC's internal N_sla computation) now reports
  // the CORRECT (adherence-aware) value, not the buggy one — proves the fix is actually wired
  // in, not just correct in the standalone function.
  const categoriesD35: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 20, shrinkagePct: 0, priority: 1 }];
  const intervalsD35: StandardInterval[] = [{ intervalIndex: 0, start: day0Open, end: new Date(day0Open.getTime() + 30 * 60000), volume: Math.round(1300 / 20), category: 'General' }];
  const slaD35: SLAPolicyConfig = {
    primaryPct: 80, primaryWindow: 6, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90, minCoverageEnabled: false,
  };
  const searchD35 = searchOptimalHC({ intervals: intervalsD35, openingWIP: [], categories: categoriesD35, calendar: calD35, labor: laborD35, sla: slaD35, seed: 42, userMaxHC: 20, replications: 3 });
  assert(searchD35.shiftPlacement?.placementFeasibleFloor !== 2, 'D35.5 the production search no longer reports the buggy under-adhered N_sla=2 for this scenario', `placementFeasibleFloor=${searchD35.shiftPlacement?.placementFeasibleFloor}`);
}

// =================================================================
// Suite D36 — 24/7 coverage regression: the floor must not inflate headcount there
//
// Phase 3's default-on coverage floor is enforced for 24x7 calendars (isWorking() never
// skips a sample there) but BOTH repair levers are unconditionally disabled for 24x7
// (buildCoverageRepairDistribution returns null; placement is gated on !calendar.is24x7).
// Under load heavy enough that every agent exhausts their daily budget simultaneously,
// coverage genuinely collapses to 0 with no lever to fix it except adding heads — turning a
// scheduling constraint into a capacity constraint and inflating the recommendation, exactly
// what G1/G4 forbid. Fixed by making the coverage GATE (not the diagnostic) unconditionally
// pass for is24x7 until Step 2 gives 24/7 a real repair lever.
// =================================================================
console.log('\n--- Suite D36: 24/7 coverage gate must not inflate headcount (no repair lever exists there) ---');
{
  const laborD36: LaborConfig = {
    dailyProductiveHours: 8, adherencePct: 1.0, workingDaysPerWeek: 7, offDaysPerWeek: 0,
    contractualHoursSource: 'derived', shifts: [],
  };
  const categoriesD36: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 20, shrinkagePct: 0, priority: 1 }];
  const intervalsD36: StandardInterval[] = [];
  // A burst concentrated in hours 0-10 of day 1 ONLY, across a 5-day horizon (the rest of
  // the horizon carries a token zero-volume interval just to establish its length). This
  // deliberately decouples coverage from occupancy: occupancy averages over the WHOLE
  // horizon (denominator scaled by all 5 days), so it stays comfortably low even though
  // agents fully exhaust their daily budget during the burst — leaving a genuine, large
  // same-day coverage gap for the rest of day 1 that SLA (4-day window) never penalizes,
  // since the multi-day window tolerates same-day completion timing.
  for (let h = 0; h < 10; h++) {
    for (let m = 0; m < 60; m += 30) {
      intervalsD36.push({ intervalIndex: intervalsD36.length, start: new Date(2026, 2, 2, h, m), end: new Date(2026, 2, 2, h, m + 30), volume: 13, category: 'General' });
    }
  }
  intervalsD36.push({ intervalIndex: intervalsD36.length, start: new Date(2026, 2, 6, 23, 30), end: new Date(2026, 2, 6, 23, 59), volume: 0, category: 'General' });
  const slaD36Base: SLAPolicyConfig = {
    primaryPct: 80, primaryWindow: 4, primaryUnit: 'days', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90,
  };

  const searchCoverageOn = searchOptimalHC({ intervals: intervalsD36, openingWIP: [], categories: categoriesD36, calendar: CAL_24X7, labor: laborD36, sla: { ...slaD36Base, minCoverageEnabled: true, minAgentsPerInterval: 1 }, seed: 42, userMaxHC: 60, replications: 5 });
  const searchCoverageOff = searchOptimalHC({ intervals: intervalsD36, openingWIP: [], categories: categoriesD36, calendar: CAL_24X7, labor: laborD36, sla: { ...slaD36Base, minCoverageEnabled: false }, seed: 42, userMaxHC: 60, replications: 5 });

  assert(!searchCoverageOff.isInfeasible && searchCoverageOff.recommendedHC !== null, 'D36.1 setup: with coverage OFF, the scenario finds a passing recommendation on 24x7 (isolates the coverage cost)', `isInfeasible=${searchCoverageOff.isInfeasible} recommendedHC=${searchCoverageOff.recommendedHC}`);
  // D36.1b: confirms this genuinely isolates coverage from occupancy/SLA (both already
  // comfortable at the un-inflated N) — without this, D36.2 could pass by coincidence the
  // way an earlier, uncalibrated version of this scenario did (occupancy happened to bind
  // at the same N as coverage there, masking the regression).
  // Note: query the diagnostic with the gate ENABLED here (minCoverageObserved/passesCoverage
  // are computed identically regardless of minCoverageEnabled — only the GATE respects the
  // toggle, per D32.12) so this assertion reflects genuine coverage, not the disabled gate.
  const auditOff = runBackofficeDES({ operationalHC: searchCoverageOff.recommendedHC!, intervals: intervalsD36, openingWIP: [], categories: categoriesD36, calendar: CAL_24X7, labor: laborD36, sla: { ...slaD36Base, minCoverageEnabled: true, minAgentsPerInterval: 1 }, seed: 42 });
  assert(auditOff.passesPrimarySLA && auditOff.passesOccupancyCap && auditOff.minCoverageObserved < 1, 'D36.1b setup: at the coverage-off recommendation, SLA and occupancy already pass comfortably while coverage genuinely fails — isolates coverage as the sole would-be driver', `passesPrimarySLA=${auditOff.passesPrimarySLA} passesOccupancyCap=${auditOff.passesOccupancyCap} minCoverageObserved=${auditOff.minCoverageObserved}`);
  assert(
    searchCoverageOn.recommendedHC === searchCoverageOff.recommendedHC,
    'D36.2 FIX VERIFIED: the coverage floor does not inflate headcount on 24x7 (no repair lever exists there, so the gate must not bind)',
    `coverageOn=${searchCoverageOn.recommendedHC} coverageOff=${searchCoverageOff.recommendedHC} (pre-fix this inflated from 3 to 11 on this exact scenario)`
  );
  assert(!searchCoverageOn.isInfeasible, 'D36.3 the search does not report isInfeasible purely from the coverage gate on 24x7', `isInfeasible=${searchCoverageOn.isInfeasible} reason=${searchCoverageOn.infeasibleReason}`);

  // D36.5: same fix holds in the async entry point — both share computeStatisticalEvaluation,
  // so no D8/D11-style drift risk, but pin it directly rather than assume.
  const searchCoverageOnAsync = await searchOptimalHCAsync({ intervals: intervalsD36, openingWIP: [], categories: categoriesD36, calendar: CAL_24X7, labor: laborD36, sla: { ...slaD36Base, minCoverageEnabled: true, minAgentsPerInterval: 1 }, seed: 42, userMaxHC: 60, replications: 5 });
  assert(searchCoverageOnAsync.recommendedHC === searchCoverageOff.recommendedHC, 'D36.5 the same fix holds in searchOptimalHCAsync', `sync-off=${searchCoverageOff.recommendedHC} async-on=${searchCoverageOnAsync.recommendedHC}`);

  // D36.4: CONTROL — the guard must be 24/7-specific, not a blanket disable. A non-24x7
  // config where coverage genuinely binds (the D32.7-style scenario) must still show the
  // gate is active there.
  const calD36Control: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 22 };
  const laborD36Control: LaborConfig = { ...LABOR, dailyProductiveHours: 9 };
  const intervalsD36Control: StandardInterval[] = [];
  for (let day = 0; day < 2; day++) {
    for (let h = 8; h < 22; h++) {
      for (let m = 0; m < 60; m += 30) {
        intervalsD36Control.push({ intervalIndex: intervalsD36Control.length, start: new Date(2026, 2, 2 + day, h, m), end: new Date(2026, 2, 2 + day, h, m + 30), volume: 20, category: 'General' });
      }
    }
  }
  const desControl = runBackofficeDES({ operationalHC: 16, intervals: intervalsD36Control, openingWIP: [], categories: categoriesD36, calendar: calD36Control, labor: laborD36Control, sla: { ...slaD36Base, primaryUnit: 'hours', primaryWindow: 4, minCoverageEnabled: true, minAgentsPerInterval: 1 }, seed: 42 });
  assert(!desControl.passesCoverage, 'D36.4 CONTROL: the guard is 24/7-specific — a non-24x7 config where coverage genuinely fails still correctly reports passesCoverage=false', `passesCoverage=${desControl.passesCoverage} minCoverageObserved=${desControl.minCoverageObserved}`);
}

// =================================================================
// Suite D37 — 24/7 multi-start: real staggering, shift-end, and coverage repair
//
// D36 proved the coverage GATE no longer inflates 24x7 headcount. This suite proves the
// actual REPAIR mechanism works for 24x7 — real shift starts tiling the day, agents genuinely
// going off at their own shift end (not just present forever), and coverage satisfiable by
// redistribution at a real, small N rather than defaulting to "no lever, don't bind" forever.
// =================================================================
console.log('\n--- Suite D37: 24x7 multi-start (real staggering, shift-end, coverage repair) ---');
{
  // D37.1-2: getValidSlapStarts now tiles the 1440-min day for 24x7 instead of returning [0].
  const starts8h = getValidSlapStarts(CAL_24X7, 8 * 60, 480);
  assert(starts8h.length === 3 && starts8h[0] === 0 && starts8h[2] === 960, 'D37.1 an 8h shift on a 480min grid gives exactly 3 tiling starts (0, 480, 960) covering the full 24h day', `got ${JSON.stringify(starts8h)}`);

  // D37.2: a staggered 24x7 agent genuinely goes OFF at their own shift end (bounded
  // presence), not available indefinitely — the same property D30.3 pins for non-24x7.
  const laborD37: LaborConfig = { dailyProductiveHours: 8, adherencePct: 1.0, workingDaysPerWeek: 7, offDaysPerWeek: 0, contractualHoursSource: 'derived', shifts: [], shiftPlacementEnabled: true, shiftSlapMinutes: 480 };
  const categoriesD37: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 20, shrinkagePct: 0, priority: 1 }];
  const distD37: ShiftDistributionByCategory = { __POOLED__: { slapMinutes: 480, slaps: [{ startMinutesFromOpen: 0, agentCount: 1 }, { startMinutesFromOpen: 480, agentCount: 1 }, { startMinutesFromOpen: 960, agentCount: 1 }] } };
  const lightIntervals: StandardInterval[] = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 30) {
      lightIntervals.push({ intervalIndex: lightIntervals.length, start: new Date(2026, 2, 2, h, m), end: new Date(2026, 2, 2, h, m + 30), volume: 1, category: 'General' });
    }
  }
  const slaD37: SLAPolicyConfig = { primaryPct: 80, primaryWindow: 6, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes', asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open', occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90 };
  const desD37 = runBackofficeDES({ operationalHC: 3, intervals: lightIntervals, openingWIP: [], categories: categoriesD37, calendar: CAL_24X7, labor: laborD37, sla: slaD37, seed: 42, shiftDistribution: distD37 });
  // Agent 0 (offset 0, 8h shift) should have NO non-off slice at/after 8h from their day's
  // local midnight — mirrors D30.3's assertion for non-24x7.
  const agent0Slices = (desD37.agentTimeline || []).filter((s) => s.agentId === 0 && s.state !== 'off');
  const dayOpenD37 = new Date(2026, 2, 2, 0, 0, 0, 0);
  const overrun = agent0Slices.find((s) => {
    const sliceDayOpen = new Date(s.from); sliceDayOpen.setHours(0, 0, 0, 0);
    return (s.from.getTime() - sliceDayOpen.getTime()) / 60000 >= 480 - 1e-6;
  });
  assert(!overrun, 'D37.2 a staggered 24x7 agent (offset 0) has no non-off slice at/after their own 8h shift end — presence is bounded, not indefinite', overrun ? `found: ${JSON.stringify(overrun)}` : '');

  // D37.3: verifyAgentTimelineInvariants (incl. the daily-budget check T3-1 also relies on)
  // still holds under staggered 24x7 — no agent-day exceeds its budget.
  const invariantsD37 = verifyAgentTimelineInvariants(desD37, laborD37, CAL_24X7);
  assert(invariantsD37.valid, 'D37.3 verifyAgentTimelineInvariants passes on a staggered 24x7 run (daily-budget check included)', JSON.stringify(invariantsD37.errors));

  // D37.4-5: coverage IS now satisfiable by redistribution at a real, small N for 24x7 — not
  // just "gate disabled forever". Reuses D36's burst scenario: uniform mode needed N=11 for
  // coverage to accidentally pass (budget slack); real staggering should find a much smaller
  // genuinely-covering N.
  const burstIntervals: StandardInterval[] = [];
  for (let h = 0; h < 10; h++) {
    for (let m = 0; m < 60; m += 30) {
      burstIntervals.push({ intervalIndex: burstIntervals.length, start: new Date(2026, 2, 2, h, m), end: new Date(2026, 2, 2, h, m + 30), volume: 13, category: 'General' });
    }
  }
  burstIntervals.push({ intervalIndex: burstIntervals.length, start: new Date(2026, 2, 6, 23, 30), end: new Date(2026, 2, 6, 23, 59), volume: 0, category: 'General' });
  const slaD37b: SLAPolicyConfig = { primaryPct: 80, primaryWindow: 4, primaryUnit: 'days', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes', asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open', occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90, minCoverageEnabled: true, minAgentsPerInterval: 1 };
  const laborD37b: LaborConfig = { dailyProductiveHours: 8, adherencePct: 1.0, workingDaysPerWeek: 7, offDaysPerWeek: 0, contractualHoursSource: 'derived', shifts: [] };
  const searchD37 = searchOptimalHC({ intervals: burstIntervals, openingWIP: [], categories: categoriesD37, calendar: CAL_24X7, labor: laborD37b, sla: slaD37b, seed: 42, userMaxHC: 60, replications: 5 });
  assert(searchD37.recommendedHC !== null && searchD37.recommendedHC <= 8, 'D37.4 coverage is satisfiable by redistribution at a small N for 24x7 (well below the old buggy N=11 budget-slack artifact)', `recommendedHC=${searchD37.recommendedHC}`);
  assert(!!searchD37.finalDESResult?.passesCoverage, 'D37.5 the final audit run at the recommended N genuinely satisfies coverage for 24x7', `minCoverageObserved=${searchD37.finalDESResult?.minCoverageObserved}`);
}

// =================================================================
// Suite D38 — Step 4: "Exact minimum" is an unwarranted claim, reworded
//
// DES pass/fail monotonicity in N is an open, undischarged assumption (project_context.md;
// see the Gap G re-measurement in docs/wfm/07-known-defects-and-decisions.md). The walk-down
// search only ever verifies that N passed and N-1 failed — it never proves N is the exact
// minimum. searchOptimalHCAsync's progress messaging claimed "Exact minimum" anyway.
//
// This is a SOURCE-TEXT check, not a runtime/onProgress check, by design: the post-walk-down
// re-evaluate call that builds this message always lands on operationalHC values already
// cached earlier in the same walk-down loop (evaluateAsync's `evalCache` short-circuits before
// emitting onProgress on a cache hit), so the message can never actually fire through
// onProgress in practice — it is presentation-only dead code. Since the plan's actual target
// is the string literal itself (not an observable runtime message), the honest and reliable
// pin is to read the literal source and assert on it directly.
// =================================================================
console.log('\n--- Suite D38: Step 4 — "Exact minimum" reworded to "Lowest verified-passing" ---');
{
  const hcSearchSrc = readFileSync(join(resolve(import.meta.dirname, '..'), 'src', 'utils', 'hc-search.ts'), 'utf-8');
  assert(!/Exact minimum/i.test(hcSearchSrc), 'D38.1 FIX VERIFIED: hc-search.ts no longer contains the unwarranted "Exact minimum" claim (monotonicity in N is undischarged — only a verified-passing N is warranted)', 'string "Exact minimum" still present');
  assert(/Lowest verified-passing N=/.test(hcSearchSrc), 'D38.2 the reworded message states exactly what was verified: lowest verified-passing N found, N-1 failed the gate', 'string "Lowest verified-passing N=" not found');
  assert(/failed the gate/.test(hcSearchSrc) && /reached the search floor/.test(hcSearchSrc), 'D38.3 walk-down message says "N-1 failed the gate" only when a failure stopped the walk, and "reached the search floor" when it ended at floorN', 'missing "failed the gate" or "reached the search floor" wording');
  assert(/Start N=\$\{startN\} passed; refining down/.test(hcSearchSrc), 'D38.4 floor-OFF walk-down (started from a passing startN, no leap ran) says "Start N=... passed; refining down"', 'string "Start N=${startN} passed; refining down" not found');
  assert(/walkStartedFromStartN \? '' : ` Leap \$\{ceilingHigh\} discarded\.`/.test(hcSearchSrc), 'D38.5 "Leap ... discarded" is only emitted when a leap actually ran', 'unconditional "Leap ... discarded" text');
}

// =================================================================
// Suite D39 — Step 5: empirical monotonicity sweep for the uniform-only predicate
//
// No prior test checked that DES pass/fail is actually monotone in N — only that specific
// OUTPUTS (placement distribution, apportionment shares) grow monotonically with N. This
// sweeps the uniform-start predicate (evaluateCandidateStatistical's passesAllConstraints,
// no shiftDistribution — exactly evaluateN's first disjunct) across a representative range
// of N on a plain business-hours config, same idea as D3.1's apportionment sweep applied to
// pass/fail instead of a numeric output. The full 3-way disjunction is NOT swept here per the
// remediation plan's decision rule: that would need evaluateN/evaluateAsync's per-N logic
// extracted into a shared function, which is reserved for if/when a multi-attempt search is
// actually built (Gap G re-measurement found no benefit — see docs/wfm/07 — so the extraction
// is not done here; a wider or full-disjunction sweep remains open future work).
// =================================================================
console.log('\n--- Suite D39: Step 5 — empirical monotonicity sweep (uniform predicate, D38/N range) ---');
{
  const calD39: CalendarConfig = { ...BIZ_CAL };
  const laborD39: LaborConfig = { ...LABOR };
  const categoriesD39: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 }];
  const intervalsD39: StandardInterval[] = [];
  for (let day = 0; day < 5; day++) {
    for (let h = 9; h < 17; h++) {
      for (let m = 0; m < 60; m += 30) {
        intervalsD39.push({ intervalIndex: intervalsD39.length, start: new Date(2026, 2, 2 + day, h, m), end: new Date(2026, 2, 2 + day, h, m + 30), volume: 12, category: 'General' });
      }
    }
  }
  const slaD39: SLAPolicyConfig = {
    primaryPct: 80, primaryWindow: 4, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90, minCoverageEnabled: false,
  };

  const passResults: { n: number; passed: boolean }[] = [];
  for (let n = 1; n <= 25; n++) {
    const res = evaluateCandidateStatistical({
      operationalHC: n, intervals: intervalsD39, openingWIP: [], categories: categoriesD39,
      calendar: calD39, labor: laborD39, sla: slaD39, baseSeed: 42, replications: 10,
    });
    passResults.push({ n, passed: res.passesAllConstraints });
  }

  const somePass = passResults.some((r) => r.passed);
  const someFail = passResults.some((r) => !r.passed);
  assert(somePass && someFail, 'D39.1 setup: the swept N range spans both a failing and a passing N (a degenerate all-pass or all-fail range would prove nothing about monotonicity)', `results=${JSON.stringify(passResults)}`);

  const holes: string[] = [];
  for (let i = 0; i < passResults.length - 1; i++) {
    if (passResults[i].passed && !passResults[i + 1].passed) {
      holes.push(`N=${passResults[i].n} passed but N=${passResults[i + 1].n} failed`);
    }
  }
  assert(
    holes.length === 0,
    'D39.2 no monotonicity violation found for the uniform predicate across N=1..25 on this config (consistent with, not proof of, the walk-down search\'s resting assumption)',
    holes.length > 0 ? `HOLES FOUND (report, do not silently patch): ${holes.join('; ')}` : 'no holes'
  );
}

// =================================================================
// Suite D40 — OFF% coverage-ratio fix: seats-to-roster is O/coverageDays, not (1+extraOff/7)
//
// D10 pinned extraOffDays and offPct (the display fraction). It never exercised a
// non-zero extraOffDays against the multiplier actually applied to seats, so the /7
// (calendar-week) denominator shipped for years instead of the correct /coverageDays
// (open-week) denominator. Agents only supply capacity on open days, so:
//   roster = seats * openDaysPerWeek / coverageDays,  coverageDays = openDaysPerWeek - extraOffDays
// This suite is the ground truth that was missing. It also pins the integer-exact
// computation path: floor(N * openDays / coverageDays), never floor(N * (1 + fractionalUplift)),
// because the latter loses a seat to float error in real configs.
// =================================================================
console.log('\n--- Suite D40: OFF% coverage-ratio fix (seats-to-roster, not calendar-week /7) ---');
{
  const cats: CategoryConfig[] = [
    { id: 'c1', name: 'Billing', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1 },
  ];
  const horizonStart = new Date(2026, 9, 5, 9, 0);
  const horizonEnd = new Date(2026, 9, 9, 17, 0);
  const intervals: StandardInterval[] = [
    { intervalIndex: 0, start: new Date(2026, 9, 5, 9, 0), end: new Date(2026, 9, 5, 9, 30), category: 'Billing', volume: 200 },
  ];

  function calWithOpenDays(openDays: number): CalendarConfig {
    // First `openDays` weekdays 0..6 (Sun..Sat), not24x7.
    return { ...BIZ_CAL, workingDays: Array.from({ length: openDays }, (_, i) => i) };
  }

  function laborWithOff(offDays: number): LaborConfig {
    return { ...LABOR, workingDaysPerWeek: 7 - offDays, offDaysPerWeek: offDays };
  }

  function stFor(openDays: number, offDays: number, operationalHC: number) {
    return calculateStaffingRequirement({
      operationalHC, categories: cats, intervals, openingWIP: [],
      calendar: calWithOpenDays(openDays), labor: laborWithOff(offDays),
      horizonStart, horizonEnd, bindingConstraint: 'test',
    });
  }

  // --- D40.1: full (O,L) table at N=100 — closed form vs current code ---
  // [openDays, laborOff, expectedExtraOff, expectedCoverageDays, expectedRosterUpliftPct, expectedNetOpAt100]
  const table: Array<[number, number, number, number, number, number]> = [
    [5, 2, 0, 5, 0, 100],          // default: no extra off, unchanged
    [6, 2, 1, 5, 0.2, 120],        // canonical PRD example
    [7, 2, 2, 5, 0.4, 140],        // 24x7 + standard 5-day agents
    [6, 3, 2, 4, 0.5, 150],
    [7, 3, 3, 4, 0.75, 175],
    [5, 5, 3, 2, 1.5, 250],
    [7, 1, 1, 6, 1 / 6, 116],      // floor(100*7/6)=116.666..->116
  ];
  for (const [O, L, expExtra, expCoverage, expUplift, expNet] of table) {
    const st = stFor(O, L, 100);
    assert(st.extraOffDays === expExtra, `D40.1 O=${O} L=${L}: extraOffDays === ${expExtra}`, `got ${st.extraOffDays}`);
    assert(st.coverageDays === expCoverage, `D40.1 O=${O} L=${L}: coverageDays === ${expCoverage}`, `got ${st.coverageDays}`);
    assert(approx(st.rosterUpliftPct, expUplift, 1e-3), `D40.1 O=${O} L=${L}: rosterUpliftPct === ${expUplift}`, `got ${st.rosterUpliftPct}`);
    assert(st.operationalHCWithOff === expNet, `D40.1 O=${O} L=${L}: operationalHCWithOff === ${expNet}`, `got ${st.operationalHCWithOff}`);
    // Must NOT match the old (1 + extraOff/7) formula whenever extraOff > 0.
    const oldFormulaNet = Math.floor(100 * (1 + expExtra / 7));
    if (expExtra > 0) {
      assert(st.operationalHCWithOff !== oldFormulaNet, `D40.1 O=${O} L=${L}: must NOT reproduce old /7 formula (${oldFormulaNet})`, `got ${st.operationalHCWithOff}`);
    }
  }

  // --- D40.2: float-exactness — floor(N*(1+uplift)) loses a seat; floor(N*O/coverage) doesn't ---
  {
    // O=7, L=2 -> coverageDays=5, uplift=0.4 exactly in decimal but NOT exactly in binary float.
    const st = stFor(7, 2, 45);
    const buggyFloatForm = Math.floor(45 * (1 + 0.4)); // = 62 (float error), true value is 63
    assert(st.operationalHCWithOff === 63, 'D40.2a O=7,L=2,N=45: floor(45*7/5) === 63 (integer-exact)', `got ${st.operationalHCWithOff}`);
    assert(buggyFloatForm === 62, 'D40.2a control: confirms floor(N*(1+0.4)) really does lose a seat at N=45 (documents the hazard, not the fix)', `got ${buggyFloatForm}`);
  }
  {
    // O=5, L=4: calendarClosed=2, extraOff=max(0,4-2)=2, coverageDays=5-2=3, roster=7*5/3=35/3
    const st = stFor(5, 4, 7);
    assert(st.coverageDays === 3, 'D40.2b O=5,L=4: coverageDays === 3', `got ${st.coverageDays}`);
    assert(st.operationalHCWithOff === 11, 'D40.2b floor(7*5/3) === 11 (integer-exact)', `got ${st.operationalHCWithOff}`);
  }

  // --- D40.3: rosterInfeasible guard — labor off days meeting/exceeding open days ---
  {
    // O=5 (BIZ_CAL-style), L=7 (reachable via unvalidated JSON import, App.tsx handleImportParams).
    const st = stFor(5, 7, 100);
    assert(st.rosterInfeasible === true, 'D40.3 O=5,L=7: rosterInfeasible === true (coverageDays <= 0)', `coverageDays=${st.coverageDays}`);
    assert(st.operationalHCWithOff === 100, 'D40.3 infeasible: Net Op left un-adjusted (= operationalHC), not silently 1x-multiplied away', `got ${st.operationalHCWithOff}`);
    assert(st.bindingConstraint.includes('ROSTER INFEASIBLE'), 'D40.3 infeasibility surfaced in bindingConstraint, not swallowed', `got "${st.bindingConstraint}"`);
  }

  // --- D40.4: control — the untouched default config must still read exactly as before ---
  {
    const st = stFor(5, 2, 100);
    assert(st.extraOffDays === 0 && st.rosterUpliftPct === 0 && st.operationalHCWithOff === 100,
      'D40.4 control: default 5-open+5-labor unaffected by the fix', `got extra=${st.extraOffDays} uplift=${st.rosterUpliftPct} net=${st.operationalHCWithOff}`);
  }

  // --- D40.5: direct unit coverage of computeExtraOffPct's new return shape ---
  {
    const r = computeExtraOffPct(laborWithOff(2), calWithOpenDays(6));
    assert(r.openDaysPerWeek === 6, 'D40.5 computeExtraOffPct returns openDaysPerWeek === 6', `got ${r.openDaysPerWeek}`);
    assert(r.coverageDays === 5, 'D40.5 computeExtraOffPct returns coverageDays === 5', `got ${r.coverageDays}`);
    assert(approx(r.rosterUpliftPct, 0.2, 1e-9), 'D40.5 computeExtraOffPct returns rosterUpliftPct === 0.2', `got ${r.rosterUpliftPct}`);
    assert(r.rosterInfeasible === false, 'D40.5 computeExtraOffPct returns rosterInfeasible === false');
  }

  // --- D40.6: harmonic effective shrinkage stays OFF-independent at a non-zero uplift ---
  {
    const harm: CategoryConfig[] = [
      { id: 'c1', name: 'Billing', ahtMinutes: 30, shrinkagePct: 0.1, priority: 1 },
      { id: 'c2', name: 'Claims', ahtMinutes: 30, shrinkagePct: 0.3, priority: 1 },
    ];
    const mixed: StandardInterval[] = [
      { intervalIndex: 0, start: new Date(2026, 9, 5, 9, 0), end: new Date(2026, 9, 5, 9, 30), category: 'Billing', volume: 100 },
      { intervalIndex: 1, start: new Date(2026, 9, 6, 9, 0), end: new Date(2026, 9, 6, 9, 30), category: 'Claims', volume: 100 },
    ];
    const st = calculateStaffingRequirement({
      operationalHC: 100, categories: harm, intervals: mixed, openingWIP: [],
      calendar: calWithOpenDays(7), labor: laborWithOff(3), // uplift = 0.75, well away from 0
      horizonStart, horizonEnd, bindingConstraint: 'test',
    });
    const expected = 1 - 1 / (0.5 / 0.9 + 0.5 / 0.7);
    assert(
      approx(st.effectiveShrinkagePct, Math.round(expected * 1000) / 1000, 1e-3),
      'D40.6 effectiveShrinkagePct unchanged by non-zero rosterUpliftPct (not mixed in)',
      `got ${st.effectiveShrinkagePct}`
    );
  }
}

// =================================================================
// Suite D41 — Non-blocking DQ warnings for the "fewer uploaded days" hazards
//
// Three severity:'warning' DQIssue additions to validateDataQuality: (A) labor off days
// is 0 on a non-24/7 calendar (the residue of toggling 24/7 back off, or an unrealistic
// roster), (B) Manual Hours Override far out of scale with the uploaded horizon length
// (collapses the N_min floor), (C) calendar-open days inside the horizon with zero
// uploaded rows (counted as fully-staffed anyway, understating occupancy). All three
// must NEVER flip dqResult.passed or change any computed number — only DQIssue.issues.
// =================================================================
console.log('\n--- Suite D41: Non-blocking DQ warnings (off days, override scale, coverage gap) ---');
{
  const calD41: CalendarConfig = { ...BIZ_CAL };
  const catsD41: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 30, shrinkagePct: 0.1, priority: 1 }];
  const mappingD41 = { intervalStartCol: 'Date', volumeCol: 'Volume', categoryCol: 'Category' };
  const slaD41: SLAPolicyConfig = {
    primaryPct: 80, primaryWindow: 4, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90, minCoverageEnabled: false,
  };
  // One valid interval on Monday (a BIZ_CAL working day) — used as the base fixture across cases.
  const mondayInterval: StandardInterval = {
    intervalIndex: 0, start: new Date(2026, 9, 5, 9, 0), end: new Date(2026, 9, 5, 9, 30), category: 'General', volume: 20,
  };

  function dqFor(labor: LaborConfig, calendar: CalendarConfig, intervals: StandardInterval[]) {
    return validateDataQuality({ intervals, mapping: mappingD41, categories: catsD41, calendar, labor, sla: slaD41, openingWIP: [] });
  }

  // --- Warning A: labor off days = 0, non-24x7 calendar ---
  {
    const laborZeroOff: LaborConfig = { ...LABOR, workingDaysPerWeek: 7, offDaysPerWeek: 0 };
    const dq = dqFor(laborZeroOff, calD41, [mondayInterval]);
    const offWarn = dq.issues.find((i) => i.field === 'Labor Off Days');
    assert(!!offWarn && offWarn.severity === 'warning', 'D41.A1 zero off days on non-24x7 calendar raises a warning', `issues=${JSON.stringify(dq.issues.map((i) => i.field))}`);
    assert(dq.passed === true, 'D41.A2 warning A does not flip dqResult.passed', `passed=${dq.passed}`);
  }
  // Control: normal off days -> no warning A.
  {
    const dq = dqFor(LABOR, calD41, [mondayInterval]);
    assert(!dq.issues.some((i) => i.field === 'Labor Off Days'), 'D41.A3 control: normal offDaysPerWeek=2 raises no warning A');
  }
  // Control: zero off days is fine (no warning) when the calendar genuinely is 24x7.
  {
    const laborZeroOff: LaborConfig = { ...LABOR, workingDaysPerWeek: 7, offDaysPerWeek: 0 };
    const dq = dqFor(laborZeroOff, CAL_24X7, [mondayInterval]);
    assert(!dq.issues.some((i) => i.field === 'Labor Off Days'), 'D41.A4 control: zero off days on a genuine 24x7 calendar raises no warning A');
  }

  // --- Warning B: Manual Hours Override far out of scale with the uploaded horizon ---
  {
    // Single-day upload (1 working day, 8h derived) with a monthly-scale override (160h) -> ratio 20x.
    const laborOverride: LaborConfig = { ...LABOR, contractualHoursSource: 'override', contractualProductiveHoursOverride: 160 };
    const dq = dqFor(laborOverride, calD41, [mondayInterval]);
    const overrideWarn = dq.issues.find((i) => i.field === 'Manual Agent Hours Override');
    assert(!!overrideWarn && overrideWarn.severity === 'warning', 'D41.B1 160h override vs 1-day upload raises a warning', `issues=${JSON.stringify(dq.issues.map((i) => i.field))}`);
    assert(dq.passed === true, 'D41.B2 warning B does not flip dqResult.passed', `passed=${dq.passed}`);
  }
  // Control: override left at derived-scale (0, i.e. unused) -> no warning B regardless of horizon length.
  {
    const dq = dqFor(LABOR, calD41, [mondayInterval]);
    assert(!dq.issues.some((i) => i.field === 'Manual Agent Hours Override'), 'D41.B3 control: contractualHoursSource=derived raises no warning B');
  }
  // Control: override in-scale with the horizon (~1x derived) -> no warning B.
  {
    const laborOverride: LaborConfig = { ...LABOR, contractualHoursSource: 'override', contractualProductiveHoursOverride: 8 };
    const dq = dqFor(laborOverride, calD41, [mondayInterval]);
    assert(!dq.issues.some((i) => i.field === 'Manual Agent Hours Override'), 'D41.B4 control: override ~= derived hours raises no warning B');
  }

  // --- Warning C: calendar-open days inside the horizon with zero uploaded rows ---
  {
    // Horizon Mon->Fri (BIZ_CAL open every weekday) but only Monday has a row.
    const friInterval: StandardInterval = {
      intervalIndex: 1, start: new Date(2026, 9, 9, 16, 30), end: new Date(2026, 9, 9, 17, 0), category: 'General', volume: 5,
    };
    const dq = dqFor(LABOR, calD41, [mondayInterval, friInterval]);
    const gapWarn = dq.issues.find((i) => i.field === 'Calendar/Data Coverage Gap');
    assert(!!gapWarn, 'D41.C1 open weekdays with no rows (Tue/Wed/Thu) raise a coverage-gap warning', `issues=${JSON.stringify(dq.issues.map((i) => i.field))}`);
    assert(!!gapWarn && gapWarn.message.includes('3'), 'D41.C2 gap warning counts exactly the 3 empty open days (Tue,Wed,Thu)', `message="${gapWarn?.message}"`);
    assert(dq.passed === true, 'D41.C3 warning C does not flip dqResult.passed', `passed=${dq.passed}`);
  }
  // Control: every open day in the horizon has at least one row -> no warning C.
  {
    const intervals: StandardInterval[] = [1, 2, 3, 4, 5].map((d, idx) => ({
      intervalIndex: idx, start: new Date(2026, 9, 4 + d, 9, 0), end: new Date(2026, 9, 4 + d, 9, 30), category: 'General', volume: 10,
    }));
    const dq = dqFor(LABOR, calD41, intervals);
    assert(!dq.issues.some((i) => i.field === 'Calendar/Data Coverage Gap'), 'D41.C4 control: every open day covered raises no warning C');
  }
  // Non-determinism guard: an invalid timestamp present -> warning C must not fire (and must not throw),
  // since computeIntervalHorizon would otherwise need a wall-clock fallback for an all-invalid set.
  {
    const badInterval: StandardInterval = {
      intervalIndex: 1, start: new Date(NaN), end: new Date(NaN), category: 'General', volume: 5,
    };
    const dq = dqFor(LABOR, calD41, [mondayInterval, badInterval]);
    assert(!dq.issues.some((i) => i.field === 'Calendar/Data Coverage Gap'), 'D41.C5 warning C suppressed when any timestamp is invalid (avoids new Date() fallback non-determinism)');
  }

  // --- D41.D: all three can fire together and still never block the run ---
  {
    const laborBad: LaborConfig = {
      ...LABOR, workingDaysPerWeek: 7, offDaysPerWeek: 0,
      contractualHoursSource: 'override', contractualProductiveHoursOverride: 160,
    };
    const dq = dqFor(laborBad, calD41, [mondayInterval]);
    const fields = dq.issues.map((i) => i.field);
    assert(fields.includes('Labor Off Days') && fields.includes('Manual Agent Hours Override'), 'D41.D1 both warnings A and B fire together', `fields=${JSON.stringify(fields)}`);
    assert(dq.issues.every((i) => i.severity !== 'error'), 'D41.D2 no issue in this fixture is severity:error', `severities=${JSON.stringify(dq.issues.map((i) => i.severity))}`);
    assert(dq.passed === true, 'D41.D3 dqResult.passed stays true with multiple simultaneous warnings', `passed=${dq.passed}`);
  }
}

// =================================================================
// Suite D42 — WLR-DEAD + BIND-LABEL: the two param-audit defects (2026-08-31)
//
// (1) WLR-DEAD. Workload reduction used to be applied ONLY inside computeAnalyticalNMin.
//     The search starts at startN = max(N_min, N_occ) and never explores below it, and
//     computeOccupancyFloor did not take the reduction — so under the default derived-hours
//     basis both floors share a denominator, giving N_occ = ceil(X) >= floor(X·(1−r)) = N_min
//     for every r. startN was pinned to the UN-reduced N_occ and a 50% reduction moved
//     neither recommendedHC nor grossHC. The reduction is now applied once, to category AHT,
//     so all four stages size against the same reduced workload.
//     Pre-fix, D42.1/D42.2/D42.3 fail (every value identical to the 0% baseline).
//
// (2) BIND-LABEL. The binding-constraint label tested `recommendedHC === nMinAnalytical`, but
//     the search starts at N_occ = N_min + 1 in 533 of 540 swept workloads, so the test was
//     almost never true even when the floor was exactly what bound — control fell through to
//     the default "Primary SLA … Target" string. Planners were told SLA was binding in the
//     very runs where sweeping the SLA target across 50–99% provably moved nothing.
//     Pre-fix, D42.7/D42.8 fail (bindingConstraintType === 'statistical_primary_sla').
// =================================================================
console.log('\n--- Suite D42: workload reduction reaches the recommendation + honest binding label ---');
{
  // 10 business days, Mon–Fri 09:00–17:00, 30 cases/hour × 8h = 240/day at AHT 30m.
  const catsD42: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1 }];
  const laborD42: LaborConfig = { ...LABOR, dailyProductiveHours: 7.5 };
  const slaD42Base: SLAPolicyConfig = {
    primaryPct: 80, primaryWindow: 8, primaryUnit: 'hours',
    boAsaEnabled: false, boAsaTarget: 4, boAsaUnit: 'hours',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'arrival',
    occupancyCapEnabled: false, occupancyCapPct: 85, confidenceLevelPct: 95,
  };

  function intervalsD42(volPerHour: number): StandardInterval[] {
    const out: StandardInterval[] = [];
    let idx = 0;
    for (let d = 0; d < 14; d++) {
      const day = new Date(2026, 2, 2 + d);
      if (!BIZ_CAL.workingDays.includes(day.getDay())) continue;
      for (let h = 9; h < 17; h++) {
        out.push({
          intervalIndex: idx++,
          start: new Date(2026, 2, 2 + d, h, 0),
          end: new Date(2026, 2, 2 + d, h + 1, 0),
          category: 'General',
          volume: volPerHour,
        });
      }
    }
    return out;
  }

  const ivD42 = intervalsD42(30);
  const runAsyncD42 = (sla: SLAPolicyConfig) =>
    searchOptimalHCAsync({
      intervals: ivD42, openingWIP: [], categories: catsD42, calendar: BIZ_CAL,
      labor: laborD42, sla, seed: 12345, userMaxHC: 200, replications: 8,
    });
  const runSyncD42 = (sla: SLAPolicyConfig) =>
    searchOptimalHC({
      intervals: ivD42, openingWIP: [], categories: catsD42, calendar: BIZ_CAL,
      labor: laborD42, sla, seed: 12345, userMaxHC: 200, replications: 8,
    });
  const withReduction = (pct: number): SLAPolicyConfig => ({
    ...slaD42Base, workloadReductionEnabled: true, workloadReductionPct: pct,
  });

  const baseD42 = await runAsyncD42(slaD42Base);
  const red20D42 = await runAsyncD42(withReduction(20));
  const red50D42 = await runAsyncD42(withReduction(50));

  // --- D42.1: the reduction actually moves the recommendation (the whole point) ---
  assert(
    red20D42.recommendedHC !== null && baseD42.recommendedHC !== null &&
      red20D42.recommendedHC < baseD42.recommendedHC,
    'D42.1 20% workload reduction LOWERS recommendedHC (pre-fix: identical)',
    `base=${baseD42.recommendedHC} reduced20=${red20D42.recommendedHC}`
  );
  assert(
    red50D42.recommendedHC !== null && red20D42.recommendedHC !== null &&
      red50D42.recommendedHC < red20D42.recommendedHC,
    'D42.2 50% reduction lowers it further still (monotone in the reduction %)',
    `reduced20=${red20D42.recommendedHC} reduced50=${red50D42.recommendedHC}`
  );

  // --- D42.3: Stage 4 follows too — Gross HC is not left at the un-reduced figure ---
  assert(
    red50D42.staffing.grossHCTotal < baseD42.staffing.grossHCTotal,
    'D42.3 reduction flows through to Gross HC (Stage 4), not just the floor',
    `base=${baseD42.staffing.grossHCTotal} reduced50=${red50D42.staffing.grossHCTotal}`
  );

  // --- D42.4: N_occ honours the reduction now, so it can no longer pin startN ---
  assert(
    (red50D42.occupancyFeasibleFloor ?? 0) < (baseD42.occupancyFeasibleFloor ?? 0),
    'D42.4 N_occ is computed on the reduced workload (pre-fix it ignored the reduction and pinned startN)',
    `base nOcc=${baseD42.occupancyFeasibleFloor} reduced50 nOcc=${red50D42.occupancyFeasibleFloor}`
  );

  // --- D42.5: single application — reduction must not be double-counted ---
  // 50% off a workload whose un-reduced N_min is M must land on floor(M_exact/2), never
  // floor(M_exact/4). Guard via the reported before/after pair.
  assert(
    red50D42.nMinBeforeReduction === baseD42.nMinAnalytical,
    'D42.5 nMinBeforeReduction reports the UN-reduced baseline (display figure intact)',
    `nMinBeforeReduction=${red50D42.nMinBeforeReduction} unreduced nMin=${baseD42.nMinAnalytical}`
  );
  assert(
    red50D42.nMinAnalytical >= Math.floor(baseD42.nMinAnalytical / 2) - 1 &&
      red50D42.nMinAnalytical <= Math.floor(baseD42.nMinAnalytical / 2) + 1,
    'D42.6 50% reduction halves N_min once, not twice (no double-application)',
    `unreduced=${baseD42.nMinAnalytical} reduced=${red50D42.nMinAnalytical}`
  );

  // --- D42.7: OFF remains an exact no-op ---
  const offExplicitD42 = await runAsyncD42({ ...slaD42Base, workloadReductionEnabled: false, workloadReductionPct: 30 });
  assert(
    offExplicitD42.recommendedHC === baseD42.recommendedHC &&
      offExplicitD42.staffing.grossHCTotal === baseD42.staffing.grossHCTotal,
    'D42.7 workloadReductionEnabled:false is an exact no-op even with a pct set',
    `off=${offExplicitD42.recommendedHC}/${offExplicitD42.staffing.grossHCTotal} base=${baseD42.recommendedHC}/${baseD42.staffing.grossHCTotal}`
  );
  assert(
    offExplicitD42.workloadReductionAppliedPct === undefined && offExplicitD42.nMinBeforeReduction === undefined,
    'D42.8 OFF run reports neither workloadReductionAppliedPct nor nMinBeforeReduction',
    `applied=${offExplicitD42.workloadReductionAppliedPct} before=${offExplicitD42.nMinBeforeReduction}`
  );

  // --- D42.9: sync/async parity on the reduction (D11 drift guard) ---
  const syncRed50D42 = runSyncD42(withReduction(50));
  assert(
    syncRed50D42.nMinAnalytical === red50D42.nMinAnalytical &&
      syncRed50D42.occupancyFeasibleFloor === red50D42.occupancyFeasibleFloor,
    'D42.9 sync/async parity: identical N_min and N_occ under reduction',
    `sync=${syncRed50D42.nMinAnalytical}/${syncRed50D42.occupancyFeasibleFloor} async=${red50D42.nMinAnalytical}/${red50D42.occupancyFeasibleFloor}`
  );

  // --- D42.10 / D42.11: binding label tells the truth about the capacity floor ---
  // Base run passes at its very first candidate (startN), so no DES gate set the number.
  assert(
    baseD42.bindingConstraintType === 'analytical_baseline',
    'D42.10 floor-bound run reports analytical_baseline (pre-fix: statistical_primary_sla)',
    `got ${baseD42.bindingConstraintType} — "${baseD42.bindingConstraintDescription}"`
  );
  assert(
    !baseD42.bindingConstraintDescription.includes('Primary SLA'),
    'D42.11 floor-bound run does NOT name Primary SLA as the binding constraint',
    `got "${baseD42.bindingConstraintDescription}"`
  );

  // With an occupancy cap the floor rises to N_occ > N_min — the label must name N_occ,
  // and must still not claim SLA. This is the exact configuration that used to mislabel.
  const cappedD42 = await runAsyncD42({ ...slaD42Base, occupancyCapEnabled: true, occupancyCapPct: 75 });
  assert(
    cappedD42.bindingConstraintType === 'analytical_baseline' &&
      cappedD42.recommendedHC === cappedD42.occupancyFeasibleFloor,
    'D42.12 occupancy-floor-bound run reports analytical_baseline at exactly N_occ',
    `type=${cappedD42.bindingConstraintType} recHC=${cappedD42.recommendedHC} nOcc=${cappedD42.occupancyFeasibleFloor}`
  );
  assert(
    cappedD42.bindingConstraintDescription.includes('N_occ') &&
      !cappedD42.bindingConstraintDescription.includes('Primary SLA'),
    'D42.13 description names the occupancy-feasible floor, not Primary SLA',
    `got "${cappedD42.bindingConstraintDescription}"`
  );

  // --- D42.14: the label is not stuck the other way — a genuinely SLA-bound run still says so.
  // Turnaround window at 30m against AHT 30m forces the DES to climb above the floor.
  const slaBoundD42 = await runAsyncD42({ ...slaD42Base, primaryWindow: 30, primaryUnit: 'minutes' });
  assert(
    slaBoundD42.recommendedHC !== null &&
      slaBoundD42.recommendedHC > Math.max(slaBoundD42.nMinAnalytical, slaBoundD42.occupancyFeasibleFloor ?? 0),
    'D42.14 tight-TAT run climbs above both floors (the DES really is binding here)',
    `recHC=${slaBoundD42.recommendedHC} nMin=${slaBoundD42.nMinAnalytical} nOcc=${slaBoundD42.occupancyFeasibleFloor}`
  );
  assert(
    slaBoundD42.bindingConstraintType === 'statistical_primary_sla',
    'D42.15 genuinely SLA-bound run is still labelled statistical_primary_sla (no over-correction)',
    `got ${slaBoundD42.bindingConstraintType} — "${slaBoundD42.bindingConstraintDescription}"`
  );

  // --- D42.16 / D42.17: `||` → explicit-finite-check resolvers (an explicit 0 is clamped,
  // not silently treated as "unset"). ---
  assert(
    resolveEffectiveAdherence({ adherencePct: 0 }) === 0.1,
    'D42.16 adherencePct:0 clamps to the 0.1 floor (pre-fix `|| 1.0` returned 100%)',
    `got ${resolveEffectiveAdherence({ adherencePct: 0 })}`
  );
  assert(
    resolveEffectiveAdherence({ adherencePct: undefined as unknown as number }) === 1.0 &&
      resolveEffectiveAdherence({ adherencePct: NaN }) === 1.0 &&
      resolveEffectiveAdherence({ adherencePct: 0.85 }) === 0.85,
    'D42.17 adherence resolver: missing/NaN → 1.0, in-range value passes through',
    `undef=${resolveEffectiveAdherence({ adherencePct: undefined as unknown as number })} nan=${resolveEffectiveAdherence({ adherencePct: NaN })} val=${resolveEffectiveAdherence({ adherencePct: 0.85 })}`
  );
  assert(
    resolveShiftSlapMinutes({ shiftSlapMinutes: 0 }) === 5 &&
      resolveShiftSlapMinutes({ shiftSlapMinutes: undefined }) === 30 &&
      resolveShiftSlapMinutes({ shiftSlapMinutes: 15 }) === 15,
    'D42.18 slap resolver: explicit 0 clamps to 5, missing → 30, valid passes through',
    `zero=${resolveShiftSlapMinutes({ shiftSlapMinutes: 0 })} undef=${resolveShiftSlapMinutes({ shiftSlapMinutes: undefined })} val=${resolveShiftSlapMinutes({ shiftSlapMinutes: 15 })}`
  );
}

// =================================================================
// Suite D43 — Fair case-to-agent distribution (agent SELECTION only)
//
// Defect (FAIR-AGENT): the idle-agent list was a stack (`idleList.pop()`), agents returned
// by `push`, so when spare capacity existed the agent who had JUST finished took the next
// case and a few high-id agents did most of the work. Fix: `selectFairAgent` cascade
// (utilisation -> case count -> busy minutes -> longest idle -> seeded RNG), tolerance bands
// anchored to the minimum. It changes WHO works a case, never WHICH case goes next (EDF,
// CaseMinHeap.compare untouched) and never the requirements (N_min / recommended HC / gross
// HC) — those are pinned by D43.13 on pooled / siloed / staggered / 24x7 fixtures.
//
// Pre-fix, D43.1, D43.2, D43.3, D43.5, D43.6, D43.8b/c, D43.10, D43.11, D43.12 fail. D43.4,
// D43.7, D43.8a and D43.9 are CONTROLS (properties that already held and must keep holding).
// =================================================================
console.log('\n--- Suite D43: fair case-to-agent distribution ---');
{
  const BIZ43: CalendarConfig = { workingDays: [1, 2, 3, 4, 5], dailyOpenHour: 9, dailyOpenMinute: 0, dailyCloseHour: 17, dailyCloseMinute: 0, holidays: [] };
  const LAB43: LaborConfig = { dailyProductiveHours: 8, adherencePct: 1.0, workingDaysPerWeek: 5, offDaysPerWeek: 2, contractualHoursSource: 'derived', shifts: [] };
  const SLA43: SLAPolicyConfig = {
    primaryPct: 80, primaryWindow: 3, primaryUnit: 'days', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'arrival',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 95,
  };
  const cat43 = (name: string, aht: number, priority = 1): CategoryConfig => ({ id: name, name, ahtMinutes: aht, shrinkagePct: 0.2, priority });
  const ivs43 = (startDay: number, days: number, fromH: number, toH: number, vols: Record<string, number>, cal: CalendarConfig = BIZ43, fromMin = 0): StandardInterval[] => {
    const out: StandardInterval[] = [];
    let idx = 0;
    for (let d = 0; d < days; d++) {
      const day = new Date(2026, 9, startDay + d);
      if (!cal.workingDays.includes(day.getDay())) continue;
      for (let h = fromH; h < toH; h++) {
        for (const m of [0, 30]) {
          if (d === 0 && h === fromH && m < fromMin) continue;
          for (const [category, volume] of Object.entries(vols)) {
            out.push({ intervalIndex: idx++, start: new Date(2026, 9, startDay + d, h, m), end: new Date(2026, 9, startDay + d, h, m + 30), volume, category });
          }
        }
      }
    }
    return out;
  };
  const scn43 = {
    // budgets and close never bind on the first five (asserted via parkCount === 0 in D43.7)
    seqPooled: () => ({ operationalHC: 10, intervals: ivs43(5, 5, 9, 15, { General: 6 }), openingWIP: [], categories: [cat43('General', 20)], calendar: BIZ43, labor: LAB43, sla: SLA43, seed: 42 }),
    seqSiloed: () => ({ operationalHC: 10, intervals: ivs43(5, 5, 9, 15, { A: 4, B: 3 }), openingWIP: [], categories: [cat43('A', 20, 1), cat43('B', 30, 2)], calendar: BIZ43, labor: LAB43, sla: SLA43, seed: 42, queueArchitecture: 'siloed' as const }),
    uniform: () => ({ operationalHC: 8, intervals: ivs43(5, 14, 9, 15, { General: 8 }), openingWIP: [], categories: [cat43('General', 20)], calendar: BIZ43, labor: LAB43, sla: SLA43, seed: 42 }),
    mixed: () => ({ operationalHC: 10, intervals: ivs43(5, 14, 9, 15, { Quick: 12, Mid: 1, Long: 1 }), openingWIP: [], categories: [cat43('Quick', 5, 1), cat43('Mid', 45, 2), cat43('Long', 120, 3)], calendar: BIZ43, labor: LAB43, sla: SLA43, seed: 42 }),
    siloed: () => ({ operationalHC: 12, intervals: ivs43(5, 14, 9, 15, { A: 6, B: 4 }), openingWIP: [], categories: [cat43('A', 20, 1), cat43('B', 30, 2)], calendar: BIZ43, labor: LAB43, sla: SLA43, seed: 42, queueArchitecture: 'siloed' as const }),
    c247: () => ({ operationalHC: 8, intervals: ivs43(5, 10, 0, 24, { General: 2 }, CAL_24X7), openingWIP: [], categories: [cat43('General', 30)], calendar: CAL_24X7, labor: { ...LAB43, workingDaysPerWeek: 7, offDaysPerWeek: 0 }, sla: SLA43, seed: 42 }),
    // staggered: 10 agents, two 6h cohorts (09:00-15:00 and 11:00-17:00); the horizon opens at
    // 13:00 on day 1, so the late cohort has 2h MORE availability than the early one (240 vs 120
    // min on day 1, then 360 each on day 2).
    staggered: () => ({
      operationalHC: 10,
      intervals: [...ivs43(5, 1, 13, 17, { General: 8 }), ...ivs43(6, 1, 9, 17, { General: 8 })],
      openingWIP: [], categories: [cat43('General', 20)], calendar: BIZ43, labor: { ...LAB43, dailyProductiveHours: 6 }, sla: SLA43, seed: 42,
      shiftDistribution: { __POOLED__: { slapMinutes: 120, slaps: [{ startMinutesFromOpen: 0, agentCount: 5 }, { startMinutesFromOpen: 120, agentCount: 5 }] } } as ShiftDistributionByCategory,
    }),
  };
  const STRICT = { utilTolerancePp: 0, countTolerance: 0, workloadToleranceMin: 0 };

  // Per-agent stats derived from the TIMELINE only, so the same helper runs on the pre-fix engine.
  function agentStats43(des: any) {
    const n = des.operationalHC as number;
    const busy = new Array<number>(n).fill(0);
    const cases = new Array<number>(n).fill(0);
    const cats: Array<Set<string>> = Array.from({ length: n }, () => new Set<string>());
    const last = new Map<string, { agent: number; to: number }>();
    for (const s of des.agentTimeline as any[]) {
      if (s.state !== 'busy') continue;
      busy[s.agentId] += s.minutes;
      if (s.category) cats[s.agentId].add(s.category);
      const to = s.to.getTime();
      const p = last.get(s.caseId);
      if (!p || to >= p.to) last.set(s.caseId, { agent: s.agentId, to });
    }
    const done = new Set((des.caseResults as any[]).filter((c) => c.isCompleted).map((c) => c.caseId));
    for (const [cid, v] of last) if (done.has(cid)) cases[v.agent]++;
    return { busy, cases, cats };
  }
  const spread43 = (a: number[]) => (a.length ? Math.max(...a) - Math.min(...a) : 0);
  function timesDigest43(des: any): number {
    const hs = des.horizonStart.getTime();
    let h = 2166136261;
    const rows = [...(des.caseResults as any[])].sort((a, b) => (a.caseId < b.caseId ? -1 : 1));
    for (const c of rows) {
      const s = `${c.caseId}:${c.firstStartTime ? (c.firstStartTime.getTime() - hs) / 60000 : 'x'}:${c.completeTime ? (c.completeTime.getTime() - hs) / 60000 : 'x'}`;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    }
    return h >>> 0;
  }
  const run43 = (s: any, extra: any = {}) => runBackofficeDES({ ...s, ...extra });

  // --- D43.1: identical agents, uniform AHT, steady below-capacity load -----------------------
  const uni = scn43.uniform();
  const uniStrict = run43(uni, { dispatchFairness: STRICT });
  const uniStrictStats = agentStats43(uniStrict);
  assert(uniStrict.completedCases === uniStrict.totalCases && uniStrict.totalCases === 960, 'D43.1a control: uniform fixture fully completes (load is below capacity)', `completed=${uniStrict.completedCases}/${uniStrict.totalCases}`);
  assert(spread43(uniStrictStats.cases) <= 1, 'D43.1b identical agents, uniform AHT, zero tolerances: case counts differ by <= 1 (pre-fix: LIFO stack piles work on a few agents)', `cases per agent=${JSON.stringify(uniStrictStats.cases)}`);
  const uniDefStats = agentStats43(run43(uni));
  const uniAvailMin = 10 * 480; // 10 working days x 480 min window
  const uniCaseBound = Math.ceil((0.02 * uniAvailMin) / 20) + 1; // default 2pp util band expressed in 20-min cases, +1 count band
  assert(spread43(uniDefStats.cases) <= uniCaseBound, `D43.1c default tolerances: case-count spread within the tolerance-derived bound (<= ${uniCaseBound})`, `cases per agent=${JSON.stringify(uniDefStats.cases)}`);

  // --- D43.2: highly variable AHT (5 / 45 / 120 min in one pooled queue) ------------------------
  const mixedRun = run43(scn43.mixed());
  const mixedStats = agentStats43(mixedRun);
  const mixedAvail = 10 * 480;
  const utilsMixed = mixedStats.busy.map((b) => (b / mixedAvail) * 100);
  const utilBoundPp = 2 + (2 * 120 * 100) / mixedAvail; // util band + two longest-case granularity
  assert(spread43(utilsMixed) <= utilBoundPp, `D43.2a variable AHT: per-agent utilisation spread <= ${utilBoundPp.toFixed(1)} pp (2 pp band + 2 x longest case / horizon)`, `spread=${spread43(utilsMixed).toFixed(1)}pp utils=${utilsMixed.map((u) => u.toFixed(1)).join(',')}`);
  const meanCases = mixedStats.cases.reduce((a, b) => a + b, 0) / mixedStats.cases.length;
  const sdCases = Math.sqrt(mixedStats.cases.reduce((a, b) => a + (b - meanCases) ** 2, 0) / mixedStats.cases.length);
  assert(sdCases / meanCases <= 0.15, 'D43.2b variable AHT: case-count coefficient of variation stays bounded (<= 0.15)', `cv=${(sdCases / meanCases).toFixed(3)} cases=${JSON.stringify(mixedStats.cases)}`);

  // --- D43.3: staggered cohorts with unequal availability ---------------------------------------
  const stag = run43(scn43.staggered());
  const stagStats = agentStats43(stag);
  const early = stagStats.cases.slice(0, 5).reduce((a, b) => a + b, 0);
  const late = stagStats.cases.slice(5).reduce((a, b) => a + b, 0);
  const avEarly = 120 + 360; // day-1 remainder from 13:00 to its 15:00 shift end + full day 2
  const avLate = 240 + 360;
  const stagUtils = stagStats.busy.map((b, i) => (b / (i < 5 ? avEarly : avLate)) * 100);
  assert(late > early && late / early <= (avLate / avEarly) * 1.25, 'D43.3a late cohort (more availability) gets more cases, roughly in proportion to its availability', `early=${early} late=${late} ratio=${(late / Math.max(1, early)).toFixed(2)} availRatio=${(avLate / avEarly).toFixed(2)}`);
  assert(spread43(stagUtils) <= 2 + (2 * 20 * 100) / avEarly + 6, 'D43.3b staggered: utilisation (busy / own availability) stays balanced across cohorts', `spread=${spread43(stagUtils).toFixed(1)}pp utils=${stagUtils.map((u) => u.toFixed(1)).join(',')}`);

  // --- D43.4: no assignment outside own shift, no budget overrun, no overlapping busy intervals ---
  const noOverlap = (des: any) => {
    const byAgent = new Map<number, Array<{ from: number; to: number }>>();
    for (const s of des.agentTimeline as any[]) {
      if (s.state !== 'busy') continue;
      if (!byAgent.has(s.agentId)) byAgent.set(s.agentId, []);
      byAgent.get(s.agentId)!.push({ from: s.from.getTime(), to: s.to.getTime() });
    }
    for (const [id, arr] of byAgent) {
      arr.sort((a, b) => a.from - b.from);
      for (let i = 1; i < arr.length; i++) if (arr[i].from < arr[i - 1].to - 1) return `agent ${id} overlaps at ${new Date(arr[i].from).toISOString()}`;
    }
    return '';
  };
  const c247Run = run43(scn43.c247());
  const siloCtl = run43(scn43.siloed());
  const overlapMsg = [noOverlap(uniStrict), noOverlap(siloCtl), noOverlap(c247Run), noOverlap(stag)].filter(Boolean).join('; ');
  assert(overlapMsg === '', 'D43.4a control: no agent has overlapping busy intervals (pooled, siloed, 24x7, staggered)', overlapMsg);
  let shiftViolation = '';
  for (const s of stag.agentTimeline as any[]) {
    if (s.state !== 'busy') continue;
    const dayOpen = new Date(s.from); dayOpen.setHours(9, 0, 0, 0);
    const off = s.agentId < 5 ? 0 : 120;
    const startMin = (s.from.getTime() - dayOpen.getTime()) / 60000;
    const endMin = (s.to.getTime() - dayOpen.getTime()) / 60000;
    if (startMin < off - 1e-6 || endMin > off + 360 + 1e-6) { shiftViolation = `agent ${s.agentId} busy ${startMin}-${endMin} outside [${off},${off + 360}]`; break; }
  }
  assert(shiftViolation === '', 'D43.4b control: staggered agents are never assigned outside their own shift window', shiftViolation);
  const invStag = verifyAgentTimelineInvariants(stag, { ...LAB43, dailyProductiveHours: 6 }, BIZ43);
  const inv247 = verifyAgentTimelineInvariants(c247Run, { ...LAB43, workingDaysPerWeek: 7, offDaysPerWeek: 0 }, CAL_24X7);
  assert(invStag.valid && inv247.valid, 'D43.4c control: no daily budget overrun (timeline invariants) under fair selection, staggered and 24x7', JSON.stringify([...invStag.errors, ...inv247.errors]));

  // --- D43.5: determinism of the assignment ledger ----------------------------------------------
  const ledger = (d: any) => JSON.stringify((d.caseResults as any[]).map((c) => [c.caseId, c.assignedAgent, c.candidateCount, c.decidedBy]));
  const uniA = run43(uni), uniB = run43(uni);
  assert(uniA.caseResults.length > 0 && uniA.caseResults.every((c: any) => c.assignedAgent !== undefined && c.decidedBy !== undefined), 'D43.5a audit run populates the assignment ledger on every case (assignedAgent, candidateCount, decidedBy)', 'ledger fields missing');
  assert(ledger(uniA) === ledger(uniB), 'D43.5b same seed + input gives a byte-identical ledger', '');
  const gen43 = generateCaseEntities({ intervals: uni.intervals, openingWIP: [], categories: uni.categories, calendar: BIZ43, sla: SLA43, seed: 42 });
  const pre43 = { cases: gen43.cases, horizonStart: gen43.horizonStart, horizonEnd: gen43.horizonEnd };
  const seedRun = (seed: number) => runBackofficeDES({ ...uni, seed, precomputedCases: pre43 });
  const s1 = seedRun(1), s2 = seedRun(2);
  const assigned = (d: any) => (d.caseResults as any[]).map((c) => c.assignedAgent).join(',');
  assert(s1.caseResults.every((c: any) => c.assignedAgent !== undefined) && assigned(s1) !== assigned(s2), 'D43.5c different seeds (identical cases, CRN) break ties differently — the RNG tie-break stream is seeded, not fixed', 'assignments identical or missing');
  assert(timesDigest43(s1) === timesDigest43(s2), 'D43.5d ...but case start/complete times are identical across seeds (agents are interchangeable; only WHO changes)', '');

  // --- D43.6: agent-id invariance (no first-in-list / last-returned bias) ---------------------------
  const perId = new Array<number>(8).fill(0);
  for (let seed = 1; seed <= 8; seed++) {
    const st = agentStats43(run43(uni, { seed }));
    st.cases.forEach((c, i) => { perId[i] += c; });
  }
  const meanId = perId.reduce((a, b) => a + b, 0) / perId.length;
  const idx = perId.map((_, i) => i);
  const meanIdx = 3.5;
  const cov = idx.reduce((a, i) => a + (i - meanIdx) * (perId[i] - meanId), 0);
  const varI = idx.reduce((a, i) => a + (i - meanIdx) ** 2, 0);
  const varC = perId.reduce((a, c) => a + (c - meanId) ** 2, 0);
  const corr = varC > 0 ? cov / Math.sqrt(varI * varC) : 0;
  const lowHalf = perId.slice(0, 4).reduce((a, b) => a + b, 0), highHalf = perId.slice(4).reduce((a, b) => a + b, 0);
  assert(Math.abs(corr) < 0.6 && Math.abs(lowHalf - highHalf) / (lowHalf + highHalf) < 0.03, 'D43.6 agent id does not predict load over 8 seeds (|corr| < 0.6, low/high id halves within 3%)', `corr=${corr.toFixed(2)} perId=${JSON.stringify(perId)}`);

  // --- D43.7: case ORDER unchanged (golden captured from the pre-change engine) ---------------------
  // Scenarios where no daily budget or business close binds (asserted: zero parked cases), so agent
  // choice cannot shift timing and every case's first-start / complete instant must equal the
  // pre-change engine's. Digest = FNV-1a over `caseId:startMin:completeMin` (minutes since horizon
  // start, timezone-independent).
  const GOLDEN_TIMES: Record<string, number> = { seqPooled: 139882310, seqSiloed: 949840959, uniform: 3777605062, mixed: 1989481177, siloed: 3903947605 };
  for (const [name, golden] of Object.entries(GOLDEN_TIMES)) {
    const d = run43((scn43 as any)[name]());
    const parkedCases = (d.caseResults as any[]).filter((c) => c.parkCount > 0).length;
    assert(parkedCases === 0 && timesDigest43(d) === golden, `D43.7 ${name}: dispatch timing identical to the pre-change engine (EDF case order untouched)`, `parked=${parkedCases} digest=${timesDigest43(d)} golden=${golden}`);
  }

  // --- D43.8: siloed — no cross-category assignment, fairness holds within each category ---------------
  const silo = run43(scn43.siloed(), { dispatchFairness: STRICT });
  const siloStats = agentStats43(silo);
  assert(siloStats.cats.every((s) => s.size <= 1), 'D43.8a control: every siloed agent works exactly one category', JSON.stringify(siloStats.cats.map((s) => [...s])));
  const perCat = new Map<string, number[]>();
  siloStats.cats.forEach((s, i) => { const c = [...s][0]; if (c) { if (!perCat.has(c)) perCat.set(c, []); perCat.get(c)!.push(siloStats.cases[i]); } });
  const siloSpreads = [...perCat.entries()].map(([c, a]) => `${c}:${JSON.stringify(a)}`);
  assert(perCat.size === 2 && [...perCat.values()].every((a) => spread43(a) <= 1), 'D43.8b siloed, zero tolerances: case counts within each category differ by <= 1', siloSpreads.join(' '));
  const ledgerCatOk = (silo.caseResults as any[]).every((c) => {
    const ag = c.assignedAgent as number | undefined;
    return ag !== undefined && siloStats.cats[ag].has(c.category);
  });
  assert(ledgerCatOk, 'D43.8c ledger: every case is assigned to an agent of its own category (no cross-category assignment)', 'cross-category assignment or missing ledger');

  // --- D43.9: monotone pass/fail across an N sweep (control) -----------------------------------------
  const tightSla: SLAPolicyConfig = { ...SLA43, primaryWindow: 4, primaryUnit: 'hours' };
  const sweepBase = { ...uni, sla: tightSla };
  const sweepGen = generateCaseEntities({ intervals: sweepBase.intervals, openingWIP: [], categories: sweepBase.categories, calendar: BIZ43, sla: tightSla, seed: 42 });
  const sweepPre = { cases: sweepGen.cases, horizonStart: sweepGen.horizonStart, horizonEnd: sweepGen.horizonEnd };
  for (const [label, extra] of [['default', {}], ['strict', { dispatchFairness: STRICT }]] as const) {
    const flags: boolean[] = [];
    for (let n = 1; n <= 14; n++) flags.push(runBackofficeDES({ ...sweepBase, operationalHC: n, precomputedCases: sweepPre, skipCaseResultsAndTimeline: true, ...extra }).allPassed);
    const firstPass = flags.indexOf(true);
    assert(firstPass > 0 && flags.slice(firstPass).every(Boolean), `D43.9 (${label}) pass/fail is monotone in N over 1..14 and the sweep straddles the threshold`, flags.map((f) => (f ? 'P' : 'F')).join(''));
  }

  // --- D43.10: agentFairness summary: present in audit runs only, reconciles with totals ------------------
  const af = (uniA as any).agentFairness;
  assert(!!af && Array.isArray(af.perAgent) && af.perAgent.length === 8, 'D43.10a audit run exposes agentFairness with one row per agent', `got ${JSON.stringify(af)?.slice(0, 120)}`);
  if (af) {
    const sumCases = af.perAgent.reduce((a: number, r: any) => a + r.casesCompleted, 0);
    const sumBusy = af.perAgent.reduce((a: number, r: any) => a + r.busyMinutes, 0);
    assert(sumCases === uniA.completedCases && Math.abs(sumBusy - uniA.totalHandlingMinutes) <= Math.max(0.01, uniA.totalHandlingMinutes * 1e-5), 'D43.10b per-agent completed cases sum to completedCases and busy minutes to totalHandlingMinutes (no split-case double-count)', `cases=${sumCases}/${uniA.completedCases} busy=${sumBusy}/${uniA.totalHandlingMinutes}`);
    const busyFromTimeline = agentStats43(uniA).busy;
    assert(af.perAgent.every((r: any, i: number) => Math.abs(r.busyMinutes - busyFromTimeline[i]) < 0.01), 'D43.10c per-agent busy minutes match the agent timeline exactly', '');
  }
  const leanRun = runBackofficeDES({ ...uni, skipCaseResultsAndTimeline: true });
  assert((leanRun as any).agentFairness === undefined && leanRun.caseResults.length === 0, 'D43.10d gated (skip) runs stay lean: no fairness ledger or summary', '');

  // --- D43.11: tolerance semantics --------------------------------------------------------------------------
  const wide = run43(uni, { dispatchFairness: { utilTolerancePp: 1000, countTolerance: 1e9, workloadToleranceMin: 1e9 } });
  const decided = new Set((wide.caseResults as any[]).map((c) => c.decidedBy));
  assert(decided.size > 0 && !decided.has(undefined) && [...decided].every((d) => d === 'single' || d === 'idle' || d === 'rng'), 'D43.11a with every band wide open, only the idle-time / RNG levels (or a lone candidate) can decide', JSON.stringify([...decided]));
  const strictDecided = new Set((uniStrict.caseResults as any[]).map((c) => c.decidedBy));
  assert(strictDecided.has('util') || strictDecided.has('count'), 'D43.11b with zero bands the utilisation/count levels do decide', JSON.stringify([...strictDecided]));
  const explicitDefaults = run43(uni, { dispatchFairness: { utilTolerancePp: 2, countTolerance: 1, workloadToleranceMin: 5 } });
  assert(uniA.caseResults.every((c: any) => c.assignedAgent !== undefined) && ledger(explicitDefaults) === ledger(uniA), 'D43.11c omitted dispatchFairness == documented defaults (2 pp / 1 case / 5 min): identical ledger', '');

  // --- D43.12: sync/async threading (D11 drift guard) --------------------------------------------------------
  const hcSrc = readFileSync(join(resolve(import.meta.dirname, '..'), 'src', 'utils', 'hc-search.ts'), 'utf-8');
  const syncBody = hcSrc.slice(hcSrc.indexOf('export function searchOptimalHC('), hcSrc.indexOf('export async function searchOptimalHCAsync('));
  const asyncBody = hcSrc.slice(hcSrc.indexOf('export async function searchOptimalHCAsync('));
  const cnt = (s: string, re: RegExp) => (s.match(re) || []).length;
  assert(cnt(syncBody, /dispatchFairness/g) > 0 && cnt(syncBody, /dispatchFairness/g) === cnt(asyncBody, /dispatchFairness/g), 'D43.12a searchOptimalHC and searchOptimalHCAsync thread dispatchFairness identically (same number of references)', `sync=${cnt(syncBody, /dispatchFairness/g)} async=${cnt(asyncBody, /dispatchFairness/g)}`);
  const searchParams43 = { intervals: ivs43(5, 5, 9, 15, { General: 6 }), openingWIP: [], categories: [cat43('General', 20)], calendar: BIZ43, labor: LAB43, sla: SLA43, seed: 42, userMaxHC: 30, replications: 4, dispatchFairness: { utilTolerancePp: 5, countTolerance: 2, workloadToleranceMin: 10 } };
  const fSync = searchOptimalHC(searchParams43);
  const fAsync = await searchOptimalHCAsync(searchParams43);
  assert(fSync.recommendedHC === fAsync.recommendedHC && fSync.staffing?.grossHCTotal === fAsync.staffing?.grossHCTotal, 'D43.12b sync/async parity with a custom dispatchFairness', `sync=${fSync.recommendedHC} async=${fAsync.recommendedHC}`);
  assert(cnt(hcSrc, /dispatchFairness/g) >= 8, 'D43.12c hc-search.ts passes dispatchFairness to every runBackofficeDES call site (sync + async, gated + audit + failedN)', `references=${cnt(hcSrc, /dispatchFairness/g)}`);

  // --- D43.13: HC-pinning regression + the OFF toggle reproduces the ORIGINAL (pre-fairness) numbers --
  // Fixtures: pooled (D42.1: 20% workload reduction), siloed, staggered (shift placement), 24x7.
  // OFF = legacy LIFO pick = the pre-change values (captured before the engine edit; D42.1 13/16).
  // ON (default) = identical to OFF on every fixture. Until C6 (2026-09-29) D42.1 was +1 HC under ON (14/18): the coverage
  // gate counted 'budget remaining' as presence and fair dispatch drains every agent's budget together at ~98% occupancy.
  // Presence is now the shift window, so that artefact is gone. N_min is identical in both modes.
  {
    const slaPin: SLAPolicyConfig = { ...SLA43, primaryPct: 80, primaryWindow: 8, primaryUnit: 'hours', occupancyCapPct: 85 };
    const d42Iv: StandardInterval[] = [];
    let ixp = 0;
    for (let d = 0; d < 14; d++) {
      const day = new Date(2026, 2, 2 + d);
      if (!BIZ43.workingDays.includes(day.getDay())) continue;
      for (let h = 9; h < 17; h++) d42Iv.push({ intervalIndex: ixp++, start: new Date(2026, 2, 2 + d, h, 0), end: new Date(2026, 2, 2 + d, h + 1, 0), category: 'General', volume: 30 });
    }
    const pinFx: Record<string, { p: any; nMin: number; off: [number, number]; on: [number, number] }> = {
      pooled: { p: { intervals: d42Iv, openingWIP: [], categories: [{ ...cat43('General', 30), shrinkagePct: 0.2 }], calendar: BIZ43, labor: { ...LAB43, dailyProductiveHours: 7.5 }, sla: { ...slaPin, workloadReductionEnabled: true, workloadReductionPct: 20 }, seed: 12345, userMaxHC: 200, replications: 8 }, nMin: 12, off: [13, 16], on: [13, 16] },
      siloed: { p: { intervals: ivs43(5, 10, 9, 17, { A: 10, B: 6 }), openingWIP: [], categories: [cat43('A', 20, 1), cat43('B', 30, 2)], calendar: BIZ43, labor: LAB43, sla: slaPin, seed: 42, userMaxHC: 60, replications: 5, queueArchitecture: 'siloed' }, nMin: 12, off: [13, 16], on: [13, 16] },
      staggered: { p: { intervals: ivs43(5, 10, 9, 17, { General: 8 }), openingWIP: [], categories: [cat43('General', 20)], calendar: BIZ43, labor: { ...LAB43, dailyProductiveHours: 6, shiftPlacementEnabled: true, shiftSlapMinutes: 30 }, sla: { ...slaPin, primaryWindow: 4 }, seed: 42, userMaxHC: 60, replications: 5 }, nMin: 7, off: [8, 10], on: [8, 10] },
      c247: { p: { intervals: ivs43(5, 10, 0, 24, { General: 2 }, CAL_24X7), openingWIP: [], categories: [cat43('General', 30)], calendar: CAL_24X7, labor: { ...LAB43, workingDaysPerWeek: 7, offDaysPerWeek: 0 }, sla: slaPin, seed: 42, userMaxHC: 60, replications: 5 }, nMin: 6, off: [6, 8], on: [6, 8] },
    };
    for (const [name, fx] of Object.entries(pinFx)) {
      const rOff = searchOptimalHC({ ...fx.p, dispatchFairness: { enabled: false } });
      const rOn = searchOptimalHC(fx.p);
      assert(rOff.nMinAnalytical === fx.nMin && rOn.nMinAnalytical === fx.nMin, `D43.13 ${name}: N_min identical in both modes (${fx.nMin})`, `off=${rOff.nMinAnalytical} on=${rOn.nMinAnalytical}`);
      assert(rOff.recommendedHC === fx.off[0] && rOff.staffing.grossHCTotal === fx.off[1], `D43.13 ${name}: fairness OFF reproduces the original recommended/gross HC (${fx.off[0]}/${fx.off[1]})`, `got ${rOff.recommendedHC}/${rOff.staffing.grossHCTotal}`);
      assert(rOn.recommendedHC === fx.on[0] && rOn.staffing.grossHCTotal === fx.on[1], `D43.13 ${name}: fairness ON (default) pins recommended/gross HC (${fx.on[0]}/${fx.on[1]})`, `got ${rOn.recommendedHC}/${rOn.staffing.grossHCTotal}`);
    }
    const asyncOff = await searchOptimalHCAsync({ ...pinFx.pooled.p, dispatchFairness: { enabled: false } });
    assert(asyncOff.recommendedHC === 13 && asyncOff.staffing.grossHCTotal === 16, 'D43.13 async path honours the OFF toggle identically (D42.1 13/16)', `got ${asyncOff.recommendedHC}/${asyncOff.staffing.grossHCTotal}`);
  }

  // --- D43.14: OFF is the exact legacy dispatch — timing digests equal the pre-change engine, including the
  // 24x7 scenario where daily budgets bind (30 parked cases) and ON legitimately differs -------------------
  {
    const GOLDEN_OFF: Record<string, number> = { ...GOLDEN_TIMES, c247: 3849299782 };
    for (const [name, golden] of Object.entries(GOLDEN_OFF)) {
      const d = run43((scn43 as any)[name](), { dispatchFairness: { enabled: false } });
      assert(timesDigest43(d) === golden, `D43.14 ${name}: fairness OFF timing identical to the pre-change engine`, `digest=${timesDigest43(d)} golden=${golden}`);
    }
    const on247 = run43(scn43.c247());
    assert(timesDigest43(on247) !== 3849299782 && (on247.caseResults as any[]).filter((c) => c.parkCount > 0).length === 0, 'D43.14 control: ON differs from legacy where budgets bind (fair use of budget parks 0 of the 30 cases legacy parked)', '');
    const offRun = run43(scn43.uniform(), { dispatchFairness: { enabled: false } });
    assert((offRun as any).agentFairness?.config?.enabled === false && (run43(scn43.uniform()) as any).agentFairness?.config?.enabled === true, 'D43.14 agentFairness reports which mode ran (OFF explicit, ON default)', '');
  }
}

// =================================================================
// Suite D44 — No double-booking in gated 24x7 runs (PRD P0-6)
//
// Defect (GATED-DOUBLE-BOOK): the daily idle rebuild in AgentAvailable used
// `agentState[i] === 'idle' || skipCaseResultsAndTimeline`. agentState is only tracked in audit
// runs, so in gated runs (skipCaseResultsAndTimeline = true — every CI-gate replication) an
// unstaggered 24x7 agent still processing a case at midnight re-entered the idle pool and was
// assigned a second case. Fix: eligibility comes from the mode-independent agentActive flag
// (the same source the coverage sampler uses), shared by both branches.
// Pre-fix, D44.1 fails (measured 41 / 12 / 10 / 28 double bookings on earlier fixtures) and
// D44.2 fails in legacy (OFF) mode, where gated and audit results diverged.
// =================================================================
console.log('\n--- Suite D44: no double-booking in gated 24x7 runs ---');
{
  const LAB247: LaborConfig = { dailyProductiveHours: 8, adherencePct: 1.0, workingDaysPerWeek: 7, offDaysPerWeek: 0, contractualHoursSource: 'derived', shifts: [] };
  const sla247 = (hours: number): SLAPolicyConfig => ({
    primaryPct: 80, primaryWindow: hours, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'arrival',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 95,
  });
  const iv247 = (vols: Record<string, number>): StandardInterval[] => {
    const out: StandardInterval[] = [];
    let idx = 0;
    for (let d = 0; d < 10; d++) {
      for (let h = 0; h < 24; h++) {
        for (const m of [0, 30]) {
          for (const [category, volume] of Object.entries(vols)) {
            out.push({ intervalIndex: idx++, start: new Date(2026, 9, 5 + d, h, m), end: new Date(2026, 9, 5 + d, h, m + 30), volume, category });
          }
        }
      }
    }
    return out;
  };
  const mk247 = (arch: 'pooled' | 'siloed', aht: number, hours: number) => ({
    operationalHC: 8, intervals: arch === 'pooled' ? iv247({ General: aht === 30 ? 2 : 1 }) : iv247({ A: 1, B: 1 }),
    openingWIP: [], categories: arch === 'pooled' ? [{ id: 'g', name: 'General', ahtMinutes: aht, shrinkagePct: 0.2, priority: 1 }] : [{ id: 'a', name: 'A', ahtMinutes: aht, shrinkagePct: 0.2, priority: 1 }, { id: 'b', name: 'B', ahtMinutes: aht, shrinkagePct: 0.2, priority: 2 }],
    calendar: CAL_24X7, labor: LAB247, sla: sla247(hours), seed: 42, queueArchitecture: arch,
  });

  // D44.1: no assignment to an agent that is already processing a case (gated runs)
  for (const arch of ['pooled', 'siloed'] as const) {
    for (const enabled of [true, false]) {
      const total = [30, 45, 60].reduce((acc, aht) => acc + runBackofficeDES({ ...mk247(arch, aht, 4), dispatchFairness: { enabled }, skipCaseResultsAndTimeline: true }).doubleBookedAssignments, 0);
      assert(total === 0, `D44.1 ${arch}, fair assignment ${enabled ? 'ON' : 'OFF'}: gated 24x7 run never assigns a case to an agent that is already processing one`, `doubleBookedAssignments=${total}`);
    }
  }
  // D44.1b control: audit runs were never affected (agentState tracked there)
  const auditDbl = runBackofficeDES({ ...mk247('pooled', 30, 4), dispatchFairness: { enabled: false } });
  assert(auditDbl.doubleBookedAssignments === 0, 'D44.1b control: audit (full) run has zero double bookings', `got ${auditDbl.doubleBookedAssignments}`);

  // D44.2: gated and audit runs now agree (they diverged when gated runs double-booked)
  let worst = '';
  for (const arch of ['pooled', 'siloed'] as const) {
    for (const enabled of [true, false]) {
      for (const [aht, hours] of [[30, 2], [60, 2], [60, 4]] as const) {
        const p = { ...mk247(arch, aht, hours), dispatchFairness: { enabled } };
        const a = runBackofficeDES(p), g = runBackofficeDES({ ...p, skipCaseResultsAndTimeline: true });
        if (a.primaryAchievedPct !== g.primaryAchievedPct || a.completedCases !== g.completedCases || Math.abs(a.totalHandlingMinutes - g.totalHandlingMinutes) > 1e-6 || a.boAsaMeanMinutes !== g.boAsaMeanMinutes) {
          worst = `${arch} fair=${enabled} aht=${aht} win=${hours}h audit ${a.primaryAchievedPct}%/asa ${a.boAsaMeanMinutes} vs gated ${g.primaryAchievedPct}%/asa ${g.boAsaMeanMinutes}`;
        }
      }
    }
  }
  assert(worst === '', 'D44.2 gated and audit runs agree on SLA, completions, handling minutes and ASA for unstaggered 24x7 (pooled + siloed, fair ON + OFF)', worst);
}

// =================================================================
// Suite D45 — Per-agent availableMinutes accrual (single path)
//
// Defect (AVAIL-DOUBLE-COUNT): for agents already on shift at horizonStart the first day's
// availability window was pre-seeded AND folded again by the AgentAvailable handler firing at
// the same instant (horizon starting exactly at business open / a cohort's slap start), so
// availableMinutes (Results panel + the fair cascade's utilisation) over-counted day 1
// (e.g. 3300 instead of 2850). Expected value is derived here independently, from the
// calendar, the cohort's own shift window and the simulated span taken from the timeline.
// Pre-fix D45.1 fails on the horizon-at-open fixtures; the mid-day-start fixtures are controls.
// =================================================================
console.log('\n--- Suite D45: availableMinutes accrual ---');
{
  const BIZ45: CalendarConfig = { workingDays: [1, 2, 3, 4, 5], dailyOpenHour: 9, dailyOpenMinute: 0, dailyCloseHour: 17, dailyCloseMinute: 0, holidays: [] };
  const LAB45: LaborConfig = { dailyProductiveHours: 8, adherencePct: 1.0, workingDaysPerWeek: 5, offDaysPerWeek: 2, contractualHoursSource: 'derived', shifts: [] };
  const SLA45: SLAPolicyConfig = {
    primaryPct: 80, primaryWindow: 3, primaryUnit: 'days', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'arrival',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 95,
  };
  const cat45: CategoryConfig[] = [{ id: 'g', name: 'General', ahtMinutes: 20, shrinkagePct: 0.2, priority: 1 }];
  const iv45 = (days: number, fromH: number, toH: number, vol: number, cal: CalendarConfig): StandardInterval[] => {
    const out: StandardInterval[] = [];
    let idx = 0;
    for (let d = 0; d < days; d++) {
      if (!cal.workingDays.includes(new Date(2026, 9, 5 + d).getDay())) continue;
      for (let h = fromH; h < toH; h++) for (const m of [0, 30]) {
        out.push({ intervalIndex: idx++, start: new Date(2026, 9, 5 + d, h, m), end: new Date(2026, 9, 5 + d, h, m + 30), volume: vol, category: 'General' });
      }
    }
    return out;
  };
  const cohorts = (counts: Array<[number, number]>): ShiftDistributionByCategory => ({ __POOLED__: { slapMinutes: 30, slaps: counts.map(([o, n]) => ({ startMinutesFromOpen: o, agentCount: n })) } });

  // expected on-shift minutes per agent, independent of the engine's accrual
  function expectedAvail(des: any, cal: CalendarConfig, is24: boolean, shiftLenMin: number | null, offsets: number[] | null): number[] {
    const hs = des.horizonStart.getTime();
    const simEnd = Math.max(...(des.agentTimeline as any[]).map((s) => s.to.getTime()));
    const out: number[] = [];
    for (let a = 0; a < des.operationalHC; a++) {
      let total = 0;
      const d0 = new Date(hs); d0.setHours(0, 0, 0, 0);
      for (let day = new Date(d0); day.getTime() <= simEnd; day.setDate(day.getDate() + 1)) {
        if (!cal.workingDays.includes(day.getDay())) continue;
        const open = new Date(day); open.setHours(is24 ? 0 : cal.dailyOpenHour, 0, 0, 0);
        const close = new Date(day); if (is24) close.setDate(close.getDate() + 1); close.setHours(is24 ? 0 : cal.dailyCloseHour, 0, 0, 0);
        const off = offsets ? offsets[a] : 0;
        const start = open.getTime() + off * 60000;
        const end = shiftLenMin === null ? close.getTime() : Math.min(close.getTime(), start + shiftLenMin * 60000);
        const lo = Math.max(start, hs), hi = Math.min(end, simEnd);
        if (hi > lo) total += (hi - lo) / 60000;
      }
      out.push(total);
    }
    return out;
  }
  const check45 = (label: string, des: any, exp: number[]) => {
    const rows = des.agentFairness.perAgent as any[];
    let bad = '';
    for (let a = 0; a < rows.length; a++) if (Math.abs(rows[a].availableMinutes - exp[a]) > 0.01) { bad = `agent ${a}: reported ${rows[a].availableMinutes} expected ${exp[a]}`; break; }
    assert(bad === '', label, bad);
  };

  // uniform, horizon starts exactly at business open (the reported over-count case)
  const uni45 = runBackofficeDES({ operationalHC: 6, intervals: iv45(14, 9, 15, 6, BIZ45), openingWIP: [], categories: cat45, calendar: BIZ45, labor: LAB45, sla: SLA45, seed: 42 });
  check45('D45.1a uniform, horizon at business open: availableMinutes == own on-shift minutes', uni45, expectedAvail(uni45, BIZ45, false, null, null));
  // staggered incl. a late coverage-repair-style cohort, horizon at open
  const stagOpen = runBackofficeDES({ operationalHC: 7, intervals: iv45(14, 9, 17, 6, BIZ45), openingWIP: [], categories: cat45, calendar: BIZ45, labor: { ...LAB45, dailyProductiveHours: 6 }, sla: SLA45, seed: 42, shiftDistribution: cohorts([[0, 6], [120, 1]]) });
  check45('D45.1b staggered (6 agents at open + 1 late cohort), horizon at open', stagOpen, expectedAvail(stagOpen, BIZ45, false, 360, [0, 0, 0, 0, 0, 0, 120]));
  // staggered, horizon starts MID-day (control — pre-seed path only)
  const stagMid = runBackofficeDES({ operationalHC: 4, intervals: iv45(3, 13, 17, 4, BIZ45), openingWIP: [], categories: cat45, calendar: BIZ45, labor: { ...LAB45, dailyProductiveHours: 6 }, sla: SLA45, seed: 42, shiftDistribution: cohorts([[0, 2], [120, 2]]) });
  check45('D45.1c control: staggered, horizon starts mid-day (13:00)', stagMid, expectedAvail(stagMid, BIZ45, false, 360, [0, 0, 120, 120]));
  // uniform, horizon starts mid-day (control)
  const uniMid = runBackofficeDES({ operationalHC: 4, intervals: iv45(3, 13, 17, 4, BIZ45), openingWIP: [], categories: cat45, calendar: BIZ45, labor: LAB45, sla: SLA45, seed: 42 });
  check45('D45.1d control: uniform, horizon starts mid-day', uniMid, expectedAvail(uniMid, BIZ45, false, null, null));
  // 24x7 (horizon at midnight = open), uniform and staggered
  const CAL247_45: CalendarConfig = { is24x7: true, workingDays: [0, 1, 2, 3, 4, 5, 6], dailyOpenHour: 0, dailyOpenMinute: 0, dailyCloseHour: 24, dailyCloseMinute: 0, holidays: [] };
  const LAB247_45: LaborConfig = { ...LAB45, workingDaysPerWeek: 7, offDaysPerWeek: 0 };
  const u247 = runBackofficeDES({ operationalHC: 5, intervals: iv45(5, 0, 24, 2, CAL247_45), openingWIP: [], categories: cat45, calendar: CAL247_45, labor: LAB247_45, sla: SLA45, seed: 42 });
  check45('D45.1e 24x7 uniform, horizon at midnight', u247, expectedAvail(u247, CAL247_45, true, null, null));
  const s247 = runBackofficeDES({ operationalHC: 6, intervals: iv45(5, 0, 24, 2, CAL247_45), openingWIP: [], categories: cat45, calendar: CAL247_45, labor: LAB247_45, sla: SLA45, seed: 42, shiftDistribution: cohorts([[0, 2], [480, 2], [960, 2]]) });
  check45('D45.1f 24x7 staggered (3 cohorts of 8h), horizon at midnight', s247, expectedAvail(s247, CAL247_45, true, 480, [0, 0, 480, 480, 960, 960]));
  // OFF mode does not use the accrual for selection but still reports it
  const offRun = runBackofficeDES({ operationalHC: 6, intervals: iv45(14, 9, 15, 6, BIZ45), openingWIP: [], categories: cat45, calendar: BIZ45, labor: LAB45, sla: SLA45, seed: 42, dispatchFairness: { enabled: false } });
  check45('D45.1g fair OFF reports the same correct availability', offRun, expectedAvail(offRun, BIZ45, false, null, null));

  // D45.2: the three built-in samples (Load Sample), run with the app defaults on a fixed Monday.
  // Pins N_min / recommended / gross HC. Fair OFF = the ORIGINAL pre-fairness numbers; fair ON is
  // identical on all six (with the availability double-count fixed, the earlier support-pooled +1
  // disappeared — it was never released).
  const SAMPLE_PINS: Record<string, [number, number, number]> = {
    'claims/pooled': [30, 31, 40], 'claims/siloed': [30, 31, 40],
    'support/pooled': [20, 27, 34], 'support/siloed': [20, 21, 26],
    'healthcare/pooled': [18, 31, 39], 'healthcare/siloed': [18, 27, 34],
  };
  for (const type of ['claims', 'support', 'healthcare'] as const) {
    const { rows } = buildSampleDataset(type, new Date(2026, 9, 5, 8, 0, 0, 0));
    const intervals = mapRawRecordsToIntervals(rows, { intervalStartCol: 'IntervalStart', volumeCol: 'Volume', categoryCol: 'Category' } as any);
    const categories = discoverAndSyncCategories(intervals, DEFAULT_CATEGORIES, DEFAULT_SLA);
    for (const arch of ['pooled', 'siloed'] as const) {
      const p = { intervals, openingWIP: [], categories, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: DEFAULT_SLA, seed: DEFAULT_SIM_PARAMS.seed, userMaxHC: DEFAULT_SIM_PARAMS.maxHCSearch, replications: DEFAULT_SIM_PARAMS.replications, queueArchitecture: arch };
      const pin = SAMPLE_PINS[`${type}/${arch}`];
      for (const enabled of [true, false]) {
        const r = searchOptimalHC({ ...p, dispatchFairness: { enabled } });
        const got = [r.nMinAnalytical, r.recommendedHC, r.staffing.grossHCTotal];
        assert(got.join('/') === pin.join('/'), `D45.2 sample ${type} ${arch}, fair ${enabled ? 'ON' : 'OFF'}: N_min/rec/gross = ${pin.join('/')}`, `got ${got.join('/')}`);
      }
    }
  }
}

// =================================================================
// Suite D46 — Coverage presence = inside the agent's own shift window (C6, PRD P0-5)
//
// Coverage used to count an agent present only while daily BUDGET remained (or while busy).
// At adherence 0.98 the budget (470.4 min) is shorter than the 480-min shift, so a saturated
// late cohort "left" ~9.6 min before close and repair could never pass on real files. Presence
// is now purely clock-based: dayOpen + startOffset <= t < dayOpen + startOffset + shiftLength.
// Budget still caps WORK; dispatch eligibility is unchanged.
// Pre-fix: D46.1, D46.2b, D46.3 (structural) and D46.4 (binding label) fail; D46.5 and the
// 'control' assertions hold before and after (staggered presence already honoured the shift window).
// =================================================================
console.log('\n--- Suite D46: coverage presence = own shift window ---');
{
  const WIN46: CalendarConfig = { workingDays: [1, 2, 3, 4, 5], dailyOpenHour: 8, dailyOpenMinute: 0, dailyCloseHour: 22, dailyCloseMinute: 0, holidays: [] };
  const lab46 = (hours: number, adh: number): LaborConfig => ({ dailyProductiveHours: hours, adherencePct: adh, workingDaysPerWeek: 5, offDaysPerWeek: 2, contractualHoursSource: 'derived', shifts: [] });
  const sla46: SLAPolicyConfig = {
    primaryPct: 50, primaryWindow: 5, primaryUnit: 'days', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'arrival',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 95, minCoverageEnabled: true, minAgentsPerInterval: 1,
  };
  const cat46: CategoryConfig[] = [{ id: 'g', name: 'General', ahtMinutes: 20, shrinkagePct: 0.2, priority: 1 }];
  const iv46 = (days: number, volPerHalfHour: number): StandardInterval[] => {
    const out: StandardInterval[] = [];
    let idx = 0;
    for (let d = 0; d < days; d++) {
      for (let h = 8; h < 22; h++) for (const m of [0, 30]) {
        out.push({ intervalIndex: idx++, start: new Date(2026, 9, 5 + d, h, m), end: new Date(2026, 9, 5 + d, h, m + 30), volume: volPerHalfHour, category: 'General' });
      }
    }
    return out;
  };
  const dist46 = (counts: Array<[number, number]>): ShiftDistributionByCategory => ({ __POOLED__: { slapMinutes: 30, slaps: counts.map(([o, n]) => ({ startMinutesFromOpen: o, agentCount: n })) } });
  const run46 = (hc: number, hours: number, adh: number, vol: number, sd?: ShiftDistributionByCategory) =>
    runBackofficeDES({ operationalHC: hc, intervals: iv46(3, vol), openingWIP: [], categories: cat46, calendar: WIN46, labor: lab46(hours, adh), sla: sla46, seed: 42, shiftDistribution: sd });

  // D46.1: a saturated late-cohort agent whose budget ends before its shift end is still present
  // until shift end. 2 agents (08:00 + 14:00 cohorts), adherence 0.98 => budget 470.4 < 480 shift;
  // 56 cases/day of 20 min saturates both, so the late agent works until its budget is gone.
  {
    const r = run46(2, 8, 0.98, 2, dist46([[0, 1], [360, 1]]));
    assert(r.minCoverageObserved >= 1 && r.passesCoverage, 'D46.1 late-cohort agent whose budget ends before shift end still counts present until shift end (min coverage >= 1)', `minCoverageObserved=${r.minCoverageObserved}`);
  }

  // D46.2: adherence 0.98, 14h window: repair distribution passes coverage at N=2 (the minimum
  // that can tile the window), and the search recommends a plausible N.
  {
    const cw = undefined;
    const repair = buildCoverageRepairDistribution({ n: 2, calendar: WIN46, labor: lab46(8, 0.98), minAgentsPerInterval: 1, queueArchitecture: 'pooled', categoryWorkloadMinutes: cw });
    assert(!!repair, 'D46.2a repair distribution exists at N=2', '');
    const r = run46(2, 8, 0.98, 2, repair ?? undefined);
    assert(r.passesCoverage, 'D46.2b saturated adherence-0.98 fixture: repair at N=2 passes coverage', `minCoverageObserved=${r.minCoverageObserved}`);
    const s = searchOptimalHC({ intervals: iv46(3, 2), openingWIP: [], categories: cat46, calendar: WIN46, labor: lab46(8, 0.98), sla: sla46, seed: 42, userMaxHC: 40, replications: 3 });
    assert(s.recommendedHC !== null && s.recommendedHC <= 4, 'D46.2c control: search recommends a plausible N (<= 4) for a 2-agent-sized load with coverage on', `recommendedHC=${s.recommendedHC}`);
  }

  // D46.3: uniform placement with an open day longer than the shift fails coverage for any N
  // (structural) — extra agents cannot manufacture presence after the shift ends.
  for (const hc of [1, 5, 20]) {
    const r = run46(hc, 8, 1.0, 0.2);
    assert(r.minCoverageObserved === 0 && !r.passesCoverage, `D46.3 uniform, 14h window, 8h shift, N=${hc}: coverage fails structurally (agents gone after 16:00)`, `minCoverageObserved=${r.minCoverageObserved}`);
  }
  {
    const r = run46(5, 14, 1.0, 0.2);
    assert(r.minCoverageObserved >= 1 && r.passesCoverage, 'D46.3b control: uniform with shift length == open day passes coverage', `minCoverageObserved=${r.minCoverageObserved}`);
  }

  // D46.4: when coverage is what sets the recommendation, the binding constraint says so — in both
  // the sync and async search. Load is light enough that SLA/occupancy pass at N=1 (analytic floor
  // 1) but one agent can never cover a 14h window with 8h shifts, so the search must climb to 2 and
  // the N-1 candidate fails coverage ONLY. Controls: SLA-driven and floor-driven runs keep their labels.
  {
    const p46 = { openingWIP: [], categories: cat46, calendar: WIN46, labor: lab46(8, 0.98), sla: sla46, seed: 42, userMaxHC: 40, replications: 3 };
    const syncCov = searchOptimalHC({ ...p46, intervals: iv46(3, 0.2) });
    const asyncCov = await searchOptimalHCAsync({ ...p46, intervals: iv46(3, 0.2) });
    assert(syncCov.recommendedHC === 2 && syncCov.bindingConstraintType === 'min_coverage' && /coverage/i.test(syncCov.bindingConstraintDescription ?? ''), 'D46.4a sync: coverage-bound recommendation (N=2, floor 1) reports bindingConstraintType min_coverage', `rec=${syncCov.recommendedHC} type=${syncCov.bindingConstraintType} desc=${syncCov.bindingConstraintDescription}`);
    assert(asyncCov.recommendedHC === syncCov.recommendedHC && asyncCov.bindingConstraintType === syncCov.bindingConstraintType && asyncCov.bindingConstraintDescription === syncCov.bindingConstraintDescription, 'D46.4b async reports the identical recommendation and binding constraint', `async type=${asyncCov.bindingConstraintType}`);
    const noCov = searchOptimalHC({ ...p46, intervals: iv46(3, 0.2), sla: { ...sla46, minCoverageEnabled: false } });
    assert(noCov.recommendedHC === 1 && noCov.bindingConstraintType !== 'min_coverage', 'D46.4c control: coverage gate OFF recommends N=1 and never reports min_coverage', `rec=${noCov.recommendedHC} type=${noCov.bindingConstraintType}`);
    const floorBound = searchOptimalHC({ ...p46, intervals: iv46(3, 4) });
    assert(floorBound.bindingConstraintType !== 'min_coverage', 'D46.4d control: load-driven recommendation is not labelled coverage', `type=${floorBound.bindingConstraintType}`);
  }

  // D46.5: an agent outside its shift window is never counted present, even with budget left.
  // 6h shifts at 08:00 and 16:00 leave 14:00-16:00 uncovered (light demand, budgets untouched).
  {
    const r = run46(2, 6, 1.0, 0.2, dist46([[0, 1], [480, 1]]));
    assert(r.minCoverageObserved === 0 && !r.passesCoverage, 'D46.5 gap between two 6h shifts (14:00-16:00) is a coverage failure even though both agents have unused budget', `minCoverageObserved=${r.minCoverageObserved}`);
    const ok = run46(3, 6, 1.0, 0.2, dist46([[0, 1], [360, 1], [480, 1]]));
    assert(ok.minCoverageObserved >= 1 && ok.passesCoverage, 'D46.5b control: 6h shifts at 08:00, 14:00 and 16:00 tile 08:00-22:00 without a gap', `minCoverageObserved=${ok.minCoverageObserved}`);
  }
}

// =================================================================
// Suite D47 — N_min workload-floor toggle (frozen decision #4 amended 2026-09-30)
//
// nMinFloorEnabled undefined/true (default) = today's behavior byte-for-byte: N_min and N_occ are
// the hard search floor. false = the search may walk below both when every gate still passes;
// belowWorkloadFloor flags the result. resolveSearchBounds is the ONE helper both searches use.
// Pre-fix: resolveSearchBounds / belowWorkloadFloor / the OFF walk-down do not exist.
// =================================================================
console.log('\n--- Suite D47: N_min floor toggle ---');
{
  const rsb47 = (hcNs as any).resolveSearchBounds as ((p: any) => { startN: number; floorN: number; capInfeasible: boolean }) | undefined;
  assert(typeof rsb47 === 'function', 'D47.0 resolveSearchBounds is exported from hc-search', '');
  if (typeof rsb47 === 'function') {
    const on = rsb47({ nMinFloorEnabled: true, nMinAnalytical: 10, occupancyFeasibleFloor: 11, searchCap: 50 });
    assert(on.startN === 11 && on.floorN === 11 && on.capInfeasible === false, 'D47.0a ON: startN=max(nMin,nOcc), floorN=startN, cap ok', JSON.stringify(on));
    const onCap = rsb47({ nMinFloorEnabled: true, nMinAnalytical: 10, occupancyFeasibleFloor: 11, searchCap: 6 });
    assert(onCap.startN === 6 && onCap.floorN === 6 && onCap.capInfeasible === true, 'D47.0b ON: nMin > cap -> capInfeasible, startN clamped to cap', JSON.stringify(onCap));
    const offB = rsb47({ nMinFloorEnabled: false, nMinAnalytical: 10, occupancyFeasibleFloor: 11, searchCap: 6 });
    assert(offB.startN === 6 && offB.floorN === 1 && offB.capInfeasible === false, 'D47.0c OFF: same startN, floorN=1, never capInfeasible', JSON.stringify(offB));
    const undef = rsb47({ nMinFloorEnabled: undefined, nMinAnalytical: 3, occupancyFeasibleFloor: 0, searchCap: 50 });
    assert(undef.startN === 3 && undef.floorN === 3, 'D47.0d undefined behaves as ON', JSON.stringify(undef));
  }

  // T1_A5 fixture (trusted-source scenario_T1_A5_search_floor_binding): 5 days x 160 cases x 30min,
  // 8h window, 80% target, N_min = 10 and HC=10 already gives 100%.
  const iv47 = (perDay: number): StandardInterval[] => [0, 1, 2, 3, 4].map((d) => ({ intervalIndex: d, start: new Date(2026, 9, 5 + d, 9, 0), end: new Date(2026, 9, 5 + d, 9, 30), volume: perDay, category: 'General' }));
  const cat47: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1 }];
  const sla47: SLAPolicyConfig = {
    primaryPct: 80, primaryWindow: 8, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'arrival',
    occupancyCapEnabled: false, occupancyCapPct: 85, confidenceLevelPct: 95,
  };
  const p47 = (perDay: number, sla: SLAPolicyConfig, extra: Record<string, unknown> = {}) => ({
    intervals: iv47(perDay), openingWIP: [], categories: cat47, calendar: BIZ_CAL, labor: LABOR, sla, seed: 777, userMaxHC: 50, replications: 1, ...extra,
  });
  const slaOff47 = { ...sla47, nMinFloorEnabled: false } as SLAPolicyConfig;

  // (a) omitted vs explicit true
  const omitted = searchOptimalHC(p47(160, sla47));
  const explicitOn = searchOptimalHC(p47(160, { ...sla47, nMinFloorEnabled: true } as SLAPolicyConfig));
  assert(
    omitted.recommendedHC === explicitOn.recommendedHC && omitted.nMinAnalytical === explicitOn.nMinAnalytical &&
      omitted.bindingConstraintType === explicitOn.bindingConstraintType && omitted.bindingConstraintDescription === explicitOn.bindingConstraintDescription,
    'D47.1a nMinFloorEnabled omitted vs true: identical recommendedHC / nMin / binding', `omitted=${omitted.recommendedHC}/${omitted.bindingConstraintType} on=${explicitOn.recommendedHC}/${explicitOn.bindingConstraintType}`
  );
  assert(omitted.recommendedHC === 10 && omitted.nMinAnalytical === 10 && omitted.bindingConstraintType === 'analytical_baseline', 'D47.1b default ON pins T1_A5: HC=10, N_min=10, analytical_baseline', `rec=${omitted.recommendedHC} type=${omitted.bindingConstraintType}`);
  assert(!(omitted as any).belowWorkloadFloor && !(explicitOn as any).belowWorkloadFloor, 'D47.1c floor ON: belowWorkloadFloor is falsy', '');

  // (b) OFF walks below N_min. On the plain T1_A5 fixture it cannot: occupancy is demand / planned
  // capacity (frozen decision #3), so N=9 sits at 111% and fails the always-on 100% ceiling, and
  // N_min = N_occ = 10 coincide. A floor only bites when N_min > N_occ, e.g. a contractual-hours
  // override smaller than the hours the DES delivers (30h vs 40h): N_min = floor(400/30) = 13
  // while the occupancy-feasible floor stays 10.
  const offPlain = searchOptimalHC(p47(160, slaOff47));
  assert(offPlain.recommendedHC === 10 && !offPlain.belowWorkloadFloor, 'D47.2p control: plain T1_A5 OFF stays at 10 (occupancy fails at 9) and is not flagged', `rec=${offPlain.recommendedHC} flag=${offPlain.belowWorkloadFloor}`);
  const LAB47: LaborConfig = { ...LABOR, contractualHoursSource: 'override', contractualProductiveHoursOverride: 30 };
  const onOv = searchOptimalHC(p47(160, sla47, { labor: LAB47 }));
  assert(onOv.nMinAnalytical === 13 && onOv.recommendedHC === 13 && onOv.bindingConstraintType === 'analytical_baseline' && !onOv.belowWorkloadFloor, 'D47.2 control: override fixture, floor ON: N_min = 13, recommendedHC = 13 (analytical_baseline), not flagged', `nMin=${onOv.nMinAnalytical} rec=${onOv.recommendedHC} type=${onOv.bindingConstraintType}`);
  const off = searchOptimalHC(p47(160, slaOff47, { labor: LAB47 }));
  assert(off.recommendedHC !== null && off.recommendedHC < off.nMinAnalytical, 'D47.2a floor OFF: recommendedHC < N_min on the override fixture', `rec=${off.recommendedHC} nMin=${off.nMinAnalytical}`);
  {
    const below = off.searchHistory.find((h) => h.hc === (off.recommendedHC ?? 0) - 1);
    assert(!!below && below.passed === false, 'D47.2b floor OFF: recommendedHC-1 was evaluated at full R and failed', `entry=${JSON.stringify(below)}`);
    assert(off.belowWorkloadFloor === true, 'D47.2c floor OFF: belowWorkloadFloor === true', `got ${off.belowWorkloadFloor}`);
    assert(off.bindingConstraintType !== 'analytical_baseline', 'D47.2d floor OFF: binding label is not the N_min floor label', `type=${off.bindingConstraintType}`);
    assert((off.recommendedHC ?? 99) < (onOv.recommendedHC ?? 0), 'D47.2e OFF recommends fewer agents than ON (13)', `off=${off.recommendedHC} on=${onOv.recommendedHC}`);
  }

  // (c) sync === async under OFF
  {
    const asyncOff = await searchOptimalHCAsync(p47(160, slaOff47, { labor: LAB47 }));
    assert(
      asyncOff.recommendedHC === off.recommendedHC && asyncOff.bindingConstraintType === off.bindingConstraintType &&
        asyncOff.bindingConstraintDescription === off.bindingConstraintDescription && (asyncOff as any).belowWorkloadFloor === (off as any).belowWorkloadFloor &&
        asyncOff.searchHistory.map((h) => `${h.hc}:${h.passed}`).join(',') === off.searchHistory.map((h) => `${h.hc}:${h.passed}`).join(','),
      'D47.3a sync === async under floor OFF (recommendedHC, binding, flag, evaluated history)', `sync=${off.recommendedHC} async=${asyncOff.recommendedHC}`
    );
    const asyncOn = await searchOptimalHCAsync(p47(160, sla47, { labor: LAB47 }));
    assert(asyncOn.recommendedHC === onOv.recommendedHC && asyncOn.bindingConstraintType === onOv.bindingConstraintType, 'D47.3b sync === async under floor ON (default)', `sync=${onOv.recommendedHC} async=${asyncOn.recommendedHC}`);
  }

  // (d) OFF <= ON across a volume sweep
  {
    const bad: string[] = [];
    for (const v of [40, 80, 120, 160, 200]) {
      const o = searchOptimalHC(p47(v, sla47, { labor: LAB47 }));
      const f = searchOptimalHC(p47(v, slaOff47, { labor: LAB47 }));
      if ((f.recommendedHC ?? Infinity) > (o.recommendedHC ?? Infinity)) bad.push(`v=${v} on=${o.recommendedHC} off=${f.recommendedHC}`);
    }
    assert(bad.length === 0, 'D47.4 volume sweep: OFF recommendedHC <= ON recommendedHC', bad.join('; '));
  }

  // (e) OFF with a user cap below N_min is not rejected on the baseline alone
  {
    const on = searchOptimalHC(p47(160, sla47, { userMaxHC: 6, labor: LAB47 }));
    const offCap = searchOptimalHC(p47(160, slaOff47, { userMaxHC: 6, labor: LAB47 }));
    assert(on.isInfeasible && /strictly exceeds/.test(on.infeasibleReason ?? ''), 'D47.5a control: ON with cap < N_min is infeasible via the baseline check', `reason=${on.infeasibleReason}`);
    assert(!/strictly exceeds/.test(offCap.infeasibleReason ?? ''), 'D47.5b OFF with cap < N_min is not infeasible via the baselineExceedsCap path', `reason=${offCap.infeasibleReason}`);
    const offCapAsync = await searchOptimalHCAsync(p47(160, slaOff47, { userMaxHC: 6, labor: LAB47 }));
    assert(offCapAsync.recommendedHC === offCap.recommendedHC && offCapAsync.isInfeasible === offCap.isInfeasible, 'D47.5c async agrees with sync for OFF + cap < N_min', `sync=${offCap.recommendedHC} async=${offCapAsync.recommendedHC}`);
  }
}

// =================================================================
// Suite D48 — SLA clock start derived from the clock basis (approved 2026-09-30)
//
// business_time => clock always starts at the next open business moment (stored value ignored;
// addWorkingTime already starts at nextOpen, so this is HC-neutral). wall_clock => the stored
// policy, default 'arrival'. resolveClockStartPolicy is the single read site in
// generateCaseEntities.
// Pre-fix: resolveClockStartPolicy does not exist; DEFAULT_SLA.clockStartPolicy is 'arrival'.
// =================================================================
console.log('\n--- Suite D48: clock start derived from clock basis ---');
{
  const resolve48 = (desNs as any).resolveClockStartPolicy as ((s: SLAPolicyConfig) => string) | undefined;
  const base48: SLAPolicyConfig = { ...DEFAULT_SLA, primaryPct: 80, primaryWindow: 6, primaryUnit: 'hours', occupancyCapEnabled: false, minCoverageEnabled: false };
  const mk48 = (basis: 'business_time' | 'wall_clock', pol: any): SLAPolicyConfig => ({ ...base48, clockBasis: basis, clockStartPolicy: pol });

  assert(typeof resolve48 === 'function', 'D48.0 resolveClockStartPolicy is exported from des-engine', '');
  if (typeof resolve48 === 'function') {
    assert(resolve48(mk48('business_time', 'arrival')) === 'next_open', 'D48.1a business + stored arrival -> next_open (stored value ignored)', '');
    assert(resolve48(mk48('business_time', 'next_open')) === 'next_open', 'D48.1b business + stored next_open -> next_open', '');
    assert(resolve48(mk48('wall_clock', 'arrival')) === 'arrival', 'D48.1c wall + arrival -> arrival', '');
    assert(resolve48(mk48('wall_clock', 'next_open')) === 'next_open', 'D48.1d wall + next_open -> next_open', '');
    assert(resolve48(mk48('wall_clock', undefined)) === 'arrival', 'D48.1e wall + undefined -> arrival', '');
  }
  assert(DEFAULT_SLA.clockStartPolicy === 'next_open', 'D48.1f DEFAULT_SLA.clockStartPolicy is next_open (matches default business basis)', `got ${DEFAULT_SLA.clockStartPolicy}`);

  // Off-hours arrival: Saturday 10:00-10:30 (calendar closed weekends).
  const offIv: StandardInterval[] = [{ intervalIndex: 0, start: new Date(2026, 9, 10, 10, 0), end: new Date(2026, 9, 10, 10, 30), volume: 4, category: 'General' }];
  const cat48: CategoryConfig[] = [{ id: 'g', name: 'General', ahtMinutes: 20, shrinkagePct: 0.2, priority: 1 }];
  const wip48 = [{ id: 'W1', category: 'General', arrival: new Date(2026, 9, 10, 11, 0), priority: 1 }] as any;
  const deadlines = (sla: SLAPolicyConfig) => {
    const g = generateCaseEntities({ intervals: offIv, openingWIP: wip48, categories: cat48, calendar: BIZ_CAL, sla, seed: 42 });
    return g.cases.map((c) => `${c.id}:${c.clockStart.getTime()}:${c.primaryDeadline.getTime()}`).join('|');
  };
  {
    const a = deadlines(mk48('business_time', 'arrival'));
    const n = deadlines(mk48('business_time', 'next_open'));
    assert(a === n, 'D48.2a business_time: stored arrival vs next_open give identical clockStart + primaryDeadline (demand + opening WIP)', `arrival=${a.slice(0, 120)} next_open=${n.slice(0, 120)}`);
    const first = generateCaseEntities({ intervals: offIv, openingWIP: [], categories: cat48, calendar: BIZ_CAL, sla: mk48('business_time', 'arrival'), seed: 42 }).cases[0];
    assert(first.clockStart.getDay() === 1 && first.clockStart.getHours() === 9, 'D48.2b business_time + stored arrival: Saturday arrival clock starts Monday 09:00', `clockStart=${first.clockStart.toString()}`);
  }
  {
    const a = deadlines(mk48('wall_clock', 'arrival'));
    const n = deadlines(mk48('wall_clock', 'next_open'));
    assert(a !== n, 'D48.3 wall_clock: arrival vs next_open deadlines differ for an off-hours arrival', '');
  }
  // Search parity under business_time (arrivals spread across all 24h incl. weekends).
  {
    const ivs: StandardInterval[] = [];
    let idx = 0;
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h += 6) ivs.push({ intervalIndex: idx++, start: new Date(2026, 9, 5 + d, h, 0), end: new Date(2026, 9, 5 + d, h + 6, 0), volume: 6, category: 'General' });
    const run = (pol: any) => searchOptimalHC({ intervals: ivs, openingWIP: [], categories: cat48, calendar: BIZ_CAL, labor: LABOR, sla: mk48('business_time', pol), seed: 42, userMaxHC: 60, replications: 3 });
    const a = run('arrival');
    const n = run('next_open');
    assert(a.recommendedHC !== null && a.recommendedHC === n.recommendedHC && a.nMinAnalytical === n.nMinAnalytical, 'D48.4 business_time: searchOptimalHC recommendedHC identical for stored arrival vs next_open', `arrival=${a.recommendedHC} next_open=${n.recommendedHC}`);
  }
}

// =================================================================
// Suite D50 — Stage 3b roster polish at fixed HC (placement ON only)
//
// After recommendedHC is decided the roster is re-spread across business hours (coverage floor
// cover seeded into the deficit greedy) and adopted ONLY if every CI gate still passes at the SAME
// HC and coverage strictly improves. HC never moves. Pre-fix: rosterPolish / initialCounts /
// buildPolishedRoster do not exist, so every behavioural assert below fails.
// =================================================================
console.log('\n--- Suite D50: roster polish at fixed HC ---');
{
  const cal50: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 20 };
  const labor50Off: LaborConfig = { ...LABOR, dailyProductiveHours: 8 };
  const labor50On: LaborConfig = { ...labor50Off, shiftPlacementEnabled: true, shiftSlapMinutes: 30 };
  const cat50: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 }];
  const mkIv50 = (volAt: (h: number) => number): StandardInterval[] => {
    const out: StandardInterval[] = [];
    for (let day = 0; day < 5; day++) {
      for (let h = 8; h < 20; h++) {
        for (let m = 0; m < 60; m += 30) {
          out.push({ intervalIndex: out.length, start: new Date(2026, 2, 2 + day, h, m), end: new Date(2026, 2, 2 + day, h, m + 30), volume: volAt(h), category: 'General' });
        }
      }
    }
    return out;
  };
  const mkSla50 = (pct: number, windowH: number): SLAPolicyConfig => ({
    primaryPct: pct, primaryWindow: windowH, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90,
  });
  const run50 = (labor: LaborConfig, ivs: StandardInterval[], sla: SLAPolicyConfig, seed = 42) => ({
    intervals: ivs, openingWIP: [] as any[], categories: cat50, calendar: cal50, labor, sla, seed, userMaxHC: 40, replications: 6,
  });
  const slotsOf = (d: ShiftDistributionByCategory | undefined) => JSON.stringify(d?.__POOLED__?.slaps ?? null);

  // Mid-day peak (12:00-16:00 heavy, light elsewhere): the uniform/repair roster leaves the
  // morning under-covered while the deficit greedy shifts depth to where the work is released.
  const iv50 = mkIv50((h) => (h >= 12 && h < 16 ? 14 : 3));
  const sla50 = mkSla50(85, 3);
  const off50 = searchOptimalHC(run50(labor50Off, iv50, sla50));
  const on50 = searchOptimalHC(run50(labor50On, iv50, sla50));
  const rp = (on50 as any).rosterPolish;

  // D50.1
  assert(rp !== undefined && rp.status === 'adopted', 'D50.1a placement ON, uniform/repair passes: polish adopted', `status=${rp?.status} reason=${rp?.reason}`);
  assert(!!rp?.polished && (rp.polished.minOnShift > rp.current.minOnShift || (rp.polished.minOnShift === rp.current.minOnShift && rp.polished.gapAgentHours < rp.current.gapAgentHours - 1e-9)), 'D50.1b adopted roster improves coverage (higher minOnShift, tie -> lower gap)', `cur=${JSON.stringify(rp?.current)} pol=${JSON.stringify(rp?.polished)}`);
  assert(!!rp?.polished && rp.polished.minOnShift >= 1, 'D50.1c polished roster keeps at least one agent on shift in every bucket', `min=${rp?.polished?.minOnShift}`);

  // D50.2
  assert(on50.recommendedHC === off50.recommendedHC && on50.staffing?.grossHCTotal === off50.staffing?.grossHCTotal, 'D50.2a recommendedHC and grossHCTotal equal the placement-OFF run (sync)', `off=${off50.recommendedHC}/${off50.staffing?.grossHCTotal} on=${on50.recommendedHC}/${on50.staffing?.grossHCTotal}`);
  const on50Async = await searchOptimalHCAsync(run50(labor50On, iv50, sla50));
  assert(on50Async.recommendedHC === off50.recommendedHC && on50Async.staffing?.grossHCTotal === off50.staffing?.grossHCTotal, 'D50.2b recommendedHC and grossHCTotal equal the placement-OFF run (async)', `async=${on50Async.recommendedHC}`);

  // D50.3
  const rpA = (on50Async as any).rosterPolish;
  assert(rpA !== undefined && rpA.status === rp?.status && slotsOf(on50Async.shiftPlacement?.winningDistribution) === slotsOf(on50.shiftPlacement?.winningDistribution), 'D50.3 sync === async: rosterPolish status + adopted distribution', `sync=${rp?.status}/${slotsOf(on50.shiftPlacement?.winningDistribution)} async=${rpA?.status}/${slotsOf(on50Async.shiftPlacement?.winningDistribution)}`);

  // D50.5
  const minCov = on50.finalDESResult?.minCoverageObserved ?? -1;
  assert(rp?.status === 'adopted' && minCov >= 1, 'D50.5 adopted roster satisfies the coverage floor in the audit DES', `status=${rp?.status} minCoverageObserved=${minCov}`);

  // D50.6
  const on50b = searchOptimalHC(run50(labor50On, iv50, sla50));
  assert(rp !== undefined && JSON.stringify((on50b as any).rosterPolish) === JSON.stringify(rp), 'D50.6 same seed twice: identical rosterPolish', '');

  // D50.8
  assert((off50 as any).rosterPolish === undefined, 'D50.8 placement OFF: rosterPolish undefined', '');

  // D50.4 — even the first move toward the coverage roster breaks a gate (tight 97% / 2h target
  // right after a 60-case opening spike): current roster is kept, HC unchanged.
  {
    const ivC = mkIv50((h) => (h === 8 ? 60 : 5));
    const slaC = mkSla50(97, 2);
    const onC = searchOptimalHC(run50(labor50On, ivC, slaC));
    const rpC = (onC as any).rosterPolish;
    const offC = searchOptimalHC(run50(labor50Off, ivC, slaC));
    assert(rpC !== undefined && rpC.status === 'kept_current_failed_gate' && typeof rpC.reason === 'string' && rpC.reason.length > 0 && rpC.movesApplied === 0, 'D50.4a first move fails the gate: status kept_current_failed_gate with reason', `status=${rpC?.status} reason=${rpC?.reason}`);
    // Here the current roster is a placement RESCUE (uniform/repair cannot pass at all: OFF is infeasible),
    // so HC is compared against that existing behaviour by construction, not against OFF.
    assert(offC.recommendedHC === null && onC.recommendedHC !== null, 'D50.4b control: HC still comes from the unchanged search (placement rescue), polish only re-spreads', `off=${offC.recommendedHC} on=${onC.recommendedHC}`);
    const winC = onC.shiftPlacement?.winningDistribution?.__POOLED__?.slaps ?? [];
    const onShiftC = (rpC.profile.bucketStartMinutes as number[]).map((st) => winC.reduce((acc, sl) => (sl.startMinutesFromOpen <= st && st < sl.startMinutesFromOpen + 8 * 60 ? acc + sl.agentCount : acc), 0));
    assert(JSON.stringify(onShiftC) === JSON.stringify(rpC.profile.onShiftCurrent) && slotsOf(onC.finalDESResult?.shiftDistributionUsed) === slotsOf(onC.shiftPlacement?.winningDistribution), 'D50.4c kept-current: final roster (and audit DES roster) is exactly the pre-polish current roster', `final=${JSON.stringify(onShiftC)} current=${JSON.stringify(rpC.profile.onShiftCurrent)}`);
  }

  // D50.9 — the target fails but a partial move passes: adopted_partial with better coverage.
  {
    const ivP = mkIv50((h) => (h === 8 ? 60 : 4));
    const slaP = mkSla50(95, 4);
    const onP = searchOptimalHC(run50(labor50On, ivP, slaP));
    const offP = searchOptimalHC(run50(labor50Off, ivP, slaP));
    const rpP = (onP as any).rosterPolish;
    assert(rpP?.status === 'adopted_partial' && rpP.movesApplied > 0 && rpP.movesApplied < rpP.movesTotal && typeof rpP.reason === 'string' && rpP.reason.length > 0, 'D50.9a partial: 0 < k* < K with the failing reason of the next step', `status=${rpP?.status} ${rpP?.movesApplied}/${rpP?.movesTotal} reason=${rpP?.reason}`);
    assert(!!rpP?.polished && rpP.polished.minOnShift > rpP.current.minOnShift, 'D50.9b partial roster has a strictly higher minOnShift than current', `cur=${rpP?.current?.minOnShift} pol=${rpP?.polished?.minOnShift}`);
    assert(onP.recommendedHC === offP.recommendedHC && onP.staffing?.grossHCTotal === offP.staffing?.grossHCTotal, 'D50.9c partial: HC and gross HC equal placement-OFF', `off=${offP.recommendedHC} on=${onP.recommendedHC}`);
    const onPA = await searchOptimalHCAsync(run50(labor50On, ivP, slaP));
    assert(JSON.stringify((onPA as any).rosterPolish) === JSON.stringify(rpP) && slotsOf(onPA.shiftPlacement?.winningDistribution) === slotsOf(onP.shiftPlacement?.winningDistribution), 'D50.9d partial: sync === async (rosterPolish + adopted roster)', '');
    const onP2 = searchOptimalHC(run50(labor50On, ivP, slaP));
    assert(JSON.stringify((onP2 as any).rosterPolish) === JSON.stringify(rpP), 'D50.9e partial: deterministic across runs', '');
  }

  // D50.10 — the interpolation path and the k-search control (pure helpers).
  {
    const bri = (hcNs as any).buildRosterInterpolation as (p: any) => { moves: Array<{ key: string; from: number; to: number }>; totalMoves: number; rosterAt: (k: number) => any };
    const mkD = (c: Record<number, number>): ShiftDistributionByCategory => ({ __POOLED__: { slapMinutes: 30, slaps: Object.entries(c).map(([o, n]) => ({ startMinutesFromOpen: Number(o), agentCount: n })) } });
    const cur = mkD({ 0: 4, 240: 1 });
    const tgt = mkD({ 0: 1, 30: 1, 240: 3 });
    const it = bri({ current: cur, target: tgt, seats: new Map([['__POOLED__', 5]]), slapMinutes: 30 });
    assert(it.totalMoves === 3 && JSON.stringify(it.moves.map((m) => [m.from, m.to])) === JSON.stringify([[0, 240], [0, 240], [0, 30]]), 'D50.10a move order: largest surplus -> largest deficit (ties: earliest from, latest to)', JSON.stringify(it.moves));
    assert(it.rosterAt(0) === cur, 'D50.10b Roster(0) is the current roster', '');
    const cnt = (d: any) => { const m = new Map<number, number>(); for (const sl of d.__POOLED__.slaps) m.set(sl.startMinutesFromOpen, sl.agentCount); return m; };
    const eqCounts = (x: Map<number, number>, y: Map<number, number>) => { const ks = new Set([...x.keys(), ...y.keys()]); for (const k of ks) if ((x.get(k) || 0) !== (y.get(k) || 0)) return false; return true; };
    assert(eqCounts(cnt(it.rosterAt(3)), cnt(tgt)), 'D50.10c Roster(K) has the target counts', JSON.stringify(it.rosterAt(3)));
    let stepsOk = true;
    for (let k = 1; k <= it.totalMoves; k++) {
      const a = cnt(k === 1 ? cur : it.rosterAt(k - 1));
      const b = cnt(it.rosterAt(k));
      let moved = 0; let total = 0;
      for (const key of new Set([...a.keys(), ...b.keys()])) { const d = (b.get(key) || 0) - (a.get(key) || 0); if (d > 0) moved += d; total += b.get(key) || 0; }
      if (moved !== 1 || total !== 5) stepsOk = false;
    }
    assert(stepsOk, 'D50.10d each step moves exactly one agent and headcount stays 5', '');

    const cks = (hcNs as any).createRosterKSearch as (K: number) => { next: () => number | null; record: (k: number, e: any) => void; result: () => { bestK: number; evals: Map<number, any> } };
    const drive = (K: number, passesAt: (k: number) => boolean) => {
      const ks = cks(K); const order: number[] = [];
      for (let k = ks.next(); k !== null; k = ks.next()) { order.push(k); ks.record(k, { passes: passesAt(k), reasons: [], slaPct: 0 }); }
      return { order, bestK: ks.result().bestK };
    };
    const r1 = drive(7, (k) => k <= 4);
    assert(r1.bestK === 4 && r1.order[0] === 7 && r1.order.length <= Math.ceil(Math.log2(7)) + 1, 'D50.10e k-search: evaluates K first, finds largest passing k within ceil(log2 K)+1 evaluations', JSON.stringify(r1));
    const r2 = drive(7, () => true);
    assert(r2.bestK === 7 && r2.order.length === 1, 'D50.10f k-search: target passing ends after one evaluation', JSON.stringify(r2));
    const r3 = drive(7, () => false);
    assert(r3.bestK === 0 && r3.order.length <= Math.ceil(Math.log2(7)) + 1 && r3.order.includes(1), 'D50.10g k-search: nothing passes -> k*=0 and step 1 was tried', JSON.stringify(r3));
  }

  // D50.7 — no seed === today's placement (explicit no-regression); a seed is honoured.
  {
    const windowLen = 12 * 60;
    const shiftLen = 8 * 60;
    const starts = getValidSlapStarts(cal50, shiftLen, 30);
    const size = Math.ceil(windowLen / 30);
    const matrix = new Float64Array(size * size);
    matrix[0 * size + 7] = 600;
    matrix[12 * size + 23] = 500;
    matrix[6 * size + 15] = 300;
    const g = { gridMinutes: 30, windowLengthMinutes: windowLen, size, matrix, totalWorkMinutes: 1400 };
    const plain = computeShiftPlacement({ grid: g, validStarts: starts, shiftLengthMinutes: shiftLen, n: 6, slapMinutes: 30 });
    const emptySeed = computeShiftPlacement({ grid: g, validStarts: starts, shiftLengthMinutes: shiftLen, n: 6, slapMinutes: 30, initialCounts: new Map() } as any);
    assert(JSON.stringify(plain) === JSON.stringify(emptySeed), 'D50.7a empty seed is byte-identical to no seed', '');
    const seeded = computeShiftPlacement({ grid: g, validStarts: starts, shiftLengthMinutes: shiftLen, n: 6, slapMinutes: 30, initialCounts: new Map([[240, 2]]) } as any);
    const tot = seeded.slaps.reduce((a, s) => a + s.agentCount, 0);
    const at240 = seeded.slaps.find((s) => s.startMinutesFromOpen === 240)?.agentCount ?? 0;
    assert(tot === 6 && at240 >= 2, 'D50.7b seeded run places exactly n agents in total and keeps the seed', JSON.stringify(seeded.slaps));
  }
}

// =================================================================
// Suite D49 — Sample-file guard: test_files/AJM_Only.csv at the app defaults (pooled).
//
// Characterisation pins, not a fix: they freeze the default-setting required-HC of the cheapest
// sample file so any engine change that moves it fails loudly. Values are the "after" baseline in
// docs/audit/sample-hc-after-2026-09-30.jsonl (the full 4-file x 6-cell diff is `npm run test:audit`).
// The file is loaded through scripts/sample-files.ts, the same loader as the audit script.
// =================================================================
console.log('\n--- Suite D49: sample-file guard (AJM_Only.csv, defaults, pooled) ---');
{
  const t0 = Date.now();
  const { intervals: iv49, categories: cats49 } = loadSampleFile('AJM_Only.csv');
  const run49 = (laborOver: Partial<LaborConfig> = {}, slaOver: Partial<SLAPolicyConfig> = {}) =>
    searchOptimalHC({
      intervals: iv49, openingWIP: [], categories: cats49, calendar: DEFAULT_CALENDAR,
      labor: { ...DEFAULT_LABOR, ...laborOver }, sla: { ...DEFAULT_SLA, ...slaOver },
      seed: DEFAULT_SIM_PARAMS.seed, userMaxHC: DEFAULT_SIM_PARAMS.maxHCSearch,
      replications: DEFAULT_SIM_PARAMS.replications, queueArchitecture: 'pooled',
    });
  const rosterStr = (r: any) => { const d = r.finalDESResult?.shiftDistributionUsed?.__POOLED__; return d ? d.slaps.map((sl: any) => `${sl.startMinutesFromOpen}:${sl.agentCount}`).join(' ') : 'uniform'; };

  const ba = run49();
  assert(ba.nMinAnalytical === 9 && ba.occupancyFeasibleFloor === 10, 'D49.1a AJM_Only BA: N_min 9, N_occ 10', `nMin=${ba.nMinAnalytical} nOcc=${ba.occupancyFeasibleFloor}`);
  assert(ba.recommendedHC === 16 && ba.staffing?.grossHCTotal === 20, 'D49.1b AJM_Only BA: recommended HC 16, gross HC 20', `hc=${ba.recommendedHC} gross=${ba.staffing?.grossHCTotal}`);
  assert(ba.finalDESResult?.primaryAchievedPct === 90.1 && ba.bindingConstraintType === 'statistical_primary_sla', 'D49.1c AJM_Only BA: SLA 90.1%, binding statistical_primary_sla', `sla=${ba.finalDESResult?.primaryAchievedPct} binding=${ba.bindingConstraintType}`);

  const foff = run49({}, { nMinFloorEnabled: false } as Partial<SLAPolicyConfig>);
  assert(foff.recommendedHC === 16 && foff.staffing?.grossHCTotal === 20, 'D49.2 AJM_Only FOFF (workload floor OFF): HC 16, gross 20', `hc=${foff.recommendedHC} gross=${foff.staffing?.grossHCTotal}`);

  const pon = run49({ shiftPlacementEnabled: true, shiftSlapMinutes: 30 });
  assert(pon.recommendedHC === 16 && pon.staffing?.grossHCTotal === 20, 'D49.3a AJM_Only PON (placement ON): HC 16, gross 20', `hc=${pon.recommendedHC} gross=${pon.staffing?.grossHCTotal}`);
  assert((pon as any).rosterPolish?.status === 'kept_current_failed_gate' && rosterStr(pon) === '0:15 150:1', 'D49.3b AJM_Only PON: rosterPolish kept_current_failed_gate, winning roster 0:15 150:1', `status=${(pon as any).rosterPolish?.status} roster=${rosterStr(pon)}`);
  console.log(`  (D49 elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

// =================================================================
// Suite D51 — Stage 3b roster polish in SILOED mode (twins of D50.1 / D50.9)
//
// DES facts this pins (verified in des-engine.ts): the min-coverage gate is ORG-WIDE (countAgentsOnShiftNow
// counts every agent, gated against resolveMinAgentsPerInterval(sla, totalHC)), while the seat split is
// per category (allocateAgentsToCategories over each category's representative-case AHT minutes). The
// polish decision therefore adds a per-category guard: adopt only if the org metric improves AND no
// category's minOnShift decreases. Pre-fix: rosterPolish.byCategory and the exported seat-split helper
// do not exist, so the per-category and parity asserts fail.
// =================================================================
console.log('\n--- Suite D51: roster polish, siloed ---');
{
  const cal51: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 20 };
  const labor51Off: LaborConfig = { ...LABOR, dailyProductiveHours: 8 };
  const labor51On: LaborConfig = { ...labor51Off, shiftPlacementEnabled: true, shiftSlapMinutes: 30 };
  const cats51: CategoryConfig[] = [
    { id: 'A', name: 'A', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 },
    { id: 'B', name: 'B', ahtMinutes: 25, shrinkagePct: 0.1, priority: 2 },
  ];
  const mkIv51 = (volA: (h: number) => number, volB: (h: number) => number): StandardInterval[] => {
    const out: StandardInterval[] = [];
    for (let day = 0; day < 5; day++) {
      for (let h = 8; h < 20; h++) {
        for (let m = 0; m < 60; m += 30) {
          for (const [category, f] of [['A', volA], ['B', volB]] as Array<[string, (h: number) => number]>) {
            out.push({ intervalIndex: out.length, start: new Date(2026, 2, 2 + day, h, m), end: new Date(2026, 2, 2 + day, h, m + 30), volume: f(h), category });
          }
        }
      }
    }
    return out;
  };
  const mkSla51 = (pct: number, windowH: number): SLAPolicyConfig => ({
    primaryPct: pct, primaryWindow: windowH, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90,
  });
  const run51 = (labor: LaborConfig, ivs: StandardInterval[], sla: SLAPolicyConfig) => ({
    intervals: ivs, openingWIP: [] as any[], categories: cats51, calendar: cal51, labor, sla, seed: 42, userMaxHC: 60, replications: 6,
    queueArchitecture: 'siloed' as const,
  });
  const distStr = (d: ShiftDistributionByCategory | undefined) => JSON.stringify(d ? Object.keys(d).sort().map((k) => [k, d[k].slaps]) : null);
  const catGuardOk = (rp: any) => {
    const keys = Object.keys(rp?.byCategory ?? {}).sort();
    if (JSON.stringify(keys) !== JSON.stringify(['A', 'B'])) return false;
    return keys.every((k) => rp.byCategory[k].polished && rp.byCategory[k].polished.minOnShift >= rp.byCategory[k].current.minOnShift);
  };

  const checkScenario = async (tag: string, ivs: StandardInterval[], sla: SLAPolicyConfig, wantStatus: 'adopted' | 'adopted_partial') => {
    const off = searchOptimalHC(run51(labor51Off, ivs, sla));
    const on = searchOptimalHC(run51(labor51On, ivs, sla));
    const rp = (on as any).rosterPolish;
    assert(rp?.status === wantStatus, `${tag}a siloed placement ON: polish ${wantStatus}`, `status=${rp?.status} reason=${rp?.reason}`);
    assert(!!rp?.polished && (rp.polished.minOnShift > rp.current.minOnShift || (rp.polished.minOnShift === rp.current.minOnShift && rp.polished.gapAgentHours < rp.current.gapAgentHours - 1e-9)), `${tag}b org-wide coverage improves`, `cur=${JSON.stringify(rp?.current)} pol=${JSON.stringify(rp?.polished)}`);
    assert(catGuardOk(rp), `${tag}c both categories reported and no category's minOnShift decreases`, JSON.stringify(rp?.byCategory));
    assert(on.recommendedHC === off.recommendedHC && on.staffing?.grossHCTotal === off.staffing?.grossHCTotal && on.recommendedHC !== null, `${tag}d HC and gross HC equal placement OFF (sync)`, `off=${off.recommendedHC}/${off.staffing?.grossHCTotal} on=${on.recommendedHC}/${on.staffing?.grossHCTotal}`);
    const onA = await searchOptimalHCAsync(run51(labor51On, ivs, sla));
    assert(onA.recommendedHC === off.recommendedHC && onA.staffing?.grossHCTotal === off.staffing?.grossHCTotal, `${tag}e HC and gross HC equal placement OFF (async)`, `async=${onA.recommendedHC}`);
    assert(JSON.stringify((onA as any).rosterPolish) === JSON.stringify(rp) && distStr(onA.shiftPlacement?.winningDistribution) === distStr(on.shiftPlacement?.winningDistribution), `${tag}f sync === async (rosterPolish incl. byCategory + adopted roster)`, '');
    const on2 = searchOptimalHC(run51(labor51On, ivs, sla));
    assert(JSON.stringify((on2 as any).rosterPolish) === JSON.stringify(rp) && distStr(on2.shiftPlacement?.winningDistribution) === distStr(on.shiftPlacement?.winningDistribution), `${tag}g deterministic across runs`, '');
    const floor = resolveMinAgentsPerInterval(sla, on.recommendedHC ?? 0);
    const minCov = on.finalDESResult?.minCoverageObserved ?? -1;
    assert(floor >= 1 && minCov >= floor, `${tag}h coverage floor (org-wide gate, ${floor}) honoured in the final DES`, `minCoverageObserved=${minCov}`);
    return { on, rp };
  };

  await checkScenario('D51.1', mkIv51((h) => (h >= 12 && h < 16 ? 14 : 3), (h) => (h >= 12 && h < 16 ? 10 : 2)), mkSla51(85, 3), 'adopted');
  const part = await checkScenario('D51.2', mkIv51((h) => (h === 8 ? 60 : 4), (h) => (h === 8 ? 40 : 3)), mkSla51(95, 4), 'adopted_partial');
  assert(part.rp?.movesApplied > 0 && part.rp?.movesApplied < part.rp?.movesTotal, 'D51.2i partial: 0 < k* < K', `${part.rp?.movesApplied}/${part.rp?.movesTotal}`);

  // D51.3 — pooled shape unaffected: no per-category block in a pooled result.
  {
    const ivsP = mkIv51((h) => (h >= 12 && h < 16 ? 14 : 3), () => 0).filter((i) => i.category === 'A');
    const r = searchOptimalHC({ intervals: ivsP, openingWIP: [], categories: [cats51[0]], calendar: cal51, labor: labor51On, sla: mkSla51(85, 3), seed: 42, userMaxHC: 40, replications: 6 });
    assert((r as any).rosterPolish !== undefined && (r as any).rosterPolish.byCategory === undefined, 'D51.3 pooled rosterPolish carries no byCategory block', `keys=${Object.keys((r as any).rosterPolish ?? {})}`);
  }

  // D51.4 — seat-split parity: the polish split IS the DES split (same function, same weights).
  {
    const seatsFn = (hcNs as any).seatsByDistributionKey as ((c: any[], n: number, q: 'pooled' | 'siloed') => Map<string, number>) | undefined;
    assert(typeof seatsFn === 'function', 'D51.4a seatsByDistributionKey is exported for the parity pin', '');
    const ivs = mkIv51((h) => (h >= 12 && h < 16 ? 14 : 3), (h) => (h >= 12 && h < 16 ? 10 : 2));
    const gen = generateCaseEntities({ intervals: ivs, openingWIP: [], categories: cats51, calendar: cal51, sla: mkSla51(85, 3), seed: 42 });
    if (typeof seatsFn === 'function') {
      let allEq = true;
      let firstBad = '';
      for (let n = 1; n <= 40; n++) {
        const w = new Map<string, number>();
        for (const c of cats51) w.set(c.name, 0);
        for (const c of gen.cases) w.set(c.category, (w.get(c.category) || 0) + c.totalAhtMinutes);
        const des = allocateAgentsToCategories(w, n);
        const pol = seatsFn(gen.cases, n, 'siloed');
        const same = [...des.entries()].every(([k, v]) => (pol.get(k) || 0) === v) && [...pol.entries()].every(([k, v]) => (des.get(k) || 0) === v);
        if (!same) { allEq = false; firstBad ||= `n=${n} des=${JSON.stringify([...des])} pol=${JSON.stringify([...pol])}`; }
      }
      assert(allEq, 'D51.4b polish seat split equals the DES seat split for n=1..40', firstBad);
      const n = 17;
      const des = runBackofficeDES({
        operationalHC: n, intervals: ivs, openingWIP: [], categories: cats51, calendar: cal51, labor: labor51Off, sla: mkSla51(85, 3), seed: 42,
        queueArchitecture: 'siloed', precomputedCases: gen,
      });
      const seen = new Map<string, number>();
      for (const row of des.agentFairness?.perAgent ?? []) if (row.category) seen.set(row.category, (seen.get(row.category) || 0) + 1);
      const pol = seatsFn(gen.cases, n, 'siloed');
      assert([...pol.entries()].every(([k, v]) => (seen.get(k) || 0) === v) && [...seen.values()].reduce((a, b) => a + b, 0) === n, 'D51.4c agents the DES actually seated per category equal the polish split', `des=${JSON.stringify([...seen])} pol=${JSON.stringify([...pol])}`);
    }
  }
}

// =================================================================
// Suite D52 — Stage 3b roster polish, SILOED: every queue gets its own best spread
//
// Pre-fix the siloed polish walked ONE name-ordered move path with one global k, so the first
// category (by name) that hit its own SLA limit stopped every later category at its current roster
// (AJM_Simu HC 93: 4 of 5 queues kept 1 agent for the last 2.5 h). Siloed queues are independent in
// the DES (own agents, own queue, CRN arrivals), so each category is binary-searched in PARALLEL
// inside the same evaluations from its own categoryPasses verdict; org-wide gate failures are
// charged to every key that moved up that round; the combined vector is confirmed once and falls
// back to the best fully-passing evaluated vector. Pooled is untouched (D50 stays byte-identical).
// =================================================================
console.log('\n--- Suite D52: roster polish, siloed per-queue parallel search ---');
{
  const cal52: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 20 };
  const labor52Off: LaborConfig = { ...LABOR, dailyProductiveHours: 8 };
  const labor52On: LaborConfig = { ...labor52Off, shiftPlacementEnabled: true, shiftSlapMinutes: 30 };
  // Same 95% / 4h target for both. A: an 08:00 spike -> hits its own SLA limit after a couple of moves (first by name). B: mid-day peak -> can spread further.
  const cats52: CategoryConfig[] = [
    { id: 'A', name: 'A', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 },
    { id: 'B', name: 'B', ahtMinutes: 25, shrinkagePct: 0.1, priority: 2 },
  ];
  const mkIv52 = (): StandardInterval[] => {
    const out: StandardInterval[] = [];
    for (let day = 0; day < 5; day++) {
      for (let h = 8; h < 20; h++) {
        for (let m = 0; m < 60; m += 30) {
          for (const [category, vol] of [['A', h === 8 ? 60 : 4], ['B', h >= 12 && h < 16 ? 10 : 2]] as Array<[string, number]>) {
            out.push({ intervalIndex: out.length, start: new Date(2026, 2, 2 + day, h, m), end: new Date(2026, 2, 2 + day, h, m + 30), volume: vol, category });
          }
        }
      }
    }
    return out;
  };
  const sla52: SLAPolicyConfig = {
    primaryPct: 95, primaryWindow: 4, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90,
  };
  const iv52 = mkIv52();
  const run52 = (labor: LaborConfig) => ({
    intervals: iv52, openingWIP: [] as any[], categories: cats52, calendar: cal52, labor, sla: sla52, seed: 42, userMaxHC: 60, replications: 6,
    queueArchitecture: 'siloed' as const,
  });
  const distStr52 = (d: ShiftDistributionByCategory | undefined) => JSON.stringify(d ? Object.keys(d).sort().map((k) => [k, d[k].slaps]) : null);

  const off52 = searchOptimalHC(run52(labor52Off));
  const on52 = searchOptimalHC(run52(labor52On));
  const rp52 = (on52 as any).rosterPolish;
  const bc = rp52?.byCategory ?? {};

  // D52.1 — the later category spreads further than the first one allows.
  assert(rp52?.status === 'adopted_partial', 'D52.1a siloed placement ON: adopted_partial (A saturates)', `status=${rp52?.status} reason=${rp52?.reason}`);
  assert(bc.A?.polished?.minOnShift > bc.A?.current?.minOnShift, 'D52.1b first-by-name category A still improves its own minOnShift', JSON.stringify(bc.A));
  assert(bc.B?.polished?.minOnShift > bc.B?.current?.minOnShift, 'D52.1c later category B ALSO improves its minOnShift (pre-fix: stuck at current)', JSON.stringify(bc.B));
  assert(Object.keys(bc).length === 2 && Object.keys(bc).every((k) => bc[k].polished && bc[k].polished.minOnShift >= bc[k].current.minOnShift), 'D52.1d no category minOnShift drops', JSON.stringify(bc));
  const sumApplied = Object.values<any>(bc).reduce((a, v) => a + (v.movesApplied ?? NaN), 0);
  const sumTotal = Object.values<any>(bc).reduce((a, v) => a + (v.movesTotal ?? NaN), 0);
  assert(sumApplied === rp52?.movesApplied && sumTotal === rp52?.movesTotal && bc.A?.movesApplied < bc.A?.movesTotal, 'D52.1e byCategory movesApplied/movesTotal are per key and sum to the top-level counts', `${JSON.stringify(bc)} top=${rp52?.movesApplied}/${rp52?.movesTotal}`);

  // D52.2 — HC never moves; sync === async; deterministic.
  assert(on52.recommendedHC !== null && on52.recommendedHC === off52.recommendedHC && on52.staffing?.grossHCTotal === off52.staffing?.grossHCTotal, 'D52.2a HC and gross HC equal placement OFF (sync)', `off=${off52.recommendedHC}/${off52.staffing?.grossHCTotal} on=${on52.recommendedHC}/${on52.staffing?.grossHCTotal}`);
  const on52A = await searchOptimalHCAsync(run52(labor52On));
  assert(on52A.recommendedHC === off52.recommendedHC && on52A.staffing?.grossHCTotal === off52.staffing?.grossHCTotal, 'D52.2b HC and gross HC equal placement OFF (async)', `async=${on52A.recommendedHC}`);
  assert(JSON.stringify((on52A as any).rosterPolish) === JSON.stringify(rp52) && distStr52(on52A.shiftPlacement?.winningDistribution) === distStr52(on52.shiftPlacement?.winningDistribution), 'D52.2c sync === async (rosterPolish incl. per-key moves + adopted roster)', '');
  const on52b = searchOptimalHC(run52(labor52On));
  assert(JSON.stringify((on52b as any).rosterPolish) === JSON.stringify(rp52) && distStr52(on52b.shiftPlacement?.winningDistribution) === distStr52(on52.shiftPlacement?.winningDistribution), 'D52.2d deterministic across runs', '');
  const floor52 = resolveMinAgentsPerInterval(sla52, on52.recommendedHC ?? 0);
  assert(floor52 >= 1 && (on52.finalDESResult?.minCoverageObserved ?? -1) >= floor52, 'D52.2e coverage floor honoured in the final DES', `min=${on52.finalDESResult?.minCoverageObserved} floor=${floor52}`);

  // D52.3 — categoryPasses agrees with the category gate: every value true <=> passesCategorySLA.
  {
    const evalAt = (hc: number) => (hcNs as any).evaluateCandidateStatistical({
      operationalHC: hc, intervals: iv52, openingWIP: [], categories: cats52, calendar: cal52, labor: labor52Off, sla: sla52,
      baseSeed: 42, replications: 4, queueArchitecture: 'siloed',
    });
    let allAgree = true; let sawFail = false; let sawPass = false; let keysOk = true;
    for (const hc of [4, 8, 12, 16, 20, 30]) {
      const r = evalAt(hc);
      const cp = r.categoryPasses as Record<string, boolean> | undefined;
      if (!cp) { allAgree = false; keysOk = false; break; }
      const allTrue = Object.values(cp).every(Boolean);
      if (allTrue !== r.passesCategorySLA) allAgree = false;
      if (allTrue !== !r.failingReasons.some((x: string) => x.startsWith("Category '"))) allAgree = false;
      if (JSON.stringify(Object.keys(cp).sort()) !== JSON.stringify(['A', 'B'])) keysOk = false;
      if (allTrue) sawPass = true; else sawFail = true;
    }
    assert(allAgree && keysOk && sawFail && sawPass, 'D52.3 categoryPasses (keys = categories) all-true <=> passesCategorySLA, across passing and failing HCs', `agree=${allAgree} keys=${keysOk} fail=${sawFail} pass=${sawPass}`);
  }

  // D52.4 — the parallel k-search control (pure helper, fake evaluators).
  {
    const cps = (hcNs as any).createParallelRosterKSearch as ((totals: Record<string, number>) => { next: () => Record<string, number> | null; record: (v: Record<string, number>, e: any) => void; result: () => any }) | undefined;
    assert(typeof cps === 'function', 'D52.4a createParallelRosterKSearch is exported', '');
    if (typeof cps === 'function') {
      // fake DES: per-category verdicts + an org-wide verdict, both supplied by the test.
      const drive = (totals: Record<string, number>, ev: (v: Record<string, number>) => { cat: Record<string, boolean>; org: boolean }) => {
        const s = cps(totals); const seen: Array<Record<string, number>> = [];
        for (let v = s.next(); v !== null; v = s.next()) {
          seen.push({ ...v });
          const e = ev(v);
          s.record(v, { passes: e.org && Object.values(e.cat).every(Boolean), passesOrgGates: e.org, categoryPasses: e.cat, reasons: e.org ? [] : ['org gate'], slaPct: 0 });
        }
        return { seen, res: s.result() };
      };
      const bound = (totals: Record<string, number>) => Math.ceil(Math.log2(Math.max(...Object.values(totals)))) + 2;
      const limitsEv = (lim: Record<string, number>, orgCap = Infinity) => (v: Record<string, number>) => ({
        cat: Object.fromEntries(Object.keys(lim).map((k) => [k, v[k] <= lim[k]])),
        org: Object.values(v).reduce((a, b) => a + b, 0) <= orgCap,
      });
      const tot = { A: 9, B: 12 };
      const a = drive(tot, limitsEv({ A: 4, B: 12 }));
      assert(JSON.stringify(a.res.bestVector) === JSON.stringify({ A: 4, B: 12 }) && a.seen.length <= bound(tot) && JSON.stringify(a.seen[0]) === JSON.stringify(tot) && a.res.allReached === false, 'D52.4b independent limits: each key lands on its own largest passing k, K tried first, within ceil(log2 maxK)+2 evaluations', JSON.stringify({ n: a.seen.length, best: a.res.bestVector }));
      const b = drive(tot, limitsEv({ A: 9, B: 12 }));
      assert(b.seen.length === 1 && b.res.allReached === true && JSON.stringify(b.res.bestVector) === JSON.stringify(tot), 'D52.4c every key passes at K: one evaluation, allReached', JSON.stringify({ n: b.seen.length, r: b.res }));
      const c = drive(tot, limitsEv({ A: 0, B: 0 }));
      assert(JSON.stringify(c.res.bestVector) === JSON.stringify({ A: 0, B: 0 }) && c.seen.length <= bound(tot) && c.seen.some((v) => v.A === 1) && c.seen.some((v) => v.B === 1), 'D52.4d nothing passes: zeros (current roster), step 1 tried for every key', JSON.stringify({ n: c.seen.length, best: c.res.bestVector }));
      const totO = { A: 8, B: 8 };
      const d = drive(totO, limitsEv({ A: 8, B: 8 }, 10));
      const dv = d.res.bestVector as Record<string, number>;
      assert(dv.A + dv.B <= 10 && dv.A + dv.B > 0 && d.seen.length <= bound(totO) && typeof d.res.blockReason === 'string' && d.res.blockReason.includes('org gate'), 'D52.4e org-gate failure is charged to the keys that moved: result respects the org cap, within the evaluation bound, blockReason names the gate', JSON.stringify({ n: d.seen.length, best: dv, why: d.res.blockReason }));
      // D52.4f — the combined vector was never evaluated during the rounds and FAILS the confirm (an org gate that only bites at that exact
      // vector): fall back to the best fully-passing evaluated vector, never adopt the unverified/failing one.
      const exactFail = (v: Record<string, number>) => ({ cat: { A: v.A <= 3, B: v.B <= 2 }, org: !(v.A === 3 && v.B === 2) });
      const f = drive({ A: 6, B: 3 }, exactFail);
      const fb = f.res.bestVector as Record<string, number>;
      assert(JSON.stringify(f.res.chosenVector) === JSON.stringify({ A: 3, B: 2 }) && JSON.stringify(f.seen[f.seen.length - 1]) === JSON.stringify({ A: 3, B: 2 }) && JSON.stringify(fb) === JSON.stringify({ A: 3, B: 1 }) && f.res.allReached === false && f.seen.length <= bound({ A: 6, B: 3 }) && typeof f.res.blockReason === 'string' && f.res.blockReason.includes('org gate'), 'D52.4f confirm fails -> falls back to the best fully-passing evaluated vector and records the blocking gate', JSON.stringify({ seen: f.seen, best: fb, chosen: f.res.chosenVector, why: f.res.blockReason }));
      // D52.4g — property sweep: whatever the fake does, the adopted vector is all-zero or was evaluated fully passing, and the bound holds.
      let propOk = true; let firstBad = '';
      for (let ka = 1; ka <= 12; ka++) for (let kb = 1; kb <= 12; kb += 2) for (let la = 0; la <= ka; la += 2) for (let cap = 4; cap <= 24; cap += 5) {
        const t = { A: ka, B: kb };
        const ev = (v: Record<string, number>) => ({ cat: { A: v.A <= la, B: v.B <= Math.max(0, kb - (v.A >= 3 ? 1 : 0)) }, org: v.A + v.B <= cap });
        const r = drive(t, ev);
        const bv = r.res.bestVector as Record<string, number>;
        const e = ev(bv);
        const ok = (bv.A === 0 && bv.B === 0) || (e.org && e.cat.A && e.cat.B && r.seen.some((x) => x.A === bv.A && x.B === bv.B));
        if (!ok || r.seen.length > bound(t)) { propOk = false; firstBad ||= JSON.stringify({ t, la, cap, bv, n: r.seen.length }); }
      }
      assert(propOk, 'D52.4g sweep: adopted vector is all-zero or was evaluated fully passing; evaluations <= ceil(log2 maxK)+2', firstBad);
    }
  }
}

// =================================================================
// Suite D53 — Results describe the settings the run used; audit messages in local time
//
// Pre-fix ResultsFlow received the LIVE calendar/labor/sla/categories and ran
// verifyAgentTimelineInvariants(des, labor, calendar) on old results against settings edited
// after the run (run at 08:00, calendar changed to 10:00 -> 7,515 false "busy slice starts outside
// business window" errors on EGS_Only). App now snapshots the run inputs (runInputs) and feeds
// Results from them; diffRunInputs drives an amber "settings changed" banner. The audit messages
// also printed UTC (toISOString, 08:00 looked like 04:00) — now local via formatDateTime24.
// =================================================================
console.log('\n--- Suite D53: results use run-time settings; local-time audit messages ---');
{
  let diffRunInputs: ((a: any, b: any) => string[]) | null = null;
  try {
    diffRunInputs = (await import('../src/utils/run-inputs')).diffRunInputs;
  } catch (e) {
    diffRunInputs = null;
  }
  assert(typeof diffRunInputs === 'function', 'D53.0 src/utils/run-inputs.ts exports diffRunInputs', 'module missing');
  const base = { calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: DEFAULT_SLA, categories: DEFAULT_CATEGORIES, simParams: DEFAULT_SIM_PARAMS };
  const clone = () => JSON.parse(JSON.stringify(base));
  if (diffRunInputs) {
    const d = diffRunInputs;
    assert(JSON.stringify(d(base, clone())) === '[]', 'D53.1 identical inputs -> []', JSON.stringify(d(base, clone())));
    const c2 = clone(); c2.calendar.dailyOpenHour = (c2.calendar.dailyOpenHour + 2) % 24;
    assert(JSON.stringify(d(base, c2)) === '["Business calendar"]', 'D53.2 calendar open hour changed -> [Business calendar]', JSON.stringify(d(base, c2)));
    const reordered = { simParams: { ...base.simParams }, categories: base.categories.map((c) => Object.fromEntries(Object.entries(c).reverse())), sla: Object.fromEntries(Object.entries(base.sla).reverse()), labor: Object.fromEntries(Object.entries(base.labor).reverse()), calendar: Object.fromEntries(Object.entries(base.calendar).reverse()) };
    assert(JSON.stringify(d(base, reordered)) === '[]', 'D53.3 key order is ignored', JSON.stringify(d(base, reordered)));
    const c4 = clone(); c4.labor.dailyProductiveHours += 1;
    assert(JSON.stringify(d(base, c4)) === '["Labor"]', 'D53.4a labor change detected', JSON.stringify(d(base, c4)));
    const c5 = clone(); c5.sla.primaryPct = c5.sla.primaryPct - 5;
    assert(JSON.stringify(d(base, c5)) === '["SLA policy"]', 'D53.4b SLA change detected', JSON.stringify(d(base, c5)));
    const c6 = clone(); c6.categories[0].ahtMinutes += 1;
    assert(JSON.stringify(d(base, c6)) === '["Categories"]', 'D53.4c categories change detected', JSON.stringify(d(base, c6)));
    const c7 = clone(); c7.simParams.seed = (c7.simParams.seed ?? 0) + 1;
    assert(JSON.stringify(d(base, c7)) === '["Simulation settings"]', 'D53.4d simParams change detected', JSON.stringify(d(base, c7)));
    const c8 = clone(); c8.calendar.dailyOpenHour = (c8.calendar.dailyOpenHour + 2) % 24; c8.sla.primaryPct -= 5;
    assert(JSON.stringify(d(base, c8)) === '["Business calendar","SLA policy"]', 'D53.4e multiple sections listed in display order', JSON.stringify(d(base, c8)));
  }

  // Invariant check: matching vs edited-after-run calendar (local-time messages).
  const cal08: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 18 };
  const cal10: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 10, dailyCloseHour: 20 };
  const ivs53: StandardInterval[] = [];
  let idx53 = 0;
  for (let d = 0; d < 3; d++) {
    for (let h = 8; h < 18; h++) for (const m of [0, 30]) {
      ivs53.push({ intervalIndex: idx53++, start: new Date(2026, 9, 5 + d, h, m), end: new Date(2026, 9, 5 + d, h, m + 30), volume: 6, category: 'General' });
    }
  }
  const cats53: CategoryConfig[] = [{ id: 'General', name: 'General', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 }];
  const sla53: SLAPolicyConfig = { ...DEFAULT_SLA, primaryPct: 80, primaryWindow: 6, primaryUnit: 'hours', occupancyCapEnabled: false, boAsaEnabled: false };
  const des53 = runBackofficeDES({ operationalHC: 6, intervals: ivs53, openingWIP: [], categories: cats53, calendar: cal08, labor: LABOR, sla: sla53, seed: 42 });
  const same53 = verifyAgentTimelineInvariants(des53, LABOR, cal08);
  assert(same53.valid && same53.errors.length === 0, 'D53.5 08:00 run checked with the same 08:00 calendar -> 0 errors', `errors=${same53.errors.length} ${same53.errors[0] ?? ''}`);
  const stale53 = verifyAgentTimelineInvariants(des53, LABOR, cal10);
  assert(stale53.errors.length > 0, 'D53.6a 08:00 run checked with a 10:00 calendar -> errors (the stale-settings symptom the snapshot removes)', `errors=${stale53.errors.length}`);
  const isoRe = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[^ ]*Z/;
  assert(stale53.errors.length > 0 && stale53.errors.every((e) => !isoRe.test(e)), 'D53.6b no ISO/UTC "T..Z" timestamps in audit messages', stale53.errors.find((e) => isoRe.test(e)) ?? '');
  assert(stale53.errors.some((e) => /2026-10-0\d 08:00/.test(e)), 'D53.6c messages show local "YYYY-MM-DD 08:00"', stale53.errors[0] ?? '');

  // Source checks: App feeds Results from the run snapshot; export uses it too.
  const root53 = resolve(import.meta.dirname, '..');
  const appSrc53 = readFileSync(join(root53, 'src', 'App.tsx'), 'utf-8');
  const resultsStart53 = appSrc53.indexOf('<ResultsFlow');
  const resultsBlock53 = resultsStart53 < 0 ? '' : appSrc53.slice(resultsStart53, appSrc53.indexOf('/>', resultsStart53));
  assert(['calendar', 'labor', 'sla', 'categories', 'simParams'].every((p) => new RegExp(`${p}=\\{[^}]*runInputs[^}]*\\}`).test(resultsBlock53)), 'D53.7a App passes runInputs-derived calendar/labor/sla/categories/simParams to ResultsFlow', resultsBlock53);
  assert(/settingsChangedSinceRun=/.test(resultsBlock53) && /diffRunInputs/.test(appSrc53), 'D53.7b App passes the diffRunInputs result as settingsChangedSinceRun', '');
  const nClear53 = (appSrc53.match(/setSearchOutput\(null\)/g) || []).length;
  const nRunClear53 = (appSrc53.match(/setRunInputs\(null\)/g) || []).length;
  assert(/setRunInputs\((?!null)/.test(appSrc53) && nClear53 > 0 && nClear53 === nRunClear53, 'D53.7c runInputs set with the result and cleared everywhere searchOutput is cleared', `${nClear53} vs ${nRunClear53}`);
  const desSrc53 = readFileSync(join(root53, 'src', 'utils', 'des-engine.ts'), 'utf-8');
  const invStart53 = desSrc53.indexOf('export function verifyAgentTimelineInvariants');
  const invNext53 = desSrc53.indexOf('\nexport ', invStart53 + 10);
  assert(invStart53 > 0 && !/toISOString\(\)/.test(desSrc53.slice(invStart53, invNext53 > 0 ? invNext53 : undefined)), 'D53.8 verifyAgentTimelineInvariants has no toISOString()', '');
  const rfSrc53 = readFileSync(join(root53, 'src', 'components', 'ResultsFlow.tsx'), 'utf-8');
  assert(/settingsChangedSinceRun/.test(rfSrc53) && /Settings changed since this run/.test(rfSrc53), 'D53.9 ResultsFlow renders the stale-settings banner', '');
  assert(/buildConfigSnapshot/.test(appSrc53) && /onExportAssumptionsJSON=\{[^}]*\}/.test(resultsBlock53) && !/onExportAssumptionsJSON=\{handleExportParams\}/.test(resultsBlock53), 'D53.10 Results export is wired to a run-snapshot handler, not the live Config export', resultsBlock53);
}

// =================================================================
// Suite D54 — Number fields keep what is typed (H1; audit UI-41/42/43/44/54, UI-33, DOC-3)
//
// Pre-fix every number input clamped on each keystroke (select-all, type 8,5 into the 50-100
// occupancy cap stored 100) and snapped to a default when emptied. NumberField keeps a local
// draft; pure helpers decide when a draft is committable and what a blur/Enter/unmount commits.
// =================================================================
console.log('\n--- Suite D54: number fields keep what is typed ---');
{
  let nim: any = null;
  try {
    nim = await import('../src/utils/number-input');
  } catch (e) {
    nim = null;
  }
  assert(!!nim && typeof nim.commitNumberDraft === 'function' && typeof nim.draftIsCommittable === 'function', 'D54.0 src/utils/number-input.ts exports commitNumberDraft + draftIsCommittable', 'module missing');
  if (nim && typeof nim.commitNumberDraft === 'function' && typeof nim.draftIsCommittable === 'function') {
    const { commitNumberDraft: c, draftIsCommittable: ok } = nim;
    const occ = { min: 50, max: 100, integer: true };
    assert(ok('8', occ) === false, 'D54.1a "8" in 50-100 -> not committable (partial of 85)', '');
    assert(ok('85', occ) === true && c('85', { ...occ, fallback: 70 }) === 85, 'D54.1b "85" -> committable, commits 85', '');
    assert(ok('', occ) === false && c('', { ...occ, fallback: 70 }) === 70, 'D54.2a empty -> not committable, commit returns the stored fallback', '');
    assert(ok('-', occ) === false && c('-', { ...occ, fallback: 70 }) === 70, 'D54.2b "-" -> not committable, fallback', '');
    assert(ok('1e', occ) === false && c('1e', { ...occ, fallback: 70 }) === 70, 'D54.2c "1e" -> not committable, fallback', '');
    assert(c('abc', { ...occ, fallback: 70 }) === 70 && c('  ', { ...occ, fallback: 70 }) === 70, 'D54.2d "abc" / whitespace -> fallback', '');
    assert(c('Infinity', { ...occ, fallback: 70 }) === 70 && ok('Infinity', occ) === false, 'D54.2e Infinity -> not committable, fallback', '');
    assert(c('8', { ...occ, fallback: 70 }) === 50, 'D54.3a "8" on blur clamps up to min 50', '');
    assert(c('30', { ...occ, fallback: 70 }) === 50 && ok('30', occ) === false, 'D54.3b "30" on blur -> 50, not committable while typing', '');
    assert(c('99999', { min: 1, max: 100, integer: true, fallback: 5 }) === 100 && ok('99999', { min: 1, max: 100, integer: true }) === false, 'D54.3c "99999" max 100 -> commits 100 on blur, not committable', '');
    assert(c('-3', { min: 1, fallback: 7 }) === 1, 'D54.3d "-3" min 1 -> 1', '');
    assert(c('1e9', { min: 1, max: 5000, integer: true, fallback: 7 }) === 5000, 'D54.3e "1e9" -> max', '');
    assert(ok('12.5', { min: 1, max: 100, integer: true }) === false && c('12.5', { min: 1, max: 100, integer: true, fallback: 5 }) === 13, 'D54.4 "12.5" integer -> not committable, blur commits 13 (Math.round)', '');
    assert(ok('12.5', { min: 1, max: 100 }) === true && c('12.5', { min: 1, max: 100, fallback: 5 }) === 12.5, 'D54.4b "12.5" decimal field -> committable 12.5', '');
    assert(ok('0', { min: 0 }) === true && c('0', { min: 0, fallback: 9 }) === 0, 'D54.5a "0" with min 0 -> 0 survives (no || default)', '');
    assert(c('0', { min: 1, fallback: 9 }) === 1, 'D54.5b "0" with min 1 -> 1', '');
    assert(ok('-7', { integer: true }) === true && c('-7', { integer: true, fallback: 1 }) === -7, 'D54.5c no range: negative integer kept (seed)', '');
    assert(ok('1', { min: 0, max: 24 }) === true && ok('25', { min: 0, max: 24 }) === false, 'D54.5d range edges respected by draftIsCommittable', '');
    // percent round trip
    const { fractionToPercentDisplay: f2p, percentDisplayToFraction: p2f } = nim;
    assert(typeof f2p === 'function' && typeof p2f === 'function' && f2p(0.925) === 92.5 && p2f(92.5) === 0.925, 'D54.6a 0.925 <-> 92.5 round trip', `${f2p?.(0.925)} ${p2f?.(92.5)}`);
    assert(typeof f2p === 'function' && f2p(0.85) === 85 && p2f(85) === 0.85 && f2p(0.1) === 10 && f2p(0.999) === 99.9, 'D54.6b 0.85 -> 85, 0.1 -> 10, 0.999 -> 99.9 (no float noise)', `${f2p?.(0.85)} ${p2f?.(85)} ${f2p?.(0.999)}`);
  }

  // Source guard (a guard, not proof): every number input goes through NumberField.
  const root54 = resolve(import.meta.dirname, '..');
  const compDir54 = join(root54, 'src', 'components');
  const offenders54: string[] = [];
  for (const f of readdirSync(compDir54).filter((n) => n.endsWith('.tsx') && n !== 'NumberField.tsx')) {
    const t = readFileSync(join(compDir54, f), 'utf-8');
    if (/type=["']number["']/.test(t) || /type=\{["']number["']\}/.test(t)) offenders54.push(f);
  }
  assert(offenders54.length === 0, 'D54.7 no type="number" input remains in src/components outside NumberField.tsx', offenders54.join(', '));
  assert(existsSync(join(compDir54, 'NumberField.tsx')), 'D54.8 NumberField.tsx exists', '');
}

console.log('\n==================================================');
console.log(` RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
console.log('==================================================\n');

if (failedTests > 0) process.exitCode = 1;
