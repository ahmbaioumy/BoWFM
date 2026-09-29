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
 *   Scheduled             = available + the tail of the business day after the agent's daily
 *                           productive budget ran out (agent goes out-of-queue but is still on shift).
 *   Utilisation %         = busy / scheduled. Equals the "Utilisation %" of the Agent Assignment
 *                           Fairness panel over the whole run. It differs from occupancy ONLY on
 *                           days the daily productive-hour budget is exhausted before shift end;
 *                           otherwise the two are the same number (this engine models no separate
 *                           non-productive time inside a shift).
 *   Cases handled         = cases the agent COMPLETED (credited to the finisher, never double-counted).
 *   Cases touched         = distinct cases the agent worked on (>= handled; includes split cases).
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
  casesCompleted: number;
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
  /** Busy minutes per case touched; null when nothing touched. */
  avgHandleMin: number | null;
  /** Days in range on which the agent was on shift. */
  onShiftDays: number;
  /** casesCompleted / onShiftDays; null when never on shift in range. */
  casesPerDay: number | null;
  /** Busy minutes inside the last `lateWindowMin` of each business day. */
  lateWindowBusyMin: number;
}

export interface AgentTrendPoint {
  date: string;
  /** Mean cases completed per on-shift agent. */
  avg: number;
  min: number;
  max: number;
  agents: number;
}

export interface AgentAnalytics {
  /** Every active date in the run (unfiltered), ascending. Drives the date-picker bounds. */
  allDates: string[];
  /** Active dates inside the filter range, ascending. */
  dates: string[];
  categories: string[];
  rows: AgentAnalyticsRow[];
  /** matrix[rowIdx][dateIdx] = cases completed by that agent on that date. */
  matrix: number[][];
  /** onShiftMatrix[rowIdx][dateIdx] = the agent was on shift that date. */
  onShiftMatrix: boolean[][];
  trend: AgentTrendPoint[];
  team: {
    agents: number;
    casesTotal: number;
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
}

export const DEFAULT_LATE_WINDOW_MIN = 120;

interface Cell {
  busy: number;
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
    if (fairnessCat.has(id)) return 'Pooled';
    const set = sliceCats.get(id);
    return set && set.size === 1 ? [...set][0] : 'Pooled';
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

  // ---- Completer of each finished case ----------------------------------------------------
  const completerOf = new Map<string, number>();
  const completedByAgentDate = new Map<number, Map<string, number>>();
  for (const c of des.caseResults ?? []) {
    if (!c.isCompleted || !c.completeTime || !c.assignedAgents || c.assignedAgents.length === 0) continue;
    const who = c.assignedAgents[c.assignedAgents.length - 1];
    completerOf.set(c.caseId, who);
    if (catFilter && c.category !== catFilter) continue;
    const d = formatDate24(c.completeTime);
    if (!inRange(d)) continue;
    let m = completedByAgentDate.get(who);
    if (!m) completedByAgentDate.set(who, (m = new Map()));
    m.set(d, (m.get(d) || 0) + 1);
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
      cell = { busy: 0, idle: 0, pendingOff: 0, hasOnShift: false, firstOnShiftFrom: null, lateBusy: 0, resumes: 0, touched: new Set() };
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
  const rows: AgentAnalyticsRow[] = [];
  const keptIds: number[] = [];
  for (let id = 0; id < hc; id++) {
    if (agentSel && !agentSel.has(id)) continue;
    const cat = agentCategory(id);
    // Siloed agents belong to one category; pooled agents ('Pooled') pass and are filtered by work instead.
    if (catFilter && cat !== 'Pooled' && cat !== catFilter) continue;
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
      // Late cohorts work a capped shift (productive hours from their own start): never schedule past it.
      const tail = lateShift ? Math.max(0, Math.min(cell.pendingOff, prodMin - avail)) : cell.pendingOff;
      scheduled += avail + tail;
    }
    // Filtered-category runs: idle is category-agnostic, so keep available/scheduled as recorded.
    let completed = 0;
    for (const n of (completedByAgentDate.get(id) ?? new Map<string, number>()).values()) completed += n;
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
      casesTouched: touched.size,
      casesHandedOver: handedOver,
      resumes,
      busyMin: busy,
      idleMin: idle,
      availableMin: available,
      scheduledMin: Math.max(scheduled, available),
      occupancyPct: pct(busy, available),
      utilisationPct: pct(busy, Math.max(scheduled, available)),
      avgHandleMin: touched.size > 0 ? busy / touched.size : null,
      onShiftDays,
      casesPerDay: onShiftDays > 0 ? completed / onShiftDays : null,
      lateWindowBusyMin: lateBusy,
    });
  }

  // ---- Matrix + trend ---------------------------------------------------------------------
  const matrix: number[][] = [];
  const onShiftMatrix: boolean[][] = [];
  for (const r of rows) {
    const cm = completedByAgentDate.get(r.agentId) ?? new Map<string, number>();
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
  const busyMin = rows.reduce((a, r) => a + r.busyMin, 0);
  const availableMin = rows.reduce((a, r) => a + r.availableMin, 0);
  const scheduledMin = rows.reduce((a, r) => a + r.scheduledMin, 0);

  return {
    allDates,
    dates,
    categories,
    rows,
    matrix,
    onShiftMatrix,
    trend,
    team: {
      agents: rows.length,
      casesTotal,
      casesMean: rows.length > 0 ? casesTotal / rows.length : 0,
      busyMin,
      availableMin,
      scheduledMin,
      occupancyPct: pct(busyMin, availableMin),
      utilisationPct: pct(busyMin, scheduledMin),
    },
    fairness: computeAgentFairnessMetrics(rows.map((r) => ({ casesCompleted: r.casesCompleted, utilPct: r.utilisationPct }))),
    lateWindowMin,
    earliestCohortStart,
    filter: { fromDate, toDate, category: catFilter, agentIds: agentSel ? [...agentSel].sort((a, b) => a - b) : [] },
  };
}

