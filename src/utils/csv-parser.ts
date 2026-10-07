/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CalendarConfig,
  CategoryConfig,
  ColumnMapping,
  DQIssue,
  DQResult,
  LaborConfig,
  OpeningWIPCase,
  OperatingHoursBreakdown,
  SLAPolicyConfig,
  StandardInterval,
} from '../types/wfm';
import {
  computeIntervalHorizon,
  convertDurationToMinutes,
  formatDate24,
  formatDateTime24,
  getCalendarWorkingDaysInHorizon,
  getDailyWindowLengthHours,
  isWorking,
  isWorkingDay,
} from './calendar';
import { buildOpeningWipCases } from './des-engine';
import { readNumberColumn } from './number-cell';

/** One finding about a file picked for upload. Errors refuse the file; warnings travel with it. */
export interface CSVProblem {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

const MAX_ROWS_NAMED = 5;

function nameRows(lines: number[]): string {
  const shown = lines.slice(0, MAX_ROWS_NAMED).join(', ');
  return lines.length > MAX_ROWS_NAMED ? `${shown}, …` : shown;
}

/**
 * Pipe is chosen only when the first line that carries any delimiter (looking at up to the first 6
 * non-blank lines) has pipes and none of comma / semicolon / tab, so a file that has a comma,
 * semicolon or tab on that line keeps the delimiter it always had (the one exception: a first line that contains only `|` now selects pipe).
 */
function firstDelimiterLineIsPipe(text: string): boolean {
  let inQ = false;
  let c = 0;
  let s = 0;
  let t = 0;
  let p = 0;
  let linesSeen = 0;
  const endOfLine = (): boolean | null => {
    if (c + s + t + p > 0) return p > 0 && c + s + t === 0;
    c = s = t = p = 0;
    linesSeen++;
    return linesSeen >= 6 ? false : null;
  };
  const limit = Math.min(text.length, 4096);
  for (let i = 0; i < limit; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQ && text[i + 1] === '"') i++;
      else inQ = !inQ;
    } else if (!inQ) {
      if (ch === ',') c++;
      else if (ch === ';') s++;
      else if (ch === '\t') t++;
      else if (ch === '|') p++;
      else if (ch === '\n' || ch === '\r') {
        const r = endOfLine();
        if (r !== null) return r;
      }
    }
  }
  return c + s + t + p > 0 ? p > 0 && c + s + t === 0 : false;
}

export function parseCSVRaw(text: string): {
  headers: string[];
  rows: Record<string, string>[];
  delimiter: string;
  problems: CSVProblem[];
} {
  const fail = (code: string, message: string, delimiter = ','): ReturnType<typeof parseCSVRaw> => ({
    headers: [],
    rows: [],
    delimiter,
    problems: [{ severity: 'error', code, message }],
  });

  // E1 not readable text (NUL characters, or the "PK" signature of an Excel workbook / zip file)
  if (text && (text.includes('\u0000') || text.startsWith('PK\u0003\u0004'))) {
    return fail(
      'E1',
      'This is not a readable text file. It looks like an Excel workbook or a file saved in an unusual encoding. In Excel use Save As → CSV UTF-8, then upload that file.'
    );
  }
  // E2 empty
  if (!text || !text.trim()) return fail('E2', 'The file is empty.');

  // 1. Delimiter detection (, or ; or \t) by analyzing unquoted delimiters
  let delimiter = ',';
  let commaCount = 0;
  let semiCount = 0;
  let tabCount = 0;
  let inQ = false;

  for (let i = 0; i < Math.min(text.length, 4096); i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQ && text[i + 1] === '"') {
        i++; // skip escaped quote
      } else {
        inQ = !inQ;
      }
    } else if (!inQ) {
      if (ch === ',') commaCount++;
      else if (ch === ';') semiCount++;
      else if (ch === '\t') tabCount++;
      else if (ch === '\n' || ch === '\r') {
        if (commaCount > 0 || semiCount > 0 || tabCount > 0) {
          break;
        }
      }
    }
  }

  if (tabCount > commaCount && tabCount > semiCount) {
    delimiter = '\t';
  } else if (semiCount > commaCount && semiCount > tabCount) {
    delimiter = ';';
  } else {
    delimiter = ',';
  }
  // Fourth candidate, lowest priority: only when the first line carrying any separator has pipes and no comma/semicolon/tab
  // (decimal commas in later data rows must not turn a pipe file into a one-column comma file).
  if (firstDelimiterLineIsPipe(text)) {
    delimiter = '|';
  }

  // 2. Tokenize into 2D records using character-by-character RFC 4180 state machine.
  // `line` is the 1-based physical line of the file (blank lines and lines inside quoted cells count).
  const records: { cells: string[]; line: number }[] = [];
  let currentRecord: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let quoteOpenLine = 1;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < len && text[i + 1] === '"') {
          // Escaped quote: "" -> "
          currentField += '"';
          i += 2;
          continue;
        } else {
          // Closing quote
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        // All characters inside quotes (including \r, \n, delimiter, apostrophes) are preserved
        if (char === '\r') {
          if (!(i + 1 < len && text[i + 1] === '\n')) line++;
        } else if (char === '\n') {
          line++;
        }
        currentField += char;
        i++;
        continue;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        quoteOpenLine = line;
        i++;
        continue;
      } else if (char === delimiter) {
        currentRecord.push(currentField);
        currentField = '';
        i++;
        continue;
      } else if (char === '\r') {
        if (i + 1 < len && text[i + 1] === '\n') {
          i++;
        }
        currentRecord.push(currentField);
        currentField = '';
        records.push({ cells: currentRecord, line: recordLine });
        currentRecord = [];
        line++;
        recordLine = line;
        i++;
        continue;
      } else if (char === '\n') {
        currentRecord.push(currentField);
        currentField = '';
        records.push({ cells: currentRecord, line: recordLine });
        currentRecord = [];
        line++;
        recordLine = line;
        i++;
        continue;
      } else {
        currentField += char;
        i++;
        continue;
      }
    }
  }

  // Push trailing field/record
  if (currentField.length > 0 || currentRecord.length > 0) {
    currentRecord.push(currentField);
    records.push({ cells: currentRecord, line: recordLine });
  }

  // 3. Filter out empty rows safely (rows where all cells are empty/whitespace)
  const clean = records.filter((rec) => rec.cells.some((cell) => cell.trim().length > 0));

  if (clean.length === 0) return fail('E2', 'The file is empty.', delimiter);

  const nonEmptyCount = (cells: string[]) => cells.filter((c) => c.trim().length > 0).length;
  const rawHeaders = clean[0].cells;
  const dataRecords = clean.slice(1);

  // --- Errors, in precedence order E3 > E7 > E6 > E4 > E5 (E1, E2 handled above) ---
  const err = (code: string, message: string) => fail(code, message, delimiter);

  if (dataRecords.length === 0) {
    return err('E3', 'The file has column headers but no data rows.');
  }
  if (
    nonEmptyCount(rawHeaders) === 1 &&
    nonEmptyCount(dataRecords[0].cells) >= 2 &&
    (dataRecords.length < 2 || nonEmptyCount(dataRecords[1].cells) >= 2)
  ) {
    return err(
      'E7',
      `The first row (file row ${clean[0].line}) looks like a title, not column headers. Remove the row(s) above the header and upload again.`
    );
  }
  if (rawHeaders.length === 1 && dataRecords.length >= 2) {
    let other = false;
    let q = false;
    for (let k = 0; k < len && !other; k++) {
      const ch = text[k];
      if (ch === '"') {
        if (q && text[k + 1] === '"') k++;
        else q = !q;
      } else if (!q && (ch === ',' || ch === ';' || ch === '\t' || ch === '|') && ch !== delimiter) {
        other = true;
      }
    }
    if (other) {
      return err(
        'E6',
        'Only one column was found. Columns must be separated by comma, semicolon, tab or |. If there is a title row above the header, remove it.'
      );
    }
  }
  if (inQuotes) {
    return err(
      'E4',
      `A quotation mark opened on file row ${quoteOpenLine} is never closed, so the rest of the file cannot be read reliably. Close or remove the quote on that row.`
    );
  }
  const moreRows: { line: number; found: number }[] = [];
  for (const rec of dataRecords) {
    if (rec.cells.length > rawHeaders.length) {
      let lastNonEmpty = -1;
      rec.cells.forEach((c, idx) => {
        if (c.trim().length > 0) lastNonEmpty = idx;
      });
      if (lastNonEmpty + 1 > rawHeaders.length) moreRows.push({ line: rec.line, found: lastNonEmpty + 1 });
    }
  }
  if (moreRows.length > 0) {
    return err(
      'E5',
      `${moreRows.length} row(s) have more columns than the header (file rows ${nameRows(moreRows.map((r) => r.line))}; expected ${rawHeaders.length}, found ${moreRows[0].found} on row ${moreRows[0].line}). A delimiter is extra on those rows, or there is a title row above the header.`
    );
  }

  // --- Headers (duplicates renamed, nothing overwritten) and rows ---
  const problems: CSVProblem[] = [];
  const baseNames = rawHeaders.map((h, colIdx) => h.trim() || `Column_${colIdx + 1}`);
  const used = new Set(baseNames);
  const seen = new Map<string, number>();
  const dupNames: string[] = [];
  const headers = baseNames.map((name) => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (n === 1) return name;
    if (!dupNames.includes(name)) dupNames.push(name);
    let k = n;
    let candidate = `${name} (${k})`;
    while (used.has(candidate)) {
      k++;
      candidate = `${name} (${k})`;
    }
    used.add(candidate);
    return candidate;
  });

  const rows: Record<string, string>[] = [];
  const shortLines: number[] = [];
  let lastNamedHeader = -1;
  rawHeaders.forEach((h, idx) => {
    if (h.trim().length > 0) lastNamedHeader = idx;
  });
  for (const rec of dataRecords) {
    const rowCells = rec.cells;
    if (rowCells.length < lastNamedHeader + 1) shortLines.push(rec.line);
    const rowObj: Record<string, string> = {};
    headers.forEach((h, colIdx) => {
      rowObj[h] = rowCells[colIdx] !== undefined ? rowCells[colIdx] : '';
    });
    rows.push(rowObj);
  }

  if (shortLines.length > 0) {
    problems.push({
      severity: 'warning',
      code: 'W1',
      message: `${shortLines.length} row(s) have fewer columns than the header (file rows ${nameRows(shortLines)}); the missing cells were read as empty. Check those rows (missing delimiter, footer or total line).`,
    });
  }
  if (dupNames.length > 0) {
    problems.push({
      severity: 'warning',
      code: 'W2',
      message: `Some columns have the same name (${dupNames.map((n) => `"${n}"`).join(', ')}); the later ones were renamed "${dupNames[0]} (2)" and so on. Check the column mapping.`,
    });
  }
  if (text.includes('�')) {
    problems.push({
      severity: 'warning',
      code: 'W3',
      message:
        'Some characters could not be read (the file is not saved as UTF-8). Names may look wrong; numbers and dates are not affected.',
    });
  }

  return { headers, rows, delimiter, problems };
}

