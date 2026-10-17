/**
 * "Exported from outdated results" note for CSV exports (P2-13).
 *
 * When the settings or data changed after the run that produced the Results screen, every export
 * from Results ends with one extra trailing NOTE section naming what changed. It is a trailing
 * block only: the header and columns of the real tables are untouched, so tools that read by
 * header ignore it. Nothing changed -> nothing appended (byte-identical to the plain export).
 */

import { exportToExcelCSV } from './csv-parser';

export interface ExportSection {
  title: string;
  rows: Array<Record<string, unknown>>;
}

/** Outdated state handed from App (via ResultsFlow) to an export: plain-words names of what changed. */
export interface OutdatedNote {
  settings: string[];
  data: string[];
}

/** Append the NOTE section when anything changed; otherwise return the sections unchanged. Pure, never mutates. */
export function withOutdatedNote(
  sections: ExportSection[],
  settingsChanged: string[],
  dataChanged: string[]
): ExportSection[] {
  const parts: string[] = [];
  if (settingsChanged.length > 0) parts.push(`settings changed (${settingsChanged.join(', ')})`);
  if (dataChanged.length > 0) parts.push(`data changed (${dataChanged.join(', ')})`);
  if (parts.length === 0) return sections;
  return [...sections, { title: `NOTE: Exported from outdated results - ${parts.join(', ')}. Re-run to refresh.`, rows: [] }];
}

/**
 * Rows + sections + note, or null when there is nothing to export: a stale note alone must never
 * produce a note-only file (same early return exportToExcelCSV already has for empty exports).
 */
export function prepareNotedExport(
  data: Array<Record<string, unknown>>,
  sections: ExportSection[],
  settingsChanged: string[],
  dataChanged: string[]
): { data: Array<Record<string, unknown>>; sections: ExportSection[] } | null {
  if (data.length === 0 && sections.length === 0) return null;
  return { data, sections: withOutdatedNote(sections, settingsChanged, dataChanged) };
}

/** Download a CSV with the outdated note appended when stale. Empty exports still return early. */
export function exportWithOutdatedNote(
  data: Array<Record<string, unknown>>,
  filename: string,
  note: OutdatedNote,
  sections: ExportSection[] = []
): void {
  const prepared = prepareNotedExport(data, sections, note.settings, note.data);
  if (!prepared) return;
  exportToExcelCSV(prepared.data, filename, prepared.sections);
}
