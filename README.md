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

Setiap workflow menjalankan matrix lima job secara paralel. Satu job memakai satu akun dan membuka lima page/tab dalam satu browser context akun. Jadi totalnya 5 job × 5 tab = 25 tab:

- Matrix job 1 memakai Email 1 dan membuka URL 1 sampai URL 5.
- Matrix job 2 memakai Email 2 dan membuka URL 1 sampai URL 5.
- Matrix job 3 memakai Email 3 dan membuka URL 1 sampai URL 5.
- Matrix job 4 memakai Email 4 dan membuka URL 1 sampai URL 5.
- Matrix job 5 memakai Email 5 dan membuka URL 1 sampai URL 5.

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

### GMAIL_ACCOUNT_LIST

Isi lima akun dalam format `email:password`, satu akun per baris. Pemisah koma juga didukung, tetapi format baris baru lebih aman:

```text
email1@gmail.com:password1
email2@gmail.com:password2
email3@gmail.com:password3
email4@gmail.com:password4
email5@gmail.com:password5
```

Atau:

```text
email1@gmail.com:password1
email2@gmail.com:password2
email3@gmail.com:password3
email4@gmail.com:password4
email5@gmail.com:password5
```

Pemetaan:

```text
Email 1 → URL 1, URL 2, URL 3, URL 4, URL 5
Email 2 → URL 1, URL 2, URL 3, URL 4, URL 5
Email 3 → URL 1, URL 2, URL 3, URL 4, URL 5
Email 4 → URL 1, URL 2, URL 3, URL 4, URL 5
Email 5 → URL 1, URL 2, URL 3, URL 4, URL 5
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
