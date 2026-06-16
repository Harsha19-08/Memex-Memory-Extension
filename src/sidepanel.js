import { loadState, saveState, clampList } from "./storage.js";

const $ = id => document.getElementById(id);

let state = {
  notes: [],
  clipboard: [],
  todos: [],
  activeTab: "notes",
  theme: "auto",
  clipboardEnabled: false,
  onboardingSeen: false,
  debugMode: false,
  clipboardLimit: 200,
  clipboardPollEnabled: false,
  clipboardPollIntervalMs: 1100
};

const NOTE_LIMIT = 500;
const TODO_LIMIT = 500;
const RENDER_STEP = 40;
const renderLimit = { notes: 60, clips: 60, todos: 80 };
let editingNoteId = null;
let pendingNotesRefresh = false;

const svgIcons = {
  pin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V6h1a2 2 0 000-4H8a2 2 0 000 4h1v4.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`,
  link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M10 13a5 5 0 0 0 7.07 0l1.41-1.41a5 5 0 0 0-7.07-7.07L10 4"/><path d="M14 11a5 5 0 0 0-7.07 0L5.52 12.4a5 5 0 1 0 7.07 7.07L14 20"/></svg>`,
  external: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M14 3h7v7"/><path d="M10 14L21 3"/><path d="M21 14v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h7"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="20 6 9 17 4 12"/></svg>`
};

function legacyCopyText(text) {
  const ta = document.createElement('textarea');
  ta.value = String(text ?? '');
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  if (!ok) throw new Error('execCommand copy failed');
}

let lastMemexWrite = { text: null, at: 0 };

async function copyTextToClipboard(text) {
  const s = String(text ?? '');
  try {
    await navigator.clipboard.writeText(s);
    lastMemexWrite = { text: s, at: Date.now() };
    return true;
  } catch {
    try {
      legacyCopyText(s);
      lastMemexWrite = { text: s, at: Date.now() };
      return true;
    } catch {
      return false;
    }
  }
}

const pendingKeys = new Set();
let saveTimer;
function scheduleSave(keys) {
  keys.forEach(k => pendingKeys.add(k));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const patch = {};
    pendingKeys.forEach(k => { patch[k] = state[k]; });
    pendingKeys.clear();
    saveState(patch);
  }, 250);
}
function saveNow(keys) {
  const patch = {};
  keys.forEach(k => { patch[k] = state[k]; });
  saveState(patch);
}

// ── Theme ──────────────────────────────
function applyTheme() {
  const root = document.documentElement;
  if (state.theme === "dark") {
    root.setAttribute("data-theme", "dark");
    root.style.setProperty("color-scheme", "dark");
  } else if (state.theme === "light") {
    root.setAttribute("data-theme", "light");
    root.style.setProperty("color-scheme", "light");
  } else {
    root.removeAttribute("data-theme");
    root.style.removeProperty("color-scheme");
  }
  updateThemeIndicator();
}
function cycleTheme() {
  const cycle = ["auto", "light", "dark"];
  state.theme = cycle[(cycle.indexOf(state.theme) + 1) % 3];
  saveNow(["theme"]);
  applyTheme();
}
function updateThemeIndicator() {
  const themeChip = $("themeChip");
  if (themeChip) themeChip.textContent = `Theme: ${state.theme.charAt(0).toUpperCase()}${state.theme.slice(1)}`;
}

// ── Clipboard status ───────────────────
function updateClipboardStatus() {
  const toggle = $("clipboardToggle");
  if (!toggle) return;
  toggle.classList.toggle("on", state.clipboardEnabled);
  toggle.classList.toggle("off", !state.clipboardEnabled);
  toggle.setAttribute("aria-pressed", state.clipboardEnabled ? "true" : "false");
  toggle.innerHTML = `<span class="status-dot"></span> Clipboard: ${state.clipboardEnabled ? "On" : "Off"}`;
}

function updatePollStatus() {
  const chip = $("pollChip");
  if (!chip) return;
  chip.textContent = `Monitor: ${state.clipboardPollEnabled ? "On" : "Off"}`;
  chip.classList.toggle("on", state.clipboardPollEnabled);
  chip.classList.toggle("off", !state.clipboardPollEnabled);
}

