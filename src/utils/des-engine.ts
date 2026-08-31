/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentRosterSource,
  AgentSliceState,
  AgentWorkSlice,
  CalendarConfig,
  CaseEntity,
  CaseRunResult,
  CategoryConfig,
  DESResult,
  EventType,
  LaborConfig,
  OpeningWIPCase,
  ShiftDistributionByCategory,
  SimEvent,
  SLAPolicyConfig,
  StandardInterval,
} from '../types/wfm';
import {
  addWorkingTime,
  computeIntervalHorizon,
  convertSlaDurationToMinutes,
  formatTime24,
  getCalendarWorkingDaysInHorizon,
  getDailyOpenClose,
  isWorking,
  isWorkingDay,
  nextOpen,
  subtractWorkingTime,
  workingDuration,
} from './calendar';

// Event type numeric precedence for strict tie-breaking (1 = highest precedence)
const EVENT_TYPE_ORDER: Record<EventType, number> = {
  ProcessingComplete: 1,
  CasePark: 2,
  AgentAvailable: 3,
  ShiftEnd: 3,
  DayClose: 3,
  CaseResume: 4,
  SimulationEnd: 5,
  CaseArrival: 6,
  SLAClockStart: 7,
  CaseAssignment: 8,
  ProcessingStart: 9,
  SLARisk: 10,
  SLADeadline: 10,
  SLABreach: 10,
};

// High-performance Binary Min-Heap Priority Queue for discrete event simulation
class SimEventHeap {
  private data: SimEvent[] = [];

  get length(): number {
    return this.data.length;
  }

  push(ev: SimEvent) {
    this.data.push(ev);
    this.bubbleUp(this.data.length - 1);
  }

  peek(): SimEvent | undefined {
    return this.data[0];
  }

  pop(): SimEvent | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const bottom = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = bottom;
      this.bubbleDown(0);
    }
    return top;
  }

  private compare(a: SimEvent, b: SimEvent): number {
    if (a.timeMs !== b.timeMs) return a.timeMs - b.timeMs;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.entityId.localeCompare(b.entityId);
  }

  private bubbleUp(idx: number) {
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (this.compare(this.data[idx], this.data[parent]) < 0) {
        const tmp = this.data[idx];
        this.data[idx] = this.data[parent];
        this.data[parent] = tmp;
        idx = parent;
      } else {
        break;
      }
    }
  }

  private bubbleDown(idx: number) {
    const len = this.data.length;
    while (true) {
      const left = (idx << 1) + 1;
      const right = left + 1;
      let smallest = idx;

      if (left < len && this.compare(this.data[left], this.data[smallest]) < 0) {
        smallest = left;
      }
      if (right < len && this.compare(this.data[right], this.data[smallest]) < 0) {
        smallest = right;
      }
      if (smallest !== idx) {
        const tmp = this.data[idx];
        this.data[idx] = this.data[smallest];
        this.data[smallest] = tmp;
        idx = smallest;
      } else {
        break;
      }
    }
  }
}

// High-performance Binary Min-Heap Priority Queue for Case Queue (O(log K) push and pop)
export class CaseMinHeap {
  private data: CaseEntity[] = [];

  get length(): number {
    return this.data.length;
  }

  getInternalData(): CaseEntity[] {
    return this.data;
  }

  push(c: CaseEntity, _isResumed: boolean = false) {
    this.data.push(c);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): CaseEntity | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const bottom = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = bottom;
      this.bubbleDown(0);
    }
    return top;
  }

  removeAt(idx: number): boolean {
    if (idx < 0 || idx >= this.data.length) return false;
    const bottom = this.data.pop()!;
    if (idx < this.data.length) {
      this.data[idx] = bottom;
      this.bubbleUp(idx);
      this.bubbleDown(idx);
    }
    return true;
  }

  remove(c: CaseEntity): boolean {
    const idx = this.data.findIndex((item) => item.id === c.id || item.syntheticId === c.syntheticId);
    if (idx === -1) return false;
    return this.removeAt(idx);
  }

  toArray(): CaseEntity[] {
    return [...this.data];
  }

  private compare(a: CaseEntity, b: CaseEntity): number {
    // 1. Resumed/parked cases with remaining partial work take precedence
    const aParked = a.parkCount > 0 || a.remainingWorkMinutes < a.totalAhtMinutes ? 1 : 0;
    const bParked = b.parkCount > 0 || b.remainingWorkMinutes < b.totalAhtMinutes ? 1 : 0;
    if (aParked !== bParked) return bParked - aParked;

    // 2. Earliest Latest Safe Start / SLA Urgency (EDF)
    const aLss = a.latestSafeStart.getTime();
    const bLss = b.latestSafeStart.getTime();
    if (aLss !== bLss) return aLss - bLss;

    // 3. Category / Case Priority (1 = highest) as tie-breaker
    if (a.priority !== b.priority) return a.priority - b.priority;

    // 4. Arrival time (FIFO)
    const aArr = a.arrival.getTime();
    const bArr = b.arrival.getTime();
    if (aArr !== bArr) return aArr - bArr;

    // 5. Synthetic Id tie-breaker
    return a.syntheticId - b.syntheticId;
  }

  private bubbleUp(idx: number) {
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (this.compare(this.data[idx], this.data[parent]) < 0) {
        const tmp = this.data[idx];
        this.data[idx] = this.data[parent];
        this.data[parent] = tmp;
        idx = parent;
      } else {
        break;
      }
    }
  }

  private bubbleDown(idx: number) {
    const len = this.data.length;
    while (true) {
      const left = (idx << 1) + 1;
      const right = left + 1;
      let smallest = idx;

      if (left < len && this.compare(this.data[left], this.data[smallest]) < 0) {
        smallest = left;
      }
      if (right < len && this.compare(this.data[right], this.data[smallest]) < 0) {
        smallest = right;
      }
      if (smallest !== idx) {
        const tmp = this.data[idx];
        this.data[idx] = this.data[smallest];
        this.data[smallest] = tmp;
        idx = smallest;
      } else {
        break;
      }
    }
  }
}

function compareByUrgency(a: CaseEntity, b: CaseEntity): number {
  const aLss = a.latestSafeStart.getTime();
  const bLss = b.latestSafeStart.getTime();
  if (aLss !== bLss) return aLss - bLss;
  if (a.priority !== b.priority) return a.priority - b.priority;
  const aArr = a.arrival.getTime();
  const bArr = b.arrival.getTime();
  if (aArr !== bArr) return aArr - bArr;
  return a.syntheticId - b.syntheticId;
}

export function pickNextCase(queue: CaseMinHeap, _now: Date): CaseEntity | undefined {
  const len = queue.length;
  if (len === 0) return undefined;
  if (len === 1) return queue.pop();

  const data = queue.getInternalData();

  let bestParkedIdx = -1;
  let bestNewIdx = -1;

  for (let i = 0; i < len; i++) {
    const c = data[i];
    const isParked = c.parkCount > 0 || c.remainingWorkMinutes < c.totalAhtMinutes;
    if (isParked) {
      if (bestParkedIdx === -1 || compareByUrgency(c, data[bestParkedIdx]) < 0) {
        bestParkedIdx = i;
      }
    } else if (bestNewIdx === -1 || compareByUrgency(c, data[bestNewIdx]) < 0) {
      bestNewIdx = i;
    }
  }

  const chosenIdx = bestParkedIdx !== -1 ? bestParkedIdx : bestNewIdx !== -1 ? bestNewIdx : 0;
  const chosen = data[chosenIdx];
  queue.removeAt(chosenIdx);
  return chosen;
}

