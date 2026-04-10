"""
Minutes — local helper.

A small FastAPI server that the Chrome extension talks to. It accepts a finished
meeting recording (audio + the list of participant names from the Meet UI),
runs whisper.cpp locally to transcribe, then asks Claude to produce a
per-participant summary (Claude attributes lines to speakers from context).

Audio never leaves the machine. The only outbound network call is to the
Anthropic API for the summary.

Run:
    cd helper
    ./run.sh
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from align import segments_to_blocks
from summarize import summarize_with_claude, test_api_key

# ---------- paths ----------

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
MODELS_DIR = ROOT / "models"
MODEL_PATH = MODELS_DIR / "ggml-large-v3-turbo.bin"

WHISPER_BIN = shutil.which("whisper-cli") or "/opt/homebrew/bin/whisper-cli"
FFMPEG_BIN = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"

DATA_DIR.mkdir(parents=True, exist_ok=True)

# ---------- app ----------

app = FastAPI(title="Minutes helper", version="0.1.0")

# The extension lives at chrome-extension://<id>/, a distinct origin.
# This server only binds to 127.0.0.1, so allowing all origins is fine.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def session_dir(session_id: str) -> Path:
    d = DATA_DIR / session_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def write_json(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False))


def read_json(path: Path):
    return json.loads(path.read_text())


# ---------- transcription ----------


def convert_to_wav(src: Path, dst: Path) -> None:
    """Convert any audio file to 16 kHz mono PCM WAV (whisper's preferred format)."""
    cmd = [
        FFMPEG_BIN,
        "-y",
        "-i", str(src),
        "-ar", "16000",
        "-ac", "1",
        "-c:a", "pcm_s16le",
        str(dst),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr}")


def measure_volume(wav_path: Path) -> dict:
    """
    Run ffmpeg's volumedetect on the WAV and parse mean/max volume in dB.
    Returns {'mean_db': float, 'max_db': float} or raises RuntimeError.
    """
    cmd = [FFMPEG_BIN, "-hide_banner", "-i", str(wav_path), "-af", "volumedetect", "-f", "null", "-"]
    result = subprocess.run(cmd, capture_output=True, text=True)
    # volumedetect writes to stderr regardless of success.
    out = result.stderr
    mean_db = None
    max_db = None
    for line in out.splitlines():
        if "mean_volume:" in line:
            try: mean_db = float(line.split("mean_volume:")[1].split("dB")[0].strip())
            except (ValueError, IndexError): pass
        if "max_volume:" in line:
            try: max_db = float(line.split("max_volume:")[1].split("dB")[0].strip())
            except (ValueError, IndexError): pass
    if mean_db is None or max_db is None:
        raise RuntimeError(f"ffmpeg volumedetect did not produce volume stats:\n{out}")
    return {"mean_db": mean_db, "max_db": max_db}


# Anything quieter than this on average is effectively silence. Whisper
# hallucinates "Thank you" / "Thanks for watching" on silent audio because
# of YouTube training-data bias, so we refuse to transcribe it and surface
# a real diagnostic instead.
SILENCE_MEAN_DB_THRESHOLD = -55.0
SILENCE_MAX_DB_THRESHOLD = -40.0


def silence_diagnostic(volume: dict) -> str:
    return (
        f"Recording was effectively silent (mean {volume['mean_db']:.1f} dB, "
        f"max {volume['max_db']:.1f} dB). Whisper hallucinates phrases like "
        f"\"Thank you\" on silent audio, so I'm refusing to transcribe this.\n\n"
        f"Most likely causes:\n"
        f"  1. Microphone permission was not granted to the extension — only "
        f"the OTHER meeting participants get recorded via tab capture, your "
        f"own voice has to come from the mic.\n"
        f"  2. You were the only person in the meeting, the other participants "
        f"were muted, AND the mic stream wasn't captured.\n"
        f"  3. The Meet tab was muted in Chrome's tab audio.\n\n"
        f"Open chrome://settings/content/microphone and confirm the Minutes "
        f"extension is allowed to use the microphone, then try again."
    )


def run_whisper(wav_path: Path, out_prefix: Path) -> dict:
    """Run whisper-cli and return parsed JSON output."""
    if not MODEL_PATH.exists():
        raise RuntimeError(
            f"Model not found at {MODEL_PATH}. Download it with:\n"
            f"  curl -L -o {MODEL_PATH} "
            f"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"
        )
    cmd = [
        WHISPER_BIN,
        "-m", str(MODEL_PATH),
        "-f", str(wav_path),
        "-l", "en",
        "-oj",
        "-of", str(out_prefix),
        "-pp",
    ]
    print(f"[whisper] {' '.join(cmd)}", file=sys.stderr)
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"whisper-cli failed: {result.stderr}")

    json_path = Path(str(out_prefix) + ".json")
    if not json_path.exists():
        raise RuntimeError("whisper did not produce JSON output")
    return json.loads(json_path.read_text())


def normalize_whisper_segments(whisper_json: dict) -> list[dict]:
    """
    whisper.cpp's JSON output stores segments under "transcription".
    Each segment has offsets in milliseconds under "offsets": {"from", "to"}.
    """
    segments = []
    for seg in whisper_json.get("transcription", []):
        offsets = seg.get("offsets", {})
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        segments.append({
            "t0_ms": int(offsets.get("from", 0)),
            "t1_ms": int(offsets.get("to", 0)),
            "text": text,
        })
    return segments