function updatePrivacyChip() {
  const chip = $("privacyChip");
  if (!chip) return;
  chip.textContent = state.debugMode ? "Debug: On" : "Local-only";
  chip.title = state.debugMode
    ? "Debug logging enabled (Ctrl/⌘+Click to turn off)"
    : "Local-only storage (Ctrl/⌘+Click to enable debug logging)";
}
function setClipboardEnabled(enabled) {
  state.clipboardEnabled = enabled;
  state.onboardingSeen = true;
  saveNow(["clipboardEnabled", "onboardingSeen"]);
  updateClipboardStatus();
  if (state.activeTab === "clipboard") renderClipboard();
}

function setClipboardPollEnabled(enabled) {
  state.clipboardPollEnabled = !!enabled;
  saveNow(["clipboardPollEnabled"]);
  updatePollStatus();
  if (state.clipboardPollEnabled) armPolling(20000);
  syncClipboardPolling();
}

// ── Tab switching ──────────────────────
function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
  document.querySelectorAll(".tab-pane").forEach(p => p.classList.toggle("active", p.id === "pane-" + tab));
  if (tab === "search") setTimeout(() => $("globalSearch").focus(), 50);
  saveNow(["activeTab"]);
}
document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => switchTab(t.dataset.tab)));

// ── Helpers ────────────────────────────
function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000), h = Math.floor(diff / 3600000), d = Math.floor(diff / 86400000);
  if (diff < 60000) return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (d === 1) return "yesterday";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function groupByDate(items, dateKey = "createdAt") {
  const groups = {};
  items.forEach(item => {
    const d = new Date(item[dateKey]);
    const now = new Date(), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const itemDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = Math.round((today - itemDay) / 86400000);
    const label = diff === 0 ? "Today" : diff === 1 ? "Yesterday" : d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
    if (!groups[label]) groups[label] = [];
    groups[label].push(item);
  });
  return groups;
}
function isURL(s) { try { const u = new URL(s); return u.protocol.startsWith("http"); } catch { return false; } }
function encData(t) { try { return encodeURIComponent(String(t ?? "")); } catch { return ""; } }
function decData(t) { try { return decodeURIComponent(String(t ?? "")); } catch { return String(t ?? ""); } }
function escapeHtml(t) {
  const str = String(t ?? "");
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function highlight(text, q) {
  if (!q) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const eq = escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escaped.replace(new RegExp(eq, "gi"), m => `<mark>${m}</mark>`);
}
function getEditingNoteId() {
  const active = document.activeElement;
  if (!active || !active.classList || !active.classList.contains("note-content")) return null;
  const card = active.closest(".note-card");
  return card ? card.dataset.id : null;
}

// ── NOTES ──────────────────────────────
function renderNotes() {
  const list = $("notesList");
  const pinned = state.notes.filter(n => n.pinned);
  const regular = state.notes.filter(n => !n.pinned);
  const limited = regular.slice(0, renderLimit.notes);
  let html = "";
  if (pinned.length) {
    html += `<div class="date-label" style="color:var(--orange)">📌 Pinned</div>`;
    pinned.forEach(n => { html += noteCardHTML(n); });
    if (regular.length) html += `<div class="section-divider"></div>`;
  }
  if (!limited.length && !pinned.length) {
    html = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg><div class="empty-title">No notes yet</div><div class="empty-sub">Click + to create your first note</div></div>`;
  } else if (limited.length) {
    const groups = groupByDate(limited);
    Object.entries(groups).forEach(([label, items]) => {
      html += `<div class="date-label">${label}</div>`;
      items.forEach(n => { html += noteCardHTML(n); });
    });
  }
  if (regular.length > renderLimit.notes) {
    const remaining = regular.length - renderLimit.notes;
    html += `<button class="show-more" data-more="notes">Show ${remaining} more</button>`;
  }
  list.innerHTML = html;
  list.querySelectorAll(".note-content").forEach(el => {
    const id = el.closest(".note-card").dataset.id;
    el.addEventListener("focus", () => { editingNoteId = id; });
    el.addEventListener("blur", () => {
      editingNoteId = null;
      if (pendingNotesRefresh) {
        pendingNotesRefresh = false;
        renderNotes();
      }
    });
    el.addEventListener("input", () => {
      const note = state.notes.find(n => n.id === id);
      if (note) {
        note.content = el.innerText;
        note.updatedAt = new Date().toISOString();
        debounce(() => scheduleSave(["notes"]), 600);
      }
    });
    el.addEventListener("keydown", e => { if (e.key === "Enter" && e.metaKey) el.blur(); });
  });
  list.querySelectorAll(".color-dot").forEach(dot => {
    dot.addEventListener("click", () => {
      const id = dot.closest(".note-card").dataset.id;
      const note = state.notes.find(n => n.id === id);
      if (note) { note.color = dot.dataset.color; saveNow(["notes"]); renderNotes(); }
    });
  });
  list.querySelectorAll(".pin-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.closest(".note-card").dataset.id;
      const note = state.notes.find(n => n.id === id);
      if (note) { note.pinned = !note.pinned; saveNow(["notes"]); renderNotes(); }
    });
  });
  list.querySelectorAll(".delete-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.closest(".note-card").dataset.id;
      state.notes = state.notes.filter(n => n.id !== id);
      saveNow(["notes"]);
      renderNotes();
    });
  });
  const moreBtn = list.querySelector("[data-more='notes']");
  if (moreBtn) {
    moreBtn.addEventListener("click", () => {
      renderLimit.notes += RENDER_STEP;
      renderNotes();
    });
  }
}
function noteCardHTML(n) {
  const colors = ["yellow", "blue", "pink", "green", "gray"];
  const colorDots = colors.map(c => `<span class="color-dot ${c}${n.color === c ? " selected" : ""}" data-color="${c}" title="${c}"></span>`).join("");
  return `<div class="note-card ${n.color}" data-id="${n.id}">
    <div class="note-content" contenteditable="true" spellcheck="false" data-placeholder="Write anything…">${escapeHtml(n.content)}</div>
    <div class="note-footer">
      <div class="note-meta">
        ${n.pinned ? '<span class="pinned-badge">pinned</span>' : ""}
        <span>${timeAgo(n.updatedAt || n.createdAt)}</span>
        ${n.source ? `<span class="note-source">${n.source}</span>` : ""}
      </div>
      <div class="note-actions">
        <div class="color-picker">${colorDots}</div>
        <button class="note-btn pin-btn${n.pinned ? " active" : ""}" title="Pin">${svgIcons.pin}</button>
        <button class="note-btn delete-btn" title="Delete">${svgIcons.trash}</button>
      </div>
    </div>
  </div>`;
}
$("newNoteBtn").addEventListener("click", () => {
  const note = { id: Date.now().toString(), content: "", color: "yellow", pinned: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  state.notes.unshift(note);
  state.notes = clampList(state.notes, NOTE_LIMIT);
  saveNow(["notes"]);
  renderNotes();
  setTimeout(() => { const first = $("notesList").querySelector(".note-content"); if (first) first.focus(); }, 50);
});

// ── CLIPBOARD ──────────────────────────
function renderClipboard() {
  const list = $("clipList");
  const pinned = state.clipboard.filter(c => c.pinned);
  const regular = state.clipboard.filter(c => !c.pinned);
  const limited = regular.slice(0, renderLimit.clips);
  let html = "";

  if (!state.clipboard.length && !state.clipboardEnabled) {
    list.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg><div class="empty-title">Clipboard memory is off</div><div class="empty-sub">Enable it to save what you copy, privately.</div><div style="margin-top:10px"><button class="btn primary" id="enableClipboard">Enable Clipboard Memory</button></div></div>`;
    const enableBtn = $("enableClipboard");
    if (enableBtn) enableBtn.addEventListener("click", () => setClipboardEnabled(true));
    return;
  }

  if (!state.clipboardEnabled) {
    html += `<div class="inline-banner">Clipboard memory is paused<button class="btn ghost" id="resumeClipboard">Resume</button></div>`;
  }

  if (!state.clipboard.length) {
    list.innerHTML = `${html}<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg><div class="empty-title">Nothing copied yet</div><div class="empty-sub">Memex can capture copies made inside webpages (page content + input fields). It cannot capture copies from the browser address bar (omnibox) or chrome:// pages. For file:// pages, enable “Allow access to file URLs” in the extension details, then refresh the page.</div></div>`;
    const resumeBtn = $("resumeClipboard");
    if (resumeBtn) resumeBtn.addEventListener("click", () => setClipboardEnabled(true));
    return;
  }

  if (pinned.length) {
    html += `<div class="date-label" style="color:var(--orange)">📌 Pinned</div>`;
    pinned.forEach(c => { html += clipCardHTML(c); });
    if (regular.length) html += `<div class="section-divider"></div>`;
  }
  const groups = groupByDate(limited);
  Object.entries(groups).forEach(([label, items]) => {
    html += `<div class="date-label">${label}</div>`;
    items.forEach(c => { html += clipCardHTML(c); });
  });
  if (regular.length > renderLimit.clips) {
    const remaining = regular.length - renderLimit.clips;
    html += `<button class="show-more" data-more="clips">Show ${remaining} more</button>`;
  }
  list.innerHTML = html;
  list.querySelectorAll("[data-copy-url]").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const url = decData(btn.dataset.copyUrl);
      if (!url) return;

      const ok = await copyTextToClipboard(url);
      if (!ok) {
        console.warn("Failed to copy url to clipboard");
        return;
      }

      btn.style.background = "var(--green-bg)";
      btn.style.color = "var(--green)";
      setTimeout(() => { btn.style.background = ""; btn.style.color = ""; }, 900);
    });
  });
  list.querySelectorAll("[data-copy]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.copy;
      const clip = state.clipboard.find(c => c.id === id);
      if (!clip) return;

      const ok = await copyTextToClipboard(clip.text);
      if (!ok) {
        console.warn("Failed to copy to clipboard");
        return;
      }

      btn.style.background = "var(--green-bg)";
      btn.style.color = "var(--green)";
      setTimeout(() => { btn.style.background = ""; btn.style.color = ""; }, 1000);
    });
  });
  list.querySelectorAll("[data-pin-clip]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.pinClip;
      const clip = state.clipboard.find(c => c.id === id);
      if (clip) { clip.pinned = !clip.pinned; saveNow(["clipboard"]); renderClipboard(); }
    });
  });
  list.querySelectorAll("[data-del-clip]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.clipboard = state.clipboard.filter(c => c.id !== btn.dataset.delClip);
      saveNow(["clipboard"]); renderClipboard();
    });
  });
  list.querySelectorAll("[data-open-url]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const url = decData(btn.dataset.openUrl);
      if (url) window.open(url, "_blank", "noopener");
    });
  });
  list.querySelectorAll(".clip-text.is-url").forEach(el => {
    el.addEventListener("click", async () => {
      const sel = window.getSelection?.();
      if (sel && !sel.isCollapsed) return;

      const url = decData(el.dataset.url);
      const ok = await copyTextToClipboard(url);
      if (!ok) return;

      const prev = el.title;
      el.title = "Copied link";
      el.style.textDecoration = "none";
      el.style.opacity = "0.9";
      setTimeout(() => {
        el.title = prev || "Copy link";
        el.style.textDecoration = "underline";
        el.style.opacity = "";
      }, 800);
    });
  });
  const resumeBtn = list.querySelector("#resumeClipboard");
  if (resumeBtn) resumeBtn.addEventListener("click", () => setClipboardEnabled(true));
  const moreBtn = list.querySelector("[data-more='clips']");
  if (moreBtn) {
    moreBtn.addEventListener("click", () => {
      renderLimit.clips += RENDER_STEP;
      renderClipboard();
    });
  }
}
function clipCardHTML(c) {
  const textUrl = isURL(c.text);
  const sourceUrl = isURL(c.sourceUrl || "") ? c.sourceUrl : "";
  const openTarget = (textUrl ? c.text : sourceUrl) || "";
  const displayText = c.text.length > 300 ? c.text.slice(0, 300) + "…" : c.text;

  const sourcePill = c.source
    ? (sourceUrl
      ? `<button type="button" class="clip-source-pill" data-copy-url="${encData(sourceUrl)}" title="Copy page link">${escapeHtml(c.source)}</button>`
      : `<span class="clip-source-pill">${escapeHtml(c.source)}</span>`)
    : "";

  return `<div class="clip-card">
    <div class="clip-text${textUrl ? " is-url" : ""}"${textUrl ? ` data-url="${encData(c.text)}"` : ""} title="${textUrl ? "Copy link" : ""}">${escapeHtml(displayText)}</div>
    <div class="clip-footer">
      <div style="display:flex;align-items:center;gap:6px">
        ${sourcePill}
        ${sourceUrl ? `<button type="button" class="clip-btn link" data-copy-url="${encData(sourceUrl)}" title="Copy page link">${svgIcons.link}</button>` : ""}
        <span class="clip-time">${timeAgo(c.createdAt)}</span>
      </div>
      <div class="clip-actions">
        ${openTarget ? `<button type="button" class="clip-btn open" data-open-url="${encData(openTarget)}" title="Open link">${svgIcons.external}</button>` : ""}
        <button type="button" class="clip-btn pin${c.pinned ? " active" : ""}" data-pin-clip="${c.id}" title="Pin">${svgIcons.pin}</button>
        <button type="button" class="clip-btn copy" data-copy="${c.id}" title="Copy again">${svgIcons.copy} Copy</button>
        <button type="button" class="clip-btn del" data-del-clip="${c.id}" title="Delete">${svgIcons.trash}</button>
      </div>
    </div>
  </div>`;
}

