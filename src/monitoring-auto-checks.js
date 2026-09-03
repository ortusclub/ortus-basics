/**
 * Pure decision: should the monitoring watcher fire an auto-check right now?
 *
 * - autoChecksEnabled === false  → never auto-fire (operator turned it off and
 *   uses the manual "Check now" button instead). Absent/undefined counts as
 *   enabled so existing campaigns and pre-existing state files keep firing.
 * - otherwise fire only when nextCheckAt is set and is now due.
 *
 * Does NOT cover the 7-day window expiry — that stays in tickMonitoringNow.
 */
export function shouldAutoFireCheck({ autoChecksEnabled, nextCheckAt, now }) {
  // Ortus Basics 1.0: checks are manual-only. Forced here rather than relying on
  // campaign.autoChecksEnabled, because resumeMonitoringFromDisk() rehydrates the
  // persisted monitoring slice with Object.assign and would restore an older
  // autoChecksEnabled: true straight over the launch-time false.
  // Manual "Check now" does not come through here — it calls
  // runMonitoringCheckAll() directly — so it is unaffected.
  return false;
  /* eslint-disable no-unreachable */
  if (autoChecksEnabled === false) return false;
  if (!nextCheckAt) return false;
  const due = new Date(nextCheckAt).getTime();
  if (Number.isNaN(due)) return false;
  return now >= due;
}
