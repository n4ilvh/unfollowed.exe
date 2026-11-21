// background.js
// Owns the full "one button" scan workflow so it keeps running even if the
// popup gets closed (Chrome destroys popup.js the instant it loses focus).
//
// Instagram's followers/following list is a same-URL client-side overlay,
// so we can't drive this by navigation - we have to ask content.js to find
// and click the trigger on the page (content.js does the heavy lifting of
// robustly locating that trigger; this file just sequences the two stages).

let popupPort = null;

let scanState = { stage: "idle", tabId: null };
let busy = false;
const HISTORY_LIMIT = 15;
const normalize = u => String(u || "").replace(/^@/, "").trim().toLowerCase();
const notify = msg => chrome.runtime.sendMessage(msg).catch(() => {});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "popup") {
    popupPort = port;
    console.log("Popup connected to background");
    port.onDisconnect.addListener(() => {
      console.log("Popup disconnected from background");
      popupPort = null;
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("Background received message:", message);

  if (message.command === "startFullScan") {
    beginScan(message.tabId, message.username, "full").then(sendResponse);
    return true;
  }

  if (message.command === "startListScan") {
    beginScan(message.tabId, message.username, message.mode).then(sendResponse);
    return true;
  }

  if (message.command === "usernamesCollected") {
    handleUsernamesCollected(message, sender);
    return true;
  }

  if (message.command === "progressUpdate") {
    forwardProgress(message, sender);
    return true;
  }

  if (message.command === "scanError") {
    // Bubbled up from content.js (e.g. couldn't find/click the trigger).
    failScan(message.error);
    return true;
  }

  if (message.command === "stopScan") {
    stopScan().then(sendResponse);
    return true;
  }

  if (message.command === "resetScan") {
    stopScan().then(async () => {
      await chrome.storage.local.remove(["followers", "following", "unfollow", "scanStatus", "scanStage", "scanError", "scanSession", "listUpdatedAt", "dataOwner", "scanHistory", "ignoredUsers", "scanWarnings", "scanProgress"]);
      sendResponse({ ok: true });
    });
    return true;
  }


  if (message.type === "DOWNLOAD_CSV") {
    const csv = message.csv;
    const url = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
    chrome.downloads.download({
      url,
      filename: `unfollowed-log-${fileTimestamp()}.csv`,
      saveAs: true
    });
    return true;
  }

  return true; // Keep message channel open for async response
});

async function beginScan(tabId, username, mode) {
  const validModes = ["full", "followers", "following"];
  if (!validModes.includes(mode) || !Number.isInteger(tabId) || !username) {
    return { started: false, error: "Invalid scan request." };
  }
  const stored = await chrome.storage.local.get(["scanSession", "username"]);
  if (busy || stored.scanSession) return { started: false, error: "A scan is already running. Stop it first if it is stuck." };
  if (stored.username?.toLowerCase() !== username.toLowerCase()) {
    return { started: false, error: "Saved username changed. Reopen the extension." };
  }
  const firstMode = mode === "full" ? "following" : mode;
  const session = { tabId, username, mode, stage: firstMode,
    pending: {}, startedAt: Date.now() };
  busy = true;
  scanState = { stage: firstMode, tabId };
  await chrome.storage.local.set({ scanSession: session, scanStatus: "scanning",
    scanStage: firstMode, scanError: "", scanWarnings: {}, scanProgress: { scanned: 0, total: 0, mode: firstMode } });
  await chrome.action.setBadgeText({ text: "..." });
  chrome.action.setBadgeBackgroundColor({ color: "#000080" });
  openAndScan(tabId, firstMode);
  return { started: true };
}

function openAndScan(tabId, mode) {
  chrome.tabs.sendMessage(tabId, { command: "openList", mode }, (response) => {
    if (chrome.runtime.lastError) {
      failScan(
        "Couldn't reach the Instagram tab. Make sure you're on your Instagram profile page, refresh it, and try again."
      );
      return;
    }

    if (!response?.success) {
      failScan(response?.reason || `Couldn't open the ${mode} list.`);
      return;
    }

    chrome.tabs.sendMessage(tabId, {
      command: "startScrolling",
      mode
    });
  });
}

async function handleUsernamesCollected(message, sender) {
  const { scanSession: session } = await chrome.storage.local.get("scanSession");
  if (!session || sender?.tab?.id !== session.tabId || message.mode !== session.stage) return;
  const list = message.data?.[message.mode];
  if (!Array.isArray(list)) return failScan("The scan did not return a valid list.");
  if (!message.verified) return failScan("Instagram stopped loading before the expected count was reached. Saved lists were kept. Refresh the profile and try again.");
  const cleaned = [...new Set(list.filter(u => typeof u === "string" && u.trim()).map(normalize))];
  session.pending[message.mode] = cleaned;
  session.warnings = session.warnings || {};
  if (message.approximate) {
    session.warnings[message.mode] = `Instagram reported ${message.expectedTotal} ${message.mode}, but only ${cleaned.length} loaded. Results may be missing an account.`;
  }
  const latest = await chrome.storage.local.get("scanSession");
  if (!latest.scanSession || latest.scanSession.startedAt !== session.startedAt || latest.scanSession.stage !== session.stage) return;

  if (session.mode === "full" && message.mode === "following") {
    session.stage = "followers";
    await chrome.storage.local.set({ scanSession: session, scanStage: "followers" });
    await closeAnyOpenDialog(session.tabId);
    const check = await chrome.storage.local.get("scanSession");
    if (check.scanSession?.startedAt === session.startedAt && check.scanSession.stage === "followers") openAndScan(session.tabId, "followers");
    return;
  }

  const old = await chrome.storage.local.get(["followers", "following", "dataOwner", "listUpdatedAt", "username", "scanHistory"]);
  if (old.username?.toLowerCase() !== session.username.toLowerCase()) {
    return failScan("Account changed during scan. Previous data was preserved.");
  }
  const sameOwner = old.dataOwner?.toLowerCase() === session.username.toLowerCase();
  const followers = session.pending.followers ?? (sameOwner ? old.followers : undefined);
  const following = session.pending.following ?? (sameOwner ? old.following : undefined);
  const updatedAt = { ...(sameOwner ? old.listUpdatedAt : {}) };
  for (const mode of Object.keys(session.pending)) updatedAt[mode] = Date.now();
  const completePair = Array.isArray(followers) && Array.isArray(following);
  const followerSet = new Set((followers ?? []).map(normalize));
  const unfollow = completePair ? following.filter(u => !followerSet.has(normalize(u))) : [];
  const history = sameOwner && Array.isArray(old.scanHistory) ? old.scanHistory : [];
  history.unshift({ timestamp: Date.now(), mode: session.mode, followers: followers ?? [], following: following ?? [] });
  const stillRunning = await chrome.storage.local.get("scanSession");
  if (stillRunning.scanSession?.startedAt !== session.startedAt) return;
  await chrome.storage.local.set({
    dataOwner: session.username, followers: followers ?? [], following: following ?? [],
    unfollow, listUpdatedAt: updatedAt, scanHistory: history.slice(0, HISTORY_LIMIT), scanStatus: "complete", scanStage: "complete", scanProgress: null,
    scanWarnings: session.warnings || {}, scanError: ""
  });
  await chrome.storage.local.remove("scanSession");
  busy = false;
  scanState.stage = "complete";
  chrome.action.setBadgeText({ text: completePair ? String(unfollow.length) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#800000" });
  notify({ command: "scanComplete", followers: followers ?? [], following: following ?? [], unfollow, warnings: session.warnings || {} });
}

function closeAnyOpenDialog(tabId) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      setTimeout(resolve, 400);
    };

    // Never let the whole workflow hang waiting on the page. If the dialog
    // really is stuck open, content.js's openList will report that clearly.
    setTimeout(done, 8000);

    chrome.tabs.sendMessage(tabId, { command: "closeDialog" }, () => {
      // Ignore errors - if there's nothing to close, that's fine too.
      void chrome.runtime.lastError;
      done();
    });
  });
}

