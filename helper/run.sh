#!/usr/bin/env bash
# Convenience launcher for the Minutes helper.
# First run: creates a venv and installs deps. Subsequent runs: just starts the server.

set -euo pipefail
cd "$(dirname "$0")"

# Load .env if present (KEY=value lines, no quotes needed)
if [ -f ".env" ]; then
  set -a
  . ./.env
  set +a
fi

if [ ! -d ".venv" ]; then
  echo "[minutes] creating venv..."
  python3 -m venv .venv
  ./.venv/bin/pip install --upgrade pip
  ./.venv/bin/pip install -r requirements.txt
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "[minutes] ERROR: ANTHROPIC_API_KEY is not set."
  echo "  export ANTHROPIC_API_KEY=sk-ant-..."
  exit 1
fi

exec ./.venv/bin/python main.py
