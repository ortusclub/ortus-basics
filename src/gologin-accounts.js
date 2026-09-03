/**
 * GoLogin accounts registry — the app talks to MORE THAN ONE GoLogin account.
 *
 * Until 2026-08-07 there was exactly one: a single `GOLOGIN_API_TOKEN` read
 * straight out of the environment at ~30 call sites, with nothing anywhere
 * recording which account a profile came from. Linked Velocity is a separate
 * GoLogin plan whose profiles cannot be shared into the Ortus workspace, so
 * "which account owns this profile" had to become a real, tracked fact.
 *
 * The model, deliberately kept small:
 *   - Accounts are declared HERE, hard-coded, exactly like the sheet config in
 *     sheets-webapp-url.js — every operator's build must agree on the roster.
 *     Only the secrets come from the environment.
 *   - A profile belongs to whichever account's API listed it
 *     (see gologin-launcher.getProfiles, which tags every profile).
 *   - An OPERATOR belongs to whichever account matches their login email
 *     domain. That is the whole access rule: an @ortusclub.com login can use
 *     Ortus profiles, an @linkedvelocity.com login can use Linked Velocity
 *     profiles. Everyone still SEES both — the other account's profiles render
 *     in the picker marked unavailable, so the roster stays legible to all.
 *
 * There is no runtime switcher and no per-operator override. Domain is the
 * single source of truth precisely because it cannot be silently mis-set: a
 * shared server with two operators signed in at once still resolves each one's
 * account correctly, which a global "active account" toggle could not.
 */

// Hard-coded roster. `env` names the variable holding that account's API
// token; an account with no token configured is simply absent at runtime
// (see configuredAccounts) — the app degrades to whatever IS configured
// rather than erroring, so a build shipped before the Linked Velocity token
// exists behaves exactly like the old single-account app.
// A pseudo-mode for Post Amplification. It is not a campaign mode — it runs
// through /api/post-amplification/start, not the campaign wizard — but the
// account rules have to talk about it, so it gets a name alongside the real
// modes rather than a parallel boolean.
export const POST_AMPLIFICATION_MODE = 'post_amplification';

export const GL_ACCOUNTS = Object.freeze([
  Object.freeze({
    id: 'ortus',
    label: 'Ortus',
    env: 'GOLOGIN_API_TOKEN',
    domains: Object.freeze(['ortusclub.com', 'ortus.solutions']),
    modes: null,      // no restriction — every mode
    openToAll: false, // domain-gated
  }),
  Object.freeze({
    id: 'linkedvelocity',
    label: 'Linked Velocity',
    env: 'GOLOGIN_API_TOKEN_LINKEDVELOCITY',
    domains: Object.freeze(['linkedvelocity.com']),
    modes: null,
    openToAll: false,
  }),
  // The marketing team's workspace (added 2026-08-07). Unlike the other two, it
  // is restricted by WHAT it may do rather than WHO owns it (operator decision:
  // "it's okay if others who are not marketing people use those accounts"):
  //
  //   openToAll: true  → no domain gate. Any operator may drive these accounts.
  //                      They claim no email domain, so nobody ever resolves
  //                      INTO this workspace either — it is never somebody's
  //                      "own" account set, just a shared pool.
  //   modes: [...]     → the only protection, and it holds against everyone:
  //                      these accounts refuse every mode except Follower
  //                      Growth and Post Amplification.
  Object.freeze({
    id: 'marketing',
    label: 'Marketing',
    env: 'GOLOGIN_API_TOKEN_MARKETING',
    domains: Object.freeze([]),
    modes: Object.freeze(['follower_growth', POST_AMPLIFICATION_MODE]),
    openToAll: true,
  }),
]);

// The account every unknown domain falls back to, and the account whose token
// keeps the legacy `process.env.GOLOGIN_API_TOKEN` meaning. Must stay 'ortus':
// falling back to a DIFFERENT account would hand an unrecognised login the
// wrong workspace instead of the one it has always had.
export const DEFAULT_ACCOUNT_ID = 'ortus';

// ── Extra workspaces the operator adds themselves (Ortus Basics 1.0) ────────
// The three built-ins above are the ones this codebase knows by name. An
// operator may hold a token for some OTHER GoLogin workspace, and the rule for
// this build is simply "a token you paste is a workspace you can drive". Those
// arrive here at runtime from src/gologin-credentials.js.
//
// They are deliberately `openToAll: true` with no domains: a custom workspace
// is nobody's home workspace (accountForEmail must never resolve INTO one), and
// there is no domain that could gate it. `modes: null` — no mode restriction.
let _customAccounts = [];

export function setCustomAccounts(list) {
  _customAccounts = (Array.isArray(list) ? list : [])
    .filter((a) => a && a.id && a.env)
    .map((a) => Object.freeze({
      id: String(a.id),
      label: String(a.label || a.id),
      env: String(a.env),
      domains: Object.freeze([]),
      modes: null,
      openToAll: true,
      custom: true,
    }));
  return _customAccounts.length;
}

