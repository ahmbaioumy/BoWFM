/**
 * Regression suite: (A) export timestamps == on-screen timestamps, (B) agent analytics.
 *
 * (A) Bug: case/slice exports wrote Date#toISOString() (UTC, trailing Z) while the screen showed
 *     local time via formatDateTime24 — a planner at UTC+4 saw 08:18 on screen and 04:18Z in Excel.
 * (B) src/utils/agent-analytics.ts: metrics, filters, bucketing, determinism.
 *
 * Run: npx tsx scripts/verify-agent-analytics.mts
 */

// DST-free fixed offset (UTC+4, no daylight saving) so the offset assertions are meaningful on any
// machine. Must be set before any Date is constructed.
process.env.TZ = 'Etc/GMT-4';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { formatDate24, formatDateTime24 } from '../src/utils/calendar';
import { buildExcelCSV, discoverAndSyncCategories, mapRawRecordsToIntervals } from '../src/utils/csv-parser';
import { buildBreachExportRows, buildCaseExportRows, buildSliceExportRows } from '../src/utils/export-rows';
import { runBackofficeDES } from '../src/utils/des-engine';
import {
  buildAgentAnalyticsExport,
  buildAgentInsights,
  computeAgentAnalytics,
  sortRowsByCases,
} from '../src/utils/agent-analytics';
import { buildSampleDataset } from '../src/utils/sample-data';
import { DEFAULT_CALENDAR, DEFAULT_CATEGORIES, DEFAULT_LABOR, DEFAULT_SIM_PARAMS, DEFAULT_SLA } from '../src/utils/default-config';
import type { CalendarConfig, CategoryConfig, LaborConfig, ShiftDistributionByCategory, SLAPolicyConfig, StandardInterval } from '../src/types/wfm';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail = '') {
  if (cond) {
    console.log(`  ✓ PASS: ${name}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${name}${detail ? ` - ${detail}` : ''}`);
    failed++;
  }
}
const approx = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

