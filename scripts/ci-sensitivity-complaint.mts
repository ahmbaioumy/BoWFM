import { readFileSync, writeFileSync } from 'node:fs';
import { parseCSVRaw, mapRawRecordsToIntervals } from '../src/utils/csv-parser';
import {
  evaluateCandidateStatistical,
  generatePrecomputedReplications,
  getTCrit,
} from '../src/utils/hc-search';
import { getCalendarWorkingDaysInHorizon } from '../src/utils/calendar';
import type { CalendarConfig, CategoryConfig, LaborConfig, SLAPolicyConfig } from '../src/types/wfm';

const cal: CalendarConfig = {
  workingDays: [1, 2, 3, 4, 5],
  dailyOpenHour: 8,
  dailyOpenMinute: 0,
  dailyCloseHour: 22,
  dailyCloseMinute: 0,
  holidays: [],
};

const labor: LaborConfig = {
  dailyProductiveHours: 8,
  adherencePct: 0.98,
  workingDaysPerWeek: 6,
  offDaysPerWeek: 1,
  contractualHoursSource: 'derived',
  shifts: [],
};

const categories: CategoryConfig[] = [
  { id: 'cat_hs_billing', name: 'HS-Billing', ahtMinutes: 30, shrinkagePct: 0.3, priority: 1, primaryPct: 80, primaryWindow: 3, primaryUnit: 'hours' },
  { id: 'cat_hs_tech', name: 'HS-Tech', ahtMinutes: 30, shrinkagePct: 0.3, priority: 2, primaryPct: 80, primaryWindow: 5, primaryUnit: 'days' },
  { id: 'cat_ms_billing', name: 'MS-Billing', ahtMinutes: 30, shrinkagePct: 0.3, priority: 3, primaryPct: 80, primaryWindow: 2, primaryUnit: 'hours' },
  { id: 'cat_ms_tech', name: 'MS-Tech', ahtMinutes: 30, shrinkagePct: 0.3, priority: 4, primaryPct: 80, primaryWindow: 6, primaryUnit: 'hours' },
];

const rawCSV = readFileSync('test_complaint.csv', 'utf8');
const parsedRaw = parseCSVRaw(rawCSV);
let intervals = mapRawRecordsToIntervals(parsedRaw.rows, {
  intervalStartCol: 'Date',
  timeCol: 'time',
  volumeCol: 'Offered',
  categoryCol: 'Seg',
});

// Keep first 7 calendar days to keep DES tractable while preserving multi-seg shape
const dayKeys = [...new Set(intervals.map((i) => i.start.toISOString().slice(0, 10)))].sort();
const keepDays = new Set(dayKeys.slice(0, 7));
intervals = intervals.filter((i) => keepDays.has(i.start.toISOString().slice(0, 10)));

let minStartMs = Infinity;
let maxEndMs = -Infinity;
for (const it of intervals) {
  minStartMs = Math.min(minStartMs, it.start.getTime());
  maxEndMs = Math.max(maxEndMs, (it.end ?? new Date(it.start.getTime() + 30 * 60000)).getTime());
}
const horizonStart = new Date(minStartMs);
const horizonEnd = new Date(maxEndMs);
const workingDays = Math.max(1, getCalendarWorkingDaysInHorizon(horizonStart, horizonEnd, cal));

let totalWorkloadHours = 0;
for (const it of intervals) {
  const cat = categories.find((c) => c.name === it.category);
  totalWorkloadHours += (it.volume * (cat?.ahtMinutes ?? 30)) / 60;
}
const nMin = Math.max(1, Math.ceil(totalWorkloadHours / (1.0 * labor.dailyProductiveHours * labor.adherencePct * workingDays)));

const R = 8;
const seed = 12345;
const baseSla: SLAPolicyConfig = {
  primaryPct: 80,
  primaryWindow: 6,
  primaryUnit: 'hours',
  boAsaEnabled: false,
  boAsaTarget: 60,
  boAsaUnit: 'minutes',
  asaClockBasis: 'business_window',
  clockBasis: 'business_time',
  clockStartPolicy: 'arrival',
  occupancyCapEnabled: false,
  occupancyCapPct: 85,
  confidenceLevelPct: 95,
};

const t0 = Date.now();
const precomputed = generatePrecomputedReplications({
  intervals,
  openingWIP: [],
  categories,
  calendar: cal,
  sla: baseSla,
  baseSeed: seed,
  replications: R,
});
const lines: string[] = [];
lines.push(
  `days=${keepDays.size} intervals=${intervals.length} workloadH=${totalWorkloadHours.toFixed(1)} workingDays=${workingDays} N_min=${nMin} R=${R} precomputeMs=${Date.now() - t0}`
);
lines.push(`tCrit df=${R - 1}: ` + [50, 80, 90, 95, 99, 99.5, 99.9].map((c) => `${c}%=>${getTCrit(R - 1, c).toFixed(4)}`).join(' '));
writeFileSync('ci-sensitivity-out.txt', lines.join('\n') + '\n', 'utf8');

const levels = [50, 80, 90, 95, 99, 99.5, 99.9];
for (const conf of levels) {
  const sla = { ...baseSla, confidenceLevelPct: conf };
  const t1 = Date.now();
  const ev = evaluateCandidateStatistical({
    operationalHC: nMin,
    intervals,
    openingWIP: [],
    categories,
    calendar: cal,
    labor,
    sla,
    baseSeed: seed,
    replications: R,
    queueArchitecture: 'pooled',
    precomputedCaseSets: precomputed,
  });
  const ps = ev.primaryStats;
  lines.push(
    JSON.stringify({
      CI: conf,
      t: Number(getTCrit(R - 1, conf).toFixed(4)),
      ms: Date.now() - t1,
      N: nMin,
      pass: ev.passesAllConstraints,
      passPrimary: ev.passesPrimaryCI,
      ciLow: ps.ci95Low,
      ciHigh: ps.ci95High,
      median: ps.achievedPctMedian,
      mean: ps.achievedPctMean,
      stdDev: ps.stdDev,
      halfWidth: Number(((ps.ci95High - ps.ci95Low) / 2).toFixed(3)),
      reasons: ev.failingReasons,
    })
  );
  writeFileSync('ci-sensitivity-out.txt', lines.join('\n') + '\n', 'utf8');
}

if (nMin > 1) {
  const sla = { ...baseSla, confidenceLevelPct: 50 };
  const ev = evaluateCandidateStatistical({
    operationalHC: nMin - 1,
    intervals,
    openingWIP: [],
    categories,
    calendar: cal,
    labor,
    sla,
    baseSeed: seed,
    replications: R,
    queueArchitecture: 'pooled',
    precomputedCaseSets: precomputed,
  });
  lines.push(
    JSON.stringify({
      note: 'N_min-1 at CI=50% (search never tests below N_min)',
      N: nMin - 1,
      pass: ev.passesAllConstraints,
      passPrimary: ev.passesPrimaryCI,
      ciLow: ev.primaryStats.ci95Low,
      median: ev.primaryStats.achievedPctMedian,
      stdDev: ev.primaryStats.stdDev,
      reasons: ev.failingReasons,
    })
  );
  writeFileSync('ci-sensitivity-out.txt', lines.join('\n') + '\n', 'utf8');
}

process.stdout.write(lines.join('\n') + '\n');
