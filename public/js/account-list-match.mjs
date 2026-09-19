// Match complete email addresses, including decorated GoLogin profile labels.
// Never use partial or fuzzy matching when choosing sender accounts.
export function matchAccountList(text, profiles) {
  const emails = value => String(value || '').toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/g) || [];
  const entries = [...new Set(String(text).toLowerCase().split(/[\s,;]+/).filter(Boolean))];
  const matched = [], missing = [], ambiguous = [];
  for (const entry of entries) {
    const candidates = profiles.filter(p => emails(p.name).includes(entry));
    if (candidates.length === 1) matched.push(candidates[0]);
    else if (candidates.length > 1) ambiguous.push(entry);
    else missing.push(entry);
  }
  return { matched, missing, ambiguous };
}
