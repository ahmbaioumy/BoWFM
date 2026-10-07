/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  CalendarConfig,
  CategoryConfig,
  ColumnMapping,
  DQResult,
  HCSearchOutput,
  LaborConfig,
  OpeningWIPCase,
  SimulationParams,
  SLAPolicyConfig,
  StandardInterval,
  SearchProgressState,
} from './types/wfm';
import {
  autoSuggestColumnMapping,
  discoverAndSyncCategories,
  mapRawRecordsToIntervals,
  parseCSVRaw,
  type CSVProblem,
  remapCasesToIntervalSpelling,
  validateDataQuality,
} from './utils/csv-parser';
import { searchOptimalHCAsync } from './utils/hc-search';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { Sidebar, MainFlow, FLOW_TABS } from './components/Sidebar';
import { ParamsPanel } from './components/ParamsPanel';
import { DemandFlow } from './components/DemandFlow';
import { ConfigFlow } from './components/ConfigFlow';
import { RunFlow } from './components/RunFlow';
import { ResultsFlow } from './components/ResultsFlow';
import { SensitivityFlow } from './components/SensitivityFlow';
import { SimulationProgressModal } from './components/SimulationProgressModal';
import { ResetConfirmModal } from './components/ResetConfirmModal';
import { buildSampleDataset, nextMondayAt8 } from './utils/sample-data';
import { diffRunInputs, RunInputs } from './utils/run-inputs';

import {
  DEFAULT_CALENDAR,
  DEFAULT_CATEGORIES,
  DEFAULT_LABOR,
  DEFAULT_SIM_PARAMS,
  DEFAULT_SLA,
} from './utils/default-config';

