/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { CalendarConfig, ClockBasis, TimeUnit } from '../types/wfm';

export function convertSlaDurationToMinutes(
  value: number,
  unit: TimeUnit,
  clockBasis?: ClockBasis,
  calendar?: CalendarConfig
): number {
  switch (unit) {
    case 'minutes':
      return value;
    case 'hours':
      return value * 60;
    case 'days': {
      if (clockBasis === 'business_time' && calendar) {
        const dailyWindowHours = getDailyWindowLengthHours(calendar);
        return value * dailyWindowHours * 60;
      }
      return value * 24 * 60; // Wall-clock days
    }
  }
}

export function convertDurationToMinutes(
  value: number,
  unit: TimeUnit,
  clockBasis?: ClockBasis,
  calendar?: CalendarConfig
): number {
  return convertSlaDurationToMinutes(value, unit, clockBasis, calendar);
}

export function formatDuration(minutes: number, targetUnit: TimeUnit = 'hours'): string {
  if (minutes < 0) return '0 min';
  switch (targetUnit) {
    case 'minutes':
      return `${Math.round(minutes * 10) / 10} min`;
    case 'hours':
      return `${(minutes / 60).toFixed(2)} hrs`;
    case 'days':
      return `${(minutes / (24 * 60)).toFixed(2)} days`;
  }
}

export function isHoliday(date: Date, holidays: string[]): boolean {
  if (!date || isNaN(date.getTime())) return false;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const dateStr = `${y}-${m}-${d}`;
  return holidays.includes(dateStr);
}

export function isWorkingDay(date: Date, calendar: CalendarConfig): boolean {
  if (!date || isNaN(date.getTime())) return false;
  if (calendar.is24x7) return true;
  const dayOfWeek = date.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  if (!calendar.workingDays.includes(dayOfWeek)) return false;
  if (isHoliday(date, calendar.holidays)) return false;
  return true;
}

export function getDailyOpenClose(date: Date, calendar: CalendarConfig): { openTime: Date; closeTime: Date } {
  if (!date || isNaN(date.getTime())) {
    return { openTime: new Date(NaN), closeTime: new Date(NaN) };
  }
  const openTime = new Date(date);
  const closeTime = new Date(date);

  if (calendar.is24x7) {
    openTime.setHours(0, 0, 0, 0);
    closeTime.setDate(closeTime.getDate() + 1);
    closeTime.setHours(0, 0, 0, 0);
    return { openTime, closeTime };
  }

  const openH = calendar.dailyOpenHour ?? 8;
  const openM = calendar.dailyOpenMinute ?? 0;
  let closeH = calendar.dailyCloseHour ?? 18;
  let closeM = calendar.dailyCloseMinute ?? 0;

  // If close is set to 00:00 or 24:00 when open is >= 0, it means close at end-of-day midnight (24:00)
  if ((closeH === 0 && closeM === 0 && (openH > 0 || openM > 0)) || closeH >= 24) {
    closeH = 24;
    closeM = 0;
  }

  openTime.setHours(openH, openM, 0, 0);
  closeTime.setHours(closeH, closeM, 0, 0);

  return { openTime, closeTime };
}

export function isWorking(date: Date, calendar: CalendarConfig): boolean {
  if (!date || isNaN(date.getTime())) return false;
  if (calendar.is24x7) return true;
  if (!isWorkingDay(date, calendar)) return false;
  const { openTime, closeTime } = getDailyOpenClose(date, calendar);
  const t = date.getTime();
  return t >= openTime.getTime() && t < closeTime.getTime();
}

/**
 * Returns the next timestamp when the business window is open.
 * If the given date is already during open working hours, returns date (or copy).
 */
