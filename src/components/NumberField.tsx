/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { commitNumberDraft, draftIsCommittable } from '../utils/number-input';

type PassThrough = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value' | 'defaultValue' | 'onChange' | 'type' | 'min' | 'max' | 'step'
>;

export interface NumberFieldProps extends PassThrough {
  /** Stored value, already in DISPLAY units (callers convert fractions to percent). */
  value: number;
  /** Called with a finite, in-range number (display units). Never NaN. */
  onCommit: (n: number) => void;
  min?: number;
  max?: number;
  integer?: boolean;
  step?: number;
  /** Committed when the field is left empty (default: keep the stored value). */
  emptyValue?: number;
}

function format(n: number): string {
  // Strip float noise (0.1 + 0.2 style) without losing real decimals.
  return Number.isFinite(n) ? String(Number(n.toFixed(10))) : '';
}

/**
 * Number input that keeps what is typed. The text is held as a local draft; a draft that is
 * already a valid value is stored at once (so "8","5" in a 50-100 field stores 85, never 50
 * after the first key). Anything else (empty, partial, out of range) is resolved on blur,
 * Enter or unmount through commitNumberDraft: clamped, or the stored value when unparseable.
 * Escape restores the stored value.
 */
export function NumberField({
  value,
  onCommit,
  min,
  max,
  integer,
  step,
  emptyValue,
  disabled,
  onBlur,
  onFocus,
  onKeyDown,
  ...rest
}: NumberFieldProps) {
  const [draft, setDraft] = React.useState<string>(() => format(value));
  const [syncTick, setSyncTick] = React.useState(0);

  // Latest values for handlers and the unmount cleanup (which would otherwise see stale props).
  const draftRef = React.useRef(draft);
  const valueRef = React.useRef(value);
  const onCommitRef = React.useRef(onCommit);
  const rangeRef = React.useRef({ min, max, integer });
  const emptyRef = React.useRef(emptyValue);
  const dirtyRef = React.useRef(false); // user typed since the last sync
  const focusedRef = React.useRef(false);
  const lastCommittedRef = React.useRef<number | null>(null);
  draftRef.current = draft;
  valueRef.current = value;
  onCommitRef.current = onCommit;
  rangeRef.current = { min, max, integer };
  emptyRef.current = emptyValue;

  // Re-sync from outside (import, toggle, sample load, parent normalisation). While the field is
  // focused, a value that equals what this field just committed is left alone so typing is not
  // rewritten under the cursor.
  React.useEffect(() => {
    if (!focusedRef.current || value !== lastCommittedRef.current) {
      setDraft(format(value));
      dirtyRef.current = false;
    }
  }, [value, syncTick]);

  // Unmount: a pending (possibly out-of-range) draft is committed, not lost.
  React.useEffect(() => {
    return () => {
      if (!dirtyRef.current) return;
      const n = resolveDraft();
      if (Number.isFinite(n) && n !== valueRef.current) onCommitRef.current(n);
    };
  }, []);

  // What a blur / Enter / unmount stores for the current draft.
  function resolveDraft(): number {
    const fallback = draftRef.current.trim() === '' && emptyRef.current !== undefined ? emptyRef.current : valueRef.current;
    return commitNumberDraft(draftRef.current, { ...rangeRef.current, fallback });
  }

  function resync() {
    lastCommittedRef.current = null;
    dirtyRef.current = false;
    setSyncTick((t) => t + 1);
  }

  function commitPending() {
    const n = resolveDraft();
    if (dirtyRef.current && Number.isFinite(n) && n !== valueRef.current) {
      lastCommittedRef.current = n;
      onCommitRef.current(n);
    }
    setDraft(format(n));
    resync();
  }

  return (
    <input
      {...rest}
      type="number"
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      value={draft}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        draftRef.current = text;
        dirtyRef.current = true;
        if (draftIsCommittable(text, rangeRef.current)) {
          const n = Number(text);
          if (n !== valueRef.current) {
            lastCommittedRef.current = n;
            onCommitRef.current(n);
          }
        }
      }}
      onFocus={(e) => {
        focusedRef.current = true;
        onFocus?.(e);
      }}
      onBlur={(e) => {
        focusedRef.current = false;
        commitPending();
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commitPending();
        } else if (e.key === 'Escape') {
          setDraft(format(valueRef.current));
          resync();
        }
        onKeyDown?.(e);
      }}
    />
  );
}
