// background.js
// Owns the full "one button" scan workflow so it keeps running even if the
// popup gets closed (Chrome destroys popup.js the instant it loses focus).
//
// Instagram's followers/following list is a same-URL client-side overlay,
// so we can't drive this by navigation - we have to ask content.js to find
// and click the trigger on the page (content.js does the heavy lifting of
// robustly locating that trigger; this file just sequences the two stages).

let popupPort = null;

let scanState = {
  stage: "idle", // idle | following | followers | complete | error
  tabId: null
};

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
    beginFullScan(message.tabId);
    sendResponse?.({ started: true });
    return true;
  }

  if (message.command === "usernamesCollected") {
    handleUsernamesCollected(message);
    return true;
  }

  if (message.command === "progressUpdate") {
    forwardProgress(message);
    return true;
  }

  if (message.command === "scanError") {
    // Bubbled up from content.js (e.g. couldn't find/click the trigger).
    failScan(message.error);
    return true;
  }

  if (message.command === "resetScan") {
    scanState = { stage: "idle", tabId: null };
    chrome.storage.local.remove(["followers", "following", "unfollow", "scanStatus"]);
    chrome.action.setBadgeText({ text: "" });
    sendResponse?.({ ok: true });
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

function beginFullScan(tabId) {
  scanState = { stage: "following", tabId };

  chrome.storage.local.set({
    scanStatus: "scanning",
    scanStage: "following",
    followers: [],
    following: []
  });

  chrome.action.setBadgeText({ text: "..." });
  chrome.action.setBadgeBackgroundColor({ color: "#000080" });

  openAndScan(tabId, "following");
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

function handleUsernamesCollected(message) {
  const { followers = [], following = [] } = message.data || {};

  const patch = {};
  if (message.mode === "following") patch.following = following;
  if (message.mode === "followers") patch.followers = followers;
  chrome.storage.local.set(patch);

  if (message.mode === "following") {
    scanState.stage = "followers";
    chrome.storage.local.set({ scanStage: "followers" });

    if (!scanState.tabId) {
      failScan("Lost track of the Instagram tab.");
      return;
    }

    // Close the "Following" dialog before opening "Followers" - Instagram
    // won't open a second overlay on top of the first one.
    closeAnyOpenDialog(scanState.tabId).then(() => {
      openAndScan(scanState.tabId, "followers");
    });
    return;
  }

  if (message.mode === "followers") {
    finishFullScan(following, followers);
  }
}

function closeAnyOpenDialog(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { command: "closeDialog" }, () => {
      // Ignore errors - if there's nothing to close, that's fine too.
      setTimeout(resolve, 400);
    });
  });
}

function finishFullScan(following, followers) {
  const unfollow = following.filter((u) => !followers.includes(u));

  scanState.stage = "complete";

  chrome.storage.local.set({
    followers,
    following,
    unfollow,
    scanStatus: "complete",
    scanStage: "complete"
  });

  chrome.action.setBadgeText({ text: String(unfollow.length) });
  chrome.action.setBadgeBackgroundColor({ color: "#800000" });

  chrome.runtime.sendMessage({
    command: "scanComplete",
    followers,
    following,
    unfollow
  }).catch(() => {});

  if (chrome.notifications) {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "unfollowed.exe",
      message: `Scan complete! ${unfollow.length} people don't follow you back.`
    });
  }
}

function failScan(errorText) {
  scanState.stage = "error";

  chrome.storage.local.set({
    scanStatus: "error",
    scanError: errorText
  });

  chrome.action.setBadgeText({ text: "!" });
  chrome.action.setBadgeBackgroundColor({ color: "#a00000" });

  chrome.runtime.sendMessage({
    command: "scanError",
    error: errorText
  }).catch(() => {});
}

function forwardProgress(message) {
  if (popupPort) {
    popupPort.postMessage({
      command: "progressUpdate",
      scanned: message.scanned,
      total: message.total,
      mode: message.mode
    });
  }

  chrome.runtime.sendMessage({
    command: "progressUpdate",
    scanned: message.scanned,
    total: message.total,
    mode: message.mode
  }).catch(() => {});
}

function fileTimestamp() {
  return new Date().toISOString().slice(0, 10);
}
