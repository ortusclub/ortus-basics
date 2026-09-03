/**
 * Pure throttle-policy module — decide 429 recovery action without side effects.
 *
 * @module throttle-policy
 */

/**
 * Decide whether to enter cooldown or park based on episode history.
 *
 * @param {Object} opts - options object
 * @param {number} [opts.consecutive429s] - how many 429s in a row for this profile in this episode
 * @param {number} [opts.cooldownsSoFar] - how many cooldown episodes this profile has served in this run
 * @param {number} [opts.reachedThisRun] - how many people this profile has actually reached this run
 * @returns {Object} { action: 'cooldown'|'park', waitMs: number }
 *
 * Logic:
 * - reachedThisRun === 0 → action: 'park', waitMs: 0
 * - If cooldownsSoFar < 2:
 *   - cooldownsSoFar=0 → action: 'cooldown', waitMs: 30 min (1800000 ms)
 *   - cooldownsSoFar=1 → action: 'cooldown', waitMs: 60 min (3600000 ms)
 * - If cooldownsSoFar >= 2:
 *   - action: 'park', waitMs: 0
 *
 * Missing/negative values are treated as 0.
 *
 * The reachedThisRun shortcut is the weekly cap's actual signature. A throttle
 * arrives after an account has been sending; the cap 429s the very first invite
 * and every one after it. Waiting out 30 then 60 minutes to conclude what the
 * first turn already showed cost the operator 90 minutes per capped account and
 * still reported it as "throttled" the whole time (2026-09-03). An account
 * parked wrongly is one button away from the rotation; an account cooled
 * wrongly is an hour and a half.
 */
export function decide429({ consecutive429s, cooldownsSoFar, reachedThisRun } = {}) {
  // Input validation: treat missing/negative values as 0
  const cooldowns = Math.max(0, cooldownsSoFar ?? 0);

  // Nothing got through at all: this is the cap, not a slow-down. Only when the
  // caller actually supplies the count — an absent one must not park anything.
  if (reachedThisRun != null && Math.max(0, reachedThisRun) === 0) {
    return { action: 'park', waitMs: 0 };
  }

  // Determine action and wait time based on cooldown episode count
  if (cooldowns < 2) {
    // First or second episode: enter cooldown
    const waitMs = cooldowns === 0 ? 30 * 60 * 1000 : 60 * 60 * 1000;
    return { action: 'cooldown', waitMs };
  }

  // Third or subsequent episode: park the profile
  return { action: 'park', waitMs: 0 };
}
