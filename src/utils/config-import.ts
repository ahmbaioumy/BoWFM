/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure validator for an imported settings JSON (Sidebar "Import JSON"). No React, no I/O.
 *
 * Contract:
 *  - The five core keys (calendar, labor, sla, categories, simParams) are ALL-OR-NOTHING: if any key that is
 *    present is invalid, nothing is applied and every problem is returned. Absent core keys are left as they are.
 *  - `columnMapping` is optional: if invalid it is ignored and a note is returned (the core keys still apply).
 *  - Unknown top-level keys (`exportedAt`, `outdated`, future keys) are ignored. Unknown keys INSIDE a known
 *    section are carried through unchanged (future/optional engine fields such as shiftPlacementEnabled).
 *  - Calendar and labor merge over the defaults; sla merges over the defaults with the same sanitising the
 *    importer always applied (confidence / slack / workload-reduction clamps, clock start derived from the basis).
 *  - This is the real guard against a malformed file reaching the engine.
 */

import type {
  CalendarConfig,
  CategoryConfig,
  ColumnMapping,
  LaborConfig,
  SimulationParams,
  SLAPolicyConfig,
} from '../types/wfm';
import { DEFAULT_CALENDAR, DEFAULT_LABOR, DEFAULT_SIM_PARAMS, DEFAULT_SLA } from './default-config';

export interface ImportedConfig {
  calendar?: CalendarConfig;
  labor?: LaborConfig;
  sla?: SLAPolicyConfig;
  categories?: CategoryConfig[];
  simParams?: SimulationParams;
  columnMapping?: ColumnMapping;
}

export type ConfigImportResult =
  | { ok: true; value: ImportedConfig; /** keys applied, in file order of the core list */ applied: string[]; notes: string[] }
  | { ok: false; problems: string[]; /** JSON paths, same order as `problems` (tooltip) */ technical: string[] };

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isInt(v: unknown): v is number {
  return isNum(v) && Number.isInteger(v);
}

const TIME_UNITS = ['minutes', 'hours', 'days'];

/** Strict YYYY-MM-DD that is a real calendar date. */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** One rejected item: `text` is the plain-words line for the banner, `technical` the JSON path (tooltip). */
interface Problem {
  text: string;
  technical: string;
}

/** Plain-words field names per section (the screen the planner knows them from). Unlisted keys show their key. */
const LABELS: Record<string, Record<string, string>> = {
  calendar: {
    is24x7: '24/7 operations', workingDays: 'Working days', dailyOpenHour: 'Opening hour', dailyOpenMinute: 'Opening minute',
    dailyCloseHour: 'Closing hour', dailyCloseMinute: 'Closing minute', holidays: 'Holidays',
  },
  labor: {
    dailyProductiveHours: 'Daily productive hours', adherencePct: 'Adherence', workingDaysPerWeek: 'Working days per week',
    offDaysPerWeek: 'Off days per week', contractualHoursSource: 'Contractual hours source',
    contractualProductiveHoursOverride: 'Contractual hours override', shiftPlacementEnabled: 'Shift placement',
    shiftSlapMinutes: 'Shift start step (minutes)', shifts: 'Shifts',
  },
  sla: {
    primaryPct: 'Primary SLA target %', primaryWindow: 'Primary SLA window', primaryUnit: 'Primary SLA unit',
    boAsaTarget: 'Answer-time target', boAsaUnit: 'Answer-time unit', asaClockBasis: 'Answer-time clock',
    clockBasis: 'Clock basis', clockStartPolicy: 'Clock start', occupancyCapPct: 'Occupancy cap %',
    minAgentsPerInterval: 'Minimum agents per interval', boAsaEnabled: 'Answer-time check on/off',
    occupancyCapEnabled: 'Occupancy cap on/off', nMinFloorEnabled: 'Workload floor on/off',
    volumeVariability: 'Volume variability on/off', minCoverageEnabled: 'Minimum coverage on/off',
  },
  category: {
    name: 'Name', ahtMinutes: 'AHT (minutes)', shrinkagePct: 'Shrinkage', priority: 'Priority', primaryPct: 'SLA target %',
    primaryWindow: 'SLA window', primaryUnit: 'SLA unit', primaryWindowMinutes: 'SLA window (minutes)',
    boAsaTarget: 'Answer-time target', boAsaUnit: 'Answer-time unit', boAsaOwn: 'Own answer-time target', id: 'Id',
  },
  simParams: {
    seed: 'Random seed', maxHCSearch: 'Maximum headcount to search', replications: 'Replications',
    queueArchitecture: 'Queue architecture', dispatchFairness: 'Fair agent assignment',
    enabled: 'Fair assignment on/off', resetDaily: 'Reset daily', utilTolerancePp: 'Utilisation tolerance',
    countTolerance: 'Case-count tolerance', workloadToleranceMin: 'Workload tolerance (minutes)',
  },
};

