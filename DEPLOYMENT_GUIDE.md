# Stage 2 Deployment Guide

## Overview

ABC Caption Formatter v3 adds AI-powered caption refinement via a 3-component system:

1. **WhisperX Server** (Python FastAPI) — Force-aligns audio to captions with word-level timing
2. **Render Proxy** (Node.js Express) — Orchestrates Gemini + WhisperX pipeline
3. **Frontend Tool** (HTML) — User interface with Stage 2 UI for accept/reject workflow

This guide assumes you already have:
- Render account (free tier works)
- Google Gemini API key (free tier available)
- Anthropic Claude API key (if using /api/review endpoint)
- A Windows home machine for WhisperX server
- Cloudflare account (free; for Tunnel)

---

## Quick Start (5 steps)

### 1. Start WhisperX Server (5 minutes)

**On your Windows home machine:**

```bash
cd abc-captions/whisperx-server

# Copy env template
copy .env.example .env

# Edit .env: set SHARED_SECRET=your-secret-here
# (You'll use this same secret everywhere)

# Launch server
start.bat

# Verify it's running:
curl http://localhost:8765/health
# Should see: {"status":"ok","service":"whisperx-alignment"}
```

**Keep this terminal open or set up as Windows Service (see README).**

### 2. Set up Cloudflare Tunnel (10 minutes)

**On the same Windows machine:**

```bash
# Install cloudflared
winget install --id Cloudflare.cloudflared

# Authenticate
cloudflared tunnel login
# (Opens browser, click "Authorize")

# Create tunnel
cloudflared tunnel create whisperx-abc

# Note the UUID shown, then edit ~/.cloudflared/config.yml:
tunnel: <paste-UUID-here>
credentials-file: C:\Users\<username>\.cloudflared\<UUID>.json
ingress:
  - service: http://localhost:8765

# Start tunnel
cloudflared tunnel run whisperx-abc

# Test it (in a new terminal):
curl https://<subdomain>.trycloudflare.com/health
# Should get the same JSON response
```

**Save the public URL** (e.g., `https://whisperx-abc.trycloudflare.com`) — you'll need it in step 4.

### 3. Deploy Backend to Render (15 minutes)

**In your Render dashboard:**

1. Create new "Web Service"
2. Connect your GitHub repo (abc-captions)
3. Set build command: `npm install`
4. Set start command: `npm start`
5. Set environment variables:
   ```
   SHARED_SECRET = your-secret-here
   ANTHROPIC_API_KEY = sk-...
   GEMINI_API_KEY = your-gemini-key
   WHISPERX_URL = https://whisperx-abc.trycloudflare.com
   ```
6. Click "Create Web Service"
7. Wait for deployment (~2 min)
8. Copy service URL: `https://<service>.onrender.com`

### 4. Update Frontend Config (2 minutes)

**In `frontend/ABC_Caption_Formatter_v3.html` lines 316-317:**

```javascript
const API_BASE_URL = 'https://<service>.onrender.com';  // From step 3
const API_SECRET = 'your-secret-here';                   // Must match step 1
```

### 5. Test End-to-End (10 minutes)

1. **Open** `frontend/ABC_Caption_Formatter_v3.html` in browser
2. **Upload** SRT + .docx (Stage 1 — this part is unchanged)
3. **Click** "Format captions"
4. **Upload** MP3 audio file
5. **Click** "Refine captions"
6. **Wait** 20-40 seconds
7. **Review** suggested changes
8. **Accept/reject** individual captions
9. **Download** refined SRT

✅ If this works, deployment is complete!

---

## Detailed Setup (With Troubleshooting)

### Component 1: WhisperX Server

**System Requirements:**
- Windows 10/11
- Python 3.10+
- 8GB RAM minimum, 16GB recommended
- Optional: NVIDIA GPU (CUDA 12.x) for 5x speedup

**Files:**
- `whisperx-server/server.py` — Main FastAPI app
- `whisperx-server/requirements.txt` — Python packages
- `whisperx-server/start.bat` — Launcher for Windows
- `whisperx-server/.env.example` → `.env` (copy and edit)
- `whisperx-server/README.md` — Detailed guide

**Setup:**

```bash
cd whisperx-server

# Copy env file
copy .env.example .env

# Edit with notepad:
notepad .env
# SHARED_SECRET=your-secret-12345
# PORT=8765

# Run (auto-creates venv if needed):
start.bat
```

**Verify:**
```bash
# In a new terminal:
curl http://localhost:8765/health
# Expect: {"status":"ok","service":"whisperx-alignment"}
```

**Troubleshooting:**
- "ModuleNotFoundError: No module named 'whisperx'"
  → Delete `venv` folder, re-run `start.bat`
- "Port 8765 already in use"
  → Edit `.env`, change PORT to 8766, restart
