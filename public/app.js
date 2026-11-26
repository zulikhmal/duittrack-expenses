const DEFAULT_SHEET_URL = 'https://docs.google.com/spreadsheets/d/10tMHyAHHCFKBLmNYwKKlwzQ8fbrIBNhd04Ht3JrVtlQ/edit';

const STORAGE_KEYS = {
  DIRECT_GAS: 'duittrack_direct_gas_v1',
  THEME: 'duittrack_theme_v1',
  APP_PIN: 'duittrack_pin_v1'
};

const MONTH_NAMES_MS = [
  'Januari', 'Februari', 'Mac', 'April', 'Mei', 'Jun',
  'Julai', 'Ogos', 'September', 'Oktober', 'November', 'Disember'
];

const CATEGORIES = [
  'Rumah & Bil',
  'Makan & Minum',
  'Pengangkutan',
  'Langganan',
  'Hutang & Pinjaman',
  'Simpanan & Pelaburan',
  'Keluarga & Lain-lain'
];

const state = {
  config: {
    mode: 'unconfigured',
    configured: false,
    authRequired: false,
    spreadsheetUrl: DEFAULT_SHEET_URL
  },
  directGas: loadJsonStorage(STORAGE_KEYS.DIRECT_GAS, {
    url: '',
    secret: '',
    spreadsheetUrl: DEFAULT_SHEET_URL
  }),
  pin: sessionStorage.getItem(STORAGE_KEYS.APP_PIN) || '',
  currentMonth: getTodayMonth(),
  expenses: [],
  budgets: [],
  filters: {
    search: '',
    status: 'all',
    category: 'all',
    sort: 'date_desc'
  },
  isSyncing: false,
  connectionError: ''
};

function loadJsonStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function getTodayDate() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getTodayMonth() {
  return getTodayDate().slice(0, 7);
}

function roundMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}

function formatRM(value) {
  const num = roundMoney(value);
  const abs = Math.abs(num);
  const formatted = abs.toLocaleString('en-MY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  return num < 0 ? `-RM ${formatted}` : `RM ${formatted}`;
}

function formatMonthLabel(monthStr) {
  const [y, m] = String(monthStr || '').split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return monthStr;
  return `${MONTH_NAMES_MS[m - 1]} ${y}`;
}

function shiftMonth(monthStr, delta) {
  const [y, m] = monthStr.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function computePaymentState(amount, paidAmount, paidAt) {
  const safeAmount = Math.max(0, roundMoney(amount));
  const clampedPaid = Math.min(safeAmount, Math.max(0, roundMoney(paidAmount)));
  let status = 'unpaid';
  if (safeAmount > 0 && clampedPaid >= safeAmount) {
    status = 'paid';
  } else if (clampedPaid > 0) {
    status = 'partial';
  }
  const nextPaidAt = status === 'unpaid' ? '' : (paidAt || getTodayDate());
  return {
    amount: safeAmount,
    paid_amount: clampedPaid,
    status,
    paid_at: nextPaidAt
  };
}

function getActiveBackendMode() {
  if (state.config.configured) {
    return state.config.mode;
  }
  if (state.directGas.url) {
    return 'direct_gas';
  }
  return 'unconfigured';
}

function getSpreadsheetReferenceUrl() {
  return state.config.spreadsheetUrl || state.directGas.spreadsheetUrl || DEFAULT_SHEET_URL;
}

function showToast(message, isError = false) {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast${isError ? ' toast--error' : ''}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 3600);
}

async function serverApiFetch(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  if (state.pin) {
    headers['X-App-Pin'] = state.pin;
  }
  const res = await fetch(path, {
    ...options,
    headers
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    showPinOverlay('Kod PIN diperlukan atau tidak sah.');
    throw new Error(data.error || 'PIN diperlukan');
  }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Ralat pelayan (${res.status})`);
  }
  return data;
}

async function directGasCall(action, payload = {}) {
  const url = String(state.directGas.url || '').trim();
  if (!url) throw new Error('URL Google Apps Script belum ditetapkan.');
  const res = await fetch(url, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      action,
      ...payload,
      secret: state.directGas.secret || ''
    })
  });
  const text = await res.text();
  if (text.trim().startsWith('<')) {
    throw new Error('Apps Script memulangkan HTML. Pastikan deploy sebagai Web App dengan akses "Anyone".');
  }
  const data = JSON.parse(text);
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Ralat Apps Script (${res.status})`);
  }
  return data;
}

function requireActiveBackendMode() {
  const mode = getActiveBackendMode();
  if (mode !== 'apps_script' && mode !== 'sheets_api' && mode !== 'direct_gas') {
    throw new Error('Google Sheet belum disambungkan. Sila semak Tetapan sambungan.');
  }
  return mode;
}

