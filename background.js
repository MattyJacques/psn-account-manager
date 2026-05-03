chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "openSignIn") openSignIn().catch(console.error);
});

async function openSignIn() {
  const tab = await chrome.tabs.create({ url: "https://www.playstation.com/en-gb/" });

  await new Promise((resolve, reject) => {
    const TIMEOUT_MS = 30_000;

    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }

    function onUpdated(tabId, changeInfo) {
      if (tabId !== tab.id || changeInfo.status !== "complete") return;
      cleanup();
      resolve();
    }

    function onRemoved(tabId) {
      if (tabId !== tab.id) return;
      cleanup();
      reject(new Error("Tab closed before sign-in page loaded"));
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for sign-in page to load"));
    }, TIMEOUT_MS);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const btn = document.querySelector('[data-qa="web-toolbar#signin-button"]');
      if (btn) btn.click();
    },
  });
}
