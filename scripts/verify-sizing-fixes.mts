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
  CaseMinHeap,
  generateCaseEntities,
  pickNextCase,
  resolveEffectiveAdherence,
  resolveMinAgentsPerInterval,
  resolveOccupancyCapPct,
  resolveShiftSlapMinutes,
  runBackofficeDES,
  verifyAgentTimelineInvariants,
} from '../src/utils/des-engine';
import * as hcNs from '../src/utils/hc-search';
import * as calNs from '../src/utils/calendar';
import * as desNs from '../src/utils/des-engine';
import { discoverAndSyncCategories, mapRawRecordsToIntervals, missingRequiredMappings, validateDataQuality } from '../src/utils/csv-parser';
import { buildManualWipCase, normalizeRemainingInput, parseRemainingText, remainingWorkLabel, totalPendingWorkMinutes } from '../src/utils/wip-row';
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
    // Re-pinned 2026-10-14 (Item 1, L28 / P1-9, owner decision 2026-10-11): ON was 22 (repair roster 0:21 300:1). When the repair roster fails the gate
    // the same agents are now also tried spread evenly over the same starts and the even split (0:11 300:10) passes the gate and the confirmation block at
    // 21. Coverage OFF is unchanged at 28 because the spread layout exists only with a repair roster (A1: OFF may now EXCEED ON, only when the ON answer
    // uses the spread roster - D78.d2 / D78.j).
    searchWithCoverage.recommendedHC === 21 && searchNoCoverage.recommendedHC === 28 &&
      [...(searchWithCoverage.finalDESResult?.shiftDistributionUsed?.__POOLED__?.slaps ?? [])].sort((p, q) => p.startMinutesFromOpen - q.startMinutesFromOpen).map((x) => x.startMinutesFromOpen + ':' + x.agentCount).join(' ') === '0:11 300:10',
    'D33.7 coverage ON = 21 (even spread 0:11 300:10, Item 1), coverage OFF = 28 (OFF > ON only because the ON answer uses the spread roster)',
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
    'support/pooled': [20, 28, 35], // Re-pinned 2026-10-14 (Item 2): 27/34 -> 28/35, 27 clears the main days but not the confirmation block
    'support/siloed': [20, 21, 26],
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
    // Re-pinned 2026-10-14 (Item 1, L28 / P1-9: the even spread over the coverage starts is a second layout tried when the repair roster fails): placement OFF was
    // infeasible (null); the spread layout (0:15 240:14) now passes, so OFF recommends 29. Placement ON is unchanged at 18 (a placement rescue); the control still
    // proves the ON headcount comes from the search, not the polish: ON 18 <= OFF 29.
    assert(offC.recommendedHC === 29 && onC.recommendedHC === 18, 'D50.4b control: HC still comes from the unchanged search (placement rescue, ON 18), polish only re-spreads; OFF was infeasible and is now 29 via the even-spread layout (Item 1)', `off=${offC.recommendedHC} on=${onC.recommendedHC}`);
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
// docs/audit/sample-hc-after-2026-09-30.jsonl, unchanged for AJM_Only BA/BN/FOFF/PON in sample-hc-after-2026-10-15.jsonl (the full 4-file x 6-cell diff is `npm run test:audit`).
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

  await checkScenario('D51.1', mkIv51((h) => (h >= 12 && h < 16 ? 14 : 3), (h) => (h >= 12 && h < 16 ? 10 : 2)), mkSla51(85, 3), 'no_improvement', { hc: 13, gross: 14 }); // Re-pinned 2026-10-14 (Item 1): 14 / 16 -> 13 / 14. The even spread over the coverage starts passes at 13 (A=0:4 240:3, B=0:3 240:3); placement OFF drops 17 -> 13 the same way, so ON still equals OFF.
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
      // Item 3: answer time is judged per category; the ASA samples belong to category A (B has no eligible cases, so it is not judged).
      categoryStats: { A: { primaryPct: o.catA ? o.catA[i] : 100, ...(o.asa ? { primaryEligible: 10, asaMeanMinutes: o.asa[i] } : {}) }, B: { primaryPct: o.catB ? o.catB[i] : 100 } },
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
  assert(af.failingReasons.length === 1 && /^BO ASA \(category 'A'\) 95% CI/.test(af.failingReasons[0]) && /upper bound > target 41minutes \(41m\)/.test(af.failingReasons[0]), 'D57.5b exactly one failing reason: BO ASA upper bound > target 41 minutes', af.failingReasons.join(' | '));
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
// 10 cases, 1 agent, AHT 1100 min, 8 productive h/day. Horizon Mon 12 Oct; every case is due Fri 30 Oct 17:00.
// Item 4 (2026-10-16): the drain now runs until the last deadline (Fri 30 Oct 17:00, later than horizon + 14 days = Mon 26 Oct 17:00)
// = 15 working days x 480 min = 7200 min -> floor(7200 / 1100) = 6 cases finish (6600 min, inside the deadline); the 7th is
// started but not finished, cases 8-10 never start: 4 unfinished at the new drain end. (Before item 4 this fixture used AHT 800 and
// the 11-day drain, 6 / 4; at AHT 800 the new drain would finish 9 of 10 - the redesign keeps the same 6 / 10, 60 % expectations.)
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
    totalAhtMinutes: 1100,
    remainingWorkMinutes: 1100,
    primaryDeadline: at59(30, 17),
    latestSafeStart: at59(28, 9),
    firstStartTime: null,
    completeTime: null,
    parkCount: 0,
    isOpeningWip: false,
  }));
  const cat59: CategoryConfig[] = [{ id: 'a', name: 'A', ahtMinutes: 1100, shrinkagePct: 0.2, priority: 1, primaryWindowMinutes: 100000 }];
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
  assert(r59.totalCases === 10 && r59.completedCases === 6 && r59.unfinishedCases === 4, 'D59.1 6 of 10 cases finish inside the drain (to the last deadline: floor(15 x 480 / 1100) = 6), 4 unfinished', `total ${r59.totalCases}, completed ${r59.completedCases}, unfinished ${r59.unfinishedCases}; expected 10/6/4`);
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
  const sortKeys = (_k: string, v: any) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().filter((k) => k !== 'winningLayout' && k !== 'confirmationOnlyFailure').map((k) => [k, v[k]])) : v); // winningLayout (Item 1 rework 2) and confirmationOnlyFailure (Item 2 rework, C3) are display-only labels, left out so the pinned pre-change digests still prove nothing else moved
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
  //   Re-pinned 2026-10-14 (Item 1 A4): 'others' 9db7e75aa8ce963c -> 4b5bc4d4961616be. Verified checkpoint vs new: HC 18, gross 20, adopted roster (A=0:8 240:3 | B=0:5 240:2)
  //   and the history's N / passed flags (15F 17F 18P 19P 20P 21P 22P) are identical; only the failing N's rows differ (they now describe the coverage-satisfying repair /
  //   spread roster, not the uniform one) and boundaryEvidence (the N-1 run uses that same roster).
  await polishCase('D65.4 siloed (D52 fixture)', { intervals: iv2, categories: cat2, labor: laborOn65, sla: mkSla65(95, 4), seed: 42, userMaxHC: 60, arch: 'siloed' }, { N: 18, mean: 99.3, rp: 'f10ac0c20fe7cf73', others: '4b5bc4d4961616be', dist: '7ccb9a8cd5d81ac2', bind: 'statistical_primary_sla|Primary SLA 95% Target (Statistical DES, 90% CI)', status: 'no_improvement' });

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
    // Re-pinned 2026-10-14 (Item 1, L28 / P1-9): the even spread over the coverage starts (0:4 240:4) passes at 8, so the recommendation moved 9 -> 8 (still
    // no_improvement); digest 21068fd81ff08d7a -> 26d8f22fd14ab032 (sync = async).
    assert(dg(a) === '26d8f22fd14ab032' && dg(aa) === dg(a), 'D65.5b no_improvement: full result pinned (P1-6: 12 -> 9; Item 1: 9 -> 8, digest 21068fd81ff08d7a -> 26d8f22fd14ab032) and sync = async', `sync ${dg(a)} async ${dg(aa)}`);
    assert(a.recommendedHC === 8 && aa.recommendedHC === 8, 'D65.5c no_improvement scenario: recommended HC is 8 in sync and async (P1-6: was 12; Item 1 even-spread layout: 9 -> 8)', `sync ${a.recommendedHC} async ${aa.recommendedHC}`);
    const off: Scn = { intervals: iv1, categories: cat1, labor: laborOff65, sla: sla65, seed: 42, userMaxHC: 40 };
    const o: any = searchOptimalHC(baseOf(off));
    const oa: any = await searchOptimalHCAsync(baseOf(off));
    // Re-pinned 2026-10-08 (P2-9): digest 9038b551a950a83b -> dd646445fac9906d. The recommended HC is unchanged (9); only the
    // `boundaryEvidence` block and the new `fixedShifts` field on the result differ.
    // Re-pinned 2026-10-14 (Item 1, spread passes): digest dd646445fac9906d -> 849aa48b20e81991. The placement-OFF recommendation moved 9 -> 7 (gross 10 -> 8; the even
    // spread 0:4 240:3 passes the gate and the confirmation block).
    assert(o.rosterPolish === undefined && dg(o) === '849aa48b20e81991' && dg(oa) === dg(o), 'D65.6 placement OFF: full result pinned (P2-9: only boundaryEvidence + fixedShifts differ from the pre-change digest 9038b551a950a83b) and sync = async', `sync ${dg(o)} async ${dg(oa)}`);
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
  const sortKeys72 = (_k: string, v: any) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().filter((k) => k !== 'winningLayout' && k !== 'confirmationOnlyFailure').map((k) => [k, v[k]])) : v); // winningLayout (Item 1 rework 2) and confirmationOnlyFailure (Item 2 rework, C3) are display-only labels, left out so the pinned pre-change digests still prove nothing else moved
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
  // (Item 1, 2026-10-14: these stay the UNCHANGED-code values on purpose; D72.9 checks the new placement-ON answers are <= them.)
  // Re-pinned 2026-10-14 (Item 2): smp-support [coverage ON] 27 -> 28 - the confirmation rule raises the answer by one (27 fails the second set), so the never-worse bound moves with it.
  const PRE_ON: Record<string, [number | null, number | null]> = {
    min: [9, 10], d33: [22, 21], d50: [9, 7], d50c: [29, 29], d50p: [11, 11], d51a: [17, 13], d51b: [20, 21], d52: [19, 21],
    'smp-support': [28, 28], 'smp-healthcare': [31, 31], 'smp-claims': [31, 31],
  };
  // ---- Shift Placement OFF controls: full-result digests recorded from the UNCHANGED code, [coverage ON, coverage OFF] ----
  const OFF_CTRL: Record<string, [string, string]> = {
    // Re-pinned 2026-10-14 (Item 1, L28 / P1-9). d33 [coverage ON]: 9bfa6b712030ca31 -> 182ef9a29f103996. The HC moved 22 -> 21 (the even spread 0:11 300:10 passes; same
    // owner-approved change as D33.7 / D72.6b); the coverage-OFF digest is unchanged.
    d33: ['182ef9a29f103996', 'e7648280481a50de'],
    // Re-pinned 2026-10-14 (Item 1, spread passes): d50 [coverage ON] 7e51ccbdd49beee7 -> f72ba2b9f58c361a (HC 9 -> 7, gross 10 -> 8, 0:8 240:1 -> 0:4 240:3);
    // d51a [coverage ON] 5a50233e9e8ebe81 -> f0162988cc498a17 (HC 17 -> 13, gross 19 -> 14, A=0:8 240:1 B=0:7 240:1 -> A=0:4 240:3 B=0:3 240:3). Coverage-OFF digests unchanged.
    d50: ['f72ba2b9f58c361a', '99118c71f91661d0'],
    d51a: ['f0162988cc498a17', 'b039820a28ec7405'],
    // Re-pinned 2026-10-14 (Item 1 A4), min [coverage ON]: 9fbac7c6e70685e6 -> dd6858f403235959 and smp-support [coverage ON]: 04e10423ae3aa168 -> e6abddaaf9f4d90e. Verified
    // checkpoint vs new: HC (9 / 27), gross HC (10 / 34), roster (0:8 240:1 / 0:26 150:1) and the history's N / passed flags are identical; only boundaryEvidence (the N-1 run
    // now uses the coverage-satisfying repair roster instead of uniform) and the failing N's history rows differ.
    min: ['dd6858f403235959', 'fd7188fda9d2d415'],
    'smp-claims': ['c817d697e8592d00', '5ebe0d840e798f15'],
    // Re-pinned 2026-10-14 (Item 2) smp-support [coverage ON]: e6abddaaf9f4d90e -> bbe42346e24279eb (HC 27 -> 28, gross 34 -> 35: 27 clears the main days but not the confirmation block). Coverage-OFF digest unchanged.
    'smp-support': ['bbe42346e24279eb', 'cca2b247a10fb364'],
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
    // Re-pinned 2026-10-14 (Item 1, L28 / P1-9): placement OFF, coverage ON was 22; the even spread (0:11 300:10) now passes at 21 (same value as D33.7).
    assert(S72('d33', true, false).rec === 21 && S72('d33', false, true).rec === 21, 'D72.6b CONTROLS: coverage OFF + placement ON stays 21; placement OFF, coverage ON 22 -> 21 (Item 1: even-spread layout, as D33.7)', `${S72('d33', true, false).rec} / ${S72('d33', false, true).rec}`);
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
  const NEW_ON_COV_ON: Record<string, number> = { d50: 7, d51a: 13, d52: 18 }; // measured after the change (unchanged code: 9 / 17 / 19); d51a 14 -> 13 on 2026-10-14 (Item 1: the even spread passes at 13)
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
        // Re-targeted 2026-10-14 (Item 1, L28 / P1-9). The headcount moved below the old pin by one of two routes. (1) The even-spread layout over the coverage
        // starts (a second layout tried when the repair roster fails): then the reported roster IS the spread roster and it passes the unmodified gate on BOTH
        // blocks. (2) A rescue ladder rung (original D72.8b): some rung passes the full-R gate on BOTH blocks. d51a (13) now takes route 1 (spread); the
        // ladder route is still pinned on d50 and d52 here and proven to be the ADOPTED roster, with the spread failing, in D72.8c.
        const plan8 = (hcNs as any).planCoverageRepair({ n: on.rec, sla: slaFor(fx, cov), calendar: fx.calendar, labor: laborFor(fx, true), queueArchitecture: fx.arch, representativeCases: pSets[0].cases });
        if (plan8.spread && on.win && rosterStr72(on.win) === rosterStr72(plan8.spread)) {
          const pOk = evalAt(fx, cov, on.rec, plan8.spread, pSets, fx.seed).passesAllConstraints;
          const cOk = evalAt(fx, cov, on.rec, plan8.spread, cSets, dcs(fx.seed)).passesAllConstraints;
          assert(pOk && cOk, `D72.8b ${name}: at the new headcount ${on.rec} the adopted roster is the even-spread layout (${rosterStr72(on.win)}) and it passes the unmodified gate on the primary AND the confirmation block`, `primary=${pOk} confirm=${cOk}`);
        } else {
          const ld = brl({ n: on.rec, cases: pSets[0].cases, calendar: fx.calendar, labor: laborFor(fx, true), queueArchitecture: fx.arch });
          const both = ld.filter((d) => evalAt(fx, cov, on.rec as number, d, pSets, fx.seed).passesAllConstraints && evalAt(fx, cov, on.rec as number, d, cSets, dcs(fx.seed)).passesAllConstraints);
          assert(both.length > 0, `D72.8b ${name}: at the new headcount ${on.rec} at least one ladder roster passes the unmodified gate on the primary AND the confirmation block`, `rungs=${ld.length}`);
        }
      }
    }
  } else {
    assert(false, 'D72.8 never a false accept on the moved suite fixtures (D50 / D51 / D52)', 'rescue helpers are not exported');
  }

  // ============================================================================================
  // D72.8c the ladder path is still exercised (Item 1, 2026-10-14): at these headcounts the repair roster AND the even spread both fail the gate
  // (or the spread fails confirmation) and the ADOPTED roster is a ladder rung - not the repair roster, not the spread roster.
  // ============================================================================================
  if (typeof brl === 'function' && typeof dcs === 'function') {
    for (const [name, n8] of [['d52', 18], ['d50c', 18]] as Array<[string, number]>) {
      const fx = FX[name];
      const on = S72(name, true, true);
      const pSets = primarySets(fx); const cSets = confirmSets(fx);
      const plan8 = (hcNs as any).planCoverageRepair({ n: n8, sla: slaFor(fx, true), calendar: fx.calendar, labor: laborFor(fx, true), queueArchitecture: fx.arch, representativeCases: pSets[0].cases });
      const winStr = rosterStr72(on.win);
      const ld = brl({ n: n8, cases: pSets[0].cases, calendar: fx.calendar, labor: laborFor(fx, true), queueArchitecture: fx.arch });
      const rung = ld.findIndex((d) => rosterStr72(d) === winStr);
      assert(on.rec === n8 && !!on.win && rung >= 0 && winStr !== rosterStr72(plan8.dist ?? undefined) && winStr !== rosterStr72(plan8.spread ?? undefined),
        `D72.8c ${name}: recommended HC ${n8}, and the adopted roster (${winStr}) is ladder rung ${rung}, not the repair roster (${rosterStr72(plan8.dist ?? undefined)}) nor the spread roster (${rosterStr72(plan8.spread ?? undefined)})`, `rec=${on.rec} win=${winStr}`);
      const repOk = !!plan8.dist && evalAt(fx, true, n8, plan8.dist, pSets, fx.seed).passesAllConstraints;
      const spP = !!plan8.spread && evalAt(fx, true, n8, plan8.spread, pSets, fx.seed).passesAllConstraints;
      const spC = !!plan8.spread && evalAt(fx, true, n8, plan8.spread, cSets, dcs(fx.seed)).passesAllConstraints;
      assert(!repOk && !(spP && spC), `D72.8c ${name}: at N=${n8} the repair roster fails the gate and the spread roster fails it (primary ${spP}, confirmation ${spC}) - so only a ladder rung can pass`, `repair=${repOk} spreadPrimary=${spP} spreadConfirm=${spC}`);
    }
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
      const repairEv = covPlan.dist ? evalAt(fx, cov, n, covPlan.dist, sets, fx.seed) : null;
      if (repairEv && repairEv.passesAllConstraints) return { pass: true, via: 'repair' };
      // Item 1 (L28 / P1-9): the repair roster failed -> the even spread over the same starts, accepted only if it also passes the confirmation block
      // (the same shared state machine the searches drive).
      const ccs = (hcNs as any).createCoverageSpreadSearch as ((p: any) => { next: () => any; record: (e: any) => void; result: () => any }) | undefined;
      if (repairEv && covPlan.spread && typeof ccs === 'function') {
        const sp = ccs({ repairRoster: covPlan.dist, spreadRoster: covPlan.spread, repairResult: repairEv, confirmEnabled: true });
        const ctxS = { sla: slaX, categories: fx.categories, replications: fx.reps, baseSeed: fx.seed, precomputedCaseSets: sets, confirmation: blk };
        for (let c = sp.next(); c !== null; c = sp.next()) {
          const p = c.stage === 'confirm' ? rre(c.stage, ctxS) : { sla: slaX, categories: fx.categories, replications: fx.reps, baseSeed: fx.seed, precomputedCaseSets: sets };
          sp.record(evaluateCandidateStatistical({ operationalHC: n, intervals: fx.intervals, openingWIP: [], categories: p.categories, calendar: fx.calendar, labor: lab, sla: p.sla, baseSeed: p.baseSeed, replications: p.replications, queueArchitecture: fx.arch, precomputedCaseSets: p.precomputedCaseSets, shiftDistribution: c.roster }));
        }
        if (sp.result().adopted) return { pass: true, via: 'spread' };
      }
      if (!covPlan.repairFirst && evalAt(fx, cov, n, undefined, sets, fx.seed).passesAllConstraints) return { pass: true, via: 'uniform' };
      const an = computeCandidatePlacementDistribution({ n, cases: sets[0].cases, calendar: fx.calendar, labor: lab, queueArchitecture: fx.arch });
      if (an && evalAt(fx, cov, n, an, sets, fx.seed).passesAllConstraints) return { pass: true, via: 'analytic' };
      const rs = crs({ ladder: brl({ n, cases: sets[0].cases, calendar: fx.calendar, labor: lab, queueArchitecture: fx.arch }), alreadyTried: [covPlan.dist, covPlan.spread, an] });
      const ctx = { sla: slaX, categories: fx.categories, replications: fx.reps, baseSeed: fx.seed, precomputedCaseSets: sets, confirmation: blk };
      for (let c = rs.next(); c !== null; c = rs.next()) {
        const p = rre(c.stage, ctx);
        rs.record(evaluateCandidateStatistical({ operationalHC: n, intervals: fx.intervals, openingWIP: [], categories: p.categories, calendar: fx.calendar, labor: lab, sla: p.sla, baseSeed: p.baseSeed, replications: p.replications, queueArchitecture: fx.arch, precomputedCaseSets: p.precomputedCaseSets, shiftDistribution: c.roster }));
      }
      const w = rs.result().winner;
      return { pass: w !== null, via: w ? `rung${w.rung}` : 'none' };
    };
    // Item 1 (2026-10-14): d51a is now passed by the even-spread layout at 13-16 (no ladder-only N), so its 12c expectation is 'spread'; the ladder route is
    // exercised by d52 (N=18) and by d50c (N=18..28, repair and spread both fail there), so 'rung' is still required of those sweeps.
    for (const [name, cov, lo, hi, route] of [['min', false, 3, 14, 'rung'], ['d51a', true, 6, 18, 'spread'], ['d52', true, 10, 24, 'rung'], ['d50c', true, 16, 30, 'rung']] as Array<[string, boolean, number, number, string]>) {
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
      assert(rows.some((r) => r.pass && r.via.startsWith(route)), `D72.12c ${name} (${cvTag}): the sweep includes at least one N that only ${route === 'rung' ? 'the ladder' : 'the even-spread layout'} passes (so that route is really exercised)`, dump);
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

// ─── SUITE D74: Results screen tells the truth (UI-9 / UI-10, display only) ───
{
  console.log('\n=== SUITE D74: history colour follows the CI gate; engine explanation is shown ===');
  const { historyPrimaryPasses: hpp, representativeTone: rt } = await import('../src/utils/results-display');
  assert(hpp({ primaryPct: 96.0, primaryCiLow: 94.1 }, 95, 95) === false, 'D74.1 median above target but CI low below floor -> fail colour', '');
  assert(hpp({ primaryPct: 92, primaryCiLow: 90.5 }, 90, 95) === true, 'D74.2 median below policy target but CI low >= slack floor -> pass colour', '');
  assert(hpp({ primaryPct: 96 }, 95, 95) === true && hpp({ primaryPct: 94 }, 95, 95) === false, 'D74.3 missing primaryCiLow falls back to median >= policy target', '');
  assert(hpp({ primaryPct: 90, primaryCiLow: 95 }, 95, 95) === true, 'D74.4 boundary: CI low equal to floor passes (same >= as engine passesPrimaryCI)', '');
  assert(rt(94, 95, true) === 'amber' && rt(94, 95, false) === 'bad' && rt(95, 95, true) === 'ok', 'D74.5 representative tone: amber only when below target with an engine explanation', '');
  const rf74 = readFileSync(join(resolve(import.meta.dirname, '..'), 'src', 'components', 'ResultsFlow.tsx'), 'utf-8');
  assert(rf74.includes('infeasibleAdjacentWarning') && rf74.includes('historyPrimaryPasses'), 'D74.6 ResultsFlow renders infeasibleAdjacentWarning and uses historyPrimaryPasses', '');
}

// ─── SUITE D75: idle-agent category label + low-replication note (H5 / H11, display only) ───
{
  console.log('\n=== SUITE D75: no guessed category for idle agents; replication note ===');
  const { idleAgentCategoryLabel: lbl, replicationsNote: note } = await import('../src/utils/results-display');
  assert(note(1) === 'No confidence check: with one replication the result is a single run.', 'D75.1 1 replication -> single-run note', '');
  assert(note(2) !== null && note(2)!.startsWith('Fewer than 30 replications'), 'D75.2 2 replications -> weak-CI note', '');
  assert(note(29) === note(2) && note(29) !== null, 'D75.3 29 replications -> weak-CI note', '');
  assert(note(30) === null, 'D75.4 30 replications -> no note', '');
  assert(note(100) === null, 'D75.5 100 replications -> no note', '');
  assert(lbl('Billing') === 'Billing', 'D75.6 real engine assignment is returned when present', '');
  assert(lbl(null) === 'No cases handled' && lbl(undefined) === 'No cases handled' && lbl('') === 'No cases handled', 'D75.7 neutral label when assignment absent', '');
  const fixture75 = ['A', 'B', 'C'];
  assert(!fixture75.includes(lbl(null)) && lbl(null) !== fixture75[4 % fixture75.length], 'D75.8 absent assignment never equals the old modulo guess for agent index 4', '');
  const rf75 = readFileSync(join(resolve(import.meta.dirname, '..'), 'src', 'components', 'ResultsFlow.tsx'), 'utf-8');
  assert(!rf75.includes('% categories.length') && rf75.includes('idleAgentCategoryLabel'), 'D75.9 ResultsFlow no longer labels agents by modulo guess', '');
  const runf75 = readFileSync(join(resolve(import.meta.dirname, '..'), 'src', 'components', 'RunFlow.tsx'), 'utf-8');
  assert(runf75.includes('replicationsNote('), 'D75.10 RunFlow shows the replication note', '');
}

// ─── SUITE D76: P1-7 / L24 roster polish must not be worse than the unpolished roster on fresh simulated days ───
{
  console.log('\n=== SUITE D76: polish confirmation (relative rule on the confirmation block) ===');
  const h = hcNs as any;
  const mkEv = (o: { orgOk?: boolean; cats?: Record<string, boolean>; lo?: number; reasons?: string[]; occ?: boolean; asa?: boolean; cov?: boolean }): any => ({
    passesOrgGates: o.orgOk ?? true, categoryPasses: o.cats ?? { A: true }, failingReasons: o.reasons ?? [], primaryStats: { ci95Low: o.lo ?? 90 },
    ...(o.occ === undefined ? {} : { passesOccupancyCap: o.occ }), ...(o.asa === undefined ? {} : { passesBoAsaCap: o.asa }), ...(o.cov === undefined ? {} : { passesCoverage: o.cov }),
  });
  const rule = h.polishNotWorseOnConfirmation as (b: any, c: any) => boolean;
  assert(typeof rule === 'function' && typeof h.mergePolishConfirmation === 'function' && typeof h.pooledPolishFallbackOrder === 'function', 'D76.0 polish confirmation API exported', '');
  // The rule, one case per branch (injected evaluations).
  assert(rule(mkEv({}), mkEv({ orgOk: false })) === false, 'D76.1a baseline passes + candidate fails org gates -> rejected', '');
  assert(rule(mkEv({}), mkEv({ cats: { A: false } })) === false, 'D76.1b baseline passes + a category fails for the candidate -> rejected', '');
  assert(rule(mkEv({}), mkEv({ lo: 80 })) === true, 'D76.1c baseline passes + candidate passes (lower bound irrelevant once both pass) -> adopted', '');
  const badBase = mkEv({ orgOk: false, lo: 80, cats: { A: true, B: false }, reasons: ['Primary SLA 90% CI [x] lower bound < 90%'] });
  assert(rule(badBase, mkEv({ orgOk: false, lo: 81, cats: { A: true, B: false } })) === true, 'D76.1d baseline fails + candidate lower bound better -> adopted', '');
  assert(rule(badBase, mkEv({ orgOk: false, lo: 80 - 5e-10, cats: { A: true, B: false } })) === true, 'D76.1e baseline fails + equal within 1e-9 -> adopted', '');
  assert(rule(badBase, mkEv({ orgOk: false, lo: 79, cats: { A: true, B: false } })) === false, 'D76.1f baseline fails + candidate lower bound worse -> rejected', '');
  assert(rule(badBase, mkEv({ orgOk: false, lo: 85, cats: { A: false, B: false } })) === false, 'D76.1g baseline fails + a category that passed for the baseline fails for the candidate -> rejected', '');
  assert(rule(badBase, mkEv({ orgOk: false, lo: 85, cats: { A: true, B: true } })) === true, 'D76.1h baseline fails + a failing category improves -> adopted', '');
  assert(rule(badBase, mkEv({ orgOk: false, lo: 85, cats: { A: true, B: false }, occ: false })) === false, 'D76.1i (P1-7-c: explicit flag, not message text) a cap the baseline satisfied (occupancy) becomes violated -> rejected', '');
  assert(rule(mkEv({ orgOk: false, lo: 80, reasons: ['BO ASA 90% CI x'] }), mkEv({ orgOk: false, lo: 81, reasons: ['BO ASA 90% CI x'] })) === true, 'D76.1j a cap violated by both stays neutral -> adopted on lower bound', '');
  // Siloed merge: two queues, only B fails confirmation -> only B is charged.
  const prim: any = { passes: true, passesOrgGates: true, categoryPasses: { A: true, B: true }, reasons: [], slaPct: 95 };
  const base2 = mkEv({ cats: { A: true, B: true } });
  const m1 = h.mergePolishConfirmation(prim, base2, mkEv({ cats: { A: true, B: false } }));
  assert(m1.categoryPasses.A === true && m1.categoryPasses.B === false && m1.passesOrgGates === true && m1.passes === false, 'D76.2a only the queue that fails confirmation loses its verdict (A keeps, B charged)', JSON.stringify(m1));
  const m2 = h.mergePolishConfirmation(prim, base2, mkEv({ orgOk: false }));
  assert(m2.passesOrgGates === false && m2.passes === false, 'D76.2b org-gate confirmation failure is an org failure', JSON.stringify(m2));
  const m3 = h.mergePolishConfirmation(prim, base2, mkEv({ cats: { A: true, B: true } }));
  assert(m3.passes === true && JSON.stringify(m3.categoryPasses) === JSON.stringify(prim.categoryPasses), 'D76.2c both pass confirmation -> primary verdict unchanged', JSON.stringify(m3));
  // Drive the real parallel search with merged verdicts: B fails confirmation at its full target, A is unaffected.
  {
    const totals = { A: 4, B: 4 };
    const ps = h.createParallelRosterKSearch(totals);
    const evalV = (v: Record<string, number>) => {
      const primary: any = { passes: true, passesOrgGates: true, categoryPasses: { A: true, B: true }, reasons: [], slaPct: 95 };
      return h.mergePolishConfirmation(primary, base2, mkEv({ cats: { A: true, B: v.B <= 2 } }));
    };
    for (let v = ps.next(); v !== null; v = ps.next()) ps.record(v, evalV(v));
    const res = ps.result();
    assert(res.bestVector.A === 4 && res.bestVector.B === 2, 'D76.2d two queues, only B fails confirmation above 2 -> A keeps all 4 moves, B stops at 2', JSON.stringify(res.bestVector));
  }
  // Pooled non-monotone: primary passes at 8, 4, 2; confirmation rejects 8 and 4 -> falls back to 2 (not 0, not 4).
  {
    const ks = h.createRosterKSearch(8);
    for (let k = ks.next(); k !== null; k = ks.next()) ks.record(k, { passes: k <= 6, reasons: [], slaPct: 90 });
    const sr = ks.result();
    const order: number[] = h.pooledPolishFallbackOrder(sr);
    assert(sr.bestK === 6 && JSON.stringify(order) === JSON.stringify([6, 4]), 'D76.3a pooled fallback order: chosen k first, then the smaller already-evaluated primary-passing k (failed k=8, 7 never offered)', `bestK=${sr.bestK} order=${JSON.stringify(order)}`);
    const accepts = (okKs: number[]) => order.find((k) => okKs.includes(k)) ?? 0;
    assert(accepts([6, 4]) === 6 && accepts([4]) === 4 && accepts([]) === 0, 'D76.3b first order entry accepted by the rule wins: 6 if it satisfies it, else the largest evaluated k that does (4), else 0', '');
  }

  // Real fixtures with Shift Placement ON (found by a scan at the pre-change build; recorded before-values pinned below).
  const cal76: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 20 };
  const labor76: LaborConfig = { ...LABOR, dailyProductiveHours: 8, shiftPlacementEnabled: true, shiftSlapMinutes: 30 };
  const mkIv76 = (cats: Array<[string, (hh: number) => number]>): StandardInterval[] => {
    const out: StandardInterval[] = [];
    for (let day = 0; day < 5; day++) for (let hh = 8; hh < 20; hh++) for (let m = 0; m < 60; m += 30) for (const [category, vf] of cats) {
      out.push({ intervalIndex: out.length, start: new Date(2026, 2, 2 + day, hh, m), end: new Date(2026, 2, 2 + day, hh, m + 30), volume: vf(hh), category });
    }
    return out;
  };
  const mkSla76 = (pct: number, w: number): SLAPolicyConfig => ({
    primaryPct: pct, primaryWindow: w, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90, minCoverageEnabled: true,
  });
  const c1: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 }];
  const c2: CategoryConfig[] = [{ id: 'A', name: 'A', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 }, { id: 'B', name: 'B', ahtMinutes: 25, shrinkagePct: 0.1, priority: 2 }];
  const rs76 = (d: ShiftDistributionByCategory | undefined) => (d ? Object.keys(d).sort().map((k) => `${k === '__POOLED__' ? '' : k + '='}${d[k].slaps.map((s) => `${s.startMinutesFromOpen}:${s.agentCount}`).join(' ')}`).join(' | ') : 'uniform');
  const fixtures76: Array<{ label: string; intervals: StandardInterval[]; categories: CategoryConfig[]; sla: SLAPolicyConfig; arch: 'pooled' | 'siloed'; hc: number; gross: number; roster: string; status: string }> = [
    { label: 'pooled spike 4/20 SLA 85/3h', intervals: mkIv76([['General', (hh) => (hh === 8 ? 20 : 4)]]), categories: c1, sla: mkSla76(85, 3), arch: 'pooled', hc: 6, gross: 7, roster: '0:3 150:1 210:1 240:1', status: 'adopted_partial' },
    { label: 'siloed A spike 3/14 + B peak 2/7 SLA 95/4h', intervals: mkIv76([['A', (hh) => (hh === 8 ? 14 : 3)], ['B', (hh) => (hh >= 12 && hh < 16 ? 7 : 2)]]), categories: c2, sla: mkSla76(95, 4), arch: 'siloed', hc: 9, gross: 10, roster: 'A=0:1 60:1 240:2 | B=0:1 120:1 240:3', status: 'adopted' },
  ];
  for (const fx of fixtures76) {
    const run = { intervals: fx.intervals, openingWIP: [] as any[], categories: fx.categories, calendar: cal76, labor: labor76, sla: fx.sla, seed: 42, userMaxHC: 60, replications: 6, queueArchitecture: fx.arch };
    const t0 = Date.now();
    const r: any = searchOptimalHC(run);
    const ms = Date.now() - t0;
    const pc = r.polishConfirmation;
    console.log(`  (D76 fixture ${fx.label}: HC ${r.recommendedHC}/${r.staffing?.grossHCTotal}; ${r.rosterPolish?.status}; ${rs76(r.shiftPlacement?.winningDistribution)}; confirmation ${JSON.stringify(pc)}; ${ms}ms)`);
    assert(r.recommendedHC === fx.hc && r.staffing?.grossHCTotal === fx.gross, `D76.4a ${fx.label}: recommended / gross headcount identical to the pre-change build (${fx.hc} / ${fx.gross})`, `${r.recommendedHC}/${r.staffing?.grossHCTotal}`);
    assert(rs76(r.shiftPlacement?.winningDistribution) === fx.roster && r.rosterPolish?.status === fx.status, `D76.4b ${fx.label}: adopted roster and polish status identical to the pre-change build (a polish that passes confirmation is still adopted)`, `${rs76(r.shiftPlacement?.winningDistribution)} ${r.rosterPolish?.status}`);
    assert(!!pc && pc.baselinePasses === true && pc.adoptedPasses === true, `D76.4c ${fx.label}: polishConfirmation reports baseline and adopted pass`, JSON.stringify(pc));
    assert(!!pc && pc.evaluations === 2, `D76.4d ${fx.label}: exactly 2 extra full-R evaluations (baseline + the one primary-passing vector kept; each vector once, none for primary failures)`, JSON.stringify(pc));
    const sets = h.generatePrecomputedReplications({ intervals: fx.intervals, openingWIP: [], categories: fx.categories, calendar: cal76, sla: fx.sla, baseSeed: 42, replications: 6 });
    const ind: any = evaluateCandidateStatistical({
      operationalHC: r.recommendedHC, intervals: fx.intervals, openingWIP: [], categories: fx.categories, calendar: cal76, labor: labor76, sla: fx.sla,
      baseSeed: 42, replications: 6, queueArchitecture: fx.arch, precomputedCaseSets: sets, shiftDistribution: r.shiftPlacement?.winningDistribution, dispatchFairness: undefined,
    });
    assert(JSON.stringify(r.primaryStatistical) === JSON.stringify(ind.primaryStats), `D76.5 ${fx.label}: displayed statistics are the PRIMARY-set evaluation of the adopted roster (no confirmation leak)`, `reported mean=${r.primaryStatistical?.achievedPctMean} independent=${ind.primaryStats?.achievedPctMean}`);
    const rA: any = await searchOptimalHCAsync(run);
    assert(JSON.stringify(rA.polishConfirmation) === JSON.stringify(pc) && JSON.stringify(rA.rosterPolish) === JSON.stringify(r.rosterPolish) && rs76(rA.shiftPlacement?.winningDistribution) === rs76(r.shiftPlacement?.winningDistribution) && rA.recommendedHC === r.recommendedHC, `D76.6 ${fx.label}: sync === async (polishConfirmation, rosterPolish, roster, HC)`, `async=${JSON.stringify(rA.polishConfirmation)}`);
    const r2: any = searchOptimalHC(run);
    assert(JSON.stringify(r2.polishConfirmation) === JSON.stringify(pc) && JSON.stringify(r2.rosterPolish) === JSON.stringify(r.rosterPolish) && rs76(r2.shiftPlacement?.winningDistribution) === rs76(r.shiftPlacement?.winningDistribution), `D76.7 ${fx.label}: same seed twice identical`, '');
  }
  // Placement OFF: no confirmation, no field.
  {
    const fx = fixtures76[0];
    const off: any = searchOptimalHC({ intervals: fx.intervals, openingWIP: [], categories: fx.categories, calendar: cal76, labor: { ...labor76, shiftPlacementEnabled: false }, sla: fx.sla, seed: 42, userMaxHC: 60, replications: 6, queueArchitecture: fx.arch });
    assert(off.polishConfirmation === undefined, 'D76.8 placement OFF: polishConfirmation undefined', '');
  }
}

