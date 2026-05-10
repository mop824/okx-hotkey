/**
 * report-sender.js — Receives REPORT_SELECTOR_FAILURE from content script,
 * validates payload, applies per-selector rate-limit, and POSTs to server.
 *
 * Rate-limit: per selector_name, 5 min window, stored in chrome.storage.local
 * (key: "report_sent_ts_<name>"). Distinct from monitor-side debounce so that
 * background acts as a second gate even if multiple tabs fire simultaneously.
 */

'use strict';

// LICENSE_SERVER is defined in service-worker.js (same module scope).
// Both files load into the same service-worker global — no re-import needed.

const _REPORT_DEBOUNCE_MS   = 5 * 60 * 1000;
const _REPORT_STORAGE_PREFIX = 'report_sent_ts_';

// ── Payload validation ────────────────────────────────────────────────────────

const _SELECTOR_NAME_RE = /^\w+$/; // alphanumeric + underscore only
const _OKX_TRADE_URL_RE = /^https:\/\/www\.okx\.com\/trade-/;

function _validatePayload(p) {
  if (!p || typeof p !== 'object') return false;
  if (typeof p.selector_name !== 'string' || !_SELECTOR_NAME_RE.test(p.selector_name)) return false;
  if (typeof p.page_url !== 'string' || !_OKX_TRADE_URL_RE.test(p.page_url)) return false;
  if (typeof p.user_agent !== 'string') return false;
  if (p.user_agent.length > 256) return false;
  // ASCII-only guard: reject multi-byte chars (≤127 code points)
  for (let i = 0; i < p.user_agent.length; i++) {
    if (p.user_agent.charCodeAt(i) > 127) return false;
  }
  return true;
}

// ── Rate-limit (background-side) ──────────────────────────────────────────────

async function _canSendReport(selectorName) {
  const key = _REPORT_STORAGE_PREFIX + selectorName;
  const result = await chrome.storage.local.get(key);
  const lastTs = result[key] || 0;
  return Date.now() - lastTs >= _REPORT_DEBOUNCE_MS;
}

async function _markSent(selectorName) {
  const key = _REPORT_STORAGE_PREFIX + selectorName;
  await chrome.storage.local.set({ [key]: Date.now() });
}

// ── HTTP send ─────────────────────────────────────────────────────────────────

async function sendReport(payload) {
  if (!_validatePayload(payload)) {
    console.warn('[OKX Report] Payload validation failed:', payload);
    return;
  }

  const allowed = await _canSendReport(payload.selector_name);
  if (!allowed) {
    console.log('[OKX Report] Rate-limited:', payload.selector_name);
    return;
  }

  const stored = await chrome.storage.local.get(['license_key', 'hotkey_selectors_version']);
  const { license_key, hotkey_selectors_version } = stored;

  if (!license_key) {
    console.warn('[OKX Report] No license key — skipping report');
    return;
  }

  const body = JSON.stringify({
    selector_name:     payload.selector_name,
    failure_type:      payload.failure_type || 'unknown',
    page_url:          payload.page_url,
    user_agent:        payload.user_agent,
    selectors_version: hotkey_selectors_version ?? null,
    timestamp:         new Date().toISOString(),
  });

  let res;
  try {
    res = await fetch(`${LICENSE_SERVER}/hotkey/report`, {
      method:  'POST',
      headers: {
        'X-License-Key': license_key,
        'Content-Type':  'application/json',
      },
      body,
    });
  } catch (err) {
    console.warn('[OKX Report] Network error:', err.message);
    return; // No retry on network failure
  }

  // Mark as sent regardless of server response so we don't hammer on errors
  await _markSent(payload.selector_name);

  if (res.status === 202) {
    console.log('[OKX Report] Accepted:', payload.selector_name);
  } else if (res.status === 401) {
    console.warn('[OKX Report] 401 invalid license — no retry');
  } else if (res.status === 429) {
    console.warn('[OKX Report] 429 server rate-limited — no retry');
  } else {
    console.warn('[OKX Report] Unexpected status:', res.status);
  }
}
