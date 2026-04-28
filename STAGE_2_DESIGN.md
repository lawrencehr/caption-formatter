# ABC Caption Formatter — Stage 2 Design & Scoping Document

> **Project:** Adding AI-powered caption refinement to the existing Sunrise v3 tool
> **Status:** Scoping complete, ready for implementation in Claude Code
> **Date:** April 2026

---

## Table of Contents

1. [Context](#1-context)
2. [Goals and non-goals](#2-goals-and-non-goals)
3. [User experience](#3-user-experience)
4. [Architecture overview](#4-architecture-overview)
5. [Component 1 — WhisperX local server](#5-component-1--whisperx-local-server)
6. [Component 2 — Cloudflare Tunnel exposure](#6-component-2--cloudflare-tunnel-exposure)
7. [Component 3 — Render proxy extensions](#7-component-3--render-proxy-extensions)
8. [Component 4 — Browser tool Stage 2 UI](#8-component-4--browser-tool-stage-2-ui)
9. [Data formats and interfaces](#9-data-formats-and-interfaces)
10. [Gemini prompt design](#10-gemini-prompt-design)
11. [Italic preservation through pipeline](#11-italic-preservation-through-pipeline)
12. [Implementation phases](#12-implementation-phases)
13. [Testing strategy](#13-testing-strategy)
14. [Known risks and mitigations](#14-known-risks-and-mitigations)
15. [Out of scope](#15-out-of-scope)
16. [Open questions](#16-open-questions)

---

## 1. Context

### What exists today

**Sunrise v3** (`ABC_Caption_Formatter_v2.html`) — a self-contained HTML tool that:
- Takes a Premiere Pro SRT export and a Google Doc transcript (.docx)
- Strips Premiere's HTML tags, parses bold formatting from the transcript
- Fixes 4 structural caption problems: cross-caption name splits, mid-caption speaker labels (MIDDLE and END cases), colon+ellipsis placements
- Applies italic formatting based on bold segments in the transcript
- Redistributes lines using punctuation-first then balanced-split logic
- Flags timing-affected captions with ⚠ warnings
- Outputs a formatted SRT for re-import to Premiere

**Existing proxy** (`server.js` on Render) — Node.js/Express server with:
- Auth via shared secret header
- `/api/review` endpoint for Anthropic Claude API calls
- `/api/audio-check` endpoint for Gemini API calls (built but not currently exposed in tool)
- Environment variables: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `SHARED_SECRET`

**Workflow today:** User runs Sunrise v3, gets a formatted SRT with some ⚠ flags, manually adjusts those captions in Premiere.

### The problem Stage 2 solves

The ⚠ flagged captions still need manual work in Premiere — splitting overlong lines, adjusting timing where text was moved between captions, and addressing line breaks that fall in awkward places (mid-name, mid-phrase). Stage 2 automates that work using AI suggestions plus accurate force-alignment.

---

## 2. Goals and non-goals

### Goals

- **Reduce manual Premiere fixes** by automatically suggesting better caption breaks
- **Preserve all existing italic formatting** through the pipeline
- **Improve timing accuracy** beyond what Premiere's manual workflow produces
- **Keep the user in control** — show suggested changes as a diff, let them accept/reject
- **Maintain offline-first principle** for Stage 1 — Stage 2 is opt-in and requires audio + internet

### Non-goals

- Replacing Stage 1 — Stage 2 builds on Stage 1's output, doesn't duplicate it
- Real-time captioning or live alignment
- Multi-language support
- Speaker diarisation (the Google Doc transcript already provides this)
- Automatic style guide enforcement (numbers, spelling, etc.) — still human-reviewed

---

## 3. User experience

### Updated workflow

1. User completes existing Premiere workflow through manual timing fixes (unchanged)
2. User exports SRT (unchanged)
3. **NEW:** User exports MP3 audio: File → Export → Media → MP3, 128 kbps
4. User opens Sunrise v3 (now Sunrise v4 after Stage 2 work)
5. Drops .docx, drops .srt, clicks **Format captions** (unchanged — Stage 1)
6. **NEW:** Below the formatted output, a new section appears: **"Refine with AI"**
7. User drops the MP3 file
8. User clicks **"Refine captions"**
9. Tool shows a status bar: *"Sending to Gemini for review... aligning timing... done."*
10. Tool displays a side-by-side diff: Stage 1 captions on the left, Stage 2 suggestions on the right, with changes highlighted
11. User reviews the diff. Each changed caption has a checkbox — user can accept or reject individual suggestions
12. User clicks **"Download refined SRT"** — gets the final file with accepted changes applied + accurate WhisperX timing
13. Re-imports into Premiere as before

### What the user sees during Stage 2

- ⏳ "Uploading audio to AI for review..." (~2 sec)
- ⏳ "Gemini is analysing audio + captions..." (~10-30 sec depending on length)
- ⏳ "Aligning timing with WhisperX..." (~5-15 sec)
- ✓ "12 suggested improvements" — opens diff view

---

## 4. Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│ User's browser — Sunrise v4 HTML                            │
│  • Stage 1 processing (existing, unchanged)                 │
│  • Stage 2 UI: audio upload, refine button, diff view       │
└────────┬─────────────────────────────────────────┬──────────┘
         │                                          │
         │ POST /api/refine                         │ POST /api/refine
         │ { audio_b64, captions[], metadata }      │ (multipart for big audio)
         ▼                                          ▼
┌─────────────────────────────────────────────────────────────┐
│ Render proxy (existing server.js, extended)                 │
│  • Auth check via X-Secret                                  │
│  • Coordinates 2-step pipeline:                             │
│    1. Call Gemini → get caption suggestions                 │
│    2. Call WhisperX (via Cloudflare tunnel) → align timing  │
│  • Returns merged result to browser                         │
└────────┬────────────────────────────────────────┬───────────┘
         │                                          │
         ▼                                          ▼
┌──────────────────────┐                ┌─────────────────────┐
│ Gemini 1.5 Flash API │                │ Cloudflare Tunnel   │
│ • Audio + captions   │                │ → User's home PC    │
│ • Returns suggested  │                │ → WhisperX FastAPI  │
│   caption edits      │                │   server            │
└──────────────────────┘                └─────────────────────┘
```

### Why this architecture

- **Browser is the orchestrator** — keeps state simple, user sees progress
- **Render proxy hides API keys + WhisperX URL** — never exposed to client
- **Sequential pipeline** — Gemini suggests text changes, then WhisperX aligns the new text. WhisperX timing without Gemini's text edits is less useful; Gemini text without timing alignment is incomplete
- **Cloudflare Tunnel for WhisperX** — gives the home server a stable public URL without dealing with router config or ngrok's restart issues

---

## 5. Component 1 — WhisperX local server

### Purpose

Receives audio + a list of caption text segments, returns word-level timestamps that the proxy uses to retime the SRT.

### Tech stack

- **Python 3.10+** (WhisperX requires this)
- **FastAPI** for the HTTP server
- **Uvicorn** as the ASGI server
- **WhisperX** for force alignment
- **PyTorch** + **CUDA toolkit** for GPU acceleration (CPU fallback if no GPU)

### Files to create

```
abc-captions/
└── whisperx-server/
    ├── server.py              # FastAPI app
    ├── requirements.txt       # Python deps
    ├── start.bat              # Windows startup script
    ├── .env                   # API key for auth (matches Render proxy SHARED_SECRET)
    └── README.md              # Setup instructions
```

### API

**POST `/align`**

Request body (JSON):
```json
{
  "audio_base64": "...",
  "audio_format": "mp3",
  "captions": [
    { "index": 1, "text": "And now to the secret evil" },
    { "index": 2, "text": "in Australia's renewable energy" }
  ],
  "language": "en"
}
```

Headers:
- `X-Secret: <shared secret matching Render env var>`

Response:
```json
{
  "captions": [
    {
      "index": 1,
      "text": "And now to the secret evil",
      "start_ms": 800,
      "end_ms": 3720,
      "words": [
        { "word": "And", "start_ms": 800, "end_ms": 920 },
        { "word": "now", "start_ms": 920, "end_ms": 1100 }
      ]
    }
  ]
}
```

### Hardware requirements

- **GPU path:** NVIDIA card with 4GB+ VRAM, CUDA 12.x toolkit. ~5x faster.
- **CPU path:** Any modern CPU. ~30-60 sec per 5-minute video.
- **RAM:** 8GB minimum, 16GB recommended

### Startup behaviour

- `start.bat` activates a venv, runs `uvicorn server:app --host 0.0.0.0 --port 8765`
- Port 8765 is internal — exposure happens via Cloudflare Tunnel
- Server should auto-restart on Windows reboot (configure as a scheduled task)

---

## 6. Component 2 — Cloudflare Tunnel exposure

### Why Cloudflare Tunnel

- **Free** with no time limits
- **Stable URLs** — `https://whisperx-abc.example.com` doesn't change between restarts
- **Built-in auth** — Cloudflare Access can require a token before traffic reaches your machine
- **Better than ngrok free tier** which gives random URLs that rotate

### Setup steps (one-time)

1. Sign up for free Cloudflare account
2. Add a domain (or use a Cloudflare-issued `*.trycloudflare.com` subdomain — no domain needed)
3. Install `cloudflared` on Windows: `winget install --id Cloudflare.cloudflared`
4. Authenticate: `cloudflared tunnel login`
5. Create tunnel: `cloudflared tunnel create whisperx-abc`
6. Configure tunnel routing in `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: <tunnel-id>
   credentials-file: C:\Users\<user>\.cloudflared\<tunnel-id>.json
   ingress:
     - hostname: whisperx-abc.example.com
       service: http://localhost:8765
     - service: http_status:404
   ```
7. Run as a Windows service: `cloudflared service install`
8. Note the public URL — this goes into the Render proxy as `WHISPERX_URL` env var

---

## 7. Component 3 — Render proxy extensions

### New endpoint

**POST `/api/refine`**

Headers:
- `X-Secret: <shared secret>`
- `Content-Type: multipart/form-data` (for audio file upload)

Form fields:
- `audio` — MP3 file
- `captions` — JSON string of Stage 1 caption objects (with italic flags preserved)

Response:
```json
{
  "status": "success",
  "stages": {
    "gemini": { "duration_ms": 12400, "suggestions_count": 14 },
    "whisperx": { "duration_ms": 8200 }
  },
  "captions": [
    {
      "index": 1,
      "text": "And now, to the secret evil",
      "italic": false,
      "start_ms": 800,
      "end_ms": 3720,
      "changed": true,
      "change_type": "phrase_break",
      "original_text": "And now to the secret evil"
    }
  ]
}
```

### New environment variables

- `WHISPERX_URL` — Cloudflare Tunnel URL pointing to home WhisperX server
- (Existing) `GEMINI_API_KEY`, `SHARED_SECRET`

### Pipeline logic

```javascript
1. Validate request, verify X-Secret
2. Upload audio to Gemini (Files API for files >20MB, inline base64 otherwise)
3. Call Gemini with audio + captions + STAGE_2_PROMPT
4. Parse Gemini response → list of suggested caption edits
5. Send (audio + suggested caption text) to WhisperX server
6. Receive word-level timestamps from WhisperX
7. Merge: take Gemini's text + italic flags from input + WhisperX's timing
8. Return merged result to browser
```

### Error handling

- WhisperX server unreachable → return Gemini suggestions with original timing, flag in response
- Gemini fails → return original captions unchanged with error message
- Audio too large → return 413 with size limit info
- Timeout: 120 seconds for the full pipeline

---

## 8. Component 4 — Browser tool Stage 2 UI

### New section appears after Stage 1 completes

```
┌──────────────────────────────────────────────────┐
│ STAGE 2: REFINE WITH AI (optional)               │
├──────────────────────────────────────────────────┤
│  Drop MP3 audio file here or click to browse     │
│  [audio upload zone]                             │
│                                                  │
│  [Refine captions →]   ← disabled until audio    │
└──────────────────────────────────────────────────┘
```

### Diff view (after refinement completes)

```
┌──────────────────────────────────────────────────────────────┐
│ 14 SUGGESTED IMPROVEMENTS  [ Accept all ] [ Reject all ]     │
├──────────────────────────────────────────────────────────────┤
│ ✓ Cap 12  00:00:23                              [phrase]     │
│   ─ left the energy minister speechless: LIAM                │
│   + left the energy minister speechless:                     │
│   ─ BARTLETT: At what point during                           │
│   + LIAM BARTLETT: At what point during                      │
├──────────────────────────────────────────────────────────────┤
│ ✓ Cap 27  00:01:15                              [timing]     │
│   timing: 00:01:14,200 → 00:01:14,560                        │
├──────────────────────────────────────────────────────────────┤
│ ☐ Cap 33  00:02:08                              [phrase]     │
│   ─ which: ... applies as much                               │
│   + which:                                                   │
│   + ... applies as much                                      │
└──────────────────────────────────────────────────────────────┘

[ Download refined SRT ]   [ Skip refinement ]
```

### State management

```javascript
// New state on top of existing
let stage2Audio = null;       // ArrayBuffer of MP3
let stage2Suggestions = [];    // From /api/refine response
let stage2Accepted = new Set(); // Caption indices user accepted
let stage2Status = 'idle';     // idle | uploading | processing | done | error
```

### Download merge logic

When user clicks "Download refined SRT":
- For each caption: if `stage2Accepted.has(index)` use Stage 2 text + timing, else use Stage 1
- Italic flags always come from Stage 1 (not Gemini)
- Generate SRT exactly as Stage 1 currently does

---

## 9. Data formats and interfaces

### Caption object — canonical schema through pipeline

```typescript
interface Caption {
  index: number;          // 1-based caption number
  text: string;           // plain text, no HTML tags
  italic: boolean;        // from Stage 1, never modified by Stage 2
  start_ms: number;       // milliseconds
  end_ms: number;
  // Stage 1 only:
  timingFlag?: string;    // ⚠ flag if any
  // Stage 2 only:
  changed?: boolean;
  change_type?: 'phrase_break' | 'name_kept_together' | 'timing_only' | 'split' | 'merge';
  original_text?: string; // pre-Gemini text for diff display
}
```

### SRT output

Generated client-side after merge. Format unchanged from Stage 1:
```
1
00:00:00,800 --> 00:00:03,720
And now, to the secret evil
in Australia's renewable energy
```

Italic captions wrap each line in `<i>...</i>`.

---

## 10. Gemini prompt design

### Prompt template

```
You are an expert caption editor for ABC Media Watch social media videos.
You will receive audio and a list of captions that have been auto-formatted
from a Premiere Pro export.

Your job: review the captions against what is actually said in the audio,
and suggest improvements where the caption breaks fall in awkward places.

PRIORITISE:
- Captions flagged with "⚠" — these are known to have timing issues
- Captions where a person's name is split across two captions (e.g. "LIAM" /
  "BARTLETT:" should be merged so "LIAM BARTLETT:" appears together)
- Caption breaks that fall mid-phrase or mid-thought when the audio has a
  natural pause elsewhere
- Captions that combine end-of-one-thought + start-of-another (should split)

DO NOT CHANGE:
- The actual words spoken (no rewriting, only adjusting where breaks fall)
- Italic markers
- The overall sequence of captions (don't reorder)
- Captions that already work well

OUTPUT FORMAT:
Return a JSON array of changes only. Don't repeat unchanged captions.
For each change, specify:
- caption_index: the 1-based index from the input
- new_text: the suggested replacement (or null if just timing change)
- change_type: "phrase_break" | "name_kept_together" | "timing_only" | "split" | "merge"
- reason: 1-sentence explanation
- merge_with_next: true if this caption should be combined with the next
- split_after_word: word index where to split if change_type is "split"

INPUT CAPTIONS:
[...captions JSON...]
```

### Example response

```json
[
  {
    "caption_index": 12,
    "new_text": "however that left the energy minister speechless:",
    "change_type": "name_kept_together",
    "reason": "LIAM was orphaned at end of caption 12 — moved to start of 13",
    "merge_with_next": false
  },
  {
    "caption_index": 13,
    "new_text": "LIAM BARTLETT: At what point during this crisis",
    "change_type": "name_kept_together",
    "reason": "Receives 'LIAM' from previous caption"
  }
]
```

---

## 11. Italic preservation through pipeline

This is the trickiest correctness issue. The flow:

1. Stage 1 marks each caption italic/plain based on transcript bold formatting
2. Stage 2 ships captions to Gemini WITH italic flags in the input JSON
3. Gemini suggests text changes but italic flags stay associated with the caption index
4. WhisperX returns timing for the new text
5. Final SRT generation uses italic flags from Stage 1, text from Stage 2 (if accepted), timing from WhisperX

**Edge case to handle:** If Gemini splits one caption into two (`change_type: "split"`), both resulting captions inherit the original's italic flag. If Gemini merges two captions and they had different italic flags, prefer the first caption's flag and warn in the UI.

---

## 12. Implementation phases

### Phase 1: WhisperX server (start here)

- Stand up FastAPI server on Windows machine
- Implement `/align` endpoint
- Test locally with curl + sample MP3 + sample captions
- Configure Cloudflare Tunnel
- Verify public URL is reachable from outside the network

**Deliverable:** A `curl https://whisperx-abc.example.com/align` call returns word-level timestamps for sample input.

### Phase 2: Render proxy extension

- Add `/api/refine` endpoint to existing `server.js`
- Implement Gemini call with prompt template
- Implement WhisperX call
- Add merge logic
- Test with mock browser request

**Deliverable:** `POST /api/refine` with audio + captions returns merged result.

### Phase 3: Browser tool Stage 2 UI

- Add Stage 2 section that appears after Stage 1 completes
- Audio drop zone + state management
- Loading states with progress messages
- Diff view rendering
- Accept/reject checkboxes
- Final download merge logic

**Deliverable:** End-to-end flow works in browser.

### Phase 4: Polish

- Error states (server unreachable, Gemini fails, etc.)
- Italic preservation testing
- Save UI preferences (e.g. default accept-all toggle)
- Performance: chunk large audio if needed
- Documentation update — extend the existing `ABC_Caption_Formatter_v2_DOCUMENTATION.md`

---

## 13. Testing strategy

### Test files

Use the existing test pair already in conversation history:
- `MW_Epxx_-_Seg_Name_v1_2024_1_mp4.srt` (cobalt/Spotlight episode)
- `Untitled document.docx` (transcript)
- Need to add: matching MP3 export

### Test cases

1. **No changes needed:** Captions already perfect. Gemini should return empty array.
2. **Name split:** Cap 112/113 LIAM/BARTLETT split. Gemini should suggest merge.
3. **Phrase break:** A caption that ends mid-prepositional-phrase. Gemini should suggest different break point.
4. **Italic preservation:** Caption is italic in Stage 1. After Stage 2 changes text, must still be italic in output.
5. **Timing accuracy:** Sample a known caption, manually verify Stage 2 timing matches actual audio within ±100ms.
6. **WhisperX unreachable:** Stop the local server. Stage 2 should gracefully degrade — return Gemini text with original timing + warning.
7. **Audio too large:** Test 50MB+ file. Should either chunk or return clear error.

---

## 14. Known risks and mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| WhisperX timing slightly off (±50ms) | Medium | Acceptable — Premiere has frame-level precision anyway, user can nudge |
| Gemini hallucinates word changes | Medium | Prompt explicitly forbids changing actual words; UI shows diff for review |
| Home machine offline when needed | Medium | Graceful degradation — Stage 2 falls back to Gemini-only mode with original timing |
| Cloudflare Tunnel auth needed | Low | If we want to lock down the WhisperX URL, use Cloudflare Access policies |
| Audio file >20MB inline limit for Gemini | High | Use Gemini Files API for large uploads; documented in their SDK |
| Italic flag lost on split/merge | Medium | Explicit handling in merge logic, test cases above |
| User accepts wrong suggestion by accident | Low | Reject button on each suggestion + final preview before download |

---

## 15. Out of scope

- **Replacing Stage 1.** Stage 2 always builds on Stage 1's output.
- **Multi-language support.** WhisperX supports it but we'd need to thread language through the UI. Not now.
- **Real-time / live captioning.** This is a post-production tool only.
- **Caption translation.** Different problem entirely.
- **Speaker diarisation.** Already provided by transcript.
- **Subtitle styling beyond italic.** No bold, no colour, no positioning.

---

## 16. Open questions

1. **Audio format support.** MP3 is primary but should we also accept WAV/M4A? WhisperX accepts both. Check what Premiere exports easily.
2. **Caption count limit.** Is there an upper bound where Gemini's context window becomes a concern? Test with longest typical episode (probably 200-300 captions).
3. **Authentication for Cloudflare Tunnel.** Should the WhisperX endpoint be locked down with Cloudflare Access in addition to the X-Secret header? Probably yes for production, can defer for testing.
4. **WhisperX model size.** `large-v3` is most accurate but slowest. `medium` is a reasonable default for English-only. User-configurable?
5. **Persistence of accept/reject decisions.** If the user closes the tool mid-review, do we save state? Probably not — too much complexity for marginal value.
6. **Bulk accept based on change_type.** Should there be a "Accept all phrase_break suggestions but not timing_only" filter? Consider for Phase 4 polish.