// ── TODOS ──────────────────────────────
function renderTodos() {
  const list = $("todoList");
  const stats = $("todoStats");
  const total = state.todos.length;
  const done = state.todos.filter(t => t.done).length;
  stats.innerHTML = total ? `<span class="stat-chip"><span class="stat-num">${total - done}</span> remaining</span><span class="stat-chip"><span class="stat-num">${done}</span> done</span>` : "";
  if (!state.todos.length) {
    list.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg><div class="empty-title">All clear!</div><div class="empty-sub">Add tasks above to get started</div></div>`;
    return;
  }
  const active = state.todos.filter(t => !t.done);
  const completed = state.todos.filter(t => t.done);
  const activeLimited = active.slice(0, renderLimit.todos);
  let html = "";
  if (activeLimited.length) {
    const priority = { high: [], medium: [], low: [], none: [] };
    activeLimited.forEach(t => (priority[t.priority || "none"]).push(t));
    ["high", "medium", "low", "none"].forEach(p => {
      priority[p].forEach(t => { html += todoItemHTML(t); });
    });
    if (active.length > renderLimit.todos) {
      const remaining = active.length - renderLimit.todos;
      html += `<button class="show-more" data-more="todos">Show ${remaining} more</button>`;
    }
  }
  if (completed.length) {
    html += `<div class="todo-section-label">Completed</div>`;
    completed.slice(0, 10).forEach(t => { html += todoItemHTML(t); });
    if (completed.length > 10) html += `<div style="text-align:center;padding:8px;font-size:11px;color:var(--text-3)">+${completed.length - 10} more</div>`;
  }
  list.innerHTML = html;
  list.querySelectorAll(".todo-check").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const todo = state.todos.find(t => t.id === id);
      if (todo) {
        todo.done = !todo.done;
        todo.doneAt = todo.done ? new Date().toISOString() : null;
        saveNow(["todos"]);
        renderTodos();
      }
    });
  });
  list.querySelectorAll("[data-del-todo]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.todos = state.todos.filter(t => t.id !== btn.dataset.delTodo);
      saveNow(["todos"]);
      renderTodos();
    });
  });
  const moreBtn = list.querySelector("[data-more='todos']");
  if (moreBtn) {
    moreBtn.addEventListener("click", () => {
      renderLimit.todos += RENDER_STEP;
      renderTodos();
    });
  }
}
function todoItemHTML(t) {
  return `<div class="todo-item">
    <button class="todo-check${t.done ? " checked" : ""}" data-id="${t.id}" aria-label="${t.done ? "Mark incomplete" : "Mark complete"}">${t.done ? svgIcons.check : ""}</button>
    <div class="priority-dot ${t.priority || "none"}"></div>
    <span class="todo-text${t.done ? " done" : ""}">${escapeHtml(t.text)}</span>
    <button class="todo-del-btn" data-del-todo="${t.id}" aria-label="Delete todo">${svgIcons.trash}</button>
  </div>`;
}
function addTodo() {
  const input = $("todoInput");
  const text = input.value.trim();
  if (!text) return;
  const priority = $("prioritySelect").value;
  const todo = { id: Date.now().toString(), text, priority, done: false, createdAt: new Date().toISOString() };
  state.todos.unshift(todo);
  state.todos = clampList(state.todos, TODO_LIMIT);
  input.value = ""; $("prioritySelect").value = "none";
  saveNow(["todos"]);
  renderTodos();
}
$("addTodoBtn").addEventListener("click", addTodo);
$("todoInput").addEventListener("keydown", e => { if (e.key === "Enter") addTodo(); });

// ── SEARCH ─────────────────────────────
let searchTimer;
$("globalSearch").addEventListener("input", e => {
  const q = e.target.value.trim();
  $("searchClear").classList.toggle("visible", q.length > 0);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => renderSearch(q), 100);
});
$("searchClear").addEventListener("click", () => {
  $("globalSearch").value = "";
  $("searchClear").classList.remove("visible");
  renderSearch("");
});
function renderSearch(q) {
  const out = $("searchResults");
  if (!q) {
    out.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><div class="empty-title">Search everything</div><div class="empty-sub">Notes, clipboard, and todos in one place</div></div>`;
    return;
  }
  const ql = q.toLowerCase();
  const notes = state.notes.filter(n => String(n.content || "").toLowerCase().includes(ql));
  const clips = state.clipboard.filter(c => String(c.text || "").toLowerCase().includes(ql));
  const todos = state.todos.filter(t => String(t.text || "").toLowerCase().includes(ql));
  if (!notes.length && !clips.length && !todos.length) {
    out.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><div class="empty-title">No results for "${escapeHtml(q)}"</div><div class="empty-sub">Try different keywords</div></div>`;
    return;
  }
  let html = "";
  if (notes.length) {
    html += `<div class="result-group-label"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4z"/></svg> Notes (${notes.length})</div>`;
    notes.slice(0, 5).forEach(n => {
      html += `<div class="result-item" data-goto="notes-${n.id}"><div class="result-text">${highlight(n.content.slice(0, 120), q)}</div><div class="result-meta">${timeAgo(n.updatedAt || n.createdAt)}</div></div>`;
    });
  }
  if (clips.length) {
    html += `<div class="result-group-label"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg> Clipboard (${clips.length})</div>`;
    clips.slice(0, 5).forEach(c => {
      html += `<div class="result-item"><div class="result-text">${highlight(c.text.slice(0, 120), q)}</div><div class="result-meta">${c.source || ""} · ${timeAgo(c.createdAt)}</div></div>`;
    });
  }
  if (todos.length) {
    html += `<div class="result-group-label"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg> Todos (${todos.length})</div>`;
    todos.slice(0, 5).forEach(t => {
      html += `<div class="result-item"><div class="result-text${t.done ? " done" : ""}">${highlight(t.text, q)}</div><div class="result-meta">${t.done ? "✓ Done" : "Active"} · ${timeAgo(t.createdAt)}</div></div>`;
    });
  }
  out.innerHTML = html;
  out.querySelectorAll("[data-goto]").forEach(el => {
    el.addEventListener("click", () => switchTab("notes"));
  });
}

