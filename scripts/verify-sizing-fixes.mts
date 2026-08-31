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
import { validateDataQuality } from '../src/utils/csv-parser';
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
  assert(runOmitted.finalDESResult?.shiftDistributionUsed === undefined, 'D21.4 finalDESResult.shiftDistributionUsed is undefined when the flag is off', `got ${JSON.stringify(runOmitted.finalDESResult?.shiftDistributionUsed)}`);
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
    searchWithCoverage.recommendedHC === searchNoCoverage.recommendedHC,
    'D33.7 coverage costs ZERO extra headcount here — same recommendation with the floor on vs off (redistribution, not more heads)',
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

console.log('\n==================================================');
console.log(` RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
console.log('==================================================\n');

if (failedTests > 0) process.exitCode = 1;
