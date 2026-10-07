#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_MODE="${1:-dev}"
if [ "$WEB_MODE" != "dev" ] && [ "$WEB_MODE" != "start" ]; then
  echo "Usage: npm run dev (development) or npm start (after a production build)." >&2
  exit 2
fi
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 20.9+ and npm are required. Install Node.js, then run npm install from the project root." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required to run the FastAPI backend." >&2
  exit 1
fi

if [ ! -x node_modules/.bin/concurrently ] || [ ! -x node_modules/.bin/next ]; then
  echo "Installing the npm workspace dependencies..."
  npm install
fi

if [ ! -x .venv/bin/python ]; then
  echo "Creating the project Python environment..."
  python3 -m venv .venv
fi

if ! .venv/bin/python -c 'import dotenv, espn_api, fastapi, numpy, uvicorn' >/dev/null 2>&1; then
  echo "Installing the FastAPI and ESPN Python dependencies..."
  .venv/bin/python -m pip install -r requirements.txt
fi

if [ ! -f .env ]; then
  echo "No .env file found. Copy .env.example to .env and add your ESPN league settings." >&2
  exit 1
fi

exec npm exec -- concurrently --kill-others --names API,WEB --prefix-colors blue,green \
  ".venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8000" \
  "npm run $WEB_MODE --workspace fantasy-football-dashboard"
