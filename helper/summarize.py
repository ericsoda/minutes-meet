"""
Summarize a meeting transcript with Claude.

The transcript blocks have timestamps but no speaker labels. We give Claude
the list of participants from the Meet UI and ask it to (1) attribute lines
to speakers from context, and (2) produce a per-participant summary.
"""

from __future__ import annotations

import os

from anthropic import Anthropic

MODEL = "claude-sonnet-5"


SYSTEM_PROMPT = """\
You summarize meeting transcripts produced by a local speech-to-text engine.

The transcript has TIMESTAMPS but NO speaker labels. You will also be given
the list of participants who were in the meeting (scraped from the video call's
participant panel). Your job is two-fold:

1. Attribute lines to speakers from context — people address each other by name
   ("Alice, your turn"), refer to themselves ("I shipped the auth fix"), or
   answer questions directed at them. Use these cues. When you cannot tell with
   reasonable confidence, attribute to "Unknown" rather than guessing.

2. Produce a markdown document with this exact structure (and nothing else):

# {title}

## Participants
- One bullet per participant who actually spoke, in the order they first spoke.
- If a listed participant never spoke, omit them.

## Per-participant summary

### {Participant name}
- 2 to 6 bullets capturing what THIS PERSON said: status updates, questions, \
commitments, opinions, blockers. Each bullet should be a complete thought a \
reader could lift directly into their own notes.
- Lead with substance. Skip filler ("um, yeah, so basically...").
- Use the participant's actual phrasing where it's vivid; paraphrase where \
it's rambling.
- If a participant barely spoke, write a single bullet saying so. Do not pad.

### {Next participant}
...

## Action items
- [ ] {Owner}: {action} — only items that were explicitly stated or clearly \
implied. If there are none, omit this section entirely.

Hard rules:
- Be faithful to the transcript. Never invent facts, names, dates, or numbers.
- Each per-participant section must stand alone — someone reading only their \
own section should understand what they reported and committed to.
- Skip pleasantries, audio artifacts, and side chatter.
- Output the markdown only. No preamble, no postscript, no "here is your summary".
"""


def format_ts(ms: int) -> str:
    s = ms // 1000
    return f"{s // 60:02d}:{s % 60:02d}"


def format_transcript_for_claude(blocks: list[dict]) -> str:
    lines = []
    for b in blocks:
        lines.append(f"[{format_ts(b['t0_ms'])}] {b['text']}")
    return "\n".join(lines)


def summarize_with_claude(
    blocks: list[dict],
    participants: list[str],
    title: str,
    api_key: str | None = None,
) -> str:
    """
    The api_key parameter takes precedence over the ANTHROPIC_API_KEY env var,
    so the Chrome extension can hold the user's key in chrome.storage and
    pass it on each request without the helper persisting it to disk.
    """
    key = api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise RuntimeError(
            "No Anthropic API key provided. Set one in the Minutes popup, "
            "or export ANTHROPIC_API_KEY before starting the helper."
        )

    transcript_text = format_transcript_for_claude(blocks)
    participants_text = (
        "\n".join(f"- {p}" for p in participants)
        if participants
        else "(none provided — do your best from context)"
    )
    user_message = (
        f"Title: {title}\n\n"
        f"Participants in the meeting:\n{participants_text}\n\n"
        f"Transcript:\n{transcript_text}"
    )

    client = Anthropic(api_key=key)
    response = client.messages.create(
        model=MODEL,
        max_tokens=8192,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_message}],
    )
    if response.stop_reason == "max_tokens":
        raise RuntimeError(
            "Claude hit the output token limit mid-summary — the summary would "
            "be truncated. This meeting is unusually long; raise max_tokens in "
            "summarize.py and retry processing."
        )
    for block in response.content:
        if getattr(block, "type", None) == "text":
            return block.text
    return ""


def test_api_key(api_key: str) -> tuple[bool, str]:
    """
    Make a tiny throwaway call to validate a key. Returns (ok, message).
    Used by the popup's setup screen so users find out about typos
    immediately, not after a 30-minute meeting.
    """
    if not api_key or not api_key.startswith("sk-ant-"):
        return False, "Key should start with 'sk-ant-'."
    try:
        client = Anthropic(api_key=api_key)
        client.messages.create(
            model=MODEL,
            max_tokens=8,
            messages=[{"role": "user", "content": "Reply with the word OK."}],
        )
        return True, "Key works."
    except Exception as e:
        return False, str(e)
