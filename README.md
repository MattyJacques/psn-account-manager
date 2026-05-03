# PSN Account Manager

A small Chrome / Brave extension to keep track of PlayStation Network accounts (email, password, optional label and notes).

## Install (developer mode)

1. Open `chrome://extensions` (or `brave://extensions`).
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder (`psn-account-manager`).
4. Pin the extension to the toolbar for easy access.

## Features

- Add, edit, delete accounts.
- Optional label + notes per account.
- Show / hide passwords; one-click copy for email and password.
- Export to JSON, import from JSON, clear-all.
- Data stored in `chrome.storage.local` — never synced, never sent anywhere.

## Security note

Passwords are stored **in plaintext** in your local browser profile. Anyone with access to this Chrome/Brave profile (or its on-disk storage) can read them. Treat this like a sticky note, not a password vault. For shared machines or higher-sensitivity accounts, use a dedicated password manager.
