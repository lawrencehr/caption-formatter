# ABC Caption Proxy Server

Node.js/Express proxy for ABC Caption Formatter that handles API calls to Anthropic Claude, Google Gemini, and the WhisperX alignment server.

## Endpoints

- `POST /api/review` — Claude style guide review (Anthropic API)
- `POST /api/audio-check` — Gemini audio vs captions comparison
- `POST /api/refine` — Stage 2: Gemini caption refinement + WhisperX alignment
- `GET /` — Health check

## Deployment on Render

### Environment Variables

Create these in Render's environment settings:

```
SHARED_SECRET=<shared-secret-token>
ANTHROPIC_API_KEY=<your-api-key>
GEMINI_API_KEY=<your-api-key>
WHISPERX_URL=<https://whisperx-abc.example.com>
```

### Setup

1. Push this code to Render
2. Set the build command: `npm install`
3. Set the start command: `npm start` (which runs `node server.js`)
4. Add environment variables from above
5. Render will expose it at `https://<your-service>.onrender.com`

### Client Configuration

In the HTML tool, set the API base URL to:
```
https://<your-service>.onrender.com
```

Add the `X-Secret` header to all requests:
```
X-Secret: <SHARED_SECRET>
```

## Local Development

```bash
# Install dependencies
npm install

# Set environment variables
export SHARED_SECRET=dev-secret
export ANTHROPIC_API_KEY=sk-...
export GEMINI_API_KEY=...
export WHISPERX_URL=http://localhost:8765

# Run server
npm start

# Server listens on port 3000 (configurable with PORT env var)
```

## Testing Endpoints

### /api/review (Claude)

```bash
curl -X POST http://localhost:3000/api/review \
  -H "X-Secret: dev-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello Claude"}]
  }'
```

### /api/audio-check (Gemini)

```bash
curl -X POST http://localhost:3000/api/audio-check \
  -H "X-Secret: dev-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "audioBase64": "<base64-encoded-audio>",
    "mimeType": "audio/mpeg",
    "captionsText": "Hello world..."
  }'
```

### /api/refine (Stage 2)

```bash
curl -X POST http://localhost:3000/api/refine \
  -H "X-Secret: dev-secret" \
  -F "audio=@sample.mp3" \
  -F 'captions=[{"index":1,"text":"Hello world","italic":false,"start_ms":100,"end_ms":2000}]'
```

## Architecture

```
Browser                              Proxy (this server)
   |                                    |
   +--POST /api/review ------→ Anthropic API
   |
   +--POST /api/audio-check → Gemini API
   |
   +--POST /api/refine ------→ [Gemini API]
   |                            └→ [WhisperX server]
```

## Error Handling

- **400**: Invalid request (missing fields, invalid JSON)
- **401**: Missing or incorrect X-Secret header
- **408**: Timeout (>120 seconds)
- **413**: File too large (>100MB for audio)
- **500**: Service error (Anthropic/Gemini/WhisperX unavailable)

## Configuration Notes

- Max JSON payload: 25MB
- Max file upload: 100MB
- Pipeline timeout: 120 seconds
- Temp file directory: `/tmp` (configurable in server.js)

## File Structure

```
backend/
├── server.js       # Main Express app with all endpoints
├── package.json    # Dependencies
├── temp/           # Temporary uploaded files (auto-created)
└── README.md       # This file
```

## Dependencies

- `express` ^4.18.2 — HTTP server framework
- `express-fileupload` ^1.5.0 — Multipart file upload handling
- `form-data` ^4.0.0 — Form data serialization (for WhisperX requests)

See `package.json` for exact versions.

## Maintenance

### Check logs
- Render dashboard → Logs tab
- Local: watch server console output

### Restart server
- Render: auto-restarts on `git push` or via dashboard
- Local: Ctrl+C, then `npm start`

### Update dependencies
```bash
npm update
```

## Support

For issues:
1. Check logs (Render dashboard or console)
2. Verify environment variables are set correctly
3. Test each endpoint independently with curl
4. Check that WhisperX server is running (if testing /api/refine)