// ── Storage listener (live updates) ──
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.clipboard) { state.clipboard = changes.clipboard.newValue || []; if (state.activeTab === "clipboard") renderClipboard(); }
  if (changes.notes) {
    state.notes = changes.notes.newValue || [];
    if (state.activeTab === "notes") {
      const activeNoteId = getEditingNoteId() || editingNoteId;
      if (activeNoteId) {
        pendingNotesRefresh = true;
      } else {
        renderNotes();
      }
    }
  }
  if (changes.activeTab) { state.activeTab = changes.activeTab.newValue; switchTab(state.activeTab); }
  if (changes.clipboardEnabled) { state.clipboardEnabled = !!changes.clipboardEnabled.newValue; updateClipboardStatus(); if (state.activeTab === "clipboard") renderClipboard(); }
  if (changes.clipboardPollEnabled) { state.clipboardPollEnabled = changes.clipboardPollEnabled.newValue === true; updatePollStatus(); syncClipboardPolling(); }
  if (changes.clipboardPollIntervalMs) { state.clipboardPollIntervalMs = Number(changes.clipboardPollIntervalMs.newValue) || state.clipboardPollIntervalMs; syncClipboardPolling(); }
  if (changes.theme) { state.theme = changes.theme.newValue || "auto"; applyTheme(); }
  if (changes.debugMode) { state.debugMode = changes.debugMode.newValue === true; updatePrivacyChip(); }
});

