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

  const WEEKDAY_INDEX = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6
  };

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

  function fromISODate(iso) {
    if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    const date = new Date(iso + 'T00:00:00');
    if (Number.isNaN(date.getTime())) return null;
    return date;
  }

  function shiftISODate(baseIso, amount) {
    const baseDate = fromISODate(baseIso);
    if (!baseDate) return baseIso;
    baseDate.setDate(baseDate.getDate() + amount);
    return toISODate(baseDate);
  }

  function getMostRecentWeekday(baseIso, weekdayIndex) {
    const baseDate = fromISODate(baseIso);
    if (!baseDate) return baseIso;
    const diff = (baseDate.getDay() - weekdayIndex + 7) % 7;
    baseDate.setDate(baseDate.getDate() - diff);
    return toISODate(baseDate);
  }

  function getRelativeWeekday(baseIso, weekdayIndex, direction) {
    const baseDate = fromISODate(baseIso);
    if (!baseDate) return baseIso;
    const currentDay = baseDate.getDay();
    let diff;

    if (direction === 'next') {
      diff = (weekdayIndex - currentDay + 7) % 7;
      if (diff === 0) diff = 7;
      baseDate.setDate(baseDate.getDate() + diff);
      return toISODate(baseDate);
    }

    diff = (currentDay - weekdayIndex + 7) % 7;
    if (diff === 0) diff = 7;
    baseDate.setDate(baseDate.getDate() - diff);
    return toISODate(baseDate);
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
      dateIso: todayIso,
      partnerShareMode: null,
      partnerShareValue: null,
      partnerAlias: '',
      confidence: {
        amount: 0,
        description: 0,
        date: 0,
        partnerShare: 0
      },
      isComplete: false,
      source: 'empty'
    };
  }

  function findPartnerAliasInWindow(text, startIndex, endIndex) {
    const snippet = text.slice(Math.max(0, startIndex - 24), Math.min(text.length, endIndex + 36)).toLowerCase();
    const match = snippet.match(/\b(?:my\s+)?(wife|husband|spouse|partner|girlfriend|boyfriend|fiance|fiancee)\b/);
    return normalizePartnerAlias(match ? match[1] : '');
  }

  function extractMoneyMentions(text) {
    const mentions = [];
    const occupied = [];
    const euroRegex = /\b(\d+(?:[.,]\d{1,2})?)\s*(?:€|euro|euros)\b(?:\s*(?:and)?\s*(\d{1,2})\s*(?:cent|cents))?/gi;
    const decimalRegex = /\b(\d+[.,]\d{1,2})\b(?!\s*(?:%|percent))(?!(?:\s*(?:cent|cents)))/gi;

    let match;
    while ((match = euroRegex.exec(text))) {
      const euros = parseLooseNumber(match[1]);
      const cents = match[2] ? parseLooseNumber(match[2]) : null;
      let amount = euros;

      if (amount === null) continue;
      if (cents !== null) {
        amount = Math.trunc(amount) + (cents / 100);
      }

      mentions.push({
        amount: roundMoney(amount),
        index: match.index,
        endIndex: match.index + match[0].length,
        text: match[0]
      });
      occupied.push([match.index, match.index + match[0].length]);
    }

    while ((match = decimalRegex.exec(text))) {
      const startIndex = match.index;
      const endIndex = match.index + match[0].length;
      const overlaps = occupied.some(function (range) {
        return startIndex < range[1] && endIndex > range[0];
      });

      if (overlaps) continue;

      mentions.push({
        amount: roundMoney(parseLooseNumber(match[1])),
        index: startIndex,
        endIndex: endIndex,
        text: match[0]
      });
    }

    return mentions
      .filter(function (mention) {
        return mention.amount !== null;
      })
      .sort(function (a, b) {
        return a.index - b.index;
      });
  }

  function resolveSpokenDate(transcript, options) {
    const todayIso = options && options.todayIso ? options.todayIso : toISODate(new Date());
    const text = normalizeWhitespace(transcript).toLowerCase();

    if (!text) return todayIso;

    let resolvedDate = todayIso;
    let match;

    const relativeRegex = /\b(today'?s?|todays?|yesterday|tomorrow)\b/g;
    while ((match = relativeRegex.exec(text))) {
      const token = match[1];
      if (token.indexOf('yesterday') === 0) {
        resolvedDate = shiftISODate(todayIso, -1);
      } else if (token.indexOf('tomorrow') === 0) {
        resolvedDate = shiftISODate(todayIso, 1);
      } else {
        resolvedDate = todayIso;
      }
    }

    const directionalWeekdayRegex = /\b(last|next)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g;
    while ((match = directionalWeekdayRegex.exec(text))) {
      resolvedDate = getRelativeWeekday(todayIso, WEEKDAY_INDEX[match[2]], match[1]);
    }

    const weekdayRegex = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g;
    while ((match = weekdayRegex.exec(text))) {
      const before = text.slice(Math.max(0, match.index - 5), match.index);
      if (/last\s*$/.test(before) || /next\s*$/.test(before)) continue;
      resolvedDate = getMostRecentWeekday(todayIso, WEEKDAY_INDEX[match[1]]);
    }

    const isoRegex = /\b(\d{4}-\d{2}-\d{2})\b/g;
    while ((match = isoRegex.exec(text))) {
      if (isValidDateString(match[1])) {
        resolvedDate = match[1];
      }
    }

    const europeanRegex = /\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/g;
    while ((match = europeanRegex.exec(text))) {
      const day = Number(match[1]);
      const month = Number(match[2]);
      const providedYear = match[3] ? Number(match[3].length === 2 ? '20' + match[3] : match[3]) : null;
      const year = Number.isFinite(providedYear) ? providedYear : Number(todayIso.slice(0, 4));
      const candidate = year + '-' + pad2(month) + '-' + pad2(day);
      if (isValidDateString(candidate)) {
        resolvedDate = candidate;
      }
    }

    return resolvedDate;
  }

  function extractDescription(text, totalMention) {
    if (!totalMention) return '';

    const trailingText = text.slice(totalMention.endIndex);
    const stopMatch = trailingText.match(/\b(?:i want to split|split this|split it|split|partner share|no actually|actually|instead|make that|scratch that)\b/i);
    const candidate = stopMatch ? trailingText.slice(0, stopMatch.index) : trailingText;
    const forMatch = candidate.match(/\bfor\s+(.+)$/i);
    const atMatch = candidate.match(/\bat\s+(.+)$/i);
    let description = forMatch ? forMatch[1] : atMatch ? atMatch[1] : '';

    description = description
      .replace(/\b(today'?s?|todays?|yesterday'?s?|tomorrow'?s?)\b/gi, '')
      .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '')
      .replace(/^(?:the|a|an)\s+/i, '');

    if (!description) return '';
    if (/\b(?:wife|husband|spouse|partner|girlfriend|boyfriend|fiance|fiancee)\b/i.test(description)) {
      return '';
    }

    return normalizeWhitespace(description);
  }

  function parsePercentMentions(text) {
    const mentions = [];
    const percentRegex = /(?:\b(\d+(?:[.,]\d+)?)\s*%|\b(\d+(?:[.,]\d+)?)\s*percent\b)/gi;
    const halfRegex = /\bhalf\b/gi;
    let match;

    while ((match = percentRegex.exec(text))) {
      const value = parseLooseNumber(match[1] || match[2]);
      if (value === null) continue;
      mentions.push({
        value: value,
        index: match.index,
        endIndex: match.index + match[0].length
      });
    }

    while ((match = halfRegex.exec(text))) {
      mentions.push({
        value: 50,
        index: match.index,
        endIndex: match.index + match[0].length
      });
    }

    return mentions.sort(function (a, b) {
      return a.index - b.index;
    });
  }

  function parseTranscriptDraft(transcript, options) {
    const todayIso = options && options.todayIso ? options.todayIso : toISODate(new Date());
    const draft = createEmptyVoiceDraft(todayIso);
    const text = normalizeWhitespace(transcript);
    const lowerText = text.toLowerCase();
    const moneyMentions = extractMoneyMentions(text);
    const percentMentions = parsePercentMentions(text);
    let totalMention = null;

    draft.dateIso = resolveSpokenDate(text, { todayIso: todayIso });
    draft.confidence.date = draft.dateIso === todayIso && !/\b(today|yesterday|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday|\d{1,2}[./-]\d{1,2}|\d{4}-\d{2}-\d{2})\b/i.test(text)
      ? 0
      : 0.72;

    percentMentions.forEach(function (mention) {
      const context = lowerText.slice(Math.max(0, mention.index - 28), Math.min(lowerText.length, mention.endIndex + 28));
      if (!/\b(split|share|partner|wife|husband|spouse|girlfriend|boyfriend|fiance|fiancee)\b/.test(context)) return;
      draft.partnerShareMode = 'percent';
      draft.partnerShareValue = Math.min(Math.max(roundMoney(mention.value), 0), 100);
      draft.partnerAlias = findPartnerAliasInWindow(text, mention.index, mention.endIndex);
      draft.confidence.partnerShare = 0.68;
    });

    moneyMentions.forEach(function (mention, index) {
      const before = lowerText.slice(Math.max(0, mention.index - 30), mention.index);
      const after = lowerText.slice(mention.endIndex, Math.min(lowerText.length, mention.endIndex + 48));
      const nearbyBefore = lowerText.slice(Math.max(0, mention.index - 18), mention.index);
      const nearbyAfter = lowerText.slice(mention.endIndex, Math.min(lowerText.length, mention.endIndex + 28));
      const partnerContext = /\b(split|share)\b/.test(nearbyBefore)
        || /\b(?:for|to|with)\s+(?:my\s+)?(wife|husband|spouse|partner|girlfriend|boyfriend|fiance|fiancee)\b/.test(nearbyAfter)
        || /\b(wife|husband|spouse|partner|girlfriend|boyfriend|fiance|fiancee)\b/.test(nearbyBefore);
      const totalContext = /\b(add|spent|spend|paid|pay|cost|track|expense|total|log)\b/.test(before)
        || index === 0;

      if (partnerContext) {
        draft.partnerShareMode = 'fixed';
        draft.partnerShareValue = mention.amount;
        draft.partnerAlias = findPartnerAliasInWindow(text, mention.index, mention.endIndex);
        draft.confidence.partnerShare = 0.78;
        return;
      }

      if (totalContext || !draft.amount) {
        draft.amount = mention.amount;
        totalMention = mention;
        draft.confidence.amount = 0.84;
      }
    });

    draft.description = extractDescription(text, totalMention);
    draft.confidence.description = draft.description ? 0.58 : 0;
    draft.isComplete = !!(draft.amount && draft.amount > 0);
    draft.source = text ? 'heuristic' : 'empty';

    return draft;
  }

  function normalizeConfidence(value, fallback) {
    if (value === null || typeof value === 'undefined') return fallback;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(Math.max(numeric, 0), 1);
  }

  function normalizeUpdatedFields(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      amount: !!source.amount,
      description: !!source.description,
      date: !!source.date,
      partnerShare: !!(source.partner_share ?? source.partnerShare)
    };
  }

  function detectVoiceFieldTouches(transcript, options) {
    const todayIso = options && options.todayIso ? options.todayIso : toISODate(new Date());
    const text = normalizeWhitespace(transcript);
    const lowerText = text.toLowerCase();
    const draft = options && options.draft ? options.draft : parseTranscriptDraft(text, { todayIso: todayIso });
    const descriptionTailMatch = text.match(/\b(?:for|at)\s+([^.!?]+)$/i);
    const descriptionTail = descriptionTailMatch ? normalizeWhitespace(descriptionTailMatch[1]) : '';
    const hasDescriptionTail = !!(
      descriptionTail &&
      !/\b(?:wife|husband|spouse|partner|girlfriend|boyfriend|fiance|fiancee)\b/i.test(descriptionTail)
    );

    return {
      amount: draft.amount !== null || (/\d/.test(text) && /\b(?:euro|euros|cent|cents|amount|total|cost|spent|spend|paid|pay|track|log|expense)\b/i.test(lowerText)),
      description: !!draft.description || hasDescriptionTail || /\bdescription\b/i.test(lowerText),
      date: draft.confidence && draft.confidence.date >= 0.65,
      partnerShare: !!draft.partnerShareMode || /\b(?:split|share|wife|husband|spouse|partner|girlfriend|boyfriend|fiance|fiancee)\b/i.test(lowerText)
    };
  }

  function normalizeVoiceExtraction(raw, options) {
    const todayIso = options && options.todayIso ? options.todayIso : toISODate(new Date());
    const fallback = createEmptyVoiceDraft(todayIso);

    if (!raw || typeof raw !== 'object') return fallback;

    const amount = roundMoney(Number(raw.amount));
    const description = normalizeWhitespace(raw.description || '');
    const candidateDate = typeof raw.date_iso === 'string' ? raw.date_iso : typeof raw.dateIso === 'string' ? raw.dateIso : '';
    const dateIso = isValidDateString(candidateDate) ? candidateDate : null;
    const partnerShareMode = raw.partner_share_mode === 'fixed' || raw.partnerShareMode === 'fixed'
      ? 'fixed'
      : raw.partner_share_mode === 'percent' || raw.partnerShareMode === 'percent'
        ? 'percent'
        : null;
    const rawPartnerValue = raw.partner_share_value ?? raw.partnerShareValue;
    const partnerShareValue = roundMoney(Number(rawPartnerValue));
    const normalizedPartnerValue = partnerShareMode === 'percent'
      ? Math.min(Math.max(partnerShareValue === null ? 0 : partnerShareValue, 0), 100)
      : partnerShareMode === 'fixed'
        ? Math.max(partnerShareValue === null ? 0 : partnerShareValue, 0)
        : null;
    const partnerAlias = normalizePartnerAlias(raw.partner_alias || raw.partnerAlias || '');
    const confidence = raw.confidence && typeof raw.confidence === 'object' ? raw.confidence : {};
    const updatedFields = normalizeUpdatedFields(raw.updated_fields || raw.updatedFields);

    return {
      amount: amount && amount > 0 ? amount : null,
      description: description,
      dateIso: dateIso,
      partnerShareMode: partnerShareMode,
      partnerShareValue: normalizedPartnerValue,
      partnerAlias: partnerAlias,
      updatedFields: updatedFields,
      confidence: {
        amount: normalizeConfidence(confidence.amount, amount && amount > 0 ? 0.85 : 0),
        description: normalizeConfidence(confidence.description, description ? 0.65 : 0),
        date: normalizeConfidence(confidence.date, dateIso ? 0.65 : 0),
        partnerShare: normalizeConfidence(confidence.partner_share ?? confidence.partnerShare, partnerShareMode ? 0.7 : 0)
      },
      isComplete: typeof raw.is_complete === 'boolean' ? raw.is_complete : !!(amount && amount > 0),
      source: 'model'
    };
  }

  function mergeVoiceDraft(baseDraft, incomingDraft) {
    const base = baseDraft || createEmptyVoiceDraft(incomingDraft && incomingDraft.dateIso ? incomingDraft.dateIso : toISODate(new Date()));
    const incoming = incomingDraft || {};
    const hasUpdatedFields = !!(incoming.updatedFields && typeof incoming.updatedFields === 'object');
    const updatedFields = hasUpdatedFields ? normalizeUpdatedFields(incoming.updatedFields) : null;
    const nextAmount = hasUpdatedFields
      ? (updatedFields.amount ? incoming.amount : base.amount)
      : (incoming.amount !== null && typeof incoming.amount !== 'undefined' ? incoming.amount : base.amount);
    const nextDescription = hasUpdatedFields
      ? (updatedFields.description ? incoming.description : base.description)
      : (incoming.description ? incoming.description : base.description);
    const nextDateIso = hasUpdatedFields
      ? (updatedFields.date && incoming.dateIso ? incoming.dateIso : base.dateIso)
      : (incoming.dateIso || base.dateIso);
    const nextPartnerShareMode = hasUpdatedFields
      ? (updatedFields.partnerShare ? incoming.partnerShareMode : base.partnerShareMode)
      : (incoming.partnerShareMode !== null && typeof incoming.partnerShareMode !== 'undefined'
          ? incoming.partnerShareMode
          : base.partnerShareMode);
    const nextPartnerShareValue = hasUpdatedFields
      ? (updatedFields.partnerShare ? incoming.partnerShareValue : base.partnerShareValue)
      : (incoming.partnerShareValue !== null && typeof incoming.partnerShareValue !== 'undefined'
          ? incoming.partnerShareValue
          : base.partnerShareValue);
    const nextPartnerAlias = hasUpdatedFields
      ? (updatedFields.partnerShare ? (incoming.partnerAlias || '') : (base.partnerAlias || ''))
      : (incoming.partnerAlias || base.partnerAlias || '');
    const nextConfidence = {
      amount: hasUpdatedFields && !updatedFields.amount
        ? (base.confidence ? base.confidence.amount : 0)
        : normalizeConfidence(incoming.confidence && incoming.confidence.amount, base.confidence ? base.confidence.amount : 0),
      description: hasUpdatedFields && !updatedFields.description
        ? (base.confidence ? base.confidence.description : 0)
        : normalizeConfidence(incoming.confidence && incoming.confidence.description, base.confidence ? base.confidence.description : 0),
      date: hasUpdatedFields && !updatedFields.date
        ? (base.confidence ? base.confidence.date : 0)
        : normalizeConfidence(incoming.confidence && incoming.confidence.date, base.confidence ? base.confidence.date : 0),
      partnerShare: hasUpdatedFields && !updatedFields.partnerShare
        ? (base.confidence ? base.confidence.partnerShare : 0)
        : normalizeConfidence(
            incoming.confidence && (incoming.confidence.partnerShare ?? incoming.confidence.partner_share),
            base.confidence ? base.confidence.partnerShare : 0
          )
    };

    return {
      amount: nextAmount,
      description: nextDescription,
      dateIso: nextDateIso,
      partnerShareMode: nextPartnerShareMode,
      partnerShareValue: nextPartnerShareValue,
      partnerAlias: nextPartnerAlias,
      updatedFields: updatedFields || undefined,
      confidence: nextConfidence,
      isComplete: !!(nextAmount && nextAmount > 0),
      source: incoming.source || base.source || 'empty'
    };
  }

  function applyIncrementalHeuristicDraft(currentDraft, heuristicDraft, transcriptText, todayIso, focusTranscriptText) {
    const parsedHeuristicDraft = heuristicDraft || createEmptyVoiceDraft(todayIso || toISODate(new Date()));
    const focusText = normalizeWhitespace(focusTranscriptText || transcriptText);
    const focusDraft = focusText && focusText !== normalizeWhitespace(transcriptText)
      ? parseTranscriptDraft(focusText, { todayIso: todayIso || toISODate(new Date()) })
      : parsedHeuristicDraft;
    const touchedFields = detectVoiceFieldTouches(focusText, {
      todayIso: todayIso || toISODate(new Date()),
      draft: focusDraft
    });
    const baseDraft = currentDraft || createEmptyVoiceDraft(todayIso || toISODate(new Date()));
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
      return createEmptyVoiceDraft(todayIso || toISODate(new Date()));
    }

    if (touchedFields.amount && focusDraft.amount !== null && typeof focusDraft.amount !== 'undefined') {
      nextDraft.amount = focusDraft.amount;
      nextDraft.confidence.amount = focusDraft.confidence.amount;
    } else if (baseDraft.amount === null && parsedHeuristicDraft.amount !== null && typeof parsedHeuristicDraft.amount !== 'undefined') {
      nextDraft.amount = parsedHeuristicDraft.amount;
      nextDraft.confidence.amount = parsedHeuristicDraft.confidence.amount;
    }

    if (touchedFields.description && focusDraft.description) {
      nextDraft.description = focusDraft.description;
      nextDraft.confidence.description = focusDraft.confidence.description;
    } else if (!baseDraft.description && parsedHeuristicDraft.description) {
      nextDraft.description = parsedHeuristicDraft.description;
      nextDraft.confidence.description = parsedHeuristicDraft.confidence.description;
    }

    if (touchedFields.date && focusDraft.dateIso && focusDraft.confidence.date >= 0.65) {
      nextDraft.dateIso = focusDraft.dateIso;
      nextDraft.confidence.date = focusDraft.confidence.date;
    } else if ((!baseDraft.dateIso || (baseDraft.confidence && baseDraft.confidence.date === 0))
      && parsedHeuristicDraft.dateIso
      && parsedHeuristicDraft.confidence.date >= 0.65) {
      nextDraft.dateIso = parsedHeuristicDraft.dateIso;
      nextDraft.confidence.date = parsedHeuristicDraft.confidence.date;
    }

    if (
      touchedFields.partnerShare &&
      focusDraft.partnerShareMode &&
      focusDraft.partnerShareValue !== null &&
      typeof focusDraft.partnerShareValue !== 'undefined'
    ) {
      nextDraft.partnerShareMode = focusDraft.partnerShareMode;
      nextDraft.partnerShareValue = focusDraft.partnerShareValue;
      nextDraft.partnerAlias = focusDraft.partnerAlias || nextDraft.partnerAlias || '';
      nextDraft.confidence.partnerShare = focusDraft.confidence.partnerShare;
    } else if (
      !baseDraft.partnerShareMode &&
      parsedHeuristicDraft.partnerShareMode &&
      parsedHeuristicDraft.partnerShareValue !== null &&
      typeof parsedHeuristicDraft.partnerShareValue !== 'undefined'
    ) {
      nextDraft.partnerShareMode = parsedHeuristicDraft.partnerShareMode;
      nextDraft.partnerShareValue = parsedHeuristicDraft.partnerShareValue;
      nextDraft.partnerAlias = parsedHeuristicDraft.partnerAlias || nextDraft.partnerAlias || '';
      nextDraft.confidence.partnerShare = parsedHeuristicDraft.confidence.partnerShare;
    }

    nextDraft.isComplete = !!(nextDraft.amount && nextDraft.amount > 0);
    nextDraft.source = parsedHeuristicDraft.source || nextDraft.source || 'heuristic';
    return nextDraft;
  }

  function resolveCommittedTurnOrder(commits) {
    const pending = Array.isArray(commits) ? commits.slice() : [];
    const order = [];
    const seen = new Set();
    let progressed = true;

    while (progressed) {
      progressed = false;
      pending.forEach(function (commit) {
        if (!commit || !commit.itemId || seen.has(commit.itemId)) return;
        if (!commit.previousItemId || seen.has(commit.previousItemId) || !pending.some(function (entry) { return entry && entry.itemId === commit.previousItemId; })) {
          order.push(commit.itemId);
          seen.add(commit.itemId);
          progressed = true;
        }
      });
    }

    pending.forEach(function (commit) {
      if (!commit || !commit.itemId || seen.has(commit.itemId)) return;
      order.push(commit.itemId);
      seen.add(commit.itemId);
    });

    return order;
  }

  function composeTranscriptText(order, textById) {
    if (!Array.isArray(order) || !textById || typeof textById !== 'object') return '';
    return order
      .map(function (itemId) {
        return normalizeWhitespace(textById[itemId] || '');
      })
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  function shouldApplyVoiceVersion(latestAppliedVersion, candidateVersion) {
    return Number(candidateVersion) > Number(latestAppliedVersion);
  }

  return {
    PARTNER_ALIASES: PARTNER_ALIASES.slice(),
    composeTranscriptText: composeTranscriptText,
    createEmptyVoiceDraft: createEmptyVoiceDraft,
    detectVoiceFieldTouches: detectVoiceFieldTouches,
    applyIncrementalHeuristicDraft: applyIncrementalHeuristicDraft,
    mergeVoiceDraft: mergeVoiceDraft,
    normalizePartnerAlias: normalizePartnerAlias,
    normalizeVoiceExtraction: normalizeVoiceExtraction,
    parseTranscriptDraft: parseTranscriptDraft,
    resolveCommittedTurnOrder: resolveCommittedTurnOrder,
    resolveSpokenDate: resolveSpokenDate,
    shouldApplyVoiceVersion: shouldApplyVoiceVersion,
    toISODate: toISODate
  };
});
