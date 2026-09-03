/**
 * Run this once locally to log into LinkedIn.
 *
 *   npm run login
 *
 * A visible Chrome window opens. Log in with your LinkedIn credentials,
 * complete any 2FA prompts, then come back here and press ENTER.
 * Your session cookies are saved to the ./session folder.
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const SESSION_DIR = path.join(__dirname, 'session');

async function main() {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }

  console.log('');
  console.log('🔐  Opening Chrome — please log into LinkedIn…');
  console.log('');

  const ctx = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: false,
    args: ['--no-sandbox'],
    viewport: { width: 1280, height: 900 },
  });

  const page = await ctx.newPage();
  await page.goto('https://www.linkedin.com/login');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  await new Promise((resolve) => {
    rl.question(
      '✅  Once you are fully logged in, press ENTER here to save your session… ',
      () => {
        rl.close();
        resolve();
      }
    );
  });

  // Verify cookies
  const cookies = await ctx.cookies('https://www.linkedin.com');
  const hasLiAt = cookies.some((c) => c.name === 'li_at');

  if (hasLiAt) {
    console.log('');
    console.log('🎉  Session saved! You can now close this window.');
    console.log('    Your cookies are stored in ./session/');
    console.log('');
  } else {
    console.log('');
    console.log('⚠️   Could not find li_at cookie. Are you sure you logged in?');
    console.log('    Try running `npm run login` again.');
    console.log('');
  }

  await ctx.close();
}

main().catch(console.error);
