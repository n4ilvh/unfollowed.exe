let scrollInterval;
const followers = new Set();
const following = new Set();
let currentMode = "followers";
let scannedCount = 0;
let totalCount = 0;
let stuckCount = 0;
let totalMode = null;
let lastScannedCount = 0;

// Totals read from the profile header ("945 followers") BEFORE the list is
// opened. This is the reliable source: once the dialog is open Instagram
// doesn't repeat the count anywhere we can read it.
const expectedTotals = { followers: 0, following: 0 };

// Paths that look like usernames to the regex but are really app routes.
const RESERVED_PATHS = new Set([
  "explore", "reels", "reel", "direct", "accounts", "stories", "p", "tv",
  "about", "legal", "privacy", "terms", "directory", "web", "api", "emails",
  "challenge", "nametag", "session", "oauth", "developer", "docs",
  "popular", "popular_users", "home", "inbox", "notifications", "search",
  "create", "saved", "settings", "login", "signup", "verified", "tags",
  "locations", "topics", "business", "help", "press", "jobs", "blog", "ads"
]);

// The user's own handle (saved by the popup). It sits in the page nav and
// must never be counted as a follower/following.
let ownUsername = "";
try {
  chrome.storage.local.get("username", (r) => {
    ownUsername = (r?.username || "").toLowerCase();
  });
} catch (e) {}

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

    // Start this list from a clean slate so leftovers from an earlier or
    // aborted scan can't inflate the count.
    (currentMode === "followers" ? followers : following).clear();
    totalCount = expectedTotals[currentMode] || 0;
    totalMode = currentMode;

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
        if (!scrollInterval) return; // scan already finished/stopped

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

        const detectedTotal = getExpectedTotal(currentMode);

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
    // Always answer, even on failure - background.js waits on this reply.
    closeDialog()
      .then((closed) => sendResponse?.({ closed }))
      .catch((err) => sendResponse?.({ closed: false, error: String(err) }));
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
  // If any dialog is already open (a leftover list, a notifications prompt)
  // waitForDialog() below would instantly "succeed" on it and we'd scan the
  // wrong list under the wrong label. Start from a known-clean page.
  if (getListDialog()) {
    const closed = await closeDialog();
    if (!closed) {
      return {
        success: false,
        reason: "Couldn't close the dialog that's already open. Close it manually and try again."
      };
    }
  }

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

  // Remember how many Instagram says there are (e.g. "945 followers").
  const headerTotal = readTotalFromTrigger(trigger);
  expectedTotals[mode] = headerTotal;
  console.log(`[unfollowed.exe] ${mode} total from profile header: ${headerTotal}`);

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
// close "Following" before opening "Followers". Resolves true once no dialog
// is left, false if every strategy failed. Never throws.
//
// NOTE: Instagram's close "X" is an <svg aria-label="Close"> inside a
// <div role="button">, not a <button>. SVG elements have no .click()
// method, so calling it on the svg throws - we click the wrapping element
// with real mouse events instead.
async function closeDialog() {
  if (!getListDialog()) return true;

  const strategies = [
    () => {
      const dialog = getListDialog();
      const icon = dialog?.querySelector(
        'svg[aria-label="Close"], button[aria-label="Close"], [role="button"][aria-label="Close"]'
      );
      if (!icon) return;
      const target =
        icon.closest('button, [role="button"]') || icon.parentElement || icon;
      dispatchFullClick(target);
    },
    () => pressEscape(),
    () => {
      // Click the dimmed backdrop outside the dialog.
      const backdrop = document.elementFromPoint(5, 5);
      if (backdrop && !backdrop.closest('[role="dialog"]')) {
        dispatchFullClick(backdrop);
      }
    }
  ];

  for (const strategy of strategies) {
    try {
      strategy();
    } catch (err) {
      console.warn("[unfollowed.exe] close strategy failed:", err);
    }
    if (await waitForDialogGone(1500)) return true;
  }

  return !getListDialog();
}

function pressEscape() {
  const target = document.activeElement || document.body;
  ["keydown", "keyup"].forEach((type) => {
    const evt = new KeyboardEvent(type, {
      key: "Escape",
      code: "Escape",
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true
    });
    target.dispatchEvent(evt);
    document.dispatchEvent(evt);
  });
}

