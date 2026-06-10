const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const path = require('path');
const { matchCaptionsToTranscript } = require('./lib/matcher');
const {
  GEMINI_MODELS,
  geminiConfigFor,
  buildGeminiPrompt,
  parseSuggestions,
  filterOversizedSuggestions,
} = require('./lib/gemini');
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
      // Gemini 3.x: temperature/top_p/top_k are no longer recommended; use
      // thinkingLevel instead. "low" keeps it fast for this structured task.
      generationConfig: geminiConfigFor('gemini-3.5-flash')
    };

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
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
    // Delete temp file immediately — buffer is in memory, disk copy no longer needed
    fs.unlink(audioFile.tempFilePath, err => {
      if (err) console.error('[cleanup] Failed to delete temp file:', err.message);
    });
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

      const geminiPrompt = buildGeminiPrompt(captions);

      const geminiBodyBase = {
        contents: [{
          parts: [
            { inline_data: { mime_type: audioFormat === 'mp3' ? 'audio/mpeg' : `audio/${audioFormat}`, data: audioBase64 } },
            { text: geminiPrompt }
          ]
        }],
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ]
      };

      // Try models in order, falling back on 503/UNAVAILABLE.
      // gemini-3.5-flash is the new stable flagship (announced at I/O 2026).
      // generationConfig is built per-model — 3.x uses thinkingLevel, 2.x uses temperature.
      const geminiModels = GEMINI_MODELS;
      let geminiResponse, geminiData;
      for (let attempt = 0; attempt < geminiModels.length; attempt++) {
        const model = geminiModels[attempt];
        if (attempt > 0) {
          console.log(`[/api/refine] Gemini falling back to ${model}...`);
        }
        const geminiBody = { ...geminiBodyBase, generationConfig: geminiConfigFor(model) };
        geminiResponse = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geminiBody) }
        );
        if (geminiResponse.ok) break;
        const errBody = await geminiResponse.json();
        console.error(`Gemini ${model} attempt ${attempt} failed: ${errBody?.error?.status}`);
        console.error("Gemini Error Body:", JSON.stringify(errBody, null, 2));
        if (errBody?.error?.status !== 'UNAVAILABLE' && errBody?.error?.status !== 'RESOURCE_EXHAUSTED') {
          clearInterval(keepAlive);
          res.write(JSON.stringify({ status: 'error', error: `Gemini API error: ${errBody?.error?.message || geminiResponse.statusText}` }));
          return res.end();
        }
        if (attempt === geminiModels.length - 1) {
          clearInterval(keepAlive);
          res.write(JSON.stringify({ status: 'error', error: 'Gemini is overloaded — please try again in a minute.' }));
          return res.end();
        }
      }

      geminiData = await geminiResponse.json();

      let suggestions = [];
      try {
        const responseText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
        console.log('Gemini response (first 500 chars):', responseText.substring(0, 500));
        const parsed = parseSuggestions(responseText);
        suggestions = parsed.suggestions;
        if (parsed.salvaged) {
          const finishReason = geminiData.candidates?.[0]?.finishReason;
          console.warn(`[/api/refine] Primary parse failed (${parsed.parseError}). FinishReason: ${finishReason}. Salvaged ${suggestions.length} suggestions from incomplete response.`);
        }
      } catch (e) {
        console.warn(`Could not parse Gemini suggestions: ${e.message}`);
        suggestions = [];
      }

      // Drop oversized suggestions plus everything in their linked chains.
      const preFilterCount = suggestions.length;
      const filterResult = filterOversizedSuggestions(suggestions, captions);
      suggestions = filterResult.kept;
      if (suggestions.length < preFilterCount) {
        console.log(`[/api/refine] Filtered ${preFilterCount - suggestions.length} suggestion(s) due to oversized lines + linked chains (${suggestions.length} remain; affected indices: ${filterResult.droppedIndices.join(', ')})`);
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

    // Captions that need WhisperX timing: Stage 1 reshuffled their text, or AI changed them
    const timingUpdateNeeded = new Set();
    for (const cap of captions) {
      if (cap.timingFlag) timingUpdateNeeded.add(cap.index);
    }
    for (const s of acceptedSuggestions) {
      timingUpdateNeeded.add(s.caption_index);
    }

    console.log(`[/api/refine] Phase 2: WhisperX for ${captions.length} captions, ${acceptedSuggestions.length} accepted changes, ${timingUpdateNeeded.size} need timing updates`);

    const whisperxURL = process.env.WHISPERX_URL;
    if (!whisperxURL) {
      console.warn('WHISPERX_URL not configured, returning accepted text with original timing');
      const fallbackResult = _mergeCaptionSuggestions(captions, acceptedSuggestions, true, new Map(), new Set(), new Map());
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

    async function tryWhisperX(url) {
      console.log(`[/api/refine] Attempting WhisperX at ${url}/transcribe...`);
      return await fetch(`${url}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Secret': process.env.SHARED_SECRET },
        body: JSON.stringify({
          audio_base64: audioBase64,
          audio_format: audioFormat,
        }),
        timeout: 300000
      });
    }

    try {
      let whisperxResponse;
      try {
        whisperxResponse = await tryWhisperX(whisperxURL);
      } catch (e) {
        const fallbackURL = whisperxURL.includes('127.0.0.1') 
          ? whisperxURL.replace('127.0.0.1', 'localhost')
          : whisperxURL.replace('localhost', '127.0.0.1');
        
        console.warn(`[/api/refine] Primary WhisperX failed (${e.message}), trying fallback: ${fallbackURL}`);
        whisperxResponse = await tryWhisperX(fallbackURL);
      }

      if (!whisperxResponse.ok) {
        whisperxError = `WhisperX error: ${whisperxResponse.status}`;
        console.warn(whisperxError);
      } else {
        const rawText = await whisperxResponse.text();
        console.log(`[/api/refine] WhisperX raw response received (${rawText.length} bytes)`);
        try {
          whisperxResult = JSON.parse(rawText.trim());
          console.log(`[/api/refine] WhisperX transcribed ${whisperxResult.words?.length || 0} words`);
        } catch (e) {
          whisperxError = `Failed to parse WhisperX JSON: ${e.message}`;
          console.warn(whisperxError, rawText.slice(0, 100));
        }
      }
    } catch (err) {
      whisperxError = `WhisperX unreachable or timeout: ${err.message}`;
      console.warn(whisperxError);
    }

    // Match all captions to transcript via sequence alignment
    const assignedTiming = new Map();
    const splitRemainderTiming = new Map();
    let matchResults = [];

    if (whisperxResult && Array.isArray(whisperxResult.words)) {
      const whisperWords = whisperxResult.words.filter(w => w.start_ms != null && w.end_ms != null);
      
      // Use refined Gemini text for matching (otherwise alignment fails on changed text).
      // Split remainders are injected immediately after their parent so they get real timing too.
      const suggestionsMap = new Map(acceptedSuggestions.map(s => [s.caption_index, s]));
      const captionsForMatching = [];
      const matchingMeta = []; // {type:'main'|'remainder', capIndex} parallel to captionsForMatching
      for (const cap of captions) {
        const sugg = suggestionsMap.get(cap.index);
        if (sugg) {
          const isDelete = sugg.change_type === 'delete' || !sugg.new_text || sugg.new_text.trim() === '';
          captionsForMatching.push({ ...cap, text: isDelete ? '' : sugg.new_text });
          matchingMeta.push({ type: 'main', capIndex: cap.index });
          if (sugg.change_type === 'split' && sugg.split_remainder?.trim()) {
            captionsForMatching.push({ ...cap, text: sugg.split_remainder.trim() });
            matchingMeta.push({ type: 'remainder', capIndex: cap.index });
          }
        } else {
          captionsForMatching.push(cap);
          matchingMeta.push({ type: 'main', capIndex: cap.index });
        }
      }

      const remainderCount = captionsForMatching.length - captions.length;
      console.log(`[/api/refine] Matching ${captions.length} captions (+${remainderCount} split remainders) to ${whisperWords.length} transcript words...`);
      matchResults = matchCaptionsToTranscript(captionsForMatching, whisperWords);

      let matchedCount = 0;
      for (let i = 0; i < matchingMeta.length; i++) {
        const match = matchResults[i];
        if (!match) continue;
        const { type, capIndex } = matchingMeta[i];
        const timing = {
          startMs:      Math.max(0, match.startMs - 150),
          endMs:        match.endMs + 200,
          words:        match.words,
          matchedRatio: match.matchedRatio,
        };
        if (type === 'main') { matchedCount++; assignedTiming.set(capIndex, timing); }
        else                 { splitRemainderTiming.set(capIndex, timing); }
      }
      console.log(`[/api/refine] Matched ${matchedCount}/${captions.length} captions (${((matchedCount / captions.length) * 100).toFixed(0)}%)`);
    }

    // Only apply WhisperX timing to captions that actually need it
    const filteredTiming = new Map(
      [...assignedTiming].filter(([idx]) => timingUpdateNeeded.has(idx))
    );

    // Captions that needed a timing update but WhisperX couldn't match them
    const suggestionsMapForFailed = new Map(acceptedSuggestions.map(s => [s.caption_index, s]));
    const timingUpdateFailed = new Set();
    for (const idx of timingUpdateNeeded) {
      const sugg = suggestionsMapForFailed.get(idx);
      const isDeleted = sugg && (sugg.change_type === 'delete' || !sugg.new_text || sugg.new_text.trim() === '');
      if (!isDeleted && !filteredTiming.has(idx)) {
        timingUpdateFailed.add(idx);
      }
    }

    const missed = captions
      .filter(c => !assignedTiming.has(c.index))
      .map(c => c.index);

    stages.whisperx = {
      duration_ms:          Date.now() - whisperxStartTime,
      status:               whisperxError ? 'failed' : 'success',
      error:                whisperxError,
      words_transcribed:    whisperxResult?.words?.length || 0,
      matched:              captions.length - missed.length,
      missed_segments:      whisperxError ? [] : missed,
      timing_update_failed: whisperxError ? [...timingUpdateNeeded] : [...timingUpdateFailed],
    };

    const mergedCaptions = _mergeCaptionSuggestions(
      captions,
      acceptedSuggestions,
      !!whisperxError,
      filteredTiming,
      timingUpdateFailed,
      whisperxError ? new Map() : splitRemainderTiming
    );

    // Gemini-only version: accepted text + Stage 1 timing (no WhisperX changes).
    const geminiOnlyCaptions = _mergeCaptionSuggestions(
      captions,
      acceptedSuggestions,
      true,
      new Map(),
      new Set(),
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

// Helper: Merge accepted suggestions + assigned WhisperX timing into original captions.
function _mergeCaptionSuggestions(originalCaptions, suggestions, isPartial, assignedTiming = new Map(), timingUpdateFailed = new Set(), splitRemainderTiming = new Map()) {
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

app.get('/', (req, res) => res.send('ABC Caption Proxy — OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