/** Required columns that are not mapped yet, named as the mapping screen shows them (empty = all set). */
export function missingRequiredMappings(mapping: ColumnMapping): string[] {
  const missing: string[] = [];
  if (!mapping.intervalStartCol) missing.push('Date / Day');
  if (!mapping.volumeCol) missing.push('Volume');
  return missing;
}

export function autoSuggestColumnMapping(
  headers: string[],
  sampleRows: Record<string, string>[] = []
): ColumnMapping {
  const mapping: ColumnMapping = {
    intervalStartCol: '',
    timeCol: '',
    volumeCol: '',
    categoryCol: '',
    intervalEndCol: '',
  };

  const lowerHeaders = headers.map((h) => ({
    original: h,
    lower: h.toLowerCase().replace(/[^a-z0-9]/g, ''),
  }));

  // 1. First pass: look for separate Date, Interval/Time, Vol, and Categ/Seg columns by header name
  for (const h of lowerHeaders) {
    if (!mapping.intervalStartCol) {
      if (
        h.lower === 'date' ||
        h.lower === 'day' ||
        h.lower === 'fctdate' ||
        h.lower === 'startdate' ||
        h.lower === 'datetime' ||
        h.lower === 'timestamp' ||
        h.lower === 'starttimestamp' ||
        h.lower === 'intervaldate' ||
        h.lower === 'calldate' ||
        h.lower.startsWith('date')
      ) {
        mapping.intervalStartCol = h.original;
      }
    }

    if (!mapping.timeCol) {
      if (
        h.lower === 'int' ||
        h.lower === 'interval' ||
        h.lower === 'intervals' ||
        h.lower === 'time' ||
        h.lower === 'intervaltime' ||
        h.lower === 'starttime' ||
        h.lower === 'start_time' ||
        h.lower === 'slot' ||
        h.lower === 'slots' ||
        h.lower === 'timeinterval' ||
        h.lower === 'hhmm' ||
        h.lower === 'intervalslot' ||
        h.lower === 'timeslot' ||
        h.lower === 'tod' ||
        h.lower === 'period' ||
        h.lower === 'bucket' ||
        h.lower === 'halfhour'
      ) {
        mapping.timeCol = h.original;
      }
    }

    if (!mapping.volumeCol) {
      if (
        h.lower.includes('offered') ||
        h.lower.includes('vol') ||
        h.lower.includes('volume') ||
        h.lower.includes('count') ||
        h.lower.includes('demand') ||
        h.lower.includes('cases') ||
        h.lower.includes('inflow') ||
        h.lower.includes('forecast') ||
        h.lower.includes('fct') ||
        h.lower.includes('actual') ||
        h.lower.includes('calls') ||
        h.lower.includes('contacts') ||
        h.lower.includes('items') ||
        h.lower.includes('arrived') ||
        h.lower.includes('received') ||
        h.lower.includes('transactions') ||
        h.lower.includes('workload') ||
        h.lower.includes('tickets') ||
        h.lower.includes('interactions') ||
        h.lower.includes('incoming')
      ) {
        mapping.volumeCol = h.original;
      }
    }

    if (!mapping.categoryCol) {
      if (
        h.lower === 'seg' ||
        h.lower === 'segment' ||
        h.lower.includes('categ') ||
        h.lower.includes('category') ||
        h.lower.includes('seg') ||
        h.lower.includes('segment') ||
        h.lower.includes('queue') ||
        h.lower.includes('skill') ||
        h.lower.includes('type') ||
        h.lower.includes('worktype') ||
        h.lower.includes('stream') ||
        h.lower.includes('channel') ||
        h.lower.includes('lob') ||
        h.lower.includes('group') ||
        h.lower.includes('flow') ||
        h.lower.includes('service') ||
        h.lower.includes('department')
      ) {
        mapping.categoryCol = h.original;
      }
    }
  }

  // 2. Data Inspection Pass (if sampleRows provided): infer timeCol / dateCol from values if missing
  if (sampleRows && sampleRows.length > 0) {
    const firstRow = sampleRows[0];

    for (const h of headers) {
      const val = String(firstRow[h] || '').trim();

      // Check if value is a pure Time pattern (e.g. "00:00", "00:30", "14:30", "2:30 PM")
      if (!mapping.timeCol && /^\d{1,2}:\d{2}(:\d{2})?(\s*(AM|PM))?$/i.test(val)) {
        mapping.timeCol = h;
      }

      // Check if value is a pure Date pattern (e.g. "01/10/2026", "2026-10-01", "10-01-2026")
      if (!mapping.intervalStartCol && /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(val)) {
        mapping.intervalStartCol = h;
      }
    }
  }

  // 3. Secondary fallback pass for Start Col if not detected
  if (!mapping.intervalStartCol) {
    for (const h of lowerHeaders) {
      if (
        h.lower.includes('start') ||
        h.lower.includes('time') ||
        h.lower.includes('date') ||
        h.lower.includes('interval')
      ) {
        mapping.intervalStartCol = h.original;
        break;
      }
    }
  }

  // Fallbacks if still not detected
  if (!mapping.intervalStartCol && headers.length > 0) mapping.intervalStartCol = headers[0];
  if (!mapping.volumeCol) {
    const avail = headers.find(
      (h) =>
        h !== mapping.intervalStartCol &&
        h !== mapping.timeCol &&
        h !== mapping.categoryCol
    );
    mapping.volumeCol = avail || (headers.length > 1 ? headers[1] : '');
  }

  return mapping;
}

