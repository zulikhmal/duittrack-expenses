const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

const tokenCacheByFetch = new WeakMap();

export class ApiError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function roundMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}

export function getTodayDateString(nowIso) {
  if (nowIso && typeof nowIso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(nowIso)) {
    return nowIso.slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

export function normalizeMonth(val) {
  if (val === null || val === undefined || val === '') return '';
  const str = String(val).trim();
  const match = str.match(/^(\d{4}-\d{2})/);
  return match ? match[1] : str;
}

export function normalizeDate(val) {
  if (val === null || val === undefined || val === '') return '';
  const str = String(val).trim();
  const match = str.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : str;
}

/**
 * Compute canonical rounded amounts, clamped paid_amount, payment status, and paid_at date.
 */
export function computePaymentState(amount, paidAmount, paidAt, nowIso) {
  const rawAmount = Number(amount);
  const safeAmount = Number.isFinite(rawAmount) ? Math.max(0, roundMoney(rawAmount)) : 0;

  const rawPaid = Number(paidAmount);
  const clampedPaid = Number.isFinite(rawPaid) ? Math.min(safeAmount, Math.max(0, roundMoney(rawPaid))) : 0;

  let status = 'unpaid';
  if (safeAmount > 0 && clampedPaid >= safeAmount) {
    status = 'paid';
  } else if (clampedPaid > 0) {
    status = 'partial';
  } else if (safeAmount === 0 && Number.isFinite(rawPaid) && rawPaid > 0) {
    status = 'paid';
  }

  let nextPaidAt = '';
  if (status !== 'unpaid') {
    nextPaidAt = paidAt ? normalizeDate(paidAt) : getTodayDateString(nowIso);
  }

  return {
    amount: safeAmount,
    paid_amount: clampedPaid,
    status,
    paid_at: nextPaidAt
  };
}

/**
 * Constant-time string equality check for APP_PIN verification.
 */
export function constantTimeEqual(a, b) {
  const strA = String(a ?? '');
  const strB = String(b ?? '');
  const enc = new TextEncoder();
  const bytesA = enc.encode(strA);
  const bytesB = enc.encode(strB);

  const maxLen = Math.max(bytesA.length, bytesB.length);
  let diff = bytesA.length ^ bytesB.length;
  for (let i = 0; i < maxLen; i++) {
    const byteA = i < bytesA.length ? bytesA[i] : 0;
    const byteB = i < bytesB.length ? bytesB[i] : 0;
    diff |= byteA ^ byteB;
  }
  return diff === 0;
}

export function detectBackendMode(env) {
  if (env?.GAS_WEBAPP_URL && String(env.GAS_WEBAPP_URL).trim()) {
    return 'apps_script';
  }
  if (
    env?.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
    env?.GOOGLE_PRIVATE_KEY &&
    env?.GOOGLE_SPREADSHEET_ID
  ) {
    return 'sheets_api';
  }
  return 'unconfigured';
}

function base64UrlEncode(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function pemToArrayBuffer(pem) {
  const normalized = String(pem || '')
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');

  if (!normalized) {
    throw new ApiError('GOOGLE_PRIVATE_KEY tidak sah atau kosong.', 500, 'INVALID_KEY');
  }

  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Sign a Google OAuth 2.0 Service Account JWT using Web Crypto RS256.
 */
export async function signGoogleJwt(email, privateKeyPem, scope = SHEETS_SCOPE, nowSeconds) {
  const iat = Number.isFinite(nowSeconds) ? Math.floor(nowSeconds) : Math.floor(Date.now() / 1000);
  const exp = iat + 3600;

  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64UrlEncode(
    JSON.stringify({
      iss: email,
      scope,
      aud: GOOGLE_TOKEN_URL,
      iat,
      exp
    })
  );

  const signingInput = `${header}.${claim}`;
  const keyBuffer = pemToArrayBuffer(privateKeyPem);
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64UrlEncode(signature)}`;
}

async function getGoogleAccessToken(env, fetchImpl = fetch) {
  const cacheKey = `${env.GOOGLE_SERVICE_ACCOUNT_EMAIL}:${env.GOOGLE_SPREADSHEET_ID}`;
  let cache = tokenCacheByFetch.get(fetchImpl);
  if (!cache) {
    cache = new Map();
    tokenCacheByFetch.set(fetchImpl, cache);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > nowSec + 60) {
    return cached.token;
  }

  const assertion = await signGoogleJwt(
    env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    env.GOOGLE_PRIVATE_KEY,
    SHEETS_SCOPE,
    nowSec
  );

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion
  });

  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new ApiError(
      `Gagal mendapatkan token akses Google: ${data.error_description || data.error || res.status}`,
      502,
      'GOOGLE_AUTH_FAILED'
    );
  }

  cache.set(cacheKey, {
    token: data.access_token,
    expiresAt: nowSec + Number(data.expires_in || 3600)
  });

  return data.access_token;
}

/**
 * Forward an action payload to the configured Google Apps Script Web App.
 */
export async function callAppsScript(env, payload, fetchImpl = fetch) {
  const url = String(env?.GAS_WEBAPP_URL || '').trim();
  if (!url) {
    throw new ApiError('GAS_WEBAPP_URL tidak ditetapkan.', 503, 'UNCONFIGURED');
  }
  if (!/^https:\/\/script\.google\.com\//i.test(url) && !/^https?:\/\//i.test(url)) {
    throw new ApiError('Format GAS_WEBAPP_URL tidak sah.', 400, 'INVALID_URL');
  }
  if (/\/edit(\?|$)/i.test(url)) {
    throw new ApiError(
      'URL Apps Script anda berakhir dengan `/edit`. Sila Deploy sebagai Web App dan gunakan URL `/exec`.',
      400,
      'INVALID_APPS_SCRIPT_URL'
    );
  }

  const res = await fetchImpl(url, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      ...payload,
      secret: env.GAS_API_SECRET || ''
    })
  });

  const contentType = String(res.headers?.get?.('content-type') || '');
  const text = await res.text();
  const trimmed = text.trim();

  if (contentType.includes('text/html') || trimmed.startsWith('<')) {
    throw new ApiError(
      'Apps Script memulangkan HTML bukannya JSON. Pastikan Web App dideploy dengan tetapan "Who has access: Anyone" dan gunakan URL `/exec`.',
      502,
      'APPS_SCRIPT_HTML_RESPONSE'
    );
  }

  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    throw new ApiError(`Respons Apps Script tidak sah (${res.status}).`, 502, 'INVALID_UPSTREAM_JSON');
  }

  if (!res.ok || data?.ok === false) {
    const message = data?.error || `Ralat Apps Script (HTTP ${res.status})`;
    const status = message.toLowerCase().includes('tidak ditemui') ? 404 : 502;
    throw new ApiError(message, status, 'APPS_SCRIPT_ERROR');
  }

  return data;
}

function rowToExpense(row) {
  const dateStr = normalizeDate(row[2]);
  const monthStr = normalizeMonth(row[1]) || (dateStr ? dateStr.slice(0, 7) : '');
  const payment = computePaymentState(row[5], row[6], row[8]);

  return {
    id: String(row[0] || '').trim(),
    month: monthStr,
    date: dateStr,
    title: String(row[3] || '').trim(),
    category: String(row[4] || 'Lain-lain').trim() || 'Lain-lain',
    amount: payment.amount,
    paid_amount: payment.paid_amount,
    status: row[7] ? String(row[7]).trim() : payment.status,
    paid_at: normalizeDate(row[8]),
    notes: String(row[9] || ''),
    created_at: String(row[10] || '')
  };
}

function expenseToRow(exp) {
  return [
    String(exp.id),
    String(exp.month),
    String(exp.date),
    String(exp.title),
    String(exp.category),
    Number(exp.amount),
    Number(exp.paid_amount),
    String(exp.status),
    String(exp.paid_at || ''),
    String(exp.notes || ''),
    String(exp.created_at || new Date().toISOString())
  ];
}

function rowToBudget(row) {
  return {
    month: normalizeMonth(row[0]),
    income_budget: Math.max(0, roundMoney(row[1])),
    notes: String(row[2] || ''),
    updated_at: String(row[3] || '')
  };
}

function clampDayForMonth(monthStr, dayStr) {
  const [year, month] = monthStr.split('-').map(Number);
  const maxDays = new Date(year, month, 0).getDate();
  const parsedDay = Number(dayStr) || 1;
  const clamped = Math.min(Math.max(1, parsedDay), maxDays);
  return String(clamped).padStart(2, '0');
}

async function sheetsFetchJson(url, token, init, fetchImpl) {
  const res = await fetchImpl(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg = data?.error?.message || `Google Sheets API HTTP ${res.status}`;
    throw new ApiError(errMsg, res.status >= 400 && res.status < 500 ? res.status : 502, 'SHEETS_API_ERROR');
  }
  return data;
}

/**
 * Execute an action directly against Google Sheets API v4 using a Service Account.
 */
export async function callSheetsApi(env, action, payload = {}, fetchImpl = fetch) {
  const spreadsheetId = String(env?.GOOGLE_SPREADSHEET_ID || '').trim();
  if (!spreadsheetId) {
    throw new ApiError('GOOGLE_SPREADSHEET_ID tidak ditetapkan.', 503, 'UNCONFIGURED');
  }

  const token = await getGoogleAccessToken(env, fetchImpl);
  const baseUrl = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}`;

  if (action === 'health') {
    const meta = await sheetsFetchJson(
      `${baseUrl}?fields=spreadsheetId,properties.title,sheets(properties(sheetId,title))`,
      token,
      { method: 'GET' },
      fetchImpl
    );
    return {
      ok: true,
      spreadsheetId: meta.spreadsheetId || spreadsheetId,
      spreadsheetName: meta.properties?.title || 'Google Sheet',
      mode: 'sheets_api'
    };
  }

  if (action === 'list') {
    const batch = await sheetsFetchJson(
      `${baseUrl}/values:batchGet?ranges=${encodeURIComponent('Expenses!A2:K')}&ranges=${encodeURIComponent('Budgets!A2:D')}&valueRenderOption=UNFORMATTED_VALUE`,
      token,
      { method: 'GET' },
      fetchImpl
    );
    const expRows = batch.valueRanges?.[0]?.values || [];
    const budgetRows = batch.valueRanges?.[1]?.values || [];

    let expenses = expRows.filter((r) => String(r[0] || '').trim() !== '').map(rowToExpense);
    let budgets = budgetRows.filter((r) => String(r[0] || '').trim() !== '').map(rowToBudget);

    if (payload.month) {
      const targetMonth = normalizeMonth(payload.month);
      expenses = expenses.filter((e) => e.month === targetMonth);
      budgets = budgets.filter((b) => b.month === targetMonth);
    }

    return { ok: true, expenses, budgets };
  }

  if (action === 'add') {
    const title = String(payload.title || '').trim();
    if (!title) throw new ApiError('Nama perbelanjaan wajib diisi.', 400, 'VALIDATION_ERROR');

    const rawAmount = Number(payload.amount);
    if (!Number.isFinite(rawAmount) || rawAmount < 0) {
      throw new ApiError('Jumlah perbelanjaan tidak sah.', 400, 'VALIDATION_ERROR');
    }

    const nowIso = new Date().toISOString();
    const date = normalizeDate(payload.date) || nowIso.slice(0, 10);
    const month = normalizeMonth(payload.month) || date.slice(0, 7);
    const id = String(payload.id || '').trim() || `exp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    let requestedPaid = payload.paid_amount;
    if (requestedPaid === undefined || requestedPaid === null) {
      requestedPaid = payload.status === 'paid' ? rawAmount : 0;
    }

    const payment = computePaymentState(rawAmount, requestedPaid, payload.paid_at, nowIso);
    const expense = {
      id,
      month,
      date,
      title,
      category: String(payload.category || 'Lain-lain').trim() || 'Lain-lain',
      amount: payment.amount,
      paid_amount: payment.paid_amount,
      status: payment.status,
      paid_at: payment.paid_at,
      notes: String(payload.notes || '').trim(),
      created_at: nowIso
    };

    await sheetsFetchJson(
      `${baseUrl}/values/${encodeURIComponent('Expenses!A1:K1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      token,
      {
        method: 'POST',
        body: JSON.stringify({ values: [expenseToRow(expense)] })
      },
      fetchImpl
    );

    return { ok: true, expense };
  }

  if (action === 'update' || action === 'pay') {
    const id = String(payload.id || '').trim();
    if (!id) throw new ApiError('ID rekod diperlukan.', 400, 'VALIDATION_ERROR');

    const readRes = await sheetsFetchJson(
      `${baseUrl}/values/${encodeURIComponent('Expenses!A2:K')}?valueRenderOption=UNFORMATTED_VALUE`,
      token,
      { method: 'GET' },
      fetchImpl
    );
    const rows = readRes.values || [];
    const idx = rows.findIndex((r) => String(r[0] || '').trim() === id);
    if (idx === -1) {
      throw new ApiError(`Rekod tidak ditemui: ${id}`, 404, 'NOT_FOUND');
    }

    const rowNumber = idx + 2;
    const current = rowToExpense(rows[idx]);
    const nowIso = new Date().toISOString();
    let updated;

    if (action === 'update') {
      const nextTitle = payload.title !== undefined ? String(payload.title).trim() : current.title;
      if (!nextTitle) throw new ApiError('Nama perbelanjaan tidak boleh kosong.', 400, 'VALIDATION_ERROR');

      const nextDate = payload.date !== undefined ? normalizeDate(payload.date) : current.date;
      const nextMonth = payload.month !== undefined
        ? normalizeMonth(payload.month)
        : (nextDate ? nextDate.slice(0, 7) : current.month);
      const nextAmount = payload.amount !== undefined ? Number(payload.amount) : current.amount;
      if (!Number.isFinite(nextAmount) || nextAmount < 0) {
        throw new ApiError('Jumlah perbelanjaan tidak sah.', 400, 'VALIDATION_ERROR');
      }

      let nextPaid = current.paid_amount;
      if (payload.paid_amount !== undefined) {
        nextPaid = Number(payload.paid_amount);
      } else if (payload.status === 'paid') {
        nextPaid = nextAmount;
      } else if (payload.status === 'unpaid') {
        nextPaid = 0;
      }

      const nextPaidAtInput = payload.paid_at !== undefined ? payload.paid_at : current.paid_at;
      const payment = computePaymentState(nextAmount, nextPaid, nextPaidAtInput, nowIso);

      updated = {
        id: current.id,
        month: nextMonth,
        date: nextDate,
        title: nextTitle,
        category: payload.category !== undefined ? (String(payload.category).trim() || 'Lain-lain') : current.category,
        amount: payment.amount,
        paid_amount: payment.paid_amount,
        status: payment.status,
        paid_at: payment.paid_at,
        notes: payload.notes !== undefined ? String(payload.notes).trim() : current.notes,
        created_at: current.created_at || nowIso
      };
    } else {
      const mode = String(payload.mode || 'full').toLowerCase();
      let targetPaid = current.paid_amount;
      let targetPaidAt = payload.paid_at || nowIso.slice(0, 10);

      if (mode === 'full') {
        targetPaid = current.amount;
      } else if (mode === 'unpay') {
        targetPaid = 0;
        targetPaidAt = '';
      } else if (mode === 'partial') {
        if (payload.add_amount !== undefined && payload.add_amount !== null && payload.add_amount !== '') {
          const addAmt = Number(payload.add_amount);
          if (!Number.isFinite(addAmt) || addAmt < 0) {
            throw new ApiError('Jumlah bayaran tidak sah.', 400, 'VALIDATION_ERROR');
          }
          targetPaid = current.paid_amount + addAmt;
        } else if (payload.paid_amount !== undefined && payload.paid_amount !== null && payload.paid_amount !== '') {
          const setAmt = Number(payload.paid_amount);
          if (!Number.isFinite(setAmt) || setAmt < 0) {
            throw new ApiError('Jumlah bayaran tidak sah.', 400, 'VALIDATION_ERROR');
          }
          targetPaid = setAmt;
        } else {
          throw new ApiError('Sila masukkan jumlah bayaran separuh.', 400, 'VALIDATION_ERROR');
        }
      } else {
        throw new ApiError(`Mod bayaran tidak sah: ${mode}`, 400, 'VALIDATION_ERROR');
      }

      const payment = computePaymentState(current.amount, targetPaid, targetPaidAt, nowIso);
      updated = {
        ...current,
        paid_amount: payment.paid_amount,
        status: payment.status,
        paid_at: payment.paid_at
      };
    }

    await sheetsFetchJson(
      `${baseUrl}/values/${encodeURIComponent(`Expenses!A${rowNumber}:K${rowNumber}`)}?valueInputOption=RAW`,
      token,
      {
        method: 'PUT',
        body: JSON.stringify({ values: [expenseToRow(updated)] })
      },
      fetchImpl
    );

    return { ok: true, expense: updated };
  }

  if (action === 'delete') {
    const id = String(payload.id || '').trim();
    if (!id) throw new ApiError('ID rekod diperlukan.', 400, 'VALIDATION_ERROR');

    const [meta, idsRes] = await Promise.all([
      sheetsFetchJson(
        `${baseUrl}?fields=sheets(properties(sheetId,title))`,
        token,
        { method: 'GET' },
        fetchImpl
      ),
      sheetsFetchJson(
        `${baseUrl}/values/${encodeURIComponent('Expenses!A2:A')}?valueRenderOption=UNFORMATTED_VALUE`,
        token,
        { method: 'GET' },
        fetchImpl
      )
    ]);

    const expTab = (meta.sheets || []).find((s) => s.properties?.title === 'Expenses');
    if (!expTab) {
      throw new ApiError('Tab `Expenses` tidak ditemui dalam Google Sheet.', 404, 'SHEET_NOT_FOUND');
    }

    const rows = idsRes.values || [];
    const idx = rows.findIndex((r) => String(r[0] || '').trim() === id);
    if (idx === -1) {
      throw new ApiError(`Rekod tidak ditemui: ${id}`, 404, 'NOT_FOUND');
    }

    const startIndex = idx + 1;
    await sheetsFetchJson(
      `${baseUrl}:batchUpdate`,
      token,
      {
        method: 'POST',
        body: JSON.stringify({
          requests: [
            {
              deleteDimension: {
                range: {
                  sheetId: expTab.properties.sheetId,
                  dimension: 'ROWS',
                  startIndex,
                  endIndex: startIndex + 1
                }
              }
            }
          ]
        })
      },
      fetchImpl
    );

    return { ok: true, deletedId: id };
  }

  if (action === 'set_budget') {
    const month = normalizeMonth(payload.month);
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      throw new ApiError('Format bulan mestilah YYYY-MM.', 400, 'VALIDATION_ERROR');
    }

    const rawIncome = Number(payload.income_budget);
    if (!Number.isFinite(rawIncome) || rawIncome < 0) {
      throw new ApiError('Jumlah bajet tidak sah.', 400, 'VALIDATION_ERROR');
    }

    const budget = {
      month,
      income_budget: roundMoney(rawIncome),
      notes: String(payload.notes || '').trim(),
      updated_at: new Date().toISOString()
    };

    const readRes = await sheetsFetchJson(
      `${baseUrl}/values/${encodeURIComponent('Budgets!A2:D')}?valueRenderOption=UNFORMATTED_VALUE`,
      token,
      { method: 'GET' },
      fetchImpl
    );
    const rows = readRes.values || [];
    const idx = rows.findIndex((r) => normalizeMonth(r[0]) === month);
    const rowValues = [budget.month, budget.income_budget, budget.notes, budget.updated_at];

    if (idx !== -1) {
      const rowNumber = idx + 2;
      await sheetsFetchJson(
        `${baseUrl}/values/${encodeURIComponent(`Budgets!A${rowNumber}:D${rowNumber}`)}?valueInputOption=RAW`,
        token,
        {
          method: 'PUT',
          body: JSON.stringify({ values: [rowValues] })
        },
        fetchImpl
      );
    } else {
      await sheetsFetchJson(
        `${baseUrl}/values/${encodeURIComponent('Budgets!A1:D1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({ values: [rowValues] })
        },
        fetchImpl
      );
    }

    return { ok: true, budget };
  }

  if (action === 'copy_month') {
    const fromMonth = normalizeMonth(payload.from_month);
    const toMonth = normalizeMonth(payload.to_month);
    if (!fromMonth || !toMonth) {
      throw new ApiError('Bulan sumber dan bulan sasaran diperlukan.', 400, 'VALIDATION_ERROR');
    }
    if (fromMonth === toMonth) {
      throw new ApiError('Bulan sumber dan bulan sasaran tidak boleh sama.', 400, 'VALIDATION_ERROR');
    }

    const listed = await callSheetsApi(env, 'list', { month: fromMonth }, fetchImpl);
    if (!listed.expenses.length) {
      return { ok: true, added: [] };
    }

    const nowIso = new Date().toISOString();
    const added = listed.expenses.map((src, i) => {
      const dayPart = src.date && src.date.length >= 10 ? src.date.slice(8, 10) : '01';
      return {
        id: `exp_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
        month: toMonth,
        date: `${toMonth}-${clampDayForMonth(toMonth, dayPart)}`,
        title: src.title,
        category: src.category,
        amount: src.amount,
        paid_amount: 0,
        status: 'unpaid',
        paid_at: '',
        notes: src.notes,
        created_at: nowIso
      };
    });

    await sheetsFetchJson(
      `${baseUrl}/values/${encodeURIComponent('Expenses!A1:K1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      token,
      {
        method: 'POST',
        body: JSON.stringify({ values: added.map(expenseToRow) })
      },
      fetchImpl
    );

    return { ok: true, added };
  }

  throw new ApiError(`Action tidak dikenali: ${action}`, 400, 'UNKNOWN_ACTION');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

async function readJsonBody(request) {
  try {
    const text = await request.text();
    return text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError('Format JSON permintaan tidak sah.', 400, 'INVALID_JSON');
  }
}

async function dispatchBackend(env, action, payload, fetchImpl) {
  const mode = detectBackendMode(env);
  if (mode === 'apps_script') {
    return callAppsScript(env, { action, ...payload }, fetchImpl);
  }
  if (mode === 'sheets_api') {
    return callSheetsApi(env, action, payload, fetchImpl);
  }
  throw new ApiError(
    'Pangkalan data Google Sheet belum dikonfigurasi pada pelayan.',
    503,
    'UNCONFIGURED'
  );
}

/**
 * Main API router for all `/api/*` requests.
 */
export async function handleApiRequest(request, env = {}, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  try {
    if (method === 'GET' && path === '/api/config') {
      const mode = detectBackendMode(env);
      return json({
        ok: true,
        mode,
        configured: mode !== 'unconfigured',
        authRequired: Boolean(env?.APP_PIN),
        spreadsheetUrl: String(env?.SPREADSHEET_URL || '')
      });
    }

    if (env?.APP_PIN) {
      const providedPin = request.headers.get('X-App-Pin') || '';
      if (!providedPin || !constantTimeEqual(providedPin, env.APP_PIN)) {
        return json(
          { ok: false, error: 'PIN diperlukan atau tidak sah', code: 'UNAUTHORIZED' },
          401
        );
      }
    }

    if (method === 'GET' && path === '/api/health') {
      const result = await dispatchBackend(env, 'health', {}, fetchImpl);
      return json(result);
    }

    if (method === 'GET' && path === '/api/expenses') {
      const month = url.searchParams.get('month') || '';
      const result = await dispatchBackend(env, 'list', month ? { month } : {}, fetchImpl);
      return json(result);
    }

    if (method === 'POST' && path === '/api/expenses') {
      const body = await readJsonBody(request);
      const result = await dispatchBackend(env, 'add', body, fetchImpl);
      return json(result, 201);
    }

    if (method === 'POST' && path === '/api/expenses/copy-month') {
      const body = await readJsonBody(request);
      const result = await dispatchBackend(env, 'copy_month', body, fetchImpl);
      return json(result, 201);
    }

    const payMatch = path.match(/^\/api\/expenses\/([^/]+)\/pay$/);
    if (method === 'POST' && payMatch) {
      const body = await readJsonBody(request);
      const id = decodeURIComponent(payMatch[1]);
      const result = await dispatchBackend(env, 'pay', { ...body, id }, fetchImpl);
      return json(result);
    }

    const itemMatch = path.match(/^\/api\/expenses\/([^/]+)$/);
    if (itemMatch) {
      const id = decodeURIComponent(itemMatch[1]);
      if (method === 'PUT' || method === 'PATCH') {
        const body = await readJsonBody(request);
        const result = await dispatchBackend(env, 'update', { ...body, id }, fetchImpl);
        return json(result);
      }
      if (method === 'DELETE') {
        const result = await dispatchBackend(env, 'delete', { id }, fetchImpl);
        return json(result);
      }
    }

    const budgetMatch = path.match(/^\/api\/budgets\/([^/]+)$/);
    if (method === 'PUT' && budgetMatch) {
      const body = await readJsonBody(request);
      const month = decodeURIComponent(budgetMatch[1]);
      const result = await dispatchBackend(env, 'set_budget', { ...body, month }, fetchImpl);
      return json(result);
    }

    return json({ ok: false, error: 'Laluan API tidak ditemui.', code: 'NOT_FOUND' }, 404);
  } catch (err) {
    if (err instanceof ApiError) {
      return json({ ok: false, error: err.message, code: err.code }, err.status);
    }
    return json(
      { ok: false, error: err?.message || 'Ralat pelayan dalaman.', code: 'INTERNAL_ERROR' },
      500
    );
  }
}
