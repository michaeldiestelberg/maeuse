const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyIncrementalHeuristicDraft,
  composeTranscriptText,
  mergeVoiceDraft,
  normalizeVoiceExtraction,
  parseTranscriptDraft,
  resolveCommittedTurnOrder,
  resolveSpokenDate,
  shouldApplyVoiceVersion
} = require('../voice-utils.js');

test('parses the full example transcript into the expected draft', function () {
  const draft = parseTranscriptDraft(
    'Add 45 Euro and 23 Cents for todays Rewe shopping. I want to split this 50%. No actually, let\'s track 21 Euro and 50 Cents for my wife.',
    { todayIso: '2026-03-05' }
  );

  assert.equal(draft.amount, 45.23);
  assert.equal(draft.description, 'Rewe shopping');
  assert.equal(draft.dateIso, '2026-03-05');
  assert.equal(draft.partnerShareMode, 'fixed');
  assert.equal(draft.partnerShareValue, 21.5);
  assert.equal(draft.partnerAlias, 'wife');
});

test('later fixed amounts override earlier percent splits', function () {
  const draft = parseTranscriptDraft(
    'Split this 50%. No actually, make that 21 Euro and 50 Cents for my wife.',
    { todayIso: '2026-03-05' }
  );

  assert.equal(draft.partnerShareMode, 'fixed');
  assert.equal(draft.partnerShareValue, 21.5);
});

test('supports euro cents and decimal amount formats', function () {
  assert.equal(
    parseTranscriptDraft('Add 45 Euro and 23 Cents for groceries.', { todayIso: '2026-03-05' }).amount,
    45.23
  );
  assert.equal(
    parseTranscriptDraft('Add 45,23 for groceries.', { todayIso: '2026-03-05' }).amount,
    45.23
  );
  assert.equal(
    parseTranscriptDraft('Add 45.23 for groceries.', { todayIso: '2026-03-05' }).amount,
    45.23
  );
});

test('resolves today, yesterday, and weekday names against a base date', function () {
  assert.equal(resolveSpokenDate('today', { todayIso: '2026-03-05' }), '2026-03-05');
  assert.equal(resolveSpokenDate('yesterday', { todayIso: '2026-03-05' }), '2026-03-04');
  assert.equal(resolveSpokenDate('monday', { todayIso: '2026-03-05' }), '2026-03-02');
  assert.equal(resolveSpokenDate('next monday', { todayIso: '2026-03-05' }), '2026-03-09');
});

test('detects partner aliases flexibly', function () {
  const husbandDraft = parseTranscriptDraft('Track 18 Euro for my husband.', { todayIso: '2026-03-05' });
  const spouseDraft = parseTranscriptDraft('Split 30% with my spouse.', { todayIso: '2026-03-05' });

  assert.equal(husbandDraft.partnerAlias, 'husband');
  assert.equal(spouseDraft.partnerAlias, 'spouse');
});

test('normalizes structured model output into the app draft shape', function () {
  const draft = normalizeVoiceExtraction({
    amount: '45.23',
    description: 'Rewe shopping',
    date_iso: '2026-03-05',
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
  assert.equal(draft.partnerShareMode, 'fixed');
  assert.equal(draft.partnerShareValue, 21.5);
  assert.equal(draft.partnerAlias, 'wife');
  assert.equal(draft.isComplete, true);
});

test('keeps transcription turn order stable when commits arrive out of order', function () {
  const order = resolveCommittedTurnOrder([
    { itemId: 'turn-c', previousItemId: 'turn-b' },
    { itemId: 'turn-a', previousItemId: null },
    { itemId: 'turn-b', previousItemId: 'turn-a' }
  ]);
  const transcript = composeTranscriptText(order, {
    'turn-a': 'first part',
    'turn-b': 'second part',
    'turn-c': 'third part'
  });

  assert.deepEqual(order, ['turn-a', 'turn-b', 'turn-c']);
  assert.equal(transcript, 'first part second part third part');
});

test('rejects stale extraction versions', function () {
  assert.equal(shouldApplyVoiceVersion(3, 2), false);
  assert.equal(shouldApplyVoiceVersion(3, 4), true);
});

test('preserves unrelated preview fields while heuristic updates a single card', function () {
  const currentDraft = {
    amount: 45.23,
    description: 'Saturday market',
    dateIso: '2026-03-05',
    partnerShareMode: 'percent',
    partnerShareValue: 50,
    partnerAlias: '',
    confidence: {
      amount: 0.95,
      description: 0.9,
      date: 0.8,
      partnerShare: 0.7
    },
    isComplete: true,
    source: 'model'
  };

  const heuristicDraft = {
    amount: 45.23,
    description: 'Rewe shopping',
    dateIso: '2026-03-04',
    partnerShareMode: 'fixed',
    partnerShareValue: 21.5,
    partnerAlias: 'wife',
    confidence: {
      amount: 0.84,
      description: 0.58,
      date: 0.72,
      partnerShare: 0.92
    },
    isComplete: true,
    source: 'heuristic'
  };

  const nextDraft = applyIncrementalHeuristicDraft(
    currentDraft,
    heuristicDraft,
    'Add 45 Euro and 23 Cents for todays Rewe shopping. No actually, track 21 Euro and 50 Cents for my wife.',
    '2026-03-05',
    'No actually, track 21 Euro and 50 Cents for my wife.'
  );

  assert.equal(nextDraft.amount, 45.23);
  assert.equal(nextDraft.description, 'Saturday market');
  assert.equal(nextDraft.dateIso, '2026-03-05');
  assert.equal(nextDraft.partnerShareMode, 'fixed');
  assert.equal(nextDraft.partnerShareValue, 21.5);
  assert.equal(nextDraft.partnerAlias, 'wife');
});

test('keeps untouched fields when model output marks only one field as updated', function () {
  const currentDraft = {
    amount: 45.23,
    description: 'Saturday market',
    dateIso: '2026-03-05',
    partnerShareMode: 'fixed',
    partnerShareValue: 21.5,
    partnerAlias: 'wife',
    confidence: {
      amount: 0.93,
      description: 0.88,
      date: 0.78,
      partnerShare: 0.91
    },
    isComplete: true,
    source: 'model'
  };

  const normalized = normalizeVoiceExtraction({
    amount: 12.34,
    description: 'Old groceries',
    date_iso: '2026-03-04',
    partner_share_mode: 'percent',
    partner_share_value: 50,
    partner_alias: '',
    updated_fields: {
      amount: false,
      description: false,
      date: true,
      partner_share: false
    },
    confidence: {
      amount: 0.22,
      description: 0.19,
      date: 0.84,
      partner_share: 0.17
    },
    is_complete: true
  }, { todayIso: '2026-03-05' });

  const nextDraft = mergeVoiceDraft(currentDraft, normalized);

  assert.equal(nextDraft.amount, 45.23);
  assert.equal(nextDraft.description, 'Saturday market');
  assert.equal(nextDraft.dateIso, '2026-03-04');
  assert.equal(nextDraft.partnerShareMode, 'fixed');
  assert.equal(nextDraft.partnerShareValue, 21.5);
  assert.equal(nextDraft.partnerAlias, 'wife');
});
