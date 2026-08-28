/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BoundaryEvidence,
  CalendarConfig,
  CaseEntity,
  CategoryConfig,
  DESResult,
  HCSearchOutput,
  LaborConfig,
  OpeningWIPCase,
  PrimarySLAStatisticalResult,
  SearchProgressState,
  ShiftDistributionByCategory,
  ShiftSlap,
  ShiftSlapDistribution,
  SLAPolicyConfig,
  StaffingRequirement,
  StandardInterval,
} from '../types/wfm';
import {
  convertSlaDurationToMinutes,
  formatDateTime24,
  getCalendarWorkingDaysInHorizon,
  getDailyOpenClose,
  getDailyWindowLengthHours,
  getValidSlapStarts,
  isWorkingDay,
} from './calendar';
import { allocateAgentsToCategories, generateCaseEntities, resolveMinAgentsPerInterval, resolveOccupancyCapPct, runBackofficeDES } from './des-engine';

/**
 * Net extra OFF (post-DES) and the roster coverage uplift derived from it.
 * Calendar-closed days are already seats-off in DES — subtract them so weekends
 * are never double-counted. extraOffDays = max(0, labor.offDays − calendarClosed).
 *
 * `offPct` (= extraOffDays / 7) is a DISPLAY fraction — "1 extra off day in 7" — and is
 * NOT the multiplier that turns on-duty seats into a roster. Agents only supply capacity on
 * OPEN days, so the seat-to-roster multiplier is a coverage ratio: each head covers
 * `coverageDays = openDaysPerWeek − extraOffDays` of the `openDaysPerWeek` seat-days that
 * must be filled every week. roster = seats × openDaysPerWeek / coverageDays.
 * (1 + offPct) only equals that ratio when extraOffDays = 0 — dividing by the calendar week
 * instead of the open week under-states the roster for every other configuration, worse as
 * off days rise. See docs/wfm/07-known-defects-and-decisions.md and PRD.md Stage 4.
 *
 * rosterInfeasible = true when coverageDays <= 0 (agent off days meet/exceed open days —
 * no head can ever be on duty enough to cover a full week). Callers must surface this, not
 * silently apply a 1x multiplier.
 */
export function computeExtraOffPct(
  labor: Pick<LaborConfig, 'offDaysPerWeek' | 'workingDaysPerWeek'>,
  calendar: Pick<CalendarConfig, 'is24x7' | 'workingDays'>
): {
  extraOffDays: number;
  offPct: number;
  calendarClosedDays: number;
  openDaysPerWeek: number;
  coverageDays: number;
  rosterUpliftPct: number;
  rosterInfeasible: boolean;
} {
  const openDaysPerWeek = calendar.is24x7 ? 7 : Math.max(0, Math.min(7, calendar.workingDays.length));
  const calendarClosedDays = 7 - openDaysPerWeek;
  const laborOff = Number.isFinite(labor.offDaysPerWeek)
    ? Math.max(0, Math.min(7, labor.offDaysPerWeek))
    : Math.max(0, Math.min(7, 7 - (labor.workingDaysPerWeek || 5)));
  const extraOffDays = Math.max(0, laborOff - calendarClosedDays);
  const offPct = Math.min(1, Math.max(0, extraOffDays / 7));
  const coverageDays = openDaysPerWeek - extraOffDays;
  const rosterInfeasible = coverageDays <= 0;
  const rosterUpliftPct = rosterInfeasible || openDaysPerWeek <= 0 ? 0 : openDaysPerWeek / coverageDays - 1;
  return {
    extraOffDays,
    offPct,
    calendarClosedDays,
    openDaysPerWeek,
    coverageDays,
    rosterUpliftPct,
    rosterInfeasible,
  };
}

/**
 * Agent productive hours for Workload HC (N_min) denominator.
 * Derived (default): dailyProductiveHours × calendar working days in horizon.
 * Manual override used only when source is override AND hours > 0.
 */
export function resolveAgentHoursForNMin(
  labor: Pick<LaborConfig, 'dailyProductiveHours' | 'contractualHoursSource' | 'contractualProductiveHoursOverride'>,
  workingDaysInHorizon: number
): { agentHours: number; source: 'derived' | 'override'; derivedHours: number } {
  const days = Math.max(1, workingDaysInHorizon);
  const derivedHours = labor.dailyProductiveHours * days;
  const override = labor.contractualProductiveHoursOverride;
  const useOverride =
    labor.contractualHoursSource === 'override' &&
    typeof override === 'number' &&
    Number.isFinite(override) &&
    override > 0;
  return {
    agentHours: useOverride ? override : derivedHours,
    source: useOverride ? 'override' : 'derived',
    derivedHours,
  };
}

/** Stage 2 analytical floor: floor(Workload / (OccCap × agentHours × Adherence)). */
export function computeAnalyticalNMin(params: {
  totalWorkloadHours: number;
  labor: Pick<LaborConfig, 'dailyProductiveHours' | 'adherencePct' | 'contractualHoursSource' | 'contractualProductiveHoursOverride'>;
  workingDaysInHorizon: number;
  occupancyCapEnabled: boolean;
  occupancyCapPct: number;
  workloadReductionEnabled?: boolean;
  workloadReductionPct?: number;
}): number {
  const { totalWorkloadHours, labor, workingDaysInHorizon, occupancyCapEnabled, occupancyCapPct, workloadReductionEnabled, workloadReductionPct } = params;
  const effectiveWorkloadHours = workloadReductionEnabled
    ? totalWorkloadHours * (1 - clampWorkloadReductionPct(workloadReductionPct) / 100)
    : totalWorkloadHours;
  const oMax = resolveOccupancyCapPct({ occupancyCapEnabled, occupancyCapPct }) / 100;
  const effectiveAdherence = Math.min(1.0, Math.max(0.1, labor.adherencePct || 1.0));
  const { agentHours } = resolveAgentHoursForNMin(labor, workingDaysInHorizon);
  const denominator = oMax * agentHours * effectiveAdherence;
  return denominator > 0 ? Math.max(1, Math.floor(effectiveWorkloadHours / denominator)) : 1;
}

/**
 * N_occ: the smallest headcount whose occupancy can possibly clear the cap, using the SAME
 * hours basis the DES occupancy denominator actually uses (dailyProductiveHours × adherence
 * × workingDaysInHorizon — des-engine.ts's totalAvailableAgentMinutes), not the contractual
 * hours N_min uses. When those two hour bases disagree (e.g. a contractual override larger
 * than what the simulator actually delivers per agent), N_min can sit below the lowest
 * headcount the occupancy gate will ever accept — this floor makes that gap visible and lets
 * the search start past it instead of discovering it by simulating doomed candidates.
 * Purely diagnostic/starting-point: never replaces nMinAnalytical as the search's hard floor.
 */
export function computeOccupancyFloor(params: {
  totalWorkloadHours: number;
  labor: Pick<LaborConfig, 'dailyProductiveHours' | 'adherencePct'>;
  workingDaysInHorizon: number;
  occupancyCapEnabled: boolean;
  occupancyCapPct: number;
}): number {
  const { totalWorkloadHours, labor, workingDaysInHorizon, occupancyCapEnabled, occupancyCapPct } = params;
  const days = Math.max(1, workingDaysInHorizon);
  const effectiveAdherence = Math.min(1.0, Math.max(0.1, labor.adherencePct || 1.0));
  const capacityHoursPerAgent = labor.dailyProductiveHours * effectiveAdherence * days;
  const occCap = resolveOccupancyCapPct({ occupancyCapEnabled, occupancyCapPct }) / 100;
  const denominator = capacityHoursPerAgent * occCap;
  return denominator > 0 ? Math.max(1, Math.ceil(totalWorkloadHours / denominator)) : 1;
}

/**
 * Capacity (minutes) delivered by one agent on a shift starting `offsetMinutes` into a working
 * day, running `shiftLengthMinutes`, evaluated at within-day position `tau` (minutes since that
 * day's business open, 0..windowLengthMinutes). Not cumulative across days — see DemandGrid for
 * why the model works one representative day at a time.
 */
export function shiftCapacityWithinDay(
  offsetMinutes: number,
  shiftLengthMinutes: number,
  windowLengthMinutes: number,
  tau: number
): number {
  if (windowLengthMinutes <= 0 || tau <= 0) return 0;
  const r = Math.min(tau, windowLengthMinutes);
  return Math.min(shiftLengthMinutes, Math.max(0, r - offsetMinutes));
}

/**
 * A release/deadline demand matrix for ONE representative working day, gridded to `gridMinutes`
 * (the same grid slap starts live on — no benefit to finer resolution than that). `matrix[rel *
 * size + dead]` is total remaining work-minutes released in bucket `rel` with a deadline in
 * bucket `dead` (only rel <= dead is ever populated).
 *
 * Why release matters, not just deadline: a pure "cumulative work due by τ" curve is optimistic
 * — it implicitly assumes an agent's capacity can be freely banked and spent whenever needed,
 * which is only true if the SCHEDULER has foresight. The engine's real EDF dispatch is greedy
 * (always serves the most urgent case among agents idle RIGHT NOW): under a persistent backlog,
 * every agent kept continuously busy from their own start burns their whole daily budget on
 * whatever was ALREADY queued, with nothing held back for work that hasn't arrived yet. Minutes
 * spent on early-released work cannot retroactively serve a case that is released later — that
 * is exactly the release-time (Hall/Horn [a,b]-window) constraint a deadline-only curve misses,
 * and exactly the mechanism behind the reported dead-zone bug: a uniform-start cohort exhausts
 * its budget on the morning backlog and has nothing left when evening-released work arrives.
 *
 * Bucketing both release and deadline to the slap grid turns the general Hall condition — which
 * in the worst case needs checking every [a,b] pair — into an O(size²) problem with size ≤ ~48
 * (a 24h day at 30-min resolution), cheap enough to re-check on every greedy step.
 *
 * Scope: built from ONE representative day (assumes roughly stationary daily demand, matching
 * this codebase's typical short — few-hour — Primary SLA windows and the reported bug's
 * continuous-backlog regime). A deadline that lands on a LATER calendar day than its release is
 * clamped into "due by end of its release day" here — conservative (never under-constrains) but
 * not perfectly tight for genuinely multi-day SLA windows; a disclosed, out-of-scope-for-now
 * simplification, not a soundness gap.
 */
export interface DemandGrid {
  gridMinutes: number;
  windowLengthMinutes: number;
  size: number;
  matrix: Float64Array;
  totalWorkMinutes: number;
}

function gridBucket(minutesFromOpen: number, gridMinutes: number, size: number): number {
  const b = Math.floor(minutesFromOpen / gridMinutes);
  return Math.max(0, Math.min(size - 1, b));
}

/**
 * Builds the one-representative-day demand grid. Everything this reads (clockStart,
 * primaryDeadline, remainingWorkMinutes) is set by generateCaseEntities before any simulation
 * runs, so this is knowable with zero DES runs.
 *
 * Critical: `cases` normally spans the WHOLE horizon (every working day, not just one) — the
 * capacity side of this model (shiftCapacityWithinDay) is inherently a SINGLE day's budget, so
 * summing every day's demand into one grid without dividing back down by the number of distinct
 * days represented compares (say) a month of demand against one day of capacity, permanently
 * overwhelming every window with an impossible aggregate deficit that swamps any real signal
 * about WHERE within a day to stagger. Dividing by the distinct working-day count recovers the
 * intended "typical single day" demand — sound as long as daily demand is roughly stationary
 * (this codebase's usual case; see the D9-style flat/near-24x7 backoffice profiles), and it is
 * exactly what let this bug hide during development on single-day fixtures.
 */
export function buildOneDayDemandGrid(
  cases: Array<Pick<CaseEntity, 'clockStart' | 'primaryDeadline' | 'remainingWorkMinutes'>>,
  calendar: CalendarConfig,
  gridMinutes: number
): DemandGrid {
  const windowLengthMinutes = calendar.is24x7 ? 24 * 60 : getDailyWindowLengthHours(calendar) * 60;
  const grid = Math.max(5, Math.round(gridMinutes));
  const size = Math.max(1, Math.ceil(windowLengthMinutes / grid));
  const matrix = new Float64Array(size * size);
  let totalWorkMinutes = 0;
  const distinctDays = new Set<string>();

  for (const c of cases) {
    if (!(c.remainingWorkMinutes > 0)) continue;
    if (!c.clockStart || isNaN(c.clockStart.getTime()) || !c.primaryDeadline || isNaN(c.primaryDeadline.getTime())) continue;

    if (calendar.is24x7) {
      matrix[0 * size + (size - 1)] += c.remainingWorkMinutes;
      totalWorkMinutes += c.remainingWorkMinutes;
      distinctDays.add(c.clockStart.toDateString());
      continue;
    }
    if (!isWorkingDay(c.clockStart, calendar)) continue;
    distinctDays.add(c.clockStart.toDateString());

    const { openTime: relOpen } = getDailyOpenClose(c.clockStart, calendar);
    const relMinutes = (c.clockStart.getTime() - relOpen.getTime()) / 60000;
    const relBucket = gridBucket(Math.max(0, relMinutes), grid, size);

    const sameDay =
      c.primaryDeadline.getFullYear() === c.clockStart.getFullYear() &&
      c.primaryDeadline.getMonth() === c.clockStart.getMonth() &&
      c.primaryDeadline.getDate() === c.clockStart.getDate();
    let deadBucket: number;
    if (sameDay) {
      const deadMinutes = (c.primaryDeadline.getTime() - relOpen.getTime()) / 60000;
      deadBucket = gridBucket(Math.max(0, deadMinutes), grid, size);
    } else {
      deadBucket = size - 1; // conservative: "due by end of release day" — see doc comment above
    }
    if (deadBucket < relBucket) deadBucket = relBucket;

    matrix[relBucket * size + deadBucket] += c.remainingWorkMinutes;
    totalWorkMinutes += c.remainingWorkMinutes;
  }

  const dayCount = Math.max(1, distinctDays.size);
  if (dayCount > 1) {
    for (let i = 0; i < matrix.length; i++) matrix[i] /= dayCount;
    totalWorkMinutes /= dayCount;
  }

  return { gridMinutes: grid, windowLengthMinutes, size, matrix, totalWorkMinutes };
}

/** Standard 2D prefix sum so demand(releaseBucket >= a, deadlineBucket <= b) is an O(1) query. */
function build2DPrefixSum(matrix: Float64Array, size: number): Float64Array {
  const P = new Float64Array(size * size);
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      const v = matrix[i * size + j];
      const left = j > 0 ? P[i * size + (j - 1)] : 0;
      const up = i > 0 ? P[(i - 1) * size + j] : 0;
      const upLeft = i > 0 && j > 0 ? P[(i - 1) * size + (j - 1)] : 0;
      P[i * size + j] = v + left + up - upLeft;
    }
  }
  return P;
}

