import base64
import os
import tempfile
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import uvicorn

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

SHARED_SECRET = os.getenv("SHARED_SECRET", "development-secret")
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "medium")  # base|small|medium — large-v3 too slow on CPU

# Models loaded once at startup
_align_model = None
_align_metadata = None
_device = "cpu"

# ── Startup: load models ─────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    global _align_model, _align_metadata, _device

    import torch
    _device = "cuda" if torch.cuda.is_available() else "cpu"
    logger.info(f"Device: {_device}")

    logger.info("Loading WhisperX alignment model (wav2vec2 English)...")
    import whisperx
    _align_model, _align_metadata = whisperx.load_align_model(
        language_code="en", device=_device
    )
    logger.info("Alignment model ready.")
    yield
    # nothing to clean up

app = FastAPI(title="WhisperX Alignment Server", lifespan=lifespan)

# ── Models ────────────────────────────────────────────────────────────────────
class CaptionInput(BaseModel):
    index: int
    text: str
    start_ms: Optional[int] = None  # original SRT timing — required for forced alignment
    end_ms: Optional[int] = None

class AlignRequest(BaseModel):
    audio_base64: str
    captions: List[CaptionInput]
    audio_format: str = "mp3"
    language: str = "en"

class WordTimestamp(BaseModel):
    word: str
    start_ms: int
    end_ms: int

class CaptionOutput(BaseModel):
    index: int
    text: str
    start_ms: int
    end_ms: int
    words: List[WordTimestamp]

# ── Auth ──────────────────────────────────────────────────────────────────────
@app.middleware("http")
async def verify_secret(request, call_next):
    if request.url.path == "/health":
        return await call_next(request)
    secret = request.headers.get("X-Secret")
    if not secret or secret != SHARED_SECRET:
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})
    return await call_next(request)

# ── Endpoints ────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "service": "whisperx-alignment", "device": _device}

@app.post("/align")
async def align_captions(request: AlignRequest):
    """
    Force-aligns provided caption text to audio.
    Requires start_ms/end_ms on each caption for accurate alignment.
    """
    import whisperx

    if not request.audio_base64:
        raise HTTPException(400, "audio_base64 is required")
    if not request.captions:
        raise HTTPException(400, "captions array is required")
    if request.audio_format not in ("mp3", "wav", "m4a"):
        raise HTTPException(400, f"audio_format must be mp3, wav, or m4a")

    missing_timing = [c.index for c in request.captions if c.start_ms is None]
    if missing_timing:
        logger.warning(f"Captions missing start_ms: {missing_timing} — alignment quality will be reduced")

    logger.info(f"Aligning {len(request.captions)} captions on {_device}")

    # Decode audio
    try:
        audio_bytes = base64.b64decode(request.audio_base64)
    except Exception as e:
        raise HTTPException(400, f"Invalid base64: {e}")

    suffix = f".{request.audio_format}"
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
            f.write(audio_bytes)
            tmp_path = f.name

        logger.info(f"Audio: {len(audio_bytes)/1024:.0f} KB → {tmp_path}")

        # Load audio (requires ffmpeg in PATH)
        try:
            audio = whisperx.load_audio(tmp_path)
        except Exception as e:
            raise HTTPException(500, f"Audio loading failed (ffmpeg installed?): {e}")

        # Build segments for forced alignment
        # If we have SRT timestamps, use them — they bound where each caption lives in the audio
        segments = []
        for cap in request.captions:
            seg = {"text": cap.text}
            if cap.start_ms is not None:
                seg["start"] = cap.start_ms / 1000.0
            if cap.end_ms is not None:
                seg["end"] = cap.end_ms / 1000.0
            segments.append(seg)

        logger.info("Running forced alignment...")
        try:
            result = whisperx.align(
                segments,
                _align_model,
                _align_metadata,
                audio,
                device=_device,
                return_char_alignments=False,
            )
        except Exception as e:
            raise HTTPException(500, f"Alignment failed: {e}")

        logger.info(f"Alignment complete — {len(result.get('segments', []))} segments")

        # Map aligned segments back to caption indices
        aligned = _build_output(request.captions, result.get("segments", []))
        return {"status": "success", "captions": aligned}

    finally:
        if tmp_path and Path(tmp_path).exists():
            try:
                os.unlink(tmp_path)
            except Exception:
                pass

# ── Helpers ───────────────────────────────────────────────────────────────────
def _build_output(captions: List[CaptionInput], segments: list) -> list:
    """
    Pair aligned segments back to their original caption index.
    WhisperX preserves segment order, so zip by position is safe.
    """
    output = []
    for i, cap in enumerate(captions):
        seg = segments[i] if i < len(segments) else {}

        words = []
        for w in seg.get("words", []):
            if "start" in w and "end" in w:
                words.append({
                    "word": w.get("word", "").strip(),
                    "start_ms": int(w["start"] * 1000),
                    "end_ms": int(w["end"] * 1000),
                })

        # Prefer word-derived start/end; fall back to segment; fall back to original SRT
        if words:
            start_ms = words[0]["start_ms"]
            end_ms = words[-1]["end_ms"]
        elif "start" in seg and "end" in seg:
            start_ms = int(seg["start"] * 1000)
            end_ms = int(seg["end"] * 1000)
        else:
            start_ms = cap.start_ms or 0
            end_ms = cap.end_ms or (start_ms + 2000)

        output.append({
            "index": cap.index,
            "text": cap.text,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "words": words,
        })

    return output

# ── Main ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    port = int(os.getenv("PORT", "8765"))
    uvicorn.run("server:app", host="0.0.0.0", port=port, log_level="info")
