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

Your job: review the captions against what is actually said in the audio, and suggest improvements where caption breaks fall in awkward places.

PRIORITISE:
- Captions flagged with "⚠" — these are known to have timing issues
- Captions where a person's name is split across two captions
- Caption breaks that fall mid-phrase or mid-thought when the audio has a natural pause elsewhere
- Captions that combine end-of-one-thought + start-of-another (should split)

CRITICAL RULES FOR MOVING TEXT:
1. If you move words from one caption to another, you MUST return an update for BOTH captions to prevent duplicating text!
2. For example, if you move the word "retailers" from caption 90 to 89:
   - Return an update for 89 adding the word.
   - Return an update for 90 removing the word (set new_text to "" if the caption becomes empty).
3. DO NOT DUPLICATE WORDS across captions.
4. CHAIN COMPLETENESS: when you shift text forward (or backward) through a sequence of captions, EVERY caption in the chain must have an update. If caption N's new_text consumes words from N+1, then N+1 MUST also have an update — either with its new (shifted) text, or with new_text="" if it becomes empty. Never leave the last caption in a chain untouched while its text has been absorbed elsewhere — that creates a duplicate.
   Worked example — original captions:
     #75 "its existing copper,"
     #76 "zinc, and lead"
     #77 "mine, MMG plans to bulldoze"
     #78 "hundreds of hectares of the Tarkine,"
     #79 "for a new gigantic tailings dam of toxic sludge."
   If you redistribute as:
     #75 → "LIAM BARTLETT: … to expand its existing"
     #76 → "copper, zinc, and lead mine, MMG plans to"
     #77 → "bulldoze hundreds of hectares of the Tarkine,"
   then you MUST also include:
     #78 → "for a new gigantic tailings dam of toxic sludge."  (its words got pushed forward)
     #79 → ""  (empty because all its words were consumed)
   Otherwise #78 will keep "hundreds of hectares of the Tarkine," and duplicate #77's tail.

NAME TAG RULE:
A speaker name tag (e.g. "LIAM BARTLETT:", "CHRIS BOWEN:") MUST always remain as the FIRST LINE of its own caption.
- NEVER move text from a preceding caption into a caption that starts with a name tag — it would push the name tag off the top line.
- NEVER move the name tag itself away from the start of its caption.
- When text following a name tag is too long, redistribute words with the caption AFTER the name tag caption, not the caption before it.

ITALIC BOUNDARY RULE:
Never suggest changes that would merge text across italic/non-italic boundaries.
- If caption N is italic and caption N+1 is not italic (or vice versa), do NOT move text between them.
- Each caption must be entirely italic or entirely non-italic.

