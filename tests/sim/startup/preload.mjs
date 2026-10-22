// Loaded into the REAL server process (node --import) by the start-up checks. It puts the fake Google Sheet / Apps Script
// in front of every fetch, and re-reads the sheet content from SIM_STARTUP_SPEC on each request so one running server
// can be shown different sheets (blank sender column, empty sheet, …) without restarting.
import { readFileSync } from 'node:fs';
import { createWorld } from '../world.mjs';

const read = () => JSON.parse(readFileSync(process.env.SIM_STARTUP_SPEC, 'utf8'));
const spec = read();
const world = createWorld({ headers: [...spec.headers], leads: spec.leads });
const inner = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const s = read();
  world.headers.splice(0, world.headers.length, ...s.headers);
  world.rows.splice(0, world.rows.length, ...s.leads.map(l => ({ ...l })));
  return inner(input, init);
};
globalThis.__SIM__ = { accounts: spec.accounts || [], leadScript: {}, accepted: {}, linkedinHits: world.linkedinHits, invitesSent: [], messagesSent: [], people: [], primarySlug: 'pat-primary' };
globalThis.__SIM_WORLD__ = world;
