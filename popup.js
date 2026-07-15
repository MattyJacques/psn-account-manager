const STORAGE_KEY = "psn_accounts";
const REFRESH_KEY = "psn_refresh_state";
const CHECK_KEY = "psn_check_state";

const CSV_FIELDS = [
  "id", "label", "email", "password", "notes", "createdAt", "updatedAt",
  "accountId", "onlineId", "profileFetchedAt", "npsso", "npssoFetchedAt", "avatarUrl",
  "npssoValid", "npssoCheckedAt",
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
  ["#2b8f5c", "#1f6a9a"],
  ["#2b5db8", "#6a4fd8"],
  ["#b8862b", "#d8674f"],
  ["#8c3a68", "#5b2a48"],
  ["#3f7dfd", "#7a4ffd"],
  ["#1f8a9a", "#2b5db8"],
];
// Desaturated gradients for rows without a live token.
const AVATAR_GRAY_EXPIRED = ["#41506b", "#2a3348"];
const AVATAR_GRAY_NONE = ["#39435a", "#252d40"];

// NPSSO tokens are valid for ~61 days from issue.
const DAY_MS = 24 * 60 * 60 * 1000;
const NPSSO_TTL_DAYS = 61;
const NPSSO_WARN_DAYS = 51;

const STATUS_LABEL = {
  active:   "NPSSO ACTIVE",
  soon:     "EXPIRING SOON",
  expired:  "EXPIRED",
  invalid:  "INVALID",
  none:     "NOT FETCHED",
  fetching: "FETCHING",
};

const SVG_NS = "http://www.w3.org/2000/svg";

const els = {
  list:       document.getElementById("accountList"),
  footerStat: document.getElementById("footerStat"),
  empty:      document.getElementById("emptyState"),
  emptyAddBtn: document.getElementById("emptyAddBtn"),
  form:       document.getElementById("accountForm"),
  formTitle:  document.getElementById("formTitle"),
  formSubtitle: document.getElementById("formSubtitle"),
  editId:     document.getElementById("editId"),
  label:      document.getElementById("label"),
  email:      document.getElementById("email"),
  password:   document.getElementById("password"),
  saveBtn:    document.getElementById("saveBtn"),
  addBtn:     document.getElementById("addBtn"),
  cancelBtn:  document.getElementById("cancelBtn"),
  cancelBtn2: document.getElementById("cancelBtn2"),
  emailError: document.getElementById("emailError"),
  passwordError: document.getElementById("passwordError"),
  versionTag: document.getElementById("versionTag"),
  refreshAllBtn: document.getElementById("refreshAllBtn"),
  refreshAllLabel: document.getElementById("refreshAllLabel"),
  checkAllBtn:   document.getElementById("checkAllBtn"),
  checkAllLabel: document.getElementById("checkAllLabel"),
  exportBtn:  document.getElementById("exportBtn"),
  importBtn:  document.getElementById("importBtn"),
  importFile: document.getElementById("importFile"),
};

let expandedId = null;
let fetchingId = null;
let checkingId = null;
// Progress of a background check-all run ({running, index, total, activeId}
// under CHECK_KEY), or null when idle.
let checkState = null;
// Progress of a background refresh-all run ({running, index, total, activeId}
// published under REFRESH_KEY), or null when idle. Owned by the background
// worker so it survives the popup closing when sign-in tabs open.
let refreshState = null;
let currentAccounts = [];

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

function setFieldError(errorEl, input, msg) {
  errorEl.querySelector(".err-text").textContent = msg;
  errorEl.classList.remove("hidden");
  input.classList.add("invalid");
}

function clearFieldErrors() {
  for (const [errorEl, input] of [[els.emailError, els.email], [els.passwordError, els.password]]) {
    errorEl.classList.add("hidden");
    errorEl.querySelector(".err-text").textContent = "";
    input.classList.remove("invalid");
  }
}

function resetForm() {
  els.form.reset();
  els.editId.value = "";
  els.formTitle.textContent = "New account";
  els.formSubtitle.textContent = "";
  els.saveBtn.textContent = "Save";
  clearFieldErrors();
  els.form.classList.add("hidden");
  els.addBtn.classList.remove("open");
}

