/**
 * DuitTrack — Google Apps Script Web App Backend
 *
 * Cara pasang:
 * 1. Buka Google Sheet anda -> Extensions -> Apps Script
 * 2. Tampal keseluruhan kod ini ke dalam `Code.gs` dan simpan (Ctrl+S)
 * 3. (Pilihan) Project Settings -> Script Properties -> tambah `API_SECRET`
 * 4. Klik Deploy -> New deployment -> Web app:
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5. Salin Web App URL (`.../exec`) dan masukkan ke `GAS_WEBAPP_URL` di Cloudflare Workers
 *    atau terus dalam Tetapan aplikasi web DuitTrack.
 */

const SHEET_EXPENSES = 'Expenses';
const SHEET_BUDGETS = 'Budgets';

const EXPENSES_HEADERS = [
  'id',
  'month',
  'date',
  'title',
  'category',
  'amount',
  'paid_amount',
  'status',
  'paid_at',
  'notes',
  'created_at'
];

const BUDGETS_HEADERS = [
  'month',
  'income_budget',
  'notes',
  'updated_at'
];

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function roundMoney(value) {
  const num = Number(value);
  if (!isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}

function getTodayDateString() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function getCurrentMonthString() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
}

function normalizeMonth(val) {
  if (val === null || val === undefined || val === '') return '';
  if (val instanceof Date) {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM');
  }
  const str = String(val).trim();
  const match = str.match(/^(\d{4}-\d{2})/);
  return match ? match[1] : str;
}

function normalizeDate(val) {
  if (val === null || val === undefined || val === '') return '';
  if (val instanceof Date) {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const str = String(val).trim();
  const match = str.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : str;
}

function normalizeIsoTimestamp(val) {
  if (val === null || val === undefined || val === '') return '';
  if (val instanceof Date) {
    return val.toISOString();
  }
  return String(val).trim();
}

function computePaymentState(amount, paidAmount, paidAt) {
  const safeAmount = Math.max(0, roundMoney(amount));
  const rawPaid = Math.max(0, roundMoney(paidAmount));
  const safePaid = Math.min(safeAmount, rawPaid);

  let status = 'unpaid';
  if (safeAmount > 0 && safePaid >= safeAmount) {
    status = 'paid';
  } else if (safePaid > 0) {
    status = 'partial';
  } else if (safeAmount === 0 && rawPaid > 0) {
    status = 'paid';
  }

  let nextPaidAt = '';
  if (status !== 'unpaid') {
    nextPaidAt = paidAt ? normalizeDate(paidAt) : getTodayDateString();
  }

  return {
    amount: safeAmount,
    paid_amount: safePaid,
    status: status,
    paid_at: nextPaidAt
  };
}

function ensureSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let expSheet = ss.getSheetByName(SHEET_EXPENSES);
  if (!expSheet) {
    expSheet = ss.insertSheet(SHEET_EXPENSES);
  }
  if (expSheet.getLastRow() === 0) {
    expSheet.getRange(1, 1, 1, EXPENSES_HEADERS.length).setValues([EXPENSES_HEADERS]);
    expSheet.setFrozenRows(1);
  }

  let budgetSheet = ss.getSheetByName(SHEET_BUDGETS);
  if (!budgetSheet) {
    budgetSheet = ss.insertSheet(SHEET_BUDGETS);
  }
  if (budgetSheet.getLastRow() === 0) {
    budgetSheet.getRange(1, 1, 1, BUDGETS_HEADERS.length).setValues([BUDGETS_HEADERS]);
    budgetSheet.setFrozenRows(1);
  }

  return { ss: ss, expSheet: expSheet, budgetSheet: budgetSheet };
}

function verifySecret(providedSecret) {
  const expected = PropertiesService.getScriptProperties().getProperty('API_SECRET');
  if (!expected) return true;
  return String(providedSecret || '') === String(expected);
}

function rowToExpense(row) {
  const payment = computePaymentState(row[5], row[6], row[8]);
  const dateStr = normalizeDate(row[2]);
  const monthStr = normalizeMonth(row[1]) || (dateStr ? dateStr.slice(0, 7) : '');

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
    created_at: normalizeIsoTimestamp(row[10])
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

function formatTextColumnsForRow(sheet, rowNumber, colIndexes) {
  for (let i = 0; i < colIndexes.length; i++) {
    sheet.getRange(rowNumber, colIndexes[i]).setNumberFormat('@');
  }
}

function rowToBudget(row) {
  return {
    month: normalizeMonth(row[0]),
    income_budget: Math.max(0, roundMoney(row[1])),
    notes: String(row[2] || ''),
    updated_at: normalizeIsoTimestamp(row[3])
  };
}

function findExpenseRowIndex(expSheet, id) {
  const lastRow = expSheet.getLastRow();
  if (lastRow < 2) return -1;
  const ids = expSheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === String(id).trim()) {
      return i + 2;
    }
  }
  return -1;
}

