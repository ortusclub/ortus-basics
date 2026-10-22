// Loads the REAL column tables out of google-apps-script.js (FIELD_MAP, MODE_COLUMNS_V2, ...) so the
// fake sheet provisions and stamps columns exactly like the deployed script — and keeps doing so when
// that file changes. Only top-level declarations run; no Apps Script service is ever called.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const GAS = fileURLToPath(new URL('../../google-apps-script.js', import.meta.url));

export function loadGasTables() {
  const sandbox = {};
  const stub = new Proxy(function () {}, { get: () => stub, apply: () => stub, construct: () => stub });
  for (const n of ['SpreadsheetApp', 'Session', 'Utilities', 'ContentService', 'PropertiesService', 'LockService', 'CacheService', 'UrlFetchApp', 'Logger', 'HtmlService']) sandbox[n] = stub;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(GAS, 'utf8'), sandbox, { filename: 'google-apps-script.js' });
  const t = (k) => { if (sandbox[k] === undefined) throw new Error(`sim: ${k} missing from google-apps-script.js — gas.mjs needs updating`); return sandbox[k]; };
  return {
    FIELD_MAP: t('FIELD_MAP'), COL_ALIASES: t('COL_ALIASES'),
    MODE_COLUMNS_V2: t('MODE_COLUMNS_V2'), ALWAYS_PROVISIONED_V2: t('ALWAYS_PROVISIONED_V2'),
    URL_COLUMN_NAMES: t('URL_COLUMN_NAMES'),
  };
}