function startEdit(account) {
  els.editId.value = account.id;
  els.label.value = account.label || "";
  els.email.value = account.email || "";
  els.password.value = account.password || "";
  els.formTitle.textContent = "Edit account";
  els.formSubtitle.textContent = `· ${account.label || account.email}`;
  els.saveBtn.textContent = "Save changes";
  clearFieldErrors();
  els.form.classList.remove("hidden");
  els.addBtn.classList.add("open");
  els.label.focus();
  els.form.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Status from stored data alone (never "fetching") — used for footer counts.
function baseStatus(account) {
  if (!account.npsso) return "none";
  // A server check that came back invalid and is at least as recent as the
  // stored token overrides the age heuristic. A valid check does NOT extend
  // the EXPIRING SOON / EXPIRED thresholds — age still governs those.
  if (account.npssoValid === false && (account.npssoCheckedAt || 0) >= (account.npssoFetchedAt || 0)) {
    return "invalid";
  }
  const age = Date.now() - (account.npssoFetchedAt || 0);
  if (age >= NPSSO_TTL_DAYS * DAY_MS) return "expired";
  if (age >= NPSSO_WARN_DAYS * DAY_MS) return "soon";
  return "active";
}

function npssoStatus(account) {
  if (fetchingId === account.id || refreshState?.activeId === account.id) return "fetching";
  return baseStatus(account);
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

function expiryDaysLeft(account) {
  const expiresAt = (account.npssoFetchedAt || 0) + NPSSO_TTL_DAYS * DAY_MS;
  return Math.ceil((expiresAt - Date.now()) / DAY_MS);
}

function svgEl(width, height, children, extraClass) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  if (extraClass) svg.setAttribute("class", extraClass);
  for (const [tag, attrs] of children) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.appendChild(node);
  }
  return svg;
}

function chevronSvg() {
  return svgEl(12, 12, [["path", {
    d: "M3 6l5 5 5-5", stroke: "#5b647a", "stroke-width": "1.8",
    "stroke-linecap": "round", "stroke-linejoin": "round",
  }]], "chevron");
}

function spinnerSvg(size, extraClass) {
  return svgEl(size, size, [["path", {
    d: "M13.5 8a5.5 5.5 0 1 1-1.7-3.96", stroke: "currentColor",
    "stroke-width": "2.2", "stroke-linecap": "round",
  }]], extraClass);
}

function copySvg() {
  return svgEl(11, 11, [
    ["rect", { x: "5.5", y: "5.5", width: "8", height: "8", rx: "1.5", stroke: "currentColor", "stroke-width": "1.5" }],
    ["path", { d: "M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2", stroke: "currentColor", "stroke-width": "1.5" }],
  ]);
}

function checkSvg(color) {
  return svgEl(12, 12, [["path", {
    d: "M2.5 8.5 6 12l7.5-8", stroke: color, "stroke-width": "1.8",
    "stroke-linecap": "round", "stroke-linejoin": "round",
  }]]);
}

function maskedNpsso(token) {
  return "npsso ••••••••" + token.slice(-4);
}

function copyIconBtn(getValue) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "copy-btn";
  btn.title = "Copy";
  btn.appendChild(copySvg());
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(getValue());
    btn.classList.add("copied");
    setTimeout(() => btn.classList.remove("copied"), 1500);
  });
  return btn;
}

function kvRow(key, value, isToken, copyValue) {
  const row = document.createElement("div");
  row.className = "kv";
  const keyEl = document.createElement("span");
  keyEl.className = "kv-key";
  keyEl.textContent = key;
  const valEl = document.createElement("span");
  valEl.className = isToken ? "kv-val token" : "kv-val";
  valEl.textContent = value;
  row.appendChild(keyEl);
  row.appendChild(valEl);
  if (copyValue) row.appendChild(copyIconBtn(() => copyValue));
  return row;
}

function buildCheckBox(account) {
  const box = document.createElement("div");
  const valid = !!account.npssoValid;
  box.className = valid ? "check-box valid" : "check-box invalid";

  if (valid) {
    box.appendChild(checkSvg("#43d17c"));
  } else {
    box.appendChild(svgEl(12, 12, [["path", {
      d: "M4 4l8 8M12 4l-8 8", stroke: "#e5559c", "stroke-width": "1.8", "stroke-linecap": "round",
    }]]));
  }

  const msg = document.createElement("span");
  msg.className = "check-msg";
  if (valid) {
    const days = expiryDaysLeft(account);
    msg.textContent = days >= 1
      ? `Token valid — expires in ${days} day${days !== 1 ? "s" : ""}`
      : "Token valid — expires today";
  } else {
    msg.textContent = "Token invalid — sign in again to refresh";
  }
  box.appendChild(msg);

  const spacer = document.createElement("div");
  spacer.className = "check-spacer";
  box.appendChild(spacer);

  const when = document.createElement("span");
  when.className = "check-when";
  when.textContent = `checked ${timeAgo(account.npssoCheckedAt)}`;
  box.appendChild(when);

  return box;
}

