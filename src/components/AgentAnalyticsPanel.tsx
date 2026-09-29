/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useId, useMemo, useState } from 'react';
import { CalendarConfig, DESResult, LaborConfig } from '../types/wfm';
import {
  AgentAnalytics,
  AgentAnalyticsRow,
  buildAgentAnalyticsExport,
  buildAgentInsights,
  computeAgentAnalytics,
  sortRowsByCases,
} from '../utils/agent-analytics';
import { exportToExcelCSV } from '../utils/csv-parser';
import { Download, Info, RotateCcw, Sparkles } from 'lucide-react';

interface Props {
  des: DESResult;
  calendar: CalendarConfig;
  labor: LaborConfig;
}

const r1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const shortDate = (d: string) => d.slice(5); // MM-DD

const DEFINITIONS =
  'Available = busy + idle minutes while on shift. Occupancy = busy / available. ' +
  'Utilisation = busy / scheduled, where scheduled = available + the rest of the shift after the daily productive-hour budget is used up. ' +
  'The engine models no other non-productive time inside a shift, so occupancy and utilisation are the SAME number for any agent-day where the budget is not exhausted; they only differ on days it is. ' +
  'Cases handled = cases the agent finished (credited once). Touched = cases the agent worked on, including split cases. ' +
  'Avg handle = busy minutes / cases touched. Cases/day = handled / days on shift. ' +
  'Neither is the planned-capacity occupancy used for sizing.';

/* ------------------------------ Charts (inline SVG) ------------------------------ */

function ChartFrame({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <figure className="border border-slate-200 rounded-lg p-3 space-y-2 min-w-0">
      <figcaption className="text-xs font-bold text-slate-800">{title}</figcaption>
      <p className="text-[11px] text-slate-500">{desc}</p>
      {children}
    </figure>
  );
}

function CasesBarChart({ a }: { a: AgentAnalytics }) {
  const id = useId();
  const rows = sortRowsByCases(a.rows);
  const rowH = 20;
  const labelW = 72;
  const W = 560;
  const padTop = 22;
  const plotW = W - labelW - 40;
  const H = padTop + rows.length * rowH + 8;
  const maxV = Math.max(1, a.team.casesMean, ...rows.map((r) => r.casesCompleted));
  const x = (v: number) => labelW + (v / maxV) * plotW;
  const summary = `Cases handled per agent, sorted high to low. Team average ${r1(a.team.casesMean)}. ` +
    (rows.length ? `Highest ${rows[0].agentLabel} ${rows[0].casesCompleted}, lowest ${rows[rows.length - 1].agentLabel} ${rows[rows.length - 1].casesCompleted}.` : '');
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ minWidth: W, maxWidth: 'none' }} role="img" aria-labelledby={`${id}t ${id}d`}>
      <title id={`${id}t`}>Cases handled per agent</title>
      <desc id={`${id}d`}>{summary}</desc>
      {rows.map((r, i) => {
        const y = padTop + i * rowH;
        return (
          <g key={r.agentId}>
            <text x={labelW - 6} y={y + 14} textAnchor="end" className="fill-slate-600 text-[11px]">{r.agentLabel}</text>
            <rect x={labelW} y={y + 2} width={Math.max(0, x(r.casesCompleted) - labelW)} height={rowH - 5} rx={2} className="fill-blue-500">
              <title>{`${r.agentLabel}: ${r.casesCompleted} cases (${r.category})`}</title>
            </rect>
            <text x={x(r.casesCompleted) + 4} y={y + 14} className="fill-slate-700 text-[11px]">{r.casesCompleted}</text>
          </g>
        );
      })}
      <line x1={x(a.team.casesMean)} x2={x(a.team.casesMean)} y1={padTop - 4} y2={H - 6} strokeDasharray="4 3" className="stroke-rose-500" strokeWidth={1.5} />
      <text x={x(a.team.casesMean)} y={13} textAnchor="middle" className="fill-rose-600 text-[11px] font-semibold">{`Team avg ${r1(a.team.casesMean)}`}</text>
    </svg>
  );
}

