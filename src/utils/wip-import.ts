/**
 * Pure backlog (opening WIP) file-row importer (input safety, part 1).
 *
 * Extracted from DemandFlow.tsx `getParsedWipCases`. Behaviour for valid rows, ids and row
 * order is unchanged. Bad values are never silently misread: each is replaced by a safe
 * value from the row's category and COUNTED so the planner sees it before importing.
 *
 * Pure: no clock read. The default arrival is passed in by the caller.
 */
import type { OpeningWIPCase } from '../types/wfm';
import { categoryKey, detectTimezoneMarker, generateNextWIPId, parseFlexibleDate } from './csv-parser';
import { readNumberColumn } from './number-cell';

export const WIP_MAX_REMAINING_MINUTES = 100000;
export const WIP_CONFIRM_FRACTION = 0.2;
export const WIP_CONFIRM_ROWS = 50;

export interface WipColumnMapping {
  caseIdCol: string;
  categoryCol: string;
  dateCol: string;
  timeCol: string;
  remainingWorkCol: string;
  priorityCol: string;
}

export interface WipCategoryRef {
  name: string;
  ahtMinutes: number;
  priority: number;
}

export interface WipExample {
  /** row number in the file (header = row 1) */
  row: number;
  text: string;
}

export interface WipFallbackKind {
  count: number;
  examples: WipExample[];
}

export interface WipImportSummary {
  totalRows: number;
  importedRows: number;
  importedAsTyped: number;
  adjustedRows: number;
  fallbackCategoryName: string;
  /** unknown or blank category: imported under the fallback category */
  category: WipFallbackKind;
  /** remaining minutes unreadable / zero-or-less / above the limit: category handling time used */
  remainingMinutes: WipFallbackKind;
  /** priority not a positive whole number: category priority used */
  priority: WipFallbackKind;
  /** blank date: default arrival used */
  date: WipFallbackKind;
  /** category has no handling time: 30 minutes assumed */
  noHandlingTime: WipFallbackKind;
  /** arrival dates that carried a timezone marker (or were epoch numbers): converted to this PC's timezone */
  timezone: { count: number; markers: string[] };
  /** true when the planner must tick a confirmation before appending */
  requiresConfirmation: boolean;
}

export interface WipImportResult {
  cases: OpeningWIPCase[];
  invalidDates: number;
  unmatchedCategories: string[];
  summary: WipImportSummary;
}

function newKind(): WipFallbackKind {
  return { count: 0, examples: [] };
}

function note(kind: WipFallbackKind, row: number, text: string): void {
  kind.count++;
  if (kind.examples.length < 5) kind.examples.push({ row, text });
}