// ─── SUITE D77: P1-7-c polish cap check uses explicit booleans, not failingReasons text ───
{
  console.log('\n=== SUITE D77: polish cap flags (passesBoAsaCap / passesOccupancyCap / passesCoverage) ===');
  const h = hcNs as any;
  const mk = (o: { lo?: number; occ?: boolean; asa?: boolean; cov?: boolean; reasons?: string[] }): any => ({
    passesOrgGates: false, categoryPasses: { A: true }, failingReasons: o.reasons ?? [], primaryStats: { ci95Low: o.lo ?? 80 },
    ...(o.occ === undefined ? {} : { passesOccupancyCap: o.occ }), ...(o.asa === undefined ? {} : { passesBoAsaCap: o.asa }), ...(o.cov === undefined ? {} : { passesCoverage: o.cov }),
  });
  const rule = h.polishNotWorseOnConfirmation as (b: any, c: any) => boolean;
  const base = mk({ occ: true, asa: true, cov: true });
  assert(rule(base, mk({ lo: 85, occ: false, asa: true, cov: true })) === false, 'D77.1a baseline satisfies caps, candidate better SLA but occupancy cap false -> rejected', '');
  assert(rule(base, mk({ lo: 85, occ: true, asa: false, cov: true })) === false, 'D77.1b same for BO ASA cap -> rejected', '');
  assert(rule(base, mk({ lo: 85, occ: true, asa: true, cov: false })) === false, 'D77.1c same for coverage -> rejected', '');
  assert(rule(base, mk({ lo: 85, occ: true, asa: true, cov: true })) === true, 'D77.1d candidate keeps all caps -> adopted', '');
  assert(rule(mk({ occ: false, asa: true, cov: true }), mk({ lo: 85, occ: false, asa: true, cov: true })) === true, 'D77.1e cap broken by both stays neutral -> adopted', '');
  assert(rule(base, mk({ lo: 85, reasons: ['Occupancy 90% CI x'] })) === true, 'D77.1f candidate with undefined flags is not treated as breaking a cap (message text is ignored)', '');
  assert(rule(mk({}), mk({ lo: 85, occ: false })) === false, 'D77.1g baseline flag undefined (treated as satisfied) + candidate explicit false -> rejected', '');
  // Real evaluation: flags carried and consistent with failingReasons.
  const cats: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 }];
  const ivs: StandardInterval[] = [];
  for (let day = 0; day < 5; day++) for (let hr = 9; hr < 17; hr++) for (let m = 0; m < 60; m += 30) ivs.push({ intervalIndex: ivs.length, start: new Date(2026, 2, 2 + day, hr, m), end: new Date(2026, 2, 2 + day, hr, m + 30), volume: 12, category: 'General' });
  const sla: SLAPolicyConfig = {
    primaryPct: 80, primaryWindow: 4, primaryUnit: 'hours', boAsaEnabled: true, boAsaTarget: 1, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: true, occupancyCapPct: 30, confidenceLevelPct: 90, minCoverageEnabled: true, minAgentsPerInterval: 8,
  };
  let consistent = true; let sawOccFalse = false; let sawOccTrue = false; let sawAsaFalse = false; let present = true;
  for (const n of [2, 6, 12, 25, 60]) {
    const r: any = evaluateCandidateStatistical({ operationalHC: n, intervals: ivs, openingWIP: [], categories: cats, calendar: { ...BIZ_CAL }, labor: { ...LABOR }, sla, baseSeed: 42, replications: 4 });
    const fr: string[] = r.failingReasons;
    if (typeof r.passesBoAsaCap !== 'boolean' || typeof r.passesOccupancyCap !== 'boolean' || typeof r.passesCoverage !== 'boolean') present = false;
    if (r.passesBoAsaCap !== !fr.some((x) => x.startsWith('BO ASA')) || r.passesOccupancyCap !== !fr.some((x) => x.startsWith('Occupancy')) || r.passesCoverage !== !fr.some((x) => x.startsWith('Coverage:'))) consistent = false;
    if (r.passesOccupancyCap === false) sawOccFalse = true; else sawOccTrue = true;
    if (r.passesBoAsaCap === false) sawAsaFalse = true;
  }
  assert(present, 'D77.2a real evaluation results carry the three boolean cap flags', '');
  assert(consistent, 'D77.2b flags agree with failingReasons on every swept N', '');
  assert(sawOccFalse && sawOccTrue && sawAsaFalse, 'D77.2c setup: the sweep exercises failing and passing occupancy cap and a failing BO ASA cap (coverage never fails with a uniform roster; its flag is checked for consistency only)', `occF=${sawOccFalse} occT=${sawOccTrue} asaF=${sawAsaFalse}`);
}

