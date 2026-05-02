const STORAGE_KEY = "psn_accounts";

const els = {
  list: document.getElementById("accountList"),
  listWrap: document.getElementById("accountListWrap"),
  empty: document.getElementById("emptyState"),
  form: document.getElementById("accountForm"),
  formTitle: document.getElementById("formTitle"),
  editId: document.getElementById("editId"),
  label: document.getElementById("label"),
  email: document.getElementById("email"),
  password: document.getElementById("password"),
  saveBtn: document.getElementById("saveBtn"),
  addBtn: document.getElementById("addBtn"),
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
  setError("");
  els.form.classList.add("hidden");
  els.addBtn.textContent = "+ Add";
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
  els.addBtn.textContent = "✕ Close";
  els.label.focus();
  els.form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderAccounts(accounts) {
  els.list.innerHTML = "";

  if (accounts.length === 0) {
    els.empty.classList.remove("hidden");
    els.listWrap.classList.add("hidden");
  } else {
    els.empty.classList.add("hidden");
    els.listWrap.classList.remove("hidden");
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

const tdActions = document.createElement("td");
    tdActions.className = "col-actions";
    const actionsWrap = document.createElement("div");
    actionsWrap.className = "col-actions-inner";
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
    actionsWrap.appendChild(editBtn);
    actionsWrap.appendChild(deleteBtn);
    tdActions.appendChild(actionsWrap);

    tr.appendChild(tdLabel);
    tr.appendChild(tdEmail);
    tr.appendChild(tdActions);
    els.list.appendChild(tr);
  });
}


els.addBtn.addEventListener("click", () => {
  if (els.form.classList.contains("hidden")) {
    els.form.classList.remove("hidden");
    els.addBtn.textContent = "✕ Close";
    els.label.focus();
  } else {
    resetForm();
  }
});

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