function listAllData(sheets, filterMonth) {
  const expLastRow = sheets.expSheet.getLastRow();
  let expenses = [];
  if (expLastRow >= 2) {
    const rows = sheets.expSheet.getRange(2, 1, expLastRow - 1, EXPENSES_HEADERS.length).getValues();
    expenses = rows
      .filter(function (r) { return String(r[0] || '').trim() !== ''; })
      .map(rowToExpense);
  }

  const budgetLastRow = sheets.budgetSheet.getLastRow();
  let budgets = [];
  if (budgetLastRow >= 2) {
    const bRows = sheets.budgetSheet.getRange(2, 1, budgetLastRow - 1, BUDGETS_HEADERS.length).getValues();
    budgets = bRows
      .filter(function (r) { return String(r[0] || '').trim() !== ''; })
      .map(rowToBudget);
  }

  if (filterMonth) {
    const targetMonth = normalizeMonth(filterMonth);
    expenses = expenses.filter(function (item) { return item.month === targetMonth; });
    budgets = budgets.filter(function (item) { return item.month === targetMonth; });
  }

  return {
    ok: true,
    expenses: expenses,
    budgets: budgets
  };
}

function addExpense(sheets, payload) {
  const title = String(payload.title || '').trim();
  if (!title) {
    return { ok: false, error: 'Nama perbelanjaan wajib diisi.' };
  }

  const rawAmount = Number(payload.amount);
  if (!isFinite(rawAmount) || rawAmount < 0) {
    return { ok: false, error: 'Jumlah perbelanjaan tidak sah.' };
  }

  const date = normalizeDate(payload.date) || getTodayDateString();
  const month = normalizeMonth(payload.month) || date.slice(0, 7) || getCurrentMonthString();
  const id = String(payload.id || '').trim() || ('exp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));

  let requestedPaid = payload.paid_amount;
  if (requestedPaid === undefined || requestedPaid === null) {
    requestedPaid = payload.status === 'paid' ? rawAmount : 0;
  }

  const payment = computePaymentState(rawAmount, requestedPaid, payload.paid_at);
  const expense = {
    id: id,
    month: month,
    date: date,
    title: title,
    category: String(payload.category || 'Lain-lain').trim() || 'Lain-lain',
    amount: payment.amount,
    paid_amount: payment.paid_amount,
    status: payment.status,
    paid_at: payment.paid_at,
    notes: String(payload.notes || '').trim(),
    created_at: new Date().toISOString()
  };

  const nextRow = sheets.expSheet.getLastRow() + 1;
  formatTextColumnsForRow(sheets.expSheet, nextRow, [2, 3, 9]);
  sheets.expSheet.getRange(nextRow, 1, 1, EXPENSES_HEADERS.length).setValues([expenseToRow(expense)]);

  return { ok: true, expense: expense };
}

function updateExpense(sheets, payload) {
  const id = String(payload.id || '').trim();
  if (!id) {
    return { ok: false, error: 'ID rekod diperlukan.' };
  }

  const rowNumber = findExpenseRowIndex(sheets.expSheet, id);
  if (rowNumber === -1) {
    return { ok: false, error: 'Rekod tidak ditemui: ' + id };
  }

  const currentRow = sheets.expSheet.getRange(rowNumber, 1, 1, EXPENSES_HEADERS.length).getValues()[0];
  const current = rowToExpense(currentRow);

  const nextTitle = payload.title !== undefined ? String(payload.title).trim() : current.title;
  if (!nextTitle) {
    return { ok: false, error: 'Nama perbelanjaan tidak boleh kosong.' };
  }

  const nextDate = payload.date !== undefined ? normalizeDate(payload.date) : current.date;
  const nextMonth = payload.month !== undefined
    ? normalizeMonth(payload.month)
    : (nextDate ? nextDate.slice(0, 7) : current.month);
  const nextAmount = payload.amount !== undefined ? Number(payload.amount) : current.amount;
  if (!isFinite(nextAmount) || nextAmount < 0) {
    return { ok: false, error: 'Jumlah perbelanjaan tidak sah.' };
  }

  let nextPaidAmount = current.paid_amount;
  if (payload.paid_amount !== undefined) {
    nextPaidAmount = Number(payload.paid_amount);
  } else if (payload.status === 'paid') {
    nextPaidAmount = nextAmount;
  } else if (payload.status === 'unpaid') {
    nextPaidAmount = 0;
  }

  const nextPaidAtInput = payload.paid_at !== undefined ? payload.paid_at : current.paid_at;
  const payment = computePaymentState(nextAmount, nextPaidAmount, nextPaidAtInput);

  const updated = {
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
    created_at: current.created_at || new Date().toISOString()
  };

  formatTextColumnsForRow(sheets.expSheet, rowNumber, [2, 3, 9]);
  sheets.expSheet.getRange(rowNumber, 1, 1, EXPENSES_HEADERS.length).setValues([expenseToRow(updated)]);

  return { ok: true, expense: updated };
}

function payExpense(sheets, payload) {
  const id = String(payload.id || '').trim();
  if (!id) {
    return { ok: false, error: 'ID rekod diperlukan.' };
  }

  const rowNumber = findExpenseRowIndex(sheets.expSheet, id);
  if (rowNumber === -1) {
    return { ok: false, error: 'Rekod tidak ditemui: ' + id };
  }

  const currentRow = sheets.expSheet.getRange(rowNumber, 1, 1, EXPENSES_HEADERS.length).getValues()[0];
  const current = rowToExpense(currentRow);
  const mode = String(payload.mode || 'full').toLowerCase();

  let targetPaid = current.paid_amount;
  let targetPaidAt = payload.paid_at || getTodayDateString();

  if (mode === 'full') {
    targetPaid = current.amount;
  } else if (mode === 'unpay') {
    targetPaid = 0;
    targetPaidAt = '';
  } else if (mode === 'partial') {
    if (payload.add_amount !== undefined && payload.add_amount !== null && payload.add_amount !== '') {
      const addAmt = Number(payload.add_amount);
      if (!isFinite(addAmt) || addAmt < 0) {
        return { ok: false, error: 'Jumlah bayaran tidak sah.' };
      }
      targetPaid = current.paid_amount + addAmt;
    } else if (payload.paid_amount !== undefined && payload.paid_amount !== null && payload.paid_amount !== '') {
      const setAmt = Number(payload.paid_amount);
      if (!isFinite(setAmt) || setAmt < 0) {
        return { ok: false, error: 'Jumlah bayaran tidak sah.' };
      }
      targetPaid = setAmt;
    } else {
      return { ok: false, error: 'Sila masukkan jumlah bayaran separuh.' };
    }
  } else {
    return { ok: false, error: 'Mod bayaran tidak sah: ' + mode };
  }

  const payment = computePaymentState(current.amount, targetPaid, targetPaidAt);
  const updated = Object.assign({}, current, {
    paid_amount: payment.paid_amount,
    status: payment.status,
    paid_at: payment.paid_at
  });

  formatTextColumnsForRow(sheets.expSheet, rowNumber, [2, 3, 9]);
  sheets.expSheet.getRange(rowNumber, 1, 1, EXPENSES_HEADERS.length).setValues([expenseToRow(updated)]);

  return { ok: true, expense: updated };
}

function deleteExpense(sheets, payload) {
  const id = String(payload.id || '').trim();
  if (!id) {
    return { ok: false, error: 'ID rekod diperlukan.' };
  }

  const rowNumber = findExpenseRowIndex(sheets.expSheet, id);
  if (rowNumber === -1) {
    return { ok: false, error: 'Rekod tidak ditemui: ' + id };
  }

  sheets.expSheet.deleteRow(rowNumber);
  return { ok: true, deletedId: id };
}

function setBudget(sheets, payload) {
  const month = normalizeMonth(payload.month);
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return { ok: false, error: 'Format bulan mestilah YYYY-MM.' };
  }

  const rawIncome = Number(payload.income_budget);
  if (!isFinite(rawIncome) || rawIncome < 0) {
    return { ok: false, error: 'Jumlah bajet tidak sah.' };
  }

  const budget = {
    month: month,
    income_budget: roundMoney(rawIncome),
    notes: String(payload.notes || '').trim(),
    updated_at: new Date().toISOString()
  };

  const rowValues = [budget.month, budget.income_budget, budget.notes, budget.updated_at];
  const lastRow = sheets.budgetSheet.getLastRow();
  let existingRow = -1;

  if (lastRow >= 2) {
    const months = sheets.budgetSheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < months.length; i++) {
      if (normalizeMonth(months[i][0]) === month) {
        existingRow = i + 2;
        break;
      }
    }
  }

  const targetRow = existingRow !== -1 ? existingRow : lastRow + 1;
  sheets.budgetSheet.getRange(targetRow, 1).setNumberFormat('@');
  sheets.budgetSheet.getRange(targetRow, 1, 1, BUDGETS_HEADERS.length).setValues([rowValues]);

  return { ok: true, budget: budget };
}

