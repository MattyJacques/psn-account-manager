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
- **Background service worker:** `background.js` — handles the `openSignIn` message from the popup; creates a tab navigating to `https://www.playstation.com/en-gb/`, waits for it to fully load, then injects a script to click the sign-in button (`[data-qa="web-toolbar#signin-button"]`)

**Data flow:**
- All state lives in `chrome.storage.local` under the key `"psn_accounts"` as a JSON array
- `loadAccounts()` / `saveAccounts()` are the only storage access points
- `renderAccounts()` rebuilds the entire account list DOM from the in-memory array on every state change — there is no partial/incremental update

**Account object shape:**
```js
{ id, label, email, password, notes, createdAt, updatedAt? }
```
- `id` comes from `uid()` (timestamp + random suffix)
- `password` is stored in plaintext in `chrome.storage.local`

**DOM pattern:**
- `els` object caches all static DOM references at startup
- Dynamic account rows are `div.row` elements built in `renderAccounts()` — no table
- Each row has an avatar (gradient circle with initial), label + email, and icon buttons: fetch (first), copy email, edit, delete
- The fetch button sends `{action: "openSignIn"}` to the background service worker, which opens `www.playstation.com/en-gb/` and programmatically clicks the sign-in button — this preserves all OAuth params that a direct URL to the Sony auth page cannot replicate
- Form state is toggled between "add" and "edit" modes via `startEdit()` / `resetForm()`
- The form has its own cancel button (`#cancelBtn`); the `#addBtn` header button also closes the form if already open

## Permissions

`manifest.json` declares:
- `storage`, `clipboardWrite` — core popup features
- `tabs`, `scripting` — required for the background service worker to create a tab and inject the sign-in click
- host permission `https://www.playstation.com/*` — required for `scripting.executeScript()` to run on that domain

Do not add `clipboardRead`, `activeTab`, or broader host permissions — keep the surface minimal.
