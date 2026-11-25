import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computePaymentState,
  handleApiRequest,
  signGoogleJwt
} from '../src/sheets.js';
import worker from '../src/worker.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('computePaymentState handles full, partial, overpay clamping, unpay, zero amount, and decimal rounding', () => {
  const full = computePaymentState(199.999, 199.999, '', '2026-11-25T10:00:00Z');
  assert.deepEqual(full, {
    amount: 200,
    paid_amount: 200,
    status: 'paid',
    paid_at: '2026-11-25'
  });

  const partial = computePaymentState(250, 100.126, '2026-11-12', '2026-11-25T10:00:00Z');
  assert.deepEqual(partial, {
    amount: 250,
    paid_amount: 100.13,
    status: 'partial',
    paid_at: '2026-11-12'
  });

  const clampedOverpay = computePaymentState(150, 999, '', '2026-11-25T10:00:00Z');
  assert.deepEqual(clampedOverpay, {
    amount: 150,
    paid_amount: 150,
    status: 'paid',
    paid_at: '2026-11-25'
  });

  const unpaid = computePaymentState(150, 0, '2026-11-20', '2026-11-25T10:00:00Z');
  assert.deepEqual(unpaid, {
    amount: 150,
    paid_amount: 0,
    status: 'unpaid',
    paid_at: ''
  });

  const zeroUnpaid = computePaymentState(0, 0, '', '2026-11-25T10:00:00Z');
  assert.equal(zeroUnpaid.status, 'unpaid');
  assert.equal(zeroUnpaid.paid_at, '');
});

test('GET /api/config reflects backend mode without leaking secrets', async () => {
  const unconfiguredRes = await handleApiRequest(
    new Request('https://duittrack.example/api/config'),
    {}
  );
  assert.equal(unconfiguredRes.status, 200);
  const unconfigured = await unconfiguredRes.json();
  assert.deepEqual(unconfigured, {
    ok: true,
    mode: 'unconfigured',
    configured: false,
    authRequired: false,
    spreadsheetUrl: ''
  });

  const gasRes = await handleApiRequest(
    new Request('https://duittrack.example/api/config'),
    {
      GAS_WEBAPP_URL: 'https://script.google.com/macros/s/abc/exec',
      GAS_API_SECRET: 'top-secret',
      APP_PIN: '1234',
      SPREADSHEET_URL: 'https://docs.google.com/spreadsheets/d/sheet1/edit'
    }
  );
  const gasCfg = await gasRes.json();
  assert.deepEqual(gasCfg, {
    ok: true,
    mode: 'apps_script',
    configured: true,
    authRequired: true,
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet1/edit'
  });
  assert.equal(gasCfg.GAS_API_SECRET, undefined);

  const sheetsRes = await handleApiRequest(
    new Request('https://duittrack.example/api/config'),
    {
      GOOGLE_SPREADSHEET_ID: 'sheet-id',
      GOOGLE_SERVICE_ACCOUNT_EMAIL: 'svc@test.iam.gserviceaccount.com',
      GOOGLE_PRIVATE_KEY: 'dummy-pem'
    }
  );
  const sheetsCfg = await sheetsRes.json();
  assert.equal(sheetsCfg.mode, 'sheets_api');
  assert.equal(sheetsCfg.configured, true);
});

test('APP_PIN enforcement rejects missing/wrong PIN with 401 and accepts valid PIN', async () => {
  const env = {
    APP_PIN: '9988',
    GAS_WEBAPP_URL: 'https://script.google.com/macros/s/abc/exec'
  };
  const mockFetch = async () => jsonResponse({ ok: true, expenses: [], budgets: [] });

  const missing = await handleApiRequest(
    new Request('https://duittrack.example/api/expenses'),
    env,
    { fetchImpl: mockFetch }
  );
  assert.equal(missing.status, 401);

  const wrong = await handleApiRequest(
    new Request('https://duittrack.example/api/expenses', {
      headers: { 'X-App-Pin': '0000' }
    }),
    env,
    { fetchImpl: mockFetch }
  );
  assert.equal(wrong.status, 401);

  const valid = await handleApiRequest(
    new Request('https://duittrack.example/api/expenses', {
      headers: { 'X-App-Pin': '9988' }
    }),
    env,
    { fetchImpl: mockFetch }
  );
  assert.equal(valid.status, 200);
  const data = await valid.json();
  assert.equal(data.ok, true);
});

