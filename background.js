const STORAGE_KEY = "psn_accounts";
const REFRESH_KEY = "psn_refresh_state";

// A refresh-all run lives only in this worker instance's memory; if the worker
// was killed mid-run the persisted progress is stale, so clear it on startup.
chrome.storage.local.remove(REFRESH_KEY);

const CHECK_KEY = "psn_check_state";
const SSOCOOKIE_URL = "https://ca.account.sony.com/api/v1/ssocookie";
// Checks run one at a time (single slot), so a single reused DNR session-rule
// id is always enough — there is never more than one live rule.
const CHECK_DNR_RULE_ID = 1;

// A check-all run lives only in this worker instance's memory; clear stale
// persisted progress on startup, same reasoning as REFRESH_KEY above.
chrome.storage.local.remove(CHECK_KEY);

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
// Sony sometimes challenges the sign-in with a 2FA verification-code page, which
// can only be cleared by the user typing the emailed/texted code. When that
// happens we extend the capture window to this longer value so the interceptor
// isn't torn down while the user is still entering the code by hand.
const CODE_PAGE_CAPTURE_TIMEOUT_MS = 5 * 60_000;

// Tracks the account whose sign-in is in flight, so a captured profile can
// be matched to it. Only one sign-in is driven at a time.
let pendingAccountId = null;
let captureTimer = null;
// Resolves true when a profile was captured, false when the capture window
// timed out. Replaced each time startCapture arms; awaited by refreshAll to
// know when the in-flight account is finished.
let captureDone = Promise.resolve(false);
let captureDoneResolve = null;

// Chrome tears down an idle MV3 service worker after ~30s, and a pending bare
// setTimeout does NOT count as activity — so if nothing touches an extension
// API while a capture window is open (e.g. sign-in succeeded but the profile
// capture missed, and refreshAll is awaiting captureDone until the timeout),
// the worker dies, the timeout never fires, captureDone never settles, and the
// refresh-all queue hangs forever. Any extension API call resets the idle
// clock, so tick one every 20s while a capture is armed.
let keepaliveTimer = null;
function startKeepalive() {
  if (keepaliveTimer != null) return;
  keepaliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20_000);
}
function stopKeepalive() {
  clearInterval(keepaliveTimer);
  keepaliveTimer = null;
}

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
  captureDoneResolve?.(false); // settle any orphaned waiter from a prior arm
  captureDone = new Promise((resolve) => (captureDoneResolve = resolve));
  try {
    await chrome.scripting.unregisterContentScripts({ ids: INTERCEPTOR_IDS });
  } catch {}
  try {
    await chrome.scripting.registerContentScripts(INTERCEPTOR_SCRIPTS);
  } catch (e) {
    // If registration fails we log and let the sign-in proceed; the user
    // simply gets no profile capture. State is cleaned up later by the timeout.
    console.error("Failed to register interceptor", e);
  }
  captureTimer = setTimeout(() => {
    console.warn("Capture window timed out — no profile was captured for this sign-in");
    stopCapture(false);
  }, CAPTURE_TIMEOUT_MS);
  startKeepalive();
}

async function stopCapture(captured = false) {
  pendingAccountId = null;
  clearTimeout(captureTimer);
  captureTimer = null;
  stopKeepalive();
  const resolve = captureDoneResolve;
  captureDoneResolve = null;
  try {
    await chrome.scripting.unregisterContentScripts({ ids: INTERCEPTOR_IDS });
  } catch {}
  resolve?.(captured);
}

// Resets the capture teardown timer to a new duration. No-op if capture has
// already been stopped (a profile was captured, or the timeout already fired),
// so a late verification-code detection can't revive a finished sign-in.
function extendCapture(ms) {
  if (!pendingAccountId) return;
  clearTimeout(captureTimer);
  captureTimer = setTimeout(() => {
    console.warn("Extended capture window timed out — no profile was captured for this sign-in");
    stopCapture(false);
  }, ms);
}

