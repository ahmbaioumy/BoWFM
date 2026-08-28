/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  CalendarConfig,
  CategoryConfig,
  LaborConfig,
  OpeningWIPCase,
  SLAPolicyConfig,
  StandardInterval,
  TimeUnit,
} from '../types/wfm';
import {
  convertDurationToMinutes,
  getCalendarWorkingDaysInHorizon,
  getDailyWindowLengthHours,
} from '../utils/calendar';
import {
  Shield,
  Briefcase,
  AlertTriangle,
  CheckCircle2,
  Layers,
  Info,
  RefreshCw,
  Lock,
} from 'lucide-react';

interface ConfigFlowProps {
  currentTab: string;
  calendar: CalendarConfig;
  labor: LaborConfig;
  sla: SLAPolicyConfig;
  categories: CategoryConfig[];
  intervals: StandardInterval[];
  openingWIP: OpeningWIPCase[];
  onUpdateLabor: (lab: LaborConfig) => void;
  onUpdateSLA: (sla: SLAPolicyConfig) => void;
  onUpdateCategories: (cats: CategoryConfig[]) => void;
}

export function ConfigFlow({
  currentTab,
  calendar,
  labor,
  sla,
  categories,
  intervals,
  openingWIP,
  onUpdateLabor,
  onUpdateSLA,
  onUpdateCategories,
}: ConfigFlowProps) {
  // Daily window in hours
  const dailyWindow = getDailyWindowLengthHours(calendar);
  const isCapacityValid = labor.dailyProductiveHours <= dailyWindow + 0.05;
  const adherence = labor.adherencePct || 1.0;
  const presentHoursPerDay = labor.dailyProductiveHours * adherence;

  let derivedAgentHoursHint: number | null = null;
  if (intervals.length > 0) {
    let minStartMs = Infinity;
    let maxEndMs = -Infinity;
    for (const iv of intervals) {
      const s = iv.start.getTime();
      const e = iv.end.getTime();
      if (s < minStartMs) minStartMs = s;
      if (e > maxEndMs) maxEndMs = e;
    }
    let horizonStart = isFinite(minStartMs) ? new Date(minStartMs) : new Date();
    let horizonEnd = isFinite(maxEndMs) ? new Date(maxEndMs) : new Date(horizonStart.getTime() + 7 * 86400000);
    for (const w of openingWIP) {
      if (w.arrival && !isNaN(w.arrival.getTime()) && w.arrival.getTime() < horizonStart.getTime()) {
        horizonStart = new Date(w.arrival);
      }
    }
    const days = Math.max(1, getCalendarWorkingDaysInHorizon(horizonStart, horizonEnd, calendar));
    derivedAgentHoursHint = labor.dailyProductiveHours * days;
  }

  function handleUpdateCatField(id: string, field: keyof CategoryConfig, value: any) {
    onUpdateCategories(
      categories.map((c) => {
        if (c.id === id) {
          return { ...c, [field]: value };
        }
        return c;
      })
    );
  }

  return (
    <div className="space-y-6">
      {/* 1. LABOR TAB */}
      {currentTab === 'labor' && (
        <div className="space-y-5">
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs">
            <div className="flex items-center gap-2.5 mb-4 border-b border-slate-100 pb-3">
              <Briefcase className="w-5 h-5 text-emerald-600" />
              <div>
                <h3 className="text-sm font-bold text-slate-900">Labor & Productive Capacity Parameters</h3>
                <p className="text-xs text-slate-500">
                  Configure scheduled productive hours, adherence %, weekly working schedule, and Workload HC agent hours.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-5">
              {/* Daily Productive Hours */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700 block">
                  Scheduled Daily Productive Hours
                </label>
                <input
                  id="labor-daily-productive-hours"
                  type="number"
                  step="0.1"
                  min="1"
                  max="24"
                  value={labor.dailyProductiveHours}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value) || 7.5;
                    onUpdateLabor({ ...labor, dailyProductiveHours: val });
                  }}
                  className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-400 font-mono font-medium"
                />
                <span className="text-[11px] text-slate-400 block">
                  Scheduled productive capacity (excluding offline breaks).
                </span>
              </div>

              {/* Adherence % */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700 block">
                  Schedule Adherence %
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    id="labor-adherence-pct"
                    type="number"
                    min="10"
                    max="100"
                    step="1"
                    value={Math.round(adherence * 100)}
                    onChange={(e) => {
                      const val = Math.min(100, Math.max(10, parseFloat(e.target.value) || 100));
                      onUpdateLabor({ ...labor, adherencePct: val / 100 });
                    }}
                    className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-400 font-mono font-medium"
                  />
                  <span className="text-xs text-slate-500 font-mono">%</span>
                </div>
                <span className="text-[11px] text-slate-400 block">
                  Default 100%. DES present hours = daily × adherence.
                </span>
              </div>

              {/* Working Days per Week */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700 block">Working Days per Week</label>
                <input
                  id="labor-working-days-per-week"
                  type="number"
                  min="1"
                  max="7"
                  value={labor.workingDaysPerWeek}
                  onChange={(e) => {
                    const val = Math.min(7, Math.max(1, parseInt(e.target.value) || 5));
                    onUpdateLabor({
                      ...labor,
                      workingDaysPerWeek: val,
                      offDaysPerWeek: 7 - val,
                    });
                  }}
                  className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-400 font-mono font-medium"
                />
                <span className="text-[11px] text-slate-400 block">
                  Off days: {labor.offDaysPerWeek} days/week.
                </span>
              </div>

              {/* DES Present Capacity Confirmation */}
              <div className="space-y-1 bg-slate-50 p-3 rounded-lg border border-slate-200">
                <span className="text-xs font-semibold text-slate-700 block">
                  DES Present Hours / Day
                </span>
                <div className="text-lg font-bold font-mono text-emerald-700">
                  {presentHoursPerDay.toFixed(2)} hrs/day
                </div>
                <span className="text-[11px] text-slate-500 block">
                  {labor.dailyProductiveHours}h × {Math.round(adherence * 100)}% adherence
                </span>
              </div>
            </div>

            {/* Capacity Basis Alert */}
            <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                {isCapacityValid ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                )}
                <span className="text-xs text-slate-700">
                  <strong>Capacity Basis (M1):</strong> Scheduled daily productive hours ({labor.dailyProductiveHours}h) must be ≤
                  daily business window ({dailyWindow}h).
                </span>
              </div>
              <span
                className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                  isCapacityValid ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                }`}
              >
                {isCapacityValid ? 'COMPLIANT' : 'VIOLATION'}
              </span>
            </div>
          </div>

          {/* Agent Hours for Workload HC (N_min) */}
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs">
            <div className="flex items-center justify-between mb-3 border-b border-slate-100 pb-2.5">
              <div>
                <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                  Agent Productive Hours (Workload HC Baseline)
                </h4>
                <p className="text-xs text-slate-500">
                  Denominator for Workload HC (N_min). Default Derived = daily × calendar working days in horizon.
                  Manual hours used only when set &gt; 0.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() =>
                    onUpdateLabor({
                      ...labor,
                      contractualHoursSource: 'derived',
                    })
                  }
                  className={`px-2.5 py-1 rounded text-xs font-semibold transition ${
                    labor.contractualHoursSource === 'derived'
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  Derived (Horizon Default)
                </button>
                <button
                  onClick={() =>
                    onUpdateLabor({
                      ...labor,
                      contractualHoursSource: 'override',
                      contractualProductiveHoursOverride:
                        labor.contractualProductiveHoursOverride ?? 0,
                    })
                  }
                  className={`px-2.5 py-1 rounded text-xs font-semibold transition ${
                    labor.contractualHoursSource === 'override'
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  Manual Override
                </button>
              </div>
            </div>

            {labor.contractualHoursSource === 'override' ? (
              <div className="p-3 bg-blue-50/70 border border-blue-200 rounded-lg space-y-2">
                <label className="text-xs font-semibold text-blue-900 block">
                  Manual agent productive hours for this demand horizon (0 = ignore, use Derived):
                </label>
                <div className="flex items-center gap-3 flex-wrap">
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    value={
                      Number.isFinite(labor.contractualProductiveHoursOverride)
                        ? labor.contractualProductiveHoursOverride
                        : 0
                    }
                    onChange={(e) => {
                      const raw = e.target.value;
                      const val = raw === '' ? 0 : parseFloat(raw);
                      onUpdateLabor({
                        ...labor,
                        contractualProductiveHoursOverride: Number.isFinite(val) ? Math.max(0, val) : 0,
                      });
                    }}
                    className="w-40 px-3 py-1.5 text-xs bg-white border border-blue-300 rounded font-mono font-bold text-blue-900 focus:outline-none"
                  />
                  <span className="text-xs text-blue-700">
                    Hours &gt; 0 replace Derived in Workload HC only. Leave 0 to keep today&apos;s baseline.
                  </span>
                </div>
                {derivedAgentHoursHint != null && (
                  <p className="text-[11px] text-blue-800">
                    Derived hint (not applied): {derivedAgentHoursHint.toFixed(1)}h
                    (= daily × calendar working days).
                  </p>
                )}
              </div>
            ) : (
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600 space-y-1">
                <div>
                  Automatic default: <code>daily_productive_hours × calendar_working_days_in_horizon</code>.
                </div>
                {derivedAgentHoursHint != null ? (
                  <div className="font-mono text-slate-800">
                    Current derived agent hours: <strong>{derivedAgentHoursHint.toFixed(1)}h</strong>
                  </div>
                ) : (
                  <div className="text-slate-500">Computed at Run from the uploaded demand horizon.</div>
                )}
              </div>
            )}
          </div>

          {/* Deadline-Coverage Shift Placement (opt-in) */}
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs">
            <div className="flex items-center justify-between mb-3 border-b border-slate-100 pb-2.5">
              <div>
                <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                  Deadline-Coverage Shift Placement
                </h4>
                <p className="text-xs text-slate-500">
                  Experimental, opt-in. When a candidate headcount fails the SLA under a uniform
                  business-open start, also try a staggered shift-start distribution before rejecting it —
                  used only when it verifiably passes, so it can never recommend a worse headcount than
                  today. It has not been shown to reliably find a better one on realistic demand. Off by
                  default — leaves every existing result byte-for-byte unchanged.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() =>
                    onUpdateLabor({
                      ...labor,
                      shiftPlacementEnabled: false,
                    })
                  }
                  className={`px-2.5 py-1 rounded text-xs font-semibold transition ${
                    !labor.shiftPlacementEnabled
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  Off (Default)
                </button>
                <button
                  onClick={() =>
                    onUpdateLabor({
                      ...labor,
                      shiftPlacementEnabled: true,
                      shiftSlapMinutes: labor.shiftSlapMinutes || 30,
                    })
                  }
                  className={`px-2.5 py-1 rounded text-xs font-semibold transition ${
                    labor.shiftPlacementEnabled
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  Enabled
                </button>
              </div>
            </div>

            {labor.shiftPlacementEnabled ? (
              <div className="p-3 bg-blue-50/70 border border-blue-200 rounded-lg space-y-2">
                <label className="text-xs font-semibold text-blue-900 block">
                  Shift-start grid granularity
                </label>
                <div className="flex items-center gap-3 flex-wrap">
                  <select
                    value={labor.shiftSlapMinutes || 30}
                    onChange={(e) =>
                      onUpdateLabor({ ...labor, shiftSlapMinutes: parseInt(e.target.value, 10) || 30 })
                    }
                    className="w-40 px-3 py-1.5 text-xs bg-white border border-blue-300 rounded font-mono font-bold text-blue-900 focus:outline-none"
                  >
                    <option value={30}>30 minutes</option>
                    <option value={60}>60 minutes</option>
                  </select>
                  <span className="text-xs text-blue-700">
                    Valid shift starts land on this grid, and only where the full daily productive-hours
                    budget fits inside the business window without truncation.
                  </span>
                </div>
              </div>
            ) : (
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600">
                Every agent starts one uniform shift at business open, exactly as today.
              </div>
            )}
          </div>
        </div>
      )}

      {/* 2. SLA DEFAULTS & PER-CATEGORY SLA TAB */}
      {currentTab === 'sla' && (
        <div className="space-y-5">
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs space-y-5">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2.5">
                <Shield className="w-5 h-5 text-indigo-600" />
                <div>
                  <h3 className="text-sm font-bold text-slate-900">SLA Policy & Per-Category Targets</h3>
                  <p className="text-xs text-slate-500">
                    Define dual SLA targets per identified category, SLA clock rules, and ASA calculation options (business window vs clock hours).
                  </p>
                </div>
              </div>
              <span className="text-xs px-2.5 py-1 bg-indigo-50 border border-indigo-200 text-indigo-700 font-semibold rounded-lg">
                {categories.length} {categories.length === 1 ? 'Category' : 'Categories'} Identified
              </span>
            </div>

            {/* SLA Timing & Calculation Options */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* 1. Clock Basis */}
              <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                    SLA Clock Basis
                  </span>
                </div>
                <div className="flex items-center gap-1.5 pt-1">
                  <button
                    onClick={() => onUpdateSLA({ ...sla, clockBasis: 'business_time' })}
                    className={`flex-1 px-2.5 py-1.5 rounded text-xs font-semibold transition text-center ${
                      sla.clockBasis === 'business_time'
                        ? 'bg-blue-600 text-white shadow-xs'
                        : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    Business Time
                  </button>
                  <button
                    onClick={() => onUpdateSLA({ ...sla, clockBasis: 'wall_clock' })}
                    className={`flex-1 px-2.5 py-1.5 rounded text-xs font-semibold transition text-center ${
                      sla.clockBasis === 'wall_clock'
                        ? 'bg-amber-600 text-white shadow-xs'
                        : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    Wall Clock
                  </button>
                </div>
                <p className="text-[11px] text-slate-500 pt-1 leading-relaxed">
                  {sla.clockBasis === 'business_time'
                    ? 'SLA clocks pause outside open business hours.'
                    : 'Calendar wall-clock time elapses 24/7 across weekends.'}
                </p>
              </div>

              {/* 2. Clock Start Policy */}
              <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                    Clock Start Policy
                  </span>
                </div>
                <div className="flex items-center gap-1.5 pt-1">
                  <button
                    onClick={() => onUpdateSLA({ ...sla, clockStartPolicy: 'arrival' })}
                    className={`flex-1 px-2.5 py-1.5 rounded text-xs font-semibold transition text-center ${
                      sla.clockStartPolicy === 'arrival'
                        ? 'bg-blue-600 text-white shadow-xs'
                        : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    Arrival Time
                  </button>
                  <button
                    onClick={() => onUpdateSLA({ ...sla, clockStartPolicy: 'next_open' })}
                    className={`flex-1 px-2.5 py-1.5 rounded text-xs font-semibold transition text-center ${
                      sla.clockStartPolicy === 'next_open'
                        ? 'bg-indigo-600 text-white shadow-xs'
                        : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    Next Open
                  </button>
                </div>
                <p className="text-[11px] text-slate-500 pt-1 leading-relaxed">
                  {sla.clockStartPolicy === 'arrival'
                    ? 'Starts immediately on arrival timestamp.'
                    : 'After-hours arrivals snap to next open business window.'}
                </p>
              </div>

              {/* 3. ASA Toggle & Calculation Window */}
              <div className={`p-4 rounded-xl border transition space-y-2 ${
                sla.boAsaEnabled
                  ? 'bg-purple-50/60 border-purple-200'
                  : 'bg-slate-50 border-slate-200'
              }`}>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                    BO ASA Target
                  </span>
                  <label className="inline-flex items-center cursor-pointer relative" title="Toggle BO ASA constraint on or off">
                    <input
                      type="checkbox"
                      checked={sla.boAsaEnabled || false}
                      onChange={(e) =>
                        onUpdateSLA({
                          ...sla,
                          boAsaEnabled: e.target.checked,
                        })
                      }
                      className="sr-only peer"
                    />
                    <div className="w-8 h-4 bg-slate-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-purple-600"></div>
                  </label>
                </div>

                {sla.boAsaEnabled ? (
                  <>
                    <div className="flex items-center gap-1.5 pt-1">
                      <button
                        onClick={() => onUpdateSLA({ ...sla, asaClockBasis: 'business_window' })}
                        className={`flex-1 px-2 py-1 rounded text-[11px] font-semibold transition text-center ${
                          (sla.asaClockBasis || 'business_window') === 'business_window'
                            ? 'bg-purple-700 text-white shadow-xs'
                            : 'bg-white text-slate-700 border border-purple-200 hover:bg-purple-100/50'
                        }`}
                        title="Calculate ASA duration strictly during open business hours"
                      >
                        Business Window
                      </button>
                      <button
                        onClick={() => onUpdateSLA({ ...sla, asaClockBasis: 'clock_hours' })}
                        className={`flex-1 px-2 py-1 rounded text-[11px] font-semibold transition text-center ${
                          sla.asaClockBasis === 'clock_hours'
                            ? 'bg-purple-700 text-white shadow-xs'
                            : 'bg-white text-slate-700 border border-purple-200 hover:bg-purple-100/50'
                        }`}
                        title="Calculate ASA duration as 24/7 calendar elapsed clock hours"
                      >
                        24/7 Clock
                      </button>
                    </div>
                    <p className="text-[10px] text-purple-700 pt-0.5 leading-tight">
                      {(sla.asaClockBasis || 'business_window') === 'business_window'
                        ? 'Enforced in simulation: counts business hours only.'
                        : 'Enforced in simulation: counts 24/7 elapsed clock time.'}
                    </p>
                  </>
                ) : (
                  <div className="pt-1 text-[11px] text-slate-500 leading-relaxed">
                    <span className="font-semibold text-slate-700">Disabled (Off):</span> Headcount simulation optimizes strictly for Turnaround SLA (80% / 100% completion) without ASA constraints.
                  </div>
                )}
              </div>
            </div>

            {/* Global Defaults Template & Bulk Apply */}
            <div className="p-4 bg-slate-50/80 rounded-xl border border-slate-200 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <span className="text-xs font-bold text-slate-800 uppercase tracking-wider block">
                    Global SLA Baseline Template
                  </span>
                  <span className="text-xs text-slate-500">
                    Default template used when new categories are discovered or when applying in bulk.
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const primaryWinMin = convertDurationToMinutes(sla.primaryWindow, sla.primaryUnit);
                    onUpdateCategories(
                      categories.map((c) => ({
                        ...c,
                        primaryPct: sla.primaryPct,
                        primaryWindow: sla.primaryWindow,
                        primaryUnit: sla.primaryUnit,
                        primaryWindowMinutes: primaryWinMin,
                        boAsaTarget: sla.boAsaTarget,
                        boAsaUnit: sla.boAsaUnit,
                      }))
                    );
                  }}
                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg shadow-xs transition flex items-center gap-1.5 self-start sm:self-auto"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Apply Template to All Categories
                </button>
              </div>

              <div className={`grid grid-cols-1 gap-3 pt-1 ${sla.boAsaEnabled ? 'sm:grid-cols-2' : 'sm:grid-cols-1'}`}>
                {/* Primary Default */}
                <div className="p-3 bg-white rounded-lg border border-slate-200 space-y-1.5">
                  <span className="text-[11px] font-bold text-blue-900 block uppercase">Primary Baseline</span>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={sla.primaryPct}
                      onChange={(e) =>
                        onUpdateSLA({
                          ...sla,
                          primaryPct: Math.min(100, Math.max(1, parseInt(e.target.value) || 80)),
                        })
                      }
                      className="w-16 px-2 py-1 text-xs bg-slate-50 border border-slate-200 rounded font-mono font-medium"
                    />
                    <span className="text-xs text-slate-500">% in</span>
                    <input
                      type="number"
                      min="1"
                      value={sla.primaryWindow}
                      onChange={(e) =>
                        onUpdateSLA({
                          ...sla,
                          primaryWindow: Math.max(1, parseInt(e.target.value) || 6),
                        })
                      }
                      className="w-14 px-2 py-1 text-xs bg-slate-50 border border-slate-200 rounded font-mono font-medium"
                    />
                    <select
                      value={sla.primaryUnit}
                      onChange={(e) => onUpdateSLA({ ...sla, primaryUnit: e.target.value as TimeUnit })}
                      className="text-xs bg-slate-50 border border-slate-200 rounded px-1.5 py-1"
                    >
                      <option value="minutes">Min</option>
                      <option value="hours">Hrs</option>
                      <option value="days">Days</option>
                    </select>
                  </div>
                </div>

                {/* ASA Target Default (Conditional) */}
                {sla.boAsaEnabled && (
                  <div className="p-3 bg-white rounded-lg border border-purple-200 space-y-1.5">
                    <span className="text-[11px] font-bold text-purple-900 block uppercase">BO ASA Baseline Target</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-500">≤</span>
                      <input
                        type="number"
                        min="1"
                        value={sla.boAsaTarget}
                        onChange={(e) =>
                          onUpdateSLA({
                            ...sla,
                            boAsaTarget: Math.max(1, parseInt(e.target.value) || 60),
                          })
                        }
                        className="w-18 px-2 py-1 text-xs bg-slate-50 border border-slate-200 rounded font-mono font-medium"
                      />
                      <select
                        value={sla.boAsaUnit}
                        onChange={(e) => onUpdateSLA({ ...sla, boAsaUnit: e.target.value as TimeUnit })}
                        className="text-xs bg-slate-50 border border-slate-200 rounded px-1.5 py-1"
                      >
                        <option value="minutes">Min</option>
                        <option value="hours">Hrs</option>
                        <option value="days">Days</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Per-Category SLA Targets Configuration Matrix */}
            <div className="space-y-3 pt-2">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                    Per-Category SLA Configuration & Targets Matrix
                  </h4>
                  <p className="text-[11px] text-slate-500">
                    Each identified category has its own distinct Primary % target, Primary window, Absolute 100% window{sla.boAsaEnabled ? ', and BO ASA target' : ''}.
                  </p>
                </div>
              </div>

              {categories.length === 0 ? (
                <div className="p-8 text-center text-slate-400 text-xs italic bg-slate-50 rounded-xl">
                  No categories identified. Upload an interval file to populate categories.
                </div>
              ) : (
                <div className="overflow-x-auto border border-slate-200 rounded-xl bg-white">
                  <table className="w-full text-xs text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-100 border-b border-slate-200 text-slate-700 font-semibold">
                        <th className="py-2.5 px-3">Identified Category</th>
                        <th className="py-2.5 px-3">Primary SLA Target</th>
                        <th className="py-2.5 px-3">Primary Window</th>
                        {sla.boAsaEnabled && <th className="py-2.5 px-3">BO ASA Target</th>}
                        <th className="py-2.5 px-3">Resolved Deadlines</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {categories.map((c) => {
                        const targetPct = c.primaryPct !== undefined ? c.primaryPct : sla.primaryPct;
                        const priWinVal = c.primaryWindow !== undefined ? c.primaryWindow : (c.primaryWindowMinutes ? c.primaryWindowMinutes / 60 : sla.primaryWindow);
                        const priUnit = c.primaryUnit || 'hours';
                        const asaTargetVal = c.boAsaTarget !== undefined ? c.boAsaTarget : sla.boAsaTarget;
                        const asaUnit = c.boAsaUnit || sla.boAsaUnit;

                        return (
                          <tr key={c.id} className="hover:bg-slate-50/80 transition">
                            <td className="py-2.5 px-3 font-semibold text-slate-900">
                              <div className="flex items-center gap-2">
                                <span className="px-2 py-0.5 bg-slate-100 border border-slate-200 rounded font-medium text-slate-800">
                                  {c.name}
                                </span>
                                <span className="text-[10px] text-slate-400 font-mono">P{c.priority}</span>
                              </div>
                            </td>

                            {/* Primary SLA Target % */}
                            <td className="py-2.5 px-3">
                              <div className="flex items-center gap-1">
                                <input
                                  type="number"
                                  min="1"
                                  max="100"
                                  value={targetPct}
                                  onChange={(e) => {
                                    const val = Math.min(100, Math.max(1, parseInt(e.target.value) || 80));
                                    handleUpdateCatField(c.id, 'primaryPct', val);
                                  }}
                                  className="w-16 px-2 py-1 bg-white border border-slate-200 rounded text-xs font-mono font-medium"
                                />
                                <span className="text-slate-500 font-medium">%</span>
                              </div>
                            </td>

                            {/* Primary SLA Window */}
                            <td className="py-2.5 px-3">
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="number"
                                  min="1"
                                  value={priWinVal}
                                  onChange={(e) => {
                                    const val = Math.max(1, parseFloat(e.target.value) || 1);
                                    const unit = c.primaryUnit || 'hours';
                                    const inMin = convertDurationToMinutes(val, unit);
                                    onUpdateCategories(
                                      categories.map((cat) =>
                                        cat.id === c.id
                                          ? { ...cat, primaryWindow: val, primaryUnit: unit, primaryWindowMinutes: inMin }
                                          : cat
                                      )
                                    );
                                  }}
                                  className="w-16 px-2 py-1 bg-white border border-slate-200 rounded text-xs font-mono font-medium"
                                />
                                <select
                                  value={priUnit}
                                  onChange={(e) => {
                                    const unit = e.target.value as TimeUnit;
                                    const inMin = convertDurationToMinutes(priWinVal, unit);
                                    onUpdateCategories(
                                      categories.map((cat) =>
                                        cat.id === c.id
                                          ? { ...cat, primaryUnit: unit, primaryWindow: priWinVal, primaryWindowMinutes: inMin }
                                          : cat
                                      )
                                    );
                                  }}
                                  className="text-xs bg-white border border-slate-200 rounded px-1.5 py-1"
                                >
                                  <option value="minutes">Min</option>
                                  <option value="hours">Hrs</option>
                                  <option value="days">Days</option>
                                </select>
                              </div>
                            </td>

                            {/* BO ASA Target (Conditional) */}
                            {sla.boAsaEnabled && (
                              <td className="py-2.5 px-3">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-slate-400">≤</span>
                                  <input
                                    type="number"
                                    min="1"
                                    value={asaTargetVal}
                                    onChange={(e) => {
                                      const val = Math.max(1, parseFloat(e.target.value) || 1);
                                      const unit = c.boAsaUnit || sla.boAsaUnit;
                                      onUpdateCategories(
                                        categories.map((cat) =>
                                          cat.id === c.id
                                            ? { ...cat, boAsaTarget: val, boAsaUnit: unit }
                                            : cat
                                        )
                                      );
                                    }}
                                    className="w-16 px-2 py-1 bg-white border border-slate-200 rounded text-xs font-mono font-medium"
                                  />
                                  <select
                                    value={asaUnit}
                                    onChange={(e) => {
                                      const unit = e.target.value as TimeUnit;
                                      onUpdateCategories(
                                        categories.map((cat) =>
                                          cat.id === c.id
                                            ? { ...cat, boAsaUnit: unit }
                                            : cat
                                        )
                                      );
                                    }}
                                    className="text-xs bg-white border border-slate-200 rounded px-1.5 py-1"
                                  >
                                    <option value="minutes">Min</option>
                                    <option value="hours">Hrs</option>
                                    <option value="days">Days</option>
                                  </select>
                                </div>
                              </td>
                            )}

                            {/* Resolved Deadlines Badge */}
                            <td className="py-2.5 px-3">
                              <div className="flex flex-col gap-0.5">
                                <span className="text-[11px] font-mono text-blue-700">
                                  {targetPct}% in {priWinVal} {priUnit}
                                </span>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Statistical CI Confidence */}
            <div className="pt-3 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <span className="text-xs font-bold text-slate-800 uppercase tracking-wider block">
                  Statistical CI Confidence
                </span>
                <span className="text-[11px] text-slate-500">
                  Pass when CI lower bound ≥ Primary SLA % (or sizing floor when Acceptance Slack is ON). Same CI for Primary, BO ASA, and occupancy.
                  Re-run sizing after changing. Req HC only rises when CI binds above N_min (workload floor).
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={50}
                  max={99.9}
                  step={0.1}
                  value={sla.confidenceLevelPct ?? 95}
                  onChange={(e) =>
                    onUpdateSLA({
                      ...sla,
                      confidenceLevelPct: Math.min(
                        99.9,
                        Math.max(50, Math.round((parseFloat(e.target.value) || 95) * 10) / 10)
                      ),
                    })
                  }
                  className="w-24 px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded font-mono font-medium"
                />
                <span className="text-xs text-slate-600">% two-sided CI</span>
              </div>
            </div>

            {/* SLA Acceptance Slack */}
            <div className="pt-3 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                    SLA Acceptance Slack
                  </span>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={sla.slaAcceptanceSlackEnabled === true}
                      onChange={(e) =>
                        onUpdateSLA({
                          ...sla,
                          slaAcceptanceSlackEnabled: e.target.checked,
                          slaAcceptanceSlackPct:
                            sla.slaAcceptanceSlackPct !== undefined
                              ? Math.min(20, Math.max(1, Math.round(sla.slaAcceptanceSlackPct)))
                              : 5,
                        })
                      }
                      className="sr-only peer"
                    />
                    <div className="relative w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-600"></div>
                  </label>
                </div>
                <span className="text-[11px] text-slate-500">
                  Sizing floor = Primary% × (1 − slack%). OFF = no slack (exact Primary%). Does not change case deadlines or dispatch.
                </span>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="1"
                  max="20"
                  disabled={sla.slaAcceptanceSlackEnabled !== true}
                  value={sla.slaAcceptanceSlackPct ?? 5}
                  onChange={(e) =>
                    onUpdateSLA({
                      ...sla,
                      slaAcceptanceSlackPct: Math.min(20, Math.max(1, parseInt(e.target.value, 10) || 5)),
                    })
                  }
                  className="w-24 px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded font-mono disabled:opacity-40"
                />
                <span className="text-xs text-slate-600">% slack</span>
              </div>
            </div>

            {/* Workload HC Reduction */}
            <div className="pt-3 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                    Workload HC Reduction
                  </span>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={sla.workloadReductionEnabled === true}
                      onChange={(e) =>
                        onUpdateSLA({
                          ...sla,
                          workloadReductionEnabled: e.target.checked,
                          workloadReductionPct:
                            sla.workloadReductionPct !== undefined
                              ? Math.min(50, Math.max(1, Math.round(sla.workloadReductionPct)))
                              : 5,
                        })
                      }
                      className="sr-only peer"
                    />
                    <div className="relative w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-600"></div>
                  </label>
                </div>
                <span className="text-[11px] text-slate-500">
                  N_min = floor(Workload × (1 − reduction%) / (Occupancy × agentHours × Adherence)). OFF = no reduction. DES may still size above if SLA binds. Rounding can mask small %.
                </span>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="1"
                  max="50"
                  disabled={sla.workloadReductionEnabled !== true}
                  value={sla.workloadReductionPct ?? 5}
                  onChange={(e) =>
                    onUpdateSLA({
                      ...sla,
                      workloadReductionPct: Math.min(50, Math.max(1, parseInt(e.target.value, 10) || 5)),
                    })
                  }
                  className="w-24 px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded font-mono disabled:opacity-40"
                />
                <span className="text-xs text-slate-600">% reduction</span>
              </div>
            </div>

            {/* Occupancy Cap */}
            <div className="pt-3 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                    Handling Occupancy Ceiling
                  </span>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={sla.occupancyCapEnabled}
                      onChange={(e) =>
                        onUpdateSLA({
                          ...sla,
                          occupancyCapEnabled: e.target.checked,
                        })
                      }
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-600"></div>
                  </label>
                </div>
                <span className="text-[11px] text-slate-500">
                  A headcount is never recommended above this occupancy. Off = 100% (physical feasibility
                  only). COPC-aligned sustainable backoffice practice recommends ~85% for planning headroom.
                </span>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="50"
                  max="100"
                  disabled={!sla.occupancyCapEnabled}
                  value={sla.occupancyCapEnabled ? sla.occupancyCapPct : 100}
                  onChange={(e) =>
                    onUpdateSLA({
                      ...sla,
                      occupancyCapPct: Math.min(100, Math.max(50, parseInt(e.target.value) || 85)),
                    })
                  }
                  className="w-24 px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded font-mono disabled:opacity-40"
                />
                <span className="text-xs text-slate-600">% max occupancy</span>
              </div>
            </div>

            {/* Minimum Coverage Floor */}
            <div className="pt-3 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                    Minimum Coverage Floor
                  </span>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={sla.minCoverageEnabled !== false}
                      onChange={(e) =>
                        onUpdateSLA({
                          ...sla,
                          minCoverageEnabled: e.target.checked,
                        })
                      }
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-600"></div>
                  </label>
                </div>
                <span className="text-[11px] text-slate-500">
                  The queue may never be left with fewer than this many agents on shift while the
                  business is open. On by default at 1 — the recommendation is only ever raised if no
                  redistribution at the current headcount can satisfy this. Off = no floor (pre-2026
                  behavior).
                </span>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  max="999"
                  disabled={sla.minCoverageEnabled === false}
                  value={sla.minCoverageEnabled === false ? 0 : (sla.minAgentsPerInterval ?? 1)}
                  onChange={(e) =>
                    onUpdateSLA({
                      ...sla,
                      minAgentsPerInterval: Math.max(0, parseInt(e.target.value, 10) || 0),
                    })
                  }
                  className="w-24 px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded font-mono disabled:opacity-40"
                />
                <span className="text-xs text-slate-600">min agents/interval</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 4. CATEGORIES TAB (Labor & Category Parameters) */}
      {currentTab === 'categories' && (
        <div className="space-y-5">
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  Discovered Categories & Segment Parameters
                </h3>
                <p className="text-xs text-slate-500">
                  Configure fixed AHT (min), Shrinkage %, and Priority rank. SLA turnaround targets are centrally governed in the <span className="font-semibold text-slate-700">SLA Policy</span> tab.
                </p>
              </div>
              <span className="text-xs px-2.5 py-1 bg-blue-50 border border-blue-200 text-blue-700 font-semibold rounded-lg">
                {categories.length} {categories.length === 1 ? 'Category' : 'Categories'}
              </span>
            </div>

            {categories.length === 0 ? (
              <div className="p-8 text-center text-slate-400 text-xs italic bg-slate-50 rounded-xl">
                No categories discovered yet. Please upload a 30-minute inflow file in the Demand flow.
              </div>
            ) : (
              <div className="overflow-x-auto border border-slate-200 rounded-xl bg-white">
                <table className="w-full text-xs text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-100 border-b border-slate-200 text-slate-700 font-semibold">
                      <th className="py-2.5 px-3">Category Name</th>
                      <th className="py-2.5 px-3">AHT (Minutes)</th>
                      <th className="py-2.5 px-3">Shrinkage %</th>
                      <th className="py-2.5 px-3">Priority Rank</th>
                      <th className="py-2.5 px-3">Primary SLA (Locked)</th>
                      {sla.boAsaEnabled && <th className="py-2.5 px-3">BO ASA (Locked)</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {categories.map((c) => {
                      const targetPct = c.primaryPct !== undefined ? c.primaryPct : sla.primaryPct;
                      const priWinVal = c.primaryWindow !== undefined ? c.primaryWindow : (c.primaryWindowMinutes ? c.primaryWindowMinutes / 60 : sla.primaryWindow);
                      const priUnit = c.primaryUnit || sla.primaryUnit || 'hours';
                      const asaTargetVal = c.boAsaTarget !== undefined ? c.boAsaTarget : sla.boAsaTarget;
                      const asaUnit = c.boAsaUnit || sla.boAsaUnit || 'minutes';

                      return (
                        <tr key={c.id} className="hover:bg-slate-50/80 transition">
                          <td className="py-2.5 px-3 font-semibold text-slate-900">
                            <span className="px-2 py-1 bg-slate-100 border border-slate-200 rounded text-slate-800 font-medium">
                              {c.name}
                            </span>
                          </td>

                          <td className="py-2.5 px-3">
                            <div className="flex items-center gap-1.5">
                              <input
                                type="number"
                                min="1"
                                step="1"
                                value={c.ahtMinutes}
                                onChange={(e) =>
                                  handleUpdateCatField(c.id, 'ahtMinutes', Math.max(1, parseFloat(e.target.value) || 1))
                                }
                                className="w-20 px-2 py-1 bg-white border border-slate-200 rounded text-xs font-mono font-medium"
                              />
                              <span className="text-slate-400">min</span>
                            </div>
                          </td>

                          <td className="py-2.5 px-3">
                            <div className="flex items-center gap-1.5">
                              <input
                                type="number"
                                min="0"
                                max="99"
                                step="1"
                                value={Math.round(c.shrinkagePct * 100)}
                                onChange={(e) => {
                                  const val = Math.min(99, Math.max(0, parseFloat(e.target.value) || 0));
                                  handleUpdateCatField(c.id, 'shrinkagePct', val / 100);
                                }}
                                className="w-20 px-2 py-1 bg-white border border-slate-200 rounded text-xs font-mono font-medium"
                              />
                              <span className="text-slate-400">%</span>
                            </div>
                          </td>

                          <td className="py-2.5 px-3">
                            <input
                              type="number"
                              min="1"
                              value={c.priority}
                              onChange={(e) =>
                                handleUpdateCatField(c.id, 'priority', parseInt(e.target.value) || 1)
                              }
                              className="w-16 px-2 py-1 bg-white border border-slate-200 rounded text-xs font-mono font-medium"
                            />
                          </td>

                          {/* Primary SLA - Locked */}
                          <td className="py-2.5 px-3">
                            <div className="inline-flex items-center gap-1.5 px-2 py-1 bg-blue-50/70 border border-blue-200/80 rounded-md text-blue-800" title="Centrally managed in SLA Policy tab">
                              <Lock className="w-3 h-3 text-blue-400 shrink-0" />
                              <span className="font-mono text-xs font-semibold">
                                {targetPct}% in {priWinVal} {priUnit}
                              </span>
                            </div>
                          </td>

                          {/* BO ASA Target - Locked (if enabled) */}
                          {sla.boAsaEnabled && (
                            <td className="py-2.5 px-3">
                              <div className="inline-flex items-center gap-1.5 px-2 py-1 bg-purple-50/70 border border-purple-200/80 rounded-md text-purple-800" title="Centrally managed in SLA Policy tab">
                                <Lock className="w-3 h-3 text-purple-400 shrink-0" />
                                <span className="font-mono text-xs font-semibold">
                                  ≤ {asaTargetVal} {asaUnit}
                                </span>
                              </div>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
