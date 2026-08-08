/**
 * scripts/login-and-click.js
 *
 * Robust Playwright script with:
 * - support for GMAIL_USER_LIST (comma/newline separated) mapped to matrix INSTANCE
 * - optional storageState.json usage
 * - login fallback with username/password
 * - clicking Continue + Skip (handles frames)
 * - KEEP_OPEN_MINUTES with cancellable sleep (handles SIGTERM/SIGINT)
 * - debug dump (screenshot, HTML, cookies) on errors or abort
 *
 * Env variables:
 * - TARGET_URL (required)
 * - GMAIL_USER_LIST (comma/newline) OR GMAIL_USERNAME
 * - GMAIL_PASSWORD (required if no storageState)
 * - INSTANCE (matrix index, 1-based)
 * - KEEP_OPEN_MINUTES (default 15)
 * - PLAYWRIGHT_HEADLESS ("false" to run headful locally)
 */

const { chromium } = require('playwright');
const fs = require('fs');

let abortRequested = false;
process.on('SIGTERM', () => {
  console.warn('Received SIGTERM — requesting abort.');
  abortRequested = true;
});
process.on('SIGINT', () => {
  console.warn('Received SIGINT — requesting abort.');
  abortRequested = true;
});

function cancellableSleep(ms, checkInterval = 1000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (abortRequested) {
        clearInterval(t);
        return reject(new Error('Sleep aborted by signal'));
      }
      if (Date.now() - start >= ms) {
        clearInterval(t);
        return resolve();
      }
    }, checkInterval);
  });
}