function waitForDialogGone(timeout) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = setInterval(() => {
      if (!getListDialog()) {
        clearInterval(check);
        resolve(true);
      } else if (Date.now() - start > timeout) {
        clearInterval(check);
        resolve(false);
      }
    }, 100);
  });
}

function waitForDialog(timeout) {
  return new Promise((resolve) => {
    const start = Date.now();

    const check = setInterval(() => {
      const dialog = getListDialog();

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

function getListDialog() {
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
  if (dialogs.length <= 1) return dialogs[0] || null;

  const linkCount = (d) => d.querySelectorAll('a[href^="/"]').length;
  return dialogs.sort((a, b) => linkCount(b) - linkCount(a))[0];
}

function getElementAtCenter() {
  const dialog = getListDialog();
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

// The scrollable list inside the dialog. Reading only from here (instead of
// the whole dialog) keeps header/nav links out of the results.
function getListScope() {
  const dialog = getListDialog();
  if (!dialog) return null;

  const scroller = findScrollableParent(getElementAtCenter());
  if (scroller && dialog.contains(scroller) && scroller !== dialog) {
    return scroller;
  }
  return dialog;
}

function collectUsernames() {
  try {
    // Only ever read from the open list. Falling back to the whole page
    // would scoop up nav links like /explore/ and /reels/ as "users".
    const scope = getListScope();
    if (!scope) return;

    const target = currentMode === "followers" ? followers : following;

    scope.querySelectorAll('a[href^="/"]').forEach((link) => {
      const href = link.getAttribute("href");
      const match = href && href.match(/^\/([A-Za-z0-9_.]{1,30})\/?$/);
      if (!match) return;

      const username = match[1].toLowerCase();
      if (RESERVED_PATHS.has(username)) return;
      if (ownUsername && username === ownUsername) return;

      target.add("@" + match[1]);
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

  const detectedTotal = getExpectedTotal(currentMode);

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

// Prefer the total captured from the profile header before the list opened.
function getExpectedTotal(mode) {
  return expectedTotals[mode] || getTotalCountFromDialog(mode);
}

// Reads "945 followers" / "1.2M followers" off the element we're about to
// click. Instagram puts the exact number in a title attribute for big
// counts ("12,345" shown as "12.3K"), so prefer that.
function readTotalFromTrigger(trigger) {
  const titled = trigger.matches?.("[title]")
    ? trigger
    : trigger.querySelector?.("[title]");
  const sources = [titled?.getAttribute("title"), trigger.textContent];

  for (const raw of sources) {
    const match = (raw || "").match(/\d[\d.,]*\s*[kKmM]?/);
    if (match) {
      const n = parseCountText(match[0]);
      if (n > 0) return n;
    }
  }
  return 0;
}

// Fallback only: Instagram doesn't reliably expose a count inside the dialog.
function getTotalCountFromDialog(mode) {
  const selector =
    mode === "followers"
      ? `a[href$="/followers/"] span span`
      : `a[href$="/following/"] span span`;

  const candidates = [
    document.querySelector(selector)?.textContent,
    document.querySelector('[role="dialog"] h1, [role="dialog"] header')
      ?.textContent
  ];

  for (const text of candidates) {
    // Require a digit so words like "Mutual" can't match the k/m suffix.
    const match = (text || "").match(/\d[\d.,]*\s*[kKmM]?/);
    if (match) {
      const total = parseCountText(match[0]);
      if (total > 0) return total;
    }
  }

  return 0;
}

// "945" -> 945, "1,234" -> 1234, "1.234" (EU) -> 1234, "12.3K" -> 12300,
// "1.2M" -> 1200000. Always returns a finite number (0 if unparseable).
function parseCountText(text) {
  const t = String(text).trim().toLowerCase().replace(/\s/g, "");
  const suffix = (t.match(/[km]$/) || [])[0];

  let n;
  if (suffix) {
    // "1,2k" (decimal comma) and "1.2k" both mean 1.2 thousand
    n = Math.round(
      parseFloat(t.slice(0, -1).replace(",", ".")) * (suffix === "k" ? 1e3 : 1e6)
    );
  } else {
    // Without a suffix every "." or "," is a thousands separator.
    n = parseInt(t.replace(/[.,]/g, ""), 10);
  }

  return Number.isFinite(n) ? n : 0;
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