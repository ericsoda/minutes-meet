const btn = document.getElementById("grant-btn");
const status = document.getElementById("status");

function setStatus(text, cls) {
  status.hidden = false;
  status.textContent = text;
  status.className = "status " + (cls || "");
}

async function checkExisting() {
  try {
    const p = await navigator.permissions.query({ name: "microphone" });
    if (p.state === "granted") {
      setStatus("Microphone access is already granted. You can close this tab.", "ok");
    }
  } catch (_) {}
}

btn.addEventListener("click", async () => {
  setStatus("Requesting microphone access…", "");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Immediately stop the tracks; we only needed the prompt to be granted.
    for (const t of stream.getTracks()) t.stop();
    setStatus(
      "Microphone access granted. You can close this tab and click Start in the Minutes popup.",
      "ok",
    );
  } catch (e) {
    setStatus(
      "Permission denied or blocked.\n\n" +
        "If no prompt appeared: open chrome://settings/content/microphone, " +
        "find this extension, and set it to Allow. Then reload this tab and try again.\n\n" +
        (e?.message || e),
      "err",
    );
  }
});

checkExisting();
