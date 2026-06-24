// Unit tests for validateSuggestionChains + filterOversizedSuggestions with
// line-level (\n) texts and strict-30 flat fallback.
const { validateSuggestionChains, filterOversizedSuggestions } = require('../../backend/lib/gemini');

const captions = [
  { index: 1, text: 'ALEX REED: Hello and welcome to the program', italic: false },
  { index: 2, text: 'to Prime Time this week with much more', italic: false },
  { index: 3, text: 'a fine quote from somebody', italic: true },
  { index: 4, text: 'and back to the host narration again here', italic: false },
];

let pass = 0, fail = 0;
function expect(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', name); }
}

// 1. Valid multiline suggestion passes
{
  const r = validateSuggestionChains([
    { caption_index: 2, new_text: 'to Prime Time this week\nwith much more', change_type: 'phrase_break', linked_suggestions: [] },
  ], captions);
  expect('valid multiline kept', r.kept.length === 1 && r.droppedChains.length === 0);
}

// 2. Multiline with a >30-char line is dropped (text conserved, so the line check fires)
{
  const r = validateSuggestionChains([
    { caption_index: 2, new_text: 'to Prime Time this week with much\nmore', change_type: 'phrase_break', linked_suggestions: [] },
  ], captions);
  expect('34-char line dropped', r.kept.length === 0 && /over 30 chars/.test(r.droppedChains[0].reason));
}

// 3. Three spoken lines dropped
{
  const r = validateSuggestionChains([
    { caption_index: 2, new_text: 'to Prime\nTime this\nweek with much more', change_type: 'phrase_break', linked_suggestions: [] },
  ], captions);
  expect('3 lines dropped', r.kept.length === 0);
}

// 4. Name-tag caption: tag alone on line 1 OK; tag missing → dropped
{
  const ok = validateSuggestionChains([
    { caption_index: 1, new_text: 'ALEX REED:\nHello and welcome', change_type: 'phrase_break', linked_suggestions: [2] },
    { caption_index: 2, new_text: 'to the program\nto Prime Time this week', change_type: 'phrase_break', linked_suggestions: [1] },
  ], JSON.parse(JSON.stringify(captions)));
  // chain conservation: caption1 "ALEX REED: Hello and welcome to the program" + caption2 — tokens must match
  // orig: "ALEX REED: Hello and welcome to the program to Prime Time this week with much more"
  // new : "ALEX REED: Hello and welcome" + "to the program to Prime Time this week" — LOSES "with much more" → dropped for conservation
  expect('incomplete chain dropped (conservation)', ok.kept.length === 0 && /not conserved/.test(ok.droppedChains[0].reason));

  const ok2 = validateSuggestionChains([
    { caption_index: 1, new_text: 'ALEX REED:\nHello and welcome', change_type: 'phrase_break', linked_suggestions: [2] },
    { caption_index: 2, new_text: 'to the program to Prime\nTime this week with much more', change_type: 'phrase_break', linked_suggestions: [1] },
  ], JSON.parse(JSON.stringify(captions)));
  expect('valid name-tag chain kept', ok2.kept.length === 2);

  // Tag conserved but NOT alone on line 1 (spoken text shares the line) → name-tag check fires
  const bad = validateSuggestionChains([
    { caption_index: 1, new_text: 'ALEX REED: Hello and welcome\nto the program', change_type: 'phrase_break', linked_suggestions: [] },
  ], JSON.parse(JSON.stringify(captions)));
  expect('tag not alone on line 1 dropped', bad.kept.length === 0 && /name tag/.test(bad.droppedChains[0].reason));
}

// 5. Flat text that cannot split ≤30/≤30 is dropped (strict 30 backstop)
{
  const r = validateSuggestionChains([
    { caption_index: 4, new_text: 'and back to the host narration againheremoretext yes', change_type: 'phrase_break', linked_suggestions: [] },
  ], captions);
  expect('strict-30 flat backstop', r.kept.length === 0 || r.droppedChains.length === 1);
}

// 6. Italic boundary chain still dropped
{
  const r = validateSuggestionChains([
    { caption_index: 3, new_text: 'a fine quote from somebody and\nback', change_type: 'merge', linked_suggestions: [4] },
    { caption_index: 4, new_text: 'to the host narration\nagain here', change_type: 'phrase_break', linked_suggestions: [3] },
  ], JSON.parse(JSON.stringify(captions)));
  expect('italic boundary dropped', r.kept.length === 0 && /italic/.test(r.droppedChains[0].reason));
}

// 7. Self-links stripped on kept suggestions
{
  const r = validateSuggestionChains([
    { caption_index: 2, new_text: 'to Prime Time this week\nwith much more', change_type: 'phrase_break', linked_suggestions: [2] },
  ], captions);
  expect('self-link stripped', r.kept.length === 1 && r.kept[0].linked_suggestions.length === 0);
}

// 8. Oversize filter: multiline judged per line (30+\n+30 = 61 chars total must PASS)
{
  const text29 = 'a'.repeat(29), text30 = 'b'.repeat(30);
  const r = filterOversizedSuggestions([
    { caption_index: 2, new_text: text30 + '\n' + text29, change_type: 'phrase_break', linked_suggestions: [] },
  ], captions);
  expect('61-char multiline passes filter (per-line ok)', r.kept.length === 1);
  const r2 = filterOversizedSuggestions([
    { caption_index: 2, new_text: 'c'.repeat(31) + '\n' + text29, change_type: 'phrase_break', linked_suggestions: [] },
  ], captions);
  expect('31-char line fails filter', r2.kept.length === 0);
}

// 9. Multiline name-tag in filter: tag line exempt from 30
{
  const r = filterOversizedSuggestions([
    { caption_index: 1, new_text: 'ALEX REED:\n' + 'd'.repeat(30), change_type: 'phrase_break', linked_suggestions: [] },
  ], captions);
  expect('tag + 30-char spoken line passes filter', r.kept.length === 1);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
