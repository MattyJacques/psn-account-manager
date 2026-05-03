const STORAGE_KEY = "psn_accounts";

const AVATAR_GRADIENTS = [
  ["#a78bfa", "#6366f1"],
  ["#fb7185", "#e11d48"],
  ["#38bdf8", "#0284c7"],
  ["#34d399", "#059669"],
  ["#fb923c", "#ea580c"],
  ["#f472b6", "#db2777"],
  ["#a3e635", "#65a30d"],
  ["#e879f9", "#a21caf"],
];

const els = {
  list:       document.getElementById("accountList"),
  groupLabel: document.getElementById("groupLabel"),
  footerStat: document.getElementById("footerStat"),
  empty:      document.getElementById("emptyState"),
  form:       document.getElementById("accountForm"),
  formTitle:  document.getElementById("formTitle"),
  editId:     document.getElementById("editId"),
  label:      document.getElementById("label"),
  email:      document.getElementById("email"),
  password:   document.getElementById("password"),
  saveBtn:    document.getElementById("saveBtn"),
  addBtn:     document.getElementById("addBtn"),
  cancelBtn:  document.getElementById("cancelBtn"),
  formError:  document.getElementById("formError"),
  exportBtn:  document.getElementById("exportBtn"),
  importBtn:  document.getElementById("importBtn"),
  importFile: document.getElementById("importFile"),
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
  els.formTitle.textContent = "New account";
  els.saveBtn.textContent = "Save";
  setError("");
  els.form.classList.add("hidden");
}

function startEdit(account) {
  els.editId.value = account.id;
  els.label.value = account.label || "";
  els.email.value = account.email || "";
  els.password.value = account.password || "";
  els.formTitle.textContent = "Edit account";
  els.saveBtn.textContent = "Update";
  setError("");
  els.form.classList.remove("hidden");
  els.label.focus();
  els.form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function avatarStyle(index) {
  const [a, b] = AVATAR_GRADIENTS[index % AVATAR_GRADIENTS.length];
  return `background: linear-gradient(135deg, ${a}, ${b})`;
}

function avatarInitial(account) {
  const src = account.label || account.email;
  return src.charAt(0).toUpperCase();
}

const SVG_OPEN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
const SVG_COPY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const SVG_EDIT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
const SVG_DELETE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>`;

function renderAccounts(accounts) {
  els.list.innerHTML = "";

  const count = accounts.length;
  els.groupLabel.textContent = count > 0 ? `Accounts · ${count}` : "";
  els.footerStat.innerHTML = count > 0 ? `<strong>${count}</strong> account${count !== 1 ? "s" : ""}` : "";

  if (count === 0) {
    els.empty.classList.remove("hidden");
    return;
  }
  els.empty.classList.add("hidden");

  accounts.forEach((account, index) => {
    const row = document.createElement("div");
    row.className = "row";

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.style.cssText = avatarStyle(index);
    avatar.textContent = avatarInitial(account);

    const info = document.createElement("div");
    info.className = "row-info";

    const labelEl = document.createElement("span");
    if (account.label) {
      labelEl.className = "row-label";
      labelEl.textContent = account.label;
    } else {
      labelEl.className = "row-label untitled";
      labelEl.textContent = "Untitled";
    }

    const emailEl = document.createElement("span");
    emailEl.className = "row-email";
    emailEl.textContent = account.email;
    emailEl.title = account.email;

    info.appendChild(labelEl);
    info.appendChild(emailEl);

    const actions = document.createElement("div");
    actions.className = "row-actions";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "qa-btn";
    copyBtn.title = "Copy email";
    copyBtn.innerHTML = SVG_COPY;
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(account.email);
    });

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "qa-btn";
    editBtn.title = "Edit";
    editBtn.innerHTML = SVG_EDIT;
    editBtn.addEventListener("click", () => startEdit(account));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "qa-btn danger";
    deleteBtn.title = "Delete";
    deleteBtn.innerHTML = SVG_DELETE;
    deleteBtn.addEventListener("click", async () => {
      if (!confirm(`Delete account "${account.label || account.email}"?`)) return;
      const all = await loadAccounts();
      const next = all.filter((a) => a.id !== account.id);
      await saveAccounts(next);
      renderAccounts(next);
    });

    const fetchBtn = document.createElement("button");
    fetchBtn.type = "button";
    fetchBtn.className = "qa-btn";
    fetchBtn.title = "Sign in to PSN";
    fetchBtn.innerHTML = SVG_OPEN;
    fetchBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ action: "openSignIn", email: account.email });
    });

    actions.appendChild(fetchBtn);
    actions.appendChild(copyBtn);
    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);

    row.appendChild(avatar);
    row.appendChild(info);
    row.appendChild(actions);
    els.list.appendChild(row);
  });
}

els.addBtn.addEventListener("click", () => {
  if (els.form.classList.contains("hidden")) {
    els.form.classList.remove("hidden");
    els.label.focus();
  } else {
    resetForm();
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

  if (!email || !password) {
    setError("Email and password are required.");
    return;
  }

  const accounts = await loadAccounts();

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
      a.id === id ? { ...a, label, email, password, updatedAt: Date.now() } : a,
    );
  } else {
    next = [
      ...accounts,
      { id: uid(), label, email, password, notes: "", createdAt: Date.now() },
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

(async function init() {
  const accounts = await loadAccounts();
  renderAccounts(accounts);
})();
