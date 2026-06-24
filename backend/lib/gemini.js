// Shared Gemini logic for the Stage 2 Phase 1 pipeline.
// Used by backend/server.js (production) and test_system/gemini_eval (offline eval)
// so the prompt, generationConfig, parsing and filtering can never drift apart.

const GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.0-flash'];

// Gemini 3.x: temperature / top_p / top_k are no longer recommended; the
// model picks them internally. Use thinkingLevel (string) instead of the
// old thinkingBudget (number).  See:
//   https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.5
// For 2.x models, the old temperature + thinkingBudget shape still works.
function geminiConfigFor(model, opts = {}) {
  const isV3 = model.startsWith('gemini-3');
  if (isV3) {
    return {
      // 'medium' — A/B tested 2026-06-10 (test_system/gemini_eval, 48 runs):
      // low produced char-limit violations + one silent text-loss; medium had
      // zero rule violations across 573 suggestions. Cost: ~60s vs ~31s.
      // opts.thinkingLevel overrides (eval harness A/B).
      thinkingConfig: { thinkingLevel: opts.thinkingLevel || 'medium' },
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
// maxChars: limit for normal (non-name-tag) captions, default 60.
function annotateCaptions(captions, maxChars = 60) {
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
    const lineTooLong = nameTagM ? spokenText.length > 30 : spokenText.length > maxChars;
    const effectiveMax = nameTagM ? 30 : maxChars;

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

// opts.maxChars: character limit for normal captions (default 60).
// opts.lineLevel (default true): Gemini writes explicit ≤30-char lines
// (\n-separated) instead of a flat ≤maxChars string. Line-level is production
// default — A/B tested 2026-06-11: flat mode rendered a >30-char line for ~10%
// of suggestions (the 60-char limit can't guarantee a clean 30/30 split);
// line-level rendered 0% over 103 suggestions and handled name tags perfectly.
// Pass lineLevel: false for the legacy flat prompt (eval harness comparison).
function buildGeminiPrompt(captions, opts = {}) {
  const maxChars = opts.maxChars || 60;
  const lineLevel = opts.lineLevel !== false;
  return `You are an expert caption editor for broadcast news social media videos.
You will receive audio and a list of captions that have been auto-formatted from a Premiere Pro export.

Your job: review the captions against what is actually said in the audio, and suggest improvements where caption breaks fall in awkward places.

HARD CHARACTER LIMIT:
Every caption entry in the input has a chars field (current spoken-text length) and a max_chars field (the limit that applies — ${maxChars} for normal captions, 30 for name-tag captions where only the second line is available for spoken text). Before finalising any suggestion, verify new_text does not exceed max_chars. If it does, try a different redistribution or split — never return a suggestion whose new_text or split_remainder exceeds ${maxChars} characters. If no valid fix exists within the limit, return NO suggestion for that caption. Returning oversized text is never acceptable.

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
- new_text: ${lineLevel
    ? 'the suggested replacement text (or "" if deleted), written as 1 or 2 lines separated by a newline character (\\n) — EACH LINE MUST NOT exceed 30 characters'
    : `the suggested replacement text (or "" if deleted) — MUST NOT exceed ${maxChars} characters`}
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

${lineLevel
  ? `LINE LENGTH RULE (CRITICAL — YOU CHOOSE THE LINE BREAKS):
Each caption is displayed on up to 2 lines, max 30 characters per line.
Write new_text (and split_remainder) with an explicit newline character (\\n) between the two lines. EVERY LINE MUST BE 30 CHARACTERS OR FEWER — count the characters of each line before finalising a suggestion.
Captions with a speaker name tag (e.g. "JOHN SMITH:") always use the first line for the name tag: write the tag alone on line 1 and the spoken text on line 2 (max 30 chars).
- If a caption is flagged with line_too_long: true, you MUST fix the overflow.
- If you cannot move words to a neighbor (because of name tags or italic boundaries), you MUST SPLIT the caption using change_type "split" with new_text as the first half and split_remainder as the second half.
- HARD LIMIT: no line may exceed 30 characters. If you cannot achieve this without violating the no-text-loss rule or the name tag / italic boundary rules, return NO suggestion for that caption.
Break lines at natural phrase points (after punctuation, before conjunctions) when possible.`
  : `LINE LENGTH RULE:
Each caption is displayed on up to 2 lines, max 30 characters per line (${maxChars} total for normal captions).
Captions with a speaker name tag (e.g. "JOHN SMITH:") always use the first line for the name tag, leaving only the second line for spoken text.
- For these, you MUST fit the spoken text within the provided effective_max_chars (always 30 — only line 2 is available for spoken text).
- If a caption is flagged with line_too_long: true, you MUST fix the overflow.
- If you cannot move words to a neighbor (because of name tags or italic boundaries), you MUST SPLIT the caption using change_type "split" with new_text as the first half and split_remainder as the second half.
- HARD LIMIT: new_text MUST NOT exceed ${maxChars} characters. split_remainder MUST NOT exceed ${maxChars} characters. If you cannot achieve this without violating the no-text-loss rule or the name tag / italic boundary rules, return NO suggestion for that caption — do not return an oversized suggestion.
Write new_text as a flat string with NO line breaks — the formatter will split it automatically.`}

INPUT CAPTIONS:
${JSON.stringify(annotateCaptions(captions, maxChars), null, 2)}`;
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

  // Line-level texts (\n present): oversized when any line beyond a name tag
  // exceeds 30 chars. Flat texts: legacy total-length check (60, or 30 spoken
  // for name-tag captions).
  const _textOversized = (text, origCap) => {
    const t = (text || '').trim();
    if (!t) return false;
    if (t.includes('\n')) {
      const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
      const tagFirst = NAME_TAG_RE_SPACED.test(lines[0] || '') && lines[0].trim().endsWith(':');
      const spokenLines = tagFirst ? lines.slice(1) : lines;
      return spokenLines.some(l => l.length > 30);
    }
    const nameTagM = origCap ? (origCap.text || '').match(NAME_TAG_RE_SPACED) : null;
    const effectiveMax = nameTagM ? 30 : 60;
    const nameTagInNew = nameTagM ? t.match(NAME_TAG_RE_SPACED) : null;
    const spokenText = nameTagInNew ? t.slice(nameTagInNew[0].length).trim() : t;
    return spokenText.length > effectiveMax;
  };

  const _isOversized = s => {
    const origCap = captionsMapForFilter.get(s.caption_index);
    if (_textOversized(s.new_text, origCap)) return true;
    // A split remainder becomes its own caption (no name tag) — full 60 when flat.
    if (s.change_type === 'split' && _textOversized(s.split_remainder, null)) return true;
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

// ── Chain validation ─────────────────────────────────────────────────────────
// Deterministic guard against the failure modes Gemini can produce even when
// each suggestion individually looks fine (measured in test_system/gemini_eval):
//   - text loss / duplication from incomplete chains (words silently dropped)
//   - chains that move words across italic / non-italic boundaries
//   - dangling links (a suggestion depends on one that doesn't exist)
//   - texts that pass the 60-char limit but cannot be split into two ≤30 lines
// Also normalizes linked_suggestions (strips self-references, coerces to array).
// Suggestions are grouped into chains via the symmetric closure of
// linked_suggestions; an invalid chain is dropped whole.

// Mirrors splitLines() in frontend/caption_formatter.html — used to test
// whether a suggested text can actually render as ≤2 lines of ≤30 chars.
const SPLIT_BREAK_RE = /(?<!\d),(?!\s*\d)|[;:]|[—–]/g;
function splitLinesForCheck(text) {
  text = text.trim();
  if (!text) return [];
  if (text.length <= 30) return [text];
  const candidates = [];
  SPLIT_BREAK_RE.lastIndex = 0;
  let m;
  while ((m = SPLIT_BREAK_RE.exec(text)) !== null) {
    const pos = m.index + m[0].length;
    const ratio = pos / text.length;
    if (ratio < 0.20 || ratio > 0.80) continue;
    const l1 = text.slice(0, pos).trim();
    const l2 = text.slice(pos).trim();
    if (l1 && l2 && l1.length <= 30 && l2.length <= 30)
      candidates.push({ l1, l2, dist: Math.abs(pos - text.length / 2) });
  }
  if (candidates.length) {
    candidates.sort((a, b) => a.dist - b.dist);
    return [candidates[0].l1, candidates[0].l2];
  }
  const words = text.split(/\s+/);
  if (words.length === 1) return [text];
  let best = null, bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const l1 = words.slice(0, i).join(' ');
    const l2 = words.slice(i).join(' ');
    const diff = Math.abs(l1.length - l2.length);
    if (diff < bestDiff) { bestDiff = diff; best = [l1, l2]; }
  }
  return best || [text];
}

function validateSuggestionChains(suggestions, captions) {
  const capByIdx = new Map(captions.map(c => [c.index, c]));
  const suggByIdx = new Map(suggestions.map(s => [s.caption_index, s]));
  const tok = t => (t || '').split(/\s+/).filter(Boolean);

  // Normalize links: array, no self-references
  for (const s of suggestions) {
    s.linked_suggestions = Array.isArray(s.linked_suggestions)
      ? s.linked_suggestions.filter(i => i !== s.caption_index)
      : [];
  }

  // Union-find over caption_index to build chains (symmetric closure of links)
  const parent = new Map(suggestions.map(s => [s.caption_index, s.caption_index]));
  const find = i => { let r = i; while (parent.get(r) !== r) r = parent.get(r); parent.set(i, r); return r; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const s of suggestions) {
    for (const li of s.linked_suggestions) {
      if (suggByIdx.has(li)) union(s.caption_index, li);
    }
  }
  const chains = new Map(); // root → caption_index[]
  for (const s of suggestions) {
    const r = find(s.caption_index);
    if (!chains.has(r)) chains.set(r, []);
    chains.get(r).push(s.caption_index);
  }

  const droppedChains = []; // {indices, reason}
  for (const indices of chains.values()) {
    indices.sort((a, b) => a - b);
    const chainSugs = indices.map(i => suggByIdx.get(i));
    let reason = null;

    // Dangling links: depends on a suggestion that doesn't exist
    for (const s of chainSugs) {
      const missing = s.linked_suggestions.filter(li => !suggByIdx.has(li));
      if (missing.length) { reason = `dangling link to #${missing.join(', #')}`; break; }
    }

    // Italic uniformity: a multi-caption chain must not span italic + non-italic captions
    if (!reason && indices.length > 1) {
      const states = new Set(indices.map(i => !!(capByIdx.get(i) || {}).italic));
      if (states.size > 1) reason = 'chain crosses an italic/non-italic boundary';
    }

    // Exact-token conservation across the chain (split remainders included).
    // Catches incomplete chains: words lost or duplicated when applied together.
    if (!reason) {
      const origTokens = [], newTokens = [];
      for (const i of indices) {
        origTokens.push(...tok((capByIdx.get(i) || {}).text));
        const s = suggByIdx.get(i);
        const isDelete = s.change_type === 'delete' || !s.new_text || !String(s.new_text).trim();
        if (!isDelete) newTokens.push(...tok(String(s.new_text)));
        if (s.change_type === 'split' && s.split_remainder && String(s.split_remainder).trim()) {
          newTokens.push(...tok(String(s.split_remainder).trim()));
        }
      }
      if (origTokens.join(' ') !== newTokens.join(' ')) reason = 'text not conserved across chain (words lost, duplicated, or altered)';
    }

    // Line feasibility — STRICT 30 chars/line (Premiere force-wraps at 30, so an
    // overflowing line is silently hidden; never acceptable).
    // Line-level texts (\n present, the production prompt format): validate
    // Gemini's own lines directly — ≤2 spoken lines, each ≤30; for a caption
    // that owns a name tag, the tag must sit alone on line 1.
    // Flat texts (legacy / model ignored the format): simulate the frontend's
    // splitLines and require a clean ≤30/≤30 result.
    if (!reason) {
      outer:
      for (const s of chainSugs) {
        const origCap = capByIdx.get(s.caption_index);
        const origHasTag = !!(origCap && (origCap.text || '').match(NAME_TAG_RE_SPACED));
        for (const t of [s.new_text, s.split_remainder]) {
          if (!t || !String(t).trim()) continue;
          const str = String(t).trim();
          const isRemainder = t === s.split_remainder;
          if (str.includes('\n')) {
            const lines = str.split('\n').map(l => l.trim()).filter(Boolean);
            const tagFirst = NAME_TAG_RE_SPACED.test(lines[0] || '') && lines[0].endsWith(':');
            if (origHasTag && !isRemainder && !tagFirst) {
              reason = `caption #${s.caption_index} has a name tag but line 1 of new_text is not the tag alone`;
              break outer;
            }
            const spokenLines = tagFirst ? lines.slice(1) : lines;
            if (spokenLines.length > 2 || spokenLines.some(l => l.length > 30)) {
              reason = `"${str.replace(/\n/g, ' / ').slice(0, 50)}..." has a spoken line over 30 chars (or >2 lines)`;
              break outer;
            }
          } else {
            const tagM = str.match(NAME_TAG_RE_SPACED);
            const renderable = tagM ? str.slice(tagM[0].length).trim() : str;
            const lines = splitLinesForCheck(renderable);
            if (lines.length > 2 || lines.some(l => l.length > 30)) {
              reason = `"${renderable.slice(0, 50)}..." cannot split into two ≤30-char lines`;
              break outer;
            }
          }
        }
      }
    }

    if (reason) droppedChains.push({ indices, reason });
  }

  const badIndices = new Set(droppedChains.flatMap(d => d.indices));
  return {
    kept: suggestions.filter(s => !badIndices.has(s.caption_index)),
    droppedChains,
  };
}

module.exports = {
  GEMINI_MODELS,
  geminiConfigFor,
  annotateCaptions,
  buildGeminiPrompt,
  parseSuggestions,
  filterOversizedSuggestions,
  validateSuggestionChains,
};