// Retrieves the account's NPSSO token from the Sony SSO cookie endpoint.
//
// This must NOT be a plain fetch() from the service worker: the worker uses the
// default (non-incognito) cookie store — the manifest's default "spanning"
// incognito mode gives one shared worker — so when the user signs in inside a
// private window, a worker fetch reads a DIFFERENT account's Sony session and
// returns a stale token. It also cannot be an injected fetch from the
// playstation.com tab, because playstation.com and account.sony.com are
// different sites, so SameSite would strip the Sony cookies.
//
// Instead we open the endpoint as a top-level navigation in a background tab in
// the SAME window as the sign-in (openerTabId's window). That tab inherits the
// sign-in window's cookie store (correct account, even in a private window) and
// a top-level GET sends the SameSite Sony cookies — exactly replicating the
// working manual method (visiting the URL in the browser). We read the JSON
// back and close the tab. Returns the token string, or null on any failure —
// this never throws, so a token miss cannot break profile capture.
async function fetchNpsso(openerTabId) {
  if (openerTabId == null) return null;
  let tabId = null;
  try {
    const opener = await chrome.tabs.get(openerTabId);
    const tab = await chrome.tabs.create({
      windowId: opener.windowId,
      url: "https://ca.account.sony.com/api/v1/ssocookie",
      active: false,
    });
    tabId = tab.id;
    // Give the small JSON response time to load. A fixed delay avoids a race
    // where waitForTabLoad would attach its listener after "complete" fired.
    await new Promise((r) => setTimeout(r, 1500));
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          return document.body.innerText;
        } catch {
          return null;
        }
      },
    });
    const json = JSON.parse(injection?.result ?? "");
    return typeof json.npsso === "string" && json.npsso ? json.npsso : null;
  } catch (e) {
    console.error("Failed to fetch NPSSO", e);
    return null;
  } finally {
    if (tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {}
    }
  }
}

// Reads the signed-in account's avatar URL from the toolbar profile icon on
// the playstation.com tab, polling while the SPA toolbar renders it (the icon
// only mounts once the profile query resolves). Returns the https image URL,
// or null on any failure — an avatar miss never breaks profile capture.
async function fetchAvatarUrl(tabId) {
  if (tabId == null) return null;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        return new Promise((resolve) => {
          function tryIcon(attemptsLeft) {
            if (attemptsLeft === 0) return resolve(null);
            // Full path is "web-toolbar#profile-container#profile-icon#image#image"
            // — suffix match, same reasoning as the toolbar selectors in
            // driveToolbar.
            const img = document.querySelector('img[data-qa$="profile-icon#image#image"]');
            if (img && img.src && img.src.startsWith("https://")) return resolve(img.src);
            setTimeout(() => tryIcon(attemptsLeft - 1), 200);
          }
          tryIcon(50); // poll up to 10 s for the signed-in toolbar icon
        });
      },
    });
    return typeof result === "string" ? result : null;
  } catch (e) {
    console.error("Failed to read avatar URL", e);
    return null;
  }
}

// Two capture paths can race (the interceptor's message and the replay
// fallback below); the first one in wins and the loser returns early.
let captureHandling = false;

async function handleProfileCaptured({ accountId, onlineId }, tabId) {
  // A psnProfileCaptured message can arrive after the 90s timeout already
  // ran stopCapture; in that case there is nothing pending, so we return.
  if (!pendingAccountId || captureHandling) return;
  captureHandling = true;
  try {
    await persistCapturedProfile({ accountId, onlineId }, tabId);
  } finally {
    captureHandling = false;
  }
}

async function persistCapturedProfile({ accountId, onlineId }, tabId) {
  // Match the captured profile to the account by the stored row id
  // (pendingAccountId), NOT by the Sony accountId value in the payload.
  const id = pendingAccountId;
  // Identity guard: if this row was captured before and the profile that just
  // arrived belongs to a DIFFERENT PSN account, the signed-in session is not
  // the one we drove — e.g. Sony's SSO survived the sign-out and bounced the
  // previous account straight back in. Saving would overwrite this row with
  // another account's identity and NPSSO token, so fail the capture instead
  // and let the queue retry with a fresh sign-in. (Editing a row's email
  // clears its captured identity in the popup, so a legitimate account swap
  // cannot trip this.)
  if (accountId) {
    const row = (await loadAccounts()).find((a) => a.id === id);
    if (row?.accountId && row.accountId !== accountId) {
      console.warn(
        `Captured profile belongs to a different PSN account (accountId ${accountId}, expected ${row.accountId}) — refusing to save; failing this capture`
      );
      await stopCapture(false);
      return;
    }
  }
  // The session is confirmed live at this point, so fetch the NPSSO token and
  // the toolbar avatar in the same pass and persist them alongside the profile
  // fields. tabId is the signed-in playstation.com tab — fetchNpsso uses it
  // only to locate its window (so the token is read from the correct, possibly
  // private, cookie store); fetchAvatarUrl reads the toolbar icon from it.
  const [npsso, avatarUrl] = await Promise.all([fetchNpsso(tabId), fetchAvatarUrl(tabId)]);
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
      ...(npsso ? { npsso, npssoFetchedAt: Date.now() } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
    };
  });
  if (changed) await saveAccounts(next);
  await stopCapture(true);
}

