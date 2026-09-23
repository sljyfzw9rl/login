'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

let stopRequested = false;

process.on('SIGTERM', () => {
  console.warn('SIGTERM diterima.');
  stopRequested = true;
});

process.on('SIGINT', () => {
  console.warn('SIGINT diterima.');
  stopRequested = true;
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

function parseAccounts(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const separatorIndex = line.indexOf(':');

      if (separatorIndex <= 0) {
        throw new Error(
          `Format akun pada baris ${index + 1} tidak valid. ` +
          'Gunakan format email:password.'
        );
      }

      const email = line.slice(0, separatorIndex).trim();
      const password = line.slice(separatorIndex + 1).trim();

      if (!email || !password) {
        throw new Error(
          `Email atau password pada baris ${index + 1} kosong.`
        );
      }

      return { email, password };
    });
}

function sleep(ms) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const timer = setInterval(() => {
      if (stopRequested) {
        clearInterval(timer);
        reject(new Error('Proses dihentikan.'));
        return;
      }

      if (Date.now() - startedAt >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, 1000);
  });
}

function ignoredRequest(url) {
  return /google-analytics|analytics\.google|doubleclick|googletagmanager|csp\.withgoogle\.com|play\.google\.com\/log|\/ccm\/collect|directaccessweb-pa\.googleapis\.com\/webrtc|www\.google\.com\/images\/cleardot\.gif/i
    .test(url || '');
}

async function safeScreenshot(page, filePath) {
  try {
    await page.screenshot({
      path: filePath,
      fullPage: true
    });
  } catch (error) {
    console.warn(`Screenshot gagal: ${error.message}`);
  }
}

async function saveDebug(page, emailIndex, urlIndex, label) {
  const prefix =
    `debug-email-${emailIndex}-url-${urlIndex}-${label}-${timestamp()}`;

  await safeScreenshot(page, `${prefix}.png`);

  try {
    await fs.promises.writeFile(
      `${prefix}.html`,
      await page.content().catch(() => '')
    );
  } catch (error) {
    console.warn(
      `[email:${emailIndex}][url:${urlIndex}] Gagal menyimpan HTML debug: ${error.message}`
    );
  }

  try {
    await fs.promises.writeFile(
      `${prefix}.url.txt`,
      page.url()
    );
  } catch (error) {
    console.warn(
      `[email:${emailIndex}][url:${urlIndex}] Gagal menyimpan URL debug: ${error.message}`
    );
  }
}

async function isVisible(page, selector) {
  return page
    .locator(selector)
    .first()
    .isVisible()
    .catch(() => false);
}

async function clickText(page, labels, prefix) {
  for (const label of labels) {
    for (const frame of page.frames()) {
      try {
        const locator = frame
          .getByText(label, { exact: false })
          .first();

        const visible = await locator
          .isVisible({ timeout: 1500 })
          .catch(() => false);

        if (!visible) continue;

        await locator.click({ timeout: 5000 });
        console.log(`${prefix} Klik: ${label}`);
        return true;
      } catch {
        // coba frame/label berikutnya
      }
    }
  }

  return false;
}

async function clickTwoStepLater(page, prefix) {
  const labels = [
    'Lakukan ini nanti',
    'Do this later'
  ];

  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      for (const label of labels) {
        try {
          const locator = frame
            .getByText(label, { exact: false })
            .first();

          const visible = await locator
            .isVisible({ timeout: 1000 })
            .catch(() => false);

          if (!visible) continue;

          await locator.click({ timeout: 5000 });
          console.log(`${prefix} Klik: ${label}`);
          await page.waitForTimeout(8000);
          return true;
        } catch {
          // retry
        }
      }
    }

    await page.waitForTimeout(1000);
  }

  return false;
}

async function loginFormVisible(page) {
  const emailVisible = await isVisible(page, '#identifierId, input[type="email"]');
  const passwordVisible = await isVisible(page, 'input[type="password"]');
  return emailVisible || passwordVisible;
}

async function realGoogleChallenge(page) {
  const url = page.url();
  const text = await page
    .locator('body')
    .innerText()
    .catch(() => '');

  if (/twosvrequired/i.test(url)) {
    return false;
  }

  return /enter code|masukkan kode|verification code|kode verifikasi|security key|passkey|verify it.?s you|try another way|coba cara lain|captcha|suspicious sign.?in/i
    .test(text);
}

