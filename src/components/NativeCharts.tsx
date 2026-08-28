/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { DESResult, HCSearchOutput, SLAPolicyConfig } from '../types/wfm';
import { formatDateTime24 } from '../utils/calendar';

interface StaffingPathChartProps {
  searchHistory: HCSearchOutput['searchHistory'];
  recommendedHC: number | null;
  sla: SLAPolicyConfig;
}

export function StaffingPathChart({ searchHistory, recommendedHC, sla }: StaffingPathChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (!searchHistory || searchHistory.length === 0) {
    return <div className="p-8 text-center text-slate-400 text-xs italic">No HC search data to display.</div>;
  }

  // Chart dimensions
  const width = 640;
  const height = 300;
  const padLeft = 45;
  const padRight = 50;
  const padTop = 25;
  const padBottom = 40;

  const innerWidth = width - padLeft - padRight;
  const innerHeight = height - padTop - padBottom;

  const minHC = searchHistory[0].hc;
  const maxHC = searchHistory[searchHistory.length - 1].hc;
  const hcRange = Math.max(1, maxHC - minHC);

  // Max ASA for right axis scale
  const maxAsa = Math.max(
    sla.boAsaTarget * 1.5,
    ...searchHistory.map((h) => h.boAsaMinutes || 0)
  );

  function getX(hc: number) {
    if (searchHistory.length === 1) return padLeft + innerWidth / 2;
    return padLeft + ((hc - minHC) / hcRange) * innerWidth;
  }

  function getYPercent(pct: number) {
    return padTop + innerHeight - (Math.min(100, Math.max(0, pct)) / 100) * innerHeight;
  }

  function getYAsa(minutes: number) {
    return padTop + innerHeight - (Math.min(maxAsa, Math.max(0, minutes)) / maxAsa) * innerHeight;
  }

  // Generate SVG path points
  const primaryPoints = searchHistory.map((h) => `${getX(h.hc)},${getYPercent(h.primaryPct)}`).join(' ');
  const occPoints = searchHistory.map((h) => `${getX(h.hc)},${getYPercent(h.occupancyPct)}`).join(' ');
  const asaPoints = searchHistory.map((h) => `${getX(h.hc)},${getYAsa(h.boAsaMinutes)}`).join(' ');

  const hoveredItem = hoverIndex !== null ? searchHistory[hoverIndex] : null;

  return (
    <div className="w-full bg-white rounded-xl border border-slate-200 p-4 shadow-xs relative">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3 border-b border-slate-100 pb-2.5">
        <div>
          <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">HC Staffing Search Curve</h4>
          <p className="text-[11px] text-slate-500">
            Evaluating Primary SLA, BO ASA, and Occupancy vs Operational HC
          </p>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-3 text-[11px]">
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-blue-600 rounded"></span>
            <span className="text-slate-600 font-medium">Primary SLA %</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-amber-500 rounded"></span>
            <span className="text-slate-600 font-medium">Occupancy %</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-purple-600 rounded"></span>
            <span className="text-slate-600 font-medium">BO ASA (min)</span>
          </div>
        </div>
      </div>

      <div className="w-full overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto max-h-[300px] select-none font-sans">
          {/* Grid lines */}
          {[0, 25, 50, 75, 100].map((p) => {
            const y = getYPercent(p);
            return (
              <g key={p}>
                <line x1={padLeft} y1={y} x2={width - padRight} y2={y} stroke="#f1f5f9" strokeWidth="1" />
                <text x={padLeft - 6} y={y + 3} fill="#94a3b8" fontSize="9" textAnchor="end">
                  {p}%
                </text>
                <text x={width - padRight + 6} y={y + 3} fill="#a855f7" fontSize="8" textAnchor="start">
                  {Math.round((p / 100) * maxAsa)}m
                </text>
              </g>
            );
          })}

          {/* Primary SLA target line */}
          <line
            x1={padLeft}
            y1={getYPercent(sla.primaryPct)}
            x2={width - padRight}
            y2={getYPercent(sla.primaryPct)}
            stroke="#3b82f6"
            strokeWidth="1"
            strokeDasharray="4 3"
          />

          {/* Lines */}
          <polyline fill="none" stroke="#3b82f6" strokeWidth="2.5" strokeLinecap="round" points={primaryPoints} />
          <polyline fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" points={occPoints} />
          <polyline fill="none" stroke="#a855f7" strokeWidth="2" strokeLinecap="round" strokeDasharray="5 2" points={asaPoints} />

          {/* Data Points */}
          {searchHistory.map((h, i) => {
            const cx = getX(h.hc);
            const cyPrimary = getYPercent(h.primaryPct);
            const isRec = h.hc === recommendedHC;

            return (
              <g key={h.hc} onMouseEnter={() => setHoverIndex(i)} onMouseLeave={() => setHoverIndex(null)} className="cursor-pointer">
                {/* Vertical hover guide */}
                {hoverIndex === i && (
                  <line x1={cx} y1={padTop} x2={cx} y2={padTop + innerHeight} stroke="#cbd5e1" strokeWidth="1" strokeDasharray="3 3" />
                )}

                {/* X-axis tick */}
                <text x={cx} y={height - 12} fill={isRec ? '#0f172a' : '#64748b'} fontSize="10" fontWeight={isRec ? 'bold' : 'normal'} textAnchor="middle">
                  {h.hc} HC
                </text>

                {/* Recommended Badge Ring */}
                {isRec && (
                  <circle cx={cx} cy={cyPrimary} r="9" fill="none" stroke="#10b981" strokeWidth="2" className="animate-pulse" />
                )}

                {/* Circle marker */}
                <circle
                  cx={cx}
                  cy={cyPrimary}
                  r={isRec ? 5 : 4}
                  fill={h.passed ? '#10b981' : '#ef4444'}
                  stroke="#ffffff"
                  strokeWidth="1.5"
                />
              </g>
            );
          })}

          {/* Axis Labels */}
          <text x={padLeft - 6} y={padTop - 8} fill="#64748b" fontSize="9" textAnchor="end" fontWeight="600">
            SLA %
          </text>
          <text x={width - padRight + 6} y={padTop - 8} fill="#a855f7" fontSize="9" textAnchor="start" fontWeight="600">
            ASA (m)
          </text>
          <text x={width / 2} y={height - 2} fill="#64748b" fontSize="10" textAnchor="middle" fontWeight="600">
            Operational Headcount (N)
          </text>
        </svg>
      </div>

      {/* Hover Card Overlay */}
      {hoveredItem && (
        <div className="absolute top-4 right-4 bg-slate-900/90 text-white rounded-lg p-2.5 text-xs shadow-lg border border-slate-700 pointer-events-none backdrop-blur-xs">
          <div className="font-bold border-b border-slate-700 pb-1 mb-1.5 flex items-center justify-between gap-3">
            <span>Operational HC: {hoveredItem.hc}</span>
            <span
              className={`px-1.5 py-0.5 text-[10px] rounded font-semibold ${
                hoveredItem.passed ? 'bg-emerald-500/30 text-emerald-300' : 'bg-rose-500/30 text-rose-300'
              }`}
            >
              {hoveredItem.passed ? 'PASS ALL' : 'FAIL'}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
            <div>Primary SLA: <span className="font-mono font-semibold text-blue-300">{hoveredItem.primaryPct}%</span></div>
            <div>BO ASA: <span className="font-mono font-semibold text-purple-300">{hoveredItem.boAsaMinutes} min</span></div>
            <div>
              {hoveredItem.rawOccupancyPct > hoveredItem.occupancyPct + 0.1 ? (
                <>
                  Capacity ratio:{' '}
                  <span className="font-mono font-semibold text-rose-300">
                    {hoveredItem.rawOccupancyPct}%
                  </span>
                  <span className="text-slate-400"> (occupancy displayed {hoveredItem.occupancyPct}%)</span>
                </>
              ) : (
                <>
                  Occupancy:{' '}
                  <span className="font-mono font-semibold text-amber-300">
                    {hoveredItem.rawOccupancyPct}%
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface QueueWipTimelineChartProps {
  timeline: DESResult['intervalsTimeline'];
  horizonStart: Date;
  horizonEnd: Date;
}

export function QueueWipTimelineChart({ timeline }: QueueWipTimelineChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (!timeline || timeline.length === 0) {
    return <div className="p-8 text-center text-slate-400 text-xs italic">No timeline data available.</div>;
  }

  const width = 720;
  const height = 260;
  const padLeft = 40;
  const padRight = 20;
  const padTop = 20;
  const padBottom = 35;

  const innerWidth = width - padLeft - padRight;
  const innerHeight = height - padTop - padBottom;

  const maxQueue = Math.max(
    5,
    ...timeline.map((t) => t.queuedWIP + t.activeHandling + t.parkedWIP)
  );

  function getX(idx: number) {
    return padLeft + (idx / Math.max(1, timeline.length - 1)) * innerWidth;
  }

  function getY(val: number) {
    return padTop + innerHeight - (Math.max(0, val) / maxQueue) * innerHeight;
  }

  // Build SVG Area points for stacked backlog (Queued + Parked)
  const queueLine = timeline.map((t, i) => `${getX(i)},${getY(t.queuedWIP)}`).join(' ');
  const activeLine = timeline.map((t, i) => `${getX(i)},${getY(t.activeHandling)}`).join(' ');
  const parkedLine = timeline.map((t, i) => `${getX(i)},${getY(t.parkedWIP)}`).join(' ');

  const hoveredSlot = hoverIndex !== null ? timeline[hoverIndex] : null;

  return (
    <div className="w-full bg-white rounded-xl border border-slate-200 p-4 shadow-xs relative">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3 border-b border-slate-100 pb-2.5">
        <div>
          <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Queue & Work-In-Progress (WIP) Timeline</h4>
          <p className="text-[11px] text-slate-500">
            Interval-by-interval active handling, queued backlog, and parked cases
          </p>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-3 text-[11px]">
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-blue-600 rounded"></span>
            <span className="text-slate-600 font-medium">Queued Cases</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-emerald-600 rounded"></span>
            <span className="text-slate-600 font-medium">Active Handling</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-amber-600 rounded"></span>
            <span className="text-slate-600 font-medium">Parked WIP</span>
          </div>
        </div>
      </div>

      <div className="w-full overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto max-h-[260px] select-none font-sans">
          {/* Y Grid */}
          {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
            const val = Math.round(frac * maxQueue);
            const y = getY(val);
            return (
              <g key={frac}>
                <line x1={padLeft} y1={y} x2={width - padRight} y2={y} stroke="#f1f5f9" strokeWidth="1" />
                <text x={padLeft - 6} y={y + 3} fill="#94a3b8" fontSize="9" textAnchor="end">
                  {val}
                </text>
              </g>
            );
          })}

          {/* Polylines */}
          <polyline fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" points={queueLine} />
          <polyline fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" points={activeLine} />
          <polyline fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" points={parkedLine} />

          {/* X ticks for key dates */}
          {timeline.map((t, idx) => {
            if (idx % Math.max(1, Math.floor(timeline.length / 7)) === 0 || idx === timeline.length - 1) {
              const x = getX(idx);
              const label = t.time.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' });
              return (
                <g key={idx}>
                  <line x1={x} y1={padTop + innerHeight} x2={x} y2={padTop + innerHeight + 4} stroke="#94a3b8" />
                  <text x={x} y={height - 8} fill="#64748b" fontSize="8" textAnchor="middle">
                    {label}
                  </text>
                </g>
              );
            }
            return null;
          })}

          {/* Transparent hit boxes for hover */}
          {timeline.map((t, idx) => {
            const x = getX(idx);
            const slotW = innerWidth / timeline.length;
            return (
              <rect
                key={idx}
                x={x - slotW / 2}
                y={padTop}
                width={slotW}
                height={innerHeight}
                fill="transparent"
                onMouseEnter={() => setHoverIndex(idx)}
                onMouseLeave={() => setHoverIndex(null)}
                className="cursor-pointer"
              />
            );
          })}

          {/* Hover guide */}
          {hoverIndex !== null && (
            <line
              x1={getX(hoverIndex)}
              y1={padTop}
              x2={getX(hoverIndex)}
              y2={padTop + innerHeight}
              stroke="#64748b"
              strokeWidth="1.5"
              strokeDasharray="2 2"
            />
          )}
        </svg>
      </div>

      {hoveredSlot && (
        <div className="absolute top-4 right-4 bg-slate-900/90 text-white rounded-lg p-2.5 text-xs shadow-lg border border-slate-700 pointer-events-none backdrop-blur-xs">
          <div className="font-bold border-b border-slate-700 pb-1 mb-1.5 font-mono">
            {formatDateTime24(hoveredSlot.time)}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
            <div>Queued WIP: <span className="font-mono font-semibold text-blue-300">{hoveredSlot.queuedWIP}</span></div>
            <div>Active Handling: <span className="font-mono font-semibold text-emerald-300">{hoveredSlot.activeHandling}</span></div>
            <div>Parked WIP: <span className="font-mono font-semibold text-amber-300">{hoveredSlot.parkedWIP}</span></div>
            <div>Cum. Completed: <span className="font-mono font-semibold text-slate-200">{hoveredSlot.completedCum}</span></div>
          </div>
        </div>
      )}
    </div>
  );
}
