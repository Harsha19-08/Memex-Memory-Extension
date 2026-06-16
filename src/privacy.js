/**
 * Privacy & Security Filtering System
 * 
 * Handles multi-layer privacy protection:
 * - Sensitive field detection (passwords, OTP, API keys)
 * - Sensitive page detection (banking, auth sites)
 * - Incognito mode handling
 * - Domain/path allowlist/blocklist
 * 
 * All filtering is conservative: when in doubt, block.
 */

// Sensitive content patterns (very broad for privacy)
const SENSITIVE_PATTERNS = {
  // Password/authentication patterns
  password: /password|passcode|pin|secret|auth|login|signin|oauth|bearer|token/i,
  
  // Financial/payment patterns
  financial: /card|credit|debit|cvv|cvc|expir|bank|routing|iban|swift|account[-_]?number|social[-_]?security|ssn|tax[-_]?id/i,
  
  // API/developer tokens
  apiKey: /api[-_]?key|api[-_]?secret|access[-_]?token|refresh[-_]?token|bearer|jwt|auth[-_]?token|session[-_]?token/i,
  
  // OTP/2FA codes
  otp: /one[-_]?time|otp|totp|hotp|2fa|two[-_]?factor|verification[-_]?code|mfa|multi[-_]?factor/i,
  
  // Cryptographic material
  crypto: /private[-_]?key|public[-_]?key|secret[-_]?key|rsa|encryption[-_]?key|signing[-_]?key|certificate|pem|pgp/i,
  
  // Authentication forms
  authForm: /login|signin|signup|password|auth|oauth|sso|credentials|jwt|token/i
};

// Blocked host patterns (case-insensitive)
// Keep this list HIGH-SIGNAL only.
// Overblocking (e.g. "google.com", "microsoft") breaks capture on normal sites.
const BLOCKED_HOSTS = [
  // Banking / finance
  'bank', 'banking', 'chase', 'wellsfargo', 'bofa', 'citibank', 'capitalone',
  'americanexpress', 'hsbc', 'barclays', 'ubs',

  // Payment / checkout providers
  'paypal', 'stripe', 'square',
  'checkout.google', 'pay.google', 'billing.google',

  // Auth / identity providers (login portals)
  'accounts.google', 'myaccount.google',
  'login.microsoft', 'login.microsoftonline', 'login.live',
  'appleid.apple', 'id.apple',
  'auth0', 'okta', 'openid', 'oauth', 'singpass'
];

// Blocked path patterns (case-insensitive)
// Keep these focused on HIGH-RISK auth/payment flows to avoid overblocking normal pages.
const BLOCKED_PATHS = [
  '/login', '/signin', '/signup', '/auth', '/oauth', '/authorize', '/authenticate',
  '/password', '/reset', '/forgot',
  '/mfa', '/2fa', '/otp', '/verify', '/verification', '/confirm',
  '/checkout', '/payment', '/billing'
];

/**
 * Check if a field element contains sensitive data
 */
export function isSensitiveField(element) {
  if (!element || element.nodeType !== 1) return false;
  
  // Type attribute checks
  const type = (element.getAttribute('type') || '').toLowerCase();
  if (['password', 'hidden', 'email'].includes(type)) return true;
  
  // Autocomplete attribute checks (HTML5 standard)
  const autocomplete = (element.getAttribute('autocomplete') || '').toLowerCase();
  const sensitiveAutoComplete = [
    'current-password', 'new-password', 'one-time-code',
    'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year',
    'cc-name', 'billing'
  ];
  if (sensitiveAutoComplete.includes(autocomplete)) return true;
  
  // Name/ID/placeholder/aria-label pattern checks
  const fieldMeta = [
    element.name,
    element.id,
    element.getAttribute('aria-label'),
    element.getAttribute('placeholder')
  ].filter(Boolean).join(' ').toLowerCase();
  
  // Check all sensitive patterns
  for (const [_, pattern] of Object.entries(SENSITIVE_PATTERNS)) {
    if (pattern.test(fieldMeta)) return true;
  }
  
  // Check if inside a sensitive form
  const form = element.closest('form');
  if (form) {
    // If form has password field, mark as sensitive
    if (form.querySelector('input[type="password"]')) return true;
    
    // Check form attributes
    const formMeta = [
      form.getAttribute('id'),
      form.getAttribute('name'),
      form.getAttribute('action')
    ].filter(Boolean).join(' ').toLowerCase();
    
    if (SENSITIVE_PATTERNS.authForm.test(formMeta)) return true;
  }
  
  return false;
}

/**
 * Check if element is hidden
 */
export function isHiddenElement(element) {
  if (!element || element.nodeType !== 1) return false;
  if (element.type === 'hidden') return true;
  
  try {
    const style = window.getComputedStyle(element);
    return style.display === 'none' || style.visibility === 'hidden';
  } catch {
    return false;
  }
}

/**
 * Check if current page contains sensitive content
 */
export function isSensitivePage(url) {
  if (!url) return false;
  
  try {
    const urlObj = new URL(url);
    const host = urlObj.hostname.toLowerCase();
    const path = urlObj.pathname.toLowerCase();
    
    // Check blocked hosts
    if (BLOCKED_HOSTS.some(blocked => host.includes(blocked))) return true;
    
    // Check blocked paths
    if (BLOCKED_PATHS.some(blocked => path.includes(blocked))) return true;
    
    // NOTE: Do NOT block the whole page just because a password field exists.
    // Many modern sites keep hidden login modals in the DOM, which would
    // incorrectly disable clipboard capture everywhere.
    // We rely on URL/path checks + activeElement field checks instead.
    return false;
  } catch {
    return false;
  }
}

