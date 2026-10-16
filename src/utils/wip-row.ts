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
export function parseRemainingText(text: string): { value: number | undefined; invalid: boolean } {
  if (text.trim() === '') return { value: undefined, invalid: false };
  if (!/^\s*\d+([.,]\d+)?\s*$/.test(text)) return { value: undefined, invalid: true };
  const n = Number(text.trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? { value: n, invalid: false } : { value: undefined, invalid: true };
}

/** Table label: "full (35m)" when blank, "10m (in progress)" when below the category handling time, else "Nm". */
export function remainingWorkLabel(w: OpeningWIPCase, categories: ReadonlyArray<CategoryConfig>): string {
  const aht = effectiveRemainingMinutes({ ...w, remainingWorkMinutes: undefined }, categories);
  if (w.remainingWorkMinutes === undefined || w.remainingWorkMinutes === null) return `full (${aht}m)`;
  return w.remainingWorkMinutes < aht ? `${w.remainingWorkMinutes}m (in progress)` : `${w.remainingWorkMinutes}m`;
}
