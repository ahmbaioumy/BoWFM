/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure helpers behind <NumberField>: what a typed draft means, when it can be stored at once,
 * and what a blur / Enter / unmount commits. No React, no clamping per keystroke: a draft such
 * as "8" (the first key of "85" in a 50-100 field) is held, not stored as 50.
 */

export interface NumberDraftRange {
  /** Inclusive lower bound. Omit for no lower bound. */
  min?: number;
  /** Inclusive upper bound. Omit for no upper bound. */
  max?: number;
  /** Whole numbers only (a fractional draft is rounded with Math.round when committed). */
  integer?: boolean;
}

export interface NumberCommitOptions extends NumberDraftRange {
  /** Returned when the draft is empty or unparseable: the CURRENT stored value, never a default. */
  fallback: number;
}

// Plain decimal / exponent notation only. Rejects '', '-', '1e', 'abc', 'Infinity', '0x10'.
const DRAFT_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/** Parse a typed draft; NaN when it is empty, partial or not a finite number. */
function parseDraft(draft: string): number {
  const t = draft.trim();
  if (!DRAFT_RE.test(t)) return NaN;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

function clamp(n: number, min: number | undefined, max: number | undefined): number {
  const lo = min ?? -Infinity;
  const hi = max ?? Infinity;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * True when the draft already is a valid value for the field (finite, inside [min, max],
 * whole when `integer`). Such a draft is stored immediately; anything else waits for
 * blur / Enter / unmount.
 */
export function draftIsCommittable(draft: string, opts: NumberDraftRange): boolean {
  const n = parseDraft(draft);
  if (Number.isNaN(n)) return false;
  if (opts.integer && !Number.isInteger(n)) return false;
  if (opts.min !== undefined && n < opts.min) return false;
  if (opts.max !== undefined && n > opts.max) return false;
  return true;
}

/**
 * The value a blur / Enter / unmount stores: the parsed draft, rounded when `integer`, then
 * clamped into [min, max]. Empty or unparseable drafts return `fallback` (the stored value).
 */
export function commitNumberDraft(draft: string, opts: NumberCommitOptions): number {
  const n = parseDraft(draft);
  if (Number.isNaN(n)) return opts.fallback;
  const r = opts.integer ? Math.round(n) : n;
  return clamp(r, opts.min, opts.max);
}

/** Stored fraction (0.925) -> percent shown to one decimal (92.5), without float noise. */
export function fractionToPercentDisplay(fraction: number): number {
  return Math.round(fraction * 1000) / 10;
}

/** Percent typed (92.5) -> stored fraction (0.925), kept to one decimal of a percent. */
export function percentDisplayToFraction(percent: number): number {
  return Math.round(percent * 10) / 1000;
}
