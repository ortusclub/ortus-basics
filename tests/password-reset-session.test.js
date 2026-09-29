import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('verified password change revokes previous password and sessions, preserving concurrent accounts',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'basics-auth-'));process.env.ORTUS_DATA_DIR=dir;process.env.SESSION_SECRET='test-secret';process.env.DASHBOARD_USERS='person@ortusclub.com:legacy-password';t.after(()=>rm(dir,{recursive:true,force:true}));
 const auth=await import('../src/auth.js');await Promise.all([auth.createUser('person@ortusclub.com','old-password'),auth.createUser('second@ortusclub.com','another-password')]);
 let token;const response={cookie:(name,value)=>token=value};await auth.issueSessionCookie(response,'person@ortusclub.com');const old=token;assert.equal(await auth.readSessionFromRequest({cookies:{ortus_session:old}}),'person@ortusclub.com');
 await auth.setPassword('person@ortusclub.com','new-password');assert.equal(await auth.verifyCredentials('person@ortusclub.com','old-password'),null);assert.equal(await auth.verifyCredentials('person@ortusclub.com','legacy-password'),null);assert.equal(await auth.verifyCredentials('person@ortusclub.com','new-password'),'person@ortusclub.com');assert.equal(await auth.userExists('second@ortusclub.com'),true);
 assert.equal(await auth.readSessionFromRequest({cookies:{ortus_session:old}}),null);await auth.issueSessionCookie(response,'person@ortusclub.com');assert.equal(await auth.readSessionFromRequest({cookies:{ortus_session:token}}),'person@ortusclub.com');assert.equal((await stat(join(dir,'users.json'))).mode&0o777,0o600);
});