// Same key-search as interceptor.js: the response nesting is not guaranteed
// stable, so search the whole parsed object for the first truthy value.
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

// Fallback capture for when the interceptor never reports: replay the page's
// own getProfileOracle request. The resource-timing timeline keeps the full
// request URL (persisted-query hash included) even when our fetch hook never
// saw the request — e.g. when the post-auth return restored the homepage from
// the back/forward cache, where content scripts do not re-inject. Replaying
// with the CURRENT cookies returns the newly signed-in account's profile no
// matter which session originally issued the request; Apollo's CSRF guard
// only demands a JSON content-type header. Polls for the timeline entry while
// the SPA is still booting. Resolves via handleProfileCaptured on success;
// a miss changes nothing (the capture timeout still owns cleanup).
async function captureProfileFallback(tabIds) {
  for (const tabId of tabIds ?? []) {
    if (!pendingAccountId) return; // the interceptor already reported
    let text = null;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab.url || !new URL(tab.url).hostname.endsWith("playstation.com")) continue;
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          return new Promise((resolve) => {
            function attempt(attemptsLeft) {
              const entry = performance
                .getEntriesByType("resource")
                .find((e) => e.name.includes("operationName=getProfileOracle"));
              if (!entry) {
                if (attemptsLeft <= 0) return resolve(null);
                return setTimeout(() => attempt(attemptsLeft - 1), 500);
              }
              fetch(entry.name, { credentials: "include", headers: { "content-type": "application/json" } })
                .then((r) => r.text())
                .then(resolve)
                .catch(() => resolve(null));
            }
            attempt(20); // poll up to 10s for the SPA to issue the profile query
          });
        },
      });
      text = result;
    } catch {
      continue; // tab gone or not injectable — try the next flow tab
    }
    if (typeof text !== "string") continue;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    const accountId = deepFind(json, "accountId");
    const onlineId = deepFind(json, "onlineId");
    if (accountId == null && onlineId == null) continue;
    console.warn("Interceptor missed the profile — captured via getProfileOracle replay fallback");
    await handleProfileCaptured(
      {
        accountId: accountId != null ? String(accountId) : null,
        onlineId: onlineId != null ? String(onlineId) : null,
      },
      tabId
    );
    return;
  }
}

// ── NPSSO validity check ──────────────────────────────────────────────────
//
// Validates an account's STORED npsso token against Sony's SSO endpoint.
// fetch() cannot set a Cookie header (it's a forbidden header), so a DNR
// session rule injects "Cookie: npsso=<token>" onto just this one request. The
// rule is scoped to resourceType "xmlhttprequest" so it can never affect
// fetchNpsso()'s main_frame tab navigation to the same URL. credentials:"omit"
// stops the browser adding its own cookies, so the stored token is the only
// thing on the wire and the response reflects that token alone — not the live
// browser session. Session rules (not dynamic) keep the token off DNR's
// on-disk rule store, and any leftover rule dies with the browser session.
//
// Returns { valid, rotated? } — rotated is set when Sony echoed a DIFFERENT
// token for the same session (rotation) so the caller can save the fresh one.
// Returns null when the result is indeterminate (network failure / non-JSON
// body) so a Sony outage never brands a token invalid. Never throws.
async function checkNpsso(account) {
  const token = account.npsso;
  if (!token) return null;
  const rule = {
    id: CHECK_DNR_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "cookie", operation: "set", value: `npsso=${token}` }],
    },
    condition: {
      urlFilter: "https://ca.account.sony.com/api/v1/ssocookie",
      resourceTypes: ["xmlhttprequest"],
    },
  };
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [CHECK_DNR_RULE_ID],
      addRules: [rule],
    });
    let res;
    try {
      res = await fetch(SSOCOOKIE_URL, { credentials: "omit", cache: "no-store" });
    } finally {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [CHECK_DNR_RULE_ID] });
    }
    if (res.status >= 500) return null; // server-side outage — indeterminate, don't brand invalid
    if (!res.ok) return { valid: false }; // 4xx — token rejected
    let json;
    try {
      json = await res.json();
    } catch {
      return null; // non-JSON body — indeterminate, record nothing
    }
    const returned = typeof json?.npsso === "string" && json.npsso ? json.npsso : null;
    if (returned) return { valid: true, ...(returned !== token ? { rotated: returned } : {}) };
    return { valid: false };
  } catch (e) {
    console.error("NPSSO validity check failed", e);
    // Make sure the rule is gone even if the failure happened before the
    // fetch's own finally could run (e.g. addRules itself threw).
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [CHECK_DNR_RULE_ID] });
    } catch {}
    return null;
  }
}

