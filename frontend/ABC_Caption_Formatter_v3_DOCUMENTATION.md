# ABC Caption Formatter v2 — Full Documentation

> Last updated: April 2026  
> Tool file: `ABC_Caption_Formatter_v2.html`  
> Context: Built for Media Watch social media captioning workflow at ABC

---

## Table of Contents

1. [What the tool does](#1-what-the-tool-does)
2. [User workflow](#2-user-workflow)
3. [Style guide rules implemented](#3-style-guide-rules-implemented)
4. [Inputs](#4-inputs)
5. [Core processing logic](#5-core-processing-logic)
6. [Preprocessing pass — structural fixes](#6-preprocessing-pass--structural-fixes)
7. [Italic detection](#7-italic-detection)
8. [Line splitting](#8-line-splitting)
9. [Output and flags](#9-output-and-flags)
10. [SRT output format](#10-srt-output-format)
11. [Deployment](#11-deployment)
12. [Known limitations and edge cases](#12-known-limitations-and-edge-cases)
13. [What the tool does NOT do](#13-what-the-tool-does-not-do)
14. [Future additions to consider](#14-future-additions-to-consider)
15. [Function reference](#15-function-reference)

---

## 1. What the tool does

The tool takes two inputs — a **Google Doc transcript** (.docx) and a **Premiere Pro exported SRT file** — and produces a **formatted SRT** ready to re-import into Premiere.

It automates three things that were previously done manually for every video:

1. **Italic detection** — identifies which captions are quotes or non-host speaker lines, and marks them italic. Previously done by ear while watching the video.
2. **Speaker name formatting** — ensures non-host speaker labels (`JODY:`, `SERON CHAU:`) appear alone on line 1 of their caption, with the quote beginning on line 2, and that the name is italic.
3. **Line distribution** — re-splits caption text across two lines using natural language breaks (punctuation-first, balanced-split fallback). Captions under 30 chars stay on one line.

It also detects and flags structural problems that Premiere creates when auto-generating captions — mid-caption speaker labels, names split across captions, ellipsis placement issues — and fixes them automatically where possible, flagging others for manual timing adjustment in Premiere.

---

## 2. User workflow

### Step-by-step

**In Premiere Pro:**

1. Open the Captions template project and import the episode master
2. Right-click the episode → Modify → Audio Channels → set to Stereo
3. Mark ins/outs for the segment, drag into the sequence timeline
4. Text panel → Transcript tab → click **Transcribe**
5. While transcribing: copy the relevant transcript section from Google Docs and clean it via textcleaner.net (replace line breaks with spaces, remove extra spaces, remove duplicate lines)
6. Once Premiere finishes transcribing: in Transcript tab, click the left button (Show Source Monitor Transcript), select all (Cmd+A), click Merge Segments
7. Paste the cleaned Google Doc text over the Premiere transcript
8. Click right button (Show Program Monitor Transcript), then click **CC** (Create Captions)
9. Settings: Style = ABC Captions 2024, Max length = 30, Min duration = 6, Gap = 0, Lines = Double
10. Do manual timing fixes in the Captions tab (Step 5 of the PDF guide)
11. **File → Export → Captions → SubRip (.srt)** — tick **Include Styling**

**In the tool:**

12. Download the Google Doc transcript: **File → Download → Microsoft Word (.docx)**
13. Open `ABC_Caption_Formatter_v2.html` in Chrome (double-click the file — no internet needed)
14. Drop the `.docx` into Step 1 — wait for "X bold segments detected"
15. Drop the `.srt` into Step 2 — wait for "X captions loaded"
16. Click **Format captions**
17. Review the output — blue rows are italic, white rows are plain. Orange ⚠ flags need attention.
18. Click **↓ Download .srt**

**Back in Premiere:**

19. Captions tab → **⋯ menu → Import Captions from File** → select the formatted SRT
20. Delete the old caption track
21. Select all captions → Properties panel → set Track Style to **ABC Captions 2024**
22. Address any ⚠ flagged captions (timing splits, long lines)
23. Watch twice to check, then export and upload

### Important note on track styles and italics

Applying the ABC Captions 2024 track style **after** import can wipe italic formatting. The safest approach is:
- Import the SRT while the track style is already set, OR
- Set style at the track level (Caption Track Settings) rather than selecting all captions and applying

Test this once with a short clip when first setting up the workflow.

---

## 3. Style guide rules implemented

### Automatically applied

| Rule | Implementation |
|---|---|
| Max 30 chars per line | Enforced in `splitLines()` — both punctuation candidates and balanced split targets ≤30 chars per line |
| Two lines max per caption | Tool works within Premiere's caption structure — never creates more than 2 lines per output caption |
| Under 30 chars → single line | `splitLines()` returns immediately if `text.length <= 30` |
| Punctuation-based line breaks | Commas, semicolons, colons, em/en dashes trigger preferred break points |
| Balanced line distribution | When no valid punctuation break, balanced word split minimises the length difference between lines |
| No break at thousands-separator commas | `250,000` and `250, 000` are protected — regex uses lookbehind/lookahead |
| Speaker name on line 1, quote on line 2 | `processCaptions()` non-host branch always sets `[NAME:, quote_text]` |
| Non-host speech is italic | Bold formatting in transcript drives `<i>` tag wrapping in SRT output |
| Quoted/on-screen text is italic | Same italic detection covers both speaker quotes and standalone italic passages |
| Speaker name is italic | NAME: line is included in the `<i>` wrapping |

### Not automated (requires manual check)

- OK vs okay — not changed (Premiere's transcript usually gets this right)
- per cent vs % — not changed
- Numbers as words (one, two... nine) — not changed
- Sound effects in (CAPS) — not checked
- Swearing classification — not checked
- Ellipsis direction (lowercase vs uppercase continuation) — not changed
- Decades apostrophe (80s not 80's) — not changed
- All rounds of manual checking — the tool supplements, not replaces, the human review

---

## 4. Inputs

### Input 1: Google Doc transcript (.docx)

The script/transcript as written by the presenter/producer in Google Docs. Must be downloaded as Word format (File → Download → Microsoft Word).

**Formatting conventions that the tool relies on:**

- **Plain text** = host narration. Not italic in captions.
- **Bold text** (bold-only or bold+italic) = quotes, non-host speech, on-screen text. Italic in captions.
- **Speaker labels** appear as `ALL CAPS NAME:` immediately before bold quote text. E.g. `JODY:`, `SERON CHAU:`, `LIAM BARTLETT:`.

The tool uses [mammoth.js](https://github.com/mwilliams/mammoth.js) (bundled, no internet needed) to convert the .docx to HTML, then walks the HTML DOM to extract all bold text segments.

**Why mammoth over copy-paste?** Copy-paste from Google Docs into a browser contenteditable area also preserves HTML formatting, but is unreliable across browsers and paste contexts. Mammoth reads the .docx file format directly and consistently.

### Input 2: Premiere SRT export

The SRT exported from Premiere after captions are created and timing is manually fixed. Must be exported with **Include Styling** ticked (File → Export → Captions → SubRip).

**What Premiere exports:**

```
1
00:00:00,800 --> 00:00:03,720
<font color=#000000FF>And now, to the most urgent</font>

4
00:00:08,760 --> 00:00:10,040
<i><font color=#000000FF>JODY: </font></i>
<i><font color=#000000FF>Piece together</font></i>
```

The tool **strips all existing HTML tags** (`<font>`, `<i>`, `<b>`, everything) from the SRT and reprocesses from the plain text. The existing italic formatting from Premiere is intentionally discarded — the tool rebuilds it from the transcript.

---

## 5. Core processing logic

Processing happens in this sequence:

```
parseSRT(raw)
  → rawCaptions[]

parseTranscript(mammothHtml)
  → boldSegments[]

buildIndex(boldSegments)
  → segs[] (array of normalized strings)

preprocessMidSpeakers(rawCaptions)
  → caps[] (structural fixes applied)

processCaptions(caps, segs)
  → result[] (italic + line split applied)

writeSRT(result)
  → formatted SRT string
```

Each caption object throughout processing has the shape:
```javascript
{
  start: Number,      // ms from start
  end: Number,        // ms from start
  text: String,       // plain text (tags stripped)
  timingFlag: String  // optional — set by preprocessor, carried to output
}
```

Output caption objects:
```javascript
{
  start: Number,
  end: Number,
  lines: String[],    // 1 or 2 lines of text
  italic: Boolean,
  timingFlag: String, // shown as ⚠ in UI, included in download
  flag: String        // secondary flag (e.g. "line2 long")
}
```

---

## 6. Preprocessing pass — structural fixes

`preprocessMidSpeakers(captions)` runs before any italic or split logic. It fixes four structural problems that occur when Premiere auto-generates captions and when the timing is manually edited.

All fixes operate on a **copy** of the captions array so the originals are not mutated.

### Case 1 — Cross-caption name split

**Problem:** A speaker name gets split across two captions because Premiere's timing cut happened mid-name.

```
Cap N:   "however that left the energy minister speechless: LIAM"
Cap N+1: "BARTLETT: At what point during this crisis"
```

**Detection:** Caption ends with 2+ consecutive ALL CAPS characters AND the next caption starts with ALL CAPS + colon.

**Fix:** Strip the trailing ALL CAPS word from cap N, prepend it to cap N+1.

```
Cap N:   "however that left the energy minister speechless:"  ⚠ timing flag
Cap N+1: "LIAM BARTLETT: At what point during this crisis"   ⚠ timing flag
```

**Regex:** `/^([\s\S]+?)\s+([A-Z]{2,})$/` on cap N text, then check `caps[i+1]` starts with `/^[A-Z][A-Z\s]{0,20}:/`

### Case 2 — Mid-caption speaker MIDDLE

**Problem:** Premiere puts host narration and the start of a speaker quote in the same caption.

```
"on our phones: JODY: Piece together"
```

**Detection:** Text contains lowercase characters AND matches pattern `(lowercase text) (ALL CAPS NAME): (rest)`.

**Fix:** Move the "before" text to the previous caption, rewrite current as `SPEAKER: rest`.

```
Cap N-1: "What to do with all the bloody photos on our phones:"  ⚠ timing flag
Cap N:   "JODY: Piece together"                                  ⚠ timing flag
```

**Length check:** If the combined previous caption text exceeds 60 chars, it gets a `⚠ TOO LONG` flag instead — automatic fix not safe.

### Case 3 — Mid-caption speaker END

**Problem:** The speaker label appears at the end of a caption with nothing after it.

```
Cap N:   "they've taken to the internet to say so: SERON CHAU:"
Cap N+1: "I feel like I'm holding a collectable artbook"
```

**Detection:** Same `detectMidSpeaker()` match, but `rest` is empty.

**Fix:** Keep current caption as plain text only, prepend the label to the next caption.

```
Cap N:   "they've taken to the internet to say so:"  ⚠ timing flag
Cap N+1: "SERON CHAU: I feel like I'm holding..."    ⚠ timing flag
```

### Case 4 — Colon + ellipsis

**Problem:** Premiere places a trailing ellipsis — the start of a quote — at the end of a host narration caption, either alone or with text after it.

```
"she agreed: …"
"a battery technology expert who told us: … the comment"
```

**Detection:** Caption matches `/^(.+?):\s*(…|\.{3})([\s\S]*)$/`

**Fix:** Keep the text up to and including the colon as the current caption; move the ellipsis (plus any following text) to the start of the next caption.

```
"she agreed:"                                             ⚠ timing flag
"… the disclosure may not have been as clear as it…"     ⚠ timing flag
```

**Length check:** If the combined next caption text exceeds 60 chars, it gets a `⚠ TOO LONG` flag.

---

## 7. Italic detection

### How it works

The tool determines whether a caption should be italic by checking whether its text appears as a consecutive sequence in any of the bold segments extracted from the transcript.

**Key design decision:** Uses **consecutive word sequence matching**, not word-overlap percentage. This was chosen after word-overlap at 75% threshold produced too many false positives in transcripts with shared vocabulary (e.g. "battery", "cobalt", "energy" appearing in both host narration and quotes).

### `parseTranscript(html)` — extracting bold segments

1. Mammoth converts .docx to HTML
2. The HTML DOM is walked recursively
3. A text node is "bold" if any of its ancestors is a `<b>` or `<strong>` tag, or has `font-weight: bold` in inline style
4. Bold text is accumulated into segments, flushed at block-level elements (`<p>`, `<div>`, `<li>`, etc.)
5. **Post-processing:** Speaker label prefixes are stripped BEFORE normalizing. `"CHRIS BOWEN: That's a pretty loaded..."` becomes `"that's a pretty loaded..."`. This is critical — without it, captions like `"Chris Bowen"` in host narration would match the CHRIS BOWEN: bold segment.

```javascript
const stripped = s.replace(/^[A-Z][A-Z\s\.]{0,40}:\s*/, '').trim();
return normalize(stripped);
```

### `normalize(text)` — text normalisation

Applied to both caption text and bold segments before any comparison:

- Lowercase everything
- Smart quotes → straight quotes
- Em dashes, en dashes, hyphens → spaces
- Strip everything except a-z, 0-9, spaces, apostrophes
- Collapse whitespace

This makes matching robust across different quote styles, dash types, and minor transcription differences.

### `shouldBeItalic(text, segs)` — italic decision

Two code paths based on caption length:

**Short captions (fewer than 3 meaningful words, where "meaningful" = >3 chars):**
Requires the full normalized text to appear verbatim as a substring of a bold segment. This prevents `"Chris Bowen"`, `"about cobalt:"`, `"announced:"` etc. from matching on just 2 words.

**Longer captions (3+ meaningful words):**
Requires a run of 3+ consecutive normalized words from the caption to appear consecutively in any single bold segment.

```javascript
for (const seg of segs) {
  for (let start = 0; start <= words.length - minRun; start++) {
    for (let len = minRun; len <= words.length - start; len++) {
      const run = words.slice(start, start + len).join(' ');
      if (seg.includes(run)) return true;
    }
  }
}
```

### Speaker label-push captions — forced plain

Captions that end with `:` and were produced by Case 3 or Case 4 in preprocessing (their `timingFlag` contains `"pushed"`) are forced plain regardless of the italic index. This prevents fragments like `"about cobalt:"` being italicised just because "cobalt" appears in a bold segment.

### Non-host speaker detection

In `processCaptions()`, when a caption starts with a speaker label (`detectSpeaker()` returns non-null), the tool checks whether that speaker is the host:

```javascript
const isNonHost = shouldBeItalic(spk.name, boldIdx) || shouldBeItalic(spk.rest, boldIdx);
```

If the speaker's name OR their quote appears in the bold segments, they're treated as non-host (italic). If neither matches, they're treated as host (label stripped, no italic).

This is entirely transcript-driven — no hardcoded host name required.

---

## 8. Line splitting

`splitLines(text)` implements a two-stage strategy:

### Stage 1 — Punctuation break

Searches for natural break points: commas (not between digits), semicolons, colons, em dashes (—), en dashes (–).

Break is only accepted if:
- It falls between 20% and 80% of the total text length (prevents `"Yes,"` splitting off as a tiny first line)
- Both resulting lines are ≤ 30 characters

If multiple valid punctuation breaks exist, the one closest to the midpoint is chosen (most visually balanced).

**Special case — thousands separators:** The regex uses lookbehind/lookahead to exclude commas between digits: `/(?<!\d),(?!\s*\d)/`. So `"250,000"` and `"250, 000"` don't break at the comma.

### Stage 2 — Balanced word split (fallback)

If no valid punctuation break exists, finds the word boundary that minimises the absolute difference in line lengths.

```javascript
const diff = Math.abs(l1.length - l2.length);
if (diff < bestDiff) { bestDiff = diff; best = [l1, l2]; }
```

### Single-line shortcut

If `text.length <= 30`, returns immediately as a single line. No split attempted.

### Name captions — no splitting

Speaker name captions (`["JODY:", "Piece together your favourite memories"]`) are constructed directly in `processCaptions()`, not passed through `splitLines()`. The name always sits alone on line 1. The quote text goes on line 2 as-is. If line 2 exceeds 40 chars, a flag is set but no automatic split is attempted — Premiere handles this.

---

## 9. Output and flags

### Visual display

- **White row** = plain (host narration)
- **Blue row** = italic (quote, non-host speech, on-screen text)
- **⚠ flag in timestamp column** = needs attention in Premiere

### Flag types

| Flag | Meaning | Required action in Premiere |
|---|---|---|
| `Timing adjusted — text moved from next caption` | Text from the following caption was appended here | Move the in-point of this caption forward to cover the extra words |
| `Timing adjusted — leading text moved to previous caption` | Opening words were moved to the previous caption | Move the out-point of this caption back |
| `Timing adjusted — speaker label pushed to next caption` | Speaker label was moved forward | Adjust out-point to not include the label timing |
| `Timing adjusted — speaker label moved from previous caption` | Label arrived from previous caption | Move in-point back to cover the label |
| `Timing adjusted — name moved/merged` | Name was split across captions and merged | Adjust timing at this cut point |
| `Timing adjusted — ellipsis pushed/moved` | Ellipsis relocated to correct caption | Adjust timing at this cut point |
| `⚠ Line too long after merge — split manually in Premiere` | Combined text exceeds 60 chars — auto-split not safe | Split the caption manually in Premiere and set independent timing |
| `⚠ Line too long after ellipsis merge — split manually in Premiere` | Same, caused by ellipsis prepend | Same resolution |
| `Timing needs split — quote and host text in same caption` | A caption had italic quote + plain narration mixed | Two output captions share the same timestamp — set the split point in Premiere |
| `Timing needs split — host text separated from quote` | Second part of the above split | Same |
| `Line 2 long — check in Premiere` | Speaker quote on line 2 exceeds 40 chars | May need manual line break in Premiere Properties panel |

---

## 10. SRT output format

The tool outputs standard SubRip format with `<i>` tags for italic:

```
1
00:00:00,800 --> 00:00:03,720
And now, to the most urgent
of the very many torments

4
00:00:08,760 --> 00:00:10,040
<i>JODY:</i>
<i>Piece together</i>

5
00:00:10,040 --> 00:00:12,560
<i>your favourite memories,</i>
<i>literally.</i>
```

Each line of a caption is wrapped individually in `<i>` tags (not the whole block). Premiere reads these on import and applies italic formatting as a character-level property.

**Timecodes are never modified.** The tool preserves the exact start and end times from the input SRT. Only the text content and tag structure change.

---

## 11. Deployment

The tool is a **single standalone HTML file** with no external dependencies. Mammoth.js (~636KB) is bundled inline. No server, no internet connection, no install required.

**To share:** Email or Slack the HTML file. Recipient opens it in Chrome by double-clicking.

**To update the tool:** Edit `ABC_Caption_Formatter_v2.html` directly. The JS is in the `<script>` tag near the bottom of the file. The mammoth bundle is in the `<script>` tag at the very top (after the `<title>` tag).

**Browser support:** Chrome only. The tool uses `DOMParser`, `FileReader`, `URL.createObjectURL`, and CSS custom properties — all supported in modern Chrome. Not tested in Firefox or Safari.

---

## 12. Known limitations and edge cases

### Lines that exceed 30 chars after merging

When preprocessing moves text from one caption to another (Cases 2, 4), the combined result may exceed what `splitLines()` can handle. If the combined text is >60 chars, a `⚠ TOO LONG` flag is set and the caption is left as-is for manual fixing in Premiere. `splitLines()` only produces clean results when the total text is ≤60 chars (two ≤30-char lines).

### Italic detection without a transcript

If no .docx is uploaded, `boldSegments` is empty and `shouldBeItalic()` always returns false. Speaker labels from the SRT are still detected and formatted correctly (NAME: on line 1, quote on line 2), but the quote text will not be italicised. This is a valid "speaker formatting only" mode.

### Attribution text in SRT

Some SRTs include source attribution as caption content (e.g. `"Email, ACCC Spokesperson, 20 Apr 2026"`). The tool processes this as a normal caption. It will appear as a plain caption in the output. The user should delete these captions in Premiere.

### Very long unbreakable lines

If a single word exceeds 30 chars (rare but possible with long URLs or compound words), `splitLines()` returns it as a single line with no split. No flag is set. These will appear in the output preview and the user should catch them visually.

### False positives / negatives in italic detection

The 3-consecutive-word matching is robust but not perfect. Edge cases:

- **False positive risk:** If host narration happens to use the same 3+ word sequence as a bold segment. E.g. host says "a battery technology expert" and the transcript has a quote containing those exact words. Rare but possible.
- **False negative risk:** Very short italic captions (single sentence fragments of 2-3 words) where the full text doesn't appear verbatim in the bold segments. The user should catch these in review.

### Cross-caption name split false positives

The Case 1 detection (`caption ends with ALL CAPS words`) could theoretically fire on a caption ending with a place name or acronym that happens to match the start of the next caption. The safeguard is that the next caption must also start with `ALL CAPS:` (colon required) — this makes false positives unlikely but not impossible.

---

## 13. What the tool does NOT do

- **Does not modify timecodes** — all timing comes from the input SRT unchanged
- **Does not enforce the style guide** beyond italic and line distribution — numbers, spelling, punctuation, swearing, ellipsis direction are not touched
- **Does not add or remove captions** — the number of captions in the output matches the input (except when `detectTrailingPlain` splits one mixed caption into two with shared timing)
- **Does not apply the ABC Captions 2024 font/style** — that is applied in Premiere after import
- **Does not do a second round of review** — the tool is the first pass, human review is still required
- **Does not validate transcript against audio** — this was considered but the Gemini audio check feature was deprioritised in favour of the formatting workflow

---

## 14. Future additions to consider

### Audio transcript verification (Gemini)

A previous version of the tool included a `/api/audio-check` endpoint using Gemini 1.5 Flash. The user drops an MP3 (exported from Premiere at 128kbps), the audio is sent to Gemini alongside the captions, and Gemini identifies transcription errors (wrong words, missed words, name misspellings).

This was built but deprioritised because the Google Doc transcript replaces Premiere's auto-transcription for accuracy. However, the Google Doc itself might contain errors, and audio verification would catch those.

The proxy server (`server.js`) still has the Gemini endpoint. To re-enable: add the audio drop zone to the HTML, wire it to the proxy, add `GEMINI_API_KEY` to Render environment variables.

### Style guide AI review (Claude API)

A previous version sent captions to Claude with the full ABC style guide prompt for a contextual review — practice/practise in context, lead/led, American spellings, ellipsis direction, dash usage. This was removed to simplify the workflow but the prompt is documented in conversation history and could be re-added as an optional "AI style check" button.

### Vertical video mode

The Premiere guide mentions a vertical video variant with different settings: Style = VV Captions, Max length = 36 chars, Min duration = 6, Gap = 0. The tool currently only handles the standard 30-char horizontal format. A toggle between horizontal (30 chars) and vertical (36 chars) would cover both workflows.

### Transcript cleaner

Steps 2-3 of the Premiere workflow involve manual text cleaning (removing speaker attributions, collapsing line breaks) via textcleaner.net. This could be built into the tool as a "Transcript Cleaner" tab — paste raw Google Doc text, get back a clean block ready to paste into Premiere's transcript tab.

---

## 15. Function reference

### Utility functions

**`normalize(text)`**
Lowercases, converts smart punctuation to ASCII equivalents, strips dashes to spaces, removes non-alphanumeric characters except spaces and apostrophes. Used to make caption text and transcript segments comparable.

**`esc(s)`**
HTML-escapes a string for safe display in innerHTML. Converts `&`, `<`, `>`.

**`parseTime(ts)`**
Converts SRT timestamp string (`"00:01:23,456"`) to milliseconds.

**`fmtTime(ms)`**
Converts milliseconds back to SRT timestamp string.

### Transcript processing

**`parseTranscript(html)`**
Extracts bold text segments from mammoth HTML. Walks DOM tree, accumulates text from bold nodes, flushes at block elements. Post-processes by stripping ALL CAPS speaker prefixes before normalizing. Returns array of normalized strings.

**`buildIndex(segs)`**
Identity function — returns the segs array. Exists for historical reasons (previous version built a string index). Could be removed.

**`shouldBeItalic(text, segs)`**
Returns true if the normalized caption text appears as a consecutive word sequence in any bold segment. Short captions (< 3 meaningful words) require full-text verbatim match. Longer captions require 3+ consecutive matching words.

### SRT processing

**`parseSRT(raw)`**
Splits SRT into blocks, extracts timecodes and strips all HTML tags from text. Returns array of `{start, end, text}` objects with times in milliseconds.

**`writeSRT(captions)`**
Converts processed caption objects back to SRT string. Wraps italic caption lines in `<i>` tags.

### Speaker detection

**`detectSpeaker(text)`**
Detects `ALL CAPS NAME: rest` at start of caption. Returns `{name, rest}` or null. Requires ≥85% uppercase ratio in name to avoid false positives on sentence-starting words.

**`detectMidSpeaker(text)`**
Detects `(lowercase text) ALL CAPS NAME: (optional rest)` anywhere in a caption. Returns `{before, speaker, rest}` or null. Guards: text must contain lowercase, "before" must not itself be an all-caps label.

### Line handling

**`splitLines(text)`**
Returns 1 or 2 line array. Single line if ≤30 chars. Tries punctuation breaks (20–80% position, both lines ≤30 chars) then falls back to balanced word split. Excludes digit-to-digit commas (thousands separators).

**`detectLeadIn(text, segs)`**
Detects italic captions starting with host narration swept in before the quote. Pattern: `(≤6 words):` followed by rest. The before-text must NOT be in the bold index.

**`detectTrailingPlain(text, segs)`**
Detects italic captions ending with `…` followed by a capital-letter host sentence. The italic part must be in the bold index; the plain part must not.

### Pipeline

**`preprocessMidSpeakers(captions)`**
Runs all 4 structural fix cases on a copy of the captions array. Sets `timingFlag` properties. Returns modified copy.

**`processCaptions(captions, boldIdx)`**
Main loop. Calls preprocessMidSpeakers, then for each caption: detects speakers, classifies italic/plain, handles lead-ins and trailing-plain splits, runs splitLines. Returns array of output caption objects.

**`renderOutput()`**
Builds the output panel HTML. Blue rows for italic, white for plain, ⚠ flags in the timestamp column.

**`dl()`**
Downloads the formatted SRT file using a Blob URL.
