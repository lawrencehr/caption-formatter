# ABC Caption Formatter v3 — Implementation Notes

**Status:** Stage 2 implementation complete. Ready for deployment and testing.

**Last Updated:** April 29, 2026

---

## What's New in v3

Stage 2 adds AI-powered caption refinement:
1. **Gemini 1.5 Flash** analyzes audio + captions to suggest better line breaks and phrase grouping
2. **WhisperX** force-aligns the suggested text with audio for accurate word-level timing
3. **Browser diff view** lets users review and selectively accept improvements
4. **Italic preservation** is guaranteed through the entire pipeline

---

## Deployment Checklist

### Step 1: Deploy WhisperX Server (One-time on home machine)

```bash
cd whisperx-server

# Copy .env.example to .env
cp .env.example .env

# Edit .env and set SHARED_SECRET (matching backend)
# e.g., SHARED_SECRET=abc-captions-2024-dev

# Install Python 3.10+, then run:
pip install -r requirements.txt

# Option A: Run immediately
python server.py
# or double-click start.bat on Windows

# Option B: Set up as Windows Service (auto-start)
# Follow instructions in README.md Cloudflare section
```

### Step 2: Set up Cloudflare Tunnel

Follow `whisperx-server/README.md` for full instructions. TL;DR:

```bash
winget install --id Cloudflare.cloudflared
cloudflared tunnel login
cloudflared tunnel create whisperx-abc
# Edit ~/.cloudflared/config.yml with tunnel details
cloudflared service install  # Auto-start on reboot
```

Save the public URL (e.g., `https://whisperx-abc.example.com`).

### Step 3: Deploy Backend Proxy

Push to Render:

```bash
cd backend
git push render main  # or your deployment method
```

Set environment variables on Render:
```
SHARED_SECRET=abc-captions-2024-dev  # Must match WhisperX .env
ANTHROPIC_API_KEY=sk-...
GEMINI_API_KEY=...
WHISPERX_URL=https://whisperx-abc.example.com  # From Cloudflare Tunnel
```

### Step 4: Update Frontend Configuration

Edit `frontend/ABC_Caption_Formatter_v3.html` lines 316-317:

```javascript
const API_BASE_URL = 'https://<your-render-service>.onrender.com';
const API_SECRET = 'abc-captions-2024-dev';  // Must match SHARED_SECRET
```

Then serve the HTML file (you can open it locally or host on a CDN).

---

## Architecture Summary

```
User's Browser (HTML tool v3)
       ↓ Stage 1: SRT + .docx → Formatted SRT (unchanged)
       ↓ Stage 2: MP3 + SRT → Refine + Download
       │
       ├→ POST /api/refine ────→ Render Proxy
       │                           ├→ Gemini 1.5 Flash (audio analysis)
       │                           └→ WhisperX via Cloudflare Tunnel (timing)
       ↓
    Refined SRT with accurate timing ✓
```

---

## Key Features

### Italic Preservation (Critical!)

- Italic flags **always come from Stage 1** (the Google Doc transcript)
- Stage 2 can change caption **text** and **timing**, but **never** italic status
- On split/merge: both resulting captions inherit the original's italic flag
- Final SRT wraps italic captions in `<i>...</i>` tags as always

### Error Handling

| Scenario | Behavior |
|----------|----------|
| WhisperX unreachable | Return Gemini suggestions with original timing + warning |
| Gemini fails | Return original captions unchanged, display error to user |
| Audio >100MB | Reject with error message |
| Timeout (>120s) | Return partial result or error |

### Graceful Degradation

If WhisperX server is down, Stage 2 still works:
- Gemini suggests better text
- Browser shows suggestions with original timing
- User can still download improved captions
- Warning displayed: "Timing not optimized (WhisperX unavailable)"

---

## Testing

### Manual Test (End-to-End)