// Writes a check result to the account row. Rotates the stored token when Sony
// returned a fresh one for the same session.
async function persistCheckResult(id, result) {
  const accounts = await loadAccounts();
  let changed = false;
  const next = accounts.map((a) => {
    if (a.id !== id) return a;
    changed = true;
    return {
      ...a,
      npssoValid: result.valid,
      npssoCheckedAt: Date.now(),
      ...(result.rotated ? { npsso: result.rotated, npssoFetchedAt: Date.now() } : {}),
    };
  });
  if (changed) await saveAccounts(next);
}

// Guarded entry point for a single-account check (the checkNpsso message).
// Refuses while a sign-in or refresh could be in flight so the DNR rule and
// the capture pipeline never overlap. An indeterminate result records nothing.
async function runSingleCheck(id) {
  if (refreshing || pendingAccountId || checking) return;
  const account = (await loadAccounts()).find((a) => a.id === id);
  if (!account?.npsso) return;
  checking = true;
  try {
    const result = await checkNpsso(account);
    if (result) await persistCheckResult(id, result);
  } finally {
    checking = false;
  }
}

// True while a refresh-all queue is looping; single sign-ins are locked out
// for its duration (and refreshAll is a no-op while a single sign-in pends).
let refreshing = false;
let refreshCancelRequested = false;

// True while any NPSSO check (single check or check-all queue) is in flight;
// single sign-ins and refresh-all are locked out for its duration, and both
// runSingleCheck and checkAllNpsso are a no-op while a sign-in, refresh, or
// another check is active — this also keeps two concurrent single checks
// from racing on the shared CHECK_DNR_RULE_ID.
let checking = false;
let checkCancelRequested = false;

function setRefreshState(state) {
  return new Promise((resolve) => {
    if (state) chrome.storage.local.set({ [REFRESH_KEY]: state }, resolve);
    else chrome.storage.local.remove(REFRESH_KEY, resolve);
  });
}

function setCheckState(state) {
  return new Promise((resolve) => {
    if (state) chrome.storage.local.set({ [CHECK_KEY]: state }, resolve);
    else chrome.storage.local.remove(CHECK_KEY, resolve);
  });
}

// Checks every stored account that has an NPSSO, one at a time (the DNR rule is
// a single slot). Each result is written as it lands; an indeterminate result
// (network failure) records nothing and the loop moves on — a per-account
// failure never stops the run, only cancellation does. Progress is published
// to CHECK_KEY so the popup can render it across close/reopen.
async function checkAllNpsso() {
  if (checking || refreshing || pendingAccountId) return;
  const targets = (await loadAccounts()).filter((a) => a.npsso);
  if (targets.length === 0) return;
  checking = true;
  checkCancelRequested = false;
  try {
    for (let i = 0; i < targets.length; i++) {
      if (checkCancelRequested) break;
      const account = targets[i];
      await setCheckState({ running: true, index: i, total: targets.length, activeId: account.id });
      const result = await checkNpsso(account);
      if (result) await persistCheckResult(account.id, result);
    }
  } finally {
    checking = false;
    await setCheckState(null);
  }
}

async function closeTabs(tabIds) {
  for (const tabId of tabIds ?? []) {
    try {
      await chrome.tabs.remove(tabId);
    } catch {}
  }
}

// A transient failure — Sony's "Can't connect to the server." banner outliving
// the in-page re-clicks, a flaky page load — shouldn't kill the whole queue:
// each account gets up to this many full sign-in attempts (fresh tab, fresh
// sign-out/sign-in), with a cooldown between them so a struggling or
// rate-limiting server isn't immediately hammered again.
const ACCOUNT_ATTEMPT_LIMIT = 3;
const ACCOUNT_RETRY_DELAY_MS = 5000;

