const UNLIMITED = new Set(['check_status', 'message_only', 'introduce_back', 'inmail_only']);
export const hasDailySendLimit = mode => !UNLIMITED.has(mode);
export const dailyQuotaCount = (mode, connections = 0, messages = 0) =>
  ['open_profile_only', 'message_only', 'introduce_back', 'inmail_only'].includes(mode) ? messages : connections;
export const utcDayKey = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
export function nextDailyResetAt(now = Date.now()) {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)).toISOString();
}
