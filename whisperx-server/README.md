# WhisperX Alignment Server

A FastAPI server that provides word-level timestamp alignment for audio and caption text using WhisperX. Exposed to the internet via Cloudflare Tunnel so the Render proxy can call it securely.

## Quick Start

1. **Prerequisites:**
   - Windows 10 or later
   - Python 3.10 or later
   - (Optional) NVIDIA GPU with CUDA 12.x for 5x faster processing

2. **Setup:**
   ```bash
   # Navigate to this directory
   cd whisperx-server
   
   # Copy .env.example to .env and update SHARED_SECRET
   copy .env.example .env
   # Edit .env with your text editor and add the same SHARED_SECRET from your Render proxy
   
   # Start the server (options: start.bat, start_medium.bat, start_large.bat)
   start_medium.bat
   ```

3. **Verify it's running:**
   ```bash
   curl http://localhost:8765/health
   # Expected response: {"status":"ok","service":"whisperx-alignment"}
   ```

## Installation

### Step 1: System Requirements

**Minimum:**
- Windows 10/11
- Python 3.10+ (download from https://www.python.org/downloads/)
- 8GB RAM
- 2GB disk space (for models)

**Recommended for speed:**
- NVIDIA GPU (RTX 3060 or better, 4GB+ VRAM)
- CUDA 12.x toolkit (download from https://developer.nvidia.com/cuda-downloads)
- 16GB RAM

### Step 2: Environment File

```bash
# In this directory (whisperx-server/), copy the example file:
copy .env.example .env

# Edit .env with Notepad and set SHARED_SECRET to match your Render proxy
# This secret must be identical on both sides for authentication
```

### Step 3: Start the Server

**Option A: Simple (recommended)**
- Double-click `start.bat` (Default model: small)
- Or double-click `start_medium.bat` (Medium model)
- Or double-click `start_large.bat` (Large-v3 model)
- Server starts on `http://localhost:8765`
- Stay logged in to keep it running

**Option B: Windows Service (auto-start on reboot)**
See "Windows Service Setup" section below.

## API Endpoints

### POST /align

Force-aligns audio to caption text, returning word-level timestamps.

**Request (JSON):**
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

**Response (JSON):**
```json
{
  "status": "success",
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

### GET /health

Health check endpoint.

**Response:**
```json
{"status":"ok","service":"whisperx-alignment"}
```

## Cloudflare Tunnel Setup

This exposes the local WhisperX server to the internet so your Render proxy can reach it securely.

### One-Time Setup

#### 1. Install cloudflared

```powershell
# Using Windows Package Manager (recommended)
winget install --id Cloudflare.cloudflared

# Or download manually from:
# https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
```

#### 2. Authenticate with Cloudflare

```bash
cloudflared tunnel login
```

This opens your browser. Click **Authorize** to grant permission. (You don't need a Cloudflare account; it can be free.)

#### 3. Create a Tunnel

```bash
cloudflared tunnel create whisperx-abc
```

This returns:
```
Tunnel UUID: <UUID>
Tunnel credentials file: C:\Users\<username>\.cloudflared\<UUID>.json
```

Save the UUID — you'll need it in the next step.

#### 4. Configure Tunnel Routing

Edit (or create) `C:\Users\<username>\.cloudflared\config.yml`:

**If you have a Cloudflare domain (e.g., `example.com`):**
```yaml
tunnel: <paste-UUID-from-step-3>
credentials-file: C:\Users\<username>\.cloudflared\<UUID>.json
ingress:
  - hostname: whisperx-abc.example.com
    service: http://localhost:8765
  - service: http_status:404
```

**If you want an auto-generated subdomain (no domain needed):**
```yaml
tunnel: <paste-UUID-from-step-3>
credentials-file: C:\Users\<username>\.cloudflared\<UUID>.json
ingress:
  - service: http://localhost:8765
```

#### 5. Run the Tunnel

```bash
cloudflared tunnel run whisperx-abc
```

This stays in the foreground. You should see:
```
Route added | subdomain | example.com -> http://localhost:8765
```

Open a new terminal and test:
```bash
curl https://whisperx-abc.example.com/health
```

Expected response:
```json
{"status":"ok","service":"whisperx-alignment"}
```

### Persist the Tunnel (Auto-Start on Reboot)

#### Option A: Windows Service (Recommended)

```bash
# In an Admin PowerShell window:
cloudflared service install

# Start the service:
net start cloudflared

# Check status:
Get-Service cloudflared
```

Now Cloudflare Tunnel auto-starts when Windows boots.

#### Option B: Windows Task Scheduler

1. Open Task Scheduler
2. Create Basic Task → Name: "WhisperX Tunnel"
3. Trigger: "At startup"
4. Action: Start Program
   - Program: `C:\Users\<username>\AppData\Local\Cloudflare\cloudflared.exe`
   - Arguments: `tunnel run whisperx-abc`
5. Click OK

## Troubleshooting

### Server won't start

**Error: "ModuleNotFoundError: No module named 'whisperx'"**
- The `venv` didn't install dependencies correctly
- Delete the `venv` folder
- Double-click `start.bat` again to rebuild it

**Error: "port 8765 already in use"**
- Another process is on port 8765
- Find and stop it: `netstat -ano | findstr :8765`
- Or change the port in `.env` and restart

### Tunnel won't connect

**Error: "Tunnel not found"**
- Run `cloudflared tunnel list` to see available tunnels
- Make sure the tunnel UUID in `config.yml` matches the created tunnel

**Error: "PERMISSION DENIED" / "unable to login"**
- Run cloudflared commands in an **Admin PowerShell** window

**Can't reach https://whisperx-abc.example.com**
- Make sure the tunnel is running: `cloudflared tunnel run whisperx-abc`
- Test the local endpoint first: `curl http://localhost:8765/health`

### WhisperX processing slow

- Check if GPU is being used: the server will log "device: cuda" if CUDA is available
- Install CUDA 12.x to enable GPU acceleration (~5x faster)
- Without GPU, expect 30-60 seconds per 5-minute video

## Performance Notes

- **GPU path:** 5-10 seconds per 5-minute video (NVIDIA GPU required)
- **CPU path:** 30-60 seconds per 5-minute video (any modern CPU)
- **Model size:** Uses `large-v3` (most accurate, can be tuned in `server.py`)
- **RAM:** 8GB minimum, 16GB recommended

## Configuration

Edit `server.py` to customize:
- Line 152: Change `--model` from `large-v3` to `medium` for faster processing
- Line 153: Change `--device` from `cuda` to `cpu` to force CPU-only (useful for testing on laptop without GPU)
- Line 120 timeout: Adjust from 120 to different seconds if needed

## Security

- The server requires `X-Secret` header matching your `SHARED_SECRET` for all alignment requests
- Cloudflare Tunnel encrypts traffic in transit
- Audio is temporary — processed files are deleted after alignment
- Consider enabling Cloudflare Access to add email/SSO authentication layer (optional)

## Testing

### Local test (without Tunnel):
```bash
# Terminal 1: Start server
start.bat

# Terminal 2: Test health endpoint
curl http://localhost:8765/health

# Terminal 3: Test /align endpoint with sample data
curl -X POST http://localhost:8765/align \
  -H "X-Secret: your-secret" \
  -H "Content-Type: application/json" \
  -d '{"audio_base64":"...","captions":[{"index":1,"text":"hello world"}],"audio_format":"mp3","language":"en"}'
```

### Test via Tunnel:
```bash
curl https://whisperx-abc.example.com/health
```

## Logs

Logs appear in the terminal where you ran `start.bat` or the service.

Key messages:
- `Alignment request: N captions` — successful request received
- `WhisperX completed successfully` — alignment finished
- `ERROR: WhisperX` — processing failed (check audio format / file corruption)

## Maintenance

### Update dependencies:
```bash
# Activate venv
venv\Scripts\activate.bat

# Upgrade packages
pip install --upgrade -r requirements.txt
```

### Stop the server:
- Press Ctrl+C in the terminal (if running `start.bat`)
- Or: `net stop cloudflared` (if using Windows Service)

### Restart Cloudflare Tunnel:
```bash
# If it crashes or gets stuck
net stop cloudflared
net start cloudflared

# Or force-kill and restart:
taskkill /IM cloudflared.exe /F
cloudflared tunnel run whisperx-abc
```

## File Structure

```
whisperx-server/
├── server.py              # FastAPI application
├── requirements.txt       # Python dependencies
├── start.bat              # Windows startup script
├── .env.example           # Environment variables template
├── .env                   # Your actual environment (create from .example)
├── venv/                  # Python virtual environment (auto-created)
└── README.md              # This file
```

## Support

For WhisperX issues: https://github.com/m-bain/whisperx
For Cloudflare Tunnel: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/
For this server: Check logs and ensure SHARED_SECRET matches between this server and your Render proxy.