// ── Clipboard monitor (best effort) ─────
let pollTimer = null;
let pollInFlight = false;
let lastPolled = { text: null, at: 0 };
let pollArmedUntil = 0;

function spDbg(event, data) {
  if (!state.debugMode) return;
  try { console.log('[Memex][SP]', event, data ?? ''); } catch { /* ignore */ }
}

function armPolling(ms = 12000) {
  pollArmedUntil = Date.now() + ms;
}

function isPollingContextActive() {
  if (!state.clipboardPollEnabled) return false;
  if (!navigator.clipboard?.readText) return false;
  if (document.hidden) return false;
  if (typeof document.hasFocus === 'function' && !document.hasFocus()) return false;
  // Clipboard read is frequently blocked without a recent user gesture. We keep a short “armed” window.
  if (Date.now() > pollArmedUntil) return false;
  return true;
}

async function captureClipboardOnce(captureSource, opts = {}) {
  if (!navigator.clipboard?.readText) {
    spDbg('poll_unavailable', { captureSource });
    return false;
  }
  if (!opts.force && !isPollingContextActive()) {
    spDbg('poll_inactive_context', { captureSource });
    return false;
  }
  if (pollInFlight) return false;

  pollInFlight = true;
  try {
    const raw = await navigator.clipboard.readText();
    const t = String(raw ?? '').trim();
    if (!t || t.length < 2) return false;

    const now = Date.now();
    if (lastMemexWrite?.text && t === lastMemexWrite.text && (now - lastMemexWrite.at) < 2500) {
      spDbg('poll_skip_own_write', { captureSource });
      return false;
    }
    if (lastPolled.text === t && (now - lastPolled.at) < 4000) return false;

    // Fast local dedupe against latest clip to avoid background wakeups.
    if (state.clipboard?.[0]?.text === t) return false;

    lastPolled = { text: t, at: now };

    chrome.runtime.sendMessage({
      type: 'CLIPBOARD_CAPTURE',
      captureSource,
      traceId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      text: t,
      url: '',
      hostname: '',
      timestamp: new Date().toISOString()
    }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) spDbg('poll_send_error', { message: err.message, captureSource });
      else spDbg('poll_sent', { captureSource, ok: resp?.success === true });
    });

    return true;
  } catch (e) {
    // Common: NotAllowedError when no transient activation or clipboard access blocked.
    spDbg('poll_read_failed', { name: e?.name, message: e?.message });
    if (String(e?.name) === 'NotAllowedError') pollArmedUntil = 0;
    return false;
  } finally {
    pollInFlight = false;
  }
}

function stopClipboardPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

function tickClipboardPolling() {
  stopClipboardPolling();
  if (!state.clipboardPollEnabled) return;

  const interval = Number(state.clipboardPollIntervalMs) || 1100;
  pollTimer = setTimeout(async () => {
    if (isPollingContextActive()) {
      await captureClipboardOnce('clipboard-poll');
    }
    tickClipboardPolling();
  }, Math.min(Math.max(400, interval), 5000));
}

function syncClipboardPolling() {
  if (!state.clipboardPollEnabled) {
    stopClipboardPolling();
    return;
  }
  tickClipboardPolling();
}

document.addEventListener('pointerdown', () => { if (state.clipboardPollEnabled) armPolling(); }, { capture: true });
document.addEventListener('keydown', () => { if (state.clipboardPollEnabled) armPolling(); }, { capture: true });

window.addEventListener('focus', () => syncClipboardPolling());
window.addEventListener('blur', () => stopClipboardPolling());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopClipboardPolling();
  else syncClipboardPolling();
});

// ── Debounce ────────────────────────────
let debounceTimer;
function debounce(fn, delay) { clearTimeout(debounceTimer); debounceTimer = setTimeout(fn, delay); }

// ── Onboarding ──────────────────────────
function showOnboarding() {
  const onboarding = $("onboarding");
  if (!onboarding) return;
  onboarding.hidden = false;
}
function hideOnboarding() {
  const onboarding = $("onboarding");
  if (onboarding) onboarding.hidden = true;
}
$("onboardingEnable").addEventListener("click", () => {
  setClipboardEnabled(true);
  hideOnboarding();
});
$("onboardingSkip").addEventListener("click", () => {
  setClipboardEnabled(false);
  hideOnboarding();
});

