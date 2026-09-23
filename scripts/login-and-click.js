'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

let stopRequested = false;
process.on('SIGTERM', () => { console.warn('SIGTERM diterima.'); stopRequested = true; });
process.on('SIGINT', () => { console.warn('SIGINT diterima.'); stopRequested = true; });

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
    .split(/[\r\n,]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const separatorIndex = line.indexOf(':');
      if (separatorIndex <= 0) {
        throw new Error(`Format akun baris ${index + 1} tidak valid. Gunakan format email:password.`);
      }
      const email = line.slice(0, separatorIndex).trim();
      const password = line.slice(separatorIndex + 1).trim();
      if (!email || !password) {
        throw new Error(`Email atau password baris ${index + 1} kosong.`);
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
async function screenshot(page, filePath) {
  await page.screenshot({ path: filePath, fullPage: true }).catch(() => {});
}
function ignoredRequest(url) {
  return /google-analytics|analytics\.google|doubleclick|googletagmanager|csp\.withgoogle\.com|play\.google\.com\/log|\/ccm\/collect|directaccessweb-pa\.googleapis\.com\/webrtc|cleardot\.gif/i.test(url || '');
}
async function isVisible(page, selector) {
  return page.locator(selector).first().isVisible().catch(() => false);
}
async function clickText(page, labels, prefix) {
  for (const label of labels) {
    for (const frame of page.frames()) {
      try {
        const locator = frame.getByText(label, { exact: false }).first();
        if (await locator.isVisible({ timeout: 1500 }).catch(() => false)) {
          await locator.click({ timeout: 5000 });
          console.log(`${prefix} Klik: ${label}`);
          return true;
        }
      } catch {
        // lanjut
      }
    }
  }
  return false;
}
async function clickTwoStepLater(page, prefix) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const clicked = await clickText(page, ['Lakukan ini nanti', 'Do this later'], prefix);
    if (clicked) {
      await page.waitForTimeout(8000);
      return true;
    }
    await page.waitForTimeout(1000);
  }
  return false;
}
async function hasLoginForm(page) {
  const emailVisible = await isVisible(page, '#identifierId, input[type="email"]');
  const passwordVisible = await isVisible(page, 'input[type="password"]');
  return emailVisible || passwordVisible;
}
async function saveDebug(page, emailIndex, urlIndex, label) {
  const prefix = `debug-email-${emailIndex}-url-${urlIndex}-${label}-${timestamp()}`;
  await screenshot(page, `${prefix}.png`);
  await fs.promises.writeFile(`${prefix}.html`, await page.content().catch(() => '')).catch(() => {});
  await fs.promises.writeFile(`${prefix}-url.txt`, page.url()).catch(() => {});
}

