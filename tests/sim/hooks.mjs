// ESM resolve hook: every import of src/gologin-launcher.js (from anywhere in
// the app) lands on the fake launcher instead. The fake re-exports the real
// module for everything it doesn't override, so new exports keep resolving.
// Already a file URL: going through .pathname would double-encode a folder name with spaces ("The Ortus Outreach.app").
export const FAKE = new URL('./fakes/gologin-launcher.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL || '';
  if (/(^|\/)gologin-launcher\.js$/.test(specifier) && !parent.includes('/tests/sim/')) {
    return { url: FAKE, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
