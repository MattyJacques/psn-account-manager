const MAX_ACCOUNTS = 10;
const STORAGE_KEY = "psn_accounts";

const els = {
  list: document.getElementById("accountList"),
  empty: document.getElementById("emptyState"),
  count: document.getElementById("count"),
  form: document.getElementById("accountForm"),
  formTitle: document.getElementById("formTitle"),
  editId: document.getElementById("editId"),
  label: document.getElementById("label"),
  email: document.getElementById("email"),
  password: document.getElementById("password"),
  notes: document.getElementById("notes"),
  togglePwd: document.getElementById("togglePwd"),
  saveBtn: document.getElementById("saveBtn"),
  cancelBtn: document.getElementById("cancelBtn"),
  formError: document.getElementById("formError"),
  exportBtn: document.getElementById("exportBtn"),
  importBtn: document.getElementById("importBtn"),
  importFile: document.getElementById("importFile"),
  clearAllBtn: document.getElementById("clearAllBtn"),
};

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

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function setError(msg) {
  if (!msg) {
    els.formError.classList.add("hidden");
    els.formError.textContent = "";
  } else {
    els.formError.textContent = msg;
    els.formError.classList.remove("hidden");
  }
}

function resetForm() {
  els.form.reset();
  els.editId.value = "";
  els.formTitle.textContent = "Add account";
  els.saveBtn.textContent = "Save";
  els.cancelBtn.classList.add("hidden");
  els.password.type = "password";
  els.togglePwd.textContent = "Show";
  setError("");
}

function startEdit(account) {
  els.editId.value = account.id;
  els.label.value = account.label || "";
  els.email.value = account.email || "";
  els.password.value = account.password || "";
  els.notes.value = account.notes || "";
  els.formTitle.textContent = "Edit account";
  els.saveBtn.textContent = "Update";
  els.cancelBtn.classList.remove("hidden");
  setError("");
  els.label.focus();
  els.form.scrollIntoView({ behavior: "smooth", block: "start" });
}

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

function maskPassword(pwd) {
  return "•".repeat(Math.min(pwd.length, 12));
}

function renderAccounts(accounts) {
  els.list.innerHTML = "";
  els.count.textContent = String(accounts.length);

  if (accounts.length === 0) {
    els.empty.classList.remove("hidden");
  } else {
    els.empty.classList.add("hidden");
  }

  accounts.forEach((account) => {
    const li = document.createElement("li");
    li.className = "account";

    const head = document.createElement("div");
    head.className = "account-head";

    const labelEl = document.createElement("div");
    labelEl.className = "account-label";
    if (account.label) {
      labelEl.textContent = account.label;
    } else {
      const span = document.createElement("span");
      span.className = "untitled";
      span.textContent = "Untitled";
      labelEl.appendChild(span);
    }

    const actions = document.createElement("div");
    actions.className = "account-actions";

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

    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);
    head.appendChild(labelEl);
    head.appendChild(actions);
    li.appendChild(head);

    li.appendChild(makeRow("Email", account.email, account.email));

    const pwdRow = makeRow("Password", maskPassword(account.password), account.password, true);
    li.appendChild(pwdRow);

    if (account.notes && account.notes.trim()) {
      const notesEl = document.createElement("div");
      notesEl.className = "notes";
      notesEl.textContent = account.notes;
      li.appendChild(notesEl);
    }

    els.list.appendChild(li);
  });
}

function makeRow(labelText, displayValue, copyValue, isPassword = false) {
  const row = document.createElement("div");
  row.className = "account-row";

  const lab = document.createElement("span");
  lab.className = "field-label";
  lab.textContent = labelText;

  const val = document.createElement("span");
  val.className = "value";
  val.textContent = displayValue;

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "copy-btn";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", () => copyToClipboard(copyValue, copyBtn));

  row.appendChild(lab);
  row.appendChild(val);

  if (isPassword) {
    const showBtn = document.createElement("button");
    showBtn.type = "button";
    showBtn.className = "copy-btn";
    showBtn.textContent = "Show";
    let visible = false;
    showBtn.addEventListener("click", () => {
      visible = !visible;
      val.textContent = visible ? copyValue : maskPassword(copyValue);
      showBtn.textContent = visible ? "Hide" : "Show";
    });
    row.appendChild(showBtn);
  }

  row.appendChild(copyBtn);
  return row;
}

els.togglePwd.addEventListener("click", () => {
  if (els.password.type === "password") {
    els.password.type = "text";
    els.togglePwd.textContent = "Hide";
  } else {
    els.password.type = "password";
    els.togglePwd.textContent = "Show";
  }
});

els.cancelBtn.addEventListener("click", resetForm);

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  setError("");

  const id = els.editId.value;
  const label = els.label.value.trim();
  const email = els.email.value.trim();
  const password = els.password.value;
  const notes = els.notes.value.trim();

  if (!email || !password) {
    setError("Email and password are required.");
    return;
  }

  const accounts = await loadAccounts();

  if (!id && accounts.length >= MAX_ACCOUNTS) {
    setError(`Limit reached (${MAX_ACCOUNTS} accounts max).`);
    return;
  }

  const duplicate = accounts.find(
    (a) => a.email.toLowerCase() === email.toLowerCase() && a.id !== id,
  );
  if (duplicate) {
    setError("An account with this email already exists.");
    return;
  }

  let next;
  if (id) {
    next = accounts.map((a) =>
      a.id === id ? { ...a, label, email, password, notes, updatedAt: Date.now() } : a,
    );
  } else {
    next = [
      ...accounts,
      { id: uid(), label, email, password, notes, createdAt: Date.now() },
    ];
  }

  await saveAccounts(next);
  resetForm();
  renderAccounts(next);
});

els.exportBtn.addEventListener("click", async () => {
  const accounts = await loadAccounts();
  if (accounts.length === 0) {
    alert("Nothing to export.");
    return;
  }
  const blob = new Blob([JSON.stringify(accounts, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `psn-accounts-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

els.importBtn.addEventListener("click", () => els.importFile.click());

els.importFile.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error("Expected an array");

    const cleaned = data
      .filter((a) => a && typeof a.email === "string" && typeof a.password === "string")
      .slice(0, MAX_ACCOUNTS)
      .map((a) => ({
        id: a.id || uid(),
        label: typeof a.label === "string" ? a.label : "",
        email: a.email,
        password: a.password,
        notes: typeof a.notes === "string" ? a.notes : "",
        createdAt: a.createdAt || Date.now(),
      }));

    if (!confirm(`Replace existing accounts with ${cleaned.length} imported account(s)?`)) {
      e.target.value = "";
      return;
    }
    await saveAccounts(cleaned);
    renderAccounts(cleaned);
  } catch (err) {
    alert("Import failed: " + err.message);
  }
  e.target.value = "";
});

els.clearAllBtn.addEventListener("click", async () => {
  const accounts = await loadAccounts();
  if (accounts.length === 0) return;
  if (!confirm(`Delete all ${accounts.length} account(s)? This cannot be undone.`)) return;
  await saveAccounts([]);
  resetForm();
  renderAccounts([]);
});

(async function init() {
  const accounts = await loadAccounts();
  renderAccounts(accounts);
})();
