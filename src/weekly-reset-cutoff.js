/**
 * "Free for all Friday" — when LinkedIn's weekly invitation allowance is assumed
 * to reset, and when a campaign that must not spend NEXT week's allowance should
 * stop. Pure: no clock, no campaign state.
 *
 * Assumption (operator, 2026-09-20): the allowance resets at Monday 00:00
 * California time. The app's own "resets Monday" wording agrees on the day; the
 * hour is the operator's. Both live here so there is one place to change them.
 */
export const RESET_TIME_ZONE = 'America/Los_Angeles';
export const RESET_WEEKDAY = 1;            // Monday (0 = Sunday)
export const STOP_BEFORE_RESET_MS = 15 * 60 * 1000;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Wall-clock parts of an instant in the reset time zone. */
function zoneParts(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: RESET_TIME_ZONE, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { year: +get('year'), month: +get('month'), day: +get('day'), hour: +get('hour'),
    minute: +get('minute'), second: +get('second'), weekday: WEEKDAYS.indexOf(get('weekday')) };
}

/** The instant (epoch ms) at which the zone's wall clock reads y-m-d 00:00. DST-safe. */
function zoneMidnightToUtc(year, month, day) {
  let guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  for (let i = 0; i < 3; i++) {
    const p = zoneParts(guess);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const want = Date.UTC(year, month - 1, day, 0, 0, 0);
    if (shown === want) break;
    guess += want - shown;
  }
  return guess;
}

/** Next weekly reset strictly after `nowMs` (epoch ms). */
export function nextWeeklyResetMs(nowMs) {
  const p = zoneParts(nowMs);
  for (let add = 0; add <= 7; add++) {
    // Date.UTC normalises an overflowing day-of-month, so day + add is safe.
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + add));
    if (d.getUTCDay() !== RESET_WEEKDAY) continue;
    const reset = zoneMidnightToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    if (reset > nowMs) return reset;
  }
  return nowMs + 7 * 86400000; // unreachable; never return something in the past
}

/** When a campaign started at `nowMs` must stop sending connection requests. */
export function weeklyCutoffMs(nowMs) {
  const reset = nextWeeklyResetMs(nowMs);
  const cutoff = reset - STOP_BEFORE_RESET_MS;
  // Started inside the last 15 minutes: that window is already gone — aim for next week's.
  return cutoff > nowMs ? cutoff : nextWeeklyResetMs(reset + 1000) - STOP_BEFORE_RESET_MS;
}
