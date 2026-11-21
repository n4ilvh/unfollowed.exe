const followers = [];
const following = [];
const unfollow = [];

const content = document.querySelector(".window");
const norm = u => String(u || "").replace(/^@/, "").trim().toLowerCase();
const escapeHtml = u => String(u).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let ignoredUsers = [];


const usernameInput = document.getElementById("username");
const saveButton = document.getElementById("saveUsername");

const editUsernameInput = document.getElementById("editUsername");
const editButton = document.getElementById("editBtn");

let maxWindow = false;

// ---------------------------------------------------------------------
// Startup: figure out what screen to show based on saved username +
// whatever scan state background.js has been keeping in storage.
// ---------------------------------------------------------------------
chrome.storage.local.get(
  ["username", "followers", "following", "unfollow", "scanStatus", "scanStage", "scanError", "dataOwner", "ignoredUsers", "scanProgress", "scanWarnings"],
  (result) => {
    ignoredUsers = result.dataOwner === result.username ? (result.ignoredUsers || []) : [];
    if (result.dataOwner === result.username && result.followers) followers.push(...result.followers);
    if (result.dataOwner === result.username && result.following) following.push(...result.following);
    if (result.dataOwner === result.username && result.unfollow) unfollow.push(...result.unfollow);

    if (!result.username) {
      document.getElementById("mainView").style.display = "none";
      document.getElementById("toolsView").style.display = "none";
      document.getElementById("barButtons").style.display = "none";
      return;
    }

    usernameInput.value = "@" + result.username;
    document.getElementById("mainView").style.display = "block";
    document.getElementById("welcomeView").style.display = "none";
    document.getElementById("toolsView").style.display = "none";

    if (result.scanStatus === "scanning") {
      showScanningUI();
      if (result.scanProgress) updateProgress(result.scanProgress.scanned, result.scanProgress.total, result.scanProgress.mode);
    } else {
      // Scanner is only visible during an active scan. Completed, stopped,
      // and failed scans return to Home rather than leaving a stale overlay.
      document.getElementById("scanner").style.display = "none";
      if (result.scanStatus === "error" || result.scanStatus === "stopped") {
        showHomeNotice(result.scanError || "Scan stopped. Previous lists were preserved.");
      }
      if (result.scanStatus === "complete" && result.dataOwner === result.username) {
        updateResultFilters();
      }
    }
  }
);

// Save username
saveButton.addEventListener("click", () => {
  const username = usernameInput.value.trim().replace(/^@/, "");

  if (!username) {
    return;
  }

  chrome.storage.local.set({ username });
});

// Edit username
editButton.addEventListener("click", () => {
  const username = editUsernameInput.value.trim().replace(/^@/, "");

  if (!username) return;

  chrome.storage.local.get("scanSession", ({ scanSession }) => {
    if (scanSession) { alert("Stop the active scan before switching accounts."); return; }
    chrome.storage.local.set({ username }, () => {
    console.log("Username updated:", username);

    // Clear old account results in this popup; storage remains tagged to its owner.
    followers.length = 0;
    following.length = 0;
    unfollow.length = 0;
    document.getElementById("compareContent").innerHTML = "Scan this account to see results.";
    // Update the main username display/input
    usernameInput.value = "@" + username;

    // Clear the edit box
    editUsernameInput.value = "";
    editUsernameInput.placeholder = `@${username}`;
    chrome.storage.local.set({scanStatus: "idle"});
  });
  });
});

// Open Instagram button
document.getElementById("igBtn").addEventListener("click", () => {
  chrome.storage.local.get("username", (result) => {
    if (!result.username) {
      alert("Please enter your Instagram username first.");
      return;
    }

    chrome.tabs.create({
      url: `https://www.instagram.com/${result.username}/`
    });
  });
});

