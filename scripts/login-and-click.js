'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

let stopRequested = false;

process.on('SIGTERM', () => {
  stopRequested = true;
});

process.on('SIGINT', () => {
  stopRequested = true;
});

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
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (stopRequested || Date.now() >= Date.now() + ms) {
        clearInterval(timer);
        resolve();
      }
    }, 1000);

    setTimeout(() => {
      clearInterval(timer);
      resolve();
    }, ms);
  });
}

async function saveScreenshot(page, emailIndex, urlIndex, label) {
  const filename =
    `screenshot-email-${emailIndex}-url-${urlIndex}-${label}-${timestamp()}.png`;

  await page.screenshot({
    path: filename,
    fullPage: true
  }).catch(() => {});

  return filename;
}

async function clickContinue(page, emailIndex, urlIndex) {
  const candidates = [
    'text=Continue to the app',
    'button:has-text("Continue to the app")',
    'text=Continue',
    'button:has-text("Continue")'
  ];

  for (const selector of candidates) {
    const locator = page.locator(selector).first();

    if (
      await locator.isVisible({ timeout: 1500 }).catch(() => false)
    ) {
      await locator.click({ timeout: 5000 }).catch(() => {});

      console.log(
        `[email:${emailIndex}][url:${urlIndex}] Continue diklik.`
      );

      await page.waitForTimeout(3000);
      return true;
    }
  }

  return false;
}

async function clickSkip(page, emailIndex, urlIndex) {
  const candidates = [
    'text=Skip',
    'button:has-text("Skip")',
    'text=Skip tutorial',
    'button:has-text("Skip tutorial")'
  ];

  for (const selector of candidates) {
    const locator = page.locator(selector).first();

    if (
      await locator.isVisible({ timeout: 1500 }).catch(() => false)
    ) {
      await locator.click({ timeout: 5000 }).catch(() => {});

      console.log(
        `[email:${emailIndex}][url:${urlIndex}] Skip diklik.`
      );

      await page.waitForTimeout(2000);
      return true;
    }
  }

  return false;
}

async function openApplication(page, targetUrl, emailIndex, urlIndex) {
  console.log(
    `[email:${emailIndex}][url:${urlIndex}] Membuka ${targetUrl}`
  );

  await page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForTimeout(10000);

  await clickContinue(page, emailIndex, urlIndex);
  await clickSkip(page, emailIndex, urlIndex);

  await page.waitForTimeout(5000);
}

async function isLoginPage(page) {
  const currentUrl = page.url();

  if (
    /accounts\.google\.com\/(signin|ServiceLogin|challenge)/i
      .test(currentUrl)
  ) {
    return true;
  }

  const loginSelectors = [
    '#identifierId',
    'input[type="email"]',
    'input[type="password"]'
  ];

  for (const selector of loginSelectors) {
    const count = await page.locator(selector).count().catch(() => 0);

    for (let index = 0; index < count; index += 1) {
      if (
        await page
          .locator(selector)
          .nth(index)
          .isVisible()
          .catch(() => false)
      ) {
        return true;
      }
    }
  }

  return false;
}

