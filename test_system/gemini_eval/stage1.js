// Node port of the Stage 1 pipeline from frontend/caption_formatter.html.
// Functions are copied verbatim where possible; parseTranscript is re-implemented
// with a small HTML tokenizer because Node has no DOMParser (mammoth emits a
// constrained HTML subset — p/h1-6/li/table blocks, strong/em/a/br inline —
// so a tag-level walk is equivalent to the browser DOM walk).
//
// If Stage 1 logic changes in the frontend, this file must be updated to match.

// ── UTILITIES (verbatim from frontend) ───────────────────────────────────────

function normalize(t) {
  return t.toLowerCase()
    .replace(/[''""„‟«»]/g, "'")
    .replace(/[—–\-]/g, ' ')
    .replace(/[^a-z0-9\s']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTime(ts) {
  const [hms, ms] = ts.split(','), [h, m, s] = hms.split(':').map(Number);
  return h * 3600000 + m * 60000 + s * 1000 + Number(ms);
}

// ── TRANSCRIPT PARSING (Node re-implementation of the DOM walk) ──────────────
// Collects all BOLD text (bold-only or bold+italic) from mammoth HTML output.

const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'li', 'br', 'tr', 'td', 'blockquote']);

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function parseTranscript(html) {
  const segs = [];
  let cur = '';
  let boldDepth = 0;

  function flush() {
    const t = cur.replace(/\s+/g, ' ').trim();
    if (t.length > 1) segs.push(t);
    cur = '';
  }

  const tokenRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>|[^<]+/g;
  let m;
  while ((m = tokenRe.exec(html)) !== null) {
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const isClose = m[0][1] === '/';
      if (tag === 'strong' || tag === 'b') {
        boldDepth += isClose ? -1 : 1;
        if (boldDepth < 0) boldDepth = 0;
      } else if (BLOCK_TAGS.has(tag)) {
        flush();
      }
    } else {
      const text = decodeEntities(m[0]);
      if (boldDepth > 0) cur += text;
      else flush(); // non-bold text node breaks the current bold run
    }
  }
  flush();

  // Strip leading "ALL CAPS NAME: " speaker prefixes before normalizing
  // so "CHRIS BOWEN: That's a pretty loaded..." becomes just the quote content.
  return segs.map(s => {
    const stripped = s.replace(/^[A-Z][A-Z\s\.]{0,40}:\s*/, '').trim();
    return normalize(stripped);
  }).filter(s => s.length > 2);
}

// ── ITALIC MATCHING (verbatim) ───────────────────────────────────────────────

function shouldBeItalic(text, segs) {
  if (!segs || !segs.length || !text) return false;
  const norm = normalize(text);
  if (norm.length < 4) return false;
  const words = norm.split(/\s+/).filter(w => w.length > 0);
  if (!words.length) return false;

  const meaningful = words.filter(w => w.length > 3);
  if (meaningful.length < 3) {
    return segs.some(seg => seg.includes(norm));
  }

  const minRun = 3;
  for (const seg of segs) {
    for (let start = 0; start <= words.length - minRun; start++) {
      for (let len = minRun; len <= words.length - start; len++) {
        const run = words.slice(start, start + len).join(' ');
        if (seg.includes(run)) return true;
      }
    }
  }
  return false;
}

// Re-derive italic from bold segments — used post-AI to correct flags after text
// redistribution. Mirrors the frontend's deriveItalic (which closes over the
// global boldSegments; here segs is a parameter).
function deriveItalic(text, segs) {
  if (!text || !text.trim()) return false;
  const spk = detectSpeaker(text);
  if (spk) {
    const isNonHost = shouldBeItalic(spk.name, segs) || shouldBeItalic(spk.rest, segs);
    if (isNonHost) return true;
    return shouldBeItalic(spk.rest, segs);
  }
  return shouldBeItalic(text, segs);
}

// ── SRT PARSING (verbatim) ───────────────────────────────────────────────────

function parseSRT(raw) {
  return raw.trim().split(/\n\s*\n/).flatMap(block => {
    const lines = block.trim().split('\n');
    if (lines.length < 3) return [];
    const m = lines[1].match(/(\d{2}:\d{2}:\d{2},\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2},\d{3})/);
    if (!m) return [];
    const text = lines.slice(2).join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!text) return [];
    return [{ start: parseTime(m[1]), end: parseTime(m[2]), text }];
  });
}

// ── SPEAKER DETECTION (verbatim) ─────────────────────────────────────────────