/**
 * Strict calendar date validation helpers:
 * Rejects impossible dates (e.g., 31/02/2026, 31/04/2026) and invalid leap-year dates (e.g., 29/02/2025).
 * Prevents JavaScript Date constructor from silently normalizing invalid day/month combinations.
 */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

function getDaysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) return 0;
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

function validateAndCreateDate(
  year: number,
  month: number,
  day: number,
  hours: number = 0,
  minutes: number = 0,
  seconds: number = 0
): Date {
  if (
    isNaN(year) ||
    isNaN(month) ||
    isNaN(day) ||
    isNaN(hours) ||
    isNaN(minutes) ||
    isNaN(seconds)
  ) {
    return new Date(NaN);
  }

  if (year < 1000 || year > 9999) return new Date(NaN);
  if (month < 1 || month > 12) return new Date(NaN);
  if (hours < 0 || hours > 23) return new Date(NaN);
  if (minutes < 0 || minutes > 59) return new Date(NaN);
  if (seconds < 0 || seconds > 59) return new Date(NaN);

  const maxDays = getDaysInMonth(year, month);
  if (day < 1 || day > maxDays) {
    return new Date(NaN);
  }

  const d = new Date(year, month - 1, day, hours, minutes, seconds, 0);
  if (
    isNaN(d.getTime()) ||
    d.getFullYear() !== year ||
    d.getMonth() + 1 !== month ||
    d.getDate() !== day ||
    d.getHours() !== hours ||
    d.getMinutes() !== minutes ||
    d.getSeconds() !== seconds
  ) {
    return new Date(NaN);
  }

  return d;
}

/** The single ISO-8601 pattern shared by the parser and the timezone-marker detector. */
const ISO_DATE_RE =
  /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:(Z)|([+-]\d{2}(?::?\d{2})?))?)?$/i;

/**
 * Reports whether a timestamp text carries a timezone marker, using the same rules as
 * parseFlexibleDate: 'Z', a numeric offset as written ('+04:00'), or 'epoch' for a numeric
 * Unix timestamp. Returns null when the text is read as written. Pure; parsing is unchanged.
 */
export function detectTimezoneMarker(dateStr: string | undefined, timeStr?: string): string | null {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const trimmedDate = dateStr.trim();
  if (!trimmedDate) return null;
  const hasTime = !!(timeStr && typeof timeStr === 'string' && timeStr.trim());
  if (/^\d{9,14}$/.test(trimmedDate) && !hasTime) return 'epoch';
  const fullStr = hasTime ? `${trimmedDate} ${(timeStr as string).trim()}` : trimmedDate;
  const m = fullStr.match(ISO_DATE_RE);
  if (!m) return null;
  if (m[7]) return 'Z';
  if (m[8]) return m[8];
  return null;
}

/** Name comparison key: trimmed, inner whitespace collapsed, lower-case. */
export function categoryKey(name: string): string {
  return String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Robust and strict date/time parser that handles:
 * - Separate date & time strings (e.g. date: "01/10/2026", time: "00:30")
 * - Combined strings: "01/10/2026 00:30", "2026-10-01T00:30:00Z"
 * - DD/MM/YYYY only for slash/dot delimited dates (MM/DD/YYYY is strictly rejected), YYYY-MM-DD, YYYY/MM/DD
 * - 12h & 24h times ("00:30", "14:45", "2:30 PM", "12:00 AM")
 * - Unix timestamps (seconds or milliseconds)
 * - Explicitly rejects impossible calendar dates without silent JS normalization.
 */
export function parseFlexibleDate(dateStr: string, timeStr?: string): Date {
  if (!dateStr || typeof dateStr !== 'string') return new Date(NaN);
  const trimmedDate = dateStr.trim();
  if (!trimmedDate) return new Date(NaN);

  let fullStr = trimmedDate;
  if (timeStr && typeof timeStr === 'string' && timeStr.trim()) {
    fullStr = `${trimmedDate} ${timeStr.trim()}`;
  }

  // 1. Check for Unix timestamps (digits only with 9+ chars, without date separators)
  if (/^\d{9,14}$/.test(trimmedDate) && !timeStr) {
    const numeric = Number(trimmedDate);
    const epochMs = numeric > 10000000000 ? numeric : numeric * 1000;
    const epochDate = new Date(epochMs);
    if (!isNaN(epochDate.getTime())) return epochDate;
  }

  // 2. Strict ISO 8601 regex pattern (e.g. 2026-10-01T00:30:00.000Z or 2026-10-01 00:30:00)
  const isoMatch = fullStr.match(ISO_DATE_RE);
  if (isoMatch) {
    const y = parseInt(isoMatch[1], 10);
    const mo = parseInt(isoMatch[2], 10);
    const d = parseInt(isoMatch[3], 10);
    const h = isoMatch[4] ? parseInt(isoMatch[4], 10) : 0;
    const mi = isoMatch[5] ? parseInt(isoMatch[5], 10) : 0;
    const s = isoMatch[6] ? parseInt(isoMatch[6], 10) : 0;
    const isUtc = !!isoMatch[7];
    const offsetStr = isoMatch[8];

    const maxDays = getDaysInMonth(y, mo);
    if (mo < 1 || mo > 12 || d < 1 || d > maxDays || h < 0 || h > 23 || mi < 0 || mi > 59 || s < 0 || s > 59) {
      return new Date(NaN);
    }

    if (isUtc) {
      const utcDate = new Date(Date.UTC(y, mo - 1, d, h, mi, s, 0));
      if (
        !isNaN(utcDate.getTime()) &&
        utcDate.getUTCFullYear() === y &&
        utcDate.getUTCMonth() + 1 === mo &&
        utcDate.getUTCDate() === d &&
        utcDate.getUTCHours() === h &&
        utcDate.getUTCMinutes() === mi
      ) {
        return utcDate;
      }
      return new Date(NaN);
    }

    if (offsetStr) {
      const parsedOffsetDate = new Date(fullStr);
      if (!isNaN(parsedOffsetDate.getTime())) {
        return parsedOffsetDate;
      }
    }

    return validateAndCreateDate(y, mo, d, h, mi, s);
  }

  // 3. Extract time components (HH:mm[:ss] [AM|PM])
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  let datePartStr = fullStr;

  const timeRegex = /(?:[T ]|^)(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM|am|pm))?/i;
  const timeMatch = fullStr.match(timeRegex);

  if (timeMatch) {
    let h = parseInt(timeMatch[1], 10);
    const m = parseInt(timeMatch[2], 10);
    const s = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
    const ampm = timeMatch[4] ? timeMatch[4].toUpperCase() : null;

    if (ampm) {
      if (h < 1 || h > 12) return new Date(NaN);
      if (ampm === 'PM' && h < 12) h += 12;
      if (ampm === 'AM' && h === 12) h = 0;
    } else {
      if (h < 0 || h > 23) return new Date(NaN);
    }

    if (m < 0 || m > 59 || s < 0 || s > 59) return new Date(NaN);

    hours = h;
    minutes = m;
    seconds = s;

    datePartStr = fullStr.replace(timeMatch[0], '').trim();
  }

  if (!datePartStr && trimmedDate) {
    datePartStr = trimmedDate.split(/[T ]/)[0];
  }

  // 4. Parse date tokens from datePartStr
  const dateTokens = datePartStr.split(/[^0-9]+/).filter((t) => t.length > 0);

  if (dateTokens.length >= 3) {
    const p0 = parseInt(dateTokens[0], 10);
    const p1 = parseInt(dateTokens[1], 10);
    const p2 = parseInt(dateTokens[2], 10);

    if (!isNaN(p0) && !isNaN(p1) && !isNaN(p2)) {
      let year = p2;
      let month = p1;
      let day = p0;

      // Case A: YYYY-MM-DD or YYYY/MM/DD
      if (p0 > 1000) {
        year = p0;
        month = p1;
        day = p2;
      }
      // Case B: 4-digit Year at end (p2 > 1000) -> DD/MM/YYYY only
      else if (p2 > 1000) {
        year = p2;
        day = p0;
        month = p1;
      }
      // Case C: 2-digit year at end (e.g. 01/10/26) -> DD/MM/YY only
      else if (p2 < 100) {
        year = p2 >= 70 ? 1900 + p2 : 2000 + p2;
        day = p0;
        month = p1;
      }

      return validateAndCreateDate(year, month, day, hours, minutes, seconds);
    }
  }

  return new Date(NaN);
}

