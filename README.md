# Minutes

A self-served meeting notetaker for Google Meet. Local transcription, per-participant summaries, no SaaS account, no scope creep.

- **Records** the active Google Meet tab — both the other participants (via tab capture) and your own microphone — and mixes them into a single audio stream
- **Transcribes** the audio locally with [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (`large-v3-turbo` model). Audio never leaves your machine.
- **Summarizes per participant** by sending the transcript to Claude with the list of participant names from the Meet UI. Claude attributes lines to speakers from context and writes a section per person you can lift verbatim into your notes.
- **Copy buttons** on the summary and the full transcript

The only outbound network call is to the Anthropic API for the summary. You bring your own API key.

## Why

Existing notetaker bots (MeetGreet, Fireflies, Otter, etc.) are bloated, scope-creeped beyond usefulness, and bury individual participant updates inside walls of "AI insights." Minutes does one thing: produces a per-participant summary that each person could lift verbatim as their own status update.

No "decisions captured," no sentiment analysis, no follow-up emails, no integrations, no team workspace. Just a per-participant section, action items, and copy buttons.

## Requirements

- macOS with Apple Silicon (Intel works but slower)
- [Homebrew](https://brew.sh)
- Google Chrome (or any Chromium-based browser with extension support)
- An Anthropic API key — get one at [console.anthropic.com](https://console.anthropic.com/settings/keys). Summaries cost roughly $0.01–0.05 per meeting on Claude Sonnet.

## Install

### 1. Clone the repo

```sh
git clone https://github.com/ericsoda/minutes-meet.git ~/projects/minutes-meet
cd ~/projects/minutes-meet
```

### 2. Run the setup script

```sh
./bin/setup.sh
```

This installs `whisper-cpp` and `ffmpeg` via Homebrew, downloads the whisper model (~1.5 GB), creates a Python venv, and installs the helper's dependencies.

### 3. Start the helper

```sh
cd helper
./run.sh
```

The helper runs a small FastAPI server on `http://127.0.0.1:8765` (loopback only — never reachable from anywhere except your own machine). Leave this running while you use Minutes.

### 4. Load the Chrome extension

1. Open `chrome://extensions` in Chrome
2. Toggle **Developer mode** on (top-right corner)
3. Click **Load unpacked**
4. Pick the `extension/` folder from this repo
5. Pin the **Minutes** icon to the toolbar (puzzle piece → pin icon next to Minutes)

### 5. Set your Anthropic API key

1. Click the **Minutes** icon
2. The popup will show a setup screen asking for your API key
3. Paste your key (starts with `sk-ant-...`) and click **Save & verify** — Minutes makes a tiny test call to confirm the key is valid before saving
4. Done. The key is stored in Chrome's profile storage on your machine and sent to the local helper as a request header on each meeting. It's never written to disk.

### 6. Grant microphone access

The first time you click **Start recording**, Minutes opens a tab asking you to grant microphone access. Click **Allow**.

> **Note:** Microphone permission for `meet.google.com` is *separate* from microphone permission for the Minutes extension. They have to be granted independently. Tab capture only records the *other* participants — your own voice has to come from your mic.

## Usage

1. Join a Google Meet call as you normally would
2. Click the **Minutes** icon → click **Start recording**
3. The popup shows the participant names scraped from the Meet UI. Edit them if anything's wrong.
4. (You can close the popup — recording continues in the background)
5. When the meeting ends, click the icon again → **Stop & transcribe**
6. Wait for whisper to transcribe locally (faster than realtime on Apple Silicon — a 30-minute meeting takes 3–5 min) and Claude to write the summary
7. Click **Copy summary** or **Copy transcript** to put it on your clipboard

### What you get

The summary follows this exact shape:

```markdown
# Meeting title

## Participants
- Names of people who actually spoke

## Per-participant summary

### Alice
- 2-6 bullets of what Alice said: status updates, questions, commitments
- Each bullet stands alone — Alice could lift this section into her notes

### Bob
- ...

## Action items
- [ ] Alice: ship the auth fix
- [ ] Bob: review the migration PR
```

## Output files

Each session lands in `data/<timestamp>-<id>/`:

| File | Contents |
|------|----------|
| `audio.webm` | Original captured audio (mic + tab, mixed) |
| `whisper.json` | Raw whisper.cpp output |
| `segments.json` | Normalized whisper segments |
| `transcript.json` | Merged reading-friendly blocks |
| `participants.json` | Names from the Meet UI (and your edits) |
| `volume.json` | Audio level stats for the silence guard |
| `summary.md` | Per-participant summary written by Claude |
| `meta.json` | Session metadata |

The popup shows the summary and the transcript and gives you copy buttons. If you want anything else, pull it from `data/<id>/`.

The intermediate 16 kHz WAV that whisper reads (~90 MB per meeting) is deleted after processing — it's always recreatable from `audio.webm`. Sessions that were started but never recorded into are garbage-collected after a day.

## Troubleshooting

**The popup says "Could not reach the helper."**
The helper isn't running. Open a terminal: `cd ~/projects/minutes-meet/helper && ./run.sh`

**"Recording was effectively silent."**
Microphone permission for the *extension* isn't actually granted. Open `chrome://settings/content/microphone`, find the Minutes extension, set it to Allow. Then click **Start recording** again — you'll get the grant tab if needed.

**Participant names look wrong or empty.**
Google Meet ships UI changes every few months that break DOM scrapers. Edit the names by hand in the popup before you click **Stop**. Claude only uses the names for attribution — it doesn't matter where they came from.

**No audio in the meeting after clicking Start.**
The offscreen recorder re-routes captured tab audio back through an `AudioContext` so the meeting stays audible. If this fails for some reason, refresh the Meet tab and start again.

**Whisper produces "Thank you" or "Thanks for watching" as the entire transcript.**
This is whisper hallucinating on silent audio (a known YouTube training-data artifact). The helper has a silence guard that should catch this and return a clear error instead. If you see this happen anyway, file an issue with the contents of `data/<id>/volume.json`.

**Transcription or the summary failed after the meeting.**
The recording itself is already safe on disk — the audio is uploaded to the helper *before* any processing starts. Fix whatever broke (helper down, Claude outage, bad key) and click **Retry processing** in the popup. Nothing is lost.

**I closed the Meet tab before clicking Stop.**
Also fine. The recorder finalizes the audio the moment the tab closes; click **Stop & transcribe** whenever and you'll get everything up to that point.

## Architecture

```
┌─────────────────┐         ┌─────────────────┐         ┌──────────────┐
│  Chrome ext     │         │  Local helper   │         │  Anthropic   │
│  (MV3, ~250KB)  │  HTTP   │  (Python, 8765) │  HTTPS  │  API         │
│                 │ ──────► │                 │ ──────► │              │
│  - tab capture  │         │  - whisper.cpp  │         │  Claude      │
│  - mic capture  │         │  - silence guard│         │  Sonnet      │
│  - audio mixer  │         │  - alignment    │         │              │
│  - DOM scraper  │         │  - summarizer   │         │              │
│  - popup UI     │         │                 │         │              │
└─────────────────┘         └─────────────────┘         └──────────────┘
       │                              │
       │                              ▼
       │                       data/<session>/
       │                       (audio + transcript + summary)
       │
       ▼
  chrome.storage.local
  (your API key)
```

### Design notes

- **Local transcription** because paying per-minute for what whisper.cpp does for free is silly, and your meetings shouldn't go to a third party.
- **Mic + tab audio mixing** because tab capture only records what the tab plays through speakers (the other participants). Without your mic, you'd be silent in your own recording.
- **Claude does speaker attribution from context**, not DOM-based active-speaker tracking. The DOM approach is fragile — Meet ships UI changes that break selectors. Claude is excellent at attributing lines using name cues that appear naturally in real status meetings ("Alice, your turn"). The participant-name scraper only needs to identify *who's in the meeting*, which is a much more stable surface.
- **Per-participant sections that stand alone** because the original problem is that existing tools bury individual updates inside walls of generic "AI insights." Each section here is something a person could lift directly as their own status update.
- **API key in `chrome.storage.local`, sent per-request** so the helper never persists secrets to disk.
- **Audio uploads before processing starts.** The offscreen recorder POSTs the blob straight to the helper the moment recording stops (routing it through the service worker as a message would hit Chrome's ~64 MB limit on long meetings). Once it's on disk, transcription and summarization are a separate, retryable step.

## Cost

- Transcription: $0 (local whisper.cpp)
- Summarization: typically $0.01–0.05 per meeting on Claude Sonnet, depending on length

## License

MIT — see [LICENSE](LICENSE).

## Contributing

It's a personal tool, but PRs that fix bugs or improve the participant scraper for newer Meet UI revs are welcome. Please don't open PRs that add features beyond the scope above — the whole point is *not* to scope-creep this thing.
