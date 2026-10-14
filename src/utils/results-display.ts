/**
 * Display-only helpers for the Results screen. No engine behaviour lives here.
 */
import type { WinningLayout } from '../types/wfm';

/**
 * Category label for a siloed agent who handled no cases. Uses the category the engine
 * assigned (agentFairness row); never guesses. Neutral label when no assignment is carried.
 */
export const NO_ASSIGNMENT_LABEL = 'No cases handled';
export function idleAgentCategoryLabel(assigned: string | null | undefined): string {
  return assigned && assigned.trim() !== '' ? assigned : NO_ASSIGNMENT_LABEL;
}

/** Amber note under the replications field; null when 30 or more. */
export function replicationsNote(replications: number): string | null {
  if (!(replications < 30)) return null;
  if (replications <= 1) return 'No confidence check: with one replication the result is a single run.';
  return 'Fewer than 30 replications: the confidence check is weak and results may change from run to run. 30 or more is recommended.';
}

/**
 * Whether a search-history row's Primary SLA figure should be coloured as "passing".
 * Mirrors the engine's primary gate (`passesPrimaryCI` in hc-search.ts): with a 95% CI
 * available the lower bound must be `>=` the slack-aware sizing floor
 * (`effectivePrimaryTarget`); boundary-equal passes. If the CI low is missing or not
 * finite (old data) it falls back to the legacy rule: median `>=` the policy target.
 */
export function historyPrimaryPasses(
  row: { primaryPct: number; primaryCiLow?: number | null },
  sizingFloorPct: number,
  policyTargetPct: number,
): boolean {
  const lo = row.primaryCiLow;
  if (typeof lo === 'number' && Number.isFinite(lo)) return lo >= sizingFloorPct;
  return row.primaryPct >= policyTargetPct;
}

/**
 * Tone for a representative-run SLA figure: 'ok' at/above target, 'amber' when below
 * target but the recommendation passed the confidence gate (engine supplied an
 * explanation), 'bad' when below target with no such explanation.
 */
export function representativeTone(
  achievedPct: number,
  floorPct: number,
  hasGateExplanation: boolean,
): 'ok' | 'amber' | 'bad' {
  if (achievedPct >= floorPct) return 'ok';
  return hasGateExplanation ? 'amber' : 'bad';
}

// ---------------------------------------------------------------------------
// Start-time block (Item 1 rework, A12): the roster the recommended headcount passed with.
// ---------------------------------------------------------------------------

export interface StartTimeLine {
  /** Category name for siloed runs; null for the pooled agent block. */
  category: string | null;
  /** e.g. "11 agents at 08:00, 10 agents at 13:00". */
  text: string;
}

const POOLED_KEY = '__POOLED__';

function clockLabel(openMinutes: number, offsetMinutes: number): string {
  const total = (((openMinutes + offsetMinutes) % 1440) + 1440) % 1440;
  const hh = Math.floor(total / 60);
  const mm = Math.round(total - hh * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

type StartDist = Record<string, { slaps: Array<{ startMinutesFromOpen: number; agentCount: number }> }>;
type StartCalendar = { is24x7?: boolean; dailyOpenHour: number; dailyOpenMinute: number };

/**
 * One text line per category (pooled: a single line) listing how many agents start at each clock time.
 * Clock time = calendar open time + the start offset (24x7: open is 00:00); offsets past midnight wrap.
 * Siloed: a category that has agents (`seatCounts`, from the audit run) but no roster entry starts at opening
 * and is listed as "<Category>: N agents at <open time>", so the lines sum to the recommended headcount.
 * Returns null (hide the block) when there is no roster or every agent starts at opening (offset 0).
 */
export function startTimeSplitLines(
  dist: StartDist | undefined | null,
  calendar: StartCalendar,
  seatCounts?: Record<string, number> | null,
): StartTimeLine[] | null {
  if (!dist) return null;
  const openMin = calendar.is24x7 ? 0 : calendar.dailyOpenHour * 60 + calendar.dailyOpenMinute;
  const agentsAt = (count: number, offset: number) =>
    `${count} ${count === 1 ? 'agent' : 'agents'} at ${clockLabel(openMin, offset)}`;
  const lines: StartTimeLine[] = [];
  let anyLater = false;
  const keys = new Set(Object.keys(dist));
  if (!keys.has(POOLED_KEY) && seatCounts) for (const k of Object.keys(seatCounts)) keys.add(k);
  for (const key of Array.from(keys).sort()) {
    const active = (dist[key]?.slaps ?? [])
      .filter((s) => s.agentCount > 0)
      .sort((a, b) => a.startMinutesFromOpen - b.startMinutesFromOpen);
    if (active.length === 0) {
      const seats = seatCounts?.[key] ?? 0;
      if (seats > 0 && key !== POOLED_KEY) lines.push({ category: key, text: agentsAt(seats, 0) });
      continue;
    }
    if (active.some((s) => s.startMinutesFromOpen > 0)) anyLater = true;
    lines.push({
      category: key === POOLED_KEY ? null : key,
      text: active.map((s) => agentsAt(s.agentCount, s.startMinutesFromOpen)).join(', '),
    });
  }
  return anyLater && lines.length > 0 ? lines : null;
}

export const START_TIME_HEADING = 'Start times this headcount needs';
export const START_TIME_HEADING_USED = 'Start times used for this headcount';
export const START_TIME_REASON = 'Rostering everyone at opening would not meet the targets with this headcount.';
export const START_TIME_REASON_USED = 'These are the start times this headcount was tested with.';
export const START_TIME_SPREAD_NOTE =
  'This roster splits agents evenly across start times. That is why turning the coverage floor off can give a higher headcount.';

/**
 * Static texts for the start-time block; null when the block is hidden. The "everyone at opening would not meet the
 * targets" claim is made only for layouts reached after the all-at-opening roster failed (repair, spread, placement,
 * ladder); polish or an unknown layout gets the neutral wording. The spread note only when the spread layout won.
 */
export function startTimeSplitNotes(
  dist: StartDist | undefined | null,
  calendar: StartCalendar,
  winningLayout?: WinningLayout | null,
  seatCounts?: Record<string, number> | null,
): { heading: string; reason: string; spreadNote: string | null } | null {
  if (!startTimeSplitLines(dist, calendar, seatCounts) || !dist) return null;
  const established = winningLayout === 'repair' || winningLayout === 'spread' || winningLayout === 'placement' || winningLayout === 'ladder';
  return {
    heading: established ? START_TIME_HEADING : START_TIME_HEADING_USED,
    reason: established ? START_TIME_REASON : START_TIME_REASON_USED,
    spreadNote: winningLayout === 'spread' ? START_TIME_SPREAD_NOTE : null,
  };
}
