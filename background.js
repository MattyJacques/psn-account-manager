const STORAGE_KEY = "psn_accounts";

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
  captureTimer = setTimeout(stopCapture, CAPTURE_TIMEOUT_MS);
}

async function stopCapture() {
  pendingAccountId = null;
  clearTimeout(captureTimer);
  captureTimer = null;
  try {
    await chrome.scripting.unregisterContentScripts({ ids: INTERCEPTOR_IDS });
  } catch {}
}

// Resets the capture teardown timer to a new duration. No-op if capture has
// already been stopped (a profile was captured, or the timeout already fired),
// so a late verification-code detection can't revive a finished sign-in.
function extendCapture(ms) {
  if (!pendingAccountId) return;
  clearTimeout(captureTimer);
  captureTimer = setTimeout(stopCapture, ms);
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

async function handleProfileCaptured({ accountId, onlineId }, tabId) {
  // A psnProfileCaptured message can arrive after the 90s timeout already
  // ran stopCapture; in that case there is nothing pending, so we return.
  if (!pendingAccountId) return;
  // Match the captured profile to the account by the stored row id
  // (pendingAccountId), NOT by the Sony accountId value in the payload.
  const id = pendingAccountId;
  // The session is confirmed live at this point, so fetch the NPSSO token in
  // the same pass and persist it alongside the profile fields. tabId is the
  // signed-in playstation.com tab — used only to locate its window, so the
  // token is read from the correct (possibly private) cookie store.
  const npsso = await fetchNpsso(tabId);
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
    };
  });
  if (changed) await saveAccounts(next);
  await stopCapture();
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.action === "openSignIn") {
    openSignIn(msg.email, msg.password, msg.id).catch(console.error);
  } else if (msg.action === "psnProfileCaptured") {
    // sender.tab is the playstation.com tab that relayed the capture; its
    // window determines which cookie store the NPSSO token is read from.
    handleProfileCaptured(msg, sender.tab?.id).catch(console.error);
  }
});

async function openSignIn(email, password, accountId) {
  const tab = await chrome.tabs.create({ url: "https://www.playstation.com/en-gb/" });

  await waitForTabLoad(tab.id);

  const outcome = await driveToolbar(tab.id);

  if (outcome === "logged-out") {
    // Signing out normally reloads the page; if Sony ever signs out in-place
    // without navigating, fall through after the timeout and try anyway.
    await waitForTabLoad(tab.id, 15_000).catch(() => {});
    await driveToolbar(tab.id); // now signed out, this clicks sign-in
  }

  if (typeof email !== "string" || email.trim() === "") return;

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

  await chrome.scripting.executeScript({
    target: { tabId: authTab.id },
    func: (emailToFill, passwordToFill) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;

      function fillInput(input, value) {
        nativeSetter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }

      function tryPasswordClick(attemptsLeft) {
        if (attemptsLeft === 0) return;
        const btn = document.querySelector("button#signin-password-button");
        if (!btn || btn.getAttribute("aria-disabled") === "true") {
          setTimeout(() => tryPasswordClick(attemptsLeft - 1), 100);
          return;
        }
        btn.click();
      }

      function tryPassword(attemptsLeft) {
        if (attemptsLeft === 0) return;
        const input = document.querySelector("input#signin-password-input-password");
        if (!input) {
          setTimeout(() => tryPassword(attemptsLeft - 1), 200);
          return;
        }
        fillInput(input, passwordToFill);
        tryPasswordClick(20); // wait up to 2 s for React to enable the button
      }

      function tryEmail(attemptsLeft) {
        if (attemptsLeft === 0) return;
        const input = document.querySelector("input#signin-entrance-input-signinId");
        if (!input) {
          setTimeout(() => tryEmail(attemptsLeft - 1), 200);
          return;
        }
        fillInput(input, emailToFill);
        const btn = document.querySelector("button#signin-entrance-button");
        if (btn) btn.click();

        if (passwordToFill) tryPassword(25); // poll up to 5 s for SPA to swap to password step
      }

      tryEmail(15); // poll up to 3 s for SPA render
    },
    args: [email, password ?? null],
  });

  // After credentials are submitted Sony may challenge with a 2FA verification-
  // code page instead of completing the sign-in. That step needs a code only the
  // user has, so automation stops here: surface the auth tab and extend the
  // capture window so their manual entry isn't cut off. If no code page appears
  // (the normal path), the watcher exits quietly and the interceptor captures
  // the profile once the homepage loads.
  await watchForVerificationCode(authTab.id);
}

// Polls the auth tab for the verification-code input. If it appears, focuses the
// tab/window for the user and extends the capture timeout, then returns. Returns
// as soon as the tab navigates away or closes (sign-in completed without a
// challenge), or after the poll window elapses.
async function watchForVerificationCode(authTabId, ATTEMPTS = 60, INTERVAL_MS = 500) {
  for (let i = 0; i < ATTEMPTS; i++) {
    let present = false;
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: authTabId },
        // The React id (":r3:") is regenerated per render, so match the stable
        // aria-label instead. The flow is locked to en-gb, so the English label
        // is reliable; a localized flow would need the localized prefix.
        func: () => !!document.querySelector('input[aria-label^="Verification code"]'),
      });
      present = result === true;
    } catch {
      // executeScript throws once the tab navigates to the post-auth homepage or
      // closes — i.e. the sign-in completed without a code challenge. Stop.
      return;
    }
    if (present) {
      try {
        const tab = await chrome.tabs.get(authTabId);
        await chrome.tabs.update(authTabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch {}
      extendCapture(CODE_PAGE_CAPTURE_TIMEOUT_MS);
      return;
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

// Drives the toolbar on the PlayStation homepage. If an account is already
// signed in (profile icon present), opens the profile dropdown and clicks
// sign-out; otherwise clicks the sign-in button. Resolves to "signin-clicked",
// "logged-out", or "timeout".
async function driveToolbar(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      return new Promise((resolve) => {
        function trySignOut(attemptsLeft) {
          if (attemptsLeft === 0) return resolve("timeout");
          // Full path is "web-toolbar#profile-container#profile-dropdown#
          // item-list#sign-out#button" — suffix match for the same reason
          // as the sign-in button below.
          const btn = document.querySelector('[data-qa$="sign-out#button"]');
          if (!btn) {
            setTimeout(() => trySignOut(attemptsLeft - 1), 200);
            return;
          }
          btn.click();
          resolve("logged-out");
        }

        function tryToolbar(attemptsLeft) {
          if (attemptsLeft === 0) return resolve("timeout");
          // Full path is "web-toolbar#profile-container#profile-icon#image#image".
          const profileIcon = document.querySelector('[data-qa$="profile-icon#image#image"]');
          if (profileIcon) {
            // An account is already signed in — sign it out first.
            profileIcon.click();
            trySignOut(25); // poll up to 5 s for the dropdown to open
            return;
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
