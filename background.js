chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "openSignIn") openSignIn().catch(console.error);
});

async function openSignIn() {
  const tab = await chrome.tabs.create({ url: "https://www.playstation.com/en-gb/" });

  await new Promise((resolve) => {
    function onUpdated(tabId, changeInfo) {
      if (tabId !== tab.id || changeInfo.status !== "complete") return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const btn = document.querySelector('[data-qa="web-toolbar#signin-button"]');
      if (btn) btn.click();
    },
  });
}
