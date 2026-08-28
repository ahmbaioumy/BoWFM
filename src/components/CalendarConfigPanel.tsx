/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { CalendarConfig, LaborConfig } from '../types/wfm';
import { Calendar as CalendarIcon, CheckCircle2 } from 'lucide-react';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface CalendarConfigPanelProps {
  calendar: CalendarConfig;
  onUpdateCalendar: (cal: CalendarConfig) => void;
  labor?: LaborConfig;
  onUpdateLabor?: (labor: LaborConfig) => void;
  /** When provided, owns the full toggle transition (including restoring the working/off
   * days that stood before 24/7 was ticked on). Falls back to the old inline behavior —
   * which does not restore prior values on untick — only when the caller omits it. */
  onToggle24x7?: (isChecked: boolean) => void;
}

export function CalendarConfigPanel({
  calendar,
  onUpdateCalendar,
  labor,
  onUpdateLabor,
  onToggle24x7,
}: CalendarConfigPanelProps) {
  const [newHoliday, setNewHoliday] = useState('');
  // Display-only: rotates weekday chip order. Does not affect stored workingDays or engine.
  const [weekStartsOn, setWeekStartsOn] = useState(1); // 0=Sun … 6=Sat (default: Mon)
  const displayOrder = [0, 1, 2, 3, 4, 5, 6].map((i) => (weekStartsOn + i) % 7);

  function toggleWorkingDay(dayIdx: number) {
    const exists = calendar.workingDays.includes(dayIdx);
    const updated = exists
      ? calendar.workingDays.filter((d) => d !== dayIdx)
      : [...calendar.workingDays, dayIdx].sort((a, b) => a - b);

    onUpdateCalendar({
      ...calendar,
      workingDays: updated,
    });
  }

  function handleAddHoliday() {
    if (!newHoliday || calendar.holidays.includes(newHoliday)) return;
    onUpdateCalendar({
      ...calendar,
      holidays: [...calendar.holidays, newHoliday].sort(),
    });
    setNewHoliday('');
  }

  function handleRemoveHoliday(h: string) {
    onUpdateCalendar({
      ...calendar,
      holidays: calendar.holidays.filter((item) => item !== h),
    });
  }

  const dailyOpenH = calendar.dailyOpenHour ?? 8;
  const dailyOpenM = calendar.dailyOpenMinute ?? 0;
  let dailyCloseH = calendar.dailyCloseHour ?? 18;
  let dailyCloseM = calendar.dailyCloseMinute ?? 0;

  // Handle midnight / end of day
  const isEndOfDayClose = (dailyCloseH === 0 && dailyCloseM === 0 && (dailyOpenH > 0 || dailyOpenM > 0)) || dailyCloseH >= 24;
  if (isEndOfDayClose) {
    dailyCloseH = 24;
    dailyCloseM = 0;
  }

  const dailyOpenTotalMin = dailyOpenH * 60 + dailyOpenM;
  const dailyCloseTotalMin = dailyCloseH * 60 + dailyCloseM;
  const dailyWindow = calendar.is24x7
    ? 24
    : Math.max(0, (dailyCloseTotalMin - dailyOpenTotalMin) / 60);

  function applyPreset(openH: number, openM: number, closeH: number, closeM: number) {
    onUpdateCalendar({
      ...calendar,
      dailyOpenHour: openH,
      dailyOpenMinute: openM,
      dailyCloseHour: closeH,
      dailyCloseMinute: closeM,
    });
  }

  return (
    <div className="space-y-5">
      <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4 border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2.5">
            <CalendarIcon className="w-5 h-5 text-blue-600 shrink-0" />
            <div>
              <h3 className="text-sm font-bold text-slate-900">Business Calendar & Working Windows</h3>
              <p className="text-xs text-slate-500">
                Define open business hours, working days of week, or enable 24/7 continuous operations.
              </p>
            </div>
          </div>

          {/* 24/7 Continuous Operation Checkbox Toggle */}
          <label className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg border border-blue-200 bg-blue-50/80 cursor-pointer hover:bg-blue-100/70 transition select-none self-start sm:self-auto">
            <input
              id="calendar-24x7-checkbox"
              type="checkbox"
              checked={!!calendar.is24x7}
              onChange={(e) => {
                const isChecked = e.target.checked;
                if (onToggle24x7) {
                  onToggle24x7(isChecked);
                  return;
                }
                // Fallback when the caller doesn't own the transition: same as before,
                // does not restore prior working/off days on untick.
                onUpdateCalendar({
                  ...calendar,
                  is24x7: isChecked,
                  workingDays: isChecked ? [0, 1, 2, 3, 4, 5, 6] : calendar.workingDays,
                });
                if (isChecked && labor && onUpdateLabor) {
                  onUpdateLabor({
                    ...labor,
                    workingDaysPerWeek: 7,
                    offDaysPerWeek: 0,
                  });
                }
              }}
              className="w-4 h-4 text-blue-600 rounded border-slate-300 focus:ring-blue-500 cursor-pointer"
            />
            <div>
              <span className="text-xs font-bold text-blue-900 block leading-tight">24/7 Operations</span>
              <span className="text-[10px] text-blue-700 block leading-tight">Continuous round-the-clock</span>
            </div>
          </label>
        </div>

        {calendar.is24x7 ? (
          <div className="mb-5 p-3.5 bg-blue-50/80 border border-blue-200 rounded-lg flex items-center justify-between text-xs text-blue-900">
            <div className="flex items-center gap-2.5">
              <CheckCircle2 className="w-4 h-4 text-blue-600 shrink-0" />
              <span>
                <strong>24/7 Mode Active:</strong> Operating 24 hours a day, 7 days a week (168 hrs/week) without overnight or weekend pauses.
              </span>
            </div>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-blue-200 text-blue-900 font-mono">
              24 HRS / DAY
            </span>
          </div>
        ) : null}

        {/* Working Days Selector */}
        <div className="space-y-2 mb-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <label className="text-xs font-semibold text-slate-700 block">Working Days of the Week</label>
              {calendar.is24x7 && (
                <span className="text-[10px] text-blue-600 font-semibold">(All 7 days active under 24/7)</span>
              )}
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Week starts</span>
              <div className="flex flex-wrap gap-0.5">
                {DAY_NAMES.map((dayName, idx) => (
                  <button
                    key={`week-start-${dayName}`}
                    type="button"
                    onClick={() => setWeekStartsOn(idx)}
                    title={`Display week starting ${dayName}`}
                    className={`px-1.5 py-0.5 rounded text-[10px] font-semibold transition ${
                      weekStartsOn === idx
                        ? 'bg-slate-700 text-white'
                        : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                    }`}
                  >
                    {dayName}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className={`flex flex-wrap gap-2 ${calendar.is24x7 ? 'opacity-50 pointer-events-none' : ''}`}>
            {displayOrder.map((dayIdx) => {
              const dayName = DAY_NAMES[dayIdx];
              const isSelected = calendar.is24x7 ? true : calendar.workingDays.includes(dayIdx);
              return (
                <button
                  key={dayName}
                  type="button"
                  disabled={!!calendar.is24x7}
                  onClick={() => toggleWorkingDay(dayIdx)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                    isSelected
                      ? 'bg-emerald-600 text-white shadow-xs'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {dayName}
                </button>
              );
            })}
          </div>
        </div>

        {/* Daily Hours Window */}
        <div className={`space-y-4 mb-5 ${calendar.is24x7 ? 'opacity-50 pointer-events-none' : ''}`}>
          {/* Quick Presets */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-700">Quick Operating Window Presets</label>
              <span className="text-[11px] text-slate-500">Click to apply common business schedules</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!!calendar.is24x7}
                onClick={() => applyPreset(8, 0, 17, 0)}
                className="px-2.5 py-1 text-xs rounded border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 transition font-medium"
              >
                08:00 – 17:00 (Standard 8h)
              </button>
              <button
                type="button"
                disabled={!!calendar.is24x7}
                onClick={() => applyPreset(9, 0, 18, 0)}
                className="px-2.5 py-1 text-xs rounded border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 transition font-medium"
              >
                09:00 – 18:00 (Standard 9h)
              </button>
              <button
                type="button"
                disabled={!!calendar.is24x7}
                onClick={() => applyPreset(9, 0, 24, 0)}
                className="px-2.5 py-1 text-xs rounded border border-blue-200 bg-blue-50 hover:bg-blue-100 text-blue-800 transition font-semibold"
              >
                09:00 – 24:00 (9 AM to Midnight / 23:59:59)
              </button>
              <button
                type="button"
                disabled={!!calendar.is24x7}
                onClick={() => applyPreset(0, 0, 24, 0)}
                className="px-2.5 py-1 text-xs rounded border border-purple-200 bg-purple-50 hover:bg-purple-100 text-purple-800 transition font-medium"
              >
                00:00 – 24:00 (Full 24h Day)
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700 block">Daily Open Time (24h format)</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  max="23"
                  disabled={!!calendar.is24x7}
                  value={calendar.is24x7 ? 0 : dailyOpenH}
                  onChange={(e) => {
                    const raw = parseInt(e.target.value, 10);
                    const val = Number.isNaN(raw) ? 0 : Math.min(23, Math.max(0, raw));
                    onUpdateCalendar({
                      ...calendar,
                      dailyOpenHour: val,
                    });
                  }}
                  className="w-20 px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded font-mono"
                />
                <span className="text-xs text-slate-400">:</span>
                <input
                  type="number"
                  min="0"
                  max="59"
                  step="5"
                  disabled={!!calendar.is24x7}
                  value={calendar.is24x7 ? 0 : dailyOpenM}
                  onChange={(e) => {
                    const raw = parseInt(e.target.value, 10);
                    const val = Number.isNaN(raw) ? 0 : Math.min(59, Math.max(0, raw));
                    onUpdateCalendar({
                      ...calendar,
                      dailyOpenMinute: val,
                    });
                  }}
                  className="w-20 px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded font-mono"
                />
                <span className="text-xs text-slate-600 font-mono font-semibold">
                  ({String(calendar.is24x7 ? 0 : dailyOpenH).padStart(2, '0')}:{String(calendar.is24x7 ? 0 : dailyOpenM).padStart(2, '0')})
                </span>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-slate-700 block">Daily Close Time (24h format)</label>
                {!calendar.is24x7 && !isEndOfDayClose && (
                  <button
                    type="button"
                    onClick={() => applyPreset(dailyOpenH, dailyOpenM, 24, 0)}
                    className="text-[11px] text-blue-600 hover:text-blue-800 font-medium underline"
                  >
                    Set to Midnight (24:00)
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  max="24"
                  disabled={!!calendar.is24x7}
                  value={calendar.is24x7 ? 24 : dailyCloseH}
                  onChange={(e) => {
                    const raw = parseInt(e.target.value, 10);
                    const val = Number.isNaN(raw) ? 18 : Math.min(24, Math.max(0, raw));
                    onUpdateCalendar({
                      ...calendar,
                      dailyCloseHour: val,
                      dailyCloseMinute: val === 24 ? 0 : dailyCloseM,
                    });
                  }}
                  className="w-20 px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded font-mono"
                />
                <span className="text-xs text-slate-400">:</span>
                <input
                  type="number"
                  min="0"
                  max="59"
                  step="5"
                  disabled={!!calendar.is24x7 || dailyCloseH === 24}
                  value={calendar.is24x7 || dailyCloseH === 24 ? 0 : dailyCloseM}
                  onChange={(e) => {
                    const raw = parseInt(e.target.value, 10);
                    const val = Number.isNaN(raw) ? 0 : Math.min(59, Math.max(0, raw));
                    onUpdateCalendar({
                      ...calendar,
                      dailyCloseMinute: val,
                    });
                  }}
                  className="w-20 px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded font-mono disabled:opacity-50"
                />
                <span className="text-xs text-slate-600 font-mono font-semibold">
                  ({calendar.is24x7 || dailyCloseH === 24 || (dailyCloseH === 0 && dailyOpenH > 0)
                    ? '24:00 (Midnight / 23:59:59)'
                    : `${String(dailyCloseH).padStart(2, '0')}:${String(dailyCloseM).padStart(2, '0')}`})
                </span>
              </div>
            </div>
          </div>

          {/* Explanation note for midnight / end-of-day */}
          {(dailyCloseH === 24 || (dailyCloseH === 0 && dailyOpenH > 0)) && !calendar.is24x7 && (
            <div className="p-3 bg-blue-50/70 border border-blue-200 rounded-lg text-xs text-blue-900 flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
              <div>
                <strong>Midnight Closing Configured (24:00):</strong> The queue window remains open from{' '}
                <span className="font-mono font-semibold">{String(dailyOpenH).padStart(2, '0')}:{String(dailyOpenM).padStart(2, '0')}</span> through{' '}
                <span className="font-mono font-semibold">23:59:59</span> without prematurely parking evening cases at 23:45.
              </div>
            </div>
          )}
        </div>

        <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 flex items-center justify-between text-xs text-slate-700">
          <span>
            Daily Business Window Length: <strong>{dailyWindow} hours/day</strong>
          </span>
          <span className="text-slate-500 font-mono">
            {calendar.is24x7
              ? '24h 00m'
              : `${String(Math.floor(dailyWindow)).padStart(2, '0')}h ${String(Math.round((dailyWindow % 1) * 60)).padStart(2, '0')}m`}
          </span>
        </div>

        {/* Holidays List */}
        <div className={`pt-4 border-t border-slate-100 space-y-3 ${calendar.is24x7 ? 'opacity-50 pointer-events-none' : ''}`}>
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-slate-700 block">
              Holiday Closures ({calendar.holidays.length})
            </label>
            {calendar.is24x7 && (
              <span className="text-[10px] text-slate-500">(Holiday closures bypassed in 24/7 continuous mode)</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <input
              type="date"
              value={newHoliday}
              onChange={(e) => setNewHoliday(e.target.value)}
              className="px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded"
            />
            <button
              type="button"
              onClick={handleAddHoliday}
              disabled={!newHoliday}
              className="px-3 py-1.5 text-xs font-semibold rounded bg-slate-800 text-white hover:bg-slate-700 disabled:opacity-40"
            >
              Add Holiday
            </button>
          </div>

          {calendar.holidays.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1">
              {calendar.holidays.map((h) => (
                <span
                  key={h}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-rose-50 text-rose-800 text-xs border border-rose-200"
                >
                  <span>{h}</span>
                  <button
                    onClick={() => handleRemoveHoliday(h)}
                    className="text-rose-500 hover:text-rose-700 font-bold"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
