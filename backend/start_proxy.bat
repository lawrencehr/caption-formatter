@echo off
title ABC Caption Proxy Server
color 0b

echo ===========================================
echo   ABC Caption Proxy Server (Local Setup)
echo ===========================================
echo.

set PORT=3000
set SHARED_SECRET=abc-captions-2026
set WHISPERX_URL=http://localhost:8765

:: Note: Anthropic key is only used for the /api/review endpoint.
:: If you don't use that feature, it can remain empty.
set ANTHROPIC_API_KEY=

echo Please paste your Gemini API Key (begins with AIza...):
set /p GEMINI_API_KEY=
echo.

echo Starting proxy server...
echo Pointing to WhisperX at: %WHISPERX_URL%
echo.

cmd.exe /c "npm start"

pause