(async () => {
  const TARGET_URL = process.env.TARGET_URL;
  const LIST = process.env.GMAIL_USER_LIST || '';
  const SINGLE = process.env.GMAIL_USERNAME || '';
  const PASSWORD = process.env.GMAIL_PASSWORD;
  const INSTANCE = parseInt(process.env.INSTANCE || '1', 10);
  const KEEP_OPEN_MINUTES = parseInt(process.env.KEEP_OPEN_MINUTES || '15', 10);
  const HEADLESS = process.env.PLAYWRIGHT_HEADLESS !== 'false';

  if (!TARGET_URL) {
    console.error('ERROR: TARGET_URL not set.');
    process.exit(1);
  }

  // parse emails (comma or newline)
  const emails = LIST.split(/\r?\n|,/).map(s => s.trim()).filter(Boolean);
  let USERNAME = '';
  if (emails.length > 0) {
    const idx = Math.max(0, INSTANCE - 1);
    if (idx < emails.length) USERNAME = emails[idx];
    else console.warn(`Instance ${INSTANCE} has no corresponding email in GMAIL_USER_LIST (length ${emails.length}).`);
  }
  if (!USERNAME && SINGLE) USERNAME = SINGLE;

  if (!USERNAME) {
    console.error('ERROR: No username determined. Set GMAIL_USER_LIST or GMAIL_USERNAME.');
    process.exit(1);
  }

  const tsNow = () => new Date().toISOString().replace(/[:.]/g, '-');

  async function dumpDebug(page, prefix) {
    try {
      const t = tsNow();
      const ss = `debug-${INSTANCE}-${prefix}-${t}.png`;
      const html = `debug-${INSTANCE}-${prefix}-${t}.html`;
      await page.screenshot({ path: ss, fullPage: true }).catch(()=>{});
      fs.writeFileSync(html, await page.content());
      try {
        const c = await page.context().cookies();
        fs.writeFileSync(`debug-${INSTANCE}-${prefix}-${t}-cookies.json`, JSON.stringify(c, null, 2));
      } catch (e) {}
      console.log(`[${INSTANCE}] Saved debug files: ${ss}, ${html}`);
    } catch (e) {
      console.warn(`[${INSTANCE}] dumpDebug failed: ${e.message}`);
    }
  }

  async function hasAuthCookies(context) {
    try {
      const cookies = await context.cookies();
      const names = cookies.map(c => c.name);
      console.log(`[${INSTANCE}] Cookies: ${names.join(', ')}`);
      const authNames = ['SID','HSID','SAPISID','APISID','SIDCC'];
      return names.some(n => authNames.includes(n));
    } catch (e) {
      console.warn(`[${INSTANCE}] Error reading cookies: ${e.message}`);
      return false;
    }
  }

  async function checkMyAccount(page) {
    try {
      await page.goto('https://myaccount.google.com', { waitUntil: 'networkidle', timeout: 15000 });
      const cur = page.url();
      console.log(`[${INSTANCE}] myaccount URL: ${cur}`);
      if (cur.includes('signin') || cur.includes('accounts.google.com/')) return false;
      if (await page.locator('img[alt*="Google Account"]').count() > 0) return true;
      if (await page.locator('text=Sign out').count() > 0) return true;
      return false;
    } catch (e) {
      console.warn(`[${INSTANCE}] checkMyAccount error: ${e.message}`);
      return false;
    }
  }

  async function clickInFrames(page, selector, opts = {}) {
    try {
      const loc = page.locator(selector);
      if (await loc.count() > 0) {
        for (let i = 0; i < await loc.count(); i++) {
          try {
            const el = loc.nth(i);
            if (await el.isVisible()) {
              await el.click(opts);
              return true;
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
    for (const frame of page.frames()) {
      try {
        const fl = frame.locator(selector);
        if (await fl.count() > 0) {
          for (let i = 0; i < await fl.count(); i++) {
            try {
              const fel = fl.nth(i);
              if (await fel.isVisible()) {
                await fel.click(opts);
                return true;
              }
            } catch (e) {}
          }
        }
      } catch (e) {}
    }
    return false;
  }

  async function tryClickContinue(page) {
    const sels = [
      'button:has-text("Continue to the app")',
      'text="Continue to the app"',
      'button:has-text("Continue")',
      'text="Continue"'
    ];
    for (const s of sels) {
      try {
        const ok = await clickInFrames(page, s, { timeout: 7000 }).catch(()=>false);
        if (ok) {
          console.log(`[${INSTANCE}] Clicked continue (${s})`);
          return true;
        }
      } catch (e) {}
    }
    return false;
  }

  async function tryClickSkip(page) {
    const sels = [ 'button:has-text("Skip")', 'text="Skip"', 'button:has-text("Skip tutorial")' ];
    for (const s of sels) {
      try {
        const ok = await clickInFrames(page, s, { timeout: 5000 }).catch(()=>false);
        if (ok) {
          console.log(`[${INSTANCE}] Clicked skip (${s})`);
          return true;
        }
      } catch (e) {}
    }
    return false;
  }

  async function verify(page) {
    try {
      const cur = page.url();
      console.log(`[${INSTANCE}] target page url: ${cur}`);
      if (cur.includes('accounts.google.com') || cur.includes('consent') || cur.includes('signin')) {
        console.warn(`[${INSTANCE}] Redirected to sign-in/consent page.`);
        return false;
      }
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(()=>{});
      await page.waitForTimeout(1500);
      // fallback heuristic: ensure no obvious sign-in strings
      const body = (await page.textContent('body')) || '';
      if (!/sign in|this app is from another developer|continue to the app|consent|authorize/i.test(body)) {
        console.log(`[${INSTANCE}] Body heuristic OK.`);
        return true;
      }
      return false;
    } catch (e) {
      console.warn(`[${INSTANCE}] verify error: ${e.message}`);
      return false;
    }
  }

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const contextOptions = { userAgent, viewport: { width: 1280, height: 800 } };
  if (fs.existsSync('storageState.json')) {
    contextOptions.storageState = 'storageState.json';
    console.log(`[${INSTANCE}] Using storageState.json for auth.`);
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  page.on('console', msg => {
    try { console.log(`[console][${INSTANCE}] ${msg.type()}: ${msg.text()}`); } catch(e){}
  });
  page.on('requestfailed', req => {
    try { console.log(`[requestfailed][${INSTANCE}] ${req.method()} ${req.url()} => ${req.failure()?.errorText || 'failed'}`); } catch(e){}
  });

  async function runOnce() {
    console.log(`[${INSTANCE}] Starting run for ${USERNAME}`);
    try {
      if (!contextOptions.storageState) {
        if (!PASSWORD) {
          throw new Error('GMAIL_PASSWORD not set and no storageState.json available.');
        }

        console.log(`[${INSTANCE}] Navigating to Google sign-in...`);
        await page.goto('https://accounts.google.com/signin/v2/identifier', { waitUntil: 'networkidle', timeout: 30000 });
        console.log(`[${INSTANCE}] After nav: ${page.url()}`);

        try {
          await page.waitForSelector('#identifierId, input[type="email"], input[name="identifier"]', { timeout: 30000, state: 'visible' });
        } catch (e) {
          console.warn(`[${INSTANCE}] Email input not visible: ${e.message}`);
          await dumpDebug(page, 'no-email');
          throw e;
        }

        const emailEl = (await page.$('#identifierId')) || (await page.$('input[type="email"]')) || (await page.$('input[name="identifier"]'));
        if (!emailEl) { await dumpDebug(page, 'no-email-el'); throw new Error('No email element'); }
        await emailEl.fill(USERNAME).catch(e => console.warn(`[${INSTANCE}] fill email failed: ${e.message}`));
        await Promise.all([ page.click('#identifierNext').catch(()=>{}), page.waitForTimeout(1200) ]);

        try {
          await page.waitForTimeout(800);
          const useAnother = page.locator('text=Use another account');
          if (await useAnother.count() > 0) {
            try { await useAnother.first().click({ timeout: 3000 }); console.log(`[${INSTANCE}] Clicked 'Use another account'`); } catch(e){}
          }
        } catch(e){}

        try {
          await page.waitForSelector('input[type="password"]', { timeout: 20000, state: 'visible' });
        } catch (e) {
          console.warn(`[${INSTANCE}] Password input not visible: ${e.message}`);
          await dumpDebug(page, 'no-password');
        }

        const passEl = await page.$('input[type="password"]');
        if (passEl) {
          await passEl.fill(PASSWORD).catch(e => console.warn(`[${INSTANCE}] fill password failed: ${e.message}`));
          await Promise.all([ page.click('#passwordNext').catch(()=>{}), page.waitForTimeout(1500) ]);
        } else {
          console.warn(`[${INSTANCE}] Password element not found.`);
        }

        await page.waitForTimeout(2000);
      } else {
        console.log(`[${INSTANCE}] Skipping login (using storageState).`);
      }

      const cookiesOk = await hasAuthCookies(context);
      const myOk = await checkMyAccount(page);
      console.log(`[${INSTANCE}] Auth checks: cookiesOk=${cookiesOk}, myAccount=${myOk}`);
      if (!cookiesOk && !myOk && !contextOptions.storageState) {
        console.warn(`[${INSTANCE}] Login not confirmed; continuing attempt.`);
        await dumpDebug(page, 'login-not-confirmed');
      }

      console.log(`[${INSTANCE}] Navigating to target: ${TARGET_URL}`);
      await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(()=>{});
      await page.waitForTimeout(1000);

      const contClicked = await tryClickContinue(page);
      if (!contClicked) {
        await page.waitForTimeout(1500);
        if (await tryClickContinue(page)) console.log(`[${INSTANCE}] Continue clicked on retry.`);
      }

      await page.waitForTimeout(800);
      const skipped = await tryClickSkip(page);
      if (skipped) await page.waitForTimeout(800);

      const ok = await verify(page);
      if (!ok) {
        console.warn(`[${INSTANCE}] Target verification failed.`);
        await dumpDebug(page, 'verify-failed');
        return false;
      }

      const ss = `opened-${INSTANCE}-${tsNow()}.png`;
      await page.screenshot({ path: ss, fullPage: true }).catch(()=>{});
      console.log(`[${INSTANCE}] Saved screenshot: ${ss}`);
      // stay open but cancellable
      const ms = Math.max(0, KEEP_OPEN_MINUTES) * 60 * 1000;
      if (ms > 0) {
        try {
          console.log(`[${INSTANCE}] Staying open for ${KEEP_OPEN_MINUTES} minute(s).`);
          await cancellableSleep(ms);
          console.log(`[${INSTANCE}] Stay period completed.`);
        } catch (e) {
          console.warn(`[${INSTANCE}] Stay aborted: ${e.message}`);
          await dumpDebug(page, 'stay-aborted');
        }
      }
      return true;
    } catch (err) {
      console.error(`[${INSTANCE}] Run error: ${err && err.message ? err.message : err}`);
      try { await dumpDebug(page, 'run-exception'); } catch(e){}
      return false;
    }
  }

  try {
    const ok = await runOnce();
    if (!ok) process.exitCode = 2;
  } catch (e) {
    console.error(`[${INSTANCE}] Fatal: ${e && e.message ? e.message : e}`);
    process.exitCode = 2;
  } finally {
    try {
      // ensure dump on abort if possible
      if (abortRequested) {
        try { await dumpDebug(page, 'final-abort'); } catch(e) {}
      }
    } catch (e) {}
    try { await context.close(); } catch(e){}
    try { await browser.close(); } catch(e){}
  }
})();