// Signs in every stored account in turn, refreshing its profile and NPSSO.
// Sequential by design — the capture pipeline (pendingAccountId) is a single
// slot. An account that fails (sign-in error or failed capture) is retried
// from scratch up to ACCOUNT_ATTEMPT_LIMIT times; only when it exhausts its
// attempts does the queue stop, leaving the last attempt's tabs open for
// inspection. Successful accounts' tabs are closed as the queue moves on.
// Progress is published to REFRESH_KEY so the popup can render it across
// close/reopen.
async function refreshAll() {
  if (refreshing || pendingAccountId || checking) return;
  const accounts = await loadAccounts();
  if (accounts.length === 0) return;
  refreshing = true;
  refreshCancelRequested = false;
  try {
    for (let i = 0; i < accounts.length; i++) {
      if (refreshCancelRequested) break;
      const account = accounts[i];
      await setRefreshState({ running: true, index: i, total: accounts.length, activeId: account.id });
      let tabIds = null;
      let captured = false;
      for (let attempt = 1; attempt <= ACCOUNT_ATTEMPT_LIMIT; attempt++) {
        if (attempt > 1) {
          // Retrying from scratch: close the failed attempt's tabs first (the
          // fresh openSignIn signs out whatever session the dead attempt may
          // have half-established, so no stale state can leak into the retry).
          await closeTabs(tabIds);
          tabIds = null;
          await new Promise((r) => setTimeout(r, ACCOUNT_RETRY_DELAY_MS));
          if (refreshCancelRequested) break;
        }
        // Reset the stale handle so a flow that throws before startCapture
        // re-arms it (e.g. a toolbar-drive failure) can't read the PREVIOUS
        // account's resolved captureDone as this attempt's success.
        captureDone = Promise.resolve(false);
        try {
          tabIds = await openSignIn(account.email, account.password, account.id);
        } catch (e) {
          tabIds = e.tabIds ?? tabIds; // adopt the dead attempt's tabs so the retry closes them
          // A thrown flow doesn't always mean a failed sign-in: Sony's SSO can
          // bounce the tab straight back to the signed-in homepage without
          // ever settling on the auth page (waitForSonyAuthTab times out)
          // while the capture still landed. Peek at captureDone without
          // blocking — racing an already-settled promise wins over the fresh
          // false — and salvage the attempt.
          const salvaged = await Promise.race([captureDone, Promise.resolve(false)]);
          if (salvaged) {
            console.warn(`Refresh-all: sign-in flow for ${account.email} threw but the capture landed — keeping it`, e);
            captured = true;
            break;
          }
          console.error(`Refresh-all sign-in attempt ${attempt} failed for`, account.email, e);
          await stopCapture(false); // tear down the interceptor if the failure happened after arming
          continue;
        }
        captured = await captureDone;
        if (captured) break;
        console.warn(`Refresh-all: capture attempt ${attempt}/${ACCOUNT_ATTEMPT_LIMIT} failed for ${account.email}` + (attempt < ACCOUNT_ATTEMPT_LIMIT ? " — retrying from scratch" : ""));
      }
      if (!captured) {
        console.error(`Refresh-all: giving up on ${account.email} after ${ACCOUNT_ATTEMPT_LIMIT} attempts — stopping the queue`);
        break;
      }
      await closeTabs(tabIds);
    }
  } finally {
    refreshing = false;
    await setRefreshState(null);
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.action === "openSignIn") {
    if (refreshing || checking) return;
    openSignIn(msg.email, msg.password, msg.id).catch(console.error);
  } else if (msg.action === "refreshAll") {
    refreshAll().catch(console.error);
  } else if (msg.action === "cancelRefreshAll") {
    refreshCancelRequested = true;
  } else if (msg.action === "checkNpsso") {
    runSingleCheck(msg.id).catch(console.error);
  } else if (msg.action === "checkAllNpsso") {
    checkAllNpsso().catch(console.error);
  } else if (msg.action === "cancelCheckAll") {
    checkCancelRequested = true;
  } else if (msg.action === "psnProfileCaptured") {
    // sender.tab is the playstation.com tab that relayed the capture; its
    // window determines which cookie store the NPSSO token is read from.
    handleProfileCaptured(msg, sender.tab?.id).catch(console.error);
  }
});

// Wraps driveSignInFlow so any tab created before a failure travels with the
// thrown error (err.tabIds) — refreshAll closes those tabs before retrying the
// account, instead of leaking one open tab per failed attempt.
async function openSignIn(email, password, accountId) {
  const tab = await chrome.tabs.create({ url: "https://www.playstation.com/en-gb/" });
  const createdTabIds = [tab.id];
  try {
    return await driveSignInFlow(tab, createdTabIds, email, password, accountId);
  } catch (e) {
    e.tabIds = [...new Set(createdTabIds)];
    throw e;
  }
}

