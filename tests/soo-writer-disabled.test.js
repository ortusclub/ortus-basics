import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flipAccountInUse, bumpConnectionsThisWeek, markAccountNeedsLoginSoO } from '../src/soo-writer.js';
test('credit, user and connection-tally writes stay disabled with no network',async t=>{
  t.mock.method(globalThis,'fetch',async()=>{throw Error('unexpected network call');});
  assert.deepEqual(await flipAccountInUse({email:'a@x',creditHeader:'CC (Credits)',userHeader:'CC User'}),{ok:false,disabled:true});
  assert.deepEqual(await bumpConnectionsThisWeek({email:'a@x'}),{ok:false,disabled:true});
});
test('login flag rejects a blank email before any network call',async()=>{
  assert.deepEqual(await markAccountNeedsLoginSoO({email:'  '}),{ok:false,error:'no email'});
});
