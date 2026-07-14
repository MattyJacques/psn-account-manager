# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Chrome/Brave browser extension (Manifest V3) for managing multiple PSN account credentials. No build step, no dependencies, no package manager — plain HTML, CSS, and vanilla JavaScript loaded directly by the browser extension runtime.

## Development Workflow

**Load the extension:**
1. Open `chrome://extensions` or `brave://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" and select this directory
4. Click the refresh icon on the extension card after any code change

There are no build commands, tests, or linters configured.

## Architecture

The extension has two entry points:
- **Popup:** `popup.html` + `popup.css` + `popup.js` — all UI and account management
- **Background service worker:** `background.js` — handles the `openSignIn` message from the popup; creates a tab navigating to `https://www.playstation.com/en-gb/`, waits for it to fully load, then drives the toolbar (`driveToolbar()`): if an account is already signed in (profile icon matched by `[data-qa$="profile-icon#image#image"]`), it opens the profile dropdown and clicks sign-out (`[data-qa$="sign-out#button"]`), waits for the logout reload, and re-runs the toolbar driver; otherwise it clicks the sign-in button (matched by `[data-qa$="signin-button"]` with a `button.web-toolbar__signin-button` fallback, since Sony periodically renames the `data-qa` container path), then waits for the Sony auth tab (`my.account.sony.com`) to open and injects a script that fills the email field, clicks the email-submit button, waits for the SPA to swap to the password step, fills the password field, and clicks the password-submit button. After submission, `watchAuthInterstitials()` polls the auth tab for pages Sony can interpose: a passkey-creation prompt (auto-dismissed by clicking its `[data-qa="button-remind-later"]` button) and the 2FA verification-code page (focuses the tab for manual entry, extends the capture timeout, and keeps watching so a passkey prompt shown after code entry is still dismissed)

**Profile / NPSSO capture timing (subtle — do not move):** `openSignIn()` arms the capture (`startCapture()`, which registers the `interceptor.js` content scripts) **only after** sign-out and clicking sign-in — NOT before the initial page load. If it armed earlier, the interceptor would capture the *previously* signed-in account's `getProfileOracle` on the first load (storing the wrong `accountId`/`onlineId` and reading the wrong account's npsso), then `stopCapture()` after that first hit — before the new account ever signed in. Arming after sign-in means only the new account's post-auth homepage load is captured, and by then `account.sony.com`'s SSO session is the new account too.

**Data flow:**
- All state lives in `chrome.storage.local` under the key `"psn_accounts"` as a JSON array
- `loadAccounts()` / `saveAccounts()` are the only storage access points
- `renderAccounts()` rebuilds the entire account list DOM from the in-memory array on every state change — there is no partial/incremental update

**Account object shape:**
```js
{ id, label, email, password, notes, createdAt, updatedAt?,
  accountId?, onlineId?, profileFetchedAt?, npsso?, npssoFetchedAt? }
```
- `id` comes from `uid()` (timestamp + random suffix)
- `password` is stored in plaintext in `chrome.storage.local`
- `accountId` / `onlineId` / `profileFetchedAt` are captured from the profile GraphQL response after a successful sign-in
- `npsso` / `npssoFetchedAt` hold the Sony SSO token fetched (also in plaintext) after that same sign-in — see below

**DOM pattern:**
- `els` object caches all static DOM references at startup
- Dynamic account rows are `div.acct` elements built in `renderAccounts()` — no table
- Each row (click to expand, tracked by the in-memory `expandedId`) shows: a status left-border + badge derived from `npssoStatus()` (NOT FETCHED / NPSSO ACTIVE / EXPIRING SOON at 51 days / EXPIRED at 61 days — the ~61-day NPSSO lifetime — plus a transient FETCHING while `fetchingId` is set), an avatar (gradient rounded square with initial), label, PSN ID and masked-NPSSO lines, a time-ago stamp, and a GET/SYNC button. Expanding reveals the full account ID and NPSSO token plus COPY NPSSO / EDIT ACCOUNT / DELETE action buttons
- The GET/SYNC button sends `{action: "openSignIn", email, password}` to the background service worker, which opens `www.playstation.com/en-gb/` and programmatically drives the full sign-in flow (email entry → password entry → submit) — opening via the PlayStation homepage preserves all OAuth params that a direct URL to the Sony auth page cannot replicate. **The stored password is passed to the background worker and injected directly into the Sony auth page via `scripting.executeScript()`.** `fetchingId` is cleared when the background's storage write triggers the popup's `storage.onChanged` re-render
- The inline form (styled per the Claude Design mock) has Label / Email / Password fields — `onlineId` and `accountId` are auto-captured only (not on the form; `onlineId` shown read-only in the collapsed row, `accountId` in the expanded detail view) — and toggles between "add" and "edit" modes via `startEdit()` / `resetForm()`
- The form has its own close (`#cancelBtn`) and Cancel (`#cancelBtn2`) buttons; the `#addBtn` header button also closes the form if already open
- The popup loads Manrope / JetBrains Mono from Google Fonts (allowed by the default MV3 extension-page CSP; falls back to system fonts offline)

## Permissions

`manifest.json` declares:
- `storage`, `clipboardWrite` — core popup features
- `tabs`, `scripting` — required for the background service worker to create a tab and inject the sign-in automation
- host permission `https://www.playstation.com/*` — required for `scripting.executeScript()` to click the sign-in button on the PlayStation homepage
- host permission `https://my.account.sony.com/*` — required for `scripting.executeScript()` to fill credentials on the Sony auth page
- host permission `https://ca.account.sony.com/*` — required to read the account's NPSSO token from `https://ca.account.sony.com/api/v1/ssocookie` once the session is live. `fetchNpsso()` opens that endpoint as a background tab **in the sign-in window** and reads the `{ "npsso" }` JSON back, then closes the tab. It must NOT be a service-worker `fetch()` (the shared worker uses the default cookie store, so it returns a stale account's token when the user signs in inside a private window) nor an injected fetch from the playstation.com tab (cross-site to `account.sony.com`, so SameSite strips the Sony cookies). The tab runs in `handleProfileCaptured` (the confirmed-signed-in signal), so `npsso` is persisted in the same write as the profile fields.

Do not add `clipboardRead`, `activeTab`, or broader host permissions — keep the surface minimal.