function detectSpeaker(text) {
  const m = text.match(/^([A-Z][A-Z\s\.\-']{0,50}):\s*([\s\S]*)/);
  if (!m) return null;
  const name = m[1].trim();
  const letters = name.replace(/[^A-Za-z]/g, '');
  if (!letters.length) return null;
  if ((name.match(/[A-Z]/g) || []).length / letters.length < 0.85) return null;
  return { name, rest: m[2].trim() };
}

// ── LINE SPLITTING (verbatim) ────────────────────────────────────────────────

const BREAK_RE = /(?<!\d),(?!\s*\d)|[;:]|[—–]/g;

function splitLines(text) {
  text = text.trim();
  if (!text) return [];
  if (text.length <= 30) return [text];

  const candidates = [];
  BREAK_RE.lastIndex = 0;
  let m;
  while ((m = BREAK_RE.exec(text)) !== null) {
    const pos = m.index + m[0].length;
    const ratio = pos / text.length;
    if (ratio < 0.20 || ratio > 0.80) continue;
    const l1 = text.slice(0, pos).trim();
    const l2 = text.slice(pos).trim();
    if (l1 && l2 && l1.length <= 30 && l2.length <= 30)
      candidates.push({ l1, l2, dist: Math.abs(pos - text.length / 2) });
  }

  if (candidates.length) {
    candidates.sort((a, b) => a.dist - b.dist);
    return [candidates[0].l1, candidates[0].l2];
  }

  const words = text.split(/\s+/);
  if (words.length === 1) return [text];
  let best = null, bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const l1 = words.slice(0, i).join(' ');
    const l2 = words.slice(i).join(' ');
    const diff = Math.abs(l1.length - l2.length);
    if (diff < bestDiff) { bestDiff = diff; best = [l1, l2]; }
  }
  return best || [text];
}

// ── MID-CAPTION SPEAKER DETECTION (verbatim) ─────────────────────────────────

function detectMidSpeaker(text) {
  if (!/[a-z]/.test(text)) return null;
  const m = text.match(/^(.*?[a-z].*?)\s+([A-Z][A-Z\s\.\-']{1,40}):\s*([\s\S]*)$/);
  if (!m) return null;
  const before = m[1].trim();
  const speaker = m[2].trim();
  const rest = m[3].trim();
  const letters = speaker.replace(/[^A-Za-z]/g, '');
  if (!letters.length) return null;
  if ((speaker.match(/[A-Z]/g) || []).length / letters.length < 0.85) return null;
  if (/^[A-Z][A-Z\s]+$/.test(before)) return null;
  return { before, speaker, rest };
}

// ── LEAD-IN DETECTION (verbatim) ─────────────────────────────────────────────

function detectLeadIn(text, segs) {
  if (!segs || !segs.length) return null;
  const m = text.match(/^([^:]{1,60}):\s*([\s\S]+)$/);
  if (!m) return null;
  const before = m[1].trim();
  const rest = m[2].trim();
  if (!rest) return null;
  if (before.split(/\s+/).length > 6) return null;
  if (shouldBeItalic(before, segs)) return null;
  return { leadIn: before + ':', rest };
}

// ── PRE-PROCESSING PASS (verbatim) ───────────────────────────────────────────

function preprocessMidSpeakers(captions) {
  const caps = captions.map(c => ({ ...c }));

  for (let i = 0; i < caps.length; i++) {
    const cap = caps[i];

    const splitName = cap.text.match(/^([\s\S]+?)\s+([A-Z]{2,})$/);
    if (splitName && i + 1 < caps.length) {
      const lastName = splitName[2];
      if (/^[A-Z][A-Z\s]{0,20}:/.test(caps[i + 1].text)) {
        cap.text = splitName[1].trim();
        caps[i + 1].text = `${lastName} ${caps[i + 1].text}`;
      }
    }

    if (detectSpeaker(cap.text)) continue;

    const mid = detectMidSpeaker(cap.text);
    if (mid) {
      if (mid.rest.trim()) {
        cap.text = `${mid.speaker}: ${mid.rest}`.trim();
        cap.timingFlag = 'Timing needs — leading text moved to previous caption';
        if (i > 0) {
          const combined = `${caps[i - 1].text} ${mid.before}`.replace(/\s+/g, ' ').trim();
          caps[i - 1].text = combined;
          caps[i - 1].timingFlag = combined.length > 60
            ? 'Timing needs — line too long after merge, redistribute or split'
            : 'Timing needs — text moved from next caption';
        }
      } else {
        cap.text = mid.before;
        cap.isLabelPush = true;
        if (i + 1 < caps.length) {
          caps[i + 1].text = `${mid.speaker}: ${caps[i + 1].text}`.trim();
        }
      }
      continue;
    }

    const ellipsisM = cap.text.match(/^(.+?):\s*(…|\.{3})([\s\S]*)$/);
    if (ellipsisM) {
      const before = ellipsisM[1].trim();
      const ellipsis = ellipsisM[2].trim();
      const after = ellipsisM[3].trim();
      cap.text = before + ':';
      cap.timingFlag = 'Timing needs — ellipsis pushed to next caption';
      if (i + 1 < caps.length) {
        const toAppend = after ? `${ellipsis} ${after}` : ellipsis;
        const combined = `${toAppend} ${caps[i + 1].text}`.trim();
        caps[i + 1].text = combined;
        caps[i + 1].timingFlag = combined.length > 60
          ? 'Timing needs — line too long after ellipsis merge, redistribute or split'
          : 'Timing needs — ellipsis moved from previous caption';
      }
    }
  }

  return caps;
}

// ── TRAILING PLAIN DETECTION (verbatim) ──────────────────────────────────────

function detectTrailingPlain(text, boldIdx) {
  const m = text.match(/^([\s\S]+?…)\s+([A-Z][\s\S]+)$/);
  if (!m) return null;
  const italicPart = m[1].trim();
  const plainPart = m[2].trim();
  if (!italicPart || plainPart.length < 5) return null;
  if (!shouldBeItalic(italicPart, boldIdx)) return null;
  if (shouldBeItalic(plainPart, boldIdx)) return null;
  return { italicPart, plainPart };
}

// ── MAIN PROCESSING (verbatim) ───────────────────────────────────────────────

function processCaptions(captions, boldIdx) {
  const caps = preprocessMidSpeakers(captions);
  const out = [];

  for (const cap of caps) {
    const spk = detectSpeaker(cap.text);

    if (spk) {
      const isNonHost = shouldBeItalic(spk.name, boldIdx) || shouldBeItalic(spk.rest, boldIdx);

      if (!isNonHost) {
        if (!spk.rest) continue;
        const italic = shouldBeItalic(spk.rest, boldIdx);
        const lines = splitLines(spk.rest);
        if (cap.appendLine) lines.push(cap.appendLine);
        const o = { start: cap.start, end: cap.end, lines, italic };
        if (cap.timingFlag) o.timingFlag = cap.timingFlag;
        out.push(o);

      } else {
        const lines = [`${spk.name}:`];
        if (spk.rest) lines.push(spk.rest);
        const o = { start: cap.start, end: cap.end, lines, italic: true };
        if (cap.timingFlag) o.timingFlag = cap.timingFlag;
        if (spk.rest && spk.rest.length > 40) o.flag = 'Line 2 long — check in Premiere';
        out.push(o);
      }

    } else {
      const trailing = detectTrailingPlain(cap.text, boldIdx);
      if (trailing) {
        out.push({ start: cap.start, end: cap.end, lines: splitLines(trailing.italicPart), italic: true,
          timingFlag: 'Timing needs split — quote and host text in same caption' });
        out.push({ start: cap.start, end: cap.end, lines: splitLines(trailing.plainPart), italic: false,
          timingFlag: 'Timing needs split — host text separated from quote' });

      } else {
        const isLabelPush = cap.text.trim().endsWith(':') && !!cap.isLabelPush;
        const italic = isLabelPush ? false : shouldBeItalic(cap.text, boldIdx);

        if (italic) {
          const leadIn = detectLeadIn(cap.text, boldIdx);
          if (leadIn && out.length > 0) {
            const prev = out[out.length - 1];
            const lastLine = prev.lines[prev.lines.length - 1] || '';
            prev.lines[prev.lines.length - 1] = (lastLine + ' ' + leadIn.leadIn).trim();
            prev.timingFlag = 'Timing needs — lead-in moved from next caption';
            const o = { start: cap.start, end: cap.end, lines: splitLines(leadIn.rest), italic: true };
            o.timingFlag = 'Timing needs — lead-in moved to previous caption';
            out.push(o);
          } else {
            const o = { start: cap.start, end: cap.end, lines: splitLines(cap.text), italic: true };
            if (cap.timingFlag) o.timingFlag = cap.timingFlag;
            out.push(o);
          }

        } else {
          const lines = splitLines(cap.text);
          if (cap.appendLine) lines.push(cap.appendLine);
          const o = { start: cap.start, end: cap.end, lines, italic: false };
          if (cap.timingFlag) o.timingFlag = cap.timingFlag;
          out.push(o);
        }
      }
    }
  }

  return out;
}

// ── PAYLOAD BUILDER (mirrors refineWithAI() in the frontend) ─────────────────

function buildApiCaptions(result) {
  return result.map((c, idx) => ({
    index: c.index || idx + 1,
    text: (c.lines || []).join(' ') || c.text || '',
    italic: c.italic || false,
    timingFlag: c.timingFlag || null,
    start_ms: c.start,
    end_ms: c.end,
  }));
}

// ── FULL STAGE 1 RUN ─────────────────────────────────────────────────────────
// srtText: raw SRT file contents. docxBuffer: Buffer of the transcript .docx.
// Returns { boldSegments, rawCaptions, result, apiCaptions }.

async function runStage1(srtText, docxBuffer) {
  const mammoth = require('mammoth');
  const { value: html } = await mammoth.convertToHtml({ buffer: docxBuffer });
  const boldSegments = parseTranscript(html);
  const rawCaptions = parseSRT(srtText);
  const result = processCaptions(rawCaptions, boldSegments);
  return { boldSegments, rawCaptions, result, apiCaptions: buildApiCaptions(result) };
}

module.exports = {
  normalize, parseTime, parseTranscript, shouldBeItalic, deriveItalic, parseSRT,
  detectSpeaker, splitLines, detectMidSpeaker, detectLeadIn,
  preprocessMidSpeakers, detectTrailingPlain, processCaptions,
  buildApiCaptions, runStage1,
};
