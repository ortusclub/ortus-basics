// A missing optional name is not evidence that a loaded campaign is still loading.
export function campaignTitle(status = {}, fallback = '') {
  const name = String(status.name || fallback || '').trim();
  if (name && name !== '—') return name;
  if (status._loadingIdentity) return 'Loading campaign…';
  return ({ open_profile_only: 'Message campaign', message_only: 'Direct message campaign',
    inmail_only: 'InMail campaign', introduce_back: 'Introduction campaign',
    connect_only: 'Connection campaign', check_status: 'Connection check' })[status.mode] || 'Campaign';
}
