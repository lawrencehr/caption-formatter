@echo off
setlocal enabledelayedexpansion
cd /d %~dp0

REM Ensure manual ffmpeg install is in PATH
set "PATH=C:\ffmpeg\bin;%PATH%"

echo.
echo ============================================
echo  WhisperX Alignment Server  (CPU mode)
echo ============================================
echo.

REM ── 1. Find Python ───────────────────────────────────────────────────────────
set "PYTHON=C:\Users\Lawre\AppData\Local\Programs\Python\Python312\python.exe"

if not exist "!PYTHON!" (
    echo ERROR: Python not found at !PYTHON!
    echo Please install Python 3.12 or check the path.
    pause & exit /b 1
)

for /f "tokens=2" %%v in ('"!PYTHON!" --version 2^>^&1') do set PY_VER=%%v
echo Python %PY_VER% found at: %PYTHON%

REM ── 2. Check ffmpeg ───────────────────────────────────────────────────────────
where ffmpeg >nul 2>&1
if !errorlevel! neq 0 (
    echo.
    echo ffmpeg not found — installing via winget...
    winget install --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
    if !errorlevel! neq 0 (
        echo.
        echo winget install failed. Manual steps:
        echo   1. Download ffmpeg from https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip
        echo   2. Extract to C:\ffmpeg\
        echo   3. Add C:\ffmpeg\bin to your PATH environment variable
        echo   4. Restart this script
        pause & exit /b 1
    )
    echo.
    echo ffmpeg installed. You may need to restart this script once if PATH
    echo has not updated yet. Try closing and re-opening this window.
    echo.
)
echo ffmpeg found.

REM ── 3. Create/update venv ────────────────────────────────────────────────────
if not exist venv (
    echo.
    echo [1/4] Creating Python virtual environment...
    !PYTHON! -m venv venv
    if !errorlevel! neq 0 (
        echo ERROR: venv creation failed.
        pause & exit /b 1
    )
)

echo [2/4] Activating venv...
call venv\Scripts\activate.bat
if !errorlevel! neq 0 (
    echo ERROR: Could not activate venv. Try deleting the venv\ folder and re-running.
    pause & exit /b 1
)

REM ── 4. Install PyTorch CPU-only (skip if already installed) ──────────────────
!PYTHON! -c "import torch" >nul 2>&1
if !errorlevel! neq 0 (
    echo [3/4] Installing PyTorch 2.8.0 - CPU-only...
    pip install torch==2.8.0 torchaudio==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cpu --quiet
    if !errorlevel! neq 0 (
        echo ERROR: PyTorch install failed. Check your internet connection.
        pause & exit /b 1
    )
) else (
    echo [3/4] PyTorch already installed.
)

REM ── 5. Install remaining dependencies ────────────────────────────────────────
echo [4/4] Installing/updating other dependencies...
pip install -r requirements.txt --quiet
if !errorlevel! neq 0 (
    echo ERROR: Dependency install failed.
    pause & exit /b 1
)

echo [5/5] Patching ctranslate2 for Windows AVX compatibility...
pip install ctranslate2==3.24.0 --quiet
pip uninstall -y torchcodec --quiet
if !errorlevel! neq 0 (
    echo ERROR: ctranslate2 downgrade failed.
    pause & exit /b 1
)
echo Dependencies OK.

REM ── 6. Load .env ─────────────────────────────────────────────────────────────
if not exist .env (
    echo.
    echo WARNING: .env file not found.
    echo Copy .env.example to .env and set SHARED_SECRET before running.
    echo.
    copy .env.example .env >nul
    echo Created .env from template — please edit it now and re-run.
    notepad .env
    pause & exit /b 1
)

for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
    if not "%%a"=="" set "%%a=%%b"
)

REM ── 7. Start server ───────────────────────────────────────────────────────────
echo.
echo Starting server on http://localhost:8765
echo Health check: curl http://localhost:8765/health
echo Press Ctrl+C to stop.
echo.
echo NOTE: First startup downloads the wav2vec2 alignment model (~370MB).
echo This only happens once.
echo.

uvicorn server:app --host 0.0.0.0 --port 8765

echo.
echo Server stopped. Press any key to exit.
pause >nul
