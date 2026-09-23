/**
 * Centralized config for shared Google Sheets infrastructure.
 *
 * Shared defaults live here. ORTUS_SHEETS_WEBAPP_URL selects an independently
 * owned Sheets bridge for this installation; other services keep their defaults.
 *
 * Why centralized:
 *   Before v2.52.0, each operator pasted their own Apps Script URL + SoO sheet
 *   ID into a local .env. Newer operators often skipped this step ("Ask Antonio
 *   for values" in .env.example) and silently ran without SoO. Centralizing
 *   means everyone hits the same infrastructure without per-operator setup.
 *
 * Operational requirement:
 *   - Every Google Sheet referenced from the app must be shared
 *     "anyone with the link can edit" so the Apps Script (running as the
 *     deployer, Antonio) can read/write it.
 */

// Apps Script web app deployment — the single endpoint every operator's app
// POSTs to for sheet reads/writes. Deployed under Antonio's Google account.
// NOTE: v2.72 adds a `writeRecentMessages` action (Recent Messages tab). For
// that tab to populate in production, Antonio must redeploy the updated
// google-apps-script.js on this centralized deployment. Connections and all
// existing sheet writes work regardless.
export const SHEETS_WEBAPP_URL = process.env.ORTUS_SHEETS_WEBAPP_URL?.trim() || 'https://script.google.com/macros/s/AKfycbwZu0ormMlS2IfC7yarIZDBz0XJj_FbOcp5omJTWQPCGsQ8YO3_npqGUQojNc1fmHyXCg/exec';

// State of Operations sheet — the team-wide dashboard of which LinkedIn
// account is in use / cooling off / banned. Drives the SoO panel in the app
// and the signup allowlist. One sheet for everyone.
export const SOO_SHEET_ID = '1t49JaZppDZZNIUuOv2QQw7j1MCZC8vMMy1uZe_AkLwI';
export const SOO_SHEET_GID = '992076199';

// v2.56.0 — Operations Log + Campaign Activity Apps Script deployments.
// Centralized so every operator's app posts to the same team-wide log
// sheets, not to per-operator .env URLs (which Sam and new colleagues
// won't have set). Without these centralized, log-writer.js silently
// no-op'd for everyone except Antonio.
//
// Both are Antonio-deployed Apps Script web apps. The target Google Sheets
// must be shared "anyone with the link can edit" so the Apps Script
// (running as Antonio) can append rows on every operator's behalf.
export const OPS_LOG_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbwWCNWNLTN0z9fWfvUZUwGICzXlg0CG0oBBwASZxqbFzzEnctBBJZRsHmn1dD0F-ANu/exec';
export const CAMPAIGN_LOG_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbzvwiF8QpfQmV8Lk_z0PQz4mOJQZUtRNhs8Y7Sq2q_z4XELsbKIfBhXaAvvmgJZuJ2Ucw/exec';

// v2.57.x — Domains allowed to sign up to the Ortus Outreach app (operator
// login). Replaces the previous "must be in the SoO sheet" check, which was
// wrong: the SoO sheet is keyed to LinkedIn-account-owner emails (e.g.
// jigar.chaudhary@ortus.solutions), not operator emails (e.g.
// sam@ortusclub.com). Anyone with a Google Workspace email on one of these
// domains is on the team and can sign up. SOO_BYPASS_EMAILS env stays as
// an escape hatch for emergency / non-domain access.
export const SIGNUP_ALLOWED_DOMAINS = ['ortusclub.com', 'ortus.solutions'];

// Per-email signup allowlist — individual external collaborators granted access
// WITHOUT opening their whole domain. Kept lowercase; matched exactly.
export const SIGNUP_ALLOWED_EMAILS = ['milee@linkedvelocity.com', 'jhan@apexstrategy.io'];

// v2.113 — Follower Growth campaign. SEPARATE Apps Script deployment from the
// master outreach script: it owns the central FG sheet (FG Invites / FG Budgets
// / FG Funnel). Paste fg-apps-script.js into a NEW Apps Script project, deploy
// as a web app ("execute as me", "anyone with the link"), and put its /exec URL
// here. Until then the app surfaces a friendly "not configured" error.
// A local FG_WEBAPP_URL env var overrides this (for testing against your own
// deployed copy without editing the committed default) — mirrors SCRAPER_ENGINE_URL.
export const FG_WEBAPP_URL = process.env.FG_WEBAPP_URL || 'https://script.google.com/macros/s/AKfycbzWRtACiWoRrB5mweILTI-eKsLM3p7QBPSTKC7COdkIBwl-AwddMHoO89HMCmnjA4xTyg/exec';

// Operation Magellan. A THIRD Apps Script deployment, bound to its own
// "Operation Magellan" sheet — deliberately not the outreach sheet and not the
// FG one (the FG jobs hold that script's lock for minutes at a time). Paste
// magellan-apps-script.js into a NEW Apps Script project, deploy as a web app
// ("execute as me", "anyone with the link"), and put its /exec URL here.
// Until then Magellan still runs; only the sheet write is skipped.
export const MAGELLAN_WEBAPP_URL = process.env.MAGELLAN_WEBAPP_URL || 'https://script.google.com/macros/s/AKfycbyxj7ySr0MxECDf8PQHWVi8ks93WxPCqWsEe4YZo02Ie3zuo0mSL5p3gU0n9JYM4Ypr/exec';

// Follower Growth Phase 2 — the Ortus Club page "Invite to follow" modal URL.
// The ?invite=true query opens the invite modal directly; the /posts/ path +
// feedView=all is the exact URL confirmed to open it for this page (slug ortus-club).
export const ORTUS_PAGE_INVITE_URL = 'https://www.linkedin.com/company/ortus-club/posts/?feedView=all&invite=true';
