// Resolve the {sender name} / {sender first name} values for one send.
//
// Bug (Oct 2026, OPII sheet): every open-profile message went out as
// "I'm katrina.par@ortus.solutions from The Ortus Club" while the preview showed
// "Katrina Nicole". The send path only read senderFirstNames[profileId] and fell
// back to the GoLogin profile name — which is the account's email. The preview
// reads the SoO board by email. This resolves in the same order the preview does,
// so what is previewed is what is sent.
//
// Order: operator-resolved first name → SoO First Name by the row's Sender email
// → SoO First Name by the GoLogin profile name (when it is an email) → profile name.

const norm = (s) => (s == null ? '' : String(s)).trim().toLowerCase();

export function lookupSoOFirstName(accounts, key) {
  const k = norm(key);
  if (!k || !Array.isArray(accounts)) return '';
  for (const a of accounts) {
    if (a && norm(a.email) === k) return (a.firstName || '').toString().trim();
  }
  return '';
}

export function resolveSenderIdentity({ profileFirst = '', rowSender = '', profileName = '', sooAccounts = [] } = {}) {
  let first = (profileFirst || '').toString().trim();
  let source = first ? 'profile' : '';
  if (!first) {
    first = lookupSoOFirstName(sooAccounts, rowSender);
    if (first) source = 'soo-row-sender';
  }
  if (!first) {
    first = lookupSoOFirstName(sooAccounts, profileName);
    if (first) source = 'soo-profile-name';
  }
  const pName = (profileName || '').toString().trim();
  return {
    first: first || pName.split(/\s+/)[0] || '',
    name: first || pName,
    source: source || 'profile-name-fallback',
  };
}
