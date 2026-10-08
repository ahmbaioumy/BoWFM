/**
 * Sizing-chain regression suite for the Backoffice WFM Sizing Engine.
 *
 * Companion to scripts/verify-fixes.mts (the legacy suite, left untouched).
 * This file covers defects found during the Required-HC chain audit. Every test
 * here was written to FAIL against the pre-fix code and pass afterwards.
 *
 * Run: npx tsx scripts/verify-sizing-fixes.mts
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  computeIntervalHorizon,
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
import { discoverAndSyncCategories, mapRawRecordsToIntervals, missingRequiredMappings, validateDataQuality } from '../src/utils/csv-parser';
import { buildSampleDataset } from '../src/utils/sample-data';
import { loadSampleFile } from './sample-files';
import { DEFAULT_CALENDAR, DEFAULT_CATEGORIES, DEFAULT_LABOR, DEFAULT_SIM_PARAMS, DEFAULT_SLA } from '../src/utils/default-config';
import {
  CalendarConfig,
  CaseEntity,
  OpeningWIPCase,
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
    // Updated 2026-10-08 (P2-9: non-24x7 runs without a start distribution now end each agent's shift
    // dailyProductiveHours after open). Was 'coverage ON = coverage OFF + 1' (22 vs 21). With coverage OFF there is no
    // late cohort any more, so every agent works ONE 9h shift from 08:00 and the 17:00-22:00 evening is unstaffed: the
    // uniform-only answer rises 21 -> 28 and now EXCEEDS the coverage-ON answer (22, which keeps a late cohort that
    // serves the evening). Pinned explicitly: ON = 22, OFF = 28, OFF >= ON.
    searchWithCoverage.recommendedHC === 22 && searchNoCoverage.recommendedHC === 28 &&
      (searchNoCoverage.recommendedHC ?? -1) >= (searchWithCoverage.recommendedHC ?? Infinity),
    'D33.7 coverage ON = 22, coverage OFF = 28 (OFF >= ON: one shift from open leaves the evening unstaffed, a late cohort serves it)',
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
    const GOLDEN_OFF: Record<string, number> = { ...GOLDEN_TIMES, c247: 857025119 };
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
  // Re-pinned 2026-10-08 (P1-6): with Shift Placement ON the search now tries a ladder of simple start-time rosters, each confirmed on a second
  // independent replication block, before rejecting a headcount. On this fixture that moves the recommendation 9 -> 7 with a rescued roster that
  // leaves nothing to re-spread. D50.1a: status was 'adopted' -> now 'no_improvement' (the original adopted-path intent moved to D73.1, scan-found fixture).
  // D50.1b: was "the adopted roster improves coverage" -> now "the best reachable re-spread does NOT beat the current roster"
  // (current minOnShift 3, 66.7% of buckets meet need; best reachable re-spread minOnShift 1, 62.5%).
  assert(rp !== undefined && rp.status === 'no_improvement', 'D50.1a placement ON, rescued N=7 roster: polish finds nothing to improve (no_improvement; was adopted before P1-6)', `status=${rp?.status} reason=${rp?.reason}`);
  assert(!!rp?.polished && !(rp.polished.minOnShift > rp.current.minOnShift || (rp.polished.minOnShift === rp.current.minOnShift && rp.polished.gapAgentHours < rp.current.gapAgentHours - 1e-9)), 'D50.1b no_improvement: the best reachable re-spread does not beat the current roster (was: adopted roster improves coverage)', `cur=${JSON.stringify(rp?.current)} pol=${JSON.stringify(rp?.polished)}`);
  assert(!!rp?.polished && rp.polished.minOnShift >= 1, 'D50.1c polished roster keeps at least one agent on shift in every bucket', `min=${rp?.polished?.minOnShift}`);

  // D50.2
  // Re-pinned 2026-10-08 (P1-6): was "equals the placement-OFF run" (9 / gross 10). With the rescue ladder the placement-ON search rejects fewer
  // headcounts: it now recommends 7 (gross 8), which is <= the placement-OFF 9 / 10 (a rescued roster passes the unchanged gate on two independent blocks).
  assert(on50.recommendedHC !== null && off50.recommendedHC !== null && on50.recommendedHC <= off50.recommendedHC && on50.recommendedHC === 7 && on50.staffing?.grossHCTotal === 8, 'D50.2a recommendedHC <= the placement-OFF run and pinned at 7 / gross 8 (sync; was equal to OFF = 9 / 10)', `off=${off50.recommendedHC}/${off50.staffing?.grossHCTotal} on=${on50.recommendedHC}/${on50.staffing?.grossHCTotal}`);
  const on50Async = await searchOptimalHCAsync(run50(labor50On, iv50, sla50));
  // Re-pinned 2026-10-08 (P1-6): same as D50.2a (was equal to OFF = 9 / 10; now 7 / 8).
  assert(on50Async.recommendedHC !== null && off50.recommendedHC !== null && on50Async.recommendedHC <= off50.recommendedHC && on50Async.recommendedHC === 7 && on50Async.staffing?.grossHCTotal === 8, 'D50.2b recommendedHC <= the placement-OFF run and pinned at 7 / gross 8 (async; was equal to OFF = 9 / 10)', `async=${on50Async.recommendedHC}/${on50Async.staffing?.grossHCTotal}`);

  // D50.3
  const rpA = (on50Async as any).rosterPolish;
  assert(rpA !== undefined && rpA.status === rp?.status && slotsOf(on50Async.shiftPlacement?.winningDistribution) === slotsOf(on50.shiftPlacement?.winningDistribution), 'D50.3 sync === async: rosterPolish status + adopted distribution', `sync=${rp?.status}/${slotsOf(on50.shiftPlacement?.winningDistribution)} async=${rpA?.status}/${slotsOf(on50Async.shiftPlacement?.winningDistribution)}`);

  // D50.5
  const minCov = on50.finalDESResult?.minCoverageObserved ?? -1;
  // Re-pinned 2026-10-08 (P1-6): the precondition changed from status 'adopted' to the roster the search keeps ('no_improvement', asserted in D50.1a, so not
  // repeated here); the floor check itself still holds (minCoverageObserved 3, floor 1). The adopted-roster version of this check lives in D73.1k.
  assert(minCov >= 1, 'D50.5 the roster the search keeps (status no_improvement, D50.1a; was adopted) satisfies the coverage floor in the audit DES', `status=${rp?.status} minCoverageObserved=${minCov}`);

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
    // Re-pinned 2026-10-08 (P1-6): status was 'kept_current_failed_gate' with movesApplied 0 -> now 'no_improvement' (no movesApplied field): the
    // rescue ladder finds a roster at a lower headcount whose coverage no re-spread can beat, so the polish never gets as far as a first move.
    // The original path (reason text, 0 moves, final roster = pre-polish roster) is asserted on a scan-found fixture in D73.3.
    assert(rpC !== undefined && rpC.status === 'no_improvement' && typeof rpC.reason === 'string' && rpC.reason.length > 0 && rpC.movesApplied === undefined, 'D50.4a rescued roster leaves nothing to re-spread: status no_improvement with reason, no moves applied (was kept_current_failed_gate, 0 moves)', `status=${rpC?.status} reason=${rpC?.reason}`);
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

  // Re-pinned 2026-10-08 (P1-6): D51.1 no longer reaches 'adopted' - the rescue ladder lowers the placement-ON headcount from 17 to 14 (OFF stays 17)
  // and the rescued roster leaves nothing to re-spread ('no_improvement'). `lower` carries the new pinned HC / gross HC for that case; the adopted-path
  // version of every D51.1 check lives in D73.2 (scan-found siloed fixture). D51.2 (adopted_partial) is unchanged.
  const checkScenario = async (tag: string, ivs: StandardInterval[], sla: SLAPolicyConfig, wantStatus: 'adopted' | 'adopted_partial' | 'no_improvement', lower?: { hc: number; gross: number }) => {
    const off = searchOptimalHC(run51(labor51Off, ivs, sla));
    const on = searchOptimalHC(run51(labor51On, ivs, sla));
    const rp = (on as any).rosterPolish;
    assert(rp?.status === wantStatus, `${tag}a siloed placement ON: polish ${wantStatus}`, `status=${rp?.status} reason=${rp?.reason}`);
    const improvesOrg = !!rp?.polished && (rp.polished.minOnShift > rp.current.minOnShift || (rp.polished.minOnShift === rp.current.minOnShift && rp.polished.gapAgentHours < rp.current.gapAgentHours - 1e-9));
    if (wantStatus === 'no_improvement') {
      assert(!!rp?.polished && !improvesOrg, `${tag}b org-wide: the best reachable re-spread does not beat the current roster (no_improvement; was: coverage improves)`, `cur=${JSON.stringify(rp?.current)} pol=${JSON.stringify(rp?.polished)}`);
      assert(JSON.stringify(Object.keys(rp?.byCategory ?? {}).sort()) === JSON.stringify(['A', 'B']) && Object.values<any>(rp?.byCategory ?? {}).every((v) => v.current && v.polished && v.movesApplied === undefined), `${tag}c both categories reported with current and best-reachable profiles and no moves applied (no_improvement; was: no category's minOnShift decreases)`, JSON.stringify(rp?.byCategory));
    } else {
      assert(improvesOrg, `${tag}b org-wide coverage improves`, `cur=${JSON.stringify(rp?.current)} pol=${JSON.stringify(rp?.polished)}`);
      assert(catGuardOk(rp), `${tag}c both categories reported and no category's minOnShift decreases`, JSON.stringify(rp?.byCategory));
    }
    const eqOff = (h: number | null, g: number | undefined) => (lower ? h !== null && off.recommendedHC !== null && h <= off.recommendedHC && h === lower.hc && g === lower.gross : h === off.recommendedHC && g === off.staffing?.grossHCTotal && h !== null);
    assert(eqOff(on.recommendedHC, on.staffing?.grossHCTotal), lower ? `${tag}d HC <= placement OFF and pinned at ${lower.hc} / gross ${lower.gross} (sync; was equal to OFF)` : `${tag}d HC and gross HC equal placement OFF (sync)`, `off=${off.recommendedHC}/${off.staffing?.grossHCTotal} on=${on.recommendedHC}/${on.staffing?.grossHCTotal}`);
    const onA = await searchOptimalHCAsync(run51(labor51On, ivs, sla));
    assert(eqOff(onA.recommendedHC, onA.staffing?.grossHCTotal), lower ? `${tag}e HC <= placement OFF and pinned at ${lower.hc} / gross ${lower.gross} (async; was equal to OFF)` : `${tag}e HC and gross HC equal placement OFF (async)`, `async=${onA.recommendedHC}/${onA.staffing?.grossHCTotal}`);
    assert(JSON.stringify((onA as any).rosterPolish) === JSON.stringify(rp) && distStr(onA.shiftPlacement?.winningDistribution) === distStr(on.shiftPlacement?.winningDistribution), `${tag}f sync === async (rosterPolish incl. byCategory + adopted roster)`, '');
    const on2 = searchOptimalHC(run51(labor51On, ivs, sla));
    assert(JSON.stringify((on2 as any).rosterPolish) === JSON.stringify(rp) && distStr(on2.shiftPlacement?.winningDistribution) === distStr(on.shiftPlacement?.winningDistribution), `${tag}g deterministic across runs`, '');
    const floor = resolveMinAgentsPerInterval(sla, on.recommendedHC ?? 0);
    const minCov = on.finalDESResult?.minCoverageObserved ?? -1;
    assert(floor >= 1 && minCov >= floor, `${tag}h coverage floor (org-wide gate, ${floor}) honoured in the final DES`, `minCoverageObserved=${minCov}`);
    return { on, rp };
  };

  await checkScenario('D51.1', mkIv51((h) => (h >= 12 && h < 16 ? 14 : 3), (h) => (h >= 12 && h < 16 ? 10 : 2)), mkSla51(85, 3), 'no_improvement', { hc: 14, gross: 16 });
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
  // Re-pinned 2026-10-08 (P1-6): with Shift Placement ON the search now tries a ladder of simple start-time rosters, each confirmed on a second
  // independent replication block, before rejecting a headcount. On this fixture that moves the recommendation 19 -> 18 and the rescued roster
  // leaves nothing to re-spread, so D52.1a-e no longer see 'adopted_partial' (A saturates, B keeps improving). Per assertion, old -> new:
  //   a: status adopted_partial -> no_improvement;
  //   b: A's adopted roster improves its own minOnShift -> A's best reachable re-spread does NOT beat the current roster (current 3, best reachable 2);
  //   c: B ALSO improves its minOnShift -> B's best reachable re-spread does NOT beat the current roster either (the original per-queue property
  //      "A saturates while B keeps improving" moved to D73.4, scan-found fixture);
  //   d: no category minOnShift drops (adopted) -> both categories reported with current and best-reachable profiles;
  //   e: per-key movesApplied/movesTotal sum to the top-level counts -> per-key movesTotal sums to the top-level movesTotal and nothing was applied.
  assert(rp52?.status === 'no_improvement', 'D52.1a siloed placement ON: no_improvement (rescued N=18 roster; was adopted_partial, A saturates)', `status=${rp52?.status} reason=${rp52?.reason}`);
  const noBeat = (v: any) => !!v?.polished && !!v?.current && !(v.polished.minOnShift > v.current.minOnShift || (v.polished.minOnShift === v.current.minOnShift && v.polished.gapAgentHours < v.current.gapAgentHours - 1e-9));
  assert(noBeat(bc.A), 'D52.1b first-by-name category A: its best reachable re-spread does not beat the current roster (was: A still improves its own minOnShift)', JSON.stringify(bc.A));
  assert(noBeat(bc.B), 'D52.1c later category B: its best reachable re-spread does not beat the current roster either (was: B ALSO improves its minOnShift)', JSON.stringify(bc.B));
  assert(JSON.stringify(Object.keys(bc).sort()) === JSON.stringify(['A', 'B']) && Object.keys(bc).every((k) => bc[k].polished && bc[k].current), 'D52.1d both categories reported with current and best-reachable profiles (was: no category minOnShift drops)', JSON.stringify(bc));
  const sumTotal = Object.values<any>(bc).reduce((a, v) => a + (v.movesTotal ?? NaN), 0);
  assert(sumTotal === rp52?.movesTotal && rp52?.movesApplied === undefined && Object.values<any>(bc).every((v) => v.movesApplied === undefined), 'D52.1e byCategory movesTotal is per key and sums to the top-level count; nothing applied (was: movesApplied/movesTotal per key summing to the top-level counts)', `${JSON.stringify(bc)} top=${rp52?.movesApplied}/${rp52?.movesTotal}`);

  // D52.2 — HC never moves; sync === async; deterministic.
  // Re-pinned 2026-10-08 (P1-6): was "equal to placement OFF" (19 / gross 21); the rescue ladder now gives 18 / gross 20, which is <= OFF.
  assert(on52.recommendedHC !== null && off52.recommendedHC !== null && on52.recommendedHC <= off52.recommendedHC && on52.recommendedHC === 18 && on52.staffing?.grossHCTotal === 20, 'D52.2a HC <= placement OFF and pinned at 18 / gross 20 (sync; was equal to OFF = 19 / 21)', `off=${off52.recommendedHC}/${off52.staffing?.grossHCTotal} on=${on52.recommendedHC}/${on52.staffing?.grossHCTotal}`);
  const on52A = await searchOptimalHCAsync(run52(labor52On));
  // Re-pinned 2026-10-08 (P1-6): same as D52.2a (was equal to OFF = 19 / 21; now 18 / 20).
  assert(on52A.recommendedHC !== null && off52.recommendedHC !== null && on52A.recommendedHC <= off52.recommendedHC && on52A.recommendedHC === 18 && on52A.staffing?.grossHCTotal === 20, 'D52.2b HC <= placement OFF and pinned at 18 / gross 20 (async; was equal to OFF = 19 / 21)', `async=${on52A.recommendedHC}/${on52A.staffing?.grossHCTotal}`);
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
    // Updated 2026-10-08 (P2-9: non-24x7 runs without a start distribution now end each agent's shift
    // dailyProductiveHours after open). The sweep used to pass no distribution and reach a passing HC at 20-30; with one
    // 8h shift from 08:00 on this 08:00-20:00 day, cases arriving just before shift end wait until next morning and
    // attainment plateaus at 95.2% with category B failing at every HC (see D52.3b). To keep this assertion's purpose --
    // observe BOTH passing and failing headcounts -- the sweep now gives every HC a roster that can pass: the
    // coverage-repair distribution (most agents at offset 0, one late starter per category at +240 min), built by
    // buildCoverageRepairDistribution from the same per-category workload the search uses. Expected: fail at 4..16, pass at 20+.
    const catWorkload52 = new Map<string, number>();
    for (const iv of iv52) catWorkload52.set(iv.category, (catWorkload52.get(iv.category) || 0) + iv.volume * (cats52.find((c) => c.name === iv.category)?.ahtMinutes ?? 0));
    const evalWithRoster52 = (hc: number) => (hcNs as any).evaluateCandidateStatistical({
      operationalHC: hc, intervals: iv52, openingWIP: [], categories: cats52, calendar: cal52, labor: labor52Off, sla: sla52,
      baseSeed: 42, replications: 4, queueArchitecture: 'siloed',
      shiftDistribution: hcNs.buildCoverageRepairDistribution({ n: hc, calendar: cal52, labor: labor52Off, minAgentsPerInterval: 1, queueArchitecture: 'siloed', categoryWorkloadMinutes: catWorkload52 }) ?? undefined,
    });
    let allAgree = true; let sawFail = false; let sawPass = false; let keysOk = true;
    for (const hc of [4, 8, 12, 16, 20, 30]) {
      const r = evalWithRoster52(hc);
      const cp = r.categoryPasses as Record<string, boolean> | undefined;
      if (!cp) { allAgree = false; keysOk = false; break; }
      const allTrue = Object.values(cp).every(Boolean);
      if (allTrue !== r.passesCategorySLA) allAgree = false;
      if (allTrue !== !r.failingReasons.some((x: string) => x.startsWith("Category '"))) allAgree = false;
      if (JSON.stringify(Object.keys(cp).sort()) !== JSON.stringify(['A', 'B'])) keysOk = false;
      if (allTrue) sawPass = true; else sawFail = true;
    }
    assert(allAgree && keysOk && sawFail && sawPass, 'D52.3 categoryPasses (keys = categories) all-true <=> passesCategorySLA, across passing and failing HCs', `agree=${allAgree} keys=${keysOk} fail=${sawFail} pass=${sawPass}`);

    // D52.3b (added 2026-10-08, P2-9) -- records the single-shift fact. With NO distribution every agent works one 8h shift
    // from 08:00 on a 12h day, so cases that arrive in the last 4h wait for the next morning: no headcount from 4 to 60
    // passes, overall attainment plateaus at ~95.2% (95.1-95.4 CI) and category B keeps failing while A passes.
    // Before the change the same sweep (agents stayed on to close) reached a passing HC at 20-30.
    {
      let anyPass = false; let bAlwaysFailsFrom30 = true; let aPassesFrom30 = true; let plateauOk = true;
      for (let hc = 4; hc <= 60; hc += 4) {
        const r = evalAt(hc);
        if (r.passesAllConstraints || r.passesCategorySLA) anyPass = true;
        if (hc >= 30) {
          if (r.categoryPasses.B !== false) bAlwaysFailsFrom30 = false;
          if (r.categoryPasses.A !== true) aPassesFrom30 = false;
          if (Math.abs(r.primaryStats.achievedPctMean - 95.2) > 0.15) plateauOk = false;
        }
      }
      assert(!anyPass && bAlwaysFailsFrom30 && aPassesFrom30 && plateauOk, 'D52.3b single shift, no distribution: no HC from 4 to 60 passes; attainment plateaus at ~95.2% (B fails, A passes from HC 30)', `anyPass=${anyPass} bFails=${bAlwaysFailsFrom30} aPasses=${aPassesFrom30} plateau=${plateauOk}`);
    }
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

// =================================================================
// Suites D55-D61 — Tests that protect the frozen sizing decisions (G12; audit TEST-1, TEST-4..7, TEST-9)
//
// Each check calls engine code and compares against a value derived by hand in the check's own
// message, never against the code under test. Each was proven RED against its own mutation
// (see project_context.md section 11, 2026-10-06 row). Local-time Date construction mirrors calendar.ts.
// =================================================================

// ---------------------------------------------------------------
// Suite D55 — Dispatch order: EDF, priority tie-break, parked-first (frozen decision 2)
// pickNextCase / compareByUrgency is what really dispatches (CaseMinHeap.compare does not — DES-15).
// ---------------------------------------------------------------
console.log('\n--- Suite D55: dispatch order (EDF, priority tie-break, parked-first) ---');
{
  const at = (h: number, m: number = 0) => new Date(2026, 9, 12, h, m);
  const mkCase = (id: string, syn: number, o: { lss: Date; priority: number; arrival: Date; parked?: boolean }): any => ({
    id,
    syntheticId: syn,
    category: 'A',
    priority: o.priority,
    arrival: o.arrival,
    clockStart: o.arrival,
    totalAhtMinutes: 30,
    remainingWorkMinutes: o.parked ? 10 : 30,
    primaryDeadline: new Date(o.lss.getTime() + 30 * 60000),
    latestSafeStart: o.lss,
    firstStartTime: null,
    completeTime: null,
    parkCount: o.parked ? 1 : 0,
    isOpeningWip: false,
  });
  const drain = (cases: any[]): string[] => {
    const q = new desNs.CaseMinHeap();
    for (const c of cases) q.push(c);
    const out: string[] = [];
    while (q.length > 0) out.push(desNs.pickNextCase(q, at(12))!.id);
    return out;
  };

  // T1 — same latestSafeStart: lower priority number goes first, even though the other case arrived earlier.
  const tieA = mkCase('A', 1, { lss: at(12), priority: 2, arrival: at(9) });
  const tieB = mkCase('B', 2, { lss: at(12), priority: 1, arrival: at(9, 30) });
  const t1 = drain([tieA, tieB]);
  assert(t1.join() === 'B,A', 'D55.1a equal deadline: priority 1 (arrived 09:30) goes before priority 2 (arrived 09:00)', `got ${t1.join()}; expected B,A`);
  const t1r = drain([tieB, tieA]);
  assert(t1r.join() === 'B,A', 'D55.1b same result with the push order reversed', `got ${t1r.join()}; expected B,A`);
  // Equal deadline AND equal priority: FIFO by arrival.
  const fifo = drain([mkCase('L', 1, { lss: at(12), priority: 1, arrival: at(9, 30) }), mkCase('E', 2, { lss: at(12), priority: 1, arrival: at(9) })]);
  assert(fifo.join() === 'E,L', 'D55.1c equal deadline and priority: earlier arrival first', `got ${fifo.join()}; expected E,L`);

  // T2 — EDF directly: the case that arrived LATER but is due EARLIER goes first.
  const edfA = mkCase('A', 1, { lss: at(15), priority: 1, arrival: at(9) });
  const edfB = mkCase('B', 2, { lss: at(11), priority: 1, arrival: at(10) });
  const t2 = drain([edfA, edfB]);
  assert(t2.join() === 'B,A', 'D55.2a arrived 10:00 / due 11:00 goes before arrived 09:00 / due 15:00 (EDF, not FIFO)', `got ${t2.join()}; expected B,A`);
  const t2r = drain([edfB, edfA]);
  assert(t2r.join() === 'B,A', 'D55.2b same result with the push order reversed', `got ${t2r.join()}; expected B,A`);
  // Deadline dominates priority: priority 3 due 11:00 beats priority 1 due 15:00.
  const dom = drain([mkCase('hi', 1, { lss: at(15), priority: 1, arrival: at(9) }), mkCase('lo', 2, { lss: at(11), priority: 3, arrival: at(9) })]);
  assert(dom.join() === 'lo,hi', 'D55.2c earlier deadline beats better priority', `got ${dom.join()}; expected lo,hi`);

  // Parked-first: a resumed case with a LATER deadline goes before a new case with an earlier one.
  const parkedLate = mkCase('P', 1, { lss: at(15), priority: 1, arrival: at(9), parked: true });
  const freshEarly = mkCase('N', 2, { lss: at(11), priority: 1, arrival: at(10) });
  const pf = drain([parkedLate, freshEarly]);
  assert(pf.join() === 'P,N', 'D55.3a parked case (due 15:00) goes before new case (due 11:00)', `got ${pf.join()}; expected P,N`);
  const pf2 = drain([mkCase('P2', 1, { lss: at(15), priority: 1, arrival: at(9), parked: true }), mkCase('P1', 2, { lss: at(13), priority: 1, arrival: at(9), parked: true }), freshEarly]);
  assert(pf2.join() === 'P1,P2,N', 'D55.3b among parked cases the earlier deadline goes first, then the new case', `got ${pf2.join()}; expected P1,P2,N`);

  // Through the real event loop: one agent busy with a blocker until 09:30; two contenders with the SAME
  // latestSafeStart queue up (priority-2 arrives 09:05, priority-1 arrives 09:10). At 09:30 the priority-1 case must start first.
  const cat55: CategoryConfig[] = [{ id: 'a', name: 'A', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1, primaryWindowMinutes: 600 }];
  const mkRun = (id: string, syn: number, pri: number, arr: Date, lss: Date): any => ({ ...mkCase(id, syn, { lss, priority: pri, arrival: arr }), primaryDeadline: at(17) });
  const run55 = runBackofficeDES({
    operationalHC: 1,
    intervals: [],
    openingWIP: [],
    categories: cat55,
    calendar: BIZ_CAL,
    labor: LABOR,
    sla: { ...DEFAULT_SLA },
    seed: 1,
    precomputedCases: {
      horizonStart: at(9),
      horizonEnd: at(17),
      cases: [mkRun('BLOCK', 1, 1, at(9), at(9)), mkRun('P2', 2, 2, at(9, 5), at(14)), mkRun('P1', 3, 1, at(9, 10), at(14))],
    },
  });
  const start55 = (id: string) => run55.caseResults.find((c) => c.caseId === id)?.firstStartTime?.getTime() ?? NaN;
  assert(
    start55('P1') === at(9, 30).getTime() && start55('P2') === at(10, 0).getTime(),
    'D55.4 event loop: priority-1 contender starts 09:30 (right after the 30-min blocker), priority-2 starts 10:00',
    `P1 start ${new Date(start55('P1')).toTimeString().slice(0, 5)}, P2 start ${new Date(start55('P2')).toTimeString().slice(0, 5)}; expected 09:30 / 10:00`
  );
}

// ---------------------------------------------------------------
// Suite D56 — latestSafeStart walks the BUSINESS calendar (frozen decision 2)
// Deadline Mon 10:00, 180 handling minutes, Mon-Fri 08:00-18:00: Monday 08:00-10:00 holds 120 of them,
// the remaining 60 are taken from the end of the previous working day -> Friday 17:00 (not Monday 07:00 wall clock).
// ---------------------------------------------------------------
console.log('\n--- Suite D56: latestSafeStart walks the business calendar ---');
{
  const slaBiz: SLAPolicyConfig = { ...DEFAULT_SLA, clockBasis: 'business_time', clockStartPolicy: 'next_open' };
  const friday1700 = new Date(2026, 9, 9, 17, 0).getTime();
  const monday1000 = new Date(2026, 9, 12, 10, 0).getTime();

  // Demand site: one case, interval Mon 08:00 for 1 second -> arrival within 1 s of 08:00; window 120 business minutes.
  const catDemand: CategoryConfig[] = [{ id: 'a', name: 'A', ahtMinutes: 180, shrinkagePct: 0.2, priority: 1, primaryWindowMinutes: 120 }];
  const genDemand = generateCaseEntities({
    intervals: [{ intervalIndex: 0, start: new Date(2026, 9, 12, 8, 0, 0), end: new Date(2026, 9, 12, 8, 0, 1), volume: 1, category: 'A' }],
    openingWIP: [],
    categories: catDemand,
    calendar: DEFAULT_CALENDAR,
    sla: slaBiz,
    seed: 42,
  });
  const cd = genDemand.cases[0];
  assert(genDemand.cases.length === 1 && Math.abs(cd.primaryDeadline.getTime() - monday1000) < 1000, 'D56.1a demand case: deadline is Monday 10:00 (08:00 + 120 business min)', `deadline ${cd?.primaryDeadline.toString()}`);
  assert(Math.abs(cd.latestSafeStart.getTime() - friday1700) < 1000, 'D56.1b demand case: latestSafeStart is Friday 17:00 (within 1 s), not a Monday-early wall-clock time', `got ${cd.latestSafeStart.toString()}; expected Fri 2026-10-09 17:00`);
  assert(cd.latestSafeStart.getDay() === 5, 'D56.1c demand case: latestSafeStart falls on a Friday (getDay 5)', `getDay ${cd.latestSafeStart.getDay()}`);

  // Opening-backlog site: remaining work 180 min while the category AHT is 300 -> remaining minutes are used, not total AHT.
  const catWip: CategoryConfig[] = [{ id: 'a', name: 'A', ahtMinutes: 300, shrinkagePct: 0.2, priority: 1, primaryWindowMinutes: 120 }];
  const genWip = generateCaseEntities({
    intervals: [],
    openingWIP: [{ id: 'W1', category: 'A', priority: 1, arrival: new Date(2026, 9, 12, 8, 0), clockStart: new Date(2026, 9, 12, 8, 0), remainingWorkMinutes: 180 }],
    categories: catWip,
    calendar: DEFAULT_CALENDAR,
    sla: slaBiz,
    seed: 42,
  });
  const cw = genWip.cases[0];
  assert(!!cw && cw.primaryDeadline.getTime() === monday1000, 'D56.2a backlog case: deadline is exactly Monday 10:00', `deadline ${cw?.primaryDeadline.toString()}`);
  assert(!!cw && cw.latestSafeStart.getTime() === friday1700, 'D56.2b backlog case: latestSafeStart is exactly Friday 17:00 (180 remaining min; 300 total would give Fri 15:00)', `got ${cw?.latestSafeStart.toString()}; expected Fri 2026-10-09 17:00`);
}

// ---------------------------------------------------------------
// Suite D57 — CI-gated acceptance (frozen decision 8)
// computeStatisticalEvaluation with hand-built replication results (R = 5, t(df 4, 95%) = 2.776).
// Samples [78,82,80,79,81]: mean 80, sd sqrt(2.5)=1.581, SE 0.7071, half-width 1.963 -> CI [78.04, 81.96].
// A mean-based gate passes target 80; the lower-bound gate must fail it. One fixture per gate; all other gates pass.
// ---------------------------------------------------------------
console.log('\n--- Suite D57: CI gates use the confidence bound, not the mean ---');
{
  const catsCI: CategoryConfig[] = [
    { id: 'a', name: 'A', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1, primaryPct: 80 },
    { id: 'b', name: 'B', ahtMinutes: 30, shrinkagePct: 0.2, priority: 2, primaryPct: 80 },
  ];
  const slaCI: SLAPolicyConfig = { ...DEFAULT_SLA, primaryPct: 80, slaAcceptanceSlackEnabled: false, boAsaEnabled: false, occupancyCapEnabled: false, confidenceLevelPct: 95 };
  const failing = [78, 82, 80, 79, 81];
  const passing = [81, 81, 81, 82, 82]; // mean 81.4, sd 0.5477, SE 0.2449, half-width 0.680 -> [80.72, 82.08]
  const allGood = [100, 100, 100, 100, 100];
  const reps = (p: number[], o: { occ?: number[]; asa?: number[]; catA?: number[]; catB?: number[] } = {}): any[] =>
    p.map((v, i) => ({
      primaryAchievedPct: v,
      rawOccupancyPct: o.occ ? o.occ[i] : 50,
      boAsaMeanMinutes: o.asa ? o.asa[i] : 0,
      minCoverageObserved: Infinity,
      categoryStats: { A: { primaryPct: o.catA ? o.catA[i] : 100 }, B: { primaryPct: o.catB ? o.catB[i] : 100 } },
    }));
  const evalCI = (rs: any[], sla: SLAPolicyConfig) =>
    hcNs.computeStatisticalEvaluation(4, rs, rs.map((r) => r.primaryAchievedPct), rs.length, sla, BIZ_CAL, catsCI);

  // T4 — primary gate.
  const pf = evalCI(reps(failing), slaCI);
  assert(pf.primaryStats.achievedPctMean === 80, 'D57.1a primary fixture: mean is 80 (sum 400 / 5)', `got ${pf.primaryStats.achievedPctMean}`);
  assert(approx(pf.primaryStats.ci95Low, 78.0, 0.2) && approx(pf.primaryStats.ci95High, 82.0, 0.2), 'D57.1b primary fixture: CI is [78.0, 82.0] (80 -/+ 2.776*0.7071)', `got [${pf.primaryStats.ci95Low}, ${pf.primaryStats.ci95High}]`);
  assert(pf.passesPrimaryCI === false, 'D57.1c mean 80 meets target 80 but the lower bound 78.0 does not -> passesPrimaryCI false', `got ${pf.passesPrimaryCI}`);
  assert(pf.passesAllConstraints === false && pf.passesOrgGates === false && pf.passesCategorySLA === true && pf.passesCoverage === true, 'D57.1d only the primary gate fails (category, coverage pass; org and overall verdict fail)', JSON.stringify({ c: pf.passesCategorySLA, cov: pf.passesCoverage, o: pf.passesOrgGates, all: pf.passesAllConstraints }));
  assert(pf.failingReasons.length === 1 && /^Primary SLA 95% CI/.test(pf.failingReasons[0]), 'D57.1e exactly one failing reason, the primary one', pf.failingReasons.join(' | '));
  const pp = evalCI(reps(passing), slaCI);
  assert(approx(pp.primaryStats.ci95Low, 80.7, 0.2) && approx(pp.primaryStats.ci95High, 82.1, 0.2), 'D57.2a passing fixture: CI is [80.7, 82.1] (81.4 -/+ 2.776*0.2449)', `got [${pp.primaryStats.ci95Low}, ${pp.primaryStats.ci95High}]`);
  assert(pp.passesPrimaryCI === true && pp.passesAllConstraints === true && pp.failingReasons.length === 0, 'D57.2b lower bound 80.7 >= 80 -> primary passes, nothing fails', JSON.stringify({ p: pp.passesPrimaryCI, all: pp.passesAllConstraints, r: pp.failingReasons }));

  // T5a — per-category gate: org primary perfect, category A is the failing fixture, category B passes.
  const cf = evalCI(reps(allGood, { catA: failing, catB: passing }), slaCI);
  assert(cf.passesPrimaryCI === true && cf.passesCategorySLA === false, 'D57.3a category A mean 80 / lower bound 78.0 -> category gate fails while the org primary gate passes', JSON.stringify({ p: cf.passesPrimaryCI, c: cf.passesCategorySLA }));
  assert(cf.categoryPasses.A === false && cf.categoryPasses.B === true, 'D57.3b categoryPasses: A false, B true (B lower bound 80.7)', JSON.stringify(cf.categoryPasses));
  assert(cf.failingReasons.length === 1 && /^Category 'A' Primary SLA 95% CI/.test(cf.failingReasons[0]), 'D57.3c exactly one failing reason, about category A', cf.failingReasons.join(' | '));
  const cp = evalCI(reps(allGood, { catA: passing, catB: passing }), slaCI);
  assert(cp.categoryPasses.A === true && cp.categoryPasses.B === true && cp.passesAllConstraints === true, 'D57.3d both categories with lower bound 80.7 pass', JSON.stringify(cp.categoryPasses));

  // T5b — occupancy cap 85 uses the UPPER bound: samples [82,86,84,83,85] mean 84 <= 85 but upper 84 + 1.963 = 85.96 > 85.
  const slaOcc: SLAPolicyConfig = { ...slaCI, occupancyCapEnabled: true, occupancyCapPct: 85 };
  const of = evalCI(reps(allGood, { occ: [82, 86, 84, 83, 85] }), slaOcc);
  assert(of.passesOrgGates === false && of.passesPrimaryCI === true && of.passesCategorySLA === true && of.passesCoverage === true, 'D57.4a occupancy mean 84 <= cap 85 but upper bound 85.96 > 85 -> only the occupancy gate fails', JSON.stringify({ o: of.passesOrgGates, p: of.passesPrimaryCI, c: of.passesCategorySLA }));
  assert(of.failingReasons.length === 1 && /^Occupancy 95% CI/.test(of.failingReasons[0]) && /upper bound > cap 85%/.test(of.failingReasons[0]) && /Mean: 84%/.test(of.failingReasons[0]), 'D57.4b exactly one failing reason: occupancy, upper bound > cap 85%, mean 84%', of.failingReasons.join(' | '));
  const op = evalCI(reps(allGood, { occ: [80, 80, 80, 81, 81] }), slaOcc);
  assert(op.passesOrgGates === true && op.failingReasons.length === 0, 'D57.4c occupancy [80,80,80,81,81] (upper bound 81.1 <= 85) passes', op.failingReasons.join(' | '));

  // T5c — BO ASA target 41 min uses the UPPER bound: samples [38,42,40,39,41] mean 40 <= 41 but upper 41.96 > 41.
  const slaAsa: SLAPolicyConfig = { ...slaCI, boAsaEnabled: true, boAsaTarget: 41, boAsaUnit: 'minutes', asaClockBasis: 'business_window' };
  const af = evalCI(reps(allGood, { asa: [38, 42, 40, 39, 41] }), slaAsa);
  assert(af.passesOrgGates === false && af.passesPrimaryCI === true && af.passesCategorySLA === true && af.passesCoverage === true, 'D57.5a ASA mean 40 <= target 41 but upper bound 41.96 > 41 -> only the ASA gate fails', JSON.stringify({ o: af.passesOrgGates, p: af.passesPrimaryCI, c: af.passesCategorySLA }));
  assert(af.failingReasons.length === 1 && /^BO ASA 95% CI/.test(af.failingReasons[0]) && /upper bound > target 41minutes \(41m\)/.test(af.failingReasons[0]), 'D57.5b exactly one failing reason: BO ASA upper bound > target 41 minutes', af.failingReasons.join(' | '));
  const ap = evalCI(reps(allGood, { asa: [38, 38, 38, 39, 39] }), slaAsa);
  assert(ap.passesOrgGates === true && ap.failingReasons.length === 0, 'D57.5c ASA [38,38,38,39,39] (upper bound 39.1 <= 41) passes', ap.failingReasons.join(' | '));
  const aoff = evalCI(reps(allGood, { asa: [38, 42, 40, 39, 41] }), { ...slaAsa, boAsaEnabled: false });
  assert(aoff.passesOrgGates === true, 'D57.5d same ASA samples with the ASA gate switched off -> no ASA verdict', aoff.failingReasons.join(' | '));
}

// ---------------------------------------------------------------
// Suite D58 — Common Random Numbers through the search path (frozen decision 9)
// evaluateCandidateStatistical must run every candidate N on the SAME shared replication case sets.
// Hand-built sets with distinct sizes/outcomes per replication make that visible: rep0 2 cases all in time,
// rep1 3 cases all late (deadline = arrival), rep2 4 cases all in time.
// ---------------------------------------------------------------
console.log('\n--- Suite D58: Common Random Numbers ---');
{
  const at58 = (h: number, m: number = 0) => new Date(2026, 9, 12, h, m);
  const mk58 = (rep: number, i: number, late: boolean): any => ({
    id: `R${rep}-${i}`,
    syntheticId: i + 1,
    category: 'A',
    priority: 1,
    arrival: at58(9),
    clockStart: at58(9),
    totalAhtMinutes: 30,
    remainingWorkMinutes: 30,
    primaryDeadline: late ? at58(9) : at58(17),
    latestSafeStart: late ? at58(8, 30) : at58(16, 30),
    firstStartTime: null,
    completeTime: null,
    parkCount: 0,
    isOpeningWip: false,
  });
  const sizes = [2, 3, 4];
  const sets58 = sizes.map((n, r) => ({ cases: Array.from({ length: n }, (_, i) => mk58(r, i, r === 1)), horizonStart: at58(9), horizonEnd: at58(17) }));
  const cat58: CategoryConfig[] = [{ id: 'a', name: 'A', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1, primaryWindowMinutes: 480 }];
  const ints58: StandardInterval[] = [{ intervalIndex: 0, start: at58(9), end: at58(9, 30), volume: 7, category: 'A' }];
  const evalAt = (n: number) =>
    evaluateCandidateStatistical({
      operationalHC: n,
      intervals: ints58,
      openingWIP: [],
      categories: cat58,
      calendar: BIZ_CAL,
      labor: LABOR,
      sla: { ...DEFAULT_SLA },
      baseSeed: 99,
      replications: 3,
      precomputedCaseSets: sets58,
    });
  const e5 = evalAt(5);
  const e6 = evalAt(6);
  assert(e5.repResults.map((r) => r.totalCases).join() === '2,3,4' && e6.repResults.map((r) => r.totalCases).join() === '2,3,4', 'D58.1 N=5 and N=6 both run the shared sets: totalCases per replication 2,3,4 (the sizes of the sets handed in)', `N5 ${e5.repResults.map((r) => r.totalCases).join()}; N6 ${e6.repResults.map((r) => r.totalCases).join()}; expected 2,3,4`);
  assert(e5.primaryStats.samples.join() === '100,0,100' && e6.primaryStats.samples.join() === '100,0,100', 'D58.2 N=5 and N=6 see the same outcomes: primary % per replication 100,0,100 (rep1 deadlines equal arrival, so every case is late)', `N5 ${e5.primaryStats.samples.join()}; N6 ${e6.primaryStats.samples.join()}; expected 100,0,100`);
  // Generator side: the shared sets are a pure function of (baseSeed, replication) — same arrival times on a rebuild,
  // different arrival times between replications.
  const gen58 = (): any[] =>
    hcNs.generatePrecomputedReplications({
      intervals: [{ intervalIndex: 0, start: at58(9), end: at58(17), volume: 6, category: 'A' }],
      openingWIP: [],
      categories: cat58,
      calendar: BIZ_CAL,
      sla: { ...DEFAULT_SLA },
      baseSeed: 99,
      replications: 3,
    });
  const g1 = gen58();
  const g2 = gen58();
  const arr = (s: any): string => s.cases.map((c: any) => c.arrival.getTime()).join('|');
  assert(g1.length === 3 && g1.every((s: any) => s.cases.length === 6) && g1.map(arr).join('#') === g2.map(arr).join('#'), 'D58.3 generatePrecomputedReplications: 3 sets of 6 cases, identical arrival times when rebuilt with the same seed', `${g1.map((s: any) => s.cases.length).join()}`);
  assert(arr(g1[0]) !== arr(g1[1]), 'D58.4 replications differ from each other (replication 0 and 1 arrivals are not identical)', '');
}

// ---------------------------------------------------------------
// Suite D59 — Unfinished cases count in the SLA denominator (TEST-9)
// 10 cases, 1 agent, AHT 800 min, 8 productive h/day. Horizon Mon 12 Oct, drain until Mon 26 Oct 17:00 = 11 working days
// x 480 min = 5280 min -> floor(5280 / 800) = 6 cases finish (all inside their long deadline); 4 do not.
// ---------------------------------------------------------------
console.log('\n--- Suite D59: unfinished cases stay in the SLA denominator ---');
{
  const at59 = (d: number, h: number, m: number = 0) => new Date(2026, 9, d, h, m);
  const cases59: any[] = Array.from({ length: 10 }, (_, i) => ({
    id: `U${i}`,
    syntheticId: i + 1,
    category: 'A',
    priority: 1,
    arrival: at59(12, 9),
    clockStart: at59(12, 9),
    totalAhtMinutes: 800,
    remainingWorkMinutes: 800,
    primaryDeadline: at59(30, 17),
    latestSafeStart: at59(28, 9),
    firstStartTime: null,
    completeTime: null,
    parkCount: 0,
    isOpeningWip: false,
  }));
  const cat59: CategoryConfig[] = [{ id: 'a', name: 'A', ahtMinutes: 800, shrinkagePct: 0.2, priority: 1, primaryWindowMinutes: 100000 }];
  const r59 = runBackofficeDES({
    operationalHC: 1,
    intervals: [],
    openingWIP: [],
    categories: cat59,
    calendar: BIZ_CAL,
    labor: LABOR,
    sla: { ...DEFAULT_SLA },
    seed: 7,
    skipCaseResultsAndTimeline: true,
    precomputedCases: { cases: cases59, horizonStart: at59(12, 9), horizonEnd: at59(12, 17) },
  });
  assert(r59.totalCases === 10 && r59.completedCases === 6 && r59.unfinishedCases === 4, 'D59.1 6 of 10 cases finish inside horizon + drain (floor(11 x 480 / 800) = 6), 4 unfinished', `total ${r59.totalCases}, completed ${r59.completedCases}, unfinished ${r59.unfinishedCases}; expected 10/6/4`);
  assert(r59.primaryEligibleCount === 10 && r59.primaryPassCount === 6, 'D59.2 SLA denominator is all 10 cases, numerator the 6 finished in time', `eligible ${r59.primaryEligibleCount}, pass ${r59.primaryPassCount}; expected 10 / 6`);
  assert(r59.primaryAchievedPct === 60, 'D59.3 primaryAchievedPct is 60 (6/10), not 100 (6/6)', `got ${r59.primaryAchievedPct}`);
}

// ---------------------------------------------------------------
// Suite D60 — Gross HC: per-category gross-up, sum, one round; harmonic effective shrinkage (frozen decisions 5-7)
// Two categories of equal workload, shrinkage 10% / 40%, 20 operational HC (10 each): 10/0.9 + 10/0.6 = 11.11 + 16.67 = 27.78 -> 28.
// Effective shrinkage = 1 - 1 / (0.5/0.9 + 0.5/0.6) = 1 - 1/1.3889 = 0.28. An arithmetic blend would give 0.25 and round(20 / 0.75) = 27.
// ---------------------------------------------------------------
console.log('\n--- Suite D60: Gross HC and harmonic effective shrinkage ---');
{
  const st60 = calculateStaffingRequirement({
    operationalHC: 20,
    categories: [
      { id: 'l', name: 'Low', ahtMinutes: 30, shrinkagePct: 0.1, priority: 1 },
      { id: 'h', name: 'High', ahtMinutes: 30, shrinkagePct: 0.4, priority: 2 },
    ],
    intervals: [
      { intervalIndex: 0, start: new Date(2026, 9, 5, 9, 0), end: new Date(2026, 9, 5, 9, 30), category: 'Low', volume: 100 },
      { intervalIndex: 1, start: new Date(2026, 9, 6, 9, 0), end: new Date(2026, 9, 6, 9, 30), category: 'High', volume: 100 },
    ],
    openingWIP: [],
    calendar: BIZ_CAL,
    labor: LABOR,
    horizonStart: new Date(2026, 9, 5, 9, 0),
    horizonEnd: new Date(2026, 9, 9, 17, 0),
    bindingConstraint: 'test',
  });
  assert(st60.operationalHCWithOff === 20 && st60.perCategory.length === 2, 'D60.1 5 open days / 5 labor days: OFF floor is the identity, 20 seats split over 2 categories', `got ${st60.operationalHCWithOff}`);
  assert(approx(st60.perCategory[0].operationalHC, 10, 0.01) && approx(st60.perCategory[1].operationalHC, 10, 0.01), 'D60.2 equal workload -> 10 operational HC per category', JSON.stringify(st60.perCategory.map((c) => c.operationalHC)));
  assert(approx(st60.perCategory[0].grossHC, 11.11, 0.01) && approx(st60.perCategory[1].grossHC, 16.67, 0.01), 'D60.3 per-category gross-up: 10/0.9 = 11.11 and 10/0.6 = 16.67', JSON.stringify(st60.perCategory.map((c) => c.grossHC)));
  assert(st60.grossHCTotal === 28, 'D60.4 grossHCTotal = round(11.11 + 16.67) = round(27.78) = 28 (arithmetic blend would give 27)', `got ${st60.grossHCTotal}`);
  assert(approx(st60.effectiveShrinkagePct, 0.28, 0.0006), 'D60.5 effectiveShrinkagePct = 0.28 (harmonic), not 0.25 (arithmetic)', `got ${st60.effectiveShrinkagePct}`);
}

// ---------------------------------------------------------------
// Suite D61 — Volume rounding in case generation
// Interval volumes are rounded half-up (Math.round) into whole cases: 2.5 -> 3, 2.4 -> 2, 0.4 -> 0.
// ---------------------------------------------------------------
console.log('\n--- Suite D61: interval volume rounding ---');
{
  const cat61: CategoryConfig[] = [{ id: 'a', name: 'A', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1, primaryWindowMinutes: 480 }];
  const countFor = (volume: number): number =>
    generateCaseEntities({
      intervals: [{ intervalIndex: 0, start: new Date(2026, 9, 12, 9, 0), end: new Date(2026, 9, 12, 9, 30), volume, category: 'A' }],
      openingWIP: [],
      categories: cat61,
      calendar: BIZ_CAL,
      sla: { ...DEFAULT_SLA },
      seed: 5,
    }).cases.length;
  assert(countFor(2.5) === 3, 'D61.1 volume 2.5 generates 3 cases (half rounds up)', `got ${countFor(2.5)}`);
  assert(countFor(2.4) === 2, 'D61.2 volume 2.4 generates 2 cases', `got ${countFor(2.4)}`);
  assert(countFor(0.4) === 0, 'D61.3 volume 0.4 generates 0 cases', `got ${countFor(0.4)}`);
  assert(countFor(3) === 3, 'D61.4 volume 3 generates 3 cases', `got ${countFor(3)}`);
}

// ---------------------------------------------------------------
// Suite D62 — G1: the planning horizon comes from the DEMAND data only (CSV-13, CSV-14)
// Defect: computeIntervalHorizon (and three hand-rolled copies) pulled the horizon start back to the oldest opening-backlog
// arrival, so the empty days in between counted as planned capacity: N_min, occupancy and the recommendation all fell
// (measured: 1 backlog case 14 days old -> 15 working days, N_min 7 -> 2, recommended 8 -> 7). A stray date years out did
// the same silently. Fix: horizon = demand span; backlog cases are injected at max(arrival, horizonStart) with their own
// clock/deadline untouched; backlog already overdue when the plan starts (D4) is worked but excluded from the SLA % and the
// wait-time mean and reported; an isolated stray date blocks the run; old/overdue backlog is flagged in data quality.
// Fixture (all expected values hand-derived or measured on the unchanged engine, never read back from the code under test):
// Mon-Fri 12-16 Oct 2026, 08:00-17:00 demand, 6 cases per 30-min interval = 5 x 18 x 6 = 540 cases x 30 min = 16200 min = 270 h;
// calendar Mon-Fri 08:00-18:00 (10 h), 7.5 productive h per agent-day: agent-hours over 5 days = 37.5 -> N_occ = ceil(270/37.5) = 8.
// ---------------------------------------------------------------
console.log('\n--- Suite D62: G1 planning horizon from demand data only ---');
{
  const cats62: CategoryConfig[] = [{ id: 'g', name: 'General', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1 }];
  const day62 = (offset: number, h: number, m = 0): Date => new Date(2026, 9, 12 + offset, h, m); // offset from Mon 12 Oct 2026
  const week62 = (firstOffset = 0, volume = 6): StandardInterval[] => {
    const out: StandardInterval[] = [];
    let idx = 0;
    for (let d = 0; d < 5; d++) {
      for (let slot = 0; slot < 18; slot++) {
        const start = day62(firstOffset + d, 8 + Math.floor(slot / 2), (slot % 2) * 30);
        out.push({ intervalIndex: idx++, start, end: new Date(start.getTime() + 30 * 60000), volume, category: 'General' });
      }
    }
    return out;
  };
  const wip62 = (id: string, arrival: Date, remaining = 30) => ({ id, category: 'General', priority: 1, arrival, clockStart: arrival, remainingWorkMinutes: remaining });
  const wipMany62 = (prefix: string, n: number, arrival: Date) => Array.from({ length: n }, (_, i) => wip62(`${prefix}${i}`, arrival));
  const sla62 = (win: number, unit: 'hours' | 'days', extra: Partial<SLAPolicyConfig> = {}): SLAPolicyConfig => ({ ...DEFAULT_SLA, primaryWindow: win, primaryUnit: unit, ...extra });
  const runDes62 = (hc: number, iv: StandardInterval[], wip: any[], sla: SLAPolicyConfig) =>
    runBackofficeDES({ operationalHC: hc, intervals: iv, openingWIP: wip, categories: cats62, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla, seed: 1 });
  const search62 = async (kind: 'sync' | 'async', iv: StandardInterval[], wip: any[], sla: SLAPolicyConfig) => {
    const p = { intervals: iv, openingWIP: wip, categories: cats62, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla, seed: 42, userMaxHC: 200, replications: 8, queueArchitecture: 'pooled' as const };
    return kind === 'sync' ? searchOptimalHC(p) : await searchOptimalHCAsync(p);
  };
  const H0 = day62(0, 8);
  const H1 = day62(4, 17);
  const wk = week62();
  const old14 = wip62('OLD14', new Date(2026, 8, 28, 10, 0)); // Mon 28 Sep 10:00, 14 days before the first demand interval

  // --- A. The horizon function ---
  {
    const hz = computeIntervalHorizon(wk, [old14]);
    assert(hz.horizonStart.getTime() === H0.getTime() && hz.horizonEnd.getTime() === H1.getTime(), 'D62.1 horizon with a 14-day-old backlog case = the demand week itself (Mon 08:00 -> Fri 17:00)', `got ${hz.horizonStart} -> ${hz.horizonEnd}`);
    assert(getCalendarWorkingDaysInHorizon(hz.horizonStart, hz.horizonEnd, DEFAULT_CALENDAR) === 5, 'D62.2 working days stay 5 (were 15)', `got ${getCalendarWorkingDaysInHorizon(hz.horizonStart, hz.horizonEnd, DEFAULT_CALENDAR)}`);
    const hz0 = computeIntervalHorizon(wk, []);
    assert(hz0.horizonStart.getTime() === H0.getTime() && hz0.horizonEnd.getTime() === H1.getTime(), 'D62.3 control: no backlog gives the same horizon');
    const hzIn = computeIntervalHorizon(wk, [wip62('IN', day62(2, 10))]);
    assert(hzIn.horizonStart.getTime() === H0.getTime() && hzIn.horizonEnd.getTime() === H1.getTime(), 'D62.4 control: backlog arriving inside the horizon leaves it unchanged');
    // Backlog-only data (no valid demand rows): start = earliest valid backlog arrival, end = start + 7 days (deterministic, no wall clock).
    const bo = computeIntervalHorizon([], [wip62('B2', new Date(2026, 9, 7, 10, 0)), wip62('B1', new Date(2026, 9, 5, 10, 0))]);
    assert(bo.horizonStart.getTime() === new Date(2026, 9, 5, 10, 0).getTime() && bo.horizonEnd.getTime() - bo.horizonStart.getTime() === 7 * 86400000, 'D62.5 backlog-only fallback: start = earliest backlog arrival, end = start + 7 days', `got ${bo.horizonStart} -> ${bo.horizonEnd}`);
  }

  // --- B. DES: backlog older than the horizon (14 days, 6 h SLA, 10 agents) ---
  // OLD14: arrival/clock Mon 28 Sep 10:00 (open) -> deadline 10:00 + 6 business hours = 16:00 same day; LSS = 16:00 - 30 min = 15:30.
  // The plan starts Mon 12 Oct 08:00, so the case is overdue at start (15:30 on 28 Sep < 12 Oct 08:00): worked, not scored.
  // Handling = (540 + 1) x 30 = 16230 min; occupancy = 16230 / (10 agents x 5 days x 450 min = 22500) = 72.13 -> 72.1% (was 24.0% over 15 days).
  {
    const sla6 = sla62(6, 'hours');
    const rOld = runDes62(10, wk, [old14], sla6);
    const co = rOld.caseResults.find((c) => c.caseId === 'OLD14')!;
    assert(co.arrival.getTime() === new Date(2026, 8, 28, 10, 0).getTime() && co.clockStart.getTime() === new Date(2026, 8, 28, 10, 0).getTime(), 'D62.6 old backlog case keeps its own arrival and clock start');
    assert(co.primaryDeadline.getTime() === new Date(2026, 8, 28, 16, 0).getTime() && co.latestSafeStart.getTime() === new Date(2026, 8, 28, 15, 30).getTime(), 'D62.7 ... and its original deadline (28 Sep 16:00) and latest safe start (15:30)', `deadline ${co.primaryDeadline} lss ${co.latestSafeStart}`);
    assert(co.overdueAtStart === true && co.primaryEligible === false, 'D62.8 rule D4: the case is flagged overdueAtStart and not SLA-eligible', `overdueAtStart=${co.overdueAtStart} eligible=${co.primaryEligible}`);
    assert(co.isCompleted === true && rOld.totalCases === 541 && rOld.completedCases === 541, 'D62.9 it is still worked to completion (541 of 541 cases complete)', `completed ${rOld.completedCases}/${rOld.totalCases}`);
    assert(rOld.overdueAtStartCount === 1 && rOld.primaryEligibleCount === 540, 'D62.10 run result: overdueAtStartCount = 1; SLA denominator = the 540 other cases', `count=${rOld.overdueAtStartCount} eligible=${rOld.primaryEligibleCount}`);
    assert(approx(rOld.totalHandlingMinutes, 16230, 0.01) && rOld.rawOccupancyPct === 72.1, 'D62.11 its 30 minutes count as workload: handling 16230 min, occupancy 72.1% over the 5-day planned horizon', `handling=${rOld.totalHandlingMinutes} occ=${rOld.rawOccupancyPct}`);
    const before = rOld.agentTimeline.filter((s) => s.from.getTime() < H0.getTime());
    assert(before.length === 0, 'D62.12 no timeline slice before the horizon start (no free pre-horizon capacity)', `${before.length} slices, first ${before[0]?.from}`);
    assert(rOld.caseResults.every((c) => c.firstStartTime === null || c.firstStartTime.getTime() >= H0.getTime()), 'D62.13 every case starts at or after the horizon start');
    assert(co.firstStartTime !== null && co.firstStartTime.getTime() === H0.getTime(), 'D62.14 the overdue case sorts first (EDF) and starts at the first working instant, Mon 08:00', `first start ${co.firstStartTime}`);
    assert(co.asaDurationMinutes <= 5, 'D62.15 its wait is measured from the horizon start, not from 28 Sep (<= 5 min, not ~14 days)', `asa ${co.asaDurationMinutes}`);
    const rNone = runDes62(10, wk, [], sla6);
    assert(rNone.totalCases === 540 && rNone.overdueAtStartCount === 0 && rNone.rawOccupancyPct === 72.0, 'D62.16 control: no backlog -> 540 cases, overdueAtStartCount 0, occupancy 72.0% (16200/22500)', `cases=${rNone.totalCases} count=${rNone.overdueAtStartCount} occ=${rNone.rawOccupancyPct}`);
  }

  // --- C. Backlog already due Friday, plan starts Monday: 40 cases overdue at start (rule D4) ---
  // Arrival Fri 9 Oct 10:00, 6 h SLA -> due Fri 16:00 < Mon 12 Oct 08:00 for all 40. SLA % must be over the 540 demand cases only.
  {
    const fri40 = wipMany62('F', 40, new Date(2026, 9, 9, 10, 0));
    const r = runDes62(10, wk, fri40, sla62(6, 'hours'));
    const demandCases = r.caseResults.filter((c) => !c.isOpeningWip);
    const passed = demandCases.filter((c) => c.primaryPassed).length;
    assert(r.overdueAtStartCount === 40 && r.caseResults.filter((c) => c.overdueAtStart).length === 40, 'D62.17 overdueAtStartCount = 40', `count=${r.overdueAtStartCount}`);
    assert(r.primaryEligibleCount === 540 && r.primaryPassCount === passed && r.primaryAchievedPct === Math.round((passed / 540) * 1000) / 10, 'D62.18 SLA % is computed over the 540 other cases only (hand count of passes)', `eligible=${r.primaryEligibleCount} pass=${r.primaryPassCount}/${passed} pct=${r.primaryAchievedPct}`);
    assert(r.categoryStats['General'].primaryEligible === 540 && r.categoryStats['General'].overdueAtStartCount === 40, 'D62.19 per-category SLA also excludes them (eligible 540, overdueAtStartCount 40)', JSON.stringify(r.categoryStats['General']));
    assert(r.completedCases === 580 && r.caseResults.filter((c) => c.overdueAtStart && c.isCompleted).length === 40 && approx(r.totalHandlingMinutes, 17400, 0.01), 'D62.20 all 40 are worked to completion and counted in handling minutes (580 x 30 = 17400)', `done=${r.completedCases} handling=${r.totalHandlingMinutes}`);
    const mean = demandCases.reduce((a, c) => a + c.asaDurationMinutes, 0) / demandCases.length;
    assert(Math.abs(mean - r.boAsaMeanMinutes) <= 0.15, 'D62.21 the wait-time mean is over the 540 demand cases only (independent mean from the case list)', `list mean ${mean.toFixed(3)} vs run ${r.boAsaMeanMinutes}`);
    // Unfinished-case scoring (D59) must still hold for non-excluded cases: 1 agent cannot finish the demand, so unfinished demand cases fail.
    const rThin = runDes62(1, wk, fri40, sla62(6, 'hours'));
    const thinUnfinished = rThin.caseResults.filter((c) => !c.isOpeningWip && !c.isCompleted);
    assert(thinUnfinished.length > 0 && thinUnfinished.every((c) => c.primaryEligible && !c.primaryPassed) && rThin.primaryEligibleCount === 540, 'D62.22 unfinished demand cases still count as SLA failures at HC 1 (eligible stays 540)', `unfinished demand ${thinUnfinished.length} eligible ${rThin.primaryEligibleCount}`);
  }

  // --- D. Attainable pre-horizon backlog is still scored, against its ORIGINAL deadline ---
  // Arrival Fri 9 Oct 10:00, 3 business days = 1800 min. Working time: Fri 10:00-18:00 = 480, Mon 600 -> 1080, Tue 600 -> 1680, Wed needs 120 -> Wed 14 Oct 10:00.
  // LSS = 10:00 - 30 = 09:30 Wed 14 Oct, later than Mon 12 Oct 08:00 -> attainable, NOT overdue at start.
  {
    const att = wip62('ATT', new Date(2026, 9, 9, 10, 0));
    const r = runDes62(10, wk, [att], sla62(3, 'days'));
    const c = r.caseResults.find((x) => x.caseId === 'ATT')!;
    assert(c.overdueAtStart === false && c.primaryEligible === true && r.overdueAtStartCount === 0 && r.primaryEligibleCount === 541, 'D62.23 attainable old backlog is NOT overdue at start and stays in the SLA denominator (541)', `overdue=${c.overdueAtStart} eligible=${r.primaryEligibleCount}`);
    assert(c.primaryDeadline.getTime() === new Date(2026, 9, 14, 10, 0).getTime() && c.latestSafeStart.getTime() === new Date(2026, 9, 14, 9, 30).getTime(), 'D62.24 its deadline is the hand-computed Wed 14 Oct 10:00 (LSS 09:30)', `deadline ${c.primaryDeadline}`);
    assert(c.primaryPassed === true && c.completeTime !== null && c.completeTime.getTime() <= c.primaryDeadline.getTime(), 'D62.25 scored against that original deadline: completed Monday, passed');
    assert(c.asaDurationMinutes <= 5, 'D62.26 wait measured from the horizon start (<= 5 min; measured from Friday 10:00 it would be 480 working minutes)', `asa ${c.asaDurationMinutes}`);
  }

  // --- E. Backlog arriving inside the horizon behaves exactly as before ---
  // Digest literals were measured on the engine BEFORE the change (3 cases arriving Mon 12 Oct 10:00, 10 agents, 6 h SLA, seed 1).
  {
    const inH = wipMany62('IN', 3, day62(0, 10));
    const r = runDes62(10, wk, inH, sla62(6, 'hours'));
    let fs = 0;
    let cs = 0;
    for (const c of r.caseResults) {
      fs += c.firstStartTime ? Math.round((c.firstStartTime.getTime() - H0.getTime()) / 1000) : 0;
      cs += c.completeTime ? Math.round((c.completeTime.getTime() - H0.getTime()) / 1000) : 0;
    }
    // Re-pinned 2026-10-08 (P2-9: non-24x7 runs without a start distribution now end each agent's shift dailyProductiveHours
    // after open). This default 08:00-18:00 / 7.5 h calendar has no distribution, so each agent now leaves 450 min after open and
    // cases arriving in the last 2.5 h wait for the next morning. Totals / completed / SLA 100% / occupancy 72.4% / handling 16290
    // are unchanged (demand and planned capacity are the same); boAsaMeanMinutes moves 0 -> 25.3 (mean first-start wait is no
    // longer zero) and the start/complete digests move 102067875 / 103045275 -> 110536781 / 114332981.
    assert(r.totalCases === 543 && r.completedCases === 543 && r.primaryAchievedPct === 100 && r.rawOccupancyPct === 72.4 && approx(r.boAsaMeanMinutes, 25.3, 0.05) && approx(r.totalHandlingMinutes, 16290, 0.01), 'D62.27 control: in-horizon backlog headline numbers (totals/SLA/occupancy/handling unchanged; ASA mean 25.3 min under fixed shifts, was 0)', JSON.stringify({ t: r.totalCases, p: r.primaryAchievedPct, o: r.rawOccupancyPct, a: r.boAsaMeanMinutes, h: r.totalHandlingMinutes }));
    assert(fs === 110536781 && cs === 114332981, 'D62.28 control: case start/complete time digest under fixed shifts (was 102067875 / 103045275 before P2-9)', `fs=${fs} cs=${cs}`);
    assert((r.overdueAtStartCount ?? 0) === 0 && r.caseResults.every((c) => !c.overdueAtStart), 'D62.29 control: in-horizon backlog is never flagged overdue at start');
  }

  // --- F. The search: N_min / N_occ / recommendation, sync and async ---
  {
    const sla6 = sla62(6, 'hours');
    const sla3d = sla62(3, 'days');
    const none = await search62('sync', wk, [], sla6);
    assert(none.nMinAnalytical === 7 && none.occupancyFeasibleFloor === 8 && none.recommendedHC === 8, 'D62.30 control: no backlog -> N_min 7, N_occ 8, recommended 8 (N_occ = ceil(270/37.5) = 8)', `nmin=${none.nMinAnalytical} nocc=${none.occupancyFeasibleFloor} rec=${none.recommendedHC}`);
    for (const [label, sla] of [['6 h', sla6], ['3-day', sla3d]] as Array<[string, SLAPolicyConfig]>) {
      const s = await search62('sync', wk, [old14], sla);
      const a = await search62('async', wk, [old14], sla);
      assert(s.nMinAnalytical === 7 && s.occupancyFeasibleFloor === 8 && a.nMinAnalytical === 7 && a.occupancyFeasibleFloor === 8, `D62.31 (${label}) one 14-day-old backlog case leaves N_min 7 / N_occ 8 untouched, sync and async (were 2 / 3)`, `sync ${s.nMinAnalytical}/${s.occupancyFeasibleFloor} async ${a.nMinAnalytical}/${a.occupancyFeasibleFloor}`);
      assert((s.recommendedHC ?? 0) >= 8 && s.recommendedHC === a.recommendedHC, `D62.32 (${label}) recommendation >= 8 and sync = async (were 7 at 6 h, 5 at 3-day)`, `sync=${s.recommendedHC} async=${a.recommendedHC}`);
      assert(!!s.finalDESResult && !!a.finalDESResult && s.finalDESResult.horizonStart.getTime() === H0.getTime() && a.finalDESResult.horizonStart.getTime() === H0.getTime() && s.finalDESResult.horizonEnd.getTime() === H1.getTime() && a.finalDESResult.horizonEnd.getTime() === H1.getTime(), `D62.33 (${label}) both searches report the demand-span horizon (Mon 08:00 -> Fri 17:00)`, `sync ${s.finalDESResult?.horizonStart} async ${a.finalDESResult?.horizonStart}`);
    }
    // 50 old backlog cases are real extra work: 540 + 50 = 590 cases x 30 = 17700 min handled; recommendation not below baseline.
    const a50 = await search62('async', wk, wipMany62('B', 50, new Date(2026, 8, 28, 10, 0)), sla6);
    assert((a50.recommendedHC ?? 0) >= 8 && (a50.nMinAnalytical ?? 0) >= 7, 'D62.34 50 old backlog cases: recommendation >= baseline 8, N_min >= 7', `rec=${a50.recommendedHC} nmin=${a50.nMinAnalytical}`);
    assert(!!a50.finalDESResult && approx(a50.finalDESResult.totalHandlingMinutes, 17700, 0.01) && a50.finalDESResult.overdueAtStartCount === 50, 'D62.35 their 1500 minutes are in the handled workload (17700 total) and reported as 50 overdue at start', `handling=${a50.finalDESResult?.totalHandlingMinutes} overdue=${a50.finalDESResult?.overdueAtStartCount}`);
    // Friday carry-over: 40 cases already overdue when the plan starts must not push the search to the cap.
    const fri40 = wipMany62('F', 40, new Date(2026, 9, 9, 10, 0));
    const sf = await search62('sync', wk, fri40, sla6);
    const af = await search62('async', wk, fri40, sla6);
    assert(sf.recommendedHC !== null && !sf.isInfeasible && (sf.recommendedHC ?? 0) >= 8 && (sf.recommendedHC ?? 999) < 200, 'D62.36 Friday carry-over (40 overdue at start): recommendation finite, >= 8, nowhere near the cap of 200', `rec=${sf.recommendedHC} infeasible=${sf.isInfeasible}`);
    assert(sf.recommendedHC === af.recommendedHC && sf.nMinAnalytical === af.nMinAnalytical && sf.finalDESResult?.overdueAtStartCount === 40 && af.finalDESResult?.overdueAtStartCount === 40, 'D62.37 sync = async on the Friday carry-over; both report 40 overdue at start', `sync=${sf.recommendedHC} async=${af.recommendedHC}`);
    // Wait-time gate ON must not fail solely because of old backlog.
    const slaAsa = sla62(6, 'hours', { boAsaEnabled: true, boAsaTarget: 60, boAsaUnit: 'minutes' });
    const sAsa = await search62('sync', wk, [old14], slaAsa);
    assert(!sAsa.isInfeasible && (sAsa.recommendedHC ?? 0) >= 8 && sAsa.finalDESResult?.passesBOASA === true, 'D62.38 ASA gate ON with one 14-day-old backlog case: the run still passes the gate at the recommendation', `rec=${sAsa.recommendedHC} asa=${sAsa.finalDESResult?.boAsaMeanMinutes} pass=${sAsa.finalDESResult?.passesBOASA}`);
  }

  // --- G. Data quality ---
  {
    const mapping62: any = { intervalStartCol: 'IntervalStart', volumeCol: 'Volume', categoryCol: 'Category' };
    const dq62 = (iv: StandardInterval[], wip: any[] = []) =>
      validateDataQuality({ intervals: iv, mapping: mapping62, categories: cats62, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: DEFAULT_SLA, openingWIP: wip });
    const stray = (d: Date): StandardInterval => ({ intervalIndex: 9999, start: d, end: new Date(d.getTime() + 30 * 60000), volume: 1, category: 'General' });
    const isoLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const isolated = (r: ReturnType<typeof dq62>) => r.issues.find((i) => i.severity === 'error' && /isolated/i.test(i.field + i.message));

    // Last data day = Fri 16 Oct. Empty days between it and a stray row on date S = (S - Fri 16 Oct) - 1.
    const rBase = dq62(wk);
    assert(rBase.passed === true && !isolated(rBase), 'D62.39 control: the clean week passes with no isolated-date error', JSON.stringify(rBase.issues.map((i) => i.field)));
    const r2y = dq62([...wk, stray(new Date(2028, 9, 12, 9, 0))]);
    const e2y = isolated(r2y);
    assert(r2y.passed === false && !!e2y, 'D62.40 one row two years out: BLOCKING error "Isolated date(s)..."', JSON.stringify(r2y.issues.map((i) => i.severity + ':' + i.field)));
    assert(!!e2y && e2y.message.includes('2028-10-12') && e2y.message.includes('2026-10-12') && e2y.message.includes('2026-10-16'), 'D62.41 the message names the isolated date and the main data range (2026-10-12 to 2026-10-16)', e2y?.message);
    const r30 = dq62([...wk, stray(day62(35, 9))]); // Mon 16 Nov: Oct 17..Nov 15 = 30 empty days
    assert(r30.passed === false && !!isolated(r30), 'D62.42 30 empty days before an isolated row: blocked (G1-a: rule is now "more than 7")', JSON.stringify(r30.issues.map((i) => i.severity + ':' + i.field)));
    const r31 = dq62([...wk, stray(day62(36, 9))]); // Tue 17 Nov: Oct 17..Nov 16 = 31 empty days
    assert(r31.passed === false && !!isolated(r31) && isolated(r31)!.message.includes(isoLocal(day62(36, 9))), 'D62.43 31 empty days before an isolated row: blocked, naming the date', JSON.stringify(r31.issues.map((i) => i.severity + ':' + i.field)));
    const r10 = dq62([...wk, stray(day62(14, 9))]); // Mon 26 Oct: 9 empty days
    assert(r10.passed === false && !!isolated(r10), 'D62.44 a stray row 10 days out: BLOCKING error (G1-a: empty run longer than 7 days)', JSON.stringify(r10.issues.map((i) => i.severity + ':' + i.field)));
    const closure = dq62([...wk, ...week62(42)]); // 12-16 Oct, then Mon 23 Nov: Oct 17..Nov 22 = 37 empty days, 90 rows each side
    assert(closure.passed === true && !isolated(closure), 'D62.45 a 37-day closure with 90 rows on each side: not blocked', JSON.stringify(closure.issues.map((i) => i.severity + ':' + i.field)));
    assert(closure.issues.some((i) => i.severity === 'warning' && /more than 30/.test(i.message + (i.details ?? ''))), 'D62.46 ... but a warning says the empty run is longer than 30 days', JSON.stringify(closure.issues.map((i) => i.field)));

    // Old backlog arrival: more than 30 calendar days before the first demand interval (Mon 12 Oct).
    const oldW = (arr: Date) => dq62(wk, [wip62('OLDW', arr)]).issues.find((i) => i.severity === 'warning' && /old backlog/i.test(i.field));
    const w31 = oldW(new Date(2026, 8, 11, 10, 0)); // 31 days before
    assert(!!w31 && w31.message.includes('OLDW'), 'D62.47 backlog 31 days before the first interval: warning naming the case', w31?.message);
    assert(!oldW(new Date(2026, 8, 12, 10, 0)), 'D62.48 backlog 30 days before: no old-backlog warning');
    const rTypo = dq62(wk, [wip62('TYPO', new Date(2006, 9, 9, 10, 0))]);
    assert(rTypo.passed === true && rTypo.issues.some((i) => i.severity === 'warning' && /old backlog/i.test(i.field) && i.message.includes('TYPO')), 'D62.49 backlog dated 2006: warning naming the case, run still allowed', JSON.stringify(rTypo.issues.map((i) => i.severity + ':' + i.field)));

    // Overdue-at-start count warning.
    const overdueW = (wip: any[]) => dq62(wk, wip).issues.find((i) => i.severity === 'warning' && /overdue at start/i.test(i.field + i.message));
    const w40 = overdueW(wipMany62('F', 40, new Date(2026, 9, 9, 10, 0)));
    assert(!!w40 && /\b40\b/.test(w40.message), 'D62.50 40 Friday backlog cases: warning stating 40 will be overdue at start', w40?.message);
    assert(!overdueW([]) && !overdueW([wip62('IN', day62(0, 10))]), 'D62.51 no backlog, or backlog inside the horizon: no overdue-at-start warning');
  }
}

// ---------------------------------------------------------------
// Suite D63 — G1-a: the isolated-date block now starts at an empty run LONGER THAN 7 calendar days
// A mistyped date close to the data (wrong month, a row 10 days after the end) used to only warn and still stretched the
// planning horizon (N_min 7 -> 3 in a probe). Rule: empty run of 8 or more days between two data dates AND the smaller side
// isolated (<= 1% of rows, min 1 / max 20) -> blocking error. All expectations hand-derived from the dates below.
// Fixture: Mon-Fri 12-16 Oct 2026, 90 intervals; last data day Fri 16 Oct. Empty days to a stray on date S = (S - 16 Oct) - 1.
// ---------------------------------------------------------------
console.log('\n--- Suite D63: G1-a stray date blocks from 8 empty days ---');
{
  const cats63: CategoryConfig[] = [{ id: 'g', name: 'General', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1 }];
  const mapping63: any = { intervalStartCol: 'IntervalStart', volumeCol: 'Volume', categoryCol: 'Category' };
  const d63 = (offset: number, h = 8, m = 0): Date => new Date(2026, 9, 12 + offset, h, m); // offset from Mon 12 Oct 2026
  const iv63 = (start: Date, i = 0): StandardInterval => ({ intervalIndex: i, start, end: new Date(start.getTime() + 30 * 60000), volume: 6, category: 'General' });
  const week63 = (firstOffset = 0): StandardInterval[] => {
    const out: StandardInterval[] = [];
    for (let d = 0; d < 5; d++) for (let slot = 0; slot < 18; slot++) out.push(iv63(d63(firstOffset + d, 8 + Math.floor(slot / 2), (slot % 2) * 30), out.length));
    return out;
  };
  const dq63 = (iv: StandardInterval[]) =>
    validateDataQuality({ intervals: iv, mapping: mapping63, categories: cats63, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: DEFAULT_SLA, openingWIP: [] });
  const iso63 = (r: ReturnType<typeof dq63>) => r.issues.find((i) => i.severity === 'error' && /isolated/i.test(i.field + i.message));
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const tags = (r: ReturnType<typeof dq63>) => JSON.stringify(r.issues.map((i) => i.severity + ':' + i.field));
  const wk63 = week63();

  // 1. Near stray date blocks (after and before the data)
  const after = dq63([...wk63, iv63(d63(14, 9), 9999)]); // Mon 26 Oct: 9 empty days
  const eAfter = iso63(after);
  assert(after.passed === false && !!eAfter, 'D63.1 a stray row 10 days after the data (9 empty days): BLOCKING error', tags(after));
  assert(!!eAfter && eAfter.message.includes('2026-10-26') && eAfter.message.includes('1 row') && eAfter.message.includes('2026-10-12') && eAfter.message.includes('2026-10-16') && /\b9\b/.test(eAfter.message), 'D63.2 the message names the date, 1 row, the main range (2026-10-12 to 2026-10-16) and the 9 empty days', eAfter?.message);
  const before = dq63([...wk63, iv63(d63(-9, 9), 9999)]); // Sun 3 Oct: 8 empty days (4..11 Oct)
  assert(before.passed === false && !!iso63(before) && iso63(before)!.message.includes('2026-10-03'), 'D63.3 a stray row 9 days BEFORE the data (8 empty days): blocked, naming the date', tags(before));

  // 2. Month typo blocks
  const typo = dq63([...wk63, iv63(new Date(2026, 10, 13, 9, 0), 9999)]); // Fri 13 Nov (typed 11 for 10)
  assert(typo.passed === false && !!iso63(typo) && iso63(typo)!.message.includes('2026-11-13'), 'D63.4 an October week plus one row a month later: blocked', tags(typo));

  // 3. Normal gaps do not block
  const next = dq63([...wk63, ...week63(7)]); // Mon-Fri, then next Mon-Fri: 2 empty days
  assert(next.passed === true && !iso63(next) && next.issues.length === 0, 'D63.5 consecutive weeks (2 empty days): no issue at all', tags(next));
  const closure9 = dq63([...wk63, ...week63(14)]); // Mon 26 Oct: 9 empty days, 90 rows each side
  assert(closure9.passed === true && !iso63(closure9), 'D63.6 a 9-day closure with substantial data on both sides: not blocked', tags(closure9));
  const e7 = dq63([...wk63, iv63(d63(12, 9), 9999)]); // Sat 24 Oct: 17..23 Oct = 7 empty days
  assert(e7.passed === true && !iso63(e7), 'D63.7 isolated row after exactly 7 empty days: not blocked (boundary)', tags(e7));
  const e8 = dq63([...wk63, iv63(d63(13, 9), 9999)]); // Sun 25 Oct: 8 empty days
  assert(e8.passed === false && !!iso63(e8) && iso63(e8)!.message.includes('2026-10-25'), 'D63.8 isolated row after 8 empty days: blocked', tags(e8));

  // 4. Small files are safe: 15 rows on Mon 12 Oct, 15 rows on Thu 22 Oct (9 empty days), neither side isolated (limit = 1)
  const small: StandardInterval[] = [];
  for (let s = 0; s < 15; s++) small.push(iv63(d63(0, 8 + Math.floor(s / 2), (s % 2) * 30), small.length));
  for (let s = 0; s < 15; s++) small.push(iv63(d63(10, 8 + Math.floor(s / 2), (s % 2) * 30), small.length));
  const rSmall = dq63(small);
  assert(!iso63(rSmall), 'D63.9 two days 10 days apart with 15 rows each: no isolated-date error', tags(rSmall));
}

// ---------------------------------------------------------------
// Suite D64 - F2 (DES-8): on a 24x7 calendar a budget-exhausted park hands the case back at once
// (CaseResume at nextOpen(now) = now), instead of holding it in parkedWIP until the next calendar midnight
// while other agents sit idle with budget. Hand-built precomputedCases, every time derived by hand.
// Budget = 7.5 h x adherence. Mon 12 Oct 2026 is day 1.
// ---------------------------------------------------------------
console.log('\n--- Suite D64: F2 24x7 park resumes when capacity exists ---');
{
  const catF2: CategoryConfig[] = [{ id: 'g', name: 'General', ahtMinutes: 240, shrinkagePct: 0.2, priority: 1, primaryWindowMinutes: 1440 }];
  const f2At = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m);
  const f2Case = (id: string, syn: number, arr: Date, aht: number, windowH = 24): CaseEntity => {
    const dl = new Date(arr.getTime() + windowH * 3600000);
    return {
      id, syntheticId: syn, category: 'General', priority: 1, arrival: arr, clockStart: arr, totalAhtMinutes: aht,
      remainingWorkMinutes: aht, primaryDeadline: dl, latestSafeStart: new Date(dl.getTime() - aht * 60000),
      firstStartTime: null, completeTime: null, parkCount: 0, isOpeningWip: false,
    };
  };
  const labF2 = (adh: number): LaborConfig => ({ ...DEFAULT_LABOR, dailyProductiveHours: 7.5, adherencePct: adh, workingDaysPerWeek: 7, offDaysPerWeek: 0 });
  const slaF2: SLAPolicyConfig = { ...DEFAULT_SLA, primaryWindow: 24, primaryUnit: 'hours' };
  const stagF2 = (offsets: number[]): ShiftDistributionByCategory => ({ __POOLED__: { slapMinutes: 60, slaps: offsets.map((o) => ({ startMinutesFromOpen: o, agentCount: 1 })) } } as any);
  const runF2 = (cases: CaseEntity[], hc: number, adh: number, offsets: number[] | null, seed = 7) =>
    runBackofficeDES({
      operationalHC: hc, intervals: [], openingWIP: [], categories: catF2, calendar: CAL_24X7, labor: labF2(adh), sla: slaF2, seed,
      shiftDistribution: offsets ? stagF2(offsets) : undefined,
      precomputedCases: { cases, horizonStart: f2At(12, 0), horizonEnd: f2At(13, 0) },
    });
  const dayKeyF2 = (d: Date) => d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();
  const busyF2 = (des: any) => (des.agentTimeline as any[]).filter((s) => s.state === 'busy');
  const slicesOf = (des: any, id: string) => busyF2(des).filter((s) => s.caseId === id).sort((a, b) => a.from - b.from);
  const hhmm = (d: Date) => `${d.getDate()}/${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  // Avoidable waits: a park gap where, at some 5-minute sample inside the gap, ANOTHER agent was idle, had daily
  // budget left, and (staggered) was inside its own shift window. 0 on a correct engine.
  const avoidable = (des: any, hc: number, adh: number, offsets: number[] | null): number => {
    const budget = 450 * adh;
    const sl = busyF2(des);
    const byCase = new Map<string, any[]>();
    for (const s of sl) { if (!byCase.has(s.caseId)) byCase.set(s.caseId, []); byCase.get(s.caseId)!.push(s); }
    let n = 0;
    for (const arr of byCase.values()) {
      arr.sort((a, b) => a.from - b.from);
      for (let i = 0; i + 1 < arr.length; i++) {
        const a = arr[i], b = arr[i + 1];
        if ((b.from - a.to) / 60000 <= 0.01) continue;
        let found = false;
        for (let t = a.to.getTime(); t < b.from.getTime() && !found; t += 5 * 60000) {
          for (let ag = 0; ag < hc && !found; ag++) {
            if (sl.some((s) => s.agentId === ag && s.from.getTime() <= t && t < s.to.getTime())) continue;
            let used = 0;
            for (const s of sl) if (s.agentId === ag && s.from.getTime() <= t && dayKeyF2(s.from) === dayKeyF2(new Date(t))) used += (Math.min(s.to.getTime(), t) - s.from.getTime()) / 60000;
            let inShift = true;
            if (offsets) { const d0 = new Date(t); d0.setHours(0, 0, 0, 0); const st = d0.getTime() + offsets[ag] * 60000; inShift = t >= st && t < st + 450 * 60000; }
            if (inShift && used < budget - 0.01) found = true;
          }
        }
        if (found) n++;
      }
    }
    return n;
  };
  const budgetOk = (des: any, adh: number): boolean => {
    const per = new Map<string, number>();
    for (const s of busyF2(des)) { const k = `${s.agentId}:${dayKeyF2(s.from)}`; per.set(k, (per.get(k) ?? 0) + (s.to - s.from) / 60000); }
    return [...per.values()].every((v) => v <= 450 * adh + 0.01);
  };
  const fmtSl = (a: any[]) => a.map((s) => `ag${s.agentId}@${hhmm(s.from)}-${hhmm(s.to)}`).join(' ');

  // (a) all on one shift, 3 agents. W1-W3 400 min each from 00:00 (agents left with 50 min). D (due 12 h) and E (due 24 h),
  // 100 min, arrive 06:40: two agents take them, work 50 min each, budget gone at 07:30 -> both park with 50 left.
  // The third agent is idle with 50 min: D (earlier deadline) must resume 07:30-08:20 on it. E: nobody has budget -> waits for
  // the day reset (Tue 13 Oct 00:00), legitimate.
  const casesA = [
    f2Case('W1', 1, f2At(12, 0), 400), f2Case('W2', 2, f2At(12, 0), 400), f2Case('W3', 3, f2At(12, 0), 400),
    f2Case('D', 4, f2At(12, 6, 40), 100, 12), f2Case('E', 5, f2At(12, 6, 40), 100),
  ];
  const dA = runF2(casesA, 3, 1.0, null);
  const dSl = slicesOf(dA, 'D'), eSl = slicesOf(dA, 'E');
  assert(avoidable(dA, 3, 1.0, null) === 0, 'D64.1 24x7 one shift: 0 avoidable waits (before the fix: 2, D and E both waited to midnight)', `avoidable=${avoidable(dA, 3, 1.0, null)}`);
  assert(dSl.length === 2 && hhmm(dSl[0].from) === '12/6:40' && hhmm(dSl[0].to) === '12/7:30' && hhmm(dSl[1].from) === '12/7:30' && hhmm(dSl[1].to) === '12/8:20' && dSl[0].agentId !== dSl[1].agentId,
    'D64.2 case D: 06:40-07:30 on one agent, resumes at 07:30 on the agent that still has budget, done 08:20 (same day)', fmtSl(dSl));
  assert(eSl.length === 2 && hhmm(eSl[1].from) === '13/0:00' && hhmm(eSl[1].to) === '13/0:50',
    'D64.3 case E (nobody has budget at 07:30): resumes at the day reset, Tue 00:00-00:50', fmtSl(eSl));
  assert(budgetOk(dA, 1.0), 'D64.4 no agent works beyond its 450-min daily budget (scenario a)', '');

  // (b) staggered 0/8/16 h, adherence 0.9 (budget 405; shift windows 00:00-07:30 / 08:00-15:30 / 16:00-23:30).
  // C1 00:00 (240) and C2 01:00 (240): the 00:00 agent works C1 00:00-04:00, then C2 04:00-06:45 (165 min = budget gone) and parks with 75 left.
  // The 08:00 cohort starts -> C2 must resume 08:00-09:15 the same day, not Tue 00:00.
  const offs = [0, 480, 960];
  const casesB = [f2Case('C1', 1, f2At(12, 0), 240), f2Case('C2', 2, f2At(12, 1), 240), f2Case('C3', 3, f2At(12, 17), 240), f2Case('C4', 4, f2At(12, 18), 240)];
  const dB = runF2(casesB, 3, 0.9, offs);
  const c2 = slicesOf(dB, 'C2');
  assert(avoidable(dB, 3, 0.9, offs) === 0, 'D64.5 24x7 staggered 0/8/16 h, adherence 0.9: 0 avoidable waits (before the fix: C2 waited to midnight)', `avoidable=${avoidable(dB, 3, 0.9, offs)}`);
  assert(c2.length === 2 && hhmm(c2[0].from) === '12/4:00' && hhmm(c2[0].to) === '12/6:45' && hhmm(c2[1].from) === '12/8:00' && hhmm(c2[1].to) === '12/9:15',
    'D64.6 C2 parks 06:45 (budget) and resumes 08:00 when the second cohort starts, done 09:15', fmtSl(c2));
  // no work outside any agent's own shift window, none beyond budget
  const outside = busyF2(dB).filter((s: any) => { const d0 = new Date(s.from); d0.setHours(0, 0, 0, 0); const st = d0.getTime() + offs[s.agentId] * 60000; return s.from.getTime() < st || s.to.getTime() > st + 450 * 60000; });
  assert(outside.length === 0 && budgetOk(dB, 0.9), 'D64.7 staggered: every busy slice inside its agent shift window and within the 405-min budget', `outside=${outside.length}`);

  // (c) all agents exhausted: 2 agents, W1/W2 400 min, D/E 100 min at 06:40 -> both park 07:30, nobody has budget.
  const dC = runF2([f2Case('W1', 1, f2At(12, 0), 400), f2Case('W2', 2, f2At(12, 0), 400), f2Case('D', 3, f2At(12, 6, 40), 100), f2Case('E', 4, f2At(12, 6, 40), 100)], 2, 1.0, null);
  const dcD = slicesOf(dC, 'D'), dcE = slicesOf(dC, 'E');
  assert(dcD.length === 2 && dcE.length === 2 && hhmm(dcD[0].to) === '12/7:30' && hhmm(dcD[1].from) === '13/0:00' && hhmm(dcE[1].from) === '13/0:00',
    'D64.8 every agent exhausted: D and E wait to the next budget reset (Tue 00:00) - legitimate wait, not an avoidable one', `D ${fmtSl(dcD)} E ${fmtSl(dcE)}`);
  assert(avoidable(dC, 2, 1.0, null) === 0 && budgetOk(dC, 1.0), 'D64.9 all-exhausted run: 0 avoidable waits, nobody over budget', '');

  // (d) conservation + invariants on (a), (b), (c)
  for (const [lbl, des, adh] of [['a', dA, 1.0], ['b', dB, 0.9], ['c', dC, 1.0]] as const) {
    const inv = verifyAgentTimelineInvariants(des as any, labF2(adh), CAL_24X7);
    const tot = new Map<string, number>();
    for (const s of busyF2(des)) tot.set(s.caseId, (tot.get(s.caseId) ?? 0) + (s.to - s.from) / 60000);
    const completed = (des as any).caseResults.filter((c: any) => c.isCompleted);
    const conserved = completed.every((c: any) => Math.abs((tot.get(c.caseId) ?? 0) - c.ahtMinutes) < 0.01);
    assert(inv.valid && conserved && (des as any).doubleBookedAssignments === 0 && completed.length > 0, `D64.10${lbl} (${lbl}) invariants valid, handled minutes = AHT for every completed case, no double booking`, `${inv.errors.join('; ')} completed=${completed.length}`);
  }

  // (e) SLA % non-decreasing in headcount, 24x7 week, 6 cases/hour, AHT 45, adherence 0.9, 24 h SLA (before the fix: 14 -> 100%, 16 -> 98%)
  {
    const iv: StandardInterval[] = [];
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) { const s = new Date(2026, 9, 12 + d, h, 0); iv.push({ intervalIndex: iv.length, start: s, end: new Date(s.getTime() + 3600000), volume: 6, category: 'General' } as StandardInterval); }
    const catS: CategoryConfig[] = [{ id: 'g', name: 'General', ahtMinutes: 45, shrinkagePct: 0.2, priority: 1 }];
    const slaS: SLAPolicyConfig = { ...DEFAULT_SLA, primaryWindow: 24, primaryUnit: 'hours', clockBasis: 'wall_clock', clockStartPolicy: 'arrival', minCoverageEnabled: false };
    const pcts: number[] = [];
    for (const hc of [14, 15, 16, 17]) {
      const r = runBackofficeDES({ operationalHC: hc, intervals: iv, openingWIP: [], categories: catS, calendar: CAL_24X7, labor: labF2(0.9), sla: slaS, seed: 11, queueArchitecture: 'pooled', skipCaseResultsAndTimeline: true });
      pcts.push(r.primaryAchievedPct);
    }
    assert(pcts.every((p, i) => i === 0 || p >= pcts[i - 1] - 1e-9), 'D64.11 SLA % is non-decreasing in headcount for N = 14..17 (before the fix 14 -> 100%, 16 -> 98%)', `SLA% by N=14..17: ${pcts.map((p) => p.toFixed(1)).join(', ')}`);
  }

  // (f) business-hours digest (Mon-Fri default calendar, uniform and staggered). The staggered digest (D64.12b) is identical before/after the
  // D64 fix and before/after P2-9; the uniform one (D64.12a) moved on 2026-10-08 (see below).
  {
    const digest = (des: any): number => {
      let h = 2166136261;
      for (const c of [...des.caseResults].sort((a: any, b: any) => (a.caseId < b.caseId ? -1 : 1))) {
        const str = `${c.caseId}:${c.firstStartTime?.getTime() ?? 'x'}:${c.completeTime?.getTime() ?? 'x'}:${c.parkCount}`;
        for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
      }
      return h >>> 0;
    };
    const iv: StandardInterval[] = [];
    for (let d = 0; d < 5; d++) for (const h of [8, 10, 12, 14]) { const s = new Date(2026, 9, 12 + d, h, 0); iv.push({ intervalIndex: iv.length, start: s, end: new Date(s.getTime() + 1800000), volume: 1, category: 'General' } as StandardInterval); }
    const mk = (offsets: number[] | null) => runBackofficeDES({ operationalHC: 3, intervals: iv, openingWIP: [], categories: catF2, calendar: DEFAULT_CALENDAR, labor: { ...DEFAULT_LABOR, adherencePct: 0.9 }, sla: slaF2, seed: 7, queueArchitecture: 'pooled', shiftDistribution: offsets ? stagF2(offsets) : undefined });
    const dU = digest(mk(null)), dS = digest(mk([0, 120, 240]));
    // Re-pinned 2026-10-08 (P2-9: non-24x7 runs without a start distribution now end each agent's shift dailyProductiveHours
    // after open). This uniform run (default 08:00-18:00 calendar, 7.5 h, adherence 0.9, no distribution) was 1141821764 on the
    // pre-P2-9 engine, where agents stayed on to close; now each agent leaves 450 min after open (shift end is not shortened by
    // adherence, decision 11), so cases arriving late wait for the next morning and the first-start / complete times move.
    assert(dU === 3096667861, 'D64.12a business-hours uniform run digest pinned (fixed shifts, P2-9; was 1141821764 when agents stayed to close)', `digest=${dU}`);
    assert(dS === 147910604, 'D64.12b business-hours staggered 0/2/4 h run digest pinned (measured on the unchanged engine)', `digest=${dS}`);
  }

  // (g) stress: 24x7, 41 cases, 4 agents, budget 225 min (adherence 0.5) - completes, parks per case <= agents x days, work slices bounded
  {
    const cs: CaseEntity[] = [];
    for (let i = 0; i < 41; i++) cs.push(f2Case(`S${String(i).padStart(2, '0')}`, i + 1, new Date(f2At(12, 0).getTime() + i * 70 * 60000), 120 + ((i * 37) % 90), 36));
    const dG = runF2(cs, 4, 0.5, null);
    const days = new Set(busyF2(dG).map((s: any) => dayKeyF2(s.from))).size;
    const maxPark = Math.max(...(dG as any).caseResults.map((c: any) => c.parkCount));
    const nSlices = busyF2(dG).length;
    assert(dG.totalCases === 41 && maxPark <= 4 * days && nSlices <= 41 * 4 * days && nSlices <= 400, 'D64.13 stress: completes; parks per case <= agents x days; busy slices <= 400', `cases=${dG.totalCases} maxPark=${maxPark} days=${days} slices=${nSlices}`);
    assert(budgetOk(dG, 0.5), 'D64.14 stress: nobody over the 225-min daily budget', '');
    const dG2 = runF2(cs, 4, 0.5, null);
    const sig = (d: any) => JSON.stringify((d.caseResults as any[]).map((c) => [c.caseId, c.firstStartTime?.getTime() ?? null, c.completeTime?.getTime() ?? null, c.parkCount]));
    assert(sig(dG) === sig(dG2), 'D64.15 determinism: same seed twice gives identical case results (stress)', '');
    assert(sig(runF2(casesB, 3, 0.9, offs)) === sig(dB), 'D64.16 determinism: same seed twice gives identical case results (staggered)', '');
  }
}

// =================================================================
// Suite D65 - F3 (HC-15): when the roster polish adopts a re-spread roster, the confidence block,
// the history row for N, the occupancy/ASA binding branches and the representative replication
// describe THAT roster. Pre-fix primaryPassedResult / evalCache[N] kept the PRE-polish evaluation
// (D50 fixture: block 94.3 CI [94.1, 94.5] while the adopted roster scores 100 CI [100, 100] and the
// headline run showed 100). The decision (HC, adopted roster, rosterPolish) must NOT move; runs
// with no adoption (placement OFF, no_improvement) must be byte-identical. Pins marked "pre" were
// measured on the unchanged code.
// =================================================================
console.log('\n--- Suite D65: F3 statistics describe the adopted roster ---');
{
  // Key-order-insensitive digest: the async search assembles its result object in a different key order than the sync one (same values).
  const sortKeys = (_k: string, v: any) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);
  const dg = (x: unknown) => createHash('sha1').update(JSON.stringify(x, sortKeys)).digest('hex').slice(0, 16);
  const cal65: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 20 };
  const laborOff65: LaborConfig = { ...LABOR, dailyProductiveHours: 8 };
  const laborOn65: LaborConfig = { ...laborOff65, shiftPlacementEnabled: true, shiftSlapMinutes: 30 };
  const mkIv65 = (cats: Array<[string, (h: number) => number]>): StandardInterval[] => {
    const out: StandardInterval[] = [];
    for (let day = 0; day < 5; day++) {
      for (let h = 8; h < 20; h++) {
        for (let m = 0; m < 60; m += 30) {
          for (const [category, vf] of cats) {
            out.push({ intervalIndex: out.length, start: new Date(2026, 2, 2 + day, h, m), end: new Date(2026, 2, 2 + day, h, m + 30), volume: vf(h), category });
          }
        }
      }
    }
    return out;
  };
  const mkSla65 = (pct: number, windowH: number): SLAPolicyConfig => ({
    primaryPct: pct, primaryWindow: windowH, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90,
  });
  const cat1: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 }];
  const cat2: CategoryConfig[] = [
    { id: 'A', name: 'A', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 },
    { id: 'B', name: 'B', ahtMinutes: 25, shrinkagePct: 0.1, priority: 2 },
  ];
  const peak = (h: number) => (h >= 12 && h < 16 ? 14 : 3);
  const iv1 = mkIv65([['General', peak]]);
  const iv2 = mkIv65([['A', (h) => (h === 8 ? 60 : 4)], ['B', (h) => (h >= 12 && h < 16 ? 10 : 2)]]);

  type Scn = { intervals: StandardInterval[]; categories: CategoryConfig[]; labor: LaborConfig; sla: SLAPolicyConfig; seed: number; userMaxHC: number; arch?: 'siloed' };
  const baseOf = (s: Scn) => ({ intervals: s.intervals, openingWIP: [] as any[], categories: s.categories, calendar: cal65, labor: s.labor, sla: s.sla, seed: s.seed, userMaxHC: s.userMaxHC, replications: 6, ...(s.arch ? { queueArchitecture: s.arch } : {}) });
  const distOf = (d: any) => JSON.stringify(d ? Object.keys(d).sort().map((k) => [k, d[k].slaps]) : null);

  // Polish scenarios: (a) (b) (c) (d) (e) (h) (j).
  // Re-pinned 2026-10-08 (P1-6): with Shift Placement ON the search now tries a ladder of simple start-time rosters, each confirmed on a second
  // independent replication block, before rejecting a headcount. The four fixtures below therefore no longer end in an ADOPTED polish; they end in
  // the status in `pin.status` ('no_improvement': the rescued roster leaves nothing to re-spread), and every literal moved with the new headcount.
  // `pin.ci` (median, CI low, CI high) replaces the old "CI [100, 100]" literal when the mean is no longer 100. The F3 property itself -- "the
  // statistics describe the ADOPTED roster" -- is kept alive on scan-found adopted fixtures in D73.1 / D73.2.
  const polishCase = async (tag: string, s: Scn, pin: { N: number; mean: number; rp: string; others: string; dist: string; bind: string; status: 'adopted' | 'adopted_partial' | 'no_improvement'; ci?: [number, number, number] }) => {
    const syn: any = searchOptimalHC(baseOf(s));
    const asy: any = await searchOptimalHCAsync(baseOf(s));
    const N: number = syn.recommendedHC;
    const rp = syn.rosterPolish;
    assert(rp?.status === pin.status, `${tag}.0 scenario polish status is ${pin.status}${pin.status === 'no_improvement' ? ' (was: adopts a polished roster)' : ''}`, `status=${rp?.status}`);
    const sets = hcNs.generatePrecomputedReplications({ intervals: s.intervals, openingWIP: [], categories: s.categories, calendar: cal65, sla: s.sla, baseSeed: s.seed, replications: 6 });
    const ind: any = evaluateCandidateStatistical({
      operationalHC: N, intervals: s.intervals, openingWIP: [], categories: s.categories, calendar: cal65, labor: s.labor, sla: s.sla,
      baseSeed: s.seed, replications: 6, queueArchitecture: s.arch ?? 'pooled', precomputedCaseSets: sets,
      shiftDistribution: syn.shiftPlacement?.winningDistribution, dispatchFairness: undefined,
    });
    const ps = syn.primaryStatistical;
    const brief = (x: any) => `mean=${x?.achievedPctMean} med=${x?.achievedPctMedian} CI=[${x?.ci95Low},${x?.ci95High}] R=${x?.replications}`;
    // (a) confidence block = independent evaluation of the adopted roster
    assert(JSON.stringify(ps) === JSON.stringify(ind.primaryStats), `${tag}.a1 primaryStatistical equals an independent evaluation of the adopted roster`, `reported ${brief(ps)} | independent ${brief(ind.primaryStats)}`);
    assert(ps?.achievedPctMean === pin.mean && ps?.replications === 6, `${tag}.a2 primaryStatistical mean/R literal`, `got ${brief(ps)}`);
    if (pin.mean === 100) assert(ps?.ci95Low === 100 && ps?.ci95High === 100 && ps?.achievedPctMedian === 100, `${tag}.a3 primaryStatistical CI [100, 100], median 100`, brief(ps));
    else if (pin.ci) assert(ps?.achievedPctMedian === pin.ci[0] && ps?.ci95Low === pin.ci[1] && ps?.ci95High === pin.ci[2], `${tag}.a3 primaryStatistical median ${pin.ci[0]}, CI [${pin.ci[1]}, ${pin.ci[2]}] (was CI [100, 100], median 100)`, brief(ps));
    // (b) history row for N carries those numbers; other rows pinned
    const row = syn.searchHistory.find((r: any) => r.hc === N);
    const rowOk = !!row && row.primaryPct === ind.primaryStats.achievedPctMedian && row.primaryCiLow === ind.primaryStats.ci95Low && row.primaryCiHigh === ind.primaryStats.ci95High
      && row.boAsaMinutes === ind.representativeResult.boAsaMeanMinutes && row.occupancyPct === ind.representativeResult.occupancyPct && row.rawOccupancyPct === ind.representativeResult.rawOccupancyPct
      && row.passed === ind.passesAllConstraints && JSON.stringify(row.failingReasons) === JSON.stringify(ind.failingReasons);
    assert(rowOk, `${tag}.b1 history row for N equals the adopted evaluation`, JSON.stringify(row));
    assert(syn.searchHistory.filter((r: any) => r.hc === N).length === 1, `${tag}.b2 exactly one history row for N`, '');
    assert(dg(syn.searchHistory.filter((r: any) => r.hc !== N)) === pin.others, `${tag}.b3 history rows for other N unchanged (pre)`, `got ${dg(syn.searchHistory.filter((r: any) => r.hc !== N))}`);
    // (c) (d) the decision is untouched
    assert(dg(rp) === pin.rp, `${tag}.c rosterPolish unchanged (pre)`, `got ${dg(rp)}`);
    assert(N === pin.N && dg(distOf(syn.shiftPlacement?.winningDistribution)) === pin.dist, `${tag}.d recommended HC and adopted roster unchanged (pre)`, `N=${N} dist=${dg(distOf(syn.shiftPlacement?.winningDistribution))}`);
    // (e) sync deep-equals async on the full output (boundary evidence included)
    assert(dg(syn) === dg(asy), `${tag}.e sync result deep-equals async result (full output)`, `sync ${dg(syn)} async ${dg(asy)}`);
    // (h) headline run = the adopted evaluation's representative run
    assert(syn.finalDESResult.primaryAchievedPct === ind.representativeResult.primaryAchievedPct, `${tag}.h headline primaryAchievedPct equals the adopted evaluation's representative run`, `headline ${syn.finalDESResult.primaryAchievedPct} vs rep ${ind.representativeResult.primaryAchievedPct}`);
    // (j) binding label
    assert(`${syn.bindingConstraintType}|${syn.bindingConstraintDescription}` === pin.bind, `${tag}.j binding-constraint label pinned`, `got ${syn.bindingConstraintType}|${syn.bindingConstraintDescription}`);
  };

  const sla65 = mkSla65(85, 3);
  // Re-pinned 2026-10-08 (P1-6), old -> new per pin (the rescue ladder lowers the placement-ON headcount; the old pins described the pre-rescue ADOPTED result):
  //   D65.1 seed 42: N 9 -> 7; polish status adopted -> no_improvement; mean 100 -> 89.5 (median 100 -> 89.5, CI [100, 100] -> [88.9, 90.2]);
  //     rp 5ca7f75aac8b4e42 -> 6311a533d2a41339; others b98412b976e5b850 -> 97d170e1550eee4a; roster digest eea4224868125973 -> 2be0d6ecae2ea49e;
  //     binding label statistical_primary_sla (Primary SLA 85% Target) -> analytical_baseline (Occupancy-Feasible Capacity Floor, N_occ = 7: the search now lands on the floor).
  //   D65.2 seed 7: N 9 -> 7; adopted -> no_improvement; mean 100 -> 89.5 (median 100 -> 89.7, CI [100, 100] -> [88.8, 90.1]);
  //     rp 343796a0ef1aa6d1 -> 0c61504ef37096e4; others 029a912afc357141 -> 97d170e1550eee4a; roster digest eea4224868125973 -> 2be0d6ecae2ea49e; binding label as D65.1.
  //   D65.3 seed 99: N 9 -> 7; adopted -> no_improvement; mean 100 -> 89.7 (median 100 -> 89.5, CI [100, 100] -> [89.2, 90.2]);
  //     rp 5ca7f75aac8b4e42 -> 6311a533d2a41339; others 311f6baea3e00365 -> 97d170e1550eee4a; roster digest eea4224868125973 -> 2be0d6ecae2ea49e; binding label as D65.1.
  await polishCase('D65.1 pooled seed 42', { intervals: iv1, categories: cat1, labor: laborOn65, sla: sla65, seed: 42, userMaxHC: 40 }, { N: 7, mean: 89.5, rp: '6311a533d2a41339', others: '97d170e1550eee4a', dist: '2be0d6ecae2ea49e', bind: 'analytical_baseline|Occupancy-Feasible Capacity Floor (N_occ = 7 at ≤ 100% occupancy)', status: 'no_improvement', ci: [89.5, 88.9, 90.2] });
  await polishCase('D65.2 pooled seed 7', { intervals: iv1, categories: cat1, labor: laborOn65, sla: sla65, seed: 7, userMaxHC: 40 }, { N: 7, mean: 89.5, rp: '0c61504ef37096e4', others: '97d170e1550eee4a', dist: '2be0d6ecae2ea49e', bind: 'analytical_baseline|Occupancy-Feasible Capacity Floor (N_occ = 7 at ≤ 100% occupancy)', status: 'no_improvement', ci: [89.7, 88.8, 90.1] });
  await polishCase('D65.3 pooled seed 99', { intervals: iv1, categories: cat1, labor: laborOn65, sla: sla65, seed: 99, userMaxHC: 40 }, { N: 7, mean: 89.7, rp: '6311a533d2a41339', others: '97d170e1550eee4a', dist: '2be0d6ecae2ea49e', bind: 'analytical_baseline|Occupancy-Feasible Capacity Floor (N_occ = 7 at ≤ 100% occupancy)', status: 'no_improvement', ci: [89.5, 89.2, 90.2] });
  // (g) siloed (D52 fixture). Re-pinned 2026-10-08 (P1-6): N 19 -> 18; adopted_partial -> no_improvement; mean 99.5 -> 99.3 (CI [99.2, 99.3]);
  //   rp 574fd697c0fc5960 -> f10ac0c20fe7cf73; others 51ae9df0b3740505 -> 9db7e75aa8ce963c; roster digest ef0e7a02e1a93f74 -> 7ccb9a8cd5d81ac2; binding label unchanged.
  //   The adopted-vector property of this slot (a vector is adopted for each queue) lives on in D73.2 / D73.4.
  await polishCase('D65.4 siloed (D52 fixture)', { intervals: iv2, categories: cat2, labor: laborOn65, sla: mkSla65(95, 4), seed: 42, userMaxHC: 60, arch: 'siloed' }, { N: 18, mean: 99.3, rp: 'f10ac0c20fe7cf73', others: '9db7e75aa8ce963c', dist: '7ccb9a8cd5d81ac2', bind: 'statistical_primary_sla|Primary SLA 95% Target (Statistical DES, 90% CI)', status: 'no_improvement' });

  // (f) nothing adopted: the full result must be byte-identical to today
  {
    const noImp: Scn = { intervals: iv1, categories: cat1, labor: laborOn65, sla: mkSla65(95, 2), seed: 42, userMaxHC: 40 };
    const a: any = searchOptimalHC(baseOf(noImp));
    const aa: any = await searchOptimalHCAsync(baseOf(noImp));
    assert(a.rosterPolish?.status === 'no_improvement', 'D65.5a no_improvement scenario (placement ON, 95/2h) really is no_improvement', `status=${a.rosterPolish?.status}`);
    // Re-pinned 2026-10-08 (P2-9): digest 733df309dc766f59 -> 4f9350ef4421701d. The recommended HC is unchanged (12); only the
    // `boundaryEvidence` block (the "one fewer agent" run, which used to have no shift end) and the new `fixedShifts` field on the
    // result differ.
    // Re-pinned 2026-10-08 (P1-6): digest 4f9350ef4421701d -> 21068fd81ff08d7a. Not only the digest moved: the RECOMMENDATION itself moved 12 -> 9 (with Shift Placement ON
    // the search now tries a ladder of simple start-time rosters, each confirmed on a second independent replication block, before rejecting a headcount;
    // the status is still no_improvement). The new headcount is asserted explicitly in D65.5c.
    assert(dg(a) === '21068fd81ff08d7a' && dg(aa) === dg(a), 'D65.5b no_improvement: full result pinned (P1-6: digest 4f9350ef4421701d -> 21068fd81ff08d7a because the recommendation moved 12 -> 9) and sync = async', `sync ${dg(a)} async ${dg(aa)}`);
    assert(a.recommendedHC === 9 && aa.recommendedHC === 9, 'D65.5c no_improvement scenario: recommended HC is 9 in sync and async (P1-6: was 12)', `sync ${a.recommendedHC} async ${aa.recommendedHC}`);
    const off: Scn = { intervals: iv1, categories: cat1, labor: laborOff65, sla: sla65, seed: 42, userMaxHC: 40 };
    const o: any = searchOptimalHC(baseOf(off));
    const oa: any = await searchOptimalHCAsync(baseOf(off));
    // Re-pinned 2026-10-08 (P2-9): digest 9038b551a950a83b -> dd646445fac9906d. The recommended HC is unchanged (9); only the
    // `boundaryEvidence` block and the new `fixedShifts` field on the result differ.
    assert(o.rosterPolish === undefined && dg(o) === 'dd646445fac9906d' && dg(oa) === dg(o), 'D65.6 placement OFF: full result pinned (P2-9: only boundaryEvidence + fixedShifts differ from the pre-change digest 9038b551a950a83b) and sync = async', `sync ${dg(o)} async ${dg(oa)}`);
  }
  // (i) placement stays opt-in
  assert(!DEFAULT_LABOR.shiftPlacementEnabled, 'D65.7 default labor config: shiftPlacementEnabled is OFF', `got ${String(DEFAULT_LABOR.shiftPlacementEnabled)}`);
}

// ----------------------------------------------------
// Suite D66 - Input safety part 1 (G2 + H2): numbers read from files. A volume / remaining-minutes
// cell is either read exactly as meant or the planner is told; never silently misread. Semicolon
// file `12,5` must be 12.5 (old behaviour: 125); `2h`, `30 min`, `1e9` blocked; backlog bad rows use
// THEIR category's own handling time / priority (old: invented 30 / 1) and are counted.
// ----------------------------------------------------
import { parseCSVRaw, parseFlexibleDate } from '../src/utils/csv-parser';
import { classifyNumberCell, readNumberColumn } from '../src/utils/number-cell';
import { parseWipRows } from '../src/utils/wip-import';

console.log('\n--- Suite D66: input safety part 1 (numbers read from files) ---');
{
  const map66 = { intervalStartCol: 'IntervalStart', volumeCol: 'Volume', categoryCol: 'Category' } as any;
  const fileFor = (delim: string, cells: string[]) =>
    ['IntervalStart', 'Volume', 'Category'].join(delim) + '\n' +
    cells.map((c, i) => `2026-10-05 ${String(9 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}${delim}${c}${delim}General`).join('\n');
  const load66 = (delim: string, cells: string[]) => {
    const p = parseCSVRaw(fileFor(delim, cells));
    const ivs = mapRawRecordsToIntervals(p.rows, map66, 'General', p.delimiter);
    const dq = validateDataQuality({ intervals: ivs, mapping: map66, categories: DEFAULT_CATEGORIES, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: DEFAULT_SLA, openingWIP: [] });
    return { p, ivs, dq, total: ivs.reduce((s, x) => s + x.volume, 0), err: dq.issues.find((i) => i.field === 'Unreadable volume') };
  };
  const vols = (r: { ivs: StandardInterval[] }) => r.ivs.map((x) => x.volume).join('|');

  // 1. semicolon file with decimal commas
  const a = load66(';', ['12,5', '10,5', '8,25']);
  assert(a.p.delimiter === ';', 'D66.1a parseCSVRaw returns the detected delimiter', a.p.delimiter);
  assert(Math.abs(a.total - 31.25) < 1e-9 && !a.err, 'D66.1b semicolon file 12,5 / 10,5 / 8,25 totals 31.25 (old: 1055) with no error', `total=${a.total}`);
  assert(a.dq.issues.some((i) => i.field === 'Fractional volume'), 'D66.1c fractional volumes carry the rounding warning');
  const aw = load66(';', ['12', '10', '8']);
  assert(!aw.dq.issues.some((i) => i.field === 'Fractional volume') && aw.total === 30, 'D66.1d whole-number file: no fractional warning');

  // 2. comma file: clean values unchanged, unclear blocked
  const b = load66(',', ['"1,234"', '"$1,200"', ' 7 ', '$1200', '"12,345,678"', '12.5']);
  assert(vols(b) === '1234|1200|7|1200|12345678|12.5' && !b.err, 'D66.2a comma file: "1,234", $1,200, " 7 ", $1200, 12,345,678, 12.5 read as today', vols(b));
  for (const bad of ['"12,5"', '30 min', '12abc', '1e9', '2h', '0x10', '12..5', '1:30']) {
    const r = load66(',', ['5', bad]);
    assert(!!r.err && r.err.severity === 'error' && r.ivs.some((x) => x.volume === 0) && /row 3/.test(r.err.message), `D66.2b comma file cell ${bad} is a blocking Unreadable volume error naming row 3, stored 0`, r.err?.message);
  }
  const many = load66(',', ['1', '2h', '3', 'x', '5', 'y', '7', 'z']);
  assert(many.err!.message.includes('row 3') && many.err!.message.includes('row 5') && many.err!.message.includes('row 7') && many.err!.message.includes('row 9'), 'D66.2c error names the offending rows', many.err?.message);

  // 3. semicolon / tab: per-column convention
  const c1 = load66(';', ['1.234', '2.345']);
  assert(!!c1.err && c1.err.message.includes('1234') && c1.err.message.includes('1.234'), 'D66.3a ambiguous-only column blocks and shows both readings', c1.err?.message);
  const c2 = load66(';', ['1.234', '12,5']);
  assert(!c2.err && vols(c2) === '1234|12.5', 'D66.3b 1.234 + 12,5 reads 1234 and 12.5', vols(c2));
  const c3 = load66(';', ['12,5', '12.5']);
  assert(!!c3.err && /mixed number formats/.test(c3.err.message), 'D66.3c column mixing 12,5 and 12.5 blocks as mixed number formats', c3.err?.message);
  const c4 = load66(';', ['1.234,5', '3,5']);
  assert(!c4.err && vols(c4) === '1234.5|3.5', 'D66.3d 1.234,5 reads 1234.5', vols(c4));
  const c5 = load66('\t', ['1,234.5', '2.5']);
  assert(!c5.err && vols(c5) === '1234.5|2.5', 'D66.3e tab file 1,234.5 reads 1234.5', vols(c5));
  const c6 = load66(';', ['1,234', '3.5']);
  assert(!c6.err && vols(c6) === '1234|3.5', 'D66.3f ambiguous 1,234 follows the dot convention proven by 3.5', vols(c6));

  // 4. large volume + negative
  assert(load66(',', ['100001', '5']).dq.issues.some((i) => i.field === 'Very large volume'), 'D66.4a volume above 100,000 warns');
  const neg = load66(',', ['-5', '5']);
  assert(neg.dq.issues.some((i) => i.field === 'Volume Parsing') && neg.ivs.some((x) => x.volume === 0), 'D66.4b negative volume keeps today behaviour (warning, stored 0)');

  // 5. helper table
  const cls = (s: string, d = ',') => { const r = classifyNumberCell(s, d); return r.kind === 'number' ? r.value : r.kind; };
  assert(cls('12') === 12 && cls('12.5') === 12.5 && cls('-5') === -5 && cls('') === 'blank' && cls(' 7 ') === 7, 'D66.5a helper: 12, 12.5, -5, empty, " 7 "');
  assert(cls('12,5') === 'unreadable' && cls('12,5', ';') === 12.5 && cls('0x10') === 'unreadable' && cls('1e9') === 'unreadable' && cls('30 min') === 'unreadable', 'D66.5b helper: 12,5 by delimiter, 0x10, 1e9, 30 min');
  assert(readNumberColumn(['1.234', '5.5'], ';').values.join('|') === '1.234|5.5', 'D66.5c helper: ambiguous cell follows dot convention proven in column');

  // 6. clean data parses exactly as before: built-in samples vs the legacy reader
  const legacy = (s: string) => { const v = parseFloat(String(s).trim().replace(/[\s$,]/g, '')); return Number.isFinite(v) && v >= 0 ? v : 0; };
  for (const st of ['claims', 'support', 'healthcare'] as const) {
    const ds = buildSampleDataset(st, new Date(2026, 9, 5, 8, 0));
    const ivs = mapRawRecordsToIntervals(ds.rows, { intervalStartCol: 'IntervalStart', volumeCol: 'Volume', categoryCol: 'Category' } as any);
    const legacySum = ds.rows.reduce((s, r) => s + legacy(r['Volume']), 0);
    assert(ivs.reduce((s, x) => s + x.volume, 0) === legacySum && !ivs.some((x) => x.volumeParsingIssue), `D66.6 built-in sample ${st}: volumes identical to the legacy reader, no issues`);
  }

  // 7. backlog import
  const cats66 = [{ name: 'Email', ahtMinutes: 20, priority: 3 }, { name: 'Chat', ahtMinutes: 10, priority: 2 }];
  const mapW = { caseIdCol: 'ID', categoryCol: 'Cat', dateCol: 'Date', timeCol: '', remainingWorkCol: 'Rem', priorityCol: 'Prio' };
  const def66 = new Date(2026, 9, 1, 8, 0);
  const row = (id: string, cat: string, rem: string, prio: string, date = '05/10/2026') => ({ ID: id, Cat: cat, Rem: rem, Prio: prio, Date: date });
  const rowsW = [
    row('A', 'Chat', '15', '2'),            // clean
    row('', 'Foo', '', ''),                 // unknown category
    row('', '', '', ''),                    // blank category
    row('', 'Chat', '2h', ''),              // unreadable minutes
    row('', 'Chat', '-5', ''),              // negative
    row('', 'Chat', '0', ''),               // zero
    row('', 'Chat', '1e9', ''),             // exponent
    row('', 'Chat', '100001', ''),          // above limit
    row('', 'Chat', '', 'high'),            // bad priority
    row('', 'Chat', '', '', ''),            // blank date
    row('', 'Chat', '', '', '31/31/2026'),  // impossible date: skipped
  ];
  const w = parseWipRows(rowsW, mapW, cats66, def66, [], ',');
  assert(w.cases.length === 10 && w.invalidDates === 1, 'D66.7a impossible-date row skipped, 10 imported', `${w.cases.length}/${w.invalidDates}`);
  assert(w.cases[0].id === 'A' && w.cases[0].remainingWorkMinutes === 15 && w.cases[0].priority === 2 && +w.cases[0].arrival === +parseFlexibleDate('05/10/2026'), 'D66.7b valid row unchanged');
  assert(w.cases[1].category === 'Email' && w.cases[1].remainingWorkMinutes === 20 && w.cases[1].priority === 3 && w.cases[2].remainingWorkMinutes === 20, "D66.7c unknown/blank category uses the fallback category's own AHT 20 and priority 3 (old: 30 / 1)");
  assert([3, 4, 5, 6, 7].every((i) => w.cases[i].remainingWorkMinutes === 10), 'D66.7d 2h, -5, 0, 1e9, 100001 minutes all fall back to the category AHT 10');
  assert(w.cases[8].priority === 2 && +w.cases[9].arrival === +def66, 'D66.7e bad priority -> category priority; blank date -> default arrival');
  assert(w.cases.map((c) => c.id).join(',') === 'A,WIP-0001,WIP-0002,WIP-0003,WIP-0004,WIP-0005,WIP-0006,WIP-0007,WIP-0008,WIP-0009', 'D66.7f ids and row order as before', w.cases.map((c) => c.id).join(','));
  const s = w.summary;
  assert(s.category.count === 2 && s.remainingMinutes.count === 5 && s.priority.count === 1 && s.date.count === 1 && s.noHandlingTime.count === 0, 'D66.7g each fallback counted per kind', JSON.stringify([s.category.count, s.remainingMinutes.count, s.priority.count, s.date.count]));
  assert(s.adjustedRows === 9 && s.importedAsTyped === 1 && s.remainingMinutes.examples.length === 5 && s.remainingMinutes.examples[0].text === '2h', 'D66.7h summary: 1 as typed, 9 adjusted, examples listed', JSON.stringify([s.adjustedRows, s.importedAsTyped]));
  const ws = parseWipRows([row('', 'Chat', '7,5', '')], mapW, cats66, def66, [], ';');
  const wc = parseWipRows([row('', 'Chat', '7,5', '')], mapW, cats66, def66, [], ',');
  assert(ws.cases[0].remainingWorkMinutes === 7.5 && wc.cases[0].remainingWorkMinutes === 10 && wc.summary.remainingMinutes.count === 1, 'D66.7i 7,5 reads 7.5 in a semicolon file; unreadable (category AHT, counted) in a comma file');
  const noAht = parseWipRows([row('', 'Chat', '', '')], mapW, [{ name: 'Chat', ahtMinutes: 0, priority: 2 }], def66, [], ',');
  assert(noAht.cases[0].remainingWorkMinutes === 30 && noAht.summary.noHandlingTime.count === 1, 'D66.7j category with no handling time: 30 assumed but counted');
  const mk = (n: number, bad: number) => Array.from({ length: n }, (_, i) => row('', i < bad ? 'Foo' : 'Chat', '5', '2'));
  assert(parseWipRows(mk(100, 30), mapW, cats66, def66, [], ',').summary.requiresConfirmation === true, 'D66.7k 30% fallback rows: confirmation required');
  assert(parseWipRows(mk(100, 5), mapW, cats66, def66, [], ',').summary.requiresConfirmation === false, 'D66.7l 5% fallback rows: no confirmation');
  assert(parseWipRows(mk(1000, 60), mapW, cats66, def66, [], ',').summary.requiresConfirmation === true, 'D66.7m 60 fallback rows (6%): confirmation required (more than 50 rows)');
}

// ----------------------------------------------------
// Suite D67 - Input safety part 2 (G3 + G5). G3 (Option B): timestamps carrying a timezone marker
// (Z, +hh:mm, epoch) are still converted to the PC clock (parser unchanged) and the planner is told.
// Assertions compare absolute instants, so they hold on any PC timezone. G5: category names that
// differ only by letter case / inner spacing are ONE category; settings and ids survive.
// ----------------------------------------------------
import { applyCategoryRenames, categoryKey, detectTimezoneMarker, remapCasesToIntervalSpelling, syncCategoriesWithRenames } from '../src/utils/csv-parser';

console.log('\n--- Suite D67: input safety part 2 (timezone markers + category variants) ---');
{
  const mapA = { intervalStartCol: 'Start', volumeCol: 'Volume', categoryCol: 'Category', timeCol: 'Time', intervalEndCol: 'End' } as any;
  const mkRow = (start: string, vol: string, cat = 'General', time = '', end = '') => ({ Start: start, Volume: vol, Category: cat, Time: time, End: end });
  const dq67 = (ivs: StandardInterval[], cats = DEFAULT_CATEGORIES) =>
    validateDataQuality({ intervals: ivs, mapping: mapA, categories: cats, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: DEFAULT_SLA, openingWIP: [] });

  // 1. G3: absolute instants unchanged by the new code (timezone-independent assertions)
  const abs = (s: string) => parseFlexibleDate(s).getTime();
  assert(abs('2026-01-05T08:00:00Z') === Date.UTC(2026, 0, 5, 8, 0, 0), 'D67.1a ...T08:00:00Z is the absolute instant 08:00 UTC (conversion kept)');
  assert(abs('2026-01-05T08:00:00+04:00') === Date.UTC(2026, 0, 5, 4, 0, 0), 'D67.1b ...T08:00:00+04:00 is the absolute instant 04:00 UTC');
  assert(abs('2026-01-05T08:00:00-05:00') === Date.UTC(2026, 0, 5, 13, 0, 0), 'D67.1c ...T08:00:00-05:00 is the absolute instant 13:00 UTC');
  assert(abs('2026-01-05T08:00:00.500Z') === Date.UTC(2026, 0, 5, 8, 0, 0), 'D67.1d ...T08:00:00.500Z is the absolute instant 08:00:00 UTC');
  assert(abs('1767600000') === 1767600000000, 'D67.1e epoch 1767600000 is the absolute instant 1767600000000 ms');
  const local = parseFlexibleDate('2026-01-05 08:00');
  assert(local.getFullYear() === 2026 && local.getDate() === 5 && local.getHours() === 8 && local.getMinutes() === 0, 'D67.1f marker-free text is still read as written (local 08:00)');

  // 2. marker detection (same single ISO regex)
  const det = (s: string, t?: string) => detectTimezoneMarker(s, t);
  assert(det('2026-01-05T08:00:00Z') === 'Z' && det('2026-01-05T08:00:00+04:00') === '+04:00' && det('2026-01-05T08:00:00-05:00') === '-05:00' && det('2026-01-05T08:00:00.500Z') === 'Z' && det('1767600000') === 'epoch', 'D67.2a detected: Z, +04:00, -05:00, .500Z, epoch');
  assert(det('2026-01-05 08:00') === null && det('05/01/2026 08:00') === null && det('2026-01-05') === null && det('') === null, 'D67.2b not detected: plain, dd/mm/yyyy, date-only, empty');
  assert(det('2026-01-05', '08:00:00-05:00') === '-05:00', 'D67.2c marker in a separate time column is detected');

  // 3. count + distinct markers + warning
  const marked = [
    mkRow('2026-01-05T08:00:00Z', '10'),
    mkRow('2026-01-05T08:30:00+04:00', '10'),
    mkRow('2026-01-05', '10', 'General', '09:00:00-05:00'),
    mkRow('2026-01-05 10:00', '10'),
    mkRow('2026-01-05 10:30', '10', 'General', '', '2026-01-05T11:00:00Z'),
  ];
  const ivM = mapRawRecordsToIntervals(marked, mapA, 'General', ',');
  const rowsMarked = ivM.filter((x) => (x.timezoneMarkers?.length ?? 0) > 0).length;
  const distinct = Array.from(new Set(ivM.flatMap((x) => x.timezoneMarkers ?? []))).sort().join('|');
  assert(rowsMarked === 4 && distinct === '+04:00|-05:00|Z', 'D67.3a hand count: 4 rows carry markers (incl. split date/time columns and an end column), markers +04:00, -05:00, Z', `${rowsMarked} / ${distinct}`);
  const tz = dq67(ivM).issues.find((i) => i.field === 'Timezone markers converted');
  assert(!!tz && tz.severity === 'warning' && /^4 timestamps carried a timezone marker \(\+04:00, -05:00, Z\)/.test(tz.message) && /converted to this PC's timezone \(UTC[+-]\d/.test(tz.message), 'D67.3b one non-blocking warning with count, markers and PC offset', tz?.message);
  const epochOnly = mapRawRecordsToIntervals([mkRow('1767600000', '5'), mkRow('1767601800', '5')], mapA, 'General', ',');
  const tzE = dq67(epochOnly).issues.find((i) => i.field === 'Timezone markers converted');
  assert(!!tzE && tzE.severity === 'warning' && /^2 timestamps were numeric \(Unix epoch\)/.test(tzE.message), 'D67.3c epoch-only file: numeric wording, 2 timestamps', tzE?.message);
  const clean = mapRawRecordsToIntervals([mkRow('2026-01-05 08:00', '5'), mkRow('2026-01-05 08:30', '5'), mkRow('05/01/2026 09:00', '5')], mapA, 'General', ',');
  assert(!dq67(clean).issues.some((i) => i.field === 'Timezone markers converted' || i.field === 'Category names merged'), 'D67.3d marker-free file: no timezone and no merge warning');

  // 4. G5: case / spacing variants
  const catRows = [
    mkRow('2026-01-05 08:00', '10', 'Billing'),
    mkRow('2026-01-05 08:30', '4', 'billing '),
    mkRow('2026-01-05 09:00', '6', 'BILLING'),
    mkRow('2026-01-05 09:30', '5', 'billing'),
    mkRow('2026-01-05 10:00', '3', 'Bill  ing'),
  ];
  const ivC = mapRawRecordsToIntervals(catRows, mapA, 'General', ',');
  const catsC = syncCategoriesWithRenames(ivC, [], DEFAULT_SLA).categories;
  assert(ivC.filter((x) => x.category === 'Billing').length === 4 && ivC.filter((x) => x.category === 'Bill ing').length === 1, 'D67.4a Billing / "billing " / BILLING / billing all read as Billing; "Bill  ing" is its own Bill ing', ivC.map((x) => x.category).join('|'));
  assert(catsC.map((c) => c.name).join('|') === 'Bill ing|Billing', 'D67.4b two categories: Bill ing and Billing', catsC.map((c) => c.name).join('|'));
  assert(ivC.reduce((s, x) => s + x.volume, 0) === 28, 'D67.4c total volume equals the hand sum (28)');
  const mg = dq67(ivC, catsC).issues.find((i) => i.field === 'Category names merged');
  assert(!!mg && mg.severity === 'warning' && mg.message.includes('"BILLING"') && mg.message.includes('"billing"') && mg.message.includes('→ "Billing" (3 rows)') && !mg.message.includes('Bill ing'), 'D67.4d one warning lists the variants with the row count (3 rows); Bill ing not listed', mg?.message);
  const many = Array.from({ length: 12 }, (_, g) => [mkRow(`2026-01-0${(g % 9) + 1} 0${Math.floor(g / 9)}:00`, '1', `Cat${g}`), mkRow(`2026-01-0${(g % 9) + 1} 0${Math.floor(g / 9)}:30`, '1', `CAT${g}`)]).flat();
  const mgMany = dq67(mapRawRecordsToIntervals(many, mapA, 'General', ',')).issues.find((i) => i.field === 'Category names merged');
  assert(!!mgMany && /; \+2 more\.$/.test(mgMany.message), 'D67.4e 12 merged groups: 10 listed then "+2 more"', mgMany?.message);
  assert(categoryKey('  Bill   ING ') === 'bill ing' && categoryKey('Billing') === 'billing', 'D67.4f categoryKey: trim, collapse spaces, lower-case');

  // 5. G5: re-sync with existing categories
  const exist = (name: string, aht: number, id: string) => ({ ...DEFAULT_CATEGORIES[0], id, name, ahtMinutes: aht, shrinkagePct: 0.1 });
  const onlyLower = mapRawRecordsToIntervals([mkRow('2026-01-05 08:00', '5', 'billing')], mapA, 'General', ',');
  const r1 = syncCategoriesWithRenames(onlyLower, [exist('BILLING', 12, 'cat_keep')], DEFAULT_SLA);
  assert(r1.categories.length === 1 && r1.categories[0].id === 'cat_keep' && r1.categories[0].ahtMinutes === 12 && r1.categories[0].shrinkagePct === 0.1 && r1.categories[0].name === 'billing', 'D67.5a existing BILLING + file "billing": one category, id/AHT/shrinkage kept, file spelling used');
  assert(r1.renames.length === 1 && r1.renames[0].from === 'BILLING' && r1.renames[0].to === 'billing', 'D67.5b rename list BILLING -> billing', JSON.stringify(r1.renames));
  const ivSame = mapRawRecordsToIntervals([mkRow('2026-01-05 08:00', '5', 'Billing')], mapA, 'General', ',');
  const r2 = syncCategoriesWithRenames(ivSame, [exist('Billing', 12, 'a'), exist('BILLING', 14, 'b')], DEFAULT_SLA);
  assert(r2.categories.length === 1 && r2.categories[0].id === 'a' && r2.categories[0].ahtMinutes === 12 && r2.duplicatesDropped.length === 1 && r2.duplicatesDropped[0].dropped === 'BILLING' && r2.duplicatesDropped[0].kept === 'Billing', 'D67.5c two existing categories with one key: first supplies settings, other reported', JSON.stringify(r2.duplicatesDropped));
  const ivOrder = mapRawRecordsToIntervals([mkRow('2026-01-05 08:00', '5', 'billing'), mkRow('2026-01-05 08:30', '5', 'BILLING')], mapA, 'General', ',');
  const r3 = syncCategoriesWithRenames(ivOrder, [exist('Billing', 12, 'z')], DEFAULT_SLA);
  assert(r3.categories.length === 1 && r3.categories[0].id === 'z' && r3.categories[0].ahtMinutes === 12 && r3.categories[0].name === 'billing', 'D67.5d upload order billing then BILLING keeps the existing settings');
  const wipStored = [{ id: 'W1', category: 'BILLING', priority: 1, arrival: new Date(2026, 0, 5, 8), clockStart: new Date(2026, 0, 5, 8), remainingWorkMinutes: 5 }];
  const renamed = applyCategoryRenames(wipStored, r1.renames);
  assert(renamed[0].category === 'billing' && applyCategoryRenames(renamed, r1.renames) === renamed && remapCasesToIntervalSpelling(wipStored, onlyLower)[0].category === 'billing' && remapCasesToIntervalSpelling(renamed, onlyLower) === renamed, 'D67.5e stored backlog cases follow the rename; no change returns the same array');
  assert(discoverAndSyncCategories(ivOrder, [exist('Billing', 12, 'z')], DEFAULT_SLA)[0].id === 'z', 'D67.5f discoverAndSyncCategories (wrapper) agrees');

  // 6. backlog import matches by key
  const mapW67 = { caseIdCol: 'ID', categoryCol: 'Cat', dateCol: 'Date', timeCol: '', remainingWorkCol: 'Rem', priorityCol: 'Prio' };
  const wb = parseWipRows([{ ID: 'X', Cat: 'billing', Rem: '9', Prio: '2', Date: '05/01/2026' }, { ID: 'Y', Cat: ' BILL ING ', Rem: '9', Prio: '2', Date: '05/01/2026' }], mapW67, [{ name: 'Billing', ahtMinutes: 12, priority: 2 }, { name: 'Bill ing', ahtMinutes: 8, priority: 3 }], new Date(2026, 0, 5, 8), [], ',');
  assert(wb.cases[0].category === 'Billing' && wb.cases[1].category === 'Bill ing' && wb.summary.category.count === 0 && wb.unmatchedCategories.length === 0, 'D67.6a backlog rows "billing" / " BILL ING " match Billing / Bill ing, not counted as fallback');
  const wz = parseWipRows([{ ID: 'X', Cat: 'Billing', Rem: '9', Prio: '2', Date: '2026-01-05T08:00:00Z' }, { ID: 'Y', Cat: 'Billing', Rem: '9', Prio: '2', Date: '05/01/2026' }], mapW67, [{ name: 'Billing', ahtMinutes: 12, priority: 2 }], new Date(2026, 0, 5, 8), [], ',');
  assert(wz.summary.timezone.count === 1 && wz.summary.timezone.markers.join() === 'Z' && wz.cases[0].arrival.getTime() === Date.UTC(2026, 0, 5, 8), 'D67.6b backlog: 1 arrival with a marker counted, instant unchanged');

  // 7. built-in samples unchanged
  for (const st of ['claims', 'support', 'healthcare'] as const) {
    const ds = buildSampleDataset(st, new Date(2026, 9, 5, 8, 0));
    const m = { intervalStartCol: 'IntervalStart', volumeCol: 'Volume', categoryCol: 'Category' } as any;
    const ivs = mapRawRecordsToIntervals(ds.rows, m);
    const rawNames = Array.from(new Set(ds.rows.map((r) => String(r['Category']).trim()))).sort();
    const syncedNames = syncCategoriesWithRenames(ivs, [], DEFAULT_SLA).categories.map((c) => c.name);
    const rep = validateDataQuality({ intervals: ivs, mapping: m, categories: syncCategoriesWithRenames(ivs, [], DEFAULT_SLA).categories, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: DEFAULT_SLA, openingWIP: [] });
    assert(ivs.length === ds.rows.length && ivs.reduce((s, x) => s + x.volume, 0) === ds.rows.reduce((s, r) => s + Number(r['Volume']), 0) && syncedNames.join('|') === rawNames.join('|') && !rep.issues.some((i) => i.field === 'Timezone markers converted' || i.field === 'Category names merged'), `D67.7 built-in sample ${st}: interval count, total volume and category names identical, no new warnings`);
  }
}

// ----------------------------------------------------
// Suite D68: input safety part 3, Build A (file reader rules E1-E7 / W1-W3, pipe delimiter, refusal at pick time).
// A file with an error-severity problem is REFUSED before anything else happens (App.handleFileUpload /
// DemandFlow.readWipFile check problems first); only warnings travel with an accepted file into data quality.
// File row = 1-based physical line (header = row 1), counting blank lines and lines inside quoted cells.
// The legacy copy below is the reader exactly as it was before this build; every file that loaded then must
// load identically now.
// ----------------------------------------------------
console.log('\n--- Suite D68: input safety part 3 (file reader rules + refusal) ---');
{
  function legacyParseCSVRaw(text: string): { headers: string[]; rows: Record<string, string>[]; delimiter: string } {
    if (!text || !text.trim()) return { headers: [], rows: [], delimiter: ',' };

    // 1. Delimiter detection (, or ; or \t) by analyzing unquoted delimiters
    let delimiter = ',';
    let commaCount = 0;
    let semiCount = 0;
    let tabCount = 0;
    let inQ = false;

    for (let i = 0; i < Math.min(text.length, 4096); i++) {
      const ch = text[i];
      if (ch === '"') {
        if (inQ && text[i + 1] === '"') {
          i++; // skip escaped quote
        } else {
          inQ = !inQ;
        }
      } else if (!inQ) {
        if (ch === ',') commaCount++;
        else if (ch === ';') semiCount++;
        else if (ch === '\t') tabCount++;
        else if (ch === '\n' || ch === '\r') {
          if (commaCount > 0 || semiCount > 0 || tabCount > 0) {
            break;
          }
        }
      }
    }

    if (tabCount > commaCount && tabCount > semiCount) {
      delimiter = '\t';
    } else if (semiCount > commaCount && semiCount > tabCount) {
      delimiter = ';';
    } else {
      delimiter = ',';
    }

    // 2. Tokenize into 2D records using character-by-character RFC 4180 state machine
    const records: string[][] = [];
    let currentRecord: string[] = [];
    let currentField = '';
    let inQuotes = false;
    let i = 0;
    const len = text.length;

    while (i < len) {
      const char = text[i];

      if (inQuotes) {
        if (char === '"') {
          if (i + 1 < len && text[i + 1] === '"') {
            // Escaped quote: "" -> "
            currentField += '"';
            i += 2;
            continue;
          } else {
            // Closing quote
            inQuotes = false;
            i++;
            continue;
          }
        } else {
          // All characters inside quotes (including \r, \n, delimiter, apostrophes) are preserved
          currentField += char;
          i++;
          continue;
        }
      } else {
        if (char === '"') {
          inQuotes = true;
          i++;
          continue;
        } else if (char === delimiter) {
          currentRecord.push(currentField);
          currentField = '';
          i++;
          continue;
        } else if (char === '\r') {
          if (i + 1 < len && text[i + 1] === '\n') {
            i++;
          }
          currentRecord.push(currentField);
          currentField = '';
          records.push(currentRecord);
          currentRecord = [];
          i++;
          continue;
        } else if (char === '\n') {
          currentRecord.push(currentField);
          currentField = '';
          records.push(currentRecord);
          currentRecord = [];
          i++;
          continue;
        } else {
          currentField += char;
          i++;
          continue;
        }
      }
    }

    // Push trailing field/record
    if (currentField.length > 0 || currentRecord.length > 0) {
      currentRecord.push(currentField);
      records.push(currentRecord);
    }

    // 3. Filter out empty rows safely (rows where all cells are empty/whitespace)
    const cleanRecords = records.filter((rec) => rec.some((cell) => cell.trim().length > 0));

    if (cleanRecords.length === 0) {
      return { headers: [], rows: [], delimiter };
    }

    const rawHeaders = cleanRecords[0];
    const headers = rawHeaders.map((h, colIdx) => h.trim() || `Column_${colIdx + 1}`);
    const rows: Record<string, string>[] = [];

    for (let r = 1; r < cleanRecords.length; r++) {
      const rowCells = cleanRecords[r];
      if (!rowCells.some((c) => c.trim().length > 0)) continue;

      const rowObj: Record<string, string> = {};
      headers.forEach((h, colIdx) => {
        rowObj[h] = rowCells[colIdx] !== undefined ? rowCells[colIdx] : '';
      });
      rows.push(rowObj);
    }

    return { headers, rows, delimiter };
  }

  const H = 'Start,Volume,Category';
  const R1 = '2026-01-05 08:00,10,A';
  const R2 = '2026-01-05 08:30,5,A';
  const R3 = '2026-01-05 09:00,4,B';
  const sig = (t: string) => parseCSVRaw(t).problems.map((p) => `${p.severity}:${p.code}`).join('|');
  const msg = (t: string, code: string) => parseCSVRaw(t).problems.find((p) => p.code === code)?.message ?? '';

  // E1 not readable text
  const e1a = parseCSVRaw(`${H}\n2026-01-05 08:00,1\u00000,A\n${R2}`);
  const e1b = parseCSVRaw('PK\u0003\u0004\u0014\u0000\u0006\u0000binary');
  assert(sig(`${H}\n2026-01-05 08:00,1\u00000,A\n${R2}`) === 'error:E1' && e1a.rows.length === 0 && /not a readable text file/.test(e1a.problems[0].message), 'D68.1a NUL character -> one error E1, nothing returned');
  assert(sig('PK\u0003\u0004zip') === 'error:E1' && e1b.headers.length === 0, 'D68.1b text starting with PK (Excel workbook) -> E1 (also wins over NUL)');

  // E2 empty
  assert(sig('') === 'error:E2' && sig('  \n\r\n  ') === 'error:E2' && parseCSVRaw('').problems[0].message === 'The file is empty.', 'D68.2 empty / only blank lines -> E2');

  // E3 header only
  assert(sig(`${H}\n\n\n`) === 'error:E3' && sig(H) === 'error:E3', 'D68.3 header only (blank lines ignored) -> E3');

  // E7 title row
  const e7 = `Daily report\n${H}\n${R1}\n${R2}`;
  assert(sig(e7) === 'error:E7' && /file row 1/.test(msg(e7, 'E7')), 'D68.7a title row above the header -> E7 naming file row 1', msg(e7, 'E7'));
  assert(sig(`\n\nDaily report\n${H}\n${R1}\n${R2}`) === 'error:E7' && /file row 3/.test(msg(`\n\nDaily report\n${H}\n${R1}\n${R2}`, 'E7')), 'D68.7b title row after blank lines -> row 3 named');

  // E6 one column only
  const e6 = 'Value\n7\n1;2,3';
  assert(sig(e6) === 'error:E6' && /^Only one column was found\. Columns must be separated by comma, semicolon, tab or \|\./.test(msg(e6, 'E6')), 'D68.6 one column while another separator appears in the data -> E6', msg(e6, 'E6'));
  assert(sig('Value\n7\n8\n9') === '' && parseCSVRaw('Value\n7\n8\n9').rows.length === 3, 'D68.6b a genuine one-column file without any other separator is still read as before (no problem)');

  // E4 unterminated quote (row number counts blank lines and lines inside quoted cells)
  const e4 = `${H}\n2026-01-05 08:00,10,"A\nB"\n\n2026-01-05 09:00,4,"Open\n${R2}`;
  assert(sig(e4) === 'error:E4' && /opened on file row 5 is never closed/.test(msg(e4, 'E4')), 'D68.4a unterminated quote -> E4 naming file row 5 (blank line and quoted line break counted)', msg(e4, 'E4'));
  assert(/opened on file row 3 /.test(msg(`${H}\n${R1}\n2026-01-05 09:00,4,"5 screen\n${R2}`, 'E4')), 'D68.4b simple case: quote opened on row 3');

  // E5 more non-empty cells than the header
  const e5 = `${H}\n${R1}\n2026-01-05 08:30,5,A,extra\n${R3}`;
  assert(sig(e5) === 'error:E5' && /1 row\(s\) have more columns than the header \(file rows 3; expected 3, found 4/.test(msg(e5, 'E5')) && /delimiter is extra on those rows, or there is a title row above the header/.test(msg(e5, 'E5')), 'D68.5a extra non-empty cell -> E5 with file row, expected 3 / found 4', msg(e5, 'E5'));
  const many = [H, ...Array.from({ length: 7 }, (_, k) => `2026-01-05 0${k + 1}:00,5,A,x`)].join('\n');
  assert(/7 row\(s\)/.test(msg(many, 'E5')) && /file rows 2, 3, 4, 5, 6, …;/.test(msg(many, 'E5')), 'D68.5b seven bad rows: count 7, five rows named then an ellipsis', msg(many, 'E5'));

  // precedence E1 > E2 > E3 > E7 > E6 > E4 > E5
  assert(sig('PK\u0003\u0004') === 'error:E1' && sig(`Title\n${H}\n${R1}\n${R2},x\n"open`) === 'error:E7', 'D68.P precedence: E1 beats the rest; E7 beats E4/E5');
  assert(sig('Value\n7\n1;2,3\n"open') === 'error:E6', 'D68.P2 E6 beats E4');
  assert(sig(`${H}\n${R1},x\n"open`) === 'error:E4', 'D68.P3 E4 beats E5');

  // trailing delimiter on every row; extra empty cells ignored
  const trail = `${H},\n${R1},\n${R2},\n${R3},`;
  assert(sig(trail) === '' && parseCSVRaw(trail).rows.length === 3, 'D68.8a trailing delimiter on every row (header too) -> no problem');
  assert(sig(`${H}\n${R1},\n${R2},,\n${R3}`) === '', 'D68.8b extra EMPTY cells on data rows are ignored');

  // quoted delimiter and quoted line break are not problems; later row numbers still right
  const q = `${H}\n2026-01-05 08:00,10,"A, B"\n2026-01-05 08:30,5,"Line1\nLine2"\n${R3}\n2026-01-05 10:00,2`;
  const qp = parseCSVRaw(q);
  assert(qp.rows.length === 4 && qp.rows[0].Category === 'A, B' && qp.rows[1].Category === 'Line1\nLine2' && qp.problems.length === 1 && qp.problems[0].code === 'W1' && /file rows 6\)/.test(qp.problems[0].message), 'D68.9 quoted comma and quoted line break read as before; the short row after them is file row 6', qp.problems[0]?.message);
  assert(sig(`${H}\n2026-01-05 08:00,10,"A, B"\n2026-01-05 08:30,5,"Line1\nLine2"\n${R3}`) === '', 'D68.9b same file without the short row -> zero problems');

  // W1 short rows: padded as before
  const w1 = `${H}\n${R1}\n\n2026-01-05 08:30,5\n${R3}\nTotal`;
  const w1p = parseCSVRaw(w1);
  assert(sig(w1) === 'warning:W1' && /^2 row\(s\) have fewer columns than the header \(file rows 4, 6\); the missing cells were read as empty\./.test(w1p.problems[0].message) && w1p.rows.length === 4 && w1p.rows[1].Category === '' && w1p.rows[3].Start === 'Total', 'D68.W1 short rows -> warning W1 naming file rows 4 and 6 (blank line counted); cells padded empty', w1p.problems[0]?.message);

  // W2 duplicate header: both columns keep their own values
  const w2p = parseCSVRaw('Start,Volume,Volume\n2026-01-05 08:00,10,20');
  assert(sig('Start,Volume,Volume\n2026-01-05 08:00,10,20') === 'warning:W2' && w2p.headers.join('|') === 'Start|Volume|Volume (2)' && w2p.rows[0].Volume === '10' && w2p.rows[0]['Volume (2)'] === '20', 'D68.W2 duplicate header: second renamed "Volume (2)", values 10 and 20 both kept, warning W2');

  // W3 replacement characters
  const w3 = `${H}\n2026-01-05 08:00,10,Caf�\n${R2}`;
  assert(sig(w3) === 'warning:W3' && parseCSVRaw(w3).rows.length === 2, 'D68.W3 U+FFFD present -> warning W3, file still loads');

  // UTF-16 "Unicode Text" decodes to tab-delimited text: keeps loading
  const u16 = 'Start\tVolume\tCategory\r\n2026-01-05 08:00\t10\tA\r\n2026-01-05 08:30\t5\tA\r\n';
  const u16p = parseCSVRaw(u16);
  assert(u16p.delimiter === '\t' && u16p.rows.length === 2 && u16p.problems.length === 0, 'D68.U16 decoded UTF-16 tab file loads: tab delimiter, 2 rows, no problem');

  // pipe delimiter
  const pipe = 'Start|Volume|Category\n2026-01-05 08:00|1,5|A\n2026-01-05 08:30|2,5|A\n2026-01-05 09:00|3|B';
  const pp = parseCSVRaw(pipe);
  assert(pp.delimiter === '|' && pp.headers.join(',') === 'Start,Volume,Category' && pp.rows.length === 3 && pp.problems.length === 0, 'D68.10a pipe file: delimiter |, three columns, 3 rows, no problem');
  const pm = { intervalStartCol: 'Start', volumeCol: 'Volume', categoryCol: 'Category' } as any;
  const pv = mapRawRecordsToIntervals(pp.rows, pm, 'General', pp.delimiter).reduce((s, x) => s + x.volume, 0);
  assert(Math.abs(pv - 7) < 1e-9, 'D68.10b pipe file total volume equals the hand sum (1.5 + 2.5 + 3 = 7, comma decimals read per the part-1 rules)', String(pv));
  assert(parseCSVRaw('a,b|c\n1,2|3').delimiter === ',' && parseCSVRaw('Title\nA|B\n1|2').delimiter === '|', 'D68.10c pipe has the lowest priority; used when the first delimiter line has only pipes (title line above is skipped over)');

  // warnings travel into data quality as non-blocking issues
  const okIv = mapRawRecordsToIntervals(parseCSVRaw(`${H}\n${R1}\n${R2}`).rows, pm, 'General', ',');
  const dqW = validateDataQuality({ intervals: okIv, mapping: pm, categories: DEFAULT_CATEGORIES, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: DEFAULT_SLA, openingWIP: [], fileWarnings: w1p.problems });
  const dqN = validateDataQuality({ intervals: okIv, mapping: pm, categories: DEFAULT_CATEGORIES, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: DEFAULT_SLA, openingWIP: [] });
  const fw = dqW.issues.filter((i) => i.field === 'File reading');
  assert(fw.length === 1 && fw[0].severity === 'warning' && dqW.passed === dqN.passed && dqN.issues.filter((i) => i.field === 'File reading').length === 0, 'D68.11 file warnings appear as one non-blocking "File reading" issue; without them none and the pass/fail verdict is unchanged');

  // regression: clean files and built-in samples identical to the legacy reader, zero problems
  const toText = (headers: string[], rows: Record<string, string>[], d: string) => [headers.join(d), ...rows.map((r) => headers.map((h) => r[h]).join(d))].join('\n');
  for (const st of ['claims', 'support', 'healthcare'] as const) {
    const ds = buildSampleDataset(st, new Date(2026, 9, 5, 8, 0));
    for (const d of [',', ';', '\t']) {
      const text = toText(ds.headers, ds.rows, d);
      const noClash = ![...ds.headers, ...ds.rows.flatMap((r) => Object.values(r))].some((c) => String(c).includes(d) || String(c).includes('"'));
      const a = parseCSVRaw(text);
      const b = legacyParseCSVRaw(text);
      assert(noClash && a.problems.length === 0 && JSON.stringify(a.headers) === JSON.stringify(b.headers) && JSON.stringify(a.rows) === JSON.stringify(b.rows) && a.delimiter === b.delimiter && a.delimiter === d && a.rows.length === ds.rows.length, `D68.12 sample ${st} as ${d === '\t' ? 'tab' : d} file: zero problems; headers, rows and delimiter identical to the legacy reader`);
    }
  }
  for (const t of [`${H}\n${R1}\n${R2}\n${R3}\n`, `${H}\r\n${R1}\r\n${R2}\r\n`.replace(/,/g, ';'), `${H}\n${R1}\n${R2}`.replace(/,/g, '\t'), `${H}\n\n${R1}\n\n${R2}\n\n`, q.replace(/\n2026-01-05 10:00,2$/, '')]) {
    const a = parseCSVRaw(t);
    const b = legacyParseCSVRaw(t);
    assert(a.problems.length === 0 && JSON.stringify(a.headers) === JSON.stringify(b.headers) && JSON.stringify(a.rows) === JSON.stringify(b.rows) && a.delimiter === b.delimiter, 'D68.13 clean hand file (comma / semicolon / tab / CRLF / blank lines / quoted cells): zero problems and identical to the legacy reader');
  }
  // PK-prefixed headers are valid text, not a zip signature
  {
    const pkc = parseCSVRaw('PK,Start,Volume\nA,2026-01-05 08:00,1\nA,2026-01-05 08:30,2');
    const pks = parseCSVRaw('PKey;Start;Volume\nA;2026-01-05 08:00;1\nA;2026-01-05 08:30;2');
    assert(pkc.problems.length === 0 && pkc.headers.join('|') === 'PK|Start|Volume' && pkc.rows.length === 2, 'D68.14a header starting PK (comma) loads with zero problems');
    assert(pks.problems.length === 0 && pks.delimiter === ';' && pks.headers.join('|') === 'PKey|Start|Volume' && pks.rows.length === 2, 'D68.14b header starting PKey (semicolon) loads with delimiter ;');
  }
}

// D69 - unmapped required columns are named (Input safety part 3, Build B / UI-39)
{
  console.log('\n--- D69: missingRequiredMappings ---');
  assert(missingRequiredMappings({ intervalStartCol: 'Date', volumeCol: 'Vol' }).length === 0, 'D69.1 both required columns mapped: nothing missing');
  assert(missingRequiredMappings({ intervalStartCol: 'Date', volumeCol: '' }).join('|') === 'Volume', 'D69.2 only volume unmapped: names Volume');
  assert(missingRequiredMappings({ intervalStartCol: '', volumeCol: 'Vol' }).join('|') === 'Date / Day', 'D69.3 only date unmapped: names Date / Day (the label on the mapping screen)');
  assert(missingRequiredMappings({ intervalStartCol: '', volumeCol: '' }).join(', ') === 'Date / Day, Volume', 'D69.4 both unmapped: both listed, in screen order');
  assert(missingRequiredMappings({ intervalStartCol: 'Date', volumeCol: 'Vol', timeCol: '', categoryCol: '' }).length === 0, 'D69.5 optional columns (time, category) left empty are never reported');
}

// D70 - stale results after data edits (G6 + H9): content fingerprints of demand intervals and opening backlog
import { diffRunData, diffRunInputs as diffRunInputs70, fingerprintBacklog, fingerprintIntervals } from '../src/utils/run-inputs';
{
  console.log('\n--- D70: stale results after data edits ---');
  const day = (h: number, m = 0) => new Date(2026, 0, 5, h, m);
  const mkIv = (): StandardInterval[] =>
    [8, 9, 10].flatMap((h, i) => ['Claims', 'Billing'].map((c, j) => ({ intervalIndex: i * 2 + j, start: day(h), end: day(h, 30), volume: 10 + i + j, category: c } as StandardInterval)));
  const mkWip = (): OpeningWIPCase[] =>
    [1, 2, 3].map((n) => ({ id: `W${n}`, category: n === 2 ? 'Billing' : 'Claims', priority: 1, arrival: day(7, n), clockStart: day(7, n), remainingWorkMinutes: 20 + n }));
  const snap = (iv: StandardInterval[], wip: OpeningWIPCase[]) => ({ demand: fingerprintIntervals(iv), backlog: fingerprintBacklog(wip) });
  const run = snap(mkIv(), mkWip());
  const kinds = (iv: StandardInterval[], wip: OpeningWIPCase[]) => diffRunData(run, snap(iv, wip)).join('|');

  assert(kinds(mkIv(), mkWip()) === '', 'D70.1 identical data (rebuilt objects) -> not stale');
  assert(diffRunData(null, snap(mkIv(), mkWip())).length === 0, 'D70.1b no run -> nothing reported');
  const v = mkIv(); v[3].volume += 1;
  assert(kinds(v, mkWip()) === 'demand data', 'D70.2 one interval volume changed -> demand data');
  const c = mkIv(); c[1].category = 'Other';
  assert(kinds(c, mkWip()) === 'demand data', 'D70.3 one interval category changed -> demand data');
  const t = mkIv(); t[0].start = day(8, 5);
  assert(kinds(t, mkWip()) === 'demand data', 'D70.3b one interval start changed -> demand data');
  assert(kinds(mkIv().slice(1), mkWip()) === 'demand data', 'D70.3c one interval removed -> demand data');
  const wAdd = mkWip(); wAdd.push({ id: 'W4', category: 'Claims', priority: 1, arrival: day(7), clockStart: day(7), remainingWorkMinutes: 5 });
  assert(kinds(mkIv(), wAdd) === 'opening backlog', 'D70.4a backlog case added -> opening backlog');
  assert(kinds(mkIv(), mkWip().slice(1)) === 'opening backlog', 'D70.4b backlog case removed -> opening backlog');
  const wMin = mkWip(); wMin[0].remainingWorkMinutes += 1;
  const wCat = mkWip(); wCat[0].category = 'Billing';
  const wArr = mkWip(); wArr[0].arrival = day(6, 59);
  const wPri = mkWip(); wPri[0].priority = 2;
  assert([wMin, wCat, wArr, wPri].every((w) => kinds(mkIv(), w) === 'opening backlog'), 'D70.4c backlog minutes / category / arrival / priority edited -> opening backlog each');
  assert(kinds(v, wAdd) === 'demand data|opening backlog', 'D70.5 demand and backlog changed together -> both named');
  const s0: any = { calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: DEFAULT_SLA, categories: DEFAULT_CATEGORIES, simParams: DEFAULT_SIM_PARAMS };
  const s1 = { ...s0, labor: { ...DEFAULT_LABOR, shrinkage: 0.5 } };
  assert(diffRunInputs70(s0, s1).join('|') === 'Labor' && kinds(mkIv(), mkWip()) === '', 'D70.6 settings-only change: settings named, no data kinds');
  assert(snap(mkIv(), mkWip()).demand === snap(mkIv(), mkWip()).demand && snap(mkIv(), mkWip()).backlog === snap(mkIv(), mkWip()).backlog, 'D70.7 same inputs -> same fingerprints');
  const idA = mkIv().map((x) => ({ ...x, categoryId: 'cat-1' } as any));
  const idB = mkIv().map((x) => ({ ...x, categoryId: 'cat-999' } as any));
  assert(fingerprintIntervals(idA) === fingerprintIntervals(idB), 'D70.8 different category ids, same names -> not stale');

  // real mapping function on a small raw file
  const raw = parseCSVRaw('Start,Alt,Volume,Cat\n2026-01-05 08:00,2026-01-05 09:00,5,A\n2026-01-05 08:30,2026-01-05 09:30,7,B\n2026-01-05 09:00,2026-01-05 10:00,9,A\n');
  const mapAt = (startCol: string, catCol: string) => mapRawRecordsToIntervals(raw.rows, { intervalStartCol: startCol, volumeCol: 'Volume', categoryCol: catCol } as any, 'General', raw.delimiter);
  const base70 = snap(mapAt('Start', 'Cat'), []);
  const mapped = (st: string, ct: string) => diffRunData(base70, snap(mapAt(st, ct), [])).join('|');
  assert(mapped('Alt', 'Cat') === 'demand data', 'D70.9a date mapping changed so intervals change -> demand data');
  assert(mapped('Start', '') === 'demand data', 'D70.9b category mapping cleared so intervals change -> demand data');
  assert(mapped('Alt', 'Cat') === 'demand data' && mapped('Start', 'Cat') === '', 'D70.9c mapping changed and changed back -> not stale');
  const ivR = mapAt('Start', 'Cat');
  const wipR = mkWip().map((w) => ({ ...w, category: 'A' }));
  const remapped = remapCasesToIntervalSpelling(wipR, ivR);
  assert(fingerprintBacklog(remapped) === fingerprintBacklog(wipR), 'D70.10 remapCasesToIntervalSpelling returning equal content -> backlog not stale');
}

// =================================================================
// Suite D71 - PRD P2-9: every agent leaves at the end of their own shift on a business-hours
// calendar, even when no shift-start distribution is passed.
//
// Before: with no distribution every agent started at open and stayed available until business
// close (work capped by the daily productive budget, idle time not counted). After: fixed-shift
// mode is on whenever a distribution is passed OR the calendar is not 24x7; with no distribution
// every agent sits at offset 0 (= "one cohort, everyone at offset 0"). 24x7 with no distribution
// keeps today's behaviour (planner decision).
//
// Fixture "long day": Mon-Fri 08:00-22:00 (840 min), dailyProductiveHours 9 => shift 08:00-17:00.
// Controls marked CONTROL must pass on the unchanged engine AND after the change.
// =================================================================
console.log('\n--- Suite D71: P2-9 shift end without a start distribution ---');
{
  const sortKeys71 = (_k: string, v: any) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);
  // Digest over EVERY field of a DESResult (scalars, caseResults, agentTimeline, fairness ledger...)
  // except the two fields that legitimately differ between "no distribution" and "explicit
  // single cohort": the shiftDistributionUsed echo, and the new fixedShifts flag (absent on the
  // pre-change engine, so it must stay out of the hard-coded control digests).
  const fullDigest71 = (des: any): string => {
    const { shiftDistributionUsed: _e, fixedShifts: _f, ...rest } = des;
    // Dates are written as minutes from horizonStart so the pinned digests do not depend on the machine's time zone.
    const base = des.horizonStart.getTime();
    const replacer = function (this: any, k: string, v: any) {
      const raw = this[k];
      return raw instanceof Date ? (raw.getTime() - base) / 60000 : sortKeys71(k, v);
    };
    return createHash('sha1').update(JSON.stringify(rest, replacer)).digest('hex').slice(0, 16);
  };

  const calLong71: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 22 };
  const labLong71: LaborConfig = { ...LABOR, dailyProductiveHours: 9 };
  const cats71: CategoryConfig[] = [
    { id: 'a', name: 'A', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 },
    { id: 'b', name: 'B', ahtMinutes: 30, shrinkagePct: 0.1, priority: 2 },
  ];
  const sla71: SLAPolicyConfig = {
    primaryPct: 80, primaryWindow: 4, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90, minCoverageEnabled: false,
  };
  // 3 working days (Mon 2 Mar 2026 ...), one interval per 30 min across [openH, closeH), A volume 6 + B volume 4.
  // Demand = (6*20 + 4*30) = 240 min per 30-min slot = 8 agent-equivalents of work all day.
  const mkIv71 = (openH: number, closeH: number, days = 3, vA = 6, vB = 4): StandardInterval[] => {
    const out: StandardInterval[] = [];
    for (let day = 0; day < days; day++) {
      for (let h = openH; h < closeH; h++) {
        for (let m = 0; m < 60; m += 30) {
          for (const [category, volume] of [['A', vA], ['B', vB]] as const) {
            out.push({ intervalIndex: out.length, start: new Date(2026, 2, 2 + day, h, m), end: new Date(2026, 2, 2 + day, h, m + 30), volume, category });
          }
        }
      }
    }
    return out;
  };
  const ivLong71 = mkIv71(8, 22);
  const cohort0 = (n: number, keys: string[]): ShiftDistributionByCategory =>
    Object.fromEntries(keys.map((k) => [k, { slapMinutes: 60, slaps: [{ startMinutesFromOpen: 0, agentCount: n }] }])) as ShiftDistributionByCategory;
  // Explicit single cohort at offset 0. Siloed: one entry per category, agentCount = N (the cursor stops at the
  // category's own seat block, so an oversized count just means "every agent of that category").
  const runLong71 = (n: number, arch: 'pooled' | 'siloed', dist?: ShiftDistributionByCategory, over: any = {}) =>
    runBackofficeDES({
      operationalHC: n, intervals: ivLong71, openingWIP: [], categories: cats71, calendar: calLong71, labor: labLong71,
      sla: sla71, seed: 7, queueArchitecture: arch, shiftDistribution: dist, ...over,
    });
  const busyByAgent71 = (des: any): number[] => {
    const b = new Array<number>(des.operationalHC).fill(0);
    for (const s of des.agentTimeline as any[]) if (s.state === 'busy') b[s.agentId] += s.minutes;
    return b.map((x) => Math.round(x * 1000) / 1000);
  };
  const caseTimes71 = (des: any): string =>
    createHash('sha1').update(JSON.stringify([...(des.caseResults as any[])].sort((x, y) => (x.caseId < y.caseId ? -1 : 1)).map((c) => [c.caseId, c.firstStartTime?.getTime() ?? null, c.completeTime?.getTime() ?? null, c.parkCount]))).digest('hex').slice(0, 16);
  const dayOpenMs71 = (d: Date, cal: CalendarConfig) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), cal.dailyOpenHour, cal.dailyOpenMinute).getTime();

  // --- D71.1: EQUIVALENCE (core proof) ---------------------------------------------------------------
  // No distribution == explicit single cohort at offset 0, everything except the echo, pooled and siloed, several N.
  {
    for (const arch of ['pooled', 'siloed'] as const) {
      for (const n of [6, 10, 13, 18]) {
        const keys = arch === 'pooled' ? ['__POOLED__'] : ['A', 'B'];
        const a: any = runLong71(n, arch);
        const b: any = runLong71(n, arch, cohort0(n, keys));
        const sameScalars = a.completedCases === b.completedCases && a.primaryAchievedPct === b.primaryAchievedPct && JSON.stringify(busyByAgent71(a)) === JSON.stringify(busyByAgent71(b));
        assert(
          sameScalars && caseTimes71(a) === caseTimes71(b) && fullDigest71(a) === fullDigest71(b),
          `D71.1 ${arch} N=${n}: no distribution === explicit single cohort at offset 0 (completed, SLA %, per-agent busy minutes, case start/complete digest, full-result digest)`,
          `completed ${a.completedCases}/${b.completedCases} sla ${a.primaryAchievedPct}/${b.primaryAchievedPct} times ${caseTimes71(a)}/${caseTimes71(b)} full ${fullDigest71(a)}/${fullDigest71(b)}`
        );
      }
    }
  }

  // --- D71.2: no activity after the shift end; per-agent available minutes per full day <= 540 ----------
  {
    for (const arch of ['pooled', 'siloed'] as const) {
      const des: any = runLong71(13, arch);
      let late = 0, worstDay = 0, worstEnd = 0;
      const perAgentDay = new Map<string, number>();
      for (const s of des.agentTimeline as any[]) {
        if (s.state !== 'busy' && s.state !== 'idle') continue;
        const endMin = (s.to.getTime() - dayOpenMs71(s.from, calLong71)) / 60000;
        worstEnd = Math.max(worstEnd, endMin);
        if (endMin > 9 * 60 + 1e-6) late++;
        const k = `${s.agentId}_${s.date}`;
        perAgentDay.set(k, (perAgentDay.get(k) ?? 0) + s.minutes);
      }
      for (const v of perAgentDay.values()) worstDay = Math.max(worstDay, v);
      assert(late === 0, `D71.2a ${arch}: no busy or idle slice ends after open + dailyProductiveHours*60 (08:00 + 540 = 17:00) on any day`, `${late} slices end later; latest end = open + ${worstEnd.toFixed(1)} min`);
      assert(worstDay <= 540 + 0.01, `D71.2b ${arch}: busy + idle minutes per agent per day <= 540`, `worst agent-day = ${worstDay.toFixed(2)} min`);
      const inv = verifyAgentTimelineInvariants(des, labLong71, calLong71);
      assert(inv.valid, `D71.2c ${arch}: timeline invariants valid (incl. shift-end invariant after the change)`, inv.errors.slice(0, 3).join('; '));
      // The horizon is 3 data days + the drain day(s) the engine runs to clear leftover work: count the days actually present.
      const nDays = new Set((des.agentTimeline as any[]).map((s) => s.date)).size;
      const fairAvail = (des.agentFairness?.perAgent ?? []).map((r: any) => r.availableMinutes as number);
      assert(fairAvail.length === 13 && nDays >= 3 && Math.max(...fairAvail) <= nDays * 540 + 0.01, `D71.2d ${arch}: agentFairness availableMinutes per agent <= (days in horizon) x 540`, `max=${Math.max(...fairAvail)} days=${nDays}`);
    }
  }

  // --- D71.3: the shift-end invariant fires on a timeline that violates it -----------------------------
  // (mutates a copy: adds an idle slice that ends after 17:00 for agent 0 on day 1)
  {
    const des: any = runLong71(13, 'pooled');
    const d0 = new Date(2026, 2, 2, 17, 0), d1 = new Date(2026, 2, 2, 18, 0);
    const bad = { ...des, fixedShifts: true, agentTimeline: [...des.agentTimeline, { agentId: 0, agentLabel: 'Agent-1', date: '2026-03-02', state: 'idle', rosterSource: 'existing', caseId: null, category: null, from: d0, to: d1, minutes: 60, isResume: false, inBindingWindow: false }] };
    const inv = verifyAgentTimelineInvariants(bad, labLong71, calLong71);
    assert(inv.errors.some((e) => /shift end/i.test(e)), "D71.3 verifyAgentTimelineInvariants reports a slice that ends after the agent's own shift end", inv.errors.slice(0, 3).join('; ') || '(no error reported)');
  }

  // --- D71.4: hand-built, closed-form -----------------------------------------------------------------
  // 1 agent, long day, shift Mon 12 Oct 2026 08:00-17:00, adherence 1.0 (budget 540 = shift length).
  //  X: one case arrives Mon 16:30, AHT 60. Works 16:30-17:00 (30 min), shift ends -> handed back (parkCount 1),
  //     Tue 08:00 resumes the remaining 30 min -> completes Tue 08:30. (Pre-change: ran 16:30-17:30, one slice.)
  //  Y: one case arrives Mon 18:00 (after shift end), AHT 30. Waits for next open: starts Tue 08:00, done Tue 08:30.
  //     (Pre-change: started at 18:00, done 18:30.)
  //  Adherence 0.9 (budget 486 min, unused that day): shift still ends at 17:00.
  //  Z: arrives 16:40, AHT 15 -> 16:40-16:55 (inside the shift).  W: arrives 16:50, AHT 30 -> 16:50-17:00, then Tue 08:00-08:20.
  //     If adherence shortened the shift (to 486 min = 16:06) Z would wait until Tue.
  {
    const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m);
    const catHB: CategoryConfig[] = [{ id: 'g', name: 'General', ahtMinutes: 60, shrinkagePct: 0.2, priority: 1, primaryWindowMinutes: 2880 }];
    const mk = (id: string, arr: Date, aht: number): CaseEntity => {
      const dl = new Date(arr.getTime() + 48 * 3600000);
      return { id, syntheticId: 1, category: 'General', priority: 1, arrival: arr, clockStart: arr, totalAhtMinutes: aht, remainingWorkMinutes: aht, primaryDeadline: dl, latestSafeStart: new Date(dl.getTime() - aht * 60000), firstStartTime: null, completeTime: null, parkCount: 0, isOpeningWip: false };
    };
    const run = (c: CaseEntity, adh = 1.0): any => runBackofficeDES({
      operationalHC: 1, intervals: [], openingWIP: [], categories: catHB, calendar: calLong71, labor: { ...labLong71, adherencePct: adh },
      sla: sla71, seed: 7, precomputedCases: { cases: [c], horizonStart: at(12, 8), horizonEnd: at(14, 22) },
    });
    const hm = (d: Date) => `${d.getDate()}/${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    const busy = (d: any) => (d.agentTimeline as any[]).filter((s) => s.state === 'busy').sort((a, b) => a.from - b.from);
    const x = run(mk('X', at(12, 16, 30), 60));
    const xs = busy(x).map((s) => `${hm(s.from)}-${hm(s.to)}`);
    assert(xs.join(',') === '12/16:30-12/17:00,13/8:00-13/8:30', 'D71.4a in-progress case is handed back at shift end 17:00 and finished next working day 08:00-08:30', xs.join(','));
    const xr = x.caseResults[0];
    assert(xr.parkCount === 1 && xr.isCompleted && !!xr.completeTime && hm(xr.completeTime) === '13/8:30', 'D71.4b the handed-back case counts one park and completes Tue 08:30', `park=${xr.parkCount} complete=${xr.completeTime ? hm(xr.completeTime) : null}`);
    const y = run(mk('Y', at(12, 18, 0), 30));
    const ys = busy(y).map((s) => `${hm(s.from)}-${hm(s.to)}`);
    assert(ys.join(',') === '13/8:00-13/8:30', 'D71.4c a case arriving after the shift end (Mon 18:00) waits until next open: works Tue 08:00-08:30', ys.join(','));
    const z = run(mk('Z', at(12, 16, 40), 15), 0.9);
    const zs = busy(z).map((s) => `${hm(s.from)}-${hm(s.to)}`);
    assert(zs.join(',') === '12/16:40-12/16:55', 'D71.4d adherence 0.9: a 15-min case arriving 16:40 is worked inside the shift (shift end stays 17:00, not shortened)', zs.join(','));
    const w = run(mk('W', at(12, 16, 50), 30), 0.9);
    const ws = busy(w).map((s) => `${hm(s.from)}-${hm(s.to)}`);
    assert(ws.join(',') === '12/16:50-12/17:00,13/8:00-13/8:20', 'D71.4e adherence 0.9: case arriving 16:50 gets 10 min before the 17:00 shift end, finishes Tue 08:00-08:20', ws.join(','));
  }

  // --- D71.5: adherence 0.9 on the generated fixture: shift end is open + 540 -----------------------------
  {
    const des: any = runLong71(13, 'pooled', undefined, { labor: { ...labLong71, adherencePct: 0.9 } });
    let worstEnd = 0;
    for (const s of des.agentTimeline as any[]) if (s.state === 'busy' || s.state === 'idle') worstEnd = Math.max(worstEnd, (s.to.getTime() - dayOpenMs71(s.from, calLong71)) / 60000);
    assert(Math.abs(worstEnd - 540) <= 1e-6, 'D71.5 adherence 0.9: last timeline slice ends at exactly open + 540 (not shortened to 486, not stretched to close)', `latest slice end = open + ${worstEnd.toFixed(2)} min`);
  }

  // --- D71.6: seed determinism ---------------------------------------------------------------------------
  {
    const a = fullDigest71(runLong71(12, 'pooled')), b = fullDigest71(runLong71(12, 'pooled')), c = fullDigest71(runLong71(12, 'pooled', undefined, { seed: 8 }));
    assert(a === b, 'D71.6a same seed twice -> identical result (digest over every field)', `${a} vs ${b}`);
    assert(a !== c, 'D71.6b control: a different seed gives a different digest (the digest is sensitive)', `${a} vs ${c}`);
    const s1 = fullDigest71(runLong71(12, 'siloed')), s2 = fullDigest71(runLong71(12, 'siloed'));
    assert(s1 === s2, 'D71.6c siloed: same seed twice -> identical result', `${s1} vs ${s2}`);
  }

  // --- D71.7: monotonicity sweep + CI gate (long day, coverage OFF) -------------------------------------
  {
    const evalAt = (n: number) => evaluateCandidateStatistical({
      operationalHC: n, intervals: ivLong71, openingWIP: [], categories: cats71, calendar: calLong71, labor: labLong71, sla: sla71,
      baseSeed: 42, replications: 8,
    });
    const rows = [] as Array<{ n: number; pass: boolean; mean: number; median: number; low: number; catPass: boolean; ciPass: boolean }>;
    for (let n = 8; n <= 24; n++) {
      const r: any = evalAt(n);
      rows.push({ n, pass: r.passesAllConstraints, mean: r.primaryStats.achievedPctMean, median: r.primaryStats.achievedPctMedian, low: r.primaryStats.ci95Low, catPass: r.passesCategorySLA, ciPass: r.passesPrimaryCI });
    }
    const dump = JSON.stringify(rows.map((r) => [r.n, r.pass, +r.mean.toFixed(1), r.low]));
    assert(rows.some((r) => r.pass) && rows.some((r) => !r.pass), 'D71.7a setup: the swept range N=8..24 contains both a failing and a passing N', dump);
    const holes: string[] = [];
    for (let i = 0; i < rows.length - 1; i++) if (rows[i].pass && !rows[i + 1].pass) holes.push(`N=${rows[i].n} passed but N=${rows[i + 1].n} failed`);
    assert(holes.length === 0, 'D71.7b passesAllConstraints is monotone in N over 8..24 on the long-day fixture, coverage OFF', holes.join('; ') || dump);
    // CI gate: an N whose mean AND median clear the 80% target but which still fails on the lower bound (overall or per category).
    const tgt = sla71.primaryPct;
    const ciOnly = rows.find((r) => r.mean >= tgt && r.median >= tgt && (!r.ciPass || !r.catPass));
    if (ciOnly) {
      assert(ciOnly.low < tgt || !ciOnly.catPass, `D71.7c CI gate: N=${ciOnly.n} has mean ${ciOnly.mean.toFixed(1)}% / median ${ciOnly.median.toFixed(1)}% >= ${tgt}% but is rejected on the lower bound (overall ${ciOnly.low}% / categories pass=${ciOnly.catPass})`, JSON.stringify(ciOnly));
    } else {
      // No such N on this fixture: construct it the way D57 does (hand-built replications; mean 80 == target, lower bound 78.0).
      const reps = [78, 82, 80, 79, 81].map((v) => ({ primaryAchievedPct: v, rawOccupancyPct: 50, boAsaMeanMinutes: 0, minCoverageObserved: Infinity, categoryStats: { A: { primaryPct: 100 }, B: { primaryPct: 100 } } })) as any[];
      const ev: any = hcNs.computeStatisticalEvaluation(4, reps, reps.map((r) => r.primaryAchievedPct), reps.length, { ...sla71, confidenceLevelPct: 95 }, calLong71, cats71);
      assert(ev.primaryStats.achievedPctMean >= tgt && ev.passesAllConstraints === false && ev.passesPrimaryCI === false, 'D71.7c CI gate (constructed D57-style: no swept N had mean and median >= target with a failing bound): mean 80 clears 80, lower bound 78.0 does not -> rejected', dump);
    }
  }

  // --- D71.8: fixedShifts flag -----------------------------------------------------------------------------
  {
    const noDist: any = runLong71(8, 'pooled');
    const withDist: any = runLong71(8, 'pooled', cohort0(8, ['__POOLED__']));
    assert(noDist.fixedShifts === true, 'D71.8a non-24x7, no distribution: fixedShifts true', `got ${noDist.fixedShifts}`);
    assert(withDist.fixedShifts === true, 'D71.8b non-24x7, with a distribution: fixedShifts true', `got ${withDist.fixedShifts}`);
    assert(noDist.shiftDistributionUsed === undefined && withDist.shiftDistributionUsed !== undefined, 'D71.8c shiftDistributionUsed is still only the echo of a passed distribution (undefined when none passed)', '');
    const iv247 = mkIv71(0, 24, 2);
    const r247: any = runBackofficeDES({ operationalHC: 6, intervals: iv247, openingWIP: [], categories: cats71, calendar: CAL_24X7, labor: LABOR, sla: sla71, seed: 7, queueArchitecture: 'pooled' });
    assert(r247.fixedShifts === false, 'D71.8d 24x7, no distribution: fixedShifts false', `got ${r247.fixedShifts}`);
    const r247d: any = runBackofficeDES({ operationalHC: 6, intervals: iv247, openingWIP: [], categories: cats71, calendar: CAL_24X7, labor: LABOR, sla: sla71, seed: 7, queueArchitecture: 'pooled', shiftDistribution: cohort0(6, ['__POOLED__']) });
    assert(r247d.fixedShifts === true, 'D71.8e 24x7 WITH a distribution: fixedShifts true (staggered 24x7 is unchanged)', `got ${r247d.fixedShifts}`);
    const r0: any = runBackofficeDES({ operationalHC: 0, intervals: ivLong71, openingWIP: [], categories: cats71, calendar: calLong71, labor: labLong71, sla: sla71, seed: 7 });
    assert(r0.fixedShifts === false, 'D71.8f zero headcount: fixedShifts false (mode needs operationalHC > 0)', `got ${r0.fixedShifts}`);
  }

  // --- D71.9: a 00:00-24:00 calendar WITHOUT the is24x7 flag ----------------------------------------------------
  // Documented behaviour (not special-cased): it is a business-hours calendar, so one shift from 00:00 for
  // dailyProductiveHours (8 h => 00:00-08:00), then nobody until the next 00:00. 16 h/day unstaffed.
  {
    const calMid: CalendarConfig = { workingDays: [1, 2, 3, 4, 5], dailyOpenHour: 0, dailyOpenMinute: 0, dailyCloseHour: 24, dailyCloseMinute: 0, holidays: [] };
    const iv = mkIv71(0, 24, 2, 2, 1);
    const des: any = runBackofficeDES({ operationalHC: 4, intervals: iv, openingWIP: [], categories: cats71, calendar: calMid, labor: LABOR, sla: sla71, seed: 7, queueArchitecture: 'pooled' });
    let lateSlices = 0, busyN = 0, day2Busy = 0;
    for (const s of des.agentTimeline as any[]) {
      if (s.state !== 'busy' && s.state !== 'idle') continue;
      const endMin = (s.to.getTime() - dayOpenMs71(s.from, calMid)) / 60000;
      if (endMin > 8 * 60 + 1e-6) lateSlices++;
      if (s.state === 'busy') { busyN++; if (s.from.getDate() === 3) day2Busy++; }
    }
    assert(des.fixedShifts === true && des.totalCases > 0 && busyN > 0 && day2Busy > 0, 'D71.9a 00:00-24:00 without is24x7: runs without error, fixedShifts true, work happens on both days', `fixed=${des.fixedShifts} cases=${des.totalCases} busy=${busyN} day2=${day2Busy}`);
    assert(lateSlices === 0, 'D71.9b 00:00-24:00 without is24x7: no busy/idle slice after 08:00 (one 8 h shift from 00:00, then off) - the shift-end rule applies', `${lateSlices} slices end after 08:00`);
    const inv = verifyAgentTimelineInvariants(des, LABOR, calMid);
    assert(inv.valid, 'D71.9c timeline invariants valid for the 00:00-24:00 non-24x7 run', inv.errors.slice(0, 3).join('; '));
  }

  // --- D71.C: CONTROLS (must pass BEFORE and AFTER the engine change) -----------------------------------------
  // The hard-coded digests below were captured on 2026-10-08 by running THIS fixture on the UNCHANGED engine
  // (checkpoint c59dd89, des-engine.ts not yet edited) via `npx tsx scripts/verify-sizing-fixes.mts` and reading
  // the digest printed in the failure detail while the constant was still a placeholder. Digest = fullDigest71
  // (sha1 of the key-sorted JSON of every DESResult field except shiftDistributionUsed / fixedShifts, first 16 hex).
  const CTRL_A_DIGEST = 'bdedcc57cfd4cc09';
  const CTRL_B_DIGEST = '697b95ca38183ef7';
  const CTRL_C_DIGEST = '31c6b07200eaebe0';
  {
    // (a) shift == business day (09:00-17:00, 8 h): no distribution === explicit single cohort, and === the recorded digest.
    const ivA = mkIv71(9, 17);
    const mkA = (dist?: ShiftDistributionByCategory) => runBackofficeDES({ operationalHC: 10, intervals: ivA, openingWIP: [], categories: cats71, calendar: BIZ_CAL, labor: LABOR, sla: sla71, seed: 7, queueArchitecture: 'pooled', shiftDistribution: dist });
    const a0 = fullDigest71(mkA()), a1 = fullDigest71(mkA(cohort0(10, ['__POOLED__'])));
    assert(a0 === a1, 'D71.C-a1 CONTROL 09:00-17:00 / 8 h: no-distribution run === explicit single-cohort run (digest)', `${a0} vs ${a1}`);
    assert(a0 === CTRL_A_DIGEST, 'D71.C-a2 CONTROL 09:00-17:00 / 8 h: no-distribution digest equals the one recorded on the unchanged engine', `digest=${a0}`);
    // (b) 24x7, no distribution: untouched.
    const iv247 = mkIv71(0, 24, 2);
    const b0 = fullDigest71(runBackofficeDES({ operationalHC: 9, intervals: iv247, openingWIP: [], categories: cats71, calendar: CAL_24X7, labor: LABOR, sla: sla71, seed: 7, queueArchitecture: 'pooled' }));
    assert(b0 === CTRL_B_DIGEST, 'D71.C-b CONTROL 24x7, no distribution: digest equals the one recorded on the unchanged engine', `digest=${b0}`);
    // (c) explicit two-cohort distribution on the long day: unchanged.
    const two: ShiftDistributionByCategory = { __POOLED__: { slapMinutes: 60, slaps: [{ startMinutesFromOpen: 0, agentCount: 9 }, { startMinutesFromOpen: 300, agentCount: 5 }] } };
    const c0 = fullDigest71(runLong71(14, 'pooled', two));
    assert(c0 === CTRL_C_DIGEST, 'D71.C-c CONTROL explicit two-cohort distribution (08:00 x9, 13:00 x5): digest equals the one recorded on the unchanged engine', `digest=${c0}`);
  }
}

// =================================================================
// Suite D72 - PRD P1-6 / L23: with Shift Placement ON, a headcount that failed with everyone at opening,
// with the coverage-repair roster and with the analytic placement roster is no longer rejected until a
// short FIXED ladder of simple "some agents start later" rosters has been tried. A ladder roster is accepted
// only if it passes the unmodified full-R gate on the primary case sets AND on a second, disjoint block of R
// case sets (the confirmation block, amendment 1). The min(R,5)-rep pre-screen can only skip a roster.
//
// Fixtures (all values below measured 2026-10-08 on checkpoint 7ad848f = the code BEFORE this change):
//  - "min": single category, Mon-Fri 08:00-20:00, 8 h shift, 08:00 spike (36 cases per half-hour, 5 otherwise,
//    AHT 20), SLA 85% / 3 h, 6 reps, seed 42. Found by a throwaway scan (4 calendars x 2 shift lengths x 4 volume
//    shapes x 4 SLA pairs x 3 volume levels, 384 fixtures): the first of 9 where, one head below the pre-change
//    recommendation, uniform and the analytic placement roster fail but the minimal later-start shape (8 at opening
//    + 1 at +240 min) passes on the primary block and on the confirmation block. Measured CI lower bounds at N=9
//    (target 85): uniform 77.2, analytic placement 69.2, minimal shape 88.6 (primary) / 87.9 (confirmation).
//  - "d33": the D33 file (08:00-22:00, 9 h shift, flat volume 20, SLA 80% / 4 h, 5 reps, seed 42).
//  - "d50", "d50c", "d50p", "d51a", "d51b", "d52": the D50 / D51 / D52 placement fixtures.
//  - the three built-in samples at the app defaults (pooled).
// The PRE_ON / OFF_CTRL tables are the values recorded from the UNCHANGED code; they are hard-coded on purpose.
// =================================================================
console.log('\n--- Suite D72: P1-6 / L23 rescue ladder with a confirmation block ---');
{
  const M72 = 2147483647;
  const sortKeys72 = (_k: string, v: any) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);
  // Digest over the WHOLE search result. Dates are written as minutes from the first interval so the pinned digests do not depend on the machine's time zone.
  const dig72 = (x: unknown, base: number): string => {
    const rep = function (this: any, k: string, v: any) {
      const raw = this[k];
      return raw instanceof Date ? (raw.getTime() - base) / 60000 : sortKeys72(k, v);
    };
    return createHash('sha1').update(JSON.stringify(x, rep)).digest('hex').slice(0, 16);
  };
  const sla72 = (pct: number, windowH: number): SLAPolicyConfig => ({
    primaryPct: pct, primaryWindow: windowH, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90,
  });
  type Fx72 = {
    name: string; intervals: StandardInterval[]; categories: CategoryConfig[]; calendar: CalendarConfig; labor: LaborConfig;
    sla: SLAPolicyConfig; seed: number; reps: number; arch: 'pooled' | 'siloed'; maxHC: number;
  };
  const cal72: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 20 };
  const lab72: LaborConfig = { ...LABOR, dailyProductiveHours: 8 };
  const mkIv72 = (open: number, close: number, cats: Array<[string, (h: number) => number]>): StandardInterval[] => {
    const out: StandardInterval[] = [];
    for (let day = 0; day < 5; day++) {
      for (let h = open; h < close; h++) {
        for (let m = 0; m < 60; m += 30) {
          for (const [category, vf] of cats) {
            out.push({ intervalIndex: out.length, start: new Date(2026, 2, 2 + day, h, m), end: new Date(2026, 2, 2 + day, h, m + 30), volume: vf(h), category });
          }
        }
      }
    }
    return out;
  };
  const cat1x: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 }];
  const cat2x: CategoryConfig[] = [
    { id: 'A', name: 'A', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 },
    { id: 'B', name: 'B', ahtMinutes: 25, shrinkagePct: 0.1, priority: 2 },
  ];
  const FX: Record<string, Fx72> = {};
  const addFx = (f: Fx72) => { FX[f.name] = f; };
  addFx({ name: 'min', intervals: mkIv72(8, 20, [['General', (h) => (h === 8 ? 36 : 5)]]), categories: cat1x, calendar: cal72, labor: lab72, sla: sla72(85, 3), seed: 42, reps: 6, arch: 'pooled', maxHC: 60 });
  addFx({ name: 'd33', intervals: mkIv72(8, 22, [['General', () => 20]]), categories: cat1x, calendar: { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 22 }, labor: { ...LABOR, dailyProductiveHours: 9 }, sla: sla72(80, 4), seed: 42, reps: 5, arch: 'pooled', maxHC: 60 });
  addFx({ name: 'd50', intervals: mkIv72(8, 20, [['General', (h) => (h >= 12 && h < 16 ? 14 : 3)]]), categories: cat1x, calendar: cal72, labor: lab72, sla: sla72(85, 3), seed: 42, reps: 6, arch: 'pooled', maxHC: 40 });
  addFx({ name: 'd50c', intervals: mkIv72(8, 20, [['General', (h) => (h === 8 ? 60 : 5)]]), categories: cat1x, calendar: cal72, labor: lab72, sla: sla72(97, 2), seed: 42, reps: 6, arch: 'pooled', maxHC: 40 });
  addFx({ name: 'd50p', intervals: mkIv72(8, 20, [['General', (h) => (h === 8 ? 60 : 4)]]), categories: cat1x, calendar: cal72, labor: lab72, sla: sla72(95, 4), seed: 42, reps: 6, arch: 'pooled', maxHC: 40 });
  addFx({ name: 'd51a', intervals: mkIv72(8, 20, [['A', (h) => (h >= 12 && h < 16 ? 14 : 3)], ['B', (h) => (h >= 12 && h < 16 ? 10 : 2)]]), categories: cat2x, calendar: cal72, labor: lab72, sla: sla72(85, 3), seed: 42, reps: 6, arch: 'siloed', maxHC: 60 });
  addFx({ name: 'd51b', intervals: mkIv72(8, 20, [['A', (h) => (h === 8 ? 60 : 4)], ['B', (h) => (h === 8 ? 40 : 3)]]), categories: cat2x, calendar: cal72, labor: lab72, sla: sla72(95, 4), seed: 42, reps: 6, arch: 'siloed', maxHC: 60 });
  addFx({ name: 'd52', intervals: mkIv72(8, 20, [['A', (h) => (h === 8 ? 60 : 4)], ['B', (h) => (h >= 12 && h < 16 ? 10 : 2)]]), categories: cat2x, calendar: cal72, labor: lab72, sla: sla72(95, 4), seed: 42, reps: 6, arch: 'siloed', maxHC: 60 });
  for (const type of ['support', 'healthcare', 'claims'] as const) {
    const { rows } = buildSampleDataset(type, new Date(2026, 9, 5, 8, 0, 0, 0));
    const ivs = mapRawRecordsToIntervals(rows, { intervalStartCol: 'IntervalStart', volumeCol: 'Volume', categoryCol: 'Category' } as any);
    const cats = discoverAndSyncCategories(ivs, DEFAULT_CATEGORIES, DEFAULT_SLA);
    addFx({ name: `smp-${type}`, intervals: ivs, categories: cats, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: DEFAULT_SLA, seed: DEFAULT_SIM_PARAMS.seed, reps: DEFAULT_SIM_PARAMS.replications, arch: 'pooled', maxHC: DEFAULT_SIM_PARAMS.maxHCSearch });
  }
  const NAMES72 = Object.keys(FX);
  const laborFor = (fx: Fx72, place: boolean): LaborConfig => ({ ...fx.labor, shiftPlacementEnabled: place, ...(place ? { shiftSlapMinutes: fx.labor.shiftSlapMinutes ?? 30 } : {}) });
  const slaFor = (fx: Fx72, cov: boolean): SLAPolicyConfig => ({ ...fx.sla, minCoverageEnabled: cov });
  const paramsFor = (fx: Fx72, place: boolean, cov: boolean) => ({
    intervals: fx.intervals, openingWIP: [] as OpeningWIPCase[], categories: fx.categories, calendar: fx.calendar, labor: laborFor(fx, place), sla: slaFor(fx, cov),
    seed: fx.seed, userMaxHC: fx.maxHC, replications: fx.reps, queueArchitecture: fx.arch,
  });
  const summarize = (fx: Fx72, r: any) => ({
    rec: r.recommendedHC as number | null, gross: r.staffing?.grossHCTotal as number | undefined, dig: dig72(r, fx.intervals[0].start.getTime()),
    win: r.shiftPlacement?.winningDistribution as ShiftDistributionByCategory | undefined, polish: r.rosterPolish?.status as string | undefined,
  });
  const syncCache = new Map<string, ReturnType<typeof summarize>>();
  const S72 = (name: string, place: boolean, cov: boolean) => {
    const key = `${name}|${place}|${cov}`;
    if (!syncCache.has(key)) syncCache.set(key, summarize(FX[name], searchOptimalHC(paramsFor(FX[name], place, cov))));
    return syncCache.get(key)!;
  };
  const A72 = async (name: string, place: boolean, cov: boolean) => summarize(FX[name], await searchOptimalHCAsync(paramsFor(FX[name], place, cov)));
  const rosterStr72 = (d: ShiftDistributionByCategory | undefined) => (d ? Object.keys(d).sort().map((k) => `${k === '__POOLED__' ? '' : k + '='}${d[k].slaps.map((s) => `${s.startMinutesFromOpen}:${s.agentCount}`).join(' ')}`).join(' | ') : 'uniform');

  // ---- API presence (everything below that needs the new helpers is guarded so this suite RUNS on the unchanged code and fails, not crashes) ----
  const brl = (hcNs as any).buildRescueLadder as ((p: any) => ShiftDistributionByCategory[]) | undefined;
  const crs = (hcNs as any).createRescueSearch as ((p: any) => { next: () => any; record: (e: any) => void; result: () => any }) | undefined;
  const rsi = (hcNs as any).rescueScreenInputs as ((sla: SLAPolicyConfig, cats: CategoryConfig[]) => { sla: SLAPolicyConfig; categories: CategoryConfig[] }) | undefined;
  const rre = (hcNs as any).resolveRescueEvaluation as ((stage: string, ctx: any) => any) | undefined;
  const ccb = (hcNs as any).createConfirmationBlock as ((p: any) => { baseSeed: number; sets: () => any[] }) | undefined;
  const dcs = (hcNs as any).deriveConfirmationBaseSeed as ((seed: number) => number) | undefined;
  const haveApi = [brl, crs, rsi, rre, ccb, dcs].every((f) => typeof f === 'function');
  assert(haveApi, 'D72.0 rescue API exported: buildRescueLadder, createRescueSearch, rescueScreenInputs, resolveRescueEvaluation, createConfirmationBlock, deriveConfirmationBaseSeed', `present=${[brl, crs, rsi, rre, ccb, dcs].map((f) => typeof f === 'function').join(',')}`);
  assert(
    (hcNs as any).RESCUE_SCREEN_MARGIN_PP === 1.5 && (hcNs as any).RESCUE_SCREEN_REPLICATIONS === 5 &&
      JSON.stringify((hcNs as any).RESCUE_LATE_SHARES) === JSON.stringify([0.25, 0.30, 0.35, 0.20, 0.40, 0.15, 0.10]),
    'D72.0b named constants: screen margin 1.5 pp, screen size 5 replications, late shares 25/30/35/20/40/15/10 %',
    `margin=${(hcNs as any).RESCUE_SCREEN_MARGIN_PP} reps=${(hcNs as any).RESCUE_SCREEN_REPLICATIONS} shares=${JSON.stringify((hcNs as any).RESCUE_LATE_SHARES)}`
  );

  const primarySets = (fx: Fx72) => hcNs.generatePrecomputedReplications({ intervals: fx.intervals, openingWIP: [], categories: fx.categories, calendar: fx.calendar, sla: fx.sla, baseSeed: fx.seed, replications: fx.reps });
  const confirmSets = (fx: Fx72) => hcNs.generatePrecomputedReplications({ intervals: fx.intervals, openingWIP: [], categories: fx.categories, calendar: fx.calendar, sla: fx.sla, baseSeed: (dcs ? dcs(fx.seed) : -1), replications: fx.reps });
  const evalAt = (fx: Fx72, cov: boolean, n: number, roster: ShiftDistributionByCategory | undefined, sets: any[], baseSeed: number) =>
    evaluateCandidateStatistical({
      operationalHC: n, intervals: fx.intervals, openingWIP: [], categories: fx.categories, calendar: fx.calendar, labor: laborFor(fx, true), sla: slaFor(fx, cov),
      baseSeed, replications: fx.reps, queueArchitecture: fx.arch, precomputedCaseSets: sets, shiftDistribution: roster,
    });

  // ---- Recorded from the UNCHANGED code (checkpoint 7ad848f, 2026-10-08): recommended HC with Shift Placement ON, [coverage ON, coverage OFF] ----
  const PRE_ON: Record<string, [number | null, number | null]> = {
    min: [9, 10], d33: [22, 21], d50: [9, 7], d50c: [29, 29], d50p: [11, 11], d51a: [17, 13], d51b: [20, 21], d52: [19, 21],
    'smp-support': [27, 28], 'smp-healthcare': [31, 31], 'smp-claims': [31, 31],
  };
  // ---- Shift Placement OFF controls: full-result digests recorded from the UNCHANGED code, [coverage ON, coverage OFF] ----
  const OFF_CTRL: Record<string, [string, string]> = {
    d33: ['9bfa6b712030ca31', 'e7648280481a50de'],
    d50: ['7e51ccbdd49beee7', '99118c71f91661d0'],
    d51a: ['5a50233e9e8ebe81', 'b039820a28ec7405'],
    min: ['9fbac7c6e70685e6', 'fd7188fda9d2d415'],
    'smp-claims': ['c817d697e8592d00', '5ebe0d840e798f15'],
    'smp-support': ['04e10423ae3aa168', 'cca2b247a10fb364'],
  };

  // ============================================================================================
  // D72.1 buildRescueLadder unit checks
  // ============================================================================================
  if (typeof brl === 'function') {
    const fx = FX.min;
    const labOn = laborFor(fx, true);
    const cases = generateCaseEntities({ intervals: fx.intervals, openingWIP: [], categories: fx.categories, calendar: fx.calendar, sla: fx.sla, seed: 42 }).cases as CaseEntity[];
    const slapMin = resolveShiftSlapMinutes(labOn);
    const valid = getValidSlapStarts(fx.calendar, labOn.dailyProductiveHours * 60, slapMin);
    const sum = (b: ShiftSlapDistribution) => b.slaps.reduce((s, x) => s + x.agentCount, 0);
    const l20 = brl({ n: 20, cases, calendar: fx.calendar, labor: labOn, queueArchitecture: 'pooled' });
    // 08:00-20:00 is 720 min, shift 480, slap grid 30: valid starts 0..240; the minimal cover is {0, 240} (0 covers to 480, 240 covers to 720).
    // Seats 20: rung 0 = 1 late starter; then round(share x 20) = 5, 6, 7, 4, 8, 3, 2 late starters (25, 30, 35, 20, 40, 15, 10 %).
    const lateCounts = l20.map((d) => d.__POOLED__.slaps.find((s) => s.startMinutesFromOpen === 240)?.agentCount ?? 0);
    assert(JSON.stringify(lateCounts) === JSON.stringify([1, 5, 6, 7, 4, 8, 3, 2]), 'D72.1a fixed rung order for N=20 on 08:00-20:00 / 8 h: late starters at +240 = 1, 5, 6, 7, 4, 8, 3, 2', `got ${JSON.stringify(lateCounts)}`);
    assert(l20.every((d) => Object.keys(d).join() === '__POOLED__' && sum(d.__POOLED__) === 20), 'D72.1b every pooled rung sums to N = 20', l20.map((d) => sum(d.__POOLED__)).join(','));
    assert(l20.every((d) => d.__POOLED__.slaps.every((s) => valid.includes(s.startMinutesFromOpen) && s.agentCount > 0) && d.__POOLED__.slapMinutes === slapMin), 'D72.1c every offset is a member of getValidSlapStarts and no slap has zero agents', JSON.stringify(valid));
    assert(JSON.stringify(l20) === JSON.stringify(brl({ n: 20, cases, calendar: fx.calendar, labor: labOn, queueArchitecture: 'pooled' })), 'D72.1d the ladder is identical across calls (deterministic order)', '');
    assert(
      JSON.stringify(l20[0]) === JSON.stringify(buildCoverageRepairDistribution({ n: 20, calendar: fx.calendar, labor: labOn, minAgentsPerInterval: 1, queueArchitecture: 'pooled' })),
      'D72.1e first rung = the minimal later-start shape (coverage-repair roster with a minimum of 1 even with the floor off)', JSON.stringify(l20[0])
    );
    assert(new Set(l20.map((d) => JSON.stringify(d))).size === l20.length, 'D72.1f no duplicate rosters in the ladder', '');
    assert(brl({ n: 1, cases, calendar: fx.calendar, labor: labOn, queueArchitecture: 'pooled' }).length === 0, 'D72.1g N=1: empty ladder (no seat for a late starter)', '');
    // N=2: share rungs collapse onto rung 0 (1 late starter is the only possibility) -> exactly one rung 0:1 240:1.
    const l2 = brl({ n: 2, cases, calendar: fx.calendar, labor: labOn, queueArchitecture: 'pooled' });
    assert(l2.length === 1 && rosterStr72(l2[0]) === '0:1 240:1', 'D72.1h N=2: every share rung equals the minimal shape and is dropped as a duplicate -> one rung 0:1 240:1', rosterStr72(l2[0]));
    // 24x7 and shift >= business window: empty ladder.
    assert(brl({ n: 20, cases, calendar: CAL_24X7, labor: labOn, queueArchitecture: 'pooled' }).length === 0, 'D72.1i 24x7 calendar: empty ladder', '');
    assert(brl({ n: 20, cases, calendar: BIZ_CAL, labor: { ...labOn, dailyProductiveHours: 8 }, queueArchitecture: 'pooled' }).length === 0, 'D72.1j shift == business window (09:00-17:00, 8 h): empty ladder', '');
    assert(brl({ n: 20, cases, calendar: BIZ_CAL, labor: { ...labOn, dailyProductiveHours: 9 }, queueArchitecture: 'pooled' }).length === 0, 'D72.1k shift > business window: empty ladder', '');

    // Two late starts: 07:00-22:00 (900 min) with a 6 h shift (360): minimal cover {0, 360, 540}? greedy picks the largest start <= frontier each time.
    {
      const calTwo: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 7, dailyCloseHour: 22 };
      const labTwo: LaborConfig = { ...labOn, dailyProductiveHours: 6 };
      const validTwo = getValidSlapStarts(calTwo, 360, resolveShiftSlapMinutes(labTwo));
      const lt = brl({ n: 30, cases, calendar: calTwo, labor: labTwo, queueArchitecture: 'pooled' });
      const offs = new Set<number>(); for (const d of lt) for (const s of d.__POOLED__.slaps) offs.add(s.startMinutesFromOpen);
      assert(lt.length > 2 && lt.every((d) => sum(d.__POOLED__) === 30 && d.__POOLED__.slaps.every((s) => validTwo.includes(s.startMinutesFromOpen) && s.agentCount > 0)) && [...offs].filter((o) => o > 0).length === 2, 'D72.1l two late starts (07:00-22:00 / 6 h): every rung sums to N, offsets valid, exactly two distinct late offsets used', `offsets=${[...offs].sort((a, b) => a - b).join(',')} rungs=${lt.length}`);
    }

    // Siloed: one block per category from the DES's own seat split; a category with too few seats for a late starter is left out (amendment 4).
    {
      const fs = FX.d51a;
      const labS = laborFor(fs, true);
      const casesS = generateCaseEntities({ intervals: fs.intervals, openingWIP: [], categories: fs.categories, calendar: fs.calendar, sla: fs.sla, seed: 42 }).cases as CaseEntity[];
      const wl = new Map<string, number>(); for (const c of casesS) wl.set(c.category, (wl.get(c.category) || 0) + c.totalAhtMinutes);
      let allOk = true; let detail = '';
      for (const n of [3, 5, 9, 17, 30]) {
        const seats = allocateAgentsToCategories(wl, n);
        const ladder = brl({ n, cases: casesS, calendar: fs.calendar, labor: labS, queueArchitecture: 'siloed' });
        for (const d of ladder) {
          for (const k of Object.keys(d)) {
            if (!(seats.get(k)! >= 2) || sum(d[k]) !== seats.get(k)) { allOk = false; detail ||= `n=${n} ${k}: block ${sum(d[k])} vs seats ${seats.get(k)}`; }
            if (d[k].slaps.some((s) => s.agentCount <= 0 || !valid.includes(s.startMinutesFromOpen))) { allOk = false; detail ||= `n=${n} ${k}: bad slap`; }
          }
        }
        if (ladder.length === 0 && n >= 5) { allOk = false; detail ||= `n=${n}: empty siloed ladder`; }
      }
      assert(allOk, 'D72.1m siloed (N = 3, 5, 9, 17, 30): each listed block sums to its OWN seat count (DES seat split); a category with fewer than 2 seats is never listed; offsets valid; no zero-agent slaps', detail);
      // N=3: seats split leaves one category with a single seat -> that category is absent from every rung and stays at opening.
      const seats3 = allocateAgentsToCategories(wl, 3);
      const single = [...seats3.entries()].filter(([, s]) => s === 1).map(([k]) => k);
      const l3 = brl({ n: 3, cases: casesS, calendar: fs.calendar, labor: labS, queueArchitecture: 'siloed' });
      assert(single.length === 1 && l3.length > 0 && l3.every((d) => d[single[0]] === undefined && Object.keys(d).length === 1), 'D72.1n siloed N=3: the category with one seat is left out of every rung (stays at opening); the other keeps a block', `seats=${JSON.stringify([...seats3])} rungs=${l3.map((d) => Object.keys(d).join('+')).join(',')}`);
      assert(JSON.stringify(brl({ n: 17, cases: casesS, calendar: fs.calendar, labor: labS, queueArchitecture: 'siloed' })) === JSON.stringify(brl({ n: 17, cases: casesS, calendar: fs.calendar, labor: labS, queueArchitecture: 'siloed' })), 'D72.1o siloed ladder identical across calls', '');
      const l17 = brl({ n: 17, cases: casesS, calendar: fs.calendar, labor: labS, queueArchitecture: 'siloed' });
      const catWl = new Map<string, number>(); for (const c of casesS) catWl.set(c.category, (catWl.get(c.category) || 0) + c.totalAhtMinutes);
      assert(JSON.stringify(l17[0]) === JSON.stringify(buildCoverageRepairDistribution({ n: 17, calendar: fs.calendar, labor: labS, minAgentsPerInterval: 1, queueArchitecture: 'siloed', categoryWorkloadMinutes: catWl })), 'D72.1p siloed: first rung equals the minimal later-start shape per category', '');
    }
  } else {
    assert(false, 'D72.1 buildRescueLadder unit checks', 'buildRescueLadder is not exported');
  }

  // ============================================================================================
  // D72.2 pre-screen inputs + evaluation stages
  // ============================================================================================
  if (typeof rsi === 'function' && typeof rre === 'function' && typeof ccb === 'function' && typeof dcs === 'function') {
    const baseSla: SLAPolicyConfig = { ...sla72(85, 3), confidenceLevelPct: 95, occupancyCapEnabled: true, occupancyCapPct: 92, boAsaEnabled: true, boAsaTarget: 30 };
    const cats: CategoryConfig[] = [{ ...cat2x[0], primaryPct: 90 }, { ...cat2x[1] }];
    const sc = rsi(baseSla, cats);
    assert(approx(sc.sla.primaryPct, 83.5) && sc.sla.confidenceLevelPct === 50, 'D72.2a screen: overall target 85 -> 83.5 and confidence level 50', `primary=${sc.sla.primaryPct} conf=${sc.sla.confidenceLevelPct}`);
    assert(approx(sc.categories[0].primaryPct as number, 88.5) && sc.categories[1].primaryPct === undefined, 'D72.2b screen: a per-category target 90 -> 88.5; a category without its own target stays without one', JSON.stringify(sc.categories.map((c) => c.primaryPct)));
    assert(sc.sla.occupancyCapEnabled === true && sc.sla.occupancyCapPct === 92 && sc.sla.boAsaEnabled === true && sc.sla.boAsaTarget === 30 && baseSla.primaryPct === 85 && baseSla.confidenceLevelPct === 95 && cats[0].primaryPct === 90, 'D72.2c screen: occupancy and ASA caps NOT relaxed; the caller\'s sla / categories are not mutated', JSON.stringify(sc.sla));
    const fx = FX.min;
    const blk = ccb({ intervals: fx.intervals, openingWIP: [], categories: fx.categories, calendar: fx.calendar, sla: fx.sla, seed: fx.seed, replications: fx.reps });
    const pSets = primarySets(fx);
    const ctx = { sla: fx.sla, categories: fx.categories, replications: 8, baseSeed: fx.seed, precomputedCaseSets: pSets, confirmation: blk };
    const eS = rre('screen', ctx), eP = rre('primary', ctx), eC = rre('confirm', ctx);
    assert(eS.replications === 5 && rre('screen', { ...ctx, replications: 3 }).replications === 3 && eS.precomputedCaseSets === pSets && eS.baseSeed === 42, 'D72.2d screen stage: min(R, 5) replications on the first primary sets, same base seed', `reps=${eS.replications}`);
    assert(eP.replications === 8 && eP.sla === fx.sla && eP.categories === fx.categories && eP.precomputedCaseSets === pSets && eP.baseSeed === 42, 'D72.2e primary stage: full R on the primary sets with the UNMODIFIED sla and categories', '');
    assert(eC.replications === 8 && eC.sla === fx.sla && eC.categories === fx.categories && eC.precomputedCaseSets === blk.sets() && eC.baseSeed === dcs(fx.seed) && eC.baseSeed !== 42, 'D72.2f confirmation stage: full R on the confirmation block (its derived base seed) with the UNMODIFIED sla and categories', '');
  } else {
    assert(false, 'D72.2 screen / stage inputs', 'rescue helpers are not exported');
  }

  // ============================================================================================
  // D72.3 acceptance rule (amendment 1) on constructed evaluator results
  // ============================================================================================
  if (typeof crs === 'function') {
    const mkR = (k: number): ShiftDistributionByCategory => ({ __POOLED__: { slapMinutes: 30, slaps: [{ startMinutesFromOpen: 0, agentCount: 10 - k }, { startMinutesFromOpen: 240, agentCount: k }] } });
    const ladder = [mkR(1), mkR(2), mkR(3)];
    // script(rung, stage) -> passes; returns the visit log "s0 p0 c0 ..." and the result.
    const drive = (script: (rung: number, stage: string) => boolean, tried: Array<ShiftDistributionByCategory | null | undefined> = []) => {
      const s = crs({ ladder, alreadyTried: tried });
      const log: string[] = [];
      let guard = 0;
      for (let c = s.next(); c !== null && guard < 100; c = s.next(), guard++) {
        log.push(`${c.stage[0]}${c.rung}`);
        s.record({ passesAllConstraints: script(c.rung, c.stage), tag: `${c.stage}-${c.rung}` });
      }
      return { log: log.join(' '), res: s.result() };
    };
    // (1) roster 0 passes the primary block but fails the confirmation block -> rejected, rung 1 tried; rung 1 passes both -> accepted.
    const t1 = drive((r, st) => !(r === 0 && st === 'confirm'));
    assert(t1.log === 's0 p0 c0 s1 p1 c1' && t1.res.winner?.rung === 1 && JSON.stringify(t1.res.winner.roster) === JSON.stringify(ladder[1]) && JSON.stringify(t1.res.rejectedAtConfirmation) === '[0]', 'D72.3a passes the primary block but fails the confirmation block -> rejected, next rung tried; the next rung that passes both is accepted', `log=${t1.log} winner=${t1.res.winner?.rung}`);
    assert(t1.res.winner?.ev?.tag === 'primary-1', 'D72.3b the winner carries the PRIMARY-block evaluation (what is reported and cached), not the confirmation one', `tag=${t1.res.winner?.ev?.tag}`);
    // (2) passes both on rung 0 -> accepted at once, nothing else evaluated.
    const t2 = drive(() => true);
    assert(t2.log === 's0 p0 c0' && t2.res.winner?.rung === 0, 'D72.3c a roster that passes screen, primary and confirmation is accepted at once; no further rung is evaluated', t2.log);
    // (3) every rung passes primary but fails confirmation -> no winner, all rungs rejected at confirmation, each in order.
    const t3 = drive((_r, st) => st !== 'confirm');
    assert(t3.res.winner === null && t3.log === 's0 p0 c0 s1 p1 c1 s2 p2 c2' && JSON.stringify(t3.res.rejectedAtConfirmation) === '[0,1,2]', 'D72.3d every rung fails confirmation -> no winner (the headcount stays rejected)', t3.log);
    // (4) the pre-screen never accepts: a screen pass followed by a full-R failure is rejected; a screen failure never reaches full R.
    const t4 = drive((r, st) => (r === 0 ? st === 'screen' : false));
    assert(t4.res.winner === null && t4.log === 's0 p0 s1 s2', 'D72.3e screen passes but primary full R fails -> rejected (no confirmation run); a failing screen skips straight to the next rung', t4.log);
    const t5 = drive((_r, st) => st === 'screen' ? true : false);
    assert(t5.res.winner === null, 'D72.3f the screen verdict alone can never produce a winner', t5.log);
    // (5) rosters already tried at this N are removed.
    const t6 = drive(() => true, [ladder[0], null, undefined]);
    assert(t6.log === 's0 p0 c0' && JSON.stringify(t6.res.winner?.roster) === JSON.stringify(ladder[1]) && t6.res.ladderLength === 2, 'D72.3g a roster identical to one already tried at this N (uniform / repair / analytic) is skipped', `log=${t6.log} len=${t6.res.ladderLength}`);
    // (6) empty ladder: nothing to evaluate.
    const e = crs({ ladder: [], alreadyTried: [] });
    assert(e.next() === null && e.result().winner === null, 'D72.3h empty ladder: next() is null, no winner', '');
    // (7) a real pre-screen case: a roster whose cheap screen passes but whose full-R gate fails. Found by a throwaway scan over every
    // (fixture, N, rung): on the D33 file with coverage ON, N=21, rung 0 (the minimal shape) screens at CI lower bound 78.8 against the
    // relaxed target 78.5 (50% confidence, 5 reps) but fails the real gate: lower bound 78.3 < 80 at 90% confidence over 5 reps.
    // The test re-finds it at run time over N = 15..23 so it is not tied to a digest.
    if (typeof brl === 'function' && typeof rre === 'function' && typeof ccb === 'function') {
      const fx = FX.d33; const pSets = primarySets(fx); const slaCov = slaFor(fx, true);
      const blk = ccb({ intervals: fx.intervals, openingWIP: [], categories: fx.categories, calendar: fx.calendar, sla: slaCov, seed: fx.seed, replications: fx.reps });
      const ctx = { sla: slaCov, categories: fx.categories, replications: fx.reps, baseSeed: fx.seed, precomputedCaseSets: pSets, confirmation: blk };
      const runStage = (n: number, stage: string, roster: ShiftDistributionByCategory) => { const p = rre(stage, ctx); return evaluateCandidateStatistical({ operationalHC: n, intervals: fx.intervals, openingWIP: [], categories: p.categories, calendar: fx.calendar, labor: laborFor(fx, true), sla: p.sla, baseSeed: p.baseSeed, replications: p.replications, queueArchitecture: 'pooled', precomputedCaseSets: p.precomputedCaseSets, shiftDistribution: roster }); };
      let found: { n: number; rung: number; screenLow: number; fullLow: number } | null = null;
      for (let n = 15; n <= 23 && !found; n++) {
        const ld = brl({ n, cases: pSets[0].cases, calendar: fx.calendar, labor: laborFor(fx, true), queueArchitecture: 'pooled' });
        for (let rung = 0; rung < ld.length && !found; rung++) {
          const sc = runStage(n, 'screen', ld[rung]);
          if (!sc.passesAllConstraints) continue;
          const fu = runStage(n, 'primary', ld[rung]);
          if (!fu.passesAllConstraints) found = { n, rung, screenLow: sc.primaryStats.ci95Low, fullLow: fu.primaryStats.ci95Low };
        }
      }
      assert(found !== null, 'D72.3i a real DES case exists where the pre-screen passes but the full-R gate fails (D33 file, coverage ON, rung rosters over N = 15..23)', 'none found');
      if (found) {
        const ld = brl({ n: found.n, cases: pSets[0].cases, calendar: fx.calendar, labor: laborFor(fx, true), queueArchitecture: 'pooled' });
        const s = crs({ ladder: [ld[found.rung]], alreadyTried: [] });
        const visited: string[] = [];
        for (let c = s.next(); c !== null; c = s.next()) { visited.push(c.stage); s.record(runStage(found.n, c.stage, c.roster)); }
        assert(s.result().winner === null && visited.join() === 'screen,primary', `D72.3j that roster (N=${found.n}, rung ${found.rung}; screen CI low ${found.screenLow}, full-R CI low ${found.fullLow}) is rejected by the state machine at the full-R stage: stages ${visited.join('>')}`, JSON.stringify(s.result()));
      }
    }
  } else {
    assert(false, 'D72.3 acceptance rule', 'createRescueSearch is not exported');
  }

  // ============================================================================================
  // D72.4 confirmation block: deterministic, disjoint from the primary block, identical for every candidate
  // ============================================================================================
  if (typeof ccb === 'function' && typeof dcs === 'function') {
    const fx = FX.min;
    const mk = (seed = fx.seed, reps = fx.reps) => ccb({ intervals: fx.intervals, openingWIP: [], categories: fx.categories, calendar: fx.calendar, sla: fx.sla, seed, replications: reps });
    const caseDigest = (sets: any[]) => sets.map((s) => createHash('sha1').update(JSON.stringify(s.cases.map((c: any) => [c.category, c.arrival.getTime(), c.totalAhtMinutes]))).digest('hex').slice(0, 12));
    const a = mk(), b = mk();
    assert(a.baseSeed === 1013003081 && a.baseSeed === (42 + 1013 * 1000003) % M72 && dcs(42) === 1013003081, 'D72.4a derived base seed, closed form: (seed + 1013 x 1000003) mod 2147483647 = 1013003081 for seed 42 (replication index r + 1000003 of the same seed stream)', `got ${a.baseSeed}`);
    assert(JSON.stringify(caseDigest(a.sets())) === JSON.stringify(caseDigest(b.sets())) && a.sets() === a.sets() && a.sets().length === fx.reps, 'D72.4b deterministic: same run seed -> identical sets; the block is built once and reused (same array every call)', '');
    const ref = hcNs.generatePrecomputedReplications({ intervals: fx.intervals, openingWIP: [], categories: fx.categories, calendar: fx.calendar, sla: fx.sla, baseSeed: a.baseSeed, replications: fx.reps });
    assert(JSON.stringify(caseDigest(ref)) === JSON.stringify(caseDigest(a.sets())), 'D72.4c the block is generatePrecomputedReplications at the derived base seed (one generator, no private copy of the formula)', '');
    const prim = caseDigest(primarySets(fx)); const conf = caseDigest(a.sets());
    assert(prim.length === fx.reps && conf.every((d) => !prim.includes(d)) && new Set([...prim, ...conf]).size === 2 * fx.reps, 'D72.4d disjoint arrival realisations: no confirmation replication equals any primary replication (and all 2R differ)', `primary=${prim.join()} confirm=${conf.join()}`);
    let seedsDisjoint = true; let sd = '';
    for (const seed of [1, 42, 12345, 987654321, 2147483000]) {
      for (const R of [1, 8, 30, 200]) {
        const p = new Set<number>(); for (let r = 0; r < R; r++) p.add((seed + r * 1013 + 7) % M72);
        const cb = dcs(seed);
        for (let r = 0; r < R; r++) if (p.has((cb + r * 1013 + 7) % M72)) { seedsDisjoint = false; sd ||= `seed=${seed} R=${R} r=${r}`; }
      }
    }
    assert(seedsDisjoint, 'D72.4e per-replication seeds of the two blocks never coincide (5 run seeds x R in 1, 8, 30, 200)', sd);
    assert(dcs(43) !== dcs(42) && JSON.stringify(caseDigest(mk(43).sets())) !== JSON.stringify(caseDigest(a.sets())), 'D72.4f control: a different run seed gives a different confirmation block', '');
    // CRN within the block: every candidate N and rung is evaluated on the SAME case sets and the SAME base seed.
    if (typeof rre === 'function') {
      const ctx = { sla: fx.sla, categories: fx.categories, replications: fx.reps, baseSeed: fx.seed, precomputedCaseSets: primarySets(fx), confirmation: a };
      const x1 = rre('confirm', ctx), x2 = rre('confirm', ctx);
      assert(x1.precomputedCaseSets === x2.precomputedCaseSets && x1.baseSeed === x2.baseSeed && x1.precomputedCaseSets === a.sets(), 'D72.4g Common Random Numbers inside the block: every confirmation evaluation (any N, any rung) gets the identical sets and base seed', '');
    }
  } else {
    assert(false, 'D72.4 confirmation block', 'createConfirmationBlock / deriveConfirmationBaseSeed are not exported');
  }

  // ============================================================================================
  // D72.5 rescue by the minimal later-start shape (coverage OFF, Shift Placement ON) - "min" fixture
  // ============================================================================================
  {
    const fx = FX.min;
    const nPre = PRE_ON.min[1] as number; // 10 on the unchanged code
    const on = S72('min', true, false);
    const ctrlOnCovOn = S72('min', true, true);
    assert(on.rec === nPre - 1, `D72.5a min fixture, coverage OFF, Shift Placement ON: recommended HC ${nPre - 1} (unchanged code: ${nPre})`, `got ${on.rec}`);
    assert(ctrlOnCovOn.rec === PRE_ON.min[0], 'D72.5b CONTROL coverage ON, Shift Placement ON: still 9 (repair already tried the minimal shape; unchanged)', `got ${ctrlOnCovOn.rec}`);
    // Evidence that N-1 = 9 fails the three existing routes and passes the minimal later-start shape on BOTH blocks (true before and after).
    const n1 = nPre - 1;
    const pSets = primarySets(fx);
    const uni = evalAt(fx, false, n1, undefined, pSets, fx.seed);
    const an = computeCandidatePlacementDistribution({ n: n1, cases: pSets[0].cases, calendar: fx.calendar, labor: laborFor(fx, true), queueArchitecture: 'pooled' });
    const anEv = an ? evalAt(fx, false, n1, an, pSets, fx.seed) : null;
    const minShape = buildCoverageRepairDistribution({ n: n1, calendar: fx.calendar, labor: laborFor(fx, true), minAgentsPerInterval: 1, queueArchitecture: 'pooled' });
    const msP = evalAt(fx, false, n1, minShape ?? undefined, pSets, fx.seed);
    assert(!uni.passesAllConstraints && !!anEv && !anEv.passesAllConstraints, 'D72.5c N-1: everyone at opening fails and the analytic placement roster fails (CI lower bounds 77.2 / 69.2 vs target 85)', `uniform=${uni.primaryStats.ci95Low} analytic=${anEv?.primaryStats.ci95Low}`);
    assert(!!minShape && msP.passesAllConstraints && rosterStr72(minShape) === '0:8 240:1', 'D72.5d N-1: the minimal later-start shape (8 at opening + 1 at +240) passes the full-R gate on the primary block (CI lower bound 88.6)', `roster=${rosterStr72(minShape ?? undefined)} low=${msP.primaryStats.ci95Low}`);
    if (typeof dcs === 'function') {
      const msC = evalAt(fx, false, n1, minShape ?? undefined, confirmSets(fx), dcs(fx.seed));
      assert(msC.passesAllConstraints, 'D72.5e N-1: the same roster also passes the full-R gate on the confirmation block (CI lower bound 87.9)', `low=${msC.primaryStats.ci95Low}`);
    }
    // Never a false accept: the reported roster, re-evaluated independently at full R with the unmodified SLA.
    const rep = evalAt(fx, false, on.rec as number, on.win, pSets, fx.seed);
    assert(on.rec !== null && !!on.win && rep.passesAllConstraints, 'D72.5f the roster the search reports at the new headcount passes the unmodified full-R gate when re-evaluated independently (primary block)', `rec=${on.rec} low=${rep.primaryStats.ci95Low}`);
  }

  // ============================================================================================
  // D72.6 rescue by a share rung (coverage ON, Shift Placement ON) - the D33 shape
  // ============================================================================================
  {
    const fx = FX.d33;
    const on = S72('d33', true, true);
    assert(on.rec === 21 && PRE_ON.d33[0] === 22, 'D72.6a D33 file, coverage ON, Shift Placement ON: recommended HC 21 (unchanged code: 22)', `got ${on.rec}`);
    assert(S72('d33', true, false).rec === 21 && S72('d33', false, true).rec === 22, 'D72.6b CONTROLS: coverage OFF + placement ON stays 21; placement OFF stays 22', `${S72('d33', true, false).rec} / ${S72('d33', false, true).rec}`);
    if (typeof brl === 'function' && typeof dcs === 'function') {
      // Which route rescues 21? Walk the ladder independently (no pre-screen) with the unmodified gate on both blocks.
      const pSets = primarySets(fx); const cSets = confirmSets(fx);
      const ld = brl({ n: 21, cases: pSets[0].cases, calendar: fx.calendar, labor: laborFor(fx, true), queueArchitecture: 'pooled' });
      const rows = ld.map((d, i) => ({ i, roster: rosterStr72(d), p: evalAt(fx, true, 21, d, pSets, fx.seed).passesAllConstraints, c: evalAt(fx, true, 21, d, cSets, dcs(fx.seed)).passesAllConstraints }));
      const firstBoth = rows.find((r) => r.p && r.c);
      assert(!!firstBoth && firstBoth.i > 0 && !rows[0].p, 'D72.6c at N=21 the minimal shape (rung 0) fails and a later SHARE rung passes both blocks', JSON.stringify(rows));
      const rep = evalAt(fx, true, 21, on.win, pSets, fx.seed);
      assert(!!on.win && rep.passesAllConstraints, 'D72.6d never a false accept: the reported roster at 21 passes the unmodified full-R gate when re-evaluated independently', `roster=${rosterStr72(on.win)} low=${rep.primaryStats.ci95Low}`);
    } else {
      assert(false, 'D72.6c/d share-rung evidence and independent re-evaluation (D33)', 'rescue helpers are not exported');
    }
  }

  // ============================================================================================
  // D72.7 the confirmation block on the built-in support sample (coverage OFF, Shift Placement ON)
  // ============================================================================================
  {
    const fx = FX['smp-support'];
    const on = S72('smp-support', true, false);
    // Measured 2026-10-08: without the confirmation block the ladder rescues 27 (26 at opening + 1 later), which passes the search seed by about
    // 0.1 point but only 7 of 21 fresh seeds; today's 28 passes 21 of 21. With the block 27 is rejected and the answer stays 28.
    assert(on.rec === 28, 'D72.7a support sample, coverage OFF, Shift Placement ON: recommended HC stays 28 (the rescued 27 fails confirmation)', `got ${on.rec} roster=${rosterStr72(on.win)}`);
    // Independent reproduction of the accepted roster on 10 fresh run seeds (7001..7010): must pass the unmodified gate on at least 8.
    let passes = 0; const lows: number[] = [];
    for (let s = 7001; s <= 7010; s++) {
      const sets = hcNs.generatePrecomputedReplications({ intervals: fx.intervals, openingWIP: [], categories: fx.categories, calendar: fx.calendar, sla: slaFor(fx, false), baseSeed: s, replications: fx.reps });
      const ev = evalAt(fx, false, on.rec as number, on.win, sets, s);
      if (ev.passesAllConstraints) passes++;
      lows.push(ev.primaryStats.ci95Low);
    }
    assert(on.rec !== null && passes >= 8, `D72.7b the accepted roster at ${on.rec} (${rosterStr72(on.win)}) reproduces: passes the unmodified gate on ${passes} of 10 fresh seeds (need >= 8)`, `CI lows: ${lows.join(',')}`);
  }

  // ============================================================================================
  // D72.8 never a false accept on the moved suite fixtures
  // ============================================================================================
  const NEW_ON_COV_ON: Record<string, number> = { d50: 7, d51a: 14, d52: 18 }; // measured after the change (unchanged code: 9 / 17 / 19)
  if (typeof brl === 'function' && typeof dcs === 'function') {
    for (const [name, cov] of [['d50', true], ['d51a', true], ['d52', true]] as Array<[string, boolean]>) {
      const fx = FX[name];
      const on = S72(name, true, cov);
      const pre = PRE_ON[name][cov ? 0 : 1] as number;
      if (on.rec === null) { assert(false, `D72.8 ${name}: search returned a recommendation`, 'null'); continue; }
      assert(on.rec === NEW_ON_COV_ON[name], `D72.8z ${name}, coverage ON, Shift Placement ON: recommended HC ${NEW_ON_COV_ON[name]} (unchanged code: ${pre})`, `got ${on.rec}`);
      const pSets = primarySets(fx); const cSets = confirmSets(fx);
      const rep = evalAt(fx, cov, on.rec, on.win, pSets, fx.seed);
      assert(rep.passesAllConstraints, `D72.8a ${name} (pre-change ${pre}, now ${on.rec}): the reported roster re-evaluated independently at full R with the unmodified SLA passes (primary block)`, `low=${rep.primaryStats.ci95Low}`);
      if (on.rec < pre) {
        // A rescue happened: some ladder rung passes the full-R gate on BOTH blocks at the new headcount.
        const ld = brl({ n: on.rec, cases: pSets[0].cases, calendar: fx.calendar, labor: laborFor(fx, true), queueArchitecture: fx.arch });
        const both = ld.filter((d) => evalAt(fx, cov, on.rec as number, d, pSets, fx.seed).passesAllConstraints && evalAt(fx, cov, on.rec as number, d, cSets, dcs(fx.seed)).passesAllConstraints);
        assert(both.length > 0, `D72.8b ${name}: at the new headcount ${on.rec} at least one ladder roster passes the unmodified gate on the primary AND the confirmation block`, `rungs=${ld.length}`);
      }
    }
  } else {
    assert(false, 'D72.8 never a false accept on the moved suite fixtures (D50 / D51 / D52)', 'rescue helpers are not exported');
  }

  // ============================================================================================
  // D72.9 never-worse sweep
  // ============================================================================================
  for (const name of NAMES72) {
    for (const cov of [true, false]) {
      const on = S72(name, true, cov), off = S72(name, false, cov);
      const pre = PRE_ON[name][cov ? 0 : 1];
      const v = (x: number | null) => (x === null ? Infinity : x);
      assert(v(on.rec) <= v(off.rec) && v(on.rec) <= v(pre), `D72.9 ${name}, coverage ${cov ? 'ON' : 'OFF'}: placement ON ${on.rec} <= placement OFF ${off.rec} and <= pre-change placement ON ${pre}`, `on=${on.rec} off=${off.rec} pre=${pre}`);
    }
  }

  // ============================================================================================
  // D72.10 Shift Placement OFF controls (digests recorded on the unchanged code; must pass before AND after)
  // ============================================================================================
  for (const name of Object.keys(OFF_CTRL)) {
    for (const [i, cov] of [[0, true], [1, false]] as Array<[number, boolean]>) {
      const off = S72(name, false, cov);
      assert(off.dig === OFF_CTRL[name][i], `D72.10 CONTROL ${name}, Shift Placement OFF, coverage ${cov ? 'ON' : 'OFF'}: full result digest equals the one recorded on the unchanged code (HC ${off.rec})`, `digest=${off.dig} expected=${OFF_CTRL[name][i]}`);
    }
  }

  // ============================================================================================
  // D72.11 determinism + sync == async (full-result digest) on the suite's search fixtures
  // ============================================================================================
  {
    const again = summarize(FX.min, searchOptimalHC(paramsFor(FX.min, true, false)));
    assert(again.dig === S72('min', true, false).dig, 'D72.11a determinism: same seed twice -> identical full result (min fixture, coverage OFF)', `${again.dig} vs ${S72('min', true, false).dig}`);
    const cases72: Array<[string, boolean]> = [['min', false], ['min', true], ['d33', true], ['d33', false], ['d50', true], ['d51a', true], ['d52', true], ['d50p', true], ['smp-support', false]];
    for (const [name, cov] of cases72) {
      const a = await A72(name, true, cov);
      const s = S72(name, true, cov);
      assert(a.dig === s.dig && a.rec === s.rec, `D72.11b sync === async, full-result digest: ${name}, coverage ${cov ? 'ON' : 'OFF'} (HC ${s.rec})`, `sync=${s.dig}/${s.rec} async=${a.dig}/${a.rec}`);
    }
    const aOff = await A72('d33', false, true);
    assert(aOff.dig === OFF_CTRL.d33[0], 'D72.11c sync === async with Shift Placement OFF (D33, coverage ON): async digest equals the recorded control', `async=${aOff.dig}`);
  }

  // ============================================================================================
  // D72.12 monotonicity sweep (pattern D3.1): pass/fail in N with the ladder active
  // The per-N decision is rebuilt from the same public pieces evaluateN uses (coverage repair -> uniform -> analytic placement ->
  // shared ladder state machine with the shared stage rules), Shift Placement ON.
  // ============================================================================================
  if (typeof brl === 'function' && typeof crs === 'function' && typeof rre === 'function' && typeof ccb === 'function') {
    const decide = (fx: Fx72, cov: boolean, sets: any[], blk: any, n: number): { pass: boolean; via: string } => {
      const lab = laborFor(fx, true);
      const slaX = slaFor(fx, cov);
      const covPlan = (hcNs as any).planCoverageRepair({ n, sla: slaX, calendar: fx.calendar, labor: lab, queueArchitecture: fx.arch, representativeCases: sets[0].cases });
      if (covPlan.dist && evalAt(fx, cov, n, covPlan.dist, sets, fx.seed).passesAllConstraints) return { pass: true, via: 'repair' };
      if (!covPlan.repairFirst && evalAt(fx, cov, n, undefined, sets, fx.seed).passesAllConstraints) return { pass: true, via: 'uniform' };
      const an = computeCandidatePlacementDistribution({ n, cases: sets[0].cases, calendar: fx.calendar, labor: lab, queueArchitecture: fx.arch });
      if (an && evalAt(fx, cov, n, an, sets, fx.seed).passesAllConstraints) return { pass: true, via: 'analytic' };
      const rs = crs({ ladder: brl({ n, cases: sets[0].cases, calendar: fx.calendar, labor: lab, queueArchitecture: fx.arch }), alreadyTried: [covPlan.dist, an] });
      const ctx = { sla: slaX, categories: fx.categories, replications: fx.reps, baseSeed: fx.seed, precomputedCaseSets: sets, confirmation: blk };
      for (let c = rs.next(); c !== null; c = rs.next()) {
        const p = rre(c.stage, ctx);
        rs.record(evaluateCandidateStatistical({ operationalHC: n, intervals: fx.intervals, openingWIP: [], categories: p.categories, calendar: fx.calendar, labor: lab, sla: p.sla, baseSeed: p.baseSeed, replications: p.replications, queueArchitecture: fx.arch, precomputedCaseSets: p.precomputedCaseSets, shiftDistribution: c.roster }));
      }
      const w = rs.result().winner;
      return { pass: w !== null, via: w ? `rung${w.rung}` : 'none' };
    };
    for (const [name, cov, lo, hi] of [['min', false, 3, 14], ['d51a', true, 6, 18], ['d52', true, 10, 24]] as Array<[string, boolean, number, number]>) {
      const fx = FX[name];
      const sets = primarySets(fx);
      const blk = ccb({ intervals: fx.intervals, openingWIP: [], categories: fx.categories, calendar: fx.calendar, sla: slaFor(fx, cov), seed: fx.seed, replications: fx.reps });
      const rows: Array<{ n: number; pass: boolean; via: string }> = [];
      for (let n = lo; n <= hi; n++) rows.push({ n, ...decide(fx, cov, sets, blk, n) });
      const dump = rows.map((r) => `${r.n}${r.pass ? 'P' : 'F'}:${r.via}`).join(' ');
      const holes: string[] = [];
      for (let i = 0; i < rows.length - 1; i++) if (rows[i].pass && !rows[i + 1].pass) holes.push(`N=${rows[i].n} passed but N=${rows[i + 1].n} failed`);
      const cvTag = cov ? 'coverage ON' : 'coverage OFF';
      assert(rows.some((r) => r.pass) && rows.some((r) => !r.pass), `D72.12a setup (${name}, ${fx.arch}, ${cvTag}): the swept range N=${lo}..${hi} contains both a failing and a passing N`, dump);
      assert(holes.length === 0, `D72.12b ${name} (${fx.arch}, ${cvTag}): pass/fail is monotone in N over ${lo}..${hi} with the ladder active`, holes.join('; ') || dump);
      assert(rows.some((r) => r.pass && r.via.startsWith('rung')), `D72.12c ${name} (${cvTag}): the sweep includes at least one N that only the ladder passes (so the ladder is really exercised)`, dump);
      const rec = S72(name, true, cov).rec;
      const firstPass = rows.find((r) => r.pass)?.n;
      assert(rec === firstPass, `D72.12d ${name} (${cvTag}): the search's recommendation (${rec}) is the lowest passing N of the sweep (${firstPass})`, dump);
    }
  } else {
    assert(false, 'D72.12 monotonicity sweep with the ladder active', 'rescue helpers are not exported');
  }
}

// =================================================================
// Suite D73 - PRD P1-6 / L23: replacement fixtures for the roster-polish paths
//
// With Shift Placement ON the search now tries a ladder of simple start-time rosters (each confirmed on a second independent replication
// block) before rejecting a headcount. The lower headcounts that result leave the old D50 / D51 / D52 / D65 fixtures with nothing to re-spread
// (their polish status became 'no_improvement'; see the 2026-10-08 notes there). This suite keeps every roster-polish path under test on
// fixtures that are FOUND AT RUN TIME, not hand-tuned to a digest: a deterministic scan over a fixed, ordered parameter list takes the first
// combination whose `rosterPolish.status` is the wanted one, and then asserts the properties of that path (the ones the old assertions
// checked). A scan that finds nothing FAILS. All fixtures: Mon-Fri 08:00-20:00, 8 h shift, slap 30 min, 6 replications, seed 42, minimum
// coverage ON (the polish works from the coverage profile).
//
//  D73.1  pooled   'adopted'                         (D50.1 / D50.2 / D50.3 / D50.5 / D50.6 and the D65 F3 statistics)
//  D73.2  siloed   'adopted'                         (D51.1 a-h and the D65 F3 statistics)
//  D73.3  pooled   'kept_current_failed_gate'        (D50.4 a-c, with a non-trivial headcount)
//  D73.4  siloed   'adopted_partial' per queue       (D52.1: one queue saturates while another keeps improving)
// =================================================================
console.log('\n--- Suite D73: P1-6 replacement fixtures for the roster-polish paths (scan-found) ---');
{
  const t0 = Date.now();
  const cal73: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 20 };
  const labor73Off: LaborConfig = { ...LABOR, dailyProductiveHours: 8 };
  const labor73On: LaborConfig = { ...labor73Off, shiftPlacementEnabled: true, shiftSlapMinutes: 30 };
  const mkIv73 = (cats: Array<[string, (h: number) => number]>): StandardInterval[] => {
    const out: StandardInterval[] = [];
    for (let day = 0; day < 5; day++) {
      for (let h = 8; h < 20; h++) {
        for (let m = 0; m < 60; m += 30) {
          for (const [category, vf] of cats) {
            out.push({ intervalIndex: out.length, start: new Date(2026, 2, 2 + day, h, m), end: new Date(2026, 2, 2 + day, h, m + 30), volume: vf(h), category });
          }
        }
      }
    }
    return out;
  };
  const mkSla73 = (pct: number, windowH: number): SLAPolicyConfig => ({
    primaryPct: pct, primaryWindow: windowH, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90, minCoverageEnabled: true,
  });
  const cat1y: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 }];
  const cat2y: CategoryConfig[] = [
    { id: 'A', name: 'A', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 },
    { id: 'B', name: 'B', ahtMinutes: 25, shrinkagePct: 0.1, priority: 2 },
  ];
  type Fx73 = { label: string; intervals: StandardInterval[]; categories: CategoryConfig[]; sla: SLAPolicyConfig; arch: 'pooled' | 'siloed'; maxHC: number };
  const run73 = (fx: Fx73, labor: LaborConfig) => ({
    intervals: fx.intervals, openingWIP: [] as any[], categories: fx.categories, calendar: cal73, labor, sla: fx.sla, seed: 42, userMaxHC: fx.maxHC, replications: 6, queueArchitecture: fx.arch,
  });
  const cache73 = new Map<string, any>();
  const onSearch = (fx: Fx73): any => {
    if (!cache73.has(fx.label)) cache73.set(fx.label, searchOptimalHC(run73(fx, labor73On)));
    return cache73.get(fx.label);
  };
  // First fixture of an ordered family whose placement-ON search satisfies `want`; `tried` is how many searches the scan ran.
  const scan73 = (family: Fx73[], want: (r: any) => boolean): { fx: Fx73 | null; r: any; tried: number } => {
    let tried = 0;
    for (const fx of family) {
      tried++;
      const r = onSearch(fx);
      if (want(r)) return { fx, r, tried };
    }
    return { fx: null, r: null, tried };
  };
  const distStr73 = (d: ShiftDistributionByCategory | undefined) => JSON.stringify(d ? Object.keys(d).sort().map((k) => [k, d[k].slaps]) : null);
  const rosterStr73 = (d: ShiftDistributionByCategory | undefined) => (d ? Object.keys(d).sort().map((k) => `${k === '__POOLED__' ? '' : k + '='}${d[k].slaps.map((s) => `${s.startMinutesFromOpen}:${s.agentCount}`).join(' ')}`).join(' | ') : 'uniform');
  const improves73 = (rp: any) => !!rp?.polished && (rp.polished.minOnShift > rp.current.minOnShift || (rp.polished.minOnShift === rp.current.minOnShift && rp.polished.gapAgentHours < rp.current.gapAgentHours - 1e-9));
  const catImproves = (v: any) => !!v?.polished && !!v?.current && (v.polished.minOnShift > v.current.minOnShift || (v.polished.minOnShift === v.current.minOnShift && v.polished.gapAgentHours < v.current.gapAgentHours - 1e-9));
  const catNoDrop = (rp: any, keys: string[]) => JSON.stringify(Object.keys(rp?.byCategory ?? {}).sort()) === JSON.stringify(keys) && keys.every((k) => rp.byCategory[k].polished && rp.byCategory[k].polished.minOnShift >= rp.byCategory[k].current.minOnShift);

  // ---- ordered scan families (fixed order, nothing random) ----
  const SLAS73: Array<[number, number]> = [[85, 3], [90, 3], [80, 3], [95, 4], [90, 4], [85, 4]];
  const LEVELS73: Array<[number, number]> = [[3, 14], [4, 20], [5, 30], [6, 24], [4, 14], [6, 14], [8, 40], [6, 30]];
  const SHAPES73: Array<[string, (b: number, p: number) => (h: number) => number]> = [
    ['spike', (b, p) => (h) => (h === 8 ? p : b)],
    ['peak', (b, p) => (h) => (h >= 12 && h < 16 ? p : b)],
  ];
  const pooledFamily: Fx73[] = [];
  for (const [pct, w] of SLAS73) for (const [sn, sf] of SHAPES73) for (const [b, p] of LEVELS73) {
    pooledFamily.push({ label: `pooled ${sn} ${b}/${p} SLA ${pct}/${w}h`, intervals: mkIv73([['General', sf(b, p)]]), categories: cat1y, sla: mkSla73(pct, w), arch: 'pooled', maxHC: 60 });
  }
  const siloedFamily: Fx73[] = [];
  // Queue A: an 08:00 spike (base/spike volume per half-hour); queue B: a 12:00-16:00 peak (base/peak). Order is fixed.
  const SILO_LEVELS: Array<[number, number, number, number]> = [[3, 14, 2, 7], [2, 20, 1, 10], [3, 40, 1, 7], [4, 40, 2, 7], [6, 40, 4, 7], [3, 60, 1, 10], [6, 60, 4, 10]];
  for (const [pct, w] of [[95, 4], [90, 4], [95, 3], [85, 4]] as Array<[number, number]>) for (const [bA, pA, bB, pB] of SILO_LEVELS) {
    siloedFamily.push({
      label: `siloed A spike ${bA}/${pA} + B peak ${bB}/${pB} SLA ${pct}/${w}h`,
      intervals: mkIv73([['A', (h) => (h === 8 ? pA : bA)], ['B', (h) => (h >= 12 && h < 16 ? pB : bB)]]), categories: cat2y, sla: mkSla73(pct, w), arch: 'siloed', maxHC: 60,
    });
  }

  // ---- checks shared by the 'adopted' fixtures (pooled and siloed) ----
  const f3Checks = (tag: string, fx: Fx73, r: any) => {
    const N: number = r.recommendedHC;
    const sets = hcNs.generatePrecomputedReplications({ intervals: fx.intervals, openingWIP: [], categories: fx.categories, calendar: cal73, sla: fx.sla, baseSeed: 42, replications: 6 });
    const ind: any = evaluateCandidateStatistical({
      operationalHC: N, intervals: fx.intervals, openingWIP: [], categories: fx.categories, calendar: cal73, labor: labor73On, sla: fx.sla,
      baseSeed: 42, replications: 6, queueArchitecture: fx.arch, precomputedCaseSets: sets, shiftDistribution: r.shiftPlacement?.winningDistribution, dispatchFairness: undefined,
    });
    assert(JSON.stringify(r.primaryStatistical) === JSON.stringify(ind.primaryStats), `${tag}.F3a primaryStatistical describes the ADOPTED roster (equals an independent evaluation of it)`, `reported mean=${r.primaryStatistical?.achievedPctMean} independent mean=${ind.primaryStats?.achievedPctMean}`);
    const row = r.searchHistory.find((x: any) => x.hc === N);
    assert(!!row && r.searchHistory.filter((x: any) => x.hc === N).length === 1 && row.primaryPct === ind.primaryStats.achievedPctMedian && row.primaryCiLow === ind.primaryStats.ci95Low && row.primaryCiHigh === ind.primaryStats.ci95High && row.passed === ind.passesAllConstraints, `${tag}.F3b the single search-history row for N=${N} carries the adopted roster's numbers`, JSON.stringify(row));
    assert(r.finalDESResult.primaryAchievedPct === ind.representativeResult.primaryAchievedPct, `${tag}.F3c the headline run equals the adopted evaluation's representative run`, `headline ${r.finalDESResult.primaryAchievedPct} vs rep ${ind.representativeResult.primaryAchievedPct}`);
  };

  // =============================================================================================================================
  // D73.1 pooled 'adopted'
  // =============================================================================================================================
  {
    const sc = scan73(pooledFamily, (r) => r.rosterPolish?.status === 'adopted');
    assert(sc.fx !== null, 'D73.1a scan found a pooled fixture whose placement-ON polish is adopted', `no pooled 'adopted' fixture in ${pooledFamily.length} combinations`);
    if (sc.fx) {
      const { fx, r } = sc; const rp = r.rosterPolish;
      console.log(`  (D73.1 fixture: ${fx.label}; HC ${r.recommendedHC}; moves ${rp.movesApplied}/${rp.movesTotal}; roster ${rosterStr73(r.shiftPlacement?.winningDistribution)}; scan ran ${sc.tried} searches)`);
      const off = searchOptimalHC(run73(fx, labor73Off));
      assert(rp.status === 'adopted' && rp.movesApplied === rp.movesTotal && rp.movesTotal > 0, 'D73.1b adopted pooled: every planned move applied (k* = K)', `${rp.movesApplied}/${rp.movesTotal}`);
      assert(improves73(rp), 'D73.1c adopted roster improves coverage (higher minOnShift, tie -> lower gap)', `cur=${JSON.stringify(rp.current)} pol=${JSON.stringify(rp.polished)}`);
      assert(rp.polished.minOnShift >= 1, 'D73.1d polished roster keeps at least one agent on shift in every bucket', `min=${rp.polished.minOnShift}`);
      assert(r.recommendedHC !== null && off.recommendedHC !== null && r.recommendedHC <= off.recommendedHC, 'D73.1e HC with Shift Placement ON <= the placement-OFF run (polish itself never moves the headcount)', `off=${off.recommendedHC} on=${r.recommendedHC}`);
      const rA: any = await searchOptimalHCAsync(run73(fx, labor73On));
      assert(JSON.stringify(rA.rosterPolish) === JSON.stringify(rp) && distStr73(rA.shiftPlacement?.winningDistribution) === distStr73(r.shiftPlacement?.winningDistribution) && rA.recommendedHC === r.recommendedHC, 'D73.1i sync === async: rosterPolish, adopted roster and HC', `sync=${rosterStr73(r.shiftPlacement?.winningDistribution)} async=${rosterStr73(rA.shiftPlacement?.winningDistribution)}`);
      const r2 = searchOptimalHC(run73(fx, labor73On));
      assert(JSON.stringify(r2.rosterPolish) === JSON.stringify(rp), 'D73.1j same seed twice: identical rosterPolish', '');
      const minCov = r.finalDESResult?.minCoverageObserved ?? -1;
      assert(minCov >= 1, 'D73.1k adopted roster satisfies the coverage floor in the audit DES', `minCoverageObserved=${minCov}`);
      f3Checks('D73.1', fx, r);
      assert((off as any).rosterPolish === undefined, 'D73.1l placement OFF on the same fixture: rosterPolish undefined', '');
    }
  }

  // =============================================================================================================================
  // D73.2 + D73.4 siloed: one scan, two wanted statuses
  // =============================================================================================================================
  {
    const sAd = scan73(siloedFamily, (r) => r.rosterPolish?.status === 'adopted');
    assert(sAd.fx !== null, 'D73.2a scan found a siloed fixture whose placement-ON polish is adopted', `no siloed 'adopted' fixture in ${siloedFamily.length} combinations`);
    if (sAd.fx) {
      const { fx, r } = sAd; const rp = r.rosterPolish;
      console.log(`  (D73.2 fixture: ${fx.label}; HC ${r.recommendedHC}; moves ${rp.movesApplied}/${rp.movesTotal}; roster ${rosterStr73(r.shiftPlacement?.winningDistribution)}; scan ran ${sAd.tried} searches)`);
      const off = searchOptimalHC(run73(fx, labor73Off));
      assert(improves73(rp), 'D73.2b siloed adopted: org-wide coverage improves', `cur=${JSON.stringify(rp.current)} pol=${JSON.stringify(rp.polished)}`);
      assert(catNoDrop(rp, ['A', 'B']), "D73.2c both categories reported and no category's minOnShift decreases", JSON.stringify(rp.byCategory));
      assert(r.recommendedHC !== null && off.recommendedHC !== null && r.recommendedHC <= off.recommendedHC, 'D73.2d HC with Shift Placement ON <= the placement-OFF run (sync)', `off=${off.recommendedHC} on=${r.recommendedHC}`);
      const rA: any = await searchOptimalHCAsync(run73(fx, labor73On));
      assert(rA.recommendedHC === r.recommendedHC && rA.staffing?.grossHCTotal === r.staffing?.grossHCTotal, 'D73.2e async HC and gross HC equal the sync run', `sync=${r.recommendedHC}/${r.staffing?.grossHCTotal} async=${rA.recommendedHC}/${rA.staffing?.grossHCTotal}`);
      assert(JSON.stringify(rA.rosterPolish) === JSON.stringify(rp) && distStr73(rA.shiftPlacement?.winningDistribution) === distStr73(r.shiftPlacement?.winningDistribution), 'D73.2i sync === async (rosterPolish incl. byCategory + adopted roster)', '');
      const r2 = searchOptimalHC(run73(fx, labor73On));
      assert(JSON.stringify(r2.rosterPolish) === JSON.stringify(rp) && distStr73(r2.shiftPlacement?.winningDistribution) === distStr73(r.shiftPlacement?.winningDistribution), 'D73.2j deterministic across runs', '');
      const floor = resolveMinAgentsPerInterval(fx.sla, r.recommendedHC ?? 0);
      const minCov = r.finalDESResult?.minCoverageObserved ?? -1;
      assert(floor >= 1 && minCov >= floor, `D73.2k coverage floor (org-wide gate, ${floor}) honoured in the final DES`, `minCoverageObserved=${minCov}`);
      f3Checks('D73.2', fx, r);
    }

    // D73.4 - the per-queue property of the old D52.1: one queue saturates (does not reach its own target) while ANOTHER keeps improving.
    const wantPartial = (r: any) => {
      const rp = r.rosterPolish; const bc = rp?.byCategory;
      return rp?.status === 'adopted_partial' && !!bc?.A && !!bc?.B && catImproves(bc.A) && catImproves(bc.B) && bc.A.movesApplied < bc.A.movesTotal;
    };
    const sPart = scan73(siloedFamily, wantPartial);
    assert(sPart.fx !== null, "D73.4a scan found a siloed fixture with polish 'adopted_partial' where queue A saturates and queue B also improves its own minOnShift", `none in ${siloedFamily.length} combinations`);
    if (sPart.fx) {
      const { fx, r } = sPart; const rp = r.rosterPolish; const bc = rp.byCategory;
      console.log(`  (D73.4 fixture: ${fx.label}; HC ${r.recommendedHC}; moves ${rp.movesApplied}/${rp.movesTotal}; A ${bc.A.movesApplied}/${bc.A.movesTotal} B ${bc.B.movesApplied}/${bc.B.movesTotal}; scan ran ${sPart.tried} new searches)`);
      assert(rp.status === 'adopted_partial' && rp.movesApplied > 0 && rp.movesApplied < rp.movesTotal, 'D73.4b adopted_partial: 0 < k* < K at the top level', `${rp.movesApplied}/${rp.movesTotal}`);
      assert(catImproves(bc.A), 'D73.4c first-by-name category A improves its own coverage', JSON.stringify(bc.A));
      assert(catImproves(bc.B), 'D73.4d later category B ALSO improves its coverage although A stopped short (pre-fix: stuck at current)', JSON.stringify(bc.B));
      assert(catNoDrop(rp, ['A', 'B']), 'D73.4e no category minOnShift drops', JSON.stringify(bc));
      const sumApplied = Object.values<any>(bc).reduce((a, v) => a + (v.movesApplied ?? NaN), 0);
      const sumTotal = Object.values<any>(bc).reduce((a, v) => a + (v.movesTotal ?? NaN), 0);
      assert(sumApplied === rp.movesApplied && sumTotal === rp.movesTotal && bc.A.movesApplied < bc.A.movesTotal, 'D73.4f byCategory movesApplied/movesTotal are per key and sum to the top-level counts; A applied fewer than its own total', `${JSON.stringify(bc)} top=${rp.movesApplied}/${rp.movesTotal}`);
      const off = searchOptimalHC(run73(fx, labor73Off));
      assert(r.recommendedHC !== null && off.recommendedHC !== null && r.recommendedHC <= off.recommendedHC, 'D73.4g HC with Shift Placement ON <= the placement-OFF run', `off=${off.recommendedHC} on=${r.recommendedHC}`);
      const rA: any = await searchOptimalHCAsync(run73(fx, labor73On));
      assert(JSON.stringify(rA.rosterPolish) === JSON.stringify(rp) && distStr73(rA.shiftPlacement?.winningDistribution) === distStr73(r.shiftPlacement?.winningDistribution), 'D73.4h sync === async (rosterPolish incl. per-key moves + adopted roster)', '');
      const floor = resolveMinAgentsPerInterval(fx.sla, r.recommendedHC ?? 0);
      assert(floor >= 1 && (r.finalDESResult?.minCoverageObserved ?? -1) >= floor, 'D73.4i coverage floor honoured in the final DES', `min=${r.finalDESResult?.minCoverageObserved} floor=${floor}`);
      f3Checks('D73.4', fx, r);
    }
  }

  // =============================================================================================================================
  // D73.3 pooled 'kept_current_failed_gate' at a non-trivial headcount (N >= 8) - the old D50.4 fixture (97% / 2 h after a 60-case spike) is now
  // rescued to a roster nothing can improve, so the path is re-found by a scan over a tight-SLA spike family: one 08:00 spike (spike volume per
  // half-hour from 30 to 56 in steps of 2, base volume 3 / 2 / 4) at SLA 90% / 3 h, then 85% / 3 h. First hit whose headcount is >= 8 wins.
  // =============================================================================================================================
  {
    const keptFamily: Fx73[] = [];
    for (const [pct, w] of [[90, 3], [85, 3]] as Array<[number, number]>) for (let p = 30; p <= 56; p += 2) for (const b of [3, 2, 4]) {
      keptFamily.push({ label: `pooled spike ${b}/${p} SLA ${pct}/${w}h`, intervals: mkIv73([['General', (h) => (h === 8 ? p : b)]]), categories: cat1y, sla: mkSla73(pct, w), arch: 'pooled', maxHC: 60 });
    }
    const sk = scan73(keptFamily, (r) => r.rosterPolish?.status === 'kept_current_failed_gate' && (r.recommendedHC ?? 0) >= 8);
    assert(sk.fx !== null, "D73.3a scan found a pooled fixture with polish 'kept_current_failed_gate' at a headcount of 8 or more", `none in ${keptFamily.length} combinations`);
    if (sk.fx) {
      const { fx, r } = sk; const rp = r.rosterPolish;
      console.log(`  (D73.3 fixture: ${fx.label}; HC ${r.recommendedHC}; moves ${rp.movesApplied}/${rp.movesTotal}; roster ${rosterStr73(r.shiftPlacement?.winningDistribution)}; scan ran ${sk.tried} searches)`);
      assert(rp.status === 'kept_current_failed_gate' && typeof rp.reason === 'string' && rp.reason.length > 0 && rp.movesApplied === 0 && rp.movesTotal > 0, 'D73.3b first move fails the gate: status kept_current_failed_gate with a reason, 0 moves applied out of K > 0', `status=${rp.status} moves=${rp.movesApplied}/${rp.movesTotal} reason=${rp.reason}`);
      const off = searchOptimalHC(run73(fx, labor73Off));
      assert(r.recommendedHC !== null && (off.recommendedHC === null || r.recommendedHC <= off.recommendedHC), 'D73.3c HC comes from the search itself and is <= the placement-OFF run (polish only re-spreads, it never raises HC)', `off=${off.recommendedHC} on=${r.recommendedHC}`);
      const win = r.shiftPlacement?.winningDistribution?.__POOLED__?.slaps ?? [];
      const onShift = (rp.profile.bucketStartMinutes as number[]).map((st) => win.reduce((acc: number, sl: ShiftSlapDistribution["slaps"][number]) => (sl.startMinutesFromOpen <= st && st < sl.startMinutesFromOpen + 8 * 60 ? acc + sl.agentCount : acc), 0));
      assert(JSON.stringify(onShift) === JSON.stringify(rp.profile.onShiftCurrent) && distStr73(r.finalDESResult?.shiftDistributionUsed) === distStr73(r.shiftPlacement?.winningDistribution), 'D73.3d kept-current: the final roster (and the audit DES roster) is exactly the pre-polish current roster', `final=${JSON.stringify(onShift)} current=${JSON.stringify(rp.profile.onShiftCurrent)}`);
      assert(JSON.stringify(rp.profile.onShiftPolished) !== JSON.stringify(rp.profile.onShiftCurrent), 'D73.3e a different (re-spread) target roster existed and was refused: planned on-shift profile differs from the kept one', '');
      const rA: any = await searchOptimalHCAsync(run73(fx, labor73On));
      assert(JSON.stringify(rA.rosterPolish) === JSON.stringify(rp) && rA.recommendedHC === r.recommendedHC && distStr73(rA.shiftPlacement?.winningDistribution) === distStr73(r.shiftPlacement?.winningDistribution), 'D73.3f sync === async: rosterPolish, HC and kept roster', '');
      const r2 = searchOptimalHC(run73(fx, labor73On));
      assert(JSON.stringify(r2.rosterPolish) === JSON.stringify(rp), 'D73.3g deterministic across runs', '');
    }
  }

  console.log(`  (D73 elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

console.log('\n==================================================');
console.log(` RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
console.log('==================================================\n');

if (failedTests > 0) process.exitCode = 1;