async function waitForGoogleLogin(page, emailIndex, urlIndex) {
  const deadline = Date.now() + 120000;
  let lastLogAt = 0;

  while (Date.now() < deadline) {
    if (stopRequested) {
      throw new Error('Login dihentikan.');
    }

    await clickTwoStepLater(page, `[email:${emailIndex}][url:${urlIndex}]`);

    const url = page.url();
    const text = await page
      .locator('body')
      .innerText()
      .catch(() => '');

    const reminderVisible =
      /jangan sampai terkunci|domain akan segera menerapkan|daftar verifikasi 2 langkah|two-step verification/i
        .test(text);

    if (reminderVisible) {
      await page.waitForTimeout(2000);
      continue;
    }

    if (await realGoogleChallenge(page)) {
      await saveDebug(page, emailIndex, urlIndex, 'google-challenge');
      throw new Error('Google meminta verifikasi manual.');
    }

    const formVisible = await loginFormVisible(page);

    if (formVisible) {
      if (Date.now() - lastLogAt > 10000) {
        console.log(
          `[email:${emailIndex}][url:${urlIndex}] Form login masih terlihat: ${url}`
        );
        lastLogAt = Date.now();
      }

      await page.waitForTimeout(2000);
      continue;
    }

    await page.waitForTimeout(10000);

    const finalUrl = page.url();
    const finalText = await page
      .locator('body')
      .innerText()
      .catch(() => '');

    const finalReminder =
      /jangan sampai terkunci|domain akan segera menerapkan|daftar verifikasi 2 langkah/i
        .test(finalText);

    if (finalReminder) {
      await saveDebug(page, emailIndex, urlIndex, 'two-step-reminder');
      throw new Error('Dialog "Lakukan ini nanti" belum berhasil ditutup.');
    }

    if (await realGoogleChallenge(page)) {
      await saveDebug(page, emailIndex, urlIndex, 'google-challenge-after-wait');
      throw new Error('Google meminta verifikasi manual setelah login.');
    }

    const formStillVisible = await loginFormVisible(page);
    const stillTwoStepRequired = /twosvrequired/i.test(finalUrl);

    if (!formStillVisible && !stillTwoStepRequired) {
      console.log(
        `[email:${emailIndex}][url:${urlIndex}] Login selesai. URL: ${finalUrl}`
      );
      return;
    }

    await page.waitForTimeout(2000);
  }

  await saveDebug(page, emailIndex, urlIndex, 'login-timeout');
  throw new Error('Login Google belum selesai setelah 120 detik.');
}

async function loginOnceAndSaveState({
  browser,
  account,
  emailIndex,
  statePath
}) {
  const context = await browser.newContext({
    viewport: {
      width: 1280,
      height: 800
    }
  });

  const page = await context.newPage();

  try {
    console.log(
      `[email:${emailIndex}] Login Google dilakukan satu kali.`
    );

    await page.goto(
      'https://accounts.google.com/signin/v2/identifier',
      {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      }
    );

    await page.waitForTimeout(3000);

    const emailInput = page
      .locator('#identifierId, input[type="email"]')
      .first();

    await emailInput.waitFor({
      state: 'visible',
      timeout: 40000
    });

    await emailInput.fill(account.email);

    await page
      .locator('#identifierNext')
      .click()
      .catch(() => {});

    console.log(
      `[email:${emailIndex}] Email dikirim.`
    );

    await page.waitForTimeout(4000);

    const anotherAccount = page
      .getByText('Use another account', {
        exact: false
      })
      .first();

    if (
      await anotherAccount
        .isVisible({ timeout: 3000 })
        .catch(() => false)
    ) {
      await anotherAccount.click().catch(() => {});
      await page.waitForTimeout(3000);
    }

    const passwordInput = page
      .locator('input[type="password"]')
      .first();

    await passwordInput.waitFor({
      state: 'visible',
      timeout: 50000
    });

    await passwordInput.fill(account.password);

    await page
      .locator('#passwordNext')
      .click()
      .catch(() => {});

    console.log(
      `[email:${emailIndex}] Password dikirim.`
    );

    await page.waitForTimeout(8000);

    await clickTwoStepLater(
      page,
      `[email:${emailIndex}]`
    );

    await waitForGoogleLogin(
      page,
      emailIndex,
      0
    );

    /*
     * Bootstrap AI Studio sebelum state disimpan.
     * Tujuan: agar token AI Studio ikut terbentuk.
     */
    const bootstrapUrl = 'https://aistudio.google.com/';

    await page.goto(
      bootstrapUrl,
      {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      }
    );

    await page.waitForTimeout(15000);

    await clickText(
      page,
      [
        'Continue to the app',
        'Continue',
        'Lanjutkan ke aplikasi',
        'Lanjutkan'
      ],
      `[email:${emailIndex}]`
    );

    await page.waitForTimeout(10000);

    await context.storageState({
      path: statePath
    });

    console.log(
      `[email:${emailIndex}] State Google + AI Studio disimpan: ${statePath}`
    );

    return;
  } finally {
    await context.close().catch(() => {});
  }
}