async function stopScan() {
  const { scanSession } = await chrome.storage.local.get("scanSession");
  if (scanSession?.tabId) {
    await chrome.tabs.sendMessage(scanSession.tabId, { command: "cancelScan" }).catch(() => {});
  }
  await chrome.storage.local.remove("scanSession");
  busy = false;
  scanState = { stage: "idle", tabId: null };
  await chrome.storage.local.set({ scanStatus: "stopped", scanStage: "idle", scanProgress: null, scanError: "Scan stopped. Your previously saved lists were preserved." });
  await chrome.action.setBadgeText({ text: "" });
  notify({ command: "scanStopped" });
  return { ok: true };
}

async function failScan(errorText) {
  const { scanSession } = await chrome.storage.local.get("scanSession");
  if (!scanSession) return;
  busy = false;
  await chrome.storage.local.remove("scanSession");
  scanState.stage = "error";
  chrome.tabs.sendMessage(scanSession.tabId, { command: "cancelScan" }).catch(() => {});

  chrome.storage.local.set({
    scanStatus: "error",
    scanError: errorText,
    scanProgress: null
  });

  chrome.action.setBadgeText({ text: "!" });
  chrome.action.setBadgeBackgroundColor({ color: "#a00000" });

  chrome.runtime.sendMessage({
    command: "scanFailed",
    error: errorText
  }).catch(() => {});
}

async function forwardProgress(message, sender) {
  const { scanSession } = await chrome.storage.local.get("scanSession");
  if (!scanSession || sender?.tab?.id !== scanSession.tabId || message.mode !== scanSession.stage) return;
  await chrome.storage.local.set({ scanProgress: { scanned: message.scanned, total: message.total, mode: message.mode } });
  if (popupPort) {
    try { popupPort.postMessage({
      command: "progressUpdate",
      scanned: message.scanned,
      total: message.total,
      mode: message.mode
    }); } catch {}
  }

  // Do not rebroadcast progressUpdate via runtime.sendMessage here:
  // background.js would receive its own broadcast and loop forever.
}

function fileTimestamp() {
  return new Date().toISOString().slice(0, 10);
}
// Clear abandoned sessions after the scan tab closes or browser restarts.
chrome.tabs.onRemoved.addListener(async tabId => {
  const { scanSession } = await chrome.storage.local.get("scanSession");
  if (scanSession?.tabId === tabId) await failScan("Instagram tab was closed. Previous data was preserved.");
});
chrome.runtime.onStartup.addListener(async () => {
  const { scanSession } = await chrome.storage.local.get("scanSession");
  if (scanSession) await failScan("Browser restarted during scan. Start a new scan.");
});