export function nextOpen(date: Date, calendar: CalendarConfig): Date {
  if (!date || isNaN(date.getTime())) return new Date();
  if (calendar.is24x7) return new Date(date);
  let curr = new Date(date);
  // Loop up to 5 years ahead to find next open window across long closures
  const maxDays = 366 * 5;
  for (let i = 0; i < maxDays; i++) {
    if (isWorkingDay(curr, calendar)) {
      const { openTime, closeTime } = getDailyOpenClose(curr, calendar);
      if (curr.getTime() < openTime.getTime()) {
        return new Date(openTime);
      }
      if (curr.getTime() < closeTime.getTime()) {
        return new Date(curr);
      }
    }
    // Advance to midnight of next day
    curr.setDate(curr.getDate() + 1);
    curr.setHours(0, 0, 0, 0);
  }
  throw new Error(`No open working window found in calendar configuration within ${maxDays} days`);
}

/**
 * Calculates working time (in minutes) between start and end timestamps.
 */
export function workingDuration(startDate: Date, endDate: Date, calendar: CalendarConfig): number {
  if (!startDate || !endDate || isNaN(startDate.getTime()) || isNaN(endDate.getTime())) return 0;
  if (startDate.getTime() >= endDate.getTime()) return 0;

  if (calendar.is24x7) {
    return (endDate.getTime() - startDate.getTime()) / (60 * 1000);
  }

  // Fast path for same-day evaluation
  if (
    startDate.getFullYear() === endDate.getFullYear() &&
    startDate.getMonth() === endDate.getMonth() &&
    startDate.getDate() === endDate.getDate()
  ) {
    if (!isWorkingDay(startDate, calendar)) return 0;
    const { openTime, closeTime } = getDailyOpenClose(startDate, calendar);
    const windowStart = Math.max(startDate.getTime(), openTime.getTime());
    const windowEnd = Math.min(endDate.getTime(), closeTime.getTime());
    return windowEnd > windowStart ? (windowEnd - windowStart) / (60 * 1000) : 0;
  }

  let totalWorkingMinutes = 0;
  let curr = new Date(startDate);
  const end = new Date(endDate);

  // Iterate day by day
  while (curr.getTime() < end.getTime()) {
    if (isWorkingDay(curr, calendar)) {
      const { openTime, closeTime } = getDailyOpenClose(curr, calendar);
      
      const windowStart = Math.max(curr.getTime(), openTime.getTime());
      const windowEnd = Math.min(end.getTime(), closeTime.getTime());

      if (windowEnd > windowStart) {
        totalWorkingMinutes += (windowEnd - windowStart) / (60 * 1000);
      }
    }

    // Advance curr to next day's 00:00:00
    curr.setDate(curr.getDate() + 1);
    curr.setHours(0, 0, 0, 0);
  }

  return totalWorkingMinutes;
}

/**
 * Adds working duration (in minutes) to a start timestamp, jumping across non-working hours, weekends, and holidays.
 */
export function addWorkingTime(startDate: Date, durationMinutes: number, calendar: CalendarConfig): Date {
  if (!startDate || isNaN(startDate.getTime())) return new Date();
  if (durationMinutes <= 0) return new Date(startDate);

  if (calendar.is24x7) {
    return new Date(startDate.getTime() + durationMinutes * 60 * 1000);
  }

  let remainingMin = durationMinutes;
  let curr: Date;
  try {
    curr = nextOpen(startDate, calendar);
  } catch {
    return new Date(startDate);
  }

  const maxIterations = 366 * 5;
  let iterations = 0;

  while (remainingMin > 0 && iterations++ < maxIterations) {
    const { closeTime } = getDailyOpenClose(curr, calendar);
    const availableMinutesInDay = Math.max(0, (closeTime.getTime() - curr.getTime()) / (60 * 1000));

    if (availableMinutesInDay <= 0) {
      const nextDay = new Date(curr);
      nextDay.setDate(nextDay.getDate() + 1);
      nextDay.setHours(0, 0, 0, 0);
      try {
        curr = nextOpen(nextDay, calendar);
      } catch {
        break;
      }
      continue;
    }

    if (remainingMin <= availableMinutesInDay) {
      return new Date(curr.getTime() + remainingMin * 60 * 1000);
    } else {
      remainingMin -= availableMinutesInDay;
      // Advance to next open window
      const nextDay = new Date(curr);
      nextDay.setDate(nextDay.getDate() + 1);
      nextDay.setHours(0, 0, 0, 0);
      try {
        curr = nextOpen(nextDay, calendar);
      } catch {
        break;
      }
    }
  }

  if (remainingMin > 0) {
    throw new Error('Unable to complete addWorkingTime within calendar working horizon');
  }

  return curr;
}

