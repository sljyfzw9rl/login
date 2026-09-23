const { chromium } = require('playwright');
const fs = require('fs');

let abortRequested = false;

process.on('SIGTERM', () => {
  console.warn('SIGTERM diterima. Browser akan dihentikan dengan aman.');
  abortRequested = true;
});

process.on('SIGINT', () => {
  console.warn('SIGINT diterima. Browser akan dihentikan dengan aman.');
  abortRequested = true;
});

function now() {
  return new Date().toISOString();
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseList(value) {
  return String(value || '')
    .split(/[\r\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const timer = setInterval(() => {
      if (abortRequested) {
        clearInterval(timer);
        reject(new Error('Sleep dihentikan karena signal proses.'));
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
  const instance = Math.max(
    1,
    parseInt(process.env.INSTANCE || '1', 10)
  );

  const urls = parseList(process.env.AI_STUDIO_URL);
  const users = parseList(process.env.GMAIL_USER_LIST);

  const targetUrl = urls[instance - 1];
  const username =
    users[instance - 1] ||
    process.env.GMAIL_USERNAME ||
    '';

  const password = process.env.GMAIL_PASSWORD || '';

  const keepOpenMinutes = Math.max(
    1,
    parseInt(process.env.KEEP_OPEN_MINUTES || '350', 10)
  );

  const reloadIntervalMinutes = Math.max(
    1,
    parseInt(process.env.RELOAD_INTERVAL_MINUTES || '30', 10)
  );

  console.log(`[${instance}] Script dimulai pada ${now()}`);
  console.log(`[${instance}] Jumlah URL terdeteksi: ${urls.length}`);
  console.log(`[${instance}] Durasi aktif: ${keepOpenMinutes} menit`);
  console.log(`[${instance}] Interval reload: ${reloadIntervalMinutes} menit`);

  if (!targetUrl) {
    console.log(
      `[${instance}] Tidak ada URL untuk instance ini. Selesai tanpa error.`
    );
    process.exit(0);
  }

  const hasStorageState = fs.existsSync('storageState.json');

  if (!username && !hasStorageState) {
    throw new Error(
      'GMAIL_USERNAME atau GMAIL_USER_LIST wajib diisi jika GMAIL_STORAGE_STATE tidak digunakan.'
    );
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const contextOptions = {
    viewport: {
      width: 1280,
      height: 800
    },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
  };

  if (hasStorageState) {
    contextOptions.storageState = 'storageState.json';
    console.log(`[${instance}] Menggunakan storageState.json`);
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  page.on('console', (message) => {
    console.log(
      `[browser-${instance}] ${message.type()}: ${message.text()}`
    );
  });

  page.on('requestfailed', (request) => {
    console.warn(
      `[${instance}] Request gagal: ${request.method()} ${request.url()}`
    );
  });

  async function saveDebug(label) {
    const prefix = `debug-${instance}-${label}-${timestamp()}`;

    try {
      await page.screenshot({
        path: `${prefix}.png`,
        fullPage: true
      });
    } catch (error) {
      console.warn(`[${instance}] Gagal menyimpan screenshot debug.`);
    }

    try {
      const html = await page.content();
      fs.writeFileSync(`${prefix}.html`, html);
    } catch (error) {
      console.warn(`[${instance}] Gagal menyimpan HTML debug.`);
    }

    try {
      const cookies = await context.cookies();
      fs.writeFileSync(
        `${prefix}-cookies.json`,
        JSON.stringify(cookies, null, 2)
      );
    } catch (error) {
      console.warn(`[${instance}] Gagal menyimpan cookies debug.`);
    }
  }

  async function clickText(texts) {
    for (const text of texts) {
      for (const frame of page.frames()) {
        try {
          const locator = frame
            .getByText(text, { exact: false })
            .first();

          if (await locator.isVisible({ timeout: 1500 })) {
            await locator.click({ timeout: 5000 });
            console.log(`[${instance}] Berhasil klik: ${text}`);
            return true;
          }
        } catch (error) {
          // Coba selector berikutnya.
        }
      }
    }

    return false;
  }

  async function handleContinueAndSkip() {
    await clickText([
      'Continue to the app',
      'Continue'
    ]);

    await page.waitForTimeout(1000);

    await clickText([
      'Skip tutorial',
      'Skip tour',
      'Skip'
    ]);
  }

  async function login() {
    if (hasStorageState) {
      console.log(`[${instance}] Login dilewati karena storageState tersedia.`);
      return;
    }

    if (!password) {
      throw new Error(
        'GMAIL_PASSWORD wajib diisi jika GMAIL_STORAGE_STATE tidak tersedia.'
      );
    }

    console.log(`[${instance}] Membuka halaman login Google.`);

    await page.goto(
      'https://accounts.google.com/signin/v2/identifier',
      {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      }
    );

    const emailInput = page
      .locator('#identifierId, input[type="email"]')
      .first();

    await emailInput.waitFor({
      state: 'visible',
      timeout: 30000
    });

    await emailInput.fill(username);

    await page
      .locator('#identifierNext')
      .click()
      .catch(() => {});

    await page.waitForTimeout(2000);

    const passwordInput = page
      .locator('input[type="password"]')
      .first();

    await passwordInput.waitFor({
      state: 'visible',
      timeout: 30000
    });

    await passwordInput.fill(password);

    await page
      .locator('#passwordNext')
      .click()
      .catch(() => {});

    await page.waitForTimeout(5000);

    console.log(`[${instance}] Proses login selesai.`);
  }

  async function openTarget() {
    console.log(`[${instance}] Membuka URL: ${targetUrl}`);

    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForTimeout(3000);
    await handleContinueAndSkip();
  }

  async function isTargetValid() {
    const currentUrl = page.url();

    if (
      /accounts\.google\.com|signin|consent/i.test(currentUrl)
    ) {
      return false;
    }

    const bodyText = await page
      .locator('body')
      .textContent()
      .catch(() => '');

    if (
      /sign in|authorize|consent|continue to the app/i.test(
        bodyText || ''
      )
    ) {
      return false;
    }

    return true;
  }

  try {
    await login();
    await openTarget();

    if (!(await isTargetValid())) {
      await saveDebug('initial-invalid');
      throw new Error('Halaman target tidak valid setelah dibuka.');
    }

    await page
      .screenshot({
        path: `opened-${instance}-${timestamp()}.png`,
        fullPage: true
      })
      .catch(() => {});

    const endAt =
      Date.now() + keepOpenMinutes * 60 * 1000;

    let nextReloadAt =
      Date.now() + reloadIntervalMinutes * 60 * 1000;

    console.log(
      `[${instance}] Browser akan aktif sampai ${new Date(endAt).toISOString()}`
    );

    while (!abortRequested && Date.now() < endAt) {
      const remainingUntilReload =
        nextReloadAt - Date.now();

      const remainingUntilEnd =
        endAt - Date.now();

      const waitTime = Math.min(
        30000,
        Math.max(
          1000,
          remainingUntilReload,
          remainingUntilEnd
        )
      );

      await sleep(waitTime);

      if (abortRequested || Date.now() >= endAt) {
        break;
      }

      if (Date.now() >= nextReloadAt) {
        console.log(
          `[${instance}] Reload halaman pada ${now()}`
        );

        try {
          await page.reload({
            waitUntil: 'domcontentloaded',
            timeout: 60000
          });

          await page.waitForTimeout(3000);
          await handleContinueAndSkip();

          const valid = await isTargetValid();

          if (!valid) {
            console.warn(
              `[${instance}] Halaman tidak valid setelah reload. Membuka ulang URL.`
            );

            await openTarget();
          }
        } catch (error) {
          console.warn(
            `[${instance}] Reload gagal: ${error.message}`
          );

          try {
            await openTarget();
          } catch (reopenError) {
            console.warn(
              `[${instance}] Gagal membuka ulang halaman: ${reopenError.message}`
            );

            await saveDebug('reload-failed');
          }
        }

        nextReloadAt =
          Date.now() + reloadIntervalMinutes * 60 * 1000;
      }
    }

    console.log(
      `[${instance}] Keepalive selesai pada ${now()}`
    );
  } catch (error) {
    console.error(
      `[${instance}] Error: ${error.stack || error}`
    );

    await saveDebug('error').catch(() => {});
    process.exitCode = 2;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});

    console.log(`[${instance}] Browser ditutup.`);
  }
})();