- WhisperX slow (30+ sec)
  → GPU not available; install CUDA 12.x for GPU acceleration

---

### Component 2: Cloudflare Tunnel

**Purpose:** Expose WhisperX (localhost:8765) to the internet securely.

**Setup:**

```bash
# Install
winget install --id Cloudflare.cloudflared

# Authenticate (opens browser)
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create whisperx-abc
# Output includes UUID and credentials file path
# Save the UUID!

# Configure (edit ~/.cloudflared/config.yml):
tunnel: [PASTE-UUID-HERE]
credentials-file: C:\Users\[USERNAME]\.cloudflared\[UUID].json
ingress:
  - service: http://localhost:8765

# Run tunnel
cloudflared tunnel run whisperx-abc

# In new terminal, test:
curl https://[SUBDOMAIN].trycloudflare.com/health
```

**Persist (auto-start on reboot):**

```bash
# Option A: Windows Service (recommended)
cloudflared service install
net start cloudflared

# Option B: Task Scheduler
# Create task → Trigger: "At startup" → Action: cloudflared tunnel run whisperx-abc
```

**Troubleshooting:**
- "Tunnel not found"
  → Run `cloudflared tunnel list`, copy correct UUID
- "PERMISSION DENIED"
  → Use Admin PowerShell
- Can't reach public URL
  → Check tunnel is running: `cloudflared tunnel list` (should show "ROUTE: active")

---

### Component 3: Backend Proxy (Render)

**Files:**
- `backend/server.js` — Express app with /api/refine endpoint
- `backend/package.json` — Dependencies (added express-fileupload)
- `backend/README.md` — API documentation

**Deployment to Render:**

1. Push code to GitHub:
   ```bash
   cd backend
   git add .
   git commit -m "Stage 2: add /api/refine endpoint"
   git push origin main
   ```

2. In Render dashboard:
   - Click "New +"
   - Select "Web Service"
   - Connect GitHub repo
   - Choose `backend/` as root directory (if monorepo)
   - Build: `npm install`
   - Start: `npm start`
   - Region: closest to you
   - Instance: Free tier (0.5 CPU, 512MB RAM) is fine

3. Set environment variables:
   ```
   SHARED_SECRET = your-secret-12345
   ANTHROPIC_API_KEY = sk-ant-...
   GEMINI_API_KEY = AIzaSy...
   WHISPERX_URL = https://whisperx-abc.trycloudflare.com
   ```

4. Render deploys (~2 min) and shows service URL

**Verify:**
```bash
curl https://[SERVICE].onrender.com/
# Expect: "ABC Caption Proxy — OK"
```

**Troubleshooting:**
- Service won't start
  → Check logs tab for error
  → Verify package.json has `"start": "node server.js"`
- "Cannot find module 'express-fileupload'"
  → `npm install` failed; check build logs
- 502 Bad Gateway
  → Server crashed; check logs, restart

---

### Component 4: Frontend HTML Tool

**Files:**
- `frontend/ABC_Caption_Formatter_v3.html` — Updated with Stage 2 UI
- `frontend/ABC_Caption_Formatter_v3_DOCUMENTATION.md` — User guide

**Configuration (REQUIRED):**

Edit lines 316-317:

```javascript
const API_BASE_URL = 'https://[SERVICE].onrender.com';  // Your Render URL
const API_SECRET = 'your-secret-12345';                  // Must match SHARED_SECRET
```

**Deployment Options:**

A) **Local file** (easiest for testing):
   - Open `frontend/ABC_Caption_Formatter_v3.html` in browser
   - Works immediately if Render + WhisperX are configured

B) **GitHub Pages** (host for free):
   ```bash
   # Push to gh-pages branch
   git subtree push --prefix frontend origin gh-pages
   ```

C) **CDN (Cloudflare, etc.)**:
   - Upload HTML file to CDN
   - CORS headers must allow Render proxy

**Verify:**
1. Open HTML in browser
2. Load SRT + .docx (Stage 1)
3. Format captions
4. Drop MP3 file in Stage 2 section
5. Click "Refine captions"
6. Wait 20-40 seconds, verify diff view appears

---

## Architecture Verification

Test each component independently:

### 1. WhisperX Server
```bash
curl -X POST http://localhost:8765/align \
  -H "X-Secret: your-secret-12345" \
  -H "Content-Type: application/json" \
  -d '{
    "audio_base64": "...",
    "captions": [{"index": 1, "text": "Hello world"}],
    "audio_format": "mp3",
    "language": "en"
  }'
```

### 2. Cloudflare Tunnel
```bash
curl https://[SUBDOMAIN].trycloudflare.com/health
```

### 3. Render Proxy (health)
```bash
curl https://[SERVICE].onrender.com/
```