// WELCOME SCREEN
document.getElementById("saveUsername").addEventListener("click", () => {
  document.getElementById("mainView").style.display = "block";
  document.getElementById("welcomeView").style.display = "none";
  document.getElementById("barButtons").style.display = "flex";
  document.getElementById("scanner").style.display = "none";
  document.getElementById("toolsView").style.display = "none";
});

// HOME SCREEN
document.getElementById("homeBtn").addEventListener("click", () => {
  document.getElementById("barButtons").style.display = "flex";
  document.getElementById("mainView").style.display = "block";
  document.getElementById("helpView").style.display = "none";
  document.getElementById("toolsView").style.display = "none";
  document.getElementById("compareView").style.display = "none";
  document.getElementById("scanner").style.display = "none";
});

// VIEW SCREEN
document.getElementById("viewBtn").addEventListener("click", () => {
  document.getElementById("barButtons").style.display = "flex";
  document.getElementById("mainView").style.display = "none";
  document.getElementById("helpView").style.display = "none";
  document.getElementById("toolsView").style.display = "none";
  document.getElementById("compareView").style.display = "block";
  document.getElementById("scanner").style.display = "none";
  // Rebuild the list each time View opens; do not wait for a filter change.
  updateResultFilters();
});

// TOOLS SCREEN
document.getElementById("toolsBtn").addEventListener("click", () => {
  document.getElementById("toolsView").style.display = "block";
  document.getElementById("mainView").style.display = "none";
  document.getElementById("helpView").style.display = "none";
  document.getElementById("compareView").style.display = "none";
  document.getElementById("scanner").style.display = "none";

  
  showListDates();
  // Username placeholder
  chrome.storage.local.get("username", (result) => {
    if (!result.username) {
      return;
    }

    editUsernameInput.placeholder = `@${result.username}`;
  });

})



// HELP SCREEN
document.getElementById("helpBtn").addEventListener("click", () => {
  document.getElementById("helpView").style.display = "block";
  document.getElementById("mainView").style.display = "none";
  document.getElementById("toolsView").style.display = "none";
  document.getElementById("compareView").style.display = "none";
  document.getElementById("scanner").style.display = "none";
});

// MINIMIZE BORDER BUTTON
document.getElementById("minBtn").addEventListener("click", () => {
  content.classList.toggle("hidden");
});

// MAXIMIZE BORDER BUTTON (opens as a side panel, which - unlike the popup -
// stays open even when the user clicks elsewhere. Recommended for scans.)
document.getElementById("maxBtn").addEventListener("click", async () => {
  maxWindow = true;
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  await chrome.sidePanel.open({
    tabId: tab.id
  });

  window.close();
});

if (!maxWindow) {
  document.getElementById("collapseBtn").style.display = "none";
  document.getElementById("maxBtn").style.display = "block";
} else {
  document.getElementById("collapseBtn").style.display = "block";
  document.getElementById("maxBtn").style.display = "none";
}

// CLOSE BORDER BUTTON
document.getElementById("closeBtn").addEventListener("click", () => {
  window.close();
});

// ---------------------------------------------------------------------
// THE one button. Everything else (opening Following, scrolling,
// switching to Followers, scrolling, comparing) happens automatically
// in background.js from here on - even if this popup gets closed.
// ---------------------------------------------------------------------
document.getElementById("scanBtn").addEventListener("click", () => {
  startScan("full");
});

// if combo box is clicked
document.addEventListener("click", (e) => {
  const combo = e.target.closest(".combo");

  document.querySelectorAll(".combo-list").forEach((list) => {
    if (!combo || !list.parentElement.contains(e.target)) {
      list.style.display = "none";
    }
  });

  if (!combo) return;

  if (
    e.target.classList.contains("combo-arrow") ||
    e.target.classList.contains("combo-input")
  ) {
    const list = combo.querySelector(".combo-list");
    list.style.display = list.style.display === "block" ? "none" : "block";
  }
});

