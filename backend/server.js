const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const path = require('path');
const app = express();

// File upload configuration
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

app.use(express.json({ limit: '25mb' })); // large enough for base64 audio
app.use(fileUpload({
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
  useTempFiles: true,
  tempFileDir: tempDir,
}));

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Secret');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Auth ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  const secret = req.headers['x-secret'];
  if (!secret || secret !== process.env.SHARED_SECRET) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  next();
});

// ── Claude: style guide review ────────────────────────────────────────────────
app.post('/api/review', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Claude proxy error' });
  }
});

// ── Gemini: audio vs captions comparison ──────────────────────────────────────
app.post('/api/audio-check', async (req, res) => {
  try {
    const { audioBase64, mimeType, captionsText } = req.body;
    if (!audioBase64 || !mimeType || !captionsText) {
      return res.status(400).json({ error: 'Missing audioBase64, mimeType, or captionsText' });
    }

    const prompt = `You are an expert caption verifier. Listen carefully to the audio provided.
I will also give you the auto-generated captions for this audio.
Your job is to identify transcription errors — words that are wrong, missing, or incorrectly added.

CAPTIONS TO VERIFY:
${captionsText}

Compare every caption against what is actually said in the audio.
Flag only genuine errors — do not flag stylistic differences, punctuation, or formatting.
Focus on: wrong words, misheared words, missing words, extra words not spoken.

Respond ONLY with a JSON array. If no errors found, return [].
Each object must have exactly: caption_number (int), error_type (string: WRONG_WORD | MISSING_WORD | EXTRA_WORD | NAME_ERROR), what_audio_says (string), what_caption_says (string), excerpt (string — the surrounding caption text for context).
No preamble. No markdown. Raw JSON array only.`;

    const geminiBody = {
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType, data: audioBase64 } },
          { text: prompt }
        ]
      }],
      generationConfig: { temperature: 0.1 }
    };

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody),
      }
    );

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gemini proxy error' });
  }
});

