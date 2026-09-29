// Count repeated account turns that neither advance a lead nor send anything.
// Normal cooldown waits never call record(); parked/exhausted accounts are excluded.
export function createCampaignLoopGuard({ maxStalledTurns = 3, retryDelayMs = 15000 } = {}) {
  const stalls = new Map();
  return {
    reset() { stalls.clear(); },
    record(profileId, { before, after, retryable = true }) {
      if (!retryable || before !== after) {
        stalls.delete(profileId);
        return { stalled: false, attempts: 0, pause: false, retryDelayMs: 0 };
      }
      const attempts = (stalls.get(profileId) || 0) + 1;
      stalls.set(profileId, attempts);
      return { stalled: true, attempts, pause: attempts >= maxStalledTurns, retryDelayMs };
    },
  };
}
