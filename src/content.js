/**
 * Content Script - Clipboard Capture System (classic script)
 *
 * Root-cause fix:
 * - Do NOT use Promise-style chrome.runtime.sendMessage().then(...) in content scripts.
 *   In many Chrome builds it's callback-based; using .then throws and breaks capture.
 *
 * Design:
 * - Two-phase copy/cut capture (capture + bubble)
 * - Fallback Ctrl/Cmd+C/X selection snapshot
 * - High-signal sensitive filtering (avoid false positives)
 * - Debug tracing via chrome.storage.local.debugMode (OFF by default)
 */

const MIN_CLIP_LENGTH = 2;
const MAX_CLIP_LENGTH = 10000;
const SEND_DEDUPE_MS = 750;

const isIncognito = (() => {
  try { return chrome?.extension?.inIncognitoContext === true; } catch { return false; }
})();

let clipboardEnabled = false;
let settingsLoaded = false;
let debugMode = false;

let lastCopiedText = '';
let lastSent = { text: null, at: 0 };

let pendingSelectionText = '';
let pendingUntilLoaded = null;

function dbg(event, data) {
  if (!debugMode) return;
  try {
    console.log('[Memex][CS]', event, data ?? '');
  } catch {
    // ignore
  }
}

function loadSettings() {
  try {
    chrome.storage.local.get(['clipboardEnabled', 'debugMode'], (data) => {
      clipboardEnabled = data.clipboardEnabled === true;
      debugMode = data.debugMode === true;
      settingsLoaded = true;
      dbg('settings_loaded', { clipboardEnabled, debugMode, isIncognito });

      if (pendingUntilLoaded) {
        const { text, meta } = pendingUntilLoaded;
        pendingUntilLoaded = null;
        processClipboardText(text, meta);
      }
    });
  } catch (e) {
    // If storage is unavailable, stay safe: do not capture.
    dbg('settings_load_failed', { message: e?.message });
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.clipboardEnabled) {
    clipboardEnabled = changes.clipboardEnabled.newValue === true;
    dbg('clipboardEnabled_changed', { clipboardEnabled });
  }
  if (changes.debugMode) {
    debugMode = changes.debugMode.newValue === true;
    dbg('debugMode_changed', { debugMode });
  }
});

// Keep URL blocking high-signal only (background also enforces allow/block lists).
const BLOCKED_HOSTS = [
  'bank', 'banking', 'chase', 'wellsfargo', 'bofa', 'citibank', 'capitalone',
  'paypal', 'stripe', 'square',
  'accounts.google', 'myaccount.google',
  'login.microsoft', 'login.microsoftonline', 'login.live',
  'appleid.apple', 'id.apple',
  'auth0', 'okta', 'openid', 'oauth', 'singpass'
];

const BLOCKED_PATHS = [
  '/login', '/signin', '/signup', '/auth', '/oauth', '/authorize', '/authenticate',
  '/password', '/reset', '/forgot',
  '/mfa', '/2fa', '/otp', '/verify', '/verification', '/confirm',
  '/checkout', '/payment', '/billing'
];

function isSensitiveUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    if (BLOCKED_HOSTS.some(k => host.includes(k))) return true;
    if (BLOCKED_PATHS.some(k => path.includes(k))) return true;
    return false;
  } catch {
    return false;
  }
}

function isSensitiveField(element) {
  if (!element || element.nodeType !== 1) return false;

  const type = (element.getAttribute('type') || '').toLowerCase();
  if (['password', 'hidden'].includes(type)) return true;

  const autocomplete = (element.getAttribute('autocomplete') || '').toLowerCase();
  const sensitiveAuto = ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp'];
  if (sensitiveAuto.includes(autocomplete)) return true;

  const meta = [element.name, element.id, element.getAttribute('aria-label'), element.getAttribute('placeholder')]
    .filter(Boolean).join(' ').toLowerCase();

  return /(password|passcode|pin|secret|otp|2fa|mfa|verification|api[-_]?key|token|bearer|jwt|credit|card|cvv|cvc)/i.test(meta);
}

function isSensitiveClipboardText(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;

  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t)) return true;
  if (/\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/.test(t)) return true;
  if (/\bBearer\s+[A-Za-z0-9._-]{20,}\b/i.test(t)) return true;

  const keyLike = /(sk_(live|test)_[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})/;
  if (keyLike.test(t)) return true;

  if (/(otp|verification|2fa|mfa|code)[^0-9]{0,12}\b\d{6}\b/i.test(t)) return true;

  const digits = t.replace(/[ -]/g, '');
  if (/^\d{13,19}$/.test(digits) && /(card|cvv|cvc|expiry|exp|amex|visa|mastercard)/i.test(t)) return true;

  return false;
}

