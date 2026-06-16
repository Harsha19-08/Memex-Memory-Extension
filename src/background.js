/**
 * Background Service Worker
 * 
 * Handles:
 * - Clipboard capture messages from content script
 * - Deduplication and storage
 * - URL validation and allowlist/blocklist
 * - Storage management
 * - Extension lifecycle events
 */

import * as Storage from './storage.js';
import * as Privacy from './privacy.js';

// Debug mode (OFF by default). Toggle via sidepanel: Ctrl/⌘+Click "Local-only".
let debugMode = false;
function dbg(event, data) {
  if (!debugMode) return;
  try {
    console.log('[Memex][BG]', event, data ?? '');
  } catch {
    // ignore
  }
}

function initDebugMode() {
  try {
    chrome.storage.local.get(['debugMode'], (data) => {
      debugMode = data.debugMode === true;
      dbg('debugMode_loaded', { debugMode });
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.debugMode) {
        debugMode = changes.debugMode.newValue === true;
        dbg('debugMode_changed', { debugMode });
      }
    });
  } catch {
    // ignore
  }
}

initDebugMode();

/**
 * Initialize extension on install
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    // First install: initialize defaults
    await initializeDefaults();
  } else if (details.reason === 'update') {
    // Updated: ensure defaults
    await initializeDefaults();
  }

  // Prefer Chrome-managed open behavior on toolbar click
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    // Not available in older Chromium builds; action.onClicked handler below will still work.
  }

  // Create context menu
  createContextMenu();
});

/**
 * Initialize on startup
 */
chrome.runtime.onStartup.addListener(async () => {
  await initializeDefaults();
});

/**
 * Initialize default settings
 */
async function initializeDefaults() {
  const state = await Storage.loadState();
  
  // Ensure all required fields exist
  const patch = {};
  if (typeof state.clipboardEnabled !== 'boolean') {
    patch.clipboardEnabled = false;
  }
  if (typeof state.onboardingSeen !== 'boolean') {
    patch.onboardingSeen = false;
  }
  if (typeof state.theme !== 'string') {
    patch.theme = 'auto';
  }
  if (!Number.isFinite(state.clipboardLimit)) {
    patch.clipboardLimit = Storage.LIMITS.clipboard;
  }
  
  if (Object.keys(patch).length > 0) {
    await Storage.saveState(patch);
  }
}

/**
 * Create context menu for saving selection to notes
 */
function createContextMenu() {
  try {
    // Clear old menu items
    chrome.contextMenus.removeAll();
    
    // Create "Save to Memex" context menu
    chrome.contextMenus.create({
      id: 'save-to-notes',
      title: 'Save to Memex Notes',
      contexts: ['selection'],
      documentUrlPatterns: ['http://*/*', 'https://*/*']
    });
  } catch (error) {
    console.error('Failed to create context menu:', error);
  }
}

/**
 * Handle context menu clicks
 */
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'save-to-notes' && info.selectionText) {
    try {
      const state = await Storage.loadState();
      const notes = state.notes || [];
      
      const newNote = {
        id: Date.now().toString(),
        content: info.selectionText.trim(),
        source: tab?.url ? new URL(tab.url).hostname : 'unknown',
        color: 'yellow',
        pinned: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      notes.unshift(newNote);
      await Storage.saveState({ 
        notes: Storage.clampList(notes, Storage.LIMITS.notes),
        activeTab: 'notes'
      });
    } catch (error) {
      console.error('Failed to save note:', error);
    }
  }
});

/**
 * Handle messages from content scripts and sidepanel
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Async handling
  (async () => {
    try {
      switch (message.type) {
        case 'CLIPBOARD_CAPTURE':
          await handleClipboardCapture(message, sender);
          sendResponse({ success: true });
          break;
          
        case 'GET_STATE':
          const state = await Storage.loadState();
          sendResponse(state);
          break;
          
        case 'SAVE_STATE':
          await Storage.saveState(message.data);
          sendResponse({ success: true });
          break;
          
        case 'CLEAR_ALL_DATA':
          await Storage.clearAllData();
          sendResponse({ success: true });
          break;
          
        case 'EXPORT_DATA':
          const exported = await Storage.exportData();
          sendResponse(exported);
          break;
          
        case 'IMPORT_DATA':
          await Storage.importData(message.data);
          sendResponse({ success: true });
          break;
          
        default:
          sendResponse({ error: 'Unknown message type' });
      }
    } catch (error) {
      console.error('Message handler error:', error);
      sendResponse({ error: error.message });
    }
  })();
  
  // Keep channel open for async response
  return true;
});

/**
 * Clipboard capture pipeline
 * - Validates + filters
 * - Debounces/batches writes
 * - Avoids overwrite races (Storage.saveState is serialized)
 */
const MIN_CLIP_LENGTH = 2;
const FLUSH_DELAY_MS = 150;

let pendingClips = [];
let flushTimer = null;
let flushing = false;

function sanitizeText(text) {
  if (typeof text !== 'string') return '';
  let t = text.replace(/\u00A0/g, ' ').replace(/\s+\n/g, '\n').trim();
  const max = Storage?.LIMITS?.maxClipSize || 10000;
  if (t.length > max) t = t.slice(0, max);
  return t;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushPending().catch((e) => console.error('[Memex][BG] flushPending failed:', e));
  }, FLUSH_DELAY_MS);
}

