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
          `Format akun baris ${index + 1} tidak valid. ` +
          'Gunakan format email:password.'
        );
      }

      const email = line.slice(0, separatorIndex).trim();
      const password = line.slice(separatorIndex + 1).trim();

      if (!email || !password) {
        throw new Error(
          `Email/password baris ${index + 1} kosong.`
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
    console.warn(`Gagal menyimpan screenshot: ${error.message}`);
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
   * Satu job:
   * satu email
   * lima tab
   * lima URL
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
            .getByText(value, { exact: false })
            .first();

          const visible = await locator
            .isVisible({ timeout: 1500 })
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
        } catch (error) {
          // Coba frame/teks berikutnya.
        }
      }
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

  async function detectGoogleChallenge(page) {
    const bodyText = await page
      .locator('body')
      .innerText()
      .catch(() => '');

    return /verify it.?s you|try another way|2-step verification|two-step verification|confirm it.?s you|suspicious sign.?in|couldn.?t verify|captcha/i
      .test(bodyText);
  }

  async function loginFormStillVisible(page) {
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

  async function waitForLoginCompletion(page) {
    const timeoutAt = Date.now() + 120000;
    let lastLogAt = 0;

    console.log(
      `[email:${emailIndex}] Menunggu session Google maksimal 120 detik.`
    );

    while (Date.now() < timeoutAt) {
      if (abortRequested) {
        throw new Error('Login dihentikan karena signal.');
      }

      const currentUrl = page.url();
      const formVisible = await loginFormStillVisible(page);
      const challengeVisible = await detectGoogleChallenge(page);

      if (challengeVisible) {
        await saveDebug(
          page,
          1,
          'google-challenge'
        );

        throw new Error(
          'Google meminta verifikasi tambahan/2FA. ' +
          'Login otomatis tidak dapat melanjutkan challenge tersebut.'
        );
      }

      /*
       * Jika form email/password sudah tidak terlihat,
       * password kemungkinan sudah diterima.
       *
       * Jangan mensyaratkan URL harus langsung keluar dari
       * accounts.google.com karena Google bisa melakukan redirect
       * internal terlebih dahulu.
       */
      if (!formVisible) {
        console.log(
          `[email:${emailIndex}] Form login sudah tidak terlihat.`
        );

        await page.waitForTimeout(10000);

        const formAfterWait = await loginFormStillVisible(page);
        const challengeAfterWait = await detectGoogleChallenge(page);

        if (challengeAfterWait) {
          await saveDebug(
            page,
            1,
            'google-challenge-after-login'
          );

          throw new Error(
            'Google menampilkan verifikasi tambahan setelah password.'
          );
        }

        if (!formAfterWait) {
          console.log(
            `[email:${emailIndex}] Session Google dianggap siap.`
          );

          console.log(
            `[email:${emailIndex}] URL login terakhir: ${currentUrl}`
          );

          return true;
        }
      }

      if (Date.now() - lastLogAt > 10000) {
        console.log(
          `[email:${emailIndex}] Login masih diproses: ${currentUrl}`
        );

        lastLogAt = Date.now();
      }

      await page.waitForTimeout(2000);
    }

    await saveDebug(
      page,
      1,
      'login-timeout'
    );

    throw new Error(
      'Login Google belum selesai setelah 120 detik. ' +
      'Cek artifact login-timeout untuk melihat halaman terakhir.'
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

    /*
     * Jika account chooser muncul, pilih Use another account.
     */
    const anotherAccount = loginPage
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
      'Menunggu proses login.'
    );

    await loginPage.waitForTimeout(8000);

    await waitForLoginCompletion(
      loginPage
    );

    /*
     * Waktu tambahan untuk propagasi cookie/token Google.
     */
    await loginPage.waitForTimeout(10000);

    const cookies = await context.cookies();

    console.log(
      `[email:${emailIndex}] Jumlah cookie session: ${cookies.length}`
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
     * AI Studio memerlukan waktu untuk memuat aplikasi,
     * token, dan komponen frontend.
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
     * Hanya URL login/challenge yang dianggap invalid.
     * Jangan memeriksa body dengan regex "Continue to the app",
     * karena teks itu bisa ada di template tersembunyi.
     */
    if (
      /accounts\.google\.com\/(signin|ServiceLogin|challenge)/i.test(
        currentUrl
      )
    ) {
      return false;
    }

    const selectors = [
      'input[type="password"]',
      '#identifierId',
      'input[type="email"]'
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
     * HTTP 401/403/404 dari analytics, telemetry, ads,
     * atau resource frontend tidak langsung membuat halaman invalid.
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

      if (
        !(await isTargetValid(page, tabIndex))
      ) {
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
     * Semua tab menggunakan session email yang sama.
     */
    for (let index = 0; index < 5; index += 1) {
      const page = await context.newPage();

      pages.push(page);

      /*
       * Batasi log console agar warning analytics/CSP
       * tidak memenuhi output Actions.
       */
      page.on('console', (message) => {
        const text = message.text();

        if (
          /Self-XSS|No available adapters|Content Security Policy/i.test(
            text
          )
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
       * Request analytics/iklan sering gagal di runner.
       * Tidak perlu dianggap error fatal.
       */
      page.on('requestfailed', (request) => {
        const requestUrl = request.url();

        const ignored =
          /google-analytics|analytics\.google|doubleclick|googletagmanager|\/ccm\/collect/i
            .test(requestUrl);

        if (!ignored) {
          console.warn(
            `[email:${emailIndex}][tab:${index + 1}] ` +
            `Request gagal: ${request.method()} ` +
            requestUrl.slice(0, 300)
          );
        }
      });
    }

    /*
     * Login satu kali memakai tab pertama.
     */
    await loginGoogle();

    /*
     * Buka lima URL.
     * Kalau satu tab gagal, empat tab lain tetap berjalan.
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

        const valid = await isTargetValid(
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
            'Tab masih terlihat seperti halaman login.'
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
