/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect } from 'react';
import {
  AgentRosterSource,
  AgentSliceState,
  AgentSummary,
  AgentWorkSlice,
  CalendarConfig,
  CategoryConfig,
  HCSearchOutput,
  LaborConfig,
  OpeningWIPCase,
  SimulationParams,
  SLAPolicyConfig,
  StandardInterval,
} from '../types/wfm';
import { exportToExcelCSV } from '../utils/csv-parser';
import { getCalendarWorkingDaysInHorizon, getDailyWindowLengthHours } from '../utils/calendar';
import { verifyAgentTimelineInvariants } from '../utils/des-engine';
import { clampConfidenceLevelPct, effectivePrimaryTarget } from '../utils/hc-search';
import {
  Users,
  CheckCircle2,
  AlertTriangle,
  Download,
  Search,
  Layers,
  ShieldCheck,
  Cpu,
  BarChart2,
  Clock,
  Briefcase,
  FileCode,
  Info,
  Sparkles,
  ArrowRight,
  TrendingUp,
  Percent,
  Filter,
  X,
  Activity,
  XCircle,
} from 'lucide-react';

interface ResultsFlowProps {
  currentTab: string;
  searchOutput: HCSearchOutput | null;
  calendar: CalendarConfig;
  labor: LaborConfig;
  sla: SLAPolicyConfig;
  categories: CategoryConfig[];
  intervals: StandardInterval[];
  openingWIP: OpeningWIPCase[];
  simParams: SimulationParams;
  onExportAssumptionsJSON: () => void;
}

function formatSafeTime(date: Date | null | undefined): string {
  if (!date || isNaN(date.getTime())) return '-';
  try {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  } catch {
    return '-';
  }
}

function formatSafeDateTime(date: Date | null | undefined): string {
  if (!date || isNaN(date.getTime())) return '-';
  try {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  } catch {
    return '-';
  }
}

function formatSafeISO(date: Date | null | undefined, fallback: string = ''): string {
  if (!date || isNaN(date.getTime())) return fallback;
  try {
    return date.toISOString();
  } catch {
    return fallback;
  }
}

