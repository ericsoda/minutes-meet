// Minutes — popup UI.

const HELPER_BASE = "http://127.0.0.1:8765";

const els = {
  status: document.getElementById("status"),
  settingsBtn: document.getElementById("settings-btn"),

  setupSection: document.getElementById("setup-section"),
  apiKeyInput: document.getElementById("api-key-input"),
  saveKeyBtn: document.getElementById("save-key-btn"),
  cancelSetupBtn: document.getElementById("cancel-setup-btn"),
  setupStatus: document.getElementById("setup-status"),

  controlSection: document.getElementById("control"),
  startBtn: document.getElementById("start-btn"),
  stopBtn: document.getElementById("stop-btn"),
  hint: document.getElementById("hint"),

  participantsSection: document.getElementById("participants-section"),
  participantsEdit: document.getElementById("participants-edit"),

  resultSection: document.getElementById("result-section"),
  summaryMd: document.getElementById("summary-md"),
  transcript: document.getElementById("transcript"),
  copySummary: document.getElementById("copy-summary"),
  copyTranscript: document.getElementById("copy-transcript"),

  errorSection: document.getElementById("error-section"),
  errorText: document.getElementById("error-text"),
};

function setStatus(label, cls) {
  els.status.textContent = label;
  els.status.className = "status " + cls;
}

function showError(msg) {
  els.errorSection.hidden = false;
  els.errorText.textContent = msg;
}
function clearError() {
  els.errorSection.hidden = true;
  els.errorText.textContent = "";
}