/**
 * Sequential Opening WIP ID generator:
 * Generates the next unused ID in the format WIP-0001, WIP-0002, etc.
 * Guarantees zero duplicate IDs even after deleting cases.
 */
export function generateNextWIPId(existingWIP: OpeningWIPCase[]): string {
  let maxId = 0;
  for (const wip of existingWIP) {
    const match = (wip.id || '').match(/WIP-(\d+)/i);
    if (match) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num) && num > maxId) {
        maxId = num;
      }
    }
  }

  let nextNum = maxId + 1;
  let candidate = `WIP-${String(nextNum).padStart(4, '0')}`;
  const existingSet = new Set(existingWIP.map((w) => w.id));
  while (existingSet.has(candidate)) {
    nextNum++;
    candidate = `WIP-${String(nextNum).padStart(4, '0')}`;
  }
  return candidate;
}

export function mapRawRecordsToIntervals(
  rawRows: Record<string, string>[],
  mapping: ColumnMapping,
  defaultCategoryName: string = 'General',
  delimiter: string = ','
): StandardInterval[] {
  const intervals: StandardInterval[] = [];

  // Volume column is read as a whole: for semicolon/tab files the decimal convention
  // (comma or dot) is decided per column (see number-cell.ts).
  const volumeColumn = readNumberColumn(
    rawRows.map((r) => String(r[mapping.volumeCol] ?? '')),
    delimiter
  );
  const volumeProblems = new Map(volumeColumn.problems.map((p) => [p.index, p]));

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    const dateStr = row[mapping.intervalStartCol];
    let timeStr = mapping.timeCol ? row[mapping.timeCol] : undefined;

    // Automatic fallback: If time column wasn't explicitly mapped, check if dateStr lacks a time (no ':')
    // and see if the row contains a column with time values or time-like headers
    if (!timeStr && dateStr && !dateStr.includes(':')) {
      for (const [k, v] of Object.entries(row)) {
        if (k === mapping.intervalStartCol || k === mapping.volumeCol || k === mapping.categoryCol) continue;
        const val = String(v || '').trim();
        const lk = k.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (
          lk === 'int' ||
          lk === 'time' ||
          lk === 'interval' ||
          lk === 'intervals' ||
          lk === 'starttime' ||
          lk === 'start_time' ||
          lk === 'slot' ||
          lk === 'slots' ||
          lk === 'hhmm' ||
          lk === 'tod' ||
          /^\d{1,2}:\d{2}(:\d{2})?(\s*(AM|PM))?$/i.test(val)
        ) {
          timeStr = val;
          break;
        }
      }
    }

    const volStr = row[mapping.volumeCol];
    const catStr =
      mapping.categoryCol && row[mapping.categoryCol]
        ? row[mapping.categoryCol].trim().replace(/\s+/g, ' ')
        : defaultCategoryName;

    const startDate = parseFlexibleDate(dateStr, timeStr);
    const markers: string[] = [];
    const startMarker = detectTimezoneMarker(dateStr, timeStr);
    if (startMarker) markers.push(startMarker);

    // Parse volume strictly: clear values are read, unclear ones are blocked (stored as 0).
    let volume = 0;
    let volumeParsingIssue: string | null = null;
    if (volStr) {
      const problem = volumeProblems.get(i);
      const parsed = volumeColumn.values[i];
      if (problem) {
        volumeParsingIssue = `${problem.kind}:row ${i + 2}: "${problem.text}" — ${problem.detail}`;
        volume = 0;
      } else if (parsed !== null && parsed !== undefined) {
        if (parsed < 0) {
          volumeParsingIssue = `Negative volume ${volStr} (interpreted as ${parsed}) — must be non-negative`;
          volume = 0;
        } else {
          volume = parsed;
        }
      }
    }

    let endDate: Date;
    if (mapping.intervalEndCol && row[mapping.intervalEndCol]) {
      endDate = parseFlexibleDate(row[mapping.intervalEndCol]);
      const endMarker = detectTimezoneMarker(row[mapping.intervalEndCol]);
      if (endMarker && !markers.includes(endMarker)) markers.push(endMarker);
    } else {
      endDate = isNaN(startDate.getTime())
        ? new Date(NaN)
        : new Date(startDate.getTime() + 30 * 60 * 1000); // 30 mins default
    }

    intervals.push({
      intervalIndex: i,
      start: startDate,
      end: endDate,
      volume,
      category: catStr || defaultCategoryName,
      ...(volumeParsingIssue ? { volumeParsingIssue } : {}),
      ...(markers.length > 0 ? { timezoneMarkers: markers } : {}),
    });
  }

  // Category spellings that differ only by letter case or spacing become ONE category: every
  // row takes the first spelling of its key in file order. The file alone decides (no dependency
  // on stored categories). Rows whose spelling changed remember the original for the DQ note.
  // Pre-sort order equals file order here.
  const firstSpelling = new Map<string, string>();
  const spellingsByKey = new Map<string, Set<string>>();
  for (const it of intervals) {
    const key = categoryKey(it.category);
    if (!firstSpelling.has(key)) firstSpelling.set(key, it.category);
    let set = spellingsByKey.get(key);
    if (!set) {
      set = new Set<string>();
      spellingsByKey.set(key, set);
    }
    set.add(it.category);
  }
  for (const it of intervals) {
    const key = categoryKey(it.category);
    const canonical = firstSpelling.get(key) as string;
    if ((spellingsByKey.get(key) as Set<string>).size > 1 && it.category !== canonical) {
      it.categoryVariant = it.category;
    }
    it.category = canonical;
  }

  // Sort chronologically (placing any invalid dates at end)
  intervals.sort((a, b) => {
    const tA = isNaN(a.start.getTime()) ? Number.MAX_SAFE_INTEGER : a.start.getTime();
    const tB = isNaN(b.start.getTime()) ? Number.MAX_SAFE_INTEGER : b.start.getTime();
    return tA - tB;
  });

  // Reassign intervalIndex to 0..n-1 after sort
  for (let idx = 0; idx < intervals.length; idx++) {
    intervals[idx].intervalIndex = idx;
  }

  return intervals;
}

/**
 * FCT-driven Category Discovery (PRD Seg Discovery):
 * Extracts unique categories from the mapped FCT demand intervals.
 * Preserves existing configured parameters for unchanged categories,
 * seeds new categories from global SLA defaults, and removes dropped categories.
 */
export function discoverAndSyncCategories(
  intervals: StandardInterval[],
  existingCategories: CategoryConfig[],
  globalSLA: SLAPolicyConfig
): CategoryConfig[] {
  return syncCategoriesWithRenames(intervals, existingCategories, globalSLA).categories;
}

export interface CategorySyncResult {
  categories: CategoryConfig[];
  /** existing category whose spelling changed to the spelling now used by the intervals */
  renames: Array<{ from: string; to: string }>;
  /** existing categories with the same key as an earlier one: dropped (the first supplies the settings) */
  duplicatesDropped: Array<{ kept: string; dropped: string }>;
}

