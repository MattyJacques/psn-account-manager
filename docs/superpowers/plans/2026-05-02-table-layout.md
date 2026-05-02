# Table Layout & Form Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stacked account card list with an HTML table, remove email/password copy buttons, and remove the notes field from the add/edit form.

**Architecture:** Three files change — `popup.html` (markup), `popup.js` (rendering logic), `popup.css` (styles). No build step; reload the extension in the browser to verify each change. The `<tbody id="accountList">` approach keeps the JS `els.list` reference working without renaming it.

**Tech Stack:** Vanilla JS, HTML, CSS — browser extension Manifest V3, no framework, no bundler.

---

### Task 1: Remove notes from the form

**Files:**
- Modify: `popup.html`
- Modify: `popup.js`

- [ ] **Step 1: Remove the notes textarea from popup.html**

Delete this block (lines 46–49):

```html
      <label>
        <span>Notes (optional)</span>
        <textarea id="notes" rows="2" maxlength="200" placeholder="Region, recovery code hint, etc."></textarea>
      </label>
```

- [ ] **Step 2: Remove els.notes from the DOM cache in popup.js**

In the `els` object (line 14), delete:

```js
  notes: document.getElementById("notes"),
```

- [ ] **Step 3: Remove notes read from the form submit handler**

In the submit handler (around line 227), delete:

```js
  const notes = els.notes.value.trim();
```

- [ ] **Step 4: Preserve notes on edit, omit notes on add**

In the submit handler, find the edit branch (the `map` call) and ensure notes are preserved via the spread — change:

```js
a.id === id ? { ...a, label, email, password, notes, updatedAt: Date.now() } : a,
```

to:

```js
a.id === id ? { ...a, label, email, password, updatedAt: Date.now() } : a,
```

Find the add branch (the new account object) and change:

```js
{ id: uid(), label, email, password, notes, createdAt: Date.now() },
```

to:

```js
{ id: uid(), label, email, password, notes: "", createdAt: Date.now() },
```

- [ ] **Step 5: Remove notes line from startEdit()**

In `startEdit()` (around line 69), delete:

```js
  els.notes.value = account.notes || "";
```

- [ ] **Step 6: Reload extension and verify**

1. Open `brave://extensions` (or `chrome://extensions`), click the refresh icon on the PSN Account Manager card.
2. Open the popup.
3. Confirm the Notes textarea is gone from the form.
4. Add an account — it should save successfully without notes.
5. Click Edit on an existing account that had notes — confirm no notes field appears and saving the edit does not wipe stored notes (verify via Export).

- [ ] **Step 7: Commit**

```bash
git add popup.html popup.js
git commit -m "feat: remove notes field from add/edit form"
```

---

### Task 2: Convert account list to HTML table

**Files:**
- Modify: `popup.html`
- Modify: `popup.js`

- [ ] **Step 1: Replace the ul with a table in popup.html**

Replace:

```html
    <ul id="accountList" class="account-list" aria-live="polite"></ul>
```

with:

```html
    <div class="account-list-wrap">
      <table class="account-table">
        <thead>
          <tr>
            <th>Label</th>
            <th>Email</th>
            <th>Password</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="accountList" aria-live="polite"></tbody>
      </table>
    </div>
```

- [ ] **Step 2: Delete copyToClipboard() from popup.js**

Remove the entire function (lines 78–92):

```js
async function copyToClipboard(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const original = button.textContent;
    button.textContent = "Copied";
    button.classList.add("copied");
    setTimeout(() => {
      button.textContent = original;
      button.classList.remove("copied");
    }, 1200);
  } catch {
    button.textContent = "Failed";
    setTimeout(() => { button.textContent = "Copy"; }, 1200);
  }
}
```

- [ ] **Step 3: Replace renderAccounts() and delete makeRow()**

Delete the existing `renderAccounts()` function (lines 98–166) and the `makeRow()` function (lines 168–205), then insert the new `renderAccounts()` in their place:

