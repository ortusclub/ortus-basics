import { extractProfileUrnFromVoyagerResponse } from './helpers.js';

// A fresh authenticated identity response is required. URL, cookies, cached
// identity and a successful browser launch alone do not prove a live session.
export async function verifyLinkedInLogin(page) {
  try {
    const url = new URL(page.url());
    if (url.protocol !== 'https:' || !/(^|\.)linkedin\.com$/.test(url.hostname) || /\/(login|authwall|checkpoint|uas)(\/|$)/i.test(url.pathname)) return false;
    const result = await page.evaluate(async () => {
      try {
        const cookie = document.cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith('JSESSIONID='));
        if (!cookie) return null;
        const response = await fetch('https://www.linkedin.com/voyager/api/me', {
          credentials:'include', cache:'no-store', signal:AbortSignal.timeout(10000),
          headers:{accept:'application/vnd.linkedin.normalized+json+2.1','csrf-token':cookie.slice('JSESSIONID='.length).replace(/"/g,''),'x-restli-protocol-version':'2.0.0'},
        });
        if (!response.ok || response.redirected) return null;
        return await response.json();
      } catch { return null; }
    });
    return !!extractProfileUrnFromVoyagerResponse(result);
  } catch { return false; }
}