export function syncCategoriesWithRenames(
  intervals: StandardInterval[],
  existingCategories: CategoryConfig[],
  globalSLA: SLAPolicyConfig
): CategorySyncResult {
  // key -> spelling used by the intervals (first in order)
  const uniqueByKey = new Map<string, string>();
  for (const it of intervals) {
    if (it.category && it.category.trim()) {
      const key = categoryKey(it.category);
      if (!uniqueByKey.has(key)) uniqueByKey.set(key, it.category.trim().replace(/\s+/g, ' '));
    }
  }
  const uniqueSegNames = new Set<string>(uniqueByKey.values());
  const renames: Array<{ from: string; to: string }> = [];
  const duplicatesDropped: Array<{ kept: string; dropped: string }> = [];

  if (uniqueSegNames.size === 0) {
    const kept = existingCategories.length > 0 ? existingCategories : [
      {
        id: 'cat_default',
        name: 'General',
        ahtMinutes: 30,
        shrinkagePct: 0.20,
        priority: 1,
        primaryPct: globalSLA.primaryPct,
        primaryWindowMinutes: convertDurationToMinutes(globalSLA.primaryWindow, globalSLA.primaryUnit),
      }
    ];
    return { categories: kept, renames, duplicatesDropped };
  }

  // Existing categories are matched by key; when two share a key the first in array order
  // supplies the settings and the other is reported (and not carried over).
  const existingMap = new Map<string, CategoryConfig>();
  existingCategories.forEach((c) => {
    const key = categoryKey(c.name);
    const first = existingMap.get(key);
    if (!first) {
      existingMap.set(key, c);
    } else if (uniqueByKey.has(key)) {
      duplicatesDropped.push({ kept: first.name, dropped: c.name });
    }
  });

  const sortedNames = Array.from(uniqueSegNames).sort();
  const defaultPrimaryWinMin = convertDurationToMinutes(globalSLA.primaryWindow, globalSLA.primaryUnit);

  const synced: CategoryConfig[] = sortedNames.map((name, index) => {
    const existing = existingMap.get(categoryKey(name));
    if (existing) {
      if (existing.name !== name) renames.push({ from: existing.name, to: name });
      return {
        ...existing,
        name,
        priority: existing.priority || index + 1,
      };
    }

    return {
      id: `cat_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}_${index}`,
      name,
      ahtMinutes: 30,
      shrinkagePct: 0.20,
      priority: index + 1,
      primaryPct: globalSLA.primaryPct,
      primaryWindow: globalSLA.primaryWindow,
      primaryUnit: globalSLA.primaryUnit,
      primaryWindowMinutes: defaultPrimaryWinMin,
      boAsaTarget: globalSLA.boAsaTarget,
      boAsaUnit: globalSLA.boAsaUnit,
    };
  });

  // A dropped duplicate's old spelling also maps to the surviving category's new spelling.
  for (const d of duplicatesDropped) {
    const target = synced.find((c) => categoryKey(c.name) === categoryKey(d.dropped));
    if (target && target.name !== d.dropped && !renames.some((r) => r.from === d.dropped)) {
      renames.push({ from: d.dropped, to: target.name });
    }
  }

  return { categories: synced, renames, duplicatesDropped };
}

/**
 * Stored backlog cases take the category spelling now used by the demand intervals (matched by
 * key), i.e. the same renames discoverAndSyncCategories applies to the categories themselves.
 * Returns the same array when nothing changes (safe to feed to a state setter).
 */
export function remapCasesToIntervalSpelling<T extends { category: string }>(
  cases: T[],
  intervals: StandardInterval[]
): T[] {
  if (cases.length === 0 || intervals.length === 0) return cases;
  const spelling = new Map<string, string>();
  for (const it of intervals) {
    const key = categoryKey(it.category);
    if (key && !spelling.has(key)) spelling.set(key, it.category.trim().replace(/\s+/g, ' '));
  }
  return applyCategoryRenames(
    cases,
    Array.from(spelling.values()).map((to) => ({ from: to, to }))
  );
}

/** Applies a rename list to stored backlog cases (matched by key). Returns the same array when nothing changes. */
export function applyCategoryRenames<T extends { category: string }>(
  cases: T[],
  renames: Array<{ from: string; to: string }>
): T[] {
  if (renames.length === 0) return cases;
  const map = new Map(renames.map((r) => [categoryKey(r.from), r.to]));
  let changed = false;
  const out = cases.map((c) => {
    const to = map.get(categoryKey(c.category));
    if (to !== undefined && to !== c.category) {
      changed = true;
      return { ...c, category: to };
    }
    return c;
  });
  return changed ? out : cases;
}

