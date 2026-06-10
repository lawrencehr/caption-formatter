// Shared Gemini logic for the Stage 2 Phase 1 pipeline.
// Used by backend/server.js (production) and test_system/gemini_eval (offline eval)
// so the prompt, generationConfig, parsing and filtering can never drift apart.

const GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.0-flash'];

// Gemini 3.x: temperature / top_p / top_k are no longer recommended; the
// model picks them internally. Use thinkingLevel (string) instead of the
// old thinkingBudget (number).  See:
//   https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.5
// For 2.x models, the old temperature + thinkingBudget shape still works.
function geminiConfigFor(model) {
  const isV3 = model.startsWith('gemini-3');
  if (isV3) {
    return {
      // 'low' = fast structured output, fewer reasoning steps — fits caption
      // refinement (deterministic remix, not deep reasoning). Bump to 'medium'
      // if quality drops on tricky episodes.
      thinkingConfig: { thinkingLevel: 'low' },
      maxOutputTokens: 65536,
    };
  }
  // 2.x fallback shape
  const cfg = { temperature: 0.1, maxOutputTokens: 65536 };
  // 2.5 supports thinking; 0 budget disables it for speed. 2.0 ignores it.
  cfg.thinkingConfig = { thinkingBudget: 0 };
  return cfg;
}