/** demand(a,b) = total work released in bucket >= a with a deadline in bucket <= b. */
function demandInWindow(prefix: Float64Array, size: number, aBucket: number, bBucket: number): number {
  if (bBucket < 0 || aBucket >= size) return 0;
  const upToB = prefix[(size - 1) * size + bBucket];
  const upToAMinus1B = aBucket > 0 ? prefix[(aBucket - 1) * size + bBucket] : 0;
  return upToB - upToAMinus1B;
}

/**
 * Precomputes, for every grid-aligned window [a,b], whether different valid starts actually
 * deliver different marginal capacity into it. A window wide enough that every valid start's
 * whole shift fits inside it (the limiting case: the entire day) is offset-INVARIANT — every
 * start contributes the same full shiftLengthMinutes — so it carries no signal about WHERE to
 * place an agent. Depends only on validStarts/grid geometry, never on placed counts, so this is
 * computed once per computeShiftPlacement call, not per agent or per candidate.
 */
function computeWindowDiscrimination(
  validStarts: number[],
  shiftLengthMinutes: number,
  windowLengthMinutes: number,
  gridMinutes: number,
  size: number
): Uint8Array {
  const discriminates = new Uint8Array(size * size);
  for (let b = 0; b < size; b++) {
    const bEdge = Math.min(windowLengthMinutes, (b + 1) * gridMinutes);
    for (let a = 0; a <= b; a++) {
      const aEdge = a * gridMinutes;
      let minM = Infinity;
      let maxM = -Infinity;
      for (const s of validStarts) {
        const m = shiftCapacityWithinDay(s, shiftLengthMinutes, windowLengthMinutes, bEdge) -
          shiftCapacityWithinDay(s, shiftLengthMinutes, windowLengthMinutes, aEdge);
        if (m < minM) minM = m;
        if (m > maxM) maxM = m;
      }
      discriminates[a * size + b] = maxM - minM > 1e-9 ? 1 : 0;
    }
  }
  return discriminates;
}

/**
 * Worst analytic deficit over grid-aligned windows, given raw per-offset agent counts — the
 * shared inner evaluation both computeShiftPlacement and computeMaxAnalyticDeficitMinutes reduce
 * to, so they can never drift against each other.
 *
 * Preferentially reports the worst DISCRIMINATING window's deficit (see
 * computeWindowDiscrimination) whenever one is still positive (unmet): a non-discriminating
 * window — the whole-day span above all — aggregates the most total demand of any window and so
 * is very often the single largest raw deficit, but every valid start contributes identically to
 * it, so it carries zero signal about where to place an agent and, left unguarded, makes every
 * candidate offset look equally (non-)beneficial — measured directly: this was hiding whatever
 * real, offset-sensitive improvement existed in a narrower window, on realistic multi-day
 * continuous-demand data (see suite D25). Falls back to the plain worst-of-everything only once
 * no discriminating window has any unmet deficit left — i.e. once further improvement genuinely
 * cannot come from WHERE agents are placed, only from adding more of them.
 */
function worstDeficitForCounts(
  prefix: Float64Array,
  size: number,
  gridMinutes: number,
  windowLengthMinutes: number,
  shiftLengthMinutes: number,
  counts: Map<number, number>,
  /** Omit to get the TRUE worst deficit across every window (the actual Hall-condition bound —
   * what a fixed distribution's real achievable % must be measured against). Pass the geometry
   * precomputed by computeWindowDiscrimination to instead prefer a discriminating window's
   * deficit when one is unmet — the SEARCH-time heuristic computeShiftPlacement needs, so a
   * non-discriminating (e.g. whole-day) window's dominant raw magnitude doesn't hide the
   * offset-sensitive signal a narrower window carries (see that function's doc comment). */
  discriminates?: Uint8Array
): number {
  let worstAny = -Infinity;
  let worstDiscrim = -Infinity;
  for (let b = 0; b < size; b++) {
    const bEdge = Math.min(windowLengthMinutes, (b + 1) * gridMinutes);
    for (let a = 0; a <= b; a++) {
      const demand = demandInWindow(prefix, size, a, b);
      if (demand <= 0) continue;
      const aEdge = a * gridMinutes;
      let cap = 0;
      for (const [offset, cnt] of counts.entries()) {
        if (cnt <= 0) continue;
        cap += cnt * (shiftCapacityWithinDay(offset, shiftLengthMinutes, windowLengthMinutes, bEdge) -
          shiftCapacityWithinDay(offset, shiftLengthMinutes, windowLengthMinutes, aEdge));
      }
      const deficit = demand - cap; // positive = shortfall
      if (deficit > worstAny) worstAny = deficit;
      if (discriminates && discriminates[a * size + b] && deficit > worstDiscrim) worstDiscrim = deficit;
    }
  }
  if (discriminates && worstDiscrim > 0) return worstDiscrim;
  return worstAny === -Infinity ? 0 : worstAny;
}

/**
 * Deadline-coverage shift placement: the house-monotone greedy from the design doc, evaluated
 * against the release-gated Hall condition (DemandGrid). Places exactly `n` agents, one at a
 * time; each step is an EXACT one-agent lookahead — for every valid start, it computes what the
 * resulting worst-case deficit across every grid-aligned window would be if that agent were
 * added there, and commits to whichever start minimizes it directly.
 *
 * This replaced an earlier two-phase version (pick the worst window, then pick the start that
 * best serves THAT window) that decomposed the objective into a proxy and, measurably, could
 * land on a distribution WORSE than uniform start on realistic continuous-demand data — the
 * decomposition lost information the direct objective doesn't. Evaluating the true objective for
 * every candidate at every step costs more (O(n · |validStarts| · size²) vs O(n · size²)) but at
 * size ≤ ~48 and |validStarts| ≤ ~48 this is still cheap, and it is what suite D25's positive
 * control was written to catch.
 *
 * House-monotone BY CONSTRUCTION: the loop body depends only on the grid/validStarts and the
 * distribution built so far — never on the target n — so calling this with n and n+1 reproduces
 * identical first-n placement steps, then one more. place(N+1) is always place(N) plus one
 * agent; nothing is ever removed. This is what keeps the walk-down search's monotonicity
 * assumption intact (decision-log D3 — the same property, for the same reason, as the frozen
 * Webster/Sainte-Laguë apportionment).
 */
export function computeShiftPlacement(params: {
  grid: DemandGrid;
  validStarts: number[]; // sorted ascending
  shiftLengthMinutes: number;
  n: number;
  slapMinutes: number;
}): ShiftSlapDistribution {
  const { grid, validStarts, shiftLengthMinutes, n, slapMinutes } = params;
  if (validStarts.length === 0 || n <= 0 || grid.totalWorkMinutes <= 0) {
    return { slapMinutes, slaps: [] };
  }

  const { size, gridMinutes, windowLengthMinutes, matrix } = grid;
  const prefix = build2DPrefixSum(matrix, size);
  const discriminates = computeWindowDiscrimination(validStarts, shiftLengthMinutes, windowLengthMinutes, gridMinutes, size);
  const counts = new Map<number, number>(validStarts.map((s) => [s, 0]));

  for (let agent = 0; agent < n; agent++) {
    let bestOffset = validStarts[0];
    let bestResultingDeficit = Infinity;
    // Ties broken toward the EARLIEST candidate offset (ascending iteration, only switching on
    // a STRICT improvement keeps the first-seen of any tied group) — once worstDeficitForCounts
    // already ignores non-discriminating windows wherever a discriminating one is still unmet,
    // a genuine tie between offsets means they are truly interchangeable for every window that
    // still matters, so there is no informational reason to prefer one over another; defaulting
    // to earliest keeps a config with no real staggering opportunity byte-for-byte at "everyone
    // starts at open" rather than scattering agents arbitrarily (measured directly: scattering
    // on ties was a real regression on backlog-heavy continuous-demand data — see suite D25).
    for (const s of validStarts) {
      counts.set(s, (counts.get(s) || 0) + 1);
      const resulting = worstDeficitForCounts(prefix, size, gridMinutes, windowLengthMinutes, shiftLengthMinutes, counts, discriminates);
      counts.set(s, (counts.get(s) || 0) - 1);
      if (resulting < bestResultingDeficit - 1e-9) {
        bestResultingDeficit = resulting;
        bestOffset = s;
      }
    }
    counts.set(bestOffset, (counts.get(bestOffset) || 0) + 1);
  }

  const slaps: ShiftSlap[] = Array.from(counts.entries())
    .filter(([, agentCount]) => agentCount > 0)
    .map(([startMinutesFromOpen, agentCount]) => ({ startMinutesFromOpen, agentCount }))
    .sort((a, b) => a.startMinutesFromOpen - b.startMinutesFromOpen);
  return { slapMinutes, slaps };
}

/** Worst (maximum) analytic deficit over every grid-aligned window, for a given placed
 * distribution — a lower bound on work minutes no scheduler could deliver on time under it. */
export function computeMaxAnalyticDeficitMinutes(
  grid: DemandGrid,
  distribution: ShiftSlapDistribution,
  shiftLengthMinutes: number
): number {
  const { size, gridMinutes, windowLengthMinutes, matrix } = grid;
  const prefix = build2DPrefixSum(matrix, size);
  const counts = new Map<number, number>(distribution.slaps.map((s) => [s.startMinutesFromOpen, s.agentCount]));
  return Math.max(0, worstDeficitForCounts(prefix, size, gridMinutes, windowLengthMinutes, shiftLengthMinutes, counts));
}

/**
 * N_sla: smallest N whose optimal placement analytically clears `targetPct` attainment.
 * achievablePct(N) = 100 × (1 − maxDeficit(N) / totalWorkMinutes) is monotone nondecreasing in
 * N (adding capacity at any N can only shrink every window's deficit), so binary search over N
 * is valid. Returns `maxN` (best-effort) if even the search cap cannot reach the target.
 */
export function findPlacementFeasibleFloor(params: {
  grid: DemandGrid;
  validStarts: number[];
  shiftLengthMinutes: number;
  slapMinutes: number;
  targetPct: number;
  maxN: number;
}): number {
  const { grid, validStarts, shiftLengthMinutes, slapMinutes, targetPct, maxN } = params;
  if (validStarts.length === 0 || grid.totalWorkMinutes <= 0) return 1;

  const achievablePct = (n: number): number => {
    const dist = computeShiftPlacement({ grid, validStarts, shiftLengthMinutes, n, slapMinutes });
    const maxDeficit = computeMaxAnalyticDeficitMinutes(grid, dist, shiftLengthMinutes);
    return 100 * (1 - maxDeficit / grid.totalWorkMinutes);
  };

  let lo = 1;
  let hi = Math.max(1, maxN);
  if (achievablePct(hi) < targetPct) return hi;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (achievablePct(mid) >= targetPct) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}

/**
 * Builds the full shift-start distribution for a candidate N — one placement for the pooled
 * agent block, or one independent placement per category on top of the existing frozen
 * Webster/Sainte-Laguë apportionment (allocateAgentsToCategories, des-engine.ts) for siloed.
 * Shared by both searchOptimalHC and searchOptimalHCAsync so the two search entry points
 * never drift on this logic (see decision-log D8/D11 — they have drifted before).
 *
 * `cases` is a single representative case set (the caller passes precomputedCaseSets[0].cases)
 * rather than one per replication: shift placement is a structural schedule design, not
 * something that should vary per stochastic replication — using one representative sample to
 * design the schedule, then verifying it across all R replications' arrival jitter via the
 * normal CI-gated DES evaluation, is standard WFM practice (you don't redesign the roster for
 * every random draw).
 */
export function computeCandidatePlacementDistribution(params: {
  n: number;
  cases: CaseEntity[];
  calendar: CalendarConfig;
  labor: LaborConfig;
  queueArchitecture: 'pooled' | 'siloed';
}): ShiftDistributionByCategory | null {
  const { n, cases, calendar, labor, queueArchitecture } = params;
  if (n <= 0) return null;

  // SPAN (getValidSlapStarts — a valid start must let the physical shift block fit in the
  // business window, un-adhered: the agent is PRESENT for the full shift length regardless
  // of adherence) vs CAPACITY (computeShiftPlacement's deficit math — the WORK an agent
  // actually delivers, which adherence discounts) are deliberately different figures. Fixed
  // 2026-08-28 (Gap B): both previously used the same un-adhered shiftLengthMinutes, a ~25%
  // over-credit at adherence 0.8 relative to the DES's actual dailyBudgetMinutes
  // (dailyProductiveHours × adherence × 60, des-engine.ts) — computeOccupancyFloor already
  // gets this right a few hundred lines away in this same file.
  const shiftLengthMinutes = labor.dailyProductiveHours * 60;
  const effectiveAdherence = Math.min(1.0, Math.max(0.1, labor.adherencePct || 1.0));
  const capacityMinutes = shiftLengthMinutes * effectiveAdherence;
  const slapMinutes = Math.max(5, Math.round(labor.shiftSlapMinutes || 30));
  const validStarts = getValidSlapStarts(calendar, shiftLengthMinutes, slapMinutes);
  if (validStarts.length === 0) return null;

  if (queueArchitecture === 'pooled') {
    const grid = buildOneDayDemandGrid(cases, calendar, slapMinutes);
    if (grid.totalWorkMinutes <= 0) return null;
    const dist = computeShiftPlacement({ grid, validStarts, shiftLengthMinutes: capacityMinutes, n, slapMinutes });
    return dist.slaps.length > 0 ? { __POOLED__: dist } : null;
  }

  // Siloed: apportion N across categories first (the same divisor method the DES itself
  // uses), then place each category's seats independently against only its own cases —
  // never replacing that apportionment, only scheduling on top of it.
  const catWorkloadMinutes = new Map<string, number>();
  const casesByCategory = new Map<string, CaseEntity[]>();
  for (const c of cases) {
    catWorkloadMinutes.set(c.category, (catWorkloadMinutes.get(c.category) || 0) + c.totalAhtMinutes);
    if (!casesByCategory.has(c.category)) casesByCategory.set(c.category, []);
    casesByCategory.get(c.category)!.push(c);
  }
  const seats = allocateAgentsToCategories(catWorkloadMinutes, n);
  const result: ShiftDistributionByCategory = {};
  let any = false;
  for (const [catName, seatCount] of seats.entries()) {
    if (seatCount <= 0) continue;
    const catCases = casesByCategory.get(catName) || [];
    const grid = buildOneDayDemandGrid(catCases, calendar, slapMinutes);
    if (grid.totalWorkMinutes <= 0) continue;
    const dist = computeShiftPlacement({ grid, validStarts, shiftLengthMinutes: capacityMinutes, n: seatCount, slapMinutes });
    if (dist.slaps.length > 0) {
      result[catName] = dist;
      any = true;
    }
  }
  return any ? result : null;
}