```js
function renderAccounts(accounts) {
  els.list.innerHTML = "";
  els.count.textContent = String(accounts.length);

  if (accounts.length === 0) {
    els.empty.classList.remove("hidden");
  } else {
    els.empty.classList.add("hidden");
  }

  accounts.forEach((account) => {
    const tr = document.createElement("tr");

    const tdLabel = document.createElement("td");
    tdLabel.className = "col-label";
    if (account.label) {
      tdLabel.textContent = account.label;
    } else {
      const span = document.createElement("span");
      span.className = "untitled";
      span.textContent = "Untitled";
      tdLabel.appendChild(span);
    }

    const tdEmail = document.createElement("td");
    tdEmail.className = "col-email";
    tdEmail.textContent = account.email;
    tdEmail.title = account.email;

    const tdPwd = document.createElement("td");
    tdPwd.className = "col-password";
    const pwdVal = document.createElement("span");
    pwdVal.className = "pwd-value";
    pwdVal.textContent = maskPassword(account.password);
    const showBtn = document.createElement("button");
    showBtn.type = "button";
    showBtn.className = "icon-btn";
    showBtn.textContent = "Show";
    let visible = false;
    showBtn.addEventListener("click", () => {
      visible = !visible;
      pwdVal.textContent = visible ? account.password : maskPassword(account.password);
      showBtn.textContent = visible ? "Hide" : "Show";
    });
    tdPwd.appendChild(pwdVal);
    tdPwd.appendChild(showBtn);

    const tdActions = document.createElement("td");
    tdActions.className = "col-actions";
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => startEdit(account));
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "delete";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", async () => {
      if (!confirm(`Delete account "${account.label || account.email}"?`)) return;
      const all = await loadAccounts();
      const next = all.filter((a) => a.id !== account.id);
      await saveAccounts(next);
      renderAccounts(next);
    });
    tdActions.appendChild(editBtn);
    tdActions.appendChild(deleteBtn);

    tr.appendChild(tdLabel);
    tr.appendChild(tdEmail);
    tr.appendChild(tdPwd);
    tr.appendChild(tdActions);
    els.list.appendChild(tr);
  });
}
```

- [ ] **Step 4: Reload extension and verify**

1. Reload the extension, open the popup.
2. Confirm accounts appear as table rows with Label, Email, Password (masked), and Edit/Delete columns.
3. Click Show on a password row — confirm it reveals and hides.
4. Click Edit — confirm the form populates correctly.
5. Click Delete — confirm the row is removed.
6. Confirm no Copy buttons exist anywhere in the table.

- [ ] **Step 5: Commit**

```bash
git add popup.html popup.js
git commit -m "feat: replace account card list with html table"
```

---

### Task 3: Update CSS

**Files:**
- Modify: `popup.css`

- [ ] **Step 1: Remove old card styles**

Delete these rule blocks entirely from `popup.css`:

- `.account-list { ... }` (the `display: flex; flex-direction: column` block)
- `.account { ... }`
- `.account-head { ... }`
- `.account-label { ... }`
- `.account-label .untitled { ... }`
- `.account-actions { ... }`
- `.account-actions button { ... }`
- `.account-actions button:hover { ... }`
- `.account-actions .delete:hover { ... }`
- `.account-row { ... }`
- `.account-row .field-label { ... }`
- `.account-row .value { ... }`
- `.copy-btn { ... }`
- `.copy-btn:hover { ... }`
- `.copy-btn.copied { ... }`
- `.notes { ... }`

- [ ] **Step 2: Add table styles**

Insert the following after the `.empty-state` rule:

```css
.account-list-wrap {
  max-height: 240px;
  overflow-y: auto;
  margin-bottom: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.account-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

.account-table thead th {
  position: sticky;
  top: 0;
  background: var(--panel);
  color: var(--muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 5px 8px;
  text-align: left;
  border-bottom: 1px solid var(--border);
  font-weight: 500;
}

.account-table thead th:nth-child(1) { width: 18%; }
.account-table thead th:nth-child(2) { width: 34%; }
.account-table thead th:nth-child(3) { width: 28%; }
.account-table thead th:nth-child(4) { width: 20%; }

.account-table tbody tr {
  border-bottom: 1px solid var(--border);
}

.account-table tbody tr:last-child {
  border-bottom: none;
}

.account-table tbody tr:hover {
  background: var(--panel-2);
}

.account-table td {
  padding: 5px 8px;
  vertical-align: middle;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.col-label {
  font-weight: 600;
}

.col-label .untitled {
  color: var(--muted);
  font-weight: 500;
  font-style: italic;
}

.col-email {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--muted);
}

.col-password {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: visible;
}

.col-password .pwd-value {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  letter-spacing: 1px;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}

.col-actions {
  display: flex;
  gap: 4px;
  overflow: visible;
}

.col-actions button {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--muted);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
}

.col-actions button:hover { color: var(--text); border-color: var(--accent); }
.col-actions .delete:hover { color: var(--danger); border-color: var(--danger); }
```

- [ ] **Step 3: Reload extension and do a full visual check**

1. Reload the extension, open the popup.
2. Confirm the table renders cleanly with column headers.
3. Confirm long email addresses truncate with ellipsis (hover shows full email via `title` attribute).
4. Confirm the header row stays fixed when scrolling with many accounts.
5. Confirm row hover highlight works.
6. Confirm Edit/Delete buttons style correctly (muted border, accent on hover, red on delete hover).
7. Confirm the Show/Hide button in the password column uses the existing `icon-btn` style.
8. Confirm the form still looks correct (no notes field, password show/hide button still present).

- [ ] **Step 4: Commit**

```bash
git add popup.css
git commit -m "feat: replace card styles with table styles, remove unused card/copy css"
```