// ── Keyboard shortcuts ──────────────────
document.addEventListener("keydown", e => {
  const target = e.target;
  const isInput = target && (["INPUT", "TEXTAREA"].includes(target.tagName) || target.isContentEditable);
  if (e.ctrlKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    switchTab("search");
    $("globalSearch").focus();
  }
  if (!isInput && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "n") {
    e.preventDefault();
    switchTab("notes");
    $("newNoteBtn").click();
  }
  if (!isInput && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "t") {
    e.preventDefault();
    switchTab("todos");
    $("todoInput").focus();
  }
  if (!isInput && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c") {
    e.preventDefault();
    switchTab("clipboard");
  }
});

// ── Init ────────────────────────────────
async function init() {
  state = await loadState();
  state.notes = clampList(state.notes, NOTE_LIMIT);
  state.todos = clampList(state.todos, TODO_LIMIT);
  applyTheme();
  switchTab(state.activeTab);
  updateClipboardStatus();
  updatePollStatus();
  updatePrivacyChip();
  syncClipboardPolling();
  renderNotes();
  renderClipboard();
  renderTodos();
  if (!state.onboardingSeen) showOnboarding();
}

$("themeBtn").addEventListener("click", cycleTheme);
$("themeChip").addEventListener("click", cycleTheme);
$("clipboardToggle").addEventListener("click", () => setClipboardEnabled(!state.clipboardEnabled));
$("pollChip")?.addEventListener("click", () => setClipboardPollEnabled(!state.clipboardPollEnabled));
$("captureNowChip")?.addEventListener("click", async () => {
  // Explicit user gesture: try reading regardless of monitor state.
  armPolling(8000);
  const ok = await captureClipboardOnce('manual-save', { force: true });
  const btn = $("captureNowChip");
  if (!btn) return;
  btn.style.background = ok ? "var(--green-bg)" : "var(--red-bg)";
  btn.style.color = ok ? "var(--green)" : "var(--red)";
  setTimeout(() => { btn.style.background = ""; btn.style.color = ""; }, 900);
});

// Ctrl/⌘+Click "Local-only" to toggle debug logging (no UI clutter)
$("privacyChip")?.addEventListener("click", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  state.debugMode = !state.debugMode;
  saveNow(["debugMode"]);
  updatePrivacyChip();
});

init();