function clampDayForMonth(monthStr, dayStr) {
  const parts = monthStr.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const maxDays = new Date(year, month, 0).getDate();
  const parsedDay = Number(dayStr) || 1;
  const clamped = Math.min(Math.max(1, parsedDay), maxDays);
  return String(clamped).padStart(2, '0');
}

function copyMonthExpenses(sheets, payload) {
  const fromMonth = normalizeMonth(payload.from_month);
  const toMonth = normalizeMonth(payload.to_month);

  if (!fromMonth || !toMonth) {
    return { ok: false, error: 'Bulan sumber dan bulan sasaran diperlukan.' };
  }
  if (fromMonth === toMonth) {
    return { ok: false, error: 'Bulan sumber dan bulan sasaran tidak boleh sama.' };
  }

  const all = listAllData(sheets, fromMonth);
  const sourceItems = all.expenses;
  if (sourceItems.length === 0) {
    return { ok: true, added: [] };
  }

  const nowIso = new Date().toISOString();
  const added = [];
  const rowsToAppend = [];

  for (let i = 0; i < sourceItems.length; i++) {
    const src = sourceItems[i];
    const dayPart = src.date && src.date.length >= 10 ? src.date.slice(8, 10) : '01';
    const nextDate = toMonth + '-' + clampDayForMonth(toMonth, dayPart);
    const nextExp = {
      id: 'exp_' + Date.now() + '_' + i + '_' + Math.random().toString(36).slice(2, 6),
      month: toMonth,
      date: nextDate,
      title: src.title,
      category: src.category,
      amount: src.amount,
      paid_amount: 0,
      status: 'unpaid',
      paid_at: '',
      notes: src.notes,
      created_at: nowIso
    };
    added.push(nextExp);
    rowsToAppend.push(expenseToRow(nextExp));
  }

  const startRow = sheets.expSheet.getLastRow() + 1;
  sheets.expSheet.getRange(startRow, 2, rowsToAppend.length, 2).setNumberFormat('@');
  sheets.expSheet.getRange(startRow, 9, rowsToAppend.length, 1).setNumberFormat('@');
  sheets.expSheet.getRange(startRow, 1, rowsToAppend.length, EXPENSES_HEADERS.length).setValues(rowsToAppend);

  return { ok: true, added: added };
}