async function flushPending() {
  if (flushing) return;
  flushing = true;

  const batch = pendingClips;
  pendingClips = [];

  try {
    if (!batch.length) return;

    const state = await Storage.loadState();
    if (!state.clipboardEnabled) {
      dbg('blocked_disabled', { batch: batch.length });
      return;
    }

    let clipboard = Array.isArray(state.clipboard) ? state.clipboard : [];

    // Apply oldest → newest so newest ends up on top
    const ordered = batch.slice().reverse();

    for (const clip of ordered) {
      // Dedupe (exact match anywhere)
      const dupIdx = clipboard.findIndex((c) => c && c.text === clip.text);
      if (dupIdx === 0) continue;
      if (dupIdx > 0) {
        // Keep existing pinned item; just skip adding a duplicate.
        continue;
      }

      clipboard.unshift(clip);
    }

    clipboard = Storage.clampList(clipboard, state.clipboardLimit || Storage.LIMITS.clipboard);
    await Storage.saveState({ clipboard });

    dbg('clipboard_saved', { added: ordered.length, final: clipboard.length });
  } finally {
    flushing = false;
    if (pendingClips.length) scheduleFlush();
  }
}

/**
 * Process clipboard capture from content script
 */
function classifyClipText(text) {
  const t = String(text ?? '').trim();
  if (!t) return 'text';
  try {
    const u = new URL(t);
    if (u.protocol === 'http:' || u.protocol === 'https:') return 'link';
  } catch {
    // ignore
  }

  const lines = t.split(/\r?\n/);
  const long = t.length > 220;
  const hasCodeSignals = /\b(function|const|let|var|class|import|export|return|if|else|for|while|try|catch)\b/.test(t) || /[{};`]/.test(t);
  const indented = lines.length >= 3 && lines.filter(l => /^\s{2,}\S/.test(l)).length >= 2;
  if (hasCodeSignals && (long || indented || lines.length >= 4)) return 'code';

  const looksLikePrompt = /(you are|act as|system:|developer:|user:|write a|generate a|create a|please|build a|implement)/i.test(t);
  if (looksLikePrompt && (long || lines.length >= 3)) return 'prompt';

  return 'text';
}

async function handleClipboardCapture(message, sender) {
  const { text, hostname, url, timestamp, traceId, captureSource } = message || {};
  const source = (typeof captureSource === 'string' && captureSource) ? captureSource : 'dom-copy';

  dbg('capture_received', { traceId, source, textLen: text?.length, hostname, url, incognito: sender.tab?.incognito });

  // Basic validation
  if (typeof text !== 'string') {
    dbg('drop_invalid_text', { traceId });
    return;
  }

  const hn = (typeof hostname === 'string') ? hostname : '';
  const safeUrl = (typeof url === 'string') ? url : '';

  // For DOM copy we expect a sender hostname, except for file:// pages.
  if (source === 'dom-copy') {
    if (!hn && !safeUrl.startsWith('file://')) {
      dbg('drop_missing_hostname', { traceId });
      return;
    }
  }

  if (sender.tab?.incognito) {
    dbg('drop_incognito', { traceId });
    return;
  }

  const sanitized = sanitizeText(text);
  if (!sanitized || sanitized.length < MIN_CLIP_LENGTH) {
    dbg('drop_too_short', { traceId, len: sanitized.length });
    return;
  }

  // Defense in depth privacy filters
  const reason = await Privacy.getUrlBlockReason(url || '');
  if (reason) {
    dbg('drop_url_blocked', { traceId, reason, url });
    return;
  }
  if (Privacy.isSensitiveClipboardText(sanitized)) {
    dbg('drop_sensitive_text', { traceId });
    return;
  }
  if (Privacy.isMemexInternalCopy(sanitized)) {
    dbg('drop_internal_copy', { traceId });
    return;
  }

  // Check enabled state once here (fast fail)
  const state = await Storage.loadState();
  if (!state.clipboardEnabled) {
    dbg('drop_disabled', { traceId });
    return;
  }

  const clipEntry = {
    id: Date.now().toString(),
    text: sanitized,
    kind: classifyClipText(sanitized),
    captureSource: source,
    source: hn ? Privacy.getSourceDisplay(hn) : (safeUrl.startsWith('file://') ? 'File' : (source === 'clipboard-poll' ? 'Clipboard' : 'Manual')),
    sourceUrl: safeUrl,
    pinned: false,
    createdAt: timestamp || new Date().toISOString()
  };

  pendingClips.unshift(clipEntry);
  dbg('queued', { traceId, pending: pendingClips.length });
  scheduleFlush();
}

/**
 * Handle keyboard commands
 */
chrome.commands.onCommand.addListener(async (command) => {
  // Commands are user gestures, but reliably opening side panel requires a tabId.
  // We keep commands lightweight: just set the target tab in storage.
  try {
    const tabMap = {
      'focus-search': 'search',
      'quick-note': 'notes',
      'view-clipboard': 'clipboard'
    };
    const nextTab = tabMap[command];
    if (nextTab) {
      await Storage.saveState({ activeTab: nextTab });
    }
  } catch (error) {
    console.error('Command handler error:', error);
  }
});

/**
 * Open side panel programmatically
 */
async function openSidePanel(tabId, targetTab) {
  try {
    if (!tabId) return;
    // Ensure enabled/path (some Chromium builds are picky)
    try {
      await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true });
    } catch {
      // Ignore if unsupported
    }

    await chrome.sidePanel.open({ tabId });

    if (targetTab) {
      await Storage.saveState({ activeTab: targetTab });
    }
  } catch (error) {
    console.error('Failed to open side panel:', error);
  }
}

/**
 * Handle icon click
 */
chrome.action.onClicked.addListener(async (tab) => {
  // User gesture: safe to open side panel here
  await openSidePanel(tab?.id, 'clipboard');
});
