/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef } from 'react';
import { SearchProgressState, SLAPolicyConfig } from '../types/wfm';
import { Cpu, Loader2, CheckCircle2, AlertTriangle, Activity, Square, ArrowRight, XCircle } from 'lucide-react';

interface SimulationProgressModalProps {
  progress: SearchProgressState | null;
  sla: SLAPolicyConfig;
  isOpen: boolean;
  onCancel?: () => void;
  onClose?: () => void;
}

export function SimulationProgressModal({
  progress,
  sla,
  isOpen,
  onCancel,
  onClose,
}: SimulationProgressModalProps) {
  const tableScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = tableScrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [progress?.evaluatedHistory.length]);

  if (!isOpen || !progress) return null;

  const {
    phase,
    percent,
    currentN,
    nMin,
    currentMessage,
    evaluatedHistory,
    status,
  } = progress;

  const isFinished = status === 'completed' || status === 'infeasible';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="bg-slate-900 text-white p-5 flex items-center justify-between border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Cpu className={`w-5 h-5 ${isFinished ? '' : 'animate-pulse'}`} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-sm text-white">Backoffice DES Sizing Engine</h3>
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold border ${
                    status === 'completed'
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                      : status === 'infeasible'
                      ? 'bg-rose-500/20 text-rose-300 border-rose-500/30'
                      : 'bg-blue-500/20 text-blue-300 border-blue-500/30'
                  }`}
                >
                  {status === 'completed'
                    ? 'COMPLETE'
                    : status === 'infeasible'
                    ? 'INFEASIBLE'
                    : 'ACTIVE SIMULATION'}
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Discrete-event queue simulation searching for minimal compliant headcount
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 text-right">
            <div className="text-2xl font-black font-mono text-emerald-400">
              {percent}%
            </div>
          </div>
        </div>

        {/* Body Content */}
        <div className="p-6 space-y-5 overflow-y-auto">
          {/* Main Progress Bar */}
          <div className="space-y-2">
            <div className="flex justify-between items-center text-xs font-semibold text-slate-700">
              <span className="flex items-center gap-1.5">
                <Activity className={`w-3.5 h-3.5 ${isFinished ? 'text-emerald-600' : 'text-blue-600 animate-pulse'}`} />
                <span>{phase}</span>
              </span>
              <span className="text-slate-500 font-mono">{percent}% complete</span>
            </div>

            {/* Visual Bar */}
            <div className="w-full bg-slate-100 rounded-full h-3.5 overflow-hidden p-0.5 border border-slate-200 shadow-inner">
              <div
                className={`h-full rounded-full transition-all duration-300 ease-out shadow-xs relative overflow-hidden ${
                  status === 'infeasible'
                    ? 'bg-rose-500'
                    : status === 'completed'
                    ? 'bg-emerald-500'
                    : 'bg-linear-to-r from-blue-600 via-indigo-600 to-emerald-500'
                }`}
                style={{ width: `${Math.max(4, Math.min(100, percent))}%` }}
              >
                {!isFinished && (
                  <div className="absolute inset-0 bg-white/20 animate-[shimmer_2s_infinite] bg-[linear-gradient(90deg,transparent_0%,rgba(255,255,255,0.4)_50%,transparent_100%)]"></div>
                )}
              </div>
            </div>

            {/* Current Step Status Message */}
            <div
              className={`p-3 border rounded-xl text-xs flex items-center gap-2.5 ${
                status === 'completed'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : status === 'infeasible'
                  ? 'bg-rose-50 border-rose-200 text-rose-900'
                  : 'bg-slate-50 border-slate-200 text-slate-700'
              }`}
            >
              {status === 'completed' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              ) : status === 'infeasible' ? (
                <XCircle className="w-4 h-4 text-rose-600 shrink-0" />
              ) : (
                <Loader2 className="w-4 h-4 text-indigo-600 animate-spin shrink-0" />
              )}
              <span className="font-medium">{currentMessage}</span>
            </div>
          </div>

          {/* Quick Stats Grid */}
          <div className="grid grid-cols-3 gap-3">
            <div className="p-3 bg-blue-50/60 rounded-xl border border-blue-100 text-center">
              <span className="text-[10px] font-bold text-blue-800 uppercase tracking-wider block">
                {isFinished ? 'Recommended HC' : 'Current Testing HC'}
              </span>
              <span className="text-xl font-mono font-black text-blue-900 mt-0.5 block">
                {currentN ? `N = ${currentN}` : '—'}
              </span>
              <span className="text-[10px] text-blue-600">
                {isFinished ? 'Optimal result' : 'Active DES candidate'}
              </span>
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
                {evaluatedHistory.length}
              </span>
              <span className="text-[10px] text-purple-600">Discrete iterations</span>
            </div>
          </div>

          {/* Real-time Iteration Live Log */}
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                Headcount Candidate Evaluation Feed
              </span>
              <span className="text-[11px] text-slate-400">
                SLA: {sla.primaryPct}% / {sla.primaryWindow} {sla.primaryUnit}
              </span>
            </div>

            <div
              ref={tableScrollRef}
              className="border border-slate-200 rounded-xl overflow-hidden bg-white max-h-48 overflow-y-auto"
            >
              {evaluatedHistory.length === 0 ? (
                <div className="p-4 text-center text-xs text-slate-400 italic">
                  Initializing simulation runs...
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
                    {evaluatedHistory.map((item, idx) => (
                      <tr
                        key={idx}
                        className={`${
                          item.passed
                            ? 'bg-emerald-50/80 font-bold text-emerald-950'
                            : 'hover:bg-slate-50/80 text-slate-700'
                        }`}
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
                            <span className="block text-[10px] text-rose-600">(capacity ratio {item.rawOccupancyPct}%)</span>
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

        {/* Footer */}
        <div className="bg-slate-50 px-6 py-3.5 border-t border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            {!isFinished && (
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>
            )}
            <span>
              {isFinished
                ? 'Simulation execution concluded.'
                : 'Running binary search discrete event simulation...'}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {!isFinished && onCancel && (
              <button
                id="btn-cancel-simulation"
                onClick={onCancel}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-lg text-xs font-semibold transition shadow-xs"
              >
                <Square className="w-3.5 h-3.5 fill-rose-600" />
                Stop Simulation
              </button>
            )}

            {isFinished && onClose && (
              <button
                id="btn-close-simulation-modal"
                onClick={onClose}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold transition shadow-sm"
              >
                <span>View Results</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