function showFound(v: unknown): string {
  if (v === undefined) return 'missing';
  let t: string;
  try { t = JSON.stringify(v) ?? String(v); } catch { t = String(v); }
  return t.length > 40 ? `${t.slice(0, 37)}...` : t;
}

/** Collects problems for one section. `screen` is the plain-words screen label, `path` the technical prefix. */
class Check {
  problems: Problem[] = [];
  private obj: Obj = {};
  constructor(private screen: string, private path: string, private labels: Record<string, string>) {}
  fail(key: string, rule: string, found?: unknown) {
    const f = arguments.length >= 3 ? found : this.obj[key];
    const label = this.labels[key] ?? key;
    this.problems.push({
      text: `${this.screen} > ${label}: ${rule} (found: ${showFound(f)})`,
      technical: `${this.path}${key ? `.${key}` : ''}`,
    });
  }
  int(o: Obj, key: string, min: number, max: number) {
    this.obj = o;
    if (!isInt(o[key]) || (o[key] as number) < min || (o[key] as number) > max) this.fail(key, `must be a whole number from ${min} to ${max}`);
  }
  num(o: Obj, key: string, min: number, max: number, minExclusive = false, rule?: string) {
    this.obj = o;
    const v = o[key];
    if (!isNum(v) || (minExclusive ? v <= min : v < min) || v > max) {
      this.fail(key, rule ?? `must be a number ${minExclusive ? 'above' : 'from'} ${min}${max === Infinity ? '' : ` ${minExclusive ? 'up to' : 'to'} ${max}`}`);
    }
  }
  optNum(o: Obj, key: string, min: number, max: number, minExclusive = false) {
    if (o[key] !== undefined) this.num(o, key, min, max, minExclusive);
  }
  optBool(o: Obj, key: string) {
    this.obj = o;
    if (o[key] !== undefined && typeof o[key] !== 'boolean') this.fail(key, 'must be true or false');
  }
  optEnum(o: Obj, key: string, allowed: string[]) {
    this.obj = o;
    if (o[key] !== undefined && !allowed.includes(o[key] as string)) this.fail(key, `must be one of ${allowed.join(', ')}`);
  }
}

function validateCalendar(raw: unknown, problems: Problem[]): CalendarConfig | undefined {
  if (!isObj(raw)) {
    problems.push({ text: 'Calendar: the section must be an object (found: ' + showFound(raw) + ')', technical: 'calendar' });
    return undefined;
  }
  const c = new Check('Calendar', 'calendar', LABELS.calendar);
  const o: Obj = { ...DEFAULT_CALENDAR, ...raw };
  c.optBool(o, 'is24x7');
  if (!Array.isArray(o.workingDays) || !o.workingDays.every((d) => isInt(d) && d >= 0 && d <= 6)) {
    c.fail('workingDays', 'must be a list of day numbers from 0 (Sunday) to 6 (Saturday)', o.workingDays);
  }
  c.int(o, 'dailyOpenHour', 0, 23);
  c.int(o, 'dailyOpenMinute', 0, 59);
  c.int(o, 'dailyCloseHour', 0, 24);
  c.int(o, 'dailyCloseMinute', 0, 59);
  if (o.dailyCloseHour === 24 && o.dailyCloseMinute !== 0) c.fail('dailyCloseMinute', 'must be 0 when the closing hour is 24', o.dailyCloseMinute);
  if (!Array.isArray(o.holidays)) c.fail('holidays', 'must be a list of dates', o.holidays);
  else {
    const bad = (o.holidays as unknown[]).filter((h) => !isIsoDate(h));
    if (bad.length > 0) c.fail('holidays', 'every entry must be a real date written YYYY-MM-DD', bad.slice(0, 3));
  }
  problems.push(...c.problems);
  return c.problems.length === 0 ? (o as unknown as CalendarConfig) : undefined;
}

function validateLabor(raw: unknown, problems: Problem[]): LaborConfig | undefined {
  if (!isObj(raw)) {
    problems.push({ text: 'Labor: the section must be an object (found: ' + showFound(raw) + ')', technical: 'labor' });
    return undefined;
  }
  const c = new Check('Labor', 'labor', LABELS.labor);
  const o: Obj = { ...DEFAULT_LABOR, ...raw };
  c.num(o, 'dailyProductiveHours', 0, 24, true, 'must be hours per day, above 0 up to 24');
  c.num(o, 'adherencePct', 0, 1, true, 'must be a fraction above 0 up to 1, e.g. 0.9 for 90 %');
  c.int(o, 'workingDaysPerWeek', 1, 7);
  c.int(o, 'offDaysPerWeek', 0, 6);
  c.optEnum(o, 'contractualHoursSource', ['derived', 'override']);
  c.optNum(o, 'contractualProductiveHoursOverride', 0, Infinity); // total agent hours over the demand horizon, not per day
  c.optBool(o, 'shiftPlacementEnabled');
  c.optNum(o, 'shiftSlapMinutes', 0, 24 * 60, true);
  if (!Array.isArray(o.shifts) || !o.shifts.every(isObj)) c.fail('shifts', 'must be a list of shift objects', o.shifts);
  problems.push(...c.problems);
  return c.problems.length === 0 ? (o as unknown as LaborConfig) : undefined;
}