/**
 * Subtracts working duration (in minutes) from an end timestamp, moving backwards across non-working periods.
 * Used to calculate LatestSafeStart = subtractWorkingTime(Deadline, AHT).
 */
export function subtractWorkingTime(endDate: Date, durationMinutes: number, calendar: CalendarConfig): Date {
  if (!endDate || isNaN(endDate.getTime())) return new Date();
  if (durationMinutes <= 0) return new Date(endDate);

  if (calendar.is24x7) {
    return new Date(endDate.getTime() - durationMinutes * 60 * 1000);
  }

  let remainingMin = durationMinutes;
  let curr = new Date(endDate);

  const maxDays = Math.max(366 * 5, Math.ceil(durationMinutes / 60) * 10);
  let daysEvaluated = 0;

  while (remainingMin > 0 && daysEvaluated++ < maxDays) {
    if (isWorkingDay(curr, calendar)) {
      const { openTime, closeTime } = getDailyOpenClose(curr, calendar);

      let effectiveEnd = curr.getTime();
      if (effectiveEnd > closeTime.getTime()) {
        effectiveEnd = closeTime.getTime();
      }

      if (effectiveEnd > openTime.getTime()) {
        const availableInDay = (effectiveEnd - openTime.getTime()) / (60 * 1000);
        if (remainingMin <= availableInDay) {
          return new Date(effectiveEnd - remainingMin * 60 * 1000);
        } else {
          remainingMin -= availableInDay;
        }
      }
    }

    // Go to previous working day
    // Move to the previous calendar date and find its close time
    let prevWorkDay = new Date(curr);
    prevWorkDay.setDate(prevWorkDay.getDate() - 1);

    // Skip non-working days
    let skipped = 0;
    while (skipped < maxDays && !isWorkingDay(prevWorkDay, calendar)) {
      prevWorkDay.setDate(prevWorkDay.getDate() - 1);
      skipped++;
    }

    if (skipped >= maxDays) {
      // No working days found going back; fail
      return new Date(NaN);
    }

    // Get this working day's close time, being explicit about the target date
    const { closeTime: probe } = getDailyOpenClose(prevWorkDay, calendar);
    // If close time is at or after the next calendar day's midnight, rewind it by one day
    // (this handles the case where close hour normalizes to 24)
    const nextDayMidnight = new Date(prevWorkDay);
    nextDayMidnight.setDate(nextDayMidnight.getDate() + 1);
    nextDayMidnight.setHours(0, 0, 0, 0);
    if (probe.getTime() >= nextDayMidnight.getTime()) {
      curr = new Date(nextDayMidnight.getTime() - 1000); // Just before midnight of next day
    } else {
      curr = new Date(probe);
    }
  }

  if (remainingMin > 0) {
    return new Date(NaN);
  }

  return curr;
}

/**
 * Counts the calendar working days inside a given horizon.
 */
export function getCalendarWorkingDaysInHorizon(
  horizonStart: Date,
  horizonEnd: Date,
  calendar: CalendarConfig
): number {
  if (!horizonStart || !horizonEnd || isNaN(horizonStart.getTime()) || isNaN(horizonEnd.getTime())) {
    return 0;
  }
  if (horizonStart.getTime() >= horizonEnd.getTime()) {
    return 0;
  }
  let count = 0;
  const curr = new Date(horizonStart);
  curr.setHours(0, 0, 0, 0);

  const end = new Date(horizonEnd);

  // The horizon is half-open: [horizonStart, horizonEnd). `curr` sits at each day's
  // midnight, so a day contributes capacity only if its start falls strictly before
  // horizonEnd. Using `<=` here would count a trailing day that carries zero elapsed
  // time — which happens whenever demand covers whole days, because the final 23:30
  // interval ends at 00:00 of the next day (and always for 24x7 calendars, where every
  // day is a working day).
  //
  // Accepted approximation: a *partial* final day (e.g. horizonEnd = Fri 12:00) still
  // counts as a whole working day. Capacity is counted in whole days by design.
  while (curr.getTime() < end.getTime()) {
    if (isWorkingDay(curr, calendar)) {
      count++;
    }
    curr.setDate(curr.getDate() + 1);
  }

  return count;
}

