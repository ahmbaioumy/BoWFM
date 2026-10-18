/**
 * Manual opening-backlog row helpers (DemandFlow "add a case" form).
 *
 * A blank "remaining work" means NOT STARTED: the row stores `remainingWorkMinutes: undefined` and the
 * engine (buildOpeningWipCases, validateDataQuality) then uses the CURRENT category handling time, exactly like
 * a file import without a remaining column. Only an explicit value > 0 is kept, and an explicit value below the
 * category handling time keeps in-progress priority (frozen engine rule, unchanged).
 */
import type { CategoryConfig, OpeningWIPCase } from '../types/wfm';
import { categoryKey } from './csv-parser';
import { WIP_MAX_REMAINING_MINUTES } from './wip-import';

/** Same fallback handling time the engine and the data-quality workload check use for an unknown category. */
const UNKNOWN_CATEGORY_AHT_MINUTES = 30;

/** Typed value -> stored value. Anything that is not a finite number > 0 (blank, 0, negative, NaN, text) is "not set". */
export function normalizeRemainingInput(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

export function buildManualWipCase(input: {
  id: string;
  categoryName: string;
  categories: ReadonlyArray<CategoryConfig>;
  /** Raw form value: a number, or undefined/blank/invalid for "not started". */
  remainingMinutes: unknown;
  arrival: Date;
}): OpeningWIPCase {
  const selectedCat = input.categories.find((c) => categoryKey(c.name) === categoryKey(input.categoryName));
  return {
    id: input.id,
    category: selectedCat ? selectedCat.name : input.categoryName,
    priority: selectedCat?.priority || 1,
    arrival: input.arrival,
    clockStart: input.arrival,
    remainingWorkMinutes: normalizeRemainingInput(input.remainingMinutes),
  };
}

/** Minutes the row counts for: its own remaining value, else the current category handling time. */
export function effectiveRemainingMinutes(w: OpeningWIPCase, categories: ReadonlyArray<CategoryConfig>): number {
  if (w.remainingWorkMinutes !== undefined && w.remainingWorkMinutes !== null) return Math.max(0, w.remainingWorkMinutes);
  const cat = categories.find((c) => categoryKey(c.name) === categoryKey(w.category));
  return cat?.ahtMinutes ?? UNKNOWN_CATEGORY_AHT_MINUTES;
}

export function totalPendingWorkMinutes(wip: ReadonlyArray<OpeningWIPCase>, categories: ReadonlyArray<CategoryConfig>): number {
  return wip.reduce((acc, w) => acc + effectiveRemainingMinutes(w, categories), 0);
}

/**
 * Raw typed text -> stored value. Strict decimal only (comma accepted as decimal separator).
 * Blank -> not set (not invalid). 0, negative, text, exponent, multiple dots -> not set AND invalid.
 */
export type RemainingInvalidReason = 'format' | 'thousands' | 'over_cap';

/**
 * Also rejected: a comma followed by exactly three digits ("1,000" -> reason 'thousands': read as 1.0 it would
 * silently undercount) and anything above the file-import cap WIP_MAX_REMAINING_MINUTES ('over_cap').
 * A dot is always a decimal point, so "1.000" is 1 (valid, value kept). Because that is easy to type by mistake for 1,000, a dot followed by
 * exactly three digits (integer part 1-3 digits, no leading 0: "1.000", "2.500", "999.999") returns a non-blocking `hint` naming the digits
 * without the dot. "0.125", "12.5", "1000.000" get no hint. Invalid rows are still added at full handling time.
 */
export function parseRemainingText(text: string): { value: number | undefined; invalid: boolean; reason?: RemainingInvalidReason; hint?: string } {
  if (text.trim() === '') return { value: undefined, invalid: false };
  if (!/^\s*\d+([.,]\d+)?\s*$/.test(text)) return { value: undefined, invalid: true, reason: 'format' };
  if (/^\s*\d+,\d{3}\s*$/.test(text)) return { value: undefined, invalid: true, reason: 'thousands' };
  const n = Number(text.trim().replace(',', '.'));
  if (!(Number.isFinite(n) && n > 0)) return { value: undefined, invalid: true, reason: 'format' };
  if (n > WIP_MAX_REMAINING_MINUTES) return { value: undefined, invalid: true, reason: 'over_cap' };
  if (/^\s*[1-9]\d{0,2}\.\d{3}\s*$/.test(text)) {
    return { value: n, invalid: false, hint: `Did you mean ${text.trim().replace('.', '')}? A dot is read as a decimal point.` };
  }
  return { value: n, invalid: false };
}

/** Table label: "full (35m)" when blank, "10m (in progress)" when below the category handling time, else "Nm". */
export function remainingWorkLabel(w: OpeningWIPCase, categories: ReadonlyArray<CategoryConfig>): string {
  const aht = effectiveRemainingMinutes({ ...w, remainingWorkMinutes: undefined }, categories);
  if (w.remainingWorkMinutes === undefined || w.remainingWorkMinutes === null) return `full (${aht}m)`;
  return w.remainingWorkMinutes < aht ? `${w.remainingWorkMinutes}m (in progress)` : `${w.remainingWorkMinutes}m`;
}
