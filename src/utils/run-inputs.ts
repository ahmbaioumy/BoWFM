/**
 * Snapshot of the settings a sizing run was executed with, and a comparison against the live
 * settings so Results can flag "settings changed since this run".
 */

import type {
  CalendarConfig,
  CategoryConfig,
  LaborConfig,
  SimulationParams,
  SLAPolicyConfig,
} from '../types/wfm';

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

/** Human section names whose values differ between the run snapshot and the live settings. */
export function diffRunInputs(run: RunInputs | null, live: RunInputs): string[] {
  if (!run) return [];
  return SECTIONS.filter(([key]) => stableStringify(run[key]) !== stableStringify(live[key])).map(([, label]) => label);
}
