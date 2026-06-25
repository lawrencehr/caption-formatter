# Sample data

Fictional sample files for trying out Stage 1 — **no real footage or transcripts**.
Everything here (the program "The Evening Roundup", the host, the outlets, the quotes)
is invented purely to demonstrate the formatter.

| File | What it is |
|---|---|
| `mock_subtitles.srt` | A raw Premiere-style subtitle export (18 cues). |
| `mock_transcript.docx` | The matching transcript. Quoted on-screen text is **bold**, which Stage 1 turns into *italic* captions. |

## Try it

1. Open `frontend/caption_formatter.html` in a browser.
2. Drop in `mock_subtitles.srt` and `mock_transcript.docx`.
3. Run Stage 1 — you'll get 18 formatted captions with three italic segments detected from the transcript.