function buildDetail(account) {
  const detail = document.createElement("div");
  detail.className = "acct-detail";

  detail.appendChild(kvRow("ACCOUNT ID", account.accountId || "—", false, account.accountId || null));
  if (account.npsso) {
    detail.appendChild(kvRow("NPSSO", account.npsso, true, account.npsso));
  }
  if (account.npsso && account.npssoCheckedAt) {
    detail.appendChild(buildCheckBox(account));
  }

  const actions = document.createElement("div");
  actions.className = "detail-actions";

  if (account.npsso) {
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "action-btn solid";
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

  const spacer = document.createElement("div");
  spacer.className = "detail-spacer";
  actions.appendChild(spacer);

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

function buildMeta(account, status) {
  const meta = document.createElement("div");
  meta.className = "acct-meta";

  const hasToken = !!account.npsso;
  const rowBusy = status === "fetching"
    || checkingId === account.id
    || (checkState?.running && checkState.activeId === account.id);

  if (status === "fetching") {
    const fetching = document.createElement("span");
    fetching.className = "meta-fetching";
    fetching.textContent = "capturing sign-in…";
    meta.appendChild(fetching);
  } else if (hasToken) {
    const npssoEl = document.createElement("span");
    npssoEl.className = status === "expired" ? "meta-npsso dead" : "meta-npsso";
    npssoEl.textContent = maskedNpsso(account.npsso);
    meta.appendChild(npssoEl);

    const hint = document.createElement("span");
    hint.className = "meta-hint";
    if (status === "soon") {
      hint.classList.add("warn");
      const days = Math.max(expiryDaysLeft(account), 0);
      hint.textContent = days >= 1 ? `· expires in ${days}d` : "· expires today";
    } else if (status === "expired") {
      hint.classList.add("danger");
      const gone = Math.floor(-expiryDaysLeft(account));
      hint.textContent = gone >= 1 ? `· expired ${gone}d ago` : "· expired today";
    } else if (status === "invalid") {
      hint.classList.add("invalid");
      hint.textContent = `· check failed ${timeAgo(account.npssoCheckedAt)}`;
    } else {
      hint.textContent = `· fetched ${timeAgo(account.npssoFetchedAt)}`;
    }
    meta.appendChild(hint);
  } else {
    const npssoEl = document.createElement("span");
    npssoEl.className = "meta-npsso muted";
    npssoEl.textContent = "npsso — not captured";
    meta.appendChild(npssoEl);
  }

  const spacer = document.createElement("div");
  spacer.className = "meta-spacer";
  meta.appendChild(spacer);

  const live = hasToken && status !== "expired" && status !== "invalid";
  const getBtn = document.createElement("button");
  getBtn.type = "button";
  getBtn.className = "row-btn sync";
  getBtn.textContent = live ? "SYNC" : "GET";
  getBtn.title = "Sign in to PSN and fetch NPSSO";
  getBtn.disabled = rowBusy;
  getBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (fetchingId || checkingId || refreshState?.running || checkState?.running) return;
    fetchingId = account.id;
    chrome.runtime.sendMessage({ action: "openSignIn", id: account.id, email: account.email, password: account.password });
    renderAccounts(currentAccounts);
  });
  meta.appendChild(getBtn);

  const checkBtn = document.createElement("button");
  checkBtn.type = "button";
  checkBtn.className = "row-btn";
  checkBtn.textContent = checkingId === account.id ? "CHECKING" : "CHECK";
  checkBtn.title = "Check whether the stored NPSSO token is still valid";
  checkBtn.disabled = !hasToken || rowBusy;
  checkBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (checkingId || fetchingId || refreshState?.running || checkState?.running) return;
    checkingId = account.id;
    chrome.runtime.sendMessage({ action: "checkNpsso", id: account.id });
    const stuckId = account.id;
    setTimeout(() => {
      if (checkingId === stuckId) {
        checkingId = null;
        renderAccounts(currentAccounts);
      }
    }, 15000);
    renderAccounts(currentAccounts);
  });
  meta.appendChild(checkBtn);

  return meta;
}

