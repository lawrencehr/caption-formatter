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

INPUT CAPTIONS:
${JSON.stringify(captions.map(c => ({
  index: c.index,
  text: c.text,
  italic: c.italic,
  timing_flag: c.timingFlag || null
})), null, 2)}`;

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
      const geminiModels = ['gemini-3.0-flash', 'gemini-2.5-flash', 'gemini-2.0-flash'];
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

      return res.json({ status: 'suggestions', stages, suggestions });
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

    // Build textForAlignment using only the accepted suggestions
    const suggestionsMap = new Map(acceptedSuggestions.map(s => [s.caption_index, s]));
    const textForAlignment = captions.map(cap => {
      const suggestion = suggestionsMap.get(cap.index);
      const newText = suggestion && suggestion.new_text !== null && suggestion.new_text !== undefined ? suggestion.new_text : cap.text;
      const startMs = cap.start_ms !== null ? (suggestion ? Math.max(0, cap.start_ms - 3000) : cap.start_ms) : null;
      const endMs = cap.end_ms !== null ? (suggestion ? cap.end_ms + 3000 : cap.end_ms) : null;
      return { index: cap.index, text: newText, start_ms: startMs, end_ms: endMs };
    }).filter(c => c.text && c.text.trim().length > 0);

    const whisperxURL = process.env.WHISPERX_URL;
    if (!whisperxURL) {
      console.warn('WHISPERX_URL not configured, returning accepted text with original timing');
      const fallbackResult = _mergeCaptionSuggestions(captions, acceptedSuggestions, captions, true);
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
      !!whisperxError
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

// Helper: Merge Gemini suggestions + italic flags + WhisperX timing
function _mergeCaptionSuggestions(originalCaptions, suggestions, timingCaptions, isPartial) {
  const suggestionsMap = new Map(suggestions.map(s => [s.caption_index, s]));
  const timingMap = new Map(timingCaptions.map(t => [t.index, t]));

  return originalCaptions.map(cap => {
    const suggestion = suggestionsMap.get(cap.index);
    let timingData = timingMap.get(cap.index);

    // If WhisperX alignment failed for a widened caption, it falls back to the widened bounds!
    // We must detect this and revert to the original precise bounds instead.
    if (timingData && suggestion && cap.start_ms !== null && cap.end_ms !== null) {
      const widenedStart = Math.max(0, cap.start_ms - 3000);
      const widenedEnd = cap.end_ms + 3000;
      if (timingData.start_ms === widenedStart && timingData.end_ms === widenedEnd) {
        timingData.start_ms = cap.start_ms;
        timingData.end_ms = cap.end_ms;
      }
    }

    return {
      index: cap.index,
      text: suggestion && suggestion.new_text !== null && suggestion.new_text !== undefined ? suggestion.new_text : cap.text,
      italic: cap.italic, // ALWAYS from original — never modified
      start_ms: timingData ? timingData.start_ms : cap.start_ms,
      end_ms: timingData ? timingData.end_ms : cap.end_ms,
      changed: !!suggestion,
      change_type: suggestion ? suggestion.change_type : null,
      original_text: cap.text,
      timing_flag: cap.timingFlag || null,
      partial: isPartial
    };
  });
}

app.get('/', (req, res) => res.send('ABC Caption Proxy — OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
