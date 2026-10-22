// Prints the discovered modes as JSON: which are engine-driven (startCampaign) and
// which have a hand-written profile. Run with --import ./tests/sim/register.mjs.
import { discoverModeList, MODE_PROFILES } from './modes.mjs';
const { getModeHint } = await import('../../src/campaign.js');
const out = discoverModeList().map(m => ({
  ...m,
  engine: getModeHint(m.value) != null,
  hasProfile: !!MODE_PROFILES[m.value],
}));
console.log('SIMDISCOVER:' + JSON.stringify(out));
process.exit(0);
