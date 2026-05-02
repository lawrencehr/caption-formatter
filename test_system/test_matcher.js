'use strict';

const assert = require('assert');
const {
  normaliseCaption, normaliseWord, matchCaptionsToTranscript,
  _tryAlign, _numToWords, _expandYear,
} = require('../backend/lib/matcher');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

function eq(a, b) { assert.strictEqual(a, b); }
function ok(v, msg) { assert.ok(v, msg); }

// ── _numToWords ───────────────────────────────────────────────────────────────
console.log('\n_numToWords');
test('zero',        () => eq(_numToWords(0),    'zero'));
test('teens',       () => eq(_numToWords(14),   'fourteen'));
test('tens',        () => eq(_numToWords(85),   'eighty five'));
test('hundreds',    () => eq(_numToWords(200),  'two hundred'));
test('hundreds+',   () => eq(_numToWords(312),  'three hundred twelve'));
test('thousands',   () => eq(_numToWords(1000), 'one thousand'));
test('thousands+',  () => eq(_numToWords(1200), 'one thousand two hundred'));
test('thousands++', () => eq(_numToWords(1234), 'one thousand two hundred thirty four'));

// ── _expandYear ───────────────────────────────────────────────────────────────
console.log('\n_expandYear');
test('2024', () => eq(_expandYear(2024), 'twenty twenty four'));
test('1985', () => eq(_expandYear(1985), 'nineteen eighty five'));
test('2000', () => eq(_expandYear(2000), 'two thousand'));
test('2003', () => eq(_expandYear(2003), 'two thousand three'));
test('2010', () => eq(_expandYear(2010), 'twenty ten'));

// ── normaliseCaption ──────────────────────────────────────────────────────────
console.log('\nnormaliseCaption');
test('HTML stripping',
  () => eq(normaliseCaption('<i>He said it</i>'), 'he said it'));

test('speaker label (newline)',
  () => eq(normaliseCaption('JOHN SMITH:\nHe said it'), 'he said it'));

test('speaker label (space)',
  () => eq(normaliseCaption('JODY: Hello there'), 'hello there'));

test('dollar amount',
  () => eq(normaliseCaption('earned $100'), 'earned one hundred dollars'));

test('comma-separated dollar',
  () => eq(normaliseCaption('costs $1,200'), 'costs one thousand two hundred dollars'));

test('year expansion',
  () => eq(normaliseCaption('In 2024 he said'), 'in twenty twenty four he said'));

test('percentage',
  () => eq(normaliseCaption('5% of voters'), 'five per cent of voters'));

test('plain number',
  () => eq(normaliseCaption('he said 42 times'), 'he said forty two times'));

// ── normaliseWord ─────────────────────────────────────────────────────────────
console.log('\nnormaliseWord');
test('lowercase + strip',  () => eq(normaliseWord('Hello,'),  'hello'));
test('apostrophe kept',    () => eq(normaliseWord("don't"),   "don't"));
test('trailing period',    () => eq(normaliseWord('said.'),   'said'));

// ── _tryAlign ─────────────────────────────────────────────────────────────────
console.log('\n_tryAlign');

function mkFlat(...words) {
  return words.map((w, i) => ({ word: w, start_ms: i * 200, end_ms: (i + 1) * 200 }));
}

test('exact match', () => {
  const flat = mkFlat('he', 'said', 'it');
  const r = _tryAlign(['he', 'said', 'it'], flat, 0, 2);
  eq(r.matched, 3);
  eq(r.firstFlatIdx, 0);
  eq(r.endFlatIdx, 2);
});

test('insertion tolerance', () => {
  // transcript: "he actually said it" — caption: "he said it"
  const flat = mkFlat('he', 'actually', 'said', 'it');
  const r = _tryAlign(['he', 'said', 'it'], flat, 0, 2);
  eq(r.matched, 3);
  ok(r.ratio >= 1.0, 'should be 100% match');
});

test('deletion tolerance', () => {
  // caption has "of" that was never spoken
  const flat = mkFlat('ten', 'dollars');
  const r = _tryAlign(['ten', 'of', 'dollars'], flat, 0, 2);
  eq(r.matched, 2);
  ok(r.ratio > 0.6, `ratio ${r.ratio} should exceed MIN_RATIO`);
});

// ── matchCaptionsToTranscript ─────────────────────────────────────────────────
console.log('\nmatchCaptionsToTranscript');

test('exact match', () => {
  const words = mkFlat('he', 'said', 'it');
  const [r] = matchCaptionsToTranscript([{ text: 'He said it' }], words);
  ok(r !== null, 'should match');
  eq(r.startMs, 0);
  eq(r.endMs, 600);
});

test('dollar notation → spoken words', () => {
  const words = mkFlat('earned', 'one', 'hundred', 'dollars');
  const [r] = matchCaptionsToTranscript([{ text: 'earned $100' }], words);
  ok(r !== null, 'should match despite dollar notation');
  eq(r.startMs, 0);
  eq(r.endMs, 800);
});

test('written year → spoken year', () => {
  const words = mkFlat('in', 'twenty', 'twenty', 'four', 'he');
  const [r] = matchCaptionsToTranscript([{ text: 'In 2024 he' }], words);
  ok(r !== null, 'should match year');
  ok(r.matchedRatio >= 0.6, 'ratio should meet threshold');
});

test('transcript insertion tolerance', () => {
  const words = mkFlat('he', 'actually', 'said', 'it');
  const [r] = matchCaptionsToTranscript([{ text: 'he said it' }], words);
  ok(r !== null, 'should tolerate extra word in transcript');
});

test('caption deletion tolerance', () => {
  // Caption: "ten of dollars" — only "ten" and "dollars" were spoken
  const words = mkFlat('ten', 'dollars');
  const [r] = matchCaptionsToTranscript([{ text: 'ten of dollars' }], words);
  ok(r !== null, `should match at 2/3 = 67%: got ${r ? r.matchedRatio : 'null'}`);
});

test('no match for completely different text', () => {
  const words = mkFlat('apple', 'orange');
  const [r] = matchCaptionsToTranscript([{ text: 'completely different words here today' }], words);
  eq(r, null);
});

test('sequential two-caption match', () => {
  const words = [
    ...mkFlat('first', 'caption'),
    ...mkFlat('second', 'caption').map(w => ({ ...w, start_ms: w.start_ms + 1000, end_ms: w.end_ms + 1000 })),
  ];
  const results = matchCaptionsToTranscript(
    [{ text: 'first caption' }, { text: 'second caption' }],
    words,
  );
  ok(results[0] !== null && results[1] !== null, 'both captions should match');
  ok(results[0].startMs < results[1].startMs, 'should be in temporal order');
});

test('words array populated on match', () => {
  const words = mkFlat('hello', 'world');
  const [r] = matchCaptionsToTranscript([{ text: 'hello world' }], words);
  ok(Array.isArray(r?.words) && r.words.length > 0, 'should return word array');
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