# ---------- routes ----------


@app.get("/health")
def health():
    return {
        "ok": True,
        "model_present": MODEL_PATH.exists(),
        "whisper_bin": WHISPER_BIN,
        "ffmpeg_bin": FFMPEG_BIN,
        "anthropic_key_set": bool(os.environ.get("ANTHROPIC_API_KEY")),
        "data_dir": str(DATA_DIR),
    }


@app.post("/sessions")
def create_session():
    session_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    sd = session_dir(session_id)
    write_json(sd / "meta.json", {
        "id": session_id,
        "created_at": time.time(),
        "status": "open",
    })
    return {"id": session_id}


class TestKeyRequest(BaseModel):
    api_key: str


@app.post("/test-key")
def test_key_route(req: TestKeyRequest):
    """Validate an Anthropic API key with a tiny throwaway call."""
    ok, msg = test_api_key(req.api_key)
    return {"ok": ok, "message": msg}


@app.post("/sessions/{session_id}/finalize")
async def finalize_session(
    session_id: str,
    audio: UploadFile = File(...),
    participants: str = Form("[]"),
    title: Optional[str] = Form(None),
    x_anthropic_api_key: Optional[str] = Header(None, alias="X-Anthropic-Api-Key"),
):
    sd = session_dir(session_id)
    meta_path = sd / "meta.json"
    if not meta_path.exists():
        raise HTTPException(status_code=404, detail="session not found")

    meta = read_json(meta_path)
    meta["status"] = "processing"
    meta["title"] = title or session_id
    write_json(meta_path, meta)

    # 1. save uploaded audio. The Blob's MIME type from MediaRecorder is usually
    #    "audio/webm;codecs=opus" but the extension+round-trip can erase it; we
    #    don't actually care, ffmpeg sniffs the format.
    ct = (audio.content_type or "").lower()
    if "webm" in ct:
        audio_ext = ".webm"
    elif "ogg" in ct:
        audio_ext = ".ogg"
    else:
        audio_ext = ".webm"  # default — MediaRecorder default is webm/opus
    audio_path = sd / f"audio{audio_ext}"
    with audio_path.open("wb") as f:
        while chunk := await audio.read(1024 * 1024):
            f.write(chunk)

    # 2. parse participants list (names from the Meet participants panel,
    #    optionally edited by the user before clicking Stop)
    try:
        participants_list = json.loads(participants)
        if not isinstance(participants_list, list):
            raise ValueError("participants must be a JSON list of strings")
    except (json.JSONDecodeError, ValueError) as e:
        raise HTTPException(status_code=400, detail=f"invalid participants JSON: {e}")
    write_json(sd / "participants.json", participants_list)

    try:
        # 3. convert to wav
        wav_path = sd / "audio.wav"
        convert_to_wav(audio_path, wav_path)

        # 3a. silence guard — refuse to transcribe pure silence so whisper
        # can't hallucinate phrases into the output.
        volume = measure_volume(wav_path)
        write_json(sd / "volume.json", volume)
        if (
            volume["mean_db"] <= SILENCE_MEAN_DB_THRESHOLD
            and volume["max_db"] <= SILENCE_MAX_DB_THRESHOLD
        ):
            raise RuntimeError(silence_diagnostic(volume))

        # 4. run whisper
        whisper_out_prefix = sd / "whisper"
        whisper_json = run_whisper(wav_path, whisper_out_prefix)
        segments = normalize_whisper_segments(whisper_json)
        write_json(sd / "segments.json", segments)

        # 5. merge into reading-friendly blocks (no speaker labels yet — Claude attributes)
        blocks = segments_to_blocks(segments)
        write_json(sd / "transcript.json", blocks)

        # 6. summarize with Claude. The key from the extension header takes
        #    precedence; falls back to ANTHROPIC_API_KEY env var for CLI/dev use.
        summary_md = summarize_with_claude(
            blocks=blocks,
            participants=participants_list,
            title=meta["title"],
            api_key=x_anthropic_api_key,
        )
        (sd / "summary.md").write_text(summary_md)

        meta["status"] = "done"
        meta["participants"] = participants_list
        meta["finalized_at"] = time.time()
        write_json(meta_path, meta)

        return {
            "id": session_id,
            "title": meta["title"],
            "participants": participants_list,
            "transcript": blocks,
            "summary_md": summary_md,
        }
    except Exception as e:
        meta["status"] = "error"
        meta["error"] = str(e)
        write_json(meta_path, meta)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/sessions/{session_id}")
def get_session(session_id: str):
    sd = DATA_DIR / session_id
    if not sd.exists():
        raise HTTPException(status_code=404, detail="session not found")
    meta = read_json(sd / "meta.json")
    out = {"meta": meta}
    if (sd / "transcript.json").exists():
        out["transcript"] = read_json(sd / "transcript.json")
    if (sd / "summary.md").exists():
        out["summary_md"] = (sd / "summary.md").read_text()
    return out


@app.get("/sessions")
def list_sessions():
    sessions = []
    for d in sorted(DATA_DIR.iterdir(), reverse=True):
        if not d.is_dir():
            continue
        meta_path = d / "meta.json"
        if meta_path.exists():
            sessions.append(read_json(meta_path))
    return {"sessions": sessions}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("MINUTES_PORT", "8765"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
