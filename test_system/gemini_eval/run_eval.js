// Gemini Phase-1 evaluation runner.
//
// Pipeline per episode: raw SRT + transcript DOCX → Stage 1 (Node port) →
// production Gemini prompt (backend/lib/gemini.js) + audio → suggestions.
// No WhisperX. Each run is saved in full (raw response, parsed + filtered
// suggestions, model used, finish reason, token usage) to results/.
//
// Usage:
//   set GEMINI_API_KEY=AIza...
//   node run_eval.js                  # all episodes × 2 runs
//   node run_eval.js ep11 ep14        # specific episodes
//   node run_eval.js --runs 3         # change runs per episode
//
// Then: node evaluate.js

const fs = require('fs');
const path = require('path');

const {
  GEMINI_MODELS,
  geminiConfigFor,
  buildGeminiPrompt,
  parseSuggestions,
  filterOversizedSuggestions,
} = require('../../backend/lib/gemini');
const { runStage1 } = require('./stage1');

const RESULTS_DIR = path.join(__dirname, 'results');

// Find the "Test files" directory by walking up from here (works from both
// the main checkout and a git worktree under .claude/worktrees/).
function findTestFilesDir() {
  if (process.env.TEST_FILES_DIR) return process.env.TEST_FILES_DIR;
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'Test files');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Worktree case: hop from <repo>/.claude/worktrees/<name> to <repo>
  const m = __dirname.match(/^(.*?)[\\\/]\.claude[\\\/]worktrees[\\\/]/);
  if (m) {
    const candidate = path.join(m[1], 'Test files');
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Could not locate the "Test files" directory — set TEST_FILES_DIR');
}

function discoverEpisodes(testFilesDir) {
  return fs.readdirSync(testFilesDir)
    .filter(d => /^ep\d+$/.test(d))
    .filter(d => {
      const base = path.join(testFilesDir, d);
      return fs.existsSync(path.join(base, `${d}_subtitles.srt`)) &&
             fs.existsSync(path.join(base, `${d}_transcript.docx`)) &&
             fs.existsSync(path.join(base, `${d}_audio.mp3`));
    })
    .sort();
}

// Replicates the server's model fallback loop, but also reports which model
// answered and the full candidate metadata.
async function callGemini(promptText, audioBase64, log) {
  const geminiBodyBase = {
    contents: [{
      parts: [
        { inline_data: { mime_type: 'audio/mpeg', data: audioBase64 } },
        { text: promptText },
      ],
    }],
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };

  for (let attempt = 0; attempt < GEMINI_MODELS.length; attempt++) {
    const model = GEMINI_MODELS[attempt];
    if (attempt > 0) log(`  falling back to ${model}...`);
    const body = { ...geminiBodyBase, generationConfig: geminiConfigFor(model) };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000);
    let response;
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal }
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      const data = await response.json();
      return { model, data };
    }
    const errBody = await response.json().catch(() => ({}));
    const status = errBody?.error?.status;
    log(`  ${model} failed: ${status || response.status} — ${errBody?.error?.message || response.statusText}`);
    if (status !== 'UNAVAILABLE' && status !== 'RESOURCE_EXHAUSTED') {
      throw new Error(`Gemini API error (${model}): ${errBody?.error?.message || response.statusText}`);
    }
  }
  throw new Error('All Gemini models exhausted (overloaded)');
}

async function runEpisode(testFilesDir, ep, runNum) {
  const base = path.join(testFilesDir, ep);
  const srtText = fs.readFileSync(path.join(base, `${ep}_subtitles.srt`), 'utf8');
  const docxBuffer = fs.readFileSync(path.join(base, `${ep}_transcript.docx`));
  const audioBase64 = fs.readFileSync(path.join(base, `${ep}_audio.mp3`)).toString('base64');

  const log = msg => console.log(`[${ep} run${runNum}] ${msg}`);

  const stage1Start = Date.now();
  const stage1 = await runStage1(srtText, docxBuffer);
  log(`stage 1: ${stage1.rawCaptions.length} raw → ${stage1.result.length} formatted captions, ${stage1.boldSegments.length} bold segments (${Date.now() - stage1Start}ms)`);

  // Save Stage 1 output once per episode (identical across runs — it is deterministic)
  const stage1Path = path.join(RESULTS_DIR, `${ep}_stage1.json`);
  if (!fs.existsSync(stage1Path)) {
    fs.writeFileSync(stage1Path, JSON.stringify({
      episode: ep,
      bold_segments: stage1.boldSegments,
      raw_caption_count: stage1.rawCaptions.length,
      captions: stage1.apiCaptions,
    }, null, 2));
  }

  const prompt = buildGeminiPrompt(stage1.apiCaptions);
  log(`calling Gemini (prompt ${prompt.length} chars, audio ${(audioBase64.length * 0.75 / 1024 / 1024).toFixed(1)}MB)...`);

  const geminiStart = Date.now();
  const { model, data } = await callGemini(prompt, audioBase64, log);
  const geminiMs = Date.now() - geminiStart;

  const candidate = data.candidates?.[0];
  const responseText = candidate?.content?.parts?.[0]?.text || '';
  const parsed = parseSuggestions(responseText);
  const filtered = filterOversizedSuggestions(parsed.suggestions, stage1.apiCaptions);

  log(`${model} answered in ${(geminiMs / 1000).toFixed(1)}s — ${parsed.suggestions.length} suggestions` +
      (parsed.salvaged ? ' (SALVAGED from truncated response)' : '') +
      (filtered.droppedIndices.length ? `, ${filtered.droppedIndices.length} dropped by oversize filter` : ''));

  const out = {
    episode: ep,
    run: runNum,
    timestamp: new Date().toISOString(),
    model,
    gemini_ms: geminiMs,
    finish_reason: candidate?.finishReason || null,
    usage: data.usageMetadata || null,
    salvaged: parsed.salvaged,
    parse_error: parsed.parseError || null,
    raw_response_text: responseText,
    suggestions_raw: parsed.suggestions,
    suggestions_filtered: filtered.kept,
    filter_dropped_indices: filtered.droppedIndices,
  };
  fs.writeFileSync(path.join(RESULTS_DIR, `${ep}_run${runNum}.json`), JSON.stringify(out, null, 2));
  return out;
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set. Set it and re-run:\n  PowerShell:  $env:GEMINI_API_KEY = "AIza..."');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  let runs = 2;
  const runsIdx = args.indexOf('--runs');
  if (runsIdx !== -1) { runs = Number(args[runsIdx + 1]) || 2; args.splice(runsIdx, 2); }

  const testFilesDir = findTestFilesDir();
  const all = discoverEpisodes(testFilesDir);
  const episodes = args.length ? all.filter(e => args.includes(e)) : all;
  if (!episodes.length) {
    console.error(`No matching episodes. Available: ${all.join(', ')}`);
    process.exit(1);
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  console.log(`Episodes: ${episodes.join(', ')} × ${runs} runs (test files: ${testFilesDir})\n`);

  const failures = [];
  for (const ep of episodes) {
    for (let r = 1; r <= runs; r++) {
      try {
        await runEpisode(testFilesDir, ep, r);
      } catch (err) {
        console.error(`[${ep} run${r}] FAILED: ${err.message}`);
        failures.push({ ep, run: r, error: err.message });
      }
    }
  }

  console.log('\nDone. Results in', RESULTS_DIR);
  if (failures.length) {
    console.log(`${failures.length} run(s) failed:`, failures.map(f => `${f.ep} run${f.run}`).join(', '));
  }
  console.log('Next: node evaluate.js');
}

main().catch(err => { console.error(err); process.exit(1); });
