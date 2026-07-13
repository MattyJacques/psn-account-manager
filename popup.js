const STORAGE_KEY = "psn_accounts";

const CSV_FIELDS = [
  "id", "label", "email", "password", "notes", "createdAt", "updatedAt",
  "accountId", "onlineId", "profileFetchedAt", "npsso", "npssoFetchedAt",
];

function csvEscape(value) {
  if (value === undefined || value === null) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function accountsToCSV(accounts) {
  const lines = [CSV_FIELDS.join(",")];
  for (const a of accounts) {
    lines.push(CSV_FIELDS.map((f) => csvEscape(a[f])).join(","));
  }
  return lines.join("\r\n");
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // skip; \n below terminates the row
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

const AVATAR_GRADIENTS = [
  ["#3a91ff", "#0a4bd6"],
  ["#8b5cf6", "#6d28d9"],
  ["#14b8a6", "#0d9488"],
  ["#fb7185", "#e11d48"],
  ["#fb923c", "#ea580c"],
  ["#f472b6", "#db2777"],
  ["#a3e635", "#65a30d"],
  ["#e879f9", "#a21caf"],
];

// NPSSO tokens are valid for ~61 days from issue.
const DAY_MS = 24 * 60 * 60 * 1000;
const NPSSO_TTL_DAYS = 61;
const NPSSO_WARN_DAYS = 51;

const STATUS_META = {
  active:   { label: "NPSSO ACTIVE",  color: "#2fd3a0" },
  soon:     { label: "EXPIRING SOON", color: "#f5b945" },
  expired:  { label: "EXPIRED",       color: "#ff5d6c" },
  none:     { label: "NOT FETCHED",   color: "#6b7689" },
  fetching: { label: "FETCHING",      color: "#3a93ff" },
};

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
  cancelBtn2: document.getElementById("cancelBtn2"),
  formError:  document.getElementById("formError"),
  exportBtn:  document.getElementById("exportBtn"),
  importBtn:  document.getElementById("importBtn"),
  importFile: document.getElementById("importFile"),
};

let expandedId = null;
let fetchingId = null;

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

function npssoStatus(account) {
  if (fetchingId === account.id) return "fetching";
  if (!account.npsso) return "none";
  const age = Date.now() - (account.npssoFetchedAt || 0);
  if (age >= NPSSO_TTL_DAYS * DAY_MS) return "expired";
  if (age >= NPSSO_WARN_DAYS * DAY_MS) return "soon";
  return "active";
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + "s ago";
  const mn = Math.floor(s / 60);
  if (mn < 60) return mn + "m ago";
  const h = Math.floor(mn / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

function line(key, value, muted) {
  const wrap = document.createElement("div");
  wrap.className = "acct-line";
  const keyEl = document.createElement("span");
  keyEl.className = "acct-key";
  keyEl.textContent = key;
  const valEl = document.createElement("span");
  valEl.className = muted ? "acct-val muted" : "acct-val";
  valEl.textContent = value;
  valEl.title = value;
  wrap.appendChild(keyEl);
  wrap.appendChild(valEl);
  return wrap;
}

function detailBox(key, value, isToken) {
  const box = document.createElement("div");
  box.className = "detail-box";
  const keyEl = document.createElement("span");
  keyEl.className = "detail-key";
  keyEl.textContent = key;
  const valEl = document.createElement("span");
  valEl.className = isToken ? "detail-val token" : "detail-val";
  valEl.textContent = value;
  box.appendChild(keyEl);
  box.appendChild(valEl);
  return box;
}

function buildDetail(account) {
  const detail = document.createElement("div");
  detail.className = "acct-detail";

  detail.appendChild(detailBox("ACCOUNT ID", account.accountId || "—"));
  if (account.npsso) {
    detail.appendChild(detailBox("NPSSO TOKEN", account.npsso, true));
  }

  const actions = document.createElement("div");
  actions.className = "detail-actions";

  if (account.npsso) {
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "action-btn";
    copyBtn.textContent = "COPY NPSSO";
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(account.npsso);
      copyBtn.textContent = "COPIED ✓";
      copyBtn.classList.add("copied");
      setTimeout(() => {
        copyBtn.textContent = "COPY NPSSO";
        copyBtn.classList.remove("copied");
      }, 1500);
    });
    actions.appendChild(copyBtn);
  }

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "action-btn";
  editBtn.textContent = "EDIT ACCOUNT";
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    startEdit(account);
  });
  actions.appendChild(editBtn);

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "action-btn danger";
  deleteBtn.textContent = "DELETE";
  deleteBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete account "${account.label || account.email}"?`)) return;
    const all = await loadAccounts();
    const next = all.filter((a) => a.id !== account.id);
    await saveAccounts(next);
    renderAccounts(next);
  });
  actions.appendChild(deleteBtn);

  detail.appendChild(actions);
  return detail;
}

function renderAccounts(accounts) {
  els.list.innerHTML = "";

  const count = accounts.length;
  els.groupLabel.textContent = count > 0 ? `Accounts · ${count}` : "";
  els.footerStat.textContent = count > 0 ? `${count} account${count !== 1 ? "s" : ""}` : "";
  els.list.classList.toggle("hidden", count === 0);
  els.empty.classList.toggle("hidden", count > 0);
  if (count === 0) return;

  accounts.forEach((account, index) => {
    const status = npssoStatus(account);
    const meta = STATUS_META[status];
    const isExpanded = expandedId === account.id;
    const hasToken = !!account.npsso;

    const row = document.createElement("div");
    row.className = isExpanded ? "acct expanded" : "acct";
    row.style.borderLeftColor = meta.color;

    const main = document.createElement("div");
    main.className = "acct-main";
    main.title = "Click to expand";
    main.addEventListener("click", () => {
      expandedId = isExpanded ? null : account.id;
      renderAccounts(accounts);
    });

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.style.cssText = avatarStyle(index);
    avatar.textContent = (account.label || account.email || "?").charAt(0).toUpperCase();

    const info = document.createElement("div");
    info.className = "acct-info";

    const title = document.createElement("div");
    title.className = "acct-title";
    const labelEl = document.createElement("span");
    labelEl.className = "acct-label";
    labelEl.textContent = account.label || account.email;
    const statusEl = document.createElement("span");
    statusEl.className = "acct-status";
    statusEl.style.color = meta.color;
    statusEl.textContent = meta.label;
    title.appendChild(labelEl);
    title.appendChild(statusEl);
    info.appendChild(title);

    info.appendChild(
      account.onlineId ? line("PSN ID", account.onlineId) : line("PSN ID", "Not fetched", true),
    );
    info.appendChild(
      hasToken
        ? line("NPSSO", account.npsso.slice(0, 12) + " ••••••••")
        : line("NPSSO", "Not fetched", true),
    );

    const side = document.createElement("div");
    side.className = "acct-side";
    const timeEl = document.createElement("span");
    timeEl.className = "acct-time";
    timeEl.textContent = account.npssoFetchedAt ? timeAgo(account.npssoFetchedAt) : "never";
    const getBtn = document.createElement("button");
    getBtn.type = "button";
    getBtn.className = hasToken ? "get-btn" : "get-btn primary";
    getBtn.textContent = status === "fetching" ? "SYNC…" : hasToken ? "SYNC" : "GET";
    getBtn.title = "Sign in to PSN and fetch NPSSO";
    getBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (fetchingId) return;
      fetchingId = account.id;
      chrome.runtime.sendMessage({ action: "openSignIn", id: account.id, email: account.email, password: account.password });
      renderAccounts(accounts);
    });
    side.appendChild(timeEl);
    side.appendChild(getBtn);

    main.appendChild(avatar);
    main.appendChild(info);
    main.appendChild(side);
    row.appendChild(main);

    if (isExpanded) row.appendChild(buildDetail(account));

    els.list.appendChild(row);
  });
}

els.addBtn.addEventListener("click", () => {
  if (els.form.classList.contains("hidden")) {
    resetForm();
    els.form.classList.remove("hidden");
    els.label.focus();
  } else {
    resetForm();
  }
});

els.cancelBtn.addEventListener("click", resetForm);
els.cancelBtn2.addEventListener("click", resetForm);

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
  const blob = new Blob([accountsToCSV(accounts)], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `psn-accounts-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

els.importBtn.addEventListener("click", () => els.importFile.click());

els.importFile.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const rows = parseCSV(text);
    if (rows.length === 0) throw new Error("Empty file");

    const header = rows[0].map((key) => key.trim().toLowerCase());
    const data = rows.slice(1).map((row) => {
      const obj = {};
      header.forEach((key, i) => { obj[key] = row[i]; });
      return obj;
    });

    const strField = (v) => (typeof v === "string" && v !== "" ? v : undefined);

    const cleaned = data
      .filter((a) => strField(a.email) && strField(a.password))
      .map((a) => ({
        id: uid(),
        label: strField(a.label) || "",
        email: a.email,
        password: a.password,
        notes: "",
        createdAt: Date.now(),
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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) {
    fetchingId = null;
    renderAccounts(Array.isArray(changes[STORAGE_KEY].newValue) ? changes[STORAGE_KEY].newValue : []);
  }
});

(async function init() {
  const accounts = await loadAccounts();
  renderAccounts(accounts);
})();
