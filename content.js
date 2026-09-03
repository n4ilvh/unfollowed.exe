let scrollInterval;
const followers = new Set();
const following = new Set();
let currentMode = "followers";
let scannedCount = 0;
let totalCount = 0;
let stuckCount = 0;
let totalMode = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.command === "openList") {
    openListAndWait(message.mode).then((result) => {
      sendResponse(result);
    });
    return true;
  }

  if (message.command === "startScrolling") {
    currentMode = message.mode || "followers";
    scannedCount = 0;
    totalCount = 0;
    stuckCount = 0;
    totalMode = null;

    console.log("Scrolling started for mode:", currentMode);

    if (scrollInterval) {
      clearInterval(scrollInterval);
      scrollInterval = null;
    }

    scrollInterval = setInterval(() => {
      const scrollable = findScrollableParent(getElementAtCenter());

      if (!scrollable) return;

      const oldScrollTop = scrollable.scrollTop;

      scrollable.scrollBy(0, 300);

      collectUsernames();

      setTimeout(() => {
        const newScrollTop = scrollable.scrollTop;

        if (newScrollTop === oldScrollTop) {
          stuckCount++;
        } else {
          stuckCount = 0;
        }

        if (stuckCount >= 5) {
          finishScan();
        }
      }, 100);
    }, 200);

    sendResponse?.({ status: "scrolling started" });
  }

  if (message.command === "stopScrolling") {
    console.log("Scrolling stopped");
    clearInterval(scrollInterval);
    scrollInterval = null;

    chrome.runtime.sendMessage({
      command: "usernamesCollected",
      data: {
        followers: Array.from(followers),
        following: Array.from(following)
      },
      mode: currentMode
    });
  }

  if (message.command === "closeDialog") {
    closeDialog().then(() => sendResponse?.({ closed: true }));
    return true;
  }

  if (message.command === "resetData") {
    console.log("resetData received in content.js");
    followers.clear();
    following.clear();
    scannedCount = 0;
    totalCount = 0;
  }

  if (message.action === "getProgress") {
    sendResponse?.({ scanned: scannedCount, total: totalCount });
  }
});

// ---------------------------------------------------------------------
// Finding + clicking the followers/following trigger
// ---------------------------------------------------------------------

// Tries several strategies to find the clickable element that opens the
// followers/following overlay. Returns the element, or null.
function findListTrigger(mode) {
  // Strategy 1: a real <a href="/user/following/"> (works when IG still
  // uses semantic links).
  let el =
    document.querySelector(`a[href$="/${mode}/"]`) ||
    document.querySelector(`a[href$="/${mode}"]`);
  if (el) return el;

  // Strategy 2: any <a href="/..."> whose *path* (not just string suffix)
  // ends with /mode - catches hrefs with query strings etc.
  const anchors = document.querySelectorAll('a[href^="/"]');
  for (const a of anchors) {
    try {
      const path = new URL(a.getAttribute("href"), location.href).pathname;
      if (new RegExp(`^/[^/]+/${mode}/?$`).test(path)) return a;
    } catch (e) {
      // ignore malformed hrefs
    }
  }

  // Strategy 3: text-based match. Instagram often renders this as
  // "1,234 following" (or just "following") on a non-<a> element like a
  // <div role="button">. Match on the visible text, then climb to the
  // nearest clickable ancestor.
  const textRegex = new RegExp(`^[\\d,.\\s]*[kKmM]?\\s*${mode}$`, "i");
  const candidates = document.querySelectorAll("a, div, span, button, li");

  for (const candidate of candidates) {
    const text = (candidate.textContent || "").trim();

    if (text.length > 0 && text.length < 40 && textRegex.test(text)) {
      const clickable =
        candidate.closest('a, button, [role="link"], [role="button"]') ||
        candidate;
      return clickable;
    }
  }

  return null;
}

// Polls for the trigger (header can render after initial page load),
// clicks it once found, then waits for the dialog to appear. Retries the
// click a couple of times in case the first click lands before handlers
// are attached.
async function openListAndWait(mode, timeout = 15000) {
  const start = Date.now();
  let trigger = null;

  while (Date.now() - start < timeout) {
    trigger = findListTrigger(mode);
    if (trigger) break;
    await sleep(300);
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    trigger.click();

    const dialog = await waitForDialog(4000);
    if (dialog) {
      return { success: true };
    }

    // Re-find in case the DOM re-rendered between attempts.
    trigger = findListTrigger(mode) || trigger;
    await sleep(300);
  }

  return {
    success: false,
    reason: `Error. Try scrolling to the top of the profile and running the scan again.`
  };
}