function OccUtilChart({ a }: { a: AgentAnalytics }) {
  const id = useId();
  const rows = a.rows;
  const rowH = 26;
  const labelW = 72;
  const W = 560;
  const padTop = 26;
  const plotW = W - labelW - 96;
  const H = padTop + rows.length * rowH + 20;
  const maxV = Math.max(100, ...rows.map((r) => Math.max(r.occupancyPct, r.utilisationPct)));
  const x = (v: number) => labelW + (v / maxV) * plotW;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ minWidth: W, maxWidth: 'none' }} role="img" aria-labelledby={`${id}t ${id}d`}>
      <title id={`${id}t`}>Occupancy and utilisation per agent</title>
      <desc id={`${id}d`}>{`Two bars per agent. Team occupancy ${r1(a.team.occupancyPct)}%, team utilisation ${r1(a.team.utilisationPct)}%.`}</desc>
      <rect x={labelW} y={4} width={9} height={9} className="fill-blue-500" />
      <text x={labelW + 13} y={13} className="fill-slate-600 text-[11px]">Occupancy</text>
      <rect x={labelW + 90} y={4} width={9} height={9} className="fill-amber-500" />
      <text x={labelW + 103} y={13} className="fill-slate-600 text-[11px]">Utilisation</text>
      {[0, 25, 50, 75, 100].filter((t) => t <= maxV).map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={padTop - 2} y2={H - 6} className="stroke-slate-200" strokeWidth={1} />
          <text x={x(t)} y={H - 4} textAnchor="middle" className="fill-slate-400 text-[11px]">{t}%</text>
        </g>
      ))}
      {rows.map((r, i) => {
        const y = padTop + i * rowH;
        return (
          <g key={r.agentId}>
            <text x={labelW - 6} y={y + 14} textAnchor="end" className="fill-slate-600 text-[11px]">{r.agentLabel}</text>
            <rect x={labelW} y={y + 2} width={Math.max(0, x(r.occupancyPct) - labelW)} height={10} className="fill-blue-500">
              <title>{`${r.agentLabel} occupancy ${r1(r.occupancyPct)}%`}</title>
            </rect>
            <rect x={labelW} y={y + 13} width={Math.max(0, x(r.utilisationPct) - labelW)} height={10} className="fill-amber-500">
              <title>{`${r.agentLabel} utilisation ${r1(r.utilisationPct)}%`}</title>
            </rect>
            <text x={x(Math.max(r.occupancyPct, r.utilisationPct)) + 4} y={y + 17} className="fill-slate-700 text-[11px]">
              {`${r1(r.occupancyPct)} / ${r1(r.utilisationPct)}`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function Heatmap({ a }: { a: AgentAnalytics }) {
  const id = useId();
  const n = a.dates.length;
  if (n === 0 || a.rows.length === 0) return <p className="text-xs text-slate-400 italic">No data in range.</p>;
  const cellH = 18;
  const cellW = Math.max(30, Math.min(48, Math.floor(600 / n)));
  const labelW = 72;
  const padTop = 48;
  const W = labelW + n * cellW + 8;
  const H = padTop + a.rows.length * cellH + 6;
  let max = 1;
  for (const row of a.matrix) for (const v of row) if (v > max) max = v;
  return (
    <div className="overflow-x-auto">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}t ${id}d`} style={{ minWidth: W }}>
        <title id={`${id}t`}>Cases completed per agent per date</title>
        <desc id={`${id}d`}>{`Heatmap, ${a.rows.length} agents by ${n} dates. Darker means more cases; light grey means not on shift. Maximum ${max} cases in one day.`}</desc>
        {a.dates.map((d, j) => (
          <text key={d} transform={`translate(${labelW + j * cellW + cellW / 2 + 3},${padTop - 4}) rotate(-55)`} className="fill-slate-500 text-[11px]">{shortDate(d)}</text>
        ))}
        {a.rows.map((r, i) => (
          <g key={r.agentId}>
            <text x={labelW - 6} y={padTop + i * cellH + 13} textAnchor="end" className="fill-slate-600 text-[11px]">{r.agentLabel}</text>
            {a.dates.map((d, j) => {
              const on = a.onShiftMatrix[i][j];
              const v = a.matrix[i][j];
              const cx = labelW + j * cellW;
              const cy = padTop + i * cellH;
              return (
                <g key={d}>
                  <rect x={cx + 1} y={cy + 1} width={cellW - 2} height={cellH - 2} rx={2}
                    className={on ? 'fill-indigo-600' : 'fill-slate-100 stroke-slate-200'}
                    style={on ? { opacity: 0.08 + 0.92 * (v / max) } : undefined}>
                    <title>{`${r.agentLabel} ${d}: ${on ? `${v} cases` : 'not on shift'}`}</title>
                  </rect>
                  {on && cellW >= 26 && (
                    <text x={cx + cellW / 2} y={cy + 14} textAnchor="middle" className={`${v / max > 0.55 ? 'fill-white' : 'fill-slate-700'} text-[9px]`}>{v}</text>
                  )}
                </g>
              );
            })}
          </g>
        ))}
      </svg>
    </div>
  );
}

function TrendChart({ a }: { a: AgentAnalytics }) {
  const id = useId();
  const pts = a.trend;
  if (pts.length === 0) return <p className="text-xs text-slate-400 italic">No data in range.</p>;
  const W = 560;
  const H = 280;
  const pl = 44;
  const pr = 44;
  const pt = 16;
  const pb = 64;
  const iw = W - pl - pr;
  const ih = H - pt - pb;
  const maxV = Math.max(1, ...pts.map((p) => p.max));
  const x = (i: number) => (pts.length === 1 ? pl + iw / 2 : pl + (i / (pts.length - 1)) * iw);
  const y = (v: number) => pt + ih - (v / maxV) * ih;
  const band = pts.map((p, i) => `${x(i)},${y(p.max)}`).concat([...pts].reverse().map((p, k) => `${x(pts.length - 1 - k)},${y(p.min)}`)).join(' ');
  const line = pts.map((p, i) => `${x(i)},${y(p.avg)}`).join(' ');
  const labelEvery = Math.max(1, Math.ceil(pts.length / 8));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * maxV * 10) / 10);
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ minWidth: W, maxWidth: 'none' }} role="img" aria-labelledby={`${id}t ${id}d`}>
      <title id={`${id}t`}>Daily team trend: cases per agent</title>
      <desc id={`${id}d`}>{`Average cases completed per on-shift agent for each of ${pts.length} dates, with the min to max band across agents.`}</desc>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pl} x2={W - pr} y1={y(t)} y2={y(t)} className="stroke-slate-200" strokeWidth={1} />
          <text x={pl - 4} y={y(t) + 3} textAnchor="end" className="fill-slate-400 text-[11px]">{t}</text>
        </g>
      ))}
      <polygon points={band} className="fill-blue-200" opacity={0.6}>
        <title>Min to max cases across on-shift agents</title>
      </polygon>
      <polyline points={line} fill="none" className="stroke-blue-700" strokeWidth={2} />
      {pts.map((p, i) => (
        <g key={p.date}>
          <circle cx={x(i)} cy={y(p.avg)} r={3} className="fill-blue-700">
            <title>{`${p.date}: avg ${r1(p.avg)}, min ${p.min}, max ${p.max} (${p.agents} agents)`}</title>
          </circle>
          {i % labelEvery === 0 && (
            <text transform={`translate(${x(i) - 4},${H - pb + 14}) rotate(45)`} className="fill-slate-500 text-[11px]">{shortDate(p.date)}</text>
          )}
        </g>
      ))}
      <rect x={pl} y={H - 12} width={9} height={9} className="fill-blue-200" />
      <text x={pl + 13} y={H - 3} className="fill-slate-600 text-[11px]">min-max band</text>
      <line x1={pl + 96} x2={pl + 112} y1={H - 8} y2={H - 8} className="stroke-blue-700" strokeWidth={2} />
      <text x={pl + 116} y={H - 3} className="fill-slate-600 text-[11px]">average</text>
    </svg>
  );
}

/* --------------------------------- Panel --------------------------------- */

export function AgentAnalyticsPanel({ des, calendar, labor }: Props) {
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [category, setCategory] = useState('ALL');
  const [agentIds, setAgentIds] = useState<number[]>([]);

  useEffect(() => {
    setFromDate('');
    setToDate('');
    setCategory('ALL');
    setAgentIds([]);
  }, [des]);

  const base = useMemo(() => computeAgentAnalytics({ des, calendar, labor }), [des, calendar, labor]);
  const a = useMemo(
    () => computeAgentAnalytics({ des, calendar, labor, filter: { fromDate: fromDate || null, toDate: toDate || null, category, agentIds } }),
    [des, calendar, labor, fromDate, toDate, category, agentIds]
  );
  const insights = useMemo(() => buildAgentInsights(a), [a]);

  const minDate = base.allDates[0] ?? '';
  const maxDate = base.allDates[base.allDates.length - 1] ?? '';
  const filtersActive = fromDate !== '' || toDate !== '' || category !== 'ALL' || agentIds.length > 0;
  const allAgents = Array.from({ length: des.operationalHC }, (_, i) => i);

  function toggleAgent(id: number) {
    setAgentIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].sort((x, y) => x - y)));
  }

  function handleExport() {
    exportToExcelCSV([], 'wfm_agent_analytics.csv', buildAgentAnalyticsExport(a).sections);
  }

  const th = 'py-2 px-2.5 text-right whitespace-nowrap';
  const td = 'py-1.5 px-2.5 text-right font-mono text-[11px]';
  const num = (v: number | null) => (v === null ? '-' : r1(v));

  if (!des.agentTimeline || des.agentTimeline.length === 0) return null;

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs space-y-5" data-testid="agent-analytics">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 border-b border-slate-100 pb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-bold text-slate-900">Agent Analytics</h3>
            <span className="text-xs bg-amber-50 border border-amber-200 text-amber-800 font-semibold px-2 py-0.5 rounded-full">audit run (single seed)</span>
          </div>
          <p className="text-xs text-slate-500 mt-1 flex items-start gap-1.5">
            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-slate-400" />
            <span title={DEFINITIONS}>
              Per-agent workload, occupancy and utilisation for the filtered range. Occupancy = busy / available (in queue, on shift);
              utilisation = busy / scheduled shift time. They are the same number unless an agent's daily productive-hour budget runs out
              before the shift ends. Hover for full definitions.
            </span>
          </p>
        </div>
        <button
          onClick={handleExport}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 text-white rounded-lg text-xs font-semibold hover:bg-slate-800 transition shadow-xs self-start shrink-0"
          title="Excel-friendly CSV (UTF-8 BOM): agent summary table + cases per agent per date matrix, for the current filters"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Export agent summary</span>
        </button>
      </div>

      {/* Filters */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
        <label className="text-xs text-slate-600 space-y-1 block">
          <span className="font-semibold">From date</span>
          <input type="date" value={fromDate} min={minDate} max={maxDate} onChange={(e) => setFromDate(e.target.value)}
            className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2" />
        </label>
        <label className="text-xs text-slate-600 space-y-1 block">
          <span className="font-semibold">To date</span>
          <input type="date" value={toDate} min={minDate} max={maxDate} onChange={(e) => setToDate(e.target.value)}
            className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2" />
        </label>
        <label className="text-xs text-slate-600 space-y-1 block">
          <span className="font-semibold">Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)}
            className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
            <option value="ALL">All categories</option>
            {base.categories.map((c) => (<option key={c} value={c}>{c}</option>))}
          </select>
        </label>
        <details className="text-xs text-slate-600 relative">
          <summary className="cursor-pointer select-none bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-semibold">
            Agents: {agentIds.length === 0 ? `all (${allAgents.length})` : `${agentIds.length} selected`}
          </summary>
          <div className="absolute z-10 mt-1 w-full min-w-[180px] bg-white border border-slate-200 rounded-lg shadow-lg p-2 space-y-2">
            <div className="flex gap-2">
              <button type="button" onClick={() => setAgentIds([])} className="px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200">All</button>
              <button type="button" onClick={() => setAgentIds(allAgents)} className="px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200">Select every agent</button>
            </div>
            <div className="max-h-48 overflow-y-auto grid grid-cols-2 gap-x-2 gap-y-0.5">
              {allAgents.map((id) => (
                <label key={id} className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={agentIds.includes(id)} onChange={() => toggleAgent(id)} />
                  <span>Agent-{id + 1}</span>
                </label>
              ))}
            </div>
          </div>
        </details>
      </div>
      <div className="flex items-center justify-between text-[11px] text-slate-500 -mt-2">
        <span>
          {a.rows.length} agents, {a.dates.length} active date{a.dates.length === 1 ? '' : 's'}
          {a.dates.length > 0 ? ` (${a.dates[0]} to ${a.dates[a.dates.length - 1]})` : ''}. Range includes post-horizon drain days.
        </span>
        {filtersActive && (
          <button type="button" onClick={() => { setFromDate(''); setToDate(''); setCategory('ALL'); setAgentIds([]); }}
            className="flex items-center gap-1 px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 font-semibold text-slate-700">
            <RotateCcw className="w-3 h-3" /> Reset filters
          </button>
        )}
      </div>

      {/* Insights */}
      <div className="bg-blue-50/60 border border-blue-100 rounded-lg p-3 space-y-1.5">
        <div className="flex items-center gap-1.5 text-xs font-bold text-blue-900"><Sparkles className="w-3.5 h-3.5" /> Insights</div>
        <ul className="list-disc list-inside space-y-1 text-xs text-slate-700">
          {insights.map((t, i) => (<li key={i}>{t}</li>))}
        </ul>
      </div>

      {/* Table */}
      <div className="overflow-x-auto border border-slate-200 rounded-lg max-h-96 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-100 text-slate-700 font-semibold sticky top-0">
            <tr>
              <th className="py-2 px-2.5 text-left">Agent</th>
              <th className="py-2 px-2.5 text-left">Category</th>
              <th className="py-2 px-2.5 text-left" title="Most common shift start time across the agent's active days">Shift start</th>
              <th className={th} title="Cases the agent finished (credited once)">Handled</th>
              <th className={th} title="Distinct cases the agent worked on, incl. split cases">Touched</th>
              <th className={th}>Busy (min)</th>
              <th className={th} title="Busy + idle minutes while on shift, in queue">Available (min)</th>
              <th className={th}>Idle (min)</th>
              <th className={th} title="Busy / available">Occupancy %</th>
              <th className={th} title="Busy / scheduled shift time (differs from occupancy only after the daily productive budget is exhausted)">Utilisation %</th>
              <th className={th} title="Busy minutes / cases touched">Avg handle (min)</th>
              <th className={th} title="Handled / days on shift">Cases/day</th>
              <th className={th} title="Busy slices that resumed a parked case">Resumes</th>
              <th className={th} title="Touched cases another agent finished">Handed over</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {a.rows.map((r: AgentAnalyticsRow) => (
              <tr key={r.agentId} className="hover:bg-slate-50">
                <td className="py-1.5 px-2.5 font-semibold text-slate-900 whitespace-nowrap">{r.agentLabel}</td>
                <td className="py-1.5 px-2.5 text-slate-600">{r.category}</td>
                <td className="py-1.5 px-2.5 font-mono text-[11px] whitespace-nowrap">
                  {r.cohortStart}
                  {r.isLateShift && <span className="ml-1.5 text-[10px] font-sans font-bold text-amber-800 bg-amber-100 px-1.5 py-0.5 rounded">late</span>}
                </td>
                <td className={`${td} font-semibold text-slate-900`}>{r.casesCompleted}</td>
                <td className={td}>{r.casesTouched}</td>
                <td className={td}>{r1(r.busyMin)}</td>
                <td className={td}>{r1(r.availableMin)}</td>
                <td className={td}>{r1(r.idleMin)}</td>
                <td className={td}>{r1(r.occupancyPct)}%</td>
                <td className={td}>{r1(r.utilisationPct)}%</td>
                <td className={td}>{num(r.avgHandleMin)}</td>
                <td className={td}>{num(r.casesPerDay)}</td>
                <td className={td}>{r.resumes}</td>
                <td className={td}>{r.casesHandedOver}</td>
              </tr>
            ))}
            {a.rows.length === 0 && (
              <tr><td colSpan={14} className="py-6 text-center text-slate-400">No agents match the active filters.</td></tr>
            )}
          </tbody>
          {a.rows.length > 0 && (
            <tfoot className="bg-slate-50 font-semibold text-slate-800 border-t border-slate-200">
              <tr>
                <td className="py-1.5 px-2.5" colSpan={3}>Team ({a.team.agents})</td>
                <td className={td}>{a.team.casesTotal}</td>
                <td className={td}>-</td>
                <td className={td}>{r1(a.team.busyMin)}</td>
                <td className={td}>{r1(a.team.availableMin)}</td>
                <td className={td}>{r1(a.team.availableMin - a.team.busyMin)}</td>
                <td className={td}>{r1(a.team.occupancyPct)}%</td>
                <td className={td}>{r1(a.team.utilisationPct)}%</td>
                <td className={td} colSpan={4}>avg {r1(a.team.casesMean)} cases / agent</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <ChartFrame title="Cases handled per agent" desc="Sorted high to low; dashed line = team average.">
          <div className="max-h-[36rem] overflow-auto"><CasesBarChart a={a} /></div>
        </ChartFrame>
        <ChartFrame title="Occupancy and utilisation per agent" desc="Blue = occupancy, amber = utilisation. Labels show occupancy / utilisation.">
          <div className="max-h-[36rem] overflow-auto"><OccUtilChart a={a} /></div>
        </ChartFrame>
        <ChartFrame title="Cases per agent per date" desc="Cases completed. Darker = more; light grey = not on shift that day.">
          <div className="max-h-[36rem] overflow-auto"><Heatmap a={a} /></div>
        </ChartFrame>
        <ChartFrame title="Daily team trend" desc="Average cases per on-shift agent per date, with the min-max band across agents.">
          <div className="overflow-x-auto"><TrendChart a={a} /></div>
        </ChartFrame>
      </div>
    </div>
  );
}
