/**
 * Strict number reader for cells read from uploaded files (input safety, part 1).
 *
 * Principle: read a cell when its meaning is clear, block it when it is not.
 * Pure: no clock, no environment, no side effects.
 *
 * Cleaning (as before): surrounding/inner spaces and one leading currency symbol are
 * ignored. After that the cell must be digits plus separators (and an optional leading
 * minus). Units, letters, exponents, hex are unreadable.
 *
 * Comma-delimited file: dot = decimal; a comma is accepted only as a strict thousands
 * separator (1,234 / 12,345,678, optionally followed by .dd).
 *
 * Semicolon / tab file: the convention is decided per COLUMN (see readNumberColumn).
 */

export type NumberConvention = 'dot' | 'comma';

export type CellClass =
  | { kind: 'blank' }
  | { kind: 'unreadable'; reason: string }
  /** value is certain; `proves` names the convention it proves (null = no separators). */
  | { kind: 'number'; value: number; proves: NumberConvention | null }
  /** 1.234 / 1,234 style: value depends on the column convention. */
  | { kind: 'ambiguous'; ifDot: number; ifComma: number };

/** Remove spaces and one leading currency symbol. Returns the sign separately. */
function clean(raw: string): { neg: boolean; body: string } {
  let s = String(raw ?? '').replace(/\s+/g, '');
  let neg = false;
  if (s.startsWith('-')) {
    neg = true;
    s = s.slice(1);
  }
  s = s.replace(/^[$€£¥]/, '');
  if (!neg && s.startsWith('-')) {
    neg = true;
    s = s.slice(1);
  }
  return { neg, body: s };
}

