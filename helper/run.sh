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

# The API key normally comes from the extension popup per-request; the env
# var is only a fallback for CLI/dev use, so its absence is not an error.
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "[minutes] note: ANTHROPIC_API_KEY not set — using the key from the extension popup."
fi

exec ./.venv/bin/python main.py
