// MAIN-world interceptor: runs at document_start (before the page's own
// scripts). The PlayStation SPA fires the getProfileOracle GraphQL request
// with an AbortController and cancels it during a route swap, so reading the
// page's own response is unreliable (the body read rejects with AbortError).
//
// Instead, when we see the page issue getProfileOracle, we REPLAY the same
// request (same URL + headers — so there is no persisted-query hash to
// maintain) WITHOUT the abort signal. Our copy completes even when the page
// cancels its own. We read accountId/onlineId and hand them to
// interceptor-relay.js via window.postMessage (MAIN world cannot use chrome.*).
(() => {
  const TARGET = "operationName=getProfileOracle";
  const origFetch = window.fetch;
  let captured = false;

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

  // Parse, extract, and post. Returns true if ids were found and posted.
  function emit(text) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return false;
    }
    const accountId = deepFind(json, "accountId");
    const onlineId = deepFind(json, "onlineId");
    if (accountId == null && onlineId == null) return false;
    window.postMessage(
      {
        source: "psn-am",
        accountId: accountId != null ? String(accountId) : null,
        onlineId: onlineId != null ? String(onlineId) : null,
      },
      "*"
    );
    return true;
  }

  function urlOf(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input.url === "string") return input.url;
    return "";
  }

  // Replay the page's getProfileOracle request without its abort signal so a
  // route swap cannot cancel our copy. Reuses the page's headers/credentials
  // (carrying whatever auth the page used) and runs at most once per page.
  function replay(input, init) {
    if (captured) return;
    captured = true;

    let url;
    let opts;
    if (input instanceof Request) {
      url = input.url;
      opts = {
        method: input.method,
        headers: input.headers,
        credentials: input.credentials === "omit" ? "include" : input.credentials || "include",
      };
    } else {
      url = urlOf(input);
      opts = Object.assign({}, init);
      delete opts.signal; // drop the page's AbortController
      if (!opts.credentials) opts.credentials = "include"; // ensure cookies
    }

    origFetch(url, opts)
      .then((res) => res.text())
      .then((text) => {
        if (!emit(text)) captured = false; // allow a later trigger to retry
      })
      .catch(() => {
        captured = false;
      });
  }

  window.fetch = function (...args) {
    const promise = origFetch.apply(this, args);
    try {
      if (urlOf(args[0]).includes(TARGET)) replay(args[0], args[1]);
    } catch {}
    return promise;
  };

  // XHR fallback: if the SPA ever uses XHR for this op, read it on load.
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__psnAmUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    try {
      if (this.__psnAmUrl && String(this.__psnAmUrl).includes(TARGET) && !captured) {
        this.addEventListener("load", () => {
          try {
            if (emit(this.responseText)) captured = true;
          } catch {}
        });
      }
    } catch {}
    return origSend.apply(this, args);
  };
})();
