# PSN Account Manager — Table Layout & Form Cleanup

**Date:** 2026-05-02

## Summary

Redesign the account list from stacked cards to an HTML `<table>`, remove copy buttons for email and password, and remove the notes textarea from the add/edit form.

## Account List

Replace `<ul id="accountList">` with a `<table id="accountList">`. Structure:

```
<table>
  <thead>
    <tr><th>Label</th><th>Email</th><th>Password</th><th>Actions</th></tr>
  </thead>
  <tbody> <!-- built by renderAccounts() --> </tbody>
</table>
```

### Columns

| Column | Width | Notes |
|--------|-------|-------|
| Label | ~70px | Shows label text or italic "Untitled" if empty |
| Email | ~130px | Monospace, truncated with ellipsis |
| Password | ~100px | Masked bullets + inline Show/Hide toggle button |
| Actions | ~60px | Edit and Delete buttons |

- No copy buttons anywhere in the table.
- Password Show/Hide toggle reveals/masks the value in that cell only.
- `<thead>` row provides column headers with muted styling.
- Row hover state for visual feedback.

## Form Changes

- Remove the Notes `<textarea>` and its `<label>` from `popup.html`.
- Remove `els.notes` from the `els` DOM cache object in `popup.js`.
- In the form submit handler, stop reading `notes` from the form. When editing an existing account that has notes, preserve the stored `notes` value by spreading the existing account object — no data loss.
- In `startEdit()`, remove the line that sets `els.notes.value`.

## Code Removals

- Delete `copyToClipboard()` function — no longer used.
- Delete `makeRow()` helper — `renderAccounts()` will build `<tr>`/`<td>` cells directly.
- Remove `.account-list`, `.account`, `.account-head`, `.account-label`, `.account-row`, `.field-label`, `.value`, `.copy-btn`, `.notes` CSS rules.

## CSS Additions

New table styles replace the removed card styles:

- Wrap table in `div.account-list-wrap` — `max-height: 240px; overflow-y: auto` (replaces the current `max-height` on `.account-list`)
- `table#accountList` — `border-collapse: collapse`, full width
- `thead th` — `position: sticky; top: 0` with panel background so it stays visible on scroll; muted uppercase label, border-bottom
- `tbody tr:hover` — subtle background highlight
- `td` — padding, overflow, text-overflow where needed
- Password cell: flex row with masked value + Show button
- Actions cell: flex row with Edit/Delete buttons (existing button styles reused)

## Data Integrity

- Notes field is removed from the UI but not from the data model.
- Existing accounts with notes retain them in `chrome.storage.local`.
- On edit, notes are preserved via `{ ...existingAccount, label, email, password, updatedAt }` spread.
- Import/export JSON continues to include `notes` field transparently.
