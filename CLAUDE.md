# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Caption Formatter v3 "Sunrise" — a caption refinement tool for broadcast news social media videos. Stage 1 (browser-only) formats raw Premiere SRT exports using a Google Doc transcript for italic detection. Stage 2 (requires backend) uses Gemini to suggest better phrase breaks, then WhisperX to force-align the refined text to audio for accurate millisecond timestamps.

## Components and how to run them

**Frontend** — no build step. Open `frontend/caption_formatter.html` directly in a browser. Stage 1 runs entirely in-browser. Stage 2 requires the backend to be running and reachable. Backend config (API URL + Shared Secret) is stored in `localStorage` via a config modal in the UI — not in a file.

**Backend proxy** (Node.js/Express, port 3000):
```
cd backend
npm install
# Set env vars (see below), then:
npm start
```

**WhisperX server** (Python/FastAPI, port 8765) — Windows only, run from project root:
```
cd whisperx-server
copy .env.example .env   # then edit .env with your SHARED_SECRET
start.bat                # creates venv, installs deps, starts on :8765
```
First startup downloads the wav2vec2 alignment model (~370MB). Torch/torchaudio are installed separately in `start.bat` (CPU-only build) to avoid the 2GB CUDA download.

Health check: `curl http://localhost:8765/health` → `{"status":"ok","service":"whisperx-alignment","device":"cpu","asr_loaded":true}`

**Cloudflare Tunnel** (exposes local WhisperX to Render):
```
cloudflared tunnel run whisperx-captions
```

**End-to-end test** (Phase 2 only — skips Gemini, hits WhisperX directly):
```
cd test_system
node tester.js
```
Configure `PROXY_URL`, `WHISPERX_URL`, `SHARED_SECRET`, and file paths at the top of `tester.js`. Output saved to `test_output.json`.

**Gemini Phase-1 eval harness** (Stage 1 + Gemini suggestions, no browser/backend/WhisperX):
```
cd test_system/gemini_eval
npm install                # first time only
set GEMINI_API_KEY=AIza...
node run_eval.js           # all episodes in "Test files/" × 2 runs
node evaluate.js           # score against standards → results/report.md
```
Uses `backend/lib/gemini.js` (shared with `server.js`) for the exact production prompt, and `stage1.js` (Node port of the frontend Stage 1 — keep in sync if the frontend changes).

## Required environment variables (backend)

| Variable | Description |
|---|---|
| `SHARED_SECRET` | Auth token — must match `whisperx-server/.env` and the frontend config modal |
| `GEMINI_API_KEY` | Google Gemini API key |
| `ANTHROPIC_API_KEY` | Anthropic Claude API key (used by `/api/review` only) |
| `WHISPERX_URL` | Public Cloudflare Tunnel URL, e.g. `https://whisperx-captions.trycloudflare.com` |
| `PORT` | Optional, defaults to 3000 |
| `WHISPER_MODEL` | WhisperX model name, e.g. `medium` or `large-v3` (set in `whisperx-server/.env`) |

For local dev, set `WHISPERX_URL=http://localhost:8765`.

## Architecture

```
Browser (HTML/JS, ~7,600 lines)
  │  multipart upload (audio + captions JSON + X-Secret)
  ▼
Render Proxy  backend/server.js
  ├─► POST /api/review       — proxies to Anthropic Claude API
  ├─► POST /api/audio-check  — proxies to Gemini Flash for transcript verification
  └─► POST /api/refine       — main Stage 2 pipeline (2-phase)
      ├─ Phase 1: Gemini analyses audio + captions → JSON array of suggestions
      └─ Phase 2: WhisperX force-aligns accepted text → millisecond timestamps
               │
               └─ whisperx-server/server.py  (FastAPI, runs on local Windows machine)
                  ├─ POST /transcribe  — full audio ASR + alignment → flat word list
                  └─ POST /align       — force-align captions to audio segment
```

**Stage 2 two-phase flow:**
- Phase 1 (`POST /api/refine` without `accepted_suggestions`): Gemini analyses captions (text only — audio is uploaded but NOT sent to Gemini; A/B testing showed it changes output no more than run-to-run variance), returns JSON array of suggested boundary changes. The prompt is LINE-LEVEL: Gemini writes `new_text` as 1–2 explicit `\n`-separated lines of ≤30 chars (name tag alone on line 1) — A/B tested: flat 60-char texts rendered a >30 line ~10% of the time, line-level 0%. Suggestions pass through the oversize filter then chain validation (`validateSuggestionChains` — drops chains that lose/duplicate words, cross italic boundaries, have dangling links, or break the strict 30-char line rule; Premiere force-wraps at 30 so overflow is silently hidden). Browser shows diff view; `mapApiCaption` uses Gemini's line breaks verbatim (`splitLines` only for flat text).
- Phase 2 (`POST /api/refine` with `accepted_suggestions`): Backend applies accepted suggestions, then calls WhisperX `/transcribe` (single call for full audio), uses `matcher.js` to map captions to transcript words, and returns millisecond timestamps. Browser shows Align Preview.

**Gemini model fallback:** tries `gemini-3.5-flash` → `gemini-3-flash-preview` → `gemini-2.5-flash` → `gemini-2.0-flash` in order, retrying on `UNAVAILABLE` or `RESOURCE_EXHAUSTED`.

**Keep-alive:** backend writes space bytes every 10s during long API calls to prevent Render's 100s idle timeout from cutting the connection.

