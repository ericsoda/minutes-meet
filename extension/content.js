// Minutes — content script for Google Meet.
//
// Job: report the list of participant names in the current meeting.
//
// We do NOT try to track the active speaker per-event from the DOM. That
// approach is fragile and breaks every time Meet ships a UI tweak. Instead,
// we just collect names from the participants panel (a stable surface) and
// let Claude do speaker attribution from context in the transcript.
//
// To keep things robust we try a handful of selectors and union the results.

function collectParticipantNames() {
  const names = new Set();

  // Strategy 1: explicit participant tiles in the grid.
  // Most builds of Meet attach a data-participant-id and an aria-label
  // containing the participant name.
  for (const tile of document.querySelectorAll("[data-participant-id]")) {
    const label = (tile.getAttribute("aria-label") || "").trim();
    if (label && label.length < 80 && !label.includes("Pinned")) {
      names.add(cleanName(label));
    }
    // Some builds put the name in a child element with role="heading"
    const heading = tile.querySelector('[role="heading"]');
    if (heading?.textContent) {
      names.add(cleanName(heading.textContent));
    }
  }

  // Strategy 2: the open participants side panel, if present.
  // Items there usually have an aria-label or a name span.
  for (const item of document.querySelectorAll('[role="listitem"]')) {
    const aria = (item.getAttribute("aria-label") || "").trim();
    if (aria && aria.length < 80) names.add(cleanName(aria));
  }

  // Strategy 3: the user's own name from the self-view.
  for (const el of document.querySelectorAll("[data-self-name]")) {
    const v = el.getAttribute("data-self-name");
    if (v) names.add(cleanName(v));
  }

  return [...names].filter(Boolean);
}

function cleanName(raw) {
  // Strip trailing labels Meet sometimes appends, e.g. "Alice Smith (You)",
  // "Alice Smith, presenter", "Alice Smith is muted".
  let s = raw.trim();
  s = s.replace(/\s*\(You\)\s*$/i, "");
  s = s.replace(/,.*$/, "");
  s = s.replace(/\s+is\s+(muted|presenting|speaking)\s*$/i, "");
  s = s.replace(/\s+(muted|presenting|speaking|pinned)\s*$/i, "");
  return s.trim();
}

// Periodically push updates to the background while the popup might be open
// or while we're recording. Cheap and means we don't have to plumb a
// MutationObserver.
let lastSent = "";
function pushIfChanged() {
  const names = collectParticipantNames();
  const key = names.slice().sort().join("|");
  if (key !== lastSent) {
    lastSent = key;
    try {
      chrome.runtime.sendMessage({ type: "minutes:participantsUpdate", participants: names });
    } catch (_) {}
  }
}

setInterval(pushIfChanged, 3000);
pushIfChanged();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "minutes:getParticipants") {
    sendResponse({ participants: collectParticipantNames() });
    return;
  }
});