export function App() {
  // Navigation State
  const [currentFlow, setCurrentFlow] = useState<MainFlow>('demand');
  const [currentTab, setCurrentTab] = useState<string>('upload');
  const [paramsPanelOpen, setParamsPanelOpen] = useState(false);

  // Configuration State
  const [calendar, setCalendar] = useState<CalendarConfig>(DEFAULT_CALENDAR);
  const [labor, setLabor] = useState<LaborConfig>(DEFAULT_LABOR);
  const [sla, setSla] = useState<SLAPolicyConfig>(DEFAULT_SLA);
  const [categories, setCategories] = useState<CategoryConfig[]>(DEFAULT_CATEGORIES);
  const [simParams, setSimParams] = useState<SimulationParams>(DEFAULT_SIM_PARAMS);

  // Snapshot of working/off days from just before "24/7 Operations" was ticked on, so
  // un-ticking restores it. Lives here (not in CalendarConfigPanel's local state) because
  // that panel unmounts on every tab switch (DemandFlow renders it conditionally) — a
  // component-local snapshot is discarded the moment the planner changes tabs.
  const [pre24x7Snapshot, setPre24x7Snapshot] = useState<{
    workingDays: number[];
    workingDaysPerWeek: number;
    offDaysPerWeek: number;
  } | null>(null);

  function handleToggle24x7(isChecked: boolean) {
    if (isChecked) {
      setPre24x7Snapshot({
        workingDays: calendar.workingDays,
        workingDaysPerWeek: labor.workingDaysPerWeek,
        offDaysPerWeek: labor.offDaysPerWeek,
      });
      setCalendar({ ...calendar, is24x7: true, workingDays: [0, 1, 2, 3, 4, 5, 6] });
      setLabor({ ...labor, workingDaysPerWeek: 7, offDaysPerWeek: 0 });
    } else {
      const restore = pre24x7Snapshot ?? {
        workingDays: DEFAULT_CALENDAR.workingDays,
        workingDaysPerWeek: DEFAULT_LABOR.workingDaysPerWeek,
        offDaysPerWeek: DEFAULT_LABOR.offDaysPerWeek,
      };
      setCalendar({ ...calendar, is24x7: false, workingDays: restore.workingDays });
      setLabor({ ...labor, workingDaysPerWeek: restore.workingDaysPerWeek, offDaysPerWeek: restore.offDaysPerWeek });
      setPre24x7Snapshot(null);
    }
  }

  // Demand & Data State
  const [rawHeaders, setRawHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Record<string, string>[]>([]);
  const [rawDelimiter, setRawDelimiter] = useState<string>(',');
  // Non-blocking warnings the file reader raised for the loaded file; set with rawRows, cleared on sample load and reset.
  const [rawFileWarnings, setRawFileWarnings] = useState<CSVProblem[]>([]);
  const [columnMapping, setColumnMapping] = useState<ColumnMapping>({
    intervalStartCol: '',
    volumeCol: '',
  });
  const [openingWIP, setOpeningWIP] = useState<OpeningWIPCase[]>([]);

  // Simulation & Search State
  const [searchOutput, setSearchOutput] = useState<HCSearchOutput | null>(null);
  // Exact settings the current searchOutput was computed with. Results render from this (not the live
  // settings), so audits/formulas/exports describe the run even if the planner edits config afterwards.
  const [runInputs, setRunInputs] = useState<RunInputs | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const [showProgressModal, setShowProgressModal] = useState(false);
  // Reset confirmation gate. 'reset' = plain Sidebar Reset click. { type: 'upload' | 'sample' }
  // carries the pending action to run AFTER the shared reset body, so uploading new data (or
  // loading a sample) into a tab that already has data/settings loaded is forced through the
  // same "you are about to lose your current work" confirmation as Reset itself — a stale
  // prior session can no longer silently blend into a fresh upload. null = modal closed.
  type PendingResetAction =
    | 'reset'
    | { type: 'upload'; text: string; filename: string }
    | { type: 'sample'; sampleType: 'claims' | 'support' | 'healthcare' };
  const [pendingResetAction, setPendingResetAction] = useState<PendingResetAction | null>(null);
  const [searchProgress, setSearchProgress] = useState<SearchProgressState | null>(null);
  const [simulationError, setSimulationError] = useState<string | null>(null);
  const [importNotification, setImportNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const liveInputs = useMemo<RunInputs>(
    () => ({ calendar, labor, sla, categories, simParams }),
    [calendar, labor, sla, categories, simParams]
  );
  const settingsChangedSinceRun = useMemo(() => diffRunInputs(runInputs, liveInputs), [runInputs, liveInputs]);

  // Map Raw Rows to Standard Intervals
  const intervals = useMemo(() => {
    if (rawRows.length === 0 || !columnMapping.intervalStartCol || !columnMapping.volumeCol) {
      return [];
    }
    return mapRawRecordsToIntervals(rawRows, columnMapping, 'General', rawDelimiter);
  }, [rawRows, columnMapping, rawDelimiter]);

  // Synchronize Categories Discovery when Intervals change
  useEffect(() => {
    if (intervals.length > 0) {
      setCategories((prev) => discoverAndSyncCategories(intervals, prev, sla));
      // Stored backlog cases follow a category respelling (same step as the category rename).
      setOpeningWIP((prev) => remapCasesToIntervalSpelling(prev, intervals));
    }
  }, [intervals, sla]);

  // Removed calendar tab from Labor Config — snap off stale selection
  useEffect(() => {
    if (currentFlow === 'config' && currentTab === 'calendar') {
      setCurrentTab('labor');
    }
  }, [currentFlow, currentTab]);

  // Run Data Quality (DQ) Validation
  const dqResult = useMemo<DQResult | null>(() => {
    if (intervals.length === 0) return null;
    return validateDataQuality({
      intervals,
      mapping: columnMapping,
      categories,
      calendar,
      labor,
      sla,
      openingWIP,
      fileWarnings: rawFileWarnings,
    });
  }, [intervals, columnMapping, categories, calendar, labor, sla, openingWIP, rawFileWarnings]);

  // Handle File Upload. If a prior session already has data loaded, route through the reset
  // confirmation first (see pendingResetAction) rather than blending the new file into
  // whatever calendar/labor/SLA/categories/opening-WIP a previous upload left behind. A
  // brand-new tab with nothing loaded yet applies the file immediately — nothing to lose.
  // The file is read and checked FIRST: a file with an error is refused (message returned to the upload box)
  // and nothing changes - no reset prompt, no state change, the current session stays exactly as it is.
  function handleFileUpload(text: string, filename: string): string | null {
    const refusal = parseCSVRaw(text).problems.find((p) => p.severity === 'error');
    if (refusal) return refusal.message;
    if (rawRows.length > 0) {
      setPendingResetAction({ type: 'upload', text, filename });
      return null;
    }
    applyFileUpload(text, filename);
    return null;
  }

  function applyFileUpload(text: string, filename: string) {
    setSimulationError(null);
    setSearchOutput(null);
    setRunInputs(null);

    const { headers, rows, delimiter, problems } = parseCSVRaw(text);
    setRawHeaders(headers);
    setRawRows(rows);
    setRawDelimiter(delimiter);
    setRawFileWarnings(problems.filter((p) => p.severity === 'warning'));

    const autoMapping = autoSuggestColumnMapping(headers, rows);
    setColumnMapping(autoMapping);

    if (rows.length > 0 && autoMapping.intervalStartCol && autoMapping.volumeCol) {
      const initialIntervals = mapRawRecordsToIntervals(rows, autoMapping, 'General', delimiter);
      if (initialIntervals.length > 0) {
        setCategories((prev) => discoverAndSyncCategories(initialIntervals, prev, sla));
        setOpeningWIP((prev) => remapCasesToIntervalSpelling(prev, initialIntervals));
      }
    }

    setCurrentTab('mapping');
  }

  // Load Validated Sample Datasets. Same stale-session guard as handleFileUpload above.
  function handleLoadSample(sampleType: 'claims' | 'support' | 'healthcare') {
    if (rawRows.length > 0) {
      setPendingResetAction({ type: 'sample', sampleType });
      return;
    }
    applyLoadSample(sampleType);
  }

  function applyLoadSample(sampleType: 'claims' | 'support' | 'healthcare') {
    setSimulationError(null);
    setSearchOutput(null);
    setRunInputs(null);

    // Pure generator in utils/sample-data.ts — same code the regression tests run with a fixed Monday.
    const { headers, rows } = buildSampleDataset(sampleType, nextMondayAt8(new Date()));

    setRawHeaders(headers);
    setRawRows(rows);
    setRawDelimiter(',');
    setRawFileWarnings([]);
    const mapping: ColumnMapping = {
      intervalStartCol: 'IntervalStart',
      volumeCol: 'Volume',
      categoryCol: 'Category',
    };
    setColumnMapping(mapping);

    const sampleIntervals = mapRawRecordsToIntervals(rows, mapping, 'General', ',');
    setCategories((prev) => discoverAndSyncCategories(sampleIntervals, prev, sla));
    setOpeningWIP((prev) => remapCasesToIntervalSpelling(prev, sampleIntervals));
    setCurrentTab('dq');
  }

  const isSimulatingRef = useRef(false);
  const cancelSimulationRef = useRef(false);

  // Execute Backoffice Sizing Search
  async function handleRunSizing() {
    // Clear previous simulation error and stale results
    setSimulationError(null);
    setSearchOutput(null);
    setRunInputs(null);

    if (!dqResult || !dqResult.passed) {
      setSimulationError(
        'Data Quality checks must pass before simulation sizing can begin. Please check your labor/calendar configuration and review the Data Quality (DQ) tab.'
      );
      setCurrentFlow('demand');
      setCurrentTab('dq');
      return;
    }

    cancelSimulationRef.current = false;
    setIsSimulating(true);
    setShowProgressModal(true);
    isSimulatingRef.current = true;
    setSearchProgress({
      status: 'initializing',
      phase: 'Phase 1: Analytical Baseline Initialization',
      percent: 5,
      evaluatedHistory: [],
      currentMessage: 'Preparing horizon workload and calculating analytical lower bound N_min...',
    });

    // Captured at run start: exactly what is passed to the search (not re-read after the await).
    const runSnapshot: RunInputs = { calendar, labor, sla, categories, simParams };

    try {
      const result = await searchOptimalHCAsync({
        intervals,
        openingWIP,
        categories: runSnapshot.categories,
        calendar: runSnapshot.calendar,
        labor: runSnapshot.labor,
        sla: runSnapshot.sla,
        seed: runSnapshot.simParams.seed,
        userMaxHC: runSnapshot.simParams.maxHCSearch,
        replications: runSnapshot.simParams.replications || 30,
        queueArchitecture: runSnapshot.simParams.queueArchitecture || 'pooled',
        dispatchFairness: runSnapshot.simParams.dispatchFairness,
        onProgress: (progress) => {
          setSearchProgress(progress);
        },
        shouldCancel: () => cancelSimulationRef.current,
      });

      if (!cancelSimulationRef.current) {
        // Clear previous errors on successful run
        setSimulationError(null);
        setSearchOutput(result);
        setRunInputs(runSnapshot);
        setIsSimulating(false);
      }
    } catch (err: any) {
      const desc = err instanceof Error ? err.message : String(err || 'Unknown error occurred');
      if (desc === 'SIMULATION_CANCELLED' || cancelSimulationRef.current) {
        // User explicitly stopped or cancelled simulation; dismiss cleanly without showing error
        setSimulationError(null);
        setSearchOutput(null);
        setRunInputs(null);
        setShowProgressModal(false);
        setSearchProgress(null);
      } else {
        setSimulationError(
          `Simulation execution failed: ${desc}. Please check your configuration parameters and the Data Quality gate before re-running.`
        );
        setSearchOutput(null);
        setRunInputs(null);
        setShowProgressModal(false);
        setSearchProgress(null);
        console.error('Simulation error:', err);
      }
    } finally {
      setIsSimulating(false);
      isSimulatingRef.current = false;
    }
  }

  function handleCancelSizing() {
    cancelSimulationRef.current = true;
    setIsSimulating(false);
    setShowProgressModal(false);
    setSearchProgress(null);
  }

  // Reset All State
  function handleResetAll() {
    setPendingResetAction('reset');
  }

  // Single confirm handler for the Sidebar's plain Reset AND for a new upload/sample-load
  // requested while a prior session already had data loaded (pendingResetAction carries
  // which). The full-reset body always runs first, then the pending action (if any) applies
  // against the freshly-defaulted state — a new upload can never blend with stale state.
  function handleConfirmResetAll() {
    const action = pendingResetAction;

    setCalendar(DEFAULT_CALENDAR);
    setLabor(DEFAULT_LABOR);
    setSla(DEFAULT_SLA);
    setCategories(DEFAULT_CATEGORIES);
    setSimParams(DEFAULT_SIM_PARAMS);
    setRawHeaders([]);
    setRawRows([]);
    setRawDelimiter(',');
    setRawFileWarnings([]);
    setColumnMapping({ intervalStartCol: '', volumeCol: '' });
    setOpeningWIP([]);
    setSearchOutput(null);
    setRunInputs(null);
    setSimulationError(null);
    setIsSimulating(false);
    setShowProgressModal(false);
    setSearchProgress(null);
    setParamsPanelOpen(false);
    setPendingResetAction(null);
    setCurrentFlow('demand');
    setCurrentTab('upload');

    if (action && action !== 'reset' && action.type === 'upload') {
      applyFileUpload(action.text, action.filename);
      setImportNotification({
        type: 'success',
        message: 'Previous configuration and data were reset before loading the new file.',
      });
    } else if (action && action !== 'reset' && action.type === 'sample') {
      applyLoadSample(action.sampleType);
      setImportNotification({
        type: 'success',
        message: 'Previous configuration and data were reset before loading the sample dataset.',
      });
    } else {
      setImportNotification({
        type: 'success',
        message: 'All configuration parameters, demand data, and simulation results have been reset to defaults.',
      });
    }
    setTimeout(() => {
      setImportNotification(null);
    }, 4500);
  }

  // Export JSON Parameters
  // Shared by the Config-screen export (live settings) and the Results export (run snapshot).
  function buildConfigSnapshot(src: RunInputs) {
    return {
      calendar: src.calendar,
      labor: src.labor,
      sla: src.sla,
      categories: src.categories,
      simParams: src.simParams,
      columnMapping,
      exportedAt: new Date().toISOString(),
    };
  }

  function downloadConfigSnapshot(configSnapshot: ReturnType<typeof buildConfigSnapshot>) {

    const blob = new Blob([JSON.stringify(configSnapshot, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `wfm_config_snapshot_${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function handleExportParams() {
    downloadConfigSnapshot(buildConfigSnapshot(liveInputs));
  }

  // Results-screen export: the settings the displayed numbers were computed with.
  function handleExportRunSnapshotParams() {
    downloadConfigSnapshot(buildConfigSnapshot(runInputs ?? liveInputs));
  }

  // Import JSON Parameters
  function handleImportParams(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const json = JSON.parse(evt.target?.result as string);
        if (json.calendar) setCalendar(json.calendar);
        if (json.labor) setLabor(json.labor);
        if (json.sla) {
          const n = parseFloat(String(json.sla.confidenceLevelPct ?? ''));
          const slackRaw = parseFloat(String(json.sla.slaAcceptanceSlackPct ?? ''));
          const workloadReductionRaw = parseFloat(String(json.sla.workloadReductionPct ?? ''));
          setSla({
            ...DEFAULT_SLA,
            ...json.sla,
            confidenceLevelPct: Number.isFinite(n)
              ? Math.min(99.9, Math.max(50, Math.round(n * 10) / 10))
              : 95,
            slaAcceptanceSlackEnabled: json.sla.slaAcceptanceSlackEnabled === true,
            slaAcceptanceSlackPct: Number.isFinite(slackRaw)
              ? Math.min(20, Math.max(1, Math.round(slackRaw)))
              : DEFAULT_SLA.slaAcceptanceSlackPct,
            workloadReductionEnabled: json.sla.workloadReductionEnabled === true,
            workloadReductionPct: Number.isFinite(workloadReductionRaw)
              ? Math.min(50, Math.max(1, Math.round(workloadReductionRaw)))
              : DEFAULT_SLA.workloadReductionPct,
            // Clock start is derived from the basis: business_time always starts at next open;
            // wall_clock keeps the file's value (an absent value means 'arrival', not the default).
            clockStartPolicy:
              (json.sla.clockBasis ?? DEFAULT_SLA.clockBasis) === 'business_time'
                ? 'next_open'
                : (json.sla.clockStartPolicy ?? 'arrival'),
          });
        }
        if (json.categories) setCategories(json.categories);
        if (json.simParams) setSimParams(json.simParams);
        if (json.columnMapping) setColumnMapping(json.columnMapping);
        setImportNotification({
          type: 'success',
          message: 'Configuration successfully loaded from JSON file.',
        });
        setTimeout(() => setImportNotification(null), 4000);
      } catch (err) {
        setImportNotification({
          type: 'error',
          message: 'Invalid JSON configuration file format.',
        });
        setTimeout(() => setImportNotification(null), 4000);
      }
    };
    reader.readAsText(file);
  }

  return (
    <div className="flex h-full w-full min-h-0 flex-1 overflow-hidden bg-slate-100 font-sans text-slate-900 antialiased">
      {/* Primary Left Navigation Sidebar */}
      <Sidebar
        currentFlow={currentFlow}
        currentTab={currentTab}
        onSelectFlow={(flow, defaultTab) => {
          setCurrentFlow(flow);
          if (defaultTab) setCurrentTab(defaultTab);
          else setCurrentTab(FLOW_TABS[flow][0].id);
        }}
        onSelectTab={(tab) => setCurrentTab(tab)}
        onResetAll={handleResetAll}
        onExportParams={handleExportParams}
        onImportParams={handleImportParams}
        hasResults={searchOutput !== null}
        dqPassed={dqResult?.passed === true}
        paramsPanelOpen={paramsPanelOpen}
        onToggleParamsPanel={() => setParamsPanelOpen((prev) => !prev)}
      />

      {/* Main Center Stage Workspace */}
      <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {/* Top Workflow Header */}
        <header className="h-14 bg-white border-b border-slate-200 px-6 flex items-center justify-between shrink-0 shadow-xs z-10">
          <div className="flex items-center gap-3">
            <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">
              {currentFlow.toUpperCase()}
            </span>
            <span className="text-slate-300">/</span>
            <h2 className="text-sm font-black text-slate-900">
              {FLOW_TABS[currentFlow].find((t) => t.id === currentTab)?.label || currentTab}
            </h2>
          </div>

          <div className="flex items-center gap-3">
            {dqResult && (
              <span
                className={`text-xs px-2.5 py-1 rounded-full font-bold uppercase tracking-tight ${
                  dqResult.passed
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-rose-100 text-rose-800'
                }`}
              >
                {dqResult.passed ? 'DQ Gate Cleared' : 'DQ Gate Blocked'}
              </span>
            )}

            {searchOutput?.staffing && (
              <div className="flex items-center gap-2 bg-slate-900 text-white px-3 py-1 rounded-lg text-xs font-mono">
                <span className="text-emerald-400 font-bold">
                  Net HC: {searchOutput.staffing.operationalHCWithOff}
                </span>
                <span className="text-slate-500">|</span>
                <span className="text-blue-400 font-bold">
                  Gross HC: {searchOutput.staffing.grossHCTotal}
                </span>
              </div>
            )}
          </div>
        </header>

        {/* Dynamic Flow Content View */}
        <div className="flex-1 min-h-0 overflow-y-auto p-6">
          <div className="max-w-6xl mx-auto space-y-6">
            {/* Import Notification Banner */}
            {importNotification && (
              <div
                className={`p-4 rounded-xl border text-xs flex items-center justify-between shadow-xs ${
                  importNotification.type === 'success'
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                    : 'bg-rose-50 border-rose-200 text-rose-900'
                }`}
              >
                <div className="flex items-center gap-2 font-medium">
                  {importNotification.type === 'success' ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                  )}
                  <span>{importNotification.message}</span>
                </div>
                <button
                  onClick={() => setImportNotification(null)}
                  className="text-xs font-semibold text-slate-500 hover:text-slate-700 px-2 py-0.5"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* Global Simulation Error Alert (when outside Run Flow) */}
            {simulationError && currentFlow !== 'run' && (
              <div
                role="alert"
                className="bg-rose-50 border border-rose-300 rounded-xl p-4 shadow-sm flex items-start justify-between gap-3 text-rose-900"
              >
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <h4 className="text-xs font-bold text-rose-900 uppercase tracking-wider">
                      Simulation Error
                    </h4>
                    <p className="text-xs text-rose-800 leading-relaxed font-medium">
                      {simulationError}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setSimulationError(null)}
                  className="text-xs font-semibold text-rose-600 hover:text-rose-800 px-2.5 py-1 rounded bg-rose-100/60 hover:bg-rose-100 transition shrink-0"
                >
                  Dismiss
                </button>
              </div>
            )}

            {currentFlow === 'demand' && (
              <DemandFlow
                currentTab={currentTab}
                rawHeaders={rawHeaders}
                rawRowsCount={rawRows.length}
                rawRowsPreview={rawRows.slice(0, 5)}
                columnMapping={columnMapping}
                onUpdateColumnMapping={setColumnMapping}
                onFileUpload={handleFileUpload}
                onLoadSample={handleLoadSample}
                dqResult={dqResult}
                openingWIP={openingWIP}
                onUpdateOpeningWIP={setOpeningWIP}
                categories={categories}
                intervals={intervals}
                calendar={calendar}
                onUpdateCalendar={setCalendar}
                labor={labor}
                onUpdateLabor={setLabor}
                onToggle24x7={handleToggle24x7}
              />
            )}

            {currentFlow === 'config' && (
              <ConfigFlow
                currentTab={currentTab}
                calendar={calendar}
                labor={labor}
                sla={sla}
                categories={categories}
                intervals={intervals}
                openingWIP={openingWIP}
                onUpdateLabor={setLabor}
                onUpdateSLA={setSla}
                onUpdateCategories={setCategories}
                dispatchFairness={simParams.dispatchFairness}
                onUpdateDispatchFairness={(dispatchFairness) => setSimParams((p) => ({ ...p, dispatchFairness }))}
              />
            )}

            {currentFlow === 'run' && (
              <RunFlow
                currentTab={currentTab}
                calendar={calendar}
                labor={labor}
                sla={sla}
                categories={categories}
                intervals={intervals}
                openingWIP={openingWIP}
                dqResult={dqResult}
                simParams={simParams}
                onUpdateSimParams={setSimParams}
                onRunSizing={handleRunSizing}
                isRunning={isSimulating}
                searchProgress={searchProgress}
                hasResults={searchOutput !== null}
                onJumpToResults={() => {
                  setCurrentFlow('results');
                  setCurrentTab('summary');
                }}
                simulationError={simulationError}
                onDismissError={() => setSimulationError(null)}
              />
            )}

            {currentFlow === 'results' && (
              <ResultsFlow
                currentTab={currentTab}
                searchOutput={searchOutput}
                calendar={(runInputs ?? liveInputs).calendar}
                labor={(runInputs ?? liveInputs).labor}
                sla={(runInputs ?? liveInputs).sla}
                categories={(runInputs ?? liveInputs).categories}
                intervals={intervals}
                openingWIP={openingWIP}
                simParams={(runInputs ?? liveInputs).simParams}
                settingsChangedSinceRun={settingsChangedSinceRun}
                onExportAssumptionsJSON={handleExportRunSnapshotParams}
              />
            )}

            {currentFlow === 'sensitivity' && (
              <SensitivityFlow
                currentTab={currentTab}
                calendar={calendar}
                labor={labor}
                sla={sla}
                categories={categories}
                intervals={intervals}
                openingWIP={openingWIP}
                simParams={simParams}
                onRunSizing={handleRunSizing}
              />
            )}
          </div>
        </div>
      </main>

      {/* Right Drawer: Persistent Parameters & Invariants Inspector */}
      <ParamsPanel
        isOpen={paramsPanelOpen}
        onClose={() => setParamsPanelOpen(false)}
        calendar={calendar}
        labor={labor}
        sla={sla}
        categories={categories}
        simParams={simParams}
      />

      {/* Real-time Headcount Simulation Search Modal */}
      <SimulationProgressModal
        isOpen={showProgressModal}
        progress={searchProgress}
        sla={sla}
        onCancel={handleCancelSizing}
        onClose={() => {
          setShowProgressModal(false);
          setCurrentFlow('results');
          setCurrentTab('summary');
        }}
      />

      {/* Confirmation Modal for Resetting All Data & Parameters */}
      <ResetConfirmModal
        isOpen={pendingResetAction !== null}
        onConfirm={handleConfirmResetAll}
        onCancel={() => setPendingResetAction(null)}
      />
    </div>
  );
}

export default App;
