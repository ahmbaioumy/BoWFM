/**
 * Display-only helpers for the Results screen. No engine behaviour lives here.
 */

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
