'use strict';

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

      return {
        email,
        password
      };
    });
}

function sleep(ms) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const timer = setInterval(() => {
      if (abortRequested) {
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

  if (accounts.length === 0) {
    throw new Error('GMAIL_ACCOUNT_LIST kosong.');
  }

  if (urls.length === 0) {
    throw new Error('AI_STUDIO_URL kosong.');
  }

  const account = accounts[emailIndex - 1];

  if (!account) {
    throw new Error(
      `Akun index ${emailIndex} tidak ditemukan. ` +
      `Jumlah akun: ${accounts.length}.`
    );
  }

  /*
   * Satu job menggunakan satu email dan lima tab.
   */
  const targetUrls = Array.from(
    { length: 5 },
    (_, index) => urls[index % urls.length]
  );

  console.log('========================================');
  console.log(`Email index     : ${emailIndex}`);
  console.log(`Email           : ${account.email}`);
  console.log(`Jumlah akun     : ${accounts.length}`);
  console.log(`Jumlah URL      : ${urls.length}`);
  console.log(`Jumlah tab      : ${targetUrls.length}`);
  console.log(`Durasi aktif    : ${keepOpenMinutes} menit`);
  console.log(`Interval reload : ${reloadIntervalMinutes} menit`);
  console.log('========================================');

  targetUrls.forEach((url, index) => {
    console.log(`Tab ${index + 1}: ${url}`);
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

  const context = await browser.newContext({
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
    },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) ' +
      'AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) ' +
      'Chrome/120.0.0.0 Safari/537.36'
  });

  const pages = [];

  async function saveDebug(page, tabIndex, label) {
    const prefix =
      `debug-email-${emailIndex}-url-${tabIndex}-${label}-${timestamp()}`;

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
        `[tab:${tabIndex}] Gagal menyimpan HTML: ${error.message}`
      );
    }

    try {
      const cookies = await context.cookies();

      fs.writeFileSync(
        `${prefix}-cookies.json`,
        JSON.stringify(cookies, null, 2)
      );
    } catch (error) {
      console.warn(
        `[tab:${tabIndex}] Gagal menyimpan cookies: ${error.message}`
      );
    }

    try {
      fs.writeFileSync(
        `${prefix}-url.txt`,
        page.url()
      );
    } catch (error) {
      console.warn(
        `[tab:${tabIndex}] Gagal menyimpan URL: ${error.message}`
      );
    }
  }

  async function getBodyText(page) {
    return page
      .locator('body')
      .innerText()
      .catch(() => '');
  }

  async function isVisible(page, selector) {
    return page
      .locator(selector)
      .first()
      .isVisible()
      .catch(() => false);
  }

  async function clickText(page, values, tabIndex = 0) {
    for (const value of values) {
      for (const frame of page.frames()) {
        try {
          const locator = frame
            .getByText(value, {
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
            `[email:${emailIndex}][tab:${tabIndex}] Klik: ${value}`
          );

          return true;
        } catch {
          // Lanjut ke frame/teks berikutnya.
        }
      }
    }

    return false;
  }

  async function clickLaterTwoStepReminder(page) {
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
              `[email:${emailIndex}] Dialog 2FA ditemukan. ` +
              `Klik "${label}".`
            );

            await locator.click({
              timeout: 5000
            });

            await page.waitForTimeout(8000);

            console.log(
              `[email:${emailIndex}] Dialog 2FA berhasil ditutup.`
            );

            return true;
          } catch {
            // Coba frame/label berikutnya.
          }
        }
      }

      await page.waitForTimeout(1000);
    }

    return false;
  }

  async function handleContinueAndSkip(page, tabIndex) {
    await clickText(
      page,
      [
        'Continue to the app',
        'Continue'
      ],
      tabIndex
    );

    await page.waitForTimeout(2000);

    await clickText(
      page,
      [
        'Skip tutorial',
        'Skip tour',
        'Skip'
      ],
      tabIndex
    );

    await page.waitForTimeout(2000);
  }

  async function hasLoginForm(page) {
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

  async function hasRealGoogleChallenge(page) {
    const currentUrl = page.url();
    const bodyText = await getBodyText(page);

    /*
     * twosvrequired sendiri adalah dialog pengingat yang
     * masih bisa ditutup dengan "Lakukan ini nanti".
     */
    const realChallengeText =
      /enter code|masukkan kode|verification code|kode verifikasi|security key|passkey|confirm it.?s you|konfirmasi bahwa ini Anda|try another way|coba cara lain|captcha|suspicious sign.?in/i;

    if (realChallengeText.test(bodyText)) {
      return true;
    }

    /*
     * URL challenge tertentu memang membutuhkan interaksi manual.
     */
    if (
      /\/challenge\/|\/signin\/challenge/i.test(currentUrl)
    ) {
      return true;
    }

    return false;
  }

  async function waitForLoginCompletion(page) {
    const deadline = Date.now() + 120000;
    let lastStatusAt = 0;

    console.log(
      `[email:${emailIndex}] ` +
      'Menunggu session Google maksimal 120 detik.'
    );

    while (Date.now() < deadline) {
      if (abortRequested) {
        throw new Error('Login dihentikan oleh signal.');
      }

      /*
       * Prioritas pertama: klik dialog "Lakukan ini nanti".
       */
      const clickedLater = await clickLaterTwoStepReminder(page);

      if (clickedLater) {
        await page.waitForTimeout(5000);
        continue;
      }

      const currentUrl = page.url();
      const bodyText = await getBodyText(page);

      /*
       * Jangan menganggap dialog 2FA sebagai login sukses
       * jika masih tampil.
       */
      const reminderStillVisible =
        /jangan sampai terkunci|domain akan segera menerapkan|daftar verifikasi 2 langkah|two-step verification/i
          .test(bodyText);

      if (reminderStillVisible) {
        const clickedAgain =
          await clickLaterTwoStepReminder(page);

        if (clickedAgain) {
          continue;
        }

        await saveDebug(
          page,
          1,
          'two-step-reminder'
        );

        throw new Error(
          'Dialog pengingat Verifikasi 2 Langkah masih terbuka.'
        );
      }

      if (await hasRealGoogleChallenge(page)) {
        await saveDebug(
          page,
          1,
          'google-real-challenge'
        );

        throw new Error(
          'Google meminta verifikasi tambahan manual.'
        );
      }

      const loginFormVisible =
        await hasLoginForm(page);

      if (loginFormVisible) {
        if (Date.now() - lastStatusAt > 10000) {
          console.log(
            `[email:${emailIndex}] ` +
            `Form login masih terlihat: ${currentUrl}`
          );

          lastStatusAt = Date.now();
        }

        await page.waitForTimeout(2000);
        continue;
      }

      /*
       * Form login sudah hilang.
       * Tunggu cookie, redirect, dan session stabil.
       */
      console.log(
        `[email:${emailIndex}] Form login sudah tidak terlihat. ` +
        'Menunggu session stabil.'
      );

      await page.waitForTimeout(10000);

      /*
       * Coba lagi menutup dialog apabila muncul setelah redirect.
       */
      await clickLaterTwoStepReminder(page);

      const afterWaitBody = await getBodyText(page);

      const reminderAfterWait =
        /jangan sampai terkunci|domain akan segera menerapkan|daftar verifikasi 2 langkah/i
          .test(afterWaitBody);

      if (reminderAfterWait) {
        await saveDebug(
          page,
          1,
          'two-step-reminder-after-wait'
        );

        throw new Error(
          'Dialog "Lakukan ini nanti" belum berhasil ditutup.'
        );
      }

      if (await hasRealGoogleChallenge(page)) {
        await saveDebug(
          page,
          1,
          'google-real-challenge-after-wait'
        );

        throw new Error(
          'Google meminta verifikasi tambahan manual setelah login.'
        );
      }

      const formStillVisible =
        await hasLoginForm(page);

      const currentUrlAfterWait = page.url();

      /*
       * Jangan menerima URL twosvrequired sebagai sukses.
       */
      const stillTwoStepRequired =
        /twosvrequired/i.test(currentUrlAfterWait);

      if (
        !formStillVisible &&
        !stillTwoStepRequired
      ) {
        console.log(
          `[email:${emailIndex}] Login Google selesai.`
        );

        console.log(
          `[email:${emailIndex}] URL terakhir: ${currentUrlAfterWait}`
        );

        return true;
      }

      await page.waitForTimeout(2000);
    }

    await saveDebug(
      page,
      1,
      'login-timeout'
    );

    throw new Error(
      'Login Google belum selesai setelah 120 detik.'
    );
  }

  async function loginGoogle() {
    const loginPage = pages[0];

    console.log(
      `[email:${emailIndex}] Membuka halaman login Google.`
    );

    await loginPage.goto(
      'https://accounts.google.com/signin/v2/identifier',
      {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      }
    );

    await loginPage.waitForTimeout(3000);

    const emailInput = loginPage
      .locator('#identifierId, input[type="email"]')
      .first();

    await emailInput.waitFor({
      state: 'visible',
      timeout: 40000
    });

    await emailInput.fill(account.email);

    await loginPage
      .locator('#identifierNext')
      .click()
      .catch(() => {});

    console.log(
      `[email:${emailIndex}] Email dikirim. ` +
      'Menunggu form password.'
    );

    await loginPage.waitForTimeout(4000);

    const anotherAccount = loginPage
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
      await loginPage.waitForTimeout(3000);
    }

    const passwordInput = loginPage
      .locator('input[type="password"]')
      .first();

    await passwordInput.waitFor({
      state: 'visible',
      timeout: 50000
    });

    await passwordInput.fill(account.password);

    await loginPage
      .locator('#passwordNext')
      .click()
      .catch(() => {});

    console.log(
      `[email:${emailIndex}] Password dikirim. ` +
      'Menunggu dialog keamanan Google.'
    );

    await loginPage.waitForTimeout(8000);

    /*
     * Fungsi ini akan mengeklik "Lakukan ini nanti"
     * apabila dialog tersebut muncul.
     */
    await clickLaterTwoStepReminder(
      loginPage
    );

    await waitForLoginCompletion(
      loginPage
    );

    /*
     * Waktu tambahan untuk propagasi cookies/token.
     */
    await loginPage.waitForTimeout(10000);

    const cookies = await context.cookies();

    console.log(
      `[email:${emailIndex}] Jumlah cookie: ${cookies.length}`
    );

    console.log(
      `[email:${emailIndex}] Session Google siap digunakan.`
    );
  }

  async function openTarget(page, targetUrl, tabIndex) {
    console.log(
      `[email:${emailIndex}][tab:${tabIndex}] Membuka target.`
    );

    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    /*
     * AI Studio memerlukan waktu untuk memuat
     * frontend dan session internal.
     */
    await page.waitForTimeout(15000);

    await handleContinueAndSkip(
      page,
      tabIndex
    );

    await page.waitForTimeout(5000);
  }

  async function isTargetValid(page, tabIndex) {
    const currentUrl = page.url();

    console.log(
      `[email:${emailIndex}][tab:${tabIndex}] URL: ${currentUrl}`
    );

    if (!currentUrl || currentUrl === 'about:blank') {
      return false;
    }

    /*
     * Hanya halaman login Google yang dianggap invalid.
     */
    if (
      /accounts\.google\.com\/(signin|ServiceLogin|challenge)/i.test(
        currentUrl
      )
    ) {
      return false;
    }

    const loginSelectors = [
      'input[type="password"]',
      '#identifierId',
      'input[type="email"]'
    ];

    for (const selector of loginSelectors) {
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
     * Jangan memeriksa teks "Continue to the app"
     * di seluruh body karena bisa tersembunyi.
     */
    return true;
  }

  async function reloadTab(page, targetUrl, tabIndex) {
    try {
      console.log(
        `[email:${emailIndex}][tab:${tabIndex}] Reload pada ${now()}.`
      );

      await page.reload({
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });

      await page.waitForTimeout(12000);

      await handleContinueAndSkip(
        page,
        tabIndex
      );

      await page.waitForTimeout(3000);

      const valid =
        await isTargetValid(
          page,
          tabIndex
        );

      if (!valid) {
        console.warn(
          `[email:${emailIndex}][tab:${tabIndex}] ` +
          'Session kembali ke login. Membuka ulang target.'
        );

        await openTarget(
          page,
          targetUrl,
          tabIndex
        );
      }
    } catch (error) {
      console.warn(
        `[email:${emailIndex}][tab:${tabIndex}] ` +
        `Reload gagal: ${error.message}`
      );

      try {
        await openTarget(
          page,
          targetUrl,
          tabIndex
        );
      } catch (reopenError) {
        console.error(
          `[email:${emailIndex}][tab:${tabIndex}] ` +
          `Gagal membuka ulang: ${reopenError.message}`
        );

        await saveDebug(
          page,
          tabIndex,
          'reload-failed'
        );
      }
    }
  }

  try {
    /*
     * Buat lima tab dalam satu browser context.
     * Semua tab memakai session email yang sama.
     */
    for (let index = 0; index < 5; index += 1) {
      const page = await context.newPage();

      pages.push(page);

      /*
       * Hanya tampilkan error browser yang relevan.
       */
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
            `[email:${emailIndex}][tab:${index + 1}] ` +
            `Browser error: ${text.slice(0, 300)}`
          );
        }
      });

      /*
       * Request analytics/telemetry/WebRTC sering gagal
       * di GitHub Actions dan tidak menghentikan tab.
       */
      page.on('requestfailed', (request) => {
        const requestUrl = request.url();

        const ignored =
          /google-analytics|analytics\.google|doubleclick|googletagmanager|csp\.withgoogle\.com|play\.google\.com\/log|\/ccm\/collect|directaccessweb-pa\.googleapis\.com\/webrtc/i
            .test(requestUrl);

        if (ignored) {
          return;
        }

        console.warn(
          `[email:${emailIndex}][tab:${index + 1}] ` +
          `Request gagal: ${request.method()} ` +
          requestUrl.slice(0, 300)
        );
      });
    }

    /*
     * Login hanya satu kali dengan tab pertama.
     */
    await loginGoogle();

    /*
     * Setelah login dan dialog "Lakukan ini nanti"
     * selesai, buka kelima URL.
     */
    for (let index = 0; index < pages.length; index += 1) {
      const tabIndex = index + 1;
      const page = pages[index];
      const targetUrl = targetUrls[index];

      try {
        await openTarget(
          page,
          targetUrl,
          tabIndex
        );

        const valid =
          await isTargetValid(
            page,
            tabIndex
          );

        if (!valid) {
          await saveDebug(
            page,
            tabIndex,
            'initial-invalid'
          );

          console.warn(
            `[email:${emailIndex}][tab:${tabIndex}] ` +
            'Halaman masih terlihat seperti login.'
          );
        }

        await safeScreenshot(
          page,
          `opened-email-${emailIndex}-url-${tabIndex}-${timestamp()}.png`
        );

        console.log(
          `[email:${emailIndex}][tab:${tabIndex}] Tab aktif.`
        );
      } catch (error) {
        console.error(
          `[email:${emailIndex}][tab:${tabIndex}] ` +
          `Gagal membuka tab: ${error.message}`
        );

        await saveDebug(
          page,
          tabIndex,
          'initial-error'
        );
      }
    }

    const endAt =
      Date.now() + keepOpenMinutes * 60 * 1000;

    let nextReloadAt =
      Date.now() + reloadIntervalMinutes * 60 * 1000;

    console.log(
      `[email:${emailIndex}] Lima tab aktif sampai ` +
      `${new Date(endAt).toISOString()}`
    );

    while (
      !abortRequested &&
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

      await sleep(waitTime);

      if (
        abortRequested ||
        Date.now() >= endAt
      ) {
        break;
      }

      if (Date.now() >= nextReloadAt) {
        console.log(
          `[email:${emailIndex}] Reload lima tab dimulai.`
        );

        for (let index = 0; index < pages.length; index += 1) {
          if (abortRequested) {
            break;
          }

          await reloadTab(
            pages[index],
            targetUrls[index],
            index + 1
          );
        }

        nextReloadAt =
          Date.now() + reloadIntervalMinutes * 60 * 1000;

        console.log(
          `[email:${emailIndex}] Reload lima tab selesai.`
        );
      }
    }

    console.log(
      `[email:${emailIndex}] Sesi selesai pada ${now()}.`
    );
  } catch (error) {
    console.error(
      `[email:${emailIndex}] Error fatal: ${error.stack || error}`
    );

    for (let index = 0; index < pages.length; index += 1) {
      await saveDebug(
        pages[index],
        index + 1,
        'fatal-error'
      ).catch(() => {});
    }

    process.exitCode = 2;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});

    console.log(
      `[email:${emailIndex}] Browser ditutup.`
    );
  }
})();