const NAME_TAG_RE = /^([A-Z][A-Z\s.\-']{1,40}:)/;
const NAME_TAG_RE_SPACED = /^([A-Z][A-Z\s.\-']{1,40}:)\s*/;

// Annotates raw captions with the metadata fields the prompt references
// (is_short, line_too_long, chars, max_chars, timing_flag).
function annotateCaptions(captions) {
  return captions.map(c => {
    const lines = c.text ? c.text.split('\n') : [];
    const nameTagMatch = lines.length > 0 && NAME_TAG_RE.test(lines[0]);
    // Word count check for "short" captions (excluding tags and name tags)
    const cleanTextForShortCheck = (c.text || '')
      .replace(/<[^>]*>/g, '')         // Strip ALL tags
      .replace(NAME_TAG_RE, '')        // Strip speaker label
      .trim();
    const wordCount = cleanTextForShortCheck ? cleanTextForShortCheck.split(/\s+/).length : 0;
    const isShort = wordCount > 0 && wordCount <= 3 && !nameTagMatch;

    // text arrives as a flat string (lines joined with spaces — no \n).
    // For name tag captions: line 1 is the tag, line 2 is the spoken text (max 30 chars).
    // For normal captions: two lines of 30 chars = 60 chars total.
    const nameTagM = (c.text || '').match(NAME_TAG_RE_SPACED);
    const spokenText = nameTagM ? c.text.slice(nameTagM[0].length).trim() : (c.text || '').trim();
    const lineTooLong = nameTagM ? spokenText.length > 30 : spokenText.length > 60;
    const effectiveMax = nameTagM ? 30 : 60;

    const realTimingFlag = c.timingFlag && c.timingFlag.startsWith('Timing needs') ? c.timingFlag : null;
    const entry = {
      index: c.index,
      text: c.text,
      italic: c.italic,
      ...(realTimingFlag ? { timing_flag: realTimingFlag } : {}),
      ...(isShort ? { is_short: true } : {}),
    };
    if (lineTooLong) {
      entry.line_too_long = true;
      entry.chars = spokenText.length;
      entry.max_chars = effectiveMax;
    }
    return entry;
  });
}

function buildGeminiPrompt(captions) {
  return `You are an expert caption editor for ABC Media Watch social media videos.
You will receive audio and a list of captions that have been auto-formatted from a Premiere Pro export.

Your job: review the captions against what is actually said in the audio, and suggest improvements where caption breaks fall in awkward places.

HARD CHARACTER LIMIT:
Every caption entry in the input has a chars field (current spoken-text length) and a max_chars field (the limit that applies — 60 for normal captions, 30 for name-tag captions where only the second line is available for spoken text). Before finalising any suggestion, verify new_text does not exceed max_chars. If it does, try a different redistribution or split — never return a suggestion whose new_text or split_remainder exceeds 60 characters. If no valid fix exists within the limit, return NO suggestion for that caption. Returning oversized text is never acceptable.

QUALITY THRESHOLD:
Suggest changes only where a caption break is clearly awkward — a hard cut mid-phrase, a name split across captions, a short caption that genuinely disrupts flow, or a boundary that lands in the wrong place relative to how the speaker pauses. The bar should be high: leave a caption alone if it reads naturally as a standalone phrase, even if a slightly different arrangement might be marginally better. A marginally better phrasing is not enough. Aim for targeted fixes, not an editorial pass.

THE GOLDEN RULE: ZERO TEXT LOSS
You MUST NOT edit, rephrase, or omit any words from the original captions. Your only task is to move the boundaries (the breaks) between captions. Every word in the input must appear exactly once in your output. No words can be added, and NO words can be deleted unless the entire caption is being merged into another.

PRIORITISE:
- Captions with a timing_flag field — their text has been moved by the Stage 1 formatter so boundaries are known to be wrong. If you want to move words between this caption and a neighbour to better fit the audio, return a suggestion. If the text already reads naturally and you are not moving any words, return NO suggestion — timing for flagged captions is updated automatically, so a "timing only" suggestion is unnecessary and will be discarded.
- Short captions (e.g. 1-3 words, flagged with is_short) — merge these with neighbors to improve flow unless they are name tags, or consist of a single emphatic word with an unmistakable audio pause both before and after.
- Captions where a person's name is split across two captions
- Caption breaks that fall mid-phrase or mid-thought when the audio has a natural pause elsewhere
- Captions that combine end-of-one-thought + start-of-another — prefer moving the boundary with a neighboring caption; only split if redistribution is blocked by name tag or italic rules

CRITICAL RULES FOR MOVING TEXT:
1. If you move words from one caption to another, you MUST return an update for BOTH captions to prevent duplicating text!
2. DO NOT DUPLICATE WORDS across captions.
3. CHAIN COMPLETENESS: when you shift text through a sequence, EVERY caption in the chain must have an update. If caption N consumes words from N+1, then N+1 MUST also have an update — either with its new shifted text, or with new_text="" if it was fully absorbed.
   Bad example: caption 5 absorbs "the decision" from caption 6 but no update is returned for caption 6 — "the decision" now appears in both captions.

NAME TAG RULE:
A speaker name tag (e.g. "LIAM BARTLETT:", "CHRIS BOWEN:") MUST always remain as the FIRST LINE of its own caption.
- NEVER move text from a preceding caption into a caption that starts with a name tag — it would push the name tag off the top line.
- NEVER move the name tag itself away from the start of its caption.
- When text following a name tag is too long, redistribute words with the caption AFTER the name tag caption, not the caption before it.

ITALIC BOUNDARY RULE (STRICT):
Never suggest changes that would merge text across italic/non-italic boundaries.
- If caption N is italic and caption N+1 is not italic (or vice versa), do NOT move text between them.
- Each caption must be ENTIRELY italic or ENTIRELY non-italic.
- If you need extra room to fix a long line but the neighbor has a different italic state, you MUST SPLIT the caption into two rather than crossing the boundary.

SPLIT IS A LAST RESORT:
Only use change_type "split" when you cannot move words to a neighboring caption because the name tag rule or italic boundary rule blocks redistribution AND the caption is genuinely too long. For all other cases — including "end-of-one-thought + start-of-another" — use phrase_break or merge to shift the boundary between existing captions instead.
NOTE: this last-resort rule does NOT apply to captions flagged with line_too_long: true — those must always be fixed. Prefer redistribution to a neighbour first; use a split only when redistribution is blocked by the name tag or italic boundary rules. But do something: leaving a line_too_long caption unchanged is never acceptable.

DO NOT CHANGE:
- The actual words spoken (ZERO text loss!)
- Italic markers
- Visual attributions (e.g. "- Email, ACCC Spokesperson") — these MUST BE KEPT EXACTLY AS THEY ARE.
- The overall sequence of captions.

OUTPUT FORMAT:
Return ONLY a JSON array. No preamble. No markdown. If no changes needed, return [].
For each change, specify:
- caption_index: the 1-based index from the input
- new_text: the suggested replacement text (or "" if deleted) — MUST NOT exceed 60 characters
- change_type: "phrase_break" | "name_kept_together" | "split" | "merge" | "delete"
- reason: 1-sentence explanation
- split_remainder: (splits only) the second half of the text — the formatter inserts this as a new caption immediately after
- linked_suggestions: REQUIRED. An array of OTHER caption_index values whose suggestions depend on this one being applied. If applying this change without the others would corrupt the output (duplicate words, lose words, orphaned deletes), list them here. Use [] if this suggestion stands alone and can be accepted/rejected independently of every other suggestion.

LINKED SUGGESTIONS RULE (CRITICAL):
Whenever you move words between captions, the affected captions form a "chain" — every suggestion in that chain MUST list ALL the other captions in the chain in its linked_suggestions field. Examples:
- Phrase_break moving words from caption 5 → 6: suggestion 5 has linked_suggestions: [6], suggestion 6 has linked_suggestions: [5].
- Merge absorbing caption 6 into caption 5 (so 6 becomes delete): suggestion 5 has linked_suggestions: [6], suggestion 6 has linked_suggestions: [5].
- Chain through 3 captions (4 donates to 5, 5 donates to 6): all three suggestions have linked_suggestions listing the other two — suggestion 4: [5, 6], suggestion 5: [4, 6], suggestion 6: [4, 5].
- Standalone split of caption 7 with no neighbour involvement: suggestion 7 has linked_suggestions: [].
Listing links symmetrically is mandatory — if A links to B, B MUST link back to A. Missing links will cause the system to apply broken partial changes.

For a split: set new_text to the first half and split_remainder to the second half. Return ONE entry only — do not also create a separate entry for the following caption.
SPLIT + ABSORB: if your split's new_text and split_remainder together contain all the words of an adjacent caption (i.e. you moved its text into the split to get enough characters), you MUST return a separate entry for that absorbed caption with new_text: "" and change_type: "delete". Failing to do so leaves a duplicate caption in the output.

LINE LENGTH RULE:
Each caption is displayed on up to 2 lines, max 30 characters per line (60 total for normal captions).
Captions with a speaker name tag (e.g. "JOHN SMITH:") always use the first line for the name tag, leaving only the second line for spoken text.
- For these, you MUST fit the spoken text within the provided effective_max_chars (always 30 — only line 2 is available for spoken text).
- If a caption is flagged with line_too_long: true, you MUST fix the overflow.
- If you cannot move words to a neighbor (because of name tags or italic boundaries), you MUST SPLIT the caption using change_type "split" with new_text as the first half and split_remainder as the second half.
- HARD LIMIT: new_text MUST NOT exceed 60 characters. split_remainder MUST NOT exceed 60 characters. If you cannot achieve this without violating the no-text-loss rule or the name tag / italic boundary rules, return NO suggestion for that caption — do not return an oversized suggestion.
Write new_text as a flat string with NO line breaks — the formatter will split it automatically.

INPUT CAPTIONS:
${JSON.stringify(annotateCaptions(captions), null, 2)}`;
}

// Parses the Gemini response text into a suggestions array, salvaging
// complete top-level {...} objects if the response was truncated.
// Returns { suggestions, salvaged } — salvaged=true when the primary parse failed.
function parseSuggestions(responseText) {
  const jsonMatch = responseText.match(/\[[\s\S]*\]/);
  try {
    const suggestions = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(responseText);
    return { suggestions, salvaged: false };
  } catch (parseErr) {
    // Salvage: response was likely truncated. Extract complete top-level
    // {...} objects by tracking brace depth, ignoring braces inside strings.
    const salvaged = [];
    const src = responseText;
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') { if (depth === 0) start = i; depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0 && start !== -1) {
          try { salvaged.push(JSON.parse(src.slice(start, i + 1))); } catch (_) {}
          start = -1;
        }
      }
    }
    return { suggestions: salvaged, salvaged: true, parseError: parseErr.message };
  }
}

// Filter out suggestions whose new_text or split_remainder exceeds the line limit.
// When an oversized suggestion is dropped, also drop every other suggestion it
// declared as linked (via the linked_suggestions field) — these depend on the
// dropped change being applied (e.g. a paired delete for a merge, or the other
// half of a phrase_break redistribution).
// Returns { kept, droppedIndices }.
function filterOversizedSuggestions(suggestions, captions) {
  const captionsMapForFilter = new Map(captions.map(c => [c.index, c]));

  const _isOversized = s => {
    const newText = (s.new_text || '').trim();
    if (!newText) return false;
    const origCap = captionsMapForFilter.get(s.caption_index);
    const nameTagM = origCap ? (origCap.text || '').match(NAME_TAG_RE_SPACED) : null;
    const effectiveMax = nameTagM ? 30 : 60;
    const nameTagInNew = nameTagM ? newText.match(NAME_TAG_RE_SPACED) : null;
    const spokenText = nameTagInNew ? newText.slice(nameTagInNew[0].length).trim() : newText;
    if (spokenText.length > effectiveMax) return true;
    if (s.change_type === 'split' && s.split_remainder?.trim().length > 60) return true;
    return false;
  };

  // Seed with directly oversized suggestions, then close over Gemini-declared links.
  const badIndices = new Set(suggestions.filter(_isOversized).map(s => s.caption_index));
  const suggByIdx = new Map(suggestions.map(s => [s.caption_index, s]));

  let chainChanged = true;
  while (chainChanged) {
    chainChanged = false;
    for (const s of suggestions) {
      if (!Array.isArray(s.linked_suggestions)) continue;
      const linkSet = new Set([s.caption_index, ...s.linked_suggestions]);
      const anyBad = [...linkSet].some(i => badIndices.has(i));
      if (!anyBad) continue;
      for (const i of linkSet) {
        if (suggByIdx.has(i) && !badIndices.has(i)) {
          badIndices.add(i);
          chainChanged = true;
        }
      }
    }
  }

  return {
    kept: suggestions.filter(s => !badIndices.has(s.caption_index)),
    droppedIndices: [...badIndices].sort((a, b) => a - b),
  };
}

module.exports = {
  GEMINI_MODELS,
  geminiConfigFor,
  annotateCaptions,
  buildGeminiPrompt,
  parseSuggestions,
  filterOversizedSuggestions,
};