export function parseWipRows(
  rows: Record<string, string>[],
  mapping: WipColumnMapping,
  categories: WipCategoryRef[],
  defaultArrival: Date,
  baseWip: OpeningWIPCase[],
  delimiter: string = ','
): WipImportResult {
  const fallbackCat: WipCategoryRef = categories.length > 0 ? categories[0] : { name: 'General', ahtMinutes: 30, priority: 1 };
  const summary: WipImportSummary = {
    totalRows: rows.length,
    importedRows: 0,
    importedAsTyped: 0,
    adjustedRows: 0,
    fallbackCategoryName: fallbackCat.name,
    category: newKind(),
    remainingMinutes: newKind(),
    priority: newKind(),
    date: newKind(),
    noHandlingTime: newKind(),
    timezone: { count: 0, markers: [] },
    requiresConfirmation: false,
  };
  const cases: OpeningWIPCase[] = [];
  if (rows.length === 0) return { cases, invalidDates: 0, unmatchedCategories: [], summary };

  let invalidDates = 0;
  const unmatchedSet = new Set<string>();

  const remaining = mapping.remainingWorkCol
    ? readNumberColumn(rows.map((r) => String(r[mapping.remainingWorkCol] ?? '')), delimiter)
    : null;

  rows.forEach((row, idx) => {
    const fileRow = idx + 2;
    let adjusted = false;
    const pending: Array<() => void> = [];

    // Category
    const rawCat = mapping.categoryCol ? (row[mapping.categoryCol] || '').trim() : '';
    const rawKey = categoryKey(rawCat);
    const matchedCat = categories.find((c) => categoryKey(c.name) === rawKey);
    let categoryName: string;
    let cat: WipCategoryRef;
    if (!matchedCat) {
      if (rawCat) unmatchedSet.add(rawCat);
      categoryName = fallbackCat.name;
      cat = fallbackCat;
      adjusted = true;
      pending.push(() => note(summary.category, fileRow, rawCat === '' ? '(blank)' : rawCat));
    } else {
      categoryName = matchedCat.name;
      cat = matchedCat;
    }

    // Handling time of the category (used whenever the row's own value is not usable)
    const categoryAht = (): number => {
      if (cat.ahtMinutes > 0) return cat.ahtMinutes;
      adjusted = true;
      pending.push(() => note(summary.noHandlingTime, fileRow, cat.name));
      return 30;
    };

    // Priority
    let prio = cat.priority || 1;
    if (mapping.priorityCol && row[mapping.priorityCol] && row[mapping.priorityCol].trim() !== '') {
      const txt = row[mapping.priorityCol].trim();
      const p = /^\d+$/.test(txt) ? parseInt(txt, 10) : NaN;
      if (Number.isFinite(p) && p > 0) {
        prio = p;
      } else {
        adjusted = true;
        pending.push(() => note(summary.priority, fileRow, txt));
      }
    }

    // Remaining work (minutes)
    let remMins: number | null = null;
    const remText = mapping.remainingWorkCol ? String(row[mapping.remainingWorkCol] ?? '').trim() : '';
    if (remaining && remText !== '') {
      const v = remaining.values[idx];
      const bad = remaining.problems.some((p) => p.index === idx) || v === null || v <= 0 || v > WIP_MAX_REMAINING_MINUTES;
      if (bad) {
        adjusted = true;
        pending.push(() => note(summary.remainingMinutes, fileRow, remText));
      } else {
        remMins = v;
      }
    }
    if (remMins === null) remMins = categoryAht();

    // Arrival date & time (day-first assumed; only impossible dates are rejected)
    const dateStr = mapping.dateCol ? (row[mapping.dateCol] || '').trim() : '';
    const timeStr = mapping.timeCol ? (row[mapping.timeCol] || '').trim() : undefined;
    let arrivalDate: Date;
    if (dateStr) {
      const parsed = parseFlexibleDate(dateStr, timeStr);
      const marker = detectTimezoneMarker(dateStr, timeStr);
      if (marker && !isNaN(parsed.getTime())) {
        summary.timezone.count++;
        if (!summary.timezone.markers.includes(marker)) summary.timezone.markers.push(marker);
      }
      if (isNaN(parsed.getTime())) {
        invalidDates++;
        return;
      }
      arrivalDate = parsed;
    } else {
      arrivalDate = new Date(defaultArrival);
      if (mapping.dateCol) {
        adjusted = true;
        pending.push(() => note(summary.date, fileRow, '(blank)'));
      }
    }

    // Case ID
    let caseId = mapping.caseIdCol && row[mapping.caseIdCol] ? row[mapping.caseIdCol].trim() : '';
    const usedIds = new Set([...baseWip, ...cases].map((w) => w.id));
    if (!caseId || usedIds.has(caseId)) {
      caseId = generateNextWIPId([...baseWip, ...cases]);
    }

    pending.forEach((fn) => fn());
    if (adjusted) summary.adjustedRows++;
    cases.push({
      id: caseId,
      category: categoryName,
      priority: prio,
      arrival: arrivalDate,
      clockStart: arrivalDate,
      remainingWorkMinutes: remMins,
    });
  });

  summary.importedRows = cases.length;
  summary.importedAsTyped = cases.length - summary.adjustedRows;
  summary.requiresConfirmation =
    summary.category.count > WIP_CONFIRM_FRACTION * summary.totalRows || summary.category.count > WIP_CONFIRM_ROWS;

  return { cases, invalidDates, unmatchedCategories: Array.from(unmatchedSet), summary };
}
