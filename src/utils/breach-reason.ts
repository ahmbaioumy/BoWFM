/**
 * Plain-language reason a case is listed as an SLA breach. One helper for the Results table, the breach CSV
 * and the search's boundary-evidence samples, so the three can never word it differently. Pure; wording only.
 *
 * A case counts as "cut by the 366-day limit" only when the run's drain was capped (`drainCapped`), the case is
 * unfinished, and its deadline lies beyond horizon end + the cap (derived - no stored per-case flag).
 */
import type { CaseRunResult, DESResult } from '../types/wfm';
import { DRAIN_CAP_MS } from './des-engine';

export const REASON_COMPLETED_LATE = 'Completed after primary deadline';
export const REASON_NOT_FINISHED = 'Not finished by end of simulation (deadline missed)';
export const REASON_CAP_CUT = 'Not finished — simulation stopped at the 366-day limit before its deadline';

type CaseLike = Pick<CaseRunResult, 'isCompleted' | 'primaryDeadline'>;
type ResultLike = Pick<DESResult, 'horizonEnd'> & { drainCapped?: boolean };

export function isCapCut(c: CaseLike, result: ResultLike): boolean {
  if (result.drainCapped !== true || c.isCompleted) return false;
  const dl = c.primaryDeadline?.getTime();
  if (typeof dl !== 'number' || !Number.isFinite(dl)) return false;
  return dl > result.horizonEnd.getTime() + DRAIN_CAP_MS;
}

export function breachReason(c: CaseLike, result: ResultLike): string {
  if (c.isCompleted) return REASON_COMPLETED_LATE;
  return isCapCut(c, result) ? REASON_CAP_CUT : REASON_NOT_FINISHED;
}