### 4. Render Proxy (/api/refine)
```bash
curl -X POST https://[SERVICE].onrender.com/api/refine \
  -H "X-Secret: your-secret-12345" \
  -F "audio=@sample.mp3" \
  -F 'captions=[{"index":1,"text":"test","italic":false,"start_ms":0,"end_ms":1000}]'
```

### 5. End-to-End (Browser)
- Open HTML, run full workflow
- Check Network tab: all requests should succeed (200 status)

---

## Critical Secrets (must match everywhere)

| Component | Variable | Value |
|-----------|----------|-------|
| WhisperX | `.env` SHARED_SECRET | `your-secret-12345` |
| Render | SHARED_SECRET env var | `your-secret-12345` |
| Frontend | `const API_SECRET` | `your-secret-12345` |

⚠️ **They must all be identical!**

---

## Data Flow Diagram

```
User's Browser (HTML)
  │
  ├─ [Stage 1: SRT + .docx → Formatted SRT] (in-browser, unchanged)
  │
  └─ [Stage 2: MP3 + SRT → AI Refinement] (via API)
     │
     ├─ POST /api/refine ────→ Render Proxy
     │                           │
     │                           ├─ Call Gemini (suggest caption improvements)
     │                           │
     │                           ├─ Call WhisperX (force-align audio)
     │                           │
     │                           └─ Merge (Gemini text + WhisperX timing + Stage 1 italic)
     │
     ├─ Receive merged captions
     │
     ├─ User accepts/rejects suggestions
     │
     └─ Download final SRT with preserved formatting ✓
```

---

## Performance & Costs

**WhisperX Server (local):**
- Cost: $0 (runs on your machine)
- Speed: 30-60 sec per 5-min video (CPU), ~10 sec with GPU

**Cloudflare Tunnel:**
- Cost: $0 (free tier)
- Bandwidth: Unlimited
- Latency: ~50-100ms

**Render Proxy:**
- Cost: $0 (free tier, but limited to 750 hours/month)
- Upgrade: $12/month for production (pay-as-you-go)

**Gemini API:**
- Cost: ~$0.30-1.50 per caption (depends on caption count)
- Free tier: 60 requests/minute

**Anthropic API (if using /api/review):**
- Cost: ~$0.01-0.05 per request
- Pay-as-you-go

---

## Monitoring & Troubleshooting

### Check Logs

**WhisperX:**
- Watch the `start.bat` terminal
- Look for "Alignment request:", "WhisperX completed"

**Render:**
- Dashboard → Logs tab (real-time)
- Search for "error" or "refine"

**Browser:**
- DevTools → Network tab
- Filter for `/api/refine` requests
- Check status code (should be 200)

### Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| "WhisperX unreachable" | Tunnel not running | `cloudflared tunnel run whisperx-abc` |
| "Invalid X-Secret" | Mismatch between components | Verify all 3 have same value |
| Timing is off by >500ms | Audio quality or caption mismatch | Check audio is 128kbps MP3 |
| Gemini returns empty [] | Captions already perfect | Expected! Download uses Stage 1 |
| "Timeout (>120s)" | Very long video + CPU-only | Use GPU or shorten video |

---

## Next Steps

1. ✅ Deploy WhisperX (this guide, step 1-2)
2. ✅ Deploy Render proxy (this guide, step 3)
3. ✅ Update HTML (this guide, step 4)
4. ✅ Test end-to-end (this guide, step 5)
5. 📊 Monitor first few runs, watch for errors
6. 🔧 Tune WhisperX model if needed (medium vs large-v3)
7. 📈 Track usage, upgrade Render if needed

---

## Support & Docs

- **WhisperX issues:** See `whisperx-server/README.md`
- **Cloudflare Tunnel:** See `whisperx-server/README.md` (Cloudflare section)
- **Render proxy:** See `backend/README.md`
- **Stage 2 design:** See `STAGE_2_DESIGN.md`
- **Original tool:** See `frontend/ABC_Caption_Formatter_v3_DOCUMENTATION.md`
- **Implementation notes:** See `IMPLEMENTATION_NOTES.md`

---

## Checklist Before Going Live

- [ ] WhisperX server runs locally & responds to /health
- [ ] Cloudflare Tunnel running & public URL works
- [ ] Render service deployed, env vars set
- [ ] Frontend HTML has correct API_BASE_URL and API_SECRET
- [ ] Test end-to-end: SRT → Stage 1 → MP3 → Stage 2 → Download
- [ ] Verify timing is accurate (±100ms)
- [ ] Verify italic formatting preserved
- [ ] Error messages are user-friendly
- [ ] Documentation links all work
- [ ] Render logs show no errors
- [ ] WhisperX terminal shows "Alignment complete"

---

**Status: ✅ Ready to Deploy**

Follow this guide, all components will work together seamlessly.
