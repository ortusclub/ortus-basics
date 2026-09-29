import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rotationAccountFinished, rotationFinished } from '../src/campaign-rotation.js';

test('completed accounts and logged-out accounts together finish the run', () => {
  const state = { exhausted: new Set(['sent']), unavailable: new Set(['logged-out']), skipped: new Set() };
  const queue = ['sent', 'logged-out'];
  assert.deepEqual(queue.filter(id => !rotationAccountFinished(id, state)), []);
  assert.equal(rotationFinished(queue, new Set(), state, () => false), true);
});

test('finishing one sender never stops a different sender with pending leads', () => {
  const state = { exhausted: new Set(['sent']), unavailable: new Set(), skipped: new Set() };
  assert.equal(rotationFinished(['sent', 'pending'], new Set(), state, () => false), false);
  assert.equal(rotationFinished(['sent'], new Set(['pending']), state, () => false), false);
  state.exhausted.add('pending');
  assert.equal(rotationFinished(['sent', 'pending'], new Set(), state, () => false), true);
});

test('an operator-skipped account cannot keep the rotation alive; cooldown alone can', () => {
  const state = { exhausted: new Set(), unavailable: new Set(), skipped: new Set(['skipped']) };
  assert.equal(rotationFinished(['skipped'], new Set(), state, () => false), true);
  assert.equal(rotationFinished(['cooling'], new Set(), state, () => false), false);
  assert.equal(rotationFinished(['capped'], new Set(), state, () => true), true);
});