function formatTs(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function renderTranscript(blocks) {
  els.transcript.innerHTML = "";
  for (const b of blocks || []) {
    const line = document.createElement("div");
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = `[${formatTs(b.t0_ms)}]`;
    line.appendChild(ts);
    line.appendChild(document.createTextNode(b.text));
    els.transcript.appendChild(line);
  }
}

// ---------- API key storage ----------

async function getStoredApiKey() {
  const out = await chrome.storage.local.get("anthropicApiKey");
  return out?.anthropicApiKey || "";
}

async function setStoredApiKey(key) {
  await chrome.storage.local.set({ anthropicApiKey: key });
}

// ---------- screen state ----------

function showSetup({ withCancel = false } = {}) {
  els.setupSection.hidden = false;
  els.controlSection.hidden = true;
  els.participantsSection.hidden = true;
  els.resultSection.hidden = true;
  els.cancelSetupBtn.hidden = !withCancel;
  els.setupStatus.textContent = "";
  els.setupStatus.className = "setup-status";
}

function hideSetup() {
  els.setupSection.hidden = true;
  els.controlSection.hidden = false;
}

// ---------- mic permission (separate from API key) ----------

async function ensureMicPermission() {
  try {
    const p = await navigator.permissions.query({ name: "microphone" });
    if (p.state === "granted") return true;
  } catch (_) {}

  const url = chrome.runtime.getURL("grant-mic.html");
  await chrome.tabs.create({ url });
  showError(
    "Microphone access for this extension is not granted yet. A new tab " +
    "just opened — click 'Grant microphone access' there, then come back " +
    "and click Start again.\n\n" +
    "Note: mic permission for meet.google.com is SEPARATE from mic permission " +
    "for this extension. They have to be granted independently."
  );
  return false;
}

// ---------- main render ----------

async function refreshState() {
  const storedKey = await getStoredApiKey();
  if (!storedKey) {
    // First run, or user cleared the key. Force the setup screen.
    showSetup({ withCancel: false });
    return;
  }

  hideSetup();

  const resp = await chrome.runtime.sendMessage({ type: "minutes:popup:getState" });
  const state = resp?.state || {};

  if (state.recording) {
    setStatus("recording", "recording");
    els.startBtn.hidden = true;
    els.stopBtn.hidden = false;
    els.hint.textContent =
      "Recording the active Meet tab. You can close this popup — recording continues.";
    els.participantsSection.hidden = false;
    els.participantsEdit.value = (state.participants || []).join("\n");
    els.resultSection.hidden = true;
  } else if (state.lastResult) {
    setStatus("done", "done");
    els.startBtn.hidden = false;
    els.stopBtn.hidden = true;
    els.startBtn.textContent = "Start new recording";
    els.hint.textContent = "";
    els.participantsSection.hidden = true;
    els.resultSection.hidden = false;
    els.summaryMd.textContent = state.lastResult.summary_md || "(empty)";
    renderTranscript(state.lastResult.transcript);
  } else {
    setStatus("idle", "idle");
    els.startBtn.hidden = false;
    els.stopBtn.hidden = true;
    els.hint.textContent = "Open a Google Meet tab and click Start.";
    els.participantsSection.hidden = true;
    els.resultSection.hidden = true;
  }

  if (state.lastError) showError(state.lastError);
}

// ---------- handlers ----------

els.settingsBtn.addEventListener("click", async () => {
  // Pre-fill the input (shown as password dots) so the user can verify or change.
  els.apiKeyInput.value = await getStoredApiKey();
  showSetup({ withCancel: true });
});

els.cancelSetupBtn.addEventListener("click", () => {
  refreshState();
});

els.saveKeyBtn.addEventListener("click", async () => {
  const key = els.apiKeyInput.value.trim();
  if (!key) {
    els.setupStatus.textContent = "Please paste your API key.";
    els.setupStatus.className = "setup-status err";
    return;
  }
  els.saveKeyBtn.disabled = true;
  els.setupStatus.textContent = "Verifying key with Anthropic…";
  els.setupStatus.className = "setup-status";

  try {
    const r = await fetch(`${HELPER_BASE}/test-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key }),
    });
    if (!r.ok) throw new Error(`helper /test-key returned ${r.status}`);
    const result = await r.json();
    if (!result.ok) {
      els.setupStatus.textContent = "Key rejected: " + result.message;
      els.setupStatus.className = "setup-status err";
      return;
    }
    await setStoredApiKey(key);
    els.setupStatus.textContent = "Key verified and saved.";
    els.setupStatus.className = "setup-status ok";
    setTimeout(() => refreshState(), 700);
  } catch (e) {
    els.setupStatus.textContent =
      "Could not reach the helper. Make sure it's running:\n" +
      "  cd ~/projects/minutes-meet/helper && ./run.sh\n\n" +
      (e?.message || e);
    els.setupStatus.className = "setup-status err";
  } finally {
    els.saveKeyBtn.disabled = false;
  }
});

els.startBtn.addEventListener("click", async () => {
  clearError();
  els.startBtn.disabled = true;

  const ok = await ensureMicPermission();
  if (!ok) {
    els.startBtn.disabled = false;
    return;
  }

  const resp = await chrome.runtime.sendMessage({ type: "minutes:popup:start" });
  els.startBtn.disabled = false;
  if (!resp?.ok) {
    showError(resp?.error || "failed to start");
    return;
  }
  await refreshState();
});

els.stopBtn.addEventListener("click", async () => {
  clearError();
  const edited = els.participantsEdit.value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  await chrome.runtime.sendMessage({
    type: "minutes:popup:setParticipants",
    participants: edited,
  });

  setStatus("processing", "processing");
  els.stopBtn.disabled = true;
  els.hint.textContent = "Transcribing locally with whisper.cpp, then asking Claude for the summary…";

  const resp = await chrome.runtime.sendMessage({ type: "minutes:popup:stop" });
  els.stopBtn.disabled = false;
  if (!resp?.ok) {
    showError(resp?.error || "failed to stop");
    setStatus("idle", "idle");
    return;
  }
  await refreshState();
});

els.copySummary.addEventListener("click", async () => {
  await navigator.clipboard.writeText(els.summaryMd.textContent);
  els.copySummary.textContent = "Copied!";
  setTimeout(() => (els.copySummary.textContent = "Copy summary"), 1200);
});

els.copyTranscript.addEventListener("click", async () => {
  await navigator.clipboard.writeText(els.transcript.innerText);
  els.copyTranscript.textContent = "Copied!";
  setTimeout(() => (els.copyTranscript.textContent = "Copy transcript"), 1200);
});

refreshState();