const dataAdapter = {
  async loadAll() {
    const mode = requireActiveBackendMode();
    if (mode === 'direct_gas') {
      return directGasCall('list');
    }
    return serverApiFetch('/api/expenses');
  },

  async addExpense(payload) {
    const mode = requireActiveBackendMode();
    if (mode === 'direct_gas') {
      return directGasCall('add', payload);
    }
    return serverApiFetch('/api/expenses', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async updateExpense(id, payload) {
    const mode = requireActiveBackendMode();
    if (mode === 'direct_gas') {
      return directGasCall('update', { ...payload, id });
    }
    return serverApiFetch(`/api/expenses/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
  },

  async payExpense(id, payload) {
    const mode = requireActiveBackendMode();
    if (mode === 'direct_gas') {
      return directGasCall('pay', { ...payload, id });
    }
    return serverApiFetch(`/api/expenses/${encodeURIComponent(id)}/pay`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async deleteExpense(id) {
    const mode = requireActiveBackendMode();
    if (mode === 'direct_gas') {
      return directGasCall('delete', { id });
    }
    return serverApiFetch(`/api/expenses/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
  },

  async setBudget(month, payload) {
    const mode = requireActiveBackendMode();
    if (mode === 'direct_gas') {
      return directGasCall('set_budget', { ...payload, month });
    }
    return serverApiFetch(`/api/budgets/${encodeURIComponent(month)}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
  },

  async copyMonth(fromMonth, toMonth) {
    const mode = requireActiveBackendMode();
    if (mode === 'direct_gas') {
      return directGasCall('copy_month', { from_month: fromMonth, to_month: toMonth });
    }
    return serverApiFetch('/api/expenses/copy-month', {
      method: 'POST',
      body: JSON.stringify({ from_month: fromMonth, to_month: toMonth })
    });
  }
};

function getMonthExpenses() {
  return state.expenses.filter((e) => e.month === state.currentMonth);
}

function getActiveBudget() {
  return state.budgets.find((b) => b.month === state.currentMonth) || {
    month: state.currentMonth,
    income_budget: 0,
    notes: ''
  };
}

function renderStatusHeader() {
  const mode = getActiveBackendMode();
  const badge = document.getElementById('statusBadge');
  const badgeText = document.getElementById('statusBadgeText');
  const setupBanner = document.getElementById('setupBanner');
  const settingsMode = document.getElementById('settingsActiveMode');
  const sheetLink = document.getElementById('settingsSheetLink');

  badge.classList.remove('status-pill--live', 'status-pill--demo', 'status-pill--error');

  if (state.connectionError) {
    badge.classList.add('status-pill--error');
    badgeText.textContent = 'Ralat Sambungan';
  } else if (mode === 'apps_script') {
    badge.classList.add('status-pill--live');
    badgeText.textContent = 'Google Sheet (Worker)';
    settingsMode.textContent = 'Cloudflare Worker -> Apps Script';
  } else if (mode === 'sheets_api') {
    badge.classList.add('status-pill--live');
    badgeText.textContent = 'Google Sheet (API v4)';
    settingsMode.textContent = 'Cloudflare Worker -> Google Sheets API v4';
  } else if (mode === 'direct_gas') {
    badge.classList.add('status-pill--live');
    badgeText.textContent = 'Google Sheet (Terus)';
    settingsMode.textContent = 'Pelayar -> Google Apps Script';
  } else {
    badge.classList.add('status-pill--error');
    badgeText.textContent = 'Belum Disambung';
    settingsMode.textContent = 'Belum Disambung ke Google Sheet';
  }

  setupBanner.classList.toggle('hidden', mode !== 'unconfigured');
  sheetLink.href = getSpreadsheetReferenceUrl();
}

function renderKpis() {
  const monthItems = getMonthExpenses();
  const budgetObj = getActiveBudget();
  const budget = roundMoney(budgetObj.income_budget);

  const totalPlanned = roundMoney(monthItems.reduce((acc, item) => acc + Number(item.amount || 0), 0));
  const totalPaid = roundMoney(monthItems.reduce((acc, item) => acc + Number(item.paid_amount || 0), 0));
  const totalUnpaid = roundMoney(Math.max(0, totalPlanned - totalPaid));
  const currentBalance = roundMoney(budget - totalPaid);
  const projectedBalance = roundMoney(budget - totalPlanned);
  const paidPct = totalPlanned > 0 ? Math.min(100, Math.round((totalPaid / totalPlanned) * 100)) : 0;
  const unpaidCount = monthItems.filter((i) => i.status !== 'paid').length;

  document.getElementById('kpiBudget').textContent = formatRM(budget);
  document.getElementById('kpiBudgetNote').textContent = budgetObj.notes || 'Klik "Ubah" untuk tetapkan bajet bulan ini';

  const balanceCard = document.getElementById('kpiBalanceCard');
  const balanceEl = document.getElementById('kpiBalance');
  balanceEl.textContent = formatRM(currentBalance);
  balanceCard.classList.toggle('kpi-card--overspent', currentBalance < 0);
  balanceEl.classList.toggle('text-rose', currentBalance < 0);
  document.getElementById('kpiProjectedBalance').textContent = `Baki lepas semua bil: ${formatRM(projectedBalance)}`;

  document.getElementById('kpiPaid').textContent = formatRM(totalPaid);
  document.getElementById('kpiPaidPct').textContent = `${paidPct}%`;
  document.getElementById('kpiPaidBar').style.width = `${paidPct}%`;

  document.getElementById('kpiUnpaid').textContent = formatRM(totalUnpaid);
  document.getElementById('kpiUnpaidCount').textContent = `${unpaidCount} item`;
  document.getElementById('kpiTotalPlanned').textContent = `Jumlah komitmen: ${formatRM(totalPlanned)}`;

  // Sidebar summary
  document.getElementById('summaryCompletionRate').textContent = `${paidPct}%`;
  document.getElementById('summaryPaidRatio').textContent = `${monthItems.length - unpaidCount} / ${monthItems.length}`;
  document.getElementById('summaryRemainingAmount').textContent = formatRM(totalUnpaid);
  document.getElementById('summaryPlannedAmount').textContent = formatRM(totalPlanned);
}

function renderCategoryFilterOptions(monthItems) {
  const select = document.getElementById('categoryFilter');
  const currentVal = state.filters.category;
  const uniqueCats = Array.from(new Set([...CATEGORIES, ...monthItems.map((i) => i.category)]));
  select.innerHTML = `<option value="all">Semua Kategori</option>${uniqueCats
    .map((cat) => `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`)
    .join('')}`;
  select.value = uniqueCats.includes(currentVal) ? currentVal : 'all';
}

function getFilteredSortedExpenses() {
  const search = state.filters.search.trim().toLowerCase();
  const statusFilter = state.filters.status;
  const categoryFilter = state.filters.category;
  const sortMode = state.filters.sort;

  const list = getMonthExpenses().filter((item) => {
    if (statusFilter !== 'all' && item.status !== statusFilter) return false;
    if (categoryFilter !== 'all' && item.category !== categoryFilter) return false;
    if (search) {
      const hay = `${item.title} ${item.category} ${item.notes}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const statusOrder = { unpaid: 0, partial: 1, paid: 2 };
  list.sort((a, b) => {
    if (sortMode === 'date_asc') return a.date.localeCompare(b.date);
    if (sortMode === 'amount_desc') return b.amount - a.amount;
    if (sortMode === 'unpaid_first') {
      const diff = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
      return diff !== 0 ? diff : b.date.localeCompare(a.date);
    }
    return b.date.localeCompare(a.date);
  });

  return list;
}

function renderExpensesList() {
  const monthItems = getMonthExpenses();
  renderCategoryFilterOptions(monthItems);

  const items = getFilteredSortedExpenses();
  const listEl = document.getElementById('expensesList');
  document.getElementById('listCountBadge').textContent = String(items.length);

  if (items.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <strong>Tiada rekod ditemui untuk ${escapeHtml(formatMonthLabel(state.currentMonth))}</strong>
        <p>Tambah perbelanjaan baru di atas atau klik "Salin dari Bulan Lepas" untuk bawa komitmen bulanan.</p>
      </div>
    `;
    return;
  }

  listEl.innerHTML = items.map((item) => {
    const remaining = roundMoney(Math.max(0, item.amount - item.paid_amount));
    const paidPct = item.amount > 0 ? Math.min(100, Math.round((item.paid_amount / item.amount) * 100)) : 0;
    const isPaid = item.status === 'paid';
    const isPartial = item.status === 'partial';

    const statusBadge = isPaid
      ? `<span class="badge badge-paid">Dah Bayar${item.paid_at ? ` (${escapeHtml(item.paid_at)})` : ''}</span>`
      : isPartial
        ? `<span class="badge badge-partial">Bayar Separuh</span>`
        : `<span class="badge badge-unpaid">Belum Bayar</span>`;

    const partialProgress = isPartial
      ? `
        <div class="partial-bar-wrap">
          <div class="partial-bar-text mono">Dibayar ${formatRM(item.paid_amount)} • Baki ${formatRM(remaining)}</div>
          <div class="progress-track">
            <div class="progress-fill progress-fill--amber" style="width: ${paidPct}%"></div>
          </div>
        </div>
      `
      : '';

    const checkBtnClass = isPaid ? 'check-btn--paid' : isPartial ? 'check-btn--partial' : '';
    const checkIcon = isPaid ? '&#10003;' : isPartial ? '&minus;' : '';
    const quickActionText = isPaid ? 'Batal Bayar' : 'Bayar Penuh';

    return `
      <article class="expense-item ${isPaid ? 'expense-item--paid' : ''}" data-id="${escapeHtml(item.id)}">
        <div class="expense-left">
          <button type="button" class="check-btn ${checkBtnClass}" data-action="toggle-pay" title="${isPaid ? 'Tandakan Belum Bayar' : 'Tandakan Dah Bayar &amp; Deduct'}" aria-label="${isPaid ? 'Tandakan belum bayar' : 'Tandakan dah bayar'}">
            ${checkIcon}
          </button>
          <div class="expense-info">
            <div class="expense-title-row">
              <span class="expense-title">${escapeHtml(item.title)}</span>
              <span class="badge badge-cat">${escapeHtml(item.category)}</span>
              ${statusBadge}
            </div>
            <div class="expense-meta">
              <span>&#128197; ${escapeHtml(item.date)}</span>
              ${item.notes ? `<span>&bull; ${escapeHtml(item.notes)}</span>` : ''}
            </div>
            ${partialProgress}
          </div>
        </div>

        <div class="expense-right">
          <div class="expense-amount mono">${formatRM(item.amount)}</div>
          <div class="expense-actions">
            <button type="button" class="act-btn ${isPaid ? '' : 'act-btn--pay'}" data-action="toggle-pay">${quickActionText}</button>
            ${!isPaid ? `<button type="button" class="act-btn" data-action="partial">Separuh</button>` : ''}
            <button type="button" class="act-btn" data-action="edit">Edit</button>
            <button type="button" class="act-btn act-btn--delete" data-action="delete">Padam</button>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

function renderCategoryBreakdown() {
  const container = document.getElementById('categoryBreakdown');
  document.getElementById('categoryMonthTag').textContent = formatMonthLabel(state.currentMonth);
  const monthItems = getMonthExpenses();

  if (monthItems.length === 0) {
    container.innerHTML = `<p class="muted small-text" style="margin:0;">Tiada data kategori untuk bulan ini.</p>`;
    return;
  }

  const map = new Map();
  for (const item of monthItems) {
    const key = item.category || 'Lain-lain';
    const entry = map.get(key) || { category: key, total: 0, paid: 0 };
    entry.total = roundMoney(entry.total + Number(item.amount || 0));
    entry.paid = roundMoney(entry.paid + Number(item.paid_amount || 0));
    map.set(key, entry);
  }

  const rows = Array.from(map.values()).sort((a, b) => b.total - a.total);
  container.innerHTML = rows.map((row) => {
    const paidPct = row.total > 0 ? Math.min(100, Math.round((row.paid / row.total) * 100)) : 0;
    const unpaid = roundMoney(Math.max(0, row.total - row.paid));
    return `
      <div class="cat-row">
        <div class="cat-row-head">
          <strong>${escapeHtml(row.category)}</strong>
          <span class="mono">${formatRM(row.total)}</span>
        </div>
        <div class="cat-bar-track" title="Dibayar ${paidPct}%">
          <div class="cat-bar-paid" style="width: ${paidPct}%"></div>
        </div>
        <div class="cat-bar-legend mono">
          <span>Deduct: ${formatRM(row.paid)}</span>
          <span>Baki: ${formatRM(unpaid)}</span>
        </div>
      </div>
    `;
  }).join('');
}

function syncAddDateWithMonth() {
  const addDate = document.getElementById('addDate');
  const today = getTodayDate();
  if (today.startsWith(state.currentMonth)) {
    addDate.value = today;
  } else {
    addDate.value = `${state.currentMonth}-01`;
  }
}

function renderAll() {
  document.getElementById('currentMonthLabel').textContent = formatMonthLabel(state.currentMonth);
  renderStatusHeader();
  renderKpis();
  renderExpensesList();
  renderCategoryBreakdown();
}

async function refreshData(silent = false) {
  const syncBtn = document.getElementById('syncBtn');
  const icon = syncBtn.querySelector('.sync-icon');
  state.isSyncing = true;
  syncBtn.disabled = true;
  icon.classList.add('is-spinning');

  try {
    const res = await dataAdapter.loadAll();
    state.expenses = Array.isArray(res.expenses) ? res.expenses : [];
    state.budgets = Array.isArray(res.budgets) ? res.budgets : [];
    state.connectionError = '';
    if (!silent) {
      showToast('Data berjaya disegerakkan.');
    }
  } catch (err) {
    state.connectionError = err.message || 'Gagal memuatkan data';
    showToast(state.connectionError, true);
  } finally {
    state.isSyncing = false;
    syncBtn.disabled = false;
    icon.classList.remove('is-spinning');
    renderAll();
  }
}

function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function showPinOverlay(errorMsg = '') {
  const overlay = document.getElementById('pinOverlay');
  const errEl = document.getElementById('pinError');
  overlay.classList.remove('hidden');
  if (errorMsg) {
    errEl.textContent = errorMsg;
    errEl.classList.remove('hidden');
  } else {
    errEl.classList.add('hidden');
  }
  document.getElementById('pinInput').focus();
}

async function handleAddExpense(event) {
  event.preventDefault();
  const btn = document.getElementById('addSubmitBtn');
  const title = document.getElementById('addTitle').value.trim();
  const amount = Number(document.getElementById('addAmount').value);
  const category = document.getElementById('addCategory').value;
  const date = document.getElementById('addDate').value;
  const notes = document.getElementById('addNotes').value.trim();
  const payStatus = document.querySelector('input[name="addPayStatus"]:checked')?.value || 'unpaid';

  if (!title || !Number.isFinite(amount) || amount < 0 || !date) {
    showToast('Sila lengkapkan nama, jumlah, dan tarikh.', true);
    return;
  }

  const month = date.slice(0, 7);
  const tempId = `temp_${Date.now()}`;
  const payment = computePaymentState(amount, payStatus === 'paid' ? amount : 0, payStatus === 'paid' ? date : '');
  const optimistic = {
    id: tempId,
    month,
    date,
    title,
    category,
    amount: payment.amount,
    paid_amount: payment.paid_amount,
    status: payment.status,
    paid_at: payment.paid_at,
    notes,
    created_at: new Date().toISOString()
  };

  state.expenses.push(optimistic);
  if (month !== state.currentMonth) {
    state.currentMonth = month;
  }
  renderAll();
  btn.disabled = true;

  try {
    const res = await dataAdapter.addExpense({
      id: `exp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      month,
      date,
      title,
      category,
      amount: payment.amount,
      paid_amount: payment.paid_amount,
      status: payment.status,
      paid_at: payment.paid_at,
      notes
    });
    const idx = state.expenses.findIndex((e) => e.id === tempId);
    if (idx !== -1 && res.expense) {
      state.expenses[idx] = res.expense;
    }
    document.getElementById('addTitle').value = '';
    document.getElementById('addAmount').value = '';
    document.getElementById('addNotes').value = '';
    showToast(
      payStatus === 'paid'
        ? `Ditambah & terus deduct ${formatRM(payment.amount)}`
        : 'Komitmen berjaya ditambah.'
    );
  } catch (err) {
    state.expenses = state.expenses.filter((e) => e.id !== tempId);
    showToast(err.message || 'Gagal menambah perbelanjaan.', true);
  } finally {
    btn.disabled = false;
    renderAll();
  }
}

async function handleTogglePay(id) {
  const idx = state.expenses.findIndex((e) => e.id === id);
  if (idx === -1) return;
  const previous = { ...state.expenses[idx] };
  const mode = previous.status === 'paid' ? 'unpay' : 'full';
  const payment = computePaymentState(previous.amount, mode === 'full' ? previous.amount : 0, mode === 'full' ? getTodayDate() : '');

  state.expenses[idx] = {
    ...previous,
    paid_amount: payment.paid_amount,
    status: payment.status,
    paid_at: payment.paid_at
  };
  renderAll();

  try {
    const res = await dataAdapter.payExpense(id, { mode });
    if (res.expense) {
      const freshIdx = state.expenses.findIndex((e) => e.id === id);
      if (freshIdx !== -1) state.expenses[freshIdx] = res.expense;
    }
    showToast(
      mode === 'full'
        ? `Deduct berjaya: ${previous.title} (${formatRM(previous.amount)})`
        : `Status bayaran dibatalkan: ${previous.title}`
    );
  } catch (err) {
    const rollbackIdx = state.expenses.findIndex((e) => e.id === id);
    if (rollbackIdx !== -1) state.expenses[rollbackIdx] = previous;
    showToast(err.message || 'Gagal mengemaskini bayaran.', true);
  } finally {
    renderAll();
  }
}

function openPartialModal(id) {
  const item = state.expenses.find((e) => e.id === id);
  if (!item) return;
  const remaining = roundMoney(Math.max(0, item.amount - item.paid_amount));
  document.getElementById('partialExpenseId').value = item.id;
  document.getElementById('partialAddAmount').value = remaining > 0 ? remaining.toFixed(2) : '';
  document.getElementById('partialAddAmount').max = remaining > 0 ? remaining.toFixed(2) : '';
  document.getElementById('partialItemSummary').innerHTML = `
    <div><strong>${escapeHtml(item.title)}</strong></div>
    <div class="muted mono" style="margin-top:4px;">
      Jumlah: ${formatRM(item.amount)} &bull; Sudah Bayar: ${formatRM(item.paid_amount)} &bull; Baki: <strong>${formatRM(remaining)}</strong>
    </div>
  `;
  openModal('partialModal');
}

async function handlePartialSubmit(event) {
  event.preventDefault();
  const id = document.getElementById('partialExpenseId').value;
  const addAmount = roundMoney(Number(document.getElementById('partialAddAmount').value));
  const idx = state.expenses.findIndex((e) => e.id === id);
  if (idx === -1 || !Number.isFinite(addAmount) || addAmount <= 0) {
    showToast('Jumlah bayaran separuh tidak sah.', true);
    return;
  }

  const previous = { ...state.expenses[idx] };
  const payment = computePaymentState(previous.amount, previous.paid_amount + addAmount, getTodayDate());
  state.expenses[idx] = {
    ...previous,
    paid_amount: payment.paid_amount,
    status: payment.status,
    paid_at: payment.paid_at
  };
  closeModal('partialModal');
  renderAll();

  try {
    const res = await dataAdapter.payExpense(id, { mode: 'partial', add_amount: addAmount });
    if (res.expense) {
      const freshIdx = state.expenses.findIndex((e) => e.id === id);
      if (freshIdx !== -1) state.expenses[freshIdx] = res.expense;
    }
    showToast(`Deduct ${formatRM(addAmount)} untuk ${previous.title}`);
  } catch (err) {
    const rollbackIdx = state.expenses.findIndex((e) => e.id === id);
    if (rollbackIdx !== -1) state.expenses[rollbackIdx] = previous;
    showToast(err.message || 'Gagal merekod bayaran separuh.', true);
  } finally {
    renderAll();
  }
}

function openEditModal(id) {
  const item = state.expenses.find((e) => e.id === id);
  if (!item) return;
  document.getElementById('editId').value = item.id;
  document.getElementById('editTitle').value = item.title;
  document.getElementById('editAmount').value = Number(item.amount).toFixed(2);
  document.getElementById('editPaidAmount').value = Number(item.paid_amount).toFixed(2);
  const catSelect = document.getElementById('editCategory');
  if (!Array.from(catSelect.options).some((o) => o.value === item.category)) {
    const opt = document.createElement('option');
    opt.value = item.category;
    opt.textContent = item.category;
    catSelect.appendChild(opt);
  }
  catSelect.value = item.category;
  document.getElementById('editDate').value = item.date;
  document.getElementById('editNotes').value = item.notes || '';
  openModal('editModal');
}

async function handleEditSubmit(event) {
  event.preventDefault();
  const id = document.getElementById('editId').value;
  const idx = state.expenses.findIndex((e) => e.id === id);
  if (idx === -1) return;

  const previous = { ...state.expenses[idx] };
  const payload = {
    title: document.getElementById('editTitle').value.trim(),
    amount: Number(document.getElementById('editAmount').value),
    paid_amount: Number(document.getElementById('editPaidAmount').value),
    category: document.getElementById('editCategory').value,
    date: document.getElementById('editDate').value,
    notes: document.getElementById('editNotes').value.trim()
  };

  const payment = computePaymentState(payload.amount, payload.paid_amount, previous.paid_at || getTodayDate());
  state.expenses[idx] = {
    ...previous,
    ...payload,
    month: payload.date.slice(0, 7),
    amount: payment.amount,
    paid_amount: payment.paid_amount,
    status: payment.status,
    paid_at: payment.paid_at
  };
  closeModal('editModal');
  renderAll();

  try {
    const res = await dataAdapter.updateExpense(id, payload);
    if (res.expense) {
      const freshIdx = state.expenses.findIndex((e) => e.id === id);
      if (freshIdx !== -1) state.expenses[freshIdx] = res.expense;
    }
    showToast('Perubahan disimpan.');
  } catch (err) {
    const rollbackIdx = state.expenses.findIndex((e) => e.id === id);
    if (rollbackIdx !== -1) state.expenses[rollbackIdx] = previous;
    showToast(err.message || 'Gagal mengemaskini rekod.', true);
  } finally {
    renderAll();
  }
}

async function handleDeleteExpense(id) {
  const idx = state.expenses.findIndex((e) => e.id === id);
  if (idx === -1) return;
  const target = state.expenses[idx];
  if (!window.confirm(`Padam "${target.title}" (${formatRM(target.amount)}) daripada pangkalan data?`)) {
    return;
  }

  state.expenses.splice(idx, 1);
  renderAll();

  try {
    await dataAdapter.deleteExpense(id);
    showToast(`Rekod "${target.title}" telah dipadam.`);
  } catch (err) {
    state.expenses.splice(idx, 0, target);
    showToast(err.message || 'Gagal memadam rekod.', true);
  } finally {
    renderAll();
  }
}

function openBudgetModal() {
  const current = getActiveBudget();
  document.getElementById('budgetMonthInfo').textContent = `Bulan: ${formatMonthLabel(state.currentMonth)}`;
  document.getElementById('budgetAmountInput').value = Number(current.income_budget || 0).toFixed(2);
  document.getElementById('budgetNotesInput').value = current.notes || '';
  openModal('budgetModal');
}

async function handleBudgetSubmit(event) {
  event.preventDefault();
  const amount = roundMoney(Number(document.getElementById('budgetAmountInput').value));
  const notes = document.getElementById('budgetNotesInput').value.trim();
  if (!Number.isFinite(amount) || amount < 0) {
    showToast('Jumlah bajet tidak sah.', true);
    return;
  }

  const prevBudgets = [...state.budgets];
  const nextBudget = {
    month: state.currentMonth,
    income_budget: amount,
    notes,
    updated_at: new Date().toISOString()
  };

  const idx = state.budgets.findIndex((b) => b.month === state.currentMonth);
  if (idx !== -1) state.budgets[idx] = nextBudget;
  else state.budgets.push(nextBudget);

  closeModal('budgetModal');
  renderAll();

  try {
    const res = await dataAdapter.setBudget(state.currentMonth, { income_budget: amount, notes });
    if (res.budget) {
      const freshIdx = state.budgets.findIndex((b) => b.month === state.currentMonth);
      if (freshIdx !== -1) state.budgets[freshIdx] = res.budget;
    }
    showToast('Bajet bulanan dikemaskini.');
  } catch (err) {
    state.budgets = prevBudgets;
    showToast(err.message || 'Gagal menyimpan bajet.', true);
  } finally {
    renderAll();
  }
}

async function handleCopyPrevMonth() {
  const fromMonth = shiftMonth(state.currentMonth, -1);
  const toMonth = state.currentMonth;
  if (!window.confirm(`Salin semua item dari ${formatMonthLabel(fromMonth)} ke ${formatMonthLabel(toMonth)} sebagai Belum Bayar?`)) {
    return;
  }
  try {
    const res = await dataAdapter.copyMonth(fromMonth, toMonth);
    const added = Array.isArray(res.added) ? res.added : [];
    if (added.length === 0) {
      showToast(`Tiada rekod ditemui pada ${formatMonthLabel(fromMonth)}.`, true);
      return;
    }
    state.expenses.push(...added);
    renderAll();
    showToast(`${added.length} item disalin ke ${formatMonthLabel(toMonth)}.`);
  } catch (err) {
    showToast(err.message || 'Gagal menyalin bulan lepas.', true);
  }
}

function exportMonthCsv() {
  const rows = getMonthExpenses();
  if (rows.length === 0) {
    showToast('Tiada rekod untuk dieksport pada bulan ini.', true);
    return;
  }
  const headers = ['id', 'month', 'date', 'title', 'category', 'amount', 'paid_amount', 'status', 'paid_at', 'notes'];
  const escapeCsv = (val) => {
    const s = String(val ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escapeCsv(r[h])).join(','))
  ].join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `duittrack-${state.currentMonth}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast('Fail CSV dimuat turun.');
}

function openSettingsModal() {
  document.getElementById('settingsGasUrl').value = state.directGas.url || '';
  document.getElementById('settingsGasSecret').value = state.directGas.secret || '';
  document.getElementById('settingsSheetUrlInput').value = getSpreadsheetReferenceUrl();
  document.getElementById('clearGasBtn').classList.toggle('hidden', !state.directGas.url);
  renderStatusHeader();
  openModal('settingsModal');
}

async function handleTestConnection() {
  const mode = getActiveBackendMode();
  const candidateUrl = document.getElementById('settingsGasUrl').value.trim();
  const candidateSecret = document.getElementById('settingsGasSecret').value;

  try {
    if (state.config.configured && !candidateUrl) {
      const res = await serverApiFetch('/api/health');
      showToast(`Sambungan berjaya: ${res.spreadsheetName || 'Google Sheet'}`);
      return;
    }
    const targetUrl = candidateUrl || state.directGas.url;
    if (!targetUrl) {
      showToast('Tiada URL Apps Script untuk diuji.', true);
      return;
    }
    const res = await fetch(targetUrl, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'health', secret: candidateSecret || '' })
    });
    const text = await res.text();
    if (text.trim().startsWith('<')) {
      throw new Error('Apps Script memulangkan HTML. Pastikan "Who has access: Anyone".');
    }
    const data = JSON.parse(text);
    if (!data.ok) throw new Error(data.error || 'Ujian gagal.');
    showToast(`Berjaya disambung ke "${data.spreadsheetName || 'Google Sheet'}"!`);
  } catch (err) {
    showToast(err.message || 'Sambungan gagal.', true);
  }
}

async function handleSaveSettings(event) {
  event.preventDefault();
  const url = document.getElementById('settingsGasUrl').value.trim();
  const secret = document.getElementById('settingsGasSecret').value;
  const sheetUrl = document.getElementById('settingsSheetUrlInput').value.trim() || DEFAULT_SHEET_URL;

  if (url && /\/edit(\?|$)/i.test(url)) {
    showToast('URL Apps Script tidak boleh berakhir dengan `/edit`. Gunakan URL Web App `/exec`.', true);
    return;
  }

  state.directGas = { url, secret, spreadsheetUrl: sheetUrl };
  localStorage.setItem(STORAGE_KEYS.DIRECT_GAS, JSON.stringify(state.directGas));
  closeModal('settingsModal');
  await refreshData();
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(STORAGE_KEYS.THEME, theme);
  document.getElementById('themeToggleBtn').innerHTML = theme === 'dark' ? '&#9728;' : '&#9790;';
}

function initEventListeners() {
  document.getElementById('prevMonthBtn').addEventListener('click', () => {
    state.currentMonth = shiftMonth(state.currentMonth, -1);
    syncAddDateWithMonth();
    renderAll();
  });

  document.getElementById('nextMonthBtn').addEventListener('click', () => {
    state.currentMonth = shiftMonth(state.currentMonth, 1);
    syncAddDateWithMonth();
    renderAll();
  });

  document.getElementById('todayMonthBtn').addEventListener('click', () => {
    state.currentMonth = getTodayMonth();
    syncAddDateWithMonth();
    renderAll();
  });

  document.getElementById('syncBtn').addEventListener('click', () => refreshData(false));

  document.getElementById('themeToggleBtn').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });

  document.getElementById('settingsBtn').addEventListener('click', openSettingsModal);
  document.getElementById('statusBadge').addEventListener('click', openSettingsModal);
  document.getElementById('bannerConnectBtn').addEventListener('click', openSettingsModal);

  document.getElementById('editBudgetBtn').addEventListener('click', openBudgetModal);
  document.getElementById('budgetForm').addEventListener('submit', handleBudgetSubmit);

  document.getElementById('addExpenseForm').addEventListener('submit', handleAddExpense);
  document.getElementById('partialForm').addEventListener('submit', handlePartialSubmit);
  document.getElementById('editExpenseForm').addEventListener('submit', handleEditSubmit);
  document.getElementById('copyMonthBtn').addEventListener('click', handleCopyPrevMonth);
  document.getElementById('exportCsvBtn').addEventListener('click', exportMonthCsv);
  document.getElementById('settingsExportCsvBtn').addEventListener('click', exportMonthCsv);

  document.getElementById('searchInput').addEventListener('input', (e) => {
    state.filters.search = e.target.value;
    renderExpensesList();
  });

  document.querySelectorAll('.filter-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.filter-pill').forEach((p) => p.classList.remove('is-active'));
      pill.classList.add('is-active');
      state.filters.status = pill.dataset.status || 'all';
      renderExpensesList();
    });
  });

  document.getElementById('categoryFilter').addEventListener('change', (e) => {
    state.filters.category = e.target.value;
    renderExpensesList();
  });

  document.getElementById('sortSelect').addEventListener('change', (e) => {
    state.filters.sort = e.target.value;
    renderExpensesList();
  });

  document.getElementById('expensesList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const row = btn.closest('.expense-item');
    if (!row) return;
    const id = row.dataset.id;
    const action = btn.dataset.action;

    if (action === 'toggle-pay') handleTogglePay(id);
    else if (action === 'partial') openPartialModal(id);
    else if (action === 'edit') openEditModal(id);
    else if (action === 'delete') handleDeleteExpense(id);
  });

  document.querySelectorAll('[data-partial-pct]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = document.getElementById('partialExpenseId').value;
      const item = state.expenses.find((e) => e.id === id);
      if (!item) return;
      const remaining = Math.max(0, roundMoney(item.amount - item.paid_amount));
      const pct = Number(btn.dataset.partialPct);
      const val = roundMoney(remaining * pct);
      document.getElementById('partialAddAmount').value = val.toFixed(2);
    });
  });

  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
  });

  document.querySelectorAll('.overlay').forEach((overlay) => {
    if (overlay.id === 'pinOverlay') return;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      ['partialModal', 'editModal', 'budgetModal', 'settingsModal'].forEach(closeModal);
    }
  });

  document.getElementById('settingsForm').addEventListener('submit', handleSaveSettings);
  document.getElementById('testConnBtn').addEventListener('click', handleTestConnection);

  document.getElementById('clearGasBtn').addEventListener('click', async () => {
    state.directGas = { url: '', secret: '', spreadsheetUrl: getSpreadsheetReferenceUrl() };
    localStorage.removeItem(STORAGE_KEYS.DIRECT_GAS);
    closeModal('settingsModal');
    await refreshData();
  });

  document.getElementById('pinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const entered = document.getElementById('pinInput').value;
    state.pin = entered;
    sessionStorage.setItem(STORAGE_KEYS.APP_PIN, entered);
    try {
      await serverApiFetch('/api/expenses');
      document.getElementById('pinOverlay').classList.add('hidden');
      document.getElementById('pinError').classList.add('hidden');
      await refreshData(false);
    } catch (err) {
      sessionStorage.removeItem(STORAGE_KEYS.APP_PIN);
      state.pin = '';
      showPinOverlay(err.message || 'PIN tidak sah.');
    }
  });
}

async function init() {
  try {
    localStorage.removeItem('duittrack_demo_v1');
  } catch {
    // ignore storage access issues
  }
  const savedTheme = localStorage.getItem(STORAGE_KEYS.THEME) || 'light';
  applyTheme(savedTheme);
  syncAddDateWithMonth();
  initEventListeners();

  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const cfg = await res.json();
      state.config = {
        mode: cfg.mode || 'unconfigured',
        configured: Boolean(cfg.configured),
        authRequired: Boolean(cfg.authRequired),
        spreadsheetUrl: cfg.spreadsheetUrl || DEFAULT_SHEET_URL
      };
    }
  } catch {
    // Fallback smoothly when running purely static
  }

  if (state.config.authRequired && !state.pin) {
    renderAll();
    showPinOverlay();
    return;
  }

  await refreshData(true);
}

init();
