chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "openSignIn") openSignIn(msg.email).catch(console.error);
});

async function openSignIn(email) {
  const tab = await chrome.tabs.create({ url: "https://www.playstation.com/en-gb/" });

  await waitForTabLoad(tab.id);

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const btn = document.querySelector('[data-qa="web-toolbar#signin-button"]');
      if (btn) btn.click();
    },
  });

  if (typeof email !== "string" || email.trim() === "") return;

  // Stage 2: the sign-in button may navigate the same tab or open a new
  // popup/tab — wait for a tab scoped to this session to reach the Sony auth page
  const authTab = await waitForSonyAuthTab(tab.id);

  await chrome.scripting.executeScript({
    target: { tabId: authTab.id },
    func: (emailToFill) => {
      function tryFill(attemptsLeft) {
        if (attemptsLeft === 0) return;
        const input = document.querySelector("input#signin-entrance-input-signinId");
        if (!input) {
          setTimeout(() => tryFill(attemptsLeft - 1), 200);
          return;
        }
        // Native setter + both events required for React-controlled inputs
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
          .set.call(input, emailToFill);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));

        const btn = document.querySelector("button#signin-entrance-button");
        if (btn) btn.click();
      }
      tryFill(15); // poll up to 3 s for SPA render
    },
    args: [email],
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
