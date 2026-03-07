const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createEmptyVoiceDraft,
  formatVoiceDuration,
  getVoiceHeroActionState,
  getVoicePrimaryActionState,
  normalizeVoiceExtraction,
  shouldApplyVoiceVersion
} = require('../voice-utils.js');

test('creates an empty voice draft with explicit default provenance flags', function () {
  const draft = createEmptyVoiceDraft('2026-03-05');

  assert.equal(draft.amount, null);
  assert.equal(draft.dateIso, '2026-03-05');
  assert.deepEqual(draft.defaultedFields, {
    date: false,
    partnerShare: false
  });
});

test('normalizes an explicit model draft without defaulting confirmed fields', function () {
  const draft = normalizeVoiceExtraction({
    amount: '45.23',
    description: 'Rewe shopping',
    date_iso: '2026-03-04',
    partner_share_mode: 'fixed',
    partner_share_value: '21.50',
    partner_alias: 'wife',
    confidence: {
      amount: 0.91,
      description: 0.88,
      date: 0.73,
      partner_share: 0.8
    },
    is_complete: true
  }, { todayIso: '2026-03-05' });

  assert.equal(draft.amount, 45.23);
  assert.equal(draft.description, 'Rewe shopping');
  assert.equal(draft.dateIso, '2026-03-04');
  assert.equal(draft.partnerShareMode, 'fixed');
  assert.equal(draft.partnerShareValue, 21.5);
  assert.equal(draft.partnerAlias, 'wife');
  assert.deepEqual(draft.defaultedFields, {
    date: false,
    partnerShare: false
  });
});

test('materializes date and split defaults when the model leaves them unresolved', function () {
  const draft = normalizeVoiceExtraction({
    amount: '18.50',
    description: '',
    date_iso: null,
    partner_share_mode: null,
    partner_share_value: null,
    partner_alias: '',
    confidence: {
      amount: 0.93,
      description: 0.12,
      date: 0.99,
      partner_share: 0.99
    },
    is_complete: true
  }, { todayIso: '2026-03-05' });

  assert.equal(draft.amount, 18.5);
  assert.equal(draft.dateIso, '2026-03-05');
  assert.equal(draft.partnerShareMode, 'percent');
  assert.equal(draft.partnerShareValue, 50);
  assert.equal(draft.confidence.date, 0);
  assert.equal(draft.confidence.partnerShare, 0);
  assert.deepEqual(draft.defaultedFields, {
    date: true,
    partnerShare: true
  });
});

test('falls back to an empty draft when extraction output is invalid', function () {
  const draft = normalizeVoiceExtraction(null, { todayIso: '2026-03-05' });

  assert.equal(draft.amount, null);
  assert.equal(draft.source, 'empty');
  assert.deepEqual(draft.defaultedFields, {
    date: false,
    partnerShare: false
  });
});

test('formats elapsed recording time as minutes and seconds', function () {
  assert.equal(formatVoiceDuration(0), '0:00');
  assert.equal(formatVoiceDuration(12_345), '0:12');
  assert.equal(formatVoiceDuration(65_000), '1:05');
});

test('returns a hidden header action outside review', function () {
  const action = getVoicePrimaryActionState({
    phase: 'processing',
    draft: createEmptyVoiceDraft('2026-03-05'),
    isSaving: false
  });

  assert.deepEqual(action, {
    label: '',
    disabled: true,
    visible: false,
    mode: 'hidden'
  });
});

test('returns save in review and disables it when amount is missing', function () {
  const action = getVoicePrimaryActionState({
    phase: 'review',
    draft: createEmptyVoiceDraft('2026-03-05'),
    isSaving: false
  });

  assert.deepEqual(action, {
    label: 'Save',
    disabled: true,
    visible: true,
    mode: 'save'
  });
});

test('returns saving while a reviewed draft is being persisted', function () {
  const action = getVoicePrimaryActionState({
    phase: 'review',
    draft: normalizeVoiceExtraction({
      amount: 12.3,
      description: '',
      date_iso: '2026-03-05',
      partner_share_mode: 'percent',
      partner_share_value: 30,
      partner_alias: '',
      confidence: {
        amount: 0.9,
        description: 0.3,
        date: 0.8,
        partner_share: 0.7
      },
      is_complete: true
    }, { todayIso: '2026-03-05' }),
    isSaving: true
  });

  assert.deepEqual(action, {
    label: 'Saving…',
    disabled: true,
    visible: true,
    mode: 'saving'
  });
});

test('returns start recording hero state in idle', function () {
  const action = getVoiceHeroActionState({
    phase: 'idle',
    isSupported: true,
    elapsedLabel: '0:00',
    hasAudio: false
  });

  assert.deepEqual(action, {
    label: 'Start recording',
    caption: 'Speak one expense, then stop to process it',
    disabled: false,
    mode: 'start'
  });
});

test('returns stop recording hero state while actively recording', function () {
  const action = getVoiceHeroActionState({
    phase: 'recording',
    isSupported: true,
    elapsedLabel: '0:21',
    hasAudio: false
  });

  assert.deepEqual(action, {
    label: 'Stop recording',
    caption: '0:21',
    disabled: false,
    mode: 'stop'
  });
});

test('returns record again hero state after an error with retryable audio', function () {
  const action = getVoiceHeroActionState({
    phase: 'error',
    isSupported: true,
    elapsedLabel: '0:00',
    hasAudio: true
  });

  assert.deepEqual(action, {
    label: 'Record again',
    caption: 'Discard this take and try again',
    disabled: false,
    mode: 'redo'
  });
});

test('returns unsupported hero state when voice capture is unavailable', function () {
  const action = getVoiceHeroActionState({
    phase: 'idle',
    isSupported: false,
    elapsedLabel: '0:00',
    hasAudio: false
  });

  assert.deepEqual(action, {
    label: 'Voice unavailable',
    caption: 'Use manual entry on this device',
    disabled: true,
    mode: 'unsupported'
  });
});

test('rejects stale processing versions', function () {
  assert.equal(shouldApplyVoiceVersion(3, 2), false);
  assert.equal(shouldApplyVoiceVersion(3, 4), true);
});
