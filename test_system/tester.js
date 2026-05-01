'use strict';

const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
// Set SHARED_SECRET as an env var before running:
//   SHARED_SECRET=yourvalue node tester.js
const SHARED_SECRET = process.env.SHARED_SECRET ||
  (() => { throw new Error('Set SHARED_SECRET env var: SHARED_SECRET=yourvalue node tester.js'); })();

const PROXY_URL    = process.env.PROXY_URL    || 'http://localhost:3000';
const WHISPERX_URL = process.env.WHISPERX_URL || 'http://localhost:8765';

const SRT_FILE   = process.argv[2] || path.join(__dirname, '..', 'Test files', 'Before cleanup v2.srt');
const AUDIO_FILE = process.argv[3] || path.join(__dirname, '..', 'Test files', 'Ep11.mp3');
const OUT_FILE   = path.join(__dirname, 'test_output.json');

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('--- STARTING END-TO-END TEST ---');
  console.log(`  Proxy:      ${PROXY_URL}`);
  console.log(`  WhisperX:   ${WHISPERX_URL}`);
  console.log(`  SRT:        ${SRT_FILE}`);
  console.log(`  Audio:      ${AUDIO_FILE}`);

  // 1. Load SRT
  console.log('\nLoading SRT...');
  const srtContent = fs.readFileSync(SRT_FILE, 'utf8');
  const captions = parseSRT(srtContent).map(c => ({
    ...c,
    timingFlag: 'Timing needs checking', // Force retiming for all
  }));
  console.log(`Loaded ${captions.length} captions.`);

  // 2. Skip Phase 1 (Gemini)
  console.log('\n--- SKIPPING PHASE 1 (GEMINI) ---');
  const suggestions = [];

  // 3. Phase 2: WhisperX Alignment
  console.log('\n--- PHASE 2: WHISPERX ---');
  console.log('Sending request to /api/refine (Phase 2)...');

  const formData = new FormData();
  formData.append('audio', new Blob([fs.readFileSync(AUDIO_FILE)]), path.basename(AUDIO_FILE));
  formData.append('captions', JSON.stringify(captions));
  formData.append('accepted_suggestions', JSON.stringify(suggestions));

  const startTime = Date.now();
  const response = await fetch(`${PROXY_URL}/api/refine`, {
    method: 'POST',
    headers: { 'X-Secret': SHARED_SECRET },
    body: formData,
  });

  if (!response.ok) {
    console.error('Phase 2 failed:', response.status);
    console.error(await response.text());
    process.exit(1);
  }

  const result = await response.json();
  console.log(`Phase 2 took ${Date.now() - startTime}ms`);

  const missed = result.stages?.whisperx?.missed_segments || [];
  if (missed.length > 0) {
    console.warn(`WhisperX missed ${missed.length} segment(s): indices ${missed.join(', ')}`);
  }

  // 4. Quick summary
  console.log('\n--- QUICK SUMMARY ---');
  const refined = result.captions || [];
  const shortCaptions = refined.filter(c => (c.end_ms - c.start_ms) <= 500);
  console.log(`Captions total: ${refined.length}  |  <= 500ms: ${shortCaptions.length}`);
  shortCaptions.slice(0, 10).forEach(c => {
    console.log(`  #${c.index} (${c.end_ms - c.start_ms}ms): "${c.text}"`);
    if (c.words?.length) {
      console.log(`    Words: ${c.words.map(w => `"${w.word}"(${w.start_ms}-${w.end_ms}ms)`).join(' ')}`);
    } else {
      console.log('    (no word-level data — fallback timing)');
    }
  });

  // 5. Save output (include input captions for timing-shift analysis in analyze.js)
  const output = { ...result, input_captions: captions };
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\nFull result saved to: ${OUT_FILE}`);

  // 6. Run quality analysis
  console.log('\n--- RUNNING QUALITY ANALYSIS ---');
  runAnalysis();
}

// ── Quality Analysis ──────────────────────────────────────────────────────────

function runAnalysis() {
  // analyze.js reads test_output.json and calls process.exit() with 0 (pass) or 1 (fail)
  require('./analyze.js');
}

// ── SRT Parsing ───────────────────────────────────────────────────────────────

function parseSRT(data) {
  return data.split(/\r?\n\r?\n/).map(seg => {
    const lines = seg.split(/\r?\n/);
    if (lines.length < 3) return null;
    const index = parseInt(lines[0]);
    const times = lines[1].match(/(\d+:\d+:\d+,\d+) --> (\d+:\d+:\d+,\d+)/);
    if (!times) return null;
    return {
      index,
      start_ms: timeToMs(times[1]),
      end_ms:   timeToMs(times[2]),
      text:     lines.slice(2).join('\n'),
      italic:   lines.slice(2).join('\n').includes('<i>'),
    };
  }).filter(Boolean);
}

function timeToMs(t) {
  const parts = t.split(/[:,]/);
  return (parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2])) * 1000 + parseInt(parts[3]);
}

main().catch(err => { console.error(err.message); process.exit(1); });