async function loginOnceAndSaveState({ browser, account, emailIndex, statePath, warmUpUrl }) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();

  try {
    console.log(`[email:${emailIndex}] Login Google dilakukan satu kali.`);
    await page.goto('https://accounts.google.com/signin/v2/identifier', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await page.waitForTimeout(3000);

    const emailInput = page.locator('#identifierId, input[type="email"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 40000 });
    await emailInput.fill(account.email);
    await page.locator('#identifierNext').click().catch(() => {});
    console.log(`[email:${emailIndex}] Email dikirim.`);
    await page.waitForTimeout(5000);

    const passwordInput = page.locator('input[type="password"]').first();
    await passwordInput.waitFor({ state: 'visible', timeout: 50000 });
    await passwordInput.fill(account.password);
    await page.locator('#passwordNext').click().catch(() => {});
    console.log(`[email:${emailIndex}] Password dikirim.`);
    await page.waitForTimeout(8000);

    await clickTwoStepLater(page, `[email:${emailIndex}]`);

    // Tunggu sampai benar-benar lewat login
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (stopRequested) throw new Error('Login dihentikan.');

      await clickTwoStepLater(page, `[email:${emailIndex}]`);

      const currentUrl = page.url();
      const body = await page.locator('body').innerText().catch(() => '');

      const realChallenge = /enter code|masukkan kode|verification code|kode verifikasi|security key|passkey|verify it.?s you|try another way|coba cara lain|captcha|suspicious sign.?in/i.test(body);
      if (realChallenge) {
        await saveDebug(page, emailIndex, 0, 'google-challenge');
        throw new Error('Google meminta verifikasi tambahan manual.');
      }

      const formVisible = await hasLoginForm(page);
      const reminderVisible = /jangan sampai terkunci|domain akan segera menerapkan|daftar verifikasi 2 langkah/i.test(body);

      if (reminderVisible) {
        await page.waitForTimeout(2000);
        continue;
      }

      if (!formVisible && !/twosvrequired/i.test(currentUrl)) {
        await page.waitForTimeout(8000);
        const formAfterWait = await hasLoginForm(page);
        if (!formAfterWait) {
          console.log(`[email:${emailIndex}] Login Google selesai.`);
          break;
        }
      }
      await page.waitForTimeout(3000);
    }

    // === PERBAIKAN PENTING: Warm-up AI Studio SEBELUM simpan state ===
    console.log(`[email:${emailIndex}] Warm-up AI Studio untuk mendapatkan cookie yang benar...`);
    await page.goto(warmUpUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 90000
    });
    await page.waitForTimeout(12000);

    // Handle dialog AI Studio
    await clickText(page, ['Continue to the app', 'Continue', 'Lanjutkan ke aplikasi', 'Lanjutkan'], `[email:${emailIndex}]`);
    await page.waitForTimeout(3000);
    await clickText(page, ['Skip tutorial', 'Skip tour', 'Skip', 'Lewati'], `[email:${emailIndex}]`);
    await page.waitForTimeout(8000);

    // Cek apakah masih di halaman login Google
    if (await hasLoginForm(page) || /accounts\.google\.com/i.test(page.url())) {
      await saveDebug(page, emailIndex, 0, 'warmup-still-login');
      throw new Error('Setelah warm-up masih terdeteksi halaman login Google.');
    }

    // Simpan state SETELAH berhasil masuk AI Studio
    await context.storageState({ path: statePath });
    console.log(`[email:${emailIndex}] Session disimpan (sudah warm-up AI Studio).`);

    // Screenshot bukti
    await screenshot(page, `opened-email-${emailIndex}-warmup-${timestamp()}.png`);

  } finally {
    await context.close().catch(() => {});
  }
}

async function openTarget(page, targetUrl, prefix) {
  console.log(`${prefix} Membuka target.`);
  await page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 90000
  });
  await page.waitForTimeout(15000);

  await clickText(page, ['Continue to the app', 'Continue', 'Lanjutkan ke aplikasi', 'Lanjutkan'], prefix);
  await page.waitForTimeout(3000);
  await clickText(page, ['Skip tutorial', 'Skip tour', 'Skip', 'Lewati'], prefix);
  await page.waitForTimeout(8000);
}

