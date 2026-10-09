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
  buildAgentAnalyticsNotes,
  buildAgentInsights,
  computeAgentAnalytics,
  sortRowsByCases,
  utilisationReadsLowByDesign,
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
  assert(a.rows.every((r, i) => approx(r.utilisationPct, fair[i].utilPct, 0.01)), 'AA.5 fixture check: on this uniform, budget-exhausting run scheduled-based utilisation equals the engine on-shift busy/available (not a general identity)', a.rows.map((r, i) => `${r.utilisationPct.toFixed(2)}/${fair[i].utilPct.toFixed(2)}`).slice(0, 3).join(' '));
  assert(a.rows.every((r) => approx(r.availableMin, r.busyMin + r.idleMin) && r.scheduledMin >= r.availableMin - 1e-9 && r.occupancyPct >= r.utilisationPct - 1e-9), 'AA.6 available = busy+idle; scheduled >= available; occupancy >= utilisation');
  assert(a.rows.every((r) => r.casesHandedOver <= r.casesTouched && r.casesTouched >= 0), 'AA.7 touched >= handed over');
  // Updated 2026-10-08 (P2-9: non-24x7 runs without a start distribution now end each agent's shift dailyProductiveHours after
  // open). Was 'occupancy and utilisation differ where the daily budget is exhausted before shift end' (some agent > 0.5 points
  // apart). This default uniform fixture (08:00-18:00, 7.5 h, adherence 1.0, no distribution) is now a fixed-shift run: scheduled
  // is capped at the agent's own 450-min shift and adherence 1.0 loses no productive time, so occupancy == utilisation.
  assert(a.rows.every((r) => Math.abs(r.occupancyPct - r.utilisationPct) < 0.5), 'AA.8 uniform default fixture is a fixed-shift run at adherence 1.0: occupancy == utilisation for every agent', a.rows.map((r) => `${r.occupancyPct.toFixed(1)}/${r.utilisationPct.toFixed(1)}`).join(' '));
  assert(a.rows.every((r) => r.cohortStart === '08:00' && !r.isLateShift) && a.earliestCohortStart === '08:00', 'AA.9 uniform run: one 08:00 cohort, nobody flagged late');
  // Definition change (work share): matrix cells are fractional work share, not finisher counts.
  assert(a.matrix.every((row, i) => approx(row.reduce((x, y) => x + y, 0), a.rows[i].workShare, 1e-6)) && approx(a.rows.reduce((s, r) => s + r.workShare, 0), des.completedCases, 1e-6), 'AA.10 matrix row sums == work share; total work share == completed cases');
  const byDate = new Map<string, number>();
  for (const c of des.caseResults) if (c.isCompleted && c.completeTime) byDate.set(formatDate24(c.completeTime), (byDate.get(formatDate24(c.completeTime)) || 0) + 1);
  // Definition change: work share is bucketed by the date of each busy slice, so column sums are no longer completions-by-date (whole run still equals completed cases).
  assert(approx(a.matrix.reduce((s, row) => s + row.reduce((x, y) => x + y, 0), 0), des.completedCases, 1e-6) && a.matrix.every((row) => row.every((v) => v >= 0)), 'AA.11 matrix (work share by slice date) totals completed cases');
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
  assert(af2.rows.length === 1 && approx(af2.rows[0].workShare, af2.matrix[0][0]), 'AA.20 filters combine (agent + date)');

  // Determinism + deterministic sort.
  assert(JSON.stringify(computeAgentAnalytics({ des, calendar: cal, labor: lab })) === JSON.stringify(a), 'AA.21 identical inputs give byte-identical output');
  // sortRowsByCases orders by workShare (not casesCompleted), so the test sets workShare; casesCompleted is left as it is.
  const tie = sortRowsByCases([{ ...a.rows[3], workShare: 5 }, { ...a.rows[1], workShare: 5 }, { ...a.rows[2], workShare: 9 }]);
  assert(tie.map((r) => r.agentId).join(',') === '2,1,3', 'AA.22 bar-chart sort: cases desc, ties by agent id asc');

  // Trend band.
  assert(a.trend.length === a.dates.length && a.trend.every((p) => p.min <= p.avg + 1e-9 && p.avg <= p.max + 1e-9 && p.agents > 0), 'AA.23 daily trend: min <= avg <= max for every date');

  // Insights are computed, not canned.
  const ins = buildAgentInsights(a, {}, true); // showUtilisation = true: keeps the retained utilisation wording covered (hidden by default, 2026-10-09)
  assert(ins.length >= 3 && ins.some((t) => t.includes('Most loaded')) && ins.some((t) => t.includes('Jain')), 'AA.24 insights include load extremes and fairness metrics');
  assert(buildAgentInsights(cf).join('|') !== ins.join('|'), 'AA.25 insights change with the filter (computed from the filtered data)');
  assert(buildAgentInsights(computeAgentAnalytics({ des, calendar: cal, labor: lab, filter: { agentIds: [], category: 'nope' } }))[0].startsWith('No agents'), 'AA.26 empty selection yields a plain "No agents" message');

  // Export: two tables, dates formatted local, BOM.
  const ex = buildAgentAnalyticsExport(a, lab);
  const text = buildExcelCSV([], ex.sections);
  assert(text.startsWith('﻿"Agent summary') && text.includes('"Work share (cases) per agent per date') && text.split('\r\n').length > 2 * a.rows.length, 'AA.27 export has summary + matrix sections in one Excel-friendly file');
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
  // Every agent in a staggered run works a fixed shift of dailyProductiveHours (6h = 360 min) from their own start.
  const earlyAgents = sa.rows.filter((r) => !r.isLateShift);
  assert(earlyAgents.length === 6 && earlyAgents.every((r) => r.scheduledMin <= r.onShiftDays * 360 + 1e-6), 'AA.32b staggered 09:00-17:00 / 6h: early-cohort scheduled <= on-shift days x 360 (not to business close)', earlyAgents.map((r) => `${r.scheduledMin}/${r.onShiftDays}`).join(' '));

  // ---- Long-day staggered fixture: 08:00-22:00 (14h) calendar, 9 productive hours, 2 categories, pooled ----
  const LBIZ: CalendarConfig = { workingDays: [1, 2, 3, 4, 5], dailyOpenHour: 8, dailyOpenMinute: 0, dailyCloseHour: 22, dailyCloseMinute: 0, holidays: [] };
  const mkLab = (adh: number): LaborConfig => ({ dailyProductiveHours: 9, adherencePct: adh, workingDaysPerWeek: 5, offDaysPerWeek: 2, contractualHoursSource: 'derived', shifts: [] });
  const lcat: CategoryConfig[] = [
    { id: 'g', name: 'Gold', ahtMinutes: 20, shrinkagePct: 0.2, priority: 1 },
    { id: 's', name: 'Silver', ahtMinutes: 20, shrinkagePct: 0.2, priority: 1 },
  ];
  const liv: StandardInterval[] = [];
  let lidx = 0;
  for (let d = 0; d < 10; d++) {
    if (!LBIZ.workingDays.includes(new Date(2026, 9, 5 + d).getDay())) continue;
    for (let h = 8; h < 22; h++) {
      for (const m of [0, 30]) {
        for (const cn of ['Gold', 'Silver']) liv.push({ intervalIndex: lidx++, start: new Date(2026, 9, 5 + d, h, m), end: new Date(2026, 9, 5 + d, h, m + 30), volume: cn === 'Gold' ? 4 : 3, category: cn });
      }
    }
  }
  const ldist: ShiftDistributionByCategory = { __POOLED__: { slapMinutes: 30, slaps: [{ startMinutesFromOpen: 0, agentCount: 5 }, { startMinutesFromOpen: 300, agentCount: 3 }] } };
  const runLong = (adh: number, withDist = true) => runBackofficeDES({ operationalHC: 8, intervals: liv, openingWIP: [], categories: lcat, calendar: LBIZ, labor: mkLab(adh), sla: SLA, seed: 7, queueArchitecture: 'pooled', ...(withDist ? { shiftDistribution: ldist } : {}) });
  const ld = runLong(1.0);
  // Full in-horizon days only (Oct 6-13): excludes the first day and any post-horizon drain day.
  const FULL = { fromDate: '2026-10-06', toDate: '2026-10-13' };
  const la = computeAgentAnalytics({ des: ld, calendar: LBIZ, labor: mkLab(1.0) });
  const lf = computeAgentAnalytics({ des: ld, calendar: LBIZ, labor: mkLab(1.0), filter: FULL });
  const earlyL = la.rows.filter((r) => !r.isLateShift);
  const earlyF = lf.rows.filter((r) => !r.isLateShift);
  assert(earlyL.length === 5 && la.rows.filter((r) => r.isLateShift).length === 3, 'AA.33-pre long-day fixture: 5 agents at 08:00, 3 flagged late at 13:00', JSON.stringify(la.rows.map((r) => r.cohortStart)));
  assert(la.rows.every((r) => r.scheduledMin <= r.onShiftDays * 540 + 1e-6), 'AA.33 long-day staggered: every agent scheduled <= on-shift days x 540', la.rows.map((r) => `${r.scheduledMin}/${r.onShiftDays}`).join(' '));
  const lone = computeAgentAnalytics({ des: ld, calendar: LBIZ, labor: mkLab(1.0), filter: { fromDate: '2026-10-07', toDate: '2026-10-07', agentIds: [0] } });
  assert(lone.rows.length === 1 && lone.rows[0].onShiftDays === 1 && approx(lone.rows[0].scheduledMin, 540, 1e-6), 'AA.34 early-cohort agent on a full in-horizon day is scheduled exactly 540', `${lone.rows[0]?.scheduledMin}`);
  assert(lf.rows.every((r) => Math.abs(r.occupancyPct - r.utilisationPct) < 0.5), 'AA.35 adherence 1.0 staggered: occupancy == utilisation for every agent (full days)', lf.rows.map((r) => `${r.occupancyPct.toFixed(1)}/${r.utilisationPct.toFixed(1)}`).join(' '));
  const ld9 = runLong(0.9);
  const l9 = computeAgentAnalytics({ des: ld9, calendar: LBIZ, labor: mkLab(0.9), filter: FULL });
  const l9day = computeAgentAnalytics({ des: ld9, calendar: LBIZ, labor: mkLab(0.9), filter: { fromDate: '2026-10-07', toDate: '2026-10-07' } });
  assert(l9day.rows.every((r) => approx(r.scheduledMin, 540, 1e-6)), 'AA.36 adherence 0.9 staggered: scheduled is still 540 per full day', l9day.rows.map((r) => r.scheduledMin.toFixed(1)).join(' '));
  assert(l9.rows.some((r) => r.occupancyPct - r.utilisationPct > 0.5), 'AA.36b adherence 0.9 staggered: budget ends before the shift, so occupancy > utilisation for some agent (legitimate gap kept)', l9.rows.map((r) => `${r.occupancyPct.toFixed(1)}/${r.utilisationPct.toFixed(1)}`).join(' '));
  const lateUtilTxt = buildAgentInsights(lf, {}, true).find((t) => t.includes('late-coverage')) ?? '';
  const um = /Their utilisation is ([\d.]+)% vs ([\d.]+)%/.exec(lateUtilTxt);
  assert(!!um && Math.abs(Number(um[1]) - Number(um[2])) < 5, 'AA.37 insight: late vs earlier-start utilisation differ by < 5 points (adherence 1.0, full days)', lateUtilTxt);
  const gold = computeAgentAnalytics({ des: ld, calendar: LBIZ, labor: mkLab(1.0), filter: { category: 'Gold', ...FULL } });
  const goldGap = (r: { scheduledMin: number; availableMin: number; onShiftDays: number }) => (r.scheduledMin - r.availableMin) / Math.max(1, r.onShiftDays);
  const gEarly = gold.rows.filter((r) => !r.isLateShift);
  const gLate = gold.rows.filter((r) => r.isLateShift);
  assert(gEarly.length === 5 && gLate.length === 3 && [...gEarly, ...gLate].every((r) => goldGap(r) < 20), 'AA.38 pooled category filter: scheduled - available per day ~0 for early and late cohorts alike', [...gEarly, ...gLate].map((r) => goldGap(r).toFixed(0)).join(' '));
  assert(!!ld.shiftDistributionUsed && !runLong(1.0, false).shiftDistributionUsed, 'AA.39 a run with a shiftDistribution reports shiftDistributionUsed; a run without does not');

  // ---- Follow-ups: run facts, notes section, scheduled-minute pins ----
  const lastDataDay = formatDate24(liv[liv.length - 1].start);
  // Updated 2026-10-08 (P2-9): was a.staggered === false for the uniform run. The default non-24x7 uniform run is now a fixed-shift
  // run (des.fixedShifts), so the flag is true for it too; the false case moved to the 24x7 fixture below (AA.46).
  assert(la.staggered === true && a.staggered === true && ld.fixedShifts === true && des.fixedShifts === true, 'AA.40 staggered flag: true for the shift-placement run AND for the non-24x7 uniform run (fixed shifts, P2-9)');

  const expectedDrain = la.allDates.filter((d) => d > lastDataDay);
  assert(expectedDrain.length >= 1 && JSON.stringify(la.drainDates) === JSON.stringify(expectedDrain) && la.drainDates.every((d) => la.dates.includes(d)), 'AA.41 drainDates lists exactly the active dates after the last data day', `${la.drainDates} vs ${expectedDrain} (last data day ${lastDataDay})`);
  assert(lf.drainDates.length === 0 && a.drainDates.every((d) => a.dates.includes(d)), 'AA.41b drainDates is empty when the date filter excludes the post-data dates; entries always lie inside dates', `${lf.drainDates} | ${a.drainDates}`);
  const lastDayOnly = computeAgentAnalytics({ des: ld, calendar: LBIZ, labor: mkLab(1.0), filter: { fromDate: lastDataDay, toDate: lastDataDay } });
  assert(lastDayOnly.drainDates.length === 0 && computeAgentAnalytics({ des: ld, calendar: LBIZ, labor: mkLab(1.0), filter: { fromDate: expectedDrain[0] } }).drainDates.join() === expectedDrain.join(), 'AA.41c the last data day itself is not a drain date; a filter starting at the first post-data date keeps it');

  const goldPooled = computeAgentAnalytics({ des: ld, calendar: LBIZ, labor: mkLab(1.0), filter: { category: 'Gold' } });
  assert(apc.pooledCategoryFilter === true && goldPooled.pooledCategoryFilter === true && ap.pooledCategoryFilter === false && la.pooledCategoryFilter === false && cf.pooledCategoryFilter === false && a.pooledCategoryFilter === false, 'AA.42 pooledCategoryFilter true only for pooled run + category filter (false: pooled unfiltered, siloed + filter, siloed unfiltered)', JSON.stringify([apc.pooledCategoryFilter, goldPooled.pooledCategoryFilter, ap.pooledCategoryFilter, la.pooledCategoryFilter, cf.pooledCategoryFilter, a.pooledCategoryFilter]));

  const ex3 = buildAgentAnalyticsExport(la, mkLab(1.0));
  const exKeysOk = (ex3.sections[2]?.rows.length ?? 0) > 0 && ex3.sections[2].rows.every((r) => Object.keys(r).join() === 'Item,Note');
  assert(ex3.sections.length === 3 && ex3.sections[1].rows.length === la.rows.length && ex3.sections[1].rows[0][la.dates[0]] !== undefined && (ex3.sections[2]?.title ?? '').startsWith('Notes') && exKeysOk, 'AA.43 export has 3 sections: summary, matrix (index 1), Notes with Item/Note rows', ex3.sections.map((s) => s.title).join(' | '));
  assert(JSON.stringify(ex3.sections.slice(0, 2)) === JSON.stringify(buildAgentAnalyticsExport(la, mkLab(1.0)).sections.slice(0, 2)) && ex.sections.length === 3, 'AA.43b summary and matrix sections are deterministic and the uniform export also carries the notes section');

  const noteOf = (rows: Array<{ Item: string; Note: string }>, item: string) => rows.find((r) => r.Item === item)?.Note;
  const nStag = buildAgentAnalyticsNotes(la, mkLab(1.0), true); // showUtilisation = true: retained utilisation notes stay covered
  const nUni = buildAgentAnalyticsNotes(a, lab, true);
  const nFilt = buildAgentAnalyticsNotes(lf, mkLab(1.0), true);
  const nGold = buildAgentAnalyticsNotes(goldPooled, mkLab(1.0), true);
  // Updated 2026-10-08 (P2-9): the default uniform fixture is a fixed-shift run, so its Scheduled note now says fixed shift with the
  // 450-min figure (7.5 h) instead of 'business close'. The open-case wording ('around the clock', 'not an error') is pinned on the
  // 24x7 fixture below (AA.46-AA.46e).
  assert((noteOf(nStag, 'Scheduled (min)') ?? '').includes('fixed shift') && (noteOf(nStag, 'Scheduled (min)') ?? '').includes('540') && (noteOf(nUni, 'Scheduled (min)') ?? '').includes('fixed shift') && (noteOf(nUni, 'Scheduled (min)') ?? '').includes('450') && !(noteOf(nUni, 'Scheduled (min)') ?? '').includes('business close') && !/shift placement (on|off)/i.test(noteOf(nStag, 'Scheduled (min)') ?? '') && !/shift placement (on|off)/i.test(noteOf(nUni, 'Utilisation % vs Occupancy %') ?? ''), 'AA.44 Scheduled note follows what the run did (fixed shift + 540 min for the long-day run, fixed shift + 450 min for the default uniform run), not the Shift Placement switch', `${noteOf(nStag, 'Scheduled (min)')} || ${noteOf(nUni, 'Scheduled (min)')}`);
  assert(noteOf(nStag, 'Utilisation % vs Occupancy %') === noteOf(nUni, 'Utilisation % vs Occupancy %') && !(noteOf(nUni, 'Utilisation % vs Occupancy %') ?? '').includes('not an error') && (noteOf(nUni, 'Utilisation % vs Occupancy %') ?? '').startsWith('Normally the same number') && noteOf(nStag, 'On-Shift Days') !== undefined, 'AA.44b utilisation note is the same fixed-shift note for the uniform and shift-placement runs (no "not an error" caveat); On-Shift Days note present');
  const drainNote = noteOf(nStag, 'Part-day after the data ends');
  assert(!!drainNote && la.drainDates.every((d) => drainNote.includes(d)) && noteOf(nFilt, 'Part-day after the data ends') === undefined && (noteOf(nUni, 'Part-day after the data ends') !== undefined) === (a.drainDates.length > 0), 'AA.44c part-day note only when drainDates is non-empty, and it names the date(s)', drainNote ?? '');
  assert(noteOf(nGold, 'Category filter') !== undefined && noteOf(nStag, 'Category filter') === undefined && noteOf(buildAgentAnalyticsNotes(cf, lab, true), 'Category filter') === undefined && !(noteOf(nGold, 'Category filter') ?? '').includes('whole time on shift'), 'AA.44d category note only when pooledCategoryFilter; does not claim Available is the whole time on shift');
  const fullByAgent = new Map(la.rows.map((r) => [r.agentId, r]));
  const goldRows = goldPooled.rows.filter((r) => fullByAgent.has(r.agentId));
  assert(goldRows.length > 0 && goldRows.every((r) => { const f = fullByAgent.get(r.agentId)!; return r.availableMin < f.availableMin - 1e-6 && Math.abs(r.idleMin - f.idleMin) < 1e-6; }), 'AA.44f category filter on a pooled run: availableMin strictly below unfiltered, idleMin equal (pins the Category filter note)', goldRows.map((r) => `${r.agentId}: ${r.availableMin.toFixed(1)} vs ${fullByAgent.get(r.agentId)!.availableMin.toFixed(1)}, idle ${r.idleMin.toFixed(1)} vs ${fullByAgent.get(r.agentId)!.idleMin.toFixed(1)}`).join(' | '));
  assert(![...nStag, ...nUni, ...nGold].some((r) => /budget|staggered|in queue|drain|horizon/i.test(r.Note)), 'AA.44e notes avoid internal jargon (budget, staggered, in queue, drain, horizon)');

  // ---- 24x7 fixture without a start distribution (added 2026-10-08, P2-9): the one run that still has NO fixed shift end ----
  // Moved here from the default uniform fixture, which is now a fixed-shift run. 7 days round the clock, 3 cases/hour, AHT 30, 4 agents,
  // 8 h productive, adherence 1.0, no shiftDistribution: agents stay on around the clock, so Scheduled runs to the end of each day
  // (~1440 min on a full day) while Available is only the time in the queue; on 13 Oct occupancy is 41-45% vs utilisation 33.3% (busy / 1440).
  const CAL247: CalendarConfig = { is24x7: true, workingDays: [0, 1, 2, 3, 4, 5, 6], dailyOpenHour: 0, dailyOpenMinute: 0, dailyCloseHour: 24, dailyCloseMinute: 0, holidays: [] };
  const LAB247: LaborConfig = { dailyProductiveHours: 8, adherencePct: 1.0, workingDaysPerWeek: 5, offDaysPerWeek: 2, contractualHoursSource: 'derived', shifts: [] };
  const SLA247: SLAPolicyConfig = { ...SLA, primaryWindow: 24, primaryUnit: 'hours', clockBasis: 'wall_clock', minCoverageEnabled: false };
  const iv247: StandardInterval[] = [];
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) { const st = new Date(2026, 9, 12 + d, h, 0); iv247.push({ intervalIndex: iv247.length, start: st, end: new Date(st.getTime() + 3600000), volume: 3, category: 'General' }); }
  const des247 = runBackofficeDES({ operationalHC: 4, intervals: iv247, openingWIP: [], categories: [{ ...cat[0], ahtMinutes: 30 }], calendar: CAL247, labor: LAB247, sla: SLA247, seed: 7, queueArchitecture: 'pooled' });
  const a247 = computeAgentAnalytics({ des: des247, calendar: CAL247, labor: LAB247 });
  const n247 = buildAgentAnalyticsNotes(a247, LAB247, true);
  assert(des247.fixedShifts === false && a247.staggered === false && !des247.shiftDistributionUsed, 'AA.46 24x7 run without a start distribution: no fixed shifts (fixedShifts false, staggered false)', `fixedShifts=${des247.fixedShifts} staggered=${a247.staggered}`);
  assert(utilisationReadsLowByDesign(a247, LAB247, CAL247) === true && utilisationReadsLowByDesign(a, lab, cal) === false && utilisationReadsLowByDesign(la, mkLab(1.0), LBIZ) === false, 'AA.46b utilisationReadsLowByDesign: true for the 24x7 no-distribution run, false for the fixed-shift runs');
  const full247 = computeAgentAnalytics({ des: des247, calendar: CAL247, labor: LAB247, filter: { fromDate: '2026-10-13', toDate: '2026-10-13' } });
  assert(full247.rows.length === 4 && full247.rows.every((r) => r.scheduledMin > 1300 && r.scheduledMin <= 1440 + 1e-6 && r.occupancyPct - r.utilisationPct > 5), 'AA.46c 24x7 no-distribution: Scheduled runs around the clock (1300-1440 min on a full day) and occupancy sits >5 points above utilisation', full247.rows.map((r) => `${r.scheduledMin.toFixed(0)} ${r.occupancyPct.toFixed(1)}/${r.utilisationPct.toFixed(1)}`).join(' | '));
  const sch247 = noteOf(n247, 'Scheduled (min)') ?? '';
  const ut247 = noteOf(n247, 'Utilisation % vs Occupancy %') ?? '';
  assert(sch247.includes('around the clock') && !sch247.includes('each agent worked a fixed shift') && sch247.includes('only a round-the-clock business without placed start times has no shift end') && ut247.includes('around the clock') && ut247.includes('not an error') && !/shift placement (on|off)/i.test(sch247 + ut247), 'AA.46d 24x7 no-distribution notes: say agents stay on around the clock, it is the only case with no shift end, and "not an error"', `${sch247} || ${ut247}`);
  assert(!n247.some((r) => /budget|staggered|in queue|drain|horizon/i.test(r.Note)), 'AA.46e 24x7 notes avoid internal jargon (budget, staggered, in queue, drain, horizon)');

  // ---- Utilisation hidden by default (SHOW_UTILISATION = false, 2026-10-09): default builder output must not mention it ----
  const hiddenInsights = [...buildAgentInsights(sa), ...buildAgentInsights(lf), ...buildAgentInsights(a), ...buildAgentInsights(la)];
  const hiddenNotes = [...buildAgentAnalyticsNotes(la, mkLab(1.0)), ...buildAgentAnalyticsNotes(goldPooled, mkLab(1.0)), ...buildAgentAnalyticsNotes(a, lab), ...buildAgentAnalyticsNotes(a247, LAB247)];
  const hiddenEx = buildAgentAnalyticsExport(la, mkLab(1.0));
  const hiddenEx247 = buildAgentAnalyticsExport(a247, LAB247);
  assert(hiddenEx.sections[0].rows.length > 0 && hiddenEx.sections[0].rows.every((r) => !('Utilisation %' in r)) && hiddenEx247.sections[0].rows.every((r) => !('Utilisation %' in r)), 'AA.47a default export summary rows have no "Utilisation %" column (fixed-shift and 24x7 runs)');
  assert(hiddenNotes.every((r) => !/utilis/i.test(r.Item) && !/utilis/i.test(r.Note)), 'AA.47b default notes: no row Item or Note text mentions utilisation', hiddenNotes.filter((r) => /utilis/i.test(r.Item + r.Note)).map((r) => r.Item).join(' | '));
  assert(hiddenInsights.length > 0 && hiddenInsights.every((t) => !/utilis/i.test(t)) && hiddenInsights.some((t) => t.includes('late-coverage') && t.endsWith('.')) && hiddenInsights.some((t) => t.startsWith('Fairness') && t.includes('cases CV') && t.endsWith('.')), 'AA.47c default insights: no line mentions utilisation; late-coverage and fairness lines still present and end with a full stop', hiddenInsights.filter((t) => /utilis/i.test(t)).join(' | '));
  assert(hiddenEx.sections.length === 3 && hiddenEx.sections[0].rows.every((r) => 'Scheduled (min)' in r) && hiddenNotes.some((r) => r.Item === 'Scheduled (min)'), 'AA.47d default export still has exactly 3 sections and keeps the Scheduled (min) column and note');

  const shownEx = buildAgentAnalyticsExport(la, mkLab(1.0), true);
  assert(shownEx.sections.length === 3 && shownEx.sections[0].rows.every((r, i) => r['Utilisation %'] === Math.round(la.rows[i].utilisationPct * 10) / 10) && shownEx.sections[2].rows.some((r) => r.Item === 'Utilisation % vs Occupancy %'), 'AA.47e showUtilisation = true restores the export column and the note row (retained code stays covered)');

  // Pins left open by review: exact scheduled per full day at adherence 0.8, sums, export rounding, drain part-day cap.
  const ld8 = runLong(0.8);
  const l8day = computeAgentAnalytics({ des: ld8, calendar: LBIZ, labor: mkLab(0.8), filter: { fromDate: '2026-10-07', toDate: '2026-10-07' } });
  assert(l8day.rows.length === 8 && l8day.rows.every((r) => approx(r.scheduledMin, 540, 1e-6)), 'AA.45 adherence 0.8 staggered: scheduled is exactly 540 per full in-horizon day', l8day.rows.map((r) => r.scheduledMin.toFixed(2)).join(' '));
  const l8all = computeAgentAnalytics({ des: ld8, calendar: LBIZ, labor: mkLab(0.8) });
  assert(approx(l8all.team.scheduledMin, l8all.rows.reduce((s, r) => s + r.scheduledMin, 0), 1e-6) && approx(la.team.scheduledMin, la.rows.reduce((s, r) => s + r.scheduledMin, 0), 1e-6), 'AA.45b team.scheduledMin equals the sum of the row values');
  const exL8 = buildAgentAnalyticsExport(l8all, mkLab(0.8)).sections[0].rows;
  assert(exL8.length === l8all.rows.length && exL8.every((er, i) => er['Scheduled (min)'] === Math.round(l8all.rows[i].scheduledMin * 10) / 10), 'AA.45c export Scheduled (min) equals the row value rounded to 1 decimal');
  const l8drain = computeAgentAnalytics({ des: ld8, calendar: LBIZ, labor: mkLab(0.8), filter: { fromDate: expectedDrain[0], toDate: expectedDrain[0] } });
  assert(l8drain.dates.length >= 1 && l8drain.rows.some((r) => r.onShiftDays === 1) && l8drain.rows.every((r) => r.scheduledMin <= 540 + 1e-6), 'AA.45d on a part-day after the data ends, no agent is scheduled above the daily productive hours (540 min)', l8drain.rows.map((r) => r.scheduledMin.toFixed(1)).join(' '));
}