// ------------------------------------------------------------------------------------------
console.log('\n--- Suite EX: export timestamps match the screen ---');
{
  assert(new Date().getTimezoneOffset() === -240, 'EX.0 fixture TZ is UTC+4 (DST-free)', `offset=${new Date().getTimezoneOffset()}`);

  // Concrete reported case: 08:18 local on screen was exported as 04:18Z.
  const arrival = new Date(2026, 9, 5, 8, 18, 1, 986);
  const screen = formatDateTime24(arrival);
  assert(screen === '2026-10-05 08:18', 'EX.1 screen formatter shows local 2026-10-05 08:18', screen);
  assert(arrival.toISOString() === '2026-10-05T04:18:01.986Z', 'EX.1b (control) the OLD export value was UTC 04:18:01.986Z — 4h behind the screen', arrival.toISOString());

  const csv = buildExcelCSV([{ Arrival: arrival }]);
  const cell = csv.split('\r\n')[1];
  assert(cell === `"${screen}"`, 'EX.2 exported Date cell == screen formatter output', cell);
  assert(!/[TZ]/.test(cell.replace(/"/g, '')), 'EX.2b exported cell has no ISO "T" separator and no "Z"', cell);
  assert(csv.startsWith('﻿') && csv.includes('\r\n'), 'EX.3 UTF-8 BOM + CRLF preserved (Excel-friendly)');

  // Midnight-crossing: 23:50 local (= 19:50Z same day) and 00:20 next day (= 20:20Z previous day).
  const before = new Date(2026, 9, 5, 23, 50, 0, 0);
  const after = new Date(2026, 9, 6, 0, 20, 0, 0);
  const csv2 = buildExcelCSV([{ From: before, To: after }]).split('\r\n')[1];
  assert(csv2 === `"${formatDateTime24(before)}","${formatDateTime24(after)}"` && csv2 === '"2026-10-05 23:50","2026-10-06 00:20"', 'EX.4 midnight-crossing slice keeps local dates (23:50 -> next-day 00:20)', csv2);
  // A UTC export would put a 00:30 local case on the PREVIOUS calendar day: guard the date part too.
  const early = new Date(2026, 9, 6, 0, 30, 0, 0);
  assert(buildExcelCSV([{ T: early }]).includes('2026-10-06 00:30') && early.toISOString().startsWith('2026-10-05'), 'EX.5 00:30 local exports on its own local date (UTC would say the previous day)');

  // Real engine output: every timestamp cell of the case/breach/slice exports equals the screen formatter.
  const { rows } = buildSampleDataset('support', new Date(2026, 9, 5, 8, 0, 0, 0));
  const intervals = mapRawRecordsToIntervals(rows, { intervalStartCol: 'IntervalStart', volumeCol: 'Volume', categoryCol: 'Category' } as any);
  const categories = discoverAndSyncCategories(intervals, DEFAULT_CATEGORIES, DEFAULT_SLA);
  const des = runBackofficeDES({ operationalHC: 21, intervals, openingWIP: [], categories, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: DEFAULT_SLA, seed: DEFAULT_SIM_PARAMS.seed, queueArchitecture: 'siloed' });
  const caseRows = buildCaseExportRows(des.caseResults);
  let mismatches = 0;
  des.caseResults.forEach((c, i) => {
    const r = caseRows[i];
    if (r['Arrival Time'] !== formatDateTime24(c.arrival) || r['Primary Deadline'] !== formatDateTime24(c.primaryDeadline) ||
        r['Latest Safe Start'] !== formatDateTime24(c.latestSafeStart) || r['Clock Start'] !== formatDateTime24(c.clockStart) ||
        r['First Start Time'] !== (c.firstStartTime ? formatDateTime24(c.firstStartTime) : 'UNSTARTED') ||
        r['Complete Time'] !== (c.completeTime ? formatDateTime24(c.completeTime) : 'UNFINISHED')) mismatches++;
  });
  assert(des.caseResults.length > 100 && mismatches === 0, `EX.6 all ${des.caseResults.length} exported case rows match the screen formatter`, `${mismatches} mismatches`);
  const sample = des.caseResults[0];
  assert(caseRows[0]['Arrival Time'] === formatDateTime24(sample.arrival) && !String(caseRows[0]['Arrival Time']).includes('Z'), `EX.6b case ${sample.caseId}: export "${caseRows[0]['Arrival Time']}" == screen "${formatDateTime24(sample.arrival)}" (UTC would be ${sample.arrival.toISOString()})`);
  const breachRows = buildBreachExportRows(des.caseResults.slice(0, 50));
  assert(breachRows.every((r, i) => r['Arrival Time'] === formatDateTime24(des.caseResults[i].arrival)), 'EX.7 breach export uses the same formatter');
  const sliceRows = buildSliceExportRows(des.agentTimeline.slice(0, 500), 10);
  assert(sliceRows.every((r, i) => r.From === formatDateTime24(des.agentTimeline[i].from) && r.To === formatDateTime24(des.agentTimeline[i].to) && !('From ISO' in r)), 'EX.8 slice export From/To == screen formatter; UTC "ISO" columns removed');

  // Static guard: nothing in the results/export path may reintroduce UTC ISO output.
  const srcOf = (f: string) => readFileSync(resolve(import.meta.dirname, '..', f), 'utf8');
  const bad = ['src/components/ResultsFlow.tsx', 'src/components/DataTable.tsx', 'src/components/AgentAnalyticsPanel.tsx', 'src/utils/export-rows.ts', 'src/utils/agent-analytics.ts']
    .filter((f) => /toISOString\(/.test(srcOf(f)));
  assert(bad.length === 0, 'EX.9 no toISOString() in results UI / export builders', bad.join(', '));
  const exporterSrc = srcOf('src/utils/csv-parser.ts');
  const exporterBody = exporterSrc.slice(exporterSrc.indexOf('function csvCell'));
  assert(!/toISOString/.test(exporterBody), 'EX.10 the shared Excel exporter does not use toISOString');
}

// ------------------------------------------------------------------------------------------
console.log('\n--- Suite AA: agent analytics ---');
{
  const { rows } = buildSampleDataset('support', new Date(2026, 9, 5, 8, 0, 0, 0));
  const intervals = mapRawRecordsToIntervals(rows, { intervalStartCol: 'IntervalStart', volumeCol: 'Volume', categoryCol: 'Category' } as any);
  const categories = discoverAndSyncCategories(intervals, DEFAULT_CATEGORIES, DEFAULT_SLA);
  const run = (arch: 'pooled' | 'siloed', hc: number) => runBackofficeDES({ operationalHC: hc, intervals, openingWIP: [], categories, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: DEFAULT_SLA, seed: DEFAULT_SIM_PARAMS.seed, queueArchitecture: arch });
  const des = run('siloed', 21);
  const cal = DEFAULT_CALENDAR;
  const lab = DEFAULT_LABOR;
  const a = computeAgentAnalytics({ des, calendar: cal, labor: lab });
  const fair = des.agentFairness!.perAgent;

  assert(a.rows.length === 21 && a.rows.every((r, i) => r.agentId === i), 'AA.1 one row per agent, ascending id');
  assert(a.rows.reduce((s, r) => s + r.casesCompleted, 0) === des.completedCases, 'AA.2 handled cases sum to completedCases (no split double-count)', `${a.rows.reduce((s, r) => s + r.casesCompleted, 0)} vs ${des.completedCases}`);
  assert(approx(a.rows.reduce((s, r) => s + r.busyMin, 0), des.totalHandlingMinutes, 0.01), 'AA.3 busy minutes sum to totalHandlingMinutes');
  assert(a.rows.every((r, i) => r.casesCompleted === fair[i].casesCompleted), 'AA.4 per-agent handled == agentFairness.casesCompleted');
  assert(a.rows.every((r, i) => approx(r.utilisationPct, fair[i].utilPct, 0.01)), 'AA.5 whole-run utilisation == fairness panel utilisation (uniform shifts)', a.rows.map((r, i) => `${r.utilisationPct.toFixed(2)}/${fair[i].utilPct.toFixed(2)}`).slice(0, 3).join(' '));
  assert(a.rows.every((r) => approx(r.availableMin, r.busyMin + r.idleMin) && r.scheduledMin >= r.availableMin - 1e-9 && r.occupancyPct >= r.utilisationPct - 1e-9), 'AA.6 available = busy+idle; scheduled >= available; occupancy >= utilisation');
  assert(a.rows.every((r) => r.casesHandedOver <= r.casesTouched && r.casesTouched >= 0), 'AA.7 touched >= handed over');
  assert(a.rows.some((r) => r.occupancyPct - r.utilisationPct > 0.5), 'AA.8 occupancy and utilisation differ where the daily budget is exhausted before shift end');
  assert(a.rows.every((r) => r.cohortStart === '08:00' && !r.isLateShift) && a.earliestCohortStart === '08:00', 'AA.9 uniform run: one 08:00 cohort, nobody flagged late');
  assert(a.matrix.every((row, i) => row.reduce((x, y) => x + y, 0) === a.rows[i].casesCompleted), 'AA.10 matrix row sums == handled');
  const byDate = new Map<string, number>();
  for (const c of des.caseResults) if (c.isCompleted && c.completeTime) byDate.set(formatDate24(c.completeTime), (byDate.get(formatDate24(c.completeTime)) || 0) + 1);
  assert(a.dates.every((d, j) => a.matrix.reduce((s, row) => s + row[j], 0) === (byDate.get(d) || 0)), 'AA.11 matrix column sums == completions bucketed by calendar date');
  assert(!a.dates.includes('2026-10-10') && !a.dates.includes('2026-10-11'), 'AA.12 weekend (no on-shift agents) dates are not active dates');

  // Date filter: whole == part1 + part2, and single day.
  const mid = a.dates[Math.floor(a.dates.length / 2)];
  const next = a.dates[Math.floor(a.dates.length / 2) + 1];
  const p1 = computeAgentAnalytics({ des, calendar: cal, labor: lab, filter: { toDate: mid } });
  const p2 = computeAgentAnalytics({ des, calendar: cal, labor: lab, filter: { fromDate: next } });
  assert(p1.team.casesTotal + p2.team.casesTotal === a.team.casesTotal && approx(p1.team.busyMin + p2.team.busyMin, a.team.busyMin, 0.01) && approx(p1.team.availableMin + p2.team.availableMin, a.team.availableMin, 0.01), 'AA.13 disjoint date ranges add up to the full run (cases, busy, available)');
  const one = computeAgentAnalytics({ des, calendar: cal, labor: lab, filter: { fromDate: mid, toDate: mid } });
  assert(one.dates.length === 1 && one.dates[0] === mid && one.team.casesTotal === (byDate.get(mid) || 0), 'AA.14 single-day filter returns that day only', `${one.dates} ${one.team.casesTotal}`);
  const none = computeAgentAnalytics({ des, calendar: cal, labor: lab, filter: { fromDate: '2030-01-01' } });
  assert(none.dates.length === 0 && none.team.casesTotal === 0 && none.trend.length === 0, 'AA.15 out-of-horizon range is empty, not an error');

  // Category filter (siloed).
  const cats = a.categories;
  const c0 = cats[0];
  const cf = computeAgentAnalytics({ des, calendar: cal, labor: lab, filter: { category: c0 } });
  assert(cf.rows.length > 0 && cf.rows.length < a.rows.length && cf.rows.every((r) => r.category === c0), 'AA.16 siloed category filter keeps only that category\'s agents');
  assert(cf.team.casesTotal === des.categoryStats[c0].completed, 'AA.17 siloed category filter cases == categoryStats completed', `${cf.team.casesTotal} vs ${des.categoryStats[c0].completed}`);
  // Pooled: category restricts the WORK counted, all agents stay.
  const dp = run('pooled', 12);
  const ap = computeAgentAnalytics({ des: dp, calendar: cal, labor: lab });
  const apc = computeAgentAnalytics({ des: dp, calendar: cal, labor: lab, filter: { category: c0 } });
  assert(apc.rows.length === ap.rows.length && apc.team.casesTotal === dp.categoryStats[c0].completed && apc.team.busyMin < ap.team.busyMin, 'AA.18 pooled category filter counts only that category\'s work across all agents');

  // Agent filter.
  const af = computeAgentAnalytics({ des, calendar: cal, labor: lab, filter: { agentIds: [5, 2, 9] } });
  assert(af.rows.map((r) => r.agentId).join(',') === '2,5,9' && af.matrix.length === 3, 'AA.19 agent multi-select keeps chosen agents in id order');
  const af2 = computeAgentAnalytics({ des, calendar: cal, labor: lab, filter: { agentIds: [3], fromDate: mid, toDate: mid } });
  assert(af2.rows.length === 1 && af2.rows[0].casesCompleted === af2.matrix[0][0], 'AA.20 filters combine (agent + date)');

  // Determinism + deterministic sort.
  assert(JSON.stringify(computeAgentAnalytics({ des, calendar: cal, labor: lab })) === JSON.stringify(a), 'AA.21 identical inputs give byte-identical output');
  const tie = sortRowsByCases([{ ...a.rows[3], casesCompleted: 5 }, { ...a.rows[1], casesCompleted: 5 }, { ...a.rows[2], casesCompleted: 9 }]);
  assert(tie.map((r) => r.agentId).join(',') === '2,1,3', 'AA.22 bar-chart sort: cases desc, ties by agent id asc');

  // Trend band.
  assert(a.trend.length === a.dates.length && a.trend.every((p) => p.min <= p.avg + 1e-9 && p.avg <= p.max + 1e-9 && p.agents > 0), 'AA.23 daily trend: min <= avg <= max for every date');

  // Insights are computed, not canned.
  const ins = buildAgentInsights(a);
  assert(ins.length >= 3 && ins.some((t) => t.includes('Most loaded')) && ins.some((t) => t.includes('Jain')), 'AA.24 insights include load extremes and fairness metrics');
  assert(buildAgentInsights(cf).join('|') !== ins.join('|'), 'AA.25 insights change with the filter (computed from the filtered data)');
  assert(buildAgentInsights(computeAgentAnalytics({ des, calendar: cal, labor: lab, filter: { agentIds: [], category: 'nope' } }))[0].startsWith('No agents'), 'AA.26 empty selection yields a plain "No agents" message');

  // Export: two tables, dates formatted local, BOM.
  const ex = buildAgentAnalyticsExport(a);
  const text = buildExcelCSV([], ex.sections);
  assert(text.startsWith('﻿"Agent summary') && text.includes('"Cases completed per agent per date') && text.split('\r\n').length > 2 * a.rows.length, 'AA.27 export has summary + matrix sections in one Excel-friendly file');
  assert(ex.sections[1].rows[0][a.dates[0]] !== undefined && ex.sections[1].rows.length === a.rows.length && a.dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)), 'AA.28 matrix headers are local YYYY-MM-DD dates');

  // Staggered cohorts: late-coverage agents are detected and the end-of-day share is computed.
  const BIZ: CalendarConfig = { workingDays: [1, 2, 3, 4, 5], dailyOpenHour: 9, dailyOpenMinute: 0, dailyCloseHour: 17, dailyCloseMinute: 0, holidays: [] };
  const LAB: LaborConfig = { dailyProductiveHours: 6, adherencePct: 1.0, workingDaysPerWeek: 5, offDaysPerWeek: 2, contractualHoursSource: 'derived', shifts: [] };
  const SLA: SLAPolicyConfig = {
    primaryPct: 80, primaryWindow: 3, primaryUnit: 'days', boAsaEnabled: false, boAsaTarget: 60, boAsaUnit: 'minutes',
    asaClockBasis: 'business_window', clockBasis: 'business_time', clockStartPolicy: 'arrival',
    occupancyCapEnabled: false, occupancyCapPct: 100, confidenceLevelPct: 95,
  };
  const cat: CategoryConfig[] = [{ id: 'g', name: 'General', ahtMinutes: 20, shrinkagePct: 0.2, priority: 1 }];
  const iv: StandardInterval[] = [];
  let idx = 0;
  for (let d = 0; d < 10; d++) {
    if (!BIZ.workingDays.includes(new Date(2026, 9, 5 + d).getDay())) continue;
    for (let h = 9; h < 17; h++) for (const m of [0, 30]) iv.push({ intervalIndex: idx++, start: new Date(2026, 9, 5 + d, h, m), end: new Date(2026, 9, 5 + d, h, m + 30), volume: 6, category: 'General' });
  }
  const dist: ShiftDistributionByCategory = { __POOLED__: { slapMinutes: 30, slaps: [{ startMinutesFromOpen: 0, agentCount: 6 }, { startMinutesFromOpen: 120, agentCount: 2 }] } };
  const sd = runBackofficeDES({ operationalHC: 8, intervals: iv, openingWIP: [], categories: cat, calendar: BIZ, labor: LAB, sla: SLA, seed: 42, shiftDistribution: dist });
  const sa = computeAgentAnalytics({ des: sd, calendar: BIZ, labor: LAB });
  const lateAgents = sa.rows.filter((r) => r.isLateShift);
  assert(sa.earliestCohortStart === '09:00' && lateAgents.length === 2 && lateAgents.every((r) => r.cohortStart === '11:00'), 'AA.29 staggered run: 6 agents at 09:00, 2 flagged late at 11:00', JSON.stringify(sa.rows.map((r) => r.cohortStart)));
  const lateShare = lateAgents.reduce((s, r) => s + r.lateWindowBusyMin, 0);
  const allLate = sa.rows.reduce((s, r) => s + r.lateWindowBusyMin, 0);
  assert(allLate > 0 && lateShare / allLate > 2 / 8, 'AA.30 late cohort does a larger-than-headcount share of last-2h work', `${lateShare}/${allLate}`);
  assert(sa.rows.every((r) => r.scheduledMin >= r.availableMin - 1e-9), 'AA.31 staggered: scheduled >= available');
  assert(buildAgentInsights(sa).some((t) => t.includes('late-coverage')), 'AA.32 insights call out late-coverage agents');
}

console.log('\n==================================================');
console.log(` RESULTS: ${passed} PASSED, ${failed} FAILED`);
console.log('==================================================\n');
if (failed > 0) process.exitCode = 1;