async function driveSignInFlow(tab, createdTabIds, email, password, accountId) {
  await waitForTabLoad(tab.id);

  let outcome = await driveToolbar(tab.id);

  // An account is signed in. Log it out LOCALLY (delete cookies, no server-side
  // sign-out) so its NPSSO stays valid, then FRESH-NAVIGATE (not reload — a soft
  // reload can restore the signed-in page from the bfcache, verified in Phase 0)
  // and re-drive to the sign-in click. Tolerate up to 2 cycles.
  for (let logouts = 0; outcome === "needs-logout" && logouts < 2; logouts++) {
    await clearSonyCookies();
    await chrome.tabs.update(tab.id, { url: "https://www.playstation.com/en-gb/" });
    await waitForTabLoad(tab.id, 15_000).catch(() => {});
    outcome = await driveToolbar(tab.id);
  }

  if (outcome !== "signin-clicked") {
    // Don't barrel on into a guaranteed 30s "Timed out waiting for Sony auth
    // page" — fail now with the real reason: the sign-in button was never
    // clicked (toolbar never mounted, the local cookie-clear + re-navigate never
    // reached a logged-out toolbar, or Sony changed the toolbar selectors).
    throw new Error(`Toolbar drive ended in "${outcome}" without clicking sign-in`);
  }

  if (typeof email !== "string" || email.trim() === "") return [tab.id];

  // Arm the profile/NPSSO capture only NOW — after any previously signed-in
  // account has been signed out and we've committed to signing in the new one.
  // Registering the interceptor earlier (before the initial page load) let it
  // capture the OLD account's getProfileOracle on that first load, storing the
  // wrong profile AND reading the wrong account's npsso, then stopping before
  // the new account ever signed in. Arming here means only the new account's
  // post-auth homepage load is captured, and by then account.sony.com's SSO
  // session is the new account too.
  await startCapture(accountId);

  // Stage 2: the sign-in button may navigate the same tab or open a new
  // popup/tab — wait for a tab scoped to this session to reach the Sony auth page
  const authTab = await waitForSonyAuthTab(tab.id);
  createdTabIds.push(authTab.id);

  // The injected func returns a promise reporting how far the fill got, so a
  // miss fails this attempt IMMEDIATELY (throw → refreshAll retries from
  // scratch) instead of leaving an untouched email page to silently burn the
  // whole 90s capture window. The email poll is 20s: the tab's "complete"
  // status fires well before Sony's SPA renders the email field, and a slow
  // load routinely needs more than the 3s this poll used to allow.
  const [{ result: fillResult }] = await chrome.scripting.executeScript({
    target: { tabId: authTab.id },
    func: (emailToFill, passwordToFill) => {
      return new Promise((resolve) => {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;

        function fillInput(input, value) {
          nativeSetter.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }

        function tryPasswordClick(attemptsLeft) {
          if (attemptsLeft === 0) return resolve("password-button-timeout");
          const btn = document.querySelector("button#signin-password-button");
          if (!btn || btn.getAttribute("aria-disabled") === "true") {
            setTimeout(() => tryPasswordClick(attemptsLeft - 1), 100);
            return;
          }
          btn.click();
          resolve("submitted");
        }

        function tryPassword(attemptsLeft) {
          if (attemptsLeft === 0) return resolve("password-input-timeout");
          const input = document.querySelector("input#signin-password-input-password");
          if (!input) {
            setTimeout(() => tryPassword(attemptsLeft - 1), 200);
            return;
          }
          fillInput(input, passwordToFill);
          tryPasswordClick(30); // wait up to 3 s for React to enable the button
        }

        function tryEmail(attemptsLeft) {
          if (attemptsLeft === 0) return resolve("email-input-timeout");
          const input = document.querySelector("input#signin-entrance-input-signinId");
          if (!input) {
            setTimeout(() => tryEmail(attemptsLeft - 1), 200);
            return;
          }
          fillInput(input, emailToFill);
          const btn = document.querySelector("button#signin-entrance-button");
          if (btn) btn.click();

          if (passwordToFill) tryPassword(50); // poll up to 10 s for SPA to swap to password step
          else resolve("submitted");
        }

        tryEmail(100); // poll up to 20 s for the SPA to render the email field
      });
    },
    args: [email, password ?? null],
  });

  if (fillResult !== "submitted") {
    throw new Error(`Credential fill failed on the Sony auth page ("${fillResult}")`);
  }

  // After credentials are submitted Sony may interpose extra pages before
  // completing the sign-in: a 2FA verification-code challenge (needs a code only
  // the user has — surface the tab and extend the capture window so their manual
  // entry isn't cut off) and/or a passkey-creation prompt (dismissed
  // automatically via its "Remind Me Later" button). If neither appears (the
  // normal path), the watcher exits quietly and the interceptor captures the
  // profile once the homepage loads.
  await watchAuthInterstitials(authTab.id);

  // The tabs the flow was driven through (the auth step may have opened its
  // own popup) — refreshAll closes them between queue items so a run doesn't
  // pile up tabs per account.
  const flowTabIds = [...new Set([tab.id, authTab.id])];

  // Give the interceptor its chance, but don't depend on it: if the capture
  // is still pending once the auth flow has run its course, replay the
  // profile query directly (see captureProfileFallback). Both paths funnel
  // into handleProfileCaptured; whichever lands first wins.
  if (pendingAccountId) await captureProfileFallback(flowTabIds);

  return flowTabIds;
}

