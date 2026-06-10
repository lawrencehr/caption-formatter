// Final-pass simulator: replays each saved Gemini run through the same path the
// real app uses after the user accepts suggestions:
//
//   server  mergeCaptionSuggestions (backend/lib/merge.js — dedup, splits,
//           min-duration, overlap resolution, gap close)   [no-WhisperX path]
//   frontend mapApiCaption equivalent — splitLines(text) + italic re-derivation
//           via deriveItalic for changed captions
//   writeSRT
//
// "Accept all" of the *filtered* suggestions (what the production filter lets
// through) is the worst-case acceptance pattern. Validates the FINAL SRT:
//
//   L. Line lengths    — ≤2 lines per caption, each ≤30 chars
//   I. Italic flips    — changed captions whose re-derived italic disagrees with
//                        the italic of the words' source captions
//   T. Timing sanity   — duration ≥240ms, monotonic, no overlaps
//   X. Exact text      — exact-token diff of final SRT text vs original captions
//                        (exercises the server dedup logic for false drops)
//
// Usage: node final_pass.js

const fs = require('fs');
const path = require('path');
const { mergeCaptionSuggestions } = require('../../backend/lib/merge');
const { validateSuggestionChains } = require('../../backend/lib/gemini');
const { splitLines, deriveItalic, normalize } = require('./stage1');

const RESULTS_DIR = path.join(__dirname, 'results');
const MIN_DURATION_MS = 240;

const tok = t => (t || '').split(/\s+/).filter(Boolean);

function lcsdiff(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const lost = [], gained = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) lost.push(a[i++]);
    else gained.push(b[j++]);
  }
  while (i < n) lost.push(a[i++]);
  while (j < m) gained.push(b[j++]);
  return { lost, gained };
}

function evaluateFinalPass(run, stage1) {
  const captions = stage1.captions;
  const segs = stage1.bold_segments;
  // Production path: oversize filter (already applied in suggestions_filtered)
  // → chain validation → user accepts all surviving suggestions.
  const chainResult = validateSuggestionChains(
    JSON.parse(JSON.stringify(run.suggestions_filtered || [])), captions);
  const accepted = chainResult.kept;
  const issues = [];
  const add = (check, detail) => issues.push({ check, detail });

  // ── Server merge (no-WhisperX path: isPartial=true, no timing maps) ─────────
  const merged = mergeCaptionSuggestions(captions, accepted, true, new Map(), new Set(), new Map());

  // ── Frontend mapApiCaption equivalent (post-fix: Stage-1 italic carried
  // through the API for changed captions, deriveItalic as fallback) ──────────
  const origByIdx = new Map(captions.map(c => [c.index, c]));
  const finalCaps = merged.map(c => {
    const orig = origByIdx.get(c.index);
    const italic = (!c.changed && orig)
      ? orig.italic
      : (typeof c.italic === 'boolean' ? c.italic : deriveItalic(c.text, segs));
    return { ...c, lines: splitLines(c.text || ''), italic_final: italic };
  });

  // ── L. Line lengths ─────────────────────────────────────────────────────────
  for (const c of finalCaps) {
    if (c.lines.length > 2) add('L-lines', `caption #${c.index}: ${c.lines.length} lines`);
    for (const l of c.lines) {
      if (l.length > 30) add('L-lines', `caption #${c.index}${c.changed ? ' (changed)' : ''}: line ${l.length} chars > 30 — "${l}"`);
    }
  }

  // ── I. Italic flips (provenance vs derived) ────────────────────────────────
  // Build word → source-italic map from the original captions, then align the
  // final word stream against it (only safe when streams match exactly).
  const origStream = [], origItal = [];
  for (const c of captions) for (const w of tok(c.text).map(normalize)) { if (w) { origStream.push(w); origItal.push(!!c.italic); } }
  const finStream = [], finOwner = [];
  finalCaps.forEach((fc, fi) => { for (const w of tok(fc.text).map(normalize)) { if (w) { finStream.push(w); finOwner.push(fi); } } });
  const streamsEqual = origStream.length === finStream.length && origStream.every((w, i) => w === finStream[i]);
  if (streamsEqual) {
    const perFinal = new Map();
    for (let i = 0; i < finStream.length; i++) {
      const fi = finOwner[i];
      if (!perFinal.has(fi)) perFinal.set(fi, new Set());
      perFinal.get(fi).add(origItal[i]);
    }
    for (const [fi, states] of perFinal) {
      const fc = finalCaps[fi];
      if (states.size > 1) {
        add('I-italic', `caption #${fc.index}: mixes italic + non-italic source words — "${fc.text}"`);
      } else {
        const srcItalic = [...states][0];
        if (fc.italic_final !== srcItalic) {
          add('I-italic', `caption #${fc.index}${fc.changed ? ' (changed)' : ''}: source words are ${srcItalic ? 'italic' : 'plain'} but final SRT renders ${fc.italic_final ? 'italic' : 'plain'} — "${fc.text}"`);
        }
      }
    }
  }

  // ── T. Timing sanity ────────────────────────────────────────────────────────
  for (let i = 0; i < finalCaps.length; i++) {
    const c = finalCaps[i];
    if (c.end_ms - c.start_ms < MIN_DURATION_MS) add('T-timing', `caption #${c.index}: duration ${c.end_ms - c.start_ms}ms < ${MIN_DURATION_MS}ms`);
    if (i > 0 && finalCaps[i - 1].end_ms > c.start_ms) add('T-timing', `caption #${finalCaps[i - 1].index} overlaps #${c.index} by ${finalCaps[i - 1].end_ms - c.start_ms}ms`);
    if (i > 0 && c.start_ms < finalCaps[i - 1].start_ms) add('T-timing', `caption #${c.index}: starts before previous caption`);
  }

  // ── X. Exact text through the merge (incl. dedup) ──────────────────────────
  const origTokens = captions.flatMap(c => tok(c.text));
  const finTokens = finalCaps.flatMap(c => tok(c.text));
  if (origTokens.join(' ') !== finTokens.join(' ')) {
    const { lost, gained } = lcsdiff(origTokens, finTokens);
    if (lost.length) add('X-exact', `${lost.length} token(s) lost through merge: "${lost.slice(0, 12).join(' ')}"`);
    if (gained.length) add('X-exact', `${gained.length} token(s) gained through merge: "${gained.slice(0, 12).join(' ')}"`);
  }

  return { issues, finalCaps, n_merged: merged.length, n_accepted: accepted.length, chain_dropped: chainResult.droppedChains };
}

function main() {
  const runFiles = fs.readdirSync(RESULTS_DIR).filter(f => /^ep\d+_[a-z-]+_run\d+\.json$/.test(f)).sort();
  if (!runFiles.length) { console.error('No run files in results/.'); process.exit(1); }

  const rows = [];
  const byCheck = {};
  for (const f of runFiles) {
    const run = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf8'));
    const stage1 = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${run.episode}_stage1.json`), 'utf8'));
    const r = evaluateFinalPass(run, stage1);
    rows.push({ name: f.replace('.json', ''), label: run.label || 'low-audio', ...r });
    for (const i of r.issues) byCheck[i.check] = (byCheck[i.check] || 0) + 1;
  }

  // Baseline: the final pass with ZERO accepted suggestions (pure Stage 1 output
  // through merge+splitLines) — separates pre-existing issues from AI-introduced ones.
  const baselines = {};
  for (const ep of [...new Set(rows.map(r => r.name.split('_')[0]))]) {
    const stage1 = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${ep}_stage1.json`), 'utf8'));
    const r = evaluateFinalPass({ suggestions_filtered: [] }, stage1);
    baselines[ep] = r;
  }

  console.log('═══ Final-pass simulation (accept-all filtered suggestions, no-WhisperX path) ═══\n');
  console.log('BASELINE (zero suggestions accepted — issues inherent to Stage 1 output):');
  for (const [ep, b] of Object.entries(baselines)) {
    const counts = {};
    for (const i of b.issues) counts[i.check] = (counts[i.check] || 0) + 1;
    console.log(`  ${ep}: ${b.issues.length ? Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') : 'clean'}`);
  }
  console.log('');

  // Per-arm: issues net of baseline
  const byArm = {};
  for (const r of rows) {
    const ep = r.name.split('_')[0];
    const base = baselines[ep];
    const baseSet = new Set(base.issues.map(i => i.check + '|' + i.detail));
    const newIssues = r.issues.filter(i => !baseSet.has(i.check + '|' + i.detail));
    r.newIssues = newIssues;
    (byArm[r.label] = byArm[r.label] || []).push(r);
  }
  console.log('NEW issues introduced by accepted suggestions (baseline-subtracted):');
  for (const [label, rs] of Object.entries(byArm).sort()) {
    const total = rs.reduce((a, r) => a + r.newIssues.length, 0);
    const dropped = rs.reduce((a, r) => a + r.chain_dropped.reduce((x, d) => x + d.indices.length, 0), 0);
    const acceptedN = rs.reduce((a, r) => a + r.n_accepted, 0);
    const counts = {};
    for (const r of rs) for (const i of r.newIssues) counts[i.check] = (counts[i.check] || 0) + 1;
    console.log(`  ${label.padEnd(16)} ${total} new issues across ${rs.length} runs · chain validation dropped ${dropped}, accepted ${acceptedN} ${total ? '(' + Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') + ')' : ''}`);
  }
  console.log('');
  // Chain-validation drop reasons (what the new server guard rejects)
  const reasonCounts = {};
  for (const r of rows) for (const d of r.chain_dropped) {
    const key = d.reason.replace(/"[^"]*"/, '"…"');
    reasonCounts[key] = (reasonCounts[key] || 0) + 1;
  }
  if (Object.keys(reasonCounts).length) {
    console.log('Chain-validation drop reasons:');
    for (const [k, v] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])) console.log(`  ${v}× ${k}`);
    console.log('');
  }

  // Detail for runs with new issues
  for (const r of rows) {
    if (!r.newIssues.length) continue;
    console.log(`── ${r.name} (${r.n_accepted} accepted) — ${r.newIssues.length} new issue(s):`);
    for (const i of r.newIssues.slice(0, 12)) console.log(`   [${i.check}] ${i.detail}`);
    if (r.newIssues.length > 12) console.log(`   ... and ${r.newIssues.length - 12} more`);
  }
}

main();
