/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  CalendarConfig,
  CategoryConfig,
  ColumnMapping,
  DQResult,
  LaborConfig,
  OpeningWIPCase,
  StandardInterval,
} from '../types/wfm';
import { generateNextWIPId, parseCSVRaw, parseFlexibleDate } from '../utils/csv-parser';
import { formatDateTime24 } from '../utils/calendar';
import { CalendarConfigPanel } from './CalendarConfigPanel';
import {
  UploadCloud,
  FileSpreadsheet,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Plus,
  Trash2,
  Table,
  Sparkles,
  Upload,
  FileText,
  Info,
  X,
  Layers,
} from 'lucide-react';

interface DemandFlowProps {
  currentTab: string;
  rawHeaders: string[];
  rawRowsCount: number;
  rawRowsPreview: Record<string, string>[];
  columnMapping: ColumnMapping;
  onUpdateColumnMapping: (mapping: ColumnMapping) => void;
  onFileUpload: (text: string, filename: string) => void;
  onLoadSample: (sampleType: 'claims' | 'support' | 'healthcare') => void;
  dqResult: DQResult | null;
  openingWIP: OpeningWIPCase[];
  onUpdateOpeningWIP: (wip: OpeningWIPCase[]) => void;
  categories: CategoryConfig[];
  intervals: StandardInterval[];
  calendar: CalendarConfig;
  onUpdateCalendar: (cal: CalendarConfig) => void;
  labor?: LaborConfig;
  onUpdateLabor?: (labor: LaborConfig) => void;
  onToggle24x7?: (isChecked: boolean) => void;
}

