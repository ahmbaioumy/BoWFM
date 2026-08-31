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

// Initial Defaults
const DEFAULT_CALENDAR: CalendarConfig = {
  workingDays: [1, 2, 3, 4, 5], // Mon-Fri
  dailyOpenHour: 8,
  dailyOpenMinute: 0,
  dailyCloseHour: 18,
  dailyCloseMinute: 0,
  holidays: [],
};

const DEFAULT_LABOR: LaborConfig = {
  dailyProductiveHours: 7.5,
  adherencePct: 1.0,
  workingDaysPerWeek: 5,
  offDaysPerWeek: 2,
  contractualHoursSource: 'derived',
  contractualProductiveHoursOverride: 0,
  shifts: [],
};

const DEFAULT_SLA: SLAPolicyConfig = {
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
  slaAcceptanceSlackEnabled: false,
  slaAcceptanceSlackPct: 5,
  workloadReductionEnabled: false,
  workloadReductionPct: 5,
  minCoverageEnabled: true,
  minAgentsPerInterval: 1,
};

const DEFAULT_CATEGORIES: CategoryConfig[] = [
  {
    id: 'cat_claims_auto',
    name: 'Claims_Auto',
    ahtMinutes: 35,
    shrinkagePct: 0.20,
    priority: 1,
    primaryPct: 80,
    primaryWindow: 6,
    primaryUnit: 'hours',
    primaryWindowMinutes: 360,
    boAsaTarget: 60,
    boAsaUnit: 'minutes',
  },
  {
    id: 'cat_claims_home',
    name: 'Claims_Home',
    ahtMinutes: 45,
    shrinkagePct: 0.20,
    priority: 2,
    primaryPct: 80,
    primaryWindow: 6,
    primaryUnit: 'hours',
    primaryWindowMinutes: 360,
    boAsaTarget: 60,
    boAsaUnit: 'minutes',
  },
  {
    id: 'cat_claims_life',
    name: 'Claims_Life',
    ahtMinutes: 60,
    shrinkagePct: 0.25,
    priority: 3,
    primaryPct: 80,
    primaryWindow: 8,
    primaryUnit: 'hours',
    primaryWindowMinutes: 480,
    boAsaTarget: 90,
    boAsaUnit: 'minutes',
  },
];