function buildAvatar(account, index, status) {
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  let gradient;
  if (status === "expired") {
    gradient = AVATAR_GRAY_EXPIRED;
    avatar.classList.add("dead");
  } else if (status === "none") {
    gradient = AVATAR_GRAY_NONE;
    avatar.classList.add("dead");
  } else {
    gradient = AVATAR_GRADIENTS[index % AVATAR_GRADIENTS.length];
  }
  avatar.style.background = `linear-gradient(135deg, ${gradient[0]}, ${gradient[1]})`;
  avatar.textContent = (account.label || account.email || "?").charAt(0).toUpperCase();
  if (account.avatarUrl) {
    const img = document.createElement("img");
    img.className = "avatar-img";
    img.alt = "";
    img.addEventListener("error", () => img.remove()); // fall back to the gradient initial
    img.src = account.avatarUrl;
    avatar.appendChild(img);
  }
  return avatar;
}

function updateRefreshAllBtn(count) {
  const running = !!refreshState?.running;
  els.refreshAllBtn.disabled = count === 0 && !running;
  els.refreshAllBtn.classList.toggle("running", running);
  els.refreshAllLabel.textContent = running
    ? `${refreshState.index + 1}/${refreshState.total}`
    : "All";
  els.refreshAllBtn.title = running
    ? "Refreshing all accounts — click to cancel after the current one"
    : "Sign in to every account in turn and refresh its NPSSO";
}

function updateCheckAllBtn(accounts) {
  const withToken = accounts.filter((a) => a.npsso).length;
  const running = !!checkState?.running;
  els.checkAllBtn.disabled = withToken === 0 && !running;
  els.checkAllBtn.classList.toggle("running", running);
  els.checkAllLabel.textContent = running
    ? `${checkState.index + 1}/${checkState.total}`
    : "All";
  els.checkAllBtn.title = running
    ? "Checking every NPSSO — click to cancel after the current one"
    : "Check whether each stored NPSSO token is still valid";
}

function updateFooter(accounts) {
  const count = accounts.length;
  els.footerStat.textContent = "";
  if (count === 0) {
    els.footerStat.textContent = "0 accounts";
  } else {
    els.footerStat.append(`${count} account${count !== 1 ? "s" : ""}`);
    const attention = accounts.filter((a) => ["soon", "expired", "invalid"].includes(baseStatus(a))).length;
    if (attention > 0) {
      els.footerStat.append(" · ");
      const attn = document.createElement("span");
      attn.className = "attn";
      attn.textContent = `${attention} need${attention === 1 ? "s" : ""} attention`;
      els.footerStat.appendChild(attn);
    }
  }
  els.exportBtn.classList.toggle("dim", count === 0);
}

function renderAccounts(accounts) {
  currentAccounts = accounts;
  els.list.innerHTML = "";

  const count = accounts.length;
  updateRefreshAllBtn(count);
  updateCheckAllBtn(accounts);
  updateFooter(accounts);
  els.list.classList.toggle("hidden", count === 0);
  els.empty.classList.toggle("hidden", count > 0);
  if (count === 0) return;

  accounts.forEach((account, index) => {
    const status = npssoStatus(account);
    const isExpanded = expandedId === account.id;

    const row = document.createElement("div");
    row.className = `acct st-${status}${isExpanded ? " expanded" : ""}`;

    const main = document.createElement("div");
    main.className = "acct-main";
    main.title = isExpanded ? "Click to collapse" : "Click to expand";
    main.addEventListener("click", () => {
      expandedId = isExpanded ? null : account.id;
      renderAccounts(accounts);
    });

    main.appendChild(buildAvatar(account, index, status));

    const info = document.createElement("div");
    info.className = "acct-info";

    const title = document.createElement("div");
    title.className = "acct-title";
    const labelEl = document.createElement("span");
    labelEl.className = "acct-label";
    labelEl.textContent = account.label || account.email;
    title.appendChild(labelEl);

    const badge = document.createElement("span");
    badge.className = "acct-badge";
    if (status === "fetching") badge.appendChild(spinnerSvg(8, "badge-spin"));
    badge.append(STATUS_LABEL[status]);
    title.appendChild(badge);
    info.appendChild(title);

    const sub = document.createElement("span");
    sub.className = "acct-sub";
    sub.textContent = account.onlineId || "— no online ID yet";
    info.appendChild(sub);

    main.appendChild(info);
    main.appendChild(chevronSvg());
    row.appendChild(main);

    row.appendChild(buildMeta(account, status));

    if (isExpanded) row.appendChild(buildDetail(account));

    els.list.appendChild(row);
  });
}