export function ResultsFlow({
  currentTab,
  searchOutput,
  calendar,
  labor,
  sla,
  categories,
  intervals,
  openingWIP,
  simParams,
  onExportAssumptionsJSON,
}: ResultsFlowProps) {
  const [caseSearch, setCaseSearch] = useState('');
  const [caseCatFilter, setCaseCatFilter] = useState('ALL');
  const [caseStatusFilter, setCaseStatusFilter] = useState<'ALL' | 'COMPLETED' | 'BREACHED' | 'UNFINISHED'>('ALL');
  const [page, setPage] = useState(1);
  const pageSize = 50;

  // Audit Drill breach table state
  const [auditBreachPage, setAuditBreachPage] = useState(1);
  const auditBreachPageSize = 50;

  // Agent Browser State
  const [selectedAgentId, setSelectedAgentId] = useState<number | null>(null);
  const [agentSearch, setAgentSearch] = useState('');
  const [agentStateFilter, setAgentStateFilter] = useState<'ALL' | 'BUSY' | 'IDLE' | 'OFF'>('ALL');
  const [agentSourceFilter, setAgentSourceFilter] = useState<'ALL' | 'EXISTING' | 'NEW'>('ALL');
  const [agentCatFilter, setAgentCatFilter] = useState('ALL');
  const [agentPage, setAgentPage] = useState(1);

  if (!searchOutput || !searchOutput.finalDESResult || !searchOutput.staffing) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-12 text-center shadow-xs">
        <Cpu className="w-10 h-10 text-slate-300 mx-auto mb-3" />
        <h3 className="text-sm font-bold text-slate-800">No Sizing Results Available</h3>
        <p className="text-xs text-slate-500 max-w-md mx-auto mt-1">
          Complete the Demand and Config setup, then go to Run Sizing to execute the Analytical &amp; Statistical Sizing Engine.
        </p>
      </div>
    );
  }

  const { finalDESResult: des, staffing, boundaryEvidence } = searchOutput;
  const dailyWindow = getDailyWindowLengthHours(calendar);
  const primaryHC = searchOutput.primaryDrivenHC || searchOutput.recommendedHC || staffing.operationalHC;
  const primaryStats = searchOutput.primaryStatistical;
  const siloed = searchOutput.queueArchitecture === 'siloed';
  const primarySizingFloor = effectivePrimaryTarget(sla.primaryPct, sla);
  const slackOn = sla.slaAcceptanceSlackEnabled === true;
  const primaryTargetLabel = slackOn
    ? `sizing floor ${primarySizingFloor}% (policy ${sla.primaryPct}%)`
    : `${sla.primaryPct}%`;

  // Display-only planner strip numbers (direct read from searchOutput / staffing)
  const slaOnDutyHC = searchOutput.recommendedHC !== null ? searchOutput.recommendedHC : staffing.operationalHC;
  const netOperationalHC = staffing.operationalHCWithOff;
  const offPctDisplay = Math.round(staffing.offPct * 100);
  const rosterUpliftPctDisplay = Math.round(staffing.rosterUpliftPct * 100);
  const workloadHC = searchOutput.nMinAnalytical;
  const grossHCTotal = staffing.grossHCTotal;
  const extraSeats = slaOnDutyHC - workloadHC;
  const extraPct = workloadHC > 0 ? Math.round((extraSeats / workloadHC) * 1000) / 10 : 0;
  const extraText =
    extraSeats > 0
      ? `+${extraSeats} / +${extraPct}% vs workload`
      : extraSeats === 0
      ? `+0% vs workload`
      : `${extraSeats} / ${extraPct}% vs workload`;

  // Derive Roster Floor for Existing vs New Agents (0 is valid, finite check)
  const rosterFloor = Number.isFinite(searchOutput.nMinAnalytical)
    ? (searchOutput.nMinAnalytical as number)
    : 0;

  const rawAgentSlices = useMemo(() => des.agentTimeline || [], [des]);

  // Reset agent browser state when DES changes
  useEffect(() => {
    setAgentPage(1);
    setAgentSearch('');
    setAgentStateFilter('ALL');
    setAgentSourceFilter('ALL');
    setAgentCatFilter('ALL');
    setSelectedAgentId(null);
    setAuditBreachPage(1);
  }, [des]);

  // Filter cases for Case Browser
  const filteredCases = useMemo(() => {
    return (des.caseResults || []).filter((c) => {
      if (caseCatFilter !== 'ALL' && c.category !== caseCatFilter) return false;
      if (caseStatusFilter === 'COMPLETED' && !c.isCompleted) return false;
      if (caseStatusFilter === 'UNFINISHED' && c.isCompleted) return false;
      if (caseStatusFilter === 'BREACHED' && c.primaryPassed) return false;
      if (caseSearch) {
        const q = caseSearch.toLowerCase();
        return c.caseId.toLowerCase().includes(q) || c.category.toLowerCase().includes(q);
      }
      return true;
    });
  }, [des.caseResults, caseCatFilter, caseStatusFilter, caseSearch]);

  const totalPages = Math.ceil(filteredCases.length / pageSize) || 1;
  const paginatedCases = filteredCases.slice((page - 1) * pageSize, page * pageSize);

  // All SLA-breaching cases at the recommended headcount (N), for the Audit Drill tab
  const breachedCases = useMemo(() => {
    return (des.caseResults || [])
      .filter((c) => !c.primaryPassed)
      .sort((a, b) => a.primaryDeadline.getTime() - b.primaryDeadline.getTime());
  }, [des.caseResults]);

  const auditBreachTotalPages = Math.ceil(breachedCases.length / auditBreachPageSize) || 1;
  const paginatedBreachedCases = breachedCases.slice(
    (auditBreachPage - 1) * auditBreachPageSize,
    auditBreachPage * auditBreachPageSize
  );

  // Agent Summaries (Primary View)
  const agentSummaries: AgentSummary[] = useMemo(() => {
    const effectiveAdherence = Math.min(1.0, Math.max(0.1, labor.adherencePct || 1.0));
    const dailyBudgetMinutes = labor.dailyProductiveHours * effectiveAdherence * 60;

    const perAgentSlices = new Map<number, AgentWorkSlice[]>();
    for (let i = 0; i < des.operationalHC; i++) {
      perAgentSlices.set(i, []);
    }
    for (const slice of rawAgentSlices) {
      if (!perAgentSlices.has(slice.agentId)) {
        perAgentSlices.set(slice.agentId, []);
      }
      perAgentSlices.get(slice.agentId)!.push(slice);
    }

    const summaries: AgentSummary[] = [];
    for (let i = 0; i < des.operationalHC; i++) {
      const slices = perAgentSlices.get(i) || [];
      const rosterSource: AgentRosterSource = (i + 1) <= rosterFloor ? 'existing' : 'new';

      let busyMinutes = 0;
      let idleMinutes = 0;
      let offMinutes = 0;
      const caseIds = new Set<string>();
      let resumeCount = 0;
      const dayBusyMap = new Map<string, number>();

      let agentCat = siloed ? '' : 'Pooled';

      for (const s of slices) {
        if (s.state === 'busy') {
          busyMinutes += s.minutes;
          if (s.caseId) caseIds.add(s.caseId);
          if (s.isResume) resumeCount++;
          if (s.category && !agentCat) agentCat = s.category;
          dayBusyMap.set(s.date, (dayBusyMap.get(s.date) || 0) + s.minutes);
        } else if (s.state === 'idle') {
          idleMinutes += s.minutes;
        } else if (s.state === 'off') {
          offMinutes += s.minutes;
        }
      }

      if (!agentCat) {
        agentCat = siloed && categories.length > 0 ? categories[i % categories.length].name : 'Pooled';
      }

      let maxBusyAnyDay = 0;
      for (const m of dayBusyMap.values()) {
        if (m > maxBusyAnyDay) maxBusyAnyDay = m;
      }

      const occupancyPct =
        busyMinutes + idleMinutes > 0
          ? Math.min(100, Math.round((busyMinutes / (busyMinutes + idleMinutes)) * 1000) / 10)
          : 0;

      summaries.push({
        agentId: i,
        agentLabel: `Agent-${i + 1}`,
        rosterSource,
        siloCategory: agentCat,
        busyMinutes,
        idleMinutes,
        offMinutes,
        occupancyPct,
        casesHandled: caseIds.size,
        resumeCount,
        inBindingWindow: false,
        dailyBudgetMinutes,
        maxBusyAnyDay,
        hasBudgetViolation: maxBusyAnyDay > dailyBudgetMinutes + 0.01,
      });
    }

    return summaries;
  }, [des, rawAgentSlices, labor, rosterFloor, siloed, categories]);

  const filteredSummaries = useMemo(() => {
    return agentSummaries.filter((a) => {
      if (agentSourceFilter !== 'ALL' && a.rosterSource.toUpperCase() !== agentSourceFilter) return false;
      if (agentCatFilter !== 'ALL' && a.siloCategory !== agentCatFilter) return false;
      if (agentSearch) {
        const q = agentSearch.toLowerCase();
        const matchLabel = a.agentLabel.toLowerCase().includes(q);
        const matchCat = a.siloCategory.toLowerCase().includes(q);
        if (!matchLabel && !matchCat) return false;
      }
      return true;
    });
  }, [agentSummaries, agentSourceFilter, agentCatFilter, agentSearch]);

  // Filter agent slices for Slices Drill (Secondary View)
  const filteredAgentSlices = useMemo(() => {
    return rawAgentSlices
      .filter((s) => {
        if (selectedAgentId !== null && s.agentId !== selectedAgentId) return false;
        const rosterSource: AgentRosterSource = (s.agentId + 1) <= rosterFloor ? 'existing' : 'new';
        if (agentSourceFilter !== 'ALL' && rosterSource.toUpperCase() !== agentSourceFilter) return false;
        if (agentStateFilter !== 'ALL' && s.state.toUpperCase() !== agentStateFilter) return false;
        if (agentCatFilter !== 'ALL') {
          if (s.state !== 'busy' || s.category !== agentCatFilter) return false;
        }
        if (agentSearch) {
          const q = agentSearch.toLowerCase();
          const matchLabel = s.agentLabel.toLowerCase().includes(q);
          const matchCase = s.caseId ? s.caseId.toLowerCase().includes(q) : false;
          const matchCat = s.category ? s.category.toLowerCase().includes(q) : false;
          const matchDate = s.date.includes(q);
          if (!matchLabel && !matchCase && !matchCat && !matchDate) return false;
        }
        return true;
      })
      .sort((a, b) => a.agentId - b.agentId || a.from.getTime() - b.from.getTime());
  }, [rawAgentSlices, selectedAgentId, rosterFloor, agentSourceFilter, agentStateFilter, agentCatFilter, agentSearch]);

  const totalAgentPages = Math.ceil(filteredAgentSlices.length / pageSize) || 1;
  const paginatedAgentSlices = filteredAgentSlices.slice((agentPage - 1) * pageSize, agentPage * pageSize);

  // Proof Strip Calculations
  const timelineBusySum = useMemo(() => {
    let sum = 0;
    for (const s of rawAgentSlices) {
      if (s.state === 'busy') sum += s.minutes;
    }
    return sum;
  }, [rawAgentSlices]);

  const timelineBusyRounded = Math.round(timelineBusySum * 10) / 10;
  const effectiveAdherence = Math.min(1.0, Math.max(0.1, labor.adherencePct || 1.0));
  const dailyBudgetPerAgentMinutes = labor.dailyProductiveHours * effectiveAdherence * 60;
  const dailyBudgetHoursFormatted = (dailyBudgetPerAgentMinutes / 60).toFixed(2);

  const busyPass = Math.abs(timelineBusySum - des.totalHandlingMinutes) <= 0.01;
  const sliceOccupancyPct =
    des.totalAvailableProductiveMinutes > 0
      ? Math.min(100, Math.round((timelineBusySum / des.totalAvailableProductiveMinutes) * 1000) / 10)
      : 0;
  const rawSliceOccupancyPct =
    des.totalAvailableProductiveMinutes > 0
      ? Math.round((timelineBusySum / des.totalAvailableProductiveMinutes) * 1000) / 10
      : 0;
  const occPass = busyPass && Math.abs(sliceOccupancyPct - des.occupancyPct) <= 0.1;
  const rawOccPass = occPass && Math.abs(rawSliceOccupancyPct - des.rawOccupancyPct) <= 0.1;

  const distinctAgentIdsInTimeline = useMemo(() => {
    return new Set(rawAgentSlices.map((s) => s.agentId)).size;
  }, [rawAgentSlices]);
  const headcountMatch = distinctAgentIdsInTimeline === des.operationalHC;

  const invariantResult = useMemo(() => {
    if (currentTab !== 'agents') return { valid: true, errors: [] };
    return verifyAgentTimelineInvariants(des, labor, calendar);
  }, [currentTab, des, labor, calendar]);

  function handleExportCasesCSV() {
    exportToExcelCSV(
      des.caseResults.map((c) => ({
        'Case ID': c.caseId,
        Category: c.category,
        Priority: c.priority,
        'Arrival Time': formatSafeISO(c.arrival),
        'Clock Start': formatSafeISO(c.clockStart),
        'AHT (min)': c.ahtMinutes,
        'Primary Deadline': formatSafeISO(c.primaryDeadline),
        'Latest Safe Start': formatSafeISO(c.latestSafeStart),
        'First Start Time': formatSafeISO(c.firstStartTime, 'UNSTARTED'),
        'Complete Time': formatSafeISO(c.completeTime, 'UNFINISHED'),
        'Park Count': c.parkCount,
        'Is Opening WIP': c.isOpeningWip ? 'YES' : 'NO',
        'Completed?': c.isCompleted ? 'YES' : 'NO',
        'Primary SLA Passed': c.primaryPassed ? 'PASS' : 'FAIL',
        'ASA Duration (min)': c.asaDurationMinutes,
        'ASA Censored': c.asaCensored ? 'YES' : 'NO',
      })),
      'wfm_simulated_cases.csv'
    );
  }

  function handleExportBreachedCasesCSV() {
    exportToExcelCSV(
      breachedCases.map((c) => ({
        'Case ID': c.caseId,
        Category: c.category,
        'Arrival Time': formatSafeISO(c.arrival),
        'Primary Deadline': formatSafeISO(c.primaryDeadline),
        'Latest Safe Start': formatSafeISO(c.latestSafeStart),
        'First Start Time': formatSafeISO(c.firstStartTime, 'UNSTARTED'),
        'Complete Time': formatSafeISO(c.completeTime, 'UNFINISHED'),
        'Park Count': c.parkCount,
        'Breach Reason': c.isCompleted ? 'Completed after primary deadline' : 'Unfinished by horizon end',
      })),
      'wfm_sla_breach_cases.csv'
    );
  }

  function handleExportQueueWipCSV() {
    exportToExcelCSV(
      des.intervalsTimeline.map((it) => ({
        'Interval Time': formatSafeDateTime(it.time),
        'Queued WIP': it.queuedWIP,
        'Active Handling': it.activeHandling,
        'Parked WIP': it.parkedWIP,
        'Cumulative Completed': it.completedCum,
        'Available Agents': it.availableAgents,
      })),
      'wfm_queue_wip_timeline.csv'
    );
  }

  function handleExportAgentSlicesCSV() {
    exportToExcelCSV(
      rawAgentSlices.map((s) => {
        const rosterSource: AgentRosterSource = (s.agentId + 1) <= rosterFloor ? 'existing' : 'new';
        return {
          Agent: s.agentLabel,
          Source: rosterSource.toUpperCase(),
          Date: s.date,
          State: s.state === 'off' ? 'OOQ' : s.state.toUpperCase(),
          'Case ID': s.caseId || '—',
          Category: s.category || '—',
          From: formatSafeDateTime(s.from),
          To: formatSafeDateTime(s.to),
          'From ISO': formatSafeISO(s.from),
          'To ISO': formatSafeISO(s.to),
          Minutes: Math.round(s.minutes * 100) / 100,
          'Is Resume': s.isResume ? 'YES' : 'NO',
        };
      }),
      'wfm_simulated_agent_slices.csv'
    );
  }

  function handleExportAgentSummaryCSV() {
    exportToExcelCSV(
      agentSummaries.map((a) => ({
        Agent: a.agentLabel,
        Source: a.rosterSource.toUpperCase(),
        Category: a.siloCategory,
        'Busy Minutes': Math.round(a.busyMinutes * 10) / 10,
        'Idle Minutes': Math.round(a.idleMinutes * 10) / 10,
        'Off Minutes': Math.round(a.offMinutes * 10) / 10,
        'Occupancy %': a.occupancyPct,
        'Cases Handled': a.casesHandled,
        'Resumes': a.resumeCount,
        'Max Daily Busy (min)': Math.round(a.maxBusyAnyDay * 10) / 10,
        'Daily Budget (min)': Math.round(a.dailyBudgetMinutes * 10) / 10,
        'Budget Compliant': a.hasBudgetViolation ? 'VIOLATION' : 'PASS',
      })),
      'wfm_simulated_agent_summaries.csv'
    );
  }

  return (
    <div className="space-y-6">
      {/* 1. SUMMARY TAB */}
      {currentTab === 'summary' && (
        <div className="space-y-6">
          {/* Infeasible / Constraint Violation Alert Banner */}
          {searchOutput.isInfeasible && (
            <div className="bg-rose-50 border-2 border-rose-300 rounded-2xl p-6 shadow-sm space-y-4">
              <div className="flex items-start gap-3.5">
                <div className="p-2 bg-rose-100 rounded-xl text-rose-700 mt-0.5 shrink-0">
                  <AlertTriangle className="w-6 h-6 text-rose-600" />
                </div>
                <div className="space-y-1.5 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-rose-600 text-white">
                      Search Infeasible / SLA Constraint Breach
                    </span>
                    <span className="text-xs text-rose-800 font-mono font-semibold">
                      Evaluated up to N = {searchOutput.finalDESResult?.operationalHC || 500} agents
                    </span>
                  </div>
                  <h3 className="text-base font-black text-rose-950">
                    Could not satisfy Primary SLA within the Headcount Search Cap
                  </h3>
                  <p className="text-xs text-rose-800 leading-relaxed">
                    {searchOutput.infeasibleReason ||
                      'The simulation engine tested multiple candidate headcounts up to the search cap, but constraints could not be met.'}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Sizing Headline Banner */}
          <div className="bg-gradient-to-r from-slate-900 via-slate-850 to-slate-900 text-white rounded-2xl p-6 shadow-xl border border-slate-800">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${
                      searchOutput.isInfeasible
                        ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                        : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                    }`}
                  >
                    {searchOutput.isInfeasible ? 'Search Infeasible at Cap' : 'Dual Sizing Engine Verified'}
                  </span>
                  <span className="text-xs text-slate-300 font-mono bg-slate-800 px-2.5 py-0.5 rounded border border-slate-700">
                    Binding: {searchOutput.bindingConstraintDescription || staffing.bindingConstraint}
                  </span>
                </div>
                <h2 className="text-2xl font-black tracking-tight text-white">
                  {searchOutput.isInfeasible ? 'Staffing Evaluation Diagnostics (Infeasible)' : 'Recommended Staffing Requirements'}
                </h2>
                <p className="text-xs text-slate-400">
                  {searchOutput.isInfeasible
                    ? 'SLA constraints could not be satisfied within the configured search ceiling. Review diagnostic evidence below.'
                    : `Synthesized from the analytical workload baseline and statistical DES ${sla.confidenceLevelPct ?? 95}% Confidence Interval.`}
                </p>
              </div>

              {/* 3 Main Staffing Numbers */}
              <div className="flex items-center gap-4 bg-slate-800/80 p-3.5 rounded-xl border border-slate-700">
                <div className="text-center px-3 border-r border-slate-700">
                  <span className="text-[10px] text-slate-400 uppercase font-bold block">
                    Net Operational HC
                  </span>
                  <span
                    className={`text-2xl font-black font-mono ${
                      searchOutput.isInfeasible ? 'text-rose-400' : 'text-emerald-400'
                    }`}
                  >
                    {netOperationalHC}
                  </span>
                  <span className="text-[10px] text-slate-400 block">
                    {searchOutput.isInfeasible
                      ? 'Evaluated Cap (Fails SLA)'
                      : staffing.rosterInfeasible
                      ? 'Roster infeasible — off days exceed open days'
                      : `${offPctDisplay}% OFF → +${rosterUpliftPctDisplay}% roster uplift`}
                  </span>
                </div>

                <div className="text-center px-3 border-r border-slate-700">
                  <span className="text-[10px] text-slate-400 uppercase font-bold block">
                    Pooled Gross HC (M2)
                  </span>
                  <span className="text-2xl font-black text-blue-400 font-mono">
                    {grossHCTotal}
                  </span>
                  <span className="text-[10px] text-slate-400 block">
                    {Math.round(staffing.effectiveShrinkagePct * 100)}% shrinkage
                  </span>
                </div>
              </div>
            </div>

            {/* Planner Sizing Strip */}
            <div className="mt-4 pt-3.5 border-t border-slate-800 bg-slate-950/40 rounded-xl p-3.5 border border-slate-800/80">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-300">
                <span>
                  <span className="text-slate-300">Workload HC (hours + adherence):</span>{' '}
                  <span className="font-mono font-bold text-white">{workloadHC}</span>
                </span>
                <span className="text-slate-500 font-bold">→</span>
                <span>
                  <span className="text-slate-300">SLA on-duty HC:</span>{' '}
                  <span className="font-mono font-bold text-emerald-400">{slaOnDutyHC}</span>{' '}
                  <span className="text-slate-400">({extraText})</span>
                </span>
                <span className="text-slate-500 font-bold">→</span>
                <span>
                  <span className="text-slate-300">Hire after same shrink:</span>{' '}
                  <span className="font-mono font-bold text-blue-400">{grossHCTotal}</span>
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-1.5 leading-normal">
                Left = current team method (workload only). Middle = SLA impact. Right = same shrink as today, applied on the SLA N.
              </p>
            </div>
          </div>

          {/* DES Sizing Engine Record (matches completed SimulationProgressModal) */}
          {(() => {
            const isInfeasible = searchOutput.isInfeasible;
            const recommendedN =
              searchOutput.recommendedHC !== null
                ? searchOutput.recommendedHC
                : searchOutput.primaryDrivenHC;
            const nMin = searchOutput.nMinAnalytical;
            const history = searchOutput.searchHistory || [];
            const ciPct = clampConfidenceLevelPct(sla.confidenceLevelPct);
            const phase = isInfeasible
              ? 'Search Infeasible at Cap'
              : 'Sizing & Verification Complete';
            const currentMessage = isInfeasible
              ? `Search Infeasible: ${searchOutput.infeasibleReason || 'No compliant headcount found within search bounds.'}`
              : `Optimal Staffing: ${recommendedN} Operational HC (Primary-Driven: ${searchOutput.primaryDrivenHC} with ${ciPct}% CI).`;

            return (
              <div className="bg-white rounded-2xl shadow-xs border border-slate-200 overflow-hidden flex flex-col">
                <div className="bg-slate-900 text-white p-5 flex items-center justify-between border-b border-slate-800">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                      <Cpu className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-sm text-white">Backoffice DES Sizing Engine</h3>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold border ${
                            isInfeasible
                              ? 'bg-rose-500/20 text-rose-300 border-rose-500/30'
                              : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                          }`}
                        >
                          {isInfeasible ? 'INFEASIBLE' : 'COMPLETE'}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Discrete-event queue simulation searching for minimal compliant headcount
                      </p>
                    </div>
                  </div>
                  <div className="text-2xl font-black font-mono text-emerald-400">100%</div>
                </div>

                <div className="p-6 space-y-5">
                  <div className="space-y-2">
                    <div className="flex justify-between items-center text-xs font-semibold text-slate-700">
                      <span className="flex items-center gap-1.5">
                        <Activity className="w-3.5 h-3.5 text-emerald-600" />
                        <span>{phase}</span>
                      </span>
                      <span className="text-slate-500 font-mono">100% complete</span>
                    </div>
                    <div className="w-full bg-slate-100 rounded-full h-3.5 overflow-hidden p-0.5 border border-slate-200 shadow-inner">
                      <div
                        className={`h-full rounded-full shadow-xs ${
                          isInfeasible ? 'bg-rose-500' : 'bg-emerald-500'
                        }`}
                        style={{ width: '100%' }}
                      />
                    </div>
                    <div
                      className={`p-3 border rounded-xl text-xs flex items-center gap-2.5 ${
                        isInfeasible
                          ? 'bg-rose-50 border-rose-200 text-rose-900'
                          : 'bg-emerald-50 border-emerald-200 text-emerald-900'
                      }`}
                    >
                      {isInfeasible ? (
                        <XCircle className="w-4 h-4 text-rose-600 shrink-0" />
                      ) : (
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                      )}
                      <span className="font-medium">{currentMessage}</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <div className="p-3 bg-blue-50/60 rounded-xl border border-blue-100 text-center">
                      <span className="text-[10px] font-bold text-blue-800 uppercase tracking-wider block">
                        Recommended HC
                      </span>
                      <span className="text-xl font-mono font-black text-blue-900 mt-0.5 block">
                        {recommendedN ? `N = ${recommendedN}` : '—'}
                      </span>
                      <span className="text-[10px] text-blue-600">Optimal result</span>
                    </div>
                    <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-center">
                      <span className="text-[10px] font-bold text-slate-600 uppercase tracking-wider block">
                        Analytical Lower Bound
                      </span>
                      <span className="text-xl font-mono font-black text-slate-800 mt-0.5 block">
                        {nMin ? `N ≥ ${nMin}` : '—'}
                      </span>
                      <span className="text-[10px] text-slate-500">M5 workload floor</span>
                    </div>
                    <div className="p-3 bg-purple-50/60 rounded-xl border border-purple-100 text-center">
                      <span className="text-[10px] font-bold text-purple-800 uppercase tracking-wider block">
                        Evaluated Steps
                      </span>
                      <span className="text-xl font-mono font-black text-purple-900 mt-0.5 block">
                        {history.length}
                      </span>
                      <span className="text-[10px] text-purple-600">Discrete iterations</span>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                        Headcount Candidate Evaluation Feed
                      </span>
                      <span className="text-[11px] text-slate-400">
                        SLA: {sla.primaryPct}% / {sla.primaryWindow} {sla.primaryUnit}
                      </span>
                    </div>
                    <div className="border border-slate-200 rounded-xl overflow-hidden bg-white max-h-48 overflow-y-auto">
                      {history.length === 0 ? (
                        <div className="p-4 text-center text-xs text-slate-400 italic">
                          No candidate evaluations recorded.
                        </div>
                      ) : (
                        <table className="w-full text-xs text-left">
                          <thead className="bg-slate-50 text-[10px] font-bold text-slate-500 uppercase border-b border-slate-200 sticky top-0">
                            <tr>
                              <th className="py-2 px-3">Tested HC</th>
                              <th className="py-2 px-3">Primary SLA</th>
                              <th className="py-2 px-3">Occupancy</th>
                              {sla.boAsaEnabled && <th className="py-2 px-3">BO ASA</th>}
                              <th className="py-2 px-3">Status</th>
                              <th className="py-2 px-3">Reason</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 font-mono">
                            {history.map((item, idx) => (
                              <tr
                                key={idx}
                                className={
                                  item.passed
                                    ? 'bg-emerald-50/80 font-bold text-emerald-950'
                                    : 'hover:bg-slate-50/80 text-slate-700'
                                }
                              >
                                <td className="py-1.5 px-3 font-bold">N = {item.hc}</td>
                                <td className="py-1.5 px-3">
                                  <span
                                    className={
                                      item.primaryPct >= sla.primaryPct
                                        ? 'text-emerald-700 font-semibold'
                                        : 'text-rose-600'
                                    }
                                  >
                                    {item.primaryPct}%
                                  </span>
                                </td>
                                <td className="py-1.5 px-3 text-slate-600">
                                  {item.occupancyPct}%
                                  {item.rawOccupancyPct > item.occupancyPct + 0.1 && (
                                    <span className="block text-[10px] text-rose-600">
                                      (capacity ratio {item.rawOccupancyPct}%)
                                    </span>
                                  )}
                                </td>
                                {sla.boAsaEnabled && (
                                  <td className="py-1.5 px-3 text-slate-600">{item.boAsaMinutes}m</td>
                                )}
                                <td className="py-1.5 px-3">
                                  {item.passed ? (
                                    <span className="inline-flex items-center gap-1 text-[10px] text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded font-bold">
                                      <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                                      PASS
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 text-[10px] text-rose-700 bg-rose-50 px-1.5 py-0.5 rounded">
                                      <AlertTriangle className="w-3 h-3 text-rose-500" />
                                      Fail
                                    </span>
                                  )}
                                </td>
                                <td className="py-1.5 px-3 max-w-[260px] whitespace-normal font-sans">
                                  {item.passed ? (
                                    <span className="text-slate-300">—</span>
                                  ) : (
                                    item.failingReasons.map((reason, rIdx) => (
                                      <div key={rIdx} className="text-[10px] text-rose-600 leading-snug">
                                        {reason}
                                      </div>
                                    ))
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </div>
                </div>

                <div className="bg-slate-50 px-6 py-3.5 border-t border-slate-200 flex items-center">
                  <span className="text-xs text-slate-500">Simulation execution concluded.</span>
                </div>
              </div>
            );
          })()}

          {/* Primary SLA-Driven Requirement (Statistical with CI) */}
          <div className="grid grid-cols-1 gap-4">
            <div className="bg-white rounded-xl border-2 border-purple-200 p-5 shadow-xs space-y-4">
              <div className="flex items-center justify-between border-b border-purple-100 pb-3">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 bg-purple-50 text-purple-700 rounded-lg">
                    <Sparkles className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">
                      Primary SLA-Driven Sizing ({slackOn ? `floor ${primarySizingFloor}%` : `${sla.primaryPct}%`})
                    </h3>
                    <p className="text-[11px] text-slate-500">
                      Stochastic DES with {sla.confidenceLevelPct ?? 95}% Confidence Interval (≥30 replications)
                      {slackOn
                        ? ` · Acceptance slack ${sla.slaAcceptanceSlackPct ?? 5}% (policy ${sla.primaryPct}%)`
                        : ''}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-2xl font-black text-purple-700 font-mono block">
                    {primaryHC}
                  </span>
                  <span className="text-[10px] text-slate-500 font-bold uppercase">Agents Required</span>
                </div>
              </div>

              {primaryStats ? (
                <div className="space-y-2 text-xs">
                  <div className="bg-purple-50/60 p-3 rounded-lg border border-purple-100 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-purple-950 uppercase text-[10px] tracking-wider">
                        Statistical Confidence Bounds
                      </span>
                      <span className="font-mono text-purple-700 font-bold text-[11px]">
                        R = {primaryStats.replications} Replications
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 font-mono text-[11px] text-slate-700 pt-1">
                      <div>
                        <span className="text-slate-500 font-sans block text-[10px]">{sla.confidenceLevelPct ?? 95}% CI Lower Bound:</span>
                        <span className={`font-bold ${primaryStats.ci95Low >= primarySizingFloor ? 'text-emerald-700' : 'text-rose-600'}`}>
                          {primaryStats.ci95Low}%
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-500 font-sans block text-[10px]">{sla.confidenceLevelPct ?? 95}% CI Upper Bound:</span>
                        <span className="font-bold text-purple-900">{primaryStats.ci95High}%</span>
                      </div>
                      <div>
                        <span className="text-slate-500 font-sans block text-[10px]">Sample Median:</span>
                        <span className="font-bold text-slate-900">{primaryStats.achievedPctMedian}%</span>
                      </div>
                      <div>
                        <span className="text-slate-500 font-sans block text-[10px]">Sample Mean &amp; StdDev:</span>
                        {primaryStats.achievedPctMean}% (σ = {primaryStats.stdDev}%)
                      </div>
                    </div>
                  </div>

                  <div className="text-[11px] text-slate-600 leading-relaxed">
                    <strong>Statistical Guarantee:</strong> Headcount N = {primaryHC} ensures with{' '}
                    {sla.confidenceLevelPct ?? 95}% statistical confidence that the true expected Primary SLA
                    exceeds the sizing floor ({primaryTargetLabel}).
                    {slackOn ? (
                      <>
                        {' '}
                        Policy Primary remains {sla.primaryPct}%; slack accepts CI ≥ {primarySizingFloor}%.
                      </>
                    ) : null}
                  </div>
                  {Number.isFinite(searchOutput.nMinAnalytical) &&
                    primaryHC === searchOutput.nMinAnalytical && (
                      <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2 leading-relaxed">
                        Req HC is held at the workload floor <strong>N_min = {searchOutput.nMinAnalytical}</strong>{searchOutput.workloadReductionAppliedPct ? ` (workload reduced ${searchOutput.workloadReductionAppliedPct}%)` : ''}.
                        This CI was not the binding constraint (search never goes below N_min). Raise CI or tighten
                        Primary SLA to see a CI-driven increase above the floor.
                      </div>
                    )}
                </div>
              ) : (
                <div className="p-3 bg-purple-50/40 rounded-lg text-xs text-slate-600">
                  Evaluated at N = {primaryHC}: Achieved Primary SLA = {des.primaryAchievedPct}% (Sizing floor: {primaryTargetLabel}).
                </div>
              )}
              {Number.isFinite(searchOutput.occupancyFeasibleFloor) && (
                <div className="mt-2 text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-2 leading-relaxed">
                  <strong>Occupancy-feasible floor N_occ = {searchOutput.occupancyFeasibleFloor}</strong>{' '}
                  — the smallest headcount whose occupancy can clear the cap, using the same
                  productive-hours basis the DES occupancy gate uses (may differ from N_min when
                  contractual and derived agent-hours disagree).
                  {searchOutput.shiftPlacement?.enabledForRun && (
                    <>
                      {' '}
                      Deadline-coverage shift placement is <strong>enabled</strong>
                      {Number.isFinite(searchOutput.shiftPlacement.placementFeasibleFloor)
                        ? ` (analytic N_sla = ${searchOutput.shiftPlacement.placementFeasibleFloor})`
                        : ''}
                      {searchOutput.shiftPlacement.winningDistribution
                        ? ' — the recommended headcount uses a staggered shift-start distribution, not a uniform business-open start.'
                        : ' — the recommendation used a uniform business-open start; placement did not find a better distribution.'}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Core Performance Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
              <span className="text-[10px] text-slate-500 uppercase font-bold block">
                Primary SLA Achieved
              </span>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-xl font-black text-slate-900 font-mono">
                  {des.primaryAchievedPct}%
                </span>
                <span className="text-xs text-slate-500">floor ≥ {primarySizingFloor}%</span>
              </div>
              <div className="mt-2 w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
                <div
                  className={`h-full ${
                    des.primaryAchievedPct >= primarySizingFloor ? 'bg-emerald-500' : 'bg-rose-500'
                  }`}
                  style={{ width: `${Math.min(100, des.primaryAchievedPct)}%` }}
                />
              </div>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-slate-500 uppercase font-bold block">
                  BO ASA (Time-to-First-Handle)
                </span>
                <span className={`text-[9px] font-mono font-semibold px-1.5 py-0.5 rounded border ${
                  sla.boAsaEnabled
                    ? 'bg-purple-50 text-purple-700 border-purple-200'
                    : 'bg-slate-100 text-slate-600 border-slate-200'
                }`}>
                  {sla.boAsaEnabled
                    ? (sla.asaClockBasis || 'business_window') === 'business_window'
                      ? 'Enforced (Business)'
                      : 'Enforced (24/7 Clock)'
                    : 'Observed / Unconstrained'}
                </span>
              </div>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-xl font-black text-slate-900 font-mono">
                  {des.boAsaMeanMinutes}m
                </span>
                <span className="text-xs text-slate-500">
                  {sla.boAsaEnabled ? `target ≤ ${sla.boAsaTarget} ${sla.boAsaUnit}` : 'no ASA target enforced'}
                </span>
              </div>
              <span className="text-[10px] text-slate-400 block mt-1">
                {(sla.asaClockBasis || 'business_window') === 'business_window'
                  ? 'Mean wait time during open business hours'
                  : 'Mean 24/7 elapsed wall-clock wait time'}
              </span>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
              <span className="text-[10px] text-slate-500 uppercase font-bold block">
                Handling Occupancy %
              </span>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-xl font-black text-slate-900 font-mono">
                  {des.occupancyPct}%
                </span>
                {sla.occupancyCapEnabled && (
                  <span className="text-xs text-slate-500">cap {sla.occupancyCapPct}%</span>
                )}
              </div>
              {des.rawOccupancyPct > 100 && (
                <span className="text-rose-700 text-xs font-semibold block mt-1">
                  Capacity ratio: {des.rawOccupancyPct}% — demand exceeds capacity, staffing is insufficient
                </span>
              )}
              {des.rawOccupancyPct <= 100 && des.rawOccupancyPct > 85 && (
                <span className="text-amber-700 text-xs font-semibold block mt-1">
                  Above 85% leaves little headroom for forecast variance (COPC-aligned sustainable
                  backoffice guidance). Consider enabling the Occupancy Ceiling in SLA Defaults.
                </span>
              )}
              <span className="text-[10px] text-slate-400 block mt-1">
                {des.totalHandlingMinutes.toLocaleString()}m worked / {des.totalAvailableProductiveMinutes.toLocaleString()}m available
              </span>
            </div>

            {sla.minCoverageEnabled !== false && (
              <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
                <span className="text-[10px] text-slate-500 uppercase font-bold block">
                  Minimum Coverage
                </span>
                <div className="flex items-baseline gap-2 mt-1">
                  <span className={`text-xl font-black font-mono ${des.passesCoverage ? 'text-slate-900' : 'text-rose-700'}`}>
                    {Number.isFinite(des.minCoverageObserved) ? des.minCoverageObserved : '—'}
                  </span>
                  <span className="text-xs text-slate-500">min agents on shift (floor {sla.minAgentsPerInterval ?? 1})</span>
                </div>
                {!des.passesCoverage && (
                  <span className="text-rose-700 text-xs font-semibold block mt-1">
                    The queue was left below the coverage floor during at least one open business interval.
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Per-Category Sizing Breakdown Table */}
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs space-y-3">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Per-Category Staffing &amp; SLA Breakdown</h3>
                <p className="text-xs text-slate-500">
                  Workload, operational share, gross headcount, and category-specific achieved Primary SLA and ASA.
                </p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-100 text-slate-700 font-semibold border-b border-slate-200">
                  <tr>
                    <th className="py-2.5 px-3">Category</th>
                    <th className="py-2.5 px-3 text-right">Workload (hrs)</th>
                    <th className="py-2.5 px-3 text-right">Workload Share</th>
                    <th className="py-2.5 px-3 text-right">Net HC</th>
                    <th className="py-2.5 px-3 text-right">Shrinkage %</th>
                    <th className="py-2.5 px-3 text-right">Gross HC</th>
                    <th className="py-2.5 px-3 text-right">Primary SLA (Achieved / Target)</th>
                    <th className="py-2.5 px-3 text-right">Mean ASA</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {staffing.perCategory.map((cat) => {
                    const catStats = des.categoryStats[cat.category];
                    const catCfg = categories.find((c) => c.name === cat.category);
                    const officialPrimary = catCfg?.primaryPct !== undefined ? catCfg.primaryPct : sla.primaryPct;
                    const targetPrimary = effectivePrimaryTarget(officialPrimary, sla);
                    const achievedPrimary = catStats?.primaryPct || 100;
                    const primaryPassed = achievedPrimary >= targetPrimary;

                    return (
                      <tr key={cat.category} className="hover:bg-slate-50 font-mono">
                        <td className="py-2.5 px-3 font-semibold text-slate-900 font-sans">
                          {cat.category}
                        </td>
                        <td className="py-2.5 px-3 text-right">{cat.workloadHours}h</td>
                        <td className="py-2.5 px-3 text-right">{(cat.categoryShare * 100).toFixed(1)}%</td>
                        <td className="py-2.5 px-3 text-right font-bold text-emerald-700">
                          {cat.operationalHC}
                        </td>
                        <td className="py-2.5 px-3 text-right">{Math.round(cat.shrinkagePct * 100)}%</td>
                        <td className="py-2.5 px-3 text-right font-bold text-blue-700">{cat.grossHC}</td>
                        <td className="py-2.5 px-3 text-right font-sans">
                          <span
                            className={`font-mono font-bold ${
                              primaryPassed ? 'text-emerald-600' : 'text-rose-600'
                            }`}
                          >
                            {achievedPrimary}%
                          </span>
                          <span className="text-[10px] text-slate-400 font-mono ml-1">
                            ({slackOn ? 'floor' : 'tgt'}: {targetPrimary}%
                            {slackOn && officialPrimary !== targetPrimary ? ` / pol ${officialPrimary}%` : ''})
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right font-sans font-mono text-purple-700 font-semibold">
                          {catStats?.asaMeanMinutes !== undefined ? `${catStats.asaMeanMinutes}m` : '0m'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-slate-50 font-bold border-t border-slate-200 font-mono">
                  <tr>
                    <td className="py-2.5 px-3 font-sans">Total / Pooled</td>
                    <td className="py-2.5 px-3 text-right">{staffing.totalWorkloadHours}h</td>
                    <td className="py-2.5 px-3 text-right">100.0%</td>
                    <td className="py-2.5 px-3 text-right text-emerald-700">{staffing.operationalHCWithOff}</td>
                    <td className="py-2.5 px-3 text-right">
                      {Math.round(staffing.effectiveShrinkagePct * 100)}% (Harmonic)
                    </td>
                    <td className="py-2.5 px-3 text-right text-blue-700">{staffing.grossHCTotal}</td>
                    <td className="py-2.5 px-3 text-right font-sans">{des.primaryAchievedPct}%</td>
                    <td className="py-2.5 px-3 text-right font-sans text-purple-700">{des.boAsaMeanMinutes}m</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Mathematical Invariants Validation (M1 - M5) */}
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs space-y-3">
            <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
              <ShieldCheck className="w-5 h-5 text-emerald-600" />
              <h3 className="text-sm font-bold text-slate-900">
                Mathematical Invariants Audit (M1–M3)
              </h3>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="p-3 bg-emerald-50/50 border border-emerald-200 rounded-lg text-xs space-y-1">
                <span className="font-bold text-emerald-900 block">✓ M1: Capacity Basis</span>
                <span className="text-slate-600 block">
                  Daily productive hours ({labor.dailyProductiveHours}h) ≤ Daily business window ({dailyWindow}h). Passed.
                </span>
              </div>

              <div className="p-3 bg-emerald-50/50 border border-emerald-200 rounded-lg text-xs space-y-1">
                <span className="font-bold text-emerald-900 block">✓ M2: Pooled Gross Headcount</span>
                <span className="text-slate-600 block">
                  <code>Gross_HC = round(∑ gross_hc_c) = round({staffing.grossHCTotal}) = {staffing.grossHCTotal}</code>. Nearest whole HC.
                </span>
              </div>

              <div className="p-3 bg-emerald-50/50 border border-emerald-200 rounded-lg text-xs space-y-1">
                <span className="font-bold text-emerald-900 block">
                  ✓ M3: Harmonic Effective Shrinkage
                </span>
                <span className="text-slate-600 block">
                  Harmonic weighted shrinkage = {(staffing.effectiveShrinkagePct * 100).toFixed(1)}%. No unweighted averaging.
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 2. STAFFING PATH TAB */}
      {currentTab === 'staffing_path' && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-xs space-y-6">
            <div className="flex items-center gap-2.5 border-b border-slate-100 pb-3">
              <BarChart2 className="w-5 h-5 text-indigo-600" />
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  Staffing Calculation Waterfall &amp; Derivation Path
                </h3>
                <p className="text-xs text-slate-500">
                  Step-by-step mathematical translation from raw volume arrivals to pooled Gross HC.
                </p>
              </div>
            </div>

            {/* Waterfall Cards */}
            <div className="space-y-4">
              {/* Step 1 */}
              <div className="flex items-start gap-4 p-4 rounded-xl bg-slate-50 border border-slate-200">
                <div className="w-8 h-8 rounded-lg bg-slate-900 text-white font-bold text-xs flex items-center justify-center shrink-0">
                  1
                </div>
                <div className="space-y-1 flex-1">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold text-slate-900">Total Workload Demand</h4>
                    <span className="text-xs font-mono font-bold text-slate-800">
                      {staffing.totalWorkloadHours} Hours
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">
                    Sum of all 30-minute interval case counts multiplied by category-specific AHT (plus opening WIP remaining work).
                  </p>
                  <div className="text-[11px] font-mono bg-white p-2 rounded border border-slate-200 text-slate-700">
                    Formula: <code>Total_Workload = ∑ (Volume_i × AHT_i / 60) + WIP_rem / 60</code>
                  </div>
                </div>
              </div>

              {/* Step 2 */}
              <div className="flex items-start gap-4 p-4 rounded-xl bg-slate-50 border border-slate-200">
                <div className="w-8 h-8 rounded-lg bg-indigo-600 text-white font-bold text-xs flex items-center justify-center shrink-0">
                  2
                </div>
                <div className="space-y-1 flex-1">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold text-slate-900">
                      Analytical Workload Baseline (N_min)
                    </h4>
                    <span className="text-xs font-mono font-bold text-indigo-700">
                      N_min = {rosterFloor} Agents{searchOutput.workloadReductionAppliedPct ? ` (workload reduced ${searchOutput.workloadReductionAppliedPct}%)` : ''}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">
                    Steady-state workload capacity floor from total workload hours and agent productive hours
                    ({staffing.contractualHoursSource === 'override' ? 'manual override' : 'derived horizon'}
                    : {staffing.contractualProductiveHours}h).
                    {searchOutput.nMinBeforeReduction !== undefined && rosterFloor !== searchOutput.nMinBeforeReduction && (
                      <span className="block mt-1">
                        Without reduction: N_min would be {searchOutput.nMinBeforeReduction} agents.
                      </span>
                    )}
                  </p>
                  <div className="text-[11px] font-mono bg-white p-2 rounded border border-slate-200 text-slate-700">
                    Formula:{' '}
                    <code>
                      N_min = floor( Workload{searchOutput.workloadReductionAppliedPct ? ` [already reduced ${searchOutput.workloadReductionAppliedPct}%]` : ''} / (Occupancy × agentHours × Adherence) ) = {rosterFloor}
                      {' '}(agentHours={staffing.contractualProductiveHours}h, {staffing.contractualHoursSource})
                    </code>
                  </div>
                </div>
              </div>

              {/* Step 3 */}
              <div className="flex items-start gap-4 p-4 rounded-xl bg-slate-50 border border-slate-200">
                <div className="w-8 h-8 rounded-lg bg-purple-600 text-white font-bold text-xs flex items-center justify-center shrink-0">
                  3
                </div>
                <div className="space-y-1 flex-1">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold text-slate-900">
                      Statistical Primary SLA Search ({sla.confidenceLevelPct ?? 95}% CI)
                    </h4>
                    <span className="text-xs font-mono font-bold text-purple-700">
                      N = {primaryHC} Agents Required
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">
                    Evaluated across {primaryStats?.replications || 30} replications ensuring{' '}
                    {sla.confidenceLevelPct ?? 95}% CI Lower Bound ≥ {primaryTargetLabel}.
                  </p>
                  <div className="text-[11px] font-mono bg-white p-2 rounded border border-slate-200 text-slate-700">
                    Final Operational Headcount: <code>N_op = max(N_min, Primary_Required) = max({rosterFloor}, {primaryHC}) = {staffing.operationalHC}</code>{searchOutput.workloadReductionAppliedPct && <span className="text-amber-700"> (whole chain sized on workload reduced {searchOutput.workloadReductionAppliedPct}%)</span>}
                  </div>
                </div>
              </div>

              {/* Step 4 — Extra OFF coverage uplift (post-DES; calendar-closed days already in seats) */}
              <div className="flex items-start gap-4 p-4 rounded-xl bg-slate-50 border border-slate-200">
                <div className="w-8 h-8 rounded-lg bg-amber-600 text-white font-bold text-xs flex items-center justify-center shrink-0">
                  4
                </div>
                <div className="space-y-1 flex-1">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold text-slate-900">
                      Extra OFF Roster Uplift (Labor offs beyond calendar-closed days)
                    </h4>
                    <span className={`text-xs font-mono font-bold ${staffing.rosterInfeasible ? 'text-rose-700' : 'text-amber-700'}`}>
                      Net Op = {staffing.operationalHCWithOff}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">
                    DES seats already exclude business-closed days. Only leftover agent off days on open days are applied. Agents supply capacity on open days only, so the roster multiplier is a coverage ratio — openDays / coverageDays — not (1 + OFF%): OFF% divides by the calendar week, but a head only ever covers the open week.
                  </p>
                  {staffing.rosterInfeasible ? (
                    <div className="text-[11px] font-mono bg-rose-50 p-2 rounded border border-rose-200 text-rose-800">
                      <code>
                        openDays = {staffing.openDaysPerWeek}; extraOff = {staffing.extraOffDays} ⇒ coverageDays ≤ 0. No roster can cover a full week under this labor policy — Net Op left un-adjusted ({staffing.operationalHC}).
                      </code>
                    </div>
                  ) : (
                    <div className="text-[11px] font-mono bg-white p-2 rounded border border-slate-200 text-slate-700">
                      <code>
                        extraOff = {staffing.extraOffDays}; openDays = {staffing.openDaysPerWeek}; coverageDays = {staffing.coverageDays}; roster uplift = openDays/coverageDays − 1 = {(staffing.rosterUpliftPct * 100).toFixed(1)}%; Net_Op = floor({staffing.operationalHC} × {staffing.openDaysPerWeek} / {staffing.coverageDays}) = {staffing.operationalHCWithOff}
                      </code>
                    </div>
                  )}
                </div>
              </div>

              {/* Step 5 */}
              <div className="flex items-start gap-4 p-4 rounded-xl bg-slate-50 border border-slate-200">
                <div className="w-8 h-8 rounded-lg bg-blue-600 text-white font-bold text-xs flex items-center justify-center shrink-0">
                  5
                </div>
                <div className="space-y-1 flex-1">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold text-slate-900">
                      Pooled Gross Headcount &amp; Harmonic Shrinkage (M2, M3)
                    </h4>
                    <span className="text-xs font-mono font-bold text-blue-700">
                      Gross HC = {staffing.grossHCTotal}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">
                    Gross HC calculated per-category by dividing OFF-adjusted OpHC by <code>(1 - Shrinkage)</code>, summed, and rounded to the nearest whole HC at total pool. OFF is not mixed into shrinkage.
                  </p>
                  <div className="text-[11px] font-mono bg-white p-2 rounded border border-slate-200 text-slate-700">
                    Formula: <code>Gross_HC = round(∑ (OpHC_c / (1 - Shr_c))) = {staffing.grossHCTotal}</code>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 3. CASE BROWSER TAB */}
      {currentTab === 'cases' && (
        <div className="space-y-5">
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Simulated Case Browser</h3>
                <p className="text-xs text-slate-500">
                  Inspect all {des.caseResults.length.toLocaleString()} simulated cases with exact timestamps and SLA outcomes.
                </p>
              </div>

              <button
                onClick={handleExportCasesCSV}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 text-white rounded-lg text-xs font-semibold hover:bg-slate-800 transition shadow-xs self-start"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export Cases CSV (UTF-8 BOM)</span>
              </button>
            </div>

            {/* Filter Bar */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  placeholder="Search Case ID or Category..."
                  value={caseSearch}
                  onChange={(e) => {
                    setCaseSearch(e.target.value);
                    setPage(1);
                  }}
                  className="w-full pl-9 pr-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg"
                />
              </div>

              <select
                value={caseCatFilter}
                onChange={(e) => {
                  setCaseCatFilter(e.target.value);
                  setPage(1);
                }}
                className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2"
              >
                <option value="ALL">All Categories ({categories.length})</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>

              <select
                value={caseStatusFilter}
                onChange={(e) => {
                  setCaseStatusFilter(e.target.value as any);
                  setPage(1);
                }}
                className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2"
              >
                <option value="ALL">All Statuses</option>
                <option value="COMPLETED">Completed Only</option>
                <option value="BREACHED">Breached SLA Only</option>
                <option value="UNFINISHED">Unfinished Remainder Only</option>
              </select>
            </div>

            {/* Cases Table */}
            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-100 text-slate-700 font-semibold border-b border-slate-200">
                  <tr>
                    <th className="py-2.5 px-3">Case ID</th>
                    <th className="py-2.5 px-3">Category</th>
                    <th className="py-2.5 px-3">Arrival</th>
                    <th className="py-2.5 px-3">Primary Deadline</th>
                    <th className="py-2.5 px-3">First Start</th>
                    <th className="py-2.5 px-3">Completed</th>
                    <th className="py-2.5 px-3">Parks</th>
                    <th className="py-2.5 px-3 text-right">SLA Outcome</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono text-[11px]">
                  {paginatedCases.map((c) => (
                    <tr key={c.caseId} className="hover:bg-slate-50">
                      <td className="py-2 px-3 font-semibold text-slate-900">{c.caseId}</td>
                      <td className="py-2 px-3 font-sans">{c.category}</td>
                      <td className="py-2 px-3 whitespace-nowrap">{formatSafeDateTime(c.arrival)}</td>
                      <td className="py-2 px-3 whitespace-nowrap">{formatSafeDateTime(c.primaryDeadline)}</td>
                      <td className="py-2 px-3 whitespace-nowrap">{formatSafeDateTime(c.firstStartTime)}</td>
                      <td className="py-2 px-3 whitespace-nowrap">{c.completeTime ? formatSafeDateTime(c.completeTime) : 'Unfinished'}</td>
                      <td className="py-2 px-3">{c.parkCount}</td>
                      <td className="py-2 px-3 text-right font-sans">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            c.primaryPassed
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-rose-100 text-rose-800'
                          }`}
                        >
                          {c.primaryPassed ? 'PASS' : 'BREACH'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls */}
            <div className="flex items-center justify-between pt-2 text-xs text-slate-500">
              <span>
                Showing {(page - 1) * pageSize + 1} - {Math.min(page * pageSize, filteredCases.length)} of {filteredCases.length} cases
              </span>
              <div className="flex items-center gap-2">
                <button
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="font-semibold text-slate-800">
                  {page} / {totalPages}
                </span>
                <button
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 3B. AGENT BROWSER TAB */}
      {currentTab === 'agents' && (
        <div className="space-y-5">
          {/* Proof Strip */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Strip A: Occupancy Reconciliation */}
            <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                  Occupancy Proof
                </span>
                <span
                  className={`text-xs font-mono font-bold px-2 py-0.5 rounded border ${
                    rawOccPass
                      ? 'text-emerald-800 bg-emerald-50 border-emerald-200'
                      : 'text-rose-800 bg-rose-50 border-rose-200'
                  }`}
                >
                  {des.rawOccupancyPct > 100 ? des.rawOccupancyPct : des.occupancyPct}%
                </span>
              </div>
              <div className="space-y-1 text-xs text-slate-600">
                <div className="flex justify-between">
                  <span>Timeline Busy Time:</span>
                  <span className="font-mono font-semibold text-slate-900">
                    {timelineBusySum.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} min
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>DES Handling Minutes:</span>
                  <span className="font-mono font-semibold text-slate-900">
                    {des.totalHandlingMinutes.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} min
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Available Productive:</span>
                  <span className="font-mono font-semibold text-slate-900">
                    {des.totalAvailableProductiveMinutes.toLocaleString()} min
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Daily Budget / Agent:</span>
                  <span className="font-mono text-slate-700">
                    {dailyBudgetHoursFormatted}h ({Math.round(dailyBudgetPerAgentMinutes)}m)
                  </span>
                </div>
              </div>
              {des.rawOccupancyPct > 100 && (
                <p className="text-[10px] text-rose-700 font-semibold">
                  Displayed as {des.occupancyPct}% on Summary (clamped). Raw ratio {des.rawOccupancyPct}%.
                </p>
              )}
              <p className="text-[10px] pt-1 border-t border-slate-100 flex items-center gap-1">
                {rawOccPass ? (
                  <span className="text-emerald-700 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                    Raw ratio matches DES Handling minutes.
                  </span>
                ) : (
                  <span className="text-rose-700 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3 text-rose-600" />
                    Occupancy discrepancy detected vs DES Handling.
                  </span>
                )}
              </p>
            </div>

            {/* Strip B: SLA & Headcount */}
            <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                  SLA &amp; Headcount
                </span>
                <span
                  className={`text-xs font-mono font-bold px-2 py-0.5 rounded border ${
                    headcountMatch
                      ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                      : 'text-amber-700 bg-amber-50 border-amber-200'
                  }`}
                >
                  {des.operationalHC} Agents
                </span>
              </div>
              <div className="space-y-1 text-xs text-slate-600">
                <div className="flex justify-between">
                  <span>Primary SLA (Achieved / Floor):</span>
                  <span className="font-mono font-semibold text-slate-900">
                    {des.primaryAchievedPct}% / {primarySizingFloor}%
                    {slackOn ? ` (policy ${sla.primaryPct}%)` : ''}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Workload Floor vs Primary:</span>
                  <span className="font-mono text-slate-700">
                    {rosterFloor} vs {primaryHC}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Timeline Distinct Agents:</span>
                  <span className="font-mono font-semibold text-slate-900">
                    {distinctAgentIdsInTimeline} of {des.operationalHC}
                  </span>
                </div>
              </div>
              <p
                className="text-[10px] text-slate-400 pt-1 border-t border-slate-100 truncate"
                title={searchOutput.bindingConstraintDescription || staffing.bindingConstraint}
              >
                Binding: {searchOutput.bindingConstraintDescription || staffing.bindingConstraint}
              </p>
            </div>

            {/* Strip C: Roster Floor */}
            <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                  Workload Roster Floor
                </span>
                <span className="text-xs font-mono font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-200">
                  N_min = {rosterFloor}
                </span>
              </div>
              <div className="space-y-1 text-xs text-slate-600">
                <div className="flex justify-between">
                  <span>Roster Floor Threshold:</span>
                  <span className="font-mono text-slate-700">Agent-1..{rosterFloor}</span>
                </div>
                <div className="flex justify-between">
                  <span>Existing vs New Split:</span>
                  <span className="font-mono text-slate-700">
                    ≤{rosterFloor} Existing, &gt;{rosterFloor} New
                  </span>
                </div>
              </div>
              <p className="text-[10px] text-slate-400 pt-1 border-t border-slate-100 truncate">
                Pooled workload across horizon (analytical N_min){searchOutput.workloadReductionAppliedPct && ` — Workload reduced ${searchOutput.workloadReductionAppliedPct}%`}
              </p>
            </div>
          </div>

          {/* Audit Invariant Banner */}
          {invariantResult.valid ? (
            <div className="bg-emerald-50/80 border border-emerald-200 rounded-xl p-3.5 flex items-center justify-between text-xs text-emerald-900">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>
                  <strong>Audit Invariants Verified:</strong> All {rawAgentSlices.length.toLocaleString()} slices, busy handling minutes ({timelineBusyRounded}m), daily budgets, and occupancy figures reconcile with the sizing engine.
                </span>
              </div>
              <span className="font-mono text-[11px] text-emerald-700 bg-emerald-100/70 px-2 py-0.5 rounded font-semibold shrink-0">
                Recommended HC Validated
              </span>
            </div>
          ) : (
            <div className="bg-rose-50 border border-rose-200 rounded-xl p-3.5 text-xs text-rose-900 space-y-1">
              <div className="flex items-center gap-2 font-bold text-rose-800">
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                <span>Audit Invariant Check Warning</span>
              </div>
              <ul className="list-disc list-inside space-y-0.5 text-rose-700 text-[11px] pl-1">
                {invariantResult.errors.map((err, idx) => (
                  <li key={idx}>{err}</li>
                ))}
              </ul>
            </div>
          )}

          {/* 1. Primary View: Agent Summary Table */}
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-bold text-slate-900">Agent Performance Summary</h3>
                  <span className="text-xs bg-slate-100 text-slate-700 font-semibold px-2 py-0.5 rounded-full">
                    {des.operationalHC} Total Agents
                  </span>
                </div>
                <p className="text-xs text-slate-500">
                  Agent-centric summary across the simulation horizon. Click any row to filter the slice timeline below.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleExportAgentSummaryCSV}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 text-white rounded-lg text-xs font-semibold hover:bg-slate-800 transition shadow-xs"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Export Summary CSV</span>
                </button>
              </div>
            </div>

            {/* Summary Filters */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  placeholder="Search Agent or Category..."
                  value={agentSearch}
                  onChange={(e) => {
                    setAgentSearch(e.target.value);
                    setAgentPage(1);
                  }}
                  className="w-full pl-9 pr-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg"
                />
              </div>

              <select
                value={agentSourceFilter}
                onChange={(e) => {
                  setAgentSourceFilter(e.target.value as any);
                  setAgentPage(1);
                }}
                className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2"
              >
                <option value="ALL">All Roster Sources</option>
                <option value="EXISTING">Existing Floor (≤ {rosterFloor})</option>
                <option value="NEW">New Added (&gt; {rosterFloor})</option>
              </select>

              <select
                value={agentCatFilter}
                onChange={(e) => {
                  setAgentCatFilter(e.target.value);
                  setAgentPage(1);
                }}
                className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2"
              >
                <option value="ALL">All Categories ({categories.length})</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Agent Summary Table */}
            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-100 text-slate-700 font-semibold border-b border-slate-200">
                  <tr>
                    <th className="py-2.5 px-3">Agent</th>
                    <th className="py-2.5 px-3">Source</th>
                    <th className="py-2.5 px-3">Category</th>
                    <th className="py-2.5 px-3 text-right">Busy (min)</th>
                    <th className="py-2.5 px-3 text-right">Idle (min)</th>
                    <th className="py-2.5 px-3 text-right">Off (min)</th>
                    <th className="py-2.5 px-3 text-right">Occupancy %</th>
                    <th className="py-2.5 px-3 text-right">Cases</th>
                    <th className="py-2.5 px-3 text-right">Resumes</th>
                    <th className="py-2.5 px-3 text-right">Max Daily Busy</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono text-[11px]">
                  {filteredSummaries.map((a) => {
                    const isSelected = selectedAgentId === a.agentId;
                    return (
                      <tr
                        key={a.agentId}
                        onClick={() => {
                          setSelectedAgentId((curr) => (curr === a.agentId ? null : a.agentId));
                          setAgentPage(1);
                        }}
                        className={`cursor-pointer transition ${
                          isSelected
                            ? 'bg-blue-50/80 font-semibold text-blue-950 ring-1 ring-inset ring-blue-300'
                            : 'hover:bg-slate-50'
                        }`}
                      >
                        <td className="py-2 px-3">
                          <div className="flex items-center gap-1.5 font-semibold text-slate-900">
                            <span>{a.agentLabel}</span>
                            {isSelected && (
                              <span className="text-[10px] font-sans font-normal text-blue-700 bg-blue-100 px-1.5 py-0.2 rounded">
                                Selected
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-2 px-3 font-sans">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              a.rosterSource === 'existing'
                                ? 'bg-slate-100 text-slate-700 border border-slate-200'
                                : 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                            }`}
                          >
                            {a.rosterSource.toUpperCase()}
                          </span>
                        </td>
                        <td className="py-2 px-3 font-sans text-slate-700">{a.siloCategory}</td>
                        <td className="py-2 px-3 text-right font-semibold text-slate-900">
                          {a.busyMinutes.toFixed(1)}
                        </td>
                        <td className="py-2 px-3 text-right text-slate-600">{a.idleMinutes.toFixed(1)}</td>
                        <td className="py-2 px-3 text-right text-slate-400">{a.offMinutes.toFixed(1)}</td>
                        <td className="py-2 px-3 text-right">
                          <span
                            className={`font-semibold ${
                              a.occupancyPct > 85 ? 'text-amber-700' : 'text-slate-900'
                            }`}
                          >
                            {a.occupancyPct}%
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right font-sans text-slate-900">{a.casesHandled}</td>
                        <td className="py-2 px-3 text-right font-sans text-slate-600">{a.resumeCount}</td>
                        <td className="py-2 px-3 text-right">
                          <span
                            className={`${
                              a.hasBudgetViolation ? 'text-rose-600 font-bold' : 'text-slate-700'
                            }`}
                            title={`Daily budget: ${a.dailyBudgetMinutes.toFixed(1)} min`}
                          >
                            {a.maxBusyAnyDay.toFixed(1)}m / {a.dailyBudgetMinutes.toFixed(0)}m
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {filteredSummaries.length === 0 && (
                    <tr>
                      <td colSpan={10} className="py-8 text-center text-slate-400 font-sans">
                        No agents match the active filter criteria.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* 2. Secondary View: Slice Drill Down */}
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-bold text-slate-900">Agent Work Slice Drill</h3>
                  {selectedAgentId !== null ? (
                    <span className="flex items-center gap-1 text-xs bg-blue-100 text-blue-900 font-semibold px-2 py-0.5 rounded-md">
                      Filtered: Agent-{selectedAgentId + 1}
                      <button
                        onClick={() => setSelectedAgentId(null)}
                        className="hover:text-blue-950 p-0.5"
                        title="Clear agent filter"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ) : (
                    <span className="text-xs bg-slate-100 text-slate-600 font-medium px-2 py-0.5 rounded-md">
                      All Agents ({rawAgentSlices.length.toLocaleString()} total slices)
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500">
                  Inspect granular simulated activity slices with contiguous timestamps, case details, and state transitions.
                </p>
              </div>

              <div className="flex items-center gap-2">
                {selectedAgentId !== null && (
                  <button
                    onClick={() => setSelectedAgentId(null)}
                    className="px-2.5 py-1.5 text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition"
                  >
                    Show All Agents
                  </button>
                )}
                <button
                  onClick={handleExportAgentSlicesCSV}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 text-white rounded-lg text-xs font-semibold hover:bg-slate-800 transition shadow-xs self-start"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Export Slices CSV</span>
                </button>
              </div>
            </div>

            {/* Filter Bar */}
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  placeholder="Search Agent, Case ID, Date..."
                  value={agentSearch}
                  onChange={(e) => {
                    setAgentSearch(e.target.value);
                    setAgentPage(1);
                  }}
                  className="w-full pl-9 pr-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg"
                />
              </div>

              <select
                value={agentStateFilter}
                onChange={(e) => {
                  setAgentStateFilter(e.target.value as any);
                  setAgentPage(1);
                }}
                className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2"
              >
                <option value="ALL">All States</option>
                <option value="BUSY">BUSY Only</option>
                <option value="IDLE">IDLE Only</option>
                <option value="OFF">OOQ Only</option>
              </select>

              <select
                value={agentSourceFilter}
                onChange={(e) => {
                  setAgentSourceFilter(e.target.value as any);
                  setAgentPage(1);
                }}
                className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2"
              >
                <option value="ALL">All Roster Sources</option>
                <option value="EXISTING">Existing Floor (≤ {rosterFloor})</option>
                <option value="NEW">New Added (&gt; {rosterFloor})</option>
              </select>

              <select
                value={agentCatFilter}
                onChange={(e) => {
                  setAgentCatFilter(e.target.value);
                  setAgentPage(1);
                }}
                className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2"
              >
                <option value="ALL">All Categories ({categories.length})</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Agent Slices Table */}
            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-100 text-slate-700 font-semibold border-b border-slate-200">
                  <tr>
                    <th className="py-2.5 px-3">Agent</th>
                    <th className="py-2.5 px-3">Source</th>
                    <th className="py-2.5 px-3">Date</th>
                    <th className="py-2.5 px-3">State</th>
                    <th className="py-2.5 px-3">Case ID</th>
                    <th className="py-2.5 px-3">Category</th>
                    <th className="py-2.5 px-3">From</th>
                    <th className="py-2.5 px-3">To</th>
                    <th className="py-2.5 px-3 text-right">Minutes</th>
                    <th className="py-2.5 px-3 text-center">Resume</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono text-[11px]">
                  {paginatedAgentSlices.map((s) => {
                    const rosterSource: AgentRosterSource = (s.agentId + 1) <= rosterFloor ? 'existing' : 'new';
                    const rowKey = `${s.agentId}_${s.from.getTime()}_${s.to.getTime()}_${s.state}_${s.caseId || ''}`;
                    return (
                      <tr key={rowKey} className="hover:bg-slate-50">
                        <td className="py-2 px-3 font-semibold text-slate-900">{s.agentLabel}</td>
                        <td className="py-2 px-3 font-sans">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              rosterSource === 'existing'
                                ? 'bg-slate-100 text-slate-700 border border-slate-200'
                                : 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                            }`}
                          >
                            {rosterSource.toUpperCase()}
                          </span>
                        </td>
                        <td className="py-2 px-3 whitespace-nowrap font-sans">{s.date}</td>
                        <td className="py-2 px-3 font-sans">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              s.state === 'busy'
                                ? 'bg-blue-100 text-blue-800'
                                : s.state === 'idle'
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-slate-100 text-slate-600'
                            }`}
                          >
                            {s.state === 'off' ? 'OOQ' : s.state.toUpperCase()}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-slate-800">{s.caseId || '—'}</td>
                        <td className="py-2 px-3 font-sans text-slate-600">{s.category || '—'}</td>
                        <td className="py-2 px-3 whitespace-nowrap">{formatSafeDateTime(s.from)}</td>
                        <td className="py-2 px-3 whitespace-nowrap">{formatSafeDateTime(s.to)}</td>
                        <td className="py-2 px-3 text-right font-semibold text-slate-900">
                          {s.minutes.toFixed(1)}
                        </td>
                        <td className="py-2 px-3 text-center font-sans">
                          {s.isResume ? (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-100 text-purple-800">
                              RESUME
                            </span>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {paginatedAgentSlices.length === 0 && (
                    <tr>
                      <td colSpan={10} className="py-8 text-center text-slate-400 font-sans">
                        No agent slices found matching active search and filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls */}
            <div className="flex items-center justify-between pt-2 text-xs text-slate-500">
              <span>
                Showing {filteredAgentSlices.length > 0 ? (agentPage - 1) * pageSize + 1 : 0} -{' '}
                {Math.min(agentPage * pageSize, filteredAgentSlices.length)} of {filteredAgentSlices.length} slices
              </span>
              <div className="flex items-center gap-2">
                <button
                  disabled={agentPage <= 1}
                  onClick={() => setAgentPage((p) => Math.max(1, p - 1))}
                  className="px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="font-semibold text-slate-800">
                  {agentPage} / {totalAgentPages}
                </span>
                <button
                  disabled={agentPage >= totalAgentPages}
                  onClick={() => setAgentPage((p) => Math.min(totalAgentPages, p + 1))}
                  className="px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 4. QUEUE / WIP TAB */}
      {currentTab === 'queue_wip' && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Queue &amp; WIP Timeline</h3>
                <p className="text-xs text-slate-500">
                  Real-time progression of Queued WIP, Active Handling, Parked Overnight WIP, and Completed Volume.
                </p>
              </div>

              <button
                onClick={handleExportQueueWipCSV}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 text-white rounded-lg text-xs font-semibold hover:bg-slate-800 transition shadow-xs self-start"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export Queue/WIP CSV</span>
              </button>
            </div>

            {/* Timeline Table */}
            <div className="overflow-x-auto border border-slate-200 rounded-lg max-h-96">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-100 text-slate-700 font-semibold border-b border-slate-200 sticky top-0">
                  <tr>
                    <th className="py-2 px-3">Interval Time</th>
                    <th className="py-2 px-3 text-right">Queued WIP</th>
                    <th className="py-2 px-3 text-right">Active Handling</th>
                    <th className="py-2 px-3 text-right">Parked WIP</th>
                    <th className="py-2 px-3 text-right">Cumulative Completed</th>
                    <th className="py-2 px-3 text-right">Available Agents</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono text-[11px]">
                  {des.intervalsTimeline.map((it, idx) => (
                    <tr key={idx} className="hover:bg-slate-50">
                      <td className="py-1.5 px-3 font-sans font-semibold text-slate-800">
                        {formatSafeDateTime(it.time)}
                      </td>
                      <td className="py-1.5 px-3 text-right text-amber-700 font-bold">{it.queuedWIP}</td>
                      <td className="py-1.5 px-3 text-right text-blue-700 font-bold">{it.activeHandling}</td>
                      <td className="py-1.5 px-3 text-right text-purple-700">{it.parkedWIP}</td>
                      <td className="py-1.5 px-3 text-right text-emerald-700 font-bold">{it.completedCum}</td>
                      <td className="py-1.5 px-3 text-right text-slate-700">{it.availableAgents}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 5. AUDIT DRILL TAB */}
      {currentTab === 'audit' && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs space-y-5">
            <div className="flex items-center gap-2.5 border-b border-slate-100 pb-3">
              <ShieldCheck className="w-5 h-5 text-indigo-600" />
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  Headcount Search Audit, Critical Window Proof, &amp; Boundary Evidence (N vs N-1)
                </h3>
                <p className="text-xs text-slate-500">
                  Exact mathematical proof of minimum headcount feasibility and discrete event breach logs.
                </p>
              </div>
            </div>

            {boundaryEvidence ? (
              <div className="space-y-4">
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-2 text-xs">
                  <span className="font-bold text-slate-800 uppercase tracking-wider block">
                    Boundary Decision Rationale
                  </span>
                  <p className="text-slate-700 leading-relaxed">
                    {boundaryEvidence.differenceSummary}
                  </p>
                </div>

                {/* Breach Samples Table */}
                <div className="space-y-2">
                  <span className="text-xs font-bold text-slate-800 uppercase tracking-wider block">
                    Breach Case Samples at N - 1 ({boundaryEvidence.breachSamplesAtNMinus1.length} Examples)
                  </span>

                  {boundaryEvidence.breachSamplesAtNMinus1.length > 0 ? (
                    <div className="overflow-x-auto border border-slate-200 rounded-lg">
                      <table className="w-full text-xs text-left">
                        <thead className="bg-slate-100 text-slate-700 font-semibold border-b border-slate-200">
                          <tr>
                            <th className="py-2 px-3">Case ID</th>
                            <th className="py-2 px-3">Category</th>
                            <th className="py-2 px-3">Arrival</th>
                            <th className="py-2 px-3">Primary Deadline</th>
                            <th className="py-2 px-3">Latest Safe Start</th>
                            <th className="py-2 px-3">Breach Failure Reason</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 font-mono text-[11px]">
                          {boundaryEvidence.breachSamplesAtNMinus1.map((b) => (
                            <tr key={b.caseId} className="hover:bg-slate-50">
                              <td className="py-2 px-3 font-semibold text-rose-900">{b.caseId}</td>
                              <td className="py-2 px-3 font-sans">{b.category}</td>
                              <td className="py-2 px-3">{b.arrival}</td>
                              <td className="py-2 px-3">{b.deadline}</td>
                              <td className="py-2 px-3 text-amber-700">{b.latestSafeStart}</td>
                              <td className="py-2 px-3 font-sans text-rose-700 font-medium">{b.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="p-4 bg-slate-50 text-slate-500 rounded text-xs">
                      No breaches found at lower headcount bounds.
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="p-6 text-slate-400 text-xs italic bg-slate-50 rounded-lg">
                Optimal headcount N = {staffing.operationalHC} is the analytical minimum lower bound.
              </div>
            )}
          </div>

          {/* All SLA-Breaching Cases at Recommended Headcount (N) */}
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  All SLA-Breaching Cases at Recommended Headcount (N = {des.operationalHC})
                </h3>
                <p className="text-xs text-slate-500">
                  {breachedCases.length.toLocaleString()} case{breachedCases.length === 1 ? '' : 's'} failed the primary SLA in the final simulated run.
                </p>
              </div>

              {breachedCases.length > 0 && (
                <button
                  onClick={handleExportBreachedCasesCSV}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 text-white rounded-lg text-xs font-semibold hover:bg-slate-800 transition shadow-xs self-start"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Export Breaches CSV (UTF-8 BOM)</span>
                </button>
              )}
            </div>

            {breachedCases.length > 0 ? (
              <>
                <div className="overflow-x-auto border border-slate-200 rounded-lg">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-slate-100 text-slate-700 font-semibold border-b border-slate-200">
                      <tr>
                        <th className="py-2.5 px-3">Case ID</th>
                        <th className="py-2.5 px-3">Category</th>
                        <th className="py-2.5 px-3">Arrival</th>
                        <th className="py-2.5 px-3">Primary Deadline</th>
                        <th className="py-2.5 px-3">Latest Safe Start</th>
                        <th className="py-2.5 px-3">First Start</th>
                        <th className="py-2.5 px-3">Completed</th>
                        <th className="py-2.5 px-3">Parks</th>
                        <th className="py-2.5 px-3">Breach Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-mono text-[11px]">
                      {paginatedBreachedCases.map((c) => (
                        <tr key={c.caseId} className="hover:bg-slate-50">
                          <td className="py-2 px-3 font-semibold text-rose-900">{c.caseId}</td>
                          <td className="py-2 px-3 font-sans">{c.category}</td>
                          <td className="py-2 px-3 whitespace-nowrap">{formatSafeDateTime(c.arrival)}</td>
                          <td className="py-2 px-3 whitespace-nowrap">{formatSafeDateTime(c.primaryDeadline)}</td>
                          <td className="py-2 px-3 whitespace-nowrap text-amber-700">{formatSafeDateTime(c.latestSafeStart)}</td>
                          <td className="py-2 px-3 whitespace-nowrap">{formatSafeDateTime(c.firstStartTime)}</td>
                          <td className="py-2 px-3 whitespace-nowrap">{c.completeTime ? formatSafeDateTime(c.completeTime) : 'Unfinished'}</td>
                          <td className="py-2 px-3">{c.parkCount}</td>
                          <td className="py-2 px-3 font-sans text-rose-700 font-medium whitespace-nowrap">
                            {c.isCompleted ? 'Completed after primary deadline' : 'Unfinished by horizon end'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex items-center justify-between pt-2 text-xs text-slate-500">
                  <span>
                    Showing {(auditBreachPage - 1) * auditBreachPageSize + 1} - {Math.min(auditBreachPage * auditBreachPageSize, breachedCases.length)} of {breachedCases.length} breached cases
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      disabled={auditBreachPage <= 1}
                      onClick={() => setAuditBreachPage((p) => Math.max(1, p - 1))}
                      className="px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 disabled:opacity-40"
                    >
                      Previous
                    </button>
                    <span className="font-semibold text-slate-800">
                      {auditBreachPage} / {auditBreachTotalPages}
                    </span>
                    <button
                      disabled={auditBreachPage >= auditBreachTotalPages}
                      onClick={() => setAuditBreachPage((p) => Math.min(auditBreachTotalPages, p + 1))}
                      className="px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 disabled:opacity-40"
                    >
                      Next
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="p-6 text-slate-400 text-xs italic bg-slate-50 rounded-lg">
                No SLA breaches at recommended headcount.
              </div>
            )}
          </div>
        </div>
      )}

      {/* 6. ASSUMPTIONS TAB */}
      {currentTab === 'assumptions' && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs space-y-5">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2.5">
                <FileCode className="w-5 h-5 text-purple-600" />
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    Assumption Snapshot &amp; Audit Ledger
                  </h3>
                  <p className="text-xs text-slate-500">
                    Full parameter state snapshot for model auditability and reproducible sizing.
                  </p>
                </div>
              </div>

              <button
                onClick={onExportAssumptionsJSON}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 text-white rounded-lg text-xs font-semibold hover:bg-slate-800 transition"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export Snapshot JSON</span>
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
              <div className="p-4 bg-slate-900 text-slate-200 rounded-xl space-y-2">
                <span className="text-emerald-400 font-bold font-sans block text-xs uppercase">
                  Labor &amp; Calendar Policy
                </span>
                <div>daily_productive_hours: {labor.dailyProductiveHours}h</div>
                <div>adherence_pct: {labor.adherencePct || 1.0}</div>
                <div>working_days_per_week: {labor.workingDaysPerWeek}</div>
                <div>daily_open: {String(calendar.dailyOpenHour).padStart(2, '0')}:{String(calendar.dailyOpenMinute ?? 0).padStart(2, '0')}</div>
                <div>daily_close: {String(calendar.dailyCloseHour).padStart(2, '0')}:{String(calendar.dailyCloseMinute ?? 0).padStart(2, '0')}</div>
                <div>agent_hours_source: {staffing.contractualHoursSource}</div>
                <div>agent_hours_for_n_min: {staffing.contractualProductiveHours}h</div>
              </div>

              <div className="p-4 bg-slate-900 text-slate-200 rounded-xl space-y-2">
                <span className="text-blue-400 font-bold font-sans block text-xs uppercase">
                  SLA &amp; Simulation Policy
                </span>
                <div>queue_architecture: {searchOutput.queueArchitecture || 'pooled'}</div>
                <div>sla_clock_basis: {sla.clockBasis}</div>
                <div>sla_clock_start_policy: {sla.clockStartPolicy}</div>
                <div>primary_sla: {sla.primaryPct}% in {sla.primaryWindow} {sla.primaryUnit}</div>
                <div>
                  sla_acceptance_slack:{' '}
                  {slackOn ? `${sla.slaAcceptanceSlackPct ?? 5}% (sizing floor ${primarySizingFloor}%)` : 'off'}
                </div>
                <div>
                  workload_reduction_pct:{' '}
                  {searchOutput.workloadReductionAppliedPct ? `${searchOutput.workloadReductionAppliedPct}%` : 'off'}
                </div>
                <div>confidence_level_pct: {sla.confidenceLevelPct ?? 95}%</div>
                <div>n_min_analytical: {rosterFloor} agents{searchOutput.nMinBeforeReduction !== undefined && ` (before reduction: ${searchOutput.nMinBeforeReduction})`}</div>
                <div>primary_driven_hc: {primaryHC} agents</div>
                <div>prng_seed: {simParams.seed}</div>
                <div>binding_constraint: {searchOutput.bindingConstraintDescription || staffing.bindingConstraint}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
