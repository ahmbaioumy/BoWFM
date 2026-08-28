/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  CalendarConfig,
  CategoryConfig,
  LaborConfig,
  SLAPolicyConfig,
  SimulationParams,
} from '../types/wfm';
import { getDailyWindowLengthHours } from '../utils/calendar';
import { X, CheckCircle, ShieldAlert, Cpu, BookOpen, Layers } from 'lucide-react';

interface ParamsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  calendar: CalendarConfig;
  labor: LaborConfig;
  sla: SLAPolicyConfig;
  categories: CategoryConfig[];
  simParams: SimulationParams;
}

export function ParamsPanel({
  isOpen,
  onClose,
  calendar,
  labor,
  sla,
  categories,
  simParams,
}: ParamsPanelProps) {
  if (!isOpen) return null;

  const dailyWindow = getDailyWindowLengthHours(calendar);
  const isCapacityValid = labor.dailyProductiveHours <= dailyWindow + 0.05;
  const adherence = labor.adherencePct || 1.0;
  const presentDailyHours = labor.dailyProductiveHours * adherence;

  return (
    <aside
      id="persistent-params-panel"
      className="w-80 bg-slate-900/95 backdrop-blur-md border-l border-slate-800 text-slate-200 flex flex-col justify-between shrink-0 self-stretch select-none z-30 shadow-2xl"
    >
      {/* Panel Header */}
      <div className="p-3.5 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-blue-400" />
          <h3 className="text-xs font-bold uppercase tracking-wider text-white">
            Params & Logic Inspector
          </h3>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition"
          title="Close panel"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Scrollable Contents */}
      <div className="flex-1 overflow-y-auto p-3.5 space-y-4 text-xs">
        {/* Clock & Policy Basis */}
        <div className="bg-slate-800/60 rounded-lg p-3 border border-slate-700/60 space-y-2">
          <div className="flex items-center justify-between text-slate-300 font-bold text-[11px] uppercase tracking-wider">
            <span>SLA Clock Basis</span>
            <span
              className={`px-1.5 py-0.5 rounded font-mono text-[10px] ${
                sla.clockBasis === 'business_time'
                  ? 'bg-blue-500/20 text-blue-300'
                  : 'bg-amber-500/20 text-amber-300'
              }`}
            >
              {sla.clockBasis}
            </span>
          </div>

          <div className="text-[11px] text-slate-400 leading-relaxed">
            {sla.clockBasis === 'business_time' ? (
              <span>Working time only. SLA and LatestSafeStart pause outside working windows.</span>
            ) : (
              <span>Wall-clock elapsed time. Overnight/weekend burns SLA time.</span>
            )}
          </div>

          <div className="pt-2 border-t border-slate-700/50 text-[11px] space-y-1.5">
            <div>
              <span className="text-slate-400 block text-[10px]">Primary SLA</span>
              <span className="font-semibold text-white">
                {sla.primaryPct}% in {sla.primaryWindow} {sla.primaryUnit}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400 text-[10px]">Statistical CI</span>
              <span className="font-semibold text-indigo-300">
                {sla.confidenceLevelPct ?? 95}%
              </span>
            </div>
          </div>

          {sla.boAsaEnabled ? (
            <div className="pt-1 text-[11px] space-y-1">
              <div className="flex justify-between items-center">
                <span className="text-slate-400 text-[10px]">BO ASA Target</span>
                <span className="font-semibold text-purple-300">
                  ≤ {sla.boAsaTarget} {sla.boAsaUnit}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-400 text-[10px]">ASA Calculation</span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300">
                  {(sla.asaClockBasis || 'business_window') === 'business_window' ? 'Business Window' : '24/7 Clock Hours'}
                </span>
              </div>
            </div>
          ) : (
            <div className="pt-1 text-[11px] flex justify-between items-center text-slate-500">
              <span className="text-[10px]">BO ASA Constraint</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-700/50 text-slate-400">
                Off (Turnaround Only)
              </span>
            </div>
          )}
        </div>

        {/* Capacity Basis & Labor Rule (M1) */}
        <div className="bg-slate-800/60 rounded-lg p-3 border border-slate-700/60 space-y-2">
          <div className="flex items-center justify-between font-bold text-[11px] uppercase tracking-wider">
            <span className="text-slate-300">Capacity Basis (M1)</span>
            {isCapacityValid ? (
              <span className="flex items-center gap-1 text-emerald-400 text-[10px]">
                <CheckCircle className="w-3 h-3" /> Valid
              </span>
            ) : (
              <span className="flex items-center gap-1 text-rose-400 text-[10px]">
                <ShieldAlert className="w-3 h-3" /> Exceeds
              </span>
            )}
          </div>

          <div className="text-[11px] text-slate-300 space-y-1">
            <div className="flex justify-between">
              <span className="text-slate-400">Daily Productive Hours:</span>
              <span className="font-mono font-semibold">{labor.dailyProductiveHours}h</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Schedule Adherence:</span>
              <span className="font-mono font-semibold">{Math.round(adherence * 100)}%</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">DES Present Hours / Day:</span>
              <span className="font-mono font-semibold text-emerald-400">
                {presentDailyHours.toFixed(2)}h
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Daily Business Window:</span>
              <span className="font-mono font-semibold">
                {calendar.is24x7 ? '24h (24/7 Continuous)' : `${dailyWindow}h`}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Working Days / Wk:</span>
              <span className="font-mono font-semibold">{labor.workingDaysPerWeek} days</span>
            </div>
          </div>
        </div>

        {/* Agent Hours for Workload HC (N_min) */}
        <div className="bg-slate-800/60 rounded-lg p-3 border border-slate-700/60 space-y-1.5">
          <div className="flex items-center justify-between font-bold text-[11px] uppercase tracking-wider text-slate-300">
            <span>Agent Hours (N_min)</span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-700 text-slate-200">
              {labor.contractualHoursSource}
            </span>
          </div>
          <p className="text-[11px] text-slate-400 leading-snug">
            {labor.contractualHoursSource === 'override' &&
            Number.isFinite(labor.contractualProductiveHoursOverride) &&
            (labor.contractualProductiveHoursOverride as number) > 0
              ? `Manual override: ${labor.contractualProductiveHoursOverride}h (Workload HC denom)`
              : 'Derived: daily × calendar working days in horizon (0 override ignored).'}
          </p>
        </div>

        {/* Categories Parameter Snapshot */}
        <div className="bg-slate-800/60 rounded-lg p-3 border border-slate-700/60 space-y-2">
          <div className="flex items-center justify-between font-bold text-[11px] uppercase tracking-wider text-slate-300">
            <span>Discovered Categories ({categories.length})</span>
          </div>

          <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
            {categories.map((c) => (
              <div
                key={c.id}
                className="p-2 rounded bg-slate-900/60 border border-slate-700/40 text-[11px] space-y-0.5"
              >
                <div className="flex items-center justify-between font-semibold text-slate-200">
                  <span>{c.name}</span>
                  <span className="text-[10px] text-slate-400 font-mono">Rank {c.priority}</span>
                </div>
                <div className="flex justify-between text-slate-400 font-mono text-[10px]">
                  <span>AHT: {c.ahtMinutes}m</span>
                  <span>Shrinkage: {Math.round(c.shrinkagePct * 100)}%</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Deterministic PRNG Seed */}
        <div className="bg-slate-800/60 rounded-lg p-3 border border-slate-700/60 space-y-1">
          <div className="flex items-center justify-between font-bold text-[11px] uppercase tracking-wider text-slate-300">
            <span>Deterministic PRNG Seed</span>
            <span className="font-mono text-emerald-400">{simParams.seed}</span>
          </div>
          <p className="text-[11px] text-slate-400">
            Common Random Numbers (CRN) guarantees identical arrival times across all HC tests.
          </p>
        </div>
      </div>

      {/* Panel Footer */}
      <div className="p-3 border-t border-slate-800 bg-slate-950/60 flex items-center justify-between text-[11px] text-slate-400">
        <span className="flex items-center gap-1">
          <BookOpen className="w-3.5 h-3.5 text-blue-400" />
          <span>PRD Math Verified</span>
        </span>
        <span className="font-mono text-[10px] text-slate-400">M1 - M5 Locks</span>
      </div>
    </aside>
  );
}