// =================================================================
// Suite D78 - Item 1 (L28 / P1-9, HC-14): spread layout tried when the coverage-repair roster fails
//
// Minimum Coverage ON builds one "repair" roster (the minimum seats at every late cover start, the rest at
// opening). If that roster fails the gate, a second layout - the SAME agents spread evenly over the SAME starts
// (buildCoverageSpreadDistribution) - is tried before N is rejected, confirmed on the second replication block.
// One shared pure state machine (createCoverageSpreadSearch) drives both searches. When nothing passes, the
// reported failing result describes a coverage-satisfying roster (spread, else repair), never the uniform
// zero-coverage layout. Pre-change: D78.a (helper absent), D78.b (24x7 infeasible), D78.c (message "as few as 0
// agents"), D78.d (D33 21 vs 22), D78.g/h (machine absent) fail; D78.e and the unchanged-answer controls hold.
// =================================================================
console.log('\n--- Suite D78: spread layout when the coverage-repair roster fails (L28 / P1-9) ---');
{
  const spreadFn = (hcNs as any).buildCoverageSpreadDistribution as ((r: ShiftDistributionByCategory | null | undefined) => ShiftDistributionByCategory | null) | undefined;
  const machine = (hcNs as any).createCoverageSpreadSearch as ((p: any) => { next: () => any; record: (e: any) => void; result: () => any }) | undefined;
  assert(typeof spreadFn === 'function', 'D78.0 buildCoverageSpreadDistribution is exported', `typeof=${typeof spreadFn}`);
  assert(typeof machine === 'function', 'D78.0b createCoverageSpreadSearch is exported', `typeof=${typeof machine}`);

  const calD33: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 22 };
  const labD33: LaborConfig = { ...LABOR, dailyProductiveHours: 9 };
  const slaBase: SLAPolicyConfig = {
    primaryPct: 80, primaryWindow: 4, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90,
  };
  const sortedSlaps = (d: ShiftSlapDistribution) => [...d.slaps].sort((a, b) => a.startMinutesFromOpen - b.startMinutesFromOpen);
  const countsOf = (d: ShiftSlapDistribution) => sortedSlaps(d).map((s) => s.agentCount);
  const offsetsOf = (d: ShiftSlapDistribution) => sortedSlaps(d).map((s) => s.startMinutesFromOpen);
  const rosterStr78 = (d: ShiftDistributionByCategory | undefined) => (d ? Object.keys(d).sort().map((k) => `${k === '__POOLED__' ? '' : k + '='}${sortedSlaps(d[k]).map((s) => `${s.startMinutesFromOpen}:${s.agentCount}`).join(' ')}`).join(' | ') : 'uniform');

  // ---- D78.a helper unit tests ----
  const cal14: CalendarConfig = { ...CAL_24X7 };
  const lab14: LaborConfig = { ...DEFAULT_LABOR };
  const scenarios78: Array<{ name: string; cal: CalendarConfig; lab: LaborConfig; min: number }> = [
    { name: 'D33 14h window / 9h shift (2 starts)', cal: calD33, lab: labD33, min: 1 },
    { name: '24x7 / 7.5h shift (4 starts)', cal: cal14, lab: lab14, min: 1 },
    { name: '24x7 / 7.5h shift, 2 agents per interval', cal: cal14, lab: lab14, min: 2 },
  ];
  if (typeof spreadFn === 'function') {
    for (const sc of scenarios78) {
      const bad: string[] = [];
      let prev: ShiftDistributionByCategory | null = null; let prevN = -1; let repairMin = -1; let checked = 0;
      for (let n = 1; n <= 200; n++) {
        const rep = buildCoverageRepairDistribution({ n, calendar: sc.cal, labor: sc.lab, minAgentsPerInterval: sc.min, queueArchitecture: 'pooled' });
        if (!rep) { if (spreadFn(rep) !== null) bad.push(`n=${n} spread of a null repair roster is not null`); continue; }
        if (repairMin < 0) repairMin = n;
        const sp = spreadFn(rep);
        const eff = sp ?? rep;
        const rd = rep.__POOLED__, ed = eff.__POOLED__;
        const m = Math.min(...rd.slaps.filter((s) => s.startMinutesFromOpen > 0).map((s) => s.agentCount));
        const tot = (d: ShiftSlapDistribution) => d.slaps.reduce((a, s) => a + s.agentCount, 0);
        if (tot(ed) !== n || tot(rd) !== n) bad.push(`n=${n} total ${tot(ed)}/${tot(rd)}`);
        if (JSON.stringify(offsetsOf(ed)) !== JSON.stringify(offsetsOf(rd))) bad.push(`n=${n} starts changed`);
        const c = countsOf(ed); const k = c.length;
        if (c.some((x) => x < m)) bad.push(`n=${n} a start (offset 0 included) has fewer than the minimum ${m}: ${c.join(',')}`);
        const rest = n - m * k; const base = Math.floor(rest / k); const extra = rest % k;
        if (c.some((x, i) => x !== m + base + (i < extra ? 1 : 0))) bad.push(`n=${n} not even / ties not to earliest: ${c.join(',')}`);
        if (JSON.stringify(spreadFn(rep)) !== JSON.stringify(sp)) bad.push(`n=${n} not deterministic`);
        if (sp && JSON.stringify(countsOf(sp.__POOLED__)) === JSON.stringify(countsOf(rd))) bad.push(`n=${n} returned a spread equal to the repair roster instead of null`);
        if (!sp && JSON.stringify(c) !== JSON.stringify(countsOf(rd))) bad.push(`n=${n} null but rosters differ`);
        if (prev && prevN === n - 1) {
          const pc = countsOf(prev.__POOLED__);
          if (pc.length === c.length && pc.some((x, i) => c[i] < x)) bad.push(`n=${n} a start lost a seat vs n=${n - 1}: ${pc.join(',')} -> ${c.join(',')}`);
        }
        prev = eff; prevN = n; checked++;
      }
      assert(checked > 100 && bad.length === 0, `D78.a ${sc.name}: totals preserved, same starts, every start (offset 0 too) >= minimum, even split with ties to the earliest start, deterministic, house-monotone over N=${repairMin}..200`, bad.slice(0, 4).join('; '));
    }
    // exact pins
    const r21 = buildCoverageRepairDistribution({ n: 21, calendar: calD33, labor: labD33, minAgentsPerInterval: 1, queueArchitecture: 'pooled' });
    assert(rosterStr78(spreadFn(r21) ?? undefined) === '0:11 300:10', 'D78.a2 D33 N=21: repair 0:20 300:1 -> spread 0:11 300:10 (extra seat to the EARLIEST start)', `got ${rosterStr78(spreadFn(r21) ?? undefined)} from ${rosterStr78(r21 ?? undefined)}`);
    const r43 = buildCoverageRepairDistribution({ n: 43, calendar: calD33, labor: labD33, minAgentsPerInterval: 1, queueArchitecture: 'pooled' });
    assert(rosterStr78(spreadFn(r43) ?? undefined) === '0:22 300:21', 'D78.a3 N=43: spread 0:22 300:21', `got ${rosterStr78(spreadFn(r43) ?? undefined)}`);
    const r20x = buildCoverageRepairDistribution({ n: 20, calendar: cal14, labor: lab14, minAgentsPerInterval: 1, queueArchitecture: 'pooled' });
    assert(rosterStr78(spreadFn(r20x) ?? undefined) === '0:5 450:5 900:5 990:5', 'D78.a4 24x7 N=20: spread 0:5 450:5 900:5 990:5', `got ${rosterStr78(spreadFn(r20x) ?? undefined)} from ${rosterStr78(r20x ?? undefined)}`);
    const r23x = buildCoverageRepairDistribution({ n: 23, calendar: cal14, labor: lab14, minAgentsPerInterval: 1, queueArchitecture: 'pooled' });
    assert(rosterStr78(spreadFn(r23x) ?? undefined) === '0:6 450:6 900:6 990:5', 'D78.a4b 24x7 N=23: the 3 extra seats go to the 3 EARLIEST starts (0:6 450:6 900:6 990:5)', `got ${rosterStr78(spreadFn(r23x) ?? undefined)}`);
    // null cases
    assert(spreadFn(null) === null && spreadFn(undefined) === null, 'D78.a5 null / undefined repair roster -> null', '');
    assert(spreadFn({ __POOLED__: { slapMinutes: 30, slaps: [{ startMinutesFromOpen: 0, agentCount: 9 }] } }) === null, 'D78.a6 single-start roster -> null', '');
    const evenAlready: ShiftDistributionByCategory = { __POOLED__: { slapMinutes: 30, slaps: [{ startMinutesFromOpen: 0, agentCount: 2 }, { startMinutesFromOpen: 300, agentCount: 2 }] } };
    assert(spreadFn(evenAlready) === null, 'D78.a7 a roster that is already even -> null (equals the repair roster)', '');
    // siloed: per-category totals preserved, per-category minimum kept
    const wl = new Map<string, number>([['A', 6000], ['B', 3000], ['C', 1000]]);
    const badS: string[] = []; let sPrev: ShiftDistributionByCategory | null = null; let sPrevN = -1; let sChecked = 0; let sSpread = 0;
    for (let n = 1; n <= 200; n++) {
      const rep = buildCoverageRepairDistribution({ n, calendar: cal14, labor: lab14, minAgentsPerInterval: 1, queueArchitecture: 'siloed', categoryWorkloadMinutes: wl });
      if (!rep) continue;
      const sp = spreadFn(rep); const eff = sp ?? rep;
      if (sp) sSpread++;
      if (Object.keys(eff).sort().join() !== Object.keys(rep).sort().join()) badS.push(`n=${n} category keys changed`);
      for (const key of Object.keys(rep)) {
        const tr = rep[key].slaps.reduce((a, s) => a + s.agentCount, 0), te = eff[key].slaps.reduce((a, s) => a + s.agentCount, 0);
        if (tr !== te) badS.push(`n=${n} ${key} total ${te} != ${tr}`);
        if (countsOf(eff[key]).some((x) => x < 1)) badS.push(`n=${n} ${key} has an empty start`);
        const pc = sPrev && sPrevN === n - 1 ? sPrev[key] : undefined;
        if (pc && pc.slaps.length === eff[key].slaps.length && countsOf(pc).some((x, i) => countsOf(eff[key])[i] < x)) badS.push(`n=${n} ${key} lost a seat`);
      }
      sPrev = eff; sPrevN = n; sChecked++;
    }
    assert(sChecked > 100 && sSpread > 50 && badS.length === 0, 'D78.a8 siloed (3 categories): per-category totals preserved, same keys, no empty start, house-monotone per category', badS.slice(0, 4).join('; ') || `checked=${sChecked} spread=${sSpread}`);
  }
  const planOf = (hcNs as any).planCoverageRepair as (p: any) => any;
  {
    const cases78: any[] = [{ category: 'General', totalAhtMinutes: 30 }];
    const plan = planOf({ n: 20, sla: { ...DEFAULT_SLA }, calendar: cal14, labor: lab14, queueArchitecture: 'pooled', representativeCases: cases78 });
    assert(plan.spread !== undefined && plan.spread !== null && rosterStr78(plan.spread) === '0:5 450:5 900:5 990:5', 'D78.a9 planCoverageRepair returns the spread roster (one shared place for both searches)', `spread=${rosterStr78(plan.spread ?? undefined)}`);
    const planOff = planOf({ n: 20, sla: { ...DEFAULT_SLA, minCoverageEnabled: false }, calendar: cal14, labor: lab14, queueArchitecture: 'pooled', representativeCases: cases78 });
    assert(!planOff.attempt && !planOff.spread, 'D78.a10 coverage OFF: no repair attempt and no spread (spread exists only with a repair roster)', JSON.stringify({ attempt: planOff.attempt, spread: planOff.spread }));
  }

  // ---- fixtures ----
  const iv14: StandardInterval[] = [];
  for (let d = 0; d < 7; d++) for (let k = 0; k < 48; k++) {
    const s = new Date(2026, 9, 12 + d, 0, k * 30);
    iv14.push({ intervalIndex: iv14.length, start: s, end: new Date(s.getTime() + 1800000), volume: 6, category: 'General' });
  }
  const cat14: CategoryConfig[] = [{ id: 'g', name: 'General', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1 }];
  const p14 = (cov: boolean, extra: any = {}) => ({
    intervals: iv14, openingWIP: [] as OpeningWIPCase[], categories: cat14, calendar: cal14, labor: { ...DEFAULT_LABOR },
    sla: { ...DEFAULT_SLA, minCoverageEnabled: cov }, seed: 42, userMaxHC: 80, replications: 5, queueArchitecture: 'pooled' as const,
    dispatchFairness: DEFAULT_SIM_PARAMS.dispatchFairness, ...extra,
  });
  const on14 = searchOptimalHC(p14(true)); const off14 = searchOptimalHC(p14(false));
  const on14a: any = await searchOptimalHCAsync(p14(true));

  // ---- D78.b HC-14 ----
  assert(off14.recommendedHC !== null, 'D78.b0 setup: HC-14 coverage OFF finds an answer', `rec=${off14.recommendedHC}`);
  assert(on14.recommendedHC !== null && !on14.isInfeasible, 'D78.b1 HC-14 (24x7, 7 days, 6 cases / 30 min, AHT 30, SLA 80% / 6 h, R=5, max 80), coverage ON: a recommendation exists (was infeasible)', `rec=${on14.recommendedHC} reason=${on14.infeasibleReason}`);
  assert(on14.recommendedHC === 20 && off14.recommendedHC === 20, 'D78.b2 HC-14 coverage ON = coverage OFF = 20 (the even spread 0:5 450:5 900:5 990:5 passes the gate and the confirmation block)', `on=${on14.recommendedHC} off=${off14.recommendedHC}`);
  assert((on14.finalDESResult?.minCoverageObserved ?? 0) >= 1 && !!on14.finalDESResult?.passesCoverage, 'D78.b3 HC-14 ON: the audit run at the recommended N has minimum coverage >= 1', `minCov=${on14.finalDESResult?.minCoverageObserved}`);
  assert(on14a.recommendedHC === on14.recommendedHC && rosterStr78(on14a.finalDESResult?.shiftDistributionUsed) === rosterStr78(on14.finalDESResult?.shiftDistributionUsed) && on14a.bindingConstraintDescription === on14.bindingConstraintDescription && JSON.stringify(on14a.searchHistory) === JSON.stringify(on14.searchHistory), 'D78.b4 HC-14 ON: sync === async (HC, roster, label, full search history)', `sync=${on14.recommendedHC}/${rosterStr78(on14.finalDESResult?.shiftDistributionUsed)} async=${on14a.recommendedHC}/${rosterStr78(on14a.finalDESResult?.shiftDistributionUsed)}`);
  {
    const winSp = rosterStr78(on14.finalDESResult?.shiftDistributionUsed);
    assert(on14.recommendedHC !== null && winSp.split(' ').length >= 3, 'D78.b5 HC-14 ON: the reported roster is a multi-start layout (spread or repair), not uniform', winSp);
  }

  // ---- D78.c failure messages ----
  {
    const capped = searchOptimalHC(p14(true, { userMaxHC: 19 }));
    const cappedA: any = await searchOptimalHCAsync(p14(true, { userMaxHC: 19 }));
    assert(capped.isInfeasible && cappedA.isInfeasible, 'D78.c0 setup: HC-14 with a cap of 19 is infeasible (sync and async)', `sync=${capped.recommendedHC} async=${cappedA.recommendedHC}`);
    const txt = (r: any) => `${r.infeasibleReason ?? ''} || ${(r.searchHistory ?? []).map((h: any) => (h.failingReasons ?? []).join('; ')).join(' || ')}`;
    assert(!/as few as 0 agent/.test(txt(capped)) && !/as few as 0 agent/.test(txt(cappedA)), 'D78.c1 infeasible search: no reported reason says "as few as 0 agents" when a repair roster existed (reasons describe the coverage-satisfying roster)', txt(capped).slice(0, 300));
    assert(/Increase userMaxHC/.test(capped.infeasibleReason ?? ''), 'D78.c2 the exhausted-search message wording is unchanged (still ends "Increase userMaxHC or review SLA/labor parameters.")', capped.infeasibleReason);
    assert(capped.infeasibleReason === cappedA.infeasibleReason, 'D78.c3 sync === async failure message', `${capped.infeasibleReason} | ${cappedA.infeasibleReason}`);
    const overCap = searchOptimalHC(p14(true, { userMaxHC: 5 }));
    assert(/strictly exceeds/.test(overCap.infeasibleReason ?? '') && /Increase userMaxHC or adjust volume \/ AHT assumptions\./.test(overCap.infeasibleReason ?? ''), 'D78.c4 baseline-over-cap message wording unchanged', overCap.infeasibleReason);
  }

  // ---- D78.d D33 fixture and support + answer-time 60: sync === async ----
  const catD33: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 }];
  const ivD33: StandardInterval[] = [];
  for (let day = 0; day < 5; day++) for (let h = 8; h < 22; h++) for (let m = 0; m < 60; m += 30) ivD33.push({ intervalIndex: ivD33.length, start: new Date(2026, 2, 2 + day, h, m), end: new Date(2026, 2, 2 + day, h, m + 30), volume: 20, category: 'General' });
  const pD33 = (cov: boolean) => ({ intervals: ivD33, openingWIP: [] as OpeningWIPCase[], categories: catD33, calendar: calD33, labor: labD33, sla: { ...slaBase, minCoverageEnabled: cov }, seed: 42, userMaxHC: 60, replications: 5 });
  const d33On = searchOptimalHC(pD33(true)); const d33OnA: any = await searchOptimalHCAsync(pD33(true));
  const d33Off = searchOptimalHC(pD33(false));
  const sig = (r: any) => `${r.recommendedHC}|${rosterStr78(r.finalDESResult?.shiftDistributionUsed)}|${r.bindingConstraintType}|${r.bindingConstraintDescription}|${JSON.stringify(r.searchHistory)}`;
  assert(sig(d33On) === sig(d33OnA), 'D78.d1 D33 fixture, coverage ON: sync === async (HC, roster, label, history)', `sync=${sig(d33On).slice(0, 80)} async=${sig(d33OnA).slice(0, 80)}`);
  assert(d33On.recommendedHC === 21 && d33Off.recommendedHC === 28, 'D78.d2 D33 fixture: coverage ON 21 (was 22), coverage OFF 28 unchanged', `on=${d33On.recommendedHC} off=${d33Off.recommendedHC}`);
  assert((d33On.finalDESResult?.minCoverageObserved ?? 0) >= 1, 'D78.d3 D33 ON: audit run keeps minimum coverage >= 1', `minCov=${d33On.finalDESResult?.minCoverageObserved}`);
  {
    const { rows } = buildSampleDataset('support', new Date(2026, 9, 5, 8, 0, 0, 0));
    const ivs = mapRawRecordsToIntervals(rows, { intervalStartCol: 'IntervalStart', volumeCol: 'Volume', categoryCol: 'Category' } as any);
    const cats = discoverAndSyncCategories(ivs, DEFAULT_CATEGORIES, DEFAULT_SLA);
    const pS = (cov: boolean) => ({ intervals: ivs, openingWIP: [] as OpeningWIPCase[], categories: cats, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: { ...DEFAULT_SLA, minCoverageEnabled: cov, boAsaEnabled: true, boAsaTarget: 60, boAsaUnit: 'minutes' as const }, seed: DEFAULT_SIM_PARAMS.seed, userMaxHC: DEFAULT_SIM_PARAMS.maxHCSearch, replications: DEFAULT_SIM_PARAMS.replications, queueArchitecture: 'pooled' as const, dispatchFairness: DEFAULT_SIM_PARAMS.dispatchFairness });
    const sOn = searchOptimalHC(pS(true)); const sOnA: any = await searchOptimalHCAsync(pS(true));
    assert(sig(sOn) === sig(sOnA), 'D78.d4 support + answer-time 60 min, coverage ON: sync === async (HC, roster, label, history)', `sync=${sOn.recommendedHC} async=${sOnA.recommendedHC}`);
    assert(sOn.recommendedHC !== null && sOn.recommendedHC === 62, 'D78.d5 support + answer-time 60 min, coverage ON: 62 (was 43 while the pooled mean hid Technical_Escalations; Item 3 judges every category on its own, owner decision 2026-10-15)', `rec=${sOn.recommendedHC}`);
  }

  // ---- D78.e three built-in samples at defaults are unchanged ----
  for (const [type, hc, gross] of [['claims', 31, 40], ['support', 28, 35], ['healthcare', 31, 39]] as Array<['claims' | 'support' | 'healthcare', number, number]>) {
    const { rows } = buildSampleDataset(type, new Date(2026, 9, 5, 8, 0, 0, 0));
    const ivs = mapRawRecordsToIntervals(rows, { intervalStartCol: 'IntervalStart', volumeCol: 'Volume', categoryCol: 'Category' } as any);
    const cats = discoverAndSyncCategories(ivs, DEFAULT_CATEGORIES, DEFAULT_SLA);
    const r = searchOptimalHC({ intervals: ivs, openingWIP: [], categories: cats, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: DEFAULT_SLA, seed: DEFAULT_SIM_PARAMS.seed, userMaxHC: DEFAULT_SIM_PARAMS.maxHCSearch, replications: DEFAULT_SIM_PARAMS.replications, queueArchitecture: 'pooled', dispatchFairness: DEFAULT_SIM_PARAMS.dispatchFairness });
    assert(r.recommendedHC === hc && r.staffing.grossHCTotal === gross, `D78.e sample ${type} (defaults, coverage ON): HC ${hc} / gross ${gross} unchanged`, `got ${r.recommendedHC}/${r.staffing.grossHCTotal}`);
  }

  // ---- D78.f monotonicity sweep on HC-14: the recommended N and N+1..N+3 all pass the gate with repair-or-spread ----
  if (on14.recommendedHC !== null) {
    const sets = hcNs.generatePrecomputedReplications({ intervals: iv14, openingWIP: [], categories: cat14, calendar: cal14, sla: { ...DEFAULT_SLA }, baseSeed: 42, replications: 5 });
    const reps = sets[0].cases as CaseEntity[];
    const rows: string[] = []; let allPass = true;
    for (let n = on14.recommendedHC; n <= on14.recommendedHC + 3; n++) {
      const plan = planOf({ n, sla: { ...DEFAULT_SLA }, calendar: cal14, labor: { ...DEFAULT_LABOR }, queueArchitecture: 'pooled', representativeCases: reps });
      let pass = false;
      for (const roster of [plan.dist, plan.spread]) {
        if (!roster || pass) continue;
        pass = evaluateCandidateStatistical({ operationalHC: n, intervals: iv14, openingWIP: [], categories: cat14, calendar: cal14, labor: { ...DEFAULT_LABOR }, sla: { ...DEFAULT_SLA }, baseSeed: 42, replications: 5, queueArchitecture: 'pooled', precomputedCaseSets: sets, shiftDistribution: roster, dispatchFairness: DEFAULT_SIM_PARAMS.dispatchFairness }).passesAllConstraints;
      }
      rows.push(`${n}${pass ? 'P' : 'F'}`); if (!pass) allPass = false;
    }
    assert(allPass, 'D78.f HC-14 monotonicity: the recommended N and N+1..N+3 all pass with repair-or-spread', rows.join(' '));
  } else assert(false, 'D78.f HC-14 monotonicity sweep', 'no recommendation');

  // ---- D78.g the shared state machine (spread acceptance + reported failing roster, A4 / A5 / A10) ----
  if (typeof machine === 'function') {
    const rep: ShiftDistributionByCategory = { __POOLED__: { slapMinutes: 30, slaps: [{ startMinutesFromOpen: 0, agentCount: 9 }, { startMinutesFromOpen: 300, agentCount: 1 }] } };
    const spr: ShiftDistributionByCategory = { __POOLED__: { slapMinutes: 30, slaps: [{ startMinutesFromOpen: 0, agentCount: 5 }, { startMinutesFromOpen: 300, agentCount: 5 }] } };
    const ev = (pass: boolean, reasons: string[], tag: string): any => ({ passesAllConstraints: pass, failingReasons: reasons, tag });
    const repairEv = ev(false, ['Coverage: minimum coverage was as few as 0 agents'], 'repair');
    const mk = (confirmEnabled: boolean) => machine({ repairRoster: rep, spreadRoster: spr, repairResult: repairEv, confirmEnabled });
    {
      const m = mk(true); const s1 = m.next();
      assert(s1 && s1.stage === 'primary' && s1.roster === spr, 'D78.g1 first step evaluates the spread roster on the primary block', JSON.stringify(s1));
      m.record(ev(true, [], 'sp-primary')); const s2 = m.next();
      assert(s2 && s2.stage === 'confirm', 'D78.g2 a primary pass is not adopted yet: the confirmation block runs next (A5)', JSON.stringify(s2));
      m.record(ev(true, [], 'sp-confirm'));
      const r = m.result();
      assert(m.next() === null && r.adopted && r.adopted.tag === 'sp-primary', 'D78.g3 confirmed pass -> adopted, carrying the PRIMARY-block evaluation', JSON.stringify(r));
    }
    {
      const m = mk(true); m.next(); m.record(ev(false, ['Primary SLA: 70% < 80%'], 'sp-primary'));
      const r = m.result();
      assert(m.next() === null && r.adopted === null && r.reportedResult.tag === 'sp-primary' && r.reportedRoster === spr && r.reportedReasons[0].startsWith('Primary SLA'), 'D78.g4 primary fail -> not adopted; the reported failing result and roster are the SPREAD ones (A4)', JSON.stringify(r));
    }
    {
      const m = mk(true); m.next(); m.record(ev(true, [], 'sp-primary')); m.next(); m.record(ev(false, ['Primary SLA: CI low 78% < 80%'], 'sp-confirm'));
      const r = m.result();
      assert(r.adopted === null && r.reportedResult.passesAllConstraints === false && r.reportedRoster === rep && r.reportedReasons[0].startsWith('Primary SLA'), 'D78.g5 confirmation fail -> not adopted (a lucky pass stops); reported = the failing repair result, reasons = the confirmation failure', JSON.stringify(r));
    }
    {
      const m = mk(false); m.next(); m.record(ev(true, [], 'sp-probe'));
      const r = m.result();
      assert(m.next() === null && r.adopted && r.adopted.tag === 'sp-probe', 'D78.g6 probe evaluations (no confirmation block) adopt on a primary pass', JSON.stringify(r));
    }
    // A10: mixed case - repair fails only on coverage, spread fails on SLA -> never labelled Minimum Coverage Floor
    {
      const m = mk(true); m.next(); m.record(ev(false, ['Primary SLA: 70% < 80%'], 'sp-primary'));
      const r = m.result();
      const below = { passesAllConstraints: false, failingReasons: ['Primary SLA: 70% < 80%'] };
      const slaCfg: SLAPolicyConfig = { ...DEFAULT_SLA };
      const label = hcNs.resolveCoverageBinding(below, r.reportedReasons, slaCfg, 21);
      assert(label === null, 'D78.h1 mixed case (repair fails only on coverage, spread fails on SLA at N-1): the binding label is NOT "Minimum Coverage Floor"', JSON.stringify(label));
      const control = hcNs.resolveCoverageBinding({ passesAllConstraints: false, failingReasons: ['Coverage: x'] }, ['Coverage: x'], slaCfg, 21);
      assert(control !== null && control.type === 'min_coverage', 'D78.h2 control: coverage-only failure with no spread outcome still labels "Minimum Coverage Floor"', JSON.stringify(control));
    }
  } else {
    assert(false, 'D78.g / D78.h shared state machine and A10 label test', 'createCoverageSpreadSearch is not exported');
  }
  // ---- D78.i label never says "Minimum Coverage Floor" when spread passed one agent lower (searches) ----
  assert(!/Minimum Coverage Floor/.test(on14.bindingConstraintDescription) && !/Minimum Coverage Floor/.test(d33On.bindingConstraintDescription), 'D78.i HC-14 and D33 (ON): the binding label is not "Minimum Coverage Floor" when the spread layout passes one agent lower', `${on14.bindingConstraintDescription} | ${d33On.bindingConstraintDescription}`);
  // ---- D78.j A1: coverage OFF may exceed ON only when the ON answer uses a spread roster ----
  {
    const usedSpread = rosterStr78(d33On.finalDESResult?.shiftDistributionUsed);
    const usedCounts = usedSpread.split(' ').map((x) => Number(x.split(':')[1]));
    const isEven = usedCounts.length >= 2 && Math.max(...usedCounts) - Math.min(...usedCounts) <= 1;
    assert((d33Off.recommendedHC ?? Infinity) <= (d33On.recommendedHC ?? Infinity) || isEven,'D78.j D33: OFF > ON is explained by the ON answer using the spread (multi-start) roster', `on=${d33On.recommendedHC} (${usedSpread}) off=${d33Off.recommendedHC}`);
  }
}