## Frontend UI structure (Sunrise redesign)

The frontend (`frontend/caption_formatter.html`, ~7,600 lines) uses a "Broadcast Console" shell with a tab bar. CSS phases correspond to UI phases:

- **Phase A** — Shell wrapper: sidebar + tab row (`.a-shell`, `.a-tab-row`, `.a-tab`)
- **Phase B** — Review tab: caption list with timing/style inspection
- **Phase C** — AI Suggestions tab: diff view with per-caption accept/reject checkboxes, linked suggestion handling
- **Phase D** — Align Preview tab: word-level timing visualisation, drift metrics
- **Phase E** — Export tab: SRT download with format options

Stage 1 (format) and Stage 2 (AI refine) logic panels are wrapped inside the Phase A shell. The config modal stores `API_BASE_URL` and `API_SECRET` in `localStorage` — there is no `config.js` file.

## Key constraints

- **Italic flags always come from Stage 1.** They are derived from bold text in the DOCX via `deriveItalic()` / `shouldBeItalic()` in the frontend. For unchanged captions in Stage 2, `origResult.italic` is used directly; for changed captions, the Stage-1 flag carried through the API (`c.italic`) is used — safe because server-side chain validation forbids text crossing italic boundaries — with `deriveItalic()` only as fallback. Never set italic based on Gemini output.
- **Gemini must not change words** — the prompt strictly forbids it. It only moves caption boundaries.
- **Max audio upload:** 100MB. Max JSON payload: 25MB. Pipeline timeout: 120s.
- **Minimum caption duration:** 300ms (enforced post-WhisperX). Premiere Pro requires ≥6 frames (~240ms at 25fps) to import.
- **Frontend config lives in localStorage.** The config modal in the UI stores `API_BASE_URL` and `API_SECRET`. There is no `config.js` or `config.example.js` in use.
- **WhisperX degrades gracefully.** If unreachable, Stage 2 still returns Gemini text improvements with original Stage 1 timing and a user-facing warning.
- **Overlap resolution:** The overlap guard only trims `end_ms`, never moves `start_ms`. Gap-filler logic was removed (it was causing 33% start_delta failures).

## File layout (non-obvious parts)

- `frontend/caption_formatter.html` — entire frontend (~7,600 lines). CSS Phase A–E at top (~2,800 lines). Stage 1 logic: `processCaptions()`, `deriveItalic()`, `shouldBeItalic()`, `splitLines()`. Stage 2 logic: `refineWithAI()` (Phase 1 call), `downloadRefinedSRT()` (Phase 2 call), `mapApiCaption()`, `renderDiffView()`, `aiIsSeparate()` / `aiBuildLinkGroups()` (linked suggestion handling), `aiWordDiff()`.
- `backend/server.js` — single Express file (~828 lines). Gemini prompt is inline (~160 lines, forbids text rewriting, defines suggestion JSON schema). Per-model `generationConfig` (v3.x uses `thinkingLevel: 'low'`, v2.x uses `temperature: 0.1`).
- `backend/lib/gemini.js` — shared Gemini Phase 1 logic: prompt builder (line-level default; `{lineLevel: false}` reproduces the legacy flat prompt), per-model `generationConfig` (thinkingLevel `medium`, A/B verified), response parse/salvage, oversized-suggestion filter (per-line for multiline texts), `validateSuggestionChains` (chain-level text-conservation / italic-boundary / strict-30 line guard, normalises self-links). Used by `server.js` and the eval harness; unit tests in `test_system/gemini_eval/_test_validator.js`.
- `backend/lib/merge.js` — Phase 2 caption merge (`mergeCaptionSuggestions`): applies accepted suggestions, dedup rescue, split expansion, min-duration + overlap + gap resolution. Shared with the eval harness.
- `test_system/gemini_eval/` — offline eval harness: `stage1.js` (Node port of frontend Stage 1), `run_eval.js` (Gemini runner, `--thinking`/`--audio` A/B flags), `evaluate.js` (standards checker → `results/report.md`), `final_pass.js` (replays runs through merge + frontend mapping to catch errors introduced downstream). Note: `Test files/ep12/ep12_subtitles.srt` is mislabelled (contains ep11 captions).
- `backend/lib/matcher.js` — sequence matching engine (~188 lines). `normaliseCaption()` expands currency/years/numbers to words; `matchCaptionsToTranscript()` uses forward greedy cursor with SEARCH_AHEAD=40, SLACK=8, MIN_RATIO=0.6.
- `whisperx-server/server.py` — FastAPI app (~351 lines). Model loaded at startup via lifespan context manager. CUDA auto-detected; falls back to CPU. `WHISPER_MODEL` env var controls which ASR model loads (default: `medium`).
- `test_system/tester.js` — E2E test runner; configure file paths and URLs at the top.
- `test_system/analyze.js` — quality analysis: duration distribution, match ratio, start_delta, sequential integrity.
- `test_system/test_matcher.js` — 22+ unit tests for `matcher.js`.
- `caption_formatter_v2.html` — legacy reference, not in use.

## Additional documentation

- `DEPLOYMENT_GUIDE.md` — 5-step quick-start for deploying to Render + Cloudflare
- `PROJECT_SUMMARY.md` — high-level overview with deployment checklist
- `IMPLEMENTATION_NOTES.md` — technical reference for developers
- `backend/README.md` — API endpoint documentation
- `whisperx-server/README.md` — WhisperX setup + Cloudflare Tunnel instructions
