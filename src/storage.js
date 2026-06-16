/**
 * Storage abstraction layer
 * 
 * Handles:
 * - State persistence to chrome.storage.local
 * - Schema versioning and migrations
 * - Data limits and pruning
 * - Atomic writes
 * - Cache invalidation
 */

const SCHEMA_VERSION = 1;

// Storage limits
export const LIMITS = {
  notes: 1000,
  clipboard: 500,
  todos: 1000,
  maxNoteSize: 100000, // 100KB per note
  maxClipSize: 10000,  // 10KB per clipboard item
  maxTodoSize: 1000    // 1KB per todo
};

// Default state
export const DEFAULT_STATE = {
  // Data
  notes: [],
  clipboard: [],
  todos: [],

  // Settings
  activeTab: 'clipboard',
  theme: 'auto',
  clipboardEnabled: false,
  onboardingSeen: false,
  clipboardLimit: LIMITS.clipboard,

  // Clipboard monitoring (sidepanel only; OFF by default)
  clipboardPollEnabled: false,
  clipboardPollIntervalMs: 1100,

  // Debugging
  // When true, enables structured console tracing in content/background/sidepanel.
  debugMode: false,

  // Storage
  schemaVersion: SCHEMA_VERSION,
  lastBackup: null,

  // Privacy
  blockedHosts: [],
  allowedHosts: []
};

/**
 * Load state from storage
 */
export async function loadState() {
  return new Promise((resolve) => {
    const keys = Object.keys(DEFAULT_STATE);
    chrome.storage.local.get(keys, (data) => {
      if (chrome.runtime.lastError) {
        console.error('Storage load error:', chrome.runtime.lastError);
        resolve(DEFAULT_STATE);
        return;
      }
      
      const state = { ...DEFAULT_STATE, ...data };
      
      // Handle schema migrations
      if (!data.schemaVersion || data.schemaVersion < SCHEMA_VERSION) {
        migrateSchema(data, state);
      }
      
      resolve(state);
    });
  });
}

/**
 * Serialize writes to avoid races/overwrites when multiple messages arrive quickly.
 */
let writeQueue = Promise.resolve();
function enqueueWrite(op) {
  const next = writeQueue.then(op);
  writeQueue = next.catch((err) => {
    // Keep the queue alive even after an error.
    console.error('Storage write error:', err);
  });
  return next;
}

/**
 * Save state to storage
 */
export async function saveState(patch) {
  return enqueueWrite(() => new Promise((resolve, reject) => {
    try {
      // Validate patch before saving
      validatePatch(patch);

      chrome.storage.local.set(patch, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  }));
}

/**
 * Get specific data from storage
 */
export async function getItem(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (data) => {
      resolve(data[key] !== undefined ? data[key] : DEFAULT_STATE[key]);
    });
  });
}

/**
 * Validate and sanitize patch before saving
 */
function validatePatch(patch) {
  if (!patch || typeof patch !== 'object') {
    throw new Error('Patch must be an object');
  }
  
  // Validate specific fields
  if (patch.notes !== undefined) {
    if (!Array.isArray(patch.notes)) throw new Error('notes must be an array');
    if (patch.notes.length > LIMITS.notes) {
      patch.notes = patch.notes.slice(0, LIMITS.notes);
    }
  }
  
  if (patch.clipboard !== undefined) {
    if (!Array.isArray(patch.clipboard)) throw new Error('clipboard must be an array');
    if (patch.clipboard.length > LIMITS.clipboard) {
      patch.clipboard = patch.clipboard.slice(0, LIMITS.clipboard);
    }
  }
  
  if (patch.todos !== undefined) {
    if (!Array.isArray(patch.todos)) throw new Error('todos must be an array');
    if (patch.todos.length > LIMITS.todos) {
      patch.todos = patch.todos.slice(0, LIMITS.todos);
    }
  }
  
  if (patch.clipboardEnabled !== undefined && typeof patch.clipboardEnabled !== 'boolean') {
    throw new Error('clipboardEnabled must be boolean');
  }

  if (patch.clipboardLimit !== undefined) {
    const n = Number(patch.clipboardLimit);
    if (!Number.isFinite(n) || n <= 0) throw new Error('clipboardLimit must be a positive number');
    // Clamp to a safe maximum to avoid storing too much.
    patch.clipboardLimit = Math.min(Math.max(1, Math.floor(n)), LIMITS.clipboard);
  }
  
  if (patch.clipboardPollEnabled !== undefined && typeof patch.clipboardPollEnabled !== 'boolean') {
    throw new Error('clipboardPollEnabled must be boolean');
  }

  if (patch.clipboardPollIntervalMs !== undefined) {
    const n = Number(patch.clipboardPollIntervalMs);
    if (!Number.isFinite(n) || n < 400) throw new Error('clipboardPollIntervalMs must be >= 400');
    patch.clipboardPollIntervalMs = Math.min(Math.max(400, Math.floor(n)), 5000);
  }

  if (patch.theme !== undefined && !['auto', 'light', 'dark'].includes(patch.theme)) {
    throw new Error('theme must be auto, light, or dark');
  }
}