// Polls the auth tab after credential submission and handles the pages Sony can
// interpose before the sign-in completes:
// - Passkey-creation prompt: clicks its "Remind Me Later" button and keeps
//   watching (the flow continues on its own after dismissal).
// - 2FA verification-code page: focuses the tab/window for the user and extends
//   the capture timeout (once), then keeps watching — the passkey prompt can
//   still appear AFTER the user finishes typing the code, so the poll window is
//   stretched to match the extended capture instead of returning.
// - "Can't connect to the server." banner: Sony intermittently fails the
//   password submit with this transient error; the password field keeps its
//   value, so re-clicking Sign In recovers it. Retried at most
//   AUTH_RETRY_LIMIT times, with a cooldown between clicks so a banner that
//   lingers while the retried request is in flight isn't re-clicked. If the
//   banner outlives the retries, the attempt is declared dead: the capture is
//   failed immediately (stopCapture(false)) so refreshAll can start a fresh
//   attempt instead of waiting out the 90s capture timeout.
// Returns as soon as the tab navigates away or closes (sign-in completed), or
// after the poll window elapses.
const AUTH_RETRY_LIMIT = 3;
const AUTH_RETRY_COOLDOWN_MS = 3000;
async function watchAuthInterstitials(authTabId, ATTEMPTS = 60, INTERVAL_MS = 500) {
  let codePageSeen = false;
  let retriesLeft = AUTH_RETRY_LIMIT;
  let serverErrorStrikes = 0;
  for (let i = 0; i < ATTEMPTS; i++) {
    // Sign-in completed: the auth tab has navigated back to playstation.com.
    // This must be an explicit URL check — executeScript does NOT throw on
    // that navigation (the extension has host permission for playstation.com,
    // so injection succeeds and returns "none"), and without it the loop
    // polls the signed-in homepage for its whole remaining window: ~30s per
    // account normally, and up to 5 MINUTES when a 2FA code page stretched
    // ATTEMPTS — which stalled the refresh-all queue after each sign-in.
    // Checked positively against playstation.com (not "left my.account.
    // sony.com") so transient redirect hops mid-auth can't end the watch
    // while a passkey prompt could still appear.
    try {
      const tab = await chrome.tabs.get(authTabId);
      if (tab.url && new URL(tab.url).hostname.endsWith("playstation.com")) return;
    } catch {
      return; // tab closed — the flow is over either way
    }
    let state = null;
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: authTabId },
        func: (allowRetry) => {
          const remind = document.querySelector('button[data-qa="button-remind-later"]');
          if (remind && remind.getAttribute("aria-disabled") !== "true") {
            remind.click();
            return "remind-later-clicked";
          }
          // The React id (":r3:") is regenerated per render, so match the stable
          // aria-label instead. The flow is locked to en-gb, so the English label
          // is reliable; a localized flow would need the localized prefix.
          if (document.querySelector('input[aria-label^="Verification code"]')) {
            return "code-page";
          }
          // Match without the apostrophe — Sony may render "Can't" with a
          // curly quote.
          const msg = document.querySelector('span[data-qa="message"]');
          if (msg && msg.textContent.includes("connect to the server")) {
            if (allowRetry) {
              const btn = document.querySelector("button#signin-password-button");
              if (btn && btn.getAttribute("aria-disabled") !== "true") {
                btn.click();
                return "retry-clicked";
              }
            } else {
              // Banner still up and no in-page retries left.
              return "server-error";
            }
          }
          return "none";
        },
        args: [retriesLeft > 0],
      });
      state = result;
    } catch {
      // executeScript throws if the tab closed or landed on a host we can't
      // inject into — the sign-in flow has left the auth page. Stop. (It does
      // NOT throw on the post-auth playstation.com homepage — that exit is
      // the URL check at the top of the loop.)
      return;
    }
    if (state === "retry-clicked") {
      retriesLeft--;
      await new Promise((r) => setTimeout(r, AUTH_RETRY_COOLDOWN_MS));
    }
    // The banner outlived every in-page re-click: this sign-in attempt is
    // dead. Require two consecutive sightings — the first poll after the
    // final retry click comes only one cooldown later, and that retried
    // request may still be in flight — then fail the capture immediately
    // instead of letting the rest of the 90s timeout burn, so refreshAll can
    // move on to a fresh attempt for the account. (A fresh attempt is safe
    // even if the slow final retry was about to succeed: openSignIn signs
    // any existing session out before signing in.)
    serverErrorStrikes = state === "server-error" ? serverErrorStrikes + 1 : 0;
    if (serverErrorStrikes >= 2) {
      console.warn("'Can't connect to the server' banner outlived all retries — failing this sign-in attempt");
      await stopCapture(false);
      return;
    }
    if (state === "code-page" && !codePageSeen) {
      codePageSeen = true;
      try {
        const tab = await chrome.tabs.get(authTabId);
        await chrome.tabs.update(authTabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch {}
      extendCapture(CODE_PAGE_CAPTURE_TIMEOUT_MS);
      // Stretch the remaining poll window to the extended capture so a passkey
      // prompt shown after manual code entry still gets dismissed.
      ATTEMPTS = Math.ceil(CODE_PAGE_CAPTURE_TIMEOUT_MS / INTERVAL_MS);
      i = 0;
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

// Drives the toolbar on the PlayStation homepage. If an account is already
// signed in (profile icon present), reports back so the caller can clear
// cookies locally instead of clicking sign-out; otherwise clicks the sign-in
// button. Resolves to "signin-clicked", "needs-logout", or "timeout".
async function driveToolbar(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      return new Promise((resolve) => {
        function tryToolbar(attemptsLeft) {
          if (attemptsLeft === 0) return resolve("timeout");
          // Full path is "web-toolbar#profile-container#profile-icon#image#image".
          const profileIcon = document.querySelector('[data-qa$="profile-icon#image#image"]');
          if (profileIcon) {
            // An account is signed in. Do NOT click sign-out — that revokes the
            // SSO session server-side and kills the account's NPSSO. Report back
            // so the caller can clear cookies locally instead.
            return resolve("needs-logout");
          }
          // data-qa is the most stable hook, but Sony renames its container path
          // (e.g. "web-toolbar#profile-container#signin-button"), so match by
          // suffix and fall back to the toolbar's sign-in button class.
          const signInBtn =
            document.querySelector('[data-qa$="signin-button"]') ||
            document.querySelector("button.web-toolbar__signin-button");
          if (signInBtn) {
            signInBtn.click();
            resolve("signin-clicked");
            return;
          }
          setTimeout(() => tryToolbar(attemptsLeft - 1), 200);
        }

        tryToolbar(25); // poll up to 5 s for the SPA toolbar to mount
      });
    },
  });
  return result;
}

