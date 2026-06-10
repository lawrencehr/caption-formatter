// Compares prompt variants on the long-line problem:
//   control  : medium-noaudio        (flat string, 60-char limit)
//   max59    : medium-noaudio-max59  (flat string, 59-char limit)
//   lines    : medium-noaudio-lines  (Gemini writes explicit ≤30-char lines)
//
// For every suggestion, asks: would the rendered caption contain a line > 30
// chars? Flat arms render via splitLines (the frontend splitter); the lines arm
// renders via Gemini's own \n breaks (falling back to splitLines if it returned
// a flat string). Also checks exact-token conservation per run (line breaks
// neutralised) and, for the lines arm, format compliance.
//
// Usage: node lines_report.js

const fs = require('fs');
const path = require('path');
const { splitLines, normalize } = require('./stage1');

const RESULTS_DIR = path.join(__dirname, 'results');
const NAME_TAG_RE = /^([A-Z][A-Z\s.\-']{1,40}:)\s*/;
const ARMS = ['medium-noaudio', 'medium-noaudio-max59', 'medium-noaudio-lines'];
const EPISODES = ['ep14', 'ep16'];

const tok = t => (t || '').replace(/\n/g, ' ').split(/\s+/).filter(Boolean);

// Returns the rendered lines for a suggested text.
function renderLines(text, isLinesArm) {
  const t = String(text).trim();
  if (!t) return [];
  if (isLinesArm && t.includes('\n')) return t.split('\n').map(l => l.trim()).filter(Boolean);
  // strip name tag — it renders on its own line; only spoken text is split
  const tagM = t.match(NAME_TAG_RE);
  const spoken = tagM ? t.slice(tagM[0].length).trim() : t;
  const lines = splitLines(spoken);
  return tagM ? [tagM[1], ...lines] : lines;
}

function analyseRun(run, stage1) {
  const isLinesArm = !!(run.prompt_opts && run.prompt_opts.lineLevel);
  const sugs = run.suggestions_raw;
  const offenders = [];
  let flatInLinesArm = 0;

  for (const s of sugs) {
    for (const t of [s.new_text, s.split_remainder]) {
      if (!t || !String(t).trim()) continue;
      if (isLinesArm && !String(t).includes('\n') && String(t).trim().length > 30) flatInLinesArm++;
      const lines = renderLines(t, isLinesArm);
      // name-tag line 1 may legitimately exceed? tags are ≤ ~42 chars by regex; report only spoken lines >30
      const tagM = String(t).trim().match(NAME_TAG_RE);
      const checkLines = tagM ? lines.slice(1) : lines;
      const bad = checkLines.filter(l => l.length > 30);
      if (bad.length || checkLines.length > 2) {
        offenders.push({ idx: s.caption_index, worst: Math.max(...checkLines.map(l => l.length)), line: bad[0] || '(3+ lines)' });
      }
    }
  }

  // token conservation (full-stream, \n neutralised)
  const byIdx = new Map(sugs.map(s => [s.caption_index, s]));
  const finTokens = [];
  for (const c of stage1.captions) {
    const s = byIdx.get(c.index);
    if (!s) { finTokens.push(...tok(c.text)); continue; }
    const isDelete = s.change_type === 'delete' || !s.new_text || !String(s.new_text).trim();
    if (!isDelete) finTokens.push(...tok(s.new_text));
    if (s.change_type === 'split' && s.split_remainder && String(s.split_remainder).trim()) finTokens.push(...tok(s.split_remainder));
  }
  const origTokens = stage1.captions.flatMap(c => tok(c.text));
  const conserved = origTokens.join(' ') === finTokens.join(' ');

  return { n: sugs.length, offenders, conserved, flatInLinesArm, isLinesArm };
}

function main() {
  const stage1ByEp = {};
  for (const ep of EPISODES) stage1ByEp[ep] = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${ep}_stage1.json`), 'utf8'));

  console.log('═══ Long-line variant comparison (ep14 + ep16, medium thinking, no audio) ═══\n');
  for (const arm of ARMS) {
    const files = fs.readdirSync(RESULTS_DIR)
      .filter(f => new RegExp(`^(${EPISODES.join('|')})_${arm}_run\\d+\\.json$`).test(f)).sort();
    if (!files.length) { console.log(`${arm}: no runs found`); continue; }

    let totalSugs = 0, totalOffenders = 0, conservedRuns = 0, flatCount = 0;
    const detail = [];
    for (const f of files) {
      const run = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf8'));
      const r = analyseRun(run, stage1ByEp[run.episode]);
      totalSugs += r.n; totalOffenders += r.offenders.length;
      if (r.conserved) conservedRuns++;
      flatCount += r.flatInLinesArm;
      for (const o of r.offenders) detail.push(`     ${f.replace('.json', '')} #${o.idx} (${o.worst} chars): "${o.line}"`);
    }
    const pct = totalSugs ? ((totalOffenders / totalSugs) * 100).toFixed(1) : '0';
    console.log(`${arm}`);
    console.log(`   runs: ${files.length} · suggestions: ${totalSugs} · would render a >30 line: ${totalOffenders} (${pct}%) · token-conserved runs: ${conservedRuns}/${files.length}${flatCount ? ` · flat >30 strings missing \\n: ${flatCount}` : ''}`);
    if (detail.length) console.log(detail.join('\n'));
    console.log('');
  }
}

main();
