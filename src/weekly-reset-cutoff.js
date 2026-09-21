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
export const STOP_BEFORE_RESET_MS = 15 * 60 * 1000;   // monthly cutoff only
// Free for all Friday stops when the weekend free-for-all ends: Sunday 12:00
// Philippine time (operator, 2026-09-21). The window opens Saturday 12:00 PH time.
export const WEEKLY_STOP_TIME_ZONE = 'Asia/Manila';
export const WEEKLY_STOP_WEEKDAY = 0;      // Sunday
export const WEEKLY_STOP_HOUR = 12;        // midday, reset time zone

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Wall-clock parts of an instant in the reset time zone. */
function zoneParts(ms, timeZone = RESET_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { year: +get('year'), month: +get('month'), day: +get('day'), hour: +get('hour'),
    minute: +get('minute'), second: +get('second'), weekday: WEEKDAYS.indexOf(get('weekday')) };
}

/** The instant (epoch ms) at which the zone's wall clock reads y-m-d hour:00. DST-safe. */
function zoneMidnightToUtc(year, month, day, hour = 0, timeZone = RESET_TIME_ZONE) {
  let guess = Date.UTC(year, month - 1, day, hour, 0, 0);
  for (let i = 0; i < 3; i++) {
    const p = zoneParts(guess, timeZone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const want = Date.UTC(year, month - 1, day, hour, 0, 0);
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
  // Next Sunday 12:00 Philippine time strictly after now. Started Sunday
  // afternoon (PH) → that week's midday is gone, so aim for next Sunday's.
  const p = zoneParts(nowMs, WEEKLY_STOP_TIME_ZONE);
  for (let add = 0; add <= 7; add++) {
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + add));
    if (d.getUTCDay() !== WEEKLY_STOP_WEEKDAY) continue;
    const cutoff = zoneMidnightToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), WEEKLY_STOP_HOUR, WEEKLY_STOP_TIME_ZONE);
    if (cutoff > nowMs) return cutoff;
  }
  return nowMs + 7 * 86400000; // unreachable
}

/**
 * "Free for all 25th" — LinkedIn's MONTHLY message allowances (Sales Navigator
 * InMail credits, free Open Profile messages) renew on the first day of every
 * calendar month, and LinkedIn calculates the month in UTC (Recruiter Help:
 * "Coordinated Universal Time (UTC) is used for calculating a month"; Sales
 * Navigator Help: "renew on the first day of every month, regardless of your
 * billing cycle"). So the reset is the 1st at 00:00 UTC — no DST to handle.
 */
export function nextMonthlyResetMs(nowMs) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0);
}

/** When a message campaign started at `nowMs` must stop sending. */
export function monthlyCutoffMs(nowMs) {
  const cutoff = nextMonthlyResetMs(nowMs) - STOP_BEFORE_RESET_MS;
  // Started inside the last 15 minutes of the month: aim for the end of NEXT month.
  return cutoff > nowMs ? cutoff : nextMonthlyResetMs(nextMonthlyResetMs(nowMs) + 1000) - STOP_BEFORE_RESET_MS;
}
