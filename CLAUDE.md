# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

ABC Caption Formatter v3 — a 3-component caption refinement tool for ABC Media Watch social media videos. Stage 1 (browser-only) formats raw Premiere SRT exports using a Google Doc transcript for italic detection. Stage 2 (requires backend) uses Gemini to suggest better phrase breaks, then WhisperX to force-align the refined text to audio for accurate millisecond timestamps.

## Components and how to run them

**Frontend** — no build step. Open `frontend/ABC_Caption_Formatter_v3.html` directly in a browser. Stage 1 runs entirely in-browser. Stage 2 requires the backend to be running and reachable.

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

Health check: `curl http://localhost:8765/health` → `{"status":"ok","service":"whisperx-alignment"}`

**Cloudflare Tunnel** (exposes local WhisperX to Render):
```
cloudflared tunnel run whisperx-abc
```

**End-to-end test** (Phase 2 only — skips Gemini, hits WhisperX directly):
```
cd test_system
node tester.js
```
Configure `PROXY_URL`, `WHISPERX_URL`, `SHARED_SECRET`, and file paths at the top of `tester.js`. Output saved to `test_output.json`.

## Required environment variables (backend)

| Variable | Description |
|---|---|
| `SHARED_SECRET` | Auth token — must match `whisperx-server/.env` and `frontend/config.js` |
| `GEMINI_API_KEY` | Google Gemini API key |
| `ANTHROPIC_API_KEY` | Anthropic Claude API key (used by `/api/review` only) |
| `WHISPERX_URL` | Public Cloudflare Tunnel URL, e.g. `https://whisperx-abc.trycloudflare.com` |
| `PORT` | Optional, defaults to 3000 |

For local dev, set `WHISPERX_URL=http://localhost:8765`.

## Architecture

```
Browser (HTML/JS)
  │  multipart upload (audio + captions JSON + X-Secret)
  ▼
Render Proxy  backend/server.js
  ├─► Gemini Flash API  (Phase 1: caption text suggestions)
  └─► WhisperX via Cloudflare Tunnel  (Phase 2: word-level forced alignment)
         │
         └─ whisperx-server/server.py  (FastAPI, runs on local Windows machine)
```

**Stage 2 two-phase flow:**
- Phase 1 (`POST /api/refine` without `accepted_suggestions`): Gemini analyses audio + captions, returns JSON array of suggested boundary changes. Browser shows diff view.
- Phase 2 (`POST /api/refine` with `accepted_suggestions`): WhisperX force-aligns accepted suggestion text to audio, returns millisecond timestamps. Browser shows final preview.

**Gemini model fallback:** tries `gemini-3-flash-preview` → `gemini-2.5-flash` → `gemini-2.0-flash` in order, retrying on `UNAVAILABLE` or `RESOURCE_EXHAUSTED`.

**Keep-alive:** backend writes space bytes every 10s during long API calls to prevent Render's 100s idle timeout from cutting the connection.

## Key constraints

- **Italic flags always come from Stage 1.** They are derived from bold text in the DOCX via `deriveItalic()` / `shouldBeItalic()` in the frontend. For unchanged captions in Stage 2, `origResult.italic` is used directly; for changed captions, `deriveItalic()` re-derives from `boldSegments`. Never set italic based on Gemini output.
- **Gemini must not change words** — the prompt strictly forbids it. It only moves caption boundaries.
- **Max audio upload:** 100MB. Max JSON payload: 25MB. Pipeline timeout: 120s.
- **Minimum caption duration:** 300ms (enforced post-WhisperX). Premiere Pro requires ≥6 frames (~240ms at 25fps) to import.
- **Frontend config is gitignored.** `frontend/config.js` holds `API_BASE_URL` and `API_SECRET` and is never committed. `frontend/config.example.js` is the template.
- **WhisperX degrades gracefully.** If unreachable, Stage 2 still returns Gemini text improvements with original Stage 1 timing and a user-facing warning.

## File layout (non-obvious parts)

- `frontend/ABC_Caption_Formatter_v3.html` — entire frontend (~1,800 lines). Stage 1 logic: `processCaptions()`, `deriveItalic()`, `shouldBeItalic()`, `splitLines()`. Stage 2 logic: `refineWithAI()` (Phase 1), `downloadRefinedSRT()` (Phase 2), `mapApiCaption()`.
- `backend/server.js` — single Express file (~650 lines). Gemini prompt is inline (~160 lines). Deduplication and gap/overlap resolution run post-WhisperX.
- `whisperx-server/server.py` — FastAPI app. Model and device configured at lines 152-153 (`large-v3` / `cpu`). Change to `medium` for faster processing.
