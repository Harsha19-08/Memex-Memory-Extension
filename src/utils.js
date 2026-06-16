/**
 * Utility functions for Memex
 */

/**
 * Debounce a function
 */
export function debounce(fn, delay = 250) {
  let timeoutId;
  return function debounced(...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * Throttle a function
 */
export function throttle(fn, delay = 250) {
  let lastCall = 0;
  return function throttled(...args) {
    const now = Date.now();
    if (now - lastCall >= delay) {
      lastCall = now;
      fn.apply(this, args);
    }
  };
}

/**
 * Format time ago (e.g., "5m ago", "2h ago")
 */
export function timeAgo(isoString) {
  const now = Date.now();
  const time = new Date(isoString).getTime();
  const diff = now - time;
  
  const minute = 60000;
  const hour = 3600000;
  const day = 86400000;
  
  if (diff < minute) return 'just now';
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < day * 7) return `${Math.floor(diff / day)}d ago`;
  
  const date = new Date(isoString);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Format date for grouping
 */
export function formatDateGroup(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  
  // Today
  if (date.toDateString() === now.toDateString()) {
    return 'Today';
  }
  
  // Yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }
  
  // This week
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);
  if (date > weekAgo) {
    return 'This Week';
  }
  
  // Format as "Month Day"
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

/**
 * Escape HTML special characters
 */
export function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Highlight search query in text
 */
export function highlightMatch(text, query) {
  if (!query) return escapeHtml(text);
  
  const escaped = escapeHtml(text);
  const escapedQuery = escapeHtml(query)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  
  try {
    return escaped.replace(
      new RegExp(escapedQuery, 'gi'),
      (match) => `<mark>${match}</mark>`
    );
  } catch {
    return escaped;
  }
}

/**
 * Check if string is a URL
 */
export function isUrl(text) {
  if (!text || typeof text !== 'string') return false;
  try {
    const url = new URL(text);
    return url.protocol.startsWith('http');
  } catch {
    return false;
  }
}

/**
 * Truncate text with ellipsis
 */
export function truncate(text, maxLength = 300) {
  if (!text) return '';
  const str = String(text);
  return str.length > maxLength ? str.slice(0, maxLength) + '…' : str;
}

/**
 * Generate unique ID
 */
export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

/**
 * Group array by property
 */
export function groupBy(array, key) {
  return array.reduce((result, item) => {
    const group = item[key];
    if (!result[group]) result[group] = [];
    result[group].push(item);
    return result;
  }, {});
}

/**
 * Sort array stable
 */
export function stableSort(array, compareFn) {
  return array
    .map((value, index) => ({ value, index }))
    .sort((a, b) => compareFn(a.value, b.value) || a.index - b.index)
    .map(({ value }) => value);
}

/**
 * Remove duplicates from array
 */
export function unique(array, key) {
  const seen = new Set();
  return array.filter((item) => {
    const id = key ? item[key] : item;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Clamp value between min and max
 */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Deep copy object
 */
export function deepCopy(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (obj instanceof Date) return new Date(obj.getTime());
  if (obj instanceof Array) return obj.map(item => deepCopy(item));
  if (obj instanceof Object) {
    const copy = {};
    for (const key in obj) {
      copy[key] = deepCopy(obj[key]);
    }
    return copy;
  }
}

/**
 * Wait for specified milliseconds
 */
export function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Batch operations
 */
export class Batcher {
  constructor(fn, delay = 250, maxSize = 100) {
    this.fn = fn;
    this.delay = delay;
    this.maxSize = maxSize;
    this.batch = [];
    this.timeoutId = null;
  }
  
  add(item) {
    this.batch.push(item);
    
    if (this.batch.length >= this.maxSize) {
      this.flush();
    } else {
      this._scheduleFlush();
    }
  }
  
  _scheduleFlush() {
    if (this.timeoutId) return;
    this.timeoutId = setTimeout(() => this.flush(), this.delay);
  }
  
  flush() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    
    if (this.batch.length > 0) {
      const items = this.batch;
      this.batch = [];
      this.fn(items);
    }
  }
}

export default {
  debounce,
  throttle,
  timeAgo,
  formatDateGroup,
  escapeHtml,
  highlightMatch,
  isUrl,
  truncate,
  generateId,
  groupBy,
  stableSort,
  unique,
  clamp,
  deepCopy,
  wait,
  Batcher
};
