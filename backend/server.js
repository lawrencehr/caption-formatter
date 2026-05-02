const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const path = require('path');
const { matchCaptionsToTranscript } = require('./lib/matcher');
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

      const geminiPrompt = `You are an expert caption editor for ABC Media Watch social media videos.
You will receive audio and a list of captions that have been auto-formatted from a Premiere Pro export.

Your job: review the captions against what is actually said in the audio, and suggest improvements where caption breaks fall in awkward places.

MINIMAL CHANGES RULE:
Only suggest changes where they significantly improve readability, fix technical errors (like line length), or correct major phrasing awkwardness. If a caption is already clear and follows the formatting rules, LEAVE IT UNTOUCHED. Do not suggest changes for minor stylistic reasons.

THE GOLDEN RULE: ZERO TEXT LOSS
You MUST NOT edit, rephrase, or omit any words from the original captions. Your only task is to move the boundaries (the breaks) between captions. Every word in the input must appear exactly once in your output. No words can be added, and NO words can be deleted unless the entire caption is being merged into another.

PRIORITISE:
- Captions flagged with "⚠" — these are known to have timing issues
- Abnormally short captions (e.g. 1-2 words) — merge these with neighbors to improve flow unless they are name tags or represent significant dramatic pauses.
- Captions where a person's name is split across two captions
- Caption breaks that fall mid-phrase or mid-thought when the audio has a natural pause elsewhere
- Captions that combine end-of-one-thought + start-of-another (should split)

CRITICAL RULES FOR MOVING TEXT:
1. If you move words from one caption to another, you MUST return an update for BOTH captions to prevent duplicating text!
2. DO NOT DUPLICATE WORDS across captions.
3. CHAIN COMPLETENESS: when you shift text through a sequence, EVERY caption in the chain must have an update. If caption N consumes words from N+1, then N+1 MUST also have an update — either with its new shifted text, or with new_text="" if it was fully absorbed.

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

DO NOT CHANGE:
- The actual words spoken (ZERO text loss!)
- Italic markers
- Visual attributions (e.g. "- Email, ACCC Spokesperson") — these MUST BE KEPT EXACTLY AS THEY ARE.
- The overall sequence of captions.

OUTPUT FORMAT:
Return ONLY a JSON array. No preamble. No markdown. If no changes needed, return [].
For each change, specify:
- caption_index: the 1-based index from the input
- new_text: the suggested replacement text (or "" if deleted)
- change_type: "phrase_break" | "name_kept_together" | "timing_only" | "split" | "merge" | "delete"
- reason: 1-sentence explanation

LINE LENGTH RULE:
Each caption is displayed on up to 2 lines, max 30 characters per line (60 total for normal captions).
Captions with a speaker name tag (e.g. "JOHN SMITH:") always use the first line for the name tag, leaving only the second line for spoken text.
- For these, you MUST fit the spoken text within the provided effective_max_chars (which is 60 minus the name tag length).
- If a caption is flagged with line_too_long: true, you MUST fix the overflow.
- If you cannot move words to a neighbor (because of name tags or italic boundaries), you MUST SPLIT the caption into two separate captions instead.
- NO suggested caption should ever exceed 60 characters total.
Write new_text as a flat string with NO line breaks — the formatter will split it automatically.

INPUT CAPTIONS:
${JSON.stringify(captions.map(c => {
  const NAME_TAG_RE = /^([A-Z][A-Z\s.\-']{1,40}:)/;
  const lines = c.text ? c.text.split('\n') : [];
  const nameTagMatch = lines.length > 0 && NAME_TAG_RE.test(lines[0]);
    // Word count check for "short" captions (excluding tags and name tags)
    const cleanTextForShortCheck = (c.text || '')
      .replace(/<[^>]*>/g, '')         // Strip ALL tags
      .replace(NAME_TAG_RE, '')        // Strip speaker label
      .trim();
    const wordCount = cleanTextForShortCheck ? cleanTextForShortCheck.split(/\s+/).length : 0;
    const isShort = wordCount > 0 && wordCount <= 2 && !nameTagMatch;

    // Check if any spoken line (skip name tag line) exceeds 30 chars
    const spokenLines = nameTagMatch ? lines.slice(1) : lines;
    const lineTooLong = spokenLines.some(l => l.trim().length > 30);
    
    const realTimingFlag = c.timingFlag && c.timingFlag.startsWith('Timing needs') ? c.timingFlag : null;
    const effectiveMax = nameTagMatch ? Math.max(10, 60 - lines[0].length) : 60;
    const entry = {
      index: c.index,
      text: c.text,
      italic: c.italic,
      ...(realTimingFlag ? { timing_flag: realTimingFlag } : {}),
      ...(isShort ? { is_short: true } : {}),
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
        generationConfig: { temperature: 0.1, maxOutputTokens: 65536 },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ]
      };

      // Try models in order, falling back on 503/UNAVAILABLE
      const geminiModels = ['gemini-2.5-flash', 'gemini-2.0-flash'];
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
    let matchResults = [];

    if (whisperxResult && Array.isArray(whisperxResult.words)) {
      const whisperWords = whisperxResult.words.filter(w => w.start_ms != null && w.end_ms != null);
      
      // Use refined Gemini text for matching (otherwise alignment fails on changed text)
      const suggestionsMap = new Map(acceptedSuggestions.map(s => [s.caption_index, s]));
      const captionsForMatching = captions.map(cap => {
        const sugg = suggestionsMap.get(cap.index);
        if (sugg) {
          const isDelete = sugg.change_type === 'delete' || !sugg.new_text || sugg.new_text.trim() === '';
          return { ...cap, text: isDelete ? '' : sugg.new_text };
        }
        return cap;
      });

      console.log(`[/api/refine] Matching ${captionsForMatching.length} captions to ${whisperWords.length} transcript words...`);
      matchResults = matchCaptionsToTranscript(captionsForMatching, whisperWords);

      let matchedCount = 0;
      for (let i = 0; i < captions.length; i++) {
        const match = matchResults[i];
        if (match) {
          matchedCount++;
          assignedTiming.set(captions[i].index, {
            startMs:      match.startMs,
            endMs:        match.endMs + 200,  // 200ms natural tail
            words:        match.words,
            matchedRatio: match.matchedRatio,
          });
        }
      }
      console.log(`[/api/refine] Matched ${matchedCount}/${captions.length} captions (${((matchedCount / captions.length) * 100).toFixed(0)}%)`);
    }

    const missed = captions
      .filter((_, i) => !matchResults[i])
      .map(c => c.index);

    stages.whisperx = {
      duration_ms:       Date.now() - whisperxStartTime,
      status:            whisperxError ? 'failed' : 'success',
      error:             whisperxError,
      words_transcribed: whisperxResult?.words?.length || 0,
      matched:           captions.length - missed.length,
      missed_segments:   whisperxError ? [] : missed,
    };

    const mergedCaptions = _mergeCaptionSuggestions(
      captions,
      acceptedSuggestions,
      !!whisperxError,
      assignedTiming
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

// Helper: Merge accepted suggestions + assigned WhisperX timing into original captions.
function _mergeCaptionSuggestions(originalCaptions, suggestions, isPartial, assignedTiming = new Map()) {
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
      timing_flag: cap.timingFlag || null,
      timing_changed:  timingWasChanged,
      partial:         isPartial,
      words:           assigned ? assigned.words        : null,
      matched_ratio:   assigned ? assigned.matchedRatio : null,
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


  // Ensure 240ms minimum duration and resolve overlaps by trimming ends only.
  // Never move start_ms — it is the matched word boundary from the transcript.
  const MIN_DURATION_MS = 240;
  for (let i = 0; i < surviving.length; i++) {
    const c = surviving[i];
    if (c.end_ms < c.start_ms + MIN_DURATION_MS) {
      c.end_ms = c.start_ms + MIN_DURATION_MS;
    }
    if (i > 0) {
      const prev = surviving[i - 1];
      if (prev.end_ms > c.start_ms) {
        prev.end_ms = Math.max(prev.start_ms + MIN_DURATION_MS, c.start_ms);
      }
    }
  }

  return surviving;
}

app.get('/', (req, res) => res.send('ABC Caption Proxy — OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