// If "Reset" is pressed
document.getElementById("resetBtn").addEventListener("click", () => {
  if (!confirm("Delete saved lists and scan history?")) return;
  unfollow.length = 0;
  followers.length = 0;
  following.length = 0;

  chrome.runtime.sendMessage({ command: "resetScan" }, () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { command: "resetData" });
      }
    });
  });

  document.getElementById("compareView").style.display = "block";
  document.getElementById("resetBtn").style.display = "none";
  document.getElementById("csvBtn").style.display = "none";

  const compareContent = document.getElementById("compareContent");
  compareContent.innerHTML = `
    <div class="combo-container">
      <div style="color: black; font-weight: 100; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; text-align: center; height: min-content;">List has been reset.</div>
    </div>
  `;
});

document.getElementById("csvBtn").addEventListener("click", () => {
  downloadCSV(findUnfollowers(following, followers));
});

// ---------------------------------------------------------------------
// Messages from background.js while this popup happens to be open.
// ---------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message) => {
  if (message.command === "progressUpdate") {
    updateProgress(message.scanned, message.total, message.mode);
  }

  if (message.command === "scanComplete") {
    followers.length = 0;
    followers.push(...(message.followers || []));
    following.length = 0;
    following.push(...(message.following || []));
    unfollow.length = 0;
    unfollow.push(...(message.unfollow || []));

    renderCompareView(unfollow, followers, following);
  }

  if (message.command === "scanStopped") {
    showHomeNotice("Scan stopped. Your saved lists were preserved.");
  }
  if (message.command === "scanFailed") {
    showHomeNotice(message.error || "Scan failed. Your saved lists were preserved.");
  }
});

// Finds out who is not following the user
function findUnfollowers(followingList, followersList) {
  const set = new Set(followersList.map(norm));
  return followingList.filter((user) => !set.has(norm(user)));
}

// A readable, scrollable list instead of the old collapsed combo box.
// Render in batches so large Instagram lists do not freeze the popup.
const RESULT_PAGE_SIZE = 100;
let displayedResults = [];
let displayedCount = 0;

function appendResultRows() {
  const list = document.getElementById("resultList");
  if (!list) return;
  const fragment = document.createDocumentFragment();
  const next = Math.min(displayedCount + RESULT_PAGE_SIZE, displayedResults.length);
  for (let i = displayedCount; i < next; i++) {
    const username = norm(displayedResults[i]);
    const row = document.createElement("a");
    row.className = "result-user";
    row.href = `https://www.instagram.com/${encodeURIComponent(username)}/`;
    row.target = "_blank";
    row.rel = "noopener noreferrer";
    row.title = `Open @${username} on Instagram`;
    const avatar = document.createElement("span");
    avatar.className = "result-avatar";
    avatar.textContent = username.charAt(0).toUpperCase();
    const name = document.createElement("span");
    name.className = "result-username";
    name.textContent = `@${username}`;
    const arrow = document.createElement("span");
    arrow.className = "result-open";
    arrow.textContent = ">";
    arrow.setAttribute("aria-hidden", "true");
    row.append(avatar, name, arrow);
    fragment.appendChild(row);
  }
  list.appendChild(fragment);
  displayedCount = next;
  const more = document.getElementById("resultMoreBtn");
  if (more) more.hidden = displayedCount >= displayedResults.length;
}

function renderResultList(label, data) {
  displayedResults = data;
  displayedCount = 0;
  const root = document.getElementById("compareContent");
  root.replaceChildren();
  const header = document.createElement("div");
  header.className = "result-list-header";
  const heading = document.createElement("strong");
  heading.textContent = label;
  const count = document.createElement("span");
  count.textContent = `${data.length} account${data.length === 1 ? "" : "s"}`;
  header.append(heading, count);
  root.appendChild(header);
  if (!data.length) {
    const empty = document.createElement("p");
    empty.className = "result-empty";
    empty.textContent = "No accounts match this view.";
    root.appendChild(empty);
    return;
  }
  const list = document.createElement("div");
  list.id = "resultList";
  list.className = "result-list";
  root.appendChild(list);
  const more = document.createElement("button");
  more.id = "resultMoreBtn";
  more.className = "result-more";
  more.type = "button";
  more.textContent = "Show 100 more";
  more.addEventListener("click", appendResultRows);
  root.appendChild(more);
  appendResultRows();
}

