/* ============================================
   MÄUSE — App Logic
   IndexedDB persistence, expense CRUD, split calc
   ============================================ */

(function () {
  'use strict';

  // ==================== DATABASE ====================
  // Uses IndexedDB when available (standalone PWA on iPhone).
  // Falls back to in-memory storage in sandboxed iframes.
  const DB_NAME = 'maeuse';
  const DB_VERSION = 1;
  const STORE_NAME = 'expenses';
  let db = null;
  let useMemoryFallback = false;
  let memoryStore = []; // in-memory fallback

  function isIndexedDBAvailable() {
    try {
      if (!window.indexedDB) return false;
      // Quick probe — some sandboxes throw on open()
      const test = indexedDB.open('__idb_test__');
      test.onsuccess = () => { test.result.close(); indexedDB.deleteDatabase('__idb_test__'); };
      return true;
    } catch (e) {
      return false;
    }
  }

  function openDB() {
    return new Promise((resolve) => {
      if (!isIndexedDBAvailable()) {
        console.info('Mäuse: IndexedDB not available — using in-memory storage. Data will not persist across reloads in this context. Install as PWA for persistence.');
        useMemoryFallback = true;
        return resolve(null);
      }
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const d = e.target.result;
          if (!d.objectStoreNames.contains(STORE_NAME)) {
            const store = d.createObjectStore(STORE_NAME, { keyPath: 'id' });
            store.createIndex('date', 'date', { unique: false });
          }
        };
        req.onsuccess = (e) => {
          db = e.target.result;
          resolve(db);
        };
        req.onerror = () => {
          console.info('Mäuse: IndexedDB open failed — falling back to in-memory storage.');
          useMemoryFallback = true;
          resolve(null);
        };
      } catch (e) {
        console.info('Mäuse: IndexedDB exception — falling back to in-memory storage.');
        useMemoryFallback = true;
        resolve(null);
      }
    });
  }

  function dbPut(expense) {
    if (useMemoryFallback) {
      const idx = memoryStore.findIndex(e => e.id === expense.id);
      if (idx >= 0) memoryStore[idx] = expense;
      else memoryStore.push(expense);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(expense);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  function dbDelete(id) {
    if (useMemoryFallback) {
      memoryStore = memoryStore.filter(e => e.id !== id);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  function dbGetAll() {
    if (useMemoryFallback) {
      return Promise.resolve([...memoryStore]);
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  // ==================== STATE ====================
  let expenses = [];
  let currentYear = new Date().getFullYear();
  let currentMonth = new Date().getMonth(); // 0-indexed
  let editingId = null;

  // ==================== DOM REFS ====================
  const $ = (sel) => document.querySelector(sel);
  const monthLabel = $('#monthLabel');
  const totalAmountEl = $('#totalAmount');
  const partnerAmountEl = $('#partnerAmount');
  const expenseListEl = $('#expenseList');
  const addBtn = $('#addBtn');
  const sheetOverlay = $('#sheetOverlay');
  const sheet = $('#sheet');
  const sheetTitle = $('#sheetTitle');
  const sheetCancel = $('#sheetCancel');
  const sheetSave = $('#sheetSave');
  const inputAmount = $('#inputAmount');
  const inputDesc = $('#inputDesc');
  const inputDate = $('#inputDate');
  const todayBtn = $('#todayBtn');
  const splitToggle = $('#splitToggle');
  const inputSplit = $('#inputSplit');
  const splitSuffix = $('#splitSuffix');
  const splitResult = $('#splitResult');
  const presetChips = $('#presetChips');
  const deleteRow = $('#deleteRow');
  const deleteBtn = $('#deleteBtn');

  let splitMode = 'percent'; // 'percent' or 'fixed'

  // ==================== HELPERS ====================
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  function formatEuro(n) {
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  }

  function formatDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
  }

  function todayISO() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
  }

  function parseAmount(str) {
    if (!str) return 0;
    // Accept both comma and dot as decimal separator
    const clean = str.replace(/\s/g, '').replace(',', '.');
    const n = parseFloat(clean);
    return isNaN(n) ? 0 : Math.round(n * 100) / 100;
  }

  function calcPartnerShare(expense) {
    if (expense.splitMode === 'percent') {
      return Math.round(expense.amount * (expense.splitValue / 100) * 100) / 100;
    } else {
      return Math.min(expense.splitValue, expense.amount);
    }
  }

  // ==================== THEME ====================
  (function initTheme() {
    const toggle = $('[data-theme-toggle]');
    const root = document.documentElement;
    let theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    root.setAttribute('data-theme', theme);
    updateThemeIcon(theme);

    toggle.addEventListener('click', () => {
      theme = theme === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', theme);
      updateThemeIcon(theme);
    });

    function updateThemeIcon(t) {
      toggle.innerHTML = t === 'dark'
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    }
  })();

  // ==================== ONBOARDING ====================
  const ONBOARDING_PREFERENCE_KEY = 'maeuse:onboarding-hidden';
  const onboardingEl = $('#onboarding');
  const onboardingSkipCheckbox = $('#onboardingSkip');
  const onboardingStartBtn = $('#onboardingStart');
  const aboutBtn = $('#aboutBtn');
  let onboardingHideTimer = null;
  let onboardingPreferenceFallback = null;

  function readOnboardingPreference() {
    try {
      const value = window.localStorage.getItem(ONBOARDING_PREFERENCE_KEY);
      if (value === 'true') return true;
      if (value === 'false') return false;
    } catch (e) {
      // Ignore storage access failures and fall back gracefully.
    }
    return onboardingPreferenceFallback;
  }

  function writeOnboardingPreference(shouldHideOnLaunch) {
    onboardingPreferenceFallback = shouldHideOnLaunch;

    try {
      window.localStorage.setItem(ONBOARDING_PREFERENCE_KEY, shouldHideOnLaunch ? 'true' : 'false');
      return true;
    } catch (e) {
      return false;
    }
  }

  function setOnboardingMode(mode) {
    onboardingStartBtn.textContent = mode === 'revisit' ? 'Back to App' : 'Get Started';
  }

  function showOnboarding() {
    clearTimeout(onboardingHideTimer);
    document.documentElement.classList.remove('onboarding-pref-hidden');
    onboardingEl.style.display = '';
    requestAnimationFrame(() => {
      onboardingEl.classList.remove('hidden');
    });
  }

  function hideOnboarding(immediate) {
    clearTimeout(onboardingHideTimer);
    onboardingEl.classList.add('hidden');

    if (immediate) {
      onboardingEl.style.display = 'none';
      return;
    }

    onboardingHideTimer = setTimeout(() => {
      if (onboardingEl.classList.contains('hidden')) {
        onboardingEl.style.display = 'none';
      }
    }, 500);
  }

  function openOnboarding(mode) {
    const storedPreference = readOnboardingPreference();
    setOnboardingMode(mode);
    onboardingSkipCheckbox.checked = storedPreference === null ? true : storedPreference;
    showOnboarding();
  }

  function checkOnboarding() {
    const storedPreference = readOnboardingPreference();

    if (storedPreference !== null) {
      onboardingSkipCheckbox.checked = storedPreference;
      if (storedPreference) {
        hideOnboarding(true);
      } else {
        openOnboarding('initial');
      }
      return;
    }

    if (expenses.length > 0) {
      writeOnboardingPreference(true);
      onboardingSkipCheckbox.checked = true;
      hideOnboarding(true);
      return;
    }

    onboardingSkipCheckbox.checked = true;
    openOnboarding('initial');
  }

  onboardingStartBtn.addEventListener('click', () => {
    writeOnboardingPreference(onboardingSkipCheckbox.checked);
    hideOnboarding();
  });

  aboutBtn.addEventListener('click', () => {
    openOnboarding('revisit');
  });

  // ==================== MONTH NAVIGATION ====================
  function updateMonthLabel() {
    monthLabel.textContent = monthNames[currentMonth] + ' ' + currentYear;
  }

  $('#prevMonth').addEventListener('click', () => {
    currentMonth--;
    if (currentMonth < 0) { currentMonth = 11; currentYear--; }
    updateMonthLabel();
    renderList();
  });

  $('#nextMonth').addEventListener('click', () => {
    currentMonth++;
    if (currentMonth > 11) { currentMonth = 0; currentYear++; }
    updateMonthLabel();
    renderList();
  });

  // ==================== RENDER ====================
  function getMonthExpenses() {
    return expenses.filter(e => {
      const d = new Date(e.date + 'T00:00:00');
      return d.getFullYear() === currentYear && d.getMonth() === currentMonth;
    }).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  }

  function renderList() {
    const items = getMonthExpenses();
    let totalSum = 0;
    let partnerSum = 0;

    items.forEach(e => {
      totalSum += e.amount;
      partnerSum += calcPartnerShare(e);
    });

    totalAmountEl.textContent = formatEuro(totalSum);
    partnerAmountEl.textContent = formatEuro(partnerSum);

    if (items.length === 0) {
      expenseListEl.innerHTML = `
        <div class="empty-state animate-in">
          <div class="empty-state-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="5" width="20" height="14" rx="2"/>
              <path d="M2 10h20"/>
            </svg>
          </div>
          <div class="empty-state-title">No expenses yet</div>
          <div class="empty-state-text">Tap + to log a shared expense</div>
        </div>
      `;
      return;
    }

    // Group by date
    const groups = {};
    items.forEach(e => {
      const label = formatDate(e.date);
      if (!groups[label]) groups[label] = [];
      groups[label].push(e);
    });

    let html = '';
    let animIdx = 0;
    for (const [dateLabel, group] of Object.entries(groups)) {
      html += `<div class="list-header">${dateLabel}</div>`;
      group.forEach(e => {
        const share = calcPartnerShare(e);
        const splitLabel = e.splitMode === 'percent'
          ? `${e.splitValue}%`
          : 'fixed amount';
        html += `
          <div class="expense-item animate-in" style="animation-delay:${animIdx * 40}ms" data-id="${e.id}">
            <div class="expense-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="1" x2="12" y2="23"/>
                <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
              </svg>
            </div>
            <div class="expense-details">
              <div class="expense-desc">${escapeHtml(e.description || 'Expense')}</div>
              <div class="expense-meta">${splitLabel}</div>
            </div>
            <div class="expense-amounts">
              <div class="expense-total">${formatEuro(e.amount)}</div>
              <div class="expense-split">${formatEuro(share)}</div>
            </div>
          </div>`;
        animIdx++;
      });
    }
    expenseListEl.innerHTML = html;

    // Attach tap to edit
    expenseListEl.querySelectorAll('.expense-item').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        const exp = expenses.find(e => e.id === id);
        if (exp) openSheet(exp);
      });
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ==================== SHEET (ADD/EDIT) ====================
  function openSheet(expense) {
    editingId = expense ? expense.id : null;
    sheetTitle.textContent = expense ? 'Edit Expense' : 'New Expense';
    deleteRow.style.display = expense ? 'block' : 'none';

    // Reset form
    if (expense) {
      inputAmount.value = expense.amount.toFixed(2);
      inputDesc.value = expense.description;
      inputDate.value = expense.date;
      splitMode = expense.splitMode;
      inputSplit.value = expense.splitValue.toString();
    } else {
      inputAmount.value = '';
      inputDesc.value = '';
      inputDate.value = todayISO();
      splitMode = 'percent';
      inputSplit.value = '50';
    }

    // Update toggle
    splitToggle.querySelectorAll('.split-toggle-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === splitMode);
    });
    splitSuffix.textContent = splitMode === 'percent' ? '%' : '€';
    presetChips.style.display = splitMode === 'percent' ? 'flex' : 'none';
    updatePresetChips();
    updateSplitResult();

    // Show sheet
    sheetOverlay.classList.add('open');
    sheet.classList.add('open');

    // Focus amount for quick entry
    setTimeout(() => {
      inputAmount.focus();
      inputAmount.select();
    }, 350);
  }

  function closeSheet() {
    sheetOverlay.classList.remove('open');
    sheet.classList.remove('open');
    editingId = null;
    inputAmount.blur();
    inputDesc.blur();
  }

  function saveExpense() {
    const amount = parseAmount(inputAmount.value);
    if (amount <= 0) {
      inputAmount.focus();
      return;
    }

    const description = inputDesc.value.trim();
    const date = inputDate.value || todayISO();
    const splitValue = parseAmount(inputSplit.value);

    const expense = {
      id: editingId || uid(),
      amount,
      description,
      date,
      splitMode,
      splitValue: splitMode === 'percent' ? Math.min(Math.max(splitValue, 0), 100) : Math.max(splitValue, 0),
      updatedAt: Date.now()
    };

    dbPut(expense).then(() => {
      if (editingId) {
        const idx = expenses.findIndex(e => e.id === editingId);
        if (idx >= 0) expenses[idx] = expense;
      } else {
        expenses.push(expense);
      }
      // Navigate to the month of the expense
      const d = new Date(date + 'T00:00:00');
      currentYear = d.getFullYear();
      currentMonth = d.getMonth();
      updateMonthLabel();
      renderList();
      closeSheet();
    });
  }

  function deleteExpense() {
    if (!editingId) return;
    dbDelete(editingId).then(() => {
      expenses = expenses.filter(e => e.id !== editingId);
      renderList();
      closeSheet();
    });
  }

  // ==================== SPLIT CALC ====================
  function updateSplitResult() {
    const amount = parseAmount(inputAmount.value);
    const splitVal = parseAmount(inputSplit.value);

    let result;
    if (splitMode === 'percent') {
      result = amount * (splitVal / 100);
    } else {
      result = Math.min(splitVal, amount);
    }
    splitResult.textContent = '= ' + formatEuro(Math.round(result * 100) / 100);
  }

  function updatePresetChips() {
    const val = parseAmount(inputSplit.value);
    presetChips.querySelectorAll('.preset-chip').forEach(chip => {
      chip.classList.toggle('active', parseFloat(chip.dataset.value) === val);
    });
  }

  // ==================== EVENT LISTENERS ====================
  addBtn.addEventListener('click', () => openSheet(null));
  sheetOverlay.addEventListener('click', closeSheet);
  sheetCancel.addEventListener('click', closeSheet);
  sheetSave.addEventListener('click', saveExpense);
  deleteBtn.addEventListener('click', deleteExpense);

  todayBtn.addEventListener('click', () => {
    inputDate.value = todayISO();
  });

  // Split toggle
  splitToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.split-toggle-btn');
    if (!btn) return;
    splitMode = btn.dataset.mode;
    splitToggle.querySelectorAll('.split-toggle-btn').forEach(b => {
      b.classList.toggle('active', b === btn);
    });
    splitSuffix.textContent = splitMode === 'percent' ? '%' : '€';
    presetChips.style.display = splitMode === 'percent' ? 'flex' : 'none';

    // Reset to sensible defaults when switching
    if (splitMode === 'percent') {
      inputSplit.value = '50';
    } else {
      const amount = parseAmount(inputAmount.value);
      inputSplit.value = (amount / 2).toFixed(2);
    }
    updatePresetChips();
    updateSplitResult();
  });

  // Preset chips
  presetChips.addEventListener('click', (e) => {
    const chip = e.target.closest('.preset-chip');
    if (!chip) return;
    inputSplit.value = chip.dataset.value;
    updatePresetChips();
    updateSplitResult();
  });

  // Live split calculation
  inputAmount.addEventListener('input', () => {
    updateSplitResult();
  });
  inputSplit.addEventListener('input', () => {
    updatePresetChips();
    updateSplitResult();
  });

  // Allow Enter key to save
  inputDesc.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveExpense();
    }
  });

  inputAmount.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      inputDesc.focus();
    }
  });

  // ==================== SERVICE WORKER ====================
  // Only register in contexts that support it (not sandboxed iframes)
  try {
    if ('serviceWorker' in navigator && navigator.serviceWorker) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  } catch (e) {
    // Silently ignore — SW not available in this context
  }

  // ==================== PERSISTENCE WARNING ====================
  function showMemoryWarning() {
    const banner = document.getElementById('memoryWarning');
    if (banner) banner.classList.add('visible');
  }

  // ==================== INIT ====================
  async function init() {
    await openDB();
    if (useMemoryFallback) showMemoryWarning();
    expenses = await dbGetAll();
    updateMonthLabel();
    renderList();
    checkOnboarding();
  }

  init();
})();
