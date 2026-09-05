let scrollInterval;
const followers = new Set();
const following = new Set();
let currentMode = "followers";
let scannedCount = 0;
let totalCount = 0;
let stuckCount = 0;
let totalMode = null;
let lastScannedCount = 0;

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
    lastScannedCount = 0;

    console.log("Scrolling started for mode:", currentMode);

    if (scrollInterval) {
      clearInterval(scrollInterval);
      scrollInterval = null;
    }

    scrollInterval = setInterval(() => {
      const scrollable = findScrollableParent(getElementAtCenter());

      if (!scrollable) return;

      scrollable.scrollBy(0, 500);

      // Give Instagram time to render newly loaded users
      setTimeout(() => {
        collectUsernames();

        const currentScannedCount =
          currentMode === "followers"
            ? followers.size
            : following.size;

        // Check whether we're still discovering new users
        if (currentScannedCount === lastScannedCount) {
          stuckCount++;
        } else {
          stuckCount = 0;
          lastScannedCount = currentScannedCount;
        }

        const detectedTotal = getTotalCountFromDialog(currentMode);

        console.log(
          `[unfollowed.exe] ${currentMode}: ${currentScannedCount}/${detectedTotal}, no progress: ${stuckCount}`
        );

        // Only finish if we've reached Instagram's reported total
        // OR we've been unable to discover anything for a long time.
        if (
          detectedTotal > 0 &&
          currentScannedCount >= detectedTotal
        ) {
          finishScan();
          return;
        }

        if (stuckCount >= 15) {
          console.log(
            `[unfollowed.exe] ${currentMode} appears to be at the end.`
          );
          finishScan();
        }
      }, 500);
    }, 700);

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
    stuckCount = 0;
    lastScannedCount = 0;
    totalMode = null;
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
  const isUsable = (el) => {
    if (el.closest('[role="dialog"]')) return false; // ignore dialog remnants
    if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") {
      return false; // not actually visible/rendered
    }
    return true;
  };

  const scope = document.querySelector("header") || document;

  // Strategy 1/2: real hrefs, kept as a cheap first try in case Instagram
  // ever brings semantic links back. Harmless if they don't match.
  let el =
    scope.querySelector(`a[href$="/${mode}/"]`) ||
    scope.querySelector(`a[href$="/${mode}"]`);
  if (el && isUsable(el)) return el;

  const anchors = scope.querySelectorAll('a[href^="/"]');
  for (const a of anchors) {
    if (!isUsable(a)) continue;
    try {
      const path = new URL(a.getAttribute("href"), location.href).pathname;
      if (new RegExp(`^/[^/]+/${mode}/?$`).test(path)) return a;
    } catch (e) {}
  }

  // Strategy 3 (the one that actually matters here): Instagram renders
  // "945 followers" as plain text on a <span> with NO href - the click is
  // handled by a JS listener higher up the tree, not a real link. So
  // instead of hunting for a specific clickable wrapper, just find the
  // deepest element whose text matches and click IT directly - the click
  // will bubble up to whatever handler Instagram attached above it.
  const textRegex = new RegExp(`^[\\d,.\\s]*[kKmM]?\\s*${mode}$`, "i");
  const candidates = scope.querySelectorAll("span, div, a, button, li");
  let bestMatch = null;

  for (const candidate of candidates) {
    if (!isUsable(candidate)) continue;

    const text = (candidate.textContent || "").trim();

    if (text.length > 0 && text.length < 40 && textRegex.test(text)) {
      const hasMatchingChild = Array.from(
        candidate.querySelectorAll("span, div, a, button, li")
      ).some((child) => textRegex.test((child.textContent || "").trim()));

      if (!hasMatchingChild) {
        const clickable =
          candidate.closest('a, button, [role="link"], [role="button"]') || candidate;
        if (isUsable(clickable)) {
          bestMatch = clickable;
          break;
        }
      }
    }
  }

  if (bestMatch) return bestMatch;

  const allHeaderLinks = Array.from(scope.querySelectorAll("a")).map((a) => ({
    href: a.getAttribute("href"),
    text: (a.textContent || "").trim().slice(0, 40)
  }));
  console.log(`[unfollowed.exe] Could not find "${mode}" trigger. Header links seen:`, allHeaderLinks);

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

  if (!trigger) {
    console.log(`Couldn't find the "${mode}" link on this page. Check the console for a list of header links seen.`);
    return {
      success: false,
      reason: `Couldn't find the "${mode}" link on this page. Check the console for a list of header links seen.`
    };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    dispatchFullClick(trigger);

    const dialog = await waitForDialog(4000);
    if (dialog) {
      return { success: true };
    }

    trigger = findListTrigger(mode) || trigger;
    await sleep(300);
  }

  return {
    success: false,
    reason: `Found the "${mode}" link but clicking it didn't open the list. Try scrolling to the top of the profile and running the scan again.`
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

function dispatchFullClick(el) {
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };

  ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) => {
    const EventClass = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    el.dispatchEvent(new EventClass(type, opts));
  });

  el.click(); // fallback, harmless if the above already worked
}

// ---------------------------------------------------------------------
// Scrolling + collecting usernames 
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
  const selector =
    mode === "followers"
      ? `a[href$="/followers/"] span span`
      : `a[href$="/following/"] span span`;

  const headerEl = document.querySelector(selector);

  if (headerEl) {
    const text = headerEl.textContent || headerEl.innerText;
    const match = text.match(/[\d,.kKmM]+/);

    if (match) {
      const total = parseCountText(match[0]);

      console.log(
        `[unfollowed.exe] ${mode} total detected: ${total} from "${text}"`
      );

      return total;
    }
  }

  // Fall back to dialog header
  const dialogHeader = document.querySelector(
    '[role="dialog"] h1, [role="dialog"] header'
  )?.textContent;

  if (dialogHeader) {
    const match = dialogHeader.match(/[\d,.kKmM]+/);

    if (match) {
      const total = parseCountText(match[0]);

      console.log(
        `[unfollowed.exe] ${mode} total detected from dialog: ${total}`
      );

      return total;
    }
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
