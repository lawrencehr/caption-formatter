// Evaluates saved Gemini runs (from run_eval.js) against the caption standards
// the prompt demands. Writes results/report.md and prints a summary.
//
// Checks per run:
//   A. Response health     — parse success, truncation/salvage, finish reason
//   B. Schema              — required fields, valid change_type, known caption_index
//   C. Character limits    — new_text spoken ≤60 (≤30 for name-tag captions), split_remainder ≤60
//   D. Linked suggestions  — symmetry (A→B ⇒ B→A), links point at real suggestions
//   E. Zero text loss      — apply all suggestions, word-diff final vs original stream
//   F. Italic boundaries   — no final caption mixes words from italic + non-italic sources
//   G. Name tags           — tag stays as first thing in its own caption, never absorbed
//   H. line_too_long       — every flagged caption received a suggestion
//
// Usage: node evaluate.js

const fs = require('fs');
const path = require('path');
const { annotateCaptions } = require('../../backend/lib/gemini');
const { normalize } = require('./stage1');

const RESULTS_DIR = path.join(__dirname, 'results');
const CHANGE_TYPES = new Set(['phrase_break', 'name_kept_together', 'split', 'merge', 'delete']);
const NAME_TAG_RE = /^([A-Z][A-Z\s.\-']{1,40}:)\s*/;

const words = t => normalize(t || '').split(/\s+/).filter(Boolean);

// ── Apply suggestions (text only — mirrors the merge text path, no dedup rescue,
// because we are judging Gemini's raw output, not the server's repairs) ────────
function applySuggestions(captions, suggestions) {
  const byIdx = new Map(suggestions.map(s => [s.caption_index, s]));
  const out = [];
  for (const cap of captions) {
    const s = byIdx.get(cap.index);
    if (!s) { out.push({ source: cap.index, text: cap.text, changed: false }); continue; }
    const isDelete = s.change_type === 'delete' || !s.new_text || !String(s.new_text).trim();
    if (!isDelete) out.push({ source: cap.index, text: String(s.new_text), changed: true });
    if (s.change_type === 'split' && s.split_remainder && String(s.split_remainder).trim()) {
      out.push({ source: cap.index, text: String(s.split_remainder).trim(), changed: true, isRemainder: true });
    }
  }
  return out;
}

// ── Word diff (LCS) for text-loss reporting ───────────────────────────────────
function wordDiff(a, b) {
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

// Groups consecutive words for readable reporting
function groupRuns(arr) {
  // arr here is already just words; produce phrases of up to 8 words for display
  const out = [];
  for (let i = 0; i < arr.length; i += 8) out.push(arr.slice(i, i + 8).join(' '));
  return out;
}

function evaluateRun(run, stage1) {
  const captions = stage1.captions;
  const capByIdx = new Map(captions.map(c => [c.index, c]));
  const annotated = annotateCaptions(captions);
  const annByIdx = new Map(annotated.map(c => [c.index, c]));
  const suggestions = run.suggestions_raw;
  const issues = []; // {check, severity: 'error'|'warn', detail}
  const add = (check, severity, detail) => issues.push({ check, severity, detail });

  // A. Response health
  if (run.parse_error) add('A-parse', 'error', `Response was not valid JSON (${run.parse_error}); salvaged ${suggestions.length} objects. finishReason=${run.finish_reason}`);
  if (run.finish_reason && run.finish_reason !== 'STOP') add('A-finish', 'error', `finishReason=${run.finish_reason} (response truncated or blocked)`);

  // B. Schema
  for (const s of suggestions) {
    const tag = `#${s.caption_index}`;
    if (!Number.isInteger(s.caption_index)) add('B-schema', 'error', `suggestion with non-integer caption_index: ${JSON.stringify(s).slice(0, 120)}`);
    else if (!capByIdx.has(s.caption_index)) add('B-schema', 'error', `${tag}: caption_index does not exist in input`);
    if (typeof s.new_text !== 'string') add('B-schema', 'error', `${tag}: new_text missing or not a string`);
    if (!CHANGE_TYPES.has(s.change_type)) add('B-schema', 'error', `${tag}: invalid change_type "${s.change_type}"`);
    if (!Array.isArray(s.linked_suggestions)) add('B-schema', 'error', `${tag}: linked_suggestions missing or not an array`);
    if (s.split_remainder && s.change_type !== 'split') add('B-schema', 'warn', `${tag}: split_remainder present but change_type is "${s.change_type}"`);
    if (s.new_text && /\n/.test(s.new_text)) add('B-schema', 'warn', `${tag}: new_text contains a line break (prompt demands flat string)`);
  }
  const dupIdx = suggestions.map(s => s.caption_index).filter((v, i, a) => a.indexOf(v) !== i);
  for (const d of [...new Set(dupIdx)]) add('B-schema', 'error', `#${d}: multiple suggestions for the same caption_index`);

  // C. Character limits (on raw suggestions — what Gemini actually returned)
  for (const s of suggestions) {
    const cap = capByIdx.get(s.caption_index);
    if (!cap || typeof s.new_text !== 'string') continue;
    const newText = s.new_text.trim();
    if (!newText) continue;
    const origTag = (cap.text || '').match(NAME_TAG_RE);
    const max = origTag ? 30 : 60;
    const tagInNew = origTag ? newText.match(NAME_TAG_RE) : null;
    const spoken = tagInNew ? newText.slice(tagInNew[0].length).trim() : newText;
    if (spoken.length > max) add('C-charlimit', 'error', `#${s.caption_index}: spoken text ${spoken.length} chars > ${max} max — "${spoken}"`);
    if (s.change_type === 'split' && s.split_remainder && s.split_remainder.trim().length > 60)
      add('C-charlimit', 'error', `#${s.caption_index}: split_remainder ${s.split_remainder.trim().length} chars > 60 — "${s.split_remainder.trim()}"`);
  }

  // D. Linked suggestion symmetry + dangling links
  const suggByIdx = new Map(suggestions.map(s => [s.caption_index, s]));
  for (const s of suggestions) {
    if (!Array.isArray(s.linked_suggestions)) continue;
    for (const li of s.linked_suggestions) {
      if (li === s.caption_index) { add('D-links', 'warn', `#${s.caption_index}: links to itself`); continue; }
      const other = suggByIdx.get(li);
      if (!other) add('D-links', 'error', `#${s.caption_index}: links to #${li}, but no suggestion exists for #${li} (dangling link — partial apply will corrupt output)`);
      else if (!Array.isArray(other.linked_suggestions) || !other.linked_suggestions.includes(s.caption_index))
        add('D-links', 'error', `#${s.caption_index} → #${li} link is not reciprocated (asymmetric chain)`);
    }
  }

  // E. Zero text loss (global word stream comparison)
  const finalCaps = applySuggestions(captions, suggestions);
  const origStream = [], origMeta = []; // word → {capIndex, italic}
  for (const cap of captions) {
    for (const w of words(cap.text)) { origStream.push(w); origMeta.push({ capIndex: cap.index, italic: !!cap.italic }); }
  }
  const finalStream = [], finalOwner = []; // word → index into finalCaps
  finalCaps.forEach((fc, fi) => { for (const w of words(fc.text)) { finalStream.push(w); finalOwner.push(fi); } });

  const streamsEqual = origStream.length === finalStream.length && origStream.every((w, i) => w === finalStream[i]);
  if (!streamsEqual) {
    const { lost, gained } = wordDiff(origStream, finalStream);
    if (lost.length) add('E-textloss', 'error', `${lost.length} word(s) LOST after applying all suggestions: "${groupRuns(lost).join('" · "')}"`);
    if (gained.length) add('E-textloss', 'error', `${gained.length} word(s) DUPLICATED/ADDED after applying all suggestions: "${groupRuns(gained).join('" · "')}"`);
  }

  // F + G. Word provenance checks (only meaningful when streams align 1:1)
  if (streamsEqual) {
    // F. Italic boundary: a final caption must not mix italic + non-italic source words
    const perFinal = new Map(); // fi → Set of italic states
    for (let i = 0; i < finalStream.length; i++) {
      const fi = finalOwner[i];
      if (!perFinal.has(fi)) perFinal.set(fi, new Set());
      perFinal.get(fi).add(origMeta[i].italic);
    }
    for (const [fi, states] of perFinal) {
      if (states.size > 1) {
        const fc = finalCaps[fi];
        add('F-italic', 'error', `final caption (from #${fc.source}${fc.isRemainder ? ' remainder' : ''}) mixes italic and non-italic source words — "${fc.text}"`);
      }
    }
  }

  // G. Name tag rules (checked directly on suggestions)
  for (const s of suggestions) {
    const cap = capByIdx.get(s.caption_index);
    if (!cap || typeof s.new_text !== 'string') continue;
    const origTag = (cap.text || '').match(NAME_TAG_RE);
    const newText = s.new_text.trim();
    if (origTag && newText) {
      // Caption owned a name tag: new_text must still start with the same tag
      if (!newText.startsWith(origTag[1]))
        add('G-nametag', 'error', `#${s.caption_index}: original starts with name tag "${origTag[1]}" but new_text does not — "${newText.slice(0, 60)}"`);
    }
    if (!origTag && newText) {
      // Caption had no tag: it must not gain one that belongs to another caption
      const gainedTag = newText.match(NAME_TAG_RE);
      if (gainedTag) {
        const ownerCap = captions.find(c => (c.text || '').startsWith(gainedTag[1]));
        if (ownerCap) add('G-nametag', 'error', `#${s.caption_index}: new_text gained name tag "${gainedTag[1]}" that belongs to caption #${ownerCap.index}`);
      }
    }
    // Tag must never appear mid-text
    if (newText) {
      const midTag = newText.slice(1).match(/\s([A-Z][A-Z\s.\-']{1,40}:)\s/);
      if (midTag && captions.some(c => (c.text || '').startsWith(midTag[1])))
        add('G-nametag', 'error', `#${s.caption_index}: name tag "${midTag[1]}" appears mid-text in new_text`);
    }
  }

  // H. line_too_long captions must get a suggestion
  for (const a of annotated) {
    if (a.line_too_long && !suggByIdx.has(a.index)) {
      add('H-toolong', 'error', `#${a.index}: flagged line_too_long (${a.chars}/${a.max_chars} chars) but received NO suggestion — "${(capByIdx.get(a.index)?.text || '').slice(0, 70)}"`);
    }
  }

  // Stats
  const typeCounts = {};
  for (const s of suggestions) typeCounts[s.change_type] = (typeCounts[s.change_type] || 0) + 1;

  return {
    episode: run.episode,
    run: run.run,
    model: run.model,
    gemini_s: +(run.gemini_ms / 1000).toFixed(1),
    salvaged: run.salvaged,
    finish_reason: run.finish_reason,
    n_captions: captions.length,
    n_suggestions: suggestions.length,
    n_filtered_out: run.filter_dropped_indices.length,
    type_counts: typeCounts,
    errors: issues.filter(i => i.severity === 'error'),
    warnings: issues.filter(i => i.severity === 'warn'),
    issues,
  };
}

// Run-vs-run consistency: which caption indices were suggested in both runs of an episode
function consistency(evals) {
  const byEp = {};
  for (const e of evals) (byEp[e.episode] = byEp[e.episode] || []).push(e);
  const rows = [];
  for (const [ep, runs] of Object.entries(byEp)) {
    if (runs.length < 2) continue;
    const sets = runs.map(r => new Set(
      (JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${ep}_run${r.run}.json`), 'utf8'))).suggestions_raw.map(s => s.caption_index)
    ));
    const inter = [...sets[0]].filter(x => sets.slice(1).every(s => s.has(x)));
    const union = new Set(sets.flatMap(s => [...s]));
    rows.push({ ep, sizes: sets.map(s => s.size), overlap: inter.length, union: union.size, jaccard: union.size ? +(inter.length / union.size).toFixed(2) : 1 });
  }
  return rows;
}

function main() {
  const runFiles = fs.readdirSync(RESULTS_DIR).filter(f => /^ep\d+_run\d+\.json$/.test(f)).sort();
  if (!runFiles.length) { console.error('No run files in results/ — run run_eval.js first.'); process.exit(1); }

  const evals = [];
  for (const f of runFiles) {
    const run = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf8'));
    const stage1 = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${run.episode}_stage1.json`), 'utf8'));
    evals.push(evaluateRun(run, stage1));
  }

  // ── report.md ──
  const L = [];
  L.push('# Gemini Phase-1 Evaluation Report');
  L.push('');
  L.push(`Generated: ${new Date().toISOString()}`);
  L.push('');
  L.push('## Summary');
  L.push('');
  L.push('| Run | Model | Time | Captions | Suggestions | Filtered out | Errors | Warnings | Salvaged |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const e of evals) {
    L.push(`| ${e.episode} run${e.run} | ${e.model} | ${e.gemini_s}s | ${e.n_captions} | ${e.n_suggestions} | ${e.n_filtered_out} | ${e.errors.length} | ${e.warnings.length} | ${e.salvaged ? 'YES' : 'no'} |`);
  }
  L.push('');

  // Error counts by check across all runs
  const byCheck = {};
  for (const e of evals) for (const i of e.issues) {
    byCheck[i.check] = byCheck[i.check] || { error: 0, warn: 0 };
    byCheck[i.check][i.severity]++;
  }
  L.push('## Failures by standard');
  L.push('');
  L.push('| Check | Errors | Warnings |');
  L.push('|---|---|---|');
  const checkNames = {
    'A-parse': 'A. JSON parse / truncation', 'A-finish': 'A. Finish reason',
    'B-schema': 'B. Schema validity', 'C-charlimit': 'C. Character limits',
    'D-links': 'D. Linked-suggestion integrity', 'E-textloss': 'E. Zero text loss',
    'F-italic': 'F. Italic boundary', 'G-nametag': 'G. Name tag rules', 'H-toolong': 'H. line_too_long fixed',
  };
  for (const [check, counts] of Object.entries(byCheck).sort()) {
    L.push(`| ${checkNames[check] || check} | ${counts.error} | ${counts.warn} |`);
  }
  L.push('');

  const cons = consistency(evals);
  if (cons.length) {
    L.push('## Run-to-run consistency (same episode, repeated runs)');
    L.push('');
    L.push('| Episode | Suggestions per run | Overlap (same captions) | Jaccard |');
    L.push('|---|---|---|---|');
    for (const c of cons) L.push(`| ${c.ep} | ${c.sizes.join(' / ')} | ${c.overlap} of ${c.union} | ${c.jaccard} |`);
    L.push('');
  }

  L.push('## Per-run detail');
  for (const e of evals) {
    L.push('');
    L.push(`### ${e.episode} run${e.run} — ${e.model}, ${e.gemini_s}s, ${e.n_suggestions} suggestions (${Object.entries(e.type_counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'})`);
    if (e.finish_reason && e.finish_reason !== 'STOP') L.push(`- finishReason: **${e.finish_reason}**`);
    if (!e.errors.length && !e.warnings.length) { L.push('- ✓ clean — all standards met'); continue; }
    for (const i of e.errors) L.push(`- ❌ **${i.check}** — ${i.detail}`);
    for (const i of e.warnings) L.push(`- ⚠️ ${i.check} — ${i.detail}`);
  }
  L.push('');

  const reportPath = path.join(RESULTS_DIR, 'report.md');
  fs.writeFileSync(reportPath, L.join('\n'));

  // ── console summary ──
  console.log('\n═══ Gemini Phase-1 Evaluation ═══\n');
  for (const e of evals) {
    const status = e.errors.length ? `❌ ${e.errors.length} errors` : '✓ clean';
    console.log(`${e.episode} run${e.run}  ${e.model}  ${e.n_suggestions} suggestions  ${status}${e.warnings.length ? ` (${e.warnings.length} warnings)` : ''}`);
  }
  console.log(`\nFull report: ${reportPath}`);
}

main();
