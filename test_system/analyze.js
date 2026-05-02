'use strict';

// Analyzes a test_output.json file produced by tester.js.
// Usage: node analyze.js [path/to/test_output.json]
// Defaults to test_output.json in the same directory.

const fs   = require('fs');
const path = require('path');

const outputPath = process.argv[2] || path.join(__dirname, 'test_output.json');

if (!fs.existsSync(outputPath)) {
  console.error(`File not found: ${outputPath}`);
  console.error('Run tester.js first, or: node analyze.js <path/to/test_output.json>');
  process.exit(1);
}

const data        = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
const captions    = data.captions || [];
const origMap     = new Map((data.input_captions || []).map(c => [c.index, c]));
const missedSegs  = data.stages?.whisperx?.missed_segments || [];

const failures = [];
const warnings = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(n, total) {
  return total === 0 ? '—' : `${((n / total) * 100).toFixed(1)}%`;
}

function stats(arr) {
  if (!arr.length) return { mean: 0, median: 0, p95: 0, max: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const mean   = arr.reduce((s, v) => s + v, 0) / arr.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95    = sorted[Math.floor(sorted.length * 0.95)];
  const max    = sorted[sorted.length - 1];
  return { mean: Math.round(mean), median, p95, max };
}

function pad(str, n) {
  return String(str).padStart(n);
}

// ── Metric 1: Duration Distribution ──────────────────────────────────────────

const durations = captions.map(c => c.end_ms - c.start_ms);
const dur_sub240  = captions.filter((_, i) => durations[i] < 240);
const dur_240_500 = captions.filter((_, i) => durations[i] >= 240 && durations[i] < 500);
const dur_500_1k  = captions.filter((_, i) => durations[i] >= 500 && durations[i] < 1000);
const dur_1k_3k   = captions.filter((_, i) => durations[i] >= 1000 && durations[i] < 3000);
const dur_3k_plus = captions.filter((_, i) => durations[i] >= 3000);

if (dur_sub240.length > 0) {
  failures.push(`${dur_sub240.length} caption(s) < 240ms (Premiere will reject): indices ${dur_sub240.map(c => c.index).join(', ')}`);
}

// ── Metric 2: Alignment Coverage ─────────────────────────────────────────────

const withWords    = captions.filter(c => c.words && c.words.length > 0);
const withoutWords = captions.filter(c => !c.words || c.words.length === 0);
const timingChanged = captions.filter(c => c.timing_changed);

// ── Metric 2b: Match quality (Option C — matchedRatio per caption) ────────────
const matchRatios = captions.map(c => c.matched_ratio).filter(r => r != null);
const lowQuality  = captions.filter(c => c.matched_ratio != null && c.matched_ratio < 0.6);
const matchStats  = stats(matchRatios.map(r => Math.round(r * 100)));

// ── Metric 3: Word-Boundary Adherence ────────────────────────────────────────
// start_delta: caption.start_ms - first_word.start_ms (should be ~0)
// end_trim:    last_word.end_ms - (caption.end_ms - 200)
//   positive end_trim means the post-processor trimmed the end significantly

const startDeltas = [];
const endTrims    = [];
const startOutliers = [];
const endOutliers   = [];

for (const c of withWords) {
  const firstWord = c.words[0];
  const lastWord  = c.words[c.words.length - 1];
  const sd = c.start_ms - firstWord.start_ms;
  const et = lastWord.end_ms - (c.end_ms - 200);
  startDeltas.push(Math.abs(sd));
  endTrims.push(et);
  if (Math.abs(sd) > 200) startOutliers.push({ index: c.index, delta: sd });
  if (et > 500)           endOutliers.push({ index: c.index, trim: et });
}

const sdStats = stats(startDeltas);
const etStats = stats(endTrims.filter(v => v >= 0));  // negative = expanded (fine)

const startOutlierPct = withWords.length ? startOutliers.length / withWords.length : 0;
if (startOutlierPct > 0.05) {
  failures.push(`${startOutliers.length}/${withWords.length} captions have |start delta| > 200ms (>${(startOutlierPct*100).toFixed(0)}%)`);
}

const endOutlierPct = withWords.length ? endOutliers.length / withWords.length : 0;
if (endOutlierPct > 0.15) {
  warnings.push(`${endOutliers.length}/${withWords.length} captions trimmed > 500ms by post-processing`);
}

// ── Metric 4: Sequential Integrity ───────────────────────────────────────────

const overlaps  = [];
const inverted  = [];
const sorted    = [...captions].sort((a, b) => a.start_ms - b.start_ms);

for (const c of captions) {
  if (c.start_ms >= c.end_ms) inverted.push(c.index);
}

for (let i = 0; i < sorted.length - 1; i++) {
  const curr = sorted[i];
  const next = sorted[i + 1];
  if (curr.end_ms > next.start_ms) {
    overlaps.push({ a: curr.index, b: next.index, overlapMs: curr.end_ms - next.start_ms });
  }
}

if (inverted.length > 0) failures.push(`${inverted.length} inverted caption(s) (start >= end): indices ${inverted.join(', ')}`);
if (overlaps.length  > 0) failures.push(`${overlaps.length} overlapping consecutive pair(s): ${overlaps.map(o => `#${o.a}↔#${o.b}(${o.overlapMs}ms)`).join(', ')}`);

// ── Metric 5: Timing Shift From Original ─────────────────────────────────────

const startShifts = [];
const largeShifts = [];

for (const c of captions) {
  const orig = origMap.get(c.index);
  if (!orig) continue;
  const shift = Math.abs(c.start_ms - orig.start_ms);
  startShifts.push(shift);
  if (shift > 1000) largeShifts.push({ index: c.index, shift });
}

const shiftStats = stats(startShifts);
if (largeShifts.length > 0) {
  warnings.push(`${largeShifts.length} caption(s) shifted > 1000ms from original: indices ${largeShifts.map(s => s.index).join(', ')}`);
}

// ── Report ────────────────────────────────────────────────────────────────────

console.log('\n=== P2S2 Timing Quality Report ===\n');
console.log(`Source: ${outputPath}\n`);

console.log('Coverage');
console.log(`  Total captions:           ${pad(captions.length, 6)}`);
console.log(`  Timing changed by WX:     ${pad(timingChanged.length, 6)}  (${pct(timingChanged.length, captions.length)})`);
console.log(`  Word-level data:          ${pad(withWords.length, 6)}  (${pct(withWords.length, captions.length)})`);
console.log(`  Fallback (no words):      ${pad(withoutWords.length, 6)}  (${pct(withoutWords.length, captions.length)})`);
console.log(`  WhisperX missed segs:     ${pad(missedSegs.length, 6)}${missedSegs.length ? '  indices: ' + missedSegs.join(', ') : ''}`);

if (matchRatios.length > 0) {
  console.log('\nMatch Quality  (% of caption tokens found in transcript)');
  console.log(`  Mean: ${pad(matchStats.mean, 4)}%   Median: ${pad(matchStats.median, 4)}%   P95: ${pad(matchStats.p95, 4)}%   Min: ${pad(matchStats.max === 0 ? 0 : Math.min(...matchRatios.map(r => Math.round(r * 100))), 4)}%`);
  if (lowQuality.length) {
    console.log(`  Low quality (<60%) captions: ${lowQuality.map(c => `#${c.index}(${Math.round(c.matched_ratio * 100)}%)`).join(', ')}`);
  } else {
    console.log('  All matched captions above 60% quality ✓');
  }
}

console.log('\nDuration Distribution');
console.log(`  < 240ms  (Premiere fail): ${pad(dur_sub240.length, 6)}  ${dur_sub240.length ? '← INDICES: ' + dur_sub240.map(c=>c.index).join(', ') : ''}`);
console.log(`  240–500ms:                ${pad(dur_240_500.length, 6)}`);
console.log(`  500ms–1s:                 ${pad(dur_500_1k.length, 6)}`);
console.log(`  1s–3s:                    ${pad(dur_1k_3k.length, 6)}`);
console.log(`  > 3s:                     ${pad(dur_3k_plus.length, 6)}`);

if (withWords.length > 0) {
  console.log('\nWord-Boundary: Start Delta  (caption.start_ms − first_word.start_ms)');
  console.log(`  Mean: ${pad(sdStats.mean,5)}ms   Median: ${pad(sdStats.median,5)}ms   P95: ${pad(sdStats.p95,5)}ms   Max: ${pad(sdStats.max,5)}ms`);
  if (startOutliers.length) {
    console.log(`  |delta| > 200ms (${startOutliers.length}): ${startOutliers.map(o => `#${o.index}(${o.delta > 0 ? '+' : ''}${o.delta}ms)`).join(', ')}`);
  } else {
    console.log('  All captions within 200ms tolerance ✓');
  }

  console.log('\nWord-Boundary: End Trim  (last_word.end_ms − (caption.end_ms − 200ms))');
  console.log(`  Mean: ${pad(etStats.mean,5)}ms   Median: ${pad(etStats.median,5)}ms   P95: ${pad(etStats.p95,5)}ms   Max: ${pad(etStats.max,5)}ms`);
  if (endOutliers.length) {
    console.log(`  Trimmed > 500ms (${endOutliers.length}): ${endOutliers.slice(0, 10).map(o => `#${o.index}(+${o.trim}ms)`).join(', ')}${endOutliers.length > 10 ? '…' : ''}`);
  } else {
    console.log('  No captions heavily trimmed by post-processing ✓');
  }
}

console.log('\nSequential Integrity');
console.log(`  Inverted captions (start >= end): ${inverted.length === 0 ? '0 ✓' : inverted.length + ' ← FAIL'}`);
console.log(`  Overlapping pairs:                ${overlaps.length === 0 ? '0 ✓' : overlaps.length + ' ← FAIL'}`);

if (startShifts.length > 0) {
  console.log('\nTiming Shift From Original');
  console.log(`  Mean: ${pad(shiftStats.mean,5)}ms   Median: ${pad(shiftStats.median,5)}ms   P95: ${pad(shiftStats.p95,5)}ms   Max: ${pad(shiftStats.max,5)}ms`);
  if (largeShifts.length) {
    console.log(`  Shifted > 1000ms (${largeShifts.length}): ${largeShifts.map(s => `#${s.index}(${s.shift}ms)`).join(', ')}`);
  } else {
    console.log('  No captions shifted > 1000ms from original ✓');
  }
} else {
  console.log('\nTiming Shift From Original');
  console.log('  (No input_captions in output — re-run tester.js to enable this metric)');
}

console.log('\n=== PASS / FAIL ===');
if (failures.length === 0 && warnings.length === 0) {
  console.log('  PASS — all checks passed ✓\n');
} else {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  for (const w of warnings) console.log(`  WARN: ${w}`);
  console.log();
}

const exitCode = failures.length > 0 ? 1 : 0;
process.exit(exitCode);
