"""
Whisper produces many short segments. We merge consecutive segments into
larger reading-friendly blocks based on time gaps and length, then hand them
to Claude (which does the speaker attribution from context).
"""

from __future__ import annotations

# A new block starts if there's a silence gap longer than this.
GAP_BREAK_MS = 1500
# Or if the current block is already this long (so blocks stay readable).
MAX_BLOCK_CHARS = 600


def segments_to_blocks(segments: list[dict]) -> list[dict]:
    blocks: list[dict] = []
    for seg in segments:
        if not blocks:
            blocks.append({"t0_ms": seg["t0_ms"], "t1_ms": seg["t1_ms"], "text": seg["text"]})
            continue
        last = blocks[-1]
        gap = seg["t0_ms"] - last["t1_ms"]
        too_long = len(last["text"]) > MAX_BLOCK_CHARS
        if gap > GAP_BREAK_MS or too_long:
            blocks.append({"t0_ms": seg["t0_ms"], "t1_ms": seg["t1_ms"], "text": seg["text"]})
        else:
            last["t1_ms"] = seg["t1_ms"]
            last["text"] = (last["text"] + " " + seg["text"]).strip()
    return blocks
