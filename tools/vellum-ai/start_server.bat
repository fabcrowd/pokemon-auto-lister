@echo off
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Creating virtual environment...
    python -m venv .venv
    .venv\Scripts\pip install -r requirements.txt
)

echo Starting Pokemon Card Scanner sidecar on http://127.0.0.1:7331
.venv\Scripts\python server.py
