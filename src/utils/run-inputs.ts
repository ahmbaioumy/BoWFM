/**
 * Snapshot of the settings a sizing run was executed with, and a comparison against the live
 * settings so Results can flag "settings changed since this run".
 */

import type {
  CalendarConfig,
  CategoryConfig,
  LaborConfig,
  OpeningWIPCase,
  SimulationParams,
  SLAPolicyConfig,
  StandardInterval,
}from '../types/wfm';

export interface RunInputs {
  calendar: CalendarConfig;
  labor: LaborConfig;
  sla: SLAPolicyConfig;
  categories: CategoryConfig[];
  simParams: SimulationParams;
}

/** JSON-like stringify with object keys sorted, so key order never affects equality. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

const SECTIONS: Array<[keyof RunInputs, string]> = [
  ['calendar', 'Business calendar'],
  ['labor', 'Labor'],
  ['sla', 'SLA policy'],
  ['categories', 'Categories'],
  ['simParams', 'Simulation settings'],
];

/** Content fingerprints of the data a run used (strings only; the arrays are not retained). */
export interface RunDataFingerprints {
  demand: string;
  backlog: string;
}

/** Content fingerprint of demand intervals (start, end, volume, category NAME). Plain loop: cheap at 100k rows. */
export function fingerprintIntervals(intervals: ReadonlyArray<StandardInterval>): string {
  const parts: string[] = new Array(intervals.length);
  for (let i = 0; i < intervals.length; i++) {
    const r = intervals[i];
    parts[i] = `${r.start.getTime()}|${r.end.getTime()}|${r.volume}|${r.category}`;
  }
  return `${intervals.length}#${parts.join(';')}`;
}

/** Content fingerprint of the opening backlog, in array order (id, category NAME, arrival, remaining minutes, priority). */
export function fingerprintBacklog(cases: ReadonlyArray<OpeningWIPCase>): string {
  const parts: string[] = new Array(cases.length);
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    parts[i] = `${c.id}|${c.category}|${c.arrival.getTime()}|${c.remainingWorkMinutes}|${c.priority}`;
  }
  return `${cases.length}#${parts.join(';')}`;
}

/** Plain-words names of the data kinds that differ from the run: "demand data", "opening backlog". */
export function diffRunData(runData: RunDataFingerprints | null, live: RunDataFingerprints): string[] {
  if (!runData) return [];
  const out: string[] = [];
  if (runData.demand !== live.demand) out.push('demand data');
  if (runData.backlog !== live.backlog) out.push('opening backlog');
  return out;
}

/** Human section names whose values differ between the run snapshot and the live settings. */
export function diffRunInputs(run: RunInputs | null, live: RunInputs): string[] {
  if (!run) return [];
  return SECTIONS.filter(([key]) => stableStringify(run[key]) !== stableStringify(live[key])).map(([, label]) => label);
}