/**
 * Builds the minimal shift-start distribution needed to satisfy the coverage floor (at least
 * minAgentsPerInterval on shift at every point in the business window) — independent of SLA/
 * deadline objectives, and independent of shiftPlacementEnabled: G1 ("the queue may never be
 * left unattended while the business is running") is a structural requirement, not an
 * optimization the planner opts into. Moves the SMALLEST possible number of agents away from
 * offset 0 needed to cover the window's tail; everyone else stays at offset 0 (byte-for-byte
 * the pre-2026-08-28 uniform behavior otherwise), minimizing disruption.
 * Uses a classic greedy minimal interval cover — repeatedly pick the LARGEST valid start at or
 * before the current covered frontier (never leaves a gap), advance the frontier to
 * start+shiftLength, until the window is fully covered. Optimal for equal-length spans on a
 * discrete grid (this is exactly that: every valid start yields a shift of the same length).
 * Returns null when N cannot satisfy the floor at this seat count (the search then correctly
 * keeps climbing N — this function never fabricates coverage from insufficient headcount), or
 * when a single shift already reaches close (nothing to repair).
 */
export function buildCoverageRepairDistribution(params: {
  n: number;
  calendar: CalendarConfig;
  labor: LaborConfig;
  minAgentsPerInterval: number;
  queueArchitecture: 'pooled' | 'siloed';
  categoryWorkloadMinutes?: Map<string, number>; // required for siloed
}): ShiftDistributionByCategory | null {
  const { n, calendar, labor, minAgentsPerInterval, queueArchitecture, categoryWorkloadMinutes } = params;
  if (n <= 0 || minAgentsPerInterval <= 0) return null;

  const shiftLengthMinutes = labor.dailyProductiveHours * 60;
  const slapMinutes = Math.max(5, Math.round(labor.shiftSlapMinutes || 30));
  const validStarts = getValidSlapStarts(calendar, shiftLengthMinutes, slapMinutes);
  if (validStarts.length === 0) return null;
  const windowLengthMinutes = getDailyWindowLengthHours(calendar) * 60;
  if (shiftLengthMinutes >= windowLengthMinutes) return null; // offset 0 alone already covers

  const buildForSeats = (seats: number): ShiftSlapDistribution | null => {
    const sortedDesc = [...validStarts].sort((a, b) => b - a);
    const chosen = new Set<number>([0]);
    let frontier = 0;
    while (frontier < windowLengthMinutes - 1e-9) {
      const pick = sortedDesc.find((s) => s <= frontier + 1e-9);
      if (pick === undefined) break; // unreachable: offset 0 is always a valid start
      chosen.add(pick);
      frontier = pick + shiftLengthMinutes;
    }
    const nonZero = Array.from(chosen).filter((o) => o > 0).sort((a, b) => a - b);
    // Offset 0 must ALSO independently satisfy the floor for its own portion of the window —
    // it is not merely "whatever's left over" after the other offsets are seeded. Missing
    // this left offset 0 with zero agents whenever seats exactly matched the non-zero
    // offsets' requirement (e.g. N=1: the single agent went entirely to the tail offset,
    // leaving the window's OPENING with zero coverage) — caught by suite D33.4.
    const required = (nonZero.length + 1) * minAgentsPerInterval;
    if (required > seats) return null; // not enough seats to cover minimally at this N
    const slaps: ShiftSlap[] = nonZero.map((o) => ({ startMinutesFromOpen: o, agentCount: minAgentsPerInterval }));
    const baseCount = seats - nonZero.length * minAgentsPerInterval; // always >= minAgentsPerInterval here
    slaps.push({ startMinutesFromOpen: 0, agentCount: baseCount });
    return { slapMinutes, slaps: slaps.sort((a, b) => a.startMinutesFromOpen - b.startMinutesFromOpen) };
  };

  if (queueArchitecture === 'pooled') {
    const dist = buildForSeats(n);
    return dist ? { __POOLED__: dist } : null;
  }

  if (!categoryWorkloadMinutes) return null;
  const seatsMap = allocateAgentsToCategories(categoryWorkloadMinutes, n);
  const result: ShiftDistributionByCategory = {};
  let any = false;
  for (const [catName, seatCount] of seatsMap.entries()) {
    if (seatCount <= 0) continue;
    const dist = buildForSeats(seatCount);
    if (dist) {
      result[catName] = dist;
      any = true;
    }
  }
  return any ? result : null;
}

/**
 * Single shared decision point for whether a placement distribution replaces the uniform
 * result for a candidate N — used identically by searchOptimalHC and searchOptimalHCAsync.
 *
 * Guarantees:
 *  - Never-worse: only switches away from uniform when the placement result PASSES.
 *  - Monotone-safe gate: the combined predicate is uniformPasses(N) OR placePasses(N). Since
 *    placePasses(N) is monotone nondecreasing by construction (computeShiftPlacement's
 *    house-monotone greedy), this can only patch over — never introduce — a monotonicity dip
 *    relative to uniform alone (decision-log D3's regression class).
 */
export function pickPlacementOrUniform<T extends { passesAllConstraints: boolean }>(
  uniformResult: T,
  placedResult: T | null,
  placementDist: ShiftDistributionByCategory | null
): { result: T; distributionUsed: ShiftDistributionByCategory | undefined } {
  if (placedResult && placementDist && placedResult.passesAllConstraints) {
    return { result: placedResult, distributionUsed: placementDist };
  }
  return { result: uniformResult, distributionUsed: undefined };
}

export function calculateStaffingRequirement(params: {
  operationalHC: number;
  categories: CategoryConfig[];
  intervals: StandardInterval[];
  openingWIP: OpeningWIPCase[];
  calendar: CalendarConfig;
  labor: LaborConfig;
  horizonStart: Date;
  horizonEnd: Date;
  bindingConstraint: string;
}): StaffingRequirement {
  let {
    operationalHC,
    categories,
    intervals,
    openingWIP,
    calendar,
    labor,
    horizonStart,
    horizonEnd,
    bindingConstraint,
  } = params;

  const categoryMap = new Map<string, CategoryConfig>();
  categories.forEach((c) => categoryMap.set(c.name, c));

  // Compute workload hours per category
  const catWorkloadHours: Record<string, number> = {};
  categories.forEach((c) => (catWorkloadHours[c.name] = 0));

  for (const interval of intervals) {
    const cat = categoryMap.get(interval.category) || {
      id: 'default',
      name: interval.category,
      ahtMinutes: 30,
      shrinkagePct: 0.2,
      priority: 1,
    };
    catWorkloadHours[interval.category] =
      (catWorkloadHours[interval.category] || 0) + (interval.volume * cat.ahtMinutes) / 60;
  }

  for (const wip of openingWIP) {
    const cat = categoryMap.get(wip.category) || {
      id: 'default',
      name: wip.category,
      ahtMinutes: 30,
      shrinkagePct: 0.2,
      priority: 1,
    };
    const remMin =
      wip.remainingWorkMinutes !== undefined && wip.remainingWorkMinutes !== null
        ? wip.remainingWorkMinutes
        : cat.ahtMinutes;
    catWorkloadHours[wip.category] = (catWorkloadHours[wip.category] || 0) + remMin / 60;
  }

  let totalWorkloadHours = 0;
  Object.values(catWorkloadHours).forEach((hrs) => (totalWorkloadHours += hrs));
  if (totalWorkloadHours <= 0) totalWorkloadHours = 1; // Prevent division by zero

  const workingDaysInHorizon = Math.max(1, getCalendarWorkingDaysInHorizon(horizonStart, horizonEnd, calendar));

  // Same agent-hours resolver as Stage 2 N_min (override only when > 0).
  const { agentHours: contractualProductiveHours, source: resolvedHoursSource } = resolveAgentHoursForNMin(
    labor,
    workingDaysInHorizon
  );

  // Extra OFF after DES: only agent offs beyond calendar-closed days already in seats.
  // Roster uplift is a coverage ratio (agents only supply capacity on open days) — computed
  // integer-exact as (operationalHC * openDaysPerWeek) / coverageDays before flooring, never
  // via floor(N * (1 + fractionalUplift)), which loses a seat to float error in real
  // configs (e.g. 24x7 + 5-day agents: 45*(1+0.4) = 62.999999999999999 -> 62, not 63).
  const { extraOffDays, offPct, openDaysPerWeek, coverageDays, rosterUpliftPct, rosterInfeasible } =
    computeExtraOffPct(labor, calendar);
  const operationalHCWithOff = rosterInfeasible
    ? operationalHC
    : Math.floor((operationalHC * openDaysPerWeek) / coverageDays);
  if (rosterInfeasible) {
    bindingConstraint = `${bindingConstraint} [ROSTER INFEASIBLE: labor off days leave no open-day coverage — Net Operational HC not OFF-adjusted]`;
  }

  let sumGrossHC = 0;
  let harmonicDenomSum = 0;
  let requiredProductiveHoursTotal = 0;
  let fteGrossSum = 0;

  const perCategory: StaffingRequirement['perCategory'] = [];

  // Workload is accumulated for every category found in the demand data, including any
  // not present in `categories`. Those must still receive an allocation: iterating only
  // the configured categories would leave their workload in the share denominator with
  // no share of its own, so the shares would sum to less than 1 and Gross HC / FTE would
  // be silently understated (measured at half the true requirement in a two-category
  // case). Unconfigured categories fall back to the same defaults used during parsing.
  const effectiveCategories: CategoryConfig[] = [...categories];
  for (const name of Object.keys(catWorkloadHours)) {
    if (!categoryMap.has(name)) {
      effectiveCategories.push({
        id: `auto-${name}`,
        name,
        ahtMinutes: 30,
        shrinkagePct: 0.2,
        priority: 1,
      });
    }
  }

  for (const cat of effectiveCategories) {
    const wl = catWorkloadHours[cat.name] || 0;
    const share = wl / totalWorkloadHours;
    // Stage 4 base is OFF-adjusted seats; DES operationalHC stays the simulator N.
    const opHCCat = operationalHCWithOff * share;
    const reqProdHrsCat = opHCCat * labor.dailyProductiveHours * workingDaysInHorizon;
    requiredProductiveHoursTotal += reqProdHrsCat;

    const shr = Math.min(0.99, Math.max(0, cat.shrinkagePct));
    const grossHCCat = 1 - shr > 0 ? opHCCat / (1 - shr) : opHCCat;
    sumGrossHC += grossHCCat;

    if (1 - shr > 0) {
      harmonicDenomSum += share / (1 - shr);
    }

    const fteGrossCat =
      1 - shr > 0 && contractualProductiveHours > 0
        ? reqProdHrsCat / ((1 - shr) * contractualProductiveHours)
        : opHCCat;
    fteGrossSum += fteGrossCat;

    perCategory.push({
      category: cat.name,
      workloadHours: Math.round(wl * 100) / 100,
      categoryShare: Math.round(share * 1000) / 1000,
      operationalHC: Math.round(opHCCat * 100) / 100,
      requiredProductiveHours: Math.round(reqProdHrsCat * 10) / 10,
      shrinkagePct: shr,
      grossHC: Math.round(grossHCCat * 100) / 100,
      fteGross: Math.round(fteGrossCat * 100) / 100,
    });
  }

  // Pooled Gross HC (M2): round(sum_c gross_hc_c)
  const grossHCTotal = Math.round(sumGrossHC);

  // Harmonic Effective Shrinkage (M3): 1 - 1 / sum_c (share_c / (1 - shr_c))
  // OFF is not folded into shrinkage — shares × category shrinkagePct only.
  const effectiveShrinkagePct =
    harmonicDenomSum > 0 ? Math.max(0, 1 - 1 / harmonicDenomSum) : 0;

  // FTE Net: requiredProductiveHours / contractualProductiveHours (= operationalHCWithOff under derived hours)
  const fteNet =
    contractualProductiveHours > 0
      ? requiredProductiveHoursTotal / contractualProductiveHours
      : operationalHCWithOff;

  return {
    operationalHC,
    offPct,
    extraOffDays,
    openDaysPerWeek,
    coverageDays,
    rosterUpliftPct: Math.round(rosterUpliftPct * 1000) / 1000,
    rosterInfeasible,
    operationalHCWithOff,
    grossHCTotal,
    fteGrossHeadline: Math.round(fteGrossSum * 100) / 100,
    fteNet: Math.round(fteNet * 100) / 100,
    effectiveShrinkagePct: Math.round(effectiveShrinkagePct * 1000) / 1000,
    requiredProductiveHoursTotal: Math.round(requiredProductiveHoursTotal * 10) / 10,
    totalWorkloadHours: Math.round(totalWorkloadHours * 10) / 10,
    contractualProductiveHours: Math.round(contractualProductiveHours * 10) / 10,
    contractualHoursSource: resolvedHoursSource,
    perCategory,
    bindingConstraint,
  };
}

/** Clamp CI confidence % to [50, 99.9]; invalid/missing → 95. */
export function clampConfidenceLevelPct(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
  if (!Number.isFinite(n)) return 95;
  return Math.min(99.9, Math.max(50, Math.round(n * 10) / 10));
}

/** Clamp SLA acceptance slack % to [1, 20]; invalid → 5. */
export function clampSlaAcceptanceSlackPct(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
  if (!Number.isFinite(n)) return 5;
  return Math.min(20, Math.max(1, Math.round(n)));
}

/** Clamp workload reduction % to [1, 50]; invalid → 5. */
export function clampWorkloadReductionPct(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
  if (!Number.isFinite(n)) return 5;
  return Math.min(50, Math.max(1, Math.round(n)));
}

/**
 * Sizing floor for Primary SLA CI pass.
 * OFF → official %. ON → official × (1 − slack/100), e.g. 80 × 0.95 = 76.
 */
export function effectivePrimaryTarget(officialPct: number, sla: SLAPolicyConfig): number {
  if (!sla.slaAcceptanceSlackEnabled) return officialPct;
  const slack = clampSlaAcceptanceSlackPct(sla.slaAcceptanceSlackPct) / 100;
  return Math.round(officialPct * (1 - slack) * 10) / 10;
}

