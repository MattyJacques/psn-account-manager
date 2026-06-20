// ISOLATED-world relay: the MAIN-world interceptor cannot call chrome.*,
// so it postMessages to the page; this relay validates the message and
// forwards it to the background worker.
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "psn-am") return;
  chrome.runtime.sendMessage(
    {
      action: "psnProfileCaptured",
      accountId: data.accountId ?? null,
      onlineId: data.onlineId ?? null,
    },
    () => void chrome.runtime.lastError
  );
});