// ------------------------------------------------------------------------------------------
console.log('\n--- Suite AW: work share + single-agent cover (hand-built timelines) ---');
{
  const BIZ: CalendarConfig = { workingDays: [1, 2, 3, 4, 5], dailyOpenHour: 9, dailyOpenMinute: 0, dailyCloseHour: 17, dailyCloseMinute: 0, holidays: [] };
  const LAB: LaborConfig = { dailyProductiveHours: 8, adherencePct: 1.0, workingDaysPerWeek: 5, offDaysPerWeek: 2, contractualHoursSource: 'derived', shifts: [] };
  const T = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m); // Oct 5 = Mon, Oct 6 = Tue
  const sl = (agentId: number, state: 'busy' | 'idle', from: Date, to: Date, caseId: string | null = null): any => ({
    agentId, agentLabel: `Agent-${agentId + 1}`, date: formatDate24(from), state, rosterSource: 'existing', caseId, category: caseId ? 'General' : null,
    from, to, minutes: (to.getTime() - from.getTime()) / 60000, isResume: false, inBindingWindow: false,
  });
  const cr = (caseId: string, done: Date | null, agents: number[]): any => ({ caseId, category: 'General', isCompleted: done !== null, completeTime: done, assignedAgents: agents });
  const mkDes = (hc: number, timeline: any[], cases: any[]): any => ({ operationalHC: hc, agentTimeline: timeline, caseResults: cases, completedCases: cases.filter((c) => c.isCompleted).length });
  const cfg = { calendar: BIZ, labor: LAB };

  // c1 split A(0) 30 min Mon + B(1) 10 min Tue, finished by B Tue. c2 A only, 20 min Mon. c3 unfinished (A 15 min).
  const tl = [
    sl(0, 'busy', T(5, 9), T(5, 9, 30), 'c1'), sl(0, 'busy', T(5, 9, 30), T(5, 9, 50), 'c2'), sl(0, 'busy', T(5, 9, 50), T(5, 10, 5), 'c3'),
    sl(1, 'busy', T(6, 9), T(6, 9, 10), 'c1'), sl(1, 'idle', T(6, 9, 10), T(6, 10)),
    sl(0, 'idle', T(6, 9), T(6, 10)),
  ];
  const des = mkDes(2, tl, [cr('c1', T(6, 9, 10), [0, 1]), cr('c2', T(5, 9, 50), [0]), cr('c3', null, [0])]);
  const w = computeAgentAnalytics({ des, ...cfg });
  const [A, B] = w.rows;
  assert(approx(A.workShare, 0.75 + 1) && approx(B.workShare, 0.25), 'AW.1 split case c1: A 30 min / B 10 min -> 0.75 / 0.25 (plus A sole c2 = 1)', `${A.workShare} ${B.workShare}`);
  assert(approx(A.workShare + B.workShare, des.completedCases) && approx(w.team.workShareTotal, 2), 'AW.2 total work share == finished cases; unfinished c3 earns none');
  assert(A.casesCompleted === 1 && B.casesCompleted === 1 && A.casesTouched === 3, 'AW.3 finished (finisher credit) is kept alongside work share');
  const mon = w.dates.indexOf('2026-10-05');
  const tue = w.dates.indexOf('2026-10-06');
  assert(approx(w.matrix[0][mon], 0.75 + 1) && approx(w.matrix[1][tue], 0.25) && approx(w.matrix[1][mon], 0) && approx(w.matrix[0][tue], 0), 'AW.4 shares are attributed to the date of each slice');
  const tueOnly = computeAgentAnalytics({ des, ...cfg, filter: { fromDate: '2026-10-06' } });
  assert(approx(tueOnly.rows[1].workShare, 0.25) && approx(tueOnly.rows[0].workShare, 0), 'AW.5 date filter keeps only that day\'s slices (denominator still whole case)', `${tueOnly.rows.map((r) => r.workShare)}`);
  // avg handle = busy on finished-case work / work share: A = (30+20)/1.75, B = 10/0.25 = 40; unfinished c3 excluded.
  assert(approx(A.avgHandleMin!, 50 / 1.75) && approx(B.avgHandleMin!, 40), 'AW.6 avg handle = busy on completed cases / work share', `${A.avgHandleMin} ${B.avgHandleMin}`);
  // Ground-truth: the old "busy / touched" would have said B = 10 min.
  assert(approx(B.busyMin / B.casesTouched, 10) && !approx(B.avgHandleMin!, 10), 'AW.7 (control) busy/touched differs from the new definition');
  assert(approx(w.team.casesMean, 1), 'AW.8 team average is on work share');

  // Single-agent cover: agent 0 in queue 09-13, agent 1 09-17 -> agent 1 alone 13-17 and finishes c1 that agent 0 started.
  const soloTl = [
    sl(0, 'busy', T(5, 9), T(5, 9, 30), 'c1'), sl(0, 'idle', T(5, 9, 30), T(5, 13)),
    sl(1, 'idle', T(5, 9), T(5, 13)), sl(1, 'busy', T(5, 13), T(5, 13, 10), 'c1'), sl(1, 'idle', T(5, 13, 10), T(5, 17)),
  ];
  const soloCases = [cr('c1', T(5, 13, 10), [0, 1])];
  const s2 = computeAgentAnalytics({ des: mkDes(2, soloTl, soloCases), ...cfg });
  assert(s2.soloCover.length === 1 && s2.soloCover[0].agentId === 1 && s2.soloCover[0].windowStart === '13:00' && s2.soloCover[0].windowEnd === '17:00' && s2.soloCover[0].minutes === 240 && s2.soloCover[0].finishedFromOthers === 1, 'AW.9 one late agent -> single-agent cover 13:00-17:00 with 1 finished-from-others', JSON.stringify(s2.soloCover));
  const i2 = buildAgentInsights(s2).find((t) => t.includes('only agent on shift'));
  assert(!!i2 && i2.includes('Agent-2') && i2.includes('13:00-17:00') && i2.includes('finishes 1 cases started by others'), 'AW.10 insight names the agent, window and hand-over count', i2 ?? '');
  const covTl = [...soloTl, sl(2, 'idle', T(5, 9), T(5, 17))];
  const s3 = computeAgentAnalytics({ des: mkDes(3, covTl, soloCases), ...cfg });
  assert(s3.soloCover.length === 0 && !buildAgentInsights(s3).some((t) => t.includes('only agent on shift')), 'AW.11 two agents covering the late window -> no single-agent insight');
  assert(JSON.stringify(computeAgentAnalytics({ des: mkDes(2, soloTl, soloCases), ...cfg })) === JSON.stringify(s2), 'AW.12 deterministic');

  // Real sample runs: totals hold for pooled and siloed, whole run.
  const { rows: sampleRows } = buildSampleDataset('support', new Date(2026, 9, 5, 8, 0, 0, 0));
  const ivs = mapRawRecordsToIntervals(sampleRows, { intervalStartCol: 'IntervalStart', volumeCol: 'Volume', categoryCol: 'Category' } as any);
  const cats = discoverAndSyncCategories(ivs, DEFAULT_CATEGORIES, DEFAULT_SLA);
  for (const [arch, hc] of [['pooled', 12], ['siloed', 21]] as const) {
    const d = runBackofficeDES({ operationalHC: hc, intervals: ivs, openingWIP: [], categories: cats, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR, sla: DEFAULT_SLA, seed: DEFAULT_SIM_PARAMS.seed, queueArchitecture: arch });
    const r = computeAgentAnalytics({ des: d, calendar: DEFAULT_CALENDAR, labor: DEFAULT_LABOR });
    assert(approx(r.rows.reduce((x, y) => x + y.workShare, 0), d.completedCases, 1e-6), `AW.13 ${arch}: sum of work share == completedCases`, `${r.team.workShareTotal} vs ${d.completedCases}`);
  }
}

console.log('\n==================================================');
console.log(` RESULTS: ${passed} PASSED, ${failed} FAILED`);
console.log('==================================================\n');
if (failed > 0) process.exitCode = 1;
