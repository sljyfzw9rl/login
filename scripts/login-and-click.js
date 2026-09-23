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
      const separator = line.indexOf(':');

      if (separator <= 0) {
        throw new Error(
          `Format akun pada baris ${index + 1} salah. ` +
          'Gunakan format email:password.'
        );
      }

      const email = line.slice(0, separator).trim();
      const password = line.slice(separator + 1).trim();

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
      const html = await page.content();

      fs.writeFileSync(
        `${prefix}.html`,
        html
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

  function isGoogleLoginUrl(url) {
    return /accounts\.google\.com\/(signin|ServiceLogin|challenge)/i.test(
      url
    );
  }

  async function isVisible(page, selector) {
    return page
      .locator(selector)
      .first()
      .isVisible()
      .catch(() => false);
  }

  async function clickText(page, values, tabIndex) {
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
            `[email:${emailIndex}][tab:${tabIndex}] Klik "${value}".`
          );

          return true;
        } catch (error) {
          // Coba selector/frame berikutnya.
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

  async function waitForGoogleLogin(page) {
    const timeoutAt = Date.now() + 60000;

    console.log(
      `[email:${emailIndex}] Menunggu redirect login Google maksimal 60 detik.`
    );

    while (Date.now() < timeoutAt) {
      const currentUrl = page.url();

      const emailVisible =
        await isVisible(
          page,
          '#identifierId, input[type="email"]'
        );

      const passwordVisible =
        await isVisible(
          page,
          'input[type="password"]'
        );

      const accountChooserVisible =
        await isVisible(
          page,
          'text=Choose an account'
        ) ||
        await isVisible(
          page,
          'text=Use another account'
        );

      const verificationVisible =
        await isVisible(
          page,
          'text=Verify it’s you'
        ) ||
        await isVisible(
          page,
          'text=Verify it\'s you'
        ) ||
        await isVisible(
          page,
          'text=Try another way'
        );

      if (verificationVisible) {
        throw new Error(
          'Google meminta verifikasi tambahan atau 2FA.'
        );
      }

      /*
       * Account chooser dapat muncul setelah password.
       * Pilih akun yang sesuai jika tersedia.
       */
      if (accountChooserVisible) {
        const clicked = await clickText(
          page,
          [
            account.email,
            'Use another account'
          ],
          0
        );

        if (clicked) {
          await page.waitForTimeout(3000);
        }
      }

      /*
       * Selama form login masih terlihat, tunggu.
       */
      if (emailVisible || passwordVisible) {
        await page.waitForTimeout(1500);
        continue;
      }

      /*
       * Jika sudah tidak berada di URL login Google,
       * proses redirect dianggap selesai.
       */
      if (!isGoogleLoginUrl(currentUrl)) {
        await page.waitForTimeout(5000);

        const stillEmailVisible =
          await isVisible(
            page,
            '#identifierId, input[type="email"]'
          );

        const stillPasswordVisible =
          await isVisible(
            page,
            'input[type="password"]'
          );

        if (!stillEmailVisible && !stillPasswordVisible) {
          console.log(
            `[email:${emailIndex}] Login Google berhasil/redirect selesai.`
          );

          return true;
        }
      }

      await page.waitForTimeout(1500);
    }

    throw new Error(
      'Login Google belum selesai setelah menunggu 60 detik.'
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
      timeout: 30000
    });

    await emailInput.fill(account.email);

    await loginPage
      .locator('#identifierNext')
      .click()
      .catch(() => {});

    console.log(
      `[email:${emailIndex}] Email dikirim. Menunggu form password.`
    );

    await loginPage.waitForTimeout(3000);

    /*
     * Jika account chooser tampil, pilih "Use another account"
     * lalu tunggu form password muncul.
     */
    const useAnotherAccount = loginPage
      .getByText('Use another account', { exact: false })
      .first();

    if (
      await useAnotherAccount
        .isVisible({ timeout: 2000 })
        .catch(() => false)
    ) {
      await useAnotherAccount.click().catch(() => {});
      await loginPage.waitForTimeout(2500);
    }

    const passwordInput = loginPage
      .locator('input[type="password"]')
      .first();

    await passwordInput.waitFor({
      state: 'visible',
      timeout: 40000
    });

    await passwordInput.fill(account.password);

    await loginPage
      .locator('#passwordNext')
      .click()
      .catch(() => {});

    console.log(
      `[email:${emailIndex}] Password dikirim. Menunggu proses login.`
    );

    /*
     * Tunggu jauh lebih lama agar redirect, cookie, dan token
     * Google selesai dibuat.
     */
    await loginPage.waitForTimeout(5000);

    await waitForGoogleLogin(loginPage);

    /*
     * Beri waktu tambahan untuk cookie/session propagation
     * sebelum membuka lima URL.
     */
    await loginPage.waitForTimeout(5000);

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
     * AI Studio melakukan banyak request asynchronous.
     */
    await page.waitForTimeout(10000);

    await handleContinueAndSkip(
      page,
      tabIndex
    );

    await page.waitForTimeout(5000);
  }

  async function isTargetValid(page, tabIndex) {
    const currentUrl = page.url();

    console.log(
      `[email:${emailIndex}][tab:${tabIndex}] URL akhir: ${currentUrl}`
    );

    if (!currentUrl || currentUrl === 'about:blank') {
      return false;
    }

    /*
     * Jangan memeriksa body dengan regex "Continue to the app".
     * Teks tersebut dapat berada pada template/element tersembunyi.
     */
    if (isGoogleLoginUrl(currentUrl)) {
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
     * 401 analytics, 403 telemetry, atau 404 resource frontend
     * tidak otomatis berarti halaman utama gagal.
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

      await page.waitForTimeout(10000);

      await handleContinueAndSkip(
        page,
        tabIndex
      );

      await page.waitForTimeout(3000);

      const valid = await isTargetValid(
        page,
        tabIndex
      );

      if (!valid) {
        console.warn(
          `[email:${emailIndex}][tab:${tabIndex}] ` +
          'Session terlihat kembali ke login. Membuka ulang target.'
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
     * Semua tab berbagi cookie/session email yang sama.
     */
    for (let index = 0; index < 5; index += 1) {
      const page = await context.newPage();

      pages.push(page);

      /*
       * Jangan mencetak semua console browser.
       * Warning CSP dan request analytics biasanya bukan fatal.
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
       * Abaikan request analytics/iklan yang sering 401/403
       * di GitHub-hosted runner.
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
            `${requestUrl.slice(0, 300)}`
          );
        }
      });
    }

    /*
     * Login hanya sekali melalui tab pertama.
     */
    await loginGoogle();

    /*
     * Setelah session siap, buka lima URL.
     * Kegagalan satu tab tidak menghentikan empat tab lain.
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
            'Halaman terlihat masih login. Tab tetap dipantau.'
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

      /*
       * Gunakan Math.min agar reload 30 menit tidak terlewati.
       */
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

          const tabIndex = index + 1;
          const page = pages[index];
          const targetUrl = targetUrls[index];

          await reloadTab(
            page,
            targetUrl,
            tabIndex
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