/** Built-ins plus the operator's own. Every enumerator goes through this. */
export function allAccounts() {
  return [...GL_ACCOUNTS, ..._customAccounts];
}

export function accountById(id) {
  return allAccounts().find((a) => a.id === id) || null;
}

export function accountLabel(id) {
  const acc = accountById(id);
  return acc ? acc.label : String(id || '');
}

/**
 * The token for an account, read from the environment at CALL time — never
 * cached. dotenv loads late in some entry points and the Electron wrapper
 * rewrites the environment before importing the server; a token captured at
 * module load would be stale or empty in both cases.
 */
export function tokenForAccount(id) {
  const acc = accountById(id);
  if (!acc) return '';
  return process.env[acc.env] || '';
}

/**
 * Accounts that actually have a token right now. Everything that enumerates
 * accounts goes through this, so an unconfigured second account costs exactly
 * one skipped iteration rather than a failed API call per refresh.
 */
export function configuredAccounts() {
  return allAccounts().filter((a) => !!tokenForAccount(a.id));
}

/**
 * Which GoLogin account an operator's login email grants access to.
 * Unknown/blank domains get the default account — the pre-2026-08-07
 * behaviour for every existing login.
 */
export function accountForEmail(email) {
  const domain = String(email || '').trim().toLowerCase().split('@')[1] || '';
  if (!domain) return DEFAULT_ACCOUNT_ID;
  // Custom workspaces carry no domains, so they can never be resolved into here.
  const hit = GL_ACCOUNTS.find((a) => a.domains.includes(domain));
  return hit ? hit.id : DEFAULT_ACCOUNT_ID;
}

/**
 * Operators who belong to a SECOND workspace as well as their own.
 *
 * The domain rule answers for a roster; this answers for a person. Sam runs
 * Linked Velocity campaigns from his Ortus login (2026-09-02), and neither
 * GoLogin's own sharing nor a per-profile grant expresses "all of that
 * workspace" — the grant list would have to name every profile and be re-typed
 * whenever Linked Velocity adds one.
 *
 * Committed on purpose, unlike GOLOGIN_PROFILE_GRANTS: an env entry lives in
 * one machine's .env and dies on the next app update (2026-08-24, Milee).
 * Membership of a workspace should not need re-pasting after every release.
 *
 * Emails are lowercase and matched exactly. Widening WHO may drive an account
 * never changes who OWNS it: the launcher still uses the owning workspace's
 * token and the owner's mode rules still apply.
 */
export const EXTRA_ACCOUNT_MEMBERS = Object.freeze({
  linkedvelocity: Object.freeze(['sam@ortusclub.com', 'info@linkedinvelocity.com']),
});

/**
 * The Ortus-owned half of the shared inventory, granted to Linked Velocity.
 *
 * The SoO parks these under "INVENTORY: DO NOT USE" with NA credits so ORTUS
 * operators leave them alone — Linked Velocity is the team meant to drive them.
 * 17 of those 32 rows already sit in the Linked Velocity workspace and need
 * nothing; these are the 12 that are still owned by Ortus (measured 2026-09-02,
 * ids read from GoLogin, names kept for the next person to read this).
 *
 * Committed for the same reason as EXTRA_ACCOUNT_MEMBERS: the env form of this
 * list lived in Milee's own .env and died on every app update.
 *
 * A grant widens WHO may drive a profile, never who owns it.
 */
export const SHARED_INVENTORY_GRANTS = Object.freeze({
  '688a56148d10cb8490453658': 'linkedvelocity', // pinky.s@klabber.co
  '69b291389a256046e2ac5262': 'linkedvelocity', // muhammad.muneeb@ortus.solutions
  '6a180011947d2dc358c4b2f8': 'linkedvelocity', // mary.simon@ortus.solutions
  '686696205c3c6094e10f461c': 'linkedvelocity', // milee.mel@ortus.solutions
  '69a9640ef15ec789228ae321': 'linkedvelocity', // wali.hassan@ortus.solutions
  '6a2244ea31342edd731f0fb4': 'linkedvelocity', // janelle.cunanan@klabber.co
  '6a4deecaf0caa719dae4bf51': 'linkedvelocity', // ceres.jasareno@klabber.co
  '6a3a3e8949df96595bfef9ca': 'linkedvelocity', // farhan.ramadhan@klabber.co
  '6a339aea1a2d4901c9301fcb': 'linkedvelocity', // gevan.nohara@klabber.co
  '6a61c0a85c6f82743b340367': 'linkedvelocity', // haruki.saito@klabber.co
  '6a6071bf547e277c7a00353b': 'linkedvelocity', // jerodyn.reyes@klabber.co
  '6a310293fb8520c17988a10f': 'linkedvelocity', // ugi.ripaldi@klabber.co
});

