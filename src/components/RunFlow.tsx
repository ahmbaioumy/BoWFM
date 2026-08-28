/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  CalendarConfig,
  CategoryConfig,
  DQResult,
  LaborConfig,
  OpeningWIPCase,
  SimulationParams,
  SLAPolicyConfig,
  StandardInterval,
  SearchProgressState,
} from '../types/wfm';
import { getDailyWindowLengthHours } from '../utils/calendar';
import {
  CheckCircle2,
  XCircle,
  PlayCircle,
  Cpu,
  Loader2,
  ArrowRight,
  ShieldCheck,
  Activity,
  AlertTriangle,
  Layers,
  Sparkles,
  Info,
} from 'lucide-react';

interface RunFlowProps {
  currentTab: string;
  calendar: CalendarConfig;
  labor: LaborConfig;
  sla: SLAPolicyConfig;
  categories: CategoryConfig[];
  intervals: StandardInterval[];
  openingWIP: OpeningWIPCase[];
  dqResult: DQResult | null;
  simParams: SimulationParams;
  onUpdateSimParams: (params: SimulationParams) => void;
  onRunSizing: () => void;
  isRunning: boolean;
  searchProgress?: SearchProgressState | null;
  hasResults: boolean;
  onJumpToResults: () => void;
  simulationError?: string | null;
  onDismissError?: () => void;
}

