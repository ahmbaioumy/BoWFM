/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Row builders for the Results exports (cases, breaches, agent slices). Pure. Every timestamp goes
 * through formatDateTime24 — the SAME formatter the on-screen tables use — so an exported cell is
 * always identical to what the planner saw (local business time, 'YYYY-MM-DD HH:mm', no 'Z').
 * Regression: an earlier version exported the UTC ISO string, which showed a different clock
 * time than the screen for any non-UTC planner (e.g. 08:18 on screen vs 04:18Z in Excel at UTC+4).
 */

import type { AgentRosterSource, AgentWorkSlice, CaseRunResult } from '../types/wfm';
import { formatDateTime24 } from './calendar';

export function buildCaseExportRows(cases: CaseRunResult[]): Array<Record<string, unknown>> {
  return cases.map((c) => ({
    'Case ID': c.caseId,
    Category: c.category,
    Priority: c.priority,
    'Arrival Time': formatDateTime24(c.arrival, ''),
    'Clock Start': formatDateTime24(c.clockStart, ''),
    'AHT (min)': c.ahtMinutes,
    'Primary Deadline': formatDateTime24(c.primaryDeadline, ''),
    'Latest Safe Start': formatDateTime24(c.latestSafeStart, ''),
    'First Start Time': formatDateTime24(c.firstStartTime, 'UNSTARTED'),
    'Complete Time': formatDateTime24(c.completeTime, 'UNFINISHED'),
    'Park Count': c.parkCount,
    'Is Opening WIP': c.isOpeningWip ? 'YES' : 'NO',
    'Completed?': c.isCompleted ? 'YES' : 'NO',
    'Primary SLA Passed': c.primaryPassed ? 'PASS' : 'FAIL',
    'ASA Duration (min)': c.asaDurationMinutes,
    'ASA Censored': c.asaCensored ? 'YES' : 'NO',
  }));
}

export function buildBreachExportRows(cases: CaseRunResult[]): Array<Record<string, unknown>> {
  return cases.map((c) => ({
    'Case ID': c.caseId,
    Category: c.category,
    'Arrival Time': formatDateTime24(c.arrival, ''),
    'Primary Deadline': formatDateTime24(c.primaryDeadline, ''),
    'Latest Safe Start': formatDateTime24(c.latestSafeStart, ''),
    'First Start Time': formatDateTime24(c.firstStartTime, 'UNSTARTED'),
    'Complete Time': formatDateTime24(c.completeTime, 'UNFINISHED'),
    'Park Count': c.parkCount,
    'Breach Reason': c.isCompleted ? 'Completed after primary deadline' : 'Unfinished by horizon end',
  }));
}

export function buildSliceExportRows(slices: AgentWorkSlice[], rosterFloor: number): Array<Record<string, unknown>> {
  return slices.map((s) => {
    const rosterSource: AgentRosterSource = s.agentId + 1 <= rosterFloor ? 'existing' : 'new';
    return {
      Agent: s.agentLabel,
      Source: rosterSource.toUpperCase(),
      Date: s.date,
      State: s.state === 'off' ? 'OOQ' : s.state.toUpperCase(),
      'Case ID': s.caseId || '—',
      Category: s.category || '—',
      From: formatDateTime24(s.from, ''),
      To: formatDateTime24(s.to, ''),
      Minutes: Math.round(s.minutes * 100) / 100,
      'Is Resume': s.isResume ? 'YES' : 'NO',
    };
  });
}
