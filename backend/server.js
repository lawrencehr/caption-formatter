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

// ── Stage 2: Gemini caption refinement + WhisperX timing alignment ──────────────
app.post('/api/refine', async (req, res) => {
  const startTime = Date.now();
  const stages = {};

  try {
    // Validate inputs
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

    console.log(`[/api/refine] Processing ${captions.length} captions, audio size: ${audioBuffer.length} bytes`);


    // ── Step 1: Gemini caption refinement ──────────────────────────────────────
    console.log('[/api/refine] Step 1: Calling Gemini for caption suggestions...');
    const geminiStartTime = Date.now();

    const geminiPrompt = `You are an expert caption editor for ABC Media Watch social media videos.
You will receive audio and a list of captions that have been auto-formatted from a Premiere Pro export.

Your job: review the captions against what is actually said in the audio, and suggest improvements where caption breaks fall in awkward places.

PRIORITISE:
- Captions flagged with "⚠" — these are known to have timing issues
- Captions where a person's name is split across two captions
- Caption breaks that fall mid-phrase or mid-thought when the audio has a natural pause elsewhere
- Captions that combine end-of-one-thought + start-of-another (should split)

DO NOT CHANGE:
- The actual words spoken (no rewriting, only adjusting where breaks fall)
- Italic markers
- The overall sequence of captions (don't reorder)
- Captions that already work well

OUTPUT FORMAT:
Return ONLY a JSON array. No preamble. No markdown. If no changes needed, return [].
For each change, specify:
- caption_index: the 1-based index from the input
- new_text: the suggested replacement text (or null if just timing change)
- change_type: "phrase_break" | "name_kept_together" | "timing_only" | "split" | "merge"
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
          {
            inline_data: {
              mime_type: audioFormat === 'mp3' ? 'audio/mpeg' : `audio/${audioFormat}`,
              data: audioBase64
            }
          },
          { text: geminiPrompt }
        ]
      }],
      generationConfig: { temperature: 0.2 }
    };

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody),
        timeout: 120000
      }
    );

    if (!geminiResponse.ok) {
      console.error(`Gemini error: ${geminiResponse.status} ${geminiResponse.statusText}`);
      const geminiError = await geminiResponse.json();
      console.error('Gemini error details:', geminiError);
      return res.status(500).json({
        status: 'error',
        error: `Gemini API error: ${geminiResponse.statusText}`,
        captions: captions // Return original captions on error
      });
    }

    const geminiData = await geminiResponse.json();
    stages.gemini = {
      duration_ms: Date.now() - geminiStartTime,
      suggestions_count: 0
    };

    // Extract JSON from Gemini response
    let suggestions = [];
    try {
      const responseText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
      console.log('Gemini response (first 500 chars):', responseText.substring(0, 500));

      // Try to extract JSON from the response
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        suggestions = JSON.parse(jsonMatch[0]);
      } else {
        // If response is already JSON
        suggestions = JSON.parse(responseText);
      }
    } catch (e) {
      console.warn(`Could not parse Gemini suggestions as JSON: ${e.message}`);
      suggestions = []; // Fall back to no changes
    }

    stages.gemini.suggestions_count = suggestions.length;
    console.log(`[/api/refine] Gemini returned ${suggestions.length} suggestions`);

    // ── Step 2: Build suggested captions for WhisperX ──────────────────────────
    const suggestionsMap = new Map(suggestions.map(s => [s.caption_index, s]));
    const textForAlignment = captions.map(cap => ({
      index: cap.index,
      text: suggestionsMap.has(cap.index) && suggestionsMap.get(cap.index).new_text
        ? suggestionsMap.get(cap.index).new_text
        : cap.text,
      start_ms: cap.start_ms,  // pass original SRT timing for forced alignment
      end_ms: cap.end_ms,
    }));

    // ── Step 3: WhisperX force-alignment ─────────────────────────────────────
    console.log('[/api/refine] Step 2: Calling WhisperX for timing alignment...');
    const whisperxStartTime = Date.now();

    const whisperxURL = process.env.WHISPERX_URL;
    if (!whisperxURL) {
      console.warn('WHISPERX_URL not configured, skipping alignment');
      stages.whisperx = { duration_ms: 0, status: 'skipped' };
      // Fall back to Gemini suggestions with original timing
      const fallbackResult = _mergeCaptionSuggestions(
        captions,
        suggestions,
        captions, // Use original timing
        true // partial flag
      );
      return res.json({
        status: 'partial',
        error: 'WhisperX not configured',
        stages,
        captions: fallbackResult
      });
    }

    let whisperxResult = null;
    let whisperxError = null;

    // Start sending spaces to frontend to avert Render 100s timeout
    res.setHeader('Content-Type', 'application/json');
    res.flushHeaders();
    const keepAlive = setInterval(() => res.write(' '), 10000);

    try {
      const whisperxResponse = await fetch(`${whisperxURL}/align`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Secret': process.env.SHARED_SECRET
        },
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

    // ── Step 4: Merge results ────────────────────────────────────────────────
    const timingFromWhisperX = whisperxResult ? whisperxResult.captions : captions;
    const mergedCaptions = _mergeCaptionSuggestions(
      captions,
      suggestions,
      timingFromWhisperX,
      !!whisperxError // partial if WhisperX failed
    );

    console.log(`[/api/refine] Pipeline complete in ${Date.now() - startTime}ms`);

    clearInterval(keepAlive);
    res.write(JSON.stringify({
      status: whisperxError ? 'partial' : 'success',
      error: whisperxError || null,
      stages,
      captions: mergedCaptions
    }));
    return res.end();

  } catch (err) {
    if (typeof keepAlive !== 'undefined') clearInterval(keepAlive);
    console.error('[/api/refine] Unexpected error:', err);
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json');
    res.write(JSON.stringify({
      status: 'error',
      error: `Refinement pipeline error: ${err.message}`
    }));
    return res.end();
  }
});

// Helper: Merge Gemini suggestions + italic flags + WhisperX timing
function _mergeCaptionSuggestions(originalCaptions, suggestions, timingCaptions, isPartial) {
  const suggestionsMap = new Map(suggestions.map(s => [s.caption_index, s]));
  const timingMap = new Map(timingCaptions.map(t => [t.index, t]));

  return originalCaptions.map(cap => {
    const suggestion = suggestionsMap.get(cap.index);
    const timingData = timingMap.get(cap.index);

    return {
      index: cap.index,
      text: suggestion && suggestion.new_text ? suggestion.new_text : cap.text,
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
