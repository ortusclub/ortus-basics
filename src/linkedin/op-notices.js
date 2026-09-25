// v1.7.48: LinkedIn / Sales Navigator copy shown when a free Open Profile
// message can't be sent because one was already sent recently (LinkedIn
// allows one unanswered free message per member in a rolling window, ~90
// days). Pure text matcher so it can be unit-tested; the page readers in
// actions.js feed it document.body.innerText.
const ALREADY_MESSAGED_PATTERNS = [
  /already (?:sent|messaged)/i,
  /can(?:'|’)?t send (?:another|a new|more|additional) (?:free )?(?:message|inmail)/i,
  /(?:cannot|unable to) send (?:another|a new|more|additional) (?:free )?(?:message|inmail)/i,
  /until (?:they|he|she|[A-Z][\w-]*) (?:repl|respond)/i,
  /has(?:n(?:'|’)?t| not) (?:yet )?(?:replied|responded)/i,
  /(?:last|past|within|every) 90 days/i,
  /wait (?:until|for) .{0,40}(?:repl|respond)/i,
  /only send one (?:free )?(?:message|inmail)/i,
  /one (?:free )?(?:message|inmail) (?:per|every)/i,
];

/** @returns {string|null} the matching line of page text, or null */
export function alreadyMessagedNoticeIn(text) {
  const t = String(text || '');
  if (!t) return null;
  for (const re of ALREADY_MESSAGED_PATTERNS) {
    const m = t.match(re);
    if (!m) continue;
    const at = m.index;
    const from = t.lastIndexOf('\n', at) + 1;
    let to = t.indexOf('\n', at); if (to < 0) to = t.length;
    return t.slice(from, to).trim().slice(0, 200);
  }
  return null;
}

export const OP_ALREADY_MESSAGED = 'OP_ALREADY_MESSAGED';
