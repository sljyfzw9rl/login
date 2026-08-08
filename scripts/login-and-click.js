/**
 * scripts/login-and-click.js
 *
 * Robust Playwright script to:
 * - use storageState.json if available (created by scripts/save-state.js),
 * - otherwise perform automated Google login with GMAIL_USERNAME/GMAIL_PASSWORD,
 * - open TARGET_URL, click "Continue to the app" (if present),
 * - click "Skip" (tutorial) or other onboarding buttons if present,
 * - optionally run in a loop (INTERVAL_MINUTES, ITERATIONS) to "stay" and refresh,
 * - verify the app is ready via EXPECTED_SELECTOR (recommended),
 * - save screenshots / HTML / cookie dumps for debugging.
 *
 * Environment:
 * - TARGET_URL (required)
 * - GMAIL_USERNAME (required if no storageState)
 * - GMAIL_PASSWORD (required if no storageState)
 * - EXPECTED_SELECTOR (optional but recommended)
 * - GMAIL_STORAGE_STATE (optional if workflow decodes it to storageState.json)
 * - INTERVAL_MINUTES (optional, default 15)
 * - ITERATIONS (optional, default 1) - set >1 to loop multiple times; set 0 to loop indefinitely (not recommended on GitHub hosted runners)
 * - PLAYWRIGHT_HEADLESS ("false" for headful debug)
 * - INSTANCE (optional, for logs in matrix)
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
  const INTERVAL_MINUTES = parseInt(process.env.INTERVAL_MINUTES || '15', 10);
  let ITERATIONS = process.env.ITERATIONS !== undefined ? parseInt(process.env.ITERATIONS, 10) : 1;
  if (Number.isNaN(ITERATIONS)) ITERATIONS = 1;

  if (!TARGET_URL) {
    console.error('ERROR: TARGET_URL tidak diset. Set env TARGET_URL atau secret AI_STUDIO_URL di workflow.');
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

  async function hasGoogleAuthCookies(context) {
    try {
      const cookies = await context.cookies();
      const names = cookies.map(c => c.name);
      console.log(`[${INSTANCE}] Cookies: ${names.join(', ')}`);
      const authNames = ['SID', 'HSID', 'SAPISID', 'APISID', 'SIDCC'];
      return names.some(n => authNames.includes(n));
    } catch (e) {
      console.warn(`[${INSTANCE}] Error checking cookies: ${e.message}`);
      return false;
    }
  }

  // safer check for logged-in state on myaccount
  async function checkMyAccount(page) {
    try {
      await page.goto('https://myaccount.google.com', { waitUntil: 'networkidle', timeout: 15000 });
      const cur = page.url();
      console.log(`[${INSTANCE}] myaccount URL: ${cur}`);
      if (cur.includes('signin') || cur.includes('accounts.google.com/')) return false;
      // use locators (text selectors) which are supported
      const avatarCount = await page.locator('img[alt*="Google Account"]').count();
      if (avatarCount > 0) return true;
      const signOutCount = await page.locator('text=Sign out').count();
      if (signOutCount > 0) return true;
      return false;
    } catch (e) {
      console.warn(`[${INSTANCE}] checkMyAccount error: ${e.message}`);
      return false;
    }
  }

  // try click element in main page and in iframes
  async function tryClickInFrames(page, selector, options = {}) {
    // try on main page first
    try {
      const loc = page.locator(selector);
      if (await loc.count() > 0) {
        for (let i = 0; i < await loc.count(); i++) {
          try {
            const el = loc.nth(i);
            if (await el.isVisible()) {
              await el.click(options);
              return true;
            }
          } catch (e) {
            // continue to next
          }
        }
      }
    } catch (e) {
      // ignore
    }

    // try in frames
    for (const frame of page.frames()) {
      try {
        const fLoc = frame.locator(selector);
        if (await fLoc.count() > 0) {
          for (let i = 0; i < await fLoc.count(); i++) {
            try {
              const fel = fLoc.nth(i);
              if (await fel.isVisible()) {
                await fel.click(options);
                return true;
              }
            } catch (e) {}
          }
        }
      } catch (e) {}
    }
    return false;
  }

  async function tryClickContinueModal(page) {
    const clickSelectors = [
      'button:has-text("Continue to the app")',
      'text="Continue to the app"',
      'button:has-text("Continue")',
      'text="Continue"',
      'button[aria-label*="Continue"]'
    ];
    for (const sel of clickSelectors) {
      const ok = await tryClickInFrames(page, sel, { timeout: 7000 }).catch(()=>false);
      if (ok) {
        console.log(`[${INSTANCE}] Clicked continue/modal with selector: ${sel}`);
        return true;
      }
    }
    return false;
  }

  async function tryClickSkipTutorial(page) {
    const skipSelectors = [
      'button:has-text("Skip")',
      'text="Skip"',
      'button:has-text("Skip tutorial")',
      'button:has-text("Skip tour")'
    ];
    for (const sel of skipSelectors) {
      const ok = await tryClickInFrames(page, sel, { timeout: 5000 }).catch(()=>false);
      if (ok) {
        console.log(`[${INSTANCE}] Clicked Skip using selector: ${sel}`);
        return true;
      }
    }
    return false;
  }

  async function verifyTarget(page) {
    try {
      const cur = page.url();
      console.log(`[${INSTANCE}] target page url: ${cur}`);
      if (cur.includes('accounts.google.com') || cur.includes('consent') || cur.includes('signin')) {
        console.warn(`[${INSTANCE}] Redirected to sign-in/consent page.`);
        return false;
      }

      // wait small time for app to initialize
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(()=>{});
      await page.waitForTimeout(2000);

      if (EXPECTED_SELECTOR) {
        try {
          await page.waitForSelector(EXPECTED_SELECTOR, { timeout: 20000, state: 'visible' });
          console.log(`[${INSTANCE}] Found expected selector: ${EXPECTED_SELECTOR}`);
          return true;
        } catch (e) {
          console.warn(`[${INSTANCE}] Expected selector not found: ${EXPECTED_SELECTOR}`);
          // dump later by caller
          return false;
        }
      }

      // fallback heuristic: ensure modal/consent strings are gone
      const body = (await page.textContent('body')) || '';
      if (!/sign in|this app is from another developer|continue to the app|consent|authorize/i.test(body)) {
        console.log(`[${INSTANCE}] Body heuristic OK (no obvious sign-in/consent text).`);
        return true;
      }

      console.warn(`[${INSTANCE}] Heuristic indicates target not ready.`);
      return false;
    } catch (e) {
      console.warn(`[${INSTANCE}] verifyTarget error: ${e.message}`);
      return false;
    }
  }

  // launch browser
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

  // debug listeners
  page.on('console', msg => {
    try { console.log(`[console][${INSTANCE}] ${msg.type()}: ${msg.text()}`); } catch(e){}
  });
  page.on('requestfailed', req => {
    try { console.log(`[requestfailed][${INSTANCE}] ${req.method()} ${req.url()} => ${req.failure()?.errorText || 'failed'}`); } catch(e){}
  });

  // helper for a single full iteration (login + open + click + verify)
  async function runIteration(iterIdx) {
    console.log(`[${INSTANCE}] Iteration ${iterIdx} start`);
    try {
      // login if no storage state
      if (!contextOptions.storageState) {
        if (!USERNAME || !PASSWORD) {
          throw new Error('GMAIL_USERNAME / GMAIL_PASSWORD tidak diset and no storageState.json available.');
        }

        console.log(`[${INSTANCE}] Navigating to Google sign-in...`);
        await page.goto('https://accounts.google.com/signin/v2/identifier', { waitUntil: 'networkidle', timeout: 30000 });
        console.log(`[${INSTANCE}] After nav: ${page.url()}`);

        // wait robust selectors for email
        try {
          await page.waitForSelector('#identifierId, input[type="email"], input[name="identifier"]', { timeout: 30000, state: 'visible' });
        } catch (e) {
          console.warn(`[${INSTANCE}] Email input not visible: ${e.message}`);
          await dumpDebug(page, 'no-email-input');
          throw e;
        }

        const emailEl = (await page.$('#identifierId')) || (await page.$('input[type="email"]')) || (await page.$('input[name="identifier"]'));
        if (!emailEl) {
          await dumpDebug(page, 'no-email-element');
          throw new Error('No email input found');
        }

        await emailEl.fill(USERNAME).catch(e => console.warn(`[${INSTANCE}] fill email failed: ${e.message}`));
        await Promise.all([
          page.click('#identifierNext').catch(()=>{}),
          page.waitForTimeout(1200)
        ]);

        // handle "Use another account" if account chooser appears
        try {
          await page.waitForTimeout(800);
          const useAnother = page.locator('text=Use another account');
          if (await useAnother.count() > 0) {
            try { await useAnother.first().click({ timeout: 3000 }); console.log(`[${INSTANCE}] Clicked 'Use another account'`); } catch(e){}
          }
        } catch(e){}

        // wait for password field
        try {
          await page.waitForSelector('input[type="password"]', { timeout: 20000, state: 'visible' });
        } catch (e) {
          console.warn(`[${INSTANCE}] Password input did not appear: ${e.message}`);
          await dumpDebug(page, 'no-password-input');
        }

        const passEl = await page.$('input[type="password"]');
        if (passEl) {
          await passEl.fill(PASSWORD).catch(e => console.warn(`[${INSTANCE}] fill password failed: ${e.message}`));
          await Promise.all([
            page.click('#passwordNext').catch(()=>{}),
            page.waitForTimeout(1500)
          ]);
        } else {
          console.warn(`[${INSTANCE}] Password element not found; automated login may fail.`);
        }

        await page.waitForTimeout(2000);
      } else {
        console.log(`[${INSTANCE}] Skipping login (using storageState).`);
      }

      // quick auth checks
      const cookiesOk = await hasGoogleAuthCookies(context);
      const myAcctOk = await checkMyAccount(page);
      console.log(`[${INSTANCE}] Auth checks: cookiesOk=${cookiesOk}, myAccountOk=${myAcctOk}`);
      if (!cookiesOk && !myAcctOk && !contextOptions.storageState) {
        console.warn(`[${INSTANCE}] Login not confirmed; continuing to attempt opening target (may fail).`);
        await dumpDebug(page, 'login-not-confirmed');
      }

      // navigate to target app
      console.log(`[${INSTANCE}] Navigating to target: ${TARGET_URL}`);
      await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(()=>{});
      await page.waitForTimeout(1200);

      // click continue modal if present
      const contClicked = await tryClickContinueModal(page);
      if (!contClicked) {
        // wait a bit and retry
        await page.waitForTimeout(1500);
        if (await tryClickContinueModal(page)) {
          console.log(`[${INSTANCE}] Continue clicked on retry.`);
        }
      }

      // after continue, try skip tutorial/onboarding
      await page.waitForTimeout(800);
      const skipped = await tryClickSkipTutorial(page);
      if (skipped) {
        await page.waitForTimeout(800);
      }

      // verify
      const ok = await verifyTarget(page);
      if (!ok) {
        console.warn(`[${INSTANCE}] Verification failed for target.`);
        await dumpDebug(page, 'target-failed');
        return false;
      }

      // save success screenshot and return success
      const ss = `opened-${INSTANCE}-${tsNow()}.png`;
      await page.screenshot({ path: ss, fullPage: true }).catch(()=>{});
      console.log(`[${INSTANCE}] Success screenshot saved: ${ss}`);
      return true;

    } catch (err) {
      console.error(`[${INSTANCE}] Iteration error: ${err && err.message ? err.message : err}`);
      try { await dumpDebug(page, 'iteration-exception'); } catch(e){}
      return false;
    }
  }

  try {
    // If ITERATIONS is 0, treat as infinite loop (Github hosted runners have max 360 minutes)
    let iteration = 0;
    while (ITERATIONS === 0 || iteration < ITERATIONS) {
      iteration++;
      const ok = await runIteration(iteration);
      if (!ok) {
        console.warn(`[${INSTANCE}] Iteration ${iteration} reported failure.`);
        // don't abort immediately; continue according to your needs. Here we'll continue.
      } else {
        console.log(`[${INSTANCE}] Iteration ${iteration} succeeded.`);
      }

      if (ITERATIONS === 0 || iteration < ITERATIONS) {
        console.log(`[${INSTANCE}] Sleeping ${INTERVAL_MINUTES} minute(s) before next iteration.`);
        // sleep
        await new Promise(res => setTimeout(res, INTERVAL_MINUTES * 60 * 1000));
      } else {
        break;
      }
    }
  } catch (e) {
    console.error(`[${INSTANCE}] Fatal error: ${e && e.message ? e.message : e}`);
    process.exitCode = 2;
  } finally {
    try { await context.close(); } catch(e){}
    await browser.close();
  }
})();