function doGet(e) {
  try {
    const params = (e && e.parameter) ? e.parameter : {};
    if (!verifySecret(params.secret)) {
      return jsonResponse({ ok: false, error: 'API secret tidak sah.' });
    }

    const sheets = ensureSheets();
    const action = String(params.action || 'health').toLowerCase();

    if (action === 'health') {
      return jsonResponse({
        ok: true,
        spreadsheetName: sheets.ss.getName(),
        spreadsheetId: sheets.ss.getId(),
        mode: 'apps_script'
      });
    }

    if (action === 'list') {
      return jsonResponse(listAllData(sheets, params.month));
    }

    return jsonResponse({ ok: false, error: 'Action GET tidak dikenali: ' + action });
  } catch (err) {
    return jsonResponse({ ok: false, error: err && err.message ? err.message : String(err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    const payload = JSON.parse(raw);

    if (!verifySecret(payload.secret)) {
      return jsonResponse({ ok: false, error: 'API secret tidak sah.' });
    }

    const sheets = ensureSheets();
    const action = String(payload.action || '').toLowerCase();

    switch (action) {
      case 'health':
        return jsonResponse({
          ok: true,
          spreadsheetName: sheets.ss.getName(),
          spreadsheetId: sheets.ss.getId(),
          mode: 'apps_script'
        });
      case 'list':
        return jsonResponse(listAllData(sheets, payload.month));
      case 'add':
        return jsonResponse(addExpense(sheets, payload));
      case 'update':
        return jsonResponse(updateExpense(sheets, payload));
      case 'pay':
        return jsonResponse(payExpense(sheets, payload));
      case 'delete':
        return jsonResponse(deleteExpense(sheets, payload));
      case 'set_budget':
        return jsonResponse(setBudget(sheets, payload));
      case 'copy_month':
        return jsonResponse(copyMonthExpenses(sheets, payload));
      default:
        return jsonResponse({ ok: false, error: 'Action POST tidak dikenali: ' + action });
    }
  } catch (err) {
    return jsonResponse({ ok: false, error: err && err.message ? err.message : String(err) });
  } finally {
    try {
      lock.releaseLock();
    } catch (_ignored) {}
  }
}