// Logs the current account out LOCALLY by deleting the specific Sony/PlayStation
// login + SSO cookies from the browser's cookie store — WITHOUT hitting Sony's
// server-side sign-out. The server session (and therefore the account's NPSSO)
// stays valid; only the local browser forgets it, so the toolbar renders
// logged-out and the next account can sign in fresh with no re-auth bounce.
// Cookie names + URLs verified minimal in Phase 0; every removal URL is covered
// by a host permission already in the manifest (no new host perms needed). Runs
// in the worker, which owns the cookie store. If Sony renames a cookie, its
// removal silently no-ops and the toolbar stays signed-in — driveSignInFlow's
// fallback then fails the account rather than clicking sign-out, so a rename
// degrades safely (no NPSSO is ever revoked).
async function clearSonyCookies() {
  const TARGETS = [
    { url: "https://ca.account.sony.com/", names: ["npsso", "JSESSIONID", "dars", "KP_uIDz-ssn"] },
    { url: "https://my.account.sony.com/", names: ["KP_uIDz-ssn"] },
    { url: "https://www.playstation.com/", names: ["isSignedIn", "pdccws_p", "session", "userinfo", "pdcsi", "pdcws2"] },
  ];
  for (const { url, names } of TARGETS) {
    for (const name of names) {
      try {
        await chrome.cookies.remove({ url, name });
      } catch (e) {
        console.warn(`clearSonyCookies: could not remove ${name} via ${url}`, e);
      }
    }
  }
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
