/**
 * scripts/login-and-click.js
 *
 * - Supports multiple emails provided in GMAIL_USER_LIST (comma or newline separated).
 * - Picks USERNAME by INSTANCE (matrix.instance: 1 -> first email).
 * - After successful verification, keeps the page open for KEEP_OPEN_MINUTES (default 15) before closing.
 *
 * Required env:
 * - TARGET_URL
 * - GMAIL_USER_LIST (comma/newline separated) OR (fallback) GMAIL_USERNAME
 * - GMAIL_PASSWORD (if not using storageState)
 * Optional:
 * - EXPECTED_SELECTOR
 * - PLAYWRIGHT_HEADLESS ("false" for headful)
 * - KEEP_OPEN_MINUTES (default 15)
 * - INTERVAL_MINUTES, ITERATIONS (if you want repeating behavior)
 * - INSTANCE (matrix)
 */

const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const TARGET_URL = process.env.TARGET_URL;
  const GMAIL_USER_LIST = process.env.GMAIL_USER_LIST || '';
  const SINGLE_USERNAME = process.env.GMAIL_USERNAME || '';
  const PASSWORD = process.env.GMAIL_PASSWORD;
  const INSTANCE = parseInt(process.env.INSTANCE || '1', 10);
  const EXPECTED_SELECTOR = process.env.EXPECTED_SELECTOR || '';
  const HEADLESS = process.env.PLAYWRIGHT_HEADLESS !== 'false';
  const KEEP_OPEN_MINUTES = parseInt(process.env.KEEP_OPEN_MINUTES || '15', 10);

  function tsNow() { return new Date().toISOString().replace(/[:.]/g, '-'); }

  // parse list
  const emails = GMAIL_USER_LIST
    .split(/\r?\n|,/)
    .map(s => s.trim())
    .filter(Boolean);

  let USERNAME = '';
  if (emails.length > 0) {
    const idx = Math.max(0, INSTANCE - 1);
    if (idx < emails.length) {
      USERNAME = emails[idx];
    } else {
      console.warn(`Instance ${INSTANCE} has no corresponding email in GMAIL_USER_LIST (length ${emails.length}).`);
    }
  }
  if (!USERNAME && SINGLE_USERNAME) USERNAME = SINGLE_USERNAME;

  if (!TARGET_URL) {
    console.error('ERROR: TARGET_URL not set.');
    process.exit(1);
  }
  if (!USERNAME) {
    console.error('ERROR: No username determined for this instance. Set GMAIL_USER_LIST or GMAIL_USERNAME.');
    process.exit(1);
  }

  const dump = async (page, prefix) => {
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
      console.log(`[${INSTANCE}] Debug saved: ${ss}, ${html}`);
    } catch (e) { console.warn('dump failed', e.message); }
  };

  // helper checks
  async function hasAuthCookies(context) {
    try {
      const cookies = await context.cookies();
      const names = cookies.map(c => c.name);
      const authNames = ['SID','HSID','SAPISID','APISID','SIDCC'];
      return names.some(n => authNames.includes(n));
    } catch (e) { return false; }
  }

  async function checkMyAccount(page) {
    try {
      await page.goto('https://myaccount.google.com', { waitUntil: 'networkidle', timeout: 15000 });
      const cur = page.url();
      if (cur.includes('signin') || cur.includes('accounts.google.com/')) return false;
      if (await page.locator('img[alt*="Google Account"]').count() > 0) return true;
      if (await page.locator('text=Sign out').count() > 0) return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  async function clickInFrames(page, selector, opts) {
    try {
      const loc = page.locator(selector);
      if (await loc.count() > 0) {
        for (let i=0;i<await loc.count();i++){
          try { if (await loc.nth(i).isVisible()) { await loc.nth(i).click(opts); return true; } } catch(e){}
        }
      }
    } catch(e){}
    for (const f of page.frames()) {
      try {
        const fl = f.locator(selector);
        if (await fl.count()>0) {
          for (let i=0;i<await fl.count();i++){
            try { if (await fl.nth(i).isVisible()) { await fl.nth(i).click(opts); return true; } } catch(e){}
          }
        }
      } catch(e){}
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
      if (await clickInFrames(page, s, { timeout: 7000 }).catch(()=>false)) {
        console.log(`[${INSTANCE}] Clicked continue (${s})`);
        return true;
      }
    }
    return false;
  }

  async function tryClickSkip(page) {
    const sels = [ 'button:has-text("Skip")', 'text="Skip"', 'button:has-text("Skip tutorial")' ];
    for (const s of sels) {
      if (await clickInFrames(page, s, { timeout: 5000 }).catch(()=>false)) {
        console.log(`[${INSTANCE}] Clicked skip (${s})`);
        return true;
      }
    }
    return false;
  }

  async function verify(page) {
    const cur = page.url();
    if (cur.includes('accounts.google.com') || cur.includes('consent') || cur.includes('signin')) {
      console.warn('Redirected to signin/consent');
      return false;
    }
    await page.waitForLoadState('networkidle').catch(()=>{});
    await page.waitForTimeout(1500);
    if (EXPECTED_SELECTOR) {
      try {
        await page.waitForSelector(EXPECTED_SELECTOR, { timeout: 20000, state: 'visible' });
        return true;
      } catch(e) { return false; }
    }
    const body = (await page.textContent('body')) || '';
    if (!/sign in|this app is from another developer|continue to the app|consent|authorize/i.test(body)) return true;
    return false;
  }

  // Launch
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled']
  });

  const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const ctxOpts = { userAgent: ua, viewport: { width: 1280, height: 800 } };
  if (fs.existsSync('storageState.json')) { ctxOpts.storageState = 'storageState.json'; console.log('Using storageState.json'); }

  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  page.on('console', m => console.log(`[console][${INSTANCE}] ${m.type()}: ${m.text()}`));
  page.on('requestfailed', r => console.log(`[requestfailed][${INSTANCE}] ${r.method()} ${r.url()} => ${r.failure()?.errorText || 'failed'}`));

  try {
    // Login if needed
    if (!ctxOpts.storageState) {
      if (!PASSWORD) {
        console.error('GMAIL_PASSWORD not set.');
        process.exit(1);
      }
      console.log(`[${INSTANCE}] Logging in as ${USERNAME}`);
      await page.goto('https://accounts.google.com/signin/v2/identifier', { waitUntil: 'networkidle', timeout: 30000 });
      // wait for input
      await page.waitForSelector('#identifierId, input[type="email"], input[name="identifier"]', { timeout: 30000 }).catch(async (e)=>{ await dump(page,'no-email'); throw e;});
      const emailEl = (await page.$('#identifierId')) || (await page.$('input[type="email"]')) || (await page.$('input[name="identifier"]'));
      if (!emailEl) { await dump(page,'no-email-el'); throw new Error('No email element'); }
      await emailEl.fill(USERNAME).catch(()=>{});
      await Promise.all([page.click('#identifierNext').catch(()=>{}), page.waitForTimeout(1200)]);
      // maybe account chooser -> use another account
      try { const uaLoc = page.locator('text=Use another account'); if (await uaLoc.count()>0) { await uaLoc.first().click().catch(()=>{}); } } catch(e){}
      // password
      await page.waitForSelector('input[type="password"]', { timeout: 20000 }).catch(()=>{});
      const passEl = await page.$('input[type="password"]');
      if (passEl) {
        await passEl.fill(PASSWORD).catch(()=>{});
        await Promise.all([page.click('#passwordNext').catch(()=>{}), page.waitForTimeout(1500)]);
      } else {
        console.warn('Password field not found.');
      }
      await page.waitForTimeout(2000);
    } else {
      console.log('Using provided storageState.json (skip login).');
    }

    // quick auth checks
    const cookiesOk = await hasAuthCookies(context);
    const myOk = await checkMyAccount(page);
    console.log(`[${INSTANCE}] cookiesOk=${cookiesOk}, myAccount=${myOk}`);
    if (!cookiesOk && !myOk && !ctxOpts.storageState) {
      console.warn('Login not confirmed; continuing attempt.');
      await dump(page,'login-not-confirmed');
    }

    // Go to target and click continue + skip
    console.log(`[${INSTANCE}] Opening target ${TARGET_URL}`);
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(()=>{});
    await page.waitForTimeout(1000);
    await tryClickContinue(page);
    await page.waitForTimeout(800);
    await tryClickSkip(page);
    await page.waitForTimeout(1000);

    // Verify
    const ok = await verify(page);
    if (!ok) {
      console.warn(`[${INSTANCE}] Target verification failed.`);
      await dump(page,'verify-failed');
      process.exitCode = 2;
    } else {
      console.log(`[${INSTANCE}] Target verified OK. Will keep page open for ${KEEP_OPEN_MINUTES} minute(s).`);
      const ss = `opened-${INSTANCE}-${tsNow()}.png`;
      await page.screenshot({ path: ss, fullPage: true }).catch(()=>{});
      console.log(`[${INSTANCE}] Saved screenshot: ${ss}`);
      // stay open for KEEP_OPEN_MINUTES
      const ms = Math.max(0, KEEP_OPEN_MINUTES) * 60 * 1000;
      if (ms > 0) {
        await new Promise(res => setTimeout(res, ms));
      }
    }

  } catch (e) {
    console.error('Automation error:', e && e.message ? e.message : e);
    try { await dump(page,'exception'); } catch(e2){}
    process.exitCode = 2;
  } finally {
    try { await context.close(); } catch(e){}
    await browser.close();
  }
})();