export function DemandFlow({
  currentTab,
  rawHeaders,
  rawRowsCount,
  rawRowsPreview,
  columnMapping,
  onUpdateColumnMapping,
  onFileUpload,
  onLoadSample,
  dqResult,
  openingWIP,
  onUpdateOpeningWIP,
  categories,
  intervals,
  calendar,
  onUpdateCalendar,
  labor,
  onUpdateLabor,
  onToggle24x7,
}: DemandFlowProps) {
  const [dragActive, setDragActive] = useState(false);
  const [newWipCategory, setNewWipCategory] = useState('');
  const [newWipRemAht, setNewWipRemAht] = useState(30);
  const [newWipArrival, setNewWipArrival] = useState('');

  // WIP CSV Import State
  const [wipInputMode, setWipInputMode] = useState<'manual' | 'csv'>('manual');
  const [wipDragActive, setWipDragActive] = useState(false);
  const [wipFileName, setWipFileName] = useState('');
  const [wipRawHeaders, setWipRawHeaders] = useState<string[]>([]);
  const [wipRawRows, setWipRawRows] = useState<Record<string, string>[]>([]);
  const [wipMapping, setWipMapping] = useState<{
    caseIdCol: string;
    categoryCol: string;
    dateCol: string;
    timeCol: string;
    remainingWorkCol: string;
    priorityCol: string;
  }>({
    caseIdCol: '',
    categoryCol: '',
    dateCol: '',
    timeCol: '',
    remainingWorkCol: '',
    priorityCol: '',
  });

  function handleFileDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      readFile(e.dataTransfer.files[0]);
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files[0]) {
      readFile(e.target.files[0]);
    }
  }

  function readFile(file: File) {
    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target?.result as string;
      if (text) {
        onFileUpload(text, file.name);
      }
    };
    reader.readAsText(file);
  }

  // --- WIP CSV Upload & Mapping Wizard Helpers ---
  function autoDetectWipMapping(headers: string[]) {
    const findCol = (patterns: RegExp[]) => {
      for (const p of patterns) {
        const match = headers.find((h) => p.test(h.trim().toLowerCase()));
        if (match) return match;
      }
      return '';
    };

    const caseIdCol = findCol([/^id$/i, /case.*id/i, /ticket.*id/i, /ref/i, /case/i]);
    const categoryCol = findCol([/categor/i, /segment/i, /type/i, /queue/i, /skill/i, /work.*type/i]);
    const dateCol = findCol([/date/i, /arrival/i, /timestamp/i, /created/i, /start/i, /clock/i]);
    const timeCol = findCol([/^time$/i, /interval/i, /hh:mm/i, /time.*of.*day/i]);
    const remainingWorkCol = findCol([/remain.*work/i, /remain/i, /work.*min/i, /aht/i, /handling/i, /duration/i, /minutes/i]);
    const priorityCol = findCol([/prior/i, /prio/i, /urgency/i, /rank/i, /weight/i]);

    return {
      caseIdCol,
      categoryCol: categoryCol || (headers.length > 0 ? headers[0] : ''),
      dateCol: dateCol || (headers.length > 1 ? headers[1] : headers[0] || ''),
      timeCol,
      remainingWorkCol,
      priorityCol,
    };
  }

  function handleWipFileDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setWipDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      readWipFile(e.dataTransfer.files[0]);
    }
  }

  function handleWipFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files[0]) {
      readWipFile(e.target.files[0]);
    }
  }

  function readWipFile(file: File) {
    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target?.result as string;
      if (text) {
        const parsed = parseCSVRaw(text);
        setWipFileName(file.name);
        setWipRawHeaders(parsed.headers);
        setWipRawRows(parsed.rows);
        setWipMapping(autoDetectWipMapping(parsed.headers));
      }
    };
    reader.readAsText(file);
  }

  function getParsedWipCases(baseWip: OpeningWIPCase[]) {
    if (wipRawRows.length === 0) return { cases: [], invalidDates: 0, unmatchedCategories: [] };

    const cases: OpeningWIPCase[] = [];
    let invalidDates = 0;
    const unmatchedSet = new Set<string>();
    const defaultCat = categories.length > 0 ? categories[0] : { name: 'General', ahtMinutes: 30, priority: 1 };

    wipRawRows.forEach((row, idx) => {
      // Category matching
      const rawCat = wipMapping.categoryCol ? (row[wipMapping.categoryCol] || '').trim() : '';
      const matchedCat = categories.find((c) => c.name.toLowerCase() === rawCat.toLowerCase());
      let categoryName = rawCat;

      if (!matchedCat) {
        if (rawCat) unmatchedSet.add(rawCat);
        categoryName = defaultCat.name;
      } else {
        categoryName = matchedCat.name;
      }

      // Priority
      let prio = matchedCat?.priority || 1;
      if (wipMapping.priorityCol && row[wipMapping.priorityCol]) {
        const parsedPrio = parseInt(row[wipMapping.priorityCol], 10);
        if (!isNaN(parsedPrio) && parsedPrio > 0) prio = parsedPrio;
      }

      // Remaining work (min)
      let remMins = matchedCat?.ahtMinutes || 30;
      if (wipMapping.remainingWorkCol && row[wipMapping.remainingWorkCol] !== undefined && row[wipMapping.remainingWorkCol].trim() !== '') {
        const parsedWork = parseFloat(row[wipMapping.remainingWorkCol]);
        if (!isNaN(parsedWork) && parsedWork >= 0) {
          remMins = parsedWork;
        }
      }

      // Arrival Date & Time parsing (Strict dd/mm/yyyy)
      const dateStr = wipMapping.dateCol ? (row[wipMapping.dateCol] || '').trim() : '';
      const timeStr = wipMapping.timeCol ? (row[wipMapping.timeCol] || '').trim() : undefined;

      let arrivalDate: Date;
      if (dateStr) {
        const parsed = parseFlexibleDate(dateStr, timeStr);
        if (isNaN(parsed.getTime())) {
          invalidDates++;
          return;
        }
        arrivalDate = parsed;
      } else if (intervals.length > 0 && !isNaN(intervals[0].start.getTime())) {
        arrivalDate = new Date(intervals[0].start);
      } else {
        arrivalDate = new Date();
      }

      // Case ID
      let caseId = wipMapping.caseIdCol && row[wipMapping.caseIdCol] ? row[wipMapping.caseIdCol].trim() : '';
      const usedIds = new Set([...baseWip, ...cases].map((w) => w.id));
      if (!caseId || usedIds.has(caseId)) {
        caseId = generateNextWIPId([...baseWip, ...cases]);
      }

      cases.push({
        id: caseId,
        category: categoryName,
        priority: prio,
        arrival: arrivalDate,
        clockStart: arrivalDate,
        remainingWorkMinutes: remMins,
      });
    });

    return {
      cases,
      invalidDates,
      unmatchedCategories: Array.from(unmatchedSet),
    };
  }

  function handleApplyWipImport(mode: 'replace' | 'append') {
    const base = mode === 'append' ? openingWIP : [];
    const { cases } = getParsedWipCases(base);
    if (cases.length > 0) {
      onUpdateOpeningWIP(mode === 'append' ? [...openingWIP, ...cases] : cases);
      // Reset wizard
      setWipRawRows([]);
      setWipRawHeaders([]);
      setWipFileName('');
      setWipInputMode('manual');
    }
  }

  function handleCancelWipImport() {
    setWipRawRows([]);
    setWipRawHeaders([]);
    setWipFileName('');
  }

  function handleAddWipCase() {
    const catName = newWipCategory || (categories.length > 0 ? categories[0].name : 'General');
    const selectedCat = categories.find((c) => c.name === catName);
    const aht = newWipRemAht > 0 ? newWipRemAht : selectedCat?.ahtMinutes || 30;

    let arrivalDate: Date;
    if (newWipArrival) {
      const parsed = parseFlexibleDate(newWipArrival);
      if (!isNaN(parsed.getTime())) {
        arrivalDate = parsed;
      } else if (intervals.length > 0 && !isNaN(intervals[0].start.getTime())) {
        arrivalDate = new Date(intervals[0].start);
      } else {
        arrivalDate = new Date();
      }
    } else if (intervals.length > 0 && !isNaN(intervals[0].start.getTime())) {
      arrivalDate = new Date(intervals[0].start);
    } else {
      arrivalDate = new Date();
    }

    const nextId = generateNextWIPId(openingWIP);
    const newCase: OpeningWIPCase = {
      id: nextId,
      category: catName,
      priority: selectedCat?.priority || 1,
      arrival: arrivalDate,
      clockStart: arrivalDate,
      remainingWorkMinutes: aht,
    };

    onUpdateOpeningWIP([...openingWIP, newCase]);
  }

  function handleRemoveWipCase(id: string) {
    onUpdateOpeningWIP(openingWIP.filter((w) => w.id !== id));
  }

  return (
    <div className="space-y-6">
      {/* 1. UPLOAD TAB */}
      {currentTab === 'upload' && (
        <div className="space-y-5">
          <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-xs space-y-6">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  Mandatory 30-Minute Inflow Demand Forecast
                </h3>
                <p className="text-xs text-slate-500">
                  Authority: PRD Inflow Requirement. Upload a 30-minute interval file (.csv, .tsv) or load a validated benchmark dataset.
                </p>
              </div>

              {rawRowsCount > 0 && (
                <span className="px-3 py-1 bg-emerald-50 text-emerald-700 font-bold text-xs rounded-full border border-emerald-200">
                  ✓ {rawRowsCount.toLocaleString()} Intervals Loaded
                </span>
              )}
            </div>

            {/* Drag & Drop Box */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleFileDrop}
              className={`border-2 border-dashed rounded-xl p-8 text-center transition flex flex-col items-center justify-center gap-3 ${
                dragActive
                  ? 'border-emerald-500 bg-emerald-50/50'
                  : 'border-slate-300 hover:border-slate-400 bg-slate-50/50'
              }`}
            >
              <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center">
                <UploadCloud className="w-6 h-6" />
              </div>

              <div className="space-y-1">
                <p className="text-xs font-bold text-slate-800">
                  Drag and drop your 30-minute demand forecast CSV here
                </p>
                <p className="text-[11px] text-slate-500">
                  Supports comma, semicolon, or tab-delimited files. Timestamps automatically mapped.
                </p>
              </div>

              <label className="cursor-pointer px-4 py-2 bg-slate-900 text-white rounded-lg text-xs font-semibold hover:bg-slate-800 transition">
                Browse Files on Computer
                <input
                  type="file"
                  accept=".csv,.txt,.tsv"
                  onChange={handleFileSelect}
                  className="hidden"
                />
              </label>
            </div>

            {/* Sample Datasets */}
            <div className="pt-3 border-t border-slate-100 space-y-3">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-500" />
                <span className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                  Instant Load Validated Benchmark Datasets
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <button
                  type="button"
                  onClick={() => onLoadSample('claims')}
                  className="p-3.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 text-left transition space-y-1"
                >
                  <div className="text-xs font-bold text-slate-900">Financial Claims (Multi-Seg)</div>
                  <div className="text-[11px] text-slate-500">
                    5-day horizon, 3 Segs (Auto, Home, Life), ~1,200 total cases, 30m intervals.
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => onLoadSample('support')}
                  className="p-3.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 text-left transition space-y-1"
                >
                  <div className="text-xs font-bold text-slate-900">Customer Operations Backlog</div>
                  <div className="text-[11px] text-slate-500">
                    7-day horizon, 2 Segs (Billing, Escalations), high burst volume.
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => onLoadSample('healthcare')}
                  className="p-3.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 text-left transition space-y-1"
                >
                  <div className="text-xs font-bold text-slate-900">Healthcare Authorization</div>
                  <div className="text-[11px] text-slate-500">
                    10-day horizon, 4 Segs (PriorAuth, Pharmacy, Appeals, Inquiries).
                  </div>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 2. COLUMN MAPPING TAB */}
      {currentTab === 'mapping' && (
        <div className="space-y-5">
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs space-y-5">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Inflow Column Mapping</h3>
                <p className="text-xs text-slate-500">
                  Align CSV header names to required Discrete Event Simulation fields.
                </p>
              </div>
            </div>

            {rawHeaders.length === 0 ? (
              <div className="p-8 text-center text-slate-400 text-xs italic bg-slate-50 rounded-xl">
                Please upload a CSV demand file first to map columns.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {/* 1. Date */}
                <div className="space-y-1.5 p-3.5 bg-slate-50 rounded-lg border border-slate-200">
                  <label className="text-xs font-bold text-slate-800 flex items-center justify-between">
                    <span>1. Date / Day *</span>
                    <span className="text-[10px] text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded font-mono">
                      MANDATORY
                    </span>
                  </label>
                  <select
                    value={columnMapping.intervalStartCol}
                    onChange={(e) =>
                      onUpdateColumnMapping({
                        ...columnMapping,
                        intervalStartCol: e.target.value,
                      })
                    }
                    className="w-full text-xs bg-white border border-slate-300 rounded px-2.5 py-1.5 font-mono font-medium text-slate-900"
                  >
                    <option value="">-- Select Date Column --</option>
                    {rawHeaders.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>

                {/* 2. Interval / Time */}
                <div className="space-y-1.5 p-3.5 bg-slate-50 rounded-lg border border-slate-200">
                  <label className="text-xs font-bold text-slate-800 flex items-center justify-between">
                    <span>2. Interval / Time</span>
                    <span className="text-[10px] text-indigo-700 bg-indigo-100 px-1.5 py-0.5 rounded font-mono">
                      TIME SLOT
                    </span>
                  </label>
                  <select
                    value={columnMapping.timeCol || ''}
                    onChange={(e) =>
                      onUpdateColumnMapping({
                        ...columnMapping,
                        timeCol: e.target.value || undefined,
                      })
                    }
                    className="w-full text-xs bg-white border border-slate-300 rounded px-2.5 py-1.5 font-mono text-slate-900 font-medium"
                  >
                    <option value="">-- In Date Column --</option>
                    {rawHeaders.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>

                {/* 3. Vol / Offered */}
                <div className="space-y-1.5 p-3.5 bg-slate-50 rounded-lg border border-slate-200">
                  <label className="text-xs font-bold text-slate-800 flex items-center justify-between">
                    <span>3. Vol / Offered *</span>
                    <span className="text-[10px] text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded font-mono">
                      MANDATORY
                    </span>
                  </label>
                  <select
                    value={columnMapping.volumeCol}
                    onChange={(e) =>
                      onUpdateColumnMapping({
                        ...columnMapping,
                        volumeCol: e.target.value,
                      })
                    }
                    className="w-full text-xs bg-white border border-slate-300 rounded px-2.5 py-1.5 font-mono font-medium text-slate-900"
                  >
                    <option value="">-- Select Volume Column --</option>
                    {rawHeaders.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>

                {/* 4. Categ / Seg */}
                <div className="space-y-1.5 p-3.5 bg-slate-50 rounded-lg border border-slate-200">
                  <label className="text-xs font-bold text-slate-800 flex items-center justify-between">
                    <span>4. Categ / Seg</span>
                    <span className="text-[10px] text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded font-mono">
                      SEGMENT
                    </span>
                  </label>
                  <select
                    value={columnMapping.categoryCol || ''}
                    onChange={(e) =>
                      onUpdateColumnMapping({
                        ...columnMapping,
                        categoryCol: e.target.value || undefined,
                      })
                    }
                    className="w-full text-xs bg-white border border-slate-300 rounded px-2.5 py-1.5 font-mono text-slate-900 font-medium"
                  >
                    <option value="">-- Single General Category --</option>
                    {rawHeaders.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {/* Raw File Preview */}
            {rawRowsPreview.length > 0 && (
              <div className="space-y-2 pt-3 border-t border-slate-100">
                <span className="text-xs font-bold text-slate-800 uppercase tracking-wider block">
                  Raw Inflow Data Sample (First 5 Rows)
                </span>
                <div className="overflow-x-auto border border-slate-200 rounded-lg">
                  <table className="w-full text-[11px] text-left">
                    <thead className="bg-slate-100 text-slate-700 font-semibold border-b border-slate-200">
                      <tr>
                        {rawHeaders.map((h) => (
                          <th key={h} className="py-2 px-3">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {rawRowsPreview.map((row, idx) => (
                        <tr key={idx} className="hover:bg-slate-50 font-mono">
                          {rawHeaders.map((h) => (
                            <td key={h} className="py-1.5 px-3">
                              {row[h] || '-'}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 3. BUSINESS CALENDAR & WORKING WINDOWS TAB */}
      {currentTab === 'calendar' && (
        <CalendarConfigPanel
          calendar={calendar}
          onUpdateCalendar={onUpdateCalendar}
          labor={labor}
          onUpdateLabor={onUpdateLabor}
          onToggle24x7={onToggle24x7}
        />
      )}

      {/* 4. DATA QUALITY (DQ) TAB */}
      {currentTab === 'dq' && (
        <div className="space-y-5">
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  Data Quality (DQ) Gate Validation
                </h3>
                <p className="text-xs text-slate-500">
                  Authority: PRD DQ Start-Gate. Sizing stops the line on any fatal format, category, or time errors.
                </p>
              </div>

              {dqResult && (
                <span
                  className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${
                    dqResult.passed
                      ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                      : 'bg-rose-100 text-rose-800 border border-rose-300'
                  }`}
                >
                  {dqResult.passed ? 'PASSED DQ GATE' : 'STOP-THE-LINE ERROR'}
                </span>
              )}
            </div>

            {dqResult ? (
              <div className="space-y-4">
                {/* Metric Summary Cards */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                    <span className="text-[10px] text-slate-500 uppercase font-bold block">
                      Total Intervals
                    </span>
                    <span className="text-sm font-bold text-slate-900 font-mono">
                      {dqResult.totalIntervals.toLocaleString()}
                    </span>
                  </div>

                  <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                    <span className="text-[10px] text-slate-500 uppercase font-bold block">
                      Total Case Volume
                    </span>
                    <span className="text-sm font-bold text-slate-900 font-mono">
                      {dqResult.totalVolume.toLocaleString()}
                    </span>
                  </div>

                  <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                    <span className="text-[10px] text-slate-500 uppercase font-bold block">
                      Working Days in Horizon
                    </span>
                    <span className="text-sm font-bold text-slate-900 font-mono">
                      {dqResult.calendarWorkingDaysInHorizon} days
                    </span>
                  </div>

                  <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                    <span className="text-[10px] text-slate-500 uppercase font-bold block">
                      Total Workload
                    </span>
                    <span className="text-sm font-bold text-emerald-700 font-mono">
                      {dqResult.totalWorkloadHours.toLocaleString()} hrs
                    </span>
                  </div>
                </div>

                {/* Issues List */}
                <div className="space-y-2">
                  <span className="text-xs font-bold text-slate-800 uppercase tracking-wider block">
                    Validation Checks ({dqResult.issues.length} Issues Detected)
                  </span>

                  {dqResult.issues.length === 0 ? (
                    <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-lg flex items-center gap-2.5 text-xs text-emerald-900 font-semibold">
                      <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                      <span>All format, timestamp, interval duration, category, and capacity checks passed.</span>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {dqResult.issues.map((issue, idx) => (
                        <div
                          key={idx}
                          className={`p-3 rounded-lg border text-xs flex items-start gap-2.5 ${
                            issue.severity === 'error'
                              ? 'bg-rose-50 border-rose-200 text-rose-900'
                              : 'bg-amber-50 border-amber-200 text-amber-900'
                          }`}
                        >
                          {issue.severity === 'error' ? (
                            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                          ) : (
                            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                          )}
                          <div className="space-y-0.5">
                            <span className="font-bold block">
                              [{issue.field}] {issue.message}
                            </span>
                            {issue.details && <span className="text-slate-600 block">{issue.details}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="p-8 text-center text-slate-400 text-xs italic bg-slate-50 rounded-xl">
                Upload and map an inflow file to run data quality checks.
              </div>
            )}
          </div>
        </div>
      )}

      {/* 4. OPENING WIP TAB */}
      {currentTab === 'opening_wip' && (
        <div className="space-y-5">
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Opening Work-in-Progress (WIP)</h3>
                <p className="text-xs text-slate-500">
                  Pre-existing cases in queue at simulation start. Evaluated with arrival = clock_start.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold px-2.5 py-1 bg-slate-100 text-slate-700 rounded-full">
                  {openingWIP.length} Cases in Opening WIP
                </span>
                {openingWIP.length > 0 && (
                  <button
                    type="button"
                    onClick={() => onUpdateOpeningWIP([])}
                    className="text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-50 px-2 py-1 rounded border border-rose-200 transition"
                  >
                    Clear All
                  </button>
                )}
              </div>
            </div>

            {/* Mode Switcher: Manual Entry vs CSV Bulk Import */}
            <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
              <button
                type="button"
                onClick={() => {
                  setWipInputMode('manual');
                  handleCancelWipImport();
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition ${
                  wipInputMode === 'manual'
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Manual Entry</span>
              </button>

              <button
                type="button"
                onClick={() => setWipInputMode('csv')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition ${
                  wipInputMode === 'csv'
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Bulk Upload from CSV</span>
              </button>
            </div>

            {/* Mode 1: Manual Entry Form */}
            {wipInputMode === 'manual' && (
              <div className="p-3.5 bg-slate-50 rounded-lg border border-slate-200 space-y-3">
                <span className="text-xs font-bold text-slate-800 uppercase tracking-wider block">
                  Add Single Opening WIP Case
                </span>

                <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                  <div className="space-y-1">
                    <label className="text-[11px] text-slate-600 font-semibold block">Category</label>
                    <select
                      value={newWipCategory}
                      onChange={(e) => setNewWipCategory(e.target.value)}
                      className="w-full text-xs bg-white border border-slate-300 rounded px-2.5 py-1.5"
                    >
                      {categories.map((c) => (
                        <option key={c.id} value={c.name}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] text-slate-600 font-semibold block">
                      Remaining Work (min)
                    </label>
                    <input
                      type="number"
                      min="1"
                      value={newWipRemAht}
                      onChange={(e) => setNewWipRemAht(parseInt(e.target.value) || 30)}
                      className="w-full text-xs bg-white border border-slate-300 rounded px-2.5 py-1.5 font-mono"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] text-slate-600 font-semibold block">
                      Arrival / Clock Start
                    </label>
                    <input
                      type="datetime-local"
                      value={newWipArrival}
                      onChange={(e) => setNewWipArrival(e.target.value)}
                      className="w-full text-xs bg-white border border-slate-300 rounded px-2.5 py-1.5 font-mono"
                    />
                  </div>

                  <div className="flex items-end">
                    <button
                      type="button"
                      onClick={handleAddWipCase}
                      className="w-full py-1.5 px-3 bg-slate-900 text-white rounded text-xs font-semibold hover:bg-slate-800 transition flex items-center justify-center gap-1.5"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add WIP Case</span>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Mode 2: Bulk CSV Upload & Wizard */}
            {wipInputMode === 'csv' && (
              <div className="space-y-4">
                {/* Highlighted Notice regarding format and category matching */}
                <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-lg space-y-1.5 text-xs text-amber-900">
                  <div className="flex items-center gap-2 font-bold text-amber-950">
                    <Info className="w-4 h-4 text-amber-700 shrink-0" />
                    <span>Pending Cases CSV Import Requirements & Format</span>
                  </div>
                  <ul className="list-disc list-inside space-y-0.5 text-[11px] text-amber-900/90 pl-1">
                    <li>
                      <span className="font-semibold">Strict Date Format:</span> Timestamps must follow{' '}
                      <code className="bg-amber-100 px-1 py-0.5 rounded font-mono text-[10px] font-bold">
                        dd/mm/yyyy
                      </code>{' '}
                      (or ISO <code className="bg-amber-100 px-1 py-0.5 rounded font-mono text-[10px]">YYYY-MM-DD</code>).
                    </li>
                    <li>
                      <span className="font-semibold">Matching Categories:</span> Each pending case must match one of your configured categories:{' '}
                      <span className="font-mono font-bold text-amber-950">
                        {categories.map((c) => c.name).join(', ') || 'None configured'}
                      </span>.
                    </li>
                    <li>
                      <span className="font-semibold">Remaining Work:</span> Specified as individual workload in{' '}
                      <span className="font-semibold">minutes</span> per case. If omitted or blank, defaults to category AHT.
                    </li>
                  </ul>
                </div>

                {/* CSV File Upload Box (if no file loaded yet) */}
                {wipRawRows.length === 0 ? (
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setWipDragActive(true);
                    }}
                    onDragLeave={() => setWipDragActive(false)}
                    onDrop={handleWipFileDrop}
                    className={`border-2 border-dashed rounded-xl p-6 text-center transition flex flex-col items-center justify-center gap-3 ${
                      wipDragActive
                        ? 'border-emerald-500 bg-emerald-50/50'
                        : 'border-slate-300 hover:border-slate-400 bg-slate-50/50'
                    }`}
                  >
                    <div className="w-10 h-10 rounded-full bg-slate-100 text-slate-700 flex items-center justify-center">
                      <UploadCloud className="w-5 h-5" />
                    </div>

                    <div className="space-y-1">
                      <p className="text-xs font-bold text-slate-800">
                        Drag and drop your Pending Cases / Opening WIP CSV here
                      </p>
                      <p className="text-[11px] text-slate-500">
                        Supports comma, semicolon, or tab-delimited files (.csv, .tsv, .txt)
                      </p>
                    </div>

                    <label className="cursor-pointer px-3.5 py-1.5 bg-slate-900 text-white rounded-lg text-xs font-semibold hover:bg-slate-800 transition">
                      Browse Pending Cases CSV
                      <input
                        type="file"
                        accept=".csv,.txt,.tsv"
                        onChange={handleWipFileSelect}
                        className="hidden"
                      />
                    </label>
                  </div>
                ) : (
                  /* Column Mapping Wizard for WIP */
                  (() => {
                    const parsedResult = getParsedWipCases(openingWIP);
                    return (
                      <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-4">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
                          <div className="flex items-center gap-2">
                            <FileSpreadsheet className="w-4 h-4 text-slate-700" />
                            <span className="text-xs font-bold text-slate-900">
                              {wipFileName || 'Pending Cases File'}
                            </span>
                            <span className="px-2 py-0.5 bg-slate-200 text-slate-800 text-[10px] font-mono font-bold rounded">
                              {wipRawRows.length.toLocaleString()} rows detected
                            </span>
                          </div>

                          <button
                            type="button"
                            onClick={handleCancelWipImport}
                            className="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1"
                          >
                            <X className="w-3.5 h-3.5" />
                            <span>Select Different File</span>
                          </button>
                        </div>

                        {/* Column Selectors Grid */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                          {/* Category Column */}
                          <div className="space-y-1 bg-white p-2.5 rounded-lg border border-slate-200">
                            <label className="text-[11px] font-bold text-slate-700 block">
                              Category Column <span className="text-rose-500">*</span>
                            </label>
                            <select
                              value={wipMapping.categoryCol}
                              onChange={(e) =>
                                setWipMapping((prev) => ({ ...prev, categoryCol: e.target.value }))
                              }
                              className="w-full text-xs bg-slate-50 border border-slate-300 rounded px-2 py-1"
                            >
                              <option value="">-- Select Category Column --</option>
                              {wipRawHeaders.map((h) => (
                                <option key={h} value={h}>
                                  {h}
                                </option>
                              ))}
                            </select>
                          </div>

                          {/* Arrival / Date Column */}
                          <div className="space-y-1 bg-white p-2.5 rounded-lg border border-slate-200">
                            <label className="text-[11px] font-bold text-slate-700 block">
                              Arrival / Date Column <span className="text-rose-500">*</span>
                            </label>
                            <select
                              value={wipMapping.dateCol}
                              onChange={(e) =>
                                setWipMapping((prev) => ({ ...prev, dateCol: e.target.value }))
                              }
                              className="w-full text-xs bg-slate-50 border border-slate-300 rounded px-2 py-1"
                            >
                              <option value="">-- Select Date/Timestamp Column --</option>
                              {wipRawHeaders.map((h) => (
                                <option key={h} value={h}>
                                  {h}
                                </option>
                              ))}
                            </select>
                          </div>

                          {/* Time Column */}
                          <div className="space-y-1 bg-white p-2.5 rounded-lg border border-slate-200">
                            <label className="text-[11px] font-bold text-slate-700 block">
                              Time Column <span className="text-slate-400 font-normal">(Optional)</span>
                            </label>
                            <select
                              value={wipMapping.timeCol}
                              onChange={(e) =>
                                setWipMapping((prev) => ({ ...prev, timeCol: e.target.value }))
                              }
                              className="w-full text-xs bg-slate-50 border border-slate-300 rounded px-2 py-1"
                            >
                              <option value="">-- Combined in Date or 00:00 --</option>
                              {wipRawHeaders.map((h) => (
                                <option key={h} value={h}>
                                  {h}
                                </option>
                              ))}
                            </select>
                          </div>

                          {/* Case ID Column */}
                          <div className="space-y-1 bg-white p-2.5 rounded-lg border border-slate-200">
                            <label className="text-[11px] font-bold text-slate-700 block">
                              Case ID Column <span className="text-slate-400 font-normal">(Optional)</span>
                            </label>
                            <select
                              value={wipMapping.caseIdCol}
                              onChange={(e) =>
                                setWipMapping((prev) => ({ ...prev, caseIdCol: e.target.value }))
                              }
                              className="w-full text-xs bg-slate-50 border border-slate-300 rounded px-2 py-1"
                            >
                              <option value="">-- Auto-generate WIP-0001 --</option>
                              {wipRawHeaders.map((h) => (
                                <option key={h} value={h}>
                                  {h}
                                </option>
                              ))}
                            </select>
                          </div>

                          {/* Remaining Work (min) Column */}
                          <div className="space-y-1 bg-white p-2.5 rounded-lg border border-slate-200">
                            <label className="text-[11px] font-bold text-slate-700 block">
                              Remaining Work (min) <span className="text-slate-400 font-normal">(Optional)</span>
                            </label>
                            <select
                              value={wipMapping.remainingWorkCol}
                              onChange={(e) =>
                                setWipMapping((prev) => ({ ...prev, remainingWorkCol: e.target.value }))
                              }
                              className="w-full text-xs bg-slate-50 border border-slate-300 rounded px-2 py-1"
                            >
                              <option value="">-- Defaults to Category AHT --</option>
                              {wipRawHeaders.map((h) => (
                                <option key={h} value={h}>
                                  {h}
                                </option>
                              ))}
                            </select>
                          </div>

                          {/* Priority Column */}
                          <div className="space-y-1 bg-white p-2.5 rounded-lg border border-slate-200">
                            <label className="text-[11px] font-bold text-slate-700 block">
                              Priority Column <span className="text-slate-400 font-normal">(Optional)</span>
                            </label>
                            <select
                              value={wipMapping.priorityCol}
                              onChange={(e) =>
                                setWipMapping((prev) => ({ ...prev, priorityCol: e.target.value }))
                              }
                              className="w-full text-xs bg-slate-50 border border-slate-300 rounded px-2 py-1"
                            >
                              <option value="">-- Defaults to Category Priority --</option>
                              {wipRawHeaders.map((h) => (
                                <option key={h} value={h}>
                                  {h}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>

                        {parsedResult.invalidDates > 0 && (
                          <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-900 flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                            <span>
                              {parsedResult.invalidDates} row{parsedResult.invalidDates === 1 ? '' : 's'} skipped:
                              dates must be dd/mm/yyyy (mm/dd is rejected). {parsedResult.cases.length} valid case
                              {parsedResult.cases.length === 1 ? '' : 's'} will import.
                            </span>
                          </div>
                        )}

                        {/* Unmatched Category Warnings */}
                        {parsedResult.unmatchedCategories.length > 0 && (
                          <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                            <span>
                              Notice: Unmatched categories found in CSV ({parsedResult.unmatchedCategories.join(', ')}).
                              These will map to fallback category{' '}
                              <strong className="font-semibold">{categories[0]?.name || 'General'}</strong>.
                            </span>
                          </div>
                        )}

                        {/* Preview Table of Parsed WIP cases */}
                        <div className="space-y-1.5">
                          <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wider block">
                            Preview Parsed Pending Cases (First {Math.min(4, parsedResult.cases.length)})
                          </span>
                          <div className="overflow-x-auto border border-slate-200 rounded-lg bg-white">
                            <table className="w-full text-xs text-left">
                              <thead className="bg-slate-100 text-slate-700 font-semibold border-b border-slate-200">
                                <tr>
                                  <th className="py-1.5 px-3">Case ID</th>
                                  <th className="py-1.5 px-3">Category</th>
                                  <th className="py-1.5 px-3">Priority</th>
                                  <th className="py-1.5 px-3">Remaining Work</th>
                                  <th className="py-1.5 px-3">Arrival Timestamp</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-100 font-mono">
                                {parsedResult.cases.slice(0, 4).map((c, i) => (
                                  <tr key={i} className="hover:bg-slate-50">
                                    <td className="py-1.5 px-3 font-semibold text-slate-900">{c.id}</td>
                                    <td className="py-1.5 px-3 text-slate-700">{c.category}</td>
                                    <td className="py-1.5 px-3 text-slate-700">{c.priority}</td>
                                    <td className="py-1.5 px-3 text-slate-700">{c.remainingWorkMinutes}m</td>
                                    <td className="py-1.5 px-3 text-slate-700">{formatDateTime24(c.arrival)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>

                        {/* Import Action Buttons */}
                        <div className="flex flex-wrap items-center gap-2 pt-2">
                          <button
                            type="button"
                            onClick={() => handleApplyWipImport('replace')}
                            disabled={parsedResult.cases.length === 0}
                            className="px-4 py-2 bg-slate-900 text-white rounded-lg text-xs font-semibold hover:bg-slate-800 transition flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                            <span>Replace WIP ({parsedResult.cases.length} Cases)</span>
                          </button>

                          {openingWIP.length > 0 && (
                            <button
                              type="button"
                              onClick={() => handleApplyWipImport('append')}
                              className="px-4 py-2 bg-white text-slate-800 border border-slate-300 rounded-lg text-xs font-semibold hover:bg-slate-50 transition flex items-center gap-1.5"
                            >
                              <Plus className="w-3.5 h-3.5" />
                              <span>Append +{parsedResult.cases.length} Cases to Existing ({openingWIP.length})</span>
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={handleCancelWipImport}
                            className="px-3 py-2 text-slate-600 hover:text-slate-800 text-xs font-semibold"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    );
                  })()
                )}
              </div>
            )}

            {/* WIP Table */}
            <div className="pt-3 border-t border-slate-100 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                  Current Opening WIP List
                </span>
                {openingWIP.length > 0 && (
                  <span className="text-[11px] text-slate-500 font-mono">
                    Total Pending Work:{' '}
                    <strong className="text-slate-800">
                      {openingWIP.reduce((acc, w) => acc + (w.remainingWorkMinutes || 0), 0).toLocaleString()} mins
                    </strong>{' '}
                    (
                    {(
                      openingWIP.reduce((acc, w) => acc + (w.remainingWorkMinutes || 0), 0) / 60
                    ).toFixed(1)}{' '}
                    hrs)
                  </span>
                )}
              </div>

              {openingWIP.length > 0 ? (
                <div className="overflow-x-auto border border-slate-200 rounded-lg max-h-80 overflow-y-auto">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-slate-100 text-slate-700 font-semibold border-b border-slate-200 sticky top-0">
                      <tr>
                        <th className="py-2 px-3">Case ID</th>
                        <th className="py-2 px-3">Category</th>
                        <th className="py-2 px-3">Priority</th>
                        <th className="py-2 px-3">Remaining Work (min)</th>
                        <th className="py-2 px-3">Arrival Timestamp</th>
                        <th className="py-2 px-3 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {openingWIP.map((w) => (
                        <tr key={w.id} className="hover:bg-slate-50 font-mono">
                          <td className="py-2 px-3 font-semibold text-slate-900">{w.id}</td>
                          <td className="py-2 px-3">{w.category}</td>
                          <td className="py-2 px-3">{w.priority}</td>
                          <td className="py-2 px-3">{w.remainingWorkMinutes}m</td>
                          <td className="py-2 px-3">{formatDateTime24(w.arrival)}</td>
                          <td className="py-2 px-3 text-right">
                            <button
                              onClick={() => handleRemoveWipCase(w.id)}
                              className="p-1 text-rose-500 hover:text-rose-700 rounded hover:bg-rose-50"
                              title="Delete case"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="p-6 text-center text-slate-400 text-xs italic bg-slate-50 rounded-lg">
                  No Opening WIP cases. Horizon begins with an empty queue.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
