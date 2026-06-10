# Gemini Phase-1 Evaluation Harness

Runs the full **transcript + raw captions + audio → Stage 1 → Gemini suggestions** pipeline
offline (no browser, no backend server, no WhisperX) so Gemini's output can be collected
repeatedly and scored against the caption standards.

## How it works

- `stage1.js` — Node port of the frontend Stage 1 pipeline (SRT parse, DOCX bold-segment
  extraction via mammoth, italic detection, mid-speaker preprocessing, `processCaptions`).
  Functions are copied verbatim from `frontend/ABC_Caption_Formatter_v3.html`; if Stage 1
  changes there, update this file to match.
- `run_eval.js` — for each episode in `Test files/`, runs Stage 1, builds the **production
  prompt** (shared module `backend/lib/gemini.js` — the exact code `server.js` uses), sends
  audio + prompt to Gemini with the production model-fallback chain, and saves everything
  to `results/`: raw response text, parsed + filtered suggestions, model used, finish
  reason, token usage, timing.
- `evaluate.js` — scores each saved run against the standards and writes `results/report.md`:

  | Check | Standard |
  |---|---|
  | A | JSON parses, response not truncated/blocked |
  | B | Schema: valid `caption_index`, `change_type`, `linked_suggestions`, no duplicates |
  | C | Char limits: spoken text ≤60 (≤30 for name-tag captions), `split_remainder` ≤60 |
  | D | Linked suggestions symmetric, no dangling links |
  | E | Zero text loss: applying all suggestions loses/duplicates no words (word-level diff) |
  | F | Italic boundary: no final caption mixes words from italic + non-italic sources |
  | G | Name tags stay as the first line of their own caption, never absorbed |
  | H | Every `line_too_long` caption received a suggestion |

  Plus run-to-run consistency (Jaccard overlap of suggested caption indices) per episode.

## Usage

```powershell
cd test_system\gemini_eval
npm install                          # first time only (mammoth)
$env:GEMINI_API_KEY = "AIza..."
node run_eval.js                     # all episodes × 2 runs each
node run_eval.js ep11 ep14           # subset
node run_eval.js --runs 3            # more repeats
node evaluate.js                     # score + write results/report.md
```

`Test files/` is auto-discovered by walking up from this directory (works from git
worktrees too); override with `$env:TEST_FILES_DIR`.

## Known data issue

`Test files/ep12/ep12_subtitles.srt` is **not** ep12's raw Premiere export — it contains a
formatted copy of ep11's captions (the browser session log shows ep12 was processed from a
file named "ep12 unclean.srt", which is not in the folder). Until the real raw SRT is
dropped in, ep12 runs will pair the cobalt audio with photo-jigsaw captions and produce
meaningless results. Run `node run_eval.js ep11 ep14 ep16` to skip it.
