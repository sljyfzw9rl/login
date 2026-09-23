# Gmail login + AI Studio keepalive

Automation Playwright untuk:

- Login ke Google.
- Membuka beberapa URL AI Studio.
- Menekan tombol `Continue to the app`.
- Menekan tombol `Skip` jika tersedia.
- Menjaga halaman tetap terbuka selama hampir 6 jam.
- Reload halaman setiap 30 menit.
- Membuka ulang halaman apabila reload gagal.
- Menjalankan beberapa URL secara paralel.

## Cara kerja

Workflow dijalankan setiap 6 jam menggunakan cron UTC:

```text
0 */6 * * *
```

Setiap workflow menjalankan lima instance:

- Instance 1 menggunakan URL pertama.
- Instance 2 menggunakan URL kedua.
- Instance 3 menggunakan URL ketiga.
- Instance 4 menggunakan URL keempat.
- Instance 5 menggunakan URL kelima.

Browser tetap terbuka selama 350 menit. Setelah itu browser ditutup agar tidak melewati batas waktu runner GitHub Actions enam jam.

## Secret yang diperlukan

Buka:

```text
Settings → Secrets and variables → Actions
```

Tambahkan secret berikut.

### AI_STUDIO_URL

Bisa menggunakan koma:

```text
https://url1,https://url2,https://url3,https://url4,https://url5
```

Atau menggunakan baris baru:

```text
https://url1
https://url2
https://url3
https://url4
https://url5
```

### GMAIL_USER_LIST

Isi daftar email sesuai urutan URL:

```text
email1@gmail.com,email2@gmail.com,email3@gmail.com,email4@gmail.com,email5@gmail.com
```

Atau:

```text
email1@gmail.com
email2@gmail.com
email3@gmail.com
email4@gmail.com
email5@gmail.com
```

Pemetaan:

```text
URL 1 → email 1
URL 2 → email 2
URL 3 → email 3
URL 4 → email 4
URL 5 → email 5
```

### GMAIL_PASSWORD

Password Gmail. Digunakan jika tidak memakai `GMAIL_STORAGE_STATE`.

### GMAIL_STORAGE_STATE

Base64 dari file Playwright storage state. Ini lebih direkomendasikan daripada login menggunakan username dan password setiap workflow.

### GMAIL_USERNAME

Opsional. Digunakan jika hanya ada satu akun Gmail.

## Pengaturan durasi

Pengaturan terdapat pada workflow:

```yaml
KEEP_OPEN_MINUTES: '350'
RELOAD_INTERVAL_MINUTES: '30'
```

Artinya:

- Browser hidup selama 350 menit.
- Halaman reload setiap 30 menit.

## Catatan GitHub Actions

GitHub-hosted runner bersifat sementara. Halaman hanya akan tetap terbuka selama job berjalan. Ketika job selesai, browser dan runner akan dihentikan.

Cron GitHub Actions menggunakan UTC dan bisa mengalami keterlambatan beberapa menit.

## Menjalankan secara lokal

```bash
npm ci
npx playwright install chromium
node scripts/login-and-click.js
```
