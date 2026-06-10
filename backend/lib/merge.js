// Phase 2 caption merge logic, shared between backend/server.js and the eval harness.

// Helper: Merge accepted suggestions + assigned WhisperX timing into original captions.
function mergeCaptionSuggestions(originalCaptions, suggestions, isPartial, assignedTiming = new Map(), timingUpdateFailed = new Set(), splitRemainderTiming = new Map()) {
  const MIN_DURATION_MS = 240;
  const suggestionsMap = new Map(suggestions.map(s => [s.caption_index, s]));

  const merged = originalCaptions.map(cap => {
    const suggestion = suggestionsMap.get(cap.index);
    const isChanged = !!suggestion;

    let newText;
    let splitRemainder = null;
    if (isChanged) {
      const isDelete = suggestion.change_type === 'delete' ||
        suggestion.new_text === null ||
        suggestion.new_text === undefined ||
        (typeof suggestion.new_text === 'string' && suggestion.new_text.trim() === '');
      newText = isDelete ? '' : suggestion.new_text;
      if (suggestion.change_type === 'split' && suggestion.split_remainder?.trim()) {
        splitRemainder = suggestion.split_remainder.trim();
      }
    } else {
      newText = cap.text;
    }

    let startMs = cap.start_ms;
    let endMs = cap.end_ms;
    let timingWasChanged = false;

    const assigned = assignedTiming.get(cap.index);
    if (assigned) {
      if (Math.abs(assigned.startMs - startMs) > 10 || Math.abs(assigned.endMs - endMs) > 10) {
        timingWasChanged = true;
      }
      startMs = assigned.startMs;
      endMs = assigned.endMs;
    }

    return {
      index: cap.index,
      text: newText,
      italic: cap.italic,
      start_ms: startMs,
      end_ms: endMs,
      changed: isChanged,
      change_type: isChanged ? suggestion.change_type : null,
      reason: isChanged ? suggestion.reason : null,
      original_text: cap.text,
      timing_flag:          cap.timingFlag || null,
      timing_changed:       timingWasChanged,
      timing_source:        assigned ? 'whisperx' : 'stage1',
      timing_update_failed: timingUpdateFailed.has(cap.index),
      partial:              isPartial,
      ...(splitRemainder ? { _splitRemainder: splitRemainder } : {}),
    };
  });

  // Drop captions whose accepted suggestion deleted them (empty new_text)
  let surviving = merged.filter(c => c.text && c.text.trim().length > 0);

  // Redistribution-chain dedup: when Gemini shifts text forward through a chain
  // of consecutive captions, it sometimes forgets to issue a suggestion for the
  // last "donor" caption — leaving its original text as a duplicate of what the
  // previous (changed) caption already absorbed. Detect & drop those donors.
  // Window-based: check within ±8 captions, not just adjacent pairs.
  const normalizeForCompare = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const DEDUP_WINDOW = 8;
  const dedupFlags = new Array(surviving.length).fill(false);
  for (let i = 0; i < surviving.length; i++) {
    if (!surviving[i].changed || dedupFlags[i]) continue;
    // For splits, include split_remainder so we detect when new_text+remainder
    // together absorb a neighbouring caption that Gemini forgot to delete.
    const splitRemNorm = surviving[i]._splitRemainder ? ' ' + normalizeForCompare(surviving[i]._splitRemainder) : '';
    const changedNorm = normalizeForCompare(surviving[i].text) + splitRemNorm;
    if (changedNorm.length < 4) continue;
    for (let j = i + 1; j <= Math.min(i + DEDUP_WINDOW, surviving.length - 1); j++) {
      if (surviving[j].changed || dedupFlags[j]) continue;
      const uncNorm = normalizeForCompare(surviving[j].text);
      if (uncNorm.length < 4) continue;
      if (changedNorm.includes(uncNorm)) dedupFlags[j] = true;
    }
    for (let j = i - 1; j >= Math.max(0, i - DEDUP_WINDOW); j--) {
      if (surviving[j].changed || dedupFlags[j]) continue;
      const uncNorm = normalizeForCompare(surviving[j].text);
      if (uncNorm.length < 4) continue;
      if (changedNorm.includes(uncNorm)) dedupFlags[j] = true;
    }
  }
  if (dedupFlags.some(Boolean)) {
    surviving = surviving.filter((_, i) => !dedupFlags[i]);
  }

  // Expand splits: insert remainder caption immediately after the split parent.
  // Use WhisperX timing if available; otherwise fall back to a placeholder
  // starting at the parent's end (flagged timing_update_failed for manual review).
  if (surviving.some(c => c._splitRemainder)) {
    const expanded = [];
    for (const cap of surviving) {
      expanded.push(cap);
      if (cap._splitRemainder) {
        const remTiming = splitRemainderTiming.get(cap.index);
        expanded.push({
          index:                cap.index + 0.5,
          text:                 cap._splitRemainder,
          italic:               cap.italic,
          start_ms:             remTiming ? remTiming.startMs : cap.end_ms,
          end_ms:               remTiming ? remTiming.endMs   : cap.end_ms + MIN_DURATION_MS,
          changed:              true,
          change_type:          'split',
          reason:               cap.reason,
          original_text:        '',
          timing_flag:          null,
          timing_changed:       false,
          timing_source:        'whisperx',
          timing_update_failed: !remTiming,
          partial:              isPartial,
          words:                remTiming ? remTiming.words        : null,
          matched_ratio:        remTiming ? remTiming.matchedRatio : null,
        });
        delete cap._splitRemainder;
      }
    }
    surviving = expanded;
  }

  // Ensure 240ms minimum duration for all captions.
  for (const c of surviving) {
    if (c.end_ms < c.start_ms + MIN_DURATION_MS) {
      c.end_ms = c.start_ms + MIN_DURATION_MS;
    }
  }

  // Resolve overlaps. Stage 1 timing takes precedence over WhisperX: if a Stage 1
  // caption's end overlaps a WhisperX caption's start, push the WhisperX start
  // forward rather than trimming the Stage 1 end.
  for (let i = 1; i < surviving.length; i++) {
    const prev = surviving[i - 1];
    const curr = surviving[i];
    if (prev.end_ms > curr.start_ms) {
      if (prev.timing_source === 'stage1' && curr.timing_source === 'whisperx') {
        curr.start_ms = prev.end_ms;
        if (curr.end_ms < curr.start_ms + MIN_DURATION_MS) {
          curr.end_ms = curr.start_ms + MIN_DURATION_MS;
        }
      } else {
        prev.end_ms = Math.max(prev.start_ms + MIN_DURATION_MS, curr.start_ms);
        // If prev couldn't shrink far enough, push curr forward rather than leaving an overlap.
        if (prev.end_ms > curr.start_ms) {
          curr.start_ms = prev.end_ms;
          if (curr.end_ms < curr.start_ms + MIN_DURATION_MS) {
            curr.end_ms = curr.start_ms + MIN_DURATION_MS;
          }
        }
      }
    }
  }

  // Butt captions together — close any gaps so there is no blank-screen time between captions.
  for (let i = 0; i < surviving.length - 1; i++) {
    surviving[i].end_ms = Math.max(
      surviving[i].start_ms + MIN_DURATION_MS,
      surviving[i + 1].start_ms
    );
  }

  return surviving;
}

module.exports = { mergeCaptionSuggestions };