function openForm() {
  resetForm();
  els.form.classList.remove("hidden");
  els.addBtn.classList.add("open");
  els.label.focus();
}

els.addBtn.addEventListener("click", () => {
  if (els.form.classList.contains("hidden")) {
    openForm();
  } else {
    resetForm();
  }
});

els.emptyAddBtn.addEventListener("click", openForm);

els.refreshAllBtn.addEventListener("click", () => {
  if (refreshState?.running) {
    chrome.runtime.sendMessage({ action: "cancelRefreshAll" });
    els.refreshAllLabel.textContent = "Cancelling…";
  } else {
    if (currentAccounts.length === 0 || fetchingId || checkState?.running) return;
    chrome.runtime.sendMessage({ action: "refreshAll" });
  }
});

els.checkAllBtn.addEventListener("click", () => {
  if (checkState?.running) {
    chrome.runtime.sendMessage({ action: "cancelCheckAll" });
    els.checkAllLabel.textContent = "Cancelling…";
  } else {
    if (currentAccounts.filter((a) => a.npsso).length === 0 || fetchingId || refreshState?.running) return;
    chrome.runtime.sendMessage({ action: "checkAllNpsso" });
  }
});

els.cancelBtn.addEventListener("click", resetForm);
els.cancelBtn2.addEventListener("click", resetForm);

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearFieldErrors();

  const id = els.editId.value;
  const label = els.label.value.trim();
  const email = els.email.value.trim();
  const password = els.password.value;

  let bad = false;
  if (!email) {
    setFieldError(els.emailError, els.email, "Email is required.");
    bad = true;
  }
  if (!password) {
    setFieldError(els.passwordError, els.password, "Password is required.");
    bad = true;
  }
  if (bad) return;

  const accounts = await loadAccounts();

  const duplicate = accounts.find(
    (a) => a.email.toLowerCase() === email.toLowerCase() && a.id !== id,
  );
  if (duplicate) {
    setFieldError(els.emailError, els.email, `This email is already used by “${duplicate.label || duplicate.email}”.`);
    return;
  }

  let next;
  if (id) {
    next = accounts.map((a) => {
      if (a.id !== id) return a;
      const updated = { ...a, label, email, password, updatedAt: Date.now() };
      // A different email means a different PSN account: the captured
      // identity (accountId/onlineId/npsso/avatar) belonged to the old one.
      // Drop it so the background's identity guard doesn't reject the next
      // capture as a wrong-account mismatch.
      if (a.email.toLowerCase() !== email.toLowerCase()) {
        delete updated.accountId;
        delete updated.onlineId;
        delete updated.profileFetchedAt;
        delete updated.npsso;
        delete updated.npssoFetchedAt;
        delete updated.avatarUrl;
        delete updated.npssoValid;
        delete updated.npssoCheckedAt;
      }
      return updated;
    });
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
  if (area !== "local") return;
  if (!changes[STORAGE_KEY] && !changes[REFRESH_KEY] && !changes[CHECK_KEY]) return;
  if (changes[REFRESH_KEY]) {
    refreshState = changes[REFRESH_KEY].newValue ?? null;
  }
  if (changes[CHECK_KEY]) {
    checkState = changes[CHECK_KEY].newValue ?? null;
  }
  if (changes[STORAGE_KEY]) {
    fetchingId = null;
    checkingId = null;
    currentAccounts = Array.isArray(changes[STORAGE_KEY].newValue) ? changes[STORAGE_KEY].newValue : [];
  }
  renderAccounts(currentAccounts);
});

(async function init() {
  els.versionTag.textContent = "v" + chrome.runtime.getManifest().version;
  const [accounts, storedRefresh, storedCheck] = await Promise.all([
    loadAccounts(),
    new Promise((resolve) => {
      chrome.storage.local.get([REFRESH_KEY], (result) => resolve(result[REFRESH_KEY]));
    }),
    new Promise((resolve) => {
      chrome.storage.local.get([CHECK_KEY], (result) => resolve(result[CHECK_KEY]));
    }),
  ]);
  refreshState = storedRefresh ?? null;
  checkState = storedCheck ?? null;
  renderAccounts(accounts);
})();
