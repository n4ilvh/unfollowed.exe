const followers = [];
const following = [];
const unfollow = [];

const content = document.querySelector(".window");

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
  ["username", "followers", "following", "unfollow", "scanStatus", "scanStage", "scanError"],
  (result) => {
    if (result.followers) followers.push(...result.followers);
    if (result.following) following.push(...result.following);
    if (result.unfollow) unfollow.push(...result.unfollow);

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
    } else if (result.scanStatus === "complete") {
      renderCompareView(unfollow, followers, following);
    } else if (result.scanStatus === "error") {
      document.getElementById("scanner").style.display = "block";
      document.getElementById("progressText").textContent =
        result.scanError || "Something went wrong.";
    }
  }
);

// Save username
saveButton.addEventListener("click", () => {
  const username = usernameInput.value.trim().replace(/^@/, "");

  if (!username) {
    return;
  }

  chrome.storage.local.set({
    username: username
  });
});

// Edit username
editButton.addEventListener("click", () => {
  const username = editUsernameInput.value.trim().replace(/^@/, "");

  if (!username) return;

  chrome.storage.local.set({
    username: username
  }, () => {
    console.log("Username updated:", username);

    // Update the main username display/input
    usernameInput.value = "@" + username;

    // Clear the edit box
    editUsernameInput.value = "";
    editUsernameInput.placeholder = `@${username}`;
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

// TOOLS SCREEN
document.getElementById("toolsBtn").addEventListener("click", () => {
  document.getElementById("toolsView").style.display = "block";
  document.getElementById("mainView").style.display = "none";
  document.getElementById("helpView").style.display = "none";
  document.getElementById("compareView").style.display = "none";
  document.getElementById("scanner").style.display = "none";

  
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
  startFullScan();
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
    updateProgress(message.scanned, message.total);
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

  if (message.command === "scanError") {
    document.getElementById("scanner").style.display = "block";
    document.getElementById("progressText").textContent = message.error;
  }
});

// Finds out who is not following the user
function findUnfollowers(followingList, followersList) {
  return followingList.filter((user) => !followersList.includes(user));
}

// Dropdown function
function createDropdown(title, data) {
  const hasData = Array.isArray(data);

  return `
    <div class="combo">
      <div class="combo-input">
        ${title}${hasData ? ` (${data.length})` : ""}
      </div>
      <div class="combo-arrow"></div>

      <div class="combo-list">
        ${
          hasData
            ? data
                .map(
                  (u) => `
              <div class="combo-item">
                <a href="https://instagram.com/${u.slice(1)}" target="_blank">${u}</a>
              </div>
            `
                )
                .join("")
            : ""
        }
      </div>
    </div>
  `;
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
  document.getElementById("csvBtn").style.display = "inline-block";

  const compareContent = document.getElementById("compareContent");
  compareContent.innerHTML = `
    <div class="combo-container">
      ${createDropdown("Not Following You Back", unfollowList)}
      ${createDropdown("Followers", followersList)}
      ${createDropdown("Following", followingList)}
    </div>
  `;
}

const port = chrome.runtime.connect({ name: "popup" });

port.onMessage.addListener((message) => {
  if (message.command === "progressUpdate") {
    updateProgress(message.scanned, message.total);
  }
});

async function startFullScan() {
  // document.getElementById("progressText").textContent += "Starting full Instagram scan";

  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab || !tab.url?.includes("instagram.com")) {
    showScanningUI();
    document.getElementById("progressText").textContent =
      "Please open Instagram first.";
    return;
  }

  else if (!tab || !tab.url?.includes(username.value.trim().replace(/^@/, ""))) {
    showScanningUI();
    document.getElementById("progressText").textContent =
      "Please open your Instagram profile first.";
    return;
  }

  showScanningUI();
  updateProgress(0, 0);

  // Hand the whole workflow off to background.js. It will drive
  // content.js through Following -> Followers -> compare, and will
  // keep going even if this popup closes.
  chrome.runtime.sendMessage({
    command: "startFullScan",
    tabId: tab.id
  });
}

function showScanningUI() {
  document.getElementById("mainView").style.display = "none";
  document.getElementById("toolsView").style.display = "none";
  document.getElementById("helpView").style.display = "none";
  document.getElementById("compareView").style.display = "none";
  document.getElementById("scanner").style.display = "block";
  initializeProgressBar();
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

function updateProgress(scanned, total) {
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

  progressText.textContent =
    total > 0
      ? `Scanned: ${scanned} of ${total} (${percent}%)`
      : `Scanned: ${scanned} users`;
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
