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

The entire extension UI is a single popup: `popup.html` + `popup.css` + `popup.js`. There is no background service worker.

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
- Dynamic account rows are built with `createElement()` calls inside `renderAccounts()`
- Form state is toggled between "add" and "edit" modes via `startEdit()` / `resetForm()`

**Key limits and constants:**
- Notes capped at 200 characters
- Passwords are masked for display using `maskPassword()` (bullet characters); the raw value is only shown on explicit toggle

## Permissions

`manifest.json` declares `storage` and `clipboardWrite`. Do not add `clipboardRead`, `tabs`, `activeTab`, or broad host permissions unless strictly required — keep the permission surface minimal.
