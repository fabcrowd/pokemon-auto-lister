#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if [ ! -f ".venv/bin/python" ]; then
  echo "Creating virtual environment..."
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi

echo "Starting Pokemon Card Scanner sidecar on http://127.0.0.1:7331"
.venv/bin/python server.py