1. Open `frontend/ABC_Caption_Formatter_v3.html` in browser
2. Upload SRT + .docx transcript (Stage 1 — unchanged)
3. Click "Format captions"
4. After Stage 1 completes, Stage 2 section appears
5. Drop MP3 audio file
6. Click "Refine captions"
7. Wait ~20-40 seconds (Gemini + WhisperX)
8. Review diff view:
   - Check suggested changes
   - Accept/reject per caption
9. Click "Download refined SRT"
10. Verify in Premiere:
    - Timing is accurate (within ±100ms of audio)
    - Italic formatting preserved
    - Text matches suggestions you accepted

### Critical Test Cases

1. **No changes:** Gemini returns [] → diff view is empty → download uses original captions
2. **Italic preservation:** Caption marked italic in Stage 1 → Stage 2 changes text → download still has `<i>` tags
3. **Timing accuracy:** Compare a caption's timing against actual audio → must be within ±100ms
4. **WhisperX failure:** Stop WhisperX server, run Stage 2 → should show captions with original timing + warning
5. **Audio >20MB:** Test with large file → should use Gemini Files API
6. **Name split detection:** Cap 112 has "LIAM", cap 113 has "BARTLETT:" → Gemini suggests merge
7. **Phrase break detection:** Caption ends mid-phrase → Gemini suggests different break point

---

## Configuration

### Browser Tool (`ABC_Caption_Formatter_v3.html`)

Lines 316-317: Set API endpoints
```javascript
const API_BASE_URL = 'https://<service>.onrender.com';
const API_SECRET = '<shared-secret>';
```

### Backend Proxy (`backend/server.js`)

Environment variables:
- `SHARED_SECRET` — Auth token (must match WhisperX .env)
- `ANTHROPIC_API_KEY` — Claude API key (for /api/review)
- `GEMINI_API_KEY` — Gemini API key
- `WHISPERX_URL` — Cloudflare Tunnel public URL

### WhisperX Server (`whisperx-server/server.py`)

Edit `server.py` line 152-153 for tuning:
```python
cmd = [
    "whisperx",
    tmp_audio_path,
    "--model", "large-v3",  # Change to "medium" for faster processing
    "--device", "cuda",     # Change to "cpu" to force CPU-only
    ...
]
```

---

## Troubleshooting

### "WhisperX unreachable" Error

**Check:**
1. WhisperX server running locally? → `curl http://localhost:8765/health`
2. Cloudflare Tunnel active? → `cloudflared tunnel list`
3. `WHISPERX_URL` env var correct? → Check Render dashboard
4. `SHARED_SECRET` matches? → Must match both servers

**Fix:**
```bash
# Restart Cloudflare Tunnel
net stop cloudflared
net start cloudflared

# Or restart WhisperX
# Close start.bat and re-run it
```

### "Gemini API error"

**Check:**
1. `GEMINI_API_KEY` set on Render? → Check env vars
2. Key is valid and has quota? → Test with `curl` to Gemini API
3. Audio file valid MP3/WAV/M4A? → Use Premiere's "Export Media" at 128kbps

### "Invalid X-Secret"

**Check:**
1. Browser tool sets `API_SECRET` correctly? → See Configuration section
2. Does it match `SHARED_SECRET` on Render? → Check both env vars
3. Typo? → Copy-paste from Render to HTML tool

### Timing is inaccurate (>±100ms off)

