import { markAccountNeedsLoginSoO, clearAccountNeedsLoginSoO } from './soo-writer.js';
import { verifyLinkedInLogin } from './linkedin/login-session.js';

const MODES = new Set(['connect_and_introduce', 'open_profile_only', 'introduce_back']);

// Serialize transitions per account: a later logout must not be swallowed by
// an earlier pending clear. Only confirmed writes are deduplicated.
export function createSoOLoginReporter({ mode, log = () => {}, write = markAccountNeedsLoginSoO, clear = clearAccountNeedsLoginSoO, verify = verifyLinkedInLogin }) {
  const confirmed = new Map(), pending = new Map();
  async function report(accountName, needsLogin = true) {
    const email = String(accountName || '').trim().toLowerCase();
    if (!MODES.has(mode) || !email) return;
    const task = (pending.get(email) || Promise.resolve()).catch(()=>{}).then(async()=>{
      if (confirmed.has(email) && confirmed.get(email) === needsLogin) return {ok:true,alreadyReported:true};
      try {
        const result = await (needsLogin ? write : clear)({email});
        if (result?.ok && result.matched) {
          confirmed.set(email,needsLogin);
          if (needsLogin ? !result.alreadySet : !result.alreadyClear) log(`  ${needsLogin?'⚑':'✓'} SoO: ${email} → Needs Login ${needsLogin?'= Y':'cleared (login confirmed)'}.`);
        } else log(`  ⚠ SoO Needs Login ${needsLogin?'flag':'clear'} failed for ${email}: ${result?.error || 'update not confirmed'}.`);
        return result;
      } catch(error) {
        log(`  ⚠ SoO Needs Login ${needsLogin?'flag':'clear'} failed for ${email}: ${error.message}`);
        return {ok:false,error:error.message};
      }
    });
    pending.set(email,task);
    try { return await task; } finally { if(pending.get(email)===task)pending.delete(email); }
  }
  report.confirmLoggedIn = async (email,page) => {
    if (!MODES.has(mode) || !String(email||'').trim()) return;
    if (await verify(page)) return report(email,false);
    return {ok:false,unverified:true};
  };
  return report;
}
