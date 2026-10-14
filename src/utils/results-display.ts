/**
 * Display-only helpers for the Results screen. No engine behaviour lives here.
 */

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

/**
 * One text line per category (pooled: a single line) listing how many agents start at each clock time.
 * Clock time = calendar open time + the start offset (24x7: open is 00:00); offsets past midnight wrap.
 * Returns null (hide the block) when there is no roster or every agent starts at opening (offset 0).
 */
export function startTimeSplitLines(
  dist: Record<string, { slaps: Array<{ startMinutesFromOpen: number; agentCount: number }> }> | undefined | null,
  calendar: { is24x7?: boolean; dailyOpenHour: number; dailyOpenMinute: number },
): StartTimeLine[] | null {
  if (!dist) return null;
  const openMin = calendar.is24x7 ? 0 : calendar.dailyOpenHour * 60 + calendar.dailyOpenMinute;
  const lines: StartTimeLine[] = [];
  let anyLater = false;
  for (const key of Object.keys(dist).sort()) {
    const active = dist[key].slaps
      .filter((s) => s.agentCount > 0)
      .sort((a, b) => a.startMinutesFromOpen - b.startMinutesFromOpen);
    if (active.length === 0) continue;
    if (active.some((s) => s.startMinutesFromOpen > 0)) anyLater = true;
    lines.push({
      category: key === POOLED_KEY ? null : key,
      text: active
        .map((s) => `${s.agentCount} ${s.agentCount === 1 ? 'agent' : 'agents'} at ${clockLabel(openMin, s.startMinutesFromOpen)}`)
        .join(', '),
    });
  }
  return anyLater && lines.length > 0 ? lines : null;
}

export const START_TIME_HEADING = 'Start times this headcount needs';
export const START_TIME_REASON = 'Rostering everyone at opening would not meet the targets with this headcount.';
export const START_TIME_SPREAD_NOTE =
  'This roster splits agents evenly across start times. That is why turning the coverage floor off can give a higher headcount.';

/** True when a (non-trivial) roster splits agents as evenly as possible across 2+ start times in every category with 2+ starts. */
function isEvenSplit(dist: Record<string, { slaps: Array<{ startMinutesFromOpen: number; agentCount: number }> }>): boolean {
  let multi = false;
  for (const key of Object.keys(dist)) {
    const counts = dist[key].slaps.filter((s) => s.agentCount > 0).map((s) => s.agentCount);
    if (counts.length < 2) continue;
    multi = true;
    if (Math.max(...counts) - Math.min(...counts) > 1) return false;
  }
  return multi;
}

/** Static texts for the start-time block; null when the block is hidden. spreadNote only with the coverage floor on and an even-split roster. */
export function startTimeSplitNotes(
  dist: Record<string, { slaps: Array<{ startMinutesFromOpen: number; agentCount: number }> }> | undefined | null,
  calendar: { is24x7?: boolean; dailyOpenHour: number; dailyOpenMinute: number },
  coverageFloorOn: boolean,
): { heading: string; reason: string; spreadNote: string | null } | null {
  if (!startTimeSplitLines(dist, calendar) || !dist) return null;
  return {
    heading: START_TIME_HEADING,
    reason: START_TIME_REASON,
    spreadNote: coverageFloorOn && isEvenSplit(dist) ? START_TIME_SPREAD_NOTE : null,
  };
}
