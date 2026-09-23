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
      /*
       * Gunakan tanda ":" pertama sebagai pemisah.
       * Jadi password masih boleh mengandung ":".
       */
      const separatorIndex = line.indexOf(':');

      if (separatorIndex <= 0) {
        throw new Error(
          `Format akun pada baris ${index + 1} tidak valid. ` +
          'Gunakan format email:password.'
        );
      }

      const email = line
        .slice(0, separatorIndex)
        .trim();

      const password = line
        .slice(separatorIndex + 1)
        .trim();

      if (!email || !password) {
        throw new Error(
          `Email atau password pada baris ${index + 1} kosong.`
        );
      }

      return {
        email,
        password
      };
    });
}

function wait(ms) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const timer = setInterval(() => {
      if (stopRequested) {
        clearInterval(timer);
        reject(new Error('Proses dihentikan oleh signal.'));
        return;
      }

      if (Date.now() - startedAt >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, 1000);
  });
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

function ignoredRequest(url) {
  return /google-analytics|analytics\.google|doubleclick|googletagmanager|csp\.withgoogle\.com|play\.google\.com\/log|\/ccm\/collect|directaccessweb-pa\.googleapis\.com\/webrtc/i
    .test(url || '');
}

async function run() {
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

  if (accounts.length === 0) {
    throw new Error(
      'GMAIL_ACCOUNT_LIST kosong.'
    );
  }

  if (urls.length === 0) {
    throw new Error(
      'AI_STUDIO_URL kosong.'
    );
  }

  const account = accounts[emailIndex - 1];

  if (!account) {
    throw new Error(
      `Akun index ${emailIndex} tidak ditemukan. ` +
      `Total akun: ${accounts.length}.`
    );
  }

  /*
   * Satu job menggunakan:
   * - satu email
   * - lima URL
   * - lima context terpisah
   */
  const targetUrls = Array.from(
    { length: 5 },
    (_, index) => urls[index % urls.length]
  );

  const storageStatePath = path.resolve(
    process.env.STORAGE_STATE_PATH || 'storageState.json'
  );

  const hasStorageState =
    fs.existsSync(storageStatePath);

  console.log('========================================');
  console.log(`Email index     : ${emailIndex}`);
  console.log(`Email           : ${account.email}`);
  console.log(`Jumlah akun     : ${accounts.length}`);
  console.log(`Jumlah URL      : ${urls.length}`);
  console.log(`Jumlah session  : ${targetUrls.length}`);
  console.log(`Storage state   : ${hasStorageState ? 'dipakai' : 'tidak ada, login password dipakai'}`);
  console.log(`Durasi aktif    : ${keepOpenMinutes} menit`);
  console.log(`Interval reload : ${reloadIntervalMinutes} menit`);
  console.log('========================================');

  targetUrls.forEach((url, index) => {
    console.log(`Session ${index + 1}: ${url}`);
  });

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  async function saveDebug(page, urlIndex, label) {
    const prefix =
      `debug-email-${emailIndex}-url-${urlIndex}-${label}-${timestamp()}`;

    await safeScreenshot(
      page,
      `${prefix}.png`
    );

    try {
      fs.writeFileSync(
        `${prefix}.html`,
        await page.content()
      );
    } catch (error) {
      console.warn(
        `[url:${urlIndex}] Gagal menyimpan HTML: ${error.message}`
      );
    }

    try {
      fs.writeFileSync(
        `${prefix}-url.txt`,
        page.url()
      );
    } catch (error) {
      console.warn(
        `[url:${urlIndex}] Gagal menyimpan URL: ${error.message}`
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

  async function bodyText(page) {
    return page
      .locator('body')
      .innerText()
      .catch(() => '');
  }

  async function clickText(page, labels, urlIndex) {
    for (const label of labels) {
      for (const frame of page.frames()) {
        try {
          const locator = frame
            .getByText(label, {
              exact: false
            })
            .first();

          const visible = await locator
            .isVisible({
              timeout: 1500
            })
            .catch(() => false);

          if (!visible) {
            continue;
          }

          await locator.click({
            timeout: 5000
          });

          console.log(
            `[email:${emailIndex}][url:${urlIndex}] Klik: ${label}`
          );

          return true;
        } catch {
          // Coba frame atau label berikutnya.
        }
      }
    }

    return false;
  }

  async function clickTwoStepLater(page) {
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
              .getByText(label, {
                exact: false
              })
              .first();

            const visible = await locator
              .isVisible({
                timeout: 1000
              })
              .catch(() => false);

            if (!visible) {
              continue;
            }

            console.log(
              `[email:${emailIndex}] Menekan "${label}".`
            );

            await locator.click({
              timeout: 5000
            });

            await page.waitForTimeout(8000);

            return true;
          } catch {
            // Coba selector berikutnya.
          }
        }
      }

      await page.waitForTimeout(1000);
    }

    return false;
  }

  async function loginFormVisible(page) {
    const emailVisible = await isVisible(
      page,
      '#identifierId, input[type="email"]'
    );

    const passwordVisible = await isVisible(
      page,
      'input[type="password"]'
    );

    return emailVisible || passwordVisible;
  }

  async function realGoogleChallenge(page) {
    const currentUrl = page.url();
    const text = await bodyText(page);

    /*
     * twosvrequired adalah halaman pengingat yang
     * dapat ditutup dengan "Lakukan ini nanti".
     */
    if (
      /twosvrequired/i.test(currentUrl)
    ) {
      return false;
    }

    return /enter code|masukkan kode|verification code|kode verifikasi|security key|passkey|verify it.?s you|try another way|coba cara lain|captcha|suspicious sign.?in/i
      .test(text);
  }

  async function waitForLogin(page, urlIndex) {
    const deadline = Date.now() + 120000;
    let lastLogAt = 0;

    console.log(
      `[email:${emailIndex}][url:${urlIndex}] ` +
      'Menunggu login maksimal 120 detik.'
    );

    while (Date.now() < deadline) {
      if (stopRequested) {
        throw new Error('Login dihentikan oleh signal.');
      }

      /*
       * Dialog pengingat 2FA ditutup terlebih dahulu.
       */
      const clicked = await clickTwoStepLater(page);

      if (clicked) {
        await page.waitForTimeout(5000);
        continue;
      }

      const currentUrl = page.url();

      const text = await bodyText(page);

      const reminderStillVisible =
        /jangan sampai terkunci|domain akan segera menerapkan|daftar verifikasi 2 langkah|two-step verification/i
          .test(text);

      if (reminderStillVisible) {
        const clickedAgain =
          await clickTwoStepLater(page);

        if (clickedAgain) {
          continue;
        }

        await saveDebug(
          page,
          urlIndex,
          'two-step-reminder'
        );

        throw new Error(
          'Dialog Verifikasi 2 Langkah masih terbuka.'
        );
      }

      if (await realGoogleChallenge(page)) {
        await saveDebug(
          page,
          urlIndex,
          'google-challenge'
        );

        throw new Error(
          'Google meminta verifikasi tambahan manual.'
        );
      }

      const formVisible =
        await loginFormVisible(page);

      if (formVisible) {
        if (Date.now() - lastLogAt > 10000) {
          console.log(
            `[email:${emailIndex}][url:${urlIndex}] ` +
            `Form login masih terlihat: ${currentUrl}`
          );

          lastLogAt = Date.now();
        }

        await page.waitForTimeout(2000);
        continue;
      }

      /*
       * Form hilang. Tunggu cookies/token Google stabil.
       */
      await page.waitForTimeout(10000);

      await clickTwoStepLater(page);

      const finalText = await bodyText(page);

      const finalReminder =
        /jangan sampai terkunci|domain akan segera menerapkan|daftar verifikasi 2 langkah/i
          .test(finalText);

      if (finalReminder) {
        await saveDebug(
          page,
          urlIndex,
          'two-step-reminder-after-wait'
        );

        throw new Error(
          'Dialog "Lakukan ini nanti" gagal ditutup.'
        );
      }

      if (await realGoogleChallenge(page)) {
        await saveDebug(
          page,
          urlIndex,
          'google-challenge-after-wait'
        );

        throw new Error(
          'Google meminta verifikasi tambahan manual.'
        );
      }

      const formStillVisible =
        await loginFormVisible(page);

      const finalUrl = page.url();

      /*
       * Jangan menerima twosvrequired jika masih tetap berada
       * di URL tersebut setelah dialog dicoba ditutup.
       */
      const stillTwoStepRequired =
        /twosvrequired/i.test(finalUrl);

      if (
        !formStillVisible &&
        !stillTwoStepRequired
      ) {
        console.log(
          `[email:${emailIndex}][url:${urlIndex}] ` +
          `Login selesai: ${finalUrl}`
        );

        return;
      }

      await page.waitForTimeout(2000);
    }

    await saveDebug(
      page,
      urlIndex,
      'login-timeout'
    );

    throw new Error(
      'Login belum selesai setelah 120 detik.'
    );
  }

  async function loginContext(context, page, urlIndex) {
    if (hasStorageState) {
      console.log(
        `[email:${emailIndex}][url:${urlIndex}] ` +
        'Menggunakan storageState.'
      );

      await page.goto(
        'https://myaccount.google.com/',
        {
          waitUntil: 'domcontentloaded',
          timeout: 60000
        }
      );

      await page.waitForTimeout(10000);

      const currentUrl = page.url();

      if (
        /twosvrequired|challenge|signin/i.test(currentUrl)
      ) {
        await clickTwoStepLater(page);
      }

      if (
        /twosvrequired|challenge|signin/i.test(page.url())
      ) {
        throw new Error(
          'storageState tidak valid atau masih membutuhkan verifikasi.'
        );
      }

      return;
    }

    console.log(
      `[email:${emailIndex}][url:${urlIndex}] ` +
      'Membuka halaman login Google.'
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
      `[email:${emailIndex}][url:${urlIndex}] ` +
      'Email dikirim. Menunggu password.'
    );

    await page.waitForTimeout(4000);

    const anotherAccount = page
      .getByText('Use another account', {
        exact: false
      })
      .first();

    if (
      await anotherAccount
        .isVisible({
          timeout: 3000
        })
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
      `[email:${emailIndex}][url:${urlIndex}] ` +
      'Password dikirim. Menunggu session.'
    );

    await page.waitForTimeout(8000);

    await clickTwoStepLater(page);

    await waitForLogin(
      page,
      urlIndex
    );

    await page.waitForTimeout(10000);

    const cookies = await context.cookies();

    console.log(
      `[email:${emailIndex}][url:${urlIndex}] ` +
      `Login selesai. Cookie: ${cookies.length}`
    );
  }

  async function openTarget(page, targetUrl, urlIndex) {
    console.log(
      `[email:${emailIndex}][url:${urlIndex}] ` +
      `Membuka target: ${targetUrl}`
    );

    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForTimeout(15000);

    await clickText(
      page,
      [
        'Continue to the app',
        'Continue'
      ],
      urlIndex
    );

    await page.waitForTimeout(2500);

    await clickText(
      page,
      [
        'Skip tutorial',
        'Skip tour',
        'Skip'
      ],
      urlIndex
    );

    await page.waitForTimeout(5000);
  }

  async function isTargetValid(page) {
    const currentUrl = page.url();

    if (
      !currentUrl ||
      currentUrl === 'about:blank'
    ) {
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

    /*
     * Jangan mencari teks "Continue to the app"
     * pada seluruh body karena bisa tersembunyi.
     */
    return true;
  }

  async function runSession(targetUrl, urlIndex) {
    const contextOptions = {
      viewport: {
        width: 1280,
        height: 800
      },
      recordVideo: {
        dir: path.resolve('videos'),
        size: {
          width: 1280,
          height: 800
        }
      },
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) ' +
        'AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) ' +
        'Chrome/120.0.0.0 Safari/537.36'
    };

    if (hasStorageState) {
      contextOptions.storageState = storageStatePath;
    }

    /*
     * Context dibuat di sini, bukan sekali untuk semua URL.
     * Setiap URL memiliki cookie/session sendiri.
     */
    const context = await browser.newContext(
      contextOptions
    );

    const page = await context.newPage();

    page.on('console', (message) => {
      const text = message.text();

      if (
        /Self-XSS|No available adapters|Content Security Policy|rtc connection lost/i
          .test(text)
      ) {
        return;
      }

      if (message.type() === 'error') {
        console.warn(
          `[email:${emailIndex}][url:${urlIndex}] ` +
          `Browser error: ${text.slice(0, 300)}`
        );
      }
    });

    page.on('requestfailed', (request) => {
      const requestUrl = request.url();

      if (ignoredRequest(requestUrl)) {
        return;
      }

      console.warn(
        `[email:${emailIndex}][url:${urlIndex}] ` +
        `Request gagal: ${request.method()} ` +
        requestUrl.slice(0, 300)
      );
    });

    try {
      /*
       * Jika storageState tidak ada, login normal dilakukan
       * pada context ini.
       */
      await loginContext(
        context,
        page,
        urlIndex
      );

      await openTarget(
        page,
        targetUrl,
        urlIndex
      );

      const valid = await isTargetValid(page);

      if (!valid) {
        await saveDebug(
          page,
          urlIndex,
          'initial-invalid'
        );

        console.warn(
          `[email:${emailIndex}][url:${urlIndex}] ` +
          'Halaman terlihat masih login.'
        );
      }

      await safeScreenshot(
        page,
        `opened-email-${emailIndex}-url-${urlIndex}-${timestamp()}.png`
      );

      console.log(
        `[email:${emailIndex}][url:${urlIndex}] ` +
        'Session aktif.'
      );

      const endAt =
        Date.now() + keepOpenMinutes * 60 * 1000;

      let nextReloadAt =
        Date.now() + reloadIntervalMinutes * 60 * 1000;

      while (
        !stopRequested &&
        Date.now() < endAt
      ) {
        const untilReload =
          nextReloadAt - Date.now();

        const untilEnd =
          endAt - Date.now();

        const waitTime = Math.min(
          30000,
          Math.max(
            1000,
            Math.min(untilReload, untilEnd)
          )
        );

        await wait(waitTime);

        if (
          stopRequested ||
          Date.now() >= endAt
        ) {
          break;
        }

        if (Date.now() >= nextReloadAt) {
          console.log(
            `[email:${emailIndex}][url:${urlIndex}] ` +
            `Reload pada ${now()}`
          );

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
                'Continue'
              ],
              urlIndex
            );

            await page.waitForTimeout(2000);

            await clickText(
              page,
              [
                'Skip tutorial',
                'Skip tour',
                'Skip'
              ],
              urlIndex
            );

            await page.waitForTimeout(3000);

            const stillValid =
              await isTargetValid(page);

            if (!stillValid) {
              console.warn(
                `[email:${emailIndex}][url:${urlIndex}] ` +
                'Session kembali ke login.'
              );

              await saveDebug(
                page,
                urlIndex,
                'login-after-reload'
              );
            } else {
              await safeScreenshot(
                page,
                `reload-email-${emailIndex}-url-${urlIndex}-${timestamp()}.png`
              );
            }
          } catch (error) {
            console.warn(
              `[email:${emailIndex}][url:${urlIndex}] ` +
              `Reload gagal: ${error.message}`
            );

            await saveDebug(
              page,
              urlIndex,
              'reload-error'
            );
          }

          nextReloadAt =
            Date.now() +
            reloadIntervalMinutes * 60 * 1000;
        }
      }

      console.log(
        `[email:${emailIndex}][url:${urlIndex}] ` +
        'Session selesai.'
      );
    } catch (error) {
      console.error(
        `[email:${emailIndex}][url:${urlIndex}] ` +
        `Error: ${error.stack || error}`
      );

      await saveDebug(
        page,
        urlIndex,
        'error'
      ).catch(() => {});
    } finally {
      /*
       * Menutup context ini hanya menutup session URL ini.
       */
      await context.close().catch(() => {});
    }
  }

  try {
    console.log(
      `[email:${emailIndex}] ` +
      'Menjalankan 5 session terisolasi.'
    );

    console.log(
      'TOTAL_ISOLATED_SESSIONS=5'
    );

    /*
     * Lima session berjalan paralel.
     * Masing-masing login sendiri jika storageState tidak tersedia.
     */
    await Promise.all(
      targetUrls.map((targetUrl, index) =>
        runSession(
          targetUrl,
          index + 1
        )
      )
    );
  } finally {
    await browser.close().catch(() => {});
  }
}

run().catch((error) => {
  console.error(
    `Fatal error: ${error.stack || error}`
  );

  process.exitCode = 1;
});
