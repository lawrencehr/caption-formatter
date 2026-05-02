'use strict';

// ── Number-to-words ───────────────────────────────────────────────────────────

const ONES = [
  '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function _numToWords(n) {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n === 0) return 'zero';
  if (n < 20)       return ONES[n];
  if (n < 100)      return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
  if (n < 1000) {
    const rem = n % 100;
    return ONES[Math.floor(n / 100)] + ' hundred' + (rem ? ' ' + _numToWords(rem) : '');
  }
  if (n < 1_000_000) {
    const hi = Math.floor(n / 1000), rem = n % 1000;
    return _numToWords(hi) + ' thousand' + (rem ? ' ' + _numToWords(rem) : '');
  }
  const hi = Math.floor(n / 1_000_000), rem = n % 1_000_000;
  return _numToWords(hi) + ' million' + (rem ? ' ' + _numToWords(rem) : '');
}

// 4-digit year (1000–2099) → spoken form  e.g. 2024 → "twenty twenty four"
function _expandYear(y) {
  const hi = Math.floor(y / 100);
  const lo = y % 100;
  if (lo === 0) return hi === 20 ? 'two thousand' : _numToWords(hi) + ' hundred';
  if (hi === 20 && lo < 10) return 'two thousand ' + _numToWords(lo);
  return _numToWords(hi) + ' ' + _numToWords(lo);
}

// ── Text normalisation ────────────────────────────────────────────────────────

function normaliseCaption(text) {
  let s = (text || '')
    .replace(/<[^>]*>/g, ' ')                      // strip HTML tags
    .replace(/\r?\n/g, ' ')                         // flatten newlines
    .replace(/^[A-Z][A-Z\s.'\-]{1,40}:\s*/, '');  // strip speaker label e.g. "JODY: "

  // Currency: $1,234 or $1,234.56
  s = s.replace(/\$([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/g, (_, n) => {
    const [whole, cents] = n.replace(/,/g, '').split('.');
    const out = _numToWords(parseInt(whole, 10)) + ' dollars';
    return cents ? out + ' and ' + _numToWords(parseInt(cents, 10)) + ' cents' : out;
  });

  // Percentages: 5% or 5.5%
  s = s.replace(/([0-9]+(?:\.[0-9]+)?)\s*%/g, (_, n) => {
    const [wi, dec] = n.split('.');
    const base = _numToWords(parseInt(wi, 10));
    if (!dec) return base + ' per cent';
    return base + ' point ' + dec.split('').map(d => _numToWords(parseInt(d, 10))).join(' ') + ' per cent';
  });

  // 4-digit years (must come before plain number expansion)
  s = s.replace(/\b(1[0-9]{3}|20[0-9]{2})\b/g, (_, y) => _expandYear(parseInt(y, 10)));

  // Decimal numbers: 1.5 → "one point five"
  s = s.replace(/\b([0-9]+)\.([0-9]+)\b/g, (_, whole, frac) => {
    return _numToWords(parseInt(whole, 10)) + ' point ' +
           frac.split('').map(d => _numToWords(parseInt(d, 10))).join(' ');
  });

  // Comma-separated integers: 1,234
  s = s.replace(/\b([0-9]{1,3}(?:,[0-9]{3})+)\b/g, (_, n) => {
    return _numToWords(parseInt(n.replace(/,/g, ''), 10));
  });

  // Remaining plain integers
  s = s.replace(/\b([0-9]+)\b/g, (_, n) => _numToWords(parseInt(n, 10)));

  // Lowercase, strip non-word chars (preserve apostrophes for contractions)
  return s.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Normalise a single word from the WhisperX transcript for comparison
function normaliseWord(w) {
  return (w || '').toLowerCase().replace(/[^a-z0-9']/g, '').trim();
}

// ── Sequence matching ─────────────────────────────────────────────────────────

const SEARCH_AHEAD = 40; // how far ahead of cursor to search for each caption's match
const SLACK        = 8;  // max transcript insertions tolerated when scanning a caption
const MIN_RATIO    = 0.6; // min fraction of caption tokens that must match
const LOOK_BACK    = 5;  // allow a small look-behind of the cursor for resilience

/**
 * Greedy forward alignment of capTokens against flat starting at startIdx.
 * For each caption token, scans up to SLACK+1 positions ahead in flat.
 * Returns { matched, ratio, firstFlatIdx, endFlatIdx }
 */
function _tryAlign(capTokens, flat, startIdx, slack) {
  let fi = startIdx;
  let matched = 0;
  let firstFlatIdx = -1;
  let lastFlatIdx  = -1;

  for (let ci = 0; ci < capTokens.length; ci++) {
    const lookAhead = Math.min(slack + 1, flat.length - fi);
    let found = false;
    for (let d = 0; d < lookAhead; d++) {
      if (normaliseWord(flat[fi + d].word) === capTokens[ci]) {
        const mfi = fi + d;
        fi = mfi + 1;
        if (firstFlatIdx === -1) firstFlatIdx = mfi;
        lastFlatIdx = mfi;
        matched++;
        found = true;
        break;
      }
    }
    // not found → deletion: skip caption token, fi unchanged
  }

  return {
    matched,
    ratio: capTokens.length > 0 ? matched / capTokens.length : 0,
    firstFlatIdx,
    endFlatIdx: lastFlatIdx,
  };
}

/**
 * Match an array of captions (each with a .text field) against a flat word
 * list produced by WhisperX full transcription.
 *
 * Returns an array of the same length as captions.  Each entry is either:
 *   { startMs, endMs, matchedRatio, words: [{word, start_ms, end_ms}] }
 * or null when no match was found (caller should keep original timing).
 */
function matchCaptionsToTranscript(captions, whisperWords) {
  const results = [];
  let cursor = 0;

  for (const cap of captions) {
    const normText  = normaliseCaption(cap.text || '');
    const capTokens = normText.split(/\s+/).filter(Boolean);

    if (capTokens.length === 0) {
      results.push(null);
      continue;
    }

    const searchStart = Math.max(0, cursor - LOOK_BACK);
    const searchEnd   = Math.min(whisperWords.length - 1, cursor + SEARCH_AHEAD);

    let best      = null;
    let bestRatio = -1;

    for (let s = searchStart; s <= searchEnd; s++) {
      const res = _tryAlign(capTokens, whisperWords, s, SLACK);
      if (res.ratio > bestRatio) {
        bestRatio = res.ratio;
        best = res;
      }
    }

    if (bestRatio >= MIN_RATIO && best && best.firstFlatIdx >= 0 && best.endFlatIdx >= 0) {
      cursor = best.endFlatIdx + 1;
      results.push({
        startMs:      whisperWords[best.firstFlatIdx].start_ms,
        endMs:        whisperWords[best.endFlatIdx].end_ms,
        matchedRatio: bestRatio,
        words:        whisperWords.slice(best.firstFlatIdx, best.endFlatIdx + 1),
      });
    } else {
      results.push(null); // cursor stays put — next caption searches from same position
    }
  }

  return results;
}

module.exports = {
  normaliseCaption,
  normaliseWord,
  matchCaptionsToTranscript,
  _tryAlign,
  _numToWords,
  _expandYear,
};