test('Apps Script proxy forwards CRUD/deduct actions with secret and handles HTML permission errors', async () => {
  const env = {
    GAS_WEBAPP_URL: 'https://script.google.com/macros/s/demo/exec',
    GAS_API_SECRET: 'rahsia-duit'
  };
  const capturedPayloads = [];

  const mockFetch = async (_url, init) => {
    const parsed = JSON.parse(init.body);
    capturedPayloads.push(parsed);
    if (parsed.action === 'list') {
      return jsonResponse({ ok: true, expenses: [{ id: 'e1' }], budgets: [] });
    }
    if (parsed.action === 'add') {
      return jsonResponse({ ok: true, expense: { id: 'e2', title: parsed.title } });
    }
    if (parsed.action === 'pay') {
      return jsonResponse({ ok: true, expense: { id: parsed.id, status: 'paid' } });
    }
    if (parsed.action === 'delete') {
      return jsonResponse({ ok: true, deletedId: parsed.id });
    }
    if (parsed.action === 'set_budget') {
      return jsonResponse({ ok: true, budget: { month: parsed.month, income_budget: parsed.income_budget } });
    }
    if (parsed.action === 'copy_month') {
      return jsonResponse({ ok: true, added: [{ id: 'e3', month: parsed.to_month }] });
    }
    return jsonResponse({ ok: false, error: 'unexpected' });
  };

  await handleApiRequest(new Request('https://duittrack.example/api/expenses?month=2026-11'), env, { fetchImpl: mockFetch });
  const addRes = await handleApiRequest(
    new Request('https://duittrack.example/api/expenses', {
      method: 'POST',
      body: JSON.stringify({ title: 'Bil Air', amount: 45, date: '2026-11-25' })
    }),
    env,
    { fetchImpl: mockFetch }
  );
  assert.equal(addRes.status, 201);

  await handleApiRequest(
    new Request('https://duittrack.example/api/expenses/e2/pay', {
      method: 'POST',
      body: JSON.stringify({ mode: 'full' })
    }),
    env,
    { fetchImpl: mockFetch }
  );

  await handleApiRequest(
    new Request('https://duittrack.example/api/expenses/e2', { method: 'DELETE' }),
    env,
    { fetchImpl: mockFetch }
  );

  await handleApiRequest(
    new Request('https://duittrack.example/api/budgets/2026-11', {
      method: 'PUT',
      body: JSON.stringify({ income_budget: 5000 })
    }),
    env,
    { fetchImpl: mockFetch }
  );

  await handleApiRequest(
    new Request('https://duittrack.example/api/expenses/copy-month', {
      method: 'POST',
      body: JSON.stringify({ from_month: '2026-10', to_month: '2026-11' })
    }),
    env,
    { fetchImpl: mockFetch }
  );

  assert.deepEqual(
    capturedPayloads.map((p) => p.action),
    ['list', 'add', 'pay', 'delete', 'set_budget', 'copy_month']
  );
  for (const p of capturedPayloads) {
    assert.equal(p.secret, 'rahsia-duit');
  }

  const htmlErrorRes = await handleApiRequest(
    new Request('https://duittrack.example/api/health'),
    env,
    {
      fetchImpl: async () => new Response('<html><body>Sign in</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      })
    }
  );
  assert.equal(htmlErrorRes.status, 502);
  const errData = await htmlErrorRes.json();
  assert.match(errData.error, /Anyone/i);
});

test('Google Sheets API v4 mode signs RS256 JWT and performs list, RAW add, pay update, deleteDimension, and budget upsert', async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['sign', 'verify']
  );

  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  const b64 = Buffer.from(pkcs8).toString('base64').match(/.{1,64}/g).join('\n');
  const pemWithEscapedNewlines = `-----BEGIN PRIVATE KEY-----\\n${b64}\\n-----END PRIVATE KEY-----`;

  const jwt = await signGoogleJwt(
    'duittrack@example.iam.gserviceaccount.com',
    pemWithEscapedNewlines,
    'https://www.googleapis.com/auth/spreadsheets',
    1700000000
  );
  assert.equal(jwt.split('.').length, 3);

  const env = {
    GOOGLE_SPREADSHEET_ID: 'sheet-xyz',
    GOOGLE_SERVICE_ACCOUNT_EMAIL: 'duittrack@example.iam.gserviceaccount.com',
    GOOGLE_PRIVATE_KEY: pemWithEscapedNewlines
  };

  const calls = [];
  const mockFetch = async (url, init = {}) => {
    const urlStr = String(url);
    calls.push({ url: urlStr, method: init.method || 'GET', body: init.body });

    if (urlStr.includes('oauth2.googleapis.com/token')) {
      return jsonResponse({ access_token: 'tok-123', expires_in: 3600 });
    }
    if (urlStr.includes('/values:batchGet')) {
      return jsonResponse({
        valueRanges: [
          {
            values: [
              ['exp_1', '2026-11', '2026-11-01', 'Sewa', 'Rumah & Bil', 1200, 0, 'unpaid', '', '', '2026-11-01T00:00:00Z']
            ]
          },
          {
            values: [
              ['2026-11', 4500, 'Gaji', '2026-11-01T00:00:00Z']
            ]
          }
        ]
      });
    }
    if (urlStr.includes(':append')) {
      return jsonResponse({ updates: { updatedRows: 1 } });
    }
    if (urlStr.includes('/values/Expenses!A2%3AK') && (!init.method || init.method === 'GET')) {
      return jsonResponse({
        values: [
          ['exp_1', '2026-11', '2026-11-01', 'Sewa', 'Rumah & Bil', 1200, 0, 'unpaid', '', '', '2026-11-01T00:00:00Z']
        ]
      });
    }
    if (urlStr.includes('/values/Expenses!A2%3AK2') && init.method === 'PUT') {
      return jsonResponse({ updatedRows: 1 });
    }
    if (urlStr.includes('fields=sheets')) {
      return jsonResponse({
        sheets: [{ properties: { sheetId: 0, title: 'Expenses' } }]
      });
    }
    if (urlStr.includes('/values/Expenses!A2%3AA')) {
      return jsonResponse({ values: [['exp_1']] });
    }
    if (urlStr.includes(':batchUpdate')) {
      return jsonResponse({ replies: [{}] });
    }
    if (urlStr.includes('/values/Budgets!A2%3AD') && (!init.method || init.method === 'GET')) {
      return jsonResponse({ values: [['2026-11', 4500, 'Gaji', '2026-11-01T00:00:00Z']] });
    }
    if (urlStr.includes('/values/Budgets!A2%3AD2') && init.method === 'PUT') {
      return jsonResponse({ updatedRows: 1 });
    }
    return jsonResponse({}, 404);
  };

  // List
  const listRes = await handleApiRequest(new Request('https://duittrack.example/api/expenses'), env, { fetchImpl: mockFetch });
  const listData = await listRes.json();
  assert.equal(listData.expenses.length, 1);
  assert.equal(listData.budgets[0].income_budget, 4500);

  // Add (verify valueInputOption=RAW)
  const addRes = await handleApiRequest(
    new Request('https://duittrack.example/api/expenses', {
      method: 'POST',
      body: JSON.stringify({ title: 'Makan', amount: 18.5, date: '2026-11-25', status: 'paid' })
    }),
    env,
    { fetchImpl: mockFetch }
  );
  assert.equal(addRes.status, 201);
  const addCall = calls.find((c) => c.url.includes('Expenses!A1%3AK1:append'));
  assert.ok(addCall.url.includes('valueInputOption=RAW'));

  // Pay update
  const payRes = await handleApiRequest(
    new Request('https://duittrack.example/api/expenses/exp_1/pay', {
      method: 'POST',
      body: JSON.stringify({ mode: 'full' })
    }),
    env,
    { fetchImpl: mockFetch }
  );
  const payData = await payRes.json();
  assert.equal(payData.expense.status, 'paid');
  assert.equal(payData.expense.paid_amount, 1200);

  // Delete (verify deleteDimension)
  const delRes = await handleApiRequest(
    new Request('https://duittrack.example/api/expenses/exp_1', { method: 'DELETE' }),
    env,
    { fetchImpl: mockFetch }
  );
  const delData = await delRes.json();
  assert.equal(delData.deletedId, 'exp_1');
  const batchCall = calls.find((c) => c.url.includes(':batchUpdate'));
  const batchBody = JSON.parse(batchCall.body);
  assert.equal(batchBody.requests[0].deleteDimension.range.startIndex, 1);
  assert.equal(batchBody.requests[0].deleteDimension.range.endIndex, 2);

  // Budget upsert
  const budgetRes = await handleApiRequest(
    new Request('https://duittrack.example/api/budgets/2026-11', {
      method: 'PUT',
      body: JSON.stringify({ income_budget: 5200, notes: 'Naik gaji' })
    }),
    env,
    { fetchImpl: mockFetch }
  );
  const budgetData = await budgetRes.json();
  assert.equal(budgetData.budget.income_budget, 5200);
});

test('worker.js routes /api/* to API handler and delegates non-API paths to ASSETS', async () => {
  let assetsCalled = 0;
  const env = {
    ASSETS: {
      fetch: async (req) => {
        assetsCalled += 1;
        return new Response(`asset:${new URL(req.url).pathname}`, { status: 200 });
      }
    }
  };

  const apiRes = await worker.fetch(new Request('https://duittrack.example/api/config'), env, {});
  assert.equal(apiRes.status, 200);
  const cfg = await apiRes.json();
  assert.equal(cfg.mode, 'unconfigured');
  assert.equal(assetsCalled, 0);

  const assetRes = await worker.fetch(new Request('https://duittrack.example/'), env, {});
  assert.equal(await assetRes.text(), 'asset:/');
  assert.equal(assetsCalled, 1);
});
