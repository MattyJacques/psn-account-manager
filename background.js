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

  // Stage 2: wait for Sony auth page, fill email, click Next
  await waitForTabLoad(tab.id, (url) => url && url.includes("my.account.sony.com"));

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (emailToFill) => {
      function tryFill(attemptsLeft) {
        if (attemptsLeft === 0) return;
        const input = document.querySelector("input#signin-entrance-input-signinId");
        if (!input) {
          setTimeout(() => tryFill(attemptsLeft - 1), 200);
          return;
        }
        // Use native setter so framework-managed inputs register the change
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
          .set.call(input, emailToFill);
        input.dispatchEvent(new Event("input", { bubbles: true }));

        const btn = document.querySelector("button#signin-entrance-button");
        if (btn) btn.click();
      }
      tryFill(15); // up to 3 seconds of polling
    },
    args: [email],
  });
}

function waitForTabLoad(tabId, urlPredicate = null) {
  return new Promise((resolve, reject) => {
    const TIMEOUT_MS = 30_000;

    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }

    function onUpdated(id, changeInfo, tab) {
      if (id !== tabId || changeInfo.status !== "complete") return;
      if (urlPredicate && !urlPredicate(tab.url)) return;
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
