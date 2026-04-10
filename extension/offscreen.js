// Minutes — offscreen recorder.
//
// MV3 service workers can't use MediaRecorder directly, so the actual audio
// recording happens here in an offscreen document.
//
// We capture TWO streams and mix them:
//   1. The Meet tab's audio (via chrome.tabCapture stream ID) — this is what
//      the OTHER participants are saying. Tab capture cannot record your
//      microphone; it only sees what the tab plays through speakers.
//   2. Your microphone (via getUserMedia({audio: true})) — this is YOU.
//
// Without (2), a meeting where you talk a lot would record as silence on
// your end. Without (1), you'd hear nothing the others said.
//
// IMPORTANT: chrome.tabCapture removes the tab's audio from the speakers
// while it's capturing. We re-route ONLY the tab stream back to speakers
// through an AudioContext so the meeting stays audible. We do NOT route the
// mic to speakers — that would create echo (you hearing yourself).

let tabStream = null;
let micStream = null;
let audioCtx = null;
let mediaRecorder = null;
let chunks = [];
let mimeType = "audio/webm";
let warnings = [];

function pickMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

async function getTabStream(streamId) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });
}

async function getMicStream() {
  // Standard mic capture. The popup pre-grants the permission so this
  // doesn't have to prompt from the offscreen document (which can't show UI).
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
}

async function start(streamId) {
  if (mediaRecorder) {
    throw new Error("recorder is already running");
  }
  warnings = [];

  // 1. Tab capture (other participants).
  try {
    tabStream = await getTabStream(streamId);
  } catch (e) {
    throw new Error("tab capture failed: " + (e?.message || e));
  }

  // 2. Microphone (you). Best-effort: if it fails, record tab-only and warn.
  try {
    micStream = await getMicStream();
  } catch (e) {
    warnings.push(
      "microphone access denied — only the other participants will be recorded. " +
      "Grant mic permission to chrome-extension://" + chrome.runtime.id + " in chrome://settings/content/microphone"
    );
    micStream = null;
  }

  // 3. Mix tab + mic into a single MediaStream via Web Audio.
  audioCtx = new AudioContext();
  const dest = audioCtx.createMediaStreamDestination();

  const tabSource = audioCtx.createMediaStreamSource(tabStream);
  tabSource.connect(dest);
  // Re-route tab audio back to speakers so the meeting stays audible.
  tabSource.connect(audioCtx.destination);

  if (micStream) {
    const micSource = audioCtx.createMediaStreamSource(micStream);
    micSource.connect(dest);
    // Do NOT connect micSource to audioCtx.destination — that would echo.
  }

  // 4. Record the mixed stream.
  mimeType = pickMimeType();
  mediaRecorder = new MediaRecorder(
    dest.stream,
    mimeType ? { mimeType, audioBitsPerSecond: 128_000 } : undefined,
  );
  chunks = [];
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  mediaRecorder.start(1000);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function stop() {
  if (!mediaRecorder) {
    throw new Error("recorder is not running");
  }
  const finished = new Promise((resolve) => {
    mediaRecorder.onstop = () => resolve();
  });
  mediaRecorder.stop();
  await finished;

  // Tear down all streams and audio context.
  if (tabStream) for (const t of tabStream.getTracks()) t.stop();
  if (micStream) for (const t of micStream.getTracks()) t.stop();
  try { await audioCtx.close(); } catch (_) {}
  tabStream = null;
  micStream = null;
  audioCtx = null;

  const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
  chunks = [];
  mediaRecorder = null;

  const audioBase64 = await blobToBase64(blob);
  return {
    audioBase64,
    mimeType: mimeType || "audio/webm",
    byteLength: blob.size,
    warnings,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== "offscreen") return;

  if (msg.type === "minutes:offscreen:start") {
    start(msg.streamId)
      .then(() => sendResponse({ ok: true, warnings }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (msg.type === "minutes:offscreen:stop") {
    stop()
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
});