// ── Stage 2: Two-phase caption refinement ────────────────────────────────────
// Phase 1 (no accepted_suggestions): Gemini only → returns suggestions for user review
// Phase 2 (accepted_suggestions present): WhisperX only → returns merged captions
app.post('/api/refine', async (req, res) => {
  const startTime = Date.now();
  const stages = {};
  let keepAlive;

  try {
    // ── Common validation ──────────────────────────────────────────────────────
    if (!req.files || !req.files.audio) {
      return res.status(400).json({ error: 'audio file is required' });
    }
    if (!req.body.captions) {
      return res.status(400).json({ error: 'captions JSON is required in form data' });
    }

    let captions;
    try {
      captions = JSON.parse(req.body.captions);
    } catch (e) {
      return res.status(400).json({ error: `Invalid captions JSON: ${e.message}` });
    }

    if (!Array.isArray(captions) || captions.length === 0) {
      return res.status(400).json({ error: 'captions must be a non-empty array' });
    }

    const audioFile = req.files.audio;
    const audioBuffer = fs.readFileSync(audioFile.tempFilePath);
    const audioBase64 = audioBuffer.toString('base64');
    const audioFormat = audioFile.mimetype.includes('mp3') ? 'mp3' :
                        audioFile.mimetype.includes('wav') ? 'wav' : 'm4a';

    if (audioBuffer.length > 100 * 1024 * 1024) {
      return res.status(413).json({ error: 'Audio file exceeds 100MB limit' });
    }

    // ── PHASE 1: Gemini suggestions only ──────────────────────────────────────
    if (!req.body.accepted_suggestions) {
      console.log(`[/api/refine] Phase 1: Gemini for ${captions.length} captions, audio: ${audioBuffer.length} bytes`);
      const geminiStartTime = Date.now();

      // Start keepAlive immediately — Gemini can take 2-4 mins for long audio
      // and Render cuts connections at 100s without any bytes written.
      res.setHeader('Content-Type', 'application/json');
      res.flushHeaders();
      keepAlive = setInterval(() => res.write(' '), 10000);

      const geminiPrompt = `You are an expert caption editor for ABC Media Watch social media videos.
You will receive audio and a list of captions that have been auto-formatted from a Premiere Pro export.

YOUR OBJECTIVE: Review the captions against what is actually said in the audio and suggest improvements to where caption breaks fall to improve readability and flow.

THE GOLDEN RULE: ZERO TEXT LOSS
You MUST NOT edit, rephrase, or omit any words from the original captions. Your only task is to move the boundaries (the breaks) between captions. Every word in the input must appear exactly once in your output. No words can be added, and NO words can be deleted unless the entire caption is being merged into another.

NAME TAG RULE (HIGHEST PRIORITY):
A speaker name tag (e.g. "LIAM BARTLETT:", "CHRIS BOWEN:") MUST always remain as the FIRST LINE of its own caption.
- NEVER move text from a preceding caption into a caption that starts with a name tag — it would push the name tag off the top line.
- NEVER move the name tag itself away from the start of its caption.
- If a caption is too long but the NEXT caption starts with a name tag, check if you can move words to the PREVIOUS caption instead.
- If text following a name tag is too long, redistribute words with the caption AFTER the name tag caption, not the caption before it.

ITALIC BOUNDARY RULE:
Never suggest changes that would merge text across italic/non-italic boundaries.
- If caption N is italic and caption N+1 is not italic (or vice versa), do NOT move text between them.
- Each caption must be entirely italic or entirely non-italic.

LINE LENGTH RULE (CRITICAL):
Each caption is displayed on exactly 2 lines, max 30 characters per line (60 characters total).
- Captions with a speaker name tag (e.g. "JOHN SMITH:") use the entire first line for the name tag, leaving ONLY the second line (max 30 chars) for spoken text.
- For these, you MUST fit the spoken text within the provided effective_max_chars (which is 60 minus the name tag length).
- If a caption is flagged with line_too_long: true, you MUST fix the overflow.
- If you cannot move words to a neighbor (because of name tags or italic boundaries), you MUST SPLIT the caption into two separate captions instead.
- NO suggested caption should ever exceed 60 characters total.

SINGLE WORD RULE:
Avoid captions that contain only a single word unless it is a significant exclamation or the start of a new speaker. Merge single-word captions into the preceding or following caption where possible, provided it doesn't violate the Line Length Rule.

CRITICAL RULES FOR MOVING TEXT:
1. If you move words from one caption to another, you MUST return an update for BOTH captions to prevent duplicating text!
2. DO NOT DUPLICATE WORDS across captions.
3. CHAIN COMPLETENESS: when you shift text through a sequence, EVERY caption in the chain must have an update. If caption N consumes words from N+1, then N+1 MUST also have an update — either with its new shifted text, or with new_text="" if it was fully absorbed.

DO NOT CHANGE:
- The actual words spoken (ZERO text loss!)
- Italic markers
- Visual attributions (e.g. "- Email, ACCC Spokesperson") — these MUST BE KEPT EXACTLY AS THEY ARE.
- The overall sequence of captions.

OUTPUT FORMAT:
Return ONLY a JSON array. No preamble. No markdown. If no changes needed, return [].
For each change:
- caption_index: the 1-based index from the input
- new_text: the suggested replacement text (or "" if deleted)
- change_type: "phrase_break" | "name_kept_together" | "timing_only" | "split" | "merge" | "delete"
- reason: 1-sentence explanation

INPUT CAPTIONS:
${JSON.stringify(captions.map(c => {
  const NAME_TAG_RE = /^([A-Z][A-Z\s.\-']{1,40}:)/;
  const lines = c.text ? c.text.split('\n') : [];
  const nameTagMatch = lines[0] && NAME_TAG_RE.test(lines[0].trim());
  const nameTagLen = nameTagMatch ? lines[0].trim().length : 0;
  const effectiveMax = nameTagMatch ? 60 - nameTagLen : 60;
  // Check if any spoken line (skip name tag line) exceeds 30 chars
  const spokenLines = nameTagMatch ? lines.slice(1) : lines;
  const lineTooLong = spokenLines.some(l => l.trim().length > 30);
  // Only send timing flags that represent real problems Gemini must address.
  // "Timing adjusted — …" flags indicate Stage 1 already modified timing and don't need AI to rewrite text,
  // but they DO need WhisperX retiming (handled separately).
  const realTimingFlag = c.timingFlag && c.timingFlag.startsWith('Timing needs') ? c.timingFlag : null;
  const entry = {
    index: c.index,
    text: c.text,
    italic: c.italic,
    ...(realTimingFlag ? { timing_flag: realTimingFlag } : {}),
  };
  if (lineTooLong) {
    entry.line_too_long = true;
    entry.effective_max_chars = effectiveMax;
  }
  return entry;
}), null, 2)}`;

      const geminiBody = {
        contents: [{
          parts: [
            { inline_data: { mime_type: audioFormat === 'mp3' ? 'audio/mpeg' : `audio/${audioFormat}`, data: audioBase64 } },
            { text: geminiPrompt }
          ]
        }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 65536 },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ]
      };

      // Try models in order, falling back on 503/UNAVAILABLE
      const geminiModels = ['gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.0-flash'];
      let geminiResponse, geminiData;
      for (let attempt = 0; attempt < geminiModels.length; attempt++) {
        const model = geminiModels[attempt];
        if (attempt > 0) {
          console.log(`[/api/refine] Gemini falling back to ${model}...`);
        }
        geminiResponse = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geminiBody) }
        );
        if (geminiResponse.ok) break;
        const errBody = await geminiResponse.json();
        console.error(`Gemini ${model} attempt ${attempt} failed: ${errBody?.error?.status}`);
        if (errBody?.error?.status !== 'UNAVAILABLE' && errBody?.error?.status !== 'RESOURCE_EXHAUSTED') {
          return res.status(500).json({ status: 'error', error: `Gemini API error: ${errBody?.error?.message || geminiResponse.statusText}` });
        }
        if (attempt === geminiModels.length - 1) {
          return res.status(503).json({ status: 'error', error: 'Gemini is overloaded — please try again in a minute.' });
        }
      }

      geminiData = await geminiResponse.json();

      let suggestions = [];
      try {
        const responseText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
        console.log('Gemini response (first 500 chars):', responseText.substring(0, 500));
        const jsonMatch = responseText.match(/\[[\s\S]*\]/);
        try {
          suggestions = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(responseText);
        } catch (parseErr) {
          // Salvage: response was likely truncated. Extract complete top-level
          // {...} objects by tracking brace depth, ignoring braces inside strings.
          const finishReason = geminiData.candidates?.[0]?.finishReason;
          console.warn(`[/api/refine] Primary parse failed (${parseErr.message}). FinishReason: ${finishReason}. Attempting salvage...`);
          
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
          suggestions = salvaged;
          console.log(`[/api/refine] Salvaged ${salvaged.length} suggestions from incomplete response.`);
        }
      } catch (e) {
        console.warn(`Could not parse Gemini suggestions: ${e.message}`);
        suggestions = [];
      }

      stages.gemini = { duration_ms: Date.now() - geminiStartTime, suggestions_count: suggestions.length };
      console.log(`[/api/refine] Phase 1 complete: ${suggestions.length} suggestions in ${Date.now() - startTime}ms`);

      clearInterval(keepAlive);
      res.write(JSON.stringify({ status: 'suggestions', stages, suggestions }));
      return res.end();
    }

    // ── PHASE 2: WhisperX alignment with user-accepted suggestions ────────────
    let acceptedSuggestions;
    try {
      acceptedSuggestions = JSON.parse(req.body.accepted_suggestions);
    } catch (e) {
      return res.status(400).json({ error: `Invalid accepted_suggestions JSON: ${e.message}` });
    }
    if (!Array.isArray(acceptedSuggestions)) acceptedSuggestions = [];

    console.log(`[/api/refine] Phase 2: WhisperX for ${captions.length} captions, ${acceptedSuggestions.length} accepted changes`);

    const suggestionsMap = new Map(acceptedSuggestions.map(s => [s.caption_index, s]));
    const isChangedSet = new Set(acceptedSuggestions.map(s => s.caption_index));
    // Also mark captions with "Timing needs" flags for alignment (even without suggestions)
    for (const cap of captions) {
      if (cap.timingFlag && (cap.timingFlag.includes('Timing needs') || cap.timingFlag.includes('Line too long'))) {
        isChangedSet.add(cap.index);
      }
    }
    const BOUNDARY_BUFFER_MS = 300;

    const resolveText = (cap, suggestion) => {
      if (!suggestion) return cap.text;
      const isDelete = suggestion.change_type === 'delete' ||
        suggestion.new_text === null ||
        suggestion.new_text === undefined ||
        (typeof suggestion.new_text === 'string' && suggestion.new_text.trim() === '');
      return isDelete ? '' : suggestion.new_text;
    };

    const tokenize = text =>
      (text || '').toLowerCase().replace(/[^\w\s]/g, ' ').trim().split(/\s+/).filter(t => t.length > 0);

    // Group consecutive changed/timing-flagged captions into chains.
    const chainStart = new Array(captions.length).fill(-1);
    const chainEnd = new Array(captions.length).fill(-1);
    let ci = 0;
    while (ci < captions.length) {
      if (!isChangedSet.has(captions[ci].index)) { ci++; continue; }
      const start = ci;
      while (ci < captions.length && isChangedSet.has(captions[ci].index)) {
        chainStart[ci] = start;
        ci++;
      }
      const end = ci - 1;
      for (let k = start; k <= end; k++) chainEnd[k] = end;
    }

    // Build ONE WhisperX segment per chain (concatenated text, chain outer window).
    // WhisperX returns word-level timestamps for the whole chain; we then walk
    // words by token count to assign per-caption timing — no internal boundary
    // confusion because we never ask WhisperX to split the chain itself.
    const chainTextMap = new Map(); // headArrayIdx → chain metadata
    const processedChainHeads = new Set();
    let chainArrayIdx = 0;

    for (let idx = 0; idx < captions.length; idx++) {
      if (!isChangedSet.has(captions[idx].index)) continue;
      const head = chainStart[idx];
      if (processedChainHeads.has(head)) continue;
      processedChainHeads.add(head);

      const tail = chainEnd[head];

      // Only include non-deleted captions so concat text matches word count
      const capEntries = [];
      for (let k = head; k <= tail; k++) {
        const cap = captions[k];
        const resolvedText = resolveText(cap, suggestionsMap.get(cap.index));
        if (resolvedText && resolvedText.trim()) capEntries.push({ cap, text: resolvedText });
      }
      if (capEntries.length === 0) continue;

      const concatText = capEntries.map(e => e.text).join(' ');

      let leftMs = null, rightMs = null;
      for (let j = head - 1; j >= 0; j--) {
        if (!isChangedSet.has(captions[j].index)) { leftMs = captions[j].end_ms; break; }
      }
      for (let j = tail + 1; j < captions.length; j++) {
        if (!isChangedSet.has(captions[j].index)) { rightMs = captions[j].start_ms; break; }
      }
      const windowStart = Math.max(0, leftMs !== null ? leftMs - BOUNDARY_BUFFER_MS : (captions[head].start_ms || 0) - 1000);
      const windowEnd = rightMs !== null ? rightMs + BOUNDARY_BUFFER_MS : ((captions[tail].end_ms || 0) + 1000);

      chainTextMap.set(head, {
        text: concatText,
        startMs: windowStart,
        endMs: windowEnd,
        capEntries,
        rightBoundary: rightMs,
        arrayIdx: chainArrayIdx++
      });
    }

    const textForAlignment = [...chainTextMap.values()].map(chain => ({
      index: chain.arrayIdx,
      text: chain.text,
      start_ms: chain.startMs,
      end_ms: chain.endMs
    }));

    const whisperxURL = process.env.WHISPERX_URL;
    if (!whisperxURL) {
      console.warn('WHISPERX_URL not configured, returning accepted text with original timing');
      const fallbackResult = _mergeCaptionSuggestions(captions, acceptedSuggestions, true, new Map());
      return res.json({
        status: 'partial',
        error: 'WhisperX not configured — using accepted text with original timing',
        stages,
        captions: fallbackResult,
        captions_no_whisper: fallbackResult
      });
    }

    // Start keepAlive to prevent Render 100s timeout during WhisperX
    res.setHeader('Content-Type', 'application/json');
    res.flushHeaders();
    keepAlive = setInterval(() => res.write(' '), 10000);

    let whisperxResult = null;
    let whisperxError = null;
    const whisperxStartTime = Date.now();

    try {
      const whisperxResponse = await fetch(`${whisperxURL}/align`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Secret': process.env.SHARED_SECRET },
        body: JSON.stringify({
          audio_base64: audioBase64,
          audio_format: audioFormat,
          captions: textForAlignment,
          language: 'en'
        }),
        timeout: 120000
      });

      if (!whisperxResponse.ok) {
        whisperxError = `WhisperX error: ${whisperxResponse.status}`;
        console.warn(whisperxError);
      } else {
        whisperxResult = await whisperxResponse.json();
        console.log(`[/api/refine] WhisperX returned word timing for ${whisperxResult.captions?.length || 0} chain(s)`);
      }
    } catch (err) {
      whisperxError = `WhisperX unreachable: ${err.message}`;
      console.warn(whisperxError);
    }

    stages.whisperx = {
      duration_ms: Date.now() - whisperxStartTime,
      status: whisperxError ? 'failed' : 'success',
      error: whisperxError
    };

    // Walk word-level WhisperX results and assign per-caption timing.
    // Each chain was one concatenated segment; we distribute words to captions
    // by token count. Caption N ends where caption N+1 starts (no internal gaps).
    // Last chain caption extends to the next unchanged caption's start.
    const chainAssignedTiming = new Map(); // capIndex → {startMs, endMs} | null (Stage 1 fallback)

    if (whisperxResult && Array.isArray(whisperxResult.captions)) {
      const whisperxChains = new Map(whisperxResult.captions.map(c => [c.index, c.words || []]));

      for (const chain of chainTextMap.values()) {
        const words = whisperxChains.get(chain.arrayIdx) || [];

        if (words.length === 0) {
          for (const { cap } of chain.capEntries) chainAssignedTiming.set(cap.index, null);
          continue;
        }

        let wordPos = 0;
        const capWordBuckets = [];
        for (const { cap, text } of chain.capEntries) {
          const tokens = tokenize(text);
          const numTokens = Math.max(tokens.length, 1);
          const capWords = words.slice(wordPos, wordPos + numTokens);
          wordPos += numTokens;
          // Subtract a small offset from word starts: wav2vec2 anchors to vowel/energy
          // onset rather than consonant onset, so start_ms is typically 80-120ms late.
          // This corrects within-chain transitions (caption N end = caption N+1 start_ms)
          // which otherwise stay on screen through the early consonants of the next caption.
          const WORD_START_OFFSET_MS = 100;
          capWordBuckets.push(capWords.length > 0
            ? { capIndex: cap.index, startMs: Math.max(0, capWords[0].start_ms - WORD_START_OFFSET_MS), endWords: capWords[capWords.length - 1].end_ms }
            : null);
        }

        for (let k = 0; k < chain.capEntries.length; k++) {
          const { cap } = chain.capEntries[k];
          const bucket = capWordBuckets[k];
          if (!bucket) { chainAssignedTiming.set(cap.index, null); continue; }

          let endMs;
          if (k < chain.capEntries.length - 1) {
            const nextBucket = capWordBuckets[k + 1];
            endMs = nextBucket ? nextBucket.startMs : bucket.endWords;
          } else {
            endMs = chain.rightBoundary !== null ? chain.rightBoundary : bucket.endWords;
          }
          chainAssignedTiming.set(cap.index, { startMs: bucket.startMs, endMs });
        }
      }
    }

    const mergedCaptions = _mergeCaptionSuggestions(
      captions,
      acceptedSuggestions,
      !!whisperxError,
      chainAssignedTiming
    );

    // Gemini-only version: accepted text + Stage 1 timing (no WhisperX changes).
    const geminiOnlyCaptions = _mergeCaptionSuggestions(
      captions,
      acceptedSuggestions,
      true,
      new Map()
    );

    console.log(`[/api/refine] Phase 2 complete in ${Date.now() - startTime}ms`);

    clearInterval(keepAlive);
    res.write(JSON.stringify({
      status: whisperxError ? 'partial' : 'success',
      error: whisperxError || null,
      stages,
      captions: mergedCaptions,
      captions_no_whisper: geminiOnlyCaptions
    }));
    return res.end();

  } catch (err) {
    if (keepAlive) clearInterval(keepAlive);
    console.error('[/api/refine] Unexpected error:', err);
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json');
    res.write(JSON.stringify({ status: 'error', error: `Refinement pipeline error: ${err.message}` }));
    return res.end();
  }
});

