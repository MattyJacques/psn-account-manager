// MAIN-world interceptor: runs at document_start (before the page's own
// scripts) and patches fetch/XHR to read the getProfileOracle GraphQL
// response, extracting accountId + onlineId. Cannot use chrome.* APIs —
// results are handed off via window.postMessage to interceptor-relay.js.
(() => {
  const TARGET = "operationName=getProfileOracle";

  // The response nesting is not guaranteed stable, so search the whole
  // parsed object for the first truthy accountId / onlineId.
  function deepFind(node, key) {
    if (node == null || typeof node !== "object") return undefined;
    const stack = [node];
    while (stack.length) {
      const cur = stack.pop();
      if (cur && typeof cur === "object") {
        if (Object.prototype.hasOwnProperty.call(cur, key) && cur[key] != null && cur[key] !== "") {
          return cur[key];
        }
        for (const v of Object.values(cur)) {
          if (v && typeof v === "object") stack.push(v);
        }
      }
    }
    return undefined;
  }

  function emit(text) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    const accountId = deepFind(json, "accountId");
    const onlineId = deepFind(json, "onlineId");
    if (accountId == null && onlineId == null) return;
    window.postMessage(
      {
        source: "psn-am",
        accountId: accountId != null ? String(accountId) : null,
        onlineId: onlineId != null ? String(onlineId) : null,
      },
      "*"
    );
  }

  function urlOf(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input.url === "string") return input.url;
    return "";
  }

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const promise = origFetch.apply(this, args);
    try {
      if (urlOf(args[0]).includes(TARGET)) {
        promise
          .then((res) => res.clone().text().then(emit))
          .catch(() => {});
      }
    } catch {}
    return promise;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__psnAmUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    try {
      if (this.__psnAmUrl && String(this.__psnAmUrl).includes(TARGET)) {
        this.addEventListener("load", () => {
          try {
            emit(this.responseText);
          } catch {}
        });
      }
    } catch {}
    return origSend.apply(this, args);
  };
})();