const RE_PLAIN_DOT = /^(\d+\.?\d*|\.\d+)$/;
const RE_THOUSANDS_COMMA = /^[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/;

function sign(neg: boolean, v: number): number {
  return neg ? -v : v;
}

/** Classify a single cell for a delimiter. Comma files are fully decided per cell. */
export function classifyNumberCell(raw: string, delimiter: string = ','): CellClass {
  const { neg, body } = clean(raw);
  if (body === '') return { kind: 'blank' };
  if (!/^[\d.,]+$/.test(body)) return { kind: 'unreadable', reason: 'contains characters other than digits and separators' };
  if (!/\d/.test(body)) return { kind: 'unreadable', reason: 'no digits' };

  if (delimiter === ',') {
    if (!body.includes(',')) {
      if (RE_PLAIN_DOT.test(body)) return { kind: 'number', value: sign(neg, parseFloat(body)), proves: null };
      return { kind: 'unreadable', reason: 'not a valid number (misplaced decimal point)' };
    }
    if (RE_THOUSANDS_COMMA.test(body)) {
      return { kind: 'number', value: sign(neg, parseFloat(body.replace(/,/g, ''))), proves: null };
    }
    return { kind: 'unreadable', reason: 'a comma here is neither a thousands separator nor allowed as a decimal in a comma-separated file' };
  }

  // Semicolon / tab file: decide what each cell proves.
  const hasDot = body.includes('.');
  const hasComma = body.includes(',');
  if (!hasDot && !hasComma) return { kind: 'number', value: sign(neg, parseInt(body, 10)), proves: null };

  if (hasDot && !hasComma) {
    if (/^[1-9]\d{0,2}\.\d{3}$/.test(body)) {
      return { kind: 'ambiguous', ifDot: sign(neg, parseFloat(body)), ifComma: sign(neg, parseFloat(body.replace('.', ''))) };
    }
    if (RE_PLAIN_DOT.test(body)) return { kind: 'number', value: sign(neg, parseFloat(body)), proves: 'dot' };
    if (/^[1-9]\d{0,2}(\.\d{3}){2,}$/.test(body)) {
      return { kind: 'number', value: sign(neg, parseFloat(body.replace(/\./g, ''))), proves: 'comma' };
    }
    return { kind: 'unreadable', reason: 'not a valid number (misplaced decimal point)' };
  }

  if (hasComma && !hasDot) {
    if (/^[1-9]\d{0,2},\d{3}$/.test(body)) {
      return { kind: 'ambiguous', ifDot: sign(neg, parseFloat(body.replace(',', ''))), ifComma: sign(neg, parseFloat(body.replace(',', '.'))) };
    }
    if (/^\d+,\d+$/.test(body)) {
      return { kind: 'number', value: sign(neg, parseFloat(body.replace(',', '.'))), proves: 'comma' };
    }
    if (/^[1-9]\d{0,2}(,\d{3}){2,}$/.test(body)) {
      return { kind: 'number', value: sign(neg, parseFloat(body.replace(/,/g, ''))), proves: 'dot' };
    }
    return { kind: 'unreadable', reason: 'not a valid number (misplaced comma)' };
  }

  // Both separators present: the last one is the decimal.
  if (/^[1-9]\d{0,2}(\.\d{3})+,\d+$/.test(body)) {
    return { kind: 'number', value: sign(neg, parseFloat(body.replace(/\./g, '').replace(',', '.'))), proves: 'comma' };
  }
  if (RE_THOUSANDS_COMMA.test(body)) {
    return { kind: 'number', value: sign(neg, parseFloat(body.replace(/,/g, ''))), proves: 'dot' };
  }
  return { kind: 'unreadable', reason: 'not a valid number (inconsistent separators)' };
}

export interface NumberColumnProblem {
  /** index into the input cell array */
  index: number;
  text: string;
  kind: 'unreadable' | 'ambiguous' | 'mixed';
  /** plain-language explanation, includes both readings for ambiguous cells */
  detail: string;
}

export interface NumberColumnResult {
  /** parsed value per cell; null for blank cells; 0 for unreadable/ambiguous/mixed cells */
  values: Array<number | null>;
  problems: NumberColumnProblem[];
  convention: NumberConvention | 'none' | 'mixed';
}

/** Read a whole column: the number convention is decided across the column. */
export function readNumberColumn(cells: string[], delimiter: string = ','): NumberColumnResult {
  const classes = cells.map((c) => classifyNumberCell(c, delimiter));
  let dotProofs = 0;
  let commaProofs = 0;
  for (const c of classes) {
    if (c.kind === 'number' && c.proves === 'dot') dotProofs++;
    if (c.kind === 'number' && c.proves === 'comma') commaProofs++;
  }
  const mixed = dotProofs > 0 && commaProofs > 0;
  const convention: NumberColumnResult['convention'] = mixed
    ? 'mixed'
    : dotProofs > 0
      ? 'dot'
      : commaProofs > 0
        ? 'comma'
        : 'none';

  const values: Array<number | null> = [];
  const problems: NumberColumnProblem[] = [];
  classes.forEach((c, index) => {
    const text = String(cells[index] ?? '').trim();
    if (c.kind === 'blank') {
      values.push(null);
    } else if (c.kind === 'unreadable') {
      values.push(0);
      problems.push({ index, text, kind: 'unreadable', detail: c.reason });
    } else if (c.kind === 'number') {
      if (mixed && c.proves !== null) {
        values.push(0);
        problems.push({
          index,
          text,
          kind: 'mixed',
          detail: `mixed number formats in this column: some values use a decimal comma, others a decimal point (this one reads as ${c.value})`,
        });
      } else {
        values.push(c.value);
      }
    } else if (convention === 'dot') {
      values.push(c.ifDot);
    } else if (convention === 'comma') {
      values.push(c.ifComma);
    } else {
      values.push(0);
      problems.push({
        index,
        text,
        kind: 'ambiguous',
        detail: mixed
          ? 'mixed number formats in this column, so this value cannot be read'
          : `could be ${c.ifComma} (comma as decimal) or ${c.ifDot} (dot/comma as thousands separator) and nothing else in the column settles it`,
      });
    }
  });
  return { values, problems, convention };
}