/**
 * Prune old items when at limit
 */
export function pruneIfNeeded(state) {
  const pruned = { ...state };
  
  // Prune notes (keep newest)
  if (pruned.notes && pruned.notes.length > LIMITS.notes) {
    pruned.notes = pruned.notes.slice(0, LIMITS.notes);
  }
  
  // Prune clipboard (keep newest)
  if (pruned.clipboard && pruned.clipboard.length > LIMITS.clipboard) {
    pruned.clipboard = pruned.clipboard.slice(0, LIMITS.clipboard);
  }
  
  // Prune todos (keep newest active first, then completed)
  if (pruned.todos && pruned.todos.length > LIMITS.todos) {
    const active = pruned.todos.filter(t => !t.done);
    const completed = pruned.todos.filter(t => t.done);
    pruned.todos = [
      ...active.slice(0, Math.floor(LIMITS.todos * 0.8)),
      ...completed.slice(0, Math.ceil(LIMITS.todos * 0.2))
    ];
  }
  
  return pruned;
}

/**
 * Clamp list to maximum size
 */
export function clampList(list, limit) {
  if (!Array.isArray(list)) return [];
  if (!Number.isFinite(limit) || limit <= 0) return list;
  return list.slice(0, limit);
}

/**
 * Clear all data
 */
export async function clearAllData() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.clear(() => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve();
    });
  });
}

/**
 * Export data as JSON
 */
export async function exportData() {
  const state = await loadState();
  return {
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      notes: state.notes || [],
      clipboard: state.clipboard || [],
      todos: state.todos || []
    }
  };
}

/**
 * Import data from JSON
 */
export async function importData(importedData) {
  if (!importedData || !importedData.data) {
    throw new Error('Invalid import format');
  }
  
  const patch = {
    notes: Array.isArray(importedData.data.notes) ? importedData.data.notes : [],
    clipboard: Array.isArray(importedData.data.clipboard) ? importedData.data.clipboard : [],
    todos: Array.isArray(importedData.data.todos) ? importedData.data.todos : []
  };
  
  // Apply limits
  patch.notes = clampList(patch.notes, LIMITS.notes);
  patch.clipboard = clampList(patch.clipboard, LIMITS.clipboard);
  patch.todos = clampList(patch.todos, LIMITS.todos);
  
  await saveState(patch);
}

/**
 * Get storage usage stats
 */
export async function getStorageStats() {
  return new Promise((resolve) => {
    chrome.storage.local.getBytesInUse(null, (bytes) => {
      const limit = 10 * 1024 * 1024; // 10MB
      resolve({
        used: bytes,
        limit,
        percentage: Math.round((bytes / limit) * 100)
      });
    });
  });
}

/**
 * Schema migration handler
 */
function migrateSchema(oldData, newData) {
  // V0 to V1 migration
  if (!oldData.schemaVersion) {
    // Any legacy data transformations would go here
    console.log('Migrating from schema v0 to v1');
  }
  
  // Mark as migrated
  chrome.storage.local.set({ schemaVersion: SCHEMA_VERSION });
}

/**
 * Watch for storage changes
 */
export function onStorageChange(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      callback(changes);
    }
  });
}