async function isTargetValid(page) {
  const currentUrl = page.url();
  if (!currentUrl || currentUrl === 'about:blank') return false;
  if (/accounts\.google\.com\/(signin|ServiceLogin|challenge)/i.test(currentUrl)) return false;

  const selectors = ['#identifierId', 'input[type="email"]', 'input[type="password"]'];
  for (const selector of selectors) {
    const count = await page.locator(selector).count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      if (await page.locator(selector).nth(i).isVisible().catch(() => false)) return false;
    }
  }
  return true;
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
    viewport: { width: 1280, height: 800 },
    // recordVideo dimatikan dulu biar lebih ringan (bisa diaktifkan lagi kalau perlu)
    // recordVideo: { dir: 'videos', size: { width: 1280, height: 800 } }
  });

  const page = await context.newPage();

  page.on('console', (message) => {
    const text = message.text();
    if (/Self-XSS|No available adapters|Content Security Policy|rtc connection lost|401|403/i.test(text)) return;
    if (message.type() === 'error') {
      console.warn(`${prefix} Browser error: ${text.slice(0, 300)}`);
    }
  });

  page.on('requestfailed', (request) => {
    const url = request.url();
    if (ignoredRequest(url)) return;
    // Hanya log yang benar-benar penting
    if (!/401|403|cleardot/i.test(url)) {
      console.warn(`${prefix} Request gagal: ${request.method()} ${url.slice(0, 200)}`);
    }
  });

  try {
    await openTarget(page, targetUrl, prefix);

    if (!(await isTargetValid(page))) {
      await saveDebug(page, emailIndex, urlIndex, 'invalid');
      console.warn(`${prefix} Halaman terlihat belum login / invalid.`);
    } else {
      console.log(`${prefix} Session aktif.`);
    }

    await screenshot(page, `opened-email-${emailIndex}-url-${urlIndex}-${timestamp()}.png`);

    const endAt = Date.now() + keepOpenMinutes * 60 * 1000;
    let nextReloadAt = Date.now() + reloadIntervalMinutes * 60 * 1000;

    while (!stopRequested && Date.now() < endAt) {
      const untilReload = nextReloadAt - Date.now();
      const untilEnd = endAt - Date.now();
      const waitTime = Math.min(30000, Math.max(1000, Math.min(untilReload, untilEnd)));

      await sleep(waitTime);

      if (stopRequested || Date.now() >= endAt) break;

      if (Date.now() >= nextReloadAt) {
        console.log(`${prefix} Reload pada ${now()}.`);
        try {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForTimeout(12000);
          await clickText(page, ['Continue to the app', 'Continue', 'Lanjutkan ke aplikasi', 'Lanjutkan'], prefix);
          await page.waitForTimeout(2000);
          await clickText(page, ['Skip tutorial', 'Skip tour', 'Skip', 'Lewati'], prefix);
          await page.waitForTimeout(4000);
          await screenshot(page, `reload-email-${emailIndex}-url-${urlIndex}-${timestamp()}.png`);
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
  const emailIndex = parseInt(process.env.EMAIL_INDEX || '1', 10);
  const keepOpenMinutes = Math.max(1, parseInt(process.env.KEEP_OPEN_MINUTES || '350', 10));
  const reloadIntervalMinutes = Math.max(1, parseInt(process.env.RELOAD_INTERVAL_MINUTES || '30', 10));
  const accounts = parseAccounts(process.env.GMAIL_ACCOUNT_LIST);
  const urls = parseList(process.env.AI_STUDIO_URL);

  if (!Number.isInteger(emailIndex) || emailIndex < 1 || emailIndex > 5) {
    throw new Error(`EMAIL_INDEX harus bernilai 1 sampai 5, tetapi nilainya ${process.env.EMAIL_INDEX || '(kosong)'}.`);
  }
  if (accounts.length < 5) {
    throw new Error(`Dibutuhkan minimal 5 akun pada GMAIL_ACCOUNT_LIST, tetapi hanya ditemukan ${accounts.length}.`);
  }
  if (urls.length < 5) {
    throw new Error(`Dibutuhkan minimal 5 URL pada AI_STUDIO_URL, tetapi hanya ditemukan ${urls.length}.`);
  }

  // Satu matrix job menangani satu akun. Setiap akun membuka lima context/tab.
  const account = accounts[emailIndex - 1];
  const targetUrls = urls.slice(0, 5);
  const tempDirectory = path.resolve('.runtime');
  fs.mkdirSync(tempDirectory, { recursive: true });
  const statePath = path.join(tempDirectory, `storage-email-${emailIndex}.json`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  try {
    console.log(`MATRIX_EMAIL_INDEX=${emailIndex}`);
    console.log(`PARSED_ACCOUNTS=${accounts.length}`);
    console.log(`PARSED_URLS=${urls.length}`);
    console.log('TOTAL_MATRIX_JOBS=5');
    console.log('TOTAL_ISOLATED_SESSIONS=5');

    await loginOnceAndSaveState({
      browser,
      account,
      emailIndex,
      statePath,
      warmUpUrl: targetUrls[0]
    });

    console.log(`[email:${emailIndex}] Menjalankan ${targetUrls.length} context terisolasi.`);
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
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(`Fatal error: ${error.stack || error}`);
  process.exitCode = 1;
});
