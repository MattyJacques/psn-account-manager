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
