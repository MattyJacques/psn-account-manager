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

  // Stage 2: the sign-in button may open Sony auth in the same tab or a new
  // popup — watch any tab navigating to my.account.sony.com
  const authTab = await waitForUrlLoad((url) => url && url.includes("my.account.sony.com"));

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

// Waits for any tab to reach status "complete" with a URL matching urlPredicate.
// Returns the full Tab object so the caller knows which tab to inject into.
function waitForUrlLoad(urlPredicate, TIMEOUT_MS = 30_000) {
  return new Promise((resolve, reject) => {
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    }

    function onUpdated(id, changeInfo, tab) {
      if (changeInfo.status !== "complete") return;
      if (!urlPredicate(tab.url)) return;
      cleanup();
      resolve(tab);
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for Sony auth page"));
    }, TIMEOUT_MS);

    chrome.tabs.onUpdated.addListener(onUpdated);
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