// ---------------------------------------------------------------------------
// Suite D79 - Item 1 rework round 1 (A12.1-A12.3): show the start times the headcount needs
// ---------------------------------------------------------------------------
// Results must show the roster the recommended headcount passed with (R1) and explain that coverage OFF can be
// higher (R2). Pure text helper in results-display.ts; the roster comes from finalDESResult.shiftDistributionUsed.
// Fail-first: before the change the helper is absent (D79.0-D79.g, D79.i fail).
console.log('\n--- Suite D79: start-time block and roster-source end-to-end (A12) ---');
{
  const rdNs: any = await import('../src/utils/results-display');
  const fn = rdNs.startTimeSplitLines as ((d: ShiftDistributionByCategory | undefined, c: CalendarConfig) => Array<{ category: string | null; text: string }> | null) | undefined;
  const noteFn = rdNs.startTimeSplitNotes as ((d: ShiftDistributionByCategory | undefined, c: CalendarConfig, layout?: string | null, seats?: Record<string, number> | null) => { heading: string; reason: string; spreadNote: string | null } | null) | undefined;
  assert(typeof fn === 'function' && typeof noteFn === 'function', 'D79.0 startTimeSplitLines / startTimeSplitNotes are exported from results-display.ts', `typeof=${typeof fn}/${typeof noteFn}`);
  const mkD = (pairs: Array<[number, number]>): ShiftSlapDistribution => ({ slapMinutes: 30, slaps: pairs.map(([o, c]) => ({ startMinutesFromOpen: o, agentCount: c })) as any });
  const calDay: CalendarConfig = { ...DEFAULT_CALENDAR, is24x7: false, dailyOpenHour: 8, dailyOpenMinute: 0, dailyCloseHour: 22, dailyCloseMinute: 0 };
  const cal247: CalendarConfig = { ...DEFAULT_CALENDAR, is24x7: true, dailyOpenHour: 8, dailyOpenMinute: 30 };
  if (typeof fn === 'function' && typeof noteFn === 'function') {
    const pooled = fn({ __POOLED__: mkD([[0, 11], [300, 10]]) }, calDay);
    assert(JSON.stringify(pooled) === JSON.stringify([{ category: null, text: '11 agents at 08:00, 10 agents at 13:00' }]), 'D79.a pooled: "11 agents at 08:00, 10 agents at 13:00"', JSON.stringify(pooled));
    const silo = fn({ Billing: mkD([[0, 1], [60, 4]]), Claims: mkD([[0, 3], [330, 2]]) }, calDay);
    assert(JSON.stringify(silo) === JSON.stringify([{ category: 'Billing', text: '1 agent at 08:00, 4 agents at 09:00' }, { category: 'Claims', text: '3 agents at 08:00, 2 agents at 13:30' }]), 'D79.b siloed: one line per category, sorted by name, singular "1 agent"', JSON.stringify(silo));
    const wrap = fn({ __POOLED__: mkD([[0, 5], [450, 5], [900, 5], [990, 5]]) }, cal247);
    assert(wrap?.[0]?.text === '5 agents at 00:00, 5 agents at 07:30, 5 agents at 15:00, 5 agents at 16:30', 'D79.c 24x7 (open treated as 00:00): 0/450/900/990 -> 00:00, 07:30, 15:00, 16:30', JSON.stringify(wrap));
    const wrap2 = fn({ __POOLED__: mkD([[0, 2], [990, 3]]) }, { ...calDay, dailyOpenHour: 20, dailyOpenMinute: 15 });
    assert(wrap2?.[0]?.text === '2 agents at 20:15, 3 agents at 12:45', 'D79.c2 day calendar opening 20:15: offset 990 wraps past midnight to 12:45', JSON.stringify(wrap2));
    assert(fn({ __POOLED__: mkD([[0, 21]]) }, calDay) === null && fn({ A: mkD([[0, 4]]), B: mkD([[0, 2], [60, 0]]) }, calDay) === null, 'D79.d everyone at opening (zero-count later starts ignored) -> block hidden (null)', '');
    assert(fn(undefined, calDay) === null && fn({}, calDay) === null, 'D79.e no distribution -> hidden (null)', '');
    const dPool = { __POOLED__: mkD([[0, 11], [300, 10]]) };
    const nSpread = noteFn(dPool, calDay, 'spread');
    assert(!!nSpread && nSpread.heading === 'Start times this headcount needs' && nSpread.reason === 'Rostering everyone at opening would not meet the targets with this headcount.' && typeof nSpread.spreadNote === 'string' && /evenly/.test(nSpread.spreadNote), 'D79.f spread layout: heading "needs", reason, and the spread note', JSON.stringify(nSpread));
    // A13.2 / A13.3: reason line only for layouts reached after the all-at-opening roster failed; spread note only for 'spread'.
    for (const lay of ['repair', 'placement', 'ladder'] as const) {
      const nn = noteFn(dPool, calDay, lay);
      assert(nn?.heading === 'Start times this headcount needs' && nn.reason === 'Rostering everyone at opening would not meet the targets with this headcount.' && nn.spreadNote === null, `D79.g ${lay}: heading "needs" + reason, NO spread note even for an even 11/10 split`, JSON.stringify(nn));
    }
    for (const lay of ['polish', undefined, 'uniform'] as const) {
      const nn = noteFn(dPool, calDay, lay);
      assert(nn?.heading === 'Start times used for this headcount' && nn.reason === 'These are the start times this headcount was tested with.' && nn.spreadNote === null, `D79.g2 ${String(lay)}: neutral heading and reason, no spread note`, JSON.stringify(nn));
    }
    // A13.4 siloed: a category with agents but no roster entry is listed at opening; lines sum to the headcount.
    {
      const seatsIn = { Billing: 5, Claims: 3 };
      const sl = (fn as any)({ Billing: mkD([[0, 1], [60, 4]]) }, calDay, seatsIn) as Array<{ category: string | null; text: string }> | null;
      const sumTxt = (ls: Array<{ text: string }> | null) => (ls ?? []).reduce((a, l) => a + l.text.split(', ').reduce((b, part) => b + Number(part.split(' ')[0]), 0), 0);
      assert(JSON.stringify(sl) === JSON.stringify([{ category: 'Billing', text: '1 agent at 08:00, 4 agents at 09:00' }, { category: 'Claims', text: '3 agents at 08:00' }]) && sumTxt(sl) === 8, 'D79.g3 siloed: Claims has 3 agents but no roster entry -> listed "Claims: 3 agents at 08:00"; lines sum to 8', JSON.stringify(sl));
      const sl2 = (fn as any)({ Billing: mkD([[0, 5]]) }, calDay, seatsIn);
      assert(sl2 === null, 'D79.g4 siloed: nobody starts later -> block still hidden', JSON.stringify(sl2));
    }
  }

  // ---- HC-14 end-to-end (24x7, 7 days, 6 cases / 30 min, AHT 30, SLA 80% / 6 h) ----
  const calH: CalendarConfig = { ...CAL_24X7 };
  const ivH: StandardInterval[] = [];
  for (let d = 0; d < 7; d++) for (let k = 0; k < 48; k++) {
    const s = new Date(2026, 9, 12 + d, 0, k * 30);
    ivH.push({ intervalIndex: ivH.length, start: s, end: new Date(s.getTime() + 1800000), volume: 6, category: 'General' });
  }
  const catH: CategoryConfig[] = [{ id: 'g', name: 'General', ahtMinutes: 30, shrinkagePct: 0.2, priority: 1 }];
  const pH = (extra: any = {}) => ({
    intervals: ivH, openingWIP: [] as OpeningWIPCase[], categories: catH, calendar: calH, labor: { ...DEFAULT_LABOR },
    sla: { ...DEFAULT_SLA, minCoverageEnabled: true }, seed: 42, userMaxHC: 80, replications: 5, queueArchitecture: 'pooled' as const,
    dispatchFairness: DEFAULT_SIM_PARAMS.dispatchFairness, ...extra,
  });
  const outH = searchOptimalHC(pH());
  const outHa: any = await searchOptimalHCAsync(pH());
  const rosterOf = (d: ShiftDistributionByCategory | undefined) => d ? Object.keys(d).sort().map((k) => [...d[k].slaps].sort((a, b) => a.startMinutesFromOpen - b.startMinutesFromOpen).map((s) => `${s.startMinutesFromOpen}:${s.agentCount}`).join(' ')).join(' | ') : 'uniform';
  assert(outH.recommendedHC === 20 && rosterOf(outH.finalDESResult?.shiftDistributionUsed) === '0:5 450:5 900:5 990:5', 'D79.h HC-14 (Shift Placement off, coverage on): the result exposes roster 0:5 450:5 900:5 990:5 at HC 20', `hc=${outH.recommendedHC} roster=${rosterOf(outH.finalDESResult?.shiftDistributionUsed)}`);
  assert(outHa.recommendedHC === 20 && rosterOf(outHa.finalDESResult?.shiftDistributionUsed) === '0:5 450:5 900:5 990:5', 'D79.h2 async twin exposes the same roster', `hc=${outHa.recommendedHC} roster=${rosterOf(outHa.finalDESResult?.shiftDistributionUsed)}`);
  if (typeof fn === 'function') {
    const lines = fn(outH.finalDESResult?.shiftDistributionUsed, calH);
    assert(!!lines && lines.length === 1 && lines[0].text === '5 agents at 00:00, 5 agents at 07:30, 5 agents at 15:00, 5 agents at 16:30', 'D79.i HC-14: the helper prints 4 start times from the real result', JSON.stringify(lines));
  } else assert(false, 'D79.i HC-14 helper text', 'startTimeSplitLines is missing');

  // ---- A4: the final audit run and the N-1 evidence run use the roster the search judged them with ----
  {
    const fdr = outH.finalDESResult;
    const failed = outH.boundaryEvidence?.failedResult;
    const nH = outH.recommendedHC ?? 0;
    const sumOf = (d: ShiftDistributionByCategory | undefined) => d ? Object.values(d).reduce((a, x) => a + x.slaps.reduce((b, s) => b + s.agentCount, 0), 0) : 0;
    assert(!!fdr && sumOf(fdr.shiftDistributionUsed) === nH && fdr.operationalHC === nH && rosterOf(fdr.shiftDistributionUsed) === '0:5 450:5 900:5 990:5', 'D79.j A4 HC-14 final audit run at N=20 ran on the winning roster', `sum=${sumOf(fdr?.shiftDistributionUsed)} n=${nH}`);
  }
  // The N-1 evidence run needs a case where the search actually judged N-1: support sample + answer-time 60 min, coverage ON
  // (recommended 62 since Item 3, was 43; 61 is tried with the 31+30 spread and fails on Technical_Escalations' own answer time). HC-14 and D33 start at their floor, so N-1 is never tried there.
  {
    const { rows } = buildSampleDataset('support', new Date(2026, 9, 5, 8, 0, 0, 0));
    const ivS = mapRawRecordsToIntervals(rows, { intervalStartCol: 'IntervalStart', volumeCol: 'Volume', categoryCol: 'Category' } as any);
    const catS = discoverAndSyncCategories(ivS, DEFAULT_CATEGORIES, DEFAULT_SLA);
    const pS = { intervals: ivS, openingWIP: [] as OpeningWIPCase[], categories: catS, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: { ...DEFAULT_SLA, minCoverageEnabled: true, boAsaEnabled: true, boAsaTarget: 60, boAsaUnit: 'minutes' as const }, seed: DEFAULT_SIM_PARAMS.seed, userMaxHC: DEFAULT_SIM_PARAMS.maxHCSearch, replications: DEFAULT_SIM_PARAMS.replications, queueArchitecture: 'pooled' as const, dispatchFairness: DEFAULT_SIM_PARAMS.dispatchFairness };
    const sOn = searchOptimalHC(pS);
    const sOnA: any = await searchOptimalHCAsync(pS);
    const sumS = (d: ShiftDistributionByCategory | undefined) => d ? Object.values(d).reduce((a, x) => a + x.slaps.reduce((b, s) => b + s.agentCount, 0), 0) : 0;
    const nS = sOn.recommendedHC ?? 0;
    const fS = sOn.boundaryEvidence?.failedResult;
    assert(nS === 62 && sOn.finalDESResult?.operationalHC === 62 && rosterOf(sOn.finalDESResult?.shiftDistributionUsed) === '0:61 150:1', 'D79.k1 support + answer-time 60, coverage ON: final audit run at N=62 ran on the winning roster 0:61 150:1 (re-pinned from 43 / 0:22 150:21: Item 3 judges every category on its own)', `n=${nS} roster=${rosterOf(sOn.finalDESResult?.shiftDistributionUsed)}`);
    assert(!!fS && fS.operationalHC === 61 && sumS(fS.shiftDistributionUsed) === 61 && rosterOf(fS.shiftDistributionUsed) === '0:31 150:30', 'D79.k2 same run: the N-1 evidence run (N=61) ran on the roster the search tried and rejected (0:31 150:30; was N=42, 0:21 150:21), not the uniform fallback', `n=${fS?.operationalHC} roster=${rosterOf(fS?.shiftDistributionUsed)}`);
    assert(rosterOf(sOnA.boundaryEvidence?.failedResult?.shiftDistributionUsed) === rosterOf(fS?.shiftDistributionUsed) && rosterOf(sOnA.finalDESResult?.shiftDistributionUsed) === rosterOf(sOn.finalDESResult?.shiftDistributionUsed), 'D79.l2 same run, async twin: audit and N-1 rosters identical to sync', `sync=${rosterOf(fS?.shiftDistributionUsed)} async=${rosterOf(sOnA.boundaryEvidence?.failedResult?.shiftDistributionUsed)}`);
    if (typeof fn === 'function') {
      const ls = fn(sOn.finalDESResult?.shiftDistributionUsed, DEFAULT_CALENDAR);
      assert(ls?.[0]?.text === '61 agents at 08:00, 1 agent at 10:30', 'D79.m support + answer-time 60: helper prints "61 agents at 08:00, 1 agent at 10:30" (sums to the recommended 62; was 22 + 21 = 43)', JSON.stringify(ls));
    }
  }

  // ---- A13.1: winningLayout is recorded by ONE shared classifier; sync == async on every fixture ----
  {
    const cls = (hcNs as any).classifyWinningLayout as ((w: any, t: any) => string) | undefined;
    assert(typeof cls === 'function', 'D79.n0 classifyWinningLayout is exported from hc-search.ts (the one shared classifier)', `typeof=${typeof cls}`);
    if (typeof cls === 'function') {
      const mk1 = (): any => ({ __POOLED__: { slapMinutes: 30, slaps: [{ startMinutesFromOpen: 0, agentCount: 1 }] } });
      const rA = mk1(), rB = mk1(), rC = mk1(), rD = mk1();
      assert(cls(undefined, {}) === 'uniform' && cls(rA, { repair: rA, spread: rB }) === 'repair' && cls(rB, { repair: rA, spread: rB }) === 'spread' && cls(rC, { repair: rA, spread: rB, placement: rC }) === 'placement' && cls(rD, { repair: rA, spread: rB, placement: rC, ladderWon: true }) === 'ladder', 'D79.n1 classifier: no roster -> uniform; identity -> repair / spread / placement; ladder winner -> ladder', '');
    }
    const lay = (r: any) => (r.winningLayout ?? 'none') as string;
    const same = (a: any, b: any) => lay(a) === lay(b) && a.recommendedHC === b.recommendedHC;
    // HC-14 (24x7 pooled, coverage ON): the even spread wins.
    assert(lay(outH) === 'spread' && same(outH, outHa), 'D79.n2 HC-14: winningLayout "spread", sync == async', `sync=${lay(outH)} async=${lay(outHa)}`);
    // D33 file (08:00-22:00, 9 h shift, flat 20, SLA 80% / 4 h, 5 reps): the even spread passes at 21.
    const calD: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 22 };
    const ivD: StandardInterval[] = [];
    for (let day = 0; day < 5; day++) for (let h = 8; h < 22; h++) for (let m = 0; m < 60; m += 30) ivD.push({ intervalIndex: ivD.length, start: new Date(2026, 2, 2 + day, h, m), end: new Date(2026, 2, 2 + day, h, m + 30), volume: 20, category: 'General' });
    const slaD: SLAPolicyConfig = { primaryPct: 80, primaryWindow: 4, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes', asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open', occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90, minCoverageEnabled: true };
    const pD = { intervals: ivD, openingWIP: [] as OpeningWIPCase[], categories: [{ id: 'c1', name: 'General', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 }] as CategoryConfig[], calendar: calD, labor: { ...LABOR, dailyProductiveHours: 9 }, sla: slaD, seed: 42, userMaxHC: 60, replications: 5, queueArchitecture: 'pooled' as const };
    const d33s = searchOptimalHC(pD); const d33a: any = await searchOptimalHCAsync(pD);
    assert(lay(d33s) === 'spread' && same(d33s, d33a), 'D79.n3 D33: winningLayout "spread", sync == async', `sync=${lay(d33s)}/${d33s.recommendedHC} async=${lay(d33a)}/${d33a.recommendedHC}`);
    // Uniform pass: the support sample at the app defaults - everyone at opening passes.
    {
      const { rows } = buildSampleDataset('support', new Date(2026, 9, 5, 8, 0, 0, 0));
      const ivS = mapRawRecordsToIntervals(rows, { intervalStartCol: 'IntervalStart', volumeCol: 'Volume', categoryCol: 'Category' } as any);
      const catS = discoverAndSyncCategories(ivS, DEFAULT_CATEGORIES, DEFAULT_SLA);
      const pU = { intervals: ivS, openingWIP: [] as OpeningWIPCase[], categories: catS, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: { ...DEFAULT_SLA, minCoverageEnabled: false }, seed: DEFAULT_SIM_PARAMS.seed, userMaxHC: DEFAULT_SIM_PARAMS.maxHCSearch, replications: DEFAULT_SIM_PARAMS.replications, queueArchitecture: 'pooled' as const, dispatchFairness: DEFAULT_SIM_PARAMS.dispatchFairness };
      const us = searchOptimalHC(pU); const ua: any = await searchOptimalHCAsync(pU);
      console.log(`  (D79 winningLayout support sample, coverage OFF: sync=${lay(us)} async=${lay(ua)} HC=${us.recommendedHC}/${ua.recommendedHC})`);
      assert(lay(us) === 'uniform' && same(us, ua), 'D79.n4 support sample, coverage OFF: the all-at-opening roster passes -> winningLayout "uniform", sync == async', `sync=${lay(us)}/${us.recommendedHC} async=${lay(ua)}/${ua.recommendedHC}`);
      if (typeof fn === 'function') assert(fn(us.finalDESResult?.shiftDistributionUsed, DEFAULT_CALENDAR) === null, 'D79.n5 uniform pass: start-time block hidden', '');
      // Same sample, coverage ON (app default): the coverage-repair roster is tried first and wins -> "repair".
      const pR = { ...pU, sla: DEFAULT_SLA };
      const rr = searchOptimalHC(pR); const rra: any = await searchOptimalHCAsync(pR);
      console.log(`  (D79 winningLayout support sample, coverage ON: sync=${lay(rr)} async=${lay(rra)} HC=${rr.recommendedHC}/${rra.recommendedHC})`);
      assert(lay(rr) === 'repair' && same(rr, rra), 'D79.n5b support sample, coverage ON: winningLayout "repair", sync == async', `sync=${lay(rr)} async=${lay(rra)}`);
    }
    // Placement-ON fixtures (D72 d52 / d50c) and the D76 polish fixtures.
    const calP: CalendarConfig = { ...BIZ_CAL, dailyOpenHour: 8, dailyCloseHour: 20 };
    const labP: LaborConfig = { ...LABOR, dailyProductiveHours: 8, shiftPlacementEnabled: true, shiftSlapMinutes: 30 };
    const mkIvP = (cats: Array<[string, (h: number) => number]>): StandardInterval[] => {
      const out: StandardInterval[] = [];
      for (let day = 0; day < 5; day++) for (let h = 8; h < 20; h++) for (let m = 0; m < 60; m += 30) for (const [category, vf] of cats) out.push({ intervalIndex: out.length, start: new Date(2026, 2, 2 + day, h, m), end: new Date(2026, 2, 2 + day, h, m + 30), volume: vf(h), category });
      return out;
    };
    const slaP = (pct: number, w: number): SLAPolicyConfig => ({ ...slaD, primaryPct: pct, primaryWindow: w });
    const c1P: CategoryConfig[] = [{ id: 'c1', name: 'General', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 }];
    const c2P: CategoryConfig[] = [{ id: 'A', name: 'A', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 }, { id: 'B', name: 'B', ahtMinutes: 25, shrinkagePct: 0.1, priority: 2 }];
    const fxP: Array<{ name: string; want: string[]; ivs: StandardInterval[]; cats: CategoryConfig[]; sla: SLAPolicyConfig; arch: 'pooled' | 'siloed'; maxHC: number }> = [
      { name: 'd52 (siloed, placement ON)', want: ['ladder'], ivs: mkIvP([['A', (h) => (h === 8 ? 60 : 4)], ['B', (h) => (h >= 12 && h < 16 ? 10 : 2)]]), cats: c2P, sla: slaP(95, 4), arch: 'siloed', maxHC: 60 },
      { name: 'd50c (pooled, placement ON)', want: ['ladder'], ivs: mkIvP([['General', (h) => (h === 8 ? 60 : 5)]]), cats: c1P, sla: slaP(97, 2), arch: 'pooled', maxHC: 40 },
      { name: 'D76 pooled spike (polish)', want: ['polish'], ivs: mkIvP([['General', (h) => (h === 8 ? 20 : 4)]]), cats: c1P, sla: slaP(85, 3), arch: 'pooled', maxHC: 60 },
      { name: 'D76 siloed spike (polish)', want: ['polish'], ivs: mkIvP([['A', (h) => (h === 8 ? 14 : 3)], ['B', (h) => (h >= 12 && h < 16 ? 7 : 2)]]), cats: c2P, sla: slaP(95, 4), arch: 'siloed', maxHC: 60 },
    ];
    for (const fx of fxP) {
      const pp = { intervals: fx.ivs, openingWIP: [] as OpeningWIPCase[], categories: fx.cats, calendar: calP, labor: labP, sla: fx.sla, seed: 42, userMaxHC: fx.maxHC, replications: 6, queueArchitecture: fx.arch };
      const rs = searchOptimalHC(pp); const ra: any = await searchOptimalHCAsync(pp);
      console.log(`  (D79 winningLayout ${fx.name}: sync=${lay(rs)} async=${lay(ra)} HC=${rs.recommendedHC}/${ra.recommendedHC})`);
      assert(fx.want.includes(lay(rs)) && same(rs, ra), `D79.n6 ${fx.name}: winningLayout ${fx.want.join('/')} and sync == async`, `sync=${lay(rs)} async=${lay(ra)}`);
      if (fx.want[0] === 'polish') assert(['adopted', 'adopted_partial'].includes((rs as any).rosterPolish?.status), `D79.n7 ${fx.name}: polish adopted -> layout polish`, `status=${(rs as any).rosterPolish?.status}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Suite D80 - small fixes S1 + S2 (2026-10-14)
// S1: computeIntervalHorizon never reads the wall clock. No valid demand interval AND no valid backlog arrival -> it throws a
//     clear message (it used to return new Date(), so a result could change with the day it was run).
// S2: the heap order (CaseMinHeap.compare) and the real dispatch order (pickNextCase / compareByUrgency) agree on every pair.
// Fail-first: before the change D80.1 / D80.2 / D80.2c / D80.3b / D80.4 fail (a date is returned instead of an error).
// ---------------------------------------------------------------------------
console.log('\n--- Suite D80: no wall-clock horizon (S1) and heap order = dispatch order (S2) ---');
{
  const badIv: StandardInterval = { intervalIndex: 0, start: new Date(NaN), end: new Date(NaN), category: 'General', volume: 5 };
  const MSG = 'No valid demand interval or backlog arrival date: the planning horizon cannot be set. Check the date columns of the uploaded file.';
  const thrown = (f: () => unknown): string | null => { try { f(); return null; } catch (e) { return (e as Error).message; } };
  const badWip = { id: 'W', category: 'General', priority: 1, arrival: new Date(NaN), clockStart: new Date(NaN), remainingWorkMinutes: 10 } as OpeningWIPCase;
  const goodWip = { ...badWip, id: 'B', arrival: new Date(2026, 9, 5, 10, 0), clockStart: new Date(2026, 9, 5, 10, 0) } as OpeningWIPCase;
  assert(thrown(() => computeIntervalHorizon([], [])) === MSG, 'D80.1 no demand interval and no backlog: throws the clear message (no wall-clock date)', `msg=${thrown(() => computeIntervalHorizon([], []))}`);
  assert(thrown(() => computeIntervalHorizon([badIv], [badWip])) === MSG, 'D80.2 only invalid dates: throws the same message', '');
  const bo = computeIntervalHorizon([badIv], [goodWip]);
  assert(bo.horizonStart.getTime() === new Date(2026, 9, 5, 10, 0).getTime() && bo.horizonEnd.getTime() - bo.horizonStart.getTime() === 7 * 86400000, 'D80.2b backlog-only still gives arrival and arrival + 7 days', '');
  const hasFn = (calNs as any).hasValidHorizonInput as ((i: any[], w: any[]) => boolean) | undefined;
  assert(typeof hasFn === 'function' && hasFn([badIv], []) === false && hasFn([], [badWip]) === false && hasFn([{ start: new Date(2026, 9, 5, 9), end: new Date(2026, 9, 5, 10) }], []) === true && hasFn([], [goodWip]) === true, 'D80.2c hasValidHorizonInput: false for all-invalid, true for a valid interval or a valid backlog arrival', `typeof=${typeof hasFn}`);
  // Valid data: unchanged.
  const okIv: StandardInterval = { intervalIndex: 0, start: new Date(2026, 9, 5, 9, 0), end: new Date(2026, 9, 5, 9, 30), category: 'General', volume: 20 };
  const okHz = computeIntervalHorizon([okIv, badIv], []);
  assert(okHz.horizonStart.getTime() === okIv.start.getTime() && okHz.horizonEnd.getTime() === okIv.end.getTime(), 'D80.2d valid data: horizon = span of the valid intervals', '');
  // Data quality: all-invalid dates never throw, still block the run, and skip the horizon warnings.
  {
    let dq: any = null; let err: string | null = null;
    try {
      dq = validateDataQuality({ intervals: [badIv, { ...badIv, intervalIndex: 1 }], mapping: { intervalStartCol: 'Date', volumeCol: 'Volume' } as any, categories: DEFAULT_CATEGORIES, calendar: DEFAULT_CALENDAR, labor: { ...DEFAULT_LABOR, contractualHoursSource: 'override', contractualProductiveHoursOverride: 500 } as any, sla: DEFAULT_SLA, openingWIP: [] });
    } catch (e) { err = (e as Error).message; }
    assert(err === null && !!dq && dq.passed === false && dq.issues.some((i: any) => i.severity === 'error'), 'D80.3 validateDataQuality with all-invalid dates: does not throw and still returns a blocking issue', `err=${err}`);
    assert(!!dq && dq.horizonStart === null && dq.horizonEnd === null && !dq.issues.some((i: any) => i.field === 'Manual Agent Hours Override' || i.field === 'Calendar/Data Coverage Gap'), 'D80.3b horizon-dependent warnings (override scale, empty open days) are skipped; horizon reported as null', `hs=${dq?.horizonStart}`);
  }
  // Engine: a direct call with no valid data throws the clear message, not an obscure later error.
  {
    const m = thrown(() => generateCaseEntities({ intervals: [badIv], openingWIP: [], categories: DEFAULT_CATEGORIES, calendar: DEFAULT_CALENDAR, sla: DEFAULT_SLA, seed: 1 }));
    assert(m === MSG, 'D80.4 generateCaseEntities with no valid data throws the clear horizon message', `msg=${m}`);
  }
  // S2: heap order vs dispatch order on a deterministic set of pairs (local seeded Mulberry32; createPrng is not exported).
  {
    let s80 = 80;
    const prng = (): number => { let t = (s80 += 0x6d2b79f5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const base = new Date(2026, 9, 5, 8, 0).getTime();
    let sid = 0;
    const mk = (over: Partial<CaseEntity> = {}): CaseEntity => {
      sid += 1;
      const aht = 10 + Math.floor(prng() * 3) * 10;
      const arr = new Date(base + Math.floor(prng() * 4) * 3600000);
      const lss = new Date(base + Math.floor(prng() * 5) * 3600000 - 2 * 3600000); // few distinct values -> many equal deadlines; some before base (overdue)
      return { id: `C${sid}`, syntheticId: sid, category: prng() < 0.5 ? 'A' : 'B', priority: 1 + Math.floor(prng() * 2), arrival: arr, clockStart: arr, totalAhtMinutes: aht, remainingWorkMinutes: prng() < 0.3 ? aht - 5 : aht, primaryDeadline: new Date(lss.getTime() + 1800000), latestSafeStart: lss, firstStartTime: null, completeTime: null, parkCount: prng() < 0.2 ? 1 : 0, isOpeningWip: prng() < 0.2, ...over } as CaseEntity;
    };
    const pool: CaseEntity[] = [];
    for (let i = 0; i < 60; i++) pool.push(mk());
    // Forced shapes: identical keys except syntheticId; parked with a later deadline vs fresh and earlier; overdue.
    pool.push(mk({ latestSafeStart: new Date(base), priority: 1, arrival: new Date(base), parkCount: 0, remainingWorkMinutes: 10, totalAhtMinutes: 10 }));
    pool.push(mk({ latestSafeStart: new Date(base), priority: 1, arrival: new Date(base), parkCount: 0, remainingWorkMinutes: 10, totalAhtMinutes: 10 }));
    pool.push(mk({ latestSafeStart: new Date(base + 9 * 3600000), parkCount: 2, remainingWorkMinutes: 5, totalAhtMinutes: 30 }));
    pool.push(mk({ latestSafeStart: new Date(base - 9 * 3600000), parkCount: 0, remainingWorkMinutes: 30, totalAhtMinutes: 30 }));
    const heapCmp = (a: CaseEntity, b: CaseEntity): number => (new CaseMinHeap() as any).compare(a, b);
    // Dispatch winner of a pair: put both in a queue and ask pickNextCase (the real dispatch).
    const dispatchSign = (a: CaseEntity, b: CaseEntity): number => {
      const q = new CaseMinHeap(); q.push(a); q.push(b);
      return pickNextCase(q, new Date(base)) === a ? -1 : 1;
    };
    let pairs = 0; const bad: string[] = [];
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
      pairs++;
      const h = Math.sign(heapCmp(pool[i], pool[j])); const d = dispatchSign(pool[i], pool[j]);
      if (h !== d) bad.push(`${pool[i].id} vs ${pool[j].id}: heap=${h} dispatch=${d}`);
      if (Math.sign(heapCmp(pool[j], pool[i])) !== -h) bad.push(`${pool[i].id} vs ${pool[j].id}: heap not antisymmetric`);
    }
    console.log(`  (D80 S2: ${pairs} pairs compared, ${bad.length} disagree${bad.length ? ': ' + bad.slice(0, 5).join('; ') : ''})`);
    assert(pairs > 1000 && bad.length === 0, 'D80.5 CaseMinHeap.compare and pickNextCase/compareByUrgency give the same winner on every pair (parked, ties, equal deadlines, overdue, categories)', bad.slice(0, 3).join('; '));
  }
}

// ---------------------------------------------------------------------------
// Suite D81 - Item 2 (L25 / P1-8, closes P1-7-a): a passing headcount must also pass on the confirmation block (owner decision 2026-10-11)
// A candidate N counts as passing only if the layout that passed ALSO passes the unchanged gate on the confirmation block (fresh,
// independent random days). One pure state machine (createPassConfirmation) is driven by both searches for the uniform, repair and
// placement layouts (the spread layout and the rescue ladder already confirm and are not confirmed twice). A primary pass that fails
// confirmation is a NON-passing result with the reason "N=<n> passed on the main simulated days but not on a second, independent set
// (<gate line>)."; the N-1 boundary evidence says the same. Cap reached only by confirmation = infeasible (B1). Runs with R <= 5 confirm
// every evaluation (B7); 5-replication leap probes of a larger R stay primary-only.
// Fail-first (pre-change, 11 failures): D81.0 (machine absent), D81.a1 (27, not 28), D81.a3/a4/a5 (no confirmation reason or evidence),
// D81.d10 (no confirmation progress), D81.cap1 / D81.cap3 (cap 27 / 28), D81.g1 / D81.h1 (27 / 26 returned), D81.r1 (R=3 not confirmed);
// the controls hold (sync === async, claims, healthcare, AJM_Only, the 10-fresh-seed proof, monotonicity 28..31, determinism).
// Mutation proof (hc-search.ts, scratch copy): dropping confirmation for uniform / repair / placement, in sync or in async, fails D81.
// ---------------------------------------------------------------------------
console.log('\n--- Suite D81: reliable minimum - a passing headcount also passes on the confirmation block (L25 / P1-8) ---');
{
  type PM = { next: () => any; record: (e: any) => void; result: () => any };
  const passMachine = (hcNs as any).createPassConfirmation as ((p: { n: number; confirmEnabled: boolean }) => PM) | undefined;
  const fmtConf = (hcNs as any).formatConfirmationFailure as ((n: number, g: string[]) => string) | undefined;
  assert(typeof passMachine === 'function' && typeof fmtConf === 'function', 'D81.0 createPassConfirmation and formatConfirmationFailure are exported', `machine=${typeof passMachine} fmt=${typeof fmtConf}`);
  const CONF_RE = /^N=(\d+) passed on the main simulated days but not on a second, independent set \((.+)\)\.$/;
  const BOUND_RE = /^N=(\d+) passed on the main simulated days but failed on a second, independent set \((.+)\)\. Stepping up to N=(\d+) achieved /;
  const rowOf = (r: any, n: number): any => (r.searchHistory as any[]).find((h) => h.hc === n);
  const sigOf = (r: any): string => `${r.recommendedHC}|${r.staffing?.grossHCTotal}|${r.isInfeasible}|${r.infeasibleReason}|${r.bindingConstraintType}|${r.bindingConstraintDescription}|${r.boundaryEvidence?.differenceSummary}|${JSON.stringify(r.finalDESResult?.shiftDistributionUsed)}|${JSON.stringify(r.boundaryEvidence?.failedResult?.shiftDistributionUsed)}|${JSON.stringify(r.searchHistory)}`;

  // ---- D81.d the pure machine (primary -> confirm), no evaluation inside ----
  if (typeof passMachine === 'function') {
    const ev = (pass: boolean, reasons: string[], tag: string): any => ({ passesAllConstraints: pass, failingReasons: reasons, tag, primaryStats: { achievedPctMedian: 81.5 } });
    {
      const m = passMachine({ n: 27, confirmEnabled: true });
      assert(m.next() === 'primary', 'D81.d1 first step is the primary evaluation', String(m.next()));
      m.record(ev(true, [], 'p'));
      assert(m.next() === 'confirm', 'D81.d2 a primary pass is NOT adopted yet: the confirmation block runs next', String(m.next()));
      m.record(ev(true, [], 'c'));
      const r = m.result();
      assert(m.next() === null && r.adopted && r.adopted.tag === 'p' && r.failed === null && r.confirmationGate === null, 'D81.d3 confirmed pass -> adopted, carrying the PRIMARY evaluation (figures comparable with every other N)', JSON.stringify(r));
    }
    {
      const m = passMachine({ n: 27, confirmEnabled: true }); m.next(); m.record(ev(true, [], 'p')); m.next();
      m.record(ev(false, ["Category 'X' Primary SLA 95% CI [70.0%, 90.0%] lower bound < target 80%"], 'c'));
      const r = m.result();
      const want = `N=27 passed on the main simulated days but not on a second, independent set (Category 'X' Primary SLA 95% CI [70.0%, 90.0%] lower bound < target 80%).`;
      assert(m.next() === null && r.adopted === null && r.failed.passesAllConstraints === false && r.failed.tag === 'p' && r.failed.primaryStats.achievedPctMedian === 81.5, 'D81.d4 confirmation failure -> NOT adopted; the failing result keeps the primary figures but is non-passing', JSON.stringify(r));
      assert(r.failed.failingReasons.length === 1 && r.failed.failingReasons[0] === want && r.confirmationGate === "Category 'X' Primary SLA 95% CI [70.0%, 90.0%] lower bound < target 80%", 'D81.d5 the only reason is the confirmation sentence; confirmationGate = the failing gate line', JSON.stringify([r.failed.failingReasons, r.confirmationGate]));
      assert(typeof fmtConf === 'function' && fmtConf(27, ['a', 'b']) === 'N=27 passed on the main simulated days but not on a second, independent set (a; b).', 'D81.d6 several failing gate lines are joined with "; "', typeof fmtConf === 'function' ? fmtConf(27, ['a', 'b']) : 'absent');
    }
    {
      const m = passMachine({ n: 27, confirmEnabled: true }); m.next(); m.record(ev(false, ['Primary SLA: 70% < 80%'], 'p'));
      const r = m.result();
      assert(m.next() === null && r.adopted === null && r.failed.tag === 'p' && r.failed.failingReasons[0] === 'Primary SLA: 70% < 80%' && r.confirmationGate === null, 'D81.d7 primary failure -> not adopted, no confirmation run, reasons unchanged', JSON.stringify(r));
    }
    {
      const m = passMachine({ n: 27, confirmEnabled: false }); m.next(); m.record(ev(true, [], 'probe'));
      const r = m.result();
      assert(m.next() === null && r.adopted && r.adopted.tag === 'probe' && r.confirmationGate === null, 'D81.d8 leap probe (fewer replications than R: confirmEnabled=false) is NOT confirmed - a probe pass is always followed by a full-R evaluation, which is', JSON.stringify(r));
      m.record(ev(false, ['late record'], 'late'));
      assert(m.result().adopted.tag === 'probe', 'D81.d9 records after the machine finished are ignored', JSON.stringify(m.result()));
    }
  }

  // ---- fixtures ----
  const { rows: supRows } = buildSampleDataset('support', new Date(2026, 9, 5, 8, 0, 0, 0));
  const ivSup = mapRawRecordsToIntervals(supRows, { intervalStartCol: 'IntervalStart', volumeCol: 'Volume', categoryCol: 'Category' } as any);
  const catSup = discoverAndSyncCategories(ivSup, DEFAULT_CATEGORIES, DEFAULT_SLA);
  const pSup = (extra: any = {}) => ({ intervals: ivSup, openingWIP: [] as OpeningWIPCase[], categories: catSup, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: DEFAULT_SLA, seed: DEFAULT_SIM_PARAMS.seed, userMaxHC: DEFAULT_SIM_PARAMS.maxHCSearch, replications: DEFAULT_SIM_PARAMS.replications, queueArchitecture: 'pooled' as const, dispatchFairness: DEFAULT_SIM_PARAMS.dispatchFairness, ...extra });

  // ---- D81.a support sample: 28 (was 27), sync === async, N=27 row and N-1 evidence (B4) ----
  const events: Array<{ n: number | undefined; msg: string }> = [];
  const sup: any = searchOptimalHC(pSup());
  const supA: any = await searchOptimalHCAsync(pSup({ onProgress: (p: any) => events.push({ n: p.currentN, msg: String(p.currentMessage ?? '') }) }));
  assert(sup.recommendedHC === 28 && sup.staffing?.grossHCTotal === 35 && !sup.isInfeasible, 'D81.a1 support sample (defaults, coverage ON): recommended 28 / gross 35 (was 27 / 34: 27 cleared the main days but not a second independent set)', `got ${sup.recommendedHC}/${sup.staffing?.grossHCTotal}`);
  assert(sigOf(sup) === sigOf(supA), 'D81.a2 support: sync === async (HC, gross, label, evidence, roster, full search history)', `sync=${sup.recommendedHC} async=${supA.recommendedHC}`);
  const row27 = rowOf(sup, 27);
  const m27 = row27 && row27.failingReasons.length === 1 ? CONF_RE.exec(row27.failingReasons[0]) : null;
  assert(!!row27 && row27.passed === false && !!m27 && m27[1] === '27' && /Category/.test(m27[2]), 'D81.a3 support N=27 history row: Fail, with the "passed on the main simulated days but not on a second, independent set (<category gate>)" reason', JSON.stringify(row27?.failingReasons));
  assert(!!row27 && row27.primaryPct >= 80, 'D81.a3b the N=27 row still shows its main-days figure (>= the 80% target) - which is why the reason text is needed', `primaryPct=${row27?.primaryPct}`);
  {
    const ev = sup.boundaryEvidence;
    const mb = ev ? BOUND_RE.exec(ev.differenceSummary) : null;
    const dist = ev?.failedResult?.shiftDistributionUsed as ShiftDistributionByCategory | undefined;
    const starts = dist ? Object.values(dist).reduce((a, d) => Math.max(a, d.slaps.length), 0) : 0;
    assert(!!ev && ev.failedN === 27 && !!mb && mb[1] === '27' && mb[3] === '28', 'D81.a4 N-1 evidence (27) says it passed on the main days but failed on a second, independent set', ev?.differenceSummary);
    assert(!!mb && !!m27 && mb[2] === m27[2], 'D81.a5 the evidence text and the history row quote the SAME failing gate line', `${mb?.[2]} | ${m27?.[2]}`);
    assert(starts >= 2, 'D81.a6 the N-1 evidence run uses the layout that passed the main days (a multi-start coverage roster), not the uniform one', `starts=${starts}`);
  }
  // ---- D81.k rework round 1 (2026-10-15): C2 Results line, C3 history flag/badge, C1 block released between confirmation stages ----
  {
    const rdK: any = await import('../src/utils/results-display');
    const rfK = readFileSync(join(resolve(import.meta.dirname, '..'), 'src', 'components', 'ResultsFlow.tsx'), 'utf-8');
    assert(rdK.CONFIRMED_TWO_SETS_TEXT === 'Confirmed on two independent sets of simulated days.', 'D81.k1 C2 results-display exports the exact line "Confirmed on two independent sets of simulated days."', String(rdK.CONFIRMED_TWO_SETS_TEXT));
    assert(/!isInfeasible && searchOutput\.recommendedHC !== null && \([\s\S]{0,200}CONFIRMED_TWO_SETS_TEXT/.test(rfK), 'D81.k2 C2 ResultsFlow renders the line only when a recommendation exists (feasible and recommendedHC set)', '');
    const flagged = (sup.searchHistory as any[]).filter((h) => h.confirmationOnlyFailure === true);
    assert(flagged.length >= 1 && flagged.every((h) => h.passed === false && h.failingReasons.length === 1 && !!CONF_RE.exec(h.failingReasons[0])) && row27?.confirmationOnlyFailure === true, 'D81.k3 C3 the engine flags the N=27 row (confirmation-only failure) on the history entry; no string matching in the UI', JSON.stringify(flagged.map((h) => h.hc)));
    assert((sup.searchHistory as any[]).filter((h) => h.confirmationOnlyFailure !== true).every((h) => !CONF_RE.test(h.failingReasons[0] ?? '')) && (sup.searchHistory as any[]).every((h) => h.passed ? h.confirmationOnlyFailure === undefined : true), 'D81.k4 C3 every other row (passes, plain misses) carries no flag', '');
    assert(supA.searchHistory.find((h: any) => h.hc === 27)?.confirmationOnlyFailure === true, 'D81.k5 C3 async search flags the same row', '');
    assert(rdK.HISTORY_SECOND_SET_BADGE === 'Fail – 2nd set' && rdK.historyReasonText('R', { confirmationOnlyFailure: true }) === rdK.HISTORY_SECOND_SET_PREFIX + 'R' && rdK.historyReasonText('R', {}) === 'R' && rdK.historyReasonText('R', { confirmationOnlyFailure: false }) === 'R', 'D81.k6 C3 helper: flagged reason gets the second-set prefix, other reasons unchanged', rdK.HISTORY_SECOND_SET_PREFIX);
    assert(/item\.confirmationOnlyFailure \? \( <span className="[^"]*text-amber[^"]*"[^>]*> <AlertTriangle[^>]*\/> \{HISTORY_SECOND_SET_BADGE\}/.test(rfK.replace(/\s+/g, ' ')), 'D81.k7 C3 ResultsFlow shows the amber "Fail - 2nd set" badge on the flag (red Fail otherwise); main-days cells keep their colours (historyPrimaryPasses unchanged)', '');
    // C1: the confirmation block is a lazy view - no replication is kept between reads - and every read regenerates byte-identical sets
    const cbK = hcNs.createConfirmationBlock({ intervals: ivSup, openingWIP: [], categories: catSup, calendar: DEFAULT_CALENDAR, sla: DEFAULT_SLA, seed: DEFAULT_SIM_PARAMS.seed, replications: 4 });
    const digK = (x: any) => createHash('sha1').update(JSON.stringify(x.cases.map((c: any) => [c.category, c.arrival.getTime(), c.totalAhtMinutes, c.deadline?.getTime?.()]))).digest('hex').slice(0, 12);
    const view = cbK.sets(); const eager = hcNs.generatePrecomputedReplications({ intervals: ivSup, openingWIP: [], categories: catSup, calendar: DEFAULT_CALENDAR, sla: DEFAULT_SLA, baseSeed: cbK.baseSeed, replications: 4 });
    const read1 = view[2]; const read2 = view[2];
    assert(Array.isArray(view) && view.length === 4 && view[4] === undefined && read1 !== read2 && digK(read1) === digK(read2), 'D81.k8 C1 a read gives a fresh, identical case set each time: the view keeps nothing resident', `len=${view.length}`);
    assert(view.map(digK).join() === eager.map(digK).join() && cbK.sets() === view && !(Object.keys(view).length > 0), 'D81.k9 C1 the lazy view equals the eagerly generated block (same seeds) and holds no own entries', '');
  }
  // progress + leap probes
  {
    const conf = events.filter((e) => e.msg.includes('Confirming on a second set of simulated days'));
    const probes = events.filter((e) => /^Leap test N=/.test(e.msg));
    const perN = new Map<number, number>();
    for (const e of conf) if (e.n !== undefined) perN.set(e.n, (perN.get(e.n) ?? 0) + 1);
    const R81 = DEFAULT_SIM_PARAMS.replications;
    const perRun = R81 - 1; // evaluateCandidateStatisticalAsync reports after every replication except the last
    assert(conf.length > 0 && conf.length % perRun === 0, 'D81.d10 async progress shows "Confirming on a second set of simulated days" (whole confirmation runs)', `events=${conf.length} (per run ${perRun})`);
    assert(probes.length > 0 && probes.every((e) => !e.msg.includes('Confirming')), 'D81.d11 the 5-replication leap probes (R=30) are primary-only: no "Confirming" progress inside a "Leap test" step', `probes=${probes.length}`);
    assert(Array.from(perN.values()).every((c) => c <= perRun), 'D81.d12 no double confirmation: at most ONE confirmation run per headcount for support (repair layout only; the spread layout confirms itself)', JSON.stringify(Array.from(perN.entries())));
  }

  // ---- D81.cap support: the old answer as a cap. Cap 27 was already infeasible before this change (the 5-replication leap probe at the cap
  //      fails on its own sets, so the full-R run never happens) and stays so; cap 28 recommends 28. The confirmation-text case is D81.g3 (fixture A). ----
  {
    const c27: any = searchOptimalHC(pSup({ userMaxHC: 27 }));
    const c27a: any = await searchOptimalHCAsync(pSup({ userMaxHC: 27 }));
    const c28: any = searchOptimalHC(pSup({ userMaxHC: 28 }));
    const c28a: any = await searchOptimalHCAsync(pSup({ userMaxHC: 28 }));
    assert(c27.isInfeasible && c27a.isInfeasible && c27.recommendedHC === null && c27.infeasibleReason === c27a.infeasibleReason && /Headcount search exhausted all candidate headcounts up to the user max ceiling of 27 agents/.test(c27.infeasibleReason ?? ''), 'D81.cap1 support with userMaxHC = 27 (the old answer): infeasible, sync === async, message wording unchanged', c27.infeasibleReason);
    assert(c28.recommendedHC === 28 && c28a.recommendedHC === 28 && !c28.isInfeasible && !c28a.isInfeasible, 'D81.cap3 support with userMaxHC = 28: recommends 28 (sync and async)', `sync=${c28.recommendedHC} async=${c28a.recommendedHC}`);
  }

  // ---- D81.b unchanged answers ----
  for (const [type, hc, gross] of [['claims', 31, 40], ['healthcare', 31, 39]] as Array<['claims' | 'healthcare', number, number]>) {
    const { rows } = buildSampleDataset(type, new Date(2026, 9, 5, 8, 0, 0, 0));
    const ivs = mapRawRecordsToIntervals(rows, { intervalStartCol: 'IntervalStart', volumeCol: 'Volume', categoryCol: 'Category' } as any);
    const cats = discoverAndSyncCategories(ivs, DEFAULT_CATEGORIES, DEFAULT_SLA);
    const r = searchOptimalHC({ intervals: ivs, openingWIP: [], categories: cats, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: DEFAULT_SLA, seed: DEFAULT_SIM_PARAMS.seed, userMaxHC: DEFAULT_SIM_PARAMS.maxHCSearch, replications: DEFAULT_SIM_PARAMS.replications, queueArchitecture: 'pooled', dispatchFairness: DEFAULT_SIM_PARAMS.dispatchFairness });
    assert(r.recommendedHC === hc && r.staffing.grossHCTotal === gross, `D81.b ${type} sample (defaults): HC ${hc} / gross ${gross} unchanged by the confirmation rule`, `got ${r.recommendedHC}/${r.staffing.grossHCTotal}`);
  }
  {
    const { intervals: ivAjm, categories: catAjm } = loadSampleFile('AJM_Only.csv');
    const r = searchOptimalHC({ intervals: ivAjm, openingWIP: [], categories: catAjm, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: DEFAULT_SLA, seed: DEFAULT_SIM_PARAMS.seed, userMaxHC: DEFAULT_SIM_PARAMS.maxHCSearch, replications: DEFAULT_SIM_PARAMS.replications, queueArchitecture: 'pooled', dispatchFairness: DEFAULT_SIM_PARAMS.dispatchFairness });
    assert(r.recommendedHC === 16 && r.staffing.grossHCTotal === 20, 'D81.b AJM_Only.csv (defaults): HC 16 / gross 20 unchanged by the confirmation rule', `got ${r.recommendedHC}/${r.staffing.grossHCTotal}`);
  }

  // ---- D81.c owner proof target: at the new N, fresh seeds (independent of the primary AND confirmation blocks) pass >= 9 of 10 ----
  {
    const freshPass = (n: number, roster: ShiftDistributionByCategory | undefined, nSeeds: number): number => {
      let pass = 0;
      for (let k = 0; k < nSeeds; k++) {
        const bs = (1000000007 + k * 1000003) % 2147483647;
        const sets = hcNs.generatePrecomputedReplications({ intervals: ivSup, openingWIP: [], categories: catSup, calendar: DEFAULT_CALENDAR, sla: DEFAULT_SLA, baseSeed: bs, replications: 30 });
        const e = evaluateCandidateStatistical({ operationalHC: n, intervals: ivSup, openingWIP: [], categories: catSup, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: DEFAULT_SLA, baseSeed: bs, replications: 30, queueArchitecture: 'pooled', precomputedCaseSets: sets, shiftDistribution: roster, dispatchFairness: DEFAULT_SIM_PARAMS.dispatchFairness });
        if (e.passesAllConstraints) pass++;
      }
      return pass;
    };
    const rosterNew = sup.finalDESResult?.shiftDistributionUsed as ShiftDistributionByCategory | undefined;
    const rosterOld = sup.boundaryEvidence?.failedResult?.shiftDistributionUsed as ShiftDistributionByCategory | undefined;
    const pNew = rosterNew ? freshPass(28, rosterNew, 10) : -1;
    const pOld = rosterOld ? freshPass(27, rosterOld, 10) : -1;
    console.log(`  (D81.c fresh seeds: N=28 passes ${pNew}/10, old answer N=27 passes ${pOld}/10)`);
    assert(pNew >= 9, 'D81.c1 support at the recommended 28: >= 9 of 10 fresh seeds pass the unchanged gate (owner proof target; N=27 passed 8 of 20)', `pass=${pNew}/10`);
    assert(pOld >= 0 && pOld < 9, 'D81.c2 control: the old answer N=27 does NOT reach the same bar on the same 10 fresh seeds (the proof can fail)', `pass=${pOld}/10`);
  }

  // ---- D81.e monotonicity: the search's own verdict (primary AND confirmation, repair or spread layout) at 28..31 ----
  {
    const planOf81 = (hcNs as any).planCoverageRepair as (p: any) => any;
    const R = DEFAULT_SIM_PARAMS.replications; const seed = DEFAULT_SIM_PARAMS.seed;
    const pre = hcNs.generatePrecomputedReplications({ intervals: ivSup, openingWIP: [], categories: catSup, calendar: DEFAULT_CALENDAR, sla: DEFAULT_SLA, baseSeed: seed, replications: R });
    const cb = hcNs.createConfirmationBlock({ intervals: ivSup, openingWIP: [], categories: catSup, calendar: DEFAULT_CALENDAR, sla: DEFAULT_SLA, seed, replications: R });
    const run = (n: number, roster: any, sets: any, bs: number) => evaluateCandidateStatistical({ operationalHC: n, intervals: ivSup, openingWIP: [], categories: catSup, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: DEFAULT_SLA, baseSeed: bs, replications: R, queueArchitecture: 'pooled', precomputedCaseSets: sets, shiftDistribution: roster, dispatchFairness: DEFAULT_SIM_PARAMS.dispatchFairness }).passesAllConstraints;
    const verdicts: string[] = []; let all = true;
    for (let n = 27; n <= 31; n++) {
      const plan = planOf81({ n, sla: DEFAULT_SLA, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, queueArchitecture: 'pooled', representativeCases: pre[0].cases });
      const ok = [plan.dist, plan.spread].some((roster: any) => !!roster && run(n, roster, pre, seed) && run(n, roster, cb.sets(), cb.baseSeed));
      verdicts.push(`${n}${ok ? 'P' : 'F'}`);
      if (n >= 28 && !ok) all = false;
      if (n === 27 && ok) all = false;
    }
    assert(all, 'D81.e monotonicity: support passes primary AND confirmation at 28, 29, 30 and 31 (27 does not)', verdicts.join(' '));
  }

  // ---- D81.f determinism ----
  {
    const sup2: any = searchOptimalHC(pSup());
    assert(sigOf(sup2) === sigOf(sup), 'D81.f two sync runs of the support sample are identical (HC, evidence, roster, full history)', `${sup2.recommendedHC} vs ${sup.recommendedHC}`);
  }

  // ---- D81.g/h/i layout fixtures (flat 5-day, 14 h/day window, 9 h shift, AHT 20, R=5, seed 1): uniform / placement ----
  const flat81 = (vol: number, win: number, pct: number, extraLabor: any = {}, cov = false) => {
    const ivs: StandardInterval[] = [];
    for (let day = 0; day < 5; day++) for (let h = 8; h < 22; h++) for (let m = 0; m < 60; m += 30) ivs.push({ intervalIndex: ivs.length, start: new Date(2026, 2, 2 + day, h, m), end: new Date(2026, 2, 2 + day, h, m + 30), volume: vol, category: 'General' });
    return {
      intervals: ivs, openingWIP: [] as OpeningWIPCase[], categories: [{ id: 'c1', name: 'General', ahtMinutes: 20, shrinkagePct: 0.1, priority: 1 }] as CategoryConfig[],
      calendar: { workingDays: [1, 2, 3, 4, 5], dailyOpenHour: 8, dailyOpenMinute: 0, dailyCloseHour: 22, dailyCloseMinute: 0, holidays: [] } as CalendarConfig,
      labor: { ...DEFAULT_LABOR, dailyProductiveHours: 9, ...extraLabor } as LaborConfig,
      sla: { primaryPct: pct, primaryWindow: win, primaryUnit: 'hours', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes', asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open', occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90, minCoverageEnabled: cov } as SLAPolicyConfig,
      seed: 1, userMaxHC: 60, replications: 5, queueArchitecture: 'pooled' as const,
    };
  };
  {
    // uniform layout (coverage OFF, no placement): 27 clears the main days (CI low 80.0) but not the second set (79.8) -> 28
    const fxU = flat81(20, 4, 80);
    const u: any = searchOptimalHC(fxU); const uA: any = await searchOptimalHCAsync(fxU);
    const rU = rowOf(u, 27);
    assert(u.recommendedHC === 28 && !!rU && rU.passed === false && rU.failingReasons.length === 1 && !!CONF_RE.exec(rU.failingReasons[0]), 'D81.g1 uniform layout (coverage OFF): recommended 28; the N=27 row is the confirmation failure (27 cleared the main days only)', `rec=${u.recommendedHC} row27=${JSON.stringify(rU?.failingReasons)}`);
    assert(sigOf(u) === sigOf(uA), 'D81.g2 uniform layout: sync === async (full history, evidence, roster)', `sync=${u.recommendedHC} async=${uA.recommendedHC}`);
    // B1: the cap is reached ONLY by a confirmation failure (27 is evaluated at full R, clears the main days, fails the second set) -> infeasible, with the sentence
    const u27: any = searchOptimalHC({ ...fxU, userMaxHC: 27 }); const u27a: any = await searchOptimalHCAsync({ ...fxU, userMaxHC: 27 });
    const wantTail = /Headcount search exhausted all candidate headcounts up to the user max ceiling of 27 agents without finding a passing configuration\. At N=27: N=27 passed on the main simulated days but not on a second, independent set \(.+\)\. Increase userMaxHC or review SLA\/labor parameters\.$/;
    assert(u27.isInfeasible && u27.recommendedHC === null && wantTail.test(u27.infeasibleReason ?? ''), 'D81.g3 uniform layout with userMaxHC = 27 (the old answer): INFEASIBLE - a number that is not reliably met is not given; the message keeps its wording and names the confirmation failure (one full stop)', u27.infeasibleReason);
    assert(u27a.isInfeasible && u27a.infeasibleReason === u27.infeasibleReason, 'D81.g4 cap 27: sync === async message', `${u27.infeasibleReason} | ${u27a.infeasibleReason}`);
  }
  {
    // placement layout (coverage OFF, Shift Placement ON): 26 clears the main days with the analytic placement roster (CI low 76.7 vs target 76.5) but not the second set (76.0) -> 27
    const fxP = flat81(20, 1, 76.5, { shiftPlacementEnabled: true });
    const p: any = searchOptimalHC(fxP); const pA: any = await searchOptimalHCAsync(fxP);
    const rP = rowOf(p, 26);
    assert(p.recommendedHC === 27 && !!rP && rP.passed === false && rP.failingReasons.length === 1 && !!CONF_RE.exec(rP.failingReasons[0]), 'D81.h1 placement layout (Shift Placement ON, coverage OFF): recommended 27; the N=26 row is the confirmation failure of the placement roster', `rec=${p.recommendedHC} row26=${JSON.stringify(rP?.failingReasons)}`);
    assert(sigOf(p) === sigOf(pA), 'D81.h2 placement layout: sync === async (full history, evidence, roster)', `sync=${p.recommendedHC} async=${pA.recommendedHC}`);
  }

  // ---- D81.r B7: R <= 5 - the leap probes are full evaluations and are confirmed ----
  {
    const ev3: Array<{ msg: string }> = [];
    const s3: any = searchOptimalHC(pSup({ replications: 3 }));
    const s3a: any = await searchOptimalHCAsync(pSup({ replications: 3, onProgress: (p: any) => ev3.push({ msg: String(p.currentMessage ?? '') }) }));
    const leapConf = ev3.filter((e) => /^Leap test N=/.test(e.msg) && e.msg.includes('Confirming on a second set of simulated days') && /\/3 replications\)$/.test(e.msg));
    assert(leapConf.length > 0, 'D81.r1 R=3: a leap step is a full evaluation and shows the confirmation run (3 replications)', `leap-confirm events=${leapConf.length}`);
    assert(sigOf(s3) === sigOf(s3a) && s3.recommendedHC !== null, 'D81.r2 R=3: sync === async', `sync=${s3.recommendedHC} async=${s3a.recommendedHC}`);
  }
}

// ---------------------------------------------------------------------------
// Suite D82 - Item 3 (H4 / L30 / P1-10): per-category answer-time (BO ASA) targets with an explicit own-target switch
// (owner decisions 2026-10-15). A category has an OWN target iff boAsaOwn === true AND boAsaTarget is a finite number > 0.
// Copies of the global value (CSV load, template apply, defaults, settings files from before the field) are never targets.
// OWNER DECISION 2026-10-15 (after review round 1, rework F): EVERY category is judged on its own - its own target if ticked,
// otherwise the global target (upper CI bound of that category's answer time). No pooled gate, no follower pool. Answer time OFF is unchanged.
// Fail-first (pre-change): the helper is absent (D82.0 and everything that needs it), D82.b/c/e fail (own target never read).
// ---------------------------------------------------------------------------
console.log('\n--- Suite D82: per-category answer-time targets, explicit own-target switch (H4 / L30 / P1-10) ---');
{
  const h = hcNs as any;
  const resolveAsa = h.resolveCategoryAsaTargets as ((c: CategoryConfig[], s: SLAPolicyConfig, cal: CalendarConfig) => Record<string, any>) | undefined;
  assert(typeof resolveAsa === 'function', 'D82.0 resolveCategoryAsaTargets is exported', `typeof=${typeof resolveAsa}`);
  const mkc = (name: string, extra: Record<string, unknown> = {}): CategoryConfig => ({ id: name, name, ahtMinutes: 20, shrinkagePct: 0.2, priority: 1, primaryPct: 80, ...extra } as CategoryConfig);
  const slaA: SLAPolicyConfig = { ...DEFAULT_SLA, primaryPct: 80, slaAcceptanceSlackEnabled: false, boAsaEnabled: true, boAsaTarget: 60, boAsaUnit: 'minutes', occupancyCapEnabled: false, confidenceLevelPct: 95 };
  const R82 = (c: CategoryConfig[], s: SLAPolicyConfig, cal: CalendarConfig = BIZ_CAL) => (resolveAsa ? resolveAsa(c, s, cal) : {});

  // ---- D82.a the own-target rule ----
  {
    const t = R82([mkc('A', { boAsaTarget: 60, boAsaUnit: 'minutes' }), mkc('B', { boAsaTarget: 90, boAsaUnit: 'minutes' }), mkc('C', { boAsaTarget: 1, boAsaUnit: 'hours' }), mkc('D')], slaA);
    assert(['A', 'B', 'C', 'D'].every((k) => t[k]?.own === false), 'D82.a1 copies are never own, equal to the global or not (B holds 90 but is not ticked), and a category with no value follows too', JSON.stringify(t));
    assert(t.B?.targetMinutes === 60 && t.C?.targetMinutes === 60, 'D82.a1b a follower reports the GLOBAL target (60 min) whatever value its copy holds', JSON.stringify(t));
    const o = R82([mkc('A', { boAsaOwn: true, boAsaTarget: 30, boAsaUnit: 'minutes' }), mkc('B', { boAsaOwn: true, boAsaTarget: 60, boAsaUnit: 'minutes' })], slaA);
    assert(o.A?.own === true && o.A.targetMinutes === 30 && o.A.targetValue === 30 && o.A.targetUnit === 'minutes', 'D82.a2 ticked + 30 min -> own, 30 min', JSON.stringify(o.A));
    assert(o.B?.own === true && o.B.targetMinutes === 60, 'D82.a3 ticked with a value equal to the global stays own (the switch is explicit, not value-compared)', JSON.stringify(o.B));
    const bad = R82([0, NaN, -5, Infinity].map((v, i) => mkc('X' + i, { boAsaOwn: true, boAsaTarget: v, boAsaUnit: 'minutes' })).concat([mkc('Y', { boAsaOwn: true }), mkc('Z', { boAsaOwn: 'true' as any, boAsaTarget: 30 })]), slaA);
    assert(Object.values(bad).every((x: any) => x.own === false), 'D82.a4 ticked but 0 / NaN / negative / Infinity / missing value, or a non-boolean flag -> not own', JSON.stringify(bad));
    const u = R82([mkc('A', { boAsaOwn: true, boAsaTarget: 1, boAsaUnit: 'hours' }), mkc('B', { boAsaOwn: true, boAsaTarget: 30 })], slaA);
    assert(u.A?.targetMinutes === 60 && u.B?.targetMinutes === 30 && u.B.targetUnit === 'minutes', 'D82.a5 own value converted with its own unit (1 hour = 60 min); an own value without a unit takes the global unit', JSON.stringify(u));
    const dBiz = R82([mkc('A', { boAsaOwn: true, boAsaTarget: 1, boAsaUnit: 'days' })], { ...slaA, asaClockBasis: 'business_window' }, BIZ_CAL);
    const dClk = R82([mkc('A', { boAsaOwn: true, boAsaTarget: 1, boAsaUnit: 'days' })], { ...slaA, asaClockBasis: 'clock_hours' }, BIZ_CAL);
    assert(dBiz.A?.targetMinutes === 480 && dClk.A?.targetMinutes === 1440, 'D82.a6 "days" uses the same basis as the global target: business window 8 h -> 480 min, clock hours -> 1440 min', `${dBiz.A?.targetMinutes} / ${dClk.A?.targetMinutes}`);
  }

  // ---- D82.b the gate, hand-built replications (R = 5, t(df 4, 95%) = 2.776) ----
  {
    const mkRep = (cs: Record<string, { asa?: number; elig?: number }>, pooled?: number): any => {
      const e = Object.entries(cs);
      const tot = e.reduce((s, [, v]) => s + (v.elig ?? 0), 0);
      const p = pooled ?? (tot > 0 ? Math.round((e.reduce((s, [, v]) => s + (v.asa ?? 0) * (v.elig ?? 0), 0) / tot) * 10) / 10 : 0);
      return {
        primaryAchievedPct: 100, rawOccupancyPct: 50, boAsaMeanMinutes: p, minCoverageObserved: Infinity,
        categoryStats: Object.fromEntries(e.map(([k, v]) => [k, { primaryPct: 100, ...(v.elig === undefined ? {} : { primaryEligible: v.elig }), ...(v.asa === undefined ? {} : { asaMeanMinutes: v.asa }) }])),
      };
    };
    const rs5 = (f: (i: number) => any): any[] => [0, 1, 2, 3, 4].map(f);
    const ev = (rs: any[], cats: CategoryConfig[], s: SLAPolicyConfig = slaA): any => h.computeStatisticalEvaluation(4, rs, rs.map((r: any) => r.primaryAchievedPct), rs.length, s, BIZ_CAL, cats);
    const own = (name: string, v: number, extra: Record<string, unknown> = {}) => mkc(name, { boAsaOwn: true, boAsaTarget: v, boAsaUnit: 'minutes', ...extra });
    const fol = (name: string) => mkc(name, { boAsaTarget: 60, boAsaUnit: 'minutes' });

    // b1: own A = 30 but A answers in 40; B (follower, 20 min) and the pooled mean (30) are fine -> only A's own target fails
    const b1 = ev(rs5(() => mkRep({ A: { asa: 40, elig: 10 }, B: { asa: 20, elig: 10 } })), [own('A', 30), fol('B')]);
    assert(b1.passesBoAsaCap === false && b1.passesOrgGates === false && b1.passesAllConstraints === false, 'D82.b1a own target missed -> BO ASA cap false, org gates false, run fails', JSON.stringify({ c: b1.passesBoAsaCap, o: b1.passesOrgGates, a: b1.passesAllConstraints }));
    assert(b1.categoryPasses.A === false && b1.categoryPasses.B === true, 'D82.b1b categoryPasses: A false (its own target), B true', JSON.stringify(b1.categoryPasses));
    assert(b1.failingReasons.length === 1 && b1.failingReasons[0].startsWith("BO ASA (category 'A')") && /30/.test(b1.failingReasons[0]) && /own target/.test(b1.failingReasons[0]), 'D82.b1c exactly one reason, "BO ASA (category \'A\') ... own target", naming the target', b1.failingReasons.join(' | '));
    assert(b1.categoryAsa?.A?.own === true && b1.categoryAsa?.A?.passes === false && b1.categoryAsa?.A?.mean === 40 && b1.categoryAsa?.A?.n === 5 && b1.categoryAsa?.A?.target === 30 && b1.categoryAsa?.B?.own === false, 'D82.b1d categoryAsa carries own / target / mean / n / passes for A and own=false for B', JSON.stringify(b1.categoryAsa));
    assert(b1.categoryAsa?.B?.own === false && b1.categoryAsa?.B?.target === 60 && b1.categoryAsa?.B?.passes === true && b1.followersAsa === undefined, 'D82.b1e B follows the global 60 and is judged on its own (passes at 20); there is no follower pool', JSON.stringify(b1.categoryAsa));
    // the same replications with A left to follow the global (copy, not ticked) pass: pooled 30 <= 60
    const b1f = ev(rs5(() => mkRep({ A: { asa: 40, elig: 10 }, B: { asa: 20, elig: 10 } })), [mkc('A', { boAsaTarget: 30, boAsaUnit: 'minutes' }), fol('B')]);
    assert(b1f.passesBoAsaCap === true && b1f.passesAllConstraints === true && b1f.categoryAsa?.A?.own === false && b1f.categoryAsa?.A?.target === 60 && b1f.categoryAsa?.A?.passes === true, 'D82.b1f the SAME replications with A holding 30 as a copy (not ticked): A is judged against the global 60 on its own (40 passes)', JSON.stringify(b1f.failingReasons));

    // b2: a LOOSER own target lets A through while the rest passes alone; without the tick the pooled mean (65 > 60) fails as today
    const looseReps = rs5(() => mkRep({ A: { asa: 80, elig: 30 }, B: { asa: 20, elig: 10 } }));
    const b2 = ev(looseReps, [own('A', 90), fol('B')]);
    const b2n = ev(looseReps, [mkc('A', { boAsaTarget: 90, boAsaUnit: 'minutes' }), fol('B')]);
    assert(b2.passesBoAsaCap === true && b2.passesAllConstraints === true && b2.failingReasons.length === 0, 'D82.b2a A own 90 (answers in 80) and B follows 60 (answers in 20) -> both met on their own, passes', JSON.stringify({ r: b2.failingReasons }));
    assert(b2n.passesBoAsaCap === false && b2n.failingReasons.length === 1 && b2n.failingReasons[0].startsWith("BO ASA (category 'A')") && /upper bound > target 60minutes \(60m\)/.test(b2n.failingReasons[0]) && !/own target/.test(b2n.failingReasons[0]), 'D82.b2b no tick: A (80) is judged against the global 60 on its own and fails - even though the pooled mean (65) would be only slightly over and B is fine', b2n.failingReasons.join(' | '));

    // b3: the upper CI bound, not the mean, decides an own target
    const b3f = ev(rs5((i) => mkRep({ A: { asa: [29, 29, 29, 29, 31][i], elig: 10 }, B: { asa: 10, elig: 10 } })), [own('A', 30), fol('B')]);
    const b3p = ev(rs5((i) => mkRep({ A: { asa: [28, 29, 29, 29, 29][i], elig: 10 }, B: { asa: 10, elig: 10 } })), [own('A', 30), fol('B')]);
    assert(b3f.passesBoAsaCap === false && b3f.categoryAsa?.A?.mean === 29.4 && b3f.categoryAsa?.A?.ciHigh > 30, 'D82.b3a own target 30: mean 29.4 clears it but the upper bound (~30.5) does not -> fails', JSON.stringify(b3f.categoryAsa?.A));
    assert(b3p.passesBoAsaCap === true && b3p.categoryAsa?.A?.ciHigh <= 30, 'D82.b3b mean 28.8, upper bound ~29.4 -> passes', JSON.stringify(b3p.categoryAsa?.A));

    // b4: replications that carry no per-category ASA data (D57-style) never produce NaN; the own category is not judged and a note says so
    const b4 = ev(rs5(() => mkRep({ A: {}, B: {} }, 5)), [own('A', 30), fol('B')]);
    assert(!/NaN/.test(JSON.stringify({ c: b4.categoryAsa, n: b4.asaNotes, r: b4.failingReasons }, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? 'NaN' : v))) && b4.passesBoAsaCap === true, 'D82.b4a no per-category ASA data: no NaN anywhere, nothing judged, passes', JSON.stringify(b4.categoryAsa));
    assert(Array.isArray(b4.asaNotes) && b4.asaNotes.length === 2 && /'A'/.test(b4.asaNotes[0]) && /'B'/.test(b4.asaNotes[1]) && b4.categoryAsa?.A?.judged === false && b4.categoryAsa?.A?.n === 0 && b4.categoryAsa?.B?.judged === false, 'D82.b4b a note per category (A own, B global) says it was not checked (no cases to measure); judged=false, n=0', JSON.stringify({ n: b4.asaNotes, a: b4.categoryAsa }));

    // b5: replications with primaryEligible 0 are skipped (n and the t value use the samples that remain)
    const b5 = ev(rs5((i) => mkRep({ A: { asa: [99, 99, 25, 26, 27][i], elig: [0, 0, 10, 10, 10][i] }, B: { asa: 10, elig: 10 } })), [own('A', 30), fol('B')]);
    assert(b5.categoryAsa?.A?.n === 3 && b5.categoryAsa?.A?.mean === 26 && b5.passesBoAsaCap === true, 'D82.b5 two replications with no eligible A case are skipped: n = 3, mean 26 (the 99s are not averaged in), passes', JSON.stringify(b5.categoryAsa?.A));
    // b5b: a replication with no case for the category is skipped (n = 1: the value itself is compared)
    const b5b = ev(rs5((i) => mkRep({ A: { asa: 10, elig: 10 }, B: { asa: [70, 70, 70, 70, 70][i], elig: [0, 0, 0, 0, 5][i] } })), [own('A', 30), fol('B')]);
    assert(b5b.categoryAsa?.B?.n === 1 && b5b.categoryAsa?.B?.mean === 70 && b5b.categoryAsa?.B?.passes === false && b5b.passesBoAsaCap === false, 'D82.b5b B follows 60: only the replication with B cases counts (n = 1, value 70 > 60 -> fails by the value itself)', JSON.stringify(b5b.categoryAsa?.B));

    // b6: every category own -> there is no pooled gate
    const b6 = ev(rs5(() => mkRep({ A: { asa: 20, elig: 10 }, B: { asa: 40, elig: 10 } }, 999)), [own('A', 30), own('B', 50)]);
    assert(b6.passesBoAsaCap === true, 'D82.b6 all categories own: the (absurd) pooled 999 is not judged; each is held to its own target', JSON.stringify({ c: b6.passesBoAsaCap }));
    // b7: ASA gate off -> the flag is ignored
    const b7 = ev(rs5(() => mkRep({ A: { asa: 40, elig: 10 }, B: { asa: 20, elig: 10 } })), [own('A', 30), fol('B')], { ...slaA, boAsaEnabled: false });
    assert(b7.passesBoAsaCap === true && b7.passesAllConstraints === true && b7.failingReasons.length === 0, 'D82.b7 answer-time off: a ticked own target is ignored', JSON.stringify(b7.failingReasons));
    // b8: R = 1 uses the value itself
    const b8 = ev([mkRep({ A: { asa: 29, elig: 10 }, B: { asa: 10, elig: 10 } })], [own('A', 30), fol('B')]);
    const b8f = ev([mkRep({ A: { asa: 31, elig: 10 }, B: { asa: 10, elig: 10 } })], [own('A', 30), fol('B')]);
    assert(b8.passesBoAsaCap === true && b8f.passesBoAsaCap === false, 'D82.b8 one replication: the value itself is compared (29 passes, 31 fails)', `${b8.passesBoAsaCap}/${b8f.passesBoAsaCap}`);
    // b9: two failing own categories -> reasons in name order, all starting "BO ASA"
    const b9 = ev(rs5(() => mkRep({ B: { asa: 50, elig: 10 }, A: { asa: 40, elig: 10 } })), [own('B', 20), own('A', 30)]);
    assert(b9.failingReasons.length === 2 && b9.failingReasons[0].startsWith("BO ASA (category 'A')") && b9.failingReasons[1].startsWith("BO ASA (category 'B')"), 'D82.b9 two own categories missed: two reasons, category-name order, both start with "BO ASA"', b9.failingReasons.join(' | '));
    // b10: no own category -> exactly today's gate (reason text, no extra fields)
    const b10 = ev(rs5(() => mkRep({ A: { asa: 70, elig: 10 }, B: { asa: 70, elig: 10 } })), [fol('A'), fol('B')]);
    assert(b10.passesBoAsaCap === false && b10.failingReasons.length === 2 && b10.failingReasons[0] === "BO ASA (category 'A') 95% CI [70m, 70m] upper bound > target 60minutes (60m) (Mean: 70m)" && b10.failingReasons[1].startsWith("BO ASA (category 'B')"), 'D82.b10 nothing ticked, answer time on: every category is judged against the global target on its own (one reason each, names the category)', JSON.stringify(b10.failingReasons));
    // b11: no averaging: pooled mean is fine (about 19) but category A alone is not
    const b11 = ev(rs5(() => mkRep({ A: { asa: 90, elig: 1 }, B: { asa: 10, elig: 100 } })), [fol('A'), fol('B')]);
    assert(b11.passesBoAsaCap === false && b11.categoryAsa?.A?.passes === false && b11.categoryAsa?.B?.passes === true && b11.failingReasons.length === 1, 'D82.b11 no pooled gate: a thin category at 90 fails the global 60 although the all-category mean is about 10', JSON.stringify(b11.failingReasons));
  }

  // ---- fixtures for the searches: two categories, flat 5-day business week, answer-time global 240 min (not binding) ----
  const fx82 = (ownFast?: number, o: { globalT?: number; globalUnit?: 'minutes' | 'hours'; copyFast?: number; copyUnit?: 'minutes' | 'hours'; ownSlow?: number; userMaxHC?: number; asaOn?: boolean } = {}) => {
    const ivs: StandardInterval[] = [];
    for (const category of ['Fast', 'Slow']) for (let day = 0; day < 5; day++) for (let hr = 9; hr < 17; hr++) for (let m = 0; m < 60; m += 30) ivs.push({ intervalIndex: ivs.length, start: new Date(2026, 2, 2 + day, hr, m), end: new Date(2026, 2, 2 + day, hr, m + 30), volume: 10, category });
    const gT = o.globalT ?? 240; const gU = o.globalUnit ?? 'minutes';
    const cat = (id: string, name: string, aht: number, pr: number, extra: Record<string, unknown>) => ({ id, name, ahtMinutes: aht, shrinkagePct: 0.2, priority: pr, primaryPct: 80, primaryWindow: 4, primaryUnit: 'hours', ...extra }) as CategoryConfig;
    const categories: CategoryConfig[] = [
      cat('f', 'Fast', 15, 1, ownFast !== undefined ? { boAsaTarget: ownFast, boAsaUnit: 'minutes', boAsaOwn: true } : o.copyFast !== undefined ? { boAsaTarget: o.copyFast, boAsaUnit: o.copyUnit ?? 'minutes' } : {}),
      cat('s', 'Slow', 30, 2, o.ownSlow !== undefined ? { boAsaTarget: o.ownSlow, boAsaUnit: 'minutes', boAsaOwn: true } : {}),
    ];
    const sla: SLAPolicyConfig = { primaryPct: 80, primaryWindow: 4, primaryUnit: 'hours', boAsaEnabled: o.asaOn ?? true, boAsaTarget: gT, boAsaUnit: gU, asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'next_open', occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 90, minCoverageEnabled: false };
    return { intervals: ivs, openingWIP: [] as OpeningWIPCase[], categories, calendar: { ...BIZ_CAL }, labor: { ...LABOR }, sla, seed: 7, userMaxHC: o.userMaxHC ?? 80, replications: 5, queueArchitecture: 'pooled' as const };
  };
  const sig82 = (r: any): string => `${r.recommendedHC}|${r.staffing?.grossHCTotal}|${r.isInfeasible}|${r.infeasibleReason}|${r.bindingConstraintType}|${r.bindingConstraintDescription}|${r.infeasibleAdjacentWarning}|${JSON.stringify(r.searchHistory)}|${r.finalDESResult?.boAsaMeanMinutes}`;
  const stripAsa = (p: any) => ({ ...p, categories: p.categories.map((c: any) => { const { boAsaTarget, boAsaUnit, boAsaOwn, ...rest } = c; return rest; }) });

  // ---- D82.c a tighter own target raises the headcount; sync === async; the failing row names the category ----
  const base82: any = searchOptimalHC(fx82());
  const tight82: any = searchOptimalHC(fx82(5));
  const tight82a: any = await searchOptimalHCAsync(fx82(5));
  assert(base82.recommendedHC !== null && tight82.recommendedHC !== null && tight82.recommendedHC > base82.recommendedHC, 'D82.c1 Fast ticked own 5 min (global 240, not binding): recommended HC rises above the no-own answer', `base=${base82.recommendedHC} own5=${tight82.recommendedHC}`);
  assert(sig82(tight82) === sig82(tight82a), 'D82.c2 sync === async with an own target (HC, reasons, labels, full history)', `sync=${tight82.recommendedHC} async=${tight82a.recommendedHC}`);
  const rowBelow82 = (tight82.searchHistory as any[]).find((x) => x.hc === tight82.recommendedHC - 1);
  assert(!!rowBelow82 && rowBelow82.passed === false && rowBelow82.failingReasons.some((x: string) => x.startsWith("BO ASA (category 'Fast')")), 'D82.c3 the row one below the recommendation fails with "BO ASA (category \'Fast\') ..."', JSON.stringify(rowBelow82?.failingReasons));
  assert(tight82.bindingConstraintType === 'bo_asa_cap' && /Fast/.test(tight82.bindingConstraintDescription) && /5/.test(tight82.bindingConstraintDescription), 'D82.c4 the binding-constraint label names the category and its own target', `${tight82.bindingConstraintType}: ${tight82.bindingConstraintDescription}`);
  // c6: a LOOSER own target for the slow-answering category: global 3 min binds on the others only
  {
    const allGlobal: any = searchOptimalHC(fx82(undefined, { globalT: 3 }));
    const fastLoose: any = searchOptimalHC(fx82(240, { globalT: 3 }));
    assert(allGlobal.recommendedHC !== null && fastLoose.recommendedHC !== null && fastLoose.recommendedHC < allGlobal.recommendedHC, 'D82.c6a Fast ticked own 240 while the global is 3: Slow alone is held to 3 -> fewer agents than when both follow 3', `follow=${allGlobal.recommendedHC} fastOwn=${fastLoose.recommendedHC}`);
    assert(fastLoose.finalDESResult.passesBOASA === false && fastLoose.infeasibleAdjacentWarning === undefined, 'D82.c6b the single-run pooled flag is false (Fast is slow) but no "fell slightly below target" warning appears: the check uses the resolved targets', `passesBOASA=${fastLoose.finalDESResult.passesBOASA} warn=${fastLoose.infeasibleAdjacentWarning}`);
    const sharedBind: any = searchOptimalHC(fx82(240, { globalT: 1 }));
    const sharedBindA: any = await searchOptimalHCAsync(fx82(240, { globalT: 1 }));
    assert(sharedBind.bindingConstraintType === 'bo_asa_cap' && /category 'Slow' \(global target/.test(sharedBind.bindingConstraintDescription) && sharedBind.bindingConstraintDescription === sharedBindA.bindingConstraintDescription, 'D82.c6c Fast ticked own 240, global 1: Slow (global target) is what stopped N-1, and the binding-constraint label names it (sync = async)', `${sharedBind.bindingConstraintType}: ${sharedBind.bindingConstraintDescription} | ${sharedBindA.bindingConstraintDescription}`);
    assert(tight82.categoryAsa?.Fast?.own === true && tight82.categoryAsa?.Fast?.judged === true && tight82.categoryAsa?.Fast?.passes === true && base82.categoryAsa?.Fast?.own === false && base82.categoryAsa?.Fast?.target === 240, 'D82.c8 the search result carries the statistical per-category verdict (Results reads it): Fast own and met in the ticked run, global 240 in the unticked run', JSON.stringify([tight82.categoryAsa?.Fast, base82.categoryAsa?.Fast]));
  }
  // c7: an own target that cannot be met within the cap -> infeasible, the message names the category
  {
    const inf: any = searchOptimalHC(fx82(0.01, { userMaxHC: 18 }));
    const infA: any = await searchOptimalHCAsync(fx82(0.01, { userMaxHC: 18 }));
    assert(inf.isInfeasible === true && /BO ASA \(category 'Fast'\)/.test(inf.infeasibleReason ?? ''), 'D82.c7a unattainable own target within the cap -> infeasible and the wording names category Fast', inf.infeasibleReason);
    assert(infA.isInfeasible === true && infA.infeasibleReason === inf.infeasibleReason, 'D82.c7b sync === async infeasible wording', `${inf.infeasibleReason} | ${infA.infeasibleReason}`);
  }

  // ---- D82.d nothing ticked -> identical to today ----
  {
    const cp = fx82(undefined, { copyFast: 5, copyUnit: 'hours' });
    const rCopy: any = searchOptimalHC(cp);
    const rStripped: any = searchOptimalHC(stripAsa(cp));
    assert(sig82(rCopy) === sig82(rStripped) && rCopy.recommendedHC === base82.recommendedHC, 'D82.d1 Fast holds 5 hours as an unticked copy: the whole result is identical to the categories with no value at all (and to the baseline)', `copy=${rCopy.recommendedHC} stripped=${rStripped.recommendedHC}`);
    // older settings file (no boAsaOwn key at all) -> same
    const old = { ...cp, categories: JSON.parse(JSON.stringify(cp.categories)) };
    assert(sig82(searchOptimalHC(old)) === sig82(rCopy) && !old.categories.some((c: any) => 'boAsaOwn' in c), 'D82.d2 a settings file without the boAsaOwn key gives the same result', '');
    // global changed after load: copies (240 min) follow the NEW global
    const g3copies = fx82(undefined, { globalT: 3, copyFast: 240 });
    const g3 = fx82(undefined, { globalT: 3 });
    const rg3c: any = searchOptimalHC(g3copies); const rg3: any = searchOptimalHC(stripAsa(g3));
    assert(sig82(rg3c) === sig82(rg3) && rg3c.recommendedHC > base82.recommendedHC, 'D82.d3 global lowered to 3 after the copies were made (240): copies follow, same answer as no copies, higher than the 240 answer', `copies=${rg3c.recommendedHC} stripped=${rg3.recommendedHC} base=${base82.recommendedHC}`);
    // unit-only change of the global: 0.05 hours = 3 min, copies say minutes
    const gu = fx82(undefined, { globalT: 0.05, globalUnit: 'hours', copyFast: 240, copyUnit: 'minutes' });
    assert(sig82(searchOptimalHC(gu)).split('|').slice(0, 3).join('|') === sig82(rg3).split('|').slice(0, 3).join('|'), 'D82.d4 only the global unit changed (0.05 hours = 3 min): copies follow it; same headcount and verdict as global 3 minutes', '');
    // answer-time off: a ticked value changes nothing
    const offTick: any = searchOptimalHC(fx82(5, { asaOn: false }));
    const offBase: any = searchOptimalHC(fx82(undefined, { asaOn: false }));
    assert(sig82(offTick) === sig82(offBase), 'D82.d5 answer-time OFF: a ticked own target changes nothing', `${offTick.recommendedHC} vs ${offBase.recommendedHC}`);
    // the three built-in samples: ticked-nothing categories (default copies, Claims_Life 90) == values stripped, at fixed headcounts, ASA on and off
    for (const [st, n] of [['claims', 31], ['support', 40], ['healthcare', 30]] as const) {
      const { rows } = buildSampleDataset(st, new Date(2026, 9, 5, 8, 0, 0, 0));
      const ivs = mapRawRecordsToIntervals(rows, { intervalStartCol: 'IntervalStart', volumeCol: 'Volume', categoryCol: 'Category' } as any);
      const withCopies = st === 'claims' ? DEFAULT_CATEGORIES : discoverAndSyncCategories(ivs, DEFAULT_CATEGORIES, DEFAULT_SLA);
      const stripped = withCopies.map((c: any) => { const { boAsaTarget, boAsaUnit, boAsaOwn, ...rest } = c; return rest as CategoryConfig; });
      for (const on of [true, false]) {
        const run = (cats: CategoryConfig[]) => { const r: any = evaluateCandidateStatistical({ operationalHC: n, intervals: ivs, openingWIP: [], categories: cats, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: { ...DEFAULT_SLA, boAsaEnabled: on, boAsaTarget: 60 }, baseSeed: DEFAULT_SIM_PARAMS.seed, replications: 4, queueArchitecture: 'pooled', dispatchFairness: DEFAULT_SIM_PARAMS.dispatchFairness }); return JSON.stringify([r.primaryStats, r.failingReasons, r.passesAllConstraints, r.passesOrgGates, r.categoryPasses, r.passesBoAsaCap, r.categoryAsa, r.followersAsa]); };
        assert(run(withCopies) === run(stripped), `D82.d6 sample ${st}, N=${n}, answer-time ${on ? 'on (60)' : 'off'}: default copies (e.g. Claims_Life 90) give the same statistical evaluation as no copies`, '');
      }
    }
  }

  // ---- D82.e a ticked Claims_Life on the default sample: Life judged alone at 90, the other two share the global 60 ----
  {
    const { rows } = buildSampleDataset('claims', new Date(2026, 9, 5, 8, 0, 0, 0));
    const ivs = mapRawRecordsToIntervals(rows, { intervalStartCol: 'IntervalStart', volumeCol: 'Volume', categoryCol: 'Category' } as any);
    const ticked = DEFAULT_CATEGORIES.map((c) => (c.name === 'Claims_Life' ? { ...c, boAsaOwn: true } : c));
    const r: any = evaluateCandidateStatistical({ operationalHC: 31, intervals: ivs, openingWIP: [], categories: ticked, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: { ...DEFAULT_SLA, boAsaEnabled: true, boAsaTarget: 60 }, baseSeed: DEFAULT_SIM_PARAMS.seed, replications: 4, queueArchitecture: 'pooled', dispatchFairness: DEFAULT_SIM_PARAMS.dispatchFairness });
    assert(r.categoryAsa?.Claims_Life?.own === true && r.categoryAsa?.Claims_Life?.target === 90 && r.categoryAsa?.Claims_Auto?.own === false && r.categoryAsa?.Claims_Auto?.target === 60 && r.categoryAsa?.Claims_Home?.target === 60, 'D82.e1 ticking Claims_Life (value 90 from the defaults): it is judged at 90, Claims_Auto / Claims_Home each at the global 60', JSON.stringify(r.categoryAsa));
  }

  // ---- D82.f the polish/"BO ASA" invariant of D77.2b holds with own targets, across a sweep ----
  {
    const p = fx82(5);
    let consistent = true; let sawFail = false; let sawPass = false; let sawOwnReason = false;
    for (const n of [12, 15, 18, 22, 30]) {
      const r: any = evaluateCandidateStatistical({ operationalHC: n, intervals: p.intervals, openingWIP: [], categories: p.categories, calendar: p.calendar, labor: p.labor, sla: p.sla, baseSeed: 42, replications: 4 });
      const fr: string[] = r.failingReasons;
      if (r.passesBoAsaCap !== !fr.some((x) => x.startsWith('BO ASA'))) consistent = false;
      if (r.passesBoAsaCap === false) sawFail = true; else sawPass = true;
      if (fr.some((x) => x.startsWith("BO ASA (category 'Fast')"))) sawOwnReason = true;
      if (r.categoryAsa?.Fast?.passes === false && r.categoryPasses.Fast !== false) consistent = false;
    }
    assert(consistent && sawFail && sawPass && sawOwnReason, 'D82.f the BO ASA flag agrees with the "BO ASA" reasons at every swept N (own category failing and passing both occur); a failing own category is false in categoryPasses', `consistent=${consistent} fail=${sawFail} pass=${sawPass}`);
  }

  // ---- D82.g planner-facing text is in the screens ----
  {
    const cfgSrc = readFileSync(resolve(import.meta.dirname, '../src/components/ConfigFlow.tsx'), 'utf8');
    const resSrc = readFileSync(resolve(import.meta.dirname, '../src/components/ResultsFlow.tsx'), 'utf8');
    assert(cfgSrc.includes('Own target') && cfgSrc.includes('follows global') && cfgSrc.includes('boAsaOwn'), 'D82.g1 Config: each category has an "Own target" tick; unticked shows "follows global"', '');
    assert(cfgSrc.includes('Each category must meet its answer-time target on its own (its own target if ticked, otherwise the global target).') && resSrc.includes('Each category must meet its answer-time target on its own (its own target if ticked, otherwise the global target).'), 'D82.g2 the rule sentence is shown in Config and in Results', '');
    assert(!/shared pool|categories without their own target|share the global target/.test(cfgSrc + resSrc), 'D82.g4 no text about a shared pool or a shared-pool rule remains in the screens', '');
    assert(/boAsaOwn: false/.test(cfgSrc), 'D82.g3 "Apply Template to All Categories" sets every category back to follow the global target', '');
  }
}

// ---------------------------------------------------------------------------
// Suite D83 - Item 4 (G9 / DES-10): the drain runs until the last deadline (owner decision 2026-10-15; challenge amendments G1-G9 2026-10-16)
// drain end = min( max(horizon end + 14 calendar days, latest finite primaryDeadline of the run's cases), horizon end + 366 days ).
// The same value drives the day-open/close scheduling, SimulationEnd and the unfinished-case count; computed once per run from the case
// array (same for every candidate N, CRN preserved). Non-finite deadlines are skipped. drainCapped is true on the result when the cap bit.
// Occupancy denominator (planned horizon), N_min, N_occ and Gross HC are untouched (frozen decision 3).
// Fail-first (pre-change): D83.a (12, not 8), D83.b (6 / 4, not 10 / 0), D83.d (async 12), D83.g (5 censored, not 3), D83.h1 (6 finish),
// D83.i1 / D83.i3 (field absent), D83.j2 (timeline ends at the old drain end); D59.1-3 redesigned (see D59). Controls that hold before and after:
// D83.c, D83.e, D83.f, D83.h2, D83.i2, D83.j1 / j3.
// ---------------------------------------------------------------------------
console.log('\n--- Suite D83: the drain runs until the last deadline (Item 4 / G9 / DES-10) ---');
{
  const at83 = (mo: number, d: number, h: number, m: number = 0) => new Date(2026, mo, d, h, m);
  const mkCases83 = (n: number, aht: number, deadline: Date): any[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `U${i}`, syntheticId: i + 1, category: 'A', priority: 1,
      arrival: at83(9, 12, 9), clockStart: at83(9, 12, 9),
      totalAhtMinutes: aht, remainingWorkMinutes: aht,
      primaryDeadline: deadline, latestSafeStart: at83(9, 12, 9),
      firstStartTime: null, completeTime: null, parkCount: 0, isOpeningWip: false,
    }));
  const cat83 = (aht: number): CategoryConfig[] => [{ id: 'a', name: 'A', ahtMinutes: aht, shrinkagePct: 0.2, priority: 1, primaryWindowMinutes: 100000 }];
  const run83 = (cases: any[], aht: number, full: boolean = false): any =>
    runBackofficeDES({
      operationalHC: 1, intervals: [], openingWIP: [], categories: cat83(aht), calendar: BIZ_CAL, labor: LABOR, sla: { ...DEFAULT_SLA }, seed: 7,
      skipCaseResultsAndTimeline: !full,
      precomputedCases: { cases, horizonStart: at83(9, 12, 9), horizonEnd: at83(9, 12, 17) },
    });
  const NOV20 = at83(10, 20, 17);

  // ---- D83.a / D83.d / D83.f the holiday repro (vol 20, AHT 33, 5-day window; 8 holidays after the horizon push deadlines past the old drain end) ----
  const HOLS83 = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26', '2026-10-27', '2026-10-28'];
  const mkIv83 = (): StandardInterval[] => {
    const out: StandardInterval[] = [];
    let idx = 0;
    for (const d of [5, 15, 16]) {
      for (let i = 0; i < 20; i++) {
        const s = new Date(2026, 9, d, 8, i * 30);
        out.push({ intervalIndex: idx++, start: s, end: new Date(s.getTime() + 30 * 60000), volume: d === 5 ? (i === 0 ? 1 : 0) : 20, category: 'A' } as StandardInterval);
      }
    }
    return out;
  };
  const sla83: SLAPolicyConfig = { ...DEFAULT_SLA, primaryWindow: 5, primaryUnit: 'days', clockBasis: 'business_time', clockStartPolicy: 'next_open' } as SLAPolicyConfig;
  const iv83 = mkIv83();
  const cats83 = discoverAndSyncCategories(iv83, [{ ...DEFAULT_CATEGORIES[0], id: 'a', name: 'A', ahtMinutes: 33, primaryWindow: 5, primaryUnit: 'days' } as CategoryConfig], sla83);
  const p83 = (hol: boolean) => ({ intervals: iv83, openingWIP: [] as OpeningWIPCase[], categories: cats83, calendar: { ...DEFAULT_CALENDAR, holidays: hol ? HOLS83 : [] }, labor: DEFAULT_LABOR, sla: sla83, seed: 12345, userMaxHC: 100, replications: 5, queueArchitecture: 'pooled' as const });
  const sig83 = (r: any): string => `${r.recommendedHC}|${r.staffing?.grossHCTotal}|${r.isInfeasible}|${r.finalDESResult?.primaryAchievedPct}|${r.finalDESResult?.occupancyPct}|${r.finalDESResult?.unfinishedCases}|${JSON.stringify(r.searchHistory)}`;
  const noHol: any = searchOptimalHC(p83(false));
  const withHol: any = searchOptimalHC(p83(true));
  assert(noHol.recommendedHC === 8 && withHol.recommendedHC === 8, 'D83.a1 vol 20: 8 HC with and without 8 holidays after the horizon (holidays push deadlines past the old drain end; it used to give 12)', `no holidays ${noHol.recommendedHC}, holidays ${withHol.recommendedHC}`);
  assert(withHol.staffing?.grossHCTotal === noHol.staffing?.grossHCTotal && withHol.finalDESResult?.primaryAchievedPct === noHol.finalDESResult?.primaryAchievedPct, 'D83.a2 the holiday run has the same gross HC and the same SLA % in the recommended result (a case still open at its own deadline is a miss whether it is counted late or unfinished)', `gross ${withHol.staffing?.grossHCTotal}/${noHol.staffing?.grossHCTotal}, SLA ${withHol.finalDESResult?.primaryAchievedPct}/${noHol.finalDESResult?.primaryAchievedPct}`);
  const withHolA: any = await searchOptimalHCAsync(p83(true));
  assert(sig83(withHolA) === sig83(withHol) && withHolA.recommendedHC === 8, 'D83.d sync === async on the holiday repro (HC, gross, verdict, figures, full search history)', `sync=${withHol.recommendedHC} async=${withHolA.recommendedHC}`);
  const withHol2: any = searchOptimalHC(p83(true));
  assert(sig83(withHol2) === sig83(withHol), 'D83.f determinism: two sync runs of the holiday repro are byte-identical (HC, gross, figures, search history)', '');

  // ---- D83.b a case due after horizon + 14 days and finished before its deadline is met, not unfinished ----
  {
    const r = run83(mkCases83(10, 800, NOV20), 800, true);
    const lastDone = Math.max(...(r.caseResults as any[]).filter((c) => c.isCompleted).map((c) => c.completeTime.getTime()));
    assert(r.completedCases === 10 && r.unfinishedCases === 0, 'D83.b1 10 x 800 min, 1 agent, all due Fri 20 Nov: all 10 finish (8000 min = 16.7 working days), none counted unfinished', `completed ${r.completedCases}, unfinished ${r.unfinishedCases}`);
    assert(r.primaryEligibleCount === 10 && r.primaryPassCount === 10 && r.primaryAchievedPct === 100, 'D83.b2 all 10 met their deadline: 10 / 10 = 100 %', `eligible ${r.primaryEligibleCount}, pass ${r.primaryPassCount}, pct ${r.primaryAchievedPct}`);
    assert(lastDone > at83(9, 26, 17).getTime() && lastDone <= NOV20.getTime(), 'D83.b3 the last case finished after the old drain end (Mon 26 Oct 17:00) and before its deadline', new Date(lastDone).toISOString());
  }

  // ---- D83.c deadlines earlier than horizon + 14 days: drain end unchanged (Mon 26 Oct 17:00 = 11 working days) ----
  {
    const r = run83(mkCases83(10, 800, at83(9, 20, 17)), 800, true);
    assert(r.completedCases === 6 && r.unfinishedCases === 4, 'D83.c1 all deadlines earlier than horizon + 14 days (Tue 20 Oct): the drain still ends at horizon + 14 days: floor(5280 / 800) = 6 finish, 4 unfinished (unchanged)', `completed ${r.completedCases}, unfinished ${r.unfinishedCases}`);
    assert(r.primaryPassCount === 4 && r.primaryAchievedPct === 40 && r.drainCapped !== true, 'D83.c2 only the 4 finished by Tue 20 Oct 17:00 are met (7 days x 480 / 800 = 4): 40 %; drain not capped', `pass ${r.primaryPassCount}, pct ${r.primaryAchievedPct}, capped ${r.drainCapped}`);
  }

  // ---- D83.e the three built-in samples and AJM_Only at defaults: headcount, gross and occupancy unchanged ----
  for (const [type, hc, gross, occ] of [['claims', 31, 40, 99.1], ['support', 28, 35, 74.9], ['healthcare', 31, 39, 58.9]] as Array<['claims' | 'support' | 'healthcare', number, number, number]>) {
    const { rows } = buildSampleDataset(type, new Date(2026, 9, 5, 8, 0, 0, 0));
    const ivs = mapRawRecordsToIntervals(rows, { intervalStartCol: 'IntervalStart', volumeCol: 'Volume', categoryCol: 'Category' } as any);
    const cats = discoverAndSyncCategories(ivs, DEFAULT_CATEGORIES, DEFAULT_SLA);
    const r: any = searchOptimalHC({ intervals: ivs, openingWIP: [], categories: cats, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: DEFAULT_SLA, seed: DEFAULT_SIM_PARAMS.seed, userMaxHC: DEFAULT_SIM_PARAMS.maxHCSearch, replications: DEFAULT_SIM_PARAMS.replications, queueArchitecture: 'pooled', dispatchFairness: DEFAULT_SIM_PARAMS.dispatchFairness });
    assert(r.recommendedHC === hc && r.staffing.grossHCTotal === gross && r.finalDESResult?.occupancyPct === occ && r.finalDESResult?.drainCapped !== true, `D83.e ${type} sample (defaults): HC ${hc} / gross ${gross} / occupancy ${occ} % unchanged by the longer drain`, `got ${r.recommendedHC}/${r.staffing.grossHCTotal}/${r.finalDESResult?.occupancyPct}`);
  }

  // ---- D83.g answer time: a case that starts inside the longer drain has its real wait counted; one that never starts stays censored ----
  {
    const r = run83(mkCases83(10, 1100, at83(9, 30, 17)), 1100, true);
    assert(r.boAsaCensoredCount === 3 && r.completedCases === 6, 'D83.g1 10 x 1100 min due Fri 30 Oct (drain to Fri 30 Oct 17:00): 7 cases start (6 done + 1 in progress), only the 3 that never start are censored (was 5 at the old drain end)', `censored ${r.boAsaCensoredCount}, completed ${r.completedCases}`);
    const startedWaits = (r.caseResults as any[]).filter((c) => !c.asaCensored).length;
    assert(startedWaits === 7, 'D83.g2 7 cases carry a real (uncensored) wait', `uncensored ${startedWaits}`);
  }

  // ---- D83.h a non-finite deadline is skipped: agents still work and the result equals the run where that case simply fails ----
  {
    const nan = mkCases83(10, 800, NOV20);
    nan[0] = { ...nan[0], primaryDeadline: new Date(NaN) };
    const early = mkCases83(10, 800, NOV20);
    early[0] = { ...early[0], primaryDeadline: at83(9, 13, 9) };
    const a = run83(nan, 800, true);
    const b = run83(early, 800, true);
    assert(a.completedCases === 10 && a.completedCases === b.completedCases && a.primaryPassCount === b.primaryPassCount && a.primaryPassCount === 9 && a.drainCapped !== true, 'D83.h1 one NaN deadline: the other 9 deadlines still set the drain (all 10 finish), equals the run where that case simply has an impossible deadline; not capped', `nan: ${a.completedCases}/${a.primaryPassCount}, early: ${b.completedCases}/${b.primaryPassCount}, capped ${a.drainCapped}`);
    const allNaN = mkCases83(10, 800, new Date(NaN));
    const c = run83(allNaN, 800, true);
    assert(c.completedCases === 6 && c.unfinishedCases === 4 && c.drainCapped !== true, 'D83.h2 every deadline NaN: the drain falls back to horizon + 14 days (6 finish, 4 unfinished), no crash, no hang', `completed ${c.completedCases}, unfinished ${c.unfinishedCases}`);
  }

  // ---- D83.i a far-future deadline is capped at horizon end + 366 days and flagged ----
  {
    const far = mkCases83(10, 800, new Date(2030, 0, 4, 17, 0));
    const r = run83(far, 800, true);
    assert(r.drainCapped === true && r.completedCases === 10 && r.unfinishedCases === 0, 'D83.i1 a deadline in 2030 (beyond horizon end + 366 days): the run proceeds with the cap, drainCapped is true, the cases still finish', `capped ${r.drainCapped}, completed ${r.completedCases}`);
    const near = run83(mkCases83(10, 800, NOV20), 800, true);
    assert(near.drainCapped !== true, 'D83.i2 a deadline inside the cap leaves drainCapped unset / false', `capped ${near.drainCapped}`);
    // a deadline well beyond the cap that no agent could reach: 40000-min cases, 1 agent, would need more than a year -> the cap still ends the run
    const slow = run83(mkCases83(10, 40000, new Date(2030, 0, 4, 17, 0)), 40000, true);
    assert(slow.drainCapped === true && slow.completedCases < 10 && slow.unfinishedCases === 10 - slow.completedCases, 'D83.i3 undersized run to a far-future deadline: stops at the cap, unfinished cases counted as before', `completed ${slow.completedCases}, unfinished ${slow.unfinishedCases}`);
  }

  // ---- D83.k the cap flag reaches the search output (sync and async), so Results can show the note (rework 1, R2) ----
  {
    const slaFar: SLAPolicyConfig = { ...sla83, primaryWindow: 300, primaryUnit: 'days' } as SLAPolicyConfig;
    const catsFar = discoverAndSyncCategories(iv83, [{ ...DEFAULT_CATEGORIES[0], id: 'a', name: 'A', ahtMinutes: 33, primaryWindow: 300, primaryUnit: 'days' } as CategoryConfig], slaFar);
    const pFar = { ...p83(false), categories: catsFar, sla: slaFar };
    const farS: any = searchOptimalHC(pFar);
    const farA: any = await searchOptimalHCAsync(pFar);
    assert(farS.finalDESResult?.drainCapped === true && farA.finalDESResult?.drainCapped === true, 'D83.k2 a 300-working-day answer window: searchOutput.finalDESResult.drainCapped is true for sync and async', `sync ${farS.finalDESResult?.drainCapped}, async ${farA.finalDESResult?.drainCapped}`);
    assert(noHol.finalDESResult?.drainCapped !== true, 'D83.k1 the ordinary holiday-free repro leaves drainCapped unset in the search output', `capped ${noHol.finalDESResult?.drainCapped}`);
  }

  // ---- D83.j undersized long-window run: the agent timeline extends to the longer drain and the invariants hold ----
  {
    const cases = mkCases83(10, 1100, at83(9, 30, 17));
    const r = run83(cases, 1100, true);
    const inv = verifyAgentTimelineInvariants(r, LABOR, BIZ_CAL);
    const lastBusy = Math.max(...(r.agentTimeline as any[]).filter((s) => s.state === 'busy').map((s) => s.to.getTime()));
    assert(inv.valid, 'D83.j1 undersized run to Fri 30 Oct: timeline invariants hold (contiguous, no overlap, busy sum = handling minutes, daily budget)', inv.errors.slice(0, 3).join(' | '));
    assert(lastBusy > at83(9, 26, 17).getTime() && lastBusy <= at83(9, 30, 17).getTime(), 'D83.j2 the agent keeps working past the old drain end (busy slices to Fri 30 Oct)', new Date(lastBusy).toISOString());
    assert(r.totalAvailableProductiveMinutes === 480, 'D83.j3 occupancy denominator is still the planned horizon (1 agent x 1 working day x 480 min) - frozen decision 3; the longer drain does not widen it', `available ${r.totalAvailableProductiveMinutes}, raw occupancy ${r.rawOccupancyPct}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Suite D84 - Item 5 (G10 / DES-7): a blank "remaining work" in the manual backlog form means the full handling time
// (owner decision 2026-10-15; amendments H1-H8 2026-10-16). Pure helper src/utils/wip-row.ts; engine unchanged.
// ---------------------------------------------------------------------------------------------------------------------
console.log('\n--- Suite D84: manual backlog row, blank remaining = full handling time (Item 5 / G10 / DES-7) ---');
{
  const cats84: CategoryConfig[] = [{ id: 'a', name: 'Alpha', ahtMinutes: 45, shrinkagePct: 0.2, priority: 2, primaryWindow: 2, primaryUnit: 'days' } as CategoryConfig];
  const arr84 = new Date(2026, 9, 12, 9, 0);
  const iv84: StandardInterval[] = [{ intervalIndex: 0, start: new Date(2026, 9, 12, 9, 0), end: new Date(2026, 9, 12, 9, 30), volume: 1, category: 'Alpha' } as StandardInterval];
  const sla84: SLAPolicyConfig = { ...DEFAULT_SLA, primaryWindow: 2, primaryUnit: 'days', clockBasis: 'business_time', clockStartPolicy: 'next_open' } as SLAPolicyConfig;
  const gen84 = (wip: OpeningWIPCase[], cats: CategoryConfig[] = cats84): CaseEntity[] =>
    generateCaseEntities({ intervals: iv84, openingWIP: wip, categories: cats, calendar: BIZ_CAL, sla: sla84, seed: 42 }).cases.filter((c: CaseEntity) => c.isOpeningWip);
  const mk84 = (rem: unknown, name: string = 'Alpha') => buildManualWipCase({ id: 'WIP-0001', categoryName: name, categories: cats84, remainingMinutes: rem, arrival: arr84 });

  // a: the blank form builds a row with no remaining value (undefined), category/priority resolved
  const blank = mk84(undefined);
  assert(blank.remainingWorkMinutes === undefined && blank.category === 'Alpha' && blank.priority === 2 && blank.arrival.getTime() === arr84.getTime(), 'D84.a1 blank remaining -> row has remainingWorkMinutes undefined (not 30)', `rem ${blank.remainingWorkMinutes}`);
  const unknown = mk84(undefined, 'Nope');
  assert(unknown.remainingWorkMinutes === undefined && unknown.category === 'Nope' && unknown.priority === 1, 'D84.a2 unknown category: still undefined (no 30 fallback), category as typed, priority 1', `rem ${unknown.remainingWorkMinutes}`);

  // b: the engine treats the blank row as full handling time, not part-worked
  const eb = gen84([blank]);
  assert(eb.length === 1 && eb[0].remainingWorkMinutes === 45 && eb[0].totalAhtMinutes === 45 && eb[0].parkCount === 0, 'D84.b1 engine: blank row -> remaining == full AHT (45), no in-progress priority', `rem ${eb[0]?.remainingWorkMinutes}/${eb[0]?.totalAhtMinutes}`);
  // editing the category AHT afterwards: a blank row follows the new AHT and never becomes part-worked
  const cats84b: CategoryConfig[] = [{ ...cats84[0], ahtMinutes: 20 } as CategoryConfig];
  const eb2 = gen84([blank], cats84b);
  assert(eb2[0].remainingWorkMinutes === 20 && eb2[0].totalAhtMinutes === 20, 'D84.b2 blank row follows a later AHT edit (45 -> 20): still full, not part-worked', `rem ${eb2[0]?.remainingWorkMinutes}/${eb2[0]?.totalAhtMinutes}`);

  // c: explicit 10 < AHT keeps in-progress priority
  const ten = mk84(10);
  const ec = gen84([ten]);
  assert(ten.remainingWorkMinutes === 10 && ec[0].remainingWorkMinutes === 10 && ec[0].remainingWorkMinutes < ec[0].totalAhtMinutes, 'D84.c1 typed 10 is kept and reaches the engine as part-worked (10 < 45)', `rem ${ec[0]?.remainingWorkMinutes}`);
  assert(mk84(0).remainingWorkMinutes === undefined && mk84(-5).remainingWorkMinutes === undefined && mk84(NaN).remainingWorkMinutes === undefined && mk84('abc').remainingWorkMinutes === undefined && mk84(null).remainingWorkMinutes === undefined, 'D84.c2 typed 0 / -5 / NaN / text / null -> undefined (treated as blank)', '');
  assert(normalizeRemainingInput(60) === 60 && normalizeRemainingInput(Infinity) === undefined, 'D84.c3 value >= AHT (60) kept as typed; Infinity -> blank', '');

  // d: Total Pending Work uses the category AHT for blank rows
  const total = totalPendingWorkMinutes([blank, ten, { ...blank, id: 'WIP-0002', category: 'Nope' }], cats84);
  assert(total === 45 + 10 + 30, 'D84.d1 total pending: blank = category AHT (45), typed 10, unknown-category blank = 30 fallback (same as the data-quality workload check)', `total ${total}`);
  assert(totalPendingWorkMinutes([blank], cats84b) === 20, 'D84.d2 total pending follows the current AHT (20) for a blank row', '');

  // e: strict text parsing (K1/K3) - no silent digit-stripping; invalid input is flagged and stored as blank
  const pr = (t: string) => parseRemainingText(t);
  assert(pr('').value === undefined && !pr('').invalid && pr('  ').value === undefined && !pr('  ').invalid, 'D84.e1 "" and "  " -> blank, not invalid', '');
  assert(pr('10').value === 10 && !pr('10').invalid && pr('12.5').value === 12.5 && !pr('12.5').invalid, 'D84.e2 "10" -> 10, "12.5" -> 12.5 (decimals kept)', '');
  assert(pr('12,5').value === 12.5 && !pr('12,5').invalid, 'D84.e3 comma decimal "12,5" is supported -> 12.5', '');
  assert(['0', '-5', 'abc', '1e2', '12.5.3', '0.0'].every((t) => pr(t).value === undefined && pr(t).invalid), 'D84.e4 "0" / "-5" / "abc" / "1e2" / "12.5.3" / "0.0" -> undefined AND invalid', '');
  // f: table label (in progress only when below the category handling time)
  const lbl = (rem: number | undefined) => remainingWorkLabel({ ...blank, remainingWorkMinutes: rem }, cats84);
  assert(lbl(undefined) === 'full (45m)' && lbl(10) === '10m (in progress)' && lbl(12.5) === '12.5m (in progress)' && lbl(45) === '45m' && lbl(60) === '60m', 'D84.f1 label: blank "full (45m)", below AHT "(in progress)", equal/above AHT plain', `${lbl(undefined)} | ${lbl(10)} | ${lbl(45)} | ${lbl(60)}`);
}

// ---------------------------------------------------------------
// Suite D85 — rounding ties (Item 6, F4 / HC-1 + HC-5; PRD 1.27.3)
// A tiny floating-point error must never change a headcount. (1) Gross HC: an exact .5 total rounds UP
// whatever order the categories are listed in (the per-category gross-ups were added in list order, so
// 10 seats over unequal workloads at 20 % shrinkage summed to 12.4999999... in some orders -> 12, 12.5 in
// others -> 13). (2) N_min: an exact whole-number workload/capacity ratio floors to that whole number
// (123.75 h / 61.875 h = 1.9999999999999998 floored to 1). Tolerance is an absolute 1e-9 (double error is
// about 2e-16 x value, so 1e-9 is far above float noise and far below any real 0.01-scale difference).
// Frozen decision 7 (per-category gross-up, sum, one round) is unchanged.
// ---------------------------------------------------------------
console.log('\n--- Suite D85: rounding ties (Gross HC .5 and N_min exact ratio) ---');
{
  const permute85 = <T,>(a: T[]): T[][] => (a.length < 2 ? [a] : a.flatMap((x, i) => permute85([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
  const hs85 = new Date(2026, 9, 5, 9, 0);
  const he85 = new Date(2026, 9, 9, 17, 0);
  const grossOf85 = (hc: number, vols: Array<[string, number]>, shr = 0.2, labor: LaborConfig = LABOR) =>
    calculateStaffingRequirement({
      operationalHC: hc,
      categories: vols.map(([n], i) => ({ id: `c${i}`, name: n, ahtMinutes: 30, shrinkagePct: shr, priority: 1 })),
      intervals: vols.map(([n, v], i) => ({ intervalIndex: i, start: new Date(2026, 9, 5, 9, 0), end: new Date(2026, 9, 5, 9, 30), category: n, volume: v })),
      openingWIP: [],
      calendar: BIZ_CAL,
      labor,
      horizonStart: hs85,
      horizonEnd: he85,
      bindingConstraint: 'test',
    });

  // ---- a: order independence, all 120 category orders ----
  // Workloads 10:20:30:40:50 (volumes at equal handling time), 20 % shrinkage: 10 seats -> 12.5 exactly -> 13; 50 seats -> 62.5 -> 63.
  const base85: Array<[string, number]> = [['Billing', 10], ['Claims', 20], ['Refunds', 30], ['Disputes', 40], ['Transfers', 50]];
  for (const [hc, want] of [[10, 13], [50, 63]] as Array<[number, number]>) {
    const seen = new Map<number, number>();
    for (const order of permute85(base85)) {
      const g = grossOf85(hc, order).grossHCTotal;
      seen.set(g, (seen.get(g) ?? 0) + 1);
    }
    assert(seen.size === 1 && seen.has(want), `D85.a${hc} ${hc} seats, 5 categories (10:20:30:40:50) at 20 % shrinkage: gross ${want} in all 120 category orders`, `distribution gross->orders: ${JSON.stringify([...seen])}`);
  }

  // ---- b: N_min exact ratio ----
  const labor85 = { dailyProductiveHours: 7.5, adherencePct: 0.55, contractualHoursSource: 'derived' as const };
  const nMin85 = (w: number) => computeAnalyticalNMin({ totalWorkloadHours: w, labor: labor85, workingDaysInHorizon: 15, occupancyCapEnabled: false, occupancyCapPct: 100 });
  assert(nMin85(123.75) === 2, 'D85.b1 123.75 h / (7.5 h x 15 days x 0.55 adherence x cap 100 %) = exactly 2 -> N_min 2', `got ${nMin85(123.75)}`);
  assert(nMin85(61.875 * 1.9999999999) === 2, 'D85.b2 ratio 1.9999999999 (inside the 1e-9 tolerance) -> 2', `got ${nMin85(61.875 * 1.9999999999)}`);
  assert(nMin85(61.875 * 1.9999) === 1, 'D85.b3 ratio 1.9999 (a real shortfall) still floors to 1', `got ${nMin85(61.875 * 1.9999)}`);
  assert(nMin85(61.875 * 2.5) === 2 && nMin85(61.875 * 3) === 3, 'D85.b4 ratio 2.5 -> 2 (floor), ratio 3 -> 3', `got ${nMin85(61.875 * 2.5)}, ${nMin85(61.875 * 3)}`);

  // ---- d: Gross boundaries (one category, share 1, so the sum is exactly 10 / (1 - shr)) ----
  const grossAt85 = (target: number) => grossOf85(10, [['Only', 10]], 1 - 10 / target).grossHCTotal;
  assert(grossAt85(12.5 - 5e-10) === 13, 'D85.d1 12.5 - 5e-10 (float noise) -> 13', `got ${grossAt85(12.5 - 5e-10)}`);
  assert(grossAt85(12.5 - 1e-7) === 12, 'D85.d2 12.5 - 1e-7 (a real shortfall) -> 12', `got ${grossAt85(12.5 - 1e-7)}`);
  assert(grossAt85(12.49) === 12 && grossAt85(12.5) === 13 && grossAt85(12.51) === 13, 'D85.d3 12.49 -> 12, exactly 12.5 -> 13, 12.51 -> 13', `got ${grossAt85(12.49)}, ${grossAt85(12.5)}, ${grossAt85(12.51)}`);

  // ---- f: the OFF-adjusted example is unchanged: 10 seats, 5 open days, 4 worked -> 12 seats -> gross 15 ----
  const f85 = grossOf85(10, [['Only', 10]], 0.2, { ...LABOR, workingDaysPerWeek: 4, offDaysPerWeek: 3 });
  assert(f85.operationalHCWithOff === 12 && f85.grossHCTotal === 15, 'D85.f 10 seats, 5 open days, 4 worked -> 12 seats -> gross 15 (unchanged)', `got ${f85.operationalHCWithOff}/${f85.grossHCTotal}`);

  // ---- e: the three built-in samples at defaults are unchanged ----
  for (const [type, hc, gross] of [['claims', 31, 40], ['support', 28, 35], ['healthcare', 31, 39]] as Array<['claims' | 'support' | 'healthcare', number, number]>) {
    const { rows } = buildSampleDataset(type, new Date(2026, 9, 5, 8, 0, 0, 0));
    const ivs = mapRawRecordsToIntervals(rows, { intervalStartCol: 'IntervalStart', volumeCol: 'Volume', categoryCol: 'Category' } as any);
    const cats = discoverAndSyncCategories(ivs, DEFAULT_CATEGORIES, DEFAULT_SLA);
    const r = searchOptimalHC({ intervals: ivs, openingWIP: [], categories: cats, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: DEFAULT_SLA, seed: DEFAULT_SIM_PARAMS.seed, userMaxHC: DEFAULT_SIM_PARAMS.maxHCSearch, replications: DEFAULT_SIM_PARAMS.replications, queueArchitecture: 'pooled', dispatchFairness: DEFAULT_SIM_PARAMS.dispatchFairness });
    assert(r.recommendedHC === hc && r.staffing.grossHCTotal === gross, `D85.e sample ${type}: HC ${hc} / gross ${gross} unchanged`, `got ${r.recommendedHC}/${r.staffing.grossHCTotal}`);
  }
}

console.log('\n==================================================');
console.log(` RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
console.log('==================================================\n');

if (failedTests > 0) process.exitCode = 1;
