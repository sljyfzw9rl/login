const { chromium } = require('playwright');
const fs = require('fs');

let abortRequested = false;

process.on('SIGTERM', () => {
  console.warn('SIGTERM diterima.');
  abortRequested = true;
});

process.on('SIGINT', () => {
  console.warn('SIGINT diterima.');
  abortRequested = true;
});

function now() {
  return new Date().toISOString();
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseList(value) {
  return String(value || '')
    .split(/[\r\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseAccounts(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const separatorIndex = line.indexOf(':');

      if (separatorIndex <= 0) {
        throw new Error(
          `Format akun invalid pada baris ${index + 1}. Gunakan format email:password`
        );
      }

      return {
        email: line.slice(0, separatorIndex).trim(),
        password: line.slice(separatorIndex + 1).trim()
      };
    });
}

function sleep(ms) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const timer = setInterval(() => {
      if (abortRequested) {
        clearInterval(timer);
        reject(new Error('Sleep dibatalkan karena signal.'));
        return;
      }

      if (Date.now() - startedAt >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, 1000);
  });
}

(async () => {
  const emailIndex = Math.max(1, parseInt(process.env.EMAIL_INDEX || '1', 10));
  const urlIndex = Math.max(1, parseInt(process.env.URL_INDEX || '1', 10));

  const accounts = parseAccounts(process.env.GMAIL_ACCOUNT_LIST);
  const urls = parseList(process.env.AI_STUDIO_URL);

  const account = accounts[emailIndex - 1];
  const targetUrl = urls[urlIndex - 1];

  if (!account) {
    throw new Error(
      `Akun index ${emailIndex} tidak ditemukan. Total akun: ${accounts.length}`
    );
  }

  if (!targetUrl) {
    throw new Error(
      `URL index ${urlIndex} tidak ditemukan. Total URL: ${urls.length}`
    );
  }

  const username = account.email;
  const password = account.password;

  const keepOpenMinutes = Math.max(
    1,
    parseInt(process.env.KEEP_OPEN_MINUTES || '350', 10)
  );

  const reloadIntervalMinutes = Math.max(
    1,
    parseInt(process.env.RELOAD_INTERVAL_MINUTES || '30', 10)
  );

  console.log(`[email:${emailIndex}][url:${urlIndex}] username: ${username}`);
  console.log(`[email:${emailIndex}][url:${urlIndex}] target: ${targetUrl}`);
  console.log(`[email:${emailIndex}][url:${urlIndex}] keep: ${keepOpenMinutes} menit`);
  console.log(`[email:${emailIndex}][url:${urlIndex}] reload: ${reloadIntervalMinutes} menit`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const hasStorageState = fs.existsSync('storageState.json');

  const contextOptions = {
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };

  if (hasStorageState) {
    contextOptions.storageState = 'storageState.json';
    console.log(`[email:${emailIndex}][url:${urlIndex}] memakai storageState.json`);
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  async function saveDebug(label) {
    const prefix = `debug-email-${emailIndex}-url-${urlIndex}-${label}-${stamp()}`;

    try {
      await page.screenshot({ path: `${prefix}.png`, fullPage: true });
    } catch (err) {
      console.warn(`[email:${emailIndex}][url:${urlIndex}] screenshot debug gagal`);
    }

    try {
      const html = await page.content();
      fs.writeFileSync(`${prefix}.html`, html);
    } catch (err) {
      console.warn(`[email:${emailIndex}][url:${urlIndex}] html debug gagal`);
    }

    try {
      const cookies = await context.cookies();
      fs.writeFileSync(`${prefix}-cookies.json`, JSON.stringify(cookies, null, 2));
    } catch (err) {
      console.warn(`[email:${emailIndex}][url:${urlIndex}] cookies debug gagal`);
    }
  }

  async function clickAnyText(values) {
    for (const val of values) {
      for (const frame of page.frames()) {
        try {
          const locator = frame.getByText(val, { exact: false }).first();

          if (await locator.isVisible({ timeout: 1500 })) {
            await locator.click({ timeout: 5000 });
            console.log(`[email:${emailIndex}][url:${urlIndex}] klik: ${val}`);
            return true;
          }
        } catch (err) {
          // lanjut
        }
      }
    }
    return false;
  }

  async function handleContinueAndSkip() {
    await clickAnyText(['Continue to the app', 'Continue']);
    await page.waitForTimeout(1000);
    await clickAnyText(['Skip tutorial', 'Skip tour', 'Skip']);
    await page.waitForTimeout(1000);
  }

  async function loginGoogle() {
    if (hasStorageState) {
      console.log(`[email:${emailIndex}][url:${urlIndex}] login dilewati karena storageState tersedia`);
      return;
    }

    if (!username || !password) {
      throw new Error('Email atau password akun tidak tersedia.');
    }

    await page.goto(
      'https://accounts.google.com/signin/v2/identifier',
      {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      }
    );

    const emailInput = page.locator('#identifierId, input[type="email"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 30000 });
    await emailInput.fill(username);

    await page.locator('#identifierNext').click().catch(() => {});
    await page.waitForTimeout(1500);

    const passwordInput = page.locator('input[type="password"]').first();
    await passwordInput.waitFor({ state: 'visible', timeout: 30000 });
    await passwordInput.fill(password);

    await page.locator('#passwordNext').click().catch(() => {});
    await page.waitForTimeout(5000);

    console.log(`[email:${emailIndex}][url:${urlIndex}] login selesai`);
  }

  async function openTarget() {
    console.log(`[email:${emailIndex}][url:${urlIndex}] buka target: ${targetUrl}`);

    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForTimeout(3000);
    await handleContinueAndSkip();
  }

  async function isTargetValid() {
    const currentUrl = page.url();

    if (/accounts\.google\.com|signin|consent/i.test(currentUrl)) {
      return false;
    }

    const bodyText = await page.locator('body').textContent().catch(() => '');

    if (/sign in|authorize|consent|continue to the app/i.test(bodyText || '')) {
      return false;
    }

    return true;
  }

  try {
    await loginGoogle();
    await openTarget();

    if (!(await isTargetValid())) {
      await saveDebug('initial-invalid');
      throw new Error('Target invalid setelah dibuka');
    }

    await page.screenshot({
      path: `opened-email-${emailIndex}-url-${urlIndex}-${stamp()}.png`,
      fullPage: true
    }).catch(() => {});

    const endAt = Date.now() + keepOpenMinutes * 60 * 1000;
    let nextReloadAt = Date.now() + reloadIntervalMinutes * 60 * 1000;

    console.log(`[email:${emailIndex}][url:${urlIndex}] browser aktif sampai ${new Date(endAt).toISOString()}`);

    while (!abortRequested && Date.now() < endAt) {
      const remainingUntilReload = nextReloadAt - Date.now();
      const remainingUntilEnd = endAt - Date.now();

      const waitTime = Math.min(
        30000,
        Math.max(1000, remainingUntilReload, remainingUntilEnd)
      );

      await sleep(waitTime);

      if (abortRequested || Date.now() >= endAt) {
        break;
      }

      if (Date.now() >= nextReloadAt) {
        console.log(`[email:${emailIndex}][url:${urlIndex}] reload halaman pada ${now()}`);

        try {
          await page.reload({
            waitUntil: 'domcontentloaded',
            timeout: 60000
          });

          await page.waitForTimeout(3000);
          await handleContinueAndSkip();

          if (!(await isTargetValid())) {
            console.warn(`[email:${emailIndex}][url:${urlIndex}] halaman setelah reload tidak valid, buka lagi target`);
            await openTarget();
          }
        } catch (error) {
          console.warn(`[email:${emailIndex}][url:${urlIndex}] reload gagal: ${error.message}`);

          try {
            await openTarget();
          } catch (reopenError) {
            console.warn(`[email:${emailIndex}][url:${urlIndex}] gagal buka ulang: ${reopenError.message}`);
            await saveDebug('reload-failed');
          }
        }

        nextReloadAt = Date.now() + reloadIntervalMinutes * 60 * 1000;
      }
    }

    console.log(`[email:${emailIndex}][url:${urlIndex}] keepalive selesai`);
  } catch (error) {
    console.error(`[email:${emailIndex}][url:${urlIndex}] error: ${error.stack || error}`);
    await saveDebug('error').catch(() => {});
    process.exitCode = 2;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    console.log(`[email:${emailIndex}][url:${urlIndex}] browser ditutup`);
  }
})();
