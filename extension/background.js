// Minutes — service worker.
//
// Coordinates: tab capture (handed off to an offscreen document), the content
// script that scrapes participant names, and the local helper at 127.0.0.1.
//
// State machine: idle → recording → processing → idle. The audio itself never
// passes through here — the offscreen document uploads it straight to the
// helper — so this worker only orchestrates.

const HELPER_BASE = "http://127.0.0.1:8765";

function defaultState() {
  return {
    phase: "idle", // "idle" | "recording" | "processing"
    sessionId: null,
    meetTabId: null,
    startedAt: null,
    participants: [], // names scraped from the Meet participant panel
    participantsEdited: false, // user edited the list — stop merging scrapes in
    title: null,
    canRetry: false, // audio is on the helper's disk; processing can be re-run
    lastResult: null,
    lastError: null,
  };
}

let state = defaultState();

// Restore state on service worker wake. Message handlers await this promise —
// a message can arrive before the storage read resolves, and acting on the
// blank default state would strand an in-flight recording.
const stateReady = chrome.storage.session.get("state").then((stored) => {
  if (stored?.state) state = { ...defaultState(), ...stored.state };
});

function saveState() {
  return chrome.storage.session.set({ state });
}

// ---------- offscreen plumbing ----------

async function ensureOffscreen() {
  const url = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url,
    reasons: ["USER_MEDIA"],
    justification: "Recording the active Google Meet tab's audio for local transcription.",
  });
}

async function closeOffscreen() {
  try {
    await chrome.offscreen.closeDocument();
  } catch (_) {}
}

// ---------- recording lifecycle ----------

async function startRecording(meetTabId) {
  // Pull current participants from the content script before we start, so the
  // popup has something to show immediately.
  let initialParticipants = [];
  try {
    const resp = await chrome.tabs.sendMessage(meetTabId, { type: "minutes:getParticipants" });
    initialParticipants = resp?.participants || [];
  } catch (_) {
    // Content script may not be loaded yet — that's fine, we'll refresh on stop.
  }

  // Create a session on the local helper.
  const r = await fetch(`${HELPER_BASE}/sessions`, { method: "POST" });
  if (!r.ok) throw new Error(`helper /sessions failed: ${r.status}`);
  const { id } = await r.json();

  // Set up the offscreen document for recording.
  await ensureOffscreen();

  // Get a stream ID for the Meet tab. The offscreen document will use this
  // to call getUserMedia and pull the audio.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: meetTabId });

  // Tell the offscreen doc to start. It will reply when MediaRecorder is running.
  const startResp = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "minutes:offscreen:start",
    streamId,
  });
  if (!startResp?.ok) {
    await closeOffscreen();
    throw new Error("offscreen failed to start: " + (startResp?.error || "unknown"));
  }

  state = {
    ...defaultState(),
    phase: "recording",
    sessionId: id,
    meetTabId,
    startedAt: Date.now(),
    participants: initialParticipants,
  };
  await saveState();
}

async function processSession() {
  const stored = await chrome.storage.local.get("anthropicApiKey");
  const apiKey = stored?.anthropicApiKey || "";
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["X-Anthropic-Api-Key"] = apiKey;

  const r = await fetch(`${HELPER_BASE}/sessions/${state.sessionId}/process`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      participants: state.participants || [],
      title: state.title,
    }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`processing failed: ${r.status} ${txt}`);
  }
  return r.json();
}

async function stopRecording() {
  if (state.phase !== "recording") throw new Error("not recording");

  // Refresh participants from the content script one last time — people may
  // have joined late. Skip if the user hand-edited the list: merging scrapes
  // back in would resurrect names they deliberately removed.
  if (!state.participantsEdited) {
    try {
      const resp = await chrome.tabs.sendMessage(state.meetTabId, { type: "minutes:getParticipants" });
      if (resp?.participants?.length) {
        const merged = new Set([...(state.participants || []), ...resp.participants]);
        state.participants = [...merged];
      }
    } catch (_) {}
  }

  const tab = await chrome.tabs.get(state.meetTabId).catch(() => null);
  state.title =
    tab?.title?.replace(/ - Google Meet.*$/, "").trim() || `Meeting ${state.sessionId}`;

  state.phase = "processing";
  await saveState();

  // Stop the offscreen recorder. It uploads the audio to the helper itself.
  const stopResp = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "minutes:offscreen:stop",
    sessionId: state.sessionId,
  });
  await closeOffscreen();

  if (!stopResp?.ok) {
    // Recording never made it to disk — nothing to retry from.
    state.phase = "idle";
    state.lastError = "recording failed: " + (stopResp?.error || "unknown");
    await saveState();
    throw new Error(state.lastError);
  }

  // Audio is safe on disk from here on — any processing failure is retryable.
  state.canRetry = true;
  await saveState();
  return runProcessing();
}

async function runProcessing() {
  try {
    const result = await processSession();
    state.phase = "idle";
    state.lastResult = result;
    state.lastError = null;
    state.canRetry = false;
    await saveState();
    return result;
  } catch (e) {
    state.phase = "idle";
    state.lastError = String(e?.message || e);
    await saveState();
    throw e;
  }
}

// ---------- message handling ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Messages tagged for the offscreen doc are handled in offscreen.js.
  if (msg?.target === "offscreen") return;

  (async () => {
    await stateReady;

    if (msg?.type === "minutes:participantsUpdate") {
      // Sent by content script as the participant panel changes.
      if (state.phase === "recording" && !state.participantsEdited) {
        const merged = new Set([...(state.participants || []), ...(msg.participants || [])]);
        state.participants = [...merged];
        await saveState();
      }
      return;
    }

    if (msg?.type === "minutes:popup:getState") {
      sendResponse({ state });
      return;
    }

    if (msg?.type === "minutes:popup:setParticipants") {
      state.participants = msg.participants || [];
      state.participantsEdited = true;
      await saveState();
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "minutes:popup:start") {
      try {
        if (state.phase !== "idle") throw new Error(`cannot start while ${state.phase}`);
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab?.url?.startsWith("https://meet.google.com/")) {
          throw new Error("Open a Google Meet tab first.");
        }
        await startRecording(activeTab.id);
        sendResponse({ ok: true, state });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
      return;
    }

    if (msg?.type === "minutes:popup:stop") {
      try {
        const result = await stopRecording();
        sendResponse({ ok: true, result, state });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e), state });
      }
      return;
    }

    if (msg?.type === "minutes:popup:retry") {
      try {
        if (!state.canRetry || !state.sessionId) throw new Error("nothing to retry");
        state.phase = "processing";
        state.lastError = null;
        await saveState();
        const result = await runProcessing();
        sendResponse({ ok: true, result, state });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e), state });
      }
      return;
    }
  })();

  // All popup messages are answered asynchronously.
  return true;
});