// Helper: Merge accepted suggestions + chain-assigned WhisperX timing into original captions.
// chainAssignedTiming: Map<capIndex, {startMs, endMs}> built by walking word-level
// results from single-segment chain alignment. Absent entry = Stage 1 fallback.
function _mergeCaptionSuggestions(originalCaptions, suggestions, isPartial, chainAssignedTiming = new Map()) {
  const suggestionsMap = new Map(suggestions.map(s => [s.caption_index, s]));

  const merged = originalCaptions.map(cap => {
    const suggestion = suggestionsMap.get(cap.index);
    const isChanged = !!suggestion;

    let newText;
    if (isChanged) {
      const isDelete = suggestion.change_type === 'delete' ||
        suggestion.new_text === null ||
        suggestion.new_text === undefined ||
        (typeof suggestion.new_text === 'string' && suggestion.new_text.trim() === '');
      newText = isDelete ? '' : suggestion.new_text;
    } else {
      newText = cap.text;
    }

    // Timing: use chain-assigned word-boundary timing for changed/flagged captions.
    // null entry = WhisperX failed for this chain → keep Stage 1 timing.
    // Unchanged captions always keep Stage 1 timing.
    let startMs = cap.start_ms;
    let endMs = cap.end_ms;
    const hasTimingNeeds = cap.timingFlag && cap.timingFlag.startsWith('Timing needs');
    const shouldAlign = isChanged || hasTimingNeeds;
    if (shouldAlign) {
      const assigned = chainAssignedTiming.get(cap.index);
      if (assigned) {
        startMs = assigned.startMs;
        endMs = assigned.endMs;
      }
      // else: no entry = WhisperX failed for this chain → keep Stage 1 timing
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
      timing_flag: cap.timingFlag || null,
      partial: isPartial
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
    const changedNorm = normalizeForCompare(surviving[i].text);
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

  // Clamp overlaps — preserve original text order, never sort by timestamp.
  for (let i = 1; i < surviving.length; i++) {
    if (surviving[i].start_ms < surviving[i - 1].end_ms) {
      surviving[i].start_ms = surviving[i - 1].end_ms;
    }
    if (surviving[i].end_ms <= surviving[i].start_ms) {
      surviving[i].end_ms = surviving[i].start_ms + 500;
    }
  }

  // Snap-to-next: close small gaps (< 500ms) between adjacent captions.
  // Within-chain gaps are already eliminated by the word-boundary assignment above;
  // this handles residual gaps at chain/unchanged boundaries and Stage 1 captions.
  const SNAP_THRESHOLD_MS = 500;
  for (let i = 0; i < surviving.length - 1; i++) {
    const gap = surviving[i + 1].start_ms - surviving[i].end_ms;
    if (gap > 0 && gap < SNAP_THRESHOLD_MS) {
      surviving[i].end_ms = surviving[i + 1].start_ms;
    }
  }

  return surviving.map((c, i) => ({ ...c, index: i + 1 }));
}

app.get('/', (req, res) => res.send('ABC Caption Proxy — OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
