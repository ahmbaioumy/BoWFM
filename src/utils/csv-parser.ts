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
  getCalendarWorkingDaysInHorizon,
  getDailyWindowLengthHours,
  isWorking,
  isWorkingDay,
} from './calendar';

export function parseCSVRaw(text: string): { headers: string[]; rows: Record<string, string>[] } {
  if (!text || !text.trim()) return { headers: [], rows: [] };

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

  // 2. Tokenize into 2D records using character-by-character RFC 4180 state machine
  const records: string[][] = [];
  let currentRecord: string[] = [];
  let currentField = '';
  let inQuotes = false;
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
        currentField += char;
        i++;
        continue;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
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
        records.push(currentRecord);
        currentRecord = [];
        i++;
        continue;
      } else if (char === '\n') {
        currentRecord.push(currentField);
        currentField = '';
        records.push(currentRecord);
        currentRecord = [];
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
    records.push(currentRecord);
  }

  // 3. Filter out empty rows safely (rows where all cells are empty/whitespace)
  const cleanRecords = records.filter((rec) => rec.some((cell) => cell.trim().length > 0));

  if (cleanRecords.length === 0) {
    return { headers: [], rows: [] };
  }

  const rawHeaders = cleanRecords[0];
  const headers = rawHeaders.map((h, colIdx) => h.trim() || `Column_${colIdx + 1}`);
  const rows: Record<string, string>[] = [];

  for (let r = 1; r < cleanRecords.length; r++) {
    const rowCells = cleanRecords[r];
    if (!rowCells.some((c) => c.trim().length > 0)) continue;

    const rowObj: Record<string, string> = {};
    headers.forEach((h, colIdx) => {
      rowObj[h] = rowCells[colIdx] !== undefined ? rowCells[colIdx] : '';
    });
    rows.push(rowObj);
  }

  return { headers, rows };
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
  const isoMatch = fullStr.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:(Z)|([+-]\d{2}(?::?\d{2})?))?)?$/i
  );
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
  defaultCategoryName: string = 'General'
): StandardInterval[] {
  const intervals: StandardInterval[] = [];

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
        ? row[mapping.categoryCol].trim()
        : defaultCategoryName;

    const startDate = parseFlexibleDate(dateStr, timeStr);

    // Parse volume safely: strip thousands separators, currency symbols, whitespace
    let volume = 0;
    let volumeParsingIssue: string | null = null;
    if (volStr) {
      const stripped = volStr.trim().replace(/[\s$,]/g, '');
      const parsed = parseFloat(stripped);
      if (Number.isFinite(parsed)) {
        if (parsed < 0) {
          volumeParsingIssue = `Negative volume ${volStr} (interpreted as ${parsed}) — must be non-negative`;
          volume = 0;
        } else {
          // Check if the raw string has separators that parseFloat would have truncated
          if (volStr.includes(',') && volStr.includes('.')) {
            // Likely European format or contains thousands separator
            if (!/^\d{1,3}(,\d{3})*(\.\d+)?$|^\d{1,3}(\.\d{3})*(,\d+)?$/.test(volStr.trim())) {
              volumeParsingIssue = `Volume "${volStr}" may have been mis-parsed due to non-standard formatting`;
            }
          } else if (volStr.includes(',') && !/^\d+(,\d+)?$/.test(volStr.trim())) {
            // Has a comma but not in expected position
            volumeParsingIssue = `Volume "${volStr}" contains unexpected formatting — thousands separators will be stripped (parsed as ${parsed})`;
          }
          volume = parsed;
        }
      } else {
        volumeParsingIssue = `Volume cell "${volStr}" is not numeric`;
        volume = 0;
      }
    }

    let endDate: Date;
    if (mapping.intervalEndCol && row[mapping.intervalEndCol]) {
      endDate = parseFlexibleDate(row[mapping.intervalEndCol]);
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
    });
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
  const uniqueSegNames = new Set<string>();
  for (const it of intervals) {
    if (it.category && it.category.trim()) {
      uniqueSegNames.add(it.category.trim());
    }
  }

  if (uniqueSegNames.size === 0) {
    return existingCategories.length > 0 ? existingCategories : [
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
  }

  const existingMap = new Map<string, CategoryConfig>();
  existingCategories.forEach((c) => existingMap.set(c.name, c));

  const sortedNames = Array.from(uniqueSegNames).sort();
  const defaultPrimaryWinMin = convertDurationToMinutes(globalSLA.primaryWindow, globalSLA.primaryUnit);

  const synced: CategoryConfig[] = sortedNames.map((name, index) => {
    const existing = existingMap.get(name);
    if (existing) {
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

  return synced;
}

export function validateDataQuality(params: {
  intervals: StandardInterval[];
  mapping: ColumnMapping;
  categories: CategoryConfig[];
  calendar: CalendarConfig;
  labor: LaborConfig;
  sla: SLAPolicyConfig;
  openingWIP: OpeningWIPCase[];
}): DQResult {
  const { intervals, mapping, categories, calendar, labor, sla, openingWIP } = params;
  const issues: DQIssue[] = [];

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
      details: `With current calendar (${calendar.is24x7 ? '24/7' : `Open ${calendar.dailyOpenHour}:00-${calendar.dailyCloseHour}:00, ${calendar.workingDays.length} days/wk`}), off-hours volume will park in queue until the next opening window. If SLA clock starts on arrival, this creates queue spikes at opening that can inflate required headcount. Recommended fixes: (1) Enable 24x7 operations or 6-day work weeks if work is handled continuously, or (2) Set Clock Start Policy to 'Next Open Business Window'.`,
    });
  }

  if (volumeParsingIssues.length > 0) {
    issues.push({
      severity: 'warning',
      field: 'Volume Parsing',
      message: `Found ${volumeParsingIssues.length} volume cell(s) with non-standard formatting (e.g. row ${volumeParsingIssues[0].row}: ${volumeParsingIssues[0].message}).`,
      details: `Thousands separators and currency symbols are stripped automatically; negative volumes are rejected and treated as 0. Verify the affected rows match your expectation.`,
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
        details: 'These days are still counted as fully-staffed working days in the sizing chain. Confirm they are genuine zero-demand days (business open, nothing arrived) rather than a gap in the export.',
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

export function exportToExcelCSV(data: any[], filename: string = 'wfm_export.csv') {
  if (data.length === 0) return;

  const headers = Object.keys(data[0]);
  const rows = data.map((row) =>
    headers
      .map((h) => {
        let val = row[h];
        if (val === null || val === undefined) val = '';
        if (val instanceof Date) {
          val = !isNaN(val.getTime()) ? val.toISOString() : '';
        }
        const strVal = String(val).replace(/"/g, '""');
        return `"${strVal}"`;
      })
      .join(',')
  );

  // UTF-8 BOM \uFEFF ensures Excel opens file with proper UTF-8 decoding
  const csvContent = '\uFEFF' + [headers.map((h) => `"${h}"`).join(','), ...rows].join('\r\n');
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
