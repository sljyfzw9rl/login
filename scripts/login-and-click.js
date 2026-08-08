/**
 * scripts/login-and-click.js
 *
 * Playwright automation:
 * - Gunakan storageState.json jika tersedia (didecode oleh workflow dari secret GMAIL_STORAGE_STATE)
 * - Jika tidak ada storageState, coba login otomatis dengan GMAIL_USERNAME & GMAIL_PASSWORD
 * - Buka TARGET_URL, klik tombol "Continue to the app" bila muncul
 * - Verifikasi apakah berhasil sampai ke halaman target (optional EXPECTED_SELECTOR)
 * - Simpan screenshot + HTML debug jika terjadi masalah
 *
 * Environment variables expected:
 * - TARGET_URL (required)
 * - GMAIL_USERNAME (required if no storageState)
 * - GMAIL_PASSWORD (required if no storageState)
 * - GMAIL_STORAGE_STATE (optional; workflow biasanya decode ke storageState.json)
 * - INSTANCE (optional; untuk logging pada matrix jobs)
 * - EXPECTED_SELECTOR (optional; selector unik di target yang menandakan success)
 * - PLAYWRIGHT_HEADLESS (set "false" untuk debug lokal)
 */

const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const TARGET_URL = process.env.TARGET_URL;
  const USERNAME = process.env.GMAIL_USERNAME;
  const PASSWORD = process.env.GMAIL_PASSWORD;
  const INSTANCE = process.env.INSTANCE || '0';
  const EXPECTED_SELECTOR = process.env.EXPECTED_SELECTOR || '';
  const HEADLESS = process.env.PLAYWRIGHT_HEADLESS !== 'false';

  if (!TARGET_URL) {
    console.error('ERROR: TARGET_URL tidak diset. Set env TARGET_URL atau secret AI_STUDIO_URL di workflow.');
    process.exit(1);
  }

  // util helper untuk debug file names
  const tsNow = () => new Date().toISOString().replace(/[:.]/g, '-');

  // debug dump: screenshot + HTML + cookies
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

  // check if context has typical Google auth cookies
  async function hasGoogleAuthCookies(context) {
    try {
      const cookies = await context.cookies();
      const names = cookies.map(c => c.name);
      console.log(`[${INSTANCE}] Cookies on context: ${names.join(', ')}`);
      const authNames = ['SID', 'HSID', 'SAPISID', 'APISID', 'SIDCC'];
      return names.some(n => authNames.includes(n));
    } catch (e) {
      console.warn(`[${INSTANCE}] Error checking cookies: ${e.message}`);
      return false;
    }
  }

  // open myaccount.google.com to see apakah kita sudah login
  async function checkMyAccount(page) {
    try {
      await page.goto('https://myaccount.google.com', { waitUntil: 'networkidle', timeout: 15000 });
      const cur = page.url();
      console.log(`[${INSTANCE}] myaccount URL: ${cur}`);
      if (cur.includes('signin') || cur.includes('accounts.google.com/')) {
        return false;
      }
      // coba cari elemen avatar / sign out link
      const avatar = await page.$('img[alt*="Google Account"], [aria-label*="Google Account"], a[href*="Sign out"], text=Sign out');
      return !!avatar;
    } catch (e) {
      console.warn(`[${INSTANCE}] checkMyAccount error: ${e.message}`);
      return false;
    }
  }

  // klik tombol Continue modal / consent jika muncul
  async function tryClickContinueModal(page) {
    const clickSelectors = [
      'button:has-text("Continue to the app")',
      'text="Continue to the app"',
      'button:has-text("Continue")',
      'text="Continue"',
      'button[aria-label*="Continue"]',
      'button:has-text("I understand")',
    ];
    for (const sel of clickSelectors) {
      try {
        const l = page.locator(sel);
        const count = await l.count();
        if (count > 0) {
          // klik elemen pertama yang visible
          for (let i = 0; i < count; i++) {
            try {
              const el = l.nth(i);
              if (await el.isVisible()) {
                await el.click({ timeout: 7000 });
                console.log(`[${INSTANCE}] Clicked selector: ${sel}`);
                return true;
              }
            } catch (e) {
              // ignore and try next
            }
          }
        }
      } catch (e) {
        // selector syntax could fail on some cases, ignore
      }
    }
    return false;
  }

  // verifikasi target page: dengan EXPECTED_SELECTOR bila ada, atau heuristik
  async function verifyTarget(page) {
    try {
      const cur = page.url();
      console.log(`[${INSTANCE}] target page url: ${cur}`);
      if (cur.includes('accounts.google.com') || cur.includes('consent') || cur.includes('signin')) {
        console.warn(`[${INSTANCE}] Redirected to sign-in/consent page.`);
        return false;
      }
      if (EXPECTED_SELECTOR) {
        try {
          await page.waitForSelector(EXPECTED_SELECTOR, { timeout: 8000, state: 'visible' });
          console.log(`[${INSTANCE}] Found expected selector: ${EXPECTED_SELECTOR}`);
          return true;
        } catch (e) {
          console.warn(`[${INSTANCE}] Expected selector not found: ${EXPECTED_SELECTOR}`);
          return false;
        }
      }
      // fallback: cek body text tidak mengandung frasa sign-in
      const body = (await page.textContent('body')) || '';
      if (!/sign in|this app is from another developer|continue to the app|consent|authorize/i.test(body)) {
        console.log(`[${INSTANCE}] Body heuristic OK (no obvious sign-in/consent text).`);
        return true;
      }
      return false;
    } catch (e) {
      console.warn(`[${INSTANCE}] verifyTarget error: ${e.message}`);
      return false;
    }
  }

  // main flow
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  // gunakan userAgent dan viewport agar lebih mirip real browser
  const userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const contextOptions = { userAgent, viewport: { width: 1280, height: 800 } };

  // jika workflow sudah decode secret ke storageState.json, gunakan storageState
  if (fs.existsSync('storageState.json')) {
    contextOptions.storageState = 'storageState.json';
    console.log(`[${INSTANCE}] Found storageState.json — will use it for auth.`);
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  // attach console & requestfailed logs to help debugging
  page.on('console', msg => {
    try { console.log(`[console][${INSTANCE}] ${msg.type()}: ${msg.text()}`); } catch(e){}
  });
  page.on('requestfailed', req => {
    try { console.log(`[requestfailed][${INSTANCE}] ${req.method()} ${req.url()} => ${req.failure()?.errorText || 'failed'}`); } catch(e){}
  });

  try {
    // If not using storageState, attempt automated login
    if (!contextOptions.storageState) {
      if (!USERNAME || !PASSWORD) {
        throw new Error('GMAIL_USERNAME / GMAIL_PASSWORD tidak diset dan tidak ada storageState.json');
      }

      console.log(`[${INSTANCE}] Navigating to Google sign-in page...`);
      await page.goto('https://accounts.google.com/signin/v2/identifier', { waitUntil: 'networkidle', timeout: 30000 });
      console.log(`[${INSTANCE}] After nav, url=${page.url()}`);

      // tunggu beberapa possible selectors untuk email input
      try {
        const emailSelectors = '#identifierId, input[type="email"], input[name="identifier"]';
        await page.waitForSelector(emailSelectors, { timeout: 30000, state: 'visible' });
      } catch (e) {
        console.warn(`[${INSTANCE}] Email input not visible within 30s: ${e.message}`);
        await dumpDebug(page, 'no-email-input');
        throw e;
      }

      // pilih actual element
      const emailEl = (await page.$('#identifierId')) || (await page.$('input[type="email"]')) || (await page.$('input[name="identifier"]'));
      if (!emailEl) {
        console.warn(`[${INSTANCE}] No email element found after wait`);
        await dumpDebug(page, 'no-email-element');
        throw new Error('No email element');
      }

      // fill email and click next
      await emailEl.fill(USERNAME).catch(e => { console.warn(`[${INSTANCE}] fill email failed: ${e.message}`); });
      await Promise.all([
        page.click('#identifierNext').catch(() => {}),
        page.waitForTimeout(1200)
      ]);

      // handle account chooser (if Google shows an account list)
      // If account tiles are present, try to click "Use another account" then continue
      try {
        await page.waitForTimeout(800); // small pause
        const useAnother = page.locator('text="Use another account"');
        if ((await useAnother.count()) > 0) {
          try { await useAnother.first().click({ timeout: 3000 }); console.log(`[${INSTANCE}] Clicked 'Use another account'`); } catch(e){}
        }
      } catch(e){}

      // wait for password input
      try {
        await page.waitForSelector('input[type="password"]', { timeout: 20000, state: 'visible' });
      } catch (e) {
        console.warn(`[${INSTANCE}] Password input did not appear in 20s: ${e.message}`);
        await dumpDebug(page, 'no-password-input');
        // continue anyway to try myaccount check
      }

      const passEl = await page.$('input[type="password"]');
      if (passEl) {
        await passEl.fill(PASSWORD).catch(e => { console.warn(`[${INSTANCE}] fill password failed: ${e.message}`); });
        await Promise.all([
          page.click('#passwordNext').catch(() => {}),
          page.waitForTimeout(1500)
        ]);
      } else {
        console.warn(`[${INSTANCE}] Password element not found; cannot fill password automatically.`);
      }

      // short wait and try visiting myaccount
      await page.waitForTimeout(2000);
    } else {
      console.log(`[${INSTANCE}] Using provided storageState; skipping login flow.`);
    }

    // check login status via cookies and myaccount
    const cookiesOk = await hasGoogleAuthCookies(context);
    const myAccountOk = await checkMyAccount(page);
    console.log(`[${INSTANCE}] Auth checks: cookiesOk=${cookiesOk}, myAccountOk=${myAccountOk}`);

    // If both checks fail and no storageState was used, record debug but continue to attempt target navigation
    if (!cookiesOk && !myAccountOk && !contextOptions.storageState) {
      console.warn(`[${INSTANCE}] Login does not appear confirmed. Will still attempt to open target but this may fail.`);
      await dumpDebug(page, 'login-not-confirmed');
    }

    // Navigate to target app
    console.log(`[${INSTANCE}] Navigating to target: ${TARGET_URL}`);
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => {
      console.warn(`[${INSTANCE}] Navigation to target threw: ${e.message}`);
    });

    // Try clicking continue modal if present
    let clicked = await tryClickContinueModal(page);
    if (!clicked) {
      // maybe modal content inside iframe / different timing - wait a bit then retry
      await page.waitForTimeout(2000);
      clicked = await tryClickContinueModal(page);
    }
    console.log(`[${INSTANCE}] Continue-button clicked? ${clicked}`);

    // Verify target
    const targetOk = await verifyTarget(page);
    if (!targetOk) {
      console.warn(`[${INSTANCE}] Target verification failed.`);
      await dumpDebug(page, 'target-failed');
      // also save full HTML with predictable name
      try { fs.writeFileSync(`page-${INSTANCE}-${tsNow()}.html`, await page.content()); } catch(e){}
      process.exitCode = 2;
    } else {
      console.log(`[${INSTANCE}] Target verification succeeded.`);
      // save screenshot as evidence
      const ssName = `opened-${INSTANCE}-${tsNow()}.png`;
      await page.screenshot({ path: ssName, fullPage: true }).catch(()=>{});
      console.log(`[${INSTANCE}] Saved screenshot: ${ssName}`);
    }

  } catch (err) {
    console.error(`[${INSTANCE}] Automation error:`, err && err.message ? err.message : err);
    try { await dumpDebug(page, 'exception'); } catch(e){}
    process.exitCode = 2;
  } finally {
    try { await context.close(); } catch(e){}
    await browser.close();
  }
})();