async function isTargetValid(page) {
  const currentUrl = page.url();

  if (!currentUrl || currentUrl === 'about:blank') {
    return false;
  }

  if (
    /accounts\.google\.com\/(signin|ServiceLogin|challenge)/i
      .test(currentUrl)
  ) {
    return false;
  }

  const selectors = [
    '#identifierId',
    'input[type="email"]',
    'input[type="password"]'
  ];

  for (const selector of selectors) {
    const count = await page
      .locator(selector)
      .count()
      .catch(() => 0);

    for (let index = 0; index < count; index += 1) {
      const visible = await page
        .locator(selector)
        .nth(index)
        .isVisible()
        .catch(() => false);

      if (visible) {
        return false;
      }
    }
  }

  if (!/^https:\/\/aistudio\.google\.com\/apps\//i.test(currentUrl)) {
    return false;
  }

  return true;
}

async function openTarget(page, targetUrl, prefix) {
  console.log(`${prefix} Membuka target: ${targetUrl}`);

  await page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForTimeout(15000);

  await clickText(
    page,
    [
      'Continue to the app',
      'Continue',
      'Lanjutkan ke aplikasi',
      'Lanjutkan'
    ],
    prefix
  );

  await page.waitForTimeout(2500);

  await clickText(
    page,
    [
      'Skip tutorial',
      'Skip tour',
      'Skip',
      'Lewati'
    ],
    prefix
  );

  await page.waitForTimeout(5000);
}

async function runIsolatedSession({
  browser,
  statePath,
  targetUrl,
  emailIndex,
  urlIndex,
  keepOpenMinutes,
  reloadIntervalMinutes
}) {
  const prefix = `[email:${emailIndex}][url:${urlIndex}]`;

  const context = await browser.newContext({
    storageState: statePath,
    viewport: {
      width: 1280,
      height: 800
    },
    recordVideo: {
      dir: 'videos',
      size: {
        width: 1280,
        height: 800
      }
    }
  });

  const page = await context.newPage();

  const coreApiStats = {
    auth401: 0,
    auth403: 0,
    auth429: 0,
    success: 0
  };

  page.on('console', (message) => {
    const text = message.text();

    if (
      /Self-XSS|No available adapters|Content Security Policy|rtc connection lost/i
        .test(text)
    ) {
      return;
    }

    if (message.type() === 'error') {
      console.warn(`${prefix} Browser error: ${text.slice(0, 300)}`);
    }
  });

  page.on('requestfailed', (request) => {
    const requestUrl = request.url();

    if (ignoredRequest(requestUrl)) {
      return;
    }

    console.warn(
      `${prefix} Request gagal: ${request.method()} ${requestUrl.slice(0, 300)}`
    );
  });

  page.on('response', (response) => {
    const status = response.status();
    const responseUrl = response.url();

    if (!responseUrl.includes('alkalimakersuite-pa.clients6.google.com')) {
      return;
    }

    if (!responseUrl.includes('MakerSuiteService')) {
      return;
    }

    if (status === 401) {
      coreApiStats.auth401 += 1;
      console.warn(`${prefix} HTTP 401: ${responseUrl}`);
    }

    if (status === 403) {
      coreApiStats.auth403 += 1;
      console.warn(`${prefix} HTTP 403: ${responseUrl}`);
    }

    if (status === 429) {
      coreApiStats.auth429 += 1;
      console.warn(`${prefix} HTTP 429: ${responseUrl}`);
    }

    if (status >= 200 && status < 300) {
      coreApiStats.success += 1;
    }
  });

  try {
    await openTarget(page, targetUrl, prefix);

    const finalUrl = page.url();
    console.log(`${prefix} URL akhir: ${finalUrl}`);

    const valid = await isTargetValid(page);

    if (!valid) {
      await saveDebug(page, emailIndex, urlIndex, 'invalid');
      console.warn(`${prefix} Halaman belum valid atau kembali ke login.`);
    }

    const isReady =
      coreApiStats.auth401 === 0 &&
      coreApiStats.auth403 === 0 &&
      coreApiStats.auth429 === 0;

    if (isReady) {
      console.log(`${prefix} LIVE: URL valid dan Core API AI Studio responsif.`);
    } else {
      console.warn(
        `${prefix} NOT_READY: ` +
        `401=${coreApiStats.auth401}, ` +
        `403=${coreApiStats.auth403}, ` +
        `429=${coreApiStats.auth429}`
      );
    }

    await safeScreenshot(
      page,
      `opened-email-${emailIndex}-url-${urlIndex}-${timestamp()}.png`
    );

    const endAt = Date.now() + keepOpenMinutes * 60 * 1000;
    let nextReloadAt = Date.now() + reloadIntervalMinutes * 60 * 1000;

    while (!stopRequested && Date.now() < endAt) {
      const untilReload = nextReloadAt - Date.now();
      const untilEnd = endAt - Date.now();

      const waitTime = Math.min(
        30000,
        Math.max(
          1000,
          Math.min(untilReload, untilEnd)
        )
      );

      await sleep(waitTime);

      if (stopRequested || Date.now() >= endAt) {
        break;
      }

      if (Date.now() >= nextReloadAt) {
        console.log(`${prefix} Reload pada ${now()}.`);

        try {
          await page.reload({
            waitUntil: 'domcontentloaded',
            timeout: 60000
          });

          await page.waitForTimeout(12000);

          await clickText(
            page,
            [
              'Continue to the app',
              'Continue',
              'Lanjutkan ke aplikasi',
              'Lanjutkan'
            ],
            prefix
          );

          await page.waitForTimeout(2000);

          await clickText(
            page,
            [
              'Skip tutorial',
              'Skip tour',
              'Skip',
              'Lewati'
            ],
            prefix
          );

          await page.waitForTimeout(5000);

          await safeScreenshot(
            page,
            `reload-email-${emailIndex}-url-${urlIndex}-${timestamp()}.png`
          );
        } catch (error) {
          console.warn(`${prefix} Reload gagal: ${error.message}`);
          await saveDebug(page, emailIndex, urlIndex, 'reload-error');
        }

        nextReloadAt = Date.now() + reloadIntervalMinutes * 60 * 1000;
      }
    }

    console.log(`${prefix} Session selesai.`);
  } catch (error) {
    console.error(`${prefix} Error: ${error.stack || error}`);

    await saveDebug(page, emailIndex, urlIndex, 'error').catch(() => {});
  } finally {
    await context.close().catch(() => {});
  }
}