export function validateDataQuality(params: {
  intervals: StandardInterval[];
  mapping: ColumnMapping;
  categories: CategoryConfig[];
  calendar: CalendarConfig;
  labor: LaborConfig;
  sla: SLAPolicyConfig;
  openingWIP: OpeningWIPCase[];
  /** Non-blocking warnings the file reader raised for the accepted file (short rows, duplicate headers, characters). */
  fileWarnings?: CSVProblem[];
}): DQResult {
  const { intervals, mapping, categories, calendar, labor, sla, openingWIP } = params;
  const issues: DQIssue[] = [];

  for (const w of params.fileWarnings ?? []) {
    if (w.severity === 'warning') issues.push({ severity: 'warning', field: 'File reading', message: w.message });
  }

  if (!mapping?.intervalStartCol || !mapping?.volumeCol) {
    issues.push({
      severity: 'error',
      field: 'Column Mapping',
      message: 'Required columns (Interval Start and Volume) must be mapped.',
    });
  }

  if (intervals.length === 0) {
    issues.push({
      severity: 'error',
      field: 'Inflow Data',
      message: 'No intervals found in the uploaded file.',
    });
    return {
      passed: false,
      totalIntervals: 0,
      totalVolume: 0,
      horizonStart: null,
      horizonEnd: null,
      calendarWorkingDaysInHorizon: 0,
      categoriesFound: [],
      issues,
      totalWorkloadHours: 0,
    };
  }

  let totalVolume = 0;
  let insideBusinessHoursVolume = 0;
  let weekdayOffHoursVolume = 0;
  let weekendOrOffDayVolume = 0;

  const categoryNamesSet = new Set<string>();
  const invalidTimestamps: number[] = [];
  const invalidIntervalLengths: number[] = [];
  const duplicateSlots: string[] = [];
  const seenSlots = new Set<string>();
  const volumeParsingIssues: Array<{ row: number; message: string }> = [];
  const daysWithDataMs = new Set<number>();
  const rowsByDayMs = new Map<number, number>(); // valid rows per local calendar day (G1 date-gap rule)
  let firstDemandStartMs = Infinity;

  for (let i = 0; i < intervals.length; i++) {
    const it = intervals[i];
    totalVolume += it.volume;
    categoryNamesSet.add(it.category);

    if (it.volumeParsingIssue) {
      volumeParsingIssues.push({ row: i + 2, message: it.volumeParsingIssue });
    }

    const startValid = !isNaN(it.start.getTime());
    const endValid = !isNaN(it.end.getTime());

    if (!startValid || !endValid) {
      invalidTimestamps.push(i + 1);
    } else {
      const dayStart = new Date(it.start);
      dayStart.setHours(0, 0, 0, 0);
      daysWithDataMs.add(dayStart.getTime());
      rowsByDayMs.set(dayStart.getTime(), (rowsByDayMs.get(dayStart.getTime()) ?? 0) + 1);
      if (it.start.getTime() < firstDemandStartMs) firstDemandStartMs = it.start.getTime();

      // Diagnostic tracking of volume arrival relative to calendar operating hours
      if (isWorking(it.start, calendar)) {
        insideBusinessHoursVolume += it.volume;
      } else if (isWorkingDay(it.start, calendar)) {
        weekdayOffHoursVolume += it.volume;
      } else {
        weekendOrOffDayVolume += it.volume;
      }

      const durationMinutes = (it.end.getTime() - it.start.getTime()) / (60 * 1000);
      if (Math.abs(durationMinutes - 30) > 0.1) {
        invalidIntervalLengths.push(i + 1);
      }

      const slotKey = `${it.category}__${it.start.getTime()}`;
      if (seenSlots.has(slotKey)) {
        duplicateSlots.push(slotKey);
      }
      seenSlots.add(slotKey);
    }
  }

  // Pre-Run Diagnostic: Check if volume arrives outside configured operating hours
  const totalOutsideVolume = weekdayOffHoursVolume + weekendOrOffDayVolume;
  const totalOutsidePct = totalVolume > 0 ? Math.round((totalOutsideVolume / totalVolume) * 1000) / 10 : 0;
  const insidePct = totalVolume > 0 ? Math.round((insideBusinessHoursVolume / totalVolume) * 1000) / 10 : 0;
  const weekdayOffPct = totalVolume > 0 ? Math.round((weekdayOffHoursVolume / totalVolume) * 1000) / 10 : 0;
  const weekendPct = totalVolume > 0 ? Math.round((weekendOrOffDayVolume / totalVolume) * 1000) / 10 : 0;

  const operatingHoursBreakdown: OperatingHoursBreakdown = {
    insideVolume: Math.round(insideBusinessHoursVolume),
    insidePct,
    weekdayOffVolume: Math.round(weekdayOffHoursVolume),
    weekdayOffPct,
    weekendVolume: Math.round(weekendOrOffDayVolume),
    weekendPct,
    totalOutsideVolume: Math.round(totalOutsideVolume),
    totalOutsidePct,
  };

  if (totalOutsidePct > 15) {
    issues.push({
      severity: 'warning',
      field: 'Operating Hours & Demand Distribution Diagnostic',
      message: `Significant off-hours arrival: ${totalOutsidePct}% of volume arrives outside configured operating hours (${weekdayOffPct}% weekday off-hours, ${weekendPct}% weekend/non-working days).`,
      details: `With current calendar (${calendar.is24x7 ? '24/7' : `Open ${calendar.dailyOpenHour}:00-${calendar.dailyCloseHour}:00, ${calendar.workingDays.length} days/wk`}), off-hours volume will park in queue until the next opening window. ${
        sla.clockBasis === 'business_time'
          ? 'No action needed for the SLA clock: under a business-time SLA the clock starts at the next open business moment automatically. If the work is really handled continuously, consider enabling 24x7 operations or 6-day work weeks.'
          : "If SLA clock starts on arrival, this creates queue spikes at opening that can inflate required headcount. Recommended fixes: (1) Enable 24x7 operations or 6-day work weeks if work is handled continuously, or (2) Set Clock Start Policy to 'Next Open Business Window'."
      }`,
    });
  }

  // Timezone markers (Z / +hh:mm / epoch): converted to this PC's timezone, as always. Warn only.
  {
    let markedRows = 0;
    const markerSet = new Set<string>();
    let pcOffsetMin: number | null = null;
    for (const it of intervals) {
      if (it.timezoneMarkers && it.timezoneMarkers.length > 0) {
        markedRows++;
        it.timezoneMarkers.forEach((m) => markerSet.add(m));
        if (pcOffsetMin === null && !isNaN(it.start.getTime())) pcOffsetMin = -it.start.getTimezoneOffset();
      }
    }
    if (markedRows > 0) {
      const off = pcOffsetMin ?? 0;
      const sign = off < 0 ? '-' : '+';
      const absOff = Math.abs(off);
      const pcZone = `UTC${sign}${Math.floor(absOff / 60)}${absOff % 60 ? ':' + String(absOff % 60).padStart(2, '0') : ''}`;
      const hasEpoch = markerSet.has('epoch');
      const zoneMarkers = Array.from(markerSet).filter((m) => m !== 'epoch').sort();
      const rowsText = `${markedRows.toLocaleString()} timestamp${markedRows === 1 ? '' : 's'}`;
      let message: string;
      if (zoneMarkers.length === 0) {
        message = `${rowsText} ${markedRows === 1 ? 'was a' : 'were'} numeric (Unix epoch) value${markedRows === 1 ? '' : 's'}. ${markedRows === 1 ? 'It was' : 'They were'} converted to this PC's timezone (${pcZone}). Open the file on a PC set to the operation's timezone, or write the times as plain dates and times to have them read as written.`;
      } else {
        message = `${rowsText} carried a timezone marker (${zoneMarkers.join(', ')}${hasEpoch ? ', plus numeric epoch values' : ''}). ${markedRows === 1 ? 'It was' : 'They were'} converted to this PC's timezone (${pcZone}). Open the file on a PC set to the operation's timezone, or remove the markers to have times read as written.`;
      }
      issues.push({ severity: 'warning', field: 'Timezone markers converted', message });
    }
  }

  // Category spellings merged (letter case / spacing only).
  {
    const groups = new Map<string, { canonical: string; variants: Map<string, number> }>();
    for (const it of intervals) {
      if (!it.categoryVariant) continue;
      const key = categoryKey(it.category);
      let g = groups.get(key);
      if (!g) {
        g = { canonical: it.category, variants: new Map<string, number>() };
        groups.set(key, g);
      }
      g.variants.set(it.categoryVariant, (g.variants.get(it.categoryVariant) ?? 0) + 1);
    }
    if (groups.size > 0) {
      const lines = Array.from(groups.keys())
        .sort()
        .map((k) => {
          const g = groups.get(k) as { canonical: string; variants: Map<string, number> };
          const names = Array.from(g.variants.keys()).sort().map((v) => `"${v}"`).join(', ');
          const rowsMerged = Array.from(g.variants.values()).reduce((a, b) => a + b, 0);
          return `${names} → "${g.canonical}" (${rowsMerged.toLocaleString()} row${rowsMerged === 1 ? '' : 's'})`;
        });
      const shown = lines.slice(0, 10).join('; ');
      issues.push({
        severity: 'warning',
        field: 'Category names merged',
        message: `Category names that differ only by letter case or spacing were merged into one category: ${shown}${lines.length > 10 ? `; +${lines.length - 10} more` : ''}.`,
        details: 'The first spelling in the file is used. Names that differ in the words themselves stay separate categories.',
      });
    }
  }

  const unreadableVolumes = volumeParsingIssues.filter((v) => /^(unreadable|ambiguous|mixed):/.test(v.message));
  const otherVolumeIssues = volumeParsingIssues.filter((v) => !/^(unreadable|ambiguous|mixed):/.test(v.message));

  if (unreadableVolumes.length > 0) {
    const examples = unreadableVolumes
      .slice(0, 5)
      .map((v) => v.message.replace(/^(unreadable|ambiguous|mixed):/, ''))
      .join('; ');
    const hasMixed = unreadableVolumes.some((v) => v.message.startsWith('mixed:'));
    issues.push({
      severity: 'error',
      field: 'Unreadable volume',
      message: `${unreadableVolumes.length} volume cell(s) cannot be read with certainty${hasMixed ? ' (mixed number formats)' : ''}: ${examples}${unreadableVolumes.length > 5 ? ` (and ${unreadableVolumes.length - 5} more)` : ''}.`,
      details: 'Volumes must be plain numbers. Units, letters and exponents are not accepted; in a comma-separated file a comma is only allowed as a thousands separator (1,234); in a semicolon or tab file the decimal convention is taken from the column and must not be mixed. These cells are stored as 0 and the run is blocked until the file is corrected.',
    });
  }

  if (otherVolumeIssues.length > 0) {
    issues.push({
      severity: 'warning',
      field: 'Volume Parsing',
      message: `Found ${otherVolumeIssues.length} volume cell(s) with a problem (e.g. row ${otherVolumeIssues[0].row}: ${otherVolumeIssues[0].message}).`,
      details: `Negative volumes are rejected and treated as 0. Verify the affected rows match your expectation.`,
    });
  }

  const fractionalVolumeRows: number[] = [];
  const hugeVolumeRows: number[] = [];
  intervals.forEach((it, i) => {
    if (Number.isFinite(it.volume) && Math.abs(it.volume - Math.round(it.volume)) > 1e-9) fractionalVolumeRows.push(i + 2);
    if (it.volume > 100000) hugeVolumeRows.push(i + 2);
  });
  if (fractionalVolumeRows.length > 0) {
    issues.push({
      severity: 'warning',
      field: 'Fractional volume',
      message: `${fractionalVolumeRows.length} interval volume(s) are not whole numbers (e.g. row ${fractionalVolumeRows[0]}). The simulation rounds each interval to whole cases.`,
      details: 'The displayed total keeps the decimals; the engine uses the rounded per-interval values, so the simulated total can differ slightly.',
    });
  }
  if (hugeVolumeRows.length > 0) {
    issues.push({
      severity: 'warning',
      field: 'Very large volume',
      message: `${hugeVolumeRows.length} interval volume(s) exceed 100,000 (e.g. row ${hugeVolumeRows[0]}). No real 30-minute interval is that large — check for a misread number.`,
    });
  }

  if (invalidTimestamps.length > 0) {
    issues.push({
      severity: 'error',
      field: 'Timestamps',
      message: `Found ${invalidTimestamps.length} invalid or unparseable timestamps (e.g. row ${invalidTimestamps[0]}). Dates must be in dd/mm/yyyy format (or ISO YYYY-MM-DD); mm/dd format (e.g. 10/31/2026) is rejected.`,
    });
  }

  if (invalidIntervalLengths.length > 0) {
    issues.push({
      severity: 'error',
      field: 'Interval Length',
      message: `Intervals must be exactly 30 minutes. Found ${invalidIntervalLengths.length} intervals with non-30m duration.`,
    });
  }

  if (duplicateSlots.length > 0) {
    let dupHint = '';
    if (mapping.intervalStartCol && !mapping.timeCol) {
      dupHint = ' (Notice: "Interval / Time" column is not mapped. If your CSV has a separate time column such as "Int" or "Time", ensure it is mapped in Column Mapping so intervals do not all collapse to 00:00).';
    }
    issues.push({
      severity: 'error',
      field: 'Duplicate Slots',
      message: `Found ${duplicateSlots.length} duplicate 30-minute interval slots for the same category.${dupHint}`,
      details: `Example: ${duplicateSlots[0]?.replace('__', ' at timestamp ')}. Each category must have at most one demand entry per 30-minute slot.`,
    });
  }

  // G1 / G1-a — empty runs between data dates (days sorted explicitly; Map order is insertion order).
  // The planning horizon is the demand span, so a mistyped date years away would make the plan span the empty gap and
  // understate the sizing. A run LONGER THAN 7 calendar days (8 or more empty days) next to an ISOLATED stray (the smaller side of the gap holds <= 1% of the rows, min 1 / max 20 rows)
  // blocks the run. Any other run longer than 30 days (a genuine closure with substantial data on both sides) only extends the
  // coverage-gap warning below. Only meaningful once every timestamp parsed cleanly.
  const longEmptyRuns: Array<{ from: number; to: number; emptyDays: number }> = [];
  if (invalidTimestamps.length === 0 && rowsByDayMs.size > 1) {
    const dayList = Array.from(rowsByDayMs.keys()).sort((x, y) => x - y);
    let totalRows = 0;
    for (const d of dayList) totalRows += rowsByDayMs.get(d) ?? 0;
    const isolatedLimit = Math.min(20, Math.max(1, totalRows * 0.01));
    const isolatedDays = new Set<number>();
    const isolatedGapDays: number[] = [];
    let rowsBefore = 0;
    for (let k = 0; k + 1 < dayList.length; k++) {
      rowsBefore += rowsByDayMs.get(dayList[k]) ?? 0;
      // More than 7 empty days between two data days <=> the next data day is 9 or more calendar days later.
      const gapLimit = new Date(dayList[k]);
      gapLimit.setDate(gapLimit.getDate() + 9);
      if (dayList[k + 1] < gapLimit.getTime()) continue;
      const rowsAfter = totalRows - rowsBefore;
      const emptyDays = Math.round((dayList[k + 1] - dayList[k]) / 86400000) - 1;
      if (Math.min(rowsBefore, rowsAfter) <= isolatedLimit) {
        isolatedGapDays.push(emptyDays);
        // The smaller side (the earlier one on an exact tie) is the isolated one.
        if (rowsBefore <= rowsAfter) {
          for (let q = 0; q <= k; q++) isolatedDays.add(dayList[q]);
        } else {
          for (let q = k + 1; q < dayList.length; q++) isolatedDays.add(dayList[q]);
        }
      } else if (emptyDays > 30) {
        longEmptyRuns.push({ from: dayList[k], to: dayList[k + 1], emptyDays });
      }
    }
    if (isolatedDays.size > 0) {
      const isolatedSorted = Array.from(isolatedDays).sort((x, y) => x - y);
      const mainDays = dayList.filter((d) => !isolatedDays.has(d));
      let isolatedRows = 0;
      for (const d of isolatedSorted) isolatedRows += rowsByDayMs.get(d) ?? 0;
      const shownIso = isolatedSorted.slice(0, 5).map((d) => formatDate24(new Date(d))).join(', ');
      const moreIso = isolatedSorted.length > 5 ? ` (+${isolatedSorted.length - 5} more)` : '';
      issues.push({
        severity: 'error',
        field: 'Isolated Date(s)',
        message: `Isolated date(s) far from the rest of the data: ${shownIso}${moreIso} (${isolatedRows} row${isolatedRows === 1 ? '' : 's'}), separated by ${isolatedGapDays.join(' and ')} empty day${isolatedGapDays.length === 1 && isolatedGapDays[0] === 1 ? '' : 's'} (more than 7) from the main data range ${formatDate24(new Date(mainDays[0]))} to ${formatDate24(new Date(mainDays[mainDays.length - 1]))}.`,
        details: 'Check for a mistyped date (for example a wrong year) and correct or remove those rows before running. The planning horizon is the span of the demand data, so a stray date would stretch it across the empty gap and understate the headcount.',
      });
    }
  }

  const { horizonStart, horizonEnd } = computeIntervalHorizon(intervals, openingWIP);
  const calendarWorkingDays = getCalendarWorkingDaysInHorizon(horizonStart, horizonEnd, calendar);

  // Warning A: labor off days is 0 on a non-24/7 calendar. Real labor policy rarely has
  // zero weekly rest; this is also the residue left behind by un-ticking "24/7 Operations"
  // (which force-sets it to 0) without restoring a normal value.
  if (labor.offDaysPerWeek === 0 && !calendar.is24x7) {
    issues.push({
      severity: 'warning',
      field: 'Labor Off Days',
      message: 'Labor off days per week is 0 on a non-24/7 calendar — agents are configured to work every open day with no weekly rest.',
      details: 'This is often left over from toggling "24/7 Operations" on and back off. If unintentional, set Working Days per Week back to a normal value (e.g. 5) in Labor & Business Calendar configuration; the extra-OFF roster uplift is 0 while this stands, understating headcount if it should not be.',
    });
  }

  // Warning B: Manual Hours Override far out of scale with the uploaded horizon. Mirrors
  // resolveAgentHoursForNMin's own gate (hc-search.ts) so this only fires when the engine
  // actually uses the override. Not imported from hc-search.ts to avoid a new cross-layer
  // dependency (csv-parser depends only on types + calendar today) — the gate is 3 lines.
  const override = labor.contractualProductiveHoursOverride;
  if (labor.contractualHoursSource === 'override' && typeof override === 'number' && Number.isFinite(override) && override > 0) {
    const derivedAgentHours = labor.dailyProductiveHours * Math.max(1, calendarWorkingDays);
    const ratio = derivedAgentHours > 0 ? override / derivedAgentHours : Infinity;
    if (ratio > 3 || ratio < 1 / 3) {
      issues.push({
        severity: 'warning',
        field: 'Manual Agent Hours Override',
        message: `Manual agent productive hours override (${override}h) is far out of scale with the uploaded demand horizon (${calendarWorkingDays} working day(s), ≈${Math.round(derivedAgentHours * 10) / 10}h derived).`,
        details: 'A monthly-scale override left in place against a short upload (or vice versa) silently skews the Workload HC (N_min) floor. Confirm the override reflects hours actually available across THIS horizon, not a different reporting period — or switch back to "Derived (Horizon Default)".',
      });
    }
  }

  // Warning C: calendar-open days inside the horizon with zero uploaded rows. These still
  // count as fully-staffed working days downstream (getCalendarWorkingDaysInHorizon), so a
  // gap in the export — as opposed to genuine zero demand — understates the occupancy
  // denominator and can undersize the recommendation. Only meaningful once every timestamp
  // parsed cleanly: computeIntervalHorizon falls back to `new Date()` when none did, which
  // would make this non-deterministic (CLAUDE.md bans wall-clock-dependent results).
  if (invalidTimestamps.length === 0) {
    const emptyOpenDays: string[] = [];
    const curr = new Date(horizonStart);
    curr.setHours(0, 0, 0, 0);
    const end = new Date(horizonEnd);
    while (curr.getTime() < end.getTime()) {
      if (isWorkingDay(curr, calendar) && !daysWithDataMs.has(curr.getTime())) {
        emptyOpenDays.push(curr.toISOString().slice(0, 10));
      }
      curr.setDate(curr.getDate() + 1);
    }
    if (emptyOpenDays.length > 0) {
      const shown = emptyOpenDays.slice(0, 5).join(', ');
      const more = emptyOpenDays.length > 5 ? ` (+${emptyOpenDays.length - 5} more)` : '';
      issues.push({
        severity: 'warning',
        field: 'Calendar/Data Coverage Gap',
        message: `${emptyOpenDays.length} calendar-open day(s) inside the uploaded horizon have no demand rows at all: ${shown}${more}.`,
        details:
          'These days are still counted as fully-staffed working days in the sizing chain. Confirm they are genuine zero-demand days (business open, nothing arrived) rather than a gap in the export.' +
          (longEmptyRuns.length > 0
            ? ` The data also contains ${longEmptyRuns.length} run(s) of more than 30 consecutive calendar days with no rows at all (longest ${Math.max(...longEmptyRuns.map((r) => r.emptyDays))} days, e.g. ${formatDate24(new Date(longEmptyRuns[0].from))} to ${formatDate24(new Date(longEmptyRuns[0].to))}); confirm this is a genuine closure and not a missing export.`
            : ''),
      });
    }
  }

  // Category AHT and shrinkage completeness check
  const categoryMap = new Map<string, CategoryConfig>();
  categories.forEach((c) => categoryMap.set(c.name, c));

  const categoriesFound = Array.from(categoryNamesSet);
  let totalWorkloadHours = 0;

  for (const catName of categoriesFound) {
    const config = categoryMap.get(catName);
    if (!config) {
      issues.push({
        severity: 'error',
        field: 'Category Config',
        message: `Inflow category "${catName}" is missing AHT and Shrinkage configuration in the UI.`,
        details: 'Every category in the uploaded file must have user-configured AHT and Shrinkage.',
      });
    } else {
      if (config.ahtMinutes <= 0) {
        issues.push({
          severity: 'error',
          field: 'Category AHT',
          message: `Category "${catName}" has invalid AHT (${config.ahtMinutes} min). Must be > 0.`,
        });
      }
      if (config.shrinkagePct < 0 || config.shrinkagePct >= 1) {
        issues.push({
          severity: 'error',
          field: 'Category Shrinkage',
          message: `Category "${catName}" has invalid shrinkage (${config.shrinkagePct * 100}%). Must be between 0% and 99%.`,
        });
      }
    }
  }

  // Check Orphan Opening WIP categories (PRD DQ check: Orphan WIP Seg not in FCT -> DQ block)
  for (const wip of openingWIP) {
    if (!categoryNamesSet.has(wip.category)) {
      issues.push({
        severity: 'error',
        field: 'Opening WIP',
        message: `Orphan Opening WIP Category "${wip.category}" is not present in FCT demand intervals.`,
        details: 'All Opening WIP cases must belong to a category present in the demand forecast.',
      });
    }
  }

  // G1 — opening backlog that sits far outside the demand data, and backlog that is already overdue when the plan starts.
  if (openingWIP.length > 0 && isFinite(firstDemandStartMs)) {
    const cutoff = new Date(firstDemandStartMs);
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - 30);
    const tooOld = openingWIP
      .filter((w) => w.arrival && !isNaN(w.arrival.getTime()) && w.arrival.getTime() < cutoff.getTime())
      .sort((a, b) => a.arrival.getTime() - b.arrival.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (tooOld.length > 0) {
      issues.push({
        severity: 'warning',
        field: 'Old Backlog Arrival',
        message: `${tooOld.length} opening-backlog case(s) arrived more than 30 days before the first demand interval (${formatDate24(new Date(firstDemandStartMs))}); the oldest is "${tooOld[0].id}" (arrived ${formatDate24(tooOld[0].arrival)}).`,
        details: 'The planning horizon is the demand span, so old backlog does not change the capacity maths — it is still worked as workload. A very old date is usually a typo (for example a wrong year); confirm the arrival dates are right.',
      });
    }
  }
  if (openingWIP.length > 0) {
    let overdueAtStart = 0;
    try {
      overdueAtStart = buildOpeningWipCases({ openingWIP, categoryMap, calendar, sla, horizonStart }).cases.filter((c) => c.overdueAtStart).length;
    } catch {
      overdueAtStart = 0; // degenerate calendar (no open window): nothing meaningful to report here
    }
    if (overdueAtStart > 0) {
      issues.push({
        severity: 'warning',
        field: 'Opening WIP Overdue at Start',
        message: `${overdueAtStart} opening-backlog case(s) will already be overdue when the plan starts (${formatDateTime24(horizonStart)}).`,
        details: 'They are worked first and counted as workload, but they are not part of the SLA % or the wait-time check (they cannot be made on time by any headcount). The Results screen reports their count separately.',
      });
    }
  }

  // Workload calculation
  for (const it of intervals) {
    const cat = categoryMap.get(it.category);
    if (cat && cat.ahtMinutes > 0) {
      totalWorkloadHours += (it.volume * cat.ahtMinutes) / 60;
    }
  }

  for (const wip of openingWIP) {
    const cat = categoryMap.get(wip.category);
    const fallbackAht = cat?.ahtMinutes ?? 30;
    const rem =
      wip.remainingWorkMinutes === undefined || wip.remainingWorkMinutes === null
        ? fallbackAht
        : Math.max(0, wip.remainingWorkMinutes);
    totalWorkloadHours += rem / 60;
  }

  if (totalWorkloadHours <= 0) {
    issues.push({
      severity: 'error',
      field: 'Total Workload',
      message: 'Total workload hours is 0. Sizing cannot proceed with zero demand.',
    });
  }

  // Capacity Basis check (M1): Scheduled shift coverage hours per agent-day must equal daily_productive_hours (±0.05 h)
  const dailyWindowLength = getDailyWindowLengthHours(calendar);
  if (labor.dailyProductiveHours > dailyWindowLength + 0.05) {
    issues.push({
      severity: 'error',
      field: 'Capacity Basis (M1)',
      message: `Daily productive hours (${labor.dailyProductiveHours}h) exceeds the daily business window (${dailyWindowLength}h).`,
      details: 'Productive hours cannot exceed open business hours.',
    });
  }

  // Adherence sanity warning
  if (labor.adherencePct <= 0 || labor.adherencePct > 1) {
    issues.push({
      severity: 'error',
      field: 'Labor Adherence',
      message: `Labor adherence (${labor.adherencePct * 100}%) must be in (0%, 100%].`,
    });
  } else if (labor.adherencePct < 0.70) {
    issues.push({
      severity: 'warning',
      field: 'Labor Adherence',
      message: `Labor adherence is set low (${Math.round(labor.adherencePct * 100)}%). DES present hours will be heavily reduced.`,
    });
  }

  const hasErrors = issues.some((i) => i.severity === 'error');

  return {
    passed: !hasErrors,
    totalIntervals: intervals.length,
    totalVolume: Math.round(totalVolume),
    horizonStart,
    horizonEnd,
    calendarWorkingDaysInHorizon: calendarWorkingDays,
    categoriesFound,
    issues,
    totalWorkloadHours: Math.round(totalWorkloadHours * 10) / 10,
    operatingHoursBreakdown,
  };
}

