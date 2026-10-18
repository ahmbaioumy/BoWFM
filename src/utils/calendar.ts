/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { CalendarConfig, ClockBasis, LaborConfig, TimeUnit } from '../types/wfm';

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

// Holiday lookup: one Set per holidays array (WeakMap, so it dies with the array). The entry remembers the array
// length and is rebuilt when it changes, so a push/splice/clear on the same array is still seen. Replacing an element
// in place at the same length is NOT detected; callers replace the array (the UI always does: CalendarConfigPanel).
const holidaySets = new WeakMap<string[], { len: number; set: Set<string> }>();

export function isHoliday(date: Date, holidays: string[]): boolean {
  if (!date || isNaN(date.getTime())) return false;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const dateStr = `${y}-${m}-${d}`;
  if (!holidays || typeof holidays !== 'object') return holidays.includes(dateStr); // unchanged failure mode for bad input
  let entry = holidaySets.get(holidays);
  if (entry === undefined || entry.len !== holidays.length) {
    entry = { len: holidays.length, set: new Set(holidays) };
    holidaySets.set(holidays, entry);
  }
  return entry.set.has(dateStr);
}

/**
 * One local calendar day of a calendar, as plain numbers: [startMs, endMs) is the local day (midnight to next
 * midnight, so a DST day is 23h or 25h), `working` is the working-day flag (24x7, weekday and holiday rules), and
 * openMs / closeMs are that day's business window (close may equal endMs for a 24:00 close).
 * Every instant inside [startMs, endMs) has the same window, so one computation serves the whole day.
 */
export interface DayWindow {
  readonly startMs: number;
  readonly endMs: number;
  readonly working: boolean;
  readonly openMs: number;
  readonly closeMs: number;
}

/**
 * Per-run memo of DayWindow values: a small set-associative table keyed by UTC day number. One UTC day can overlap
 * two or three local days (any non-UTC zone, and DST), so each set holds four windows; every candidate is checked by
 * its [startMs, endMs) range, so a hit is always exact. It is bound to one CalendarConfig object and
 * the calendar is treated as FROZEN for the life of the cache: create one per simulation run / case generation and
 * drop it afterwards. A cache is ignored (bypassed) when passed with a different calendar object.
 */
export interface DayWindowCache {
  readonly calendar: CalendarConfig;
  readonly slots: Array<DayWindow | undefined>;
  /** Round-robin replacement counter (mutated). */
  victim: number;
}

const DAY_MS = 86400000;
const WAYS = 4; // power of two
const SETS = 256; // power of two: set = UTC day number & (SETS - 1)

export function createDayWindowCache(calendar: CalendarConfig): DayWindowCache {
  return { calendar, slots: new Array<DayWindow | undefined>(SETS * WAYS), victim: 0 };
}

const NAN_DAY_WINDOW: DayWindow = { startMs: NaN, endMs: NaN, working: false, openMs: NaN, closeMs: NaN };

