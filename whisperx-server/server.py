import base64
import os
import tempfile
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional
import asyncio
import json

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
import uvicorn

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

SHARED_SECRET = os.getenv("SHARED_SECRET", "development-secret")
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "medium")

# Models loaded once at startup
_align_model = None
_align_metadata = None
_device = "cpu"

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

app = FastAPI(title="WhisperX Alignment Server", lifespan=lifespan)

class CaptionInput(BaseModel):
    index: int
    text: str
    start_ms: Optional[int] = None
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

@app.middleware("http")
async def verify_secret(request: Request, call_next):
    if request.url.path == "/health":
        return await call_next(request)
    secret = request.headers.get("X-Secret")
    if not secret or secret != SHARED_SECRET:
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})
    return await call_next(request)

@app.get("/health")
async def health():
    return {"status": "ok", "service": "whisperx-alignment", "device": _device}

@app.post("/align")
async def align_captions(request: AlignRequest):
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

    try:
        audio_bytes = base64.b64decode(request.audio_base64)
    except Exception as e:
        raise HTTPException(400, f"Invalid base64: {e}")

    suffix = f".{request.audio_format}"

    def do_alignment():
        import whisperx
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
                f.write(audio_bytes)
                tmp_path = f.name

            logger.info(f"Audio: {len(audio_bytes)/1024:.0f} KB → {tmp_path}")

            try:
                audio = whisperx.load_audio(tmp_path)
            except Exception as e:
                return {"error": f"Audio loading failed (ffmpeg installed?): {e}"}

            segments = []
            for cap in request.captions:
                seg = {"text": cap.text}
                if cap.start_ms is not None:
                    seg["start"] = cap.start_ms / 1000.0
                if cap.end_ms is not None:
                    seg["end"] = cap.end_ms / 1000.0
                segments.append(seg)

            logger.info(f"Running forced alignment for {len(segments)} segments...")
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
                return {"error": f"Alignment failed: {e}"}

            logger.info(f"Alignment complete — {len(result.get('segments', []))} output segments")
            aligned = _build_output(request.captions, result.get("segments", []))
            return {"status": "success", "captions": aligned}

        finally:
            if tmp_path and Path(tmp_path).exists():
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass

    # Note: No yield b" " here because the proxy (server.js) handles its own keep-alive.
    # StreamingResponse is still used to avoid FastAPI sync blocking.
    async def generate():
        loop = asyncio.get_running_loop()
        future = loop.run_in_executor(None, do_alignment)
        
        while not future.done():
            # Still yield a tiny bit to keep the generator active if needed,
            # but rawText.trim() in proxy will handle it.
            yield b" "
            await asyncio.sleep(15)
            
        result_dict = future.result()
        yield json.dumps(result_dict).encode('utf-8')

    return StreamingResponse(generate(), media_type="application/json")

def _build_output(captions: List[CaptionInput], segments: list) -> list:
    # Flatten all words from all returned segments.
    # This solves the issue where WhisperX fragments one input segment into multiple output segments.
    all_words = []
    for seg in segments:
        for w in seg.get("words", []):
            if "start" in w and "end" in w:
                all_words.append({
                    "word": w.get("word", "").strip(),
                    "start_ms": int(w["start"] * 1000),
                    "end_ms": int(w["end"] * 1000),
                })

    def tokenize(text):
        import re
        return re.findall(r'\w+', text.lower())

    output = []
    word_idx = 0
    for cap in captions:
        tokens = tokenize(cap.text)
        num_tokens = len(tokens)
        
        # Take the next N words that match our token count
        cap_words = all_words[word_idx : word_idx + num_tokens]
        word_idx += num_tokens

        if cap_words:
            start_ms = cap_words[0]["start_ms"]
            end_ms = cap_words[-1]["end_ms"]
        else:
            start_ms = cap.start_ms or 0
            end_ms = cap.end_ms or (start_ms + 2000)

        output.append({
            "index": cap.index,
            "text": cap.text,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "words": cap_words,
        })
    return output

if __name__ == "__main__":
    port = int(os.getenv("PORT", "8765"))
    uvicorn.run("server:app", host="0.0.0.0", port=port, log_level="info")
