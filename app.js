/* ============================================
   MÄUSE — App Logic
   IndexedDB persistence, expense CRUD, voice mode
   ============================================ */

(function () {
  'use strict';

  // ==================== DATABASE ====================
  const DB_NAME = 'maeuse';
  const DB_VERSION = 1;
  const STORE_NAME = 'expenses';

  // ==================== VOICE CONFIG ====================
  const VOICE_SETTINGS_KEY = 'maeuse:voice-settings';
  const VOICE_EXTRACT_MODEL = 'gpt-5-nano';
  // OpenAI's current docs recommend gpt-4o-mini-transcribe for best results.
  const VOICE_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';
  const VOICE_EXTRACT_DEBOUNCE_MS = 400;
  const VOICE_TRANSCRIPTION_PROMPT = [
    'Expense dictation for the Mäuse expense tracker.',
    'Expect euros, cents, dates, mixed German and English, grocery stores, restaurants, and partner aliases like wife, husband, spouse, and partner.',
    'Prefer merchant names exactly as spoken.'
  ].join(' ');

  const voiceUtils = window.MaeuseVoiceUtils || {};

  let db = null;
  let useMemoryFallback = false;
  let memoryStore = [];

  // ==================== STATE ====================
  let expenses = [];
  let currentYear = new Date().getFullYear();
  let currentMonth = new Date().getMonth();
  let editingId = null;
  let splitMode = 'percent';
  let swRegistration = null;
  let swRefreshPending = false;
  let swUpdateIntervalId = null;
  let settingsBusy = false;
  let onboardingHideTimer = null;
  let onboardingPreferenceFallback = null;
  let voiceSettings = loadVoiceSettings();
  let voiceDraft = createEmptyVoiceDraft(todayISO());
  let voiceSession = null;

  // ==================== DOM REFS ====================
  const $ = function (selector) { return document.querySelector(selector); };

  const monthLabel = $('#monthLabel');
  const totalAmountEl = $('#totalAmount');
  const partnerAmountEl = $('#partnerAmount');
  const expenseListEl = $('#expenseList');
  const addBtn = $('#addBtn');
  const voiceBtn = $('#voiceBtn');
  const memoryWarning = $('#memoryWarning');
  const updateNotice = $('#updateNotice');
  const updateReloadBtn = $('#updateReloadBtn');
  const settingsBtn = $('#settingsBtn');
  const settingsOverlay = $('#settingsOverlay');
  const settingsSheet = $('#settingsSheet');
  const settingsDone = $('#settingsDone');
  const exportDataBtn = $('#exportDataBtn');
  const importDataBtn = $('#importDataBtn');
  const importFileInput = $('#importFileInput');
  const settingsStatus = $('#settingsStatus');
  const voiceSettingsCard = $('#voiceSettingsCard');
  const voiceApiKeyInput = $('#voiceApiKey');
  const voiceVerifyBtn = $('#voiceVerifyBtn');
  const voiceEnabledToggle = $('#voiceEnabledToggle');
  const voiceSettingsStatus = $('#voiceSettingsStatus');
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
  const voiceOverlay = $('#voiceOverlay');
  const voiceSheet = $('#voiceSheet');
  const voiceCancel = $('#voiceCancel');
  const voiceDone = $('#voiceDone');
  const voiceMicToggle = $('#voiceMicToggle');
  const voiceSessionStatus = $('#voiceSessionStatus');
  const voiceSheetStatus = $('#voiceSheetStatus');
  const voiceAmountValue = $('#voiceAmountValue');
  const voiceAmountHint = $('#voiceAmountHint');
  const voiceDescriptionValue = $('#voiceDescriptionValue');
  const voiceDescriptionHint = $('#voiceDescriptionHint');
  const voiceDateValue = $('#voiceDateValue');
  const voiceDateHint = $('#voiceDateHint');
  const voiceShareValue = $('#voiceShareValue');
  const voiceShareHint = $('#voiceShareHint');
  const voiceSwitchManual = $('#voiceSwitchManual');
  const onboardingEl = $('#onboarding');
  const onboardingSkipCheckbox = $('#onboardingSkip');
  const onboardingStartBtn = $('#onboardingStart');
  const aboutBtn = $('#aboutBtn');

  // ==================== HELPERS ====================
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  function isIndexedDBAvailable() {
    try {
      if (!window.indexedDB) return false;
      const test = indexedDB.open('__idb_test__');
      test.onsuccess = function () {
        test.result.close();
        indexedDB.deleteDatabase('__idb_test__');
      };
      return true;
    } catch (error) {
      return false;
    }
  }

  function openDB() {
    return new Promise(function (resolve) {
      if (!isIndexedDBAvailable()) {
        console.info('Mäuse: IndexedDB not available, using in-memory storage.');
        useMemoryFallback = true;
        resolve(null);
        return;
      }

      try {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = function (event) {
          const database = event.target.result;
          if (!database.objectStoreNames.contains(STORE_NAME)) {
            const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
            store.createIndex('date', 'date', { unique: false });
          }
        };
        request.onsuccess = function (event) {
          db = event.target.result;
          resolve(db);
        };
        request.onerror = function () {
          console.info('Mäuse: IndexedDB open failed, using in-memory storage.');
          useMemoryFallback = true;
          resolve(null);
        };
      } catch (error) {
        console.info('Mäuse: IndexedDB exception, using in-memory storage.');
        useMemoryFallback = true;
        resolve(null);
      }
    });
  }

  function dbPut(expense) {
    if (useMemoryFallback) {
      const existingIndex = memoryStore.findIndex(function (item) { return item.id === expense.id; });
      if (existingIndex >= 0) {
        memoryStore[existingIndex] = expense;
      } else {
        memoryStore.push(expense);
      }
      return Promise.resolve();
    }

    return new Promise(function (resolve, reject) {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(expense);
      transaction.oncomplete = function () { resolve(); };
      transaction.onerror = function (event) { reject(event.target.error); };
    });
  }

  function dbDelete(id) {
    if (useMemoryFallback) {
      memoryStore = memoryStore.filter(function (item) { return item.id !== id; });
      return Promise.resolve();
    }

    return new Promise(function (resolve, reject) {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(id);
      transaction.oncomplete = function () { resolve(); };
      transaction.onerror = function (event) { reject(event.target.error); };
    });
  }

  function dbGetAll() {
    if (useMemoryFallback) {
      return Promise.resolve(memoryStore.slice());
    }

    return new Promise(function (resolve, reject) {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).getAll();
      request.onsuccess = function () { resolve(request.result || []); };
      request.onerror = function (event) { reject(event.target.error); };
    });
  }

  function dbReplaceAll(nextExpenses) {
    if (useMemoryFallback) {
      memoryStore = nextExpenses.map(function (expense) { return { ...expense }; });
      return Promise.resolve();
    }

    return new Promise(function (resolve, reject) {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.clear();
      nextExpenses.forEach(function (expense) {
        store.put(expense);
      });
      transaction.oncomplete = function () { resolve(); };
      transaction.onerror = function (event) { reject(event.target.error); };
      transaction.onabort = function (event) {
        reject(event.target.error || new Error('Failed to replace expenses.'));
      };
    });
  }

  function roundMoney(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.round(value * 100) / 100;
  }

  function formatEuro(amount) {
    return amount.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }) + ' €';
  }

  function formatPercent(value) {
    if (!Number.isFinite(value)) return '0 %';
    return (Math.round(value * 100) / 100).toLocaleString('en-US', {
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
      maximumFractionDigits: 2
    }) + ' %';
  }

  function formatDate(dateStr) {
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
  }

  function formatVoiceDate(dateStr) {
    if (!isValidDateString(dateStr)) return 'Today';
    if (dateStr === todayISO()) return 'Today';
    if (dateStr === shiftISODate(todayISO(), -1)) return 'Yesterday';
    if (dateStr === shiftISODate(todayISO(), 1)) return 'Tomorrow';

    const date = new Date(dateStr + 'T00:00:00');
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return date.toLocaleDateString('en-US', {
      day: 'numeric',
      month: 'short',
      year: sameYear ? undefined : 'numeric'
    });
  }

  function todayISO() {
    const date = new Date();
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }

  function shiftISODate(baseIso, offset) {
    const baseDate = new Date(baseIso + 'T00:00:00');
    baseDate.setDate(baseDate.getDate() + offset);
    return baseDate.getFullYear() + '-' + String(baseDate.getMonth() + 1).padStart(2, '0') + '-' + String(baseDate.getDate()).padStart(2, '0');
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function isValidDateString(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  }

  function parseAmount(value) {
    if (!value) return 0;
    const cleaned = String(value).replace(/\s/g, '').replace(',', '.');
    const parsed = parseFloat(cleaned);
    return Number.isNaN(parsed) ? 0 : roundMoney(parsed);
  }

  function calcPartnerShare(expense) {
    if (expense.splitMode === 'fixed') {
      return Math.min(expense.splitValue, expense.amount);
    }
    return roundMoney(expense.amount * (expense.splitValue / 100));
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value;
    return div.innerHTML;
  }

  function normalizeVoiceKey(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function sanitizeVoiceSettings(rawSettings) {
    const settings = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
    const apiKey = normalizeVoiceKey(settings.apiKey);
    const verifiedAt = Number(settings.verifiedAt);
    const verified = Number.isFinite(verifiedAt) && verifiedAt > 0 ? verifiedAt : 0;
    return {
      apiKey: apiKey,
      verifiedAt: verified,
      enabled: Boolean(settings.enabled && apiKey && verified)
    };
  }

  function loadVoiceSettings() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(VOICE_SETTINGS_KEY) || '{}');
      return sanitizeVoiceSettings(parsed);
    } catch (error) {
      return sanitizeVoiceSettings({});
    }
  }

  function saveVoiceSettings() {
    try {
      window.localStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify(voiceSettings));
    } catch (error) {
      // Ignore storage failures and keep the in-memory value.
    }
  }

  function createEmptyVoiceDraft(todayIso) {
    if (voiceUtils.createEmptyVoiceDraft) {
      return voiceUtils.createEmptyVoiceDraft(todayIso);
    }
    return {
      amount: null,
      description: '',
      dateIso: todayIso,
      partnerShareMode: null,
      partnerShareValue: null,
      partnerAlias: '',
      confidence: { amount: 0, description: 0, date: 0, partnerShare: 0 },
      isComplete: false,
      source: 'empty'
    };
  }

  function normalizeVoiceExtraction(raw) {
    if (voiceUtils.normalizeVoiceExtraction) {
      return voiceUtils.normalizeVoiceExtraction(raw, { todayIso: todayISO() });
    }
    return createEmptyVoiceDraft(todayISO());
  }

  function parseTranscriptDraft(transcript) {
    if (voiceUtils.parseTranscriptDraft) {
      return voiceUtils.parseTranscriptDraft(transcript, { todayIso: todayISO() });
    }
    return createEmptyVoiceDraft(todayISO());
  }

  function mergeVoiceDrafts(baseDraft, incomingDraft) {
    if (voiceUtils.mergeVoiceDraft) {
      return voiceUtils.mergeVoiceDraft(baseDraft, incomingDraft);
    }
    return incomingDraft || baseDraft;
  }

  function resolveCommittedTurnOrder(commits) {
    if (voiceUtils.resolveCommittedTurnOrder) {
      return voiceUtils.resolveCommittedTurnOrder(commits);
    }
    return commits.map(function (commit) { return commit.itemId; });
  }

  function composeTranscriptText(order, textById) {
    if (voiceUtils.composeTranscriptText) {
      return voiceUtils.composeTranscriptText(order, textById);
    }
    return order.map(function (itemId) { return (textById[itemId] || '').trim(); }).filter(Boolean).join(' ').trim();
  }

  function getLatestVoiceTurnText(session) {
    if (!session || !Array.isArray(session.order) || !session.order.length) return '';
    const latestItemId = session.order[session.order.length - 1];
    return typeof session.textsById[latestItemId] === 'string' ? session.textsById[latestItemId].trim() : '';
  }

  function getRecentVoiceTurns(session, limit) {
    if (!session || !Array.isArray(session.order)) return [];
    const startIndex = Math.max(session.order.length - limit, 0);

    return session.order.slice(startIndex).map(function (itemId, offset) {
      return {
        order: startIndex + offset + 1,
        text: typeof session.textsById[itemId] === 'string' ? session.textsById[itemId].trim() : ''
      };
    }).filter(function (turn) {
      return !!turn.text;
    });
  }

  function serializeVoiceDraftForExtraction(draft) {
    const source = draft && typeof draft === 'object' ? draft : createEmptyVoiceDraft(todayISO());
    return {
      amount: source.amount,
      description: source.description || '',
      date_iso: source.dateIso || todayISO(),
      partner_share_mode: source.partnerShareMode,
      partner_share_value: source.partnerShareValue,
      partner_alias: source.partnerAlias || ''
    };
  }

  function buildVoiceExtractionPayload(session, draftSnapshot) {
    return {
      today_iso: todayISO(),
      locale: 'en-US',
      current_draft: serializeVoiceDraftForExtraction(draftSnapshot),
      latest_turn: session && session.latestTurnText ? session.latestTurnText : '',
      recent_turns: getRecentVoiceTurns(session, 6)
    };
  }

  function shouldApplyVoiceVersion(latestApplied, candidate) {
    if (voiceUtils.shouldApplyVoiceVersion) {
      return voiceUtils.shouldApplyVoiceVersion(latestApplied, candidate);
    }
    return candidate > latestApplied;
  }

  function buildDefaultExpenseDraft() {
    return {
      amount: null,
      description: '',
      date: todayISO(),
      splitMode: 'percent',
      splitValue: 50
    };
  }

  function normalizeExpenseDraftForSheet(source) {
    const draft = source && typeof source === 'object' ? source : {};
    const parsedAmount = Number(draft.amount);
    const amount = Number.isFinite(parsedAmount) && parsedAmount > 0 ? roundMoney(parsedAmount) : null;
    const description = typeof draft.description === 'string' ? draft.description.trim() : '';
    const candidateDate = typeof draft.date === 'string' ? draft.date : typeof draft.dateIso === 'string' ? draft.dateIso : '';
    const date = isValidDateString(candidateDate) ? candidateDate : todayISO();
    const candidateSplitMode = draft.splitMode === 'fixed' || draft.partnerShareMode === 'fixed'
      ? 'fixed'
      : 'percent';
    const rawSplitValue = draft.splitValue ?? draft.partnerShareValue;
    const splitValue = Number.isFinite(Number(rawSplitValue))
      ? roundMoney(Number(rawSplitValue))
      : candidateSplitMode === 'percent'
        ? 50
        : amount
          ? roundMoney(amount / 2)
          : 0;

    return {
      amount: amount,
      description: description,
      date: date,
      splitMode: candidateSplitMode,
      splitValue: candidateSplitMode === 'percent'
        ? Math.min(Math.max(splitValue, 0), 100)
        : Math.max(splitValue, 0)
    };
  }

  function normalizeExpenseDraftForSave(source) {
    const sheetDraft = normalizeExpenseDraftForSheet(source);
    const splitModeValue = sheetDraft.splitMode === 'fixed' ? 'fixed' : 'percent';
    const splitValue = splitModeValue === 'fixed'
      ? Math.max(sheetDraft.splitValue, 0)
      : Math.min(Math.max(sheetDraft.splitValue || 50, 0), 100);

    return {
      amount: sheetDraft.amount,
      description: sheetDraft.description,
      date: sheetDraft.date,
      splitMode: splitModeValue,
      splitValue: splitValue
    };
  }

  function draftFromExpense(expense) {
    return {
      amount: expense.amount,
      description: expense.description,
      date: expense.date,
      splitMode: expense.splitMode,
      splitValue: expense.splitValue
    };
  }

  function draftFromVoiceDraft(sourceDraft) {
    const partnerShareMode = sourceDraft.partnerShareMode === 'fixed' ? 'fixed' : 'percent';
    const partnerShareValue = sourceDraft.partnerShareMode
      ? sourceDraft.partnerShareValue
      : 50;

    return {
      amount: sourceDraft.amount,
      description: sourceDraft.description,
      date: sourceDraft.dateIso,
      splitMode: partnerShareMode,
      splitValue: Number.isFinite(Number(partnerShareValue))
        ? roundMoney(Number(partnerShareValue))
        : partnerShareMode === 'percent'
          ? 50
          : 0
    };
  }

  function collectManualDraft() {
    return {
      amount: parseAmount(inputAmount.value),
      description: inputDesc.value.trim(),
      date: inputDate.value || todayISO(),
      splitMode: splitMode,
      splitValue: parseAmount(inputSplit.value)
    };
  }

  function setSettingsStatus(message, tone) {
    if (!settingsStatus) return;
    settingsStatus.hidden = !message;
    settingsStatus.textContent = message || '';
    settingsStatus.className = tone ? 'settings-status is-' + tone : 'settings-status';
  }

  function setVoiceSettingsStatus(message, tone) {
    if (!voiceSettingsStatus) return;
    voiceSettingsStatus.hidden = !message;
    voiceSettingsStatus.textContent = message || '';
    voiceSettingsStatus.className = tone ? 'settings-status is-' + tone : 'settings-status';
  }

  function setVoiceSheetStatus(message, tone) {
    if (!voiceSheetStatus) return;
    voiceSheetStatus.hidden = !message;
    voiceSheetStatus.textContent = message || '';
    voiceSheetStatus.className = tone ? 'voice-sheet-status is-' + tone : 'voice-sheet-status';
  }

  function setVoiceSessionStatus(message) {
    if (voiceSessionStatus) {
      voiceSessionStatus.textContent = message || 'Listening';
    }
  }

  function setSettingsBusy(isBusy) {
    settingsBusy = isBusy;
    if (exportDataBtn) exportDataBtn.disabled = isBusy;
    if (importDataBtn) importDataBtn.disabled = isBusy;
    if (settingsDone) settingsDone.disabled = isBusy;
    syncVoiceSettingsControls();
  }

  function syncVoiceSettingsControls() {
    const canVerify = !settingsBusy && !!normalizeVoiceKey(voiceApiKeyInput ? voiceApiKeyInput.value : voiceSettings.apiKey);
    const canEnable = !settingsBusy && !!voiceSettings.apiKey && !!voiceSettings.verifiedAt;

    if (voiceApiKeyInput) voiceApiKeyInput.disabled = settingsBusy;
    if (voiceVerifyBtn) voiceVerifyBtn.disabled = !canVerify;
    if (voiceEnabledToggle) voiceEnabledToggle.disabled = !canEnable;
  }

  function renderVoiceSettings() {
    if (voiceApiKeyInput && voiceApiKeyInput.value !== voiceSettings.apiKey) {
      voiceApiKeyInput.value = voiceSettings.apiKey;
    }
    if (voiceEnabledToggle) {
      voiceEnabledToggle.checked = !!voiceSettings.enabled;
    }
    syncVoiceSettingsControls();
    renderVoiceButtonState();
  }

  function renderVoiceButtonState() {
    if (!voiceBtn) return;
    voiceBtn.title = voiceSettings.enabled
      ? 'Add expense by voice'
      : 'Enable voice mode in Settings';
    voiceBtn.setAttribute(
      'aria-label',
      voiceSettings.enabled ? 'Add expense by voice' : 'Enable voice mode in settings'
    );
  }

  function focusVoiceSettings() {
    if (!voiceSettingsCard) return;
    window.setTimeout(function () {
      voiceSettingsCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      if (voiceSettings.apiKey && voiceEnabledToggle && !voiceEnabledToggle.disabled) {
        voiceEnabledToggle.focus();
      } else if (voiceApiKeyInput) {
        voiceApiKeyInput.focus();
        voiceApiKeyInput.select();
      }
    }, 320);
  }

  function openSettingsSheet(section) {
    if (!settingsOverlay || !settingsSheet) return;
    setSettingsStatus('', '');
    settingsOverlay.classList.add('open');
    settingsSheet.classList.add('open');

    if (section === 'voice') {
      focusVoiceSettings();
    }
  }

  function closeSettingsSheet() {
    if (settingsBusy) return;
    if (settingsOverlay) settingsOverlay.classList.remove('open');
    if (settingsSheet) settingsSheet.classList.remove('open');
    if (importFileInput) importFileInput.value = '';
  }

  function renderVoiceDraft() {
    const activeSession = voiceSession;
    const hasTranscript = !!(activeSession && activeSession.transcriptText);
    const partnerAlias = voiceDraft.partnerAlias || '';

    if (voiceAmountValue) {
      voiceAmountValue.textContent = voiceDraft.amount ? formatEuro(voiceDraft.amount) : 'Waiting…';
    }
    if (voiceAmountHint) {
      voiceAmountHint.textContent = voiceDraft.amount ? 'Updated live while you speak' : 'Say the total amount';
    }

    if (voiceDescriptionValue) {
      voiceDescriptionValue.textContent = voiceDraft.description || 'Optional';
    }
    if (voiceDescriptionHint) {
      voiceDescriptionHint.textContent = voiceDraft.description ? 'Merchant, store, or note' : 'Store, merchant, or note';
    }

    if (voiceDateValue) {
      voiceDateValue.textContent = formatVoiceDate(voiceDraft.dateIso || todayISO());
    }
    if (voiceDateHint) {
      voiceDateHint.textContent = hasTranscript ? 'Resolved from your dictation' : 'Defaults to today';
    }

    if (voiceShareValue) {
      if (voiceDraft.partnerShareMode === 'fixed' && Number.isFinite(voiceDraft.partnerShareValue)) {
        voiceShareValue.textContent = formatEuro(voiceDraft.partnerShareValue);
      } else if (voiceDraft.partnerShareMode === 'percent' && Number.isFinite(voiceDraft.partnerShareValue)) {
        voiceShareValue.textContent = formatPercent(voiceDraft.partnerShareValue);
      } else {
        voiceShareValue.textContent = '50 %';
      }
    }

    if (voiceShareHint) {
      if (voiceDraft.partnerShareMode === 'fixed') {
        voiceShareHint.textContent = partnerAlias ? 'Fixed amount for ' + partnerAlias : 'Fixed amount';
      } else if (voiceDraft.partnerShareMode === 'percent') {
        voiceShareHint.textContent = partnerAlias ? 'Split with ' + partnerAlias : 'Percentage split';
      } else {
        voiceShareHint.textContent = 'Defaults if you save now';
      }
    }

    if (voiceMicToggle) {
      const isMuted = !!(activeSession && activeSession.isMuted);
      const isBusy = !!(activeSession && (activeSession.connecting || activeSession.saving));
      voiceMicToggle.classList.toggle('is-muted', isMuted);
      voiceMicToggle.classList.toggle('is-busy', isBusy);
      voiceMicToggle.setAttribute('aria-pressed', isMuted ? 'true' : 'false');
      voiceMicToggle.setAttribute('aria-label', isMuted ? 'Unmute microphone' : 'Mute microphone');
    }

    if (voiceDone) {
      voiceDone.disabled = !(voiceDraft.amount && voiceDraft.amount > 0) || !!(activeSession && activeSession.saving);
    }
  }

  function applyHeuristicVoiceDraft(currentDraft, heuristicDraft, transcriptText, focusTranscriptText) {
    if (voiceUtils.applyIncrementalHeuristicDraft) {
      return voiceUtils.applyIncrementalHeuristicDraft(
        currentDraft,
        heuristicDraft,
        transcriptText,
        todayISO(),
        focusTranscriptText
      );
    }

    const baseDraft = currentDraft || createEmptyVoiceDraft(todayISO());
    const nextDraft = {
      ...baseDraft,
      confidence: {
        amount: baseDraft.confidence ? baseDraft.confidence.amount : 0,
        description: baseDraft.confidence ? baseDraft.confidence.description : 0,
        date: baseDraft.confidence ? baseDraft.confidence.date : 0,
        partnerShare: baseDraft.confidence ? baseDraft.confidence.partnerShare : 0
      }
    };

    if (!transcriptText) {
      return createEmptyVoiceDraft(todayISO());
    }

    if (heuristicDraft.amount !== null && typeof heuristicDraft.amount !== 'undefined') {
      nextDraft.amount = heuristicDraft.amount;
      nextDraft.confidence.amount = heuristicDraft.confidence.amount;
    }

    if (heuristicDraft.description) {
      nextDraft.description = heuristicDraft.description;
      nextDraft.confidence.description = heuristicDraft.confidence.description;
    }

    if (heuristicDraft.dateIso && heuristicDraft.confidence.date >= 0.65) {
      nextDraft.dateIso = heuristicDraft.dateIso;
      nextDraft.confidence.date = heuristicDraft.confidence.date;
    }

    if (
      heuristicDraft.partnerShareMode &&
      heuristicDraft.partnerShareValue !== null &&
      typeof heuristicDraft.partnerShareValue !== 'undefined'
    ) {
      nextDraft.partnerShareMode = heuristicDraft.partnerShareMode;
      nextDraft.partnerShareValue = heuristicDraft.partnerShareValue;
      nextDraft.partnerAlias = heuristicDraft.partnerAlias || nextDraft.partnerAlias || '';
      nextDraft.confidence.partnerShare = heuristicDraft.confidence.partnerShare;
    }

    nextDraft.isComplete = !!(nextDraft.amount && nextDraft.amount > 0);
    nextDraft.source = heuristicDraft.source || nextDraft.source || 'heuristic';
    return nextDraft;
  }

  function resetVoiceDraft() {
    voiceDraft = createEmptyVoiceDraft(todayISO());
    renderVoiceDraft();
  }

  function createVoiceSessionState() {
    return {
      id: uid(),
      peerConnection: null,
      dataChannel: null,
      mediaStream: null,
      mediaTrack: null,
      commitments: [],
      order: [],
      textsById: {},
      transcriptText: '',
      transcriptVersion: 0,
      heuristicDraft: createEmptyVoiceDraft(todayISO()),
      latestTurnText: '',
      isMuted: false,
      ready: false,
      connecting: false,
      closing: false,
      saving: false,
      extractionTimerId: null,
      extractionAbortController: null,
      lastAppliedVersion: 0,
      nextRequestVersion: 0
    };
  }

  function clearVoiceExtractionTimer(session) {
    if (!session || !session.extractionTimerId) return;
    window.clearTimeout(session.extractionTimerId);
    session.extractionTimerId = null;
  }

  function stopVoiceMedia(session) {
    if (!session) return;
    clearVoiceExtractionTimer(session);

    if (session.extractionAbortController) {
      session.extractionAbortController.abort();
      session.extractionAbortController = null;
    }

    if (session.dataChannel) {
      try { session.dataChannel.close(); } catch (error) {}
      session.dataChannel = null;
    }

    if (session.peerConnection) {
      try { session.peerConnection.close(); } catch (error) {}
      session.peerConnection = null;
    }

    if (session.mediaStream) {
      session.mediaStream.getTracks().forEach(function (track) {
        track.stop();
      });
      session.mediaStream = null;
      session.mediaTrack = null;
    }

    session.ready = false;
    session.connecting = false;
  }

  function closeVoiceSheet(options) {
    const closeOptions = options || {};
    if (voiceOverlay) voiceOverlay.classList.remove('open');
    if (voiceSheet) voiceSheet.classList.remove('open');

    if (voiceSession) {
      voiceSession.closing = true;
      stopVoiceMedia(voiceSession);
      voiceSession = null;
    }

    if (!closeOptions.preserveDraft) {
      resetVoiceDraft();
    }
    setVoiceSessionStatus('Listening');
    setVoiceSheetStatus('', '');
  }

  function showVoiceSettingsGate() {
    setVoiceSettingsStatus('Add an OpenAI API key, verify it, and turn on voice mode to unlock the mic button.', 'info');
    openSettingsSheet('voice');
  }

  function openVoiceSheet() {
    if (!voiceSettings.enabled || !voiceSettings.apiKey) {
      showVoiceSettingsGate();
      return;
    }

    closeSheet();
    closeSettingsSheet();
    resetVoiceDraft();
    setVoiceSheetStatus('', '');
    setVoiceSessionStatus('Connecting…');

    if (voiceOverlay) voiceOverlay.classList.add('open');
    if (voiceSheet) voiceSheet.classList.add('open');

    const session = createVoiceSessionState();
    voiceSession = session;
    renderVoiceDraft();

    startVoiceSession(session).catch(function (error) {
      if (voiceSession !== session) return;
      stopVoiceMedia(session);
      setVoiceSessionStatus('Voice unavailable');
      setVoiceSheetStatus(
        error && error.message
          ? error.message
          : 'Voice mode could not connect. You can switch to manual entry instead.',
        'error'
      );
      renderVoiceDraft();
    });
  }

  function waitForIceGatheringComplete(peerConnection) {
    return new Promise(function (resolve) {
      if (!peerConnection || peerConnection.iceGatheringState === 'complete') {
        resolve();
        return;
      }

      let settled = false;
      const handleStateChange = function () {
        if (peerConnection.iceGatheringState === 'complete' && !settled) {
          settled = true;
          peerConnection.removeEventListener('icegatheringstatechange', handleStateChange);
          resolve();
        }
      };

      peerConnection.addEventListener('icegatheringstatechange', handleStateChange);
      window.setTimeout(function () {
        if (settled) return;
        settled = true;
        peerConnection.removeEventListener('icegatheringstatechange', handleStateChange);
        resolve();
      }, 1500);
    });
  }

  async function readOpenAIError(response, fallbackMessage) {
    try {
      const contentType = response.headers.get('content-type') || '';
      if (contentType.indexOf('application/json') >= 0) {
        const payload = await response.json();
        if (payload && payload.error && payload.error.message) {
          return payload.error.message;
        }
      } else {
        const text = await response.text();
        if (text) return text;
      }
    } catch (error) {
      // Ignore parse errors and fall back below.
    }

    return fallbackMessage;
  }

  async function postOpenAIJson(path, apiKey, payload, signal) {
    const response = await fetch('https://api.openai.com/v1' + path, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: signal
    });

    if (!response.ok) {
      throw new Error(await readOpenAIError(response, 'The OpenAI request failed.'));
    }

    return response.json();
  }

  async function createVoiceClientSecret(apiKey, secondsToLive) {
    return postOpenAIJson('/realtime/client_secrets', apiKey, {
      expires_after: {
        anchor: 'created_at',
        seconds: secondsToLive || 600
      },
      session: {
        type: 'transcription',
        audio: {
          input: {
            noise_reduction: { type: 'near_field' },
            transcription: {
              model: VOICE_TRANSCRIPTION_MODEL,
              prompt: VOICE_TRANSCRIPTION_PROMPT
            },
            turn_detection: {
              type: 'server_vad',
              create_response: false,
              interrupt_response: false,
              prefix_padding_ms: 300,
              silence_duration_ms: 450
            }
          }
        }
      }
    });
  }

  async function createRealtimeCall(clientSecret, offerSdp) {
    const response = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + clientSecret,
        'Content-Type': 'application/sdp'
      },
      body: offerSdp
    });

    if (!response.ok) {
      throw new Error(await readOpenAIError(response, 'The OpenAI voice session could not be created.'));
    }

    return response.text();
  }

  function getResponseOutputText(response) {
    if (!response || !Array.isArray(response.output)) return '';

    for (let i = 0; i < response.output.length; i += 1) {
      const outputItem = response.output[i];
      if (!outputItem || !Array.isArray(outputItem.content)) continue;

      for (let j = 0; j < outputItem.content.length; j += 1) {
        const contentItem = outputItem.content[j];
        if (contentItem && typeof contentItem.text === 'string') {
          return contentItem.text;
        }
      }
    }

    return '';
  }

  function buildVoiceExtractionSchema() {
    return {
      type: 'object',
      additionalProperties: false,
      required: [
        'amount',
        'description',
        'date_iso',
        'partner_share_mode',
        'partner_share_value',
        'partner_alias',
        'updated_fields',
        'confidence',
        'is_complete'
      ],
      properties: {
        amount: {
          type: ['number', 'null'],
          description: 'The total expense amount in euros.'
        },
        description: {
          type: 'string',
          description: 'A concise expense description. Use an empty string if unknown.'
        },
        date_iso: {
          type: ['string', 'null'],
          description: 'Expense date in YYYY-MM-DD format.'
        },
        partner_share_mode: {
          type: ['string', 'null'],
          enum: ['percent', 'fixed', null],
          description: 'How the partner share should be interpreted.'
        },
        partner_share_value: {
          type: ['number', 'null'],
          description: 'The percentage or fixed euro amount for the partner share.'
        },
        partner_alias: {
          type: 'string',
          description: 'Partner alias if the speaker used one, otherwise an empty string.'
        },
        updated_fields: {
          type: 'object',
          additionalProperties: false,
          required: ['amount', 'description', 'date', 'partner_share'],
          properties: {
            amount: { type: 'boolean' },
            description: { type: 'boolean' },
            date: { type: 'boolean' },
            partner_share: { type: 'boolean' }
          }
        },
        confidence: {
          type: 'object',
          additionalProperties: false,
          required: ['amount', 'description', 'date', 'partner_share'],
          properties: {
            amount: { type: 'number', minimum: 0, maximum: 1 },
            description: { type: 'number', minimum: 0, maximum: 1 },
            date: { type: 'number', minimum: 0, maximum: 1 },
            partner_share: { type: 'number', minimum: 0, maximum: 1 }
          }
        },
        is_complete: {
          type: 'boolean',
          description: 'True when the current transcript contains enough information to save a sensible draft.'
        }
      }
    };
  }

  async function requestVoiceExtraction(apiKey, extractionPayload, signal) {
    const response = await postOpenAIJson('/responses', apiKey, {
      model: VOICE_EXTRACT_MODEL,
      store: false,
      max_output_tokens: 360,
      reasoning: {
        effort: 'minimal'
      },
      instructions: [
        'You update an existing expense draft from the newest hidden voice transcription turn.',
        'Treat current_draft as the source of truth for previously accepted fields.',
        'Use latest_turn as the strongest signal and recent_turns only as nearby context.',
        'Preserve current_draft values for fields the newest utterance does not change.',
        'Later corrections override earlier mentions, but only when the newest utterance supports that change.',
        'If the speaker names a wife, husband, spouse, or partner, treat that as the partner share.',
        'If a fixed partner amount is stated after a percentage, keep the later fixed amount.',
        'Return the next full draft after applying the newest utterance.',
        'Set updated_fields.<field> to true only if the newest utterance materially sets, corrects, or clears that field.',
        'Use null for unknown numeric fields and an empty string for unknown text.'
      ].join(' '),
      input: [{
        role: 'user',
        content: [{
          type: 'input_text',
          text: JSON.stringify(extractionPayload, null, 2)
        }]
      }],
      text: {
        format: {
          type: 'json_schema',
          name: 'expense_voice_draft',
          strict: true,
          schema: buildVoiceExtractionSchema()
        }
      }
    }, signal);

    const outputText = getResponseOutputText(response);
    if (!outputText) {
      throw new Error('The extraction model returned an empty response.');
    }

    return JSON.parse(outputText);
  }

  async function verifyVoiceKeyWithResponses(apiKey) {
    const response = await postOpenAIJson('/responses', apiKey, {
      model: VOICE_EXTRACT_MODEL,
      store: false,
      max_output_tokens: 40,
      reasoning: {
        effort: 'minimal'
      },
      instructions: 'Return JSON that confirms the API key can reach the Responses API.',
      input: 'Verification request for Mäuse voice mode.',
      text: {
        format: {
          type: 'json_schema',
          name: 'voice_mode_verification',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['ok'],
            properties: {
              ok: {
                type: 'boolean'
              }
            }
          }
        }
      }
    });

    const outputText = getResponseOutputText(response);
    if (!outputText) {
      throw new Error('The verification request returned an empty response.');
    }

    const parsed = JSON.parse(outputText);
    if (!parsed || parsed.ok !== true) {
      throw new Error('The verification response was not valid.');
    }
  }

  async function verifyVoiceKey() {
    const apiKey = normalizeVoiceKey(voiceApiKeyInput ? voiceApiKeyInput.value : voiceSettings.apiKey);

    if (!apiKey) {
      setVoiceSettingsStatus('Enter an OpenAI API key first.', 'error');
      return;
    }

    setSettingsBusy(true);
    setVoiceSettingsStatus('Verifying Realtime and Responses access…', 'info');

    try {
      await createVoiceClientSecret(apiKey, 90);
      await verifyVoiceKeyWithResponses(apiKey);
      voiceSettings = {
        apiKey: apiKey,
        verifiedAt: Date.now(),
        enabled: voiceSettings.enabled
      };
      saveVoiceSettings();
      renderVoiceSettings();
      setVoiceSettingsStatus('Key verified. You can enable voice mode now.', 'success');
    } catch (error) {
      voiceSettings = {
        apiKey: apiKey,
        verifiedAt: 0,
        enabled: false
      };
      saveVoiceSettings();
      renderVoiceSettings();
      setVoiceSettingsStatus(
        error && error.message ? error.message : 'The key could not be verified for voice mode.',
        'error'
      );
    } finally {
      setSettingsBusy(false);
    }
  }

  async function startVoiceSession(session) {
    if (!session) return;
    if (!navigator.onLine) {
      throw new Error('Voice mode needs an internet connection.');
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser does not support microphone capture.');
    }
    if (!window.RTCPeerConnection) {
      throw new Error('This browser does not support WebRTC voice sessions.');
    }

    session.connecting = true;
    renderVoiceDraft();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    if (voiceSession !== session) {
      stream.getTracks().forEach(function (track) { track.stop(); });
      return;
    }

    session.mediaStream = stream;
    session.mediaTrack = stream.getAudioTracks()[0] || null;

    const peerConnection = new RTCPeerConnection();
    session.peerConnection = peerConnection;

    stream.getTracks().forEach(function (track) {
      peerConnection.addTrack(track, stream);
    });

    const dataChannel = peerConnection.createDataChannel('oai-events');
    session.dataChannel = dataChannel;

    dataChannel.addEventListener('open', function () {
      if (voiceSession !== session) return;
      session.ready = true;
      session.connecting = false;
      setVoiceSessionStatus(session.isMuted ? 'Muted' : 'Listening');
      setVoiceSheetStatus('', '');
      renderVoiceDraft();
    });

    dataChannel.addEventListener('close', function () {
      if (voiceSession !== session || session.closing) return;
      session.ready = false;
      setVoiceSessionStatus('Voice paused');
      setVoiceSheetStatus('The voice session disconnected. You can retry or switch to manual entry.', 'error');
      renderVoiceDraft();
    });

    dataChannel.addEventListener('message', function (event) {
      if (voiceSession !== session) return;
      handleVoiceServerEvent(session, event.data);
    });

    peerConnection.addEventListener('connectionstatechange', function () {
      if (voiceSession !== session || session.closing) return;
      if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'disconnected') {
        session.ready = false;
        setVoiceSessionStatus('Voice paused');
        setVoiceSheetStatus('The voice connection dropped. You can retry or switch to manual entry.', 'error');
        renderVoiceDraft();
      }
    });

    const clientSecret = await createVoiceClientSecret(voiceSettings.apiKey, 600);
    if (voiceSession !== session) return;

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await waitForIceGatheringComplete(peerConnection);
    const localDescription = peerConnection.localDescription;
    const answer = await createRealtimeCall(clientSecret.value, localDescription ? localDescription.sdp : offer.sdp);

    if (voiceSession !== session) return;

    await peerConnection.setRemoteDescription({
      type: 'answer',
      sdp: answer
    });

    setVoiceSessionStatus('Listening');
    renderVoiceDraft();
  }

  function rebuildVoiceTranscript(session) {
    session.order = resolveCommittedTurnOrder(session.commitments);
    const nextTranscriptText = composeTranscriptText(session.order, session.textsById);
    session.latestTurnText = getLatestVoiceTurnText(session);

    if (nextTranscriptText !== session.transcriptText) {
      session.transcriptVersion += 1;
      session.transcriptText = nextTranscriptText;
    }

    session.heuristicDraft = parseTranscriptDraft(session.transcriptText);
    voiceDraft = applyHeuristicVoiceDraft(
      voiceDraft,
      session.heuristicDraft,
      session.transcriptText,
      session.latestTurnText
    );
    renderVoiceDraft();
  }

  function ensureCommittedTurn(session, itemId) {
    if (!itemId) return;
    const alreadyPresent = session.commitments.some(function (commit) {
      return commit.itemId === itemId;
    });
    if (!alreadyPresent) {
      session.commitments.push({ itemId: itemId, previousItemId: null });
    }
  }

  function queueVoiceExtraction(session, immediate) {
    if (!session || !session.transcriptText) return;
    clearVoiceExtractionTimer(session);

    const delay = immediate ? 0 : VOICE_EXTRACT_DEBOUNCE_MS;
    session.extractionTimerId = window.setTimeout(function () {
      runVoiceExtraction(session);
    }, delay);
  }

  async function runVoiceExtraction(session) {
    if (!session || !session.transcriptText || !voiceSettings.apiKey) return null;

    session.nextRequestVersion += 1;
    const requestVersion = session.nextRequestVersion;
    const transcriptVersion = session.transcriptVersion;
    const latestTurnText = session.latestTurnText;
    const fallbackDraft = session.heuristicDraft || parseTranscriptDraft(session.transcriptText);
    const stabilizedDraft = applyHeuristicVoiceDraft(
      voiceDraft,
      fallbackDraft,
      session.transcriptText,
      latestTurnText
    );
    const extractionPayload = buildVoiceExtractionPayload(session, stabilizedDraft);

    if (session.extractionAbortController) {
      session.extractionAbortController.abort();
    }
    session.extractionAbortController = new AbortController();

    try {
      const extracted = await requestVoiceExtraction(
        voiceSettings.apiKey,
        extractionPayload,
        session.extractionAbortController.signal
      );

      if (
        voiceSession !== session ||
        session.transcriptVersion !== transcriptVersion ||
        requestVersion !== session.nextRequestVersion ||
        !shouldApplyVoiceVersion(session.lastAppliedVersion, requestVersion)
      ) {
        return null;
      }

      const normalized = normalizeVoiceExtraction(extracted);
      voiceDraft = mergeVoiceDrafts(stabilizedDraft, normalized);
      session.lastAppliedVersion = requestVersion;
      setVoiceSheetStatus('', '');
      renderVoiceDraft();
      return voiceDraft;
    } catch (error) {
      if (error && error.name === 'AbortError') {
        return null;
      }

      if (voiceSession === session) {
        setVoiceSheetStatus(
          'The AI extraction step hit an error, but the preview cards will keep using the live fallback parser.',
          'error'
        );
      }
      return null;
    }
  }

  function handleVoiceServerEvent(session, rawEvent) {
    let payload;

    try {
      payload = JSON.parse(rawEvent);
    } catch (error) {
      return;
    }

    if (!payload || typeof payload.type !== 'string') return;

    switch (payload.type) {
      case 'input_audio_buffer.speech_started':
        if (!session.isMuted) {
          setVoiceSessionStatus('Listening');
        }
        break;

      case 'input_audio_buffer.speech_stopped':
        if (!session.isMuted) {
          setVoiceSessionStatus('Processing…');
        }
        break;

      case 'input_audio_buffer.committed':
        if (payload.item_id) {
          const commitIndex = session.commitments.findIndex(function (commit) {
            return commit.itemId === payload.item_id;
          });
          const nextCommit = {
            itemId: payload.item_id,
            previousItemId: payload.previous_item_id || null
          };

          if (commitIndex >= 0) {
            session.commitments[commitIndex] = nextCommit;
          } else {
            session.commitments.push(nextCommit);
          }
          rebuildVoiceTranscript(session);
        }
        break;

      case 'conversation.item.input_audio_transcription.delta':
        if (!payload.item_id) break;
        ensureCommittedTurn(session, payload.item_id);
        session.textsById[payload.item_id] = (session.textsById[payload.item_id] || '') + (payload.delta || '');
        rebuildVoiceTranscript(session);
        queueVoiceExtraction(session, false);
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (!payload.item_id) break;
        ensureCommittedTurn(session, payload.item_id);
        session.textsById[payload.item_id] = payload.transcript || payload.text || session.textsById[payload.item_id] || '';
        rebuildVoiceTranscript(session);
        queueVoiceExtraction(session, true);
        if (!session.isMuted) {
          setVoiceSessionStatus('Listening');
        }
        break;

      case 'conversation.item.input_audio_transcription.failed':
        setVoiceSheetStatus('OpenAI could not transcribe part of that audio. Keep speaking or switch to manual entry.', 'error');
        break;

      case 'error':
        setVoiceSheetStatus(
          payload.error && payload.error.message
            ? payload.error.message
            : 'The OpenAI voice session returned an error.',
          'error'
        );
        break;

      default:
        break;
    }
  }

  function toggleVoiceMute() {
    if (!voiceSession) return;

    if (!voiceSession.ready && !voiceSession.connecting) {
      const session = voiceSession;
      stopVoiceMedia(session);
      setVoiceSheetStatus('', '');
      setVoiceSessionStatus('Connecting…');
      startVoiceSession(session).catch(function (error) {
        if (voiceSession === session) {
          setVoiceSessionStatus('Voice unavailable');
          setVoiceSheetStatus(
            error && error.message ? error.message : 'Voice mode could not reconnect.',
            'error'
          );
        }
      });
      return;
    }

    voiceSession.isMuted = !voiceSession.isMuted;
    if (voiceSession.mediaTrack) {
      voiceSession.mediaTrack.enabled = !voiceSession.isMuted;
    }
    setVoiceSessionStatus(voiceSession.isMuted ? 'Muted' : 'Listening');
    renderVoiceDraft();
  }

  async function handleVoiceDone() {
    if (!voiceDraft.amount || voiceDraft.amount <= 0 || !voiceSession) {
      setVoiceSheetStatus('Say the total amount first, or switch to manual entry.', 'error');
      renderVoiceDraft();
      return;
    }

    const previousMuteState = voiceSession.isMuted;
    voiceSession.saving = true;
    if (voiceSession.mediaTrack) {
      voiceSession.isMuted = true;
      voiceSession.mediaTrack.enabled = false;
    }
    setVoiceSessionStatus('Saving…');
    renderVoiceDraft();

    try {
      await runVoiceExtraction(voiceSession);
      const saved = await persistExpenseFromDraft(draftFromVoiceDraft(voiceDraft), { closeSheetOnSave: false });
      if (!saved) {
        setVoiceSheetStatus('A valid amount is required before saving.', 'error');
        return;
      }
      closeVoiceSheet();
    } finally {
      if (voiceSession) {
        voiceSession.saving = false;
        voiceSession.isMuted = previousMuteState;
        if (voiceSession.mediaTrack) {
          voiceSession.mediaTrack.enabled = !previousMuteState;
        }
        setVoiceSessionStatus(previousMuteState ? 'Muted' : 'Listening');
      }
      renderVoiceDraft();
    }
  }

  function switchVoiceToManual() {
    const draft = draftFromVoiceDraft(voiceDraft);
    closeVoiceSheet({ preserveDraft: false });
    openSheetWithDraft(draft);
  }

  function setOnboardingMode(mode) {
    onboardingStartBtn.textContent = mode === 'revisit' ? 'Back to App' : 'Get Started';
  }

  function readOnboardingPreference() {
    try {
      const value = window.localStorage.getItem('maeuse:onboarding-hidden');
      if (value === 'true') return true;
      if (value === 'false') return false;
    } catch (error) {
      // Ignore storage failures and fall back to the in-memory preference.
    }
    return onboardingPreferenceFallback;
  }

  function writeOnboardingPreference(shouldHideOnLaunch) {
    onboardingPreferenceFallback = shouldHideOnLaunch;
    try {
      window.localStorage.setItem('maeuse:onboarding-hidden', shouldHideOnLaunch ? 'true' : 'false');
      return true;
    } catch (error) {
      return false;
    }
  }

  function showOnboarding() {
    window.clearTimeout(onboardingHideTimer);
    document.documentElement.classList.remove('onboarding-pref-hidden');
    onboardingEl.style.display = '';
    window.requestAnimationFrame(function () {
      onboardingEl.classList.remove('hidden');
    });
  }

  function hideOnboarding(immediate) {
    window.clearTimeout(onboardingHideTimer);
    onboardingEl.classList.add('hidden');

    if (immediate) {
      onboardingEl.style.display = 'none';
      return;
    }

    onboardingHideTimer = window.setTimeout(function () {
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

  function updateMonthLabel() {
    monthLabel.textContent = monthNames[currentMonth] + ' ' + currentYear;
  }

  function getMonthExpenses() {
    return expenses
      .filter(function (expense) {
        const date = new Date(expense.date + 'T00:00:00');
        return date.getFullYear() === currentYear && date.getMonth() === currentMonth;
      })
      .sort(function (a, b) {
        return b.date.localeCompare(a.date) || b.id.localeCompare(a.id);
      });
  }

  function renderList() {
    const items = getMonthExpenses();
    let totalSum = 0;
    let partnerSum = 0;

    items.forEach(function (expense) {
      totalSum += expense.amount;
      partnerSum += calcPartnerShare(expense);
    });

    totalAmountEl.textContent = formatEuro(totalSum);
    partnerAmountEl.textContent = formatEuro(partnerSum);

    if (!items.length) {
      expenseListEl.innerHTML = [
        '<div class="empty-state animate-in">',
        '  <div class="empty-state-icon">',
        '    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">',
        '      <rect x="2" y="5" width="20" height="14" rx="2"/>',
        '      <path d="M2 10h20"/>',
        '    </svg>',
        '  </div>',
        '  <div class="empty-state-title">No expenses yet</div>',
        '  <div class="empty-state-text">' + (voiceSettings.enabled ? 'Tap + or the mic to log a shared expense' : 'Tap + to log a shared expense') + '</div>',
        '</div>'
      ].join('\n');
      return;
    }

    const groups = {};
    items.forEach(function (expense) {
      const label = formatDate(expense.date);
      if (!groups[label]) groups[label] = [];
      groups[label].push(expense);
    });

    let html = '';
    let animationIndex = 0;

    Object.entries(groups).forEach(function (entry) {
      const dateLabel = entry[0];
      const group = entry[1];
      html += '<div class="list-header">' + dateLabel + '</div>';

      group.forEach(function (expense) {
        const share = calcPartnerShare(expense);
        const splitLabel = expense.splitMode === 'percent'
          ? expense.splitValue + '%'
          : 'fixed amount';

        html += [
          '<div class="expense-item animate-in" style="animation-delay:' + (animationIndex * 40) + 'ms" data-id="' + expense.id + '">',
          '  <div class="expense-icon">',
          '    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">',
          '      <line x1="12" y1="1" x2="12" y2="23"/>',
          '      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
          '    </svg>',
          '  </div>',
          '  <div class="expense-details">',
          '    <div class="expense-desc">' + escapeHtml(expense.description || 'Expense') + '</div>',
          '    <div class="expense-meta">' + splitLabel + '</div>',
          '  </div>',
          '  <div class="expense-amounts">',
          '    <div class="expense-total">' + formatEuro(expense.amount) + '</div>',
          '    <div class="expense-split">' + formatEuro(share) + '</div>',
          '  </div>',
          '</div>'
        ].join('\n');

        animationIndex += 1;
      });
    });

    expenseListEl.innerHTML = html;

    expenseListEl.querySelectorAll('.expense-item').forEach(function (element) {
      element.addEventListener('click', function () {
        const expense = expenses.find(function (item) {
          return item.id === element.dataset.id;
        });
        if (expense) {
          openSheet(expense);
        }
      });
    });
  }

  function updateSplitResult() {
    const amount = parseAmount(inputAmount.value);
    const splitValue = parseAmount(inputSplit.value);
    const result = splitMode === 'fixed'
      ? Math.min(splitValue, amount)
      : amount * (splitValue / 100);
    splitResult.textContent = '= ' + formatEuro(roundMoney(result));
  }

  function updatePresetChips() {
    const currentValue = parseAmount(inputSplit.value);
    presetChips.querySelectorAll('.preset-chip').forEach(function (chip) {
      chip.classList.toggle('active', parseFloat(chip.dataset.value) === currentValue);
    });
  }

  function applyDraftToSheet(draft) {
    const normalized = normalizeExpenseDraftForSheet(draft);

    inputAmount.value = normalized.amount ? normalized.amount.toFixed(2) : '';
    inputDesc.value = normalized.description;
    inputDate.value = normalized.date;
    splitMode = normalized.splitMode;
    inputSplit.value = String(normalized.splitValue);

    splitToggle.querySelectorAll('.split-toggle-btn').forEach(function (button) {
      button.classList.toggle('active', button.dataset.mode === splitMode);
    });

    splitSuffix.textContent = splitMode === 'percent' ? '%' : '€';
    presetChips.style.display = splitMode === 'percent' ? 'flex' : 'none';
    updatePresetChips();
    updateSplitResult();
  }

  function showManualSheet() {
    sheetOverlay.classList.add('open');
    sheet.classList.add('open');
    window.setTimeout(function () {
      inputAmount.focus();
      inputAmount.select();
    }, 350);
  }

  function openSheet(expense) {
    editingId = expense ? expense.id : null;
    sheetTitle.textContent = expense ? 'Edit Expense' : 'New Expense';
    deleteRow.style.display = expense ? 'block' : 'none';
    applyDraftToSheet(expense ? draftFromExpense(expense) : buildDefaultExpenseDraft());
    showManualSheet();
  }

  function openSheetWithDraft(draft) {
    editingId = null;
    sheetTitle.textContent = 'New Expense';
    deleteRow.style.display = 'none';
    applyDraftToSheet(draft || buildDefaultExpenseDraft());
    showManualSheet();
  }

  function closeSheet() {
    sheetOverlay.classList.remove('open');
    sheet.classList.remove('open');
    editingId = null;
    inputAmount.blur();
    inputDesc.blur();
  }

  async function persistExpenseFromDraft(rawDraft, options) {
    const persistOptions = options || {};
    const draft = normalizeExpenseDraftForSave(rawDraft);

    if (!draft.amount || draft.amount <= 0) {
      return false;
    }

    const expenseId = persistOptions.id || editingId || uid();
    const expense = {
      id: expenseId,
      amount: draft.amount,
      description: draft.description,
      date: draft.date,
      splitMode: draft.splitMode,
      splitValue: draft.splitValue,
      updatedAt: Date.now()
    };

    await dbPut(expense);

    const existingIndex = expenses.findIndex(function (item) {
      return item.id === expenseId;
    });
    if (existingIndex >= 0) {
      expenses[existingIndex] = expense;
    } else {
      expenses.push(expense);
    }

    const monthDate = new Date(expense.date + 'T00:00:00');
    currentYear = monthDate.getFullYear();
    currentMonth = monthDate.getMonth();
    updateMonthLabel();
    renderList();

    if (persistOptions.closeSheetOnSave !== false) {
      closeSheet();
    }

    if (expenses.length > 0) {
      writeOnboardingPreference(true);
      onboardingSkipCheckbox.checked = true;
      hideOnboarding(true);
    }

    return expense;
  }

  async function saveExpense() {
    const saved = await persistExpenseFromDraft(collectManualDraft());
    if (!saved) {
      inputAmount.focus();
    }
  }

  function deleteExpense() {
    if (!editingId) return;
    dbDelete(editingId).then(function () {
      expenses = expenses.filter(function (expense) { return expense.id !== editingId; });
      renderList();
      closeSheet();
    });
  }

  function getBackupFileName() {
    return 'maeuse-backup-' + todayISO() + '.json';
  }

  function createBackupPayload() {
    const sortedExpenses = expenses
      .slice()
      .sort(function (a, b) {
        return a.date.localeCompare(b.date)
          || (a.updatedAt || 0) - (b.updatedAt || 0)
          || a.id.localeCompare(b.id);
      })
      .map(function (expense) {
        return { ...expense };
      });

    return {
      app: 'Mäuse',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      expenses: sortedExpenses
    };
  }

  function exportBackup() {
    try {
      setSettingsBusy(true);
      const blob = new Blob([JSON.stringify(createBackupPayload(), null, 2)], {
        type: 'application/json'
      });
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = getBackupFileName();
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(function () {
        URL.revokeObjectURL(downloadUrl);
      }, 1000);
      setSettingsStatus('Backup created. Save or share the JSON file if your device asks.', 'success');
    } catch (error) {
      setSettingsStatus('Backup could not be created on this device.', 'error');
    } finally {
      setSettingsBusy(false);
    }
  }

  function sanitizeImportedExpense(rawExpense, index) {
    if (!rawExpense || typeof rawExpense !== 'object') return null;

    const amount = Number(rawExpense.amount);
    const splitValue = Number(rawExpense.splitValue);
    const date = typeof rawExpense.date === 'string' ? rawExpense.date : '';
    const candidateSplitMode = rawExpense.splitMode === 'fixed'
      ? 'fixed'
      : rawExpense.splitMode === 'percent'
        ? 'percent'
        : null;

    if (!Number.isFinite(amount) || amount <= 0) return null;
    if (!Number.isFinite(splitValue) || !candidateSplitMode || !isValidDateString(date)) return null;

    const updatedAt = Number(rawExpense.updatedAt);
    return {
      id: typeof rawExpense.id === 'string' && rawExpense.id.trim()
        ? rawExpense.id.trim()
        : uid() + '-' + index,
      amount: roundMoney(amount),
      description: typeof rawExpense.description === 'string' ? rawExpense.description.trim() : '',
      date: date,
      splitMode: candidateSplitMode,
      splitValue: candidateSplitMode === 'fixed'
        ? Math.max(roundMoney(splitValue), 0)
        : Math.min(Math.max(roundMoney(splitValue), 0), 100),
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now()
    };
  }

  function extractImportExpenses(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && typeof payload === 'object' && Array.isArray(payload.expenses)) {
      return payload.expenses;
    }
    return null;
  }

  function focusLatestExpenseMonth(nextExpenses) {
    if (!nextExpenses.length) {
      const now = new Date();
      currentYear = now.getFullYear();
      currentMonth = now.getMonth();
      return;
    }

    const latestExpense = nextExpenses
      .slice()
      .sort(function (a, b) {
        return b.date.localeCompare(a.date)
          || (b.updatedAt || 0) - (a.updatedAt || 0)
          || b.id.localeCompare(a.id);
      })[0];

    const latestDate = new Date(latestExpense.date + 'T00:00:00');
    currentYear = latestDate.getFullYear();
    currentMonth = latestDate.getMonth();
  }

  async function importBackupFile(file) {
    if (!file) return;

    try {
      setSettingsBusy(true);
      setSettingsStatus('Checking backup…', 'info');

      const parsed = JSON.parse(await file.text());
      const rawExpenses = extractImportExpenses(parsed);

      if (!rawExpenses) {
        throw new Error('This file is not a supported Mäuse backup.');
      }

      const importedExpenses = rawExpenses
        .map(function (expense, index) {
          return sanitizeImportedExpense(expense, index);
        })
        .filter(Boolean);

      if (rawExpenses.length > 0 && !importedExpenses.length) {
        throw new Error('No valid expenses were found in this backup.');
      }

      const dedupedExpenses = Array.from(
        new Map(importedExpenses.map(function (expense) {
          return [expense.id, expense];
        })).values()
      );

      const confirmMessage = dedupedExpenses.length === 0
        ? 'Import this empty backup? This will remove all expenses on this device.'
        : 'Import ' + dedupedExpenses.length + ' expense' + (dedupedExpenses.length === 1 ? '' : 's') + '? This replaces the data currently stored on this device.';

      if (!window.confirm(confirmMessage)) {
        setSettingsStatus('Import cancelled.', 'info');
        return;
      }

      await dbReplaceAll(dedupedExpenses);
      expenses = dedupedExpenses;
      focusLatestExpenseMonth(expenses);
      updateMonthLabel();
      renderList();

      if (expenses.length > 0) {
        writeOnboardingPreference(true);
        onboardingSkipCheckbox.checked = true;
        hideOnboarding(true);
      }

      setSettingsStatus(
        expenses.length === 0
          ? 'Backup imported. This device now has no saved expenses.'
          : 'Imported ' + expenses.length + ' expense' + (expenses.length === 1 ? '' : 's') + '.',
        'success'
      );
    } catch (error) {
      setSettingsStatus(
        error && error.message
          ? error.message
          : 'Import failed. Please use a Mäuse backup JSON file.',
        'error'
      );
    } finally {
      setSettingsBusy(false);
      if (importFileInput) importFileInput.value = '';
    }
  }

  function showUpdateNotice(registration) {
    swRegistration = registration;
    if (!updateNotice || !updateReloadBtn) return;
    updateReloadBtn.disabled = false;
    updateReloadBtn.textContent = 'Reload';
    updateNotice.classList.add('visible');
  }

  function hideUpdateNotice() {
    if (!updateNotice || !updateReloadBtn) return;
    updateNotice.classList.remove('visible');
    updateReloadBtn.disabled = false;
    updateReloadBtn.textContent = 'Reload';
  }

  function triggerServiceWorkerUpdate() {
    if (!swRegistration) return;
    swRegistration.update().catch(function () {});
  }

  function bindServiceWorkerUpdates(registration) {
    swRegistration = registration;

    if (registration.waiting && navigator.serviceWorker.controller) {
      showUpdateNotice(registration);
    }

    registration.addEventListener('updatefound', function () {
      const installingWorker = registration.installing;
      if (!installingWorker) return;

      installingWorker.addEventListener('statechange', function () {
        if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdateNotice(registration);
        }
      });
    });

    if (!swUpdateIntervalId) {
      swUpdateIntervalId = window.setInterval(triggerServiceWorkerUpdate, 60 * 60 * 1000);
    }
  }

  function showMemoryWarning() {
    if (memoryWarning) {
      memoryWarning.classList.add('visible');
    }
  }

  // ==================== THEME ====================
  (function initTheme() {
    const toggle = $('[data-theme-toggle]');
    const root = document.documentElement;
    let theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    root.setAttribute('data-theme', theme);
    updateThemeIcon(theme);

    toggle.addEventListener('click', function () {
      theme = theme === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', theme);
      updateThemeIcon(theme);
    });

    function updateThemeIcon(currentTheme) {
      toggle.innerHTML = currentTheme === 'dark'
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    }
  })();

  // ==================== EVENT LISTENERS ====================
  onboardingStartBtn.addEventListener('click', function () {
    writeOnboardingPreference(onboardingSkipCheckbox.checked);
    hideOnboarding();
  });

  aboutBtn.addEventListener('click', function () {
    openOnboarding('revisit');
  });

  $('#prevMonth').addEventListener('click', function () {
    currentMonth -= 1;
    if (currentMonth < 0) {
      currentMonth = 11;
      currentYear -= 1;
    }
    updateMonthLabel();
    renderList();
  });

  $('#nextMonth').addEventListener('click', function () {
    currentMonth += 1;
    if (currentMonth > 11) {
      currentMonth = 0;
      currentYear += 1;
    }
    updateMonthLabel();
    renderList();
  });

  addBtn.addEventListener('click', function () {
    openSheet(null);
  });

  if (voiceBtn) {
    voiceBtn.addEventListener('click', function () {
      openVoiceSheet();
    });
  }

  sheetOverlay.addEventListener('click', closeSheet);
  sheetCancel.addEventListener('click', closeSheet);
  sheetSave.addEventListener('click', function () {
    saveExpense().catch(function () {});
  });
  deleteBtn.addEventListener('click', deleteExpense);

  if (voiceOverlay) {
    voiceOverlay.addEventListener('click', function () {
      closeVoiceSheet();
    });
  }
  if (voiceCancel) {
    voiceCancel.addEventListener('click', function () {
      closeVoiceSheet();
    });
  }
  if (voiceMicToggle) {
    voiceMicToggle.addEventListener('click', function () {
      toggleVoiceMute();
    });
  }
  if (voiceDone) {
    voiceDone.addEventListener('click', function () {
      handleVoiceDone().catch(function (error) {
        setVoiceSheetStatus(
          error && error.message ? error.message : 'The voice draft could not be saved.',
          'error'
        );
      });
    });
  }
  if (voiceSwitchManual) {
    voiceSwitchManual.addEventListener('click', function () {
      switchVoiceToManual();
    });
  }

  if (settingsBtn) settingsBtn.addEventListener('click', function () { openSettingsSheet(); });
  if (settingsOverlay) settingsOverlay.addEventListener('click', closeSettingsSheet);
  if (settingsDone) settingsDone.addEventListener('click', closeSettingsSheet);
  if (exportDataBtn) exportDataBtn.addEventListener('click', exportBackup);
  if (importDataBtn) {
    importDataBtn.addEventListener('click', function () {
      setSettingsStatus('', '');
      if (!importFileInput) return;
      importFileInput.value = '';
      importFileInput.click();
    });
  }
  if (importFileInput) {
    importFileInput.addEventListener('change', function () {
      const file = importFileInput.files && importFileInput.files[0];
      importBackupFile(file);
    });
  }

  if (voiceApiKeyInput) {
    voiceApiKeyInput.addEventListener('input', function () {
      const nextKey = normalizeVoiceKey(voiceApiKeyInput.value);
      const keyChanged = nextKey !== voiceSettings.apiKey;
      voiceSettings.apiKey = nextKey;
      if (keyChanged) {
        voiceSettings.verifiedAt = 0;
        voiceSettings.enabled = false;
        saveVoiceSettings();
        renderVoiceSettings();
        renderList();
        if (nextKey) {
          setVoiceSettingsStatus('Verify this key before enabling voice mode.', 'info');
        } else {
          setVoiceSettingsStatus('', '');
        }
      }
    });
  }

  if (voiceVerifyBtn) {
    voiceVerifyBtn.addEventListener('click', function () {
      verifyVoiceKey().catch(function (error) {
        setVoiceSettingsStatus(
          error && error.message ? error.message : 'The key could not be verified.',
          'error'
        );
      });
    });
  }

  if (voiceEnabledToggle) {
    voiceEnabledToggle.addEventListener('change', function () {
      if (!voiceSettings.apiKey || !voiceSettings.verifiedAt) {
        voiceEnabledToggle.checked = false;
        setVoiceSettingsStatus('Verify an API key before enabling voice mode.', 'error');
        return;
      }

      voiceSettings.enabled = voiceEnabledToggle.checked;
      saveVoiceSettings();
      renderVoiceSettings();
      renderList();

      setVoiceSettingsStatus(
        voiceSettings.enabled
          ? 'Voice mode enabled. The mic button is now live.'
          : 'Voice mode disabled. Manual entry stays available.',
        voiceSettings.enabled ? 'success' : 'info'
      );
    });
  }

  todayBtn.addEventListener('click', function () {
    inputDate.value = todayISO();
  });

  splitToggle.addEventListener('click', function (event) {
    const button = event.target.closest('.split-toggle-btn');
    if (!button) return;

    splitMode = button.dataset.mode;
    splitToggle.querySelectorAll('.split-toggle-btn').forEach(function (toggleButton) {
      toggleButton.classList.toggle('active', toggleButton === button);
    });

    splitSuffix.textContent = splitMode === 'percent' ? '%' : '€';
    presetChips.style.display = splitMode === 'percent' ? 'flex' : 'none';

    if (splitMode === 'percent') {
      inputSplit.value = '50';
    } else {
      const amount = parseAmount(inputAmount.value);
      inputSplit.value = amount ? (amount / 2).toFixed(2) : '0.00';
    }

    updatePresetChips();
    updateSplitResult();
  });

  presetChips.addEventListener('click', function (event) {
    const chip = event.target.closest('.preset-chip');
    if (!chip) return;
    inputSplit.value = chip.dataset.value;
    updatePresetChips();
    updateSplitResult();
  });

  inputAmount.addEventListener('input', updateSplitResult);
  inputSplit.addEventListener('input', function () {
    updatePresetChips();
    updateSplitResult();
  });

  inputAmount.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      inputDesc.focus();
    }
  });

  inputDesc.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveExpense().catch(function () {});
    }
  });

  if (updateReloadBtn) {
    updateReloadBtn.addEventListener('click', function () {
      if (!swRegistration) {
        window.location.reload();
        return;
      }

      const waitingWorker = swRegistration.waiting;
      updateReloadBtn.disabled = true;
      updateReloadBtn.textContent = 'Reloading...';

      if (waitingWorker) {
        waitingWorker.postMessage({ type: 'SKIP_WAITING' });
        return;
      }

      triggerServiceWorkerUpdate();
      window.setTimeout(function () {
        if (updateReloadBtn.disabled) {
          window.location.reload();
        }
      }, 1000);
    });
  }

  // ==================== SERVICE WORKER ====================
  try {
    if ('serviceWorker' in navigator && navigator.serviceWorker) {
      const hadController = !!navigator.serviceWorker.controller;

      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (!hadController || swRefreshPending) return;
        swRefreshPending = true;
        hideUpdateNotice();
        window.location.reload();
      });

      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') {
          triggerServiceWorkerUpdate();
        }
      });

      window.addEventListener('online', triggerServiceWorkerUpdate);

      navigator.serviceWorker.register('./sw.js').then(function (registration) {
        bindServiceWorkerUpdates(registration);
        triggerServiceWorkerUpdate();
      }).catch(function () {});
    }
  } catch (error) {
    // Ignore service worker failures in restricted contexts.
  }

  // ==================== INIT ====================
  async function init() {
    await openDB();
    if (useMemoryFallback) {
      showMemoryWarning();
    }
    expenses = await dbGetAll();
    renderVoiceSettings();
    updateMonthLabel();
    renderList();
    checkOnboarding();
  }

  init();
})();