function isMemexInternalCopy(text) {
  if (!text) return false;
  return /memex/i.test(text) || /\d{1,2}[smhd]\s+ago/i.test(text) || /just now/i.test(text);
}

function sanitizeClipboardText(text) {
  if (!text || typeof text !== 'string') return '';
  let t = text.replace(/\u00A0/g, ' ').replace(/\s+\n/g, '\n').trim();
  if (t.length > MAX_CLIP_LENGTH) t = t.slice(0, MAX_CLIP_LENGTH);
  return t;
}

function getClipboardTextFromEvent(e) {
  try {
    const t = e?.clipboardData?.getData?.('text/plain');
    return typeof t === 'string' ? t : '';
  } catch {
    return '';
  }
}

function getSelectedText(preferredTarget) {
  try {
    const targetEl = (preferredTarget && preferredTarget.nodeType === 1) ? preferredTarget : null;
    const activeEl = (targetEl && (targetEl.tagName === 'INPUT' || targetEl.tagName === 'TEXTAREA'))
      ? targetEl
      : document.activeElement;

    if (activeEl && ['INPUT', 'TEXTAREA'].includes(activeEl.tagName)) {
      const start = activeEl.selectionStart;
      const end = activeEl.selectionEnd;
      if (typeof start === 'number' && typeof end === 'number' && start < end) {
        return activeEl.value.substring(start, end);
      }
    }

    const selection = window.getSelection();
    return selection ? selection.toString() : '';
  } catch {
    return '';
  }
}

function processClipboardText(rawText, meta = {}) {
  if (!settingsLoaded) {
    pendingUntilLoaded = { text: rawText, meta };
    loadSettings();
    return;
  }

  dbg('capture_attempt', { ...meta, enabled: clipboardEnabled, isIncognito });

  if (!clipboardEnabled || isIncognito) return;

  const trimmed = (typeof rawText === 'string' ? rawText : '').trim();
  if (!trimmed || trimmed.length < MIN_CLIP_LENGTH) return;

  if (trimmed === lastCopiedText) return;
  lastCopiedText = trimmed;

  if (isSensitiveUrl(window.location.href)) return;

  const activeEl = document.activeElement;
  if (activeEl && isSensitiveField(activeEl)) return;

  if (isSensitiveClipboardText(trimmed)) return;
  if (isMemexInternalCopy(trimmed)) return;

  const sanitized = sanitizeClipboardText(trimmed);
  if (!sanitized) return;

  sendToBackground(sanitized);
}

function sendToBackground(text) {
  const now = Date.now();
  if (lastSent.text === text && (now - lastSent.at) < SEND_DEDUPE_MS) {
    dbg('send_deduped', { len: text.length });
    return;
  }
  lastSent = { text, at: now };

  const payload = {
    type: 'CLIPBOARD_CAPTURE',
    captureSource: 'dom-copy',
    traceId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    url: window.location.href,
    hostname: window.location.hostname,
    timestamp: new Date().toISOString()
  };

  try {
    chrome.runtime.sendMessage(payload, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) {
        dbg('send_error', { message: err.message });
        return;
      }
      dbg('send_ok', resp);
    });
  } catch (e) {
    dbg('send_throw', { message: e?.message });
  }
}

function onCopyCutCapture(e) {
  pendingSelectionText = getSelectedText(e?.target);
}

function onCopyCutBubble(e) {
  const finalText = getClipboardTextFromEvent(e) || pendingSelectionText || getSelectedText(e?.target);
  pendingSelectionText = '';
  processClipboardText(finalText, { event: e.type });
}

document.addEventListener('copy', onCopyCutCapture, true);
document.addEventListener('copy', onCopyCutBubble, false);
document.addEventListener('cut', onCopyCutCapture, true);
document.addEventListener('cut', onCopyCutBubble, false);

// Fallback for sites that short-circuit copy events.
document.addEventListener('keydown', (e) => {
  const key = String(e.key || '').toLowerCase();
  const combo = (e.ctrlKey || e.metaKey) && (key === 'c' || key === 'x');
  if (!combo) return;

  setTimeout(() => {
    processClipboardText(getSelectedText(e?.target), { event: 'keydown_fallback' });
  }, 0);
}, true);

loadSettings();
