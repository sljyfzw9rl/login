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

/**
 * Format:
 * email@example.com:password
 *
 * Pemisah yang digunakan adalah tanda ":" pertama.
 * Jadi password tetap bisa mengandung ":" setelah pemisah pertama.
 */
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

function sleep(ms) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const timer = setInterval(() => {
      if (abortRequested) {
        clearInterval(timer);
        reject(new Error('Sleep dihentikan karena proses menerima signal.'));
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
    console.warn(`Gagal mengambil screenshot ${filePath}: ${error.message}`);
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
      `Akun dengan index ${emailIndex} tidak ditemukan. ` +
      `Jumlah akun yang tersedia: ${accounts.length}.`
    );
  }

  if (urls.length === 0) {
    throw new Error(
      'AI_STUDIO_URL kosong. Isi minimal satu URL.'
    );
  }

  if (urls.length < 5) {
    console.warn(
      `Peringatan: hanya ditemukan ${urls.length} URL. ` +
      'Lima tab akan tetap dibuat berdasarkan URL yang tersedia.'
    );
  }

  /*
   * Tepat lima tab.
   *
   * Jika tersedia lima URL:
   * tab 1 -> URL 1
   * tab 2 -> URL 2
   * tab 3 -> URL 3
   * tab 4 -> URL 4
   * tab 5 -> URL 5
   *
   * Jika URL kurang dari lima, URL yang tersedia akan diulang
   * sampai jumlah tab menjadi lima.
   */
  const targetUrls = Array.from(
    { length: 5 },
    (_, index) => urls[index % urls.length]
  );

  console.log('========================================');
  console.log(`Job email index : ${emailIndex}`);
  console.log(`Email           : ${account.email}`);
  console.log(`Jumlah tab      : ${targetUrls.length}`);
  console.log(`Durasi          : ${keepOpenMinutes} menit`);
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
        `[email:${emailIndex}][tab:${tabIndex}] ` +
        `Gagal menyimpan HTML debug: ${error.message}`
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
        `[email:${emailIndex}][tab:${tabIndex}] ` +
        `Gagal menyimpan cookies debug: ${error.message}`
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
            `[email:${emailIndex}][tab:${tabIndex}] ` +
            `Klik teks: ${value}`
          );

          return true;
        } catch (error) {
          // Coba frame atau selector berikutnya.
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

    await page.waitForTimeout(1000);

    await clickAnyText(
      page,
      [
        'Skip tutorial',
        'Skip tour',
        'Skip'
      ],
      tabIndex
    );

    await page.waitForTimeout(1000);
  }

  async function loginGoogle() {
    console.log(
      `[email:${emailIndex}] Membuka halaman login Google satu kali.`
    );

    await pages[0].goto(
      'https://accounts.google.com/signin/v2/identifier',
      {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      }
    );

    const emailInput = pages[0]
      .locator('#identifierId, input[type="email"]')
      .first();

    await emailInput.waitFor({
      state: 'visible',
      timeout: 30000
    });

    await emailInput.fill(account.email);

    await pages[0]
      .locator('#identifierNext')
      .click()
      .catch(() => {});

    await pages[0].waitForTimeout(2000);

    const passwordInput = pages[0]
      .locator('input[type="password"]')
      .first();

    await passwordInput.waitFor({
      state: 'visible',
      timeout: 30000
    });

    await passwordInput.fill(account.password);

    await pages[0]
      .locator('#passwordNext')
      .click()
      .catch(() => {});

    await pages[0].waitForTimeout(5000);

    const currentUrl = pages[0].url();

    if (
      /challenge|verify|signin/i.test(currentUrl)
    ) {
      throw new Error(
        'Google meminta verifikasi tambahan atau login belum selesai.'
      );
    }

    console.log(
      `[email:${emailIndex}] Login Google selesai atau sesi sudah diterima.`
    );
  }

  async function openTab(page, targetUrl, tabIndex) {
    console.log(
      `[email:${emailIndex}][tab:${tabIndex}] ` +
      `Membuka ${targetUrl}`
    );

    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForTimeout(3000);

    await handleContinueAndSkip(
      page,
      tabIndex
    );
  }

  async function isPageValid(page) {
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

  async function reloadTab(page, targetUrl, tabIndex) {
    try {
      console.log(
        `[email:${emailIndex}][tab:${tabIndex}] ` +
        `Reload halaman pada ${now()}`
      );

      await page.reload({
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });

      await page.waitForTimeout(3000);

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

        await openTab(
          page,
          targetUrl,
          tabIndex
        );
      }

      return true;
    } catch (error) {
      console.warn(
        `[email:${emailIndex}][tab:${tabIndex}] ` +
        `Reload gagal: ${error.message}`
      );

      try {
        await openTab(
          page,
          targetUrl,
          tabIndex
        );

        return true;
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

        return false;
      }
    }
  }

  try {
    /*
     * Buat lima page/tab dalam satu browser context.
     * Semua tab memakai sesi login email yang sama.
     */
    for (let index = 0; index < 5; index += 1) {
      const page = await context.newPage();
      pages.push(page);

      page.on('console', (message) => {
        console.log(
          `[email:${emailIndex}][tab:${index + 1}] ` +
          `console ${message.type()}: ${message.text()}`
        );
      });

      page.on('requestfailed', (request) => {
        console.warn(
          `[email:${emailIndex}][tab:${index + 1}] ` +
          `Request gagal: ${request.method()} ${request.url()}`
        );
      });
    }

    /*
     * Login dilakukan sekali pada tab pertama.
     * Cookies/session otomatis tersedia untuk tab lain
     * karena semuanya memakai context yang sama.
     */
    await loginGoogle();

    /*
     * Buka lima URL.
     * Tab pertama sudah berada di halaman Google setelah login,
     * sehingga diarahkan ke URL pertama.
     */
    for (let index = 0; index < pages.length; index += 1) {
      const tabIndex = index + 1;
      const page = pages[index];
      const targetUrl = targetUrls[index];

      await openTab(
        page,
        targetUrl,
        tabIndex
      );

      const valid = await isPageValid(page);

      if (!valid) {
        await saveDebug(
          page,
          tabIndex,
          'initial-invalid'
        );

        throw new Error(
          `[tab:${tabIndex}] Target tidak valid setelah dibuka.`
        );
      }

      await safeScreenshot(
        page,
        `opened-email-${emailIndex}-url-${tabIndex}-${timestamp()}.png`
      );
    }

    const endAt =
      Date.now() + keepOpenMinutes * 60 * 1000;

    let nextReloadAt =
      Date.now() + reloadIntervalMinutes * 60 * 1000;

    console.log(
      `[email:${emailIndex}] Lima tab aktif sampai ` +
      `${new Date(endAt).toISOString()}`
    );

    /*
     * Semua lima tab tetap terbuka.
     * Setiap 30 menit, kelima tab direload satu per satu.
     */
    while (
      !abortRequested &&
      Date.now() < endAt
    ) {
      const remainingUntilReload =
        nextReloadAt - Date.now();

      const remainingUntilEnd =
        endAt - Date.now();

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
          `[email:${emailIndex}] ` +
          `Reload lima tab dimulai pada ${now()}`
        );

        for (let index = 0; index < pages.length; index += 1) {
          const tabIndex = index + 1;
          const page = pages[index];
          const targetUrl = targetUrls[index];

          if (abortRequested) {
            break;
          }

          await reloadTab(
            page,
            targetUrl,
            tabIndex
          );
        }

        nextReloadAt =
          Date.now() + reloadIntervalMinutes * 60 * 1000;

        console.log(
          `[email:${emailIndex}] ` +
          'Reload lima tab selesai.'
        );
      }
    }

    console.log(
      `[email:${emailIndex}] Sesi lima tab selesai pada ${now()}`
    );
  } catch (error) {
    console.error(
      `[email:${emailIndex}] Error: ${error.stack || error}`
    );

    for (let index = 0; index < pages.length; index += 1) {
      await saveDebug(
        pages[index],
        index + 1,
        'error'
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