// Renders the results screen. Called whether the popup was open the whole
// time (via the scanComplete message) or was reopened after the scan
// finished in the background (via storage on load).
function renderCompareView(unfollowList, followersList, followingList) {
  document.getElementById("mainView").style.display = "none";
  document.getElementById("toolsView").style.display = "none";
  document.getElementById("helpView").style.display = "none";
  document.getElementById("scanner").style.display = "none";
  document.getElementById("compareView").style.display = "block";
  document.getElementById("resetBtn").style.display = "inline-block";
  document.getElementById("stopScanBtn").style.display = "none";
  document.getElementById("csvBtn").style.display = "inline-block";

  updateResultFilters();

}

const port = chrome.runtime.connect({ name: "popup" });

port.onMessage.addListener((message) => {
  if (message.command === "progressUpdate") {
    updateProgress(message.scanned, message.total, message.mode);
  }
});

document.getElementById("refreshFollowersBtn").addEventListener("click", () => startScan("followers"));
document.getElementById("refreshFollowingBtn").addEventListener("click", () => startScan("following"));

async function showListDates() {
  const { listUpdatedAt = {}, dataOwner, username } = await chrome.storage.local.get(["listUpdatedAt", "dataOwner", "username"]);
  const fmt = key => dataOwner === username && listUpdatedAt[key]
    ? new Date(listUpdatedAt[key]).toLocaleString() : "Never";
  document.getElementById("listDates").textContent =
    `Followers: ${fmt("followers")}  Following: ${fmt("following")}`;
}

async function startScan(mode) {
  const { username } = await chrome.storage.local.get("username");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let url;
  try { url = new URL(tab?.url); } catch { /* not an Instagram tab */ }
  if (url?.hostname !== "www.instagram.com" ||
      url.pathname.split("/").filter(Boolean)[0]?.toLowerCase() !== username?.toLowerCase()) {
    showHomeNotice(`Open your Instagram profile (@${username}) first.`);
    return;
  }
  const command = mode === "full" ? "startFullScan" : "startListScan";
  const response = await chrome.runtime.sendMessage({ command, tabId: tab.id, username, mode });
  if (!response?.started) {
    showHomeNotice(response?.error || "Couldn't start the scan.");
    return;
  }
  showScanningUI();
  updateProgress(0, 0, mode === "full" ? "following" : mode);
}

function showHomeNotice(message) {
  document.getElementById("mainView").style.display = "block";
  document.getElementById("toolsView").style.display = "none";
  document.getElementById("helpView").style.display = "none";
  document.getElementById("compareView").style.display = "none";
  document.getElementById("scanner").style.display = "none";
  let notice = document.getElementById("scanNotice");
  if (!notice) {
    notice = document.createElement("div");
    notice.id = "scanNotice";
    notice.setAttribute("role", "status");
    notice.className = "home-tip";
    document.getElementById("mainView").appendChild(notice);
  }
  notice.textContent = message;
}

function showScanningUI() {
  document.getElementById("scanNotice")?.remove();
  document.getElementById("mainView").style.display = "none";
  document.getElementById("toolsView").style.display = "none";
  document.getElementById("helpView").style.display = "none";
  document.getElementById("compareView").style.display = "none";
  document.getElementById("scanner").style.display = "block";
  initializeProgressBar();
  document.getElementById("stopScanBtn").style.display = "inline-block";
}