async function runSession({
  browser,
  storageState,
  targetUrl,
  emailIndex,
  urlIndex,
  keepOpenMinutes,
  reloadIntervalMinutes
}) {
  const contextOptions = {
    viewport: {
      width: 1280,
      height: 800
    }
  };

  /*
   * Setiap URL mendapat context sendiri.
   * Context tidak dibagikan dengan URL lain.
   */
  if (storageState) {
    contextOptions.storageState = storageState;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  page.on('requestfailed', (request) => {
    const requestUrl = request.url();

    /*
     * Request analytics/telemetry tidak dijadikan kegagalan session.
     */
    if (
      /google-analytics|doubleclick|googletagmanager|analytics\.google/i
        .test(requestUrl)
    ) {
      return;
    }

    console.warn(
      `[email:${emailIndex}][url:${urlIndex}] ` +
      `Request gagal: ${request.method()} ${requestUrl.slice(0, 250)}`
    );
  });

  try {
    await openApplication(
      page,
      targetUrl,
      emailIndex,
      urlIndex
    );

    if (await isLoginPage(page)) {
      await saveScreenshot(
        page,
        emailIndex,
        urlIndex,
        'login-required'
      );

      throw new Error(
        'Storage state tidak valid atau akun memerlukan login/verifikasi manual.'
      );
    }

    await saveScreenshot(
      page,
      emailIndex,
      urlIndex,
      'opened'
    );

    const sessionEnd =
      Date.now() + keepOpenMinutes * 60 * 1000;

    let nextReload =
      Date.now() + reloadIntervalMinutes * 60 * 1000;

    console.log(
      `[email:${emailIndex}][url:${urlIndex}] ` +
      'Context terisolasi aktif.'
    );

    while (!stopRequested && Date.now() < sessionEnd) {
      const untilReload = nextReload - Date.now();
      const untilEnd = sessionEnd - Date.now();

      const waitTime = Math.min(
        30000,
        Math.max(1000, Math.min(untilReload, untilEnd))
      );

      await new Promise((resolve) => setTimeout(resolve, waitTime));

      if (stopRequested || Date.now() >= sessionEnd) {
        break;
      }

      if (Date.now() >= nextReload) {
        console.log(
          `[email:${emailIndex}][url:${urlIndex}] Reload.`
        );

        try {
          await page.reload({
            waitUntil: 'domcontentloaded',
            timeout: 60000
          });

          await page.waitForTimeout(10000);
          await clickContinue(page, emailIndex, urlIndex);
          await clickSkip(page, emailIndex, urlIndex);

          if (await isLoginPage(page)) {
            await saveScreenshot(
              page,
              emailIndex,
              urlIndex,
              'login-after-reload'
            );

            console.warn(
              `[email:${emailIndex}][url:${urlIndex}] ` +
              'Session kembali ke halaman login.'
            );
          } else {
            await saveScreenshot(
              page,
              emailIndex,
              urlIndex,
              'reload'
            );
          }
        } catch (error) {
          console.warn(
            `[email:${emailIndex}][url:${urlIndex}] ` +
            `Reload gagal: ${error.message}`
          );
        }

        nextReload =
          Date.now() + reloadIntervalMinutes * 60 * 1000;
      }
    }

    console.log(
      `[email:${emailIndex}][url:${urlIndex}] Context selesai.`
    );
  } catch (error) {
    console.error(
      `[email:${emailIndex}][url:${urlIndex}] ${error.message}`
    );

    await saveScreenshot(
      page,
      emailIndex,
      urlIndex,
      'error'
    );
  } finally {
    await context.close().catch(() => {});
  }
}

(async () => {
  const emailIndex = Math.max(
    1,
    parseInt(process.env.EMAIL_INDEX || '1', 10)
  );

  const urls = parseList(process.env.AI_STUDIO_URL);

  const keepOpenMinutes = Math.max(
    1,
    parseInt(process.env.KEEP_OPEN_MINUTES || '350', 10)
  );

  const reloadIntervalMinutes = Math.max(
    1,
    parseInt(process.env.RELOAD_INTERVAL_MINUTES || '30', 10)
  );

  if (urls.length === 0) {
    throw new Error('AI_STUDIO_URL kosong.');
  }

  const targetUrls = Array.from(
    { length: 5 },
    (_, index) => urls[index % urls.length]
  );

  /*
   * Satu storageState yang sudah diotorisasi digunakan sebagai
   * titik awal tiap context. Context tetap terisolasi satu sama lain.
   */
  const storageStatePath = path.resolve('storageState.json');

  if (!fs.existsSync(storageStatePath)) {
    throw new Error(
      'storageState.json tidak ditemukan. ' +
      'Buat session Google secara manual terlebih dahulu.'
    );
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  console.log(
    `[email:${emailIndex}] Menjalankan 5 context terisolasi.`
  );

  console.log('TOTAL_ISOLATED_SESSIONS=5');

  try {
    await Promise.all(
      targetUrls.map((targetUrl, index) =>
        runSession({
          browser,
          storageState: storageStatePath,
          targetUrl,
          emailIndex,
          urlIndex: index + 1,
          keepOpenMinutes,
          reloadIntervalMinutes
        })
      )
    );
  } finally {
    await browser.close().catch(() => {});
  }
})();
