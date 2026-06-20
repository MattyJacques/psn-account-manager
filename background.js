const STORAGE_KEY = "psn_accounts";

const INTERCEPTOR_SCRIPTS = [
  {
    id: "psn-interceptor-main",
    js: ["interceptor.js"],
    matches: ["https://www.playstation.com/*"],
    runAt: "document_start",
    world: "MAIN",
    persistAcrossSessions: false,
  },
  {
    id: "psn-interceptor-relay",
    js: ["interceptor-relay.js"],
    matches: ["https://www.playstation.com/*"],
    runAt: "document_start",
    world: "ISOLATED",
    persistAcrossSessions: false,
  },
];
const INTERCEPTOR_IDS = INTERCEPTOR_SCRIPTS.map((s) => s.id);
const CAPTURE_TIMEOUT_MS = 90_000;

// Tracks the account whose sign-in is in flight, so a captured profile can
// be matched to it. Only one sign-in is driven at a time.
let pendingAccountId = null;
let captureTimer = null;

function loadAccounts() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      resolve(Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : []);
    });
  });
}

function saveAccounts(accounts) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: accounts }, resolve);
  });
}

async function startCapture(accountId) {
  pendingAccountId = accountId ?? null;
  clearTimeout(captureTimer);
  if (!pendingAccountId) return;
  try {
    await chrome.scripting.unregisterContentScripts({ ids: INTERCEPTOR_IDS });
  } catch {}
  try {
    await chrome.scripting.registerContentScripts(INTERCEPTOR_SCRIPTS);
  } catch (e) {
    console.error("Failed to register interceptor", e);
  }
  captureTimer = setTimeout(stopCapture, CAPTURE_TIMEOUT_MS);
}

async function stopCapture() {
  pendingAccountId = null;
  clearTimeout(captureTimer);
  captureTimer = null;
  try {
    await chrome.scripting.unregisterContentScripts({ ids: INTERCEPTOR_IDS });
  } catch {}
}

async function handleProfileCaptured({ accountId, onlineId }) {
  if (!pendingAccountId) return;
  const id = pendingAccountId;
  const accounts = await loadAccounts();
  let changed = false;
  const next = accounts.map((a) => {
    if (a.id !== id) return a;
    changed = true;
    return {
      ...a,
      accountId: accountId ?? a.accountId,
      onlineId: onlineId ?? a.onlineId,
      profileFetchedAt: Date.now(),
    };
  });
  if (changed) await saveAccounts(next);
  await stopCapture();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "openSignIn") {
    openSignIn(msg.email, msg.password, msg.id).catch(console.error);
  } else if (msg.action === "psnProfileCaptured") {
    handleProfileCaptured(msg).catch(console.error);
  }
});

async function openSignIn(email, password, accountId) {
  // Register the interceptor BEFORE the tab navigates, so its
  // document_start scripts are in place for the homepage load that follows
  // the Sony redirect.
  await startCapture(accountId);

  const tab = await chrome.tabs.create({ url: "https://www.playstation.com/en-gb/" });

  await waitForTabLoad(tab.id);

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      function tryClickSignIn(attemptsLeft) {
        if (attemptsLeft === 0) return;
        // data-qa is the most stable hook, but Sony renames its container path
        // (e.g. "web-toolbar#profile-container#signin-button"), so match by
        // suffix and fall back to the toolbar's sign-in button class.
        const btn =
          document.querySelector('[data-qa$="signin-button"]') ||
          document.querySelector("button.web-toolbar__signin-button");
        if (!btn) {
          setTimeout(() => tryClickSignIn(attemptsLeft - 1), 200);
          return;
        }
        btn.click();
      }
      tryClickSignIn(25); // poll up to 5 s for the SPA toolbar to mount
    },
  });

  if (typeof email !== "string" || email.trim() === "") return;

  // Stage 2: the sign-in button may navigate the same tab or open a new
  // popup/tab — wait for a tab scoped to this session to reach the Sony auth page
  const authTab = await waitForSonyAuthTab(tab.id);

  await chrome.scripting.executeScript({
    target: { tabId: authTab.id },
    func: (emailToFill, passwordToFill) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;

      function fillInput(input, value) {
        nativeSetter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }

      function tryPasswordClick(attemptsLeft) {
        if (attemptsLeft === 0) return;
        const btn = document.querySelector("button#signin-password-button");
        if (!btn || btn.getAttribute("aria-disabled") === "true") {
          setTimeout(() => tryPasswordClick(attemptsLeft - 1), 100);
          return;
        }
        btn.click();
      }

      function tryPassword(attemptsLeft) {
        if (attemptsLeft === 0) return;
        const input = document.querySelector("input#signin-password-input-password");
        if (!input) {
          setTimeout(() => tryPassword(attemptsLeft - 1), 200);
          return;
        }
        fillInput(input, passwordToFill);
        tryPasswordClick(20); // wait up to 2 s for React to enable the button
      }

      function tryEmail(attemptsLeft) {
        if (attemptsLeft === 0) return;
        const input = document.querySelector("input#signin-entrance-input-signinId");
        if (!input) {
          setTimeout(() => tryEmail(attemptsLeft - 1), 200);
          return;
        }
        fillInput(input, emailToFill);
        const btn = document.querySelector("button#signin-entrance-button");
        if (btn) btn.click();

        if (passwordToFill) tryPassword(25); // poll up to 5 s for SPA to swap to password step
      }

      tryEmail(15); // poll up to 3 s for SPA render
    },
    args: [email, password ?? null],
  });
}

// Waits for the Sony auth page to load in either the original tab (same-tab
// navigation) or a tab/popup it spawned (tab.openerTabId === openerTabId).
// Attaches the listener first, then checks already-open tabs, to close the
// race window between "button clicked" and "listener registered".
function waitForSonyAuthTab(openerTabId, TIMEOUT_MS = 30_000) {
  return new Promise((resolve, reject) => {
    let settled = false;

    function isSonyAuthTab(tabId, tab) {
      return (
        tab.url &&
        tab.url.includes("my.account.sony.com") &&
        (tabId === openerTabId || tab.openerTabId === openerTabId)
      );
    }

    function settle(tab) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(tab);
    }

    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    }

    function onUpdated(id, changeInfo, tab) {
      if (changeInfo.status !== "complete") return;
      if (!isSonyAuthTab(id, tab)) return;
      settle(tab);
    }

    const timer = setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error("Timed out waiting for Sony auth page"));
    }, TIMEOUT_MS);

    // Register listener before querying to avoid missing a fast navigation
    chrome.tabs.onUpdated.addListener(onUpdated);

    // Handle the case where navigation already completed before we were called
    chrome.tabs.query({}, (tabs) => {
      const existing = tabs.find((t) => isSonyAuthTab(t.id, t));
      if (existing) settle(existing);
    });
  });
}

// Waits for a specific tab to reach status "complete". Used for stage 1.
function waitForTabLoad(tabId, TIMEOUT_MS = 30_000) {
  return new Promise((resolve, reject) => {
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }

    function onUpdated(id, changeInfo) {
      if (id !== tabId || changeInfo.status !== "complete") return;
      cleanup();
      resolve();
    }

    function onRemoved(id) {
      if (id !== tabId) return;
      cleanup();
      reject(new Error("Tab closed before page loaded"));
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for page to load"));
    }, TIMEOUT_MS);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}
