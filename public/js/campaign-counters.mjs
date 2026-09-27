export function dailyCountText(account) {
  const count = Number(account.dailyCount) || 0;
  return account.dailyLimit > 0 ? `${count}/${account.dailyLimit} sent today` : `${count} sent today`;
}
export function batchCountText(account) {
  if (account.batchSent == null) return '';
  const checked = Number(account.batchDone) || 0;
  return `Batch: ${account.batchSent} sent · ${checked}${account.batchSize > 0 ? '/' + account.batchSize : ''} checked`;
}
export function dailyResetText(account) {
  if (!(account.dailyLimit > 0) || !account.dailyResetAt) return '';
  const date = new Date(account.dailyResetAt);
  if (!Number.isFinite(date.getTime())) return '';
  const local = date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  return `App daily limit resets ${local} (00:00 UTC).`;
}
