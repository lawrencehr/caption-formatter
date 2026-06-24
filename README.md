# Caption Formatter

A caption-refinement tool for short-form, broadcast-news social media videos. It turns a raw Premiere Pro subtitle export into clean, broadcast-style captions — correctly italicised, sensibly line-broken, and (optionally) re-timed to the audio at millisecond accuracy.

The project is built in two stages so the everyday workflow needs **no backend at all**:

- **Stage 1 — Format (browser-only).** Open one HTML file in a browser. It reformats a raw Premiere `.srt` export and uses a Google Doc transcript (`.docx`) to detect which segments should be italic. No server, no build step, no internet required.
- **Stage 2 — AI refine (optional backend).** A language model proposes better phrase breaks, then a forced-alignment model (WhisperX) re-aligns the refined text to the audio to produce accurate millisecond timestamps. Stage 2 degrades gracefully: if the alignment server is unreachable, you still get the text improvements with the original timing.

---

## Why it's interesting

- **Zero-dependency core.** Stage 1 is a single self-contained HTML file (mammoth.js is bundled inline) — it runs by double-clicking, which matters for a non-technical editing workflow.
- **Constraint-driven formatting.** Captions must obey hard broadcast rules: ≤30 characters per line (Premiere force-wraps at 30 and silently hides overflow), a speaker name-tag alone on its own line, a minimum on-screen duration, and no overlapping cues. These are enforced end-to-end.
- **The model is kept on a tight leash.** The LLM is only allowed to *move caption boundaries* — never to change a single word. A server-side chain validator drops any suggestion that loses or duplicates words, crosses an italic boundary, or breaks the 30-character line rule.
- **Two-phase pipeline with a real fallback path,** plus keep-alive handling to survive a serverless host's idle timeout during long model calls.

---

## Architecture

```
Browser (single-file HTML/JS frontend)
  │  Stage 1 runs entirely here (format + italic detection)
  │
  │  Stage 2: multipart upload (audio + captions JSON + auth header)
  ▼
Node/Express proxy  (backend/)
  ├─ POST /api/refine   — main 2-phase pipeline
  │     ├─ Phase 1: LLM analyses captions → JSON array of boundary suggestions
  │     └─ Phase 2: forced-alignment → millisecond timestamps
  │
  └─► WhisperX server  (whisperx-server/, Python/FastAPI)
        ├─ POST /transcribe  — full-audio ASR + alignment → word list
        └─ POST /align       — force-align captions to an audio segment
```

The proxy keeps all API keys server-side; the browser only ever holds a shared auth secret it sends with each request. A Cloudflare Tunnel can expose a locally-running WhisperX instance to the hosted proxy.

---

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | Vanilla HTML/CSS/JS, single file, no build step. `mammoth.js` (bundled) for `.docx` parsing |
| Backend proxy | Node.js, Express |
| Forced alignment / ASR | Python, FastAPI, WhisperX (wav2vec2) |
| Hosting (reference) | Serverless host for the proxy + Cloudflare Tunnel for the GPU/CPU alignment box |

---

## Repository layout

```
frontend/
  caption_formatter.html              Entire frontend (~7,600 lines): Stage 1 + Stage 2 UI
  caption_formatter_DOCUMENTATION.md  End-user guide
backend/
  server.js                           Express proxy (single file)
  lib/gemini.js                       Phase-1 prompt builder + suggestion validators
  lib/merge.js                        Applies accepted suggestions, resolves overlaps/min-duration
  lib/matcher.js                      Sequence matcher: maps captions to transcript words
whisperx-server/
  server.py                           FastAPI app: /transcribe and /align
test_system/
  gemini_eval/                        Offline eval harness for the Phase-1 prompt
  test_matcher.js                     Unit tests for the sequence matcher
```

---

## Getting started

### Stage 1 (no setup)

Open `frontend/caption_formatter.html` in a browser. Drop in a Premiere `.srt` export and the matching `.docx` transcript, then export reformatted captions.

### Stage 2 (optional — adds AI refine + re-timing)

**Backend proxy**

```bash
cd backend
npm install
# set the environment variables below, then:
npm start            # listens on :3000
```

| Variable | Description |
|---|---|
| `SHARED_SECRET` | Auth token — must match the WhisperX server and the frontend config |
| `GEMINI_API_KEY` | Generative model API key (Phase 1 suggestions) |
| `ANTHROPIC_API_KEY` | Optional — used by the `/api/review` endpoint only |
| `WHISPERX_URL` | URL of the WhisperX server (e.g. `http://localhost:8765`) |
| `PORT` | Optional, defaults to `3000` |

**WhisperX alignment server** (Windows; run from the project root)

```bash
cd whisperx-server
copy .env.example .env     # then set SHARED_SECRET to match the proxy
start.bat                  # creates a venv, installs deps, starts on :8765
```

First startup downloads the wav2vec2 alignment model (~370 MB).

The frontend stores the proxy URL and shared secret in `localStorage` via a config modal in the UI — there is no checked-in config file.

---

## Tests

```bash
node test_system/test_matcher.js                 # sequence-matcher unit tests
node test_system/gemini_eval/_test_validator.js  # suggestion-validator unit tests
```

---

## Notes

This started as a real production tool and has been generalised for public viewing. It is provided as a portfolio sample; there is no license attached.
