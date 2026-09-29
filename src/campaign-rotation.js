// Completed, unavailable and operator-skipped accounts must agree across
// selection, re-enqueueing and the worker's exit check.
export function rotationAccountFinished(id, { exhausted, unavailable, skipped }) {
  return exhausted.has(id) || unavailable.has(id) || !!skipped?.has(id);
}

export function rotationFinished(queue, active, state, isDailyCapped) {
  return active.size === 0 && queue.every(id => rotationAccountFinished(id, state) || isDailyCapped(id));
}