function initializeProgressBar() {
  const progressBar = document.getElementById("progressBar");
  if (!progressBar) return;

  progressBar.innerHTML = "";

  for (let i = 0; i < 10; i++) {
    const block = document.createElement("div");
    block.className = "progress-block";
    block.style.backgroundColor = "#000080";
    block.style.opacity = "0.3";
    progressBar.appendChild(block);
  }
}

function updateProgress(scanned, total, mode) {
  const progressText = document.getElementById("progressText");
  const progressBar = document.getElementById("progressBar");

  if (!progressText || !progressBar) return;

  let percent = 0;
  if (total > 0) {
    percent = Math.min(100, Math.floor((scanned / total) * 100));
  }

  const blocks = progressBar.querySelectorAll(".progress-block");
  const blocksToFill = Math.floor((percent / 100) * blocks.length);

  blocks.forEach((block, index) => {
    if (index < blocksToFill) {
      block.classList.add("filled");
      block.style.opacity = "1";
    } else {
      block.classList.remove("filled");
      block.style.opacity = "0.3";
    }
  });

  // Say which list is being scanned so the automatic Following -> Followers
  // hand-off is visible.
  const label = mode ? `${mode[0].toUpperCase()}${mode.slice(1)} - ` : "";

  progressText.textContent =
    total > 0
      ? `${label}Scanned: ${scanned} of ${total} (${percent}%)`
      : `${label}Scanned: ${scanned} users`;
}

