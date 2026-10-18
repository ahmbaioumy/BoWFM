/**
 * The one-line staffing summary shown in the Results engine record and in the search's final progress message.
 * Shared so both read the same. Wording only.
 *
 * `primaryDrivenHC` is the headcount the search settled on while walking the primary loop; the loop's pass test
 * is ALL targets (primary SLA, answer time, occupancy, coverage), so it equals the recommendation in every
 * feasible run. It is therefore NOT "what the primary SLA alone needs" and the line must not say so. The
 * binding constraint is what names what decided the number; the primary-loop value is only repeated when it
 * differs from the recommendation.
 */
export function buildStaffingLine(p: { recommendedN: number; primaryDrivenHC: number; bindingDescription?: string | null }): string {
  const parts: string[] = [];
  if (p.primaryDrivenHC !== p.recommendedN) parts.push(`primary search result ${p.primaryDrivenHC}`);
  if (p.bindingDescription) parts.push(`binding: ${p.bindingDescription}`);
  return `Optimal Staffing: ${p.recommendedN} Operational HC${parts.length ? ` (${parts.join('; ')})` : ''}.`;
}
