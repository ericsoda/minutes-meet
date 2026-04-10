// Minutes — service worker.
//
// Coordinates: tab capture (handed off to an offscreen document), the content
// script that scrapes participant names, and the local helper at 127.0.0.1.

const HELPER_BASE = "http://127.0.0.1:8765";

// In-memory state. The service worker may sleep, but while recording is in
// progress the offscreen document keeps it alive.
let state = {
  recording: false,
  sessionId: null,
  meetTabId: null,
  startedAt: null,
  participants: [], // names scraped from the Meet participant panel
  lastResult: null,
  lastError: null,
};

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
    recording: true,
    sessionId: id,
    meetTabId,
    startedAt: Date.now(),
    participants: initialParticipants,
    lastResult: null,
    lastError: null,
  };
  await chrome.storage.session.set({ state });
}

async function stopRecording() {
  if (!state.recording) throw new Error("not recording");

  // Refresh participants from the content script one last time — people may
  // have joined late.
  try {
    const resp = await chrome.tabs.sendMessage(state.meetTabId, { type: "minutes:getParticipants" });
    if (resp?.participants?.length) {
      // Union with anything we already had.
      const merged = new Set([...(state.participants || []), ...resp.participants]);
      state.participants = [...merged];
    }
  } catch (_) {}

  // Stop the offscreen recorder and get the audio blob (as base64 over message).
  const stopResp = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "minutes:offscreen:stop",
  });
  await closeOffscreen();

  if (!stopResp?.ok) {
    state.recording = false;
    state.lastError = "offscreen stop failed: " + (stopResp?.error || "unknown");
    await chrome.storage.session.set({ state });
    throw new Error(state.lastError);
  }

  // Decode base64 → Blob and POST to the helper.
  const bytes = Uint8Array.from(atob(stopResp.audioBase64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: stopResp.mimeType || "audio/webm" });

  const tab = await chrome.tabs.get(state.meetTabId).catch(() => null);
  const title = tab?.title?.replace(/ - Google Meet.*$/, "").trim() || `Meeting ${state.sessionId}`;

  const fd = new FormData();
  fd.append("audio", blob, "audio.webm");
  fd.append("participants", JSON.stringify(state.participants || []));
  fd.append("title", title);

  // Pull the API key from chrome.storage and pass it as a header. The helper
  // uses it for this one Claude call and never persists it.
  const stored = await chrome.storage.local.get("anthropicApiKey");
  const apiKey = stored?.anthropicApiKey || "";
  const headers = apiKey ? { "X-Anthropic-Api-Key": apiKey } : {};

  const finalize = await fetch(`${HELPER_BASE}/sessions/${state.sessionId}/finalize`, {
    method: "POST",
    headers,
    body: fd,
  });
  if (!finalize.ok) {
    const txt = await finalize.text();
    state.recording = false;
    state.lastError = `finalize failed: ${finalize.status} ${txt}`;
    await chrome.storage.session.set({ state });
    throw new Error(state.lastError);
  }

  const result = await finalize.json();
  state.recording = false;
  state.lastResult = result;
  await chrome.storage.session.set({ state });
  return result;
}

// ---------- message handling ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Forward messages tagged for the offscreen doc — those are handled in offscreen.js,
  // not here. We only respond to messages targeted at "background" or untagged.
  if (msg?.target === "offscreen") return;

  if (msg?.type === "minutes:participantsUpdate") {
    // Sent by content script as the participant panel changes.
    if (state.recording) {
      const merged = new Set([...(state.participants || []), ...(msg.participants || [])]);
      state.participants = [...merged];
      chrome.storage.session.set({ state });
    }
    return;
  }

  if (msg?.type === "minutes:popup:getState") {
    sendResponse({ state });
    return;
  }

  if (msg?.type === "minutes:popup:start") {
    (async () => {
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab?.url?.startsWith("https://meet.google.com/")) {
          throw new Error("Open a Google Meet tab first.");
        }
        await startRecording(activeTab.id);
        sendResponse({ ok: true, state });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  if (msg?.type === "minutes:popup:stop") {
    (async () => {
      try {
        const result = await stopRecording();
        sendResponse({ ok: true, result, state });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e), state });
      }
    })();
    return true;
  }

  if (msg?.type === "minutes:popup:setParticipants") {
    state.participants = msg.participants || [];
    chrome.storage.session.set({ state });
    sendResponse({ ok: true });
    return;
  }
});

// Restore state on service worker wake.
chrome.storage.session.get("state").then((stored) => {
  if (stored?.state) state = { ...state, ...stored.state };
});
