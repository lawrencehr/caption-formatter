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
  validateSuggestionChains,
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
      console.log(`[/api/refine] Phase 1: Gemini for ${captions.length} captions`);
      const geminiStartTime = Date.now();

      // Start keepAlive immediately — Render cuts connections at 100s without
      // any bytes written, and medium thinking can take 60-130s.
      res.setHeader('Content-Type', 'application/json');
      res.flushHeaders();
      keepAlive = setInterval(() => res.write(' '), 10000);

      const geminiPrompt = buildGeminiPrompt(captions);

      // Audio is NOT sent to Gemini. A/B testing (test_system/gemini_eval,
      // 2026-06-10) showed audio changes the output no more than run-to-run
      // variance does (Jaccard 0.64 cross-arm vs 0.64 within-arm), while adding
      // 5-12MB per request and ~20% latency. The audio upload itself is still
      // required — Phase 2 sends it to WhisperX for timing alignment.
      const geminiBodyBase = {
        contents: [{
          parts: [
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

      // Chain validation: drop chains that lose/duplicate words, cross italic
      // boundaries, have dangling links, or can't render as ≤2 lines of ≤30 chars.
      // Also strips self-references from linked_suggestions.
      const chainResult = validateSuggestionChains(suggestions, captions);
      suggestions = chainResult.kept;
      for (const d of chainResult.droppedChains) {
        console.log(`[/api/refine] Dropped chain [${d.indices.join(', ')}]: ${d.reason}`);
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

// Merge logic lives in lib/merge.js (shared with the eval harness).
const { mergeCaptionSuggestions: _mergeCaptionSuggestions } = require('./lib/merge');

app.get('/', (req, res) => res.send('ABC Caption Proxy — OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