/** One Excel cell as CSV text. Dates use the SAME local-time formatter the screen uses (never UTC/ISO). */
function csvCell(val: unknown): string {
  if (val === null || val === undefined) val = '';
  if (val instanceof Date) val = formatDateTime24(val, '');
  return `"${String(val).replace(/"/g, '""')}"`;
}

/** Header + rows as CSV lines (no BOM). Pure. */
function csvLines(data: Array<Record<string, unknown>>): string[] {
  if (data.length === 0) return [];
  const headers = Object.keys(data[0]);
  return [headers.map(csvCell).join(','), ...data.map((row) => headers.map((h) => csvCell(row[h])).join(','))];
}

/**
 * Pure builder for the Excel-friendly CSV text (UTF-8 BOM, CRLF, every cell quoted). Date cells are
 * rendered with formatDateTime24 ("YYYY-MM-DD HH:mm", local business time, no "Z"), identical to the
 * on-screen tables. Optional `sections` append further titled tables below, separated by a blank row.
 */
export function buildExcelCSV(
  data: Array<Record<string, unknown>>,
  sections: Array<{ title: string; rows: Array<Record<string, unknown>> }> = []
): string {
  const lines = csvLines(data);
  for (const sec of sections) {
    if (lines.length > 0) lines.push('');
    lines.push(csvCell(sec.title), ...csvLines(sec.rows));
  }
  // UTF-8 BOM (U+FEFF) ensures Excel opens file with proper UTF-8 decoding
  return '﻿' + lines.join('\r\n');
}

export function exportToExcelCSV(
  data: Array<Record<string, unknown>>,
  filename: string = 'wfm_export.csv',
  sections: Array<{ title: string; rows: Array<Record<string, unknown>> }> = []
) {
  if (data.length === 0 && sections.length === 0) return;

  const csvContent = buildExcelCSV(data, sections);
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
