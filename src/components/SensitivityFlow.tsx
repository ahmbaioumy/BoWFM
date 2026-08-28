/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  CalendarConfig,
  CategoryConfig,
  LaborConfig,
  OpeningWIPCase,
  SensitivityScenario,
  SimulationParams,
  SLAPolicyConfig,
  StandardInterval,
} from '../types/wfm';
import { searchOptimalHCAsync } from '../utils/hc-search';
import { TrendingUp, RefreshCw, Layers, ShieldCheck, ArrowRight, Loader2 } from 'lucide-react';

interface SensitivityFlowProps {
  currentTab: string;
  calendar: CalendarConfig;
  labor: LaborConfig;
  sla: SLAPolicyConfig;
  categories: CategoryConfig[];
  intervals: StandardInterval[];
  openingWIP: OpeningWIPCase[];
  simParams: SimulationParams;
  onRunSizing: () => void;
}

const VOL_DELTAS = [-20, -10, 0, 10, 20];
const AHT_DELTAS = [-20, -10, 0, 10, 20];

export function SensitivityFlow({
  currentTab,
  calendar,
  labor,
  sla,
  categories,
  intervals,
  openingWIP,
  simParams,
}: SensitivityFlowProps) {
  const [matrixScenarios, setMatrixScenarios] = useState<SensitivityScenario[] | null>(null);
  const [isCalculating, setIsCalculating] = useState(false);
  const [calcProgress, setCalcProgress] = useState<{ current: number; total: number; scenarioDesc: string } | null>(null);
  const [metricView, setMetricView] = useState<'operational' | 'gross'>('operational');
  const cancelSensitivityRef = React.useRef(false);

  async function calculateSensitivityGrid() {
    setIsCalculating(true);
    cancelSensitivityRef.current = false;
    const totalScenarios = VOL_DELTAS.length * AHT_DELTAS.length;
    const results: SensitivityScenario[] = [];
    let completedCount = 0;

    try {
      for (const vDelta of VOL_DELTAS) {
        for (const aDelta of AHT_DELTAS) {
          if (cancelSensitivityRef.current) {
            break;
          }

          const scenarioDesc = `Volume ${vDelta >= 0 ? `+${vDelta}%` : `${vDelta}%`}, AHT ${aDelta >= 0 ? `+${aDelta}%` : `${aDelta}%`}`;
          setCalcProgress({
            current: completedCount + 1,
            total: totalScenarios,
            scenarioDesc,
          });

          // Yield to let React re-render the progress
          await new Promise((r) => setTimeout(r, 25));

          // Adjust intervals volume
          const scaledIntervals = intervals.map((it) => ({
            ...it,
            volume: Math.max(0, Math.round(it.volume * (1 + vDelta / 100))),
          }));

          // Adjust categories AHT
          const scaledCategories = categories.map((c) => ({
            ...c,
            ahtMinutes: Math.max(1, Math.round(c.ahtMinutes * (1 + aDelta / 100))),
          }));

          const searchRes = await searchOptimalHCAsync({
            intervals: scaledIntervals,
            openingWIP,
            categories: scaledCategories,
            calendar,
            labor,
            sla,
            seed: simParams.seed,
            userMaxHC: simParams.maxHCSearch || 500,
            replications: simParams.replications || 30,
            queueArchitecture: simParams.queueArchitecture || 'pooled',
            shouldCancel: () => cancelSensitivityRef.current,
          });

          results.push({
            volumeDeltaPct: vDelta,
            ahtDeltaPct: aDelta,
            operationalHC: searchRes.recommendedHC,
            grossHCTotal: searchRes.staffing?.grossHCTotal || null,
            fteGross: searchRes.staffing?.fteGrossHeadline || null,
            primaryPct: searchRes.finalDESResult?.primaryAchievedPct || 0,
            boAsaMinutes: searchRes.finalDESResult?.boAsaMeanMinutes || 0,
            passed: !searchRes.isInfeasible,
          });

          completedCount++;
        }
        if (cancelSensitivityRef.current) break;
      }

      if (!cancelSensitivityRef.current) {
        setMatrixScenarios(results);
      }
    } finally {
      setIsCalculating(false);
      setCalcProgress(null);
    }
  }

  function handleCancelSensitivity() {
    cancelSensitivityRef.current = true;
    setIsCalculating(false);
    setCalcProgress(null);
  }

  // Find baseline scenario
  const baseline = matrixScenarios?.find((s) => s.volumeDeltaPct === 0 && s.ahtDeltaPct === 0);

  return (
    <div className="space-y-6">
      {/* 1. SCENARIOS MATRIX TAB */}
      {currentTab === 'scenarios' && (
        <div className="space-y-5">
          <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-xs space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 pb-4">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  5x5 Stress & Sensitivity Staffing Matrix
                </h3>
                <p className="text-xs text-slate-500">
                  Simulates full discrete event staffing search across ±20% Volume vs ±20% AHT permutations.
                </p>
              </div>

              <div className="flex items-center gap-3">
                {matrixScenarios && (
                  <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
                    <button
                      onClick={() => setMetricView('operational')}
                      className={`px-2.5 py-1 rounded text-xs font-semibold transition ${
                        metricView === 'operational'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Operational HC (DES)
                    </button>
                    <button
                      onClick={() => setMetricView('gross')}
                      className={`px-2.5 py-1 rounded text-xs font-semibold transition ${
                        metricView === 'gross'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Pooled Gross HC (M2)
                    </button>
                  </div>
                )}

                <button
                  onClick={calculateSensitivityGrid}
                  disabled={isCalculating || intervals.length === 0}
                  className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-xl text-xs font-bold hover:bg-emerald-700 transition disabled:opacity-40 shadow-xs"
                >
                  {isCalculating ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>
                        Computing ({calcProgress?.current || 0}/{calcProgress?.total || 25})...
                      </span>
                    </>
                  ) : (
                    <>
                      <RefreshCw className="w-4 h-4" />
                      <span>Compute 5x5 Matrix</span>
                    </>
                  )}
                </button>

                {isCalculating && (
                  <button
                    onClick={handleCancelSensitivity}
                    className="flex items-center gap-1.5 px-3 py-2 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-xl text-xs font-semibold transition"
                  >
                    Stop
                  </button>
                )}
              </div>
            </div>

            {/* Sensitivity Calculation Live Progress */}
            {isCalculating && calcProgress && (
              <div className="p-4 bg-slate-900 text-white rounded-xl border border-slate-800 space-y-2.5 animate-in fade-in duration-150">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-300 flex items-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" />
                    <span>Testing scenario {calcProgress.current} of {calcProgress.total}: {calcProgress.scenarioDesc}</span>
                  </span>
                  <span className="font-mono font-bold text-emerald-400">
                    {Math.round((calcProgress.current / calcProgress.total) * 100)}%
                  </span>
                </div>
                <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden border border-slate-700">
                  <div
                    className="bg-linear-to-r from-blue-500 to-emerald-400 h-full rounded-full transition-all duration-200"
                    style={{
                      width: `${Math.round((calcProgress.current / calcProgress.total) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {matrixScenarios ? (
              <div className="space-y-4">
                <div className="overflow-x-auto border border-slate-200 rounded-xl">
                  <table className="w-full text-xs text-center border-collapse">
                    <thead>
                      <tr className="bg-slate-100 border-b border-slate-200 text-slate-700">
                        <th className="py-3 px-4 text-left font-bold border-r border-slate-200">
                          Volume \ AHT Delta
                        </th>
                        {AHT_DELTAS.map((a) => (
                          <th key={a} className="py-3 px-4 font-bold">
                            {a >= 0 ? `+${a}%` : `${a}%`} AHT
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 font-mono">
                      {VOL_DELTAS.map((v) => (
                        <tr key={v}>
                          <td className="py-3 px-4 text-left font-bold bg-slate-50 border-r border-slate-200 font-sans text-slate-800">
                            {v >= 0 ? `+${v}%` : `${v}%`} Volume
                          </td>
                          {AHT_DELTAS.map((a) => {
                            const sc = matrixScenarios.find(
                              (s) => s.volumeDeltaPct === v && s.ahtDeltaPct === a
                            );
                            const isBaseline = v === 0 && a === 0;
                            const val =
                              metricView === 'operational' ? sc?.operationalHC : sc?.grossHCTotal;

                            return (
                              <td
                                key={a}
                                className={`py-3 px-4 transition ${
                                  isBaseline
                                    ? 'bg-emerald-100/60 font-black text-emerald-950 ring-2 ring-emerald-500/50'
                                    : (v > 0 || a > 0)
                                    ? 'bg-rose-50/40 text-slate-900 font-semibold'
                                    : 'bg-blue-50/40 text-slate-900 font-semibold'
                                }`}
                              >
                                <span className="text-sm block">
                                  {val !== null && val !== undefined ? val : 'Infeasible'}
                                </span>
                                <span className="text-[10px] text-slate-400 font-sans block">
                                  {isBaseline ? 'Baseline' : `${sc?.primaryPct}% SLA`}
                                </span>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="p-12 text-center text-slate-400 text-xs italic bg-slate-50 rounded-xl">
                Click &quot;Compute 5x5 Matrix&quot; above to simulate sensitivity scenarios across Volume and AHT permutations.
              </div>
            )}
          </div>
        </div>
      )}

      {/* 2. COMPARE SCENARIOS TAB */}
      {currentTab === 'compare' && (
        <div className="space-y-5">
          <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-xs space-y-5">
            <div className="border-b border-slate-100 pb-3">
              <h3 className="text-sm font-bold text-slate-900">
                Baseline vs Stressed Scenarios Comparison
              </h3>
              <p className="text-xs text-slate-500">
                Detailed comparison table of staffing requirements, SLA achievements, and BO ASA.
              </p>
            </div>

            {matrixScenarios ? (
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-xs text-left">
                  <thead className="bg-slate-100 text-slate-700 font-semibold border-b border-slate-200">
                    <tr>
                      <th className="py-2.5 px-3">Scenario Name</th>
                      <th className="py-2.5 px-3 text-right">Vol Delta</th>
                      <th className="py-2.5 px-3 text-right">AHT Delta</th>
                      <th className="py-2.5 px-3 text-right">Net HC</th>
                      <th className="py-2.5 px-3 text-right">Gross HC (M2)</th>
                      <th className="py-2.5 px-3 text-right">Primary SLA %</th>
                      <th className="py-2.5 px-3 text-right">BO ASA</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono text-[11px]">
                    {[
                      { name: 'Baseline Sizing', v: 0, a: 0 },
                      { name: 'Light Efficiency', v: -10, a: -10 },
                      { name: 'High Volume Inflow', v: 20, a: 0 },
                      { name: 'High Complexity (AHT +20%)', v: 0, a: 20 },
                      { name: 'Severe Combined Stress (+20% / +20%)', v: 20, a: 20 },
                    ].map((row, idx) => {
                      const sc = matrixScenarios.find(
                        (s) => s.volumeDeltaPct === row.v && s.ahtDeltaPct === row.a
                      );
                      const isBase = row.v === 0 && row.a === 0;

                      return (
                        <tr
                          key={idx}
                          className={`hover:bg-slate-50 ${isBase ? 'bg-emerald-50/50 font-bold' : ''}`}
                        >
                          <td className="py-2.5 px-3 font-sans font-semibold text-slate-900">
                            {row.name}
                          </td>
                          <td className="py-2.5 px-3 text-right">{row.v >= 0 ? `+${row.v}%` : `${row.v}%`}</td>
                          <td className="py-2.5 px-3 text-right">{row.a >= 0 ? `+${row.a}%` : `${row.a}%`}</td>
                          <td className="py-2.5 px-3 text-right text-emerald-700 font-bold">
                            {sc?.operationalHC || '-'}
                          </td>
                          <td className="py-2.5 px-3 text-right text-blue-700 font-bold">
                            {sc?.grossHCTotal || '-'}
                          </td>
                          <td className="py-2.5 px-3 text-right">{sc?.primaryPct || 100}%</td>
                          <td className="py-2.5 px-3 text-right">{sc?.boAsaMinutes || 0}m</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-8 text-center text-slate-400 text-xs italic bg-slate-50 rounded-xl">
                Please compute the sensitivity matrix on the Scenarios Matrix tab first.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
