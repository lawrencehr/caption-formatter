# P2S2 Test System

Tests and diagnostics for Phase 2 Stage 2 (WhisperX forced alignment).

## Scripts

### `analyze.js` — Timing quality report (no server needed)

Loads a saved `test_output.json` and prints a quality report with pass/fail.

```
node analyze.js [path/to/test_output.json]
```

Defaults to `test_output.json` in the same directory. Exits with code 1 if any FAIL threshold is breached.

### `tester.js` — End-to-end Phase 2 test (requires backend + WhisperX)

Sends a real SRT + audio through the full backend pipeline, saves the result, then runs `analyze.js` automatically.

```
SHARED_SECRET=yourvalue node tester.js [srt_file] [audio_file]
```

- Default SRT: `../Test files/Before cleanup v2.srt`
- Default audio: `../Test files/Ep11.mp3`
- Output: `test_output.json`

## Metrics

| Metric | What it measures |
|---|---|
| **Start delta** | `caption.start_ms − first_word.start_ms`. Should be ≈0ms. Large positive = overlap resolution pushed start forward; large negative = previous caption's end was extended into this one. |
| **End trim** | `last_word.end_ms − (caption.end_ms − 200ms)`. Positive = post-processor trimmed the caption end after WhisperX set it. The 200ms tail is intentional; large trim values (>500ms) indicate aggressive post-processing. |
| **Timing shift** | `\|new_start_ms − original_start_ms\|`. Large values (>1000ms) suggest WhisperX searched in the wrong area. |
| **Coverage** | % of captions that received word-level timestamps from WhisperX. Low coverage = fallback to original timing for many captions. |

## Thresholds

| Check | Level |
|---|---|
| Any caption < 240ms (Premiere won't import) | FAIL |
| Any inverted caption (start ≥ end) | FAIL |
| Any overlapping consecutive pair | FAIL |
| > 5% of captions with \|start delta\| > 200ms | FAIL |
| > 15% of captions end-trimmed > 500ms | WARN |
| Any caption shifted > 1000ms from original | WARN |

## Current baseline (Ep11, 100 captions)

```
Start delta > 200ms:   33/100 (33%)  ← FAIL
End-trimmed > 500ms:   21/100 (21%)  ← WARN
Duration < 240ms:          0         ✓
Overlaps / inverted:        0         ✓
```

The start-delta failures are caused by the gap/overlap resolution in `backend/server.js` adjusting `start_ms` after WhisperX has set it, creating a mismatch between caption boundaries and word timestamps.
