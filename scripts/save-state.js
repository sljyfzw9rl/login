const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('Membuka halaman login Google. Silakan login secara manual di jendela yang muncul.');
  await page.goto('https://accounts.google.com/signin/v2/identifier', { waitUntil: 'networkidle' });

  console.log('Setelah login selesai dan kamu sudah berada di akun, tekan ENTER di terminal ini untuk menyimpan session.');
  process.stdin.resume();
  process.stdin.on('data', async () => {
    await context.storageState({ path: 'state.json' });
    console.log('Saved state.json');
    await browser.close();
    process.exit(0);
  });
})();
