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
          `Email atau password baris ${index + 1} kosong.`
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
      `Total akun: ${accounts.length}.`
    );
  }

  /*
   * Satu job memakai satu email dan lima tab.
   * Jika jumlah URL kurang dari lima, URL akan diulang.
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
      const html = await page.content();

      fs.writeFileSync(
        `${prefix}.html`,
        html
      );
    } catch (error) {
      console.warn(
        `[email:${emailIndex}][tab:${tabIndex}] HTML debug gagal: ${error.message}`
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
        `[email:${emailIndex}][tab:${tabIndex}] Cookies debug gagal: ${error.message}`
      );
    }
  }

  async function clickAnyText(page, values, tabIndex) {
    for (const value of values) {
      for (const frame of page.frames()) {
        try {
          const locator = frame
            .getByText(value, { exact: false })
            .first();

          const visible = await locator.isVisible({
            timeout: 1500
          }).catch(() => false);

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
          // Coba frame berikutnya.
        }
      }
    }

    return false;
  }

  async function handleContinueAndSkip(page, tabIndex) {
    await clickAnyText(
      page,
      [
        'Continue to the app',
        'Continue'
      ],
      tabIndex
    );

    await page.waitForTimeout(1500);

    await clickAnyText(
      page,
      [
        'Skip tutorial',
        'Skip tour',
        'Skip'
      ],
      tabIndex
    );

    await page.waitForTimeout(1500);
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

    await loginPage.waitForTimeout(2500);

    const passwordInput = loginPage
      .locator('input[type="password"]')
      .first();

    await passwordInput.waitFor({
      state: 'visible',
      timeout: 30000
    });

    await passwordInput.fill(account.password);

    await loginPage
      .locator('#passwordNext')
      .click()
      .catch(() => {});

    await loginPage.waitForTimeout(7000);

    const currentUrl = loginPage.url();

    if (/challenge|verify/i.test(currentUrl)) {
      throw new Error(
        'Google meminta verifikasi tambahan.'
      );
    }

    const stillOnLoginPage = await loginPage
      .locator(
        'input[type="password"], ' +
        '#identifierId, ' +
        'input[type="email"]'
      )
      .first()
      .isVisible()
      .catch(() => false);

    if (stillOnLoginPage) {
      throw new Error(
        'Login Google belum selesai. Form login masih terlihat.'
      );
    }

    console.log(
      `[email:${emailIndex}] Login Google selesai.`
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
     * AI Studio memakai banyak request asynchronous.
     * Jangan langsung validasi setelah domcontentloaded.
     */
    await page.waitForTimeout(8000);

    await handleContinueAndSkip(
      page,
      tabIndex
    );

    await page.waitForTimeout(3000);
  }

  /*
   * Validasi lama salah karena mencari teks "Continue to the app"
   * di seluruh body. Teks itu bisa ada sebagai hidden/template text
   * walaupun halaman sebenarnya sudah terbuka.
   *
   * Validasi baru hanya menolak:
   * - redirect ke accounts.google.com
   * - URL sign-in/challenge
   * - input login yang benar-benar terlihat
   *
   * Request analytics 401 tidak dianggap sebagai kegagalan halaman.
   */
  async function isPageValid(page) {
    const currentUrl = page.url();

    if (!currentUrl || currentUrl === 'about:blank') {
      return false;
    }

    if (
      /accounts\.google\.com\/(signin|ServiceLogin|challenge)/i.test(
        currentUrl
      )
    ) {
      return false;
    }

    const visibleLoginInput = await page
      .locator(
        'input[type="password"], ' +
        '#identifierId, ' +
        'input[type="email"]'
      )
      .filter({
        visible: true
      })
      .count()
      .catch(() => 0);

    if (visibleLoginInput > 0) {
      return false;
    }

    /*
     * Untuk AI Studio, URL target yang berhasil terbuka sudah cukup
     * sebagai indikator utama. Jangan memeriksa body text secara global.
     */
    return true;
  }

  async function reloadTab(page, targetUrl, tabIndex) {
    try {
      console.log(
        `[email:${emailIndex}][tab:${tabIndex}] Reload pada ${now()}`
      );

      await page.reload({
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });

      await page.waitForTimeout(8000);

      await handleContinueAndSkip(
        page,
        tabIndex
      );

      const valid = await isPageValid(page);

      if (!valid) {
        console.warn(
          `[email:${emailIndex}][tab:${tabIndex}] ` +
          'Halaman tidak valid setelah reload. Membuka ulang.'
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
     * Satu browser context dengan lima tab.
     * Semua tab menggunakan sesi email yang sama.
     */
    for (let index = 0; index < 5; index += 1) {
      const page = await context.newPage();

      pages.push(page);

      /*
       * Jangan tampilkan semua console browser.
       * Warning CSP, analytics 401, dan "No available adapters"
       * bukan error fatal dan hanya memenuhi log.
       */
      page.on('console', (message) => {
        const type = message.type();

        if (type === 'error') {
          console.warn(
            `[email:${emailIndex}][tab:${index + 1}] ` +
            `Browser error: ${message.text().slice(0, 300)}`
          );
        }
      });

      /*
       * Analytics, ads, dan telemetry sering gagal di runner.
       * Jangan log semua request gagal.
       */
      page.on('requestfailed', (request) => {
        const requestUrl = request.url();

        const ignoredRequest =
          /google-analytics|analytics\.google|doubleclick|googletagmanager|\/ccm\/collect/i
            .test(requestUrl);

        if (!ignoredRequest) {
          console.warn(
            `[email:${emailIndex}][tab:${index + 1}] ` +
            `Request gagal: ${request.method()} ${requestUrl.slice(0, 250)}`
          );
        }
      });
    }

    /*
     * Login satu kali di tab pertama.
     */
    await loginGoogle();

    /*
     * Lima URL dibuka pada lima tab.
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

        /*
         * Jangan membuat job gagal hanya karena heuristic.
         * Cek URL login secara khusus.
         */
        if (!(await isPageValid(page))) {
          await saveDebug(
            page,
            tabIndex,
            'initial-invalid'
          );

          console.warn(
            `[email:${emailIndex}][tab:${tabIndex}] ` +
            'Halaman terlihat seperti login. Tab dilewati.'
          );

          continue;
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
      `[email:${emailIndex}] Lima tab akan aktif sampai ` +
      `${new Date(endAt).toISOString()}`
    );

    while (
      !abortRequested &&
      Date.now() < endAt
    ) {
      const remainingUntilReload =
        nextReloadAt - Date.now();

      const remainingUntilEnd =
        endAt - Date.now();

      /*
       * Gunakan MINIMUM, bukan maksimum.
       * Kalau reload jatuh 30 menit lagi, sleep tidak boleh
       * melompati jadwal reload tersebut.
       */
      const waitTime = Math.min(
        30000,
        Math.max(
          1000,
          Math.min(
            remainingUntilReload,
            remainingUntilEnd
          )
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
      `[email:${emailIndex}] Sesi lima tab selesai pada ${now()}`
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
