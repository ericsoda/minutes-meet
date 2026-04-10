#!/usr/bin/env bash
# Minutes — one-shot setup script.
#
# Installs Homebrew dependencies, downloads the whisper model, creates the
# Python venv for the helper, and installs the helper's dependencies.
# Idempotent — safe to re-run.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

YELLOW='\033[1;33m'
GREEN='\033[1;32m'
RED='\033[1;31m'
NC='\033[0m'

say()  { echo -e "${YELLOW}[minutes]${NC} $*"; }
ok()   { echo -e "${GREEN}[minutes]${NC} $*"; }
fail() { echo -e "${RED}[minutes]${NC} $*" >&2; exit 1; }

# 1. Homebrew
if ! command -v brew >/dev/null 2>&1; then
  fail "Homebrew is required. Install it from https://brew.sh and re-run this script."
fi
ok "Homebrew is installed"

# 2. whisper.cpp + ffmpeg
say "Installing whisper.cpp and ffmpeg via Homebrew (skip if already present)…"
brew list whisper-cpp >/dev/null 2>&1 || brew install whisper-cpp
brew list ffmpeg      >/dev/null 2>&1 || brew install ffmpeg
ok "whisper-cpp and ffmpeg ready"

# 3. Whisper model
MODEL_DIR="$REPO_ROOT/models"
MODEL_PATH="$MODEL_DIR/ggml-large-v3-turbo.bin"
mkdir -p "$MODEL_DIR"
if [ -f "$MODEL_PATH" ]; then
  ok "Whisper model already present ($(du -h "$MODEL_PATH" | cut -f1))"
else
  say "Downloading whisper large-v3-turbo model (~1.5 GB)…"
  curl -L --progress-bar \
    -o "$MODEL_PATH.tmp" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"
  mv "$MODEL_PATH.tmp" "$MODEL_PATH"
  ok "Model downloaded to $MODEL_PATH"
fi

# 4. Python venv + helper deps
HELPER_DIR="$REPO_ROOT/helper"
if [ ! -d "$HELPER_DIR/.venv" ]; then
  say "Creating Python venv at helper/.venv…"
  python3 -m venv "$HELPER_DIR/.venv"
fi
say "Installing helper Python dependencies…"
"$HELPER_DIR/.venv/bin/pip" install --upgrade pip --quiet
"$HELPER_DIR/.venv/bin/pip" install -r "$HELPER_DIR/requirements.txt" --quiet
ok "Helper venv ready"

cat <<'EOF'

────────────────────────────────────────────────────────────
  Minutes is set up. Next steps:

  1. Start the helper:
       cd helper && ./run.sh

  2. Load the extension in Chrome:
       - Open chrome://extensions
       - Toggle "Developer mode" on (top right)
       - Click "Load unpacked"
       - Select the extension/ folder from this repo
       - Pin the Minutes icon to your toolbar

  3. Click the Minutes icon and paste your Anthropic API key
     (get one at https://console.anthropic.com/settings/keys)

  4. Join a Google Meet, click Start, click Stop when done.
────────────────────────────────────────────────────────────
EOF
