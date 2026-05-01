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
                logger.info(f"  Input Segment: '{cap.text[:30]}...' ({seg.get('start', 0):.2f}s - {seg.get('end', 0):.2f}s)")

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
                
                # Check how many segments actually got word-level timing
                aligned_segments = result.get("segments", [])
                for i, res_seg in enumerate(aligned_segments):
                    words_found = len(res_seg.get("words", []))
                    if words_found == 0:
                        logger.warning(f"  Segment {i} FAILED: No words aligned for '{res_seg.get('text', '')[:30]}...'")
                    else:
                        logger.info(f"  Segment {i} OK: Found {words_found} words.")

            except Exception as e:
                logger.error(f"Alignment Error: {e}", exc_info=True)
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

    async def generate():
        loop = asyncio.get_running_loop()
        future = loop.run_in_executor(None, do_alignment)
        
        while not future.done():
            yield b" "
            await asyncio.sleep(1)
            
        try:
            result_dict = future.result()
            yield json.dumps(result_dict).encode('utf-8')
        except Exception as e:
            logger.error(f"Pipeline Error: {e}", exc_info=True)
            yield json.dumps({"error": str(e)}).encode('utf-8')

    return StreamingResponse(generate(), media_type="application/json")

def _build_output(captions: List[CaptionInput], segments: list) -> list:
    """
    Maps WhisperX output segments back to the input captions.
    Since we use forced alignment, segments should generally match 1-to-1.
    """
    output = []
    
    for i, cap in enumerate(captions):
        # Default to original timing if alignment fails for this segment
        start_ms = cap.start_ms or 0
        end_ms = cap.end_ms or (start_ms + 2000)
        cap_words = []

        if i < len(segments):
            seg = segments[i]
            
            # Extract word-level timing if available
            seg_words = seg.get("words", [])
            for w in seg_words:
                if "start" in w and "end" in w:
                    w_start = int(w["start"] * 1000)
                    w_end = int(w["end"] * 1000)
                    cap_words.append({
                        "word": w.get("word", "").strip(),
                        "start_ms": w_start,
                        "end_ms": w_end,
                    })
                    logger.debug(f"  Word: {w.get('word')} [{w_start}-{w_end}]")
            
            # If word alignment succeeded, use it to refine boundaries
            if cap_words:
                start_ms = cap_words[0]["start_ms"]
                end_ms = cap_words[-1]["end_ms"]
            else:
                # Fallback to segment-level timing if words are missing
                if "start" in seg and "end" in seg:
                    start_ms = int(seg["start"] * 1000)
                    end_ms = int(seg["end"] * 1000)
                logger.warning(f"No word-level alignment for caption {cap.index} ('{cap.text[:20]}...')")

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