// Seedable PRNG (Mulberry32) for Common Random Numbers (CRN)
function createPrng(seed: number) {
  let s = Math.floor(seed) || 123456789;
  return function next() {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ActiveProcessingState {
  caseId: string;
  agentIndex: number;
  startTime: Date;
  scheduledEndTime: Date;
  workAssignedMinutes: number;
}

/**
 * Splits operational headcount across categories for the siloed queue architecture,
 * proportionally to each category's workload.
 *
 * Returns a map of category name -> agent count. Total always equals operationalHC.
 *
 * Uses the Webster/Sainte-Laguë divisor method (highest averages), assigning agents
 * one at a time. This matters for correctness, not just style: the headcount search
 * walks N downward and stops at the first failing N, which is only valid if pass/fail
 * is monotone in N. The previous largest-remainder (Hamilton) method is subject to the
 * apportionment "Alabama paradox" — raising total headcount can REDUCE a category's
 * agents, because every candidate's fractional remainders re-rank. Measured on a
 * realistic workload split, Hamilton produced 14 such reversals over N=1..200,
 * including a category dropping from 1 agent to 0 (a silo with work and nobody to do
 * it, i.e. an unbounded queue). A divisor method cannot do this: allocation(N+1) is
 * always allocation(N) plus one more agent, so it is house-monotone by construction.
 *
 * Every category holding work is guaranteed at least one agent before any category
 * receives a second, provided headcount allows. In a siloed model an unstaffed queue
 * never drains, so starvation is worse than a small proportionality error.
 */
export function allocateAgentsToCategories(
  catWorkloadMinutes: Map<string, number>,
  operationalHC: number
): Map<string, number> {
  // Sorted for deterministic tie-breaking (reproducible runs for a given seed).
  const catList = Array.from(catWorkloadMinutes.keys()).sort();
  const seats = new Map<string, number>(catList.map((n) => [n, 0]));

  if (operationalHC <= 0 || catList.length === 0) return seats;

  const withWork = catList.filter((n) => (catWorkloadMinutes.get(n) || 0) > 0);
  // With no workload anywhere, spread across all categories rather than starving some.
  const targets = withWork.length > 0 ? withWork : catList;

  let remaining = operationalHC;

  // Phase 1 — one agent per category that has work, while headcount lasts.
  for (const name of targets) {
    if (remaining <= 0) break;
    seats.set(name, 1);
    remaining--;
  }

  // Phase 2 — remaining agents by highest averages.
  while (remaining > 0) {
    let best = targets[0];
    let bestQuotient = -Infinity;
    for (const name of targets) {
      const quotient = (catWorkloadMinutes.get(name) || 0) / (2 * (seats.get(name) || 0) + 1);
      if (quotient > bestQuotient) {
        bestQuotient = quotient;
        best = name;
      }
    }
    seats.set(best, (seats.get(best) || 0) + 1);
    remaining--;
  }

  return seats;
}

export function generateCaseEntities(params: {
  intervals: StandardInterval[];
  openingWIP: OpeningWIPCase[];
  categories: CategoryConfig[];
  calendar: CalendarConfig;
  sla: SLAPolicyConfig;
  seed: number;
}): { cases: CaseEntity[]; horizonStart: Date; horizonEnd: Date } {
  const { intervals, openingWIP, categories, calendar, sla, seed } = params;

  const categoryMap = new Map<string, CategoryConfig>();
  categories.forEach((c) => categoryMap.set(c.name, c));

  // Determine horizon start and end strictly across min/max of intervals and openingWIP
  const { horizonStart, horizonEnd } = computeIntervalHorizon(intervals, openingWIP);

  const prng = createPrng(seed);
  const allCases: CaseEntity[] = [];
  let nextSyntheticId = 1;
  let caseIdCounter = 1;

  const defaultPrimaryWinMin = convertSlaDurationToMinutes(
    sla.primaryWindow,
    sla.primaryUnit,
    sla.clockBasis,
    calendar
  );

  // Add opening WIP
  for (const wip of openingWIP) {
    const cat = categoryMap.get(wip.category) || {
      id: 'default',
      name: wip.category,
      ahtMinutes: 30,
      shrinkagePct: 0.2,
      priority: wip.priority || 1,
      primaryPct: sla.primaryPct,
      primaryWindowMinutes: defaultPrimaryWinMin,
    };

    const arrival = wip.arrival && !isNaN(wip.arrival.getTime()) ? new Date(wip.arrival) : new Date(horizonStart);
    const clockStart = sla.clockStartPolicy === 'next_open' ? nextOpen(arrival, calendar) : new Date(arrival);

    const primaryWinMin =
      cat.primaryWindow !== undefined && cat.primaryUnit
        ? convertSlaDurationToMinutes(cat.primaryWindow, cat.primaryUnit, sla.clockBasis, calendar)
        : (cat.primaryWindowMinutes !== undefined ? cat.primaryWindowMinutes : defaultPrimaryWinMin);

    const primaryDeadline =
      sla.clockBasis === 'business_time'
        ? addWorkingTime(clockStart, primaryWinMin, calendar)
        : new Date(clockStart.getTime() + primaryWinMin * 60 * 1000);

    const totalAht = cat.ahtMinutes;
    const remainingAht =
      wip.remainingWorkMinutes !== undefined && wip.remainingWorkMinutes !== null
        ? wip.remainingWorkMinutes
        : totalAht;

    const latestSafeStart =
      sla.clockBasis === 'business_time'
        ? subtractWorkingTime(primaryDeadline, remainingAht, calendar)
        : new Date(primaryDeadline.getTime() - remainingAht * 60 * 1000);

    const sId = nextSyntheticId++;
    allCases.push({
      id: wip.id || `WIP-${String(caseIdCounter++).padStart(4, '0')}`,
      syntheticId: sId,
      category: wip.category,
      priority: wip.priority || cat.priority || 1,
      arrival,
      clockStart,
      totalAhtMinutes: totalAht,
      remainingWorkMinutes: remainingAht,
      primaryDeadline,
      latestSafeStart,
      firstStartTime: null,
      completeTime: null,
      parkCount: 0,
      isOpeningWip: true,
    });
  }

  // Add Demand Intervals cases
  for (const interval of intervals) {
    const vol = Math.round(interval.volume);
    if (vol <= 0) continue;

    const cat = categoryMap.get(interval.category) || {
      id: 'default',
      name: interval.category,
      ahtMinutes: 30,
      shrinkagePct: 0.2,
      priority: 1,
      primaryPct: sla.primaryPct,
      primaryWindowMinutes: defaultPrimaryWinMin,
    };

    const intervalStartMs = interval.start.getTime();
    const intervalDurationMs = Math.max(1000, interval.end.getTime() - intervalStartMs);

    const primaryWinMin =
      cat.primaryWindow !== undefined && cat.primaryUnit
        ? convertSlaDurationToMinutes(cat.primaryWindow, cat.primaryUnit, sla.clockBasis, calendar)
        : (cat.primaryWindowMinutes !== undefined ? cat.primaryWindowMinutes : defaultPrimaryWinMin);

    const totalAht = cat.ahtMinutes;

    for (let v = 0; v < vol; v++) {
      const offsetMs = Math.floor(prng() * intervalDurationMs);
      const arrival = new Date(intervalStartMs + offsetMs);
      const clockStart =
        sla.clockStartPolicy === 'next_open' && !isWorking(arrival, calendar)
          ? nextOpen(arrival, calendar)
          : new Date(arrival);

      const primaryDeadline =
        sla.clockBasis === 'business_time'
          ? addWorkingTime(clockStart, primaryWinMin, calendar)
          : new Date(clockStart.getTime() + primaryWinMin * 60 * 1000);

      const latestSafeStart =
        sla.clockBasis === 'business_time'
          ? subtractWorkingTime(primaryDeadline, totalAht, calendar)
          : new Date(primaryDeadline.getTime() - totalAht * 60 * 1000);

      const sId = nextSyntheticId++;
      allCases.push({
        id: `CASE-${String(caseIdCounter++).padStart(6, '0')}`,
        syntheticId: sId,
        category: interval.category,
        priority: cat.priority || 1,
        arrival,
        clockStart,
        totalAhtMinutes: totalAht,
        remainingWorkMinutes: totalAht,
        primaryDeadline,
        latestSafeStart,
        firstStartTime: null,
        completeTime: null,
        parkCount: 0,
        isOpeningWip: false,
      });
    }
  }

  return { cases: allCases, horizonStart, horizonEnd };
}

/**
 * Effective adherence, clamped to [0.1, 1.0]; non-finite/missing → 1.0 (100%).
 *
 * FIXED 2026-08-31: every call site previously inlined `labor.adherencePct || 1.0`, which
 * treats an explicit 0 as "unset" and silently returns 100% adherence — the opposite of the
 * clamp's intent, which is to floor an implausibly low value at 10%. `??` alone would let a
 * NaN through, so the finite check is explicit.
 */
export function resolveEffectiveAdherence(labor: Pick<LaborConfig, 'adherencePct'>): number {
  const raw = labor.adherencePct;
  if (!Number.isFinite(raw)) return 1.0;
  return Math.min(1.0, Math.max(0.1, raw as number));
}

/**
 * Shift-start grid granularity in minutes, clamped to >= 5; non-finite/missing → 30.
 * Same `||` → explicit-finite-check rationale as resolveEffectiveAdherence: an explicit 0
 * is an invalid granularity to be clamped, not a signal to fall back to the 30 default.
 */
export function resolveShiftSlapMinutes(labor: Pick<LaborConfig, 'shiftSlapMinutes'>): number {
  const raw = labor.shiftSlapMinutes;
  if (!Number.isFinite(raw)) return 30;
  return Math.max(5, Math.round(raw as number));
}

/**
 * Resolves the occupancy ceiling all gates must use. The ceiling is always in force:
 * occupancyCapEnabled selects a custom target (clamped 50-100) rather than switching a
 * ceiling on/off. Off = the 100% default (physical feasibility only — no policy applied).
 */
export function resolveOccupancyCapPct(
  sla: Pick<SLAPolicyConfig, 'occupancyCapEnabled' | 'occupancyCapPct'>
): number {
  if (!sla.occupancyCapEnabled) return 100;
  return Math.min(100, Math.max(50, sla.occupancyCapPct));
}

/**
 * Resolves the minimum on-shift agent count required at every open business interval.
 * Mirrors resolveOccupancyCapPct's pattern, but the DEFAULT is ON (unlike occupancy):
 * minCoverageEnabled omitted/undefined defaults to true — the queue may never be left with
 * zero agents while the business is running, out of the box. Pass minCoverageEnabled: false,
 * or minAgentsPerInterval: 0, to reproduce pre-2026-08-28 behavior (no coverage floor).
 */
export function resolveMinAgentsPerInterval(
  sla: Pick<SLAPolicyConfig, 'minCoverageEnabled' | 'minAgentsPerInterval'>,
  operationalHC: number
): number {
  if (sla.minCoverageEnabled === false) return 0;
  const raw = sla.minAgentsPerInterval;
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : 1;
  return Math.max(0, Math.min(operationalHC, Math.round(n)));
}

export function runBackofficeDES(params: {
  operationalHC: number;
  intervals: StandardInterval[];
  openingWIP: OpeningWIPCase[];
  categories: CategoryConfig[];
  calendar: CalendarConfig;
  labor: LaborConfig;
  sla: SLAPolicyConfig;
  seed: number;
  queueArchitecture?: 'pooled' | 'siloed';
  precomputedCases?: { cases: CaseEntity[]; horizonStart: Date; horizonEnd: Date };
  skipCaseResultsAndTimeline?: boolean;
  /**
   * Optional deadline-coverage shift-start distribution (see computeShiftPlacement in
   * hc-search.ts). Absent = today's exact behavior: every agent starts one uniform shift
   * at business open. When present (and calendar is not 24x7), agents are grouped into
   * cohorts starting at their assigned slap offset instead. Keyed by category name for
   * siloed queueArchitecture, or '__POOLED__' for pooled.
   */
  shiftDistribution?: ShiftDistributionByCategory;
}): DESResult {
  const {
    operationalHC,
    intervals,
    openingWIP,
    categories,
    calendar,
    labor,
    sla,
    seed,
    queueArchitecture = 'pooled',
    precomputedCases,
    skipCaseResultsAndTimeline = false,
    shiftDistribution,
  } = params;

  const categoryMap = new Map<string, CategoryConfig>();
  categories.forEach((c) => categoryMap.set(c.name, c));

  let allCases: CaseEntity[];
  let horizonStart: Date;
  let horizonEnd: Date;

  if (precomputedCases) {
    horizonStart = precomputedCases.horizonStart;
    horizonEnd = precomputedCases.horizonEnd;
    allCases = precomputedCases.cases.map((c) => ({
      ...c,
      remainingWorkMinutes: c.remainingWorkMinutes, // Preserve remaining WIP progress
      firstStartTime: null,
      completeTime: null,
      parkCount: 0,
    }));
  } else {
    const gen = generateCaseEntities({
      intervals,
      openingWIP,
      categories,
      calendar,
      sla,
      seed,
    });
    horizonStart = gen.horizonStart;
    horizonEnd = gen.horizonEnd;
    allCases = gen.cases;
  }

  // Effective labor capacity and daily budget per agent
  const effectiveAdherence = resolveEffectiveAdherence(labor);
  const dailyPresentHours = labor.dailyProductiveHours * effectiveAdherence;
  const dailyBudgetMinutes = dailyPresentHours * 60;

  // Track state
  const caseMap = new Map<string, CaseEntity>();
  for (let i = 0; i < allCases.length; i++) {
    const c = allCases[i];
    caseMap.set(c.id, c);
  }

  // Event Priority Queue (Binary Min-Heap)
  const eventQueue = new SimEventHeap();

  function scheduleEvent(time: Date | number, eventType: EventType, entityId: string, data?: any) {
    const timeMs = typeof time === 'number' ? time : time.getTime();
    eventQueue.push({
      timeMs,
      priority: EVENT_TYPE_ORDER[eventType] || 99,
      eventType,
      entityId,
      data,
    });
  }

  // 1. Initialize all arrival events
  for (let i = 0; i < allCases.length; i++) {
    scheduleEvent(allCases[i].arrival, 'CaseArrival', allCases[i].id);
  }

  // Business-open/close event scheduling (step 2) happens further below, after the
  // siloed-architecture agent setup — staggered shift placement needs to know each
  // agent's category (agentCategoryMap) before it can assign slap start offsets, and
  // the day-open events it schedules depend on that assignment. drainHorizonEnd is
  // still declared here since it is also needed for SimulationEnd immediately below.
  const drainHorizonEnd = new Date(horizonEnd.getTime() + 14 * 24 * 60 * 60 * 1000);
  scheduleEvent(drainHorizonEnd, 'SimulationEnd', 'SYS_END');

  // Simulation State with fast Heap Priority Queue
  let simTimeMs = horizonStart.getTime();
  const isSiloed = queueArchitecture === 'siloed';

  // Agent daily remaining budget tracking
  const agentDailyMinutesRemaining = new Float64Array(operationalHC).fill(dailyBudgetMinutes);

  // Agent Timeline Tracking
  const agentTimeline: AgentWorkSlice[] = [];
  const agentState: AgentSliceState[] = new Array(operationalHC);
  const agentSliceStartMs: number[] = new Array(operationalHC);
  const agentBusyData: Array<{
    caseId: string;
    category: string;
    isResume: boolean;
    workAssignedMinutes: number;
  } | null> = new Array(operationalHC).fill(null);

  // Initial agent state and business-open/close event scheduling are set up further below
  // (after siloed agent-category assignment), since staggered shift placement needs
  // agentCategoryMap to assign each agent's slap start offset first.

  function logSlice(agentId: number, closeTimeMs: number) {
    if (skipCaseResultsAndTimeline || operationalHC === 0) return;
    const startMs = agentSliceStartMs[agentId];
    if (closeTimeMs <= startMs) return;

    const state = agentState[agentId];
    const busyInfo = agentBusyData[agentId];

    let curStartMs = startMs;
    while (curStartMs < closeTimeMs) {
      const curFrom = new Date(curStartMs);
      const nextMidnight = new Date(curFrom);
      nextMidnight.setDate(nextMidnight.getDate() + 1);
      nextMidnight.setHours(0, 0, 0, 0);
      const nextMidnightMs = nextMidnight.getTime();

      const curCloseMs = Math.min(closeTimeMs, nextMidnightMs);
      const curTo = new Date(curCloseMs);
      const pieceMinutes = (curCloseMs - curStartMs) / 60000;

      const y = curFrom.getFullYear();
      const m = String(curFrom.getMonth() + 1).padStart(2, '0');
      const d = String(curFrom.getDate()).padStart(2, '0');
      const dateStr = `${y}-${m}-${d}`;

      agentTimeline.push({
        agentId,
        agentLabel: `Agent-${agentId + 1}`,
        date: dateStr,
        state,
        rosterSource: 'existing',
        caseId: state === 'busy' && busyInfo ? busyInfo.caseId : null,
        category: state === 'busy' && busyInfo ? busyInfo.category : null,
        from: curFrom,
        to: curTo,
        minutes: pieceMinutes,
        isResume: state === 'busy' && busyInfo ? busyInfo.isResume : false,
        inBindingWindow: false,
      });

      curStartMs = curCloseMs;
    }

    agentSliceStartMs[agentId] = closeTimeMs;
  }

  function transitionAgent(
    agentId: number,
    newState: AgentSliceState,
    atTimeMs: number,
    busyInfo: { caseId: string; category: string; isResume: boolean; workAssignedMinutes: number } | null = null
  ) {
    if (skipCaseResultsAndTimeline || operationalHC === 0) return;
    if (agentState[agentId] === newState && newState !== 'busy') {
      return;
    }
    logSlice(agentId, atTimeMs);
    agentState[agentId] = newState;
    agentSliceStartMs[agentId] = atTimeMs;
    agentBusyData[agentId] = busyInfo;
  }

  // Setup Queue Architecture: Pooled vs Siloed
  const pooledQueue = new CaseMinHeap();
  let pooledIdleAgents: number[] = Array.from({ length: operationalHC }, (_, i) => i);

  const siloedQueues = new Map<string, CaseMinHeap>();
  const siloedIdleAgents = new Map<string, number[]>();
  const agentCategoryMap = new Map<number, string>();

  if (isSiloed) {
    const allCatNames = new Set<string>();
    categories.forEach((c) => allCatNames.add(c.name));
    allCases.forEach((c) => allCatNames.add(c.category));

    const catWorkloadMinutes = new Map<string, number>();
    allCatNames.forEach((name) => {
      catWorkloadMinutes.set(name, 0);
      siloedQueues.set(name, new CaseMinHeap());
      siloedIdleAgents.set(name, []);
    });
    allCases.forEach((c) => {
      catWorkloadMinutes.set(c.category, (catWorkloadMinutes.get(c.category) || 0) + c.totalAhtMinutes);
    });
    if (operationalHC > 0) {
      const seats = allocateAgentsToCategories(catWorkloadMinutes, operationalHC);
      let agentId = 0;
      for (const [catName, count] of seats.entries()) {
        for (let j = 0; j < count; j++) {
          siloedIdleAgents.get(catName)!.push(agentId);
          agentCategoryMap.set(agentId, catName);
          agentId++;
        }
      }
    }
  }

  // --- Deadline-coverage shift placement: staggered per-agent availability -----------------
  // Absent shiftDistribution ⇒ agentSlapStartMinutes stays all-zero and every agent behaves
  // exactly as today: one system-wide AgentAvailable at business open. staggeredMode is the
  // only fork point; every branch below collapses to the pre-existing single-SYS_OPEN
  // behavior when it is false. 24x7 is now a valid staggeredMode target (fixed 2026-08-28 —
  // previously always false for is24x7, which combined with the default-on coverage floor
  // to create a regression: coverage was enforced for 24x7 with no lever to satisfy it).
  const staggeredMode = !!shiftDistribution && operationalHC > 0;
  const agentSlapStartMinutes = new Float64Array(operationalHC); // all-zero when not staggered
  const slapOffsetToAgentIds = new Map<number, number[]>();
  let slapOffsetsSorted: number[] = [];
  // Shift LENGTH (minutes) an agent is on the floor for, from their own start — only
  // meaningful/enforced in staggeredMode. Not staggered ⇒ unbounded presence (unchanged
  // legacy behavior: an agent stays available all day, limited only by daily budget and
  // business close), exactly as before this shift-end mechanism was added.
  const shiftLengthMinutes = labor.dailyProductiveHours * 60;

  if (staggeredMode) {
    const categoryAgentBlocks = new Map<string, number[]>();
    if (isSiloed) {
      for (const [id, cat] of agentCategoryMap.entries()) {
        if (!categoryAgentBlocks.has(cat)) categoryAgentBlocks.set(cat, []);
        categoryAgentBlocks.get(cat)!.push(id);
      }
      // Assignment order above already ascends by id (the seats loop increments agentId
      // sequentially per category), but sort defensively — never trust iteration order.
      for (const arr of categoryAgentBlocks.values()) arr.sort((a, b) => a - b);
    } else {
      categoryAgentBlocks.set('__POOLED__', Array.from({ length: operationalHC }, (_, i) => i));
    }

    for (const [key, agentIdBlock] of categoryAgentBlocks.entries()) {
      const dist = shiftDistribution![key];
      if (!dist) continue; // no distribution for this category ⇒ its agents stay at offset 0
      const sortedSlaps = [...dist.slaps].sort((a, b) => a.startMinutesFromOpen - b.startMinutesFromOpen);
      let cursor = 0;
      for (const slap of sortedSlaps) {
        for (let k = 0; k < slap.agentCount && cursor < agentIdBlock.length; k++, cursor++) {
          agentSlapStartMinutes[agentIdBlock[cursor]] = slap.startMinutesFromOpen;
        }
      }
    }

    for (let i = 0; i < operationalHC; i++) {
      const off = agentSlapStartMinutes[i];
      if (!slapOffsetToAgentIds.has(off)) slapOffsetToAgentIds.set(off, []);
      slapOffsetToAgentIds.get(off)!.push(i);
    }
    slapOffsetsSorted = Array.from(slapOffsetToAgentIds.keys()).sort((a, b) => a - b);
  }

  // Mode-independent "has this agent's own slap started for the current calendar day" tracker.
  // MUST NOT be gated behind skipCaseResultsAndTimeline: the detailed agentState/agentTimeline
  // bookkeeping is intentionally skipped in that mode for performance (it drives every CI-gate
  // replication), but agent ELIGIBILITY for dispatch is not instrumentation — skipping its
  // staggering-awareness there was a real defect found during development: the idle-list
  // repopulation shortcut below previously treated every agent as always on-shift once ANY
  // AgentAvailable fired, in skip mode, regardless of which cohort's slap actually started —
  // so the CI-gated search evaluated a staggered distribution as if every agent behaved
  // uniformly, overstating attainment by ~25 percentage points on real backlog-heavy data (the
  // representative single-seed audit run, which does not skip, correctly enforced staggering
  // and exposed the gap). Reset to all-0 at DayClose, set to 1 for the affected cohort — or
  // every agent, for the legacy unscoped event — at AgentAvailable.
  const agentOnShiftToday: Uint8Array | null = staggeredMode ? new Uint8Array(operationalHC) : null;
  if (staggeredMode) {
    const isStartBizForShift = isWorking(horizonStart, calendar);
    let minutesFromOpenAtStartForShift = 0;
    if (isStartBizForShift) {
      const { openTime: dayOpenAtStart } = getDailyOpenClose(horizonStart, calendar);
      minutesFromOpenAtStartForShift = (horizonStart.getTime() - dayOpenAtStart.getTime()) / 60000;
    }
    for (let i = 0; i < operationalHC; i++) {
      agentOnShiftToday![i] =
        isStartBizForShift && minutesFromOpenAtStartForShift >= agentSlapStartMinutes[i] ? 1 : 0;
    }
    // Filter the initial idle-list seeding (unconditional Array.from(...) above, and the
    // per-category push loop in the siloed setup above) down to agents actually on shift —
    // needed in BOTH modes, since neither seeding step knew about staggering yet.
    pooledIdleAgents = pooledIdleAgents.filter((i) => agentOnShiftToday![i] === 1);
    for (const [cat, list] of siloedIdleAgents.entries()) {
      siloedIdleAgents.set(cat, list.filter((i) => agentOnShiftToday![i] === 1));
    }
  }

  // --- Business-open/close event scheduling (step 2) ---------------------------------------
  let curDay = new Date(horizonStart);
  curDay.setHours(0, 0, 0, 0);

  while (curDay.getTime() <= drainHorizonEnd.getTime()) {
    if (isWorkingDay(curDay, calendar)) {
      const { openTime, closeTime } = getDailyOpenClose(curDay, calendar);
      // 24x7: openTime/closeTime are midnight-to-next-midnight (getDailyOpenClose), so the
      // staggered scheduling below applies unchanged — offsets are non-wrapping minutes from
      // that midnight, per getValidSlapStarts. Fixed 2026-08-28 (24x7 multi-start): this used
      // to be a separate is24x7-only branch scheduling nothing but a single system-wide
      // AgentAvailable, which made 24x7 staggering (and therefore coverage repair) impossible.
      if (staggeredMode) {
        for (const offset of slapOffsetsSorted) {
          const slapOpenMs = openTime.getTime() + offset * 60000;
          if (slapOpenMs >= horizonStart.getTime() && slapOpenMs <= drainHorizonEnd.getTime()) {
            scheduleEvent(slapOpenMs, 'AgentAvailable', `SYS_OPEN_SLAP_${offset}`, {
              agentIds: slapOffsetToAgentIds.get(offset),
            });
          }
          // Shift-end for this cohort. Non-24x7: only when it falls STRICTLY before close —
          // a shift ending exactly at close is already handled by DayClose below
          // (getValidSlapStarts guarantees offset+shiftLength <= windowLength, so it can
          // never fall after close); scheduling a redundant event at that same instant would
          // double up on agents already covered by "everyone goes off at close". 24x7 has NO
          // DayClose event (see below — preserving BUG-D's continuous-processing behavior),
          // so nothing else resets a cohort whose shift ends exactly at the midnight
          // boundary — for 24x7 this event is therefore ALWAYS scheduled, never skipped.
          const slapEndMs = slapOpenMs + shiftLengthMinutes * 60000;
          const skipAsRedundantWithDayClose = !calendar.is24x7 && slapEndMs >= closeTime.getTime();
          if (!skipAsRedundantWithDayClose && slapEndMs >= horizonStart.getTime() && slapEndMs <= drainHorizonEnd.getTime()) {
            scheduleEvent(slapEndMs, 'ShiftEnd', `SYS_SHIFT_END_SLAP_${offset}`, {
              agentIds: slapOffsetToAgentIds.get(offset),
            });
          }
        }
      } else if (openTime.getTime() >= horizonStart.getTime() && openTime.getTime() <= drainHorizonEnd.getTime()) {
        scheduleEvent(openTime, 'AgentAvailable', 'SYS_OPEN');
      }
      // DayClose is a business-hours-only concept: 24x7 has no closing boundary to hand
      // in-flight work back at — a case in progress across midnight continues uninterrupted
      // (BUG-D). Scheduling it for 24x7 would incorrectly park active 24x7 work overnight.
      if (!calendar.is24x7 && closeTime.getTime() >= horizonStart.getTime() && closeTime.getTime() <= drainHorizonEnd.getTime()) {
        scheduleEvent(closeTime, 'DayClose', 'SYS_CLOSE');
      }
    }
    curDay.setDate(curDay.getDate() + 1);
  }

  // --- Initial agent state at horizon start -------------------------------------------------
  // Generalizes today's "idle iff business is open at horizonStart" check: in staggered mode
  // an agent is also only idle once its own slap has begun (agentOnShiftToday, computed above
  // — mode-independently, unlike this block, which only maintains the detailed agentState/
  // agentTimeline and is legitimately skip-gated). staggeredMode false collapses this to the
  // original check.
  if (!skipCaseResultsAndTimeline && operationalHC > 0) {
    const isStartBiz = isWorking(horizonStart, calendar);
    for (let i = 0; i < operationalHC; i++) {
      const shiftAlreadyStarted = !staggeredMode || agentOnShiftToday![i] === 1;
      agentState[i] = isStartBiz && shiftAlreadyStarted && agentDailyMinutesRemaining[i] > 0.01 ? 'idle' : 'off';
      agentSliceStartMs[i] = horizonStart.getTime();
    }
  }

  // --- Minimum-coverage tracking (mode-independent — must work under skipCaseResultsAndTimeline,
  // since the CI-gated replications that decide pass/fail always run with it true) -----------
  // Built entirely from state already maintained in BOTH modes: agentOnShiftToday (has this
  // agent's own shift started and not yet ended today — staggered only, else trivially "yes"
  // whenever business is open) and agentDailyMinutesRemaining (decremented at assignment time
  // regardless of skip mode). An agent counts as on-shift-and-staffing right now iff both are
  // true. Sampled once at horizonStart, then once per event-processing tick from the main
  // event loop's own deferred call (see the `nextEv` check near the bottom of the loop) —
  // deferred for the SAME reason logTimelineState is: sampling immediately inside a handler
  // (the original design) let an outgoing cohort's ShiftEnd sample a transient zero a fraction
  // of a moment before an incoming cohort's same-instant AgentAvailable restored coverage,
  // producing a false-positive coverage failure at every adjacent-cohort handoff that happens
  // to land exactly on a shared timestamp (measured: a perfect 3-way 24x7 tiling with
  // continuous handoffs reported minCoverageObserved=0 despite genuinely unbroken coverage —
  // caught while validating the 24x7 multi-start fix, suite D36).
  let minOnShiftDuringOpenHours = Infinity;
  function countAgentsOnShiftNow(): number {
    // agentDailyMinutesRemaining is decremented at ASSIGNMENT time, not completion time — an
    // agent dispatched their final chunk of budget shows remaining ~0 while STILL actively
    // busy working it. Checking remaining > 0.01 alone therefore misses currently-busy
    // agents right at the moment they consume their last minutes, undercounting presence.
    // Fixed 2026-08-28 (found while validating the 24x7 multi-start fix, suite D36: a
    // hand-built perfect 3-way tiling with continuous handoffs still reported a false-
    // positive zero-coverage moment mid-shift, at an ordinary case-completion boundary with
    // no cohort transition anywhere near it — traced to exactly this). An agent currently in
    // activeProcessing is on shift by definition, regardless of remaining budget.
    const busyAgentIds = new Set(Array.from(activeProcessing.values(), (p) => p.agentIndex));
    let count = 0;
    for (let i = 0; i < operationalHC; i++) {
      const started = !staggeredMode || agentOnShiftToday![i] === 1;
      if (started && (agentDailyMinutesRemaining[i] > 0.01 || busyAgentIds.has(i))) count++;
    }
    return count;
  }
  function sampleCoverage(atTime: Date) {
    if (operationalHC === 0) return;
    if (!isWorking(atTime, calendar)) return;
    const c = countAgentsOnShiftNow();
    if (c < minOnShiftDuringOpenHours) minOnShiftDuringOpenHours = c;
  }

  const parkedWIP = new Map<string, CaseEntity>();
  const activeProcessing = new Map<string, ActiveProcessingState>();
  let completedCount = 0;
  let totalHandlingMinutes = 0;
  // Called here (not right after sampleCoverage's own definition above) because
  // countAgentsOnShiftNow reads activeProcessing, which must exist first — harmless either
  // way since activeProcessing is always empty at horizonStart regardless.
  sampleCoverage(horizonStart);

  // Intervals timeline logging (only if !skipCaseResultsAndTimeline)
  const timelineIntervals: DESResult['intervalsTimeline'] = [];
  let nextTimelineLogTimeMs = horizonStart.getTime();
  const timelineStepMs = 30 * 60 * 1000;

  function getTotalQueuedLength(): number {
    if (!isSiloed) return pooledQueue.length;
    let sum = 0;
    siloedQueues.forEach((q) => (sum += q.length));
    return sum;
  }

  function getTotalIdleAgents(): number {
    if (!isSiloed) return pooledIdleAgents.length;
    let sum = 0;
    siloedIdleAgents.forEach((list) => (sum += list.length));
    return sum;
  }

  function logTimelineState(timeMs: number) {
    if (skipCaseResultsAndTimeline) return;
    const maxLogMs = Math.min(timeMs, horizonEnd.getTime());
    while (nextTimelineLogTimeMs <= maxLogMs) {
      const logDate = new Date(nextTimelineLogTimeMs);
      const isBiz = isWorking(logDate, calendar);
      timelineIntervals.push({
        time: logDate,
        label: formatTime24(logDate),
        queuedWIP: getTotalQueuedLength(),
        activeHandling: activeProcessing.size,
        parkedWIP: parkedWIP.size,
        completedCum: completedCount,
        availableAgents: isBiz ? getTotalIdleAgents() + activeProcessing.size : 0,
      });
      nextTimelineLogTimeMs += timelineStepMs;
    }
  }

  // Queue Dispatcher for a specific queue + idle list
  function dispatchSingleQueue(currTime: Date, queue: CaseMinHeap, idleList: number[]) {
    if (!isWorking(currTime, calendar)) return;
    if (idleList.length === 0 || queue.length === 0) return;

    const currMs = currTime.getTime();
    let openMinutesRemainingInDay = Infinity;
    if (!calendar.is24x7) {
      const { closeTime } = getDailyOpenClose(currTime, calendar);
      openMinutesRemainingInDay = Math.max(0, (closeTime.getTime() - currMs) / 60000);
      if (openMinutesRemainingInDay <= 0) return;
    }

    while (queue.length > 0 && idleList.length > 0) {
      const agentId = idleList.pop()!;
      if (agentDailyMinutesRemaining[agentId] <= 0.01) {
        continue;
      }

      const assignedCase = pickNextCase(queue, currTime);
      if (!assignedCase) {
        idleList.push(agentId);
        break;
      }

      const agentBudget = agentDailyMinutesRemaining[agentId];
      // Third bound alongside budget and business close: this agent's OWN shift end, when
      // staggeredMode is active. Absent it (uniform, unstaggered — legacy behavior, unchanged),
      // this is Infinity and never binds. See `wfm-sizing-simulation`/PRD Stage 3a for why an
      // agent's presence must not outlast their assigned shift length.
      let shiftMinutesRemainingToday = Infinity;
      if (staggeredMode) {
        const { openTime: dayOpenTime } = getDailyOpenClose(currTime, calendar);
        const ownShiftEndMs = dayOpenTime.getTime() + agentSlapStartMinutes[agentId] * 60000 + shiftLengthMinutes * 60000;
        shiftMinutesRemainingToday = Math.max(0, (ownShiftEndMs - currMs) / 60000);
      }
      const maxWorkPossible = Math.min(agentBudget, openMinutesRemainingInDay, shiftMinutesRemainingToday);
      // Which bound is actually binding, if the case doesn't fit — determines disposition
      // below (park-to-next-open vs hand off to a remaining on-shift colleague right now).
      const shiftEndIsBinding =
        staggeredMode &&
        shiftMinutesRemainingToday < agentBudget - 1e-9 &&
        shiftMinutesRemainingToday < openMinutesRemainingInDay - 1e-9;

      if (maxWorkPossible <= 0) {
        idleList.push(agentId);
        queue.push(assignedCase);
        break;
      }

      if (!assignedCase.firstStartTime) {
        assignedCase.firstStartTime = new Date(currTime);
      }

      if (assignedCase.remainingWorkMinutes <= maxWorkPossible) {
        // Completes in current business stretch
        const workToAssign = assignedCase.remainingWorkMinutes;
        agentDailyMinutesRemaining[agentId] -= workToAssign;
        const completeMs = currMs + workToAssign * 60000;
        const completeDate = new Date(completeMs);

        const isResume =
          assignedCase.parkCount > 0 ||
          assignedCase.remainingWorkMinutes < assignedCase.totalAhtMinutes;

        transitionAgent(agentId, 'busy', currMs, {
          caseId: assignedCase.id,
          category: assignedCase.category,
          isResume,
          workAssignedMinutes: workToAssign,
        });

        activeProcessing.set(assignedCase.id, {
          caseId: assignedCase.id,
          agentIndex: agentId,
          startTime: currTime,
          scheduledEndTime: completeDate,
          workAssignedMinutes: workToAssign,
        });

        scheduleEvent(completeDate, 'ProcessingComplete', assignedCase.id, {
          agentId,
          workDoneMinutes: workToAssign,
          category: assignedCase.category,
        });
      } else {
        // Works maxWorkPossible, then parks
        const workToAssign = maxWorkPossible;
        agentDailyMinutesRemaining[agentId] -= workToAssign;
        const parkMs = currMs + workToAssign * 60000;
        const parkDate = new Date(parkMs);

        const isResume =
          assignedCase.parkCount > 0 ||
          assignedCase.remainingWorkMinutes < assignedCase.totalAhtMinutes;

        transitionAgent(agentId, 'busy', currMs, {
          caseId: assignedCase.id,
          category: assignedCase.category,
          isResume,
          workAssignedMinutes: workToAssign,
        });

        activeProcessing.set(assignedCase.id, {
          caseId: assignedCase.id,
          agentIndex: agentId,
          startTime: currTime,
          scheduledEndTime: parkDate,
          workAssignedMinutes: workToAssign,
        });

        scheduleEvent(parkDate, 'CasePark', assignedCase.id, {
          agentId,
          workDoneMinutes: workToAssign,
          category: assignedCase.category,
          handover: shiftEndIsBinding,
        });
      }
    }
  }

  function dispatchAll(currTime: Date, targetCategory?: string) {
    if (!isSiloed) {
      dispatchSingleQueue(currTime, pooledQueue, pooledIdleAgents);
    } else {
      if (targetCategory) {
        const q = siloedQueues.get(targetCategory);
        const idle = siloedIdleAgents.get(targetCategory);
        if (q && idle) dispatchSingleQueue(currTime, q, idle);
      } else {
        siloedQueues.forEach((q, catName) => {
          const idle = siloedIdleAgents.get(catName);
          if (idle) dispatchSingleQueue(currTime, q, idle);
        });
      }
    }
  }

  function pushToQueue(c: CaseEntity, isResumed = false) {
    if (!isSiloed) {
      pooledQueue.push(c, isResumed);
    } else {
      let q = siloedQueues.get(c.category);
      if (!q) {
        q = new CaseMinHeap();
        siloedQueues.set(c.category, q);
        if (!siloedIdleAgents.has(c.category)) {
          siloedIdleAgents.set(c.category, []);
        }
      }
      q.push(c, isResumed);
    }
  }

  function returnAgentToIdle(agentId: number, category?: string) {
    if (!isSiloed) {
      pooledIdleAgents.push(agentId);
    } else {
      const cat = category || agentCategoryMap.get(agentId) || (categories[0] ? categories[0].name : 'General');
      let list = siloedIdleAgents.get(cat);
      if (!list) {
        list = [];
        siloedIdleAgents.set(cat, list);
      }
      list.push(agentId);
    }
  }

  // Main Event Loop
  while (eventQueue.length > 0) {
    const ev = eventQueue.pop()!;
    simTimeMs = ev.timeMs;
    const currTime = new Date(simTimeMs);

    if (
      simTimeMs >= horizonEnd.getTime() &&
      getTotalQueuedLength() === 0 &&
      activeProcessing.size === 0 &&
      parkedWIP.size === 0
    ) {
      logTimelineState(simTimeMs);
      sampleCoverage(currTime);
      break;
    }

    if (ev.eventType === 'SimulationEnd') {
      logTimelineState(simTimeMs);
      sampleCoverage(currTime);
      break;
    }

    switch (ev.eventType) {
      case 'CaseArrival': {
        const c = caseMap.get(ev.entityId);
        if (c) {
          pushToQueue(c);
          dispatchAll(currTime, c.category);
        }
        break;
      }

      case 'ProcessingComplete': {
        const proc = activeProcessing.get(ev.entityId);
        if (proc) {
          activeProcessing.delete(ev.entityId);

          const c = caseMap.get(ev.entityId)!;
          c.remainingWorkMinutes = 0;
          c.completeTime = currTime;
          completedCount++;
          totalHandlingMinutes += ev.data?.workDoneMinutes || 0;

          const hasBudget = agentDailyMinutesRemaining[proc.agentIndex] > 0.01;
          const canWork = isWorking(currTime, calendar) && hasBudget;
          if (canWork) {
            returnAgentToIdle(proc.agentIndex, ev.data?.category);
            transitionAgent(proc.agentIndex, 'idle', simTimeMs);
          } else {
            transitionAgent(proc.agentIndex, 'off', simTimeMs);
          }

          dispatchAll(currTime, c.category);
        }
        break;
      }

      case 'CasePark': {
        const proc = activeProcessing.get(ev.entityId);
        if (proc) {
          activeProcessing.delete(ev.entityId);

          const c = caseMap.get(ev.entityId)!;
          c.remainingWorkMinutes -= ev.data?.workDoneMinutes || 0;
          c.parkCount++;
          totalHandlingMinutes += ev.data?.workDoneMinutes || 0;

          if (ev.data?.handover) {
            // This agent's OWN shift ended mid-case (staggeredMode) — hand the case back to
            // the LIVE queue for a still-on-shift colleague to pick up immediately, rather
            // than parking until the business's next open (that DayClose semantics are for
            // the business closing, not one cohort's shift ending). Always goes 'off', never
            // back to idle — the canWork/budget check below is for the close/budget-bound
            // branch, where nothing else is true at the same instant.
            pushToQueue(c, true);
            transitionAgent(proc.agentIndex, 'off', simTimeMs);
            agentOnShiftToday![proc.agentIndex] = 0;
            dispatchAll(currTime, c.category);
          } else {
            parkedWIP.set(c.id, c);

            const hasBudget = agentDailyMinutesRemaining[proc.agentIndex] > 0.01;
            const canWork = isWorking(currTime, calendar) && hasBudget;
            if (canWork) {
              returnAgentToIdle(proc.agentIndex, ev.data?.category);
              transitionAgent(proc.agentIndex, 'idle', simTimeMs);
            } else {
              transitionAgent(proc.agentIndex, 'off', simTimeMs);
            }

            let nextResumeTime: Date | null = null;
            if (calendar.is24x7) {
              const nextDay = new Date(currTime);
              nextDay.setDate(nextDay.getDate() + 1);
              nextDay.setHours(0, 0, 0, 0);
              nextResumeTime = nextDay;
            } else {
              try {
                nextResumeTime = nextOpen(currTime, calendar);
              } catch {
                nextResumeTime = null;
              }
            }
            if (nextResumeTime) {
              scheduleEvent(nextResumeTime, 'CaseResume', c.id);
            }
          }
        }
        break;
      }

      case 'CaseResume': {
        const c = parkedWIP.get(ev.entityId);
        if (c) {
          parkedWIP.delete(c.id);
          pushToQueue(c, true);
          dispatchAll(currTime, c.category);
        }
        break;
      }

      case 'AgentAvailable': {
        // scopedAgentIds is set only for staggered per-slap events (see the day-open
        // scheduling above); undefined for the legacy single system-wide open event, which
        // is the only kind ever scheduled when shiftDistribution is absent.
        const scopedAgentIds: number[] | undefined = ev.data?.agentIds;

        // Reset each agent's daily budget for the new calendar day. In UNSTAGGERED 24x7
        // mode a case in flight is never paused at midnight (continuous processing is
        // required — see BUG-D), so an agent can already be mid-task when this fires. A
        // blind fill() would grant that agent a second full day's budget on top of the
        // portion of the task it has already spent working into the new day (fabricated
        // capacity — see T3-1). Instead, credit only the unconsumed remainder: today's full
        // budget minus whatever of the in-flight task falls within today (from this midnight
        // up to completion, or to the next midnight).
        // Fixed 2026-08-28 (24x7 multi-start): this branch is now explicitly gated on
        // `!staggeredMode` — under staggering EVERY agent's assignment is already bounded by
        // its own shift end (the 3-way min in dispatchSingleQueue), so no staggered agent can
        // ever be mid-task AT the midnight boundary the way an unstaggered 24x7 agent could:
        // a cohort whose shift ends exactly at midnight hands over via the normal ShiftEnd
        // mechanism before/at that instant, converting what would have been "spillover" into
        // an ordinary same-day handover. The spillover scenario this branch exists for is
        // therefore specific to the legacy unstaggered 24x7 path and does not arise under
        // staggering — scopedAgentIds events must always take the cohort-scoped refill below.
        if (calendar.is24x7 && !staggeredMode && activeProcessing.size > 0) {
          const nextMidnight = new Date(currTime);
          nextMidnight.setDate(nextMidnight.getDate() + 1);
          nextMidnight.setHours(0, 0, 0, 0);
          const nextMidnightMs = nextMidnight.getTime();

          const spilloverByAgent = new Map<number, number>();
          for (const proc of activeProcessing.values()) {
            const endMs = Math.min(proc.scheduledEndTime.getTime(), nextMidnightMs);
            const spilloverMinutes = Math.max(0, (endMs - simTimeMs) / 60000);
            spilloverByAgent.set(proc.agentIndex, spilloverMinutes);
          }
          for (let i = 0; i < operationalHC; i++) {
            const spill = spilloverByAgent.get(i) || 0;
            agentDailyMinutesRemaining[i] = Math.max(0, dailyBudgetMinutes - spill);
          }
        } else if (scopedAgentIds) {
          // Staggered mode: refill budget only for this slap's cohort. Each agent belongs
          // to exactly one cohort and each cohort's event fires exactly once per working
          // day (see the day-open scheduling loop), so this refills every agent exactly
          // once per day — same invariant as the unscoped fill() below, just partitioned.
          for (const agentId of scopedAgentIds) {
            agentDailyMinutesRemaining[agentId] = dailyBudgetMinutes;
          }
        } else {
          agentDailyMinutesRemaining.fill(dailyBudgetMinutes);
        }

        // Mark the affected cohort on-shift for today — mode-independent (never gated behind
        // skipCaseResultsAndTimeline; see the declaration of agentOnShiftToday above for why).
        if (staggeredMode) {
          if (scopedAgentIds) {
            for (const agentId of scopedAgentIds) agentOnShiftToday![agentId] = 1;
          } else {
            agentOnShiftToday!.fill(1);
          }
        }

        if (!skipCaseResultsAndTimeline) {
          const idsToTransition = scopedAgentIds ?? (() => {
            const all = new Array<number>(operationalHC);
            for (let i = 0; i < operationalHC; i++) all[i] = i;
            return all;
          })();
          for (const i of idsToTransition) {
            if (agentState[i] === 'off') {
              transitionAgent(i, 'idle', simTimeMs);
            } else {
              logSlice(i, simTimeMs);
            }
          }
        }

        // Repopulate idle agent lists. In staggered mode, eligibility comes from
        // agentOnShiftToday (mode-independently correct — see its declaration above), MINUS
        // any agent currently mid-task: unlike the legacy unscoped event (which fires exactly
        // once per day, so "everyone comes back fresh" is correct), a staggered AgentAvailable
        // fires once PER COHORT per day — a later cohort's event must not disturb an earlier
        // cohort's agent that is still processing a case, or it would be double-booked (added
        // back to the idle pool while activeProcessing still holds it). activeProcessing is
        // tracked mode-independently already, so this exclusion works in skip mode too. The
        // `agentState[i] === 'idle' || skipCaseResultsAndTimeline` shortcut is preserved
        // byte-for-byte for the non-staggered path.
        const busyAgentIdsForRepop = staggeredMode
          ? new Set(Array.from(activeProcessing.values(), (p) => p.agentIndex))
          : null;
        pooledIdleAgents.length = 0;
        if (!isSiloed) {
          for (let i = 0; i < operationalHC; i++) {
            const eligible = staggeredMode
              ? agentOnShiftToday![i] === 1 && !busyAgentIdsForRepop!.has(i)
              : (agentState[i] === 'idle' || skipCaseResultsAndTimeline);
            if (eligible) {
              pooledIdleAgents.push(i);
            }
          }
        } else {
          siloedIdleAgents.forEach((list) => { list.length = 0; });
          for (let i = 0; i < operationalHC; i++) {
            const eligible = staggeredMode
              ? agentOnShiftToday![i] === 1 && !busyAgentIdsForRepop!.has(i)
              : (agentState[i] === 'idle' || skipCaseResultsAndTimeline);
            if (eligible) {
              const cat = agentCategoryMap.get(i) || (categories[0] ? categories[0].name : 'General');
              let list = siloedIdleAgents.get(cat);
              if (!list) {
                list = [];
                siloedIdleAgents.set(cat, list);
              }
              list.push(i);
            }
          }
        }

        // Ensure any CaseResume events at or before simTimeMs are processed before dispatching
        while (eventQueue.length > 0) {
          const topEv = eventQueue.peek();
          if (topEv && topEv.timeMs <= simTimeMs && topEv.eventType === 'CaseResume') {
            const resumeEv = eventQueue.pop()!;
            const c = parkedWIP.get(resumeEv.entityId);
            if (c) {
              parkedWIP.delete(c.id);
              pushToQueue(c, true);
            }
          } else {
            break;
          }
        }

        dispatchAll(currTime);
        break;
      }

      case 'ShiftEnd': {
        // A cohort's shift ends mid-day (staggeredMode only — see scheduling above, which
        // never emits this event otherwise). Handles agents currently IDLE: take them off the
        // floor now. Agents currently BUSY are NOT touched here — dispatchSingleQueue already
        // computed each assignment's true terminating bound (budget, close, OR this agent's
        // own shift end, whichever is soonest) at the moment work was assigned, so a busy
        // agent's own case-completion/handover event fires at this exact instant (or later, if
        // their case finishes before their shift ends) and performs the off-transition itself.
        // Touching a busy agent here too would race that event and double-transition them.
        const cohortIds: number[] = ev.data?.agentIds || [];
        const cohortSet = new Set(cohortIds);
        for (const agentId of cohortIds) {
          agentOnShiftToday![agentId] = 0;
        }
        const wasIdlePooled = !isSiloed ? pooledIdleAgents.filter((id) => cohortSet.has(id)) : [];
        if (!isSiloed) {
          pooledIdleAgents = pooledIdleAgents.filter((id) => !cohortSet.has(id));
        } else {
          for (const [, list] of siloedIdleAgents.entries()) {
            for (const id of list) {
              if (cohortSet.has(id)) wasIdlePooled.push(id);
            }
          }
          siloedIdleAgents.forEach((list, cat) => {
            siloedIdleAgents.set(cat, list.filter((id) => !cohortSet.has(id)));
          });
        }
        if (!skipCaseResultsAndTimeline) {
          for (const agentId of wasIdlePooled) {
            transitionAgent(agentId, 'off', simTimeMs);
          }
        }
        break;
      }

      case 'DayClose': {
        // Handle any busy agents still active at closeTime (park them)
        for (const [caseId, proc] of Array.from(activeProcessing.entries())) {
          activeProcessing.delete(caseId);
          const c = caseMap.get(caseId);
          if (c) {
            const workDone = Math.max(0, (simTimeMs - proc.startTime.getTime()) / 60000);
            c.remainingWorkMinutes = Math.max(0, c.remainingWorkMinutes - workDone);
            c.parkCount++;
            totalHandlingMinutes += workDone;
            parkedWIP.set(c.id, c);

            let nextResumeTime: Date | null = null;
            if (calendar.is24x7) {
              const nextDay = new Date(currTime);
              nextDay.setDate(nextDay.getDate() + 1);
              nextDay.setHours(0, 0, 0, 0);
              nextResumeTime = nextDay;
            } else {
              try {
                nextResumeTime = nextOpen(currTime, calendar);
              } catch {
                nextResumeTime = null;
              }
            }
            if (nextResumeTime) {
              scheduleEvent(nextResumeTime, 'CaseResume', c.id);
            }
          }
        }

        // Reset the mode-independent on-shift tracker for the next calendar day.
        if (staggeredMode) {
          agentOnShiftToday!.fill(0);
        }

        // Transition all agents to off
        if (!skipCaseResultsAndTimeline) {
          for (let i = 0; i < operationalHC; i++) {
            if (agentState[i] === 'busy' || agentState[i] === 'idle') {
              transitionAgent(i, 'off', simTimeMs);
            }
          }
        }

        // Clear idle lists when state becomes off
        pooledIdleAgents.length = 0;
        siloedIdleAgents.forEach((list) => {
          list.length = 0;
        });

        break;
      }

      default:
        break;
    }

    // Log/sample AFTER this event's effects are applied — logging before processing captured
    // a stale snapshot at every day-open AgentAvailable (idle list still empty from the prior
    // DayClose), reading as a full staffing gap that resolved microseconds later within the
    // same tick (see suite D27). If another event shares this exact timestamp, defer until it
    // too has been processed, so a same-tick pair is never sampled half-applied — this is
    // exactly what caused a false-positive zero-coverage reading at a same-instant
    // ShiftEnd/AgentAvailable handoff between adjacent 24x7 cohorts (fixed alongside the D36
    // 24x7 regression fix, 2026-08-28): sampleCoverage used to fire immediately inside each
    // handler, so the outgoing cohort's ShiftEnd could sample a transient "0" a fraction of a
    // moment before the incoming cohort's AgentAvailable restored coverage at the SAME
    // nominal timestamp.
    const nextEv = eventQueue.peek();
    if (!nextEv || nextEv.timeMs !== simTimeMs) {
      logTimelineState(simTimeMs);
      sampleCoverage(currTime);
    }
  }

  if (!skipCaseResultsAndTimeline) {
    for (let i = 0; i < operationalHC; i++) {
      logSlice(i, simTimeMs);
    }
  }

  logTimelineState(horizonEnd.getTime());

  // 3. Compile Metric Statistics & Invariant Checks
  const totalCasesCount = allCases.length;
  const completedCasesCount = completedCount;
  const unfinishedCasesCount = totalCasesCount - completedCasesCount;

  let primaryEligibleCount = 0;
  let primaryPassCount = 0;

  let totalAsaMinutesSum = 0;
  let censoredAsaCount = 0;

  const categoryStats: DESResult['categoryStats'] = {};
  categories.forEach((cat) => {
    categoryStats[cat.name] = {
      volume: 0,
      workloadHours: 0,
      completed: 0,
      primaryEligible: 0,
      primaryPass: 0,
      primaryPct: 0,
      asaMeanMinutes: 0,
      asaCensoredCount: 0,
    };
  });

  const caseResults: CaseRunResult[] = [];

  for (let i = 0; i < allCases.length; i++) {
    const c = allCases[i];
    const isCompleted = c.completeTime !== null;

    const primaryEligible = true;
    let primaryPassed = false;
    if (isCompleted && c.completeTime) {
      primaryPassed = c.completeTime.getTime() <= c.primaryDeadline.getTime();
    }

    primaryEligibleCount++;
    if (primaryPassed) primaryPassCount++;

    // ASA Duration respecting asaClockBasis
    let asaDurationMinutes = 0;
    let asaCensored = false;

    if (sla.asaClockBasis === 'business_window') {
      if (c.firstStartTime) {
        asaDurationMinutes = workingDuration(c.clockStart, c.firstStartTime, calendar);
      } else {
        asaDurationMinutes = workingDuration(c.clockStart, horizonEnd, calendar);
        asaCensored = true;
        censoredAsaCount++;
      }
    } else {
      // clock_hours / wall clock
      if (c.firstStartTime) {
        asaDurationMinutes = Math.max(0, (c.firstStartTime.getTime() - c.clockStart.getTime()) / 60000);
      } else {
        asaDurationMinutes = Math.max(0, (horizonEnd.getTime() - c.clockStart.getTime()) / 60000);
        asaCensored = true;
        censoredAsaCount++;
      }
    }
    totalAsaMinutesSum += asaDurationMinutes;

    // Category Level Rollups
    let cStat = categoryStats[c.category];
    if (!cStat) {
      cStat = {
        volume: 0,
        workloadHours: 0,
        completed: 0,
        primaryEligible: 0,
        primaryPass: 0,
        primaryPct: 0,
        asaMeanMinutes: 0,
        asaCensoredCount: 0,
      };
      categoryStats[c.category] = cStat;
    }

    cStat.volume++;
    cStat.workloadHours += c.totalAhtMinutes / 60;
    if (isCompleted) cStat.completed++;
    cStat.primaryEligible++;
    if (primaryPassed) cStat.primaryPass++;
    cStat.asaMeanMinutes += asaDurationMinutes;
    if (asaCensored) cStat.asaCensoredCount++;

    if (!skipCaseResultsAndTimeline) {
      caseResults.push({
        caseId: c.id,
        category: c.category,
        priority: c.priority,
        arrival: c.arrival,
        clockStart: c.clockStart,
        ahtMinutes: c.totalAhtMinutes,
        primaryDeadline: c.primaryDeadline,
        latestSafeStart: c.latestSafeStart,
        firstStartTime: c.firstStartTime,
        completeTime: c.completeTime,
        parkCount: c.parkCount,
        isOpeningWip: c.isOpeningWip,
        isCompleted,
        primaryEligible,
        primaryPassed,
        isHorizonRemainder: !isCompleted,
        asaDurationMinutes: Math.round(asaDurationMinutes * 10) / 10,
        asaCensored,
      });
    }
  }

  // Finalize Category Stats
  let allCategoriesPassPrimarySLA = true;
  Object.keys(categoryStats).forEach((catName) => {
    const s = categoryStats[catName];
    const cat = categoryMap.get(catName);
    const catTarget = cat?.primaryPct !== undefined ? cat.primaryPct : sla.primaryPct;

    s.primaryPct = s.primaryEligible > 0 ? Math.round((s.primaryPass / s.primaryEligible) * 1000) / 10 : 100;
    s.asaMeanMinutes = s.volume > 0 ? Math.round((s.asaMeanMinutes / s.volume) * 10) / 10 : 0;
    s.workloadHours = Math.round(s.workloadHours * 10) / 10;

    if (s.primaryPct < catTarget) {
      allCategoriesPassPrimarySLA = false;
    }
  });

  const primaryAchievedPct =
    primaryEligibleCount > 0 ? Math.round((primaryPassCount / primaryEligibleCount) * 1000) / 10 : 100;

  const boAsaMeanMinutes =
    totalCasesCount > 0 ? Math.round((totalAsaMinutesSum / totalCasesCount) * 10) / 10 : 0;

  // Occupancy: (Total Handling Minutes) / (Operational HC * Working Days in Horizon * Daily Present Minutes)
  const workingDaysInHorizon = getCalendarWorkingDaysInHorizon(horizonStart, horizonEnd, calendar);
  const totalAvailableAgentMinutes =
    operationalHC * Math.max(1, workingDaysInHorizon) * (dailyPresentHours * 60);

  const rawOccupancyPct =
    totalAvailableAgentMinutes > 0
      ? Math.round((totalHandlingMinutes / totalAvailableAgentMinutes) * 1000) / 10
      : 0;
  const occupancyPct = Math.min(100, rawOccupancyPct);

  // Target SLA Pass Flags
  const passesPrimarySLA = primaryAchievedPct >= sla.primaryPct;
  const passesCategorySLA = allCategoriesPassPrimarySLA;

  const asaBasis = sla.asaClockBasis === 'clock_hours' ? 'wall_clock' : 'business_time';
  const targetAsaMinutes = convertSlaDurationToMinutes(
    sla.boAsaTarget,
    sla.boAsaUnit,
    asaBasis,
    calendar
  );
  const passesBOASA = !sla.boAsaEnabled || boAsaMeanMinutes <= targetAsaMinutes;
  // The cap is always in force — occupancyCapEnabled selects a custom target below the
  // 100% default rather than switching a ceiling on/off. Gate on the unclamped ratio: a
  // clamped comparison (occupancyPct <= cap) is true for every input once cap is 100.
  const passesOccupancyCap = rawOccupancyPct <= resolveOccupancyCapPct(sla);
  const minAgentsRequired = resolveMinAgentsPerInterval(sla, operationalHC);
  // Infinity means no business-open sampling occurred (degenerate horizon / zero HC) — treat
  // as passing rather than failing on an absence of evidence.
  //
  // 24x7 gate RE-ENABLED (2026-08-28, 24x7 multi-start). An interim regression existed here:
  // countAgentsOnShiftNow() used to degenerate for 24x7 because staggeredMode was
  // unconditionally false there (no shift starts existed at all) — "on shift" collapsed to
  // "has daily budget remaining", a capacity signal wearing a scheduling signal's name, with
  // neither repair lever (buildCoverageRepairDistribution, placement) available either. That
  // combination made the default-on floor climb N purely to manufacture budget slack
  // (measured: N=3->11 on a scenario where SLA/occupancy both already passed at N=3 — see
  // suite D36). Fixed by giving 24x7 a real shift-start grid (getValidSlapStarts no longer
  // returns the degenerate [0] for is24x7) and staggering support in the event scheduling
  // above, so countAgentsOnShiftNow() now reflects genuine per-agent shift presence for 24x7
  // exactly as it does for business-hours calendars, and both repair levers are available.
  const passesCoverage = minAgentsRequired <= 0 || minOnShiftDuringOpenHours === Infinity || minOnShiftDuringOpenHours >= minAgentsRequired;
  const allPassed =
    passesPrimarySLA &&
    passesCategorySLA &&
    passesBOASA &&
    passesOccupancyCap &&
    passesCoverage;

  return {
    operationalHC,
    horizonStart,
    horizonEnd,
    totalCases: totalCasesCount,
    completedCases: completedCasesCount,
    unfinishedCases: unfinishedCasesCount,
    primaryEligibleCount,
    primaryPassCount,
    primaryAchievedPct,
    passesPrimarySLA,
    categoryStats,
    passesCategorySLA,
    boAsaMeanMinutes,
    boAsaCensoredCount: censoredAsaCount,
    totalHandlingMinutes,
    totalAvailableProductiveMinutes: totalAvailableAgentMinutes,
    occupancyPct,
    rawOccupancyPct,
    passesBOASA,
    passesOccupancyCap,
    minCoverageObserved: minOnShiftDuringOpenHours,
    passesCoverage,
    allPassed,
    intervalsTimeline: timelineIntervals,
    caseResults,
    agentTimeline,
    ...(shiftDistribution ? { shiftDistributionUsed: shiftDistribution } : {}),
  };
}

export function verifyAgentTimelineInvariants(
  des: DESResult,
  labor: LaborConfig,
  calendar?: CalendarConfig
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!des.agentTimeline || des.agentTimeline.length === 0) {
    if (des.operationalHC > 0) {
      errors.push('agentTimeline is empty for operationalHC > 0');
    }
    return { valid: errors.length === 0, errors };
  }

  const effectiveAdherence = resolveEffectiveAdherence(labor);
  const dailyBudgetMinutes = labor.dailyProductiveHours * effectiveAdherence * 60;

  // 1. sum(minutes where state==='busy') === totalHandlingMinutes (0.01 tolerance)
  let busyMinutesSum = 0;
  for (const slice of des.agentTimeline) {
    if (slice.state === 'busy') {
      busyMinutesSum += slice.minutes;
    }
  }
  const busyTolerance = Math.max(0.01, des.totalHandlingMinutes * 1e-5);
  if (Math.abs(busyMinutesSum - des.totalHandlingMinutes) > busyTolerance) {
    errors.push(
      `Busy minutes sum (${busyMinutesSum.toFixed(3)}) does not match totalHandlingMinutes (${des.totalHandlingMinutes.toFixed(3)})`
    );
  }

  // 2. occupancy from slices matches occupancyPct within 0.1pp
  const sliceOccupancyPct =
    des.totalAvailableProductiveMinutes > 0
      ? Math.min(100, Math.round((busyMinutesSum / des.totalAvailableProductiveMinutes) * 1000) / 10)
      : 0;
  if (Math.abs(sliceOccupancyPct - des.occupancyPct) > 0.1) {
    errors.push(
      `Slice occupancy (${sliceOccupancyPct}%) differs from DES occupancyPct (${des.occupancyPct}%) by > 0.1pp`
    );
  }
  const rawSliceOccupancyPct =
    des.totalAvailableProductiveMinutes > 0
      ? Math.round((busyMinutesSum / des.totalAvailableProductiveMinutes) * 1000) / 10
      : 0;
  if (Math.abs(rawSliceOccupancyPct - des.rawOccupancyPct) > 0.1) {
    errors.push(
      `Raw slice occupancy (${rawSliceOccupancyPct}%) differs from DES rawOccupancyPct (${des.rawOccupancyPct}%) by > 0.1pp`
    );
  }

  // 3. every busy.caseId exists in caseResults
  const caseIdSet = new Set((des.caseResults || []).map((c) => c.caseId));
  for (const slice of des.agentTimeline) {
    if (slice.state === 'busy' && slice.caseId) {
      if (!caseIdSet.has(slice.caseId)) {
        errors.push(`Busy slice references unknown caseId: ${slice.caseId}`);
      }
    }
  }

  // 4. No agent busy minutes in a calendar day exceed dailyBudgetMinutes + 0.01
  const agentDayBusy = new Map<string, number>();
  for (const slice of des.agentTimeline) {
    if (slice.state === 'busy') {
      const key = `${slice.agentId}_${slice.date}`;
      agentDayBusy.set(key, (agentDayBusy.get(key) || 0) + slice.minutes);
    }
  }
  for (const [key, minutes] of agentDayBusy.entries()) {
    if (minutes > dailyBudgetMinutes + 0.01) {
      errors.push(
        `Agent day ${key} busy minutes (${minutes.toFixed(2)}) exceeds daily budget (${dailyBudgetMinutes.toFixed(2)})`
      );
    }
  }

  // 5. operationalHC agents are all present in timeline (at least one slice each)
  const agentIdsPresent = new Set(des.agentTimeline.map((s) => s.agentId));
  for (let id = 0; id < des.operationalHC; id++) {
    if (!agentIdsPresent.has(id)) {
      errors.push(`Agent-${id + 1} is missing from agentTimeline`);
    }
  }

  // 6. No overlaps and contiguous slices for each agent (sorted by from ASC)
  const perAgentSlices = new Map<number, AgentWorkSlice[]>();
  for (const slice of des.agentTimeline) {
    if (!perAgentSlices.has(slice.agentId)) {
      perAgentSlices.set(slice.agentId, []);
    }
    perAgentSlices.get(slice.agentId)!.push(slice);
  }

  for (const [agentId, slices] of perAgentSlices.entries()) {
    slices.sort((a, b) => a.from.getTime() - b.from.getTime());
    for (let i = 0; i < slices.length - 1; i++) {
      const curr = slices[i];
      const next = slices[i + 1];
      if (curr.to.getTime() > next.from.getTime()) {
        errors.push(
          `Agent-${agentId + 1} slice overlap: slice ends at ${curr.to.toISOString()} but next slice starts at ${next.from.toISOString()}`
        );
      } else if (curr.to.getTime() < next.from.getTime()) {
        errors.push(
          `Agent-${agentId + 1} slice gap: slice ends at ${curr.to.toISOString()} but next slice starts at ${next.from.toISOString()}`
        );
      }
    }
  }

  // 7. No busy slice falls outside the business window (I2). `calendar` was accepted as a
  // parameter but never used prior to this check — nothing previously asserted that agent
  // activity stays within open hours. Staggered shift placement is exactly the kind of
  // change that could violate this silently, so this check exists independently of it and
  // covers both uniform and staggered runs.
  if (calendar) {
    for (const slice of des.agentTimeline) {
      if (slice.state !== 'busy') continue;
      if (calendar.is24x7) continue; // no window to violate
      if (!isWorkingDay(slice.from, calendar)) {
        errors.push(
          `Agent-${slice.agentId + 1} busy slice on non-working day: ${slice.from.toISOString()}`
        );
        continue;
      }
      const { openTime, closeTime } = getDailyOpenClose(slice.from, calendar);
      if (slice.from.getTime() < openTime.getTime() || slice.from.getTime() >= closeTime.getTime()) {
        errors.push(
          `Agent-${slice.agentId + 1} busy slice starts outside business window: ${slice.from.toISOString()} (window ${openTime.toISOString()}–${closeTime.toISOString()})`
        );
      }
      if (slice.to.getTime() > closeTime.getTime()) {
        errors.push(
          `Agent-${slice.agentId + 1} busy slice ends after business close: ${slice.to.toISOString()} (close ${closeTime.toISOString()})`
        );
      }
    }
  }

  // 8. Per-agent stagger-offset compliance (I5). Check #7 only validates the GLOBAL business
  // window and cannot catch an agent dispatched before ITS OWN assigned offset while the
  // business is already open — measured: a synthetic timeline with exactly that violation
  // passed check #7 with valid=true. Uses des.shiftDistributionUsed (already echoed by
  // runBackofficeDES) to reconstruct each agent's offset — no new parameter needed. The
  // reconstruction (ascending agentId within a category block, ascending slap offset,
  // sequential cursor) mirrors the same deterministic assignment runBackofficeDES uses
  // internally (see the staggeredMode setup above); an agent's own category is read from any
  // of its busy slices (siloed agents keep one category for their whole run), so an agent
  // that never worked is skipped — nothing to validate for it.
  if (calendar && !calendar.is24x7 && des.shiftDistributionUsed) {
    const agentCategory = new Map<number, string>();
    for (const slice of des.agentTimeline) {
      if (slice.state === 'busy' && slice.category && !agentCategory.has(slice.agentId)) {
        agentCategory.set(slice.agentId, slice.category);
      }
    }
    const isPooledDist = '__POOLED__' in des.shiftDistributionUsed;
    const blockOf = new Map<string, number[]>();
    for (let id = 0; id < des.operationalHC; id++) {
      const key = isPooledDist ? '__POOLED__' : agentCategory.get(id);
      if (key === undefined) continue;
      if (!blockOf.has(key)) blockOf.set(key, []);
      blockOf.get(key)!.push(id);
    }
    const agentOffset = new Map<number, number>();
    for (const [key, ids] of blockOf.entries()) {
      const dist = des.shiftDistributionUsed[key];
      if (!dist) continue;
      ids.sort((a, b) => a - b);
      const sortedSlaps = [...dist.slaps].sort((a, b) => a.startMinutesFromOpen - b.startMinutesFromOpen);
      let cursor = 0;
      for (const slap of sortedSlaps) {
        for (let k = 0; k < slap.agentCount && cursor < ids.length; k++, cursor++) {
          agentOffset.set(ids[cursor], slap.startMinutesFromOpen);
        }
      }
    }
    for (const slice of des.agentTimeline) {
      if (slice.state !== 'busy') continue;
      const offset = agentOffset.get(slice.agentId);
      if (!offset) continue; // offset 0/undefined: nothing earlier within the day to violate
      if (!isWorkingDay(slice.from, calendar)) continue; // check #7 already covers non-working days
      const { openTime } = getDailyOpenClose(slice.from, calendar);
      const ownStart = new Date(openTime.getTime() + offset * 60000);
      if (slice.from.getTime() < ownStart.getTime()) {
        errors.push(
          `Agent-${slice.agentId + 1} busy slice starts before its own assigned offset: ${slice.from.toISOString()} (own shift starts ${ownStart.toISOString()}, offset +${offset}min)`
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