// Instagram won't open a second overlay on top of the first, so we need to
// close "Following" before opening "Followers". Try the visible close
// button first, fall back to simulating Escape.
function closeDialog() {
  return new Promise((resolve) => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) {
      resolve();
      return;
    }

    const closeIcon = dialog.querySelector(
      'button[aria-label="Close"], svg[aria-label="Close"]'
    );

    if (closeIcon) {
      (closeIcon.closest("button") || closeIcon).click();
    } else {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          bubbles: true
        })
      );
    }

    const start = Date.now();
    const check = setInterval(() => {
      if (!document.querySelector('[role="dialog"]') || Date.now() - start > 3000) {
        clearInterval(check);
        resolve();
      }
    }, 150);
  });
}

function waitForDialog(timeout) {
  return new Promise((resolve) => {
    const start = Date.now();

    const check = setInterval(() => {
      const dialog = document.querySelector('[role="dialog"]');

      if (dialog) {
        clearInterval(check);
        resolve(dialog);
        return;
      }

      if (Date.now() - start > timeout) {
        clearInterval(check);
        resolve(null);
      }
    }, 200);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------
// Scrolling + collecting usernames (unchanged in spirit from before)
// ---------------------------------------------------------------------

function getElementAtCenter() {
  const dialog = document.querySelector('[role="dialog"]');
  if (dialog) {
    const rect = dialog.getBoundingClientRect();
    return document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2
    );
  }

  const centerX = window.innerWidth / 2;
  const centerY = window.innerHeight / 2;
  return document.elementFromPoint(centerX, centerY);
}

function findScrollableParent(element) {
  let current = element || document.body;

  while (current && current !== document.documentElement) {
    const style = getComputedStyle(current);
    const hasScrollableContent = current.scrollHeight > current.clientHeight;

    if (
      (style.overflowY === "auto" || style.overflowY === "scroll") &&
      hasScrollableContent
    ) {
      return current;
    }

    current = current.parentElement;
  }

  return document.scrollingElement || document.documentElement;
}

function collectUsernames() {
  try {
    const dialog = document.querySelector('[role="dialog"]');
    const scrollContainer = dialog ? dialog : document;

    const candidates = scrollContainer.querySelectorAll('a[href^="/"]');
    const seen = new Set();

    candidates.forEach((link) => {
      const href = link.getAttribute("href");

      if (href && /^\/[A-Za-z0-9_.]{1,30}\/?$/.test(href)) {
        const username = href.replace(/^\//, "").replace(/\/$/, "");

        if (seen.has(username)) return;
        seen.add(username);

        if (
          !href.includes("/p/") &&
          !href.includes("/stories/") &&
          !href.includes("/reel/") &&
          !href.includes("/tv/")
        ) {
          const fullUsername = "@" + username;

          if (currentMode === "followers") {
            followers.add(fullUsername);
          } else {
            following.add(fullUsername);
          }
        }
      }
    });

    updateProgressTracking();
  } catch (error) {
    console.error("Error in collectUsernames:", error);
  }
}

function updateProgressTracking() {
  scannedCount = currentMode === "followers" ? followers.size : following.size;

  if (totalMode !== currentMode) {
    totalCount = 0;
    totalMode = currentMode;
  }

  const detectedTotal = getTotalCountFromDialog(currentMode);

  if (detectedTotal > 0) {
    totalCount = detectedTotal;
  }

  chrome.runtime.sendMessage({
    command: "progressUpdate",
    scanned: scannedCount,
    total: totalCount,
    mode: currentMode
  });
}

function getTotalCountFromDialog(mode) {
  // Try the profile header stat first (most reliable when present).
  const selector =
    mode === "followers"
      ? `a[href$="/followers/"] span span`
      : `a[href$="/following/"] span span`;

  const headerEl = document.querySelector(selector);
  if (headerEl) {
    const text = headerEl.textContent || headerEl.innerText;
    const match = text.match(/[\d,.kKmM]+/);
    if (match) return parseCountText(match[0]);
  }

  // Fall back to the dialog's own header text, e.g. "Followers".
  const dialogHeader = document.querySelector('[role="dialog"] h1, [role="dialog"] header')
    ?.textContent;
  if (dialogHeader) {
    const match = dialogHeader.match(/[\d,.kKmM]+/);
    if (match) return parseCountText(match[0]);
  }

  return 0;
}

function parseCountText(text) {
  const clean = text.replace(/,/g, "");

  if (clean.toLowerCase().includes("k")) {
    return Math.floor(parseFloat(clean) * 1000);
  }

  if (clean.toLowerCase().includes("m")) {
    return Math.floor(parseFloat(clean) * 1000000);
  }

  return parseInt(clean, 10) || 0;
}

function finishScan() {
  clearInterval(scrollInterval);
  scrollInterval = null;

  collectUsernames();

  console.log(`${currentMode} scan complete`);

  chrome.runtime.sendMessage({
    command: "usernamesCollected",
    data: {
      followers: Array.from(followers),
      following: Array.from(following)
    },
    mode: currentMode
  });
}