This is expected within ±100ms range. WhisperX timing depends on:
- Audio quality (Premiere's 128kbps export is fine)
- Caption text accuracy (must match audio exactly)
- Gemini's phrase break suggestions (must be natural speech pauses)

If timing is way off (>500ms), check:
- Audio file is not corrupted or silent sections
- Captions match the audio content
- WhisperX server didn't timeout

---

## File Structure

```
abc-captions/
├── frontend/
│   ├── ABC_Caption_Formatter_v3.html     (Main tool, includes Stage 2)
│   └── ABC_Caption_Formatter_v3_DOCUMENTATION.md
├── backend/
│   ├── server.js                         (Express proxy with /api/refine)
│   ├── package.json                      (Include express-fileupload)
│   ├── temp/                             (Auto-created for uploads)
│   └── README.md                         (Deployment guide)
├── whisperx-server/
│   ├── server.py                         (FastAPI /align endpoint)
│   ├── requirements.txt
│   ├── start.bat                         (Windows launcher)
│   ├── .env.example
│   ├── .env                              (Create from .example)
│   ├── venv/                             (Auto-created virtualenv)
│   └── README.md                         (Setup + Cloudflare guide)
├── STAGE_2_DESIGN.md                     (Original design document)
└── IMPLEMENTATION_NOTES.md               (This file)
```

---

## Performance

- **Gemini call:** 10-30 seconds (depends on caption count + audio length)
- **WhisperX call:** 5-15 seconds (depends on audio length; faster with GPU)
- **Total pipeline:** 20-50 seconds typical
- **Max timeout:** 120 seconds

To speed up:
- Use WhisperX GPU (NVIDIA CUDA 12.x)
- Switch WhisperX model to "medium" (slightly less accurate but ~2x faster)
- Shorter videos/fewer captions process faster

---

## Maintenance

### Monitoring

Check logs:
- **Render:** Dashboard → Logs
- **WhisperX:** Console where you ran `start.bat`
- **Browser:** DevTools → Network tab (check /api/refine requests)

### Updates

```bash
# Update WhisperX dependencies
cd whisperx-server
venv\Scripts\activate.bat
pip install --upgrade -r requirements.txt

# Update backend dependencies
cd backend
npm update

# Update frontend HTML tool
# Just re-serve the updated ABC_Caption_Formatter_v3.html
```

### Downtime

WhisperX server going offline doesn't break the tool:
- Stage 2 still works with Gemini-only mode
- Timing won't be optimized (uses Stage 1 timing)
- User sees warning, can still download

Render proxy going offline:
- Stage 1 still works completely (runs in-browser)
- Stage 2 unavailable
- User can use tool for Stage 1 formatting only

---

## Future Enhancements (Nice-to-Have)

- [ ] Support WAV/M4A in addition to MP3
- [ ] User-configurable WhisperX model (medium vs large-v3)
- [ ] Bulk accept filters by change type
- [ ] Cloudflare Access authentication for WhisperX
- [ ] Multi-language support (thread language through UI)
- [ ] Performance metrics in diff view (timing accuracy ±Xms)
- [ ] Undo/redo in diff view
- [ ] Compare with previous Stage 2 runs

---

## Known Limitations

- **Single language:** English only (WhisperX supports others; would need UI changes)
- **No real-time captioning:** Post-production tool only
- **No speaker diarization:** Relies on Google Doc transcript for speaker labels
- **No style enforcement:** Numbers, spelling, etc. still need human review
- **No timeline export:** Outputs SRT only (Premiere-compatible)

---

## Questions?

- **WhisperX setup:** See `whisperx-server/README.md`
- **Cloudflare Tunnel:** See `whisperx-server/README.md` "Cloudflare Tunnel Setup"
- **API endpoints:** See `backend/README.md`
- **Stage 2 design:** See `STAGE_2_DESIGN.md`
- **Original tool:** See `frontend/ABC_Caption_Formatter_v3_DOCUMENTATION.md`

---

## Deployment Readiness Checklist

- [ ] WhisperX server running locally (or on home machine)
- [ ] Cloudflare Tunnel configured and public URL noted
- [ ] Backend proxy deployed to Render with env vars set
- [ ] Frontend HTML updated with API_BASE_URL and API_SECRET
- [ ] All 7 critical test cases passing
- [ ] Italic formatting preserved in output SRTs
- [ ] Timing accuracy within ±100ms in sample video
- [ ] Error messages user-friendly (no raw JSON spilled)
- [ ] Documentation links working

---

**Ready to go! 🎉**
