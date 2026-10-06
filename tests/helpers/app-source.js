import { readFileSync } from 'node:fs';
export const appSource = readFileSync(new URL('../../public/js/app.js', import.meta.url), 'utf8');
// Top-level functions in this bundle end with an unindented closing brace.
export function appFunction(name) {
  const start = appSource.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing app function: ${name}`);
  const end = appSource.indexOf('\n}', start);
  if (end < 0) throw new Error(`Unterminated app function: ${name}`);
  return appSource.slice(start, end + 2);
}