export function getDailyWindowLengthHours(calendar: CalendarConfig): number {
  if (calendar.is24x7) return 24;
  const openH = calendar.dailyOpenHour ?? 8;
  const openM = calendar.dailyOpenMinute ?? 0;
  let closeH = calendar.dailyCloseHour ?? 18;
  let closeM = calendar.dailyCloseMinute ?? 0;

  if ((closeH === 0 && closeM === 0 && (openH > 0 || openM > 0)) || closeH >= 24) {
    closeH = 24;
    closeM = 0;
  }

  const openMin = openH * 60 + openM;
  const closeMin = closeH * 60 + closeM;
  return Math.max(0, (closeMin - openMin) / 60);
}

/**
 * Precomputes cumulative working minutes across a horizon for ultra-fast O(1) critical window queries.
 */
export function createCumulativeWorkingCalendar(
  horizonStart: Date,
  horizonEnd: Date,
  calendar: CalendarConfig
): {
  getOpenMinutes: (startDate: Date, endDate: Date) => number;
  getCumulativeMinutes: (date: Date) => number;
} {
  if (calendar.is24x7) {
    return {
      getOpenMinutes: (s: Date, e: Date) => Math.max(0, (e.getTime() - s.getTime()) / 60000),
      getCumulativeMinutes: (d: Date) => Math.max(0, (d.getTime() - horizonStart.getTime()) / 60000),
    };
  }

  // Precompute day-level cumulative minutes
  const startDay = new Date(horizonStart);
  startDay.setHours(0, 0, 0, 0);
  const endDay = new Date(horizonEnd);
  const horizonSpanDays = Math.max(30, Math.ceil((endDay.getTime() - startDay.getTime()) / (24 * 3600 * 1000)));
  endDay.setDate(endDay.getDate() + Math.max(90, horizonSpanDays + 30));
  endDay.setHours(0, 0, 0, 0);

  const startDayMs = startDay.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const totalDays = Math.max(1, Math.ceil((endDay.getTime() - startDayMs) / dayMs) + 1);

  const cumMinsAtDayStart = new Float64Array(totalDays + 1);
  let runningCum = 0;

  for (let i = 0; i < totalDays; i++) {
    cumMinsAtDayStart[i] = runningCum;
    const curDate = new Date(startDayMs + i * dayMs);
    if (isWorkingDay(curDate, calendar)) {
      const { openTime, closeTime } = getDailyOpenClose(curDate, calendar);
      const dayMins = Math.max(0, (closeTime.getTime() - openTime.getTime()) / 60000);
      runningCum += dayMins;
    }
  }
  cumMinsAtDayStart[totalDays] = runningCum;

  function getCumMinutes(date: Date): number {
    const t = date.getTime();
    if (t <= startDayMs) return 0;
    const dayIndex = Math.floor((t - startDayMs) / dayMs);
    if (dayIndex >= totalDays) return cumMinsAtDayStart[totalDays];

    const baseCum = cumMinsAtDayStart[dayIndex];
    const curDate = new Date(startDayMs + dayIndex * dayMs);
    if (!isWorkingDay(curDate, calendar)) return baseCum;

    const { openTime, closeTime } = getDailyOpenClose(curDate, calendar);
    const oMs = openTime.getTime();
    const cMs = closeTime.getTime();

    if (t <= oMs) return baseCum;
    if (t >= cMs) return baseCum + (cMs - oMs) / 60000;
    return baseCum + (t - oMs) / 60000;
  }

  function getOpenMinutes(startDate: Date, endDate: Date): number {
    if (startDate.getTime() >= endDate.getTime()) return 0;
    return Math.max(0, getCumMinutes(endDate) - getCumMinutes(startDate));
  }

  return {
    getOpenMinutes,
    getCumulativeMinutes: getCumMinutes,
  };
}