/**
 * Per-profile grants — the escape hatch the domain rule deliberately lacks.
 *
 * The domain gate is right for the roster as a whole and wrong for the handful
 * of accounts two workspaces genuinely share (2026-08-17: milee.mel and
 * matt.adcock, owned by Ortus, driven by Linked Velocity). GoLogin's own
 * profile-sharing cannot express this — a shared profile still tags its owning
 * workspace (see getProfiles' first-wins rule), which is exactly what keeps a
 * shared profile out of the marketing mode restriction and must not change.
 *
 * So the grant lives beside the token it overrides, in the environment:
 *
 *   GOLOGIN_PROFILE_GRANTS=linkedvelocity:686696205c3c6094e10f461c,linkedvelocity:686698b83d9568f25c44b0fe
 *
 * Read at call time, never cached, for the same reason tokenForAccount is: the
 * Electron wrapper rewrites the environment before importing the server.
 *
 * A grant widens WHO may drive a profile. It never changes who OWNS it, so
 * tokenForProfile still hands the launcher the owning workspace's token and a
 * granted profile still answers to its owner's mode rules.
 */
export function grantsForProfile(profileId) {
  const id = String(profileId || '').trim();
  if (!id) return [];
  const out = [];
  // The committed shared-inventory list first, then anything an operator has
  // added locally. Both are grants; neither cancels the other.
  if (SHARED_INVENTORY_GRANTS[id]) out.push(SHARED_INVENTORY_GRANTS[id]);
  for (const entry of String(process.env.GOLOGIN_PROFILE_GRANTS || '').split(/[,\s]+/)) {
    const [accId, profId] = entry.split(':');
    if (!accId || !profId) continue;
    if (profId.trim() === id) out.push(accId.trim().toLowerCase());
  }
  // An operator whose .env still carries a grant now committed here would
  // otherwise see the same account listed twice.
  return [...new Set(out)];
}

/**
 * The access rule in one place, so the picker's greying, the launch guard and
 * any future caller can never disagree about it.
 *
 * A profile with no recorded account is treated as the default account's —
 * that is what every profile was before this file existed.
 *
 * `profileId` is optional only so the pre-grant call signature keeps working;
 * a caller that omits it simply cannot benefit from a grant.
 */
export function canOperatorUseProfile(email, profileAccountId, profileId) {
  const id = profileAccountId || DEFAULT_ACCOUNT_ID;
  const acc = accountById(id);
  if (acc && acc.openToAll) return true;
  const mine = accountForEmail(email);
  if (mine === id) return true;
  const who = String(email || '').trim().toLowerCase();
  if ((EXTRA_ACCOUNT_MEMBERS[id] || []).includes(who)) return true;
  return grantsForProfile(profileId).includes(mine);
}

/**
 * True when the operator reaches this profile through a grant or a named
 * membership rather than by owning the workspace it lives in.
 *
 * The picker needs the distinction: the Ortus SoO parks a shared-inventory
 * account under "DO NOT USE" with NA credits to keep ORTUS operators off it,
 * and enforcing that against the very team the account was handed to is the
 * second gate people keep hitting (2026-08-24, Milee).
 */
export function usesProfileAsGuest(email, profileAccountId, profileId) {
  const id = profileAccountId || DEFAULT_ACCOUNT_ID;
  if (accountForEmail(email) === id) return false;
  return canOperatorUseProfile(email, id, profileId);
}

/**
 * The modes an account is allowed to run, or null when it is unrestricted.
 * Returned to the client so the picker can grey a tile the moment the operator
 * switches campaign type, without another round trip.
 */
export function accountModes(profileAccountId) {
  const acc = accountById(profileAccountId || DEFAULT_ACCOUNT_ID);
  return (acc && acc.modes) ? acc.modes.slice() : null;
}

/**
 * Whether an account may run this mode. An account with no `modes` list runs
 * everything, which is every workspace except marketing.
 *
 * A blank mode answers true deliberately: callers that have no mode in hand
 * (the account list, a status poll) must not be told the account is unusable.
 * The launch endpoints always pass a real mode, and they are the ones that
 * matter.
 */
export function accountAllowsMode(profileAccountId, mode) {
  const modes = accountModes(profileAccountId);
  if (!modes) return true;
  if (!mode) return true;
  return modes.includes(mode);
}

/**
 * The single question the launch guards ask: may THIS operator run THIS mode on
 * an account from THIS workspace? Both axes in one place so a caller cannot
 * check one and forget the other.
 */
export function profileUsableFor(email, profileAccountId, mode, profileId) {
  return canOperatorUseProfile(email, profileAccountId, profileId) && accountAllowsMode(profileAccountId, mode);
}