/** Deterministic ordering for the "cases per agent" bar chart: cases desc, then agent id asc. */
export function sortRowsByCases(rows: AgentAnalyticsRow[]): AgentAnalyticsRow[] {
  return [...rows].sort((a, b) => b.casesCompleted - a.casesCompleted || a.agentId - b.agentId);
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
      `Most loaded: ${top.agentLabel} completed ${top.casesCompleted} cases (${signed(dev(top.casesCompleted))} vs the team average of ${r1(mean)}). ` +
        `Least loaded: ${low.agentLabel} completed ${low.casesCompleted} (${signed(dev(low.casesCompleted))}).`
    );
    const outside = sorted.filter((r) => Math.abs(dev(r.casesCompleted)) > band);
    if (outside.length === 0) {
      out.push(`Every selected agent is within +/-${band}% of the average cases per agent.`);
    } else {
      const names = outside.slice(0, 6).map((r) => `${r.agentLabel} (${signed(dev(r.casesCompleted))})`).join(', ');
      out.push(`${outside.length} of ${rows.length} agents are outside +/-${band}% of the average cases per agent: ${names}${outside.length > 6 ? ', ...' : ''}.`);
    }
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
      `Fairness over this range: cases max/min ${fm.casesMaxMinRatio === null ? 'n/a (an agent has 0)' : fm.casesMaxMinRatio.toFixed(2)}, ` +
        `cases CV ${fm.casesCv.toFixed(3)}, utilisation CV ${fm.utilCv.toFixed(3)}, Jain's index ${fm.utilJain.toFixed(3)} (1 = perfectly even).`
    );
  }
  return out;
}

/** Export tables (rounded at the presentation boundary only). */
export function buildAgentAnalyticsExport(a: AgentAnalytics): {
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
    'Cases Completed': r.casesCompleted,
    'Cases Touched': r.casesTouched,
    'Cases Handed Over': r.casesHandedOver,
    Resumes: r.resumes,
    'Busy (min)': rd(r.busyMin),
    'Available On-Shift (min)': rd(r.availableMin),
    'Idle (min)': rd(r.idleMin),
    'Scheduled (min)': rd(r.scheduledMin),
    'Occupancy %': rd(r.occupancyPct),
    'Utilisation %': rd(r.utilisationPct),
    'Avg Handle (min per case touched)': rd(r.avgHandleMin),
    'On-Shift Days': r.onShiftDays,
    'Cases per Day': rd(r.casesPerDay),
  }));
  const matrix = a.rows.map((r, i) => {
    const row: Record<string, unknown> = { Agent: r.agentLabel, Category: r.category };
    a.dates.forEach((d, j) => {
      row[d] = a.onShiftMatrix[i][j] ? a.matrix[i][j] : '';
    });
    row['Total'] = r.casesCompleted;
    return row;
  });
  return {
    sections: [
      { title: `Agent summary - ${scope}`, rows: summary },
      { title: 'Cases completed per agent per date (blank = not on shift)', rows: matrix },
    ],
  };
}
