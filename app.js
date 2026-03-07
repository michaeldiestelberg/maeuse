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
  const VOICE_DEBUG_STORAGE_KEY = 'maeuse:voice-debug';
  const VOICE_DEBUG_MAX_ENTRIES = 250;
  const VOICE_CLEANUP_MODEL = 'gpt-5.4';
  const VOICE_CLEANUP_REASONING_EFFORT = 'low';
  const VOICE_EXTRACT_MODEL = 'gpt-5.4';
  const VOICE_EXTRACT_REASONING_EFFORT = 'none';
  const VOICE_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe';
  const VOICE_MAX_RECORDING_MS = 45000;
  const VOICE_TRANSCRIPT_COLLAPSE_THRESHOLD = 120;
  const VOICE_RECORDING_MIME_TYPES = [
    'audio/webm;codecs=opus',
    'audio/mp4',
    'audio/webm'
  ];
  const APP_ASSET_SIGNATURES_KEY = 'maeuse:asset-signatures:v1';
  const APP_UPDATE_ASSETS = [
    './index.html',
    './style.css',
    './app.js',
    './voice-utils.js',
    './manifest.json'
  ];
  const VOICE_TRANSCRIPTION_PROMPT = [
    'Expense dictation for a couples expense tracker.',
    'The speaker may mix English and German.',
    'Transcribe faithfully.',
    'Preserve self-corrections, restarts, merchant names, euro amounts, cents, dates, percentages, and partner references.',
    'Use normal punctuation.',
    'Do not clean up meaning or resolve corrections.'
  ].join(' ');
  const VOICE_CLEANUP_PROMPT = [
    'You convert one raw expense-dictation transcript into one cleaned transcript for user review and downstream extraction.',
    'Output contract: return only the schema output. cleaned_transcript must be one concise natural utterance, or an empty string if the transcript is unusable.',
    'Rules: preserve the final intended meaning exactly.',
    'Remove filler words, hesitation noises, obvious false starts, and duplicated fragments that do not change meaning.',
    'If the speaker corrects themselves, keep only the final intended value.',
    'Preserve merchant names, euro amounts, cents, dates, split percentages, fixed split amounts, and partner references.',
    'Do not invent facts, summarize, explain, or add metadata.',
    'If the final intent is still ambiguous, keep the ambiguity in wording rather than inventing a value.',
    'Done when the output is a single clean utterance suitable for user review and downstream extraction, all final actionable facts are preserved, and superseded false starts and corrections are removed.',
    'Before finalizing, verify that every final merchant, amount, date, split, and partner fact still appears in the cleaned meaning.',
    'If the raw transcript is unusable, return an empty cleaned_transcript.'
  ].join(' ');
  const VOICE_EXTRACT_PROMPT = [
    'You extract one expense draft from one cleaned expense transcript.',
    'The cleaned_transcript is the only semantic source of truth. Any earlier false starts or corrections were already resolved upstream.',
    'Output contract: return only the schema output. Use null for unknown numeric/date fields and an empty string for unknown text fields.',
    'Field rules: amount is the total expense in euros.',
    'description is a concise merchant-and-purpose description when inferable, otherwise an empty string.',
    'date_iso must be YYYY-MM-DD when explicitly inferable from cleaned_transcript relative to today_iso; otherwise null.',
    'If the speaker gives a percentage split, set partner_share_mode to percent and partner_share_value to that percentage.',
    'If the speaker gives a fixed partner amount, set partner_share_mode to fixed and partner_share_value to that euro amount.',
    'Preserve spouse or partner wording in partner_alias only when it is relevant to the split.',
    'If split details are absent or ambiguous, leave the split fields null.',
    'Do not invent values.',
    'Done when every explicit amount, date, split, and relevant partner reference from cleaned_transcript is either represented in the draft or intentionally left unknown because it is absent or ambiguous, the output fully matches the schema, and is_complete is true only if the draft is sensible to save after app defaults are applied.',
    'Before finalizing, verify that amount is the total expense, not the partner share, that no superseded value has been reintroduced, and that the output satisfies the schema exactly.'
  ].join(' ');

  const voiceUtils = window.MaeuseVoiceUtils || {};
  const voiceDebug = createVoiceDebugController();

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
  let assetUpdateCheckPromise = null;
  let assetReloadPending = false;
  let settingsBusy = false;
  let onboardingHideTimer = null;
  let onboardingPreferenceFallback = null;
  let voiceSettings = loadVoiceSettings();
  let voiceDraft = createEmptyVoiceDraft(todayISO());
  let voiceSession = null;
  let voiceTranscriptExpanded = false;

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
  const voiceHero = $('#voiceHero');
  const voiceMicToggle = $('#voiceMicToggle');
  const voiceMicLabel = $('#voiceMicLabel');
  const voiceMicCaption = $('#voiceMicCaption');
  const voiceSessionStatus = $('#voiceSessionStatus');
  const voiceSheetStatus = $('#voiceSheetStatus');
  const voicePrivacyNote = $('#voicePrivacyNote');
  const voiceProcessingCard = $('#voiceProcessingCard');
  const voiceProcessingStepTranscription = $('#voiceProcessingStepTranscription');
  const voiceProcessingStepCleanup = $('#voiceProcessingStepCleanup');
  const voiceProcessingStepExtraction = $('#voiceProcessingStepExtraction');
  const voiceErrorCard = $('#voiceErrorCard');
  const voiceErrorTitle = $('#voiceErrorTitle');
  const voiceErrorMessage = $('#voiceErrorMessage');
  const voiceReviewSection = $('#voiceReviewSection');
  const voiceTranscriptValue = $('#voiceTranscriptValue');
  const voiceTranscriptToggle = $('#voiceTranscriptToggle');
  const voiceAmountValue = $('#voiceAmountValue');
  const voiceAmountHint = $('#voiceAmountHint');
  const voiceDescriptionValue = $('#voiceDescriptionValue');
  const voiceDescriptionHint = $('#voiceDescriptionHint');
  const voiceDateValue = $('#voiceDateValue');
  const voiceDateHint = $('#voiceDateHint');
  const voiceShareValue = $('#voiceShareValue');
  const voiceShareHint = $('#voiceShareHint');
  const voiceRecordAgain = $('#voiceRecordAgain');
  const voiceRetryProcessing = $('#voiceRetryProcessing');
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
      defaultedFields: { date: false, partnerShare: false },
      isComplete: false,
      source: 'empty'
    };
  }

  function createVoiceDebugController() {
    const entries = [];
    let enabled = readVoiceDebugPreference();

    applyVoiceDebugQueryOverride();
    publishVoiceDebugApi();

    function applyVoiceDebugQueryOverride() {
      let params;
      try {
        params = new URLSearchParams(window.location.search || '');
      } catch (error) {
        return;
      }

      const raw = params.get('voiceDebug');
      if (raw === null) return;

      enabled = isTruthyFlag(raw);
      writeVoiceDebugPreference(enabled);
    }

    function readVoiceDebugPreference() {
      try {
        const raw = window.localStorage.getItem(VOICE_DEBUG_STORAGE_KEY);
        return isTruthyFlag(raw);
      } catch (error) {
        return false;
      }
    }

    function writeVoiceDebugPreference(nextValue) {
      try {
        if (nextValue) {
          window.localStorage.setItem(VOICE_DEBUG_STORAGE_KEY, 'true');
        } else {
          window.localStorage.removeItem(VOICE_DEBUG_STORAGE_KEY);
        }
      } catch (error) {}
    }

    function isTruthyFlag(value) {
      if (typeof value !== 'string') return false;
      const normalized = value.trim().toLowerCase();
      return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
    }

    function cloneDebugData(value) {
      if (value === null || typeof value === 'undefined') return value;
      try {
        return JSON.parse(JSON.stringify(value));
      } catch (error) {
        return {
          note: 'Debug payload could not be serialized cleanly.',
          type: Object.prototype.toString.call(value)
        };
      }
    }

    function pushEntry(eventName, data) {
      const entry = {
        at: new Date().toISOString(),
        event: eventName,
        data: cloneDebugData(data)
      };
      entries.push(entry);
      if (entries.length > VOICE_DEBUG_MAX_ENTRIES) {
        entries.splice(0, entries.length - VOICE_DEBUG_MAX_ENTRIES);
      }
      return entry;
    }

    function publishVoiceDebugApi() {
      window.MaeuseVoiceDebug = {
        enable: function (persist) {
          enabled = true;
          if (persist !== false) {
            writeVoiceDebugPreference(true);
          }
          console.info('Mäuse voice debug enabled.');
          return enabled;
        },
        disable: function () {
          enabled = false;
          writeVoiceDebugPreference(false);
          console.info('Mäuse voice debug disabled.');
          return enabled;
        },
        clear: function () {
          entries.length = 0;
        },
        getLogs: function () {
          return entries.slice();
        },
        isEnabled: function () {
          return enabled;
        },
        download: function () {
          const blob = new Blob([JSON.stringify(entries, null, 2)], {
            type: 'application/json'
          });
          const link = document.createElement('a');
          const url = URL.createObjectURL(blob);
          link.href = url;
          link.download = 'maeuse-voice-debug-' + todayISO() + '.json';
          document.body.appendChild(link);
          link.click();
          link.remove();
          window.setTimeout(function () {
            URL.revokeObjectURL(url);
          }, 1000);
        }
      };
    }

    return {
      log: function (eventName, data) {
        if (!enabled) return;
        const entry = pushEntry(eventName, data);
        console.debug('[Maeuse voice]', eventName, entry.data);
      },
      isEnabled: function () {
        return enabled;
      }
    };
  }

  function normalizeVoiceExtraction(raw) {
    if (voiceUtils.normalizeVoiceExtraction) {
      return voiceUtils.normalizeVoiceExtraction(raw, { todayIso: todayISO() });
    }
    return createEmptyVoiceDraft(todayISO());
  }

  function formatVoiceDuration(durationMs) {
    if (voiceUtils.formatVoiceDuration) {
      return voiceUtils.formatVoiceDuration(durationMs);
    }

    const totalSeconds = Math.max(0, Math.floor(Number(durationMs || 0) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes + ':' + String(seconds).padStart(2, '0');
  }

  function buildVoiceCleanupPayload(session) {
    return {
      locale: 'en-US',
      raw_transcript: session && session.rawTranscript ? session.rawTranscript : ''
    };
  }

  function buildVoiceExtractionPayload(session) {
    return {
      today_iso: todayISO(),
      locale: 'en-US',
      cleaned_transcript: session && session.cleanedTranscript ? session.cleanedTranscript : ''
    };
  }

  function shouldApplyVoiceVersion(latestApplied, candidate) {
    if (voiceUtils.shouldApplyVoiceVersion) {
      return voiceUtils.shouldApplyVoiceVersion(latestApplied, candidate);
    }
    return candidate > latestApplied;
  }

  function getVoicePrimaryActionState(session, draft) {
    if (voiceUtils.getVoicePrimaryActionState) {
      return voiceUtils.getVoicePrimaryActionState({
        draft: draft,
        phase: session ? session.phase : 'idle',
        isSaving: !!(session && session.saving)
      });
    }

    if (session && session.saving) {
      return { label: 'Saving…', disabled: true, visible: true, mode: 'saving' };
    }

    return session && session.phase === 'review'
      ? { label: 'Save', disabled: !(draft && draft.amount && draft.amount > 0), visible: true, mode: 'save' }
      : { label: '', disabled: true, visible: false, mode: 'hidden' };
  }

  function getVoiceHeroActionState(session) {
    if (voiceUtils.getVoiceHeroActionState) {
      return voiceUtils.getVoiceHeroActionState({
        phase: session ? session.phase : 'idle',
        isSupported: isVoiceCaptureSupported(),
        elapsedLabel: session ? formatVoiceDuration(session.recordingDurationMs) : '0:00',
        hasAudio: !!(session && session.audioBlob)
      });
    }

    return {
      label: 'Start recording',
      caption: 'Speak one expense, then stop to process it',
      disabled: !isVoiceCaptureSupported(),
      mode: 'start'
    };
  }

  function isVoiceCaptureSupported() {
    return !!(
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function' &&
      typeof window.MediaRecorder === 'function'
    );
  }

  function hasConfirmedVoiceDraft(session) {
    return !!(
      session &&
      session.phase === 'review' &&
      session.cleanedTranscript &&
      voiceDraft &&
      voiceDraft.source === 'model'
    );
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
      voiceSessionStatus.textContent = message || 'Record one expense and let AI turn it into a draft.';
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

  function normalizeVoiceText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function canExpandVoiceTranscript(text) {
    return normalizeVoiceText(text).length > VOICE_TRANSCRIPT_COLLAPSE_THRESHOLD;
  }

  function resetVoiceTranscriptExpansion() {
    voiceTranscriptExpanded = false;
  }

  function resetVoiceDraft() {
    voiceDraft = createEmptyVoiceDraft(todayISO());
    renderVoiceDraft();
  }

  function createVoiceSessionState() {
    return {
      id: uid(),
      phase: isVoiceCaptureSupported() ? 'idle' : 'error',
      mediaStream: null,
      mediaRecorder: null,
      recordedChunks: [],
      audioBlob: null,
      audioMimeType: '',
      audioFileName: '',
      recordingStartedAt: 0,
      recordingDurationMs: 0,
      recordingTimerId: null,
      autoStopTimerId: null,
      starting: false,
      processingStep: null,
      failedStep: null,
      abortController: null,
      runId: 0,
      saving: false,
      closing: false,
      rawTranscript: '',
      cleanedTranscript: '',
      errorTitle: 'Processing didn’t finish',
      errorMessage: 'Try processing this recording again or switch to manual entry.'
    };
  }

  function clearVoiceRecordingTimers(session) {
    if (!session) return;
    if (session.recordingTimerId) {
      window.clearInterval(session.recordingTimerId);
      session.recordingTimerId = null;
    }
    if (session.autoStopTimerId) {
      window.clearTimeout(session.autoStopTimerId);
      session.autoStopTimerId = null;
    }
  }

  function cleanupVoiceMedia(session) {
    if (!session) return;

    if (session.mediaRecorder) {
      session.mediaRecorder.ondataavailable = null;
      session.mediaRecorder.onstop = null;
      session.mediaRecorder.onerror = null;
      session.mediaRecorder = null;
    }

    if (session.mediaStream) {
      session.mediaStream.getTracks().forEach(function (track) {
        track.stop();
      });
      session.mediaStream = null;
    }
  }

  function clearVoiceProcessing(session) {
    if (!session || !session.abortController) return;
    session.abortController.abort();
    session.abortController = null;
  }

  function selectVoiceRecordingMimeType() {
    if (typeof window.MediaRecorder !== 'function') return '';
    if (typeof window.MediaRecorder.isTypeSupported !== 'function') return '';

    for (let i = 0; i < VOICE_RECORDING_MIME_TYPES.length; i += 1) {
      const candidate = VOICE_RECORDING_MIME_TYPES[i];
      if (window.MediaRecorder.isTypeSupported(candidate)) {
        return candidate;
      }
    }

    return '';
  }

  function voiceFileExtensionForMimeType(mimeType) {
    const normalized = String(mimeType || '').toLowerCase();
    if (normalized.indexOf('mp4') >= 0) return 'mp4';
    if (normalized.indexOf('ogg') >= 0) return 'ogg';
    if (normalized.indexOf('mpeg') >= 0 || normalized.indexOf('mp3') >= 0) return 'mp3';
    if (normalized.indexOf('wav') >= 0) return 'wav';
    return 'webm';
  }

  function buildVoiceAudioFileName(mimeType) {
    return 'voice-expense-' + Date.now() + '.' + voiceFileExtensionForMimeType(mimeType);
  }

  function setVoiceError(session, title, message) {
    if (!session) return;
    session.phase = 'error';
    session.errorTitle = title || 'Processing didn’t finish';
    session.errorMessage = message || 'Try processing this recording again or switch to manual entry.';
    setVoiceSheetStatus('', '');
    renderVoiceDraft();
  }

  function updateVoiceProcessingSteps(session) {
    const steps = [
      { key: 'transcribing', element: voiceProcessingStepTranscription },
      { key: 'cleaning', element: voiceProcessingStepCleanup },
      { key: 'extracting', element: voiceProcessingStepExtraction }
    ];
    const order = {
      transcribing: 0,
      cleaning: 1,
      extracting: 2
    };
    const currentIndex = session && session.processingStep ? order[session.processingStep] : -1;
    const failedIndex = session && session.failedStep ? order[session.failedStep] : -1;

    steps.forEach(function (step, index) {
      if (!step.element) return;
      step.element.classList.remove('is-active', 'is-done', 'is-error');

      if (session && session.phase === 'review') {
        step.element.classList.add('is-done');
        return;
      }

      if (session && session.phase === 'processing') {
        if (index < currentIndex) {
          step.element.classList.add('is-done');
        } else if (index === currentIndex) {
          step.element.classList.add('is-active');
        }
        return;
      }

      if (session && session.phase === 'error' && failedIndex >= 0) {
        if (index < failedIndex) {
          step.element.classList.add('is-done');
        } else if (index === failedIndex) {
          step.element.classList.add('is-error');
        }
      }
    });
  }

  function renderVoiceDraft() {
    const activeSession = voiceSession;
    const phase = activeSession ? activeSession.phase : 'idle';
    const heroAction = getVoiceHeroActionState(activeSession);
    const primaryAction = getVoicePrimaryActionState(activeSession, voiceDraft);
    const partnerAlias = voiceDraft.partnerAlias || '';
    const defaultedFields = voiceDraft.defaultedFields || { date: false, partnerShare: false };
    const hasReview = phase === 'review';
    const isUnsupported = !!(activeSession && !isVoiceCaptureSupported());
    const isRecording = phase === 'recording';
    const isProcessing = phase === 'processing';
    const heroVisible = phase === 'idle' || phase === 'recording';
    const cleanedTranscript = hasReview
      ? normalizeVoiceText(activeSession && activeSession.cleanedTranscript ? activeSession.cleanedTranscript : '')
      : '';
    const transcriptExpandable = hasReview && canExpandVoiceTranscript(cleanedTranscript);

    if (!transcriptExpandable && voiceTranscriptExpanded) {
      voiceTranscriptExpanded = false;
    }

    if (voiceSheet) {
      voiceSheet.dataset.phase = phase;
    }

    if (voiceMicToggle) {
      const isBusy = !!(activeSession && (activeSession.starting || activeSession.saving || isProcessing));
      const label = activeSession && activeSession.starting ? 'Opening microphone…' : heroAction.label;
      const caption = activeSession && activeSession.starting ? 'Please allow microphone access' : heroAction.caption;
      voiceMicToggle.disabled = heroAction.disabled || isBusy;
      voiceMicToggle.classList.toggle('is-recording', isRecording);
      voiceMicToggle.classList.toggle('is-processing', !!(activeSession && activeSession.starting));
      voiceMicToggle.classList.toggle('is-muted', isUnsupported);
      voiceMicToggle.setAttribute('aria-label', label);
      if (voiceMicLabel) voiceMicLabel.textContent = label;
      if (voiceMicCaption) voiceMicCaption.textContent = caption;
    }

    if (voiceHero) {
      voiceHero.hidden = !heroVisible;
    }
    if (voicePrivacyNote) {
      voicePrivacyNote.hidden = !heroVisible;
    }

    if (voiceProcessingCard) {
      voiceProcessingCard.hidden = phase !== 'processing';
    }
    if (voiceErrorCard) {
      voiceErrorCard.hidden = phase !== 'error';
    }
    if (voiceReviewSection) {
      voiceReviewSection.hidden = !hasReview;
    }
    if (voiceRecordAgain) {
      voiceRecordAgain.hidden = !hasReview;
    }
    if (voiceRetryProcessing) {
      voiceRetryProcessing.hidden = !(phase === 'error' && activeSession && activeSession.audioBlob);
    }
    if (voiceSwitchManual) {
      voiceSwitchManual.hidden = !(phase === 'review' || phase === 'error');
    }
    if (voiceActions) {
      voiceActions.hidden = !(phase === 'review' || phase === 'error');
    }

    if (voiceDone) {
      voiceDone.hidden = !primaryAction.visible;
      voiceDone.disabled = primaryAction.disabled;
      voiceDone.textContent = primaryAction.label || 'Save';
    }

    if (voiceTranscriptValue) {
      voiceTranscriptValue.textContent = hasReview
        ? (cleanedTranscript || 'No cleaned transcript available.')
        : 'Waiting for processing…';
      voiceTranscriptValue.classList.toggle('is-collapsed', transcriptExpandable && !voiceTranscriptExpanded);
      voiceTranscriptValue.classList.toggle('is-expanded', transcriptExpandable && voiceTranscriptExpanded);
    }
    if (voiceTranscriptToggle) {
      voiceTranscriptToggle.hidden = !transcriptExpandable;
      voiceTranscriptToggle.textContent = voiceTranscriptExpanded ? 'Show less' : 'Show more';
    }

    if (voiceErrorTitle) {
      voiceErrorTitle.textContent = activeSession && activeSession.errorTitle
        ? activeSession.errorTitle
        : 'Processing didn’t finish';
    }
    if (voiceErrorMessage) {
      voiceErrorMessage.textContent = activeSession && activeSession.errorMessage
        ? activeSession.errorMessage
        : 'Try processing this recording again or switch to manual entry.';
    }

    if (voiceAmountValue) {
      voiceAmountValue.textContent = hasReview
        ? (voiceDraft.amount ? formatEuro(voiceDraft.amount) : 'Missing')
        : 'Waiting…';
    }
    if (voiceAmountHint) {
      voiceAmountHint.textContent = hasReview
        ? (voiceDraft.amount ? 'AI-extracted total' : 'Add the total manually before saving')
        : 'Visible after processing';
    }

    if (voiceDescriptionValue) {
      voiceDescriptionValue.textContent = hasReview
        ? (voiceDraft.description || 'Optional')
        : 'Waiting…';
    }
    if (voiceDescriptionHint) {
      voiceDescriptionHint.textContent = hasReview
        ? (voiceDraft.description ? 'Cleaned from your dictation' : 'Optional')
        : 'Visible after processing';
    }

    if (voiceDateValue) {
      voiceDateValue.textContent = hasReview
        ? formatVoiceDate(voiceDraft.dateIso || todayISO())
        : 'Pending';
    }
    if (voiceDateHint) {
      voiceDateHint.textContent = hasReview
        ? (defaultedFields.date ? 'Using today by default' : 'Confirmed from your dictation')
        : 'Visible after processing';
    }

    if (voiceShareValue) {
      if (!hasReview) {
        voiceShareValue.textContent = 'Pending';
      } else if (voiceDraft.partnerShareMode === 'fixed' && Number.isFinite(voiceDraft.partnerShareValue)) {
        voiceShareValue.textContent = formatEuro(voiceDraft.partnerShareValue);
      } else if (voiceDraft.partnerShareMode === 'percent' && Number.isFinite(voiceDraft.partnerShareValue)) {
        voiceShareValue.textContent = formatPercent(voiceDraft.partnerShareValue);
      } else {
        voiceShareValue.textContent = '50 %';
      }
    }
    if (voiceShareHint) {
      if (!hasReview) {
        voiceShareHint.textContent = 'Visible after processing';
      } else if (defaultedFields.partnerShare) {
        voiceShareHint.textContent = 'Using 50 % default if you save now';
      } else if (voiceDraft.partnerShareMode === 'fixed') {
        voiceShareHint.textContent = partnerAlias ? 'Fixed amount for ' + partnerAlias : 'Fixed amount';
      } else if (voiceDraft.partnerShareMode === 'percent') {
        voiceShareHint.textContent = partnerAlias ? 'Split with ' + partnerAlias : 'Percentage split';
      } else {
        voiceShareHint.textContent = 'No split found';
      }
    }

    updateVoiceProcessingSteps(activeSession);
  }

  function releaseVoiceCapture(session) {
    clearVoiceRecordingTimers(session);
    cleanupVoiceMedia(session);
  }

  function resetVoiceSessionResults(session, options) {
    const resetOptions = options || {};
    if (!session) return;
    resetVoiceTranscriptExpansion();

    if (!resetOptions.preserveAudio) {
      session.audioBlob = null;
      session.audioMimeType = '';
      session.audioFileName = '';
      session.recordedChunks = [];
    }

    session.rawTranscript = '';
    session.cleanedTranscript = '';
    session.processingStep = null;
    session.failedStep = null;
    session.errorTitle = 'Processing didn’t finish';
    session.errorMessage = 'Try processing this recording again or switch to manual entry.';
    voiceDraft = createEmptyVoiceDraft(todayISO());
  }

  function closeVoiceSheet(options) {
    const closeOptions = options || {};
    if (voiceOverlay) voiceOverlay.classList.remove('open');
    if (voiceSheet) voiceSheet.classList.remove('open');

    if (voiceSession) {
      voiceDebug.log('voice.session.closed', {
        sessionId: voiceSession.id,
        phase: voiceSession.phase,
        hadAudio: !!voiceSession.audioBlob,
        hadCleanedTranscript: !!voiceSession.cleanedTranscript
      });
      voiceSession.closing = true;
      clearVoiceProcessing(voiceSession);
      releaseVoiceCapture(voiceSession);
      voiceSession = null;
    }

    if (!closeOptions.preserveDraft) {
      resetVoiceDraft();
    }
    resetVoiceTranscriptExpansion();
    setVoiceSessionStatus('Record one expense and let AI turn it into a draft.');
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
    setVoiceSheetStatus('', '');
    resetVoiceTranscriptExpansion();

    if (voiceOverlay) voiceOverlay.classList.add('open');
    if (voiceSheet) voiceSheet.classList.add('open');

    const session = createVoiceSessionState();
    voiceSession = session;
    resetVoiceSessionResults(session);
    setVoiceSessionStatus('Record one expense and let AI turn it into a draft.');
    voiceDebug.log('voice.session.opened', {
      sessionId: session.id,
      transcriptionModel: VOICE_TRANSCRIPTION_MODEL,
      cleanupModel: VOICE_CLEANUP_MODEL,
      extractModel: VOICE_EXTRACT_MODEL,
      supportedMimeType: selectVoiceRecordingMimeType() || 'browser-default',
      includeLogprobs: voiceDebug.isEnabled()
    });

    if (!isVoiceCaptureSupported()) {
      setVoiceSessionStatus('Voice capture is unavailable on this device.');
      setVoiceError(
        session,
        'Voice capture is unavailable',
        'This browser does not support local audio recording yet. Use manual entry instead.'
      );
    } else {
      renderVoiceDraft();
    }
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

  function getResponseOutputText(response) {
    if (!response || typeof response !== 'object') return '';

    if (typeof response.output_text === 'string' && response.output_text.trim()) {
      return response.output_text.trim();
    }

    if (!Array.isArray(response.output)) return '';

    const outputTexts = [];

    for (let i = 0; i < response.output.length; i += 1) {
      const outputItem = response.output[i];
      if (!outputItem || outputItem.type !== 'message' || !Array.isArray(outputItem.content)) continue;

      for (let j = 0; j < outputItem.content.length; j += 1) {
        const contentItem = outputItem.content[j];
        if (
          contentItem &&
          contentItem.type === 'output_text' &&
          typeof contentItem.text === 'string' &&
          contentItem.text.trim()
        ) {
          outputTexts.push(contentItem.text.trim());
        }
      }
    }

    if (outputTexts.length) {
      return outputTexts.join('\n').trim();
    }

    for (let i = 0; i < response.output.length; i += 1) {
      const outputItem = response.output[i];
      if (!outputItem || !Array.isArray(outputItem.content)) continue;

      for (let j = 0; j < outputItem.content.length; j += 1) {
        const contentItem = outputItem.content[j];
        if (contentItem && typeof contentItem.text === 'string' && contentItem.text.trim()) {
          return contentItem.text.trim();
        }
      }
    }

    return '';
  }

  function createSilentWavBlob(durationMs) {
    const sampleRate = 16000;
    const numChannels = 1;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const sampleCount = Math.max(1, Math.floor(sampleRate * (durationMs / 1000)));
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = sampleCount * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    function writeString(offset, value) {
      for (let i = 0; i < value.length; i += 1) {
        view.setUint8(offset + i, value.charCodeAt(i));
      }
    }

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    return new Blob([buffer], { type: 'audio/wav' });
  }

  async function postOpenAIAudioTranscription(apiKey, audioBlob, fileName, signal) {
    const formData = new FormData();
    formData.append('file', audioBlob, fileName);
    formData.append('model', VOICE_TRANSCRIPTION_MODEL);
    formData.append('response_format', 'json');
    formData.append('stream', 'false');
    formData.append('temperature', '0');
    formData.append('prompt', VOICE_TRANSCRIPTION_PROMPT);
    if (voiceDebug.isEnabled()) {
      formData.append('include[]', 'logprobs');
    }

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey
      },
      body: formData,
      signal: signal
    });

    if (!response.ok) {
      throw new Error(await readOpenAIError(response, 'The audio transcription request failed.'));
    }

    return response.json();
  }

  function getOpenAIResponseMeta(response) {
    if (!response || typeof response !== 'object') return null;

    return {
      id: response.id || null,
      model: response.model || null,
      status: response.status || null,
      incompleteDetails: response.incomplete_details || null,
      error: response.error || null,
      usage: response.usage || null
    };
  }

  function parseStructuredResponseJson(response, label) {
    const prefix = typeof label === 'string' && label ? label : 'The model';
    const outputText = getResponseOutputText(response);
    const responseMeta = getOpenAIResponseMeta(response);

    if (!outputText) {
      const emptyError = new Error(prefix + ' returned an empty response.');
      emptyError.name = 'StructuredResponseEmptyError';
      emptyError.outputText = '';
      emptyError.responseMeta = responseMeta;
      throw emptyError;
    }

    try {
      return {
        value: JSON.parse(outputText),
        outputText: outputText,
        responseMeta: responseMeta
      };
    } catch (error) {
      const parseError = new Error(prefix + ' returned invalid structured JSON.');
      parseError.name = 'StructuredResponseParseError';
      parseError.outputText = outputText;
      parseError.responseMeta = responseMeta;
      parseError.cause = error;
      throw parseError;
    }
  }

  function buildVoiceCleanupSchema() {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['cleaned_transcript'],
      properties: {
        cleaned_transcript: {
          type: 'string',
          description: 'A cleaned single-utterance transcript for user review and downstream extraction.'
        }
      }
    };
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

  async function requestVoiceCleanup(apiKey, cleanupPayload, signal) {
    const response = await postOpenAIJson('/responses', apiKey, {
      model: VOICE_CLEANUP_MODEL,
      store: false,
      max_output_tokens: 180,
      reasoning: {
        effort: VOICE_CLEANUP_REASONING_EFFORT
      },
      instructions: VOICE_CLEANUP_PROMPT,
      input: [{
        role: 'user',
        content: [{
          type: 'input_text',
          text: JSON.stringify(cleanupPayload, null, 2)
        }]
      }],
      text: {
        verbosity: 'low',
        format: {
          type: 'json_schema',
          name: 'cleaned_expense_transcript',
          strict: true,
          schema: buildVoiceCleanupSchema()
        }
      }
    }, signal);

    const parsed = parseStructuredResponseJson(response, 'The cleanup model');

    return {
      cleaned: parsed.value,
      outputText: parsed.outputText,
      responseMeta: parsed.responseMeta
    };
  }

  async function requestVoiceExtraction(apiKey, extractionPayload, signal) {
    const response = await postOpenAIJson('/responses', apiKey, {
      model: VOICE_EXTRACT_MODEL,
      store: false,
      max_output_tokens: 320,
      reasoning: {
        effort: VOICE_EXTRACT_REASONING_EFFORT
      },
      instructions: VOICE_EXTRACT_PROMPT,
      input: [{
        role: 'user',
        content: [{
          type: 'input_text',
          text: JSON.stringify(extractionPayload, null, 2)
        }]
      }],
      text: {
        verbosity: 'low',
        format: {
          type: 'json_schema',
          name: 'expense_voice_draft',
          strict: true,
          schema: buildVoiceExtractionSchema()
        }
      }
    }, signal);

    const parsed = parseStructuredResponseJson(response, 'The extraction model');

    return {
      extracted: parsed.value,
      outputText: parsed.outputText,
      responseMeta: parsed.responseMeta
    };
  }

  async function verifyVoiceKeyWithResponses(apiKey) {
    const response = await postOpenAIJson('/responses', apiKey, {
      model: VOICE_EXTRACT_MODEL,
      store: false,
      max_output_tokens: 40,
      reasoning: {
        effort: 'none'
      },
      instructions: 'Return JSON that confirms the API key can reach the Responses API with gpt-5.4.',
      input: 'Verification request for Mäuse voice mode.',
      text: {
        verbosity: 'low',
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

    const parsedResponse = parseStructuredResponseJson(response, 'The verification request');
    if (!parsedResponse.value || parsedResponse.value.ok !== true) {
      throw new Error('The verification response was not valid.');
    }
  }

  async function verifyVoiceKeyWithTranscription(apiKey) {
    const silentBlob = createSilentWavBlob(250);
    await postOpenAIAudioTranscription(apiKey, silentBlob, 'voice-check.wav');
  }

  async function verifyVoiceKey() {
    const apiKey = normalizeVoiceKey(voiceApiKeyInput ? voiceApiKeyInput.value : voiceSettings.apiKey);

    if (!apiKey) {
      setVoiceSettingsStatus('Enter an OpenAI API key first.', 'error');
      return;
    }

    setSettingsBusy(true);
    setVoiceSettingsStatus('Verifying gpt-4o-transcribe and gpt-5.4 access…', 'info');

    try {
      await verifyVoiceKeyWithTranscription(apiKey);
      await verifyVoiceKeyWithResponses(apiKey);
      voiceSettings = {
        apiKey: apiKey,
        verifiedAt: Date.now(),
        enabled: voiceSettings.enabled
      };
      saveVoiceSettings();
      renderVoiceSettings();
      setVoiceSettingsStatus('Key verified for gpt-4o-transcribe and gpt-5.4. You can enable voice mode now.', 'success');
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

  function getVoiceRunStillCurrent(session, runId) {
    return !!(voiceSession === session && session && !session.closing && session.runId === runId);
  }

  function getVoicePermissionErrorMessage(error) {
    if (!error || !error.name) {
      return 'Microphone access could not be started.';
    }

    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return 'Microphone access was denied. Allow access and try again.';
    }
    if (error.name === 'NotFoundError') {
      return 'No microphone was found on this device.';
    }
    if (error.name === 'NotReadableError') {
      return 'The microphone is already in use by another app.';
    }

    return error.message || 'Microphone access could not be started.';
  }

  async function processVoiceAudio(session, options) {
    const processOptions = options || {};
    if (!session || !session.audioBlob || !voiceSettings.apiKey) return null;
    if (!navigator.onLine) {
      setVoiceSessionStatus('Voice mode needs an internet connection.');
      setVoiceError(session, 'No internet connection', 'Reconnect to the internet, then retry processing or switch to manual entry.');
      return null;
    }

    session.runId += 1;
    const runId = session.runId;
    clearVoiceProcessing(session);
    const abortController = new AbortController();
    session.abortController = abortController;
    session.phase = 'processing';
    session.processingStep = 'transcribing';
    session.failedStep = null;
    session.errorTitle = 'Processing didn’t finish';
    session.errorMessage = 'Try processing this recording again or switch to manual entry.';
    session.rawTranscript = '';
    session.cleanedTranscript = '';
    resetVoiceTranscriptExpansion();
    voiceDraft = createEmptyVoiceDraft(todayISO());
    setVoiceSessionStatus('Transcribing audio…');
    setVoiceSheetStatus('', '');
    renderVoiceDraft();

    voiceDebug.log('voice.processing.started', {
      sessionId: session.id,
      runId: runId,
      reason: processOptions.reason || 'recording_stopped',
      audio: {
        mimeType: session.audioMimeType,
        fileName: session.audioFileName,
        size: session.audioBlob.size,
        durationMs: session.recordingDurationMs
      }
    });

    try {
      voiceDebug.log('voice.transcription.request', {
        sessionId: session.id,
        runId: runId,
        model: VOICE_TRANSCRIPTION_MODEL,
        prompt: VOICE_TRANSCRIPTION_PROMPT,
        includeLogprobs: voiceDebug.isEnabled()
      });
      const transcriptionResponse = await postOpenAIAudioTranscription(
        voiceSettings.apiKey,
        session.audioBlob,
        session.audioFileName || buildVoiceAudioFileName(session.audioMimeType),
        abortController.signal
      );

      if (!getVoiceRunStillCurrent(session, runId)) {
        voiceDebug.log('voice.processing.stale_ignored', {
          sessionId: session.id,
          runId: runId,
          stage: 'transcribing'
        });
        return null;
      }

      session.rawTranscript = normalizeVoiceText(transcriptionResponse.text || '');
      voiceDebug.log('voice.transcription.response', {
        sessionId: session.id,
        runId: runId,
        rawTranscript: session.rawTranscript,
        response: transcriptionResponse
      });

      if (!session.rawTranscript) {
        throw new Error('We could not understand enough of that recording to review it.');
      }

      session.processingStep = 'cleaning';
      setVoiceSessionStatus('Cleaning transcript…');
      renderVoiceDraft();

      const cleanupPayload = buildVoiceCleanupPayload(session);
      voiceDebug.log('voice.cleanup.request', {
        sessionId: session.id,
        runId: runId,
        model: VOICE_CLEANUP_MODEL,
        reasoningEffort: VOICE_CLEANUP_REASONING_EFFORT,
        payload: cleanupPayload,
        prompt: VOICE_CLEANUP_PROMPT
      });
      const cleanupResult = await requestVoiceCleanup(
        voiceSettings.apiKey,
        cleanupPayload,
        abortController.signal
      );

      if (!getVoiceRunStillCurrent(session, runId)) {
        voiceDebug.log('voice.processing.stale_ignored', {
          sessionId: session.id,
          runId: runId,
          stage: 'cleaning'
        });
        return null;
      }

      session.cleanedTranscript = normalizeVoiceText(
        cleanupResult.cleaned && cleanupResult.cleaned.cleaned_transcript
          ? cleanupResult.cleaned.cleaned_transcript
          : ''
      );
      voiceDebug.log('voice.cleanup.response', {
        sessionId: session.id,
        runId: runId,
        responseMeta: cleanupResult.responseMeta,
        outputText: cleanupResult.outputText,
        parsedOutput: cleanupResult.cleaned,
        cleanedTranscript: session.cleanedTranscript
      });

      if (!session.cleanedTranscript) {
        throw new Error('The transcript was too unclear to clean into a reviewable sentence.');
      }

      session.processingStep = 'extracting';
      setVoiceSessionStatus('Extracting expense…');
      renderVoiceDraft();

      const extractionPayload = buildVoiceExtractionPayload(session);
      voiceDebug.log('voice.extraction.request', {
        sessionId: session.id,
        runId: runId,
        model: VOICE_EXTRACT_MODEL,
        reasoningEffort: VOICE_EXTRACT_REASONING_EFFORT,
        payload: extractionPayload,
        prompt: VOICE_EXTRACT_PROMPT
      });
      const extractionResult = await requestVoiceExtraction(
        voiceSettings.apiKey,
        extractionPayload,
        abortController.signal
      );

      if (!getVoiceRunStillCurrent(session, runId)) {
        voiceDebug.log('voice.processing.stale_ignored', {
          sessionId: session.id,
          runId: runId,
          stage: 'extracting'
        });
        return null;
      }

      voiceDraft = normalizeVoiceExtraction(extractionResult.extracted);
      resetVoiceTranscriptExpansion();
      session.phase = 'review';
      session.processingStep = null;
      session.failedStep = null;
      setVoiceSessionStatus(
        voiceDraft.amount
          ? 'Review the result and save if it looks right.'
          : 'Review the result or edit it manually.'
      );
      setVoiceSheetStatus(
        voiceDraft.amount
          ? ''
          : 'The total amount is still missing, so Save stays disabled until you edit it manually.',
        voiceDraft.amount ? '' : ''
      );
      voiceDebug.log('voice.extraction.response', {
        sessionId: session.id,
        runId: runId,
        responseMeta: extractionResult.responseMeta,
        outputText: extractionResult.outputText,
        parsedOutput: extractionResult.extracted,
        normalizedDraft: voiceDraft
      });
      renderVoiceDraft();
      return voiceDraft;
    } catch (error) {
      if (error && error.name === 'AbortError') {
        voiceDebug.log('voice.processing.aborted', {
          sessionId: session.id,
          runId: runId,
          stage: session.processingStep
        });
        return null;
      }

      const failedStep = session.processingStep || 'transcribing';
      session.failedStep = failedStep;
      voiceDebug.log('voice.processing.error', {
        sessionId: session.id,
        runId: runId,
        stage: failedStep,
        message: error && error.message ? error.message : 'Unknown processing error',
        cause: error && error.cause && error.cause.message ? error.cause.message : null,
        responseMeta: error && error.responseMeta ? error.responseMeta : null,
        outputText: error && typeof error.outputText === 'string' ? error.outputText : null
      });

      if (!getVoiceRunStillCurrent(session, runId)) {
        return null;
      }

      setVoiceSessionStatus('This recording needs another try.');
      if (failedStep === 'transcribing') {
        setVoiceError(
          session,
          'Transcription didn’t finish',
          error && error.message ? error.message : 'We could not turn that recording into text.'
        );
      } else if (failedStep === 'cleaning') {
        setVoiceError(
          session,
          'Transcript cleanup failed',
          error && error.message ? error.message : 'The transcript could not be cleaned into a reviewable sentence.'
        );
      } else {
        setVoiceError(
          session,
          'Expense extraction failed',
          error && error.message ? error.message : 'The AI could not turn that transcript into an expense draft.'
        );
      }
      return null;
    } finally {
      if (voiceSession === session && session.abortController === abortController) {
        session.abortController = null;
      }
      renderVoiceDraft();
    }
  }

  function finalizeVoiceRecording(session) {
    if (!session) return Promise.resolve();
    const chunks = Array.isArray(session.recordedChunks) ? session.recordedChunks.slice() : [];
    const mimeType = session.audioMimeType || 'audio/webm';
    const blob = new Blob(chunks, { type: mimeType });
    session.audioBlob = blob;
    session.audioFileName = buildVoiceAudioFileName(mimeType);
    session.recordedChunks = [];
    releaseVoiceCapture(session);

    if (session.closing || voiceSession !== session) {
      return Promise.resolve();
    }

    voiceDebug.log('voice.recording.stopped', {
      sessionId: session.id,
      mimeType: mimeType,
      fileName: session.audioFileName,
      size: blob.size,
      durationMs: session.recordingDurationMs
    });

    if (!blob.size) {
      setVoiceSessionStatus('No audio was captured.');
      setVoiceError(session, 'No audio captured', 'Try recording again and speak a little longer, or switch to manual entry.');
      return Promise.resolve();
    }

    return processVoiceAudio(session, { reason: 'recording_stopped' });
  }

  async function startVoiceRecording(session) {
    if (!session || session.starting || session.phase === 'recording' || session.phase === 'processing') return;
    if (!navigator.onLine) {
      setVoiceSessionStatus('Voice mode needs an internet connection.');
      setVoiceError(session, 'No internet connection', 'Reconnect to the internet, then try recording again.');
      return;
    }
    if (!isVoiceCaptureSupported()) {
      setVoiceSessionStatus('Voice capture is unavailable on this device.');
      setVoiceError(session, 'Voice capture is unavailable', 'This browser does not support local audio recording yet. Use manual entry instead.');
      return;
    }

    session.starting = true;
    setVoiceSessionStatus('Opening microphone…');
    setVoiceSheetStatus('', '');
    renderVoiceDraft();

    try {
      clearVoiceProcessing(session);
      releaseVoiceCapture(session);
      resetVoiceSessionResults(session);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      if (voiceSession !== session || session.closing) {
        stream.getTracks().forEach(function (track) {
          track.stop();
        });
        return;
      }

      const preferredMimeType = selectVoiceRecordingMimeType();
      let recorder;
      try {
        recorder = preferredMimeType
          ? new MediaRecorder(stream, { mimeType: preferredMimeType })
          : new MediaRecorder(stream);
      } catch (error) {
        recorder = new MediaRecorder(stream);
      }

      session.mediaStream = stream;
      session.mediaRecorder = recorder;
      session.audioMimeType = recorder.mimeType || preferredMimeType || 'audio/webm';
      session.audioFileName = buildVoiceAudioFileName(session.audioMimeType);
      session.recordedChunks = [];
      session.phase = 'recording';
      session.recordingStartedAt = Date.now();
      session.recordingDurationMs = 0;
      session.failedStep = null;
      session.errorTitle = 'Processing didn’t finish';
      session.errorMessage = 'Try processing this recording again or switch to manual entry.';

      recorder.ondataavailable = function (event) {
        if (event.data && event.data.size) {
          session.recordedChunks.push(event.data);
        }
      };

      recorder.onerror = function (event) {
        const error = event && event.error ? event.error : null;
        setVoiceSessionStatus('Recording stopped unexpectedly.');
        setVoiceError(
          session,
          'Recording stopped unexpectedly',
          error && error.message ? error.message : 'Try recording again or switch to manual entry.'
        );
      };

      recorder.onstop = function () {
        finalizeVoiceRecording(session).catch(function (error) {
          setVoiceSessionStatus('This recording needs another try.');
          setVoiceError(
            session,
            'Processing didn’t finish',
            error && error.message ? error.message : 'Try processing this recording again or switch to manual entry.'
          );
        });
      };

      recorder.start();
      session.recordingTimerId = window.setInterval(function () {
        if (voiceSession !== session || session.phase !== 'recording') return;
        session.recordingDurationMs = Date.now() - session.recordingStartedAt;
        renderVoiceDraft();
      }, 250);
      session.autoStopTimerId = window.setTimeout(function () {
        if (voiceSession !== session || session.phase !== 'recording') return;
        setVoiceSheetStatus('Reached the recording limit. Processing what you said now.', '');
        stopVoiceRecording(session, { reason: 'auto_stop' });
      }, VOICE_MAX_RECORDING_MS);

      voiceDebug.log('voice.recording.started', {
        sessionId: session.id,
        mimeType: session.audioMimeType,
        fileName: session.audioFileName
      });
      setVoiceSessionStatus('Recording… tap when you’re done.');
      renderVoiceDraft();
    } catch (error) {
      setVoiceSessionStatus('Microphone unavailable');
      setVoiceError(session, 'Microphone access failed', getVoicePermissionErrorMessage(error));
    } finally {
      if (session) {
        session.starting = false;
      }
      renderVoiceDraft();
    }
  }

  function stopVoiceRecording(session, options) {
    const stopOptions = options || {};
    if (!session || session.phase !== 'recording') return;

    clearVoiceRecordingTimers(session);
    session.recordingDurationMs = Date.now() - session.recordingStartedAt;
    session.phase = 'processing';
    session.processingStep = 'transcribing';
    setVoiceSessionStatus('Transcribing audio…');
    if (stopOptions.reason !== 'auto_stop') {
      setVoiceSheetStatus('', '');
    }
    renderVoiceDraft();

    if (session.mediaRecorder && session.mediaRecorder.state !== 'inactive') {
      try {
        session.mediaRecorder.stop();
      } catch (error) {
        finalizeVoiceRecording(session).catch(function () {});
      }
    } else {
      finalizeVoiceRecording(session).catch(function () {});
    }
  }

  function retryVoiceProcessing() {
    if (!voiceSession || !voiceSession.audioBlob) return;
    voiceDebug.log('voice.retry_processing', {
      sessionId: voiceSession.id,
      hadAudio: !!voiceSession.audioBlob
    });
    processVoiceAudio(voiceSession, { reason: 'retry' }).catch(function (error) {
      setVoiceSessionStatus('This recording needs another try.');
      setVoiceError(
        voiceSession,
        'Processing didn’t finish',
        error && error.message ? error.message : 'Try processing this recording again or switch to manual entry.'
      );
    });
  }

  function handleVoiceHeroAction() {
    if (!voiceSession) return;
    if (voiceSession.phase === 'recording') {
      stopVoiceRecording(voiceSession);
      return;
    }

    if (voiceSession.phase === 'processing' || voiceSession.saving) {
      return;
    }

    if (voiceSession.phase === 'review' || voiceSession.phase === 'error') {
      voiceDebug.log('voice.record_again', {
        sessionId: voiceSession.id,
        previousPhase: voiceSession.phase,
        hadDraft: hasConfirmedVoiceDraft(voiceSession)
      });
    }

    startVoiceRecording(voiceSession).catch(function (error) {
      setVoiceSessionStatus('Microphone unavailable');
      setVoiceError(
        voiceSession,
        'Microphone access failed',
        error && error.message ? error.message : 'Try again or switch to manual entry.'
      );
    });
  }

  async function handleVoiceDone() {
    if (!voiceSession || voiceSession.phase !== 'review') return;
    if (!voiceDraft.amount || voiceDraft.amount <= 0) {
      setVoiceSheetStatus('Add the missing total manually before saving.', 'error');
      renderVoiceDraft();
      return;
    }

    voiceSession.saving = true;
    setVoiceSessionStatus('Saving…');
    renderVoiceDraft();

    try {
      voiceDebug.log('voice.save.requested', {
        sessionId: voiceSession.id,
        cleanedTranscript: voiceSession.cleanedTranscript,
        draft: voiceDraft,
        normalizedExpenseDraft: draftFromVoiceDraft(voiceDraft)
      });
      const saved = await persistExpenseFromDraft(draftFromVoiceDraft(voiceDraft), { closeSheetOnSave: false });
      if (!saved) {
        setVoiceSheetStatus('A valid amount is required before saving.', 'error');
        return;
      }
      voiceDebug.log('voice.save.persisted', {
        sessionId: voiceSession.id,
        expense: saved
      });
      closeVoiceSheet();
    } finally {
      if (voiceSession) {
        voiceSession.saving = false;
        if (voiceSession.phase === 'review') {
          setVoiceSessionStatus('Review the result and save if it looks right.');
        }
      }
      renderVoiceDraft();
    }
  }

  function switchVoiceToManual() {
    const draft = hasConfirmedVoiceDraft(voiceSession)
      ? draftFromVoiceDraft(voiceDraft)
      : buildDefaultExpenseDraft();
    voiceDebug.log('voice.switch_manual', {
      sessionId: voiceSession ? voiceSession.id : null,
      usedConfirmedDraft: hasConfirmedVoiceDraft(voiceSession),
      manualDraft: draft
    });
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

  function readAssetSignatures() {
    try {
      const raw = window.localStorage.getItem(APP_ASSET_SIGNATURES_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function writeAssetSignatures(signatures) {
    try {
      window.localStorage.setItem(APP_ASSET_SIGNATURES_KEY, JSON.stringify(signatures));
    } catch (error) {}
  }

  async function fetchAssetSignature(url) {
    let response = null;

    try {
      response = await fetch(url, {
        method: 'HEAD',
        cache: 'no-store'
      });
    } catch (error) {}

    if (!response || !response.ok) {
      response = await fetch(url, { cache: 'no-store' });
    }

    if (!response.ok) {
      throw new Error('Failed to fetch asset signature for ' + url);
    }

    return [
      response.headers.get('etag') || '',
      response.headers.get('last-modified') || '',
      response.headers.get('content-length') || ''
    ].join('|');
  }

  async function collectAssetSignatures() {
    const entries = await Promise.all(APP_UPDATE_ASSETS.map(async function (url) {
      return [url, await fetchAssetSignature(url)];
    }));

    return Object.fromEntries(entries);
  }

  function haveAssetSignaturesChanged(previous, next) {
    if (!previous) return false;

    return APP_UPDATE_ASSETS.some(function (url) {
      return previous[url] && next[url] && previous[url] !== next[url];
    });
  }

  function canReloadForAssetUpdate() {
    if (sheet && sheet.classList.contains('open')) return false;
    if (voiceSheet && voiceSheet.classList.contains('open')) return false;
    if (settingsSheet && settingsSheet.classList.contains('open')) return false;
    return true;
  }

  function handleAssetUpdateDetected(signatures) {
    writeAssetSignatures(signatures);

    if (assetReloadPending) return;
    assetReloadPending = true;

    if (canReloadForAssetUpdate()) {
      window.location.reload();
      return;
    }

    showUpdateNotice(swRegistration);
  }

  function checkForAssetUpdates() {
    if (assetReloadPending) return Promise.resolve();
    if (assetUpdateCheckPromise) return assetUpdateCheckPromise;

    assetUpdateCheckPromise = collectAssetSignatures()
      .then(function (signatures) {
        const previous = readAssetSignatures();

        if (haveAssetSignaturesChanged(previous, signatures)) {
          handleAssetUpdateDetected(signatures);
          return;
        }

        writeAssetSignatures(signatures);
      })
      .catch(function () {})
      .finally(function () {
        assetUpdateCheckPromise = null;
      });

    return assetUpdateCheckPromise;
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
      handleVoiceHeroAction();
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
  if (voiceRetryProcessing) {
    voiceRetryProcessing.addEventListener('click', function () {
      retryVoiceProcessing();
    });
  }
  if (voiceRecordAgain) {
    voiceRecordAgain.addEventListener('click', function () {
      handleVoiceHeroAction();
    });
  }
  if (voiceSwitchManual) {
    voiceSwitchManual.addEventListener('click', function () {
      switchVoiceToManual();
    });
  }
  if (voiceTranscriptToggle) {
    voiceTranscriptToggle.addEventListener('click', function () {
      voiceTranscriptExpanded = !voiceTranscriptExpanded;
      renderVoiceDraft();
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
          ? 'Voice mode enabled. The mic button is now ready.'
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
          checkForAssetUpdates();
        }
      });

      window.addEventListener('online', function () {
        triggerServiceWorkerUpdate();
        checkForAssetUpdates();
      });

      navigator.serviceWorker.register('./sw.js').then(function (registration) {
        bindServiceWorkerUpdates(registration);
        triggerServiceWorkerUpdate();
        checkForAssetUpdates();
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