export function RunFlow({
  currentTab,
  calendar,
  labor,
  sla,
  categories,
  intervals,
  openingWIP,
  dqResult,
  simParams,
  onUpdateSimParams,
  onRunSizing,
  isRunning,
  searchProgress,
  hasResults,
  onJumpToResults,
  simulationError,
  onDismissError,
}: RunFlowProps) {
  // Pre-flight checks evaluation
  const dailyWindow = getDailyWindowLengthHours(calendar);
  const capacityValid = labor.dailyProductiveHours <= dailyWindow + 0.05;

  const categoriesComplete =
    dqResult && dqResult.categoriesFound.length > 0
      ? dqResult.categoriesFound.every((catName) => {
          const cfg = categories.find((c) => c.name === catName);
          return cfg && cfg.ahtMinutes > 0 && cfg.shrinkagePct >= 0 && cfg.shrinkagePct < 1;
        })
      : categories.length > 0;

  const fileMapped = intervals.length > 0;
  const dqPassed = dqResult?.passed === true;
  const workloadPositive = (dqResult?.totalWorkloadHours || 0) > 0;

  const allGatesPassed =
    capacityValid && categoriesComplete && fileMapped && dqPassed && workloadPositive;

  const gateChecks = [
    {
      title: '1. Labor & Business Calendar Configured',
      passed: labor.dailyProductiveHours > 0 && labor.workingDaysPerWeek > 0,
      details: `${labor.dailyProductiveHours}h daily, ${labor.workingDaysPerWeek} days/wk, open ${String(calendar.dailyOpenHour).padStart(2, '0')}:${String(calendar.dailyOpenMinute ?? 0).padStart(2, '0')}-${String(calendar.dailyCloseHour).padStart(2, '0')}:${String(calendar.dailyCloseMinute ?? 0).padStart(2, '0')}`,
    },
    {
      title: '2. Capacity Basis Rule Compliant (M1)',
      passed: capacityValid,
      details: `Daily productive hours (${labor.dailyProductiveHours}h) ≤ Daily business window (${dailyWindow}h)`,
    },
    {
      title: '3. AHT & Shrinkage Set for Every Inflow Category',
      passed: categoriesComplete,
      details: `${categories.length} categories configured with fixed AHT and shrinkage %`,
    },
    {
      title: '4. Mandatory 30-Minute Inflow File Mapped',
      passed: fileMapped,
      details: `${intervals.length} half-hour interval records mapped`,
    },
    {
      title: '5. Data Quality (DQ) Gate Passed',
      passed: dqPassed,
      details: dqPassed ? 'No duplicate/missing slots or timestamp errors' : 'Stop-the-line: Fix DQ errors before sizing',
    },
    {
      title: '6. Workload Demand > 0 Hours',
      passed: workloadPositive,
      details: `Total workload = ${dqResult?.totalWorkloadHours || 0} productive hours`,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Simulation Error Alert */}
      {simulationError && (
        <div
          role="alert"
          className="bg-rose-50 border border-rose-300 rounded-xl p-4 shadow-sm flex items-start justify-between gap-3 text-rose-900 animate-in fade-in duration-150"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h4 className="text-xs font-bold text-rose-900 uppercase tracking-wider">
                Simulation Execution Error
              </h4>
              <p className="text-xs text-rose-800 leading-relaxed font-medium">
                {simulationError}
              </p>
              <p className="text-[11px] text-rose-700">
                Please check your Labor / Calendar configuration and ensure the Data Quality (DQ) gate has cleared before re-running.
              </p>
            </div>
          </div>
          {onDismissError && (
            <button
              onClick={onDismissError}
              className="text-xs font-semibold text-rose-600 hover:text-rose-800 px-2.5 py-1 rounded bg-rose-100/60 hover:bg-rose-100 transition shrink-0"
            >
              Dismiss
            </button>
          )}
        </div>
      )}

      {/* 1. PRE-FLIGHT TAB */}
      {currentTab === 'preflight' && (
        <div className="space-y-5">
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-emerald-600" />
                <div>
                  <h3 className="text-sm font-bold text-slate-900">Mandatory Start-Gate Checklist</h3>
                  <p className="text-xs text-slate-500">
                    Authority: PRD Start Gate. Exact analytical feasibility and stochastic sizing cannot begin without satisfying all requirements.
                  </p>
                </div>
              </div>

              <span
                className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${
                  allGatesPassed
                    ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                    : 'bg-rose-100 text-rose-800 border border-rose-300'
                }`}
              >
                {allGatesPassed ? 'ALL GATES CLEARED' : 'GATE BLOCKED'}
              </span>
            </div>

            <div className="space-y-2.5">
              {gateChecks.map((gate, i) => (
                <div
                  key={i}
                  className={`p-3.5 rounded-lg border text-xs flex items-center justify-between gap-3 ${
                    gate.passed
                      ? 'bg-emerald-50/40 border-emerald-200 text-slate-800'
                      : 'bg-rose-50/60 border-rose-200 text-rose-900'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    {gate.passed ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    ) : (
                      <XCircle className="w-4 h-4 text-rose-600 shrink-0" />
                    )}
                    <div>
                      <span className="font-bold block">{gate.title}</span>
                      <span className="text-[11px] text-slate-500">{gate.details}</span>
                    </div>
                  </div>

                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                      gate.passed ? 'bg-emerald-200/60 text-emerald-800' : 'bg-rose-200 text-rose-900'
                    }`}
                  >
                    {gate.passed ? 'PASSED' : 'REQUIRED'}
                  </span>
                </div>
              ))}
            </div>

            {/* Inflow Operating Hours Breakdown Diagnostic */}
            {dqResult?.operatingHoursBreakdown && (
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-2.5 mt-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                    <Info className="w-4 h-4 text-indigo-600" />
                    Arrival Inflow vs Operating Hours Diagnostic
                  </span>
                  <span className="text-xs font-mono text-slate-500">
                    Total: {dqResult.totalVolume.toLocaleString()} cases
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg">
                    <span className="text-[10px] text-emerald-700 font-bold uppercase block">Inside Hours</span>
                    <span className="text-sm font-black text-emerald-900 font-mono">
                      {dqResult.operatingHoursBreakdown.insidePct}%
                    </span>
                    <span className="text-[10px] text-emerald-600 block">
                      {dqResult.operatingHoursBreakdown.insideVolume.toLocaleString()} cases
                    </span>
                  </div>
                  <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg">
                    <span className="text-[10px] text-amber-700 font-bold uppercase block">Weekday Off-Hours</span>
                    <span className="text-sm font-black text-amber-900 font-mono">
                      {dqResult.operatingHoursBreakdown.weekdayOffPct}%
                    </span>
                    <span className="text-[10px] text-amber-600 block">
                      {dqResult.operatingHoursBreakdown.weekdayOffVolume.toLocaleString()} cases
                    </span>
                  </div>
                  <div className="p-2.5 bg-purple-50 border border-purple-200 rounded-lg">
                    <span className="text-[10px] text-purple-700 font-bold uppercase block">Weekend / Non-Work</span>
                    <span className="text-sm font-black text-purple-900 font-mono">
                      {dqResult.operatingHoursBreakdown.weekendPct}%
                    </span>
                    <span className="text-[10px] text-purple-600 block">
                      {dqResult.operatingHoursBreakdown.weekendVolume.toLocaleString()} cases
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 2. SIMULATE TAB */}
      {currentTab === 'simulate' && (
        <div className="space-y-5">
          <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-xs space-y-6">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2.5">
                <Cpu className="w-5 h-5 text-indigo-600" />
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    Dual-Algorithm Sizing Engine (Analytical Baseline + Statistical DES)
                  </h3>
                  <p className="text-xs text-slate-500">
                    Calculates the analytical steady-state workload baseline, plus statistical Primary SLA requirement over ≥30 replications with {sla.confidenceLevelPct ?? 95}% CI.
                  </p>
                </div>
              </div>
            </div>

            {/* Simulation & Algorithm Configuration */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 bg-slate-50 p-4 rounded-xl border border-slate-200">
              {/* Queue Architecture */}
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-700 block flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5 text-indigo-600" />
                  Queue Architecture Mode
                </label>
                <select
                  value={simParams.queueArchitecture || 'pooled'}
                  onChange={(e) =>
                    onUpdateSimParams({
                      ...simParams,
                      queueArchitecture: e.target.value as 'pooled' | 'siloed',
                    })
                  }
                  className="w-full px-3 py-1.5 text-xs bg-white border border-slate-200 rounded font-semibold text-slate-800"
                >
                  <option value="pooled">Pooled (Cross-Skilled Queue)</option>
                  <option value="siloed">Siloed (Dedicated Agents per Category)</option>
                </select>
                <span className="text-[11px] text-slate-400 block">
                  Pooled agents handle any category; Siloed enforces independent dedicated teams.
                </span>
              </div>

              {/* Statistical Replications */}
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-700 block flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-purple-600" />
                  Statistical Replications (≥30)
                </label>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={simParams.replications || 30}
                  onChange={(e) =>
                    onUpdateSimParams({
                      ...simParams,
                      replications: Math.max(1, parseInt(e.target.value) || 30),
                    })
                  }
                  className="w-full px-3 py-1.5 text-xs bg-white border border-slate-200 rounded font-mono font-bold"
                />
                <span className="text-[11px] text-slate-400 block">
                  Runs 30+ seeds to compute {sla.confidenceLevelPct ?? 95}% Confidence Interval for Primary SLA.
                </span>
              </div>

              {/* Max Headcount Search Ceiling (userMaxHC) */}
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-700 block flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                  Search Ceiling (userMaxHC)
                </label>
                <input
                  type="number"
                  min="1"
                  max="5000"
                  value={simParams.maxHCSearch || 500}
                  onChange={(e) =>
                    onUpdateSimParams({
                      ...simParams,
                      maxHCSearch: Math.max(1, parseInt(e.target.value) || 500),
                    })
                  }
                  className="w-full px-3 py-1.5 text-xs bg-white border border-slate-200 rounded font-mono font-bold"
                />
                <span className="text-[11px] text-slate-400 block">
                  Upper ceiling for search. Increase for large multi-thousand case datasets.
                </span>
              </div>

              {/* PRNG Seed */}
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-700 block">
                  Base PRNG Seed
                </label>
                <input
                  type="number"
                  value={simParams.seed}
                  onChange={(e) =>
                    onUpdateSimParams({
                      ...simParams,
                      seed: parseInt(e.target.value) || 12345,
                    })
                  }
                  className="w-full px-3 py-1.5 text-xs bg-white border border-slate-200 rounded font-mono font-bold"
                />
                <span className="text-[11px] text-slate-400 block">
                  Deterministic common random numbers across runs.
                </span>
              </div>
            </div>

            {/* Action Trigger Button */}
            <div className="pt-2 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="text-xs text-slate-500">
                {allGatesPassed ? (
                  <span className="text-emerald-700 font-semibold">
                    ✓ All pre-flight start gates cleared. Engine ready.
                  </span>
                ) : (
                  <span className="text-rose-600 font-semibold">
                    ⚠ Complete pre-flight start gates before running simulation.
                  </span>
                )}
              </div>

              <div className="flex items-center gap-3">
                <button
                  id="run-des-sizing-btn"
                  onClick={onRunSizing}
                  disabled={!allGatesPassed || isRunning}
                  className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-emerald-600 text-white font-bold text-xs hover:bg-emerald-700 transition disabled:opacity-40 disabled:cursor-not-allowed shadow-md shadow-emerald-900/20"
                >
                  {isRunning ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Executing Headcount Sizing Engine...</span>
                    </>
                  ) : (
                    <>
                      <PlayCircle className="w-4 h-4" />
                      <span>Run Backoffice Sizing Engine</span>
                    </>
                  )}
                </button>

                {hasResults && (
                  <button
                    onClick={onJumpToResults}
                    className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-slate-900 text-white font-semibold text-xs hover:bg-slate-800 transition"
                  >
                    <span>View Sizing Results</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Live Progress Bar & Iteration Feed */}
            {isRunning && searchProgress && (
              <div className="mt-4 p-4 rounded-xl bg-slate-900 text-white border border-slate-800 space-y-4 animate-in fade-in duration-200 shadow-lg">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Activity className="w-4 h-4 text-emerald-400 animate-pulse" />
                    <span className="text-xs font-bold text-slate-200">
                      {searchProgress.phase}
                    </span>
                  </div>
                  <span className="text-xs font-mono font-bold text-emerald-400">
                    {searchProgress.percent}%
                  </span>
                </div>

                {/* Progress track */}
                <div className="w-full bg-slate-800 rounded-full h-2.5 overflow-hidden p-0.5 border border-slate-700">
                  <div
                    className="bg-linear-to-r from-blue-500 via-indigo-400 to-emerald-400 h-full rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${Math.max(5, searchProgress.percent)}%` }}
                  />
                </div>

                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span className="flex items-center gap-1.5 text-slate-300">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400 shrink-0" />
                    {searchProgress.currentMessage}
                  </span>
                  {searchProgress.currentN && (
                    <span className="font-mono px-2 py-0.5 rounded bg-slate-800 text-emerald-300 font-bold">
                      Candidate N = {searchProgress.currentN}
                    </span>
                  )}
                </div>

                {searchProgress.evaluatedHistory.length > 0 && (
                  <div className="pt-2 border-t border-slate-800">
                    <div className="flex items-center justify-between text-[10px] text-slate-400 uppercase font-bold mb-1.5">
                      <span>Candidate Headcounts Evaluated</span>
                      <span>{searchProgress.evaluatedHistory.length} Tested</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {searchProgress.evaluatedHistory.map((h, i) => (
                        <span
                          key={i}
                          className={`text-[10px] font-mono px-2 py-0.5 rounded border flex items-center gap-1 ${
                            h.passed
                              ? 'bg-emerald-950/80 border-emerald-500 text-emerald-300 font-bold'
                              : 'bg-slate-800/80 border-slate-700 text-slate-400'
                          }`}
                        >
                          {h.passed ? (
                            <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                          ) : (
                            <AlertTriangle className="w-3 h-3 text-rose-400" />
                          )}
                          N={h.hc}: Pri={h.primaryPct}%
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
