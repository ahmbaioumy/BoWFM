/**
 * Shared loader for the test_files/ sample CSVs (test tooling only — never reaches the bundle).
 * Used by scripts/audit-sample-hc.mts and the D49 sample-file guard in verify-sizing-fixes.mts so
 * both read the files the same way.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseCSVRaw, mapRawRecordsToIntervals, discoverAndSyncCategories } from '../src/utils/csv-parser';
import { DEFAULT_CATEGORIES, DEFAULT_SLA } from '../src/utils/default-config';
import type { CategoryConfig, StandardInterval } from '../src/types/wfm';

/** Repo root, independent of the process cwd. */
export const REPO_ROOT = resolve(import.meta.dirname, '..');

export function loadSampleFile(csvName: string): { intervals: StandardInterval[]; categories: CategoryConfig[] } {
  const raw = parseCSVRaw(readFileSync(join(REPO_ROOT, 'test_files', csvName), 'utf8'));
  const intervals = mapRawRecordsToIntervals(raw.rows, { intervalStartCol: 'Date', timeCol: 'int', volumeCol: 'Vol', categoryCol: 'Seg' } as any);
  const categories = discoverAndSyncCategories(intervals, DEFAULT_CATEGORIES, DEFAULT_SLA);
  return { intervals, categories };
}