const DEFAULT_SIM_PARAMS: SimulationParams = {
  seed: 12345,
  maxHCSearch: 500,
  replications: 30,
  queueArchitecture: 'pooled',
};

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
  const [columnMapping, setColumnMapping] = useState<ColumnMapping>({
    intervalStartCol: '',
    volumeCol: '',
  });
  const [openingWIP, setOpeningWIP] = useState<OpeningWIPCase[]>([]);

  // Simulation & Search State
  const [searchOutput, setSearchOutput] = useState<HCSearchOutput | null>(null);
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

  // Map Raw Rows to Standard Intervals
  const intervals = useMemo(() => {
    if (rawRows.length === 0 || !columnMapping.intervalStartCol || !columnMapping.volumeCol) {
      return [];
    }
    return mapRawRecordsToIntervals(rawRows, columnMapping);
  }, [rawRows, columnMapping]);

  // Synchronize Categories Discovery when Intervals change
  useEffect(() => {
    if (intervals.length > 0) {
      setCategories((prev) => discoverAndSyncCategories(intervals, prev, sla));
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
    });
  }, [intervals, columnMapping, categories, calendar, labor, sla, openingWIP]);

  // Handle File Upload. If a prior session already has data loaded, route through the reset
  // confirmation first (see pendingResetAction) rather than blending the new file into
  // whatever calendar/labor/SLA/categories/opening-WIP a previous upload left behind. A
  // brand-new tab with nothing loaded yet applies the file immediately — nothing to lose.
  function handleFileUpload(text: string, filename: string) {
    if (rawRows.length > 0) {
      setPendingResetAction({ type: 'upload', text, filename });
      return;
    }
    applyFileUpload(text, filename);
  }

  function applyFileUpload(text: string, filename: string) {
    setSimulationError(null);
    setSearchOutput(null);

    const { headers, rows } = parseCSVRaw(text);
    setRawHeaders(headers);
    setRawRows(rows);

    const autoMapping = autoSuggestColumnMapping(headers, rows);
    setColumnMapping(autoMapping);

    if (rows.length > 0 && autoMapping.intervalStartCol && autoMapping.volumeCol) {
      const initialIntervals = mapRawRecordsToIntervals(rows, autoMapping);
      if (initialIntervals.length > 0) {
        setCategories((prev) => discoverAndSyncCategories(initialIntervals, prev, sla));
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

    let rows: Record<string, string>[] = [];
    const headers = ['IntervalStart', 'Volume', 'Category'];

    const baseDate = new Date();
    // Round to next Monday 08:00
    baseDate.setDate(baseDate.getDate() + ((1 + 7 - baseDate.getDay()) % 7 || 7));
    baseDate.setHours(8, 0, 0, 0);

    const daysCount = sampleType === 'claims' ? 5 : sampleType === 'support' ? 7 : 10;
    const cats =
      sampleType === 'claims'
        ? ['Claims_Auto', 'Claims_Home', 'Claims_Life']
        : sampleType === 'support'
        ? ['Billing_Support', 'Technical_Escalations']
        : ['Prior_Authorization', 'Pharmacy_Appeals', 'Provider_Inquiries'];

    let rowIndex = 0;
    for (let d = 0; d < daysCount; d++) {
      const dayDate = new Date(baseDate);
      dayDate.setDate(baseDate.getDate() + d);

      for (let hour = 8; hour < 18; hour++) {
        for (let min of [0, 30]) {
          const slotDate = new Date(dayDate);
          slotDate.setHours(hour, min, 0, 0);
          const pad = (n: number) => String(n).padStart(2, '0');
          const startIso = `${slotDate.getFullYear()}-${pad(slotDate.getMonth() + 1)}-${pad(slotDate.getDate())}T${pad(slotDate.getHours())}:${pad(slotDate.getMinutes())}:00`;

          cats.forEach((cat, cIdx) => {
            // Realistic diurnal bell curve volume
            const peakFactor = Math.sin(((hour - 8 + (min / 60)) / 10) * Math.PI);
            const baseVol = sampleType === 'claims' ? 4 : sampleType === 'support' ? 6 : 3;
            const vol = Math.max(1, Math.round(baseVol * peakFactor * (1 + cIdx * 0.4) + (rowIndex % 3)));

            rows.push({
              IntervalStart: startIso,
              Volume: String(vol),
              Category: cat,
            });
            rowIndex++;
          });
        }
      }
    }

    setRawHeaders(headers);
    setRawRows(rows);
    const mapping: ColumnMapping = {
      intervalStartCol: 'IntervalStart',
      volumeCol: 'Volume',
      categoryCol: 'Category',
    };
    setColumnMapping(mapping);

    const sampleIntervals = mapRawRecordsToIntervals(rows, mapping);
    setCategories((prev) => discoverAndSyncCategories(sampleIntervals, prev, sla));
    setCurrentTab('dq');
  }

  const isSimulatingRef = useRef(false);
  const cancelSimulationRef = useRef(false);

  // Execute Backoffice Sizing Search
  async function handleRunSizing() {
    // Clear previous simulation error and stale results
    setSimulationError(null);
    setSearchOutput(null);

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

    try {
      const result = await searchOptimalHCAsync({
        intervals,
        openingWIP,
        categories,
        calendar,
        labor,
        sla,
        seed: simParams.seed,
        userMaxHC: simParams.maxHCSearch,
        replications: simParams.replications || 30,
        queueArchitecture: simParams.queueArchitecture || 'pooled',
        onProgress: (progress) => {
          setSearchProgress(progress);
        },
        shouldCancel: () => cancelSimulationRef.current,
      });

      if (!cancelSimulationRef.current) {
        // Clear previous errors on successful run
        setSimulationError(null);
        setSearchOutput(result);
        setIsSimulating(false);
      }
    } catch (err: any) {
      const desc = err instanceof Error ? err.message : String(err || 'Unknown error occurred');
      if (desc === 'SIMULATION_CANCELLED' || cancelSimulationRef.current) {
        // User explicitly stopped or cancelled simulation; dismiss cleanly without showing error
        setSimulationError(null);
        setSearchOutput(null);
        setShowProgressModal(false);
        setSearchProgress(null);
      } else {
        setSimulationError(
          `Simulation execution failed: ${desc}. Please check your configuration parameters and the Data Quality gate before re-running.`
        );
        setSearchOutput(null);
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
    setColumnMapping({ intervalStartCol: '', volumeCol: '' });
    setOpeningWIP([]);
    setSearchOutput(null);
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
  function handleExportParams() {
    const configSnapshot = {
      calendar,
      labor,
      sla,
      categories,
      simParams,
      columnMapping,
      exportedAt: new Date().toISOString(),
    };

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
                calendar={calendar}
                labor={labor}
                sla={sla}
                categories={categories}
                intervals={intervals}
                openingWIP={openingWIP}
                simParams={simParams}
                onExportAssumptionsJSON={handleExportParams}
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