DO NOT CHANGE:
- The actual words spoken (no rewriting, only adjusting where breaks fall)
- Italic markers
- Visual attributions, names, or dates at the end of captions (e.g. "- Email, ACCC Spokesperson, 20 Apr 2026") MUST BE KEPT EXACTLY AS THEY ARE, even if they are not spoken in the audio!
- The overall sequence of captions (don't reorder)

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
For these, effective_max_chars = 60 - length of the name tag line.
If a caption has line_too_long: true, the current text overflows — you MUST suggest a redistribution of words with neighbouring captions so the spoken text fits within effective_max_chars total characters.
Write new_text as a flat string with NO line breaks — the formatter will split it automatically.

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
  const entry = {
    index: c.index,
    text: c.text,
    italic: c.italic,
    timing_flag: c.timingFlag || null,
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
        generationConfig: { temperature: 0.2 }
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
        suggestions = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(responseText);
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

    // Build textForAlignment using only the accepted suggestions.
    // For changed captions, bound the WhisperX search window to the gap between
    // the nearest unchanged captions on each side — this prevents WhisperX from
    // grabbing words that belong to adjacent stable captions (the old ±3s approach
    // was too wide and caused timestamps to collide and captions to be reordered).
    const suggestionsMap = new Map(acceptedSuggestions.map(s => [s.caption_index, s]));
    const isChangedSet = new Set(acceptedSuggestions.map(s => s.caption_index));
    const BOUNDARY_BUFFER_MS = 300;
    const alignmentWindows = new Map(); // capIndex → { windowStart, windowEnd }

    // Resolve final text per caption (treats null/empty/delete as empty)
    const resolveText = (cap, suggestion) => {
      if (!suggestion) return cap.text;
      const isDelete = suggestion.change_type === 'delete' ||
        suggestion.new_text === null ||
        suggestion.new_text === undefined ||
        (typeof suggestion.new_text === 'string' && suggestion.new_text.trim() === '');
      return isDelete ? '' : suggestion.new_text;
    };

    // Group consecutive changed captions into chains so we can split their
    // shared outer window into proportional sub-windows. Without this, three
    // adjacent changed captions all get the same window and WhisperX collapses
    // them into 0.5s micro-captions.
    const chainStart = new Array(captions.length).fill(-1);
    let i = 0;
    while (i < captions.length) {
      if (!isChangedSet.has(captions[i].index)) { i++; continue; }
      const start = i;
      while (i < captions.length && isChangedSet.has(captions[i].index)) {
        chainStart[i] = start;
        i++;
      }
    }

    const textForAlignment = captions.map((cap, idx) => {
      const suggestion = suggestionsMap.get(cap.index);
      const newText = resolveText(cap, suggestion);

      let startMs = cap.start_ms;
      let endMs = cap.end_ms;
      if (suggestion) {
        const chainHead = chainStart[idx];
        // Find outer window: nearest unchanged neighbours on either side of the chain
        let leftMs = null, rightMs = null;
        for (let j = chainHead - 1; j >= 0; j--) {
          if (!isChangedSet.has(captions[j].index)) { leftMs = captions[j].end_ms; break; }
        }
        let chainEnd = chainHead;
        while (chainEnd + 1 < captions.length && chainStart[chainEnd + 1] === chainHead) chainEnd++;
        for (let j = chainEnd + 1; j < captions.length; j++) {
          if (!isChangedSet.has(captions[j].index)) { rightMs = captions[j].start_ms; break; }
        }
        const outerStart = Math.max(0, leftMs !== null ? leftMs - BOUNDARY_BUFFER_MS : (captions[chainHead].start_ms || 0) - 1000);
        const outerEnd = rightMs !== null ? rightMs + BOUNDARY_BUFFER_MS : ((captions[chainEnd].end_ms || 0) + 1000);

        // Allocate sub-window for THIS caption based on its text length share
        // within the chain. Single-caption chains keep the full outer window.
        if (chainHead === chainEnd) {
          startMs = outerStart;
          endMs = outerEnd;
        } else {
          const chainTexts = [];
          for (let k = chainHead; k <= chainEnd; k++) {
            chainTexts.push(resolveText(captions[k], suggestionsMap.get(captions[k].index)) || '');
          }
          const lens = chainTexts.map(t => Math.max(1, t.trim().length));
          const totalLen = lens.reduce((a, b) => a + b, 0);
          const totalSpan = Math.max(1000, outerEnd - outerStart);
          const localIdx = idx - chainHead;
          let cumStart = 0;
          for (let k = 0; k < localIdx; k++) cumStart += lens[k];
          const subStart = outerStart + Math.round((cumStart / totalLen) * totalSpan);
          const subEnd = outerStart + Math.round(((cumStart + lens[localIdx]) / totalLen) * totalSpan);
          // Pad sub-window slightly so WhisperX has wiggle room; clamp to outer
          const PAD_MS = 250;
          startMs = Math.max(outerStart, subStart - PAD_MS);
          endMs = Math.min(outerEnd, subEnd + PAD_MS);
        }

        if (endMs - startMs < 1000) endMs = startMs + 1000;
        alignmentWindows.set(cap.index, { windowStart: startMs, windowEnd: endMs });
      }

      return { index: cap.index, text: newText, start_ms: startMs, end_ms: endMs };
    }).filter(c => c.text && c.text.trim().length > 0);

    const whisperxURL = process.env.WHISPERX_URL;
    if (!whisperxURL) {
      console.warn('WHISPERX_URL not configured, returning accepted text with original timing');
      const fallbackResult = _mergeCaptionSuggestions(captions, acceptedSuggestions, captions, true, new Map());
      return res.json({
        status: 'partial',
        error: 'WhisperX not configured — using accepted text with original timing',
        stages,
        captions: fallbackResult
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
        console.log(`[/api/refine] WhisperX returned timing for ${whisperxResult.captions?.length || 0} captions`);
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

    const timingFromWhisperX = whisperxResult ? whisperxResult.captions : captions;
    const mergedCaptions = _mergeCaptionSuggestions(
      captions,
      acceptedSuggestions,
      timingFromWhisperX,
      !!whisperxError,
      alignmentWindows
    );

    console.log(`[/api/refine] Phase 2 complete in ${Date.now() - startTime}ms`);

    clearInterval(keepAlive);
    res.write(JSON.stringify({
      status: whisperxError ? 'partial' : 'success',
      error: whisperxError || null,
      stages,
      captions: mergedCaptions
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

// Helper: Merge accepted suggestions + WhisperX timing into original captions
// Rules:
//  - Italic ALWAYS comes from the original caption (Stage 1)
//  - Text comes from the accepted suggestion if present, else original
//  - Timing comes from WhisperX ONLY for changed captions; unchanged captions keep
//    their original Stage-1 timing so we don't break the back-to-back caption flow
//  - Captions whose suggestion sets new_text="" (delete intent) are dropped
//  - Survivors are renumbered sequentially starting from 1
function _mergeCaptionSuggestions(originalCaptions, suggestions, timingCaptions, isPartial, alignmentWindows = new Map()) {
  const suggestionsMap = new Map(suggestions.map(s => [s.caption_index, s]));
  const timingMap = new Map(timingCaptions.map(t => [t.index, t]));

  const merged = originalCaptions.map(cap => {
    const suggestion = suggestionsMap.get(cap.index);
    const isChanged = !!suggestion;
    // Resolve final text. A delete is signalled by either change_type="delete"
    // OR new_text being null/undefined/empty when there's a suggestion (Gemini
    // sometimes returns null instead of "" for deletes). Otherwise use the
    // suggestion's new_text, or fall back to original.
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

    // Timing: only use WhisperX result for CHANGED captions.
    // Unchanged captions keep original Stage-1 timing exactly.
    let startMs = cap.start_ms;
    let endMs = cap.end_ms;
    if (isChanged) {
      const timingData = timingMap.get(cap.index);
      if (timingData) {
        const win = alignmentWindows.get(cap.index);
        // Detect WhisperX failure: it returned exactly the input window bounds (fallback behavior)
        const failedAlignment = win &&
          timingData.start_ms === win.windowStart &&
          timingData.end_ms === win.windowEnd;
        if (failedAlignment) {
          startMs = cap.start_ms;
          endMs = cap.end_ms;
        } else {
          startMs = timingData.start_ms;
          endMs = timingData.end_ms;
        }
      }
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
  const normalizeForCompare = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const dedupFlags = new Array(surviving.length).fill(false);
  for (let i = 0; i < surviving.length - 1; i++) {
    const curr = surviving[i];
    const next = surviving[i + 1];
    if (!curr.changed || next.changed) continue;
    const currNorm = normalizeForCompare(curr.text);
    const nextNorm = normalizeForCompare(next.text);
    if (nextNorm.length < 4) continue; // ignore trivially short
    if (currNorm.includes(nextNorm)) dedupFlags[i + 1] = true;
  }
  // Reverse direction: changed caption fully contained inside an unchanged neighbour above
  for (let i = 1; i < surviving.length; i++) {
    const prev = surviving[i - 1];
    const curr = surviving[i];
    if (!curr.changed || prev.changed || dedupFlags[i - 1]) continue;
    const prevNorm = normalizeForCompare(prev.text);
    const currNorm = normalizeForCompare(curr.text);
    if (currNorm.length < 4) continue;
    if (prevNorm.includes(currNorm)) dedupFlags[i - 1] = true;
  }
  if (dedupFlags.some(Boolean)) {
    surviving = surviving.filter((_, i) => !dedupFlags[i]);
  }

  // Clamp overlaps in original index order — DO NOT sort by timestamp.
  // Sorting by WhisperX timestamps reorders text content when alignment is imperfect,
  // which is worse than slightly mis-timed captions in the correct order.
  for (let i = 1; i < surviving.length; i++) {
    if (surviving[i].start_ms < surviving[i - 1].end_ms) {
      surviving[i].start_ms = surviving[i - 1].end_ms;
    }
    if (surviving[i].end_ms <= surviving[i].start_ms) {
      surviving[i].end_ms = surviving[i].start_ms + 500;
    }
  }

  // Snap-to-next pass: extend each caption's end to meet the next one's start,
  // but only for small gaps (< 500ms). Larger gaps = intentional silence.
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