function computeDayWindow(tMs: number, calendar: CalendarConfig): DayWindow {
  const date = new Date(tMs);
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const nextDayStart = new Date(date);
  nextDayStart.setDate(nextDayStart.getDate() + 1);
  nextDayStart.setHours(0, 0, 0, 0);

  if (calendar.is24x7) {
    return { startMs: dayStart.getTime(), endMs: nextDayStart.getTime(), working: true, openMs: dayStart.getTime(), closeMs: nextDayStart.getTime() };
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

  const openTime = new Date(date);
  const closeTime = new Date(date);
  openTime.setHours(openH, openM, 0, 0);
  closeTime.setHours(closeH, closeM, 0, 0);
  // getDailyOpenClose never read workingDays/holidays, so a calendar object missing them (outside the type) must
  // still yield its open/close here; such a day is simply not a working day.
  const working = Array.isArray(calendar.workingDays) && calendar.workingDays.includes(date.getDay()) && !(calendar.holidays && isHoliday(date, calendar.holidays));
  return { startMs: dayStart.getTime(), endMs: nextDayStart.getTime(), working, openMs: openTime.getTime(), closeMs: closeTime.getTime() };
}

/**
 * The single day-window computation behind getDailyOpenClose, isWorkingDay, isWorking, nextOpen, workingDuration,
 * addWorkingTime and subtractWorkingTime. With a cache it returns the memoised window when `tMs` falls inside it
 * (results are bit-identical to computing it afresh; D92 and scripts/verify-speed-equivalence.mts). The returned
 * object must be treated as read-only. A NaN time returns a non-working NaN window and is never cached.
 */
export function getDayWindow(tMs: number, calendar: CalendarConfig, cache?: DayWindowCache): DayWindow {
  if (tMs !== tMs) return NAN_DAY_WINDOW;
  if (cache === undefined || cache.calendar !== calendar) return computeDayWindow(tMs, calendar);
  const slots = cache.slots;
  const base = (Math.floor(tMs / DAY_MS) & (SETS - 1)) * WAYS;
  for (let i = 0; i < WAYS; i++) {
    const hit = slots[base + i];
    if (hit !== undefined && tMs >= hit.startMs && tMs < hit.endMs) return hit;
  }
  const fresh = computeDayWindow(tMs, calendar);
  slots[base + (cache.victim++ & (WAYS - 1))] = fresh;
  return fresh;
}

export function isWorkingDay(date: Date, calendar: CalendarConfig, cache?: DayWindowCache): boolean {
  if (!date || isNaN(date.getTime())) return false;
  if (calendar.is24x7) return true;
  return getDayWindow(date.getTime(), calendar, cache).working;
}

export function getDailyOpenClose(date: Date, calendar: CalendarConfig, cache?: DayWindowCache): { openTime: Date; closeTime: Date } {
  if (!date || isNaN(date.getTime())) {
    return { openTime: new Date(NaN), closeTime: new Date(NaN) };
  }
  const w = getDayWindow(date.getTime(), calendar, cache);
  return { openTime: new Date(w.openMs), closeTime: new Date(w.closeMs) };
}

export function isWorking(date: Date, calendar: CalendarConfig, cache?: DayWindowCache): boolean {
  if (!date || isNaN(date.getTime())) return false;
  if (calendar.is24x7) return true;
  const w = getDayWindow(date.getTime(), calendar, cache);
  if (!w.working) return false;
  const t = date.getTime();
  return t >= w.openMs && t < w.closeMs;
}

/**
 * Returns the next timestamp when the business window is open.
 * If the given date is already during open working hours, returns date (or copy).
 */
export function nextOpen(date: Date, calendar: CalendarConfig, cache?: DayWindowCache): Date {
  if (!date || isNaN(date.getTime())) return new Date();
  if (calendar.is24x7) return new Date(date);
  let curr = new Date(date);
  // Loop up to 5 years ahead to find next open window across long closures
  const maxDays = 366 * 5;
  for (let i = 0; i < maxDays; i++) {
    if (isWorkingDay(curr, calendar, cache)) {
      const { openTime, closeTime } = getDailyOpenClose(curr, calendar, cache);
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
export function workingDuration(startDate: Date, endDate: Date, calendar: CalendarConfig, cache?: DayWindowCache): number {
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
    if (!isWorkingDay(startDate, calendar, cache)) return 0;
    const { openTime, closeTime } = getDailyOpenClose(startDate, calendar, cache);
    const windowStart = Math.max(startDate.getTime(), openTime.getTime());
    const windowEnd = Math.min(endDate.getTime(), closeTime.getTime());
    return windowEnd > windowStart ? (windowEnd - windowStart) / (60 * 1000) : 0;
  }

  let totalWorkingMinutes = 0;
  let curr = new Date(startDate);
  const end = new Date(endDate);

  // Iterate day by day
  while (curr.getTime() < end.getTime()) {
    if (isWorkingDay(curr, calendar, cache)) {
      const { openTime, closeTime } = getDailyOpenClose(curr, calendar, cache);
      
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
export function addWorkingTime(startDate: Date, durationMinutes: number, calendar: CalendarConfig, cache?: DayWindowCache): Date {
  if (!startDate || isNaN(startDate.getTime())) return new Date();
  if (durationMinutes <= 0) return new Date(startDate);

  if (calendar.is24x7) {
    return new Date(startDate.getTime() + durationMinutes * 60 * 1000);
  }

  let remainingMin = durationMinutes;
  let curr: Date;
  try {
    curr = nextOpen(startDate, calendar, cache);
  } catch {
    return new Date(startDate);
  }

  const maxIterations = 366 * 5;
  let iterations = 0;

  while (remainingMin > 0 && iterations++ < maxIterations) {
    const { closeTime } = getDailyOpenClose(curr, calendar, cache);
    const availableMinutesInDay = Math.max(0, (closeTime.getTime() - curr.getTime()) / (60 * 1000));

    if (availableMinutesInDay <= 0) {
      const nextDay = new Date(curr);
      nextDay.setDate(nextDay.getDate() + 1);
      nextDay.setHours(0, 0, 0, 0);
      try {
        curr = nextOpen(nextDay, calendar, cache);
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
        curr = nextOpen(nextDay, calendar, cache);
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
export function subtractWorkingTime(endDate: Date, durationMinutes: number, calendar: CalendarConfig, cache?: DayWindowCache): Date {
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
    if (isWorkingDay(curr, calendar, cache)) {
      const { openTime, closeTime } = getDailyOpenClose(curr, calendar, cache);

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
    while (skipped < maxDays && !isWorkingDay(prevWorkDay, calendar, cache)) {
      prevWorkDay.setDate(prevWorkDay.getDate() - 1);
      skipped++;
    }

    if (skipped >= maxDays) {
      // No working days found going back; fail
      return new Date(NaN);
    }

    // Get this working day's close time, being explicit about the target date
    const { closeTime: probe } = getDailyOpenClose(prevWorkDay, calendar, cache);
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

export interface CalendarIssue {
  severity: 'error' | 'warning';
  code: 'no_working_days' | 'zero_window' | 'productive_exceeds_window' | 'holiday_on_closed_weekday';
  message: string;
}

/**
 * Pure check of the calendar/labor combination, for the calendar panel banner and the data-quality gate.
 * 24/7 short-circuits (never blocked). The zero-window rule is the engine's own: getDailyWindowLengthHours <= 0.
 * Productive-hours-above-window is an error with the same tolerance as the DQ rule M1 (the DQ gate does not
 * repeat it from here). A holiday that falls on a weekday the business is closed anyway is a warning only.
 */
export function getCalendarIssues(calendar: CalendarConfig, labor?: Pick<LaborConfig, 'dailyProductiveHours'>): CalendarIssue[] {
  if (calendar.is24x7) return [];
  const issues: CalendarIssue[] = [];
  const days = new Set((calendar.workingDays ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  if (days.size === 0) {
    issues.push({
      severity: 'error',
      code: 'no_working_days',
      message: 'No working days are selected, so the business is never open and nothing can be sized. Select at least one working day.',
    });
  }
  const windowHours = getDailyWindowLengthHours(calendar);
  if (windowHours <= 0) {
    issues.push({
      severity: 'error',
      code: 'zero_window',
      message: 'The daily window has zero length (closing time is not after opening time). Set a closing time after the opening time (24:00 is allowed).',
    });
  } else if (labor && labor.dailyProductiveHours > windowHours + 0.05) {
    issues.push({
      severity: 'error',
      code: 'productive_exceeds_window',
      message: `Daily productive hours (${labor.dailyProductiveHours}h) exceed the daily business window (${windowHours}h). Productive hours cannot exceed open business hours.`,
    });
  }
  if (days.size > 0) {
    const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayOf = (h: string): number => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(h);
      return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay() : -1;
    };
    const closedHolidays = (calendar.holidays ?? []).filter((h) => dayOf(h) >= 0 && !days.has(dayOf(h)));
    if (closedHolidays.length > 0) {
      const one = closedHolidays.length === 1;
      issues.push({
        severity: 'warning',
        code: 'holiday_on_closed_weekday',
        message: `${one ? 'Holiday' : 'Holidays'} ${closedHolidays.map((h) => `${h} (${WEEKDAY_NAMES[dayOf(h)]})`).join(', ')} ${one ? 'falls' : 'fall'} on a day that is already closed, so ${one ? 'it has' : 'they have'} no effect.`,
      });
    }
  }
  return issues;
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
 * The planning horizon: the span of the valid DEMAND intervals — min(start) to max(end). The single
 * implementation behind the search (sync and async), case generation, data quality and the config preview.
 *
 * Opening backlog NEVER moves the horizon (G1, 2026-10-06). It used to pull the start back to the oldest
 * backlog arrival, so the empty days in between counted as planned capacity and understated N_min, occupancy
 * and the recommendation. A backlog case's own arrival still drives its deadline; the simulation injects it at
 * max(arrival, horizonStart) (des-engine.ts).
 *
 * Fallback when there is no valid demand interval at all (backlog-only data): start = earliest valid backlog
 * arrival, end = start + 7 days. With neither it THROWS (S1, 2026-10-14): the horizon used to fall back to the wall
 * clock there, which made a result depend on the day it was run. Callers guard with hasValidHorizonInput.
 */
export function computeIntervalHorizon(
  intervals: Array<{ start: Date; end: Date }>,
  openingWIP: Array<{ arrival?: Date }> = []
): { horizonStart: Date; horizonEnd: Date } {
  let minStartMs = Infinity;
  let maxEndMs = -Infinity;

  for (const it of intervals) {
    if (!it.start || isNaN(it.start.getTime()) || !it.end || isNaN(it.end.getTime())) continue;
    if (it.start.getTime() < minStartMs) minStartMs = it.start.getTime();
    if (it.end.getTime() > maxEndMs) maxEndMs = it.end.getTime();
  }

  if (isFinite(minStartMs) && isFinite(maxEndMs)) {
    return { horizonStart: new Date(minStartMs), horizonEnd: new Date(maxEndMs) };
  }

  // No valid demand interval: fall back to the opening backlog; with no valid backlog arrival either, fail loudly.
  let minArrivalMs = Infinity;
  for (const w of openingWIP ?? []) {
    if (w.arrival && !isNaN(w.arrival.getTime()) && w.arrival.getTime() < minArrivalMs) minArrivalMs = w.arrival.getTime();
  }
  if (!isFinite(minArrivalMs)) {
    throw new Error('No valid demand interval or backlog arrival date: the planning horizon cannot be set. Check the date columns of the uploaded file.');
  }
  const horizonStart = new Date(minArrivalMs);
  return { horizonStart, horizonEnd: new Date(horizonStart.getTime() + 7 * 86400000) };
}

/** True when computeIntervalHorizon can set a horizon: one valid demand interval or one valid backlog arrival. */
export function hasValidHorizonInput(
  intervals: Array<{ start: Date; end: Date }>,
  openingWIP: Array<{ arrival?: Date }> = []
): boolean {
  for (const it of intervals) {
    if (it.start && !isNaN(it.start.getTime()) && it.end && !isNaN(it.end.getTime())) return true;
  }
  for (const w of openingWIP ?? []) {
    if (w.arrival && !isNaN(w.arrival.getTime())) return true;
  }
  return false;
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
