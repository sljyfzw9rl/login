const { chromium } = require('playwright');

(async () => {
  const username = process.env.GMAIL_USERNAME;
  const password = process.env.GMAIL_PASSWORD;
  const target = process.env.TARGET_URL;
  const instance = process.env.INSTANCE || '0';

  if (!target) {
    console.error('ERROR: TARGET_URL is not set. Set AI_STUDIO_URL secret or pass TARGET_URL env.');
    process.exit(1);
  }

  const useStorage = !!process.env.GMAIL_STORAGE_STATE;

  const headless = process.env.PLAYWRIGHT_HEADLESS !== 'false';

  const browser = await chromium.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  // If a storageState file was decoded to storageState.json by the workflow step, use it
  const contextOptions = {};
  const fs = require('fs');
  if (fs.existsSync('storageState.json')) {
    contextOptions.storageState = 'storageState.json';
    console.log(`[instance ${instance}] Using storageState.json for authenticated context.`);
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  try {
    // If not using storageState, perform login using username/password
    if (!contextOptions.storageState) {
      if (!username || !password) {
        console.error('ERROR: GMAIL_USERNAME/GMAIL_PASSWORD not set and no storageState provided.');
        process.exit(1);
      }

      console.log(`[instance ${instance}] Performing Google login (automated)...`);
      await page.goto('https://accounts.google.com/signin/v2/identifier', { waitUntil: 'networkidle', timeout: 30000 });

      // Fill email
      await page.fill('input[type="email"]', username);
      await Promise.all([
        page.click('#identifierNext').catch(() => {}),
        page.waitForTimeout(1000)
      ]);

      // Wait for password field
      try {
        await page.waitForSelector('input[type="password"]', { timeout: 15000 });
      } catch (e) {
        console.warn(`[instance ${instance}] Password field did not appear within 15s — possible challenge.`);
      }

      const pwExists = await page.$('input[type="password"]');
      if (pwExists) {
        await page.fill('input[type="password"]', password);
        await Promise.all([
          page.click('#passwordNext').catch(() => {}),
          page.waitForTimeout(2000)
        ]);
      } else {
        console.warn(`[instance ${instance}] Password input not detected — login might require manual verification.`);
      }

      // Small wait then try visiting myaccount to check
      await page.waitForTimeout(3000);
      try {
        await page.goto('https://myaccount.google.com', { waitUntil: 'networkidle', timeout: 15000 });
      } catch (e) {}

      const urlAfter = page.url();
      if (urlAfter.includes('signin') || urlAfter.includes('accounts.google.com/signin')) {
        console.warn(`[instance ${instance}] Looks like login did not complete (challenge/verification).`);
      } else {
        console.log(`[instance ${instance}] Login appears successful. URL: ${urlAfter}`);
      }
    } else {
      console.log(`[instance ${instance}] Using existing authenticated session.`);
    }

    // Navigate to target
    console.log(`[instance ${instance}] Navigating to target: ${target}`);
    await page.goto(target, { waitUntil: 'networkidle', timeout: 30000 });

    // Try to click "Continue to the app" modal/button
    const clickSelectors = [
      'button:has-text("Continue to the app")',
      'text="Continue to the app"',
      'button:has-text("Continue")',
      'text="Continue"'
    ];

    let clicked = false;
    for (const sel of clickSelectors) {
      const el = await page.$(sel);
      if (el) {
        try {
          await el.click({ timeout: 5000 });
          console.log(`[instance ${instance}] Clicked button with selector: ${sel}`);
          clicked = true;
          break;
        } catch (e) {
          console.warn(`[instance ${instance}] Failed clicking selector ${sel}: ${e.message}`);
        }
      }
    }

    if (!clicked) {
      console.log(`[instance ${instance}] "Continue to the app" not found immediately — waiting and retrying.`);
      await page.waitForTimeout(3000);
      for (const sel of clickSelectors) {
        const el = await page.$(sel);
        if (el) {
          await el.click({ timeout: 5000 }).catch(() => {});
          console.log(`[instance ${instance}] Clicked on retry with selector: ${sel}`);
          clicked = true;
          break;
        }
      }
    }

    const ts = Date.now();
    const screenshotPath = `opened-${instance}-${ts}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[instance ${instance}] Screenshot saved: ${screenshotPath}`);

  } catch (err) {
    console.error(`[instance ${instance}] Automation error:`, err);
    process.exitCode = 2;
  } finally {
    await browser.close();
  }
})();
  