/**
 * Check if in incognito context
 */
export function isIncognitoContext() {
  try {
    return chrome?.extension?.inIncognitoContext === true;
  } catch {
    return false;
  }
}

/**
 * Analyze text for sensitive patterns
 *
 * NOTE: This is intentionally broad and is mainly useful for field/form metadata.
 * For clipboard text itself, use `isSensitiveClipboardText` (high-signal only).
 */
export function hasSensitiveContent(text) {
  if (!text || typeof text !== 'string') return false;

  const lowerText = text.toLowerCase();

  // Check all patterns
  for (const [_, pattern] of Object.entries(SENSITIVE_PATTERNS)) {
    if (pattern.test(lowerText)) return true;
  }

  return false;
}

/**
 * High-signal clipboard secret detection (avoid false positives).
 */
export function isSensitiveClipboardText(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;

  // Private keys / cert material
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t)) return true;

  // JWTs: 3 base64url-ish segments
  if (/\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/.test(t)) return true;

  // Bearer token (token-like)
  if (/\bBearer\s+[A-Za-z0-9._-]{20,}\b/i.test(t)) return true;

  // Common API key patterns (high signal)
  const keyLike = /(sk_(live|test)_[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})/;
  if (keyLike.test(t)) return true;

  // OTP-like codes only when context suggests it
  if (/(otp|verification|2fa|mfa|code)[^0-9]{0,12}\b\d{6}\b/i.test(t)) return true;

  // Credit card numbers only when accompanied by strong payment context words
  const digits = t.replace(/[ -]/g, '');
  if (/^\d{13,19}$/.test(digits) && /(card|cvv|cvc|expiry|exp|amex|visa|mastercard)/i.test(t)) return true;

  return false;
}

/**
 * Check if text looks like it was copied from Memex UI
 * (prevents infinite loop when user copies from their own clipboard history)
 */
export function isMemexInternalCopy(text) {
  if (!text) return false;
  
  // Look for Memex-specific markers or timestamps that suggest
  // this came from the Memex UI itself
  const markers = [
    /memex/i,
    /\d{1,2}[smhd]\s+ago/i,  // "5m ago", "2h ago" timestamp format
    /just now/i
  ];
  
  return markers.some(marker => marker.test(text));
}

/**
 * Get privacy settings
 */
export async function getPrivacySettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['clipboardEnabled', 'allowedHosts', 'blockedHosts'], (data) => {
      resolve({
        clipboardEnabled: data.clipboardEnabled === true,
        allowedHosts: Array.isArray(data.allowedHosts) ? data.allowedHosts : [],
        blockedHosts: Array.isArray(data.blockedHosts) ? data.blockedHosts : []
      });
    });
  });
}

/**
 * Check if URL is allowed (considering allowlist/blocklist)
 */
export async function isUrlAllowed(url) {
  return (await getUrlBlockReason(url)) == null;
}

/**
 * Debug helper: returns a short reason string when capture is blocked, else null.
 */
export async function getUrlBlockReason(url) {
  if (!url) return null;

  try {
    const urlObj = new URL(url);
    const host = urlObj.hostname.toLowerCase();
    const path = urlObj.pathname.toLowerCase();

    const settings = await getPrivacySettings();
    const allowed = (settings.allowedHosts || []).map(s => String(s).toLowerCase()).filter(Boolean);
    const blocked = (settings.blockedHosts || []).map(s => String(s).toLowerCase()).filter(Boolean);

    // If allowlist is set, ONLY allow matching hosts
    if (allowed.length > 0) {
      const ok = allowed.some((h) => host === h || host.endsWith('.' + h) || host.includes(h));
      return ok ? null : 'allowlist_miss';
    }

    if (blocked.some((h) => host === h || host.endsWith('.' + h) || host.includes(h))) return 'blocked_host:user';
    if (BLOCKED_HOSTS.some((blockedHost) => host.includes(blockedHost))) return 'blocked_host:builtin';
    if (BLOCKED_PATHS.some((blockedPath) => path.includes(blockedPath))) return 'blocked_path:builtin';

    return null;
  } catch {
    return null;
  }
}

/**
 * Sanitize clipboard text for storage
 */
export function sanitizeClipboardText(text) {
  if (!text) return '';
  
  // Remove leading/trailing whitespace
  let sanitized = String(text).trim();
  
  // Remove control characters except newlines
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  
  // Remove excessive whitespace
  sanitized = sanitized.replace(/\s{3,}/g, '  ');
  
  return sanitized;
}

/**
 * Get clipboard source display name
 */
export function getSourceDisplay(hostname) {
  if (!hostname) return 'unknown';
  
  try {
    // Extract main domain for cleaner display
    const parts = hostname.split('.');
    if (parts.length >= 2) {
      // Handle subdomains (e.g., "api.github.com" -> "github")
      const mainDomain = parts[parts.length - 2];
      return mainDomain.charAt(0).toUpperCase() + mainDomain.slice(1);
    }
    return hostname;
  } catch {
    return hostname;
  }
}

export default {
  isSensitiveField,
  isHiddenElement,
  isSensitivePage,
  isIncognitoContext,
  hasSensitiveContent,
  isMemexInternalCopy,
  getPrivacySettings,
  isUrlAllowed,
  sanitizeClipboardText,
  getSourceDisplay
};