/**
 * Enumerates valid shift "slap" start offsets (minutes from that day's business open),
 * aligned to the `slapMinutes` grid, such that a shift beginning at that offset and running
 * `shiftLengthMinutes` fits entirely inside the business window with no truncation:
 *   startOffset + shiftLengthMinutes &lt;= windowLengthMinutes
 *
 * For 24x7 calendars the "window" is the fixed 1440-minute day (getDailyWindowLengthHours
 * already returns 24 there) — this now enumerates a REAL grid of starts instead of the
 * degenerate `[0]` it used to return. Fixed 2026-08-28: `[0]` made 24x7 staggering
 * impossible, which combined with the (also fixed) default-on coverage floor to create a
 * regression — the floor was enforced for 24x7 with no lever to satisfy it beyond adding
 * heads. Non-wrapping starts fully tile a 24h day for any shift length dividing it evenly
 * (e.g. three 8h starts at 0/480/960) and cover it with overlap otherwise (three 9h starts
 * at 0/540/900) — wrapping shifts (crossing midnight) are a rostering nicety, not a coverage
 * requirement, and remain unsupported.
 *
 * Returns [] when the window is strictly shorter than one shift (no valid start exists at
 * all). `dailyOpenHour`/`dailyCloseHour` are calendar-wide (not per-weekday), so any working
 * date yields the same window length — the probe date below is never part of the output,
 * only used to extract the H:M window shape.
 */
export function getValidSlapStarts(
  calendar: CalendarConfig,
  shiftLengthMinutes: number,
  slapMinutes: number
): number[] {
  const grid = Math.max(5, Math.round(slapMinutes));
  const windowLenMin = getDailyWindowLengthHours(calendar) * 60;
  const starts: number[] = [];
  for (let t = 0; t + shiftLengthMinutes <= windowLenMin + 1e-9; t += grid) {
    starts.push(Math.round(t));
  }
  return starts;
}

/**
 * Computes min(start) and max(end) horizon across valid intervals and opening WIP.
 */
export function computeIntervalHorizon(
  intervals: Array<{ start: Date; end: Date }>,
  openingWIP: Array<{ arrival?: Date }> = []
): { horizonStart: Date; horizonEnd: Date } {
  const validIntervals = intervals.filter(
    (it) => it.start && !isNaN(it.start.getTime()) && it.end && !isNaN(it.end.getTime())
  );

  let minStartMs = Infinity;
  let maxEndMs = -Infinity;

  for (const it of validIntervals) {
    if (it.start.getTime() < minStartMs) minStartMs = it.start.getTime();
    if (it.end.getTime() > maxEndMs) maxEndMs = it.end.getTime();
  }

  let horizonStart = isFinite(minStartMs) ? new Date(minStartMs) : new Date();
  let horizonEnd = isFinite(maxEndMs) ? new Date(maxEndMs) : new Date(horizonStart.getTime() + 7 * 86400000);

  if (openingWIP && openingWIP.length > 0) {
    for (const w of openingWIP) {
      if (w.arrival && !isNaN(w.arrival.getTime()) && w.arrival.getTime() < horizonStart.getTime()) {
        horizonStart = new Date(w.arrival);
      }
    }
  }

  return { horizonStart, horizonEnd };
}

/**
 * Format a Date to 24-hour time "HH:mm".
 */
export function formatTime24(date: Date | null | undefined, fallback: string = '-'): string {
  if (!date || isNaN(date.getTime())) return fallback;
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Format a Date to 24-hour date and time "YYYY-MM-DD HH:mm".
 */
export function formatDateTime24(date: Date | null | undefined, fallback: string = '-'): string {
  if (!date || isNaN(date.getTime())) return fallback;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/**
 * Format a Date to 24-hour date and time with seconds "YYYY-MM-DD HH:mm:ss".
 */
export function formatDateTimeSec24(date: Date | null | undefined, fallback: string = '-'): string {
  if (!date || isNaN(date.getTime())) return fallback;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Format a Date to "YYYY-MM-DD".
 */
export function formatDate24(date: Date | null | undefined, fallback: string = '-'): string {
  if (!date || isNaN(date.getTime())) return fallback;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
