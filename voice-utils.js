(function (root, factory) {
  const exports = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = exports;
  }

  root.MaeuseVoiceUtils = exports;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PARTNER_ALIASES = [
    'wife',
    'husband',
    'spouse',
    'partner',
    'girlfriend',
    'boyfriend',
    'fiance',
    'fiancee'
  ];

  function roundMoney(value) {
    if (!Number.isFinite(value)) return null;
    return Math.round(value * 100) / 100;
  }

  function normalizeWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizePartnerAlias(value) {
    const alias = normalizeWhitespace(value).toLowerCase().replace(/^my\s+/, '');
    return PARTNER_ALIASES.includes(alias) ? alias : '';
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function toISODate(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  function isValidDateString(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  }

  function parseLooseNumber(raw) {
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    const normalized = String(raw).replace(/\s/g, '').replace(',', '.');
    const value = Number(normalized);
    return Number.isFinite(value) ? value : null;
  }

  function createEmptyVoiceDraft(todayIso) {
    return {
      amount: null,
      description: '',
      dateIso: todayIso || toISODate(new Date()),
      partnerShareMode: null,
      partnerShareValue: null,
      partnerAlias: '',
      confidence: {
        amount: 0,
        description: 0,
        date: 0,
        partnerShare: 0
      },
      defaultedFields: {
        date: false,
        partnerShare: false
      },
      isComplete: false,
      source: 'empty'
    };
  }

  function normalizeConfidence(value, fallback) {
    if (value === null || typeof value === 'undefined') return fallback;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(Math.max(numeric, 0), 1);
  }

  function normalizeVoiceExtraction(raw, options) {
    const todayIso = options && options.todayIso ? options.todayIso : toISODate(new Date());
    const fallback = createEmptyVoiceDraft(todayIso);

    if (!raw || typeof raw !== 'object') return fallback;

    const parsedAmount = parseLooseNumber(raw.amount);
    const amount = roundMoney(parsedAmount);
    const description = normalizeWhitespace(raw.description || '');
    const candidateDate = typeof raw.date_iso === 'string'
      ? raw.date_iso
      : typeof raw.dateIso === 'string'
        ? raw.dateIso
        : '';
    const modelDateIso = isValidDateString(candidateDate) ? candidateDate : null;
    let partnerShareMode = raw.partner_share_mode === 'fixed' || raw.partnerShareMode === 'fixed'
      ? 'fixed'
      : raw.partner_share_mode === 'percent' || raw.partnerShareMode === 'percent'
        ? 'percent'
        : null;
    const rawPartnerValue = parseLooseNumber(raw.partner_share_value ?? raw.partnerShareValue);
    const roundedPartnerValue = roundMoney(rawPartnerValue);
    let partnerShareValue = null;

    if (partnerShareMode === 'percent' && roundedPartnerValue !== null) {
      partnerShareValue = Math.min(Math.max(roundedPartnerValue, 0), 100);
    } else if (partnerShareMode === 'fixed' && roundedPartnerValue !== null) {
      partnerShareValue = Math.max(roundedPartnerValue, 0);
    }

    const defaultedDate = !modelDateIso;
    const defaultedPartnerShare = !partnerShareMode || partnerShareValue === null;
    if (defaultedPartnerShare) {
      partnerShareMode = 'percent';
      partnerShareValue = 50;
    }

    const partnerAlias = defaultedPartnerShare ? '' : normalizePartnerAlias(raw.partner_alias || raw.partnerAlias || '');
    const confidence = raw.confidence && typeof raw.confidence === 'object' ? raw.confidence : {};

    return {
      amount: amount && amount > 0 ? amount : null,
      description: description,
      dateIso: modelDateIso || todayIso,
      partnerShareMode: partnerShareMode,
      partnerShareValue: partnerShareValue,
      partnerAlias: partnerAlias,
      confidence: {
        amount: normalizeConfidence(confidence.amount, amount && amount > 0 ? 0.85 : 0),
        description: normalizeConfidence(confidence.description, description ? 0.65 : 0),
        date: defaultedDate
          ? 0
          : normalizeConfidence(confidence.date, modelDateIso ? 0.65 : 0),
        partnerShare: defaultedPartnerShare
          ? 0
          : normalizeConfidence(confidence.partner_share ?? confidence.partnerShare, partnerShareMode ? 0.7 : 0)
      },
      defaultedFields: {
        date: defaultedDate,
        partnerShare: defaultedPartnerShare
      },
      isComplete: typeof raw.is_complete === 'boolean' ? raw.is_complete : !!(amount && amount > 0),
      source: 'model'
    };
  }

  function shouldApplyVoiceVersion(latestAppliedVersion, candidateVersion) {
    return Number(candidateVersion) > Number(latestAppliedVersion);
  }

  function formatVoiceDuration(durationMs) {
    const totalSeconds = Math.max(0, Math.floor(Number(durationMs || 0) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes + ':' + pad2(seconds);
  }

  function getVoicePrimaryActionState(options) {
    const source = options && typeof options === 'object' ? options : {};
    const draft = source.draft && typeof source.draft === 'object' ? source.draft : {};
    const phase = source.phase || 'idle';
    const isSaving = !!source.isSaving;
    const hasAmount = Number.isFinite(Number(draft.amount)) && Number(draft.amount) > 0;

    if (isSaving) {
      return {
        label: 'Saving…',
        disabled: true,
        visible: true,
        mode: 'saving'
      };
    }

    if (phase !== 'review') {
      return {
        label: '',
        disabled: true,
        visible: false,
        mode: 'hidden'
      };
    }

    return {
      label: 'Save',
      disabled: !hasAmount,
      visible: true,
      mode: 'save'
    };
  }

  function getVoiceHeroActionState(options) {
    const source = options && typeof options === 'object' ? options : {};
    const phase = source.phase || 'idle';
    const isSupported = source.isSupported !== false;
    const elapsedLabel = typeof source.elapsedLabel === 'string' && source.elapsedLabel
      ? source.elapsedLabel
      : '00:00';
    const hasAudio = !!source.hasAudio;

    if (!isSupported) {
      return {
        label: 'Voice unavailable',
        caption: 'Use manual entry on this device',
        disabled: true,
        mode: 'unsupported'
      };
    }

    if (phase === 'recording') {
      return {
        label: 'Stop recording',
        caption: elapsedLabel,
        disabled: false,
        mode: 'stop'
      };
    }

    if (phase === 'processing') {
      return {
        label: 'Processing…',
        caption: 'Please wait while AI reviews your recording',
        disabled: true,
        mode: 'processing'
      };
    }

    if (phase === 'review') {
      return {
        label: 'Record again',
        caption: 'Discard this take and speak it again',
        disabled: false,
        mode: 'redo'
      };
    }

    if (phase === 'error') {
      return {
        label: 'Record again',
        caption: hasAudio ? 'Discard this take and try again' : 'Try another recording',
        disabled: false,
        mode: 'redo'
      };
    }

    return {
      label: 'Start recording',
      caption: 'Speak one expense, then stop to process it',
      disabled: false,
      mode: 'start'
    };
  }

  return {
    PARTNER_ALIASES: PARTNER_ALIASES.slice(),
    createEmptyVoiceDraft: createEmptyVoiceDraft,
    formatVoiceDuration: formatVoiceDuration,
    getVoiceHeroActionState: getVoiceHeroActionState,
    getVoicePrimaryActionState: getVoicePrimaryActionState,
    normalizePartnerAlias: normalizePartnerAlias,
    normalizeVoiceExtraction: normalizeVoiceExtraction,
    shouldApplyVoiceVersion: shouldApplyVoiceVersion,
    toISODate: toISODate
  };
});
