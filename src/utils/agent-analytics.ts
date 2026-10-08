/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent analytics — pure, deterministic aggregation over the audit run's DESResult
 * (agentTimeline slices + caseResults + agentFairness). No engine changes: everything here is
 * derived from data the engine already emits. Single-seed audit run only — these are not
 * confidence-interval figures.
 *
 * Metric definitions (also shown in the UI help line):
 *   Available (on-shift)  = busy + idle minutes: time the agent was in the queue on shift.
 *   Occupancy %           = busy / available. How hard the agent worked while in the queue.
 *   Scheduled             = available + the on-shift time after the agent's daily productive budget ran
 *                           out (out-of-queue but still on shift). Run on fixed shifts (Shift Placement on, or the
 *                           coverage-repair stagger): capped at the agent's own shift (daily productive hours
 *                           from their own start). Run without fixed shifts: no shift end exists, so it runs
 *                           to business close.
 *   Utilisation %         = busy / scheduled. Lower than occupancy whenever an agent has scheduled
 *                           time outside the queue. NOT the Fairness panel figure: that panel's
 *                           "Occupancy %" is busy / on-shift available.
 *   Work share            = PRIMARY load metric. For every COMPLETED case, each agent earns
 *                           (that agent's busy minutes on the case) / (all agents' busy minutes on the
 *                           case), attributed to the calendar date of each busy slice (so date filters
 *                           work). A case worked by one agent is worth 1.0 to that agent; a case split
 *                           A:30 min / B:10 min is 0.75 / 0.25. Sum over ALL agents == finished cases
 *                           (within float tolerance; a completed case with zero busy minutes credits 1.0
 *                           to its finisher on its completion date). The denominator always uses every
 *                           agent's slices on the case, even when an agent/date filter hides some of them.
 *                           Unfinished cases carry no work share (their busy time still counts in Busy).
 *   Finished              = cases the agent COMPLETED (finisher credit, never double-counted). It credits
 *                           the WHOLE case to whoever closes it, so a late-shift agent who only resumes
 *                           parked cases looks overloaded here — use Work share for load.
 *   Cases touched         = distinct cases the agent worked on (>= finished; includes split cases).
 *   Avg handle            = busy minutes the agent spent on COMPLETED cases / work share. It is the
 *                           share-weighted mean total handle time of the cases the agent contributed to
 *                           (a sole worker of a case gets that case's full handle time). null when the
 *                           agent has no work share in range.
 *   Cases per day         = work share / on-shift days.
 *   Single-agent cover    = intervals (>= 30 business minutes, inside opening hours) where exactly one
 *                           agent was in the queue on shift; reported per agent with the cases it
 *                           finished during those intervals that other agents had started.
 *   Fairness / heatmap / trend / team average all use work share (not finisher credit).
 *
 * Per-date bucketing uses calendar.ts (formatDate24 / getDailyOpenClose / workingDuration /
 * addWorkingTime) — no hand-rolled Date arithmetic.
 */

import type { AgentFairnessMetrics, CalendarConfig, DESResult, LaborConfig } from '../types/wfm';
import {
  addWorkingTime,
  formatDate24,
  formatTime24,
  getDailyOpenClose,
  isWorkingDay,
  workingDuration,
} from './calendar';
import { computeAgentFairnessMetrics } from './des-engine';

export interface AgentAnalyticsFilter {
  /** Inclusive 'YYYY-MM-DD'; null/undefined = from the first active date. */
  fromDate?: string | null;
  /** Inclusive 'YYYY-MM-DD'; null/undefined = to the last active date. */
  toDate?: string | null;
  /** Category name; null/undefined/'ALL' = all. Siloed: keeps that category's agents. Pooled: counts only that category's work. */
  category?: string | null;
  /** Agent ids to keep; null/undefined/empty = all agents. */
  agentIds?: number[] | null;
}

export interface AgentAnalyticsRow {
  agentId: number;
  agentLabel: string;
  category: string;
  /** Modal shift start time of day ('HH:mm') across the agent's active days. */
  cohortStart: string;
  /** True when the agent's cohort starts later than the earliest cohort in the run. */
  isLateShift: boolean;
  /** Finisher credit: whole cases this agent completed ("Finished" in the UI). */
  casesCompleted: number;
  /** Fractional work share on completed cases in range (see file header). Primary load metric. */
  workShare: number;
  /** Busy minutes spent on completed cases in range (numerator of avg handle). */
  workBusyMin: number;
  casesTouched: number;
  /** Touched cases another agent finished (excludes cases still unfinished at run end). */
  casesHandedOver: number;
  /** Busy slices that resumed a parked / previously-started case. */
  resumes: number;
  busyMin: number;
  idleMin: number;
  /** busy + idle. */
  availableMin: number;
  /** available + post-budget on-shift tail (see file header). */
  scheduledMin: number;
  occupancyPct: number;
  utilisationPct: number;
  /** workBusyMin / workShare; null when workShare is 0. */
  avgHandleMin: number | null;
  /** Days in range on which the agent was on shift. */
  onShiftDays: number;
  /** workShare / onShiftDays; null when never on shift in range. */
  casesPerDay: number | null;
  /** Busy minutes inside the last `lateWindowMin` of each business day. */
  lateWindowBusyMin: number;
}

export interface AgentTrendPoint {
  date: string;
  /** Mean work share per on-shift agent. */
  avg: number;
  min: number;
  max: number;
  agents: number;
}

export interface SoloCover {
  agentId: number;
  agentLabel: string;
  /** Most common solo window, 'HH:mm'. */
  windowStart: string;
  windowEnd: string;
  /** Distinct dates with a solo window. */
  days: number;
  /** Total business minutes as the only agent in the queue. */
  minutes: number;
  /** Cases this agent finished inside its solo windows that another agent had started. */
  finishedFromOthers: number;
}

export interface AgentAnalytics {
  /** Every active date in the run (unfiltered), ascending. Drives the date-picker bounds. */
  allDates: string[];
  /** Active dates inside the filter range, ascending. */
  dates: string[];
  categories: string[];
  rows: AgentAnalyticsRow[];
  /** matrix[rowIdx][dateIdx] = work share earned by that agent on that date. */
  matrix: number[][];
  /** onShiftMatrix[rowIdx][dateIdx] = the agent was on shift that date. */
  onShiftMatrix: boolean[][];
  trend: AgentTrendPoint[];
  /** Intervals where exactly one agent was in the queue while open (date range only; agents kept by the filter). */
  soloCover: SoloCover[];
  team: {
    agents: number;
    /** Finisher-credit total (whole cases). */
    casesTotal: number;
    /** Work-share total across the kept agents. */
    workShareTotal: number;
    /** Mean work share per kept agent (the team-average line). */
    casesMean: number;
    busyMin: number;
    availableMin: number;
    scheduledMin: number;
    occupancyPct: number;
    utilisationPct: number;
  };
  fairness: AgentFairnessMetrics;
  lateWindowMin: number;
  earliestCohortStart: string | null;
  filter: Required<AgentAnalyticsFilter>;
  /** The run used fixed shifts: every agent works a shift of dailyProductiveHours from their own start and then leaves (a start distribution was passed, or the calendar is not 24x7). False only for 24x7 without a distribution, where agents stay available all day. */
  staggered: boolean;
  /** Dates in `dates` after the last day of data (leftover work cleared on a part-day). Empty when none are in range. */
  drainDates: string[];
  /** A category filter is set AND the rows are the shared pool (Busy/Occupancy/Utilisation count only that category's work). */
  pooledCategoryFilter: boolean;
}

export const DEFAULT_LATE_WINDOW_MIN = 120;
/** Category label of agents in the shared pool (pooled architecture). */
const POOLED_CATEGORY = 'Pooled';
const SOLO_MIN_MINUTES = 30;

interface Cell {
  busy: number;
  /** Busy minutes across ALL categories (accumulated before the category filter) — used only to cap the scheduled tail. */
  busyAll: number;
  idle: number;
  pendingOff: number;
  hasOnShift: boolean;
  firstOnShiftFrom: Date | null;
  lateBusy: number;
  resumes: number;
  touched: Set<string>;
}

function pct(n: number, d: number): number {
  return d > 0 ? (n / d) * 100 : 0;
}

function hhmmToMin(s: string): number {
  const [h, m] = s.split(':');
  return Number(h) * 60 + Number(m);
}

export function computeAgentAnalytics(input: {
  des: DESResult;
  calendar: CalendarConfig;
  labor: LaborConfig;
  filter?: AgentAnalyticsFilter;
  lateWindowMin?: number;
}): AgentAnalytics {
  const { des, calendar, labor } = input;
  const lateWindowMin = input.lateWindowMin ?? DEFAULT_LATE_WINDOW_MIN;
  const slices = [...(des.agentTimeline || [])].sort(
    (a, b) => a.agentId - b.agentId || a.from.getTime() - b.from.getTime()
  );
  const hc = des.operationalHC;

  // ---- Agent categories -------------------------------------------------------------------
  const fairnessCat = new Map<number, string | null>();
  for (const r of des.agentFairness?.perAgent ?? []) fairnessCat.set(r.agentId, r.category);
  const sliceCats = new Map<number, Set<string>>();
  for (const s of slices) {
    if (s.state === 'busy' && s.category) {
      if (!sliceCats.has(s.agentId)) sliceCats.set(s.agentId, new Set());
      sliceCats.get(s.agentId)!.add(s.category);
    }
  }
  const agentCategory = (id: number): string => {
    const f = fairnessCat.get(id);
    if (f) return f;
    if (fairnessCat.has(id)) return POOLED_CATEGORY;
    const set = sliceCats.get(id);
    return set && set.size === 1 ? [...set][0] : POOLED_CATEGORY;
  };
  const categories = Array.from(new Set(Array.from({ length: hc }, (_, i) => agentCategory(i)))).sort();
  if (des.caseResults) {
    for (const c of des.caseResults) if (!categories.includes(c.category)) categories.push(c.category);
    categories.sort();
  }

  // ---- Date universe (dates on which anybody was on shift) --------------------------------
  const activeDateSet = new Set<string>();
  for (const s of slices) if (s.state !== 'off') activeDateSet.add(formatDate24(s.from));
  const allDates = Array.from(activeDateSet).sort();

  const f = input.filter ?? {};
  const fromDate = f.fromDate ?? null;
  const toDate = f.toDate ?? null;
  const catFilter = f.category && f.category !== 'ALL' ? f.category : null;
  const agentSel = f.agentIds && f.agentIds.length > 0 ? new Set(f.agentIds) : null;
  const inRange = (d: string) => (!fromDate || d >= fromDate) && (!toDate || d <= toDate);
  const dates = allDates.filter(inRange);

  // ---- Cohort start per agent (unfiltered, so late/early classification is stable) ---------
  // First on-shift slice of each active day; the agent's cohort is the most common start time.
  const firstStartByAgentDate = new Map<number, Map<string, string>>();
  for (const s of slices) {
    if (s.state === 'off') continue;
    let m = firstStartByAgentDate.get(s.agentId);
    if (!m) firstStartByAgentDate.set(s.agentId, (m = new Map()));
    const d = formatDate24(s.from);
    if (!m.has(d)) m.set(d, formatTime24(s.from, ''));
  }
  const cohortOf = new Map<number, string>();
  for (const [id, m] of firstStartByAgentDate) {
    const counts = new Map<string, number>();
    for (const t of m.values()) counts.set(t, (counts.get(t) || 0) + 1);
    let best = '';
    let bestN = -1;
    for (const [t, n] of [...counts.entries()].sort((a, b) => hhmmToMin(a[0]) - hhmmToMin(b[0]))) {
      if (n > bestN) {
        best = t;
        bestN = n;
      }
    }
    cohortOf.set(id, best);
  }
  let earliestCohortMin = Infinity;
  for (const t of cohortOf.values()) earliestCohortMin = Math.min(earliestCohortMin, hhmmToMin(t));
  const earliestCohortStart = Number.isFinite(earliestCohortMin) ? [...cohortOf.values()].find((t) => hhmmToMin(t) === earliestCohortMin) ?? null : null;

  // ---- Per-day late window start (calendar helpers only) ----------------------------------
  const lateStartCache = new Map<string, Date | null>();
  const lateStartFor = (from: Date): Date | null => {
    const key = formatDate24(from);
    if (lateStartCache.has(key)) return lateStartCache.get(key)!;
    let out: Date | null = null;
    if (isWorkingDay(from, calendar)) {
      const { openTime, closeTime } = getDailyOpenClose(from, calendar);
      const len = workingDuration(openTime, closeTime, calendar);
      out = addWorkingTime(openTime, Math.max(0, len - lateWindowMin), calendar);
    }
    lateStartCache.set(key, out);
    return out;
  };

  // ---- Completer + work share of each finished case ---------------------------------------
  // Slices are grouped per case over ALL agents/dates so the share denominator is the case's true
  // total busy time; the filters only decide which shares are counted.
  const busyByCase = new Map<string, typeof slices>();
  for (const s of slices) {
    if (s.state !== 'busy' || !s.caseId) continue;
    let l = busyByCase.get(s.caseId);
    if (!l) busyByCase.set(s.caseId, (l = []));
    l.push(s);
  }
  const completerOf = new Map<string, number>();
  const completedByAgentDate = new Map<number, Map<string, number>>();
  const workShareByAgentDate = new Map<number, Map<string, number>>();
  const workBusyByAgent = new Map<number, number>();
  const addTo = (m: Map<number, Map<string, number>>, id: number, d: string, v: number) => {
    let inner = m.get(id);
    if (!inner) m.set(id, (inner = new Map()));
    inner.set(d, (inner.get(d) || 0) + v);
  };
  const finishedByAgent = new Map<number, Array<{ t: number; fromOthers: boolean }>>();
  for (const c of des.caseResults ?? []) {
    if (!c.isCompleted || !c.completeTime || !c.assignedAgents || c.assignedAgents.length === 0) continue;
    const who = c.assignedAgents[c.assignedAgents.length - 1];
    completerOf.set(c.caseId, who);
    const cs = busyByCase.get(c.caseId) ?? [];
    let fl = finishedByAgent.get(who);
    if (!fl) finishedByAgent.set(who, (fl = []));
    fl.push({ t: c.completeTime.getTime(), fromOthers: cs.some((x) => x.agentId !== who) });
    if (catFilter && c.category !== catFilter) continue;
    const d = formatDate24(c.completeTime);
    if (inRange(d)) addTo(completedByAgentDate, who, d, 1);
    let total = 0;
    for (const x of cs) total += x.minutes;
    if (total > 0) {
      for (const x of cs) {
        const xd = formatDate24(x.from);
        if (!inRange(xd)) continue;
        addTo(workShareByAgentDate, x.agentId, xd, x.minutes / total);
        workBusyByAgent.set(x.agentId, (workBusyByAgent.get(x.agentId) || 0) + x.minutes);
      }
    } else if (inRange(d)) {
      addTo(workShareByAgentDate, who, d, 1);
    }
  }

  // ---- Single-agent cover -----------------------------------------------------------------
  const soloAcc = new Map<number, { dates: Set<string>; minutes: number; finished: number; windows: Map<string, number> }>();
  if (new Set(slices.filter((s) => s.state !== 'off').map((s) => s.agentId)).size > 1) {
    const evByDate = new Map<string, Array<{ t: number; agent: number; delta: number }>>();
    for (const s of slices) {
      if (s.state === 'off') continue;
      const d = formatDate24(s.from);
      if (!inRange(d)) continue;
      let l = evByDate.get(d);
      if (!l) evByDate.set(d, (l = []));
      l.push({ t: s.from.getTime(), agent: s.agentId, delta: 1 }, { t: s.to.getTime(), agent: s.agentId, delta: -1 });
    }
    for (const d of Array.from(evByDate.keys()).sort()) {
      const evs = evByDate.get(d)!.sort((a, b) => a.t - b.t || a.delta - b.delta || a.agent - b.agent);
      const first = new Date(evs[0].t);
      if (!isWorkingDay(first, calendar)) continue;
      const { openTime, closeTime } = getDailyOpenClose(first, calendar);
      const active = new Map<number, number>();
      const segs: Array<{ agent: number; from: number; to: number }> = [];
      for (let i = 0; i < evs.length; i++) {
        const e = evs[i];
        active.set(e.agent, (active.get(e.agent) || 0) + e.delta);
        if (active.get(e.agent) === 0) active.delete(e.agent);
        const nextT = i + 1 < evs.length ? evs[i + 1].t : e.t;
        if (active.size === 1 && nextT > e.t) {
          const agent = active.keys().next().value as number;
          const lo = Math.max(e.t, openTime.getTime());
          const hi = Math.min(nextT, closeTime.getTime());
          if (hi <= lo) continue;
          const last = segs[segs.length - 1];
          if (last && last.agent === agent && last.to === lo) last.to = hi;
          else segs.push({ agent, from: lo, to: hi });
        }
      }
      for (const sg of segs) {
        const mins = workingDuration(new Date(sg.from), new Date(sg.to), calendar);
        if (mins < SOLO_MIN_MINUTES) continue;
        let acc = soloAcc.get(sg.agent);
        if (!acc) soloAcc.set(sg.agent, (acc = { dates: new Set(), minutes: 0, finished: 0, windows: new Map() }));
        acc.dates.add(d);
        acc.minutes += mins;
        for (const f of finishedByAgent.get(sg.agent) ?? []) if (f.fromOthers && f.t > sg.from && f.t <= sg.to) acc.finished++;
        const key = `${formatTime24(new Date(sg.from), '')}|${formatTime24(new Date(sg.to), '')}`;
        acc.windows.set(key, (acc.windows.get(key) || 0) + 1);
      }
    }
  }

  // ---- Per agent-date accumulation --------------------------------------------------------
  const cells = new Map<number, Map<string, Cell>>();
  for (const s of slices) {
    const d = formatDate24(s.from);
    if (!inRange(d)) continue;
    let byDate = cells.get(s.agentId);
    if (!byDate) cells.set(s.agentId, (byDate = new Map()));
    let cell = byDate.get(d);
    if (!cell) {
      cell = { busy: 0, busyAll: 0, idle: 0, pendingOff: 0, hasOnShift: false, firstOnShiftFrom: null, lateBusy: 0, resumes: 0, touched: new Set() };
      byDate.set(d, cell);
    }
    if (s.state === 'off') {
      if (cell.hasOnShift && isWorkingDay(s.from, calendar)) {
        const closeMs = getDailyOpenClose(s.from, calendar).closeTime.getTime();
        const end = Math.min(s.to.getTime(), closeMs);
        if (end > s.from.getTime()) cell.pendingOff += (end - s.from.getTime()) / 60000;
      }
      continue;
    }
    cell.hasOnShift = true;
    cell.pendingOff = 0;
    if (!cell.firstOnShiftFrom) cell.firstOnShiftFrom = s.from;
    if (s.state === 'idle') {
      cell.idle += s.minutes;
    } else {
      cell.busyAll += s.minutes;
      if (catFilter && s.category !== catFilter) continue;
      cell.busy += s.minutes;
      if (s.isResume) cell.resumes++;
      if (s.caseId) cell.touched.add(s.caseId);
      const ls = lateStartFor(s.from);
      if (ls) {
        const lo = s.from.getTime() < ls.getTime() ? ls : s.from;
        cell.lateBusy += workingDuration(lo, s.to, calendar);
      }
    }
  }

  // ---- Rows -------------------------------------------------------------------------------
  const prodMin = labor.dailyProductiveHours * 60;
  // Fixed shifts: every agent works a shift of prodMin from their own start (a distribution was passed, or the
  // calendar is not 24x7). Falls back to the distribution echo for results built before fixedShifts existed.
  const staggered = des.fixedShifts ?? !!des.shiftDistributionUsed;
  const rows: AgentAnalyticsRow[] = [];
  const keptIds: number[] = [];
  for (let id = 0; id < hc; id++) {
    if (agentSel && !agentSel.has(id)) continue;
    const cat = agentCategory(id);
    // Siloed agents belong to one category; pooled agents ('Pooled') pass and are filtered by work instead.
    if (catFilter && cat !== POOLED_CATEGORY && cat !== catFilter) continue;
    keptIds.push(id);
    const byDate = cells.get(id) ?? new Map<string, Cell>();
    let busy = 0;
    let idle = 0;
    let scheduled = 0;
    let lateBusy = 0;
    let resumes = 0;
    let onShiftDays = 0;
    const touched = new Set<string>();
    const cohort = cohortOf.get(id) ?? '';
    const lateShift = cohort !== '' && earliestCohortStart !== null && hhmmToMin(cohort) > hhmmToMin(earliestCohortStart);
    for (const cell of byDate.values()) {
      if (!cell.hasOnShift) continue;
      onShiftDays++;
      busy += cell.busy;
      idle += cell.idle;
      lateBusy += cell.lateBusy;
      resumes += cell.resumes;
      cell.touched.forEach((t) => touched.add(t));
      const avail = cell.busy + cell.idle;
      // Staggered runs: every agent works a fixed shift (productive hours from their own start), so never
      // schedule past it. The cap uses all-category busy + idle so a category filter cannot hide it.
      // Non-staggered runs have no shift end: the agent is on until business close (full tail).
      const tail = staggered ? Math.max(0, Math.min(cell.pendingOff, prodMin - (cell.busyAll + cell.idle))) : cell.pendingOff;
      scheduled += avail + tail;
    }
    // Filtered-category runs: idle is category-agnostic, so keep available/scheduled as recorded.
    let completed = 0;
    for (const n of (completedByAgentDate.get(id) ?? new Map<string, number>()).values()) completed += n;
    let workShare = 0;
    for (const n of (workShareByAgentDate.get(id) ?? new Map<string, number>()).values()) workShare += n;
    const workBusy = workBusyByAgent.get(id) ?? 0;
    let handedOver = 0;
    for (const cid of touched) {
      const who = completerOf.get(cid);
      if (who !== undefined && who !== id) handedOver++;
    }
    const available = busy + idle;
    rows.push({
      agentId: id,
      agentLabel: `Agent-${id + 1}`,
      category: cat,
      cohortStart: cohort || '-',
      isLateShift: lateShift,
      casesCompleted: completed,
      workShare,
      workBusyMin: workBusy,
      casesTouched: touched.size,
      casesHandedOver: handedOver,
      resumes,
      busyMin: busy,
      idleMin: idle,
      availableMin: available,
      scheduledMin: Math.max(scheduled, available),
      occupancyPct: pct(busy, available),
      utilisationPct: pct(busy, Math.max(scheduled, available)),
      avgHandleMin: workShare > 1e-9 ? workBusy / workShare : null,
      onShiftDays,
      casesPerDay: onShiftDays > 0 ? workShare / onShiftDays : null,
      lateWindowBusyMin: lateBusy,
    });
  }

  // ---- Matrix + trend ---------------------------------------------------------------------
  const matrix: number[][] = [];
  const onShiftMatrix: boolean[][] = [];
  for (const r of rows) {
    const cm = workShareByAgentDate.get(r.agentId) ?? new Map<string, number>();
    const bd = cells.get(r.agentId) ?? new Map<string, Cell>();
    matrix.push(dates.map((d) => cm.get(d) ?? 0));
    onShiftMatrix.push(dates.map((d) => bd.get(d)?.hasOnShift === true));
  }
  const trend: AgentTrendPoint[] = [];
  dates.forEach((d, j) => {
    const vals: number[] = [];
    rows.forEach((_, i) => {
      if (onShiftMatrix[i][j]) vals.push(matrix[i][j]);
    });
    if (vals.length === 0) return;
    trend.push({
      date: d,
      avg: vals.reduce((a, b) => a + b, 0) / vals.length,
      min: Math.min(...vals),
      max: Math.max(...vals),
      agents: vals.length,
    });
  });

  const casesTotal = rows.reduce((a, r) => a + r.casesCompleted, 0);
  const workShareTotal = rows.reduce((a, r) => a + r.workShare, 0);
  const keptSet = new Set(keptIds);
  const soloCover: SoloCover[] = [];
  for (const [agentId, acc] of soloAcc) {
    if (!keptSet.has(agentId)) continue;
    let best = '';
    let bestN = -1;
    for (const [k, n] of [...acc.windows.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
      if (n > bestN) {
        best = k;
        bestN = n;
      }
    }
    const [ws, we] = best.split('|');
    soloCover.push({ agentId, agentLabel: `Agent-${agentId + 1}`, windowStart: ws, windowEnd: we, days: acc.dates.size, minutes: acc.minutes, finishedFromOthers: acc.finished });
  }
  soloCover.sort((x, y) => y.finishedFromOthers - x.finishedFromOthers || y.minutes - x.minutes || x.agentId - y.agentId);
  const busyMin = rows.reduce((a, r) => a + r.busyMin, 0);
  const availableMin = rows.reduce((a, r) => a + r.availableMin, 0);
  const scheduledMin = rows.reduce((a, r) => a + r.scheduledMin, 0);
  // Last day of data = the day the horizon end falls on (the -1 ms keeps a midnight end on the previous day).
  const horizonEndMs = des.horizonEnd instanceof Date ? des.horizonEnd.getTime() : NaN;
  const lastDataDay = Number.isFinite(horizonEndMs) ? formatDate24(new Date(horizonEndMs - 1)) : null;
  const drainDates = lastDataDay === null ? [] : dates.filter((d) => d > lastDataDay);
  const pooledCategoryFilter = catFilter !== null && rows.some((r) => r.category === POOLED_CATEGORY);

  return {
    allDates,
    dates,
    categories,
    rows,
    matrix,
    onShiftMatrix,
    trend,
    soloCover,
    team: {
      agents: rows.length,
      casesTotal,
      workShareTotal,
      casesMean: rows.length > 0 ? workShareTotal / rows.length : 0,
      busyMin,
      availableMin,
      scheduledMin,
      occupancyPct: pct(busyMin, availableMin),
      utilisationPct: pct(busyMin, scheduledMin),
    },
    fairness: computeAgentFairnessMetrics(rows.map((r) => ({ casesCompleted: r.workShare, utilPct: r.utilisationPct }))),
    lateWindowMin,
    earliestCohortStart,
    filter: { fromDate, toDate, category: catFilter, agentIds: agentSel ? [...agentSel].sort((a, b) => a - b) : [] },
    staggered,
    drainDates,
    pooledCategoryFilter,
  };
}

/** Deterministic ordering for the "cases per agent" bar chart: work share desc, then agent id asc. */
export function sortRowsByCases(rows: AgentAnalyticsRow[]): AgentAnalyticsRow[] {
  return [...rows].sort((a, b) => b.workShare - a.workShare || a.agentId - b.agentId);
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const signed = (n: number) => `${n >= 0 ? '+' : '-'}${Math.abs(r1(n))}%`;

/** Plain-language insights, computed from the (already filtered) analytics. */
export function buildAgentInsights(a: AgentAnalytics, opts: { bandPct?: number } = {}): string[] {
  const band = opts.bandPct ?? 15;
  const out: string[] = [];
  const rows = a.rows;
  if (rows.length === 0) return ['No agents match the current filters.'];
  const mean = a.team.casesMean;

  if (a.team.casesTotal === 0) {
    out.push('No cases were completed by the selected agents in this date range.');
  } else {
    const sorted = sortRowsByCases(rows);
    const top = sorted[0];
    const low = sorted[sorted.length - 1];
    const dev = (n: number) => (mean > 0 ? ((n - mean) / mean) * 100 : 0);
    out.push(
      `Most loaded: ${top.agentLabel} has a work share of ${r1(top.workShare)} cases (${signed(dev(top.workShare))} vs the team average of ${r1(mean)}). ` +
        `Least loaded: ${low.agentLabel} at ${r1(low.workShare)} (${signed(dev(low.workShare))}).`
    );
    const outside = sorted.filter((r) => Math.abs(dev(r.workShare)) > band);
    if (outside.length === 0) {
      out.push(`Every selected agent is within +/-${band}% of the average cases per agent.`);
    } else {
      const names = outside.slice(0, 6).map((r) => `${r.agentLabel} (${signed(dev(r.workShare))})`).join(', ');
      out.push(`${outside.length} of ${rows.length} agents are outside +/-${band}% of the average cases per agent: ${names}${outside.length > 6 ? ', ...' : ''}.`);
    }
  }

  for (const sc of a.soloCover.slice(0, 2)) {
    out.push(
      `${sc.agentLabel} is the only agent on shift ${sc.windowStart}-${sc.windowEnd} (${sc.days} day${sc.days === 1 ? '' : 's'}) and finishes ${sc.finishedFromOthers} cases started by others, ` +
        `so its "Finished" count overstates its load; the work-share figures split those cases by minutes worked.`
    );
  }

  const occSorted = [...rows].sort((x, y) => y.occupancyPct - x.occupancyPct || x.agentId - y.agentId);
  if (rows.length > 1 && occSorted[0].availableMin > 0) {
    out.push(
      `Occupancy ranges from ${r1(occSorted[occSorted.length - 1].occupancyPct)}% (${occSorted[occSorted.length - 1].agentLabel}) to ${r1(occSorted[0].occupancyPct)}% (${occSorted[0].agentLabel}); team ${r1(a.team.occupancyPct)}%.`
    );
  }

  const late = rows.filter((r) => r.isLateShift);
  const early = rows.filter((r) => !r.isLateShift);
  if (late.length > 0 && early.length > 0) {
    const lateBusy = late.reduce((s, r) => s + r.lateWindowBusyMin, 0);
    const allBusy = rows.reduce((s, r) => s + r.lateWindowBusyMin, 0);
    const shareBusy = pct(lateBusy, allBusy);
    const shareHc = pct(late.length, rows.length);
    const starts = Array.from(new Set(late.map((r) => r.cohortStart))).sort().join(', ');
    const lateUtil = pct(late.reduce((s, r) => s + r.busyMin, 0), late.reduce((s, r) => s + r.scheduledMin, 0));
    const earlyUtil = pct(early.reduce((s, r) => s + r.busyMin, 0), early.reduce((s, r) => s + r.scheduledMin, 0));
    out.push(
      `${late.length} late-coverage agent${late.length === 1 ? '' : 's'} (start ${starts}; ${r1(shareHc)}% of headcount) did ${r1(shareBusy)}% of the team's work in the last ${a.lateWindowMin} minutes of the business day. ` +
        `Their utilisation is ${r1(lateUtil)}% vs ${r1(earlyUtil)}% for earlier-start agents.`
    );
  } else if (rows.length > 1) {
    out.push('All selected agents start at the same time, so there is no late-coverage cohort to compare.');
  }

  const fm = a.fairness;
  if (rows.length > 1) {
    out.push(
      `Fairness over this range (on work share): cases max/min ${fm.casesMaxMinRatio === null ? 'n/a (an agent has 0)' : fm.casesMaxMinRatio.toFixed(2)}, ` +
        `cases CV ${fm.casesCv.toFixed(3)}, utilisation CV ${fm.utilCv.toFixed(3)}, Jain's index ${fm.utilJain.toFixed(3)} (1 = perfectly even).`
    );
  }
  return out;
}

const hoursText = (h: number) => `${Math.round(h * 10) / 10}`;

/**
 * Plain-language notes for the current run. Single source of wording for the panel and the export.
 * Rows that do not apply to the run (part-day after the data ends, category filter) are omitted.
 */
export function buildAgentAnalyticsNotes(a: AgentAnalytics, labor: LaborConfig): Array<{ Item: string; Note: string }> {
  const hours = hoursText(labor.dailyProductiveHours);
  const mins = Math.round(labor.dailyProductiveHours * 60);
  const out: Array<{ Item: string; Note: string }> = [];
  out.push({
    Item: 'Scheduled (min)',
    Note: a.staggered
      ? `The minutes the agent was on the plan to work. In this run each agent worked a fixed shift: the daily productive hours counted from their start time (${hours} h = ${mins} min per full day).`
      : `The minutes the agent was on the plan to work. In this run agents had no fixed shift end, so this runs from the agent's start until business close. Shifts are fixed when Shift Placement is on, or when minimum coverage needs agents to start at different times.`,
  });
  out.push({
    Item: 'Utilisation % vs Occupancy %',
    Note: a.staggered
      ? `Normally the same number. They differ only on days when an agent's daily productive hours are used up before their shift ends, which happens when adherence is below 100%.`
      : `In this run agents had no fixed shift end, so utilisation is measured against the time until business close, so it reads low on a business day longer than the daily productive hours (${hours} h). This is expected, not an error. Use Occupancy to judge workload; do not size from this column.`,
  });
  out.push({
    Item: 'On-Shift Days',
    Note: `The number of dates on which the agent was on shift for any time in the range shown. The simulation puts every agent on shift every open day; rest days are added later in the headcount chain, not here.`,
  });
  if (a.drainDates.length > 0) {
    out.push({
      Item: 'Part-day after the data ends',
      Note: `${a.drainDates.join(', ')}: leftover work was cleared after the last day of data. The day counts as a day on shift with only the minutes actually on shift, which is why agents on shift that day show one more day, with fewer minutes than a full day on it.`,
    });
  }
  if (a.pooledCategoryFilter) {
    out.push({
      Item: 'Category filter',
      Note: `On a shared pool, Busy counts only the selected category's work. Idle is all of the agent's idle time, and Available is that Busy plus Idle, so it is smaller than the agent's full time on shift. Occupancy and Utilisation therefore read lower than the unfiltered figures, and per-category figures do not add up to them.`,
    });
  }
  return out;
}

/**
 * True when the run has no fixed shifts AND the business day is longer than the daily productive hours,
 * i.e. utilisation will read low by design. Day length comes from the calendar's configured open/close times.
 */
export function utilisationReadsLowByDesign(a: AgentAnalytics, labor: LaborConfig, calendar: CalendarConfig): boolean {
  if (a.staggered) return false;
  const dayMin = calendar.dailyCloseHour * 60 + calendar.dailyCloseMinute - (calendar.dailyOpenHour * 60 + calendar.dailyOpenMinute);
  return dayMin > labor.dailyProductiveHours * 60 + 1e-9;
}

/** Export tables (rounded at the presentation boundary only). */
export function buildAgentAnalyticsExport(a: AgentAnalytics, labor: LaborConfig): {
  sections: Array<{ title: string; rows: Array<Record<string, unknown>> }>;
} {
  const rd = (n: number | null) => (n === null ? '' : Math.round(n * 10) / 10);
  const range = `${a.dates[0] ?? '-'} to ${a.dates[a.dates.length - 1] ?? '-'}`;
  const scope = `audit run (single seed), ${range}, category ${a.filter.category ?? 'All'}, ${a.rows.length} agents`;
  const summary = a.rows.map((r) => ({
    Agent: r.agentLabel,
    Category: r.category,
    'Shift Start': r.cohortStart,
    'Late Coverage Shift': r.isLateShift ? 'YES' : 'NO',
    'Work Share (cases)': rd(r.workShare),
    'Cases Finished': r.casesCompleted,
    'Cases Touched': r.casesTouched,
    'Cases Handed Over': r.casesHandedOver,
    Resumes: r.resumes,
    'Busy (min)': rd(r.busyMin),
    'Available On-Shift (min)': rd(r.availableMin),
    'Idle (min)': rd(r.idleMin),
    'Scheduled (min)': rd(r.scheduledMin),
    'Occupancy %': rd(r.occupancyPct),
    'Utilisation %': rd(r.utilisationPct),
    'Avg Handle (min per case of work share)': rd(r.avgHandleMin),
    'On-Shift Days': r.onShiftDays,
    'Cases per Day': rd(r.casesPerDay),
  }));
  const matrix = a.rows.map((r, i) => {
    const row: Record<string, unknown> = { Agent: r.agentLabel, Category: r.category };
    a.dates.forEach((d, j) => {
      row[d] = a.onShiftMatrix[i][j] ? Math.round(a.matrix[i][j] * 100) / 100 : '';
    });
    row['Total'] = rd(r.workShare);
    return row;
  });
  return {
    sections: [
      { title: `Agent summary - ${scope}`, rows: summary },
      { title: 'Work share (cases) per agent per date (blank = not on shift)', rows: matrix },
      { title: 'Notes - how to read this file', rows: buildAgentAnalyticsNotes(a, labor) },
    ],
  };
}
