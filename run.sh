#!/usr/bin/env bash
# AquaNexus - starts backend + website on http://localhost:8000
set -e
cd "$(dirname "$0")/backend"
[ -d .venv ] || python3 -m venv .venv
source .venv/bin/activate
python -m pip install -q -r requirements.txt
echo "===== AquaNexus running at http://localhost:8000  (Ctrl+C to stop) ====="
python -m uvicorn app:app --port 8000