function formatPrimaryTargetLabel(officialPct: number, sla: SLAPolicyConfig): string {
  const floor = effectivePrimaryTarget(officialPct, sla);
  if (!sla.slaAcceptanceSlackEnabled || floor === officialPct) {
    return `${officialPct}%`;
  }
  const slack = clampSlaAcceptanceSlackPct(sla.slaAcceptanceSlackPct);
  return `sizing floor ${floor}% (policy ${officialPct}%, slack ${slack}%)`;
}

/** Acklam inverse normal CDF (lower tail). */
function normsInv(p: number): number {
  if (p <= 0 || p >= 1) {
    if (p <= 0) return -Infinity;
    return Infinity;
  }
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163436711554,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number;
  let r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(
    (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  );
}

/**
 * Two-sided Student-t critical value for confidence level in [50, 99.9].
 * Acklam inverse-normal + Cornish–Fisher inverse-t (offline, no deps).
 */
export function getTCrit(df: number, confidenceLevelPct: number = 95): number {
  if (df <= 0) return 0;
  const conf = clampConfidenceLevelPct(confidenceLevelPct);
  // Two-sided: P(|T| <= t) = conf/100 → one-tail upper p = (1 + conf/100) / 2
  const p = (1 + conf / 100) / 2;
  if (p <= 0.5) return 0;
  if (p >= 1) return Infinity;

  // Exact closed forms
  if (df === 1) return Math.tan(Math.PI * (p - 0.5));
  if (df === 2) {
    const a = 2 * p - 1;
    return (Math.SQRT2 * a) / Math.sqrt(Math.max(1e-300, 1 - a * a));
  }

  const z = normsInv(p);
  if (!Number.isFinite(z)) return Math.abs(z);
  if (df > 1e8) return Math.abs(z);

  const z2 = z * z;
  const z3 = z2 * z;
  const z5 = z3 * z2;
  const z7 = z5 * z2;
  const z9 = z7 * z2;
  const g1 = (z3 + z) / 4;
  const g2 = (5 * z5 + 16 * z3 + 3 * z) / 96;
  const g3 = (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / 384;
  const g4 = (79 * z9 + 776 * z7 + 1482 * z5 - 1920 * z3 - 945 * z) / 92160;
  const nu = df;
  const t = z + g1 / nu + g2 / (nu * nu) + g3 / (nu * nu * nu) + g4 / (nu * nu * nu * nu);
  return Math.abs(t);
}

/** @deprecated Prefer getTCrit(df, 95) */
export function getTCrit95(df: number): number {
  return getTCrit(df, 95);
}

export interface PrecomputedCaseSet {
  cases: any[];
  horizonStart: Date;
  horizonEnd: Date;
}

export function generatePrecomputedReplications(params: {
  intervals: StandardInterval[];
  openingWIP: OpeningWIPCase[];
  categories: CategoryConfig[];
  calendar: CalendarConfig;
  sla: SLAPolicyConfig;
  baseSeed: number;
  replications: number;
}): PrecomputedCaseSet[] {
  let { intervals, openingWIP, categories, calendar, sla, baseSeed, replications } = params;
  const R = Math.max(1, replications);
  const sets: PrecomputedCaseSet[] = [];
  for (let r = 0; r < R; r++) {
    const repSeed = (baseSeed + r * 1013 + 7) % 2147483647;
    sets.push(
      generateCaseEntities({
        intervals,
        openingWIP,
        categories,
        calendar,
        sla,
        seed: repSeed,
      })
    );
  }
  return sets;
}

function computeStatisticalEvaluation(
  operationalHC: number,
  repResults: DESResult[],
  primarySamples: number[],
  R: number,
  sla: SLAPolicyConfig,
  calendar: CalendarConfig,
  categories: CategoryConfig[]
) {
  // Sort primary samples for median and distribution
  const sortedPrimary = [...primarySamples].sort((a, b) => a - b);
  const median =
    sortedPrimary.length % 2 === 0
      ? (sortedPrimary[sortedPrimary.length / 2 - 1] + sortedPrimary[sortedPrimary.length / 2]) / 2
      : sortedPrimary[Math.floor(sortedPrimary.length / 2)];

  const sum = primarySamples.reduce((acc, v) => acc + v, 0);
  const mean = sum / R;

  const variance =
    R > 1
      ? primarySamples.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / (R - 1)
      : 0;
  const stdDev = Math.sqrt(variance);
  const standardError = R > 1 ? stdDev / Math.sqrt(R) : 0;

  // Student's t critical multiplier for configured two-sided CI (df = R - 1)
  const ciLevel = clampConfidenceLevelPct(sla.confidenceLevelPct);
  const tVal = getTCrit(R - 1, ciLevel);
  const ci95Low = Math.max(0, Math.round((mean - tVal * standardError) * 10) / 10);
  const ci95High = Math.min(100, Math.round((mean + tVal * standardError) * 10) / 10);

  const primaryStats: PrimarySLAStatisticalResult = {
    requiredHC: operationalHC,
    replications: R,
    achievedPctMedian: Math.round(median * 10) / 10,
    achievedPctMean: Math.round(mean * 10) / 10,
    ci95Low,
    ci95High,
    stdDev: Math.round(stdDev * 100) / 100,
    samples: primarySamples,
  };

  // Check statistical pass conditions:
  // Primary SLA requires the CI Lower Bound to clear the sizing floor (or median if R=1)
  const primaryFloor = effectivePrimaryTarget(sla.primaryPct, sla);
  const passesPrimaryCI = R > 1 ? ci95Low >= primaryFloor : median >= primaryFloor;

  // --- Occupancy Statistics across R replications ---
  // Sampled from rawOccupancyPct (unclamped) — censoring at 100 here would collapse every
  // overloaded replication to the same value, zeroing variance and degenerating the CI to
  // [100, 100]. See BUG-OCC-CAP.
  const occupancyCapPctResolved = resolveOccupancyCapPct(sla);
  const occupancySamples = repResults.map((r) => r.rawOccupancyPct);
  const occSum = occupancySamples.reduce((acc, v) => acc + v, 0);
  const occMean = occSum / R;
  const occVariance =
    R > 1
      ? occupancySamples.reduce((acc, v) => acc + (v - occMean) * (v - occMean), 0) / (R - 1)
      : 0;
  const occStdDev = Math.sqrt(occVariance);
  const occSE = R > 1 ? occStdDev / Math.sqrt(R) : 0;
  const occCi95Low = Math.max(0, Math.round((occMean - tVal * occSE) * 10) / 10);
  const occCi95High = Math.round((occMean + tVal * occSE) * 10) / 10;

  // The cap is always in force (occupancyCapEnabled selects a custom target, not an on/off
  // switch) — no !sla.occupancyCapEnabled short-circuit here. See resolveOccupancyCapPct.
  const passesOccupancyCap =
    R > 1 ? occCi95High <= occupancyCapPctResolved : occMean <= occupancyCapPctResolved;

  // --- BO ASA Statistics across R replications ---
  const boAsaSamples = repResults.map((r) => r.boAsaMeanMinutes);
  const asaSum = boAsaSamples.reduce((acc, v) => acc + v, 0);
  const asaMean = asaSum / R;
  const asaVariance =
    R > 1
      ? boAsaSamples.reduce((acc, v) => acc + (v - asaMean) * (v - asaMean), 0) / (R - 1)
      : 0;
  const asaStdDev = Math.sqrt(asaVariance);
  const asaSE = R > 1 ? asaStdDev / Math.sqrt(R) : 0;
  const asaCi95Low = Math.max(0, Math.round((asaMean - tVal * asaSE) * 10) / 10);
  const asaCi95High = Math.round((asaMean + tVal * asaSE) * 10) / 10;

  const asaBasis = sla.asaClockBasis === 'clock_hours' ? 'wall_clock' : 'business_time';
  const targetAsaMinutes = convertSlaDurationToMinutes(
    sla.boAsaTarget,
    sla.boAsaUnit,
    asaBasis,
    calendar
  );
  const passesBOASA =
    !sla.boAsaEnabled || (R > 1 ? asaCi95High <= targetAsaMinutes : asaMean <= targetAsaMinutes);

  // Representative result is the replication closest to median primary SLA (BUG-P2-O)
  let bestRepIdx = 0;
  let minDiff = Infinity;
  for (let r = 0; r < repResults.length; r++) {
    const diff = Math.abs(repResults[r].primaryAchievedPct - median);
    if (diff < minDiff) {
      minDiff = diff;
      bestRepIdx = r;
    }
  }
  const representativeResult = repResults[bestRepIdx] || repResults[0];

  // --- Category SLA Statistics across R replications ---
  let passesCategorySLA = true;
  const categoryFailureMessages: string[] = [];
  const catNames = new Set([
    ...categories.map((c) => c.name),
    ...Object.keys(representativeResult.categoryStats || {}),
  ]);

  for (const catName of catNames) {
    const cat = categories.find((c) => c.name === catName);
    const catOfficial = cat?.primaryPct !== undefined ? cat.primaryPct : sla.primaryPct;
    const catTarget = effectivePrimaryTarget(catOfficial, sla);
    const catSamples = repResults.map((r) => r.categoryStats[catName]?.primaryPct ?? 100);
    const cSum = catSamples.reduce((acc, v) => acc + v, 0);
    const cMean = cSum / R;
    const cVar = R > 1 ? catSamples.reduce((acc, v) => acc + (v - cMean) * (v - cMean), 0) / (R - 1) : 0;
    const cSE = R > 1 ? Math.sqrt(cVar) / Math.sqrt(R) : 0;
    const cLow = Math.max(0, Math.round((cMean - tVal * cSE) * 10) / 10);
    const cHigh = Math.min(100, Math.round((cMean + tVal * cSE) * 10) / 10);
    const catPass = R > 1 ? cLow >= catTarget : cMean >= catTarget;

    if (!catPass) {
      passesCategorySLA = false;
      categoryFailureMessages.push(
        `Category '${catName}' Primary SLA ${ciLevel}% CI [${cLow}%, ${cHigh}%] lower bound < ${formatPrimaryTargetLabel(catOfficial, sla)} (Mean: ${Math.round(cMean * 10) / 10}%)`
      );
    }
  }

  const failingReasons: string[] = [];
  if (!passesPrimaryCI) {
    failingReasons.push(
      `Primary SLA ${ciLevel}% CI [${ci95Low}%, ${ci95High}%] lower bound < ${formatPrimaryTargetLabel(sla.primaryPct, sla)} (Median: ${median}%, Mean: ${Math.round(mean * 10) / 10}%)`
    );
  }
  if (!passesCategorySLA) {
    failingReasons.push(...categoryFailureMessages);
  }
  if (sla.boAsaEnabled && !passesBOASA) {
    failingReasons.push(
      `BO ASA ${ciLevel}% CI [${asaCi95Low}m, ${asaCi95High}m] upper bound > target ${sla.boAsaTarget}${sla.boAsaUnit} (${targetAsaMinutes}m) (Mean: ${Math.round(asaMean * 10) / 10}m)`
    );
  }
  if (!passesOccupancyCap) {
    failingReasons.push(
      `Occupancy ${ciLevel}% CI [${occCi95Low}%, ${occCi95High}%] upper bound > cap ${occupancyCapPctResolved}% (Mean: ${Math.round(occMean * 10) / 10}%)`
    );
  }

  // --- Coverage: a hard structural floor, not a statistical target — the WORST replication
  // must individually satisfy it (unlike SLA/occupancy's mean-based CI gate). "The queue may
  // never be left unattended" does not admit an averaging argument: a replication that fails
  // coverage represents a real interval with too few agents, regardless of how other
  // replications' arrival randomness happened to land.
  const minAgentsRequired = resolveMinAgentsPerInterval(sla, operationalHC);
  const coverageSamples = repResults.map((r) => r.minCoverageObserved).filter((v) => v !== Infinity);
  const worstCoverage = coverageSamples.length > 0 ? Math.min(...coverageSamples) : Infinity;
  // 24x7 gate RE-ENABLED (2026-08-28, 24x7 multi-start): the interim is24x7 exclusion here
  // and in des-engine.ts's runBackofficeDES is reverted now that real 24x7 staggering gives
  // the search an actual lever to satisfy coverage (buildCoverageRepairDistribution and
  // placement both work for 24x7 now — see their own is24x7 guards, also removed).
  const passesCoverage = minAgentsRequired <= 0 || worstCoverage === Infinity || worstCoverage >= minAgentsRequired;
  if (!passesCoverage) {
    failingReasons.push(
      `Coverage: at least one replication had as few as ${worstCoverage} agent(s) on shift during an open business interval, below the required minimum of ${minAgentsRequired}`
    );
  }

  const passesAllConstraints =
    passesPrimaryCI &&
    passesCategorySLA &&
    passesBOASA &&
    passesOccupancyCap &&
    passesCoverage;

  return {
    primaryStats,
    repResults,
    representativeResult,
    representativeRepIndex: bestRepIdx,
    passesPrimaryCI,
    passesCoverage,
    passesAllConstraints,
    failingReasons,
  };
}

/**
 * Computes multi-replication statistics for candidate headcount N (synchronous).
 */
export function evaluateCandidateStatistical(params: {
  operationalHC: number;
  intervals: StandardInterval[];
  openingWIP: OpeningWIPCase[];
  categories: CategoryConfig[];
  calendar: CalendarConfig;
  labor: LaborConfig;
  sla: SLAPolicyConfig;
  baseSeed: number;
  replications: number;
  queueArchitecture?: 'pooled' | 'siloed';
  precomputedCaseSets?: PrecomputedCaseSet[];
  shiftDistribution?: ShiftDistributionByCategory;
}): {
  primaryStats: PrimarySLAStatisticalResult;
  repResults: DESResult[];
  representativeResult: DESResult;
  representativeRepIndex: number;
  passesPrimaryCI: boolean;
  passesAllConstraints: boolean;
  failingReasons: string[];
} {
  const {
    operationalHC,
    intervals,
    openingWIP,
    categories,
    calendar,
    labor,
    sla,
    baseSeed,
    replications,
    queueArchitecture = 'pooled',
    precomputedCaseSets,
    shiftDistribution,
  } = params;

  const R = Math.max(1, replications);
  const repResults: DESResult[] = [];
  const primarySamples: number[] = [];

  for (let r = 0; r < R; r++) {
    const repSeed = (baseSeed + r * 1013 + 7) % 2147483647;
    const repCases = precomputedCaseSets ? precomputedCaseSets[r] : undefined;
    const res = runBackofficeDES({
      operationalHC,
      intervals,
      openingWIP,
      categories,
      calendar,
      labor,
      sla,
      seed: repSeed,
      queueArchitecture,
      precomputedCases: repCases,
      skipCaseResultsAndTimeline: true,
      shiftDistribution,
    });
    repResults.push(res);
    primarySamples.push(res.primaryAchievedPct);
  }

  return computeStatisticalEvaluation(
    operationalHC,
    repResults,
    primarySamples,
    R,
    sla,
    calendar,
    categories
  );
}

/**
 * Computes multi-replication statistics for candidate headcount N (asynchronous with non-blocking yields).
 */
async function evaluateCandidateStatisticalAsync(params: {
  operationalHC: number;
  intervals: StandardInterval[];
  openingWIP: OpeningWIPCase[];
  categories: CategoryConfig[];
  calendar: CalendarConfig;
  labor: LaborConfig;
  sla: SLAPolicyConfig;
  baseSeed: number;
  replications: number;
  queueArchitecture?: 'pooled' | 'siloed';
  precomputedCaseSets?: PrecomputedCaseSet[];
  shouldCancel?: () => boolean;
  onRepProgress?: (completedReps: number, totalReps: number) => void;
  shiftDistribution?: ShiftDistributionByCategory;
}): Promise<{
  primaryStats: PrimarySLAStatisticalResult;
  repResults: DESResult[];
  representativeResult: DESResult;
  representativeRepIndex: number;
  passesPrimaryCI: boolean;
  passesAllConstraints: boolean;
  failingReasons: string[];
}> {
  const {
    operationalHC,
    intervals,
    openingWIP,
    categories,
    calendar,
    labor,
    sla,
    baseSeed,
    replications,
    queueArchitecture = 'pooled',
    precomputedCaseSets,
    shouldCancel,
    onRepProgress,
    shiftDistribution,
  } = params;

  const R = Math.max(1, replications);
  const repResults: DESResult[] = [];
  const primarySamples: number[] = [];

  for (let r = 0; r < R; r++) {
    if (shouldCancel?.()) throw new Error('SIMULATION_CANCELLED');
    const repSeed = (baseSeed + r * 1013 + 7) % 2147483647;
    const repCases = precomputedCaseSets ? precomputedCaseSets[r] : undefined;
    const res = runBackofficeDES({
      operationalHC,
      intervals,
      openingWIP,
      categories,
      calendar,
      labor,
      sla,
      seed: repSeed,
      queueArchitecture,
      precomputedCases: repCases,
      skipCaseResultsAndTimeline: true,
      shiftDistribution,
    });
    repResults.push(res);
    primarySamples.push(res.primaryAchievedPct);

    if (r < R - 1) {
      onRepProgress?.(r + 1, R);
      if (r % 2 === 1 || intervals.length > 500) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  return computeStatisticalEvaluation(
    operationalHC,
    repResults,
    primarySamples,
    R,
    sla,
    calendar,
    categories
  );
}

/**
 * A category whose AHT exceeds its own SLA window can never attain that SLA at
 * any headcount — no amount of staff makes a single transaction finish faster
 * than the time it takes to work it. Detecting this analytically (rather than
 * discovering it only after the leap-up search exhausts userMaxHC) avoids both
 * a costly wasted search and a misleading "increase userMaxHC" message when no
 * headcount would ever help. Shared by searchOptimalHC and searchOptimalHCAsync
 * so the two search entry points never drift on this precondition.
 */
export function findImpossibleCategories(params: {
  categories: CategoryConfig[];
  intervals: StandardInterval[];
  openingWIP: OpeningWIPCase[];
  sla: SLAPolicyConfig;
  calendar: CalendarConfig;
}): {
  impossibleCategories: Array<{ name: string; ahtMinutes: number; windowMinutes: number; volumeShare: number }>;
  achievableCeilingPct: number | null;
} {
  const { categories, intervals, openingWIP, sla, calendar } = params;

  const defaultPrimaryWinMin = convertSlaDurationToMinutes(
    sla.primaryWindow,
    sla.primaryUnit,
    sla.clockBasis,
    calendar
  );

  const volumeByCategory = new Map<string, number>();
  let totalVolume = 0;
  for (const it of intervals) {
    volumeByCategory.set(it.category, (volumeByCategory.get(it.category) || 0) + it.volume);
    totalVolume += it.volume;
  }
  for (const wip of openingWIP) {
    volumeByCategory.set(wip.category, (volumeByCategory.get(wip.category) || 0) + 1);
    totalVolume += 1;
  }

  const impossibleCategories: Array<{ name: string; ahtMinutes: number; windowMinutes: number; volumeShare: number }> = [];
  for (const cat of categories) {
    const windowMinutes =
      cat.primaryWindow !== undefined && cat.primaryUnit
        ? convertSlaDurationToMinutes(cat.primaryWindow, cat.primaryUnit, sla.clockBasis, calendar)
        : (cat.primaryWindowMinutes !== undefined ? cat.primaryWindowMinutes : defaultPrimaryWinMin);

    if (cat.ahtMinutes > windowMinutes) {
      const vol = volumeByCategory.get(cat.name) || 0;
      const volumeShare = totalVolume > 0 ? vol / totalVolume : 0;
      impossibleCategories.push({ name: cat.name, ahtMinutes: cat.ahtMinutes, windowMinutes, volumeShare });
    }
  }

  if (impossibleCategories.length === 0) {
    return { impossibleCategories: [], achievableCeilingPct: null };
  }

  const impossibleShareSum = impossibleCategories.reduce((sum, c) => sum + c.volumeShare, 0);
  const achievableCeilingPct = Math.max(0, 100 * (1 - impossibleShareSum));
  return { impossibleCategories, achievableCeilingPct };
}

function formatImpossibleCategoriesReason(
  impossibleCategories: Array<{ name: string; ahtMinutes: number; windowMinutes: number; volumeShare: number }>,
  achievableCeilingPct: number
): string {
  const names = impossibleCategories
    .map(
      (c) =>
        `'${c.name}' (AHT ${c.ahtMinutes}m > SLA window ${c.windowMinutes}m, ${(c.volumeShare * 100).toFixed(1)}% of volume)`
    )
    .join('; ');
  return `The following categories can never meet their SLA at any headcount, because their AHT exceeds their own SLA window: ${names}. No amount of additional staff changes this. Even with unlimited headcount, the maximum achievable overall Primary SLA attainment is ${achievableCeilingPct.toFixed(1)}%. Reduce AHT, widen the SLA window, or exclude these categories — increasing userMaxHC will not help.`;
}

export function searchOptimalHC(params: {
  intervals: StandardInterval[];
  openingWIP: OpeningWIPCase[];
  categories: CategoryConfig[];
  calendar: CalendarConfig;
  labor: LaborConfig;
  sla: SLAPolicyConfig;
  seed: number;
  userMaxHC?: number;
  replications?: number;
  queueArchitecture?: 'pooled' | 'siloed';
}): HCSearchOutput {
  let {
    intervals,
    openingWIP,
    categories,
    calendar,
    labor,
    sla,
    seed,
    userMaxHC = 500,
    replications = 30,
    queueArchitecture = 'pooled',
  } = params;

  const validIntervals = intervals.filter(
    (it) => it.start && !isNaN(it.start.getTime()) && it.end && !isNaN(it.end.getTime())
  );

  let minStartMs = Infinity;
  let maxEndMs = -Infinity;
  for (let i = 0; i < validIntervals.length; i++) {
    const s = validIntervals[i].start.getTime();
    const e = validIntervals[i].end.getTime();
    if (s < minStartMs) minStartMs = s;
    if (e > maxEndMs) maxEndMs = e;
  }
  let horizonStart = isFinite(minStartMs) ? new Date(minStartMs) : new Date();
  let horizonEnd = isFinite(maxEndMs) ? new Date(maxEndMs) : new Date(horizonStart.getTime() + 7 * 86400000);

  if (openingWIP.length > 0) {
    for (const w of openingWIP) {
      if (w.arrival && !isNaN(w.arrival.getTime()) && w.arrival.getTime() < horizonStart.getTime()) {
        horizonStart = new Date(w.arrival);
      }
    }
  }

  const workingDaysInHorizon = getCalendarWorkingDaysInHorizon(horizonStart, horizonEnd, calendar);

  // 1. Calculate Analytical Baseline (N_min)
  const categoryMap = new Map<string, CategoryConfig>();
  categories.forEach((c) => categoryMap.set(c.name, c));

  let totalWorkloadHours = 0;
  let peakIntervalVolume = 0;

  for (const interval of intervals) {
    if (interval.volume > peakIntervalVolume) peakIntervalVolume = interval.volume;
    const cat = categoryMap.get(interval.category) || {
      id: 'default',
      name: interval.category,
      ahtMinutes: 30,
      shrinkagePct: 0.2,
      priority: 1,
    };
    totalWorkloadHours += (interval.volume * cat.ahtMinutes) / 60;
  }

  for (const wip of openingWIP) {
    const cat = categoryMap.get(wip.category) || {
      id: 'default',
      name: wip.category,
      ahtMinutes: 30,
      shrinkagePct: 0.2,
      priority: 1,
    };
    const fallbackAht = cat.ahtMinutes;
    const remMin =
      wip.remainingWorkMinutes === undefined || wip.remainingWorkMinutes === null
        ? fallbackAht
        : Math.max(0, wip.remainingWorkMinutes);
    totalWorkloadHours += remMin / 60;
  }

  const nMinBeforeReduction = computeAnalyticalNMin({
    totalWorkloadHours,
    labor,
    workingDaysInHorizon,
    occupancyCapEnabled: sla.occupancyCapEnabled,
    occupancyCapPct: sla.occupancyCapPct,
  });

  const nMinAnalytical = computeAnalyticalNMin({
    totalWorkloadHours,
    labor,
    workingDaysInHorizon,
    occupancyCapEnabled: sla.occupancyCapEnabled,
    occupancyCapPct: sla.occupancyCapPct,
    workloadReductionEnabled: sla.workloadReductionEnabled,
    workloadReductionPct: sla.workloadReductionPct,
  });

  // 3. Search Bounds & User Max HC Enforcement
  const searchCap = Math.max(1, userMaxHC);
  const evalCache = new Map<number, ReturnType<typeof evaluateCandidateStatistical>>();
  const R = Math.max(1, replications);
  const precomputedCaseSets = generatePrecomputedReplications({
    intervals,
    openingWIP,
    categories,
    calendar,
    sla,
    baseSeed: seed,
    replications: R,
  });

  // N_occ: occupancy-feasible floor, computed on the SAME hours basis the DES occupancy gate
  // actually uses (dailyProductiveHours × adherence × workingDays), not the contractual hours
  // N_min uses — those two can disagree (e.g. a contractual override larger than what the
  // simulator delivers per agent), making N_min sit below the lowest N the occupancy gate can
  // ever accept. Diagnostic/starting-point only; nMinAnalytical remains the hard floor.
  const occupancyFeasibleFloor = computeOccupancyFloor({
    totalWorkloadHours,
    labor,
    workingDaysInHorizon,
    occupancyCapEnabled: sla.occupancyCapEnabled,
    occupancyCapPct: sla.occupancyCapPct,
  });

  // N_sla: analytic deadline-coverage floor (see computeShiftPlacement) — smallest N whose
  // optimal shift placement clears the SLA target with zero DES runs. Only computed when the
  // opt-in flag is on. DIAGNOSTIC ONLY (fixed 2026-08-28, Gap A): never used as a search
  // starting point or gate — see the startN comment below for why including it there let an
  // overstated N_sla bypass the walk-down safety net.
  let placementFeasibleFloor: number | undefined;
  let placementSlapMinutes = Math.max(5, Math.round(labor.shiftSlapMinutes || 30));
  const representativeCases = precomputedCaseSets[0]?.cases as CaseEntity[] | undefined;
  // 24x7 RE-ENABLED (2026-08-28, 24x7 multi-start) — see the removed is24x7 guard in
  // computeCandidatePlacementDistribution. Note: buildOneDayDemandGrid still buckets ALL
  // 24x7 demand into a single whole-day cell (a pre-existing simplification, not new here),
  // which computeWindowDiscrimination treats as non-discriminating — so the SLA-driven
  // greedy has little placement signal for 24x7 today. Coverage-repair is unaffected (it is
  // pure geometry, independent of demand data) and is the fix that actually matters here.
  if (labor.shiftPlacementEnabled && representativeCases) {
    const shiftLengthMinutes = labor.dailyProductiveHours * 60;
    // Capacity, not span — see Gap B comment in computeCandidatePlacementDistribution above.
    const effectiveAdherence = Math.min(1.0, Math.max(0.1, labor.adherencePct || 1.0));
    const capacityMinutes = shiftLengthMinutes * effectiveAdherence;
    const validStarts = getValidSlapStarts(calendar, shiftLengthMinutes, placementSlapMinutes);
    if (validStarts.length > 0) {
      const grid = buildOneDayDemandGrid(representativeCases, calendar, placementSlapMinutes);
      placementFeasibleFloor = findPlacementFeasibleFloor({
        grid,
        validStarts,
        shiftLengthMinutes: capacityMinutes,
        slapMinutes: placementSlapMinutes,
        targetPct: effectivePrimaryTarget(sla.primaryPct, sla),
        maxN: searchCap,
      });
    }
  }

  // Distribution actually won at each N that passed with placement — reused by the final
  // audit DES run and the N−1 boundary-evidence run so what is displayed matches what the CI
  // gate actually verified, and surfaced as HCSearchOutput.shiftPlacement.winningDistribution.
  const winningDistributionByN = new Map<number, ShiftDistributionByCategory>();

  function evaluateN(n: number, overrideR?: number) {
    const rToUse = overrideR ?? R;
    if (rToUse === R && evalCache.has(n)) return evalCache.get(n)!;
    const uniformRes = evaluateCandidateStatistical({
      operationalHC: n,
      intervals,
      openingWIP,
      categories,
      calendar,
      labor,
      sla,
      baseSeed: seed,
      replications: rToUse,
      queueArchitecture,
      precomputedCaseSets,
    });

    let finalRes = uniformRes;
    let winningDist: ShiftDistributionByCategory | undefined;

    // Coverage repair (G1): unconditional, independent of shiftPlacementEnabled — the queue
    // may never be left unattended while the business is running, so this is not an
    // optimization the planner opts into. Tries the minimal redistribution needed to satisfy
    // the floor BEFORE the SLA-driven greedy below, so a config that only needs coverage
    // (SLA already fine) never pays for an unnecessary deficit-minimizing search, and a
    // config needing both gets coverage settled first. 24x7 RE-ENABLED (2026-08-28, 24x7
    // multi-start) — buildCoverageRepairDistribution now works for is24x7.
    if (!uniformRes.passesAllConstraints && representativeCases) {
      const minAgentsRequired = resolveMinAgentsPerInterval(sla, n);
      if (minAgentsRequired > 0) {
        let catWorkloadMinutes: Map<string, number> | undefined;
        if (queueArchitecture === 'siloed') {
          catWorkloadMinutes = new Map<string, number>();
          for (const c of representativeCases) {
            catWorkloadMinutes.set(c.category, (catWorkloadMinutes.get(c.category) || 0) + c.totalAhtMinutes);
          }
        }
        const coverageDist = buildCoverageRepairDistribution({
          n, calendar, labor, minAgentsPerInterval: minAgentsRequired, queueArchitecture, categoryWorkloadMinutes: catWorkloadMinutes,
        });
        if (coverageDist) {
          const coverageRes = evaluateCandidateStatistical({
            operationalHC: n, intervals, openingWIP, categories, calendar, labor, sla,
            baseSeed: seed, replications: rToUse, queueArchitecture, precomputedCaseSets,
            shiftDistribution: coverageDist,
          });
          if (coverageRes.passesAllConstraints) {
            finalRes = coverageRes;
            winningDist = coverageDist;
          }
        }
      }
    }

    if (labor.shiftPlacementEnabled && !finalRes.passesAllConstraints && representativeCases) {
      const placementDist = computeCandidatePlacementDistribution({
        n,
        cases: representativeCases,
        calendar,
        labor,
        queueArchitecture,
      });
      if (placementDist) {
        const placedRes = evaluateCandidateStatistical({
          operationalHC: n,
          intervals,
          openingWIP,
          categories,
          calendar,
          labor,
          sla,
          baseSeed: seed,
          replications: rToUse,
          queueArchitecture,
          precomputedCaseSets,
          shiftDistribution: placementDist,
        });
        const picked = pickPlacementOrUniform(finalRes, placedRes, placementDist);
        finalRes = picked.result;
        if (picked.distributionUsed) winningDist = picked.distributionUsed;
      }
    }

    if (rToUse === R) {
      evalCache.set(n, finalRes);
      if (winningDist) {
        winningDistributionByN.set(n, winningDist);
      } else {
        winningDistributionByN.delete(n);
      }
    }
    return finalRes;
  }

  let primaryDrivenHC = nMinAnalytical;
  let primaryPassedResult: ReturnType<typeof evaluateCandidateStatistical> | null = null;
  let primaryFailedResult: ReturnType<typeof evaluateCandidateStatistical> | null = null;
  let isInfeasible = false;
  let infeasibleReason: string | undefined;
  let recommendedHC: number | null = null;
  let evalN = searchCap;

  const impossibleCheck = findImpossibleCategories({ categories, intervals: validIntervals, openingWIP, sla, calendar });
  const hasImpossibleCategory = impossibleCheck.impossibleCategories.length > 0;
  const baselineExceedsCap = nMinAnalytical > searchCap;

  if (hasImpossibleCategory) {
    isInfeasible = true;
    infeasibleReason = formatImpossibleCategoriesReason(
      impossibleCheck.impossibleCategories,
      impossibleCheck.achievableCeilingPct!
    );

    // Evaluate at searchCap for concrete telemetry
    primaryFailedResult = evaluateN(searchCap);
    primaryDrivenHC = searchCap;
    recommendedHC = null;
    evalN = searchCap;
  } else if (baselineExceedsCap) {
    isInfeasible = true;
    const reductionNote = sla.workloadReductionEnabled ? ` (workload reduction ${clampWorkloadReductionPct(sla.workloadReductionPct)}% applied)` : '';
    infeasibleReason = `Steady-state workload baseline N_min (${nMinAnalytical} agents)${reductionNote} strictly exceeds the configured user max search ceiling of ${searchCap} agents. The required workload cannot be completed within this headcount cap. Increase userMaxHC or adjust volume / AHT assumptions.`;

    // Evaluate at searchCap for concrete telemetry
    primaryFailedResult = evaluateN(searchCap);
    primaryDrivenHC = searchCap;
    recommendedHC = null;
    evalN = searchCap;
  } else {
    // Search starts at whichever floor is highest. N_min stays the frozen hard floor
    // unconditionally; N_occ raises the starting point because every candidate below it is
    // PROVABLY unable to clear the always-on occupancy gate (resolveOccupancyCapPct,
    // des-engine.ts) — a real DES-verified fact, so starting there forfeits no achievable
    // saving. N_sla (placementFeasibleFloor) is DELIBERATELY EXCLUDED here — fixed
    // 2026-08-28 (Gap A). Unlike N_occ, N_sla is not a proven bound: it comes from an
    // analytic model that can disagree with true DES attainment (see the adherence
    // conflation this file's placement functions had). Including it here let an
    // overstated N_sla skip the walk-down entirely when the raised start passed
    // immediately — pickPlacementOrUniform's per-N safety net never even ran in that path,
    // so "enabling placement never recommends worse" was falsified on 2 of 192 swept
    // configs (measured: nMin=13, nOcc=14, nSla=15, flag-off recommended 14, flag-on
    // recommended 15 — see suite D34). N_sla remains reported as
    // HCSearchOutput.shiftPlacement.placementFeasibleFloor for diagnostic/UI use — it is
    // simply never used to gate or seed the search.
    const startN = Math.min(
      searchCap,
      Math.max(1, nMinAnalytical, occupancyFeasibleFloor)
    );
    const startEval = evaluateN(startN);

    if (startEval.passesAllConstraints) {
      primaryDrivenHC = startN;
      primaryPassedResult = startEval;
      recommendedHC = startN;
      evalN = startN;
      isInfeasible = false;
    } else {
      primaryFailedResult = startEval;
      let lastFail = startN;
      let step = 1;
      let ceilingHigh: number | null = null;

      // Phase 1 — LEAP UP (speed, find first passing candidate)
      let n = lastFail;
      while (n < searchCap) {
        n = Math.min(searchCap, n + step);
        const probeRes = evaluateN(n, Math.min(R, 5));
        if (!probeRes.passesAllConstraints) {
          lastFail = n;
          primaryFailedResult = probeRes;
          step = Math.max(1, step * 2);
          continue;
        }

        const fullRes = evaluateN(n);
        if (!fullRes.passesAllConstraints) {
          lastFail = n;
          primaryFailedResult = fullRes;
          step = Math.max(1, step * 2);
          continue;
        }

        ceilingHigh = n;
        break;
      }

      if (ceilingHigh !== null) {
        // Phase 2 — WALK DOWN BY EXACTLY −1
        let lastPass = ceilingHigh;
        let currN = ceilingHigh - 1;
        const floorN = startN;

        while (currN >= floorN) {
          const res = evaluateN(currN);
          if (res.passesAllConstraints) {
            lastPass = currN;
            currN = currN - 1;
          } else {
            // first fail walking down
            primaryFailedResult = res;
            break;
          }
        }

        recommendedHC = lastPass;
        primaryDrivenHC = recommendedHC;
        primaryPassedResult = evaluateN(recommendedHC);
        evalN = recommendedHC;
        isInfeasible = false;
      } else {
        // Search exhausted up to searchCap without finding a passing candidate
        isInfeasible = true;
        const failReasons = primaryFailedResult?.failingReasons?.join('; ') || 'SLA constraints not satisfied';
        infeasibleReason = `Headcount search exhausted all candidate headcounts up to the user max ceiling of ${searchCap} agents without finding a passing configuration. At N=${searchCap}: ${failReasons}. Increase userMaxHC or review SLA/labor parameters.`;
        primaryDrivenHC = searchCap;
        recommendedHC = null;
        evalN = searchCap;
      }
    }
  }

  // 4. Run final DES audit pass at evalN
  const repIdx =
    primaryPassedResult?.representativeRepIndex ??
    primaryFailedResult?.representativeRepIndex ??
    0;
  const auditSeed = (seed + repIdx * 1013 + 7) % 2147483647;
  const finalDESResult = runBackofficeDES({
    operationalHC: evalN,
    intervals,
    openingWIP,
    categories,
    calendar,
    labor,
    sla,
    seed: auditSeed,
    queueArchitecture,
    precomputedCases: precomputedCaseSets ? precomputedCaseSets[repIdx] : undefined,
    shiftDistribution: winningDistributionByN.get(evalN),
  });

  let isInfeasibleAdjacent = false;
  let infeasibleAdjacentWarning: string | undefined;

  // If search thought it passed but final single-seed DES fails sizing floor, warn but do not overturn statistical pass
  const primaryFloorSync = effectivePrimaryTarget(sla.primaryPct, sla);
  const repPrimaryMissesFloorSync = finalDESResult.primaryAchievedPct < primaryFloorSync;
  const repOtherConstraintsFailSync =
    (sla.boAsaEnabled && !finalDESResult.passesBOASA) || !finalDESResult.passesOccupancyCap;
  if (!isInfeasible && (repPrimaryMissesFloorSync || repOtherConstraintsFailSync)) {
    isInfeasibleAdjacent = true;
    infeasibleAdjacentWarning = `Representative DES run at recommended N=${evalN} fell slightly below target: Primary SLA ${finalDESResult.primaryAchievedPct}% (${formatPrimaryTargetLabel(sla.primaryPct, sla)}). Statistical ${clampConfidenceLevelPct(sla.confidenceLevelPct)}% CI across replications remains satisfied.`;
  }

  // Evaluate boundary at evalN - 1 for evidence
  let failedNResult: DESResult | undefined;
  if (evalN > 1) {
    failedNResult = runBackofficeDES({
      operationalHC: evalN - 1,
      intervals,
      openingWIP,
      categories,
      calendar,
      labor,
      sla,
      seed: auditSeed,
      queueArchitecture,
      precomputedCases: precomputedCaseSets ? precomputedCaseSets[repIdx] : undefined,
      shiftDistribution: winningDistributionByN.get(evalN - 1),
    });
  }

  // Determine binding constraint type and description
  let bindingConstraintType: HCSearchOutput['bindingConstraintType'] = 'statistical_primary_sla';
  let bindingConstraintDescription = `Primary SLA ${formatPrimaryTargetLabel(sla.primaryPct, sla)} Target (Statistical DES, ${clampConfidenceLevelPct(sla.confidenceLevelPct)}% CI)`;

  if (hasImpossibleCategory) {
    bindingConstraintType = 'category_aht_exceeds_window';
    bindingConstraintDescription = `Category AHT Exceeds SLA Window — Analytically Infeasible at Any Headcount`;
  } else if (isInfeasible) {
    bindingConstraintType = 'analytical_baseline';
    bindingConstraintDescription = `Infeasible at User Cap (N = ${searchCap})`;
  } else if (recommendedHC === nMinAnalytical) {
    bindingConstraintType = 'analytical_baseline';
    bindingConstraintDescription = 'Steady-State Workload Capacity Baseline (N_min)';
  } else if (sla.boAsaEnabled && primaryPassedResult && !primaryPassedResult.representativeResult.passesBOASA) {
    bindingConstraintType = 'bo_asa_cap';
    bindingConstraintDescription = `Backoffice ASA Target (≤ ${sla.boAsaTarget} ${sla.boAsaUnit})`;
  } else if (primaryPassedResult && !primaryPassedResult.representativeResult.passesOccupancyCap) {
    bindingConstraintType = 'occupancy_cap';
    bindingConstraintDescription = `Occupancy Cap Target (≤ ${resolveOccupancyCapPct(sla)}%)`;
  }

  // Compile search history
  const searchHistory: HCSearchOutput['searchHistory'] = [];
  const evaluatedHCs = Array.from(evalCache.keys()).sort((a, b) => a - b);
  for (const hc of evaluatedHCs) {
    const e = evalCache.get(hc)!;
    searchHistory.push({
      hc,
      primaryPct: e.primaryStats.achievedPctMedian,
      primaryCiLow: e.primaryStats.ci95Low,
      primaryCiHigh: e.primaryStats.ci95High,
      boAsaMinutes: e.representativeResult.boAsaMeanMinutes,
      occupancyPct: e.representativeResult.occupancyPct,
      rawOccupancyPct: e.representativeResult.rawOccupancyPct,
      passed: e.passesAllConstraints,
      failingReasons: e.failingReasons,
    });
  }

  // Build Boundary Evidence
  let boundaryEvidence: BoundaryEvidence | undefined;
  if (failedNResult) {
    const breachSamples: BoundaryEvidence['breachSamplesAtNMinus1'] = [];
    const failedBreaches = failedNResult.caseResults.filter(
      (c) => !c.primaryPassed
    );

    for (let i = 0; i < Math.min(10, failedBreaches.length); i++) {
      const fb = failedBreaches[i];
      breachSamples.push({
        caseId: fb.caseId,
        category: fb.category,
        arrival: formatDateTime24(fb.arrival),
        deadline: formatDateTime24(fb.primaryDeadline),
        latestSafeStart: formatDateTime24(fb.latestSafeStart),
        reason: !fb.isCompleted
          ? 'Unfinished by horizon end'
          : 'Completed after primary deadline',
      });
    }

    boundaryEvidence = {
      recommendedN: evalN,
      recommendedResult: finalDESResult,
      failedN: failedNResult.operationalHC,
      failedResult: failedNResult,
      differenceSummary: isInfeasible
        ? `Evaluated at cap N=${evalN}: Primary SLA was ${finalDESResult.primaryAchievedPct}%. Targets could not be met within userMaxHC=${searchCap}.`
        : `At N=${failedNResult.operationalHC}, Primary SLA was ${failedNResult.primaryAchievedPct}%, BO ASA was ${failedNResult.boAsaMeanMinutes}m. Stepping up to N=${evalN} achieved ${finalDESResult.primaryAchievedPct}% Primary SLA and ${finalDESResult.boAsaMeanMinutes}m BO ASA.`,
      breachSamplesAtNMinus1: breachSamples,
    };
  }

  const staffing = calculateStaffingRequirement({
    operationalHC: evalN,
    categories,
    intervals,
    openingWIP,
    calendar,
    labor,
    horizonStart,
    horizonEnd,
    bindingConstraint: bindingConstraintDescription,
  });

  return {
    nMinAnalytical,
    nMinBeforeReduction: sla.workloadReductionEnabled ? nMinBeforeReduction : undefined,
    workloadReductionAppliedPct: sla.workloadReductionEnabled ? clampWorkloadReductionPct(sla.workloadReductionPct) : undefined,
    primaryDrivenHC,
    primaryStatistical: primaryPassedResult ? primaryPassedResult.primaryStats : undefined,
    queueArchitecture,
    recommendedHC,
    isInfeasible,
    infeasibleReason,
    isInfeasibleAdjacent,
    infeasibleAdjacentWarning,
    bindingConstraintType,
    bindingConstraintDescription,
    finalDESResult,
    staffing,
    boundaryEvidence,
    searchHistory,
    occupancyFeasibleFloor,
    shiftPlacement: labor.shiftPlacementEnabled
      ? {
          enabledForRun: true,
          slapMinutes: placementSlapMinutes,
          placementFeasibleFloor,
          winningDistribution: recommendedHC !== null ? winningDistributionByN.get(recommendedHC) : undefined,
        }
      : undefined,
  };
}

export async function searchOptimalHCAsync(params: {
  intervals: StandardInterval[];
  openingWIP: OpeningWIPCase[];
  categories: CategoryConfig[];
  calendar: CalendarConfig;
  labor: LaborConfig;
  sla: SLAPolicyConfig;
  seed: number;
  userMaxHC?: number;
  replications?: number;
  queueArchitecture?: 'pooled' | 'siloed';
  onProgress?: (progress: SearchProgressState) => void;
  shouldCancel?: () => boolean;
}): Promise<HCSearchOutput> {
  let {
    intervals,
    openingWIP,
    categories,
    calendar,
    labor,
    sla,
    seed,
    userMaxHC = 500,
    replications = 30,
    queueArchitecture = 'pooled',
    onProgress,
    shouldCancel,
  } = params;

  const validIntervals = intervals.filter(
    (it) => it.start && !isNaN(it.start.getTime()) && it.end && !isNaN(it.end.getTime())
  );
  let minStartMs = Infinity;
  let maxEndMs = -Infinity;
  for (let i = 0; i < validIntervals.length; i++) {
    const s = validIntervals[i].start.getTime();
    const e = validIntervals[i].end.getTime();
    if (s < minStartMs) minStartMs = s;
    if (e > maxEndMs) maxEndMs = e;
  }
  let horizonStart = isFinite(minStartMs) ? new Date(minStartMs) : new Date();
  let horizonEnd = isFinite(maxEndMs) ? new Date(maxEndMs) : new Date(horizonStart.getTime() + 7 * 86400000);

  if (openingWIP.length > 0) {
    for (const w of openingWIP) {
      if (w.arrival && !isNaN(w.arrival.getTime()) && w.arrival.getTime() < horizonStart.getTime()) {
        horizonStart = new Date(w.arrival);
      }
    }
  }

  const workingDaysInHorizon = getCalendarWorkingDaysInHorizon(horizonStart, horizonEnd, calendar);

  // 1. Calculate Analytical Baseline (N_min)
  const categoryMap = new Map<string, CategoryConfig>();
  categories.forEach((c) => categoryMap.set(c.name, c));

  let totalWorkloadHours = 0;
  let peakIntervalVolume = 0;

  for (const interval of intervals) {
    if (interval.volume > peakIntervalVolume) peakIntervalVolume = interval.volume;
    const cat = categoryMap.get(interval.category) || {
      id: 'default',
      name: interval.category,
      ahtMinutes: 30,
      shrinkagePct: 0.2,
      priority: 1,
    };
    totalWorkloadHours += (interval.volume * cat.ahtMinutes) / 60;
  }

  for (const wip of openingWIP) {
    const cat = categoryMap.get(wip.category) || {
      id: 'default',
      name: wip.category,
      ahtMinutes: 30,
      shrinkagePct: 0.2,
      priority: 1,
    };
    const fallbackAht = cat.ahtMinutes;
    const remMin =
      wip.remainingWorkMinutes === undefined || wip.remainingWorkMinutes === null
        ? fallbackAht
        : Math.max(0, wip.remainingWorkMinutes);
    totalWorkloadHours += remMin / 60;
  }

  const nMinBeforeReduction = computeAnalyticalNMin({
    totalWorkloadHours,
    labor,
    workingDaysInHorizon,
    occupancyCapEnabled: sla.occupancyCapEnabled,
    occupancyCapPct: sla.occupancyCapPct,
  });

  const nMinAnalytical = computeAnalyticalNMin({
    totalWorkloadHours,
    labor,
    workingDaysInHorizon,
    occupancyCapEnabled: sla.occupancyCapEnabled,
    occupancyCapPct: sla.occupancyCapPct,
    workloadReductionEnabled: sla.workloadReductionEnabled,
    workloadReductionPct: sla.workloadReductionPct,
  });

  onProgress?.({
    status: 'initializing',
    phase: 'Phase 1: Analytical Workload Baseline',
    percent: 10,
    evaluatedHistory: [],
    currentMessage: `Computing steady-state workload baseline N_min...`,
  });

  await new Promise((r) => setTimeout(r, 40));

  const reductionLabel = sla.workloadReductionEnabled
    ? ` (workload reduced ${clampWorkloadReductionPct(sla.workloadReductionPct)}%)`
    : '';

  onProgress?.({
    status: 'searching',
    phase: 'Phase 1: Workload Baseline Established',
    percent: 25,
    evaluatedHistory: [],
    currentMessage: `Analytical workload baseline: ${nMinAnalytical} agents${reductionLabel}. Starting statistical Primary SLA search.`,
  });

  await new Promise((r) => setTimeout(r, 40));

  // 3. Statistical Multi-Replication Primary SLA Search with User Cap Enforcement
  const searchCap = Math.max(1, userMaxHC);
  const evalCache = new Map<number, ReturnType<typeof evaluateCandidateStatistical>>();

  // Pre-generate distinct case entities per replication for Common Random Numbers (CRN)
  const R = Math.max(1, replications);
  const precomputedCaseSets: PrecomputedCaseSet[] = [];
  for (let r = 0; r < R; r++) {
    if (shouldCancel?.()) throw new Error('SIMULATION_CANCELLED');
    const repSeed = (seed + r * 1013 + 7) % 2147483647;
    precomputedCaseSets.push(
      generateCaseEntities({
        intervals,
        openingWIP,
        categories,
        calendar,
        sla,
        seed: repSeed,
      })
    );
    if (r < R - 1) {
      onProgress?.({
        status: 'initializing',
        phase: 'Phase 1: Building CRN replications',
        percent: 25 + Math.round(((r + 1) / R) * 5),
        evaluatedHistory: [],
        currentMessage: `Building CRN replication ${r + 1}/${R}...`,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  // N_occ / N_sla — identical math to searchOptimalHC, via the same shared pure functions
  // (computeOccupancyFloor / computeCandidatePlacementDistribution / findPlacementFeasibleFloor
  // in this file), so the two search entry points cannot drift on this logic the way D8/D11
  // record they already have for the off-hours mitigation.
  const occupancyFeasibleFloor = computeOccupancyFloor({
    totalWorkloadHours,
    labor,
    workingDaysInHorizon,
    occupancyCapEnabled: sla.occupancyCapEnabled,
    occupancyCapPct: sla.occupancyCapPct,
  });

  // DIAGNOSTIC ONLY (Gap A, fixed 2026-08-28) — see searchOptimalHC's identical comment.
  // 24x7 RE-ENABLED (2026-08-28, 24x7 multi-start) — see searchOptimalHC's identical comment
  // on the demand-grid caveat for 24x7 placement quality.
  let placementFeasibleFloor: number | undefined;
  const placementSlapMinutes = Math.max(5, Math.round(labor.shiftSlapMinutes || 30));
  const representativeCases = precomputedCaseSets[0]?.cases as CaseEntity[] | undefined;
  if (labor.shiftPlacementEnabled && representativeCases) {
    const shiftLengthMinutes = labor.dailyProductiveHours * 60;
    // Capacity, not span — see Gap B comment in computeCandidatePlacementDistribution.
    const effectiveAdherence = Math.min(1.0, Math.max(0.1, labor.adherencePct || 1.0));
    const capacityMinutes = shiftLengthMinutes * effectiveAdherence;
    const validStarts = getValidSlapStarts(calendar, shiftLengthMinutes, placementSlapMinutes);
    if (validStarts.length > 0) {
      const grid = buildOneDayDemandGrid(representativeCases, calendar, placementSlapMinutes);
      placementFeasibleFloor = findPlacementFeasibleFloor({
        grid,
        validStarts,
        shiftLengthMinutes: capacityMinutes,
        slapMinutes: placementSlapMinutes,
        targetPct: effectivePrimaryTarget(sla.primaryPct, sla),
        maxN: searchCap,
      });
    }
  }

  const winningDistributionByN = new Map<number, ShiftDistributionByCategory>();

  function buildHistorySnapshot(): SearchProgressState['evaluatedHistory'] {
    const list: SearchProgressState['evaluatedHistory'] = [];
    const keys = Array.from(evalCache.keys()).sort((a, b) => a - b);
    for (const hc of keys) {
      const e = evalCache.get(hc)!;
      list.push({
        hc,
        primaryPct: e.primaryStats.achievedPctMedian,
        boAsaMinutes: e.representativeResult.boAsaMeanMinutes,
        occupancyPct: e.representativeResult.occupancyPct,
        rawOccupancyPct: e.representativeResult.rawOccupancyPct,
        passed: e.passesAllConstraints,
        failingReasons: e.failingReasons,
      });
    }
    return list;
  }

  async function evaluateAsync(n: number, progressPct: number, msg: string, overrideR?: number) {
    const rToUse = overrideR ?? R;
    if (rToUse === R && evalCache.has(n)) return evalCache.get(n)!;
    if (shouldCancel?.()) throw new Error('SIMULATION_CANCELLED');

    onProgress?.({
      status: 'searching',
      phase: `Phase 2: Statistical Primary SLA Search (Testing N = ${n})`,
      currentN: n,
      nMin: nMinAnalytical,
      maxN: searchCap,
      percent: progressPct,
      evaluatedHistory: buildHistorySnapshot(),
      currentMessage: msg,
    });

    const uniformRes = await evaluateCandidateStatisticalAsync({
      operationalHC: n,
      intervals,
      openingWIP,
      categories,
      calendar,
      labor,
      sla,
      baseSeed: seed,
      replications: rToUse,
      queueArchitecture,
      precomputedCaseSets,
      shouldCancel,
      onRepProgress: (completedReps, totalReps) => {
        onProgress?.({
          status: 'searching',
          phase: `Phase 2: Statistical Primary SLA Search (Testing N = ${n})`,
          currentN: n,
          nMin: nMinAnalytical,
          maxN: searchCap,
          percent: progressPct,
          evaluatedHistory: buildHistorySnapshot(),
          currentMessage: `${msg} (${completedReps}/${totalReps} replications)`,
        });
      },
    });

    let finalRes = uniformRes;
    let winningDist: ShiftDistributionByCategory | undefined;

    // Coverage repair (G1) — same shared buildCoverageRepairDistribution as searchOptimalHC's
    // evaluateN; unconditional, independent of shiftPlacementEnabled. See that function's
    // comment for why this runs before the SLA-driven greedy below. 24x7 RE-ENABLED
    // (2026-08-28, 24x7 multi-start).
    if (!uniformRes.passesAllConstraints && representativeCases) {
      if (shouldCancel?.()) throw new Error('SIMULATION_CANCELLED');
      const minAgentsRequired = resolveMinAgentsPerInterval(sla, n);
      if (minAgentsRequired > 0) {
        let catWorkloadMinutes: Map<string, number> | undefined;
        if (queueArchitecture === 'siloed') {
          catWorkloadMinutes = new Map<string, number>();
          for (const c of representativeCases) {
            catWorkloadMinutes.set(c.category, (catWorkloadMinutes.get(c.category) || 0) + c.totalAhtMinutes);
          }
        }
        const coverageDist = buildCoverageRepairDistribution({
          n, calendar, labor, minAgentsPerInterval: minAgentsRequired, queueArchitecture, categoryWorkloadMinutes: catWorkloadMinutes,
        });
        if (coverageDist) {
          const coverageRes = await evaluateCandidateStatisticalAsync({
            operationalHC: n, intervals, openingWIP, categories, calendar, labor, sla,
            baseSeed: seed, replications: rToUse, queueArchitecture, precomputedCaseSets,
            shouldCancel, shiftDistribution: coverageDist,
          });
          if (coverageRes.passesAllConstraints) {
            finalRes = coverageRes;
            winningDist = coverageDist;
          }
        }
      }
    }

    // Same shared computeCandidatePlacementDistribution / pickPlacementOrUniform as
    // searchOptimalHC's evaluateN — see that function's comment for the guarantees this
    // preserves (never-worse, monotone-safe gate).
    if (labor.shiftPlacementEnabled && !finalRes.passesAllConstraints && representativeCases) {
      if (shouldCancel?.()) throw new Error('SIMULATION_CANCELLED');
      const placementDist = computeCandidatePlacementDistribution({
        n,
        cases: representativeCases,
        calendar,
        labor,
        queueArchitecture,
      });
      if (placementDist) {
        onProgress?.({
          status: 'searching',
          phase: `Phase 2: Statistical Primary SLA Search (Testing N = ${n})`,
          currentN: n,
          nMin: nMinAnalytical,
          maxN: searchCap,
          percent: progressPct,
          evaluatedHistory: buildHistorySnapshot(),
          currentMessage: `${msg} (verifying deadline-coverage shift placement)`,
        });
        const placedRes = await evaluateCandidateStatisticalAsync({
          operationalHC: n,
          intervals,
          openingWIP,
          categories,
          calendar,
          labor,
          sla,
          baseSeed: seed,
          replications: rToUse,
          queueArchitecture,
          precomputedCaseSets,
          shouldCancel,
          shiftDistribution: placementDist,
        });
        const picked = pickPlacementOrUniform(finalRes, placedRes, placementDist);
        finalRes = picked.result;
        if (picked.distributionUsed) winningDist = picked.distributionUsed;
      }
    }

    if (rToUse === R) {
      evalCache.set(n, finalRes);
      if (winningDist) {
        winningDistributionByN.set(n, winningDist);
      } else {
        winningDistributionByN.delete(n);
      }
    }
    return finalRes;
  }

  let primaryDrivenHC = nMinAnalytical;
  let primaryPassedResult: ReturnType<typeof evaluateCandidateStatistical> | null = null;
  let primaryFailedResult: ReturnType<typeof evaluateCandidateStatistical> | null = null;
  let isInfeasible = false;
  let infeasibleReason: string | undefined;
  let recommendedHC: number | null = null;
  let evalN = searchCap;

  const impossibleCheck = findImpossibleCategories({ categories, intervals: validIntervals, openingWIP, sla, calendar });
  const hasImpossibleCategory = impossibleCheck.impossibleCategories.length > 0;
  const baselineExceedsCap = nMinAnalytical > searchCap;

  if (hasImpossibleCategory) {
    isInfeasible = true;
    infeasibleReason = formatImpossibleCategoriesReason(
      impossibleCheck.impossibleCategories,
      impossibleCheck.achievableCeilingPct!
    );

    // Evaluate candidate at cap for telemetry
    primaryFailedResult = await evaluateAsync(
      searchCap,
      50,
      `Category AHT exceeds SLA window — analytically infeasible. Testing at user cap N = ${searchCap} for telemetry...`
    );
    primaryDrivenHC = searchCap;
    recommendedHC = null;
    evalN = searchCap;
  } else if (baselineExceedsCap) {
    isInfeasible = true;
    const reductionNote = sla.workloadReductionEnabled ? ` (workload reduction ${clampWorkloadReductionPct(sla.workloadReductionPct)}% applied)` : '';
    infeasibleReason = `Steady-state workload baseline N_min (${nMinAnalytical} agents)${reductionNote} strictly exceeds the configured user max search ceiling of ${searchCap} agents. The required workload cannot be completed within this headcount cap. Increase userMaxHC or adjust volume / AHT assumptions.`;

    // Evaluate candidate at cap for telemetry
    primaryFailedResult = await evaluateAsync(
      searchCap,
      50,
      `Workload baseline (${nMinAnalytical}) exceeds cap (${searchCap}). Testing at user cap N = ${searchCap}...`
    );
    primaryDrivenHC = searchCap;
    recommendedHC = null;
    evalN = searchCap;
  } else {
    // Same starting-point logic as searchOptimalHC — see its comment for why N_sla
    // (placementFeasibleFloor) is deliberately excluded here (Gap A, fixed 2026-08-28).
    // N_min stays the frozen hard floor unconditionally; N_occ only ever raises the
    // starting point (a proven, DES-verified bound — N_sla is not).
    const startN = Math.min(
      searchCap,
      Math.max(1, nMinAnalytical, occupancyFeasibleFloor)
    );
    const startEval = await evaluateAsync(
      startN,
      30,
      `Evaluating analytical baseline N = ${startN} across ${replications} stochastic replications...`
    );

    if (startEval.passesAllConstraints) {
      primaryDrivenHC = startN;
      primaryPassedResult = startEval;
      recommendedHC = startN;
      evalN = startN;
      isInfeasible = false;
    } else {
      primaryFailedResult = startEval;
      let lastFail = startN;
      let step = 1;
      let ceilingHigh: number | null = null;
      let leapIndex = 1;

      // Phase 1 — LEAP UP (speed, find first passing candidate)
      let n = lastFail;
      while (n < searchCap) {
        if (shouldCancel?.()) throw new Error('SIMULATION_CANCELLED');

        n = Math.min(searchCap, n + step);
        const estProgress = Math.min(65, Math.round(30 + leapIndex * 6));
        const probeRes = await evaluateAsync(
          n,
          estProgress,
          `Leap test N=${n} (ceiling search, not final)...`,
          Math.min(R, 5)
        );

        leapIndex++;
        if (!probeRes.passesAllConstraints) {
          lastFail = n;
          primaryFailedResult = probeRes;
          step = Math.max(1, step * 2);
          continue;
        }

        const fullRes = await evaluateAsync(
          n,
          Math.min(75, estProgress + 5),
          `Full-R confirm leap N=${n}...`
        );

        if (!fullRes.passesAllConstraints) {
          lastFail = n;
          primaryFailedResult = fullRes;
          step = Math.max(1, step * 2);
          continue;
        }

        ceilingHigh = n;
        break;
      }

      if (ceilingHigh !== null) {
        // Phase 2 — WALK DOWN BY EXACTLY −1
        let lastPass = ceilingHigh;
        let currN = ceilingHigh - 1;
        const floorN = startN;
        const totalDownSteps = Math.max(1, ceilingHigh - floorN);
        let downStepIndex = 0;

        while (currN >= floorN) {
          if (shouldCancel?.()) throw new Error('SIMULATION_CANCELLED');

          downStepIndex++;
          const downProgress = Math.min(92, Math.round(75 + (downStepIndex / totalDownSteps) * 17));
          const res = await evaluateAsync(
            currN,
            downProgress,
            `Refining −1: N=${currN} (ceiling was ${ceilingHigh})...`
          );

          if (res.passesAllConstraints) {
            lastPass = currN;
            currN = currN - 1;
          } else {
            // first fail walking down
            primaryFailedResult = res;
            break;
          }
        }

        recommendedHC = lastPass;
        primaryDrivenHC = recommendedHC;
        primaryPassedResult = await evaluateAsync(
          recommendedHC,
          93,
          `Lowest verified-passing N=${recommendedHC} found (N-1=${recommendedHC - 1} failed the gate). Leap ${ceilingHigh} discarded.`
        );
        evalN = recommendedHC;
        isInfeasible = false;
      } else {
        // Search exhausted up to searchCap without finding a passing candidate
        isInfeasible = true;
        const failReasons = primaryFailedResult?.failingReasons?.join('; ') || 'SLA constraints not satisfied';
        infeasibleReason = `Headcount search exhausted all candidate headcounts up to the user max ceiling of ${searchCap} agents without finding a passing configuration. At N=${searchCap}: ${failReasons}. Increase userMaxHC or review SLA/labor parameters.`;
        primaryDrivenHC = searchCap;
        recommendedHC = null;
        evalN = searchCap;
      }
    }
  }

  // 4. Run final DES audit pass at evalN
  onProgress?.({
    status: isInfeasible ? 'infeasible' : 'verifying_boundary',
    phase: isInfeasible
      ? `Search Infeasible at Cap (N = ${searchCap})`
      : 'Phase 3: Final Audit Pass & Boundary Verification',
    currentN: evalN,
    nMin: nMinAnalytical,
    maxN: searchCap,
    percent: 94,
    evaluatedHistory: buildHistorySnapshot(),
    currentMessage: isInfeasible
      ? `Audit at cap N = ${evalN}: Constraints breached. Generating diagnostic evidence...`
      : `Running full DES audit at recommended N = ${evalN} (Primary-driven: ${primaryDrivenHC})...`,
  });

  await new Promise((r) => setTimeout(r, 40));

  const repIdx =
    primaryPassedResult?.representativeRepIndex ??
    primaryFailedResult?.representativeRepIndex ??
    0;
  const auditSeed = (seed + repIdx * 1013 + 7) % 2147483647;
  const finalDESResult = runBackofficeDES({
    operationalHC: evalN,
    intervals,
    openingWIP,
    categories,
    calendar,
    labor,
    sla,
    seed: auditSeed,
    queueArchitecture,
    precomputedCases: precomputedCaseSets ? precomputedCaseSets[repIdx] : undefined,
    shiftDistribution: winningDistributionByN.get(evalN),
  });

  let isInfeasibleAdjacent = false;
  let infeasibleAdjacentWarning: string | undefined;

  // If search thought it passed but final single-seed DES fails sizing floor, warn but do not overturn statistical pass
  const primaryFloorAsync = effectivePrimaryTarget(sla.primaryPct, sla);
  const repPrimaryMissesFloorAsync = finalDESResult.primaryAchievedPct < primaryFloorAsync;
  const repOtherConstraintsFailAsync =
    (sla.boAsaEnabled && !finalDESResult.passesBOASA) || !finalDESResult.passesOccupancyCap;
  if (!isInfeasible && (repPrimaryMissesFloorAsync || repOtherConstraintsFailAsync)) {
    isInfeasibleAdjacent = true;
    infeasibleAdjacentWarning = `Representative DES run at recommended N=${evalN} fell slightly below target: Primary SLA ${finalDESResult.primaryAchievedPct}% (${formatPrimaryTargetLabel(sla.primaryPct, sla)}). Statistical ${clampConfidenceLevelPct(sla.confidenceLevelPct)}% CI across replications remains satisfied.`;
  }

  let failedNResult: DESResult | undefined;
  if (evalN > 1) {
    failedNResult = runBackofficeDES({
      operationalHC: evalN - 1,
      intervals,
      openingWIP,
      categories,
      calendar,
      labor,
      sla,
      seed: auditSeed,
      queueArchitecture,
      precomputedCases: precomputedCaseSets ? precomputedCaseSets[repIdx] : undefined,
      shiftDistribution: winningDistributionByN.get(evalN - 1),
    });
  }

  // Determine binding constraint
  let bindingConstraintType: HCSearchOutput['bindingConstraintType'] = 'statistical_primary_sla';
  let bindingConstraintDescription = `Primary SLA ${formatPrimaryTargetLabel(sla.primaryPct, sla)} Target (Statistical DES, ${clampConfidenceLevelPct(sla.confidenceLevelPct)}% CI)`;

  if (hasImpossibleCategory) {
    bindingConstraintType = 'category_aht_exceeds_window';
    bindingConstraintDescription = `Category AHT Exceeds SLA Window — Analytically Infeasible at Any Headcount`;
  } else if (isInfeasible) {
    bindingConstraintType = 'analytical_baseline';
    bindingConstraintDescription = `Infeasible at User Cap (N = ${searchCap})`;
  } else if (recommendedHC === nMinAnalytical) {
    bindingConstraintType = 'analytical_baseline';
    bindingConstraintDescription = 'Steady-State Workload Capacity Baseline (N_min)';
  } else if (sla.boAsaEnabled && primaryPassedResult && !primaryPassedResult.representativeResult.passesBOASA) {
    bindingConstraintType = 'bo_asa_cap';
    bindingConstraintDescription = `Backoffice ASA Target (≤ ${sla.boAsaTarget} ${sla.boAsaUnit})`;
  } else if (primaryPassedResult && !primaryPassedResult.representativeResult.passesOccupancyCap) {
    bindingConstraintType = 'occupancy_cap';
    bindingConstraintDescription = `Occupancy Cap Target (≤ ${resolveOccupancyCapPct(sla)}%)`;
  }

  // Compile search history
  const searchHistory: HCSearchOutput['searchHistory'] = [];
  const evaluatedHCs = Array.from(evalCache.keys()).sort((a, b) => a - b);
  for (const hc of evaluatedHCs) {
    const e = evalCache.get(hc)!;
    searchHistory.push({
      hc,
      primaryPct: e.primaryStats.achievedPctMedian,
      primaryCiLow: e.primaryStats.ci95Low,
      primaryCiHigh: e.primaryStats.ci95High,
      boAsaMinutes: e.representativeResult.boAsaMeanMinutes,
      occupancyPct: e.representativeResult.occupancyPct,
      rawOccupancyPct: e.representativeResult.rawOccupancyPct,
      passed: e.passesAllConstraints,
      failingReasons: e.failingReasons,
    });
  }

  // Build Boundary Evidence
  let boundaryEvidence: BoundaryEvidence | undefined;
  if (failedNResult) {
    const breachSamples: BoundaryEvidence['breachSamplesAtNMinus1'] = [];
    const failedBreaches = failedNResult.caseResults.filter(
      (c) => !c.primaryPassed
    );

    for (let i = 0; i < Math.min(10, failedBreaches.length); i++) {
      const fb = failedBreaches[i];
      breachSamples.push({
        caseId: fb.caseId,
        category: fb.category,
        arrival: formatDateTime24(fb.arrival),
        deadline: formatDateTime24(fb.primaryDeadline),
        latestSafeStart: formatDateTime24(fb.latestSafeStart),
        reason: !fb.isCompleted
          ? 'Unfinished by horizon end'
          : 'Completed after primary deadline',
      });
    }

    boundaryEvidence = {
      recommendedN: evalN,
      recommendedResult: finalDESResult,
      failedN: failedNResult.operationalHC,
      failedResult: failedNResult,
      differenceSummary: isInfeasible
        ? `Evaluated at cap N=${evalN}: Primary SLA was ${finalDESResult.primaryAchievedPct}%. Targets could not be met within userMaxHC=${searchCap}.`
        : `At N=${failedNResult.operationalHC}, Primary SLA was ${failedNResult.primaryAchievedPct}%, BO ASA was ${failedNResult.boAsaMeanMinutes}m. Stepping up to N=${evalN} achieved ${finalDESResult.primaryAchievedPct}% Primary SLA and ${finalDESResult.boAsaMeanMinutes}m BO ASA.`,
      breachSamplesAtNMinus1: breachSamples,
    };
  }

  const staffing = calculateStaffingRequirement({
    operationalHC: evalN,
    categories,
    intervals,
    openingWIP,
    calendar,
    labor,
    horizonStart,
    horizonEnd,
    bindingConstraint: bindingConstraintDescription,
  });

  onProgress?.({
    status: isInfeasible ? 'infeasible' : 'completed',
    phase: isInfeasible ? 'Search Infeasible at Cap' : 'Sizing & Verification Complete',
    currentN: evalN,
    nMin: nMinAnalytical,
    maxN: searchCap,
    percent: 100,
    evaluatedHistory: buildHistorySnapshot(),
    currentMessage: isInfeasible
      ? `Search Infeasible: ${infeasibleReason}`
      : `Optimal Staffing: ${recommendedHC} Operational HC (Primary-Driven: ${primaryDrivenHC} with ${clampConfidenceLevelPct(sla.confidenceLevelPct)}% CI).`,
  });

  await new Promise((r) => setTimeout(r, 50));

  return {
    nMinAnalytical,
    nMinBeforeReduction: sla.workloadReductionEnabled ? nMinBeforeReduction : undefined,
    workloadReductionAppliedPct: sla.workloadReductionEnabled ? clampWorkloadReductionPct(sla.workloadReductionPct) : undefined,
    primaryDrivenHC,
    primaryStatistical: primaryPassedResult ? primaryPassedResult.primaryStats : undefined,
    queueArchitecture,
    recommendedHC,
    isInfeasible,
    infeasibleReason,
    isInfeasibleAdjacent,
    infeasibleAdjacentWarning,
    bindingConstraintType,
    bindingConstraintDescription,
    searchHistory,
    finalDESResult,
    staffing,
    boundaryEvidence,
    occupancyFeasibleFloor,
    shiftPlacement: labor.shiftPlacementEnabled
      ? {
          enabledForRun: true,
          slapMinutes: placementSlapMinutes,
          placementFeasibleFloor,
          winningDistribution: recommendedHC !== null ? winningDistributionByN.get(recommendedHC) : undefined,
        }
      : undefined,
  };
}