function validateSla(raw: unknown, problems: Problem[]): SLAPolicyConfig | undefined {
  if (!isObj(raw)) {
    problems.push({ text: 'SLA: the section must be an object (found: ' + showFound(raw) + ')', technical: 'sla' });
    return undefined;
  }
  const c = new Check('SLA', 'sla', LABELS.sla);
  const o: Obj = { ...DEFAULT_SLA, ...raw };
  c.num(o, 'primaryPct', 0, 100, true, 'must be a percentage above 0 up to 100');
  c.num(o, 'primaryWindow', 0, Infinity, true);
  c.optEnum(o, 'primaryUnit', TIME_UNITS);
  c.num(o, 'boAsaTarget', 0, Infinity, true);
  c.optEnum(o, 'boAsaUnit', TIME_UNITS);
  c.optEnum(o, 'asaClockBasis', ['business_window', 'clock_hours']);
  c.optEnum(o, 'clockBasis', ['business_time', 'wall_clock']);
  c.optEnum(o, 'clockStartPolicy', ['arrival', 'next_open']);
  c.num(o, 'occupancyCapPct', 0, 100, true, 'must be a percentage above 0 up to 100');
  c.optNum(o, 'minAgentsPerInterval', 0, 1000);
  for (const k of [
    'boAsaEnabled', 'occupancyCapEnabled', 'nMinFloorEnabled', 'volumeVariability', 'minCoverageEnabled',
  ]) c.optBool(o, k);
  problems.push(...c.problems);
  if (c.problems.length > 0) return undefined;

  // The sanitising the importer always applied (clamps rather than rejects).
  const n = parseFloat(String(raw.confidenceLevelPct ?? ''));
  const slackRaw = parseFloat(String(raw.slaAcceptanceSlackPct ?? ''));
  const workloadReductionRaw = parseFloat(String(raw.workloadReductionPct ?? ''));
  return {
    ...(o as unknown as SLAPolicyConfig),
    confidenceLevelPct: Number.isFinite(n) ? Math.min(99.9, Math.max(50, Math.round(n * 10) / 10)) : 95,
    slaAcceptanceSlackEnabled: raw.slaAcceptanceSlackEnabled === true,
    slaAcceptanceSlackPct: Number.isFinite(slackRaw)
      ? Math.min(20, Math.max(1, Math.round(slackRaw)))
      : DEFAULT_SLA.slaAcceptanceSlackPct,
    workloadReductionEnabled: raw.workloadReductionEnabled === true,
    workloadReductionPct: Number.isFinite(workloadReductionRaw)
      ? Math.min(50, Math.max(1, Math.round(workloadReductionRaw)))
      : DEFAULT_SLA.workloadReductionPct,
    // Clock start is derived from the basis: business_time always starts at next open;
    // wall_clock keeps the file's value (an absent value means 'arrival', not the default).
    clockStartPolicy:
      (o.clockBasis ?? DEFAULT_SLA.clockBasis) === 'business_time'
        ? 'next_open'
        : ((raw.clockStartPolicy as SLAPolicyConfig['clockStartPolicy'] | undefined) ?? 'arrival'),
  };
}

function validateCategories(raw: unknown, problems: Problem[]): CategoryConfig[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.push({ text: 'Categories: must be a non-empty list of categories (found: ' + showFound(raw) + ')', technical: 'categories' });
    return undefined;
  }
  const out: CategoryConfig[] = [];
  let bad = false;
  raw.forEach((item, i) => {
    if (!isObj(item)) {
      problems.push({ text: `Categories > item ${i + 1}: must be an object (found: ${showFound(item)})`, technical: `categories[${i}]` });
      bad = true;
      return;
    }
    const shown = typeof item.name === 'string' && item.name.trim() ? `Categories > ${item.name}` : `Categories > item ${i + 1}`;
    const c = new Check(shown, `categories[${i}]`, LABELS.category);
    if (typeof item.name !== 'string' || !item.name.trim()) c.fail('name', 'must be a non-empty text', item.name);
    c.num(item, 'ahtMinutes', 0, Infinity, true); // the screen has no upper limit
    if (!isNum(item.shrinkagePct) || item.shrinkagePct < 0 || item.shrinkagePct >= 1) c.fail('shrinkagePct', 'must be a fraction from 0 up to (not including) 1, e.g. 0.2 for 20 %', item.shrinkagePct);
    c.optNum(item, 'priority', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    c.optNum(item, 'primaryPct', 0, 100, true);
    c.optNum(item, 'primaryWindow', 0, Infinity, true);
    c.optEnum(item, 'primaryUnit', TIME_UNITS);
    c.optNum(item, 'primaryWindowMinutes', 0, Infinity, true);
    c.optNum(item, 'boAsaTarget', 0, Infinity, true);
    c.optEnum(item, 'boAsaUnit', TIME_UNITS);
    c.optBool(item, 'boAsaOwn');
    if (item.id !== undefined && typeof item.id !== 'string') c.fail('id', 'must be text', item.id);
    problems.push(...c.problems);
    if (c.problems.length > 0) {
      bad = true;
      return;
    }
    out.push({
      ...(item as unknown as CategoryConfig),
      id: typeof item.id === 'string' && item.id ? item.id : `cat_import_${i + 1}`,
      priority: isNum(item.priority) ? item.priority : i + 1,
    });
  });
  return bad ? undefined : out;
}