(async () => {
  const emailIndex = Math.max(
    1,
    parseInt(process.env.EMAIL_INDEX || '1', 10)
  );

  const keepOpenMinutes = Math.max(
    1,
    parseInt(process.env.KEEP_OPEN_MINUTES || '350', 10)
  );

  const reloadIntervalMinutes = Math.max(
    1,
    parseInt(process.env.RELOAD_INTERVAL_MINUTES || '30', 10)
  );

  const accounts = parseAccounts(
    process.env.GMAIL_ACCOUNT_LIST
  );

  const urls = parseList(
    process.env.AI_STUDIO_URL
  );

  const account = accounts[emailIndex - 1];

  if (!account) {
    throw new Error(
      `Akun index ${emailIndex} tidak ditemukan. ` +
      `Jumlah akun: ${accounts.length}.`
    );
  }

  if (urls.length === 0) {
    throw new Error('AI_STUDIO_URL kosong.');
  }

  const targetUrls = Array.from(
    { length: 5 },
    (_, index) => urls[index % urls.length]
  );

  const tempDirectory = path.resolve('.runtime');
  fs.mkdirSync(tempDirectory, { recursive: true });

  const statePath = path.join(
    tempDirectory,
    `storage-email-${emailIndex}.json`
  );

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  try {
    console.log(
      `[email:${emailIndex}] Login Google satu kali lalu simpan state.`
    );

    await loginOnceAndSaveState({
      browser,
      account,
      emailIndex,
      statePath
    });

    console.log(
      `[email:${emailIndex}] Menjalankan 5 context terisolasi.`
    );

    console.log(
      'TOTAL_ISOLATED_SESSIONS=5'
    );

    await Promise.all(
      targetUrls.map((targetUrl, index) =>
        runIsolatedSession({
          browser,
          statePath,
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

    fs.rmSync(tempDirectory, {
      recursive: true,
      force: true
    });
  }
})().catch((error) => {
  console.error(`Fatal error: ${error.stack || error}`);
  process.exitCode = 1;
});
