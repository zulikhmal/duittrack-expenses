# DuitTrack — Rekod Perbelanjaan & Deduct Bil (Cloudflare Workers + Google Sheets)

Aplikasi web moden untuk merekod perbelanjaan dan komitmen bulanan (**RM / MYR**), **deduct automatik daripada bajet/baki apabila dibayar** (sama ada bayaran penuh atau separuh), dan menyimpan semua rekod terus ke **Google Sheets**.

## Pautan Google Sheet Anda
- **Google Sheet DB:** [DuitTrack - Expense Tracker DB](https://docs.google.com/spreadsheets/d/10tMHyAHHCFKBLmNYwKKlwzQ8fbrIBNhd04Ht3JrVtlQ/edit)
- Tab yang tersedia:
  - `Expenses` — semua rekod perbelanjaan (`id`, `month`, `date`, `title`, `category`, `amount`, `paid_amount`, `status`, `paid_at`, `notes`, `created_at`)
  - `Budgets` — bajet / gaji bulanan mengikut bulan (`YYYY-MM`)
  - `Summary` — ringkasan formula automatik dalam Google Sheet

---

## Ciri-Ciri Utama
- **Deduct Automatik Bila Dah Bayar:** Tandakan ✔ pada mana-mana bil untuk terus menolak `Baki Semasa` dan mengemaskini Google Sheet.
- **Sokong Bayar Separuh (Partial Payment):** Bayar ansuran atau separuh bil dan lihat baki yang tinggal.
- **Tambah & Terus Deduct:** Pilih sama ada item baru ialah komitmen (`Belum Bayar`) atau perbelanjaan harian (`Dah Bayar`).
- **Padam Rekod Terus dari Google Sheet:** Menghapus baris rekod terus daripada tab `Expenses`.
- **Salin Komitmen Bulan Lepas:** Salin bil berulang ke bulan baru dengan status ditetapkan semula ke `Belum Bayar`.
- **Mod Cerah / Gelap + Eksport CSV + Kunci PIN (`APP_PIN`).**

---

## Panduan Setup & Deploy Live

### Langkah 1: Pasang Google Apps Script pada Google Sheet
1. Buka Google Sheet anda: https://docs.google.com/spreadsheets/d/10tMHyAHHCFKBLmNYwKKlwzQ8fbrIBNhd04Ht3JrVtlQ/edit
2. Klik **Extensions** → **Apps Script**.
3. Padam kod asal dalam `Code.gs`, kemudian salin & tampal keseluruhan kandungan fail [`google-apps-script/Code.gs`](google-apps-script/Code.gs).
4. Simpan projek (`Ctrl + S`).
5. *(Pilihan keselamatan)* Pergi ke **Project Settings** → **Script Properties** → tambah `API_SECRET` dengan kata laluan pilihan anda.
6. Klik **Deploy** → **New deployment**:
   - Select type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
7. Klik **Deploy**, benarkan akses Google, dan salin **Web App URL** yang berakhir dengan `/exec`.

---

### Langkah 2: Simpan Kod ke GitHub
Cipta satu repositori baru di GitHub (contohnya `duittrack-expenses`), kemudian jalankan arahan ini di dalam folder projek:

```bash
git remote add origin https://github.com/<USERNAME_ANDA>/duittrack-expenses.git
git push -u origin main
```

---

### Langkah 3: Run Live Guna Cloudflare Workers
1. Log masuk ke **Cloudflare Dashboard** → **Workers & Pages** → **Create** → **Import a repository**.
2. Pilih repositori GitHub `duittrack-expenses` anda dan teruskan deploy (Cloudflare membaca tetapan daripada [`wrangler.jsonc`](wrangler.jsonc)).
3. Selepas deploy, buka Worker anda → **Settings** → **Variables and Secrets**, dan tambah:
   - `GAS_WEBAPP_URL` = *(Web App URL `/exec` dari Langkah 1)*
   - `SPREADSHEET_URL` = `https://docs.google.com/spreadsheets/d/10tMHyAHHCFKBLmNYwKKlwzQ8fbrIBNhd04Ht3JrVtlQ/edit`
   - `GAS_API_SECRET` *(pilihan — jika ditetapkan di Apps Script)*
   - `APP_PIN` *(pilihan — kod PIN untuk kunci akses web app)*
4. Atau deploy terus dari terminal menggunakan Wrangler:
   ```bash
   npx wrangler secret put GAS_WEBAPP_URL
   npm run deploy
   ```

---

## Ujian & Pembangunan Lokal
Jalankan ujian unit:
```bash
npm test
```

Jalankan server pembangunan lokal (tanpa kebergantungan luar):
```bash
npm run dev
```
Buka pelayar ke `http://127.0.0.1:8787`.

*(Untuk menguji sambungan Google Sheet secara lokal, salin `.dev.vars.example` kepada `.dev.vars` dan isi `GAS_WEBAPP_URL`.)*

---

## Alternatif: Sambungan Terus Google Sheets API v4 (Service Account)
Jika anda lebih suka menggunakan Service Account Google Cloud tanpa Apps Script, tetapkan tiga secret berikut pada Cloudflare Workers (dan kongsikan Google Sheet dengan e-mel Service Account sebagai *Editor*):
- `GOOGLE_SPREADSHEET_ID`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