function downloadCSV(data) {
  let csv =
    "Unfollowed.exe log - " +
    `[${new Date().toLocaleString()}]\n\n` +
    "not following you:\n" +
    data.map((u) => u.replace("@", "")).join("\n");

  chrome.runtime.sendMessage({
    type: "DOWNLOAD_CSV",
    csv
  });
}
// Results: searching, sorting, statistics, stale timestamps and ignore list.
function updateResultFilters() {
  const key = document.getElementById("resultFilter").value;
  const query = norm(document.getElementById("resultSearch").value);
  const followerSet = new Set(followers.map(norm));
  const followingSet = new Set(following.map(norm));
  const groups = {
    unfollow: following.filter(u => !followerSet.has(norm(u))),
    followers, following,
    mutual: following.filter(u => followerSet.has(norm(u))),
    fans: followers.filter(u => !followingSet.has(norm(u)))
  };
  const data = (groups[key] || []).filter(u => !ignoredUsers.includes(norm(u)) && norm(u).includes(query))
    .sort((a,b) => norm(a).localeCompare(norm(b)) * (document.getElementById("resultSort").value === "desc" ? -1 : 1));
  const labels = { unfollow: "Not following you back", followers: "Followers", following: "Following", mutual: "Mutual followers", fans: "Follows you only" };
  renderResultList(labels[key] || "Accounts", data);
  document.getElementById("resultStats").textContent = `Followers: ${followers.length} | Following: ${following.length} | Mutual: ${groups.mutual.length} | Not following back: ${groups.unfollow.length}`;
  chrome.storage.local.get(["listUpdatedAt", "dataOwner", "username", "scanWarnings"], r => {
    const dates = r.listUpdatedAt || {};
    const notices = [];
    if (r.dataOwner === r.username) {
      if (dates.followers && dates.following && Math.abs(dates.followers - dates.following) > 86400000) {
        notices.push("⚠ Lists were scanned more than 24 hours apart.");
      }
      notices.push(...Object.values(r.scanWarnings || {}));
    }
    document.getElementById("staleWarning").textContent = notices.join(" ");
  });
}
["resultSearch", "resultFilter", "resultSort"].forEach(id => document.getElementById(id).addEventListener(id === "resultSearch" ? "input" : "change", updateResultFilters));
document.getElementById("stopScanBtn").addEventListener("click", async () => {
  document.getElementById("stopScanBtn").disabled = true;
  try { await chrome.runtime.sendMessage({command:"stopScan"}); }
  finally { document.getElementById("stopScanBtn").disabled = false; }
});
async function showIgnored() {
  const r = await chrome.storage.local.get(["ignoredUsers", "dataOwner", "username"]);
  ignoredUsers = r.dataOwner === r.username ? (r.ignoredUsers || []) : [];
  const box = document.getElementById("ignoredList"); box.replaceChildren();
  ignoredUsers.forEach(u => {
    const row = document.createElement("div"); row.textContent = "@" + u + " ";
    const btn = document.createElement("button"); btn.textContent = "Remove";
    btn.addEventListener("click", async () => { ignoredUsers = ignoredUsers.filter(x=>x!==u); await chrome.storage.local.set({ignoredUsers}); showIgnored(); });
    row.append(btn); box.append(row);
  });
}
document.getElementById("toolsBtn").addEventListener("click", showIgnored);
document.getElementById("ignoreBtn").addEventListener("click", async () => {
  const u = norm(document.getElementById("ignoreInput").value);
  if (!/^[a-z0-9._]{1,30}$/.test(u)) return alert("Enter a valid Instagram username.");
  const r = await chrome.storage.local.get(["dataOwner", "username"]);
  if (r.dataOwner !== r.username) return alert("Scan this account before adding ignored users.");
  ignoredUsers = [...new Set([...ignoredUsers, u])];
  await chrome.storage.local.set({ignoredUsers});
  document.getElementById("ignoreInput").value = ""; showIgnored();
});
document.getElementById("clearDataBtn").addEventListener("click", async () => {
  if (!confirm("Delete all saved scan lists, history and ignored users?")) return;
  await chrome.runtime.sendMessage({command:"resetScan"});
  followers.length=following.length=unfollow.length=0; ignoredUsers=[];
  document.getElementById("compareContent").textContent = "Saved data cleared."; showListDates(); showIgnored();
});
document.getElementById("backupBtn").addEventListener("click", async () => {
  const r = await chrome.storage.local.get(["username","dataOwner","followers","following","listUpdatedAt","scanHistory","ignoredUsers"]);
  const blob = new Blob([JSON.stringify({format:"unfollowed-backup-v1",...r},null,2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href=url; a.download="unfollowed-backup.json"; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),10000);
});
document.getElementById("importBtn").addEventListener("click", () => document.getElementById("importFile").click());
document.getElementById("importFile").addEventListener("change", async e => {
  try {
    const f=e.target.files[0]; if (!f || f.size > 5_000_000) throw Error("Backup missing or too large (5 MB max).");
    const data=JSON.parse(await f.text());
    if (data.format!=="unfollowed-backup-v1" || !Array.isArray(data.followers) || !Array.isArray(data.following) || !data.username || norm(data.dataOwner)!==norm(data.username)) throw Error("Invalid backup file.");
    if (data.followers.length>100000 || data.following.length>100000 || ![...data.followers,...data.following].every(u=>typeof u==="string" && /^[a-zA-Z0-9._]{1,30}$/.test(norm(u)))) throw Error("Invalid usernames in backup.");
    const active=await chrome.storage.local.get("scanSession"); if(active.scanSession) throw Error("Stop the current scan first.");
    if (!confirm(`Restore lists for @${data.username}? This replaces your current saved data.`)) return;
    const fs=[...new Set(data.followers.map(norm))], fg=[...new Set(data.following.map(norm))];
    const set=new Set(fs);
    await chrome.storage.local.set({username:norm(data.username),dataOwner:norm(data.username),followers:fs,following:fg,unfollow:fg.filter(u=>!set.has(u)),listUpdatedAt:data.listUpdatedAt||{},scanHistory:Array.isArray(data.scanHistory)?data.scanHistory.slice(0,15):[],ignoredUsers:Array.isArray(data.ignoredUsers)?data.ignoredUsers.filter(u=>typeof u==="string").map(norm).slice(0,1000):[],scanStatus:"complete"});
    location.reload();
  } catch(err) { alert(err.message); } finally { e.target.value=""; }
});