function validateSimParams(raw: unknown, problems: Problem[]): SimulationParams | undefined {
  if (!isObj(raw)) {
    problems.push({ text: 'Simulation: the section must be an object (found: ' + showFound(raw) + ')', technical: 'simParams' });
    return undefined;
  }
  const c = new Check('Simulation', 'simParams', LABELS.simParams);
  const o: Obj = { ...DEFAULT_SIM_PARAMS, ...raw };
  c.int(o, 'seed', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER); // the screen has no limit; the engine floors the seed and mixes it with 32-bit ops
  c.int(o, 'maxHCSearch', 1, 100000);
  c.int(o, 'replications', 1, 10000);
  c.optEnum(o, 'queueArchitecture', ['pooled', 'siloed']);
  if (o.dispatchFairness !== undefined) {
    if (!isObj(o.dispatchFairness)) c.fail('dispatchFairness', 'must be an object', o.dispatchFairness);
    else {
      const f = o.dispatchFairness;
      const fc = new Check('Simulation > Fair agent assignment', 'simParams.dispatchFairness', LABELS.simParams);
      fc.optBool(f, 'enabled');
      fc.optBool(f, 'resetDaily');
      fc.optNum(f, 'utilTolerancePp', 0, 100);
      fc.optNum(f, 'countTolerance', 0, 1e6);
      fc.optNum(f, 'workloadToleranceMin', 0, 1e6);
      c.problems.push(...fc.problems);
    }
  }
  problems.push(...c.problems);
  return c.problems.length === 0 ? (o as unknown as SimulationParams) : undefined;
}

function validateColumnMapping(raw: unknown): ColumnMapping | undefined {
  if (!isObj(raw)) return undefined;
  if (typeof raw.intervalStartCol !== 'string' || typeof raw.volumeCol !== 'string') return undefined;
  for (const k of ['timeCol', 'categoryCol', 'intervalEndCol']) {
    if (raw[k] !== undefined && typeof raw[k] !== 'string') return undefined;
  }
  return raw as unknown as ColumnMapping;
}

const CORE_KEYS = ['calendar', 'labor', 'sla', 'categories', 'simParams'] as const;

export function validateImportedConfig(json: unknown): ConfigImportResult {
  if (!isObj(json)) {
    return { ok: false, problems: ['The file must contain a settings object (a JSON { … } block), not a list, number or text.'], technical: [''] };
  }
  const present = CORE_KEYS.filter((k) => json[k] !== undefined && json[k] !== null);
  if (present.length === 0) {
    return { ok: false, problems: ['No settings found: expected at least one of calendar, labor, sla, categories, simParams.'], technical: [''] };
  }
  const problems: Problem[] = [];
  const value: ImportedConfig = {};
  if (present.includes('calendar')) value.calendar = validateCalendar(json.calendar, problems);
  if (present.includes('labor')) value.labor = validateLabor(json.labor, problems);
  if (present.includes('sla')) value.sla = validateSla(json.sla, problems);
  if (present.includes('categories')) value.categories = validateCategories(json.categories, problems);
  if (present.includes('simParams')) value.simParams = validateSimParams(json.simParams, problems);
  if (problems.length > 0) return { ok: false, problems: problems.map((p) => p.text), technical: problems.map((p) => p.technical) };

  const notes: string[] = [];
  if (json.columnMapping !== undefined && json.columnMapping !== null) {
    const m = validateColumnMapping(json.columnMapping);
    if (m) value.columnMapping = m;
    else notes.push('columnMapping was not valid and was ignored (the current column mapping is unchanged).');
  }
  return { ok: true, value, applied: [...present, ...(value.columnMapping ? ['columnMapping'] : [])], notes };
}
