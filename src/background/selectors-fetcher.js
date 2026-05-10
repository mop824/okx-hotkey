/**
 * selectors-fetcher.js — Fetch OKX DOM selectors from license server
 *
 * fetchSelectors(): called on alarm + startup. Validates signature, size,
 *   and CSS-selector whitelist before persisting to chrome.storage.local.
 * getSelectors(): returns stored selectors or ENVIRONMENT_DEFAULT.
 */

'use strict';

// ── Inline constants (substituted at build time, same as service-worker.js) ──
// Must stay in sync with service-worker.js values.
const _SF_LICENSE_SERVER = 'https://YOUR_DOMAIN_HERE';

// ── ENVIRONMENT_DEFAULT ───────────────────────────────────────────────────────
// Exact copy of selectors.js static values; used as fallback when server is
// unreachable or validation fails.
const ENVIRONMENT_DEFAULT = {
  orderForm:            '.place-order-container-common',
  priceInputContainer:  '.price-input',
  inputField:           '.okui-input-input',
  orderTypeTab:         '.okui-tabs-pane-spacing[role="tab"]',
  submitBuy:            'button.okui-positivebutton',
  submitSell:           'button.okui-negativebutton',
  directionTab:         '.okui-tabs-pane-segmented[role="tab"]',
  availableBalance:     '[data-testid="max-asset"]',
  maxTrade:             '[data-testid="max-trade"]',
  sliderNode:           '.okui-slider-mark-node',
  sliderNodeText:       '.okui-slider-mark-node-text',
  lastPrice:            'span.last',
  orderBookContainer:   '.order-book-box',
  orderRow:             '.order-table-box .okui-table-row:not([aria-hidden="true"])',
  cancelAllButton:      'button.cancel-all',
  cancelButton:         'button.btn-fill-grey',
  chaseButton:          '[data-testid="chase-order"], button[class*="chase"], [aria-label*="Chase"]',
  positionRow:          '.position-box .okui-table-row:not([aria-hidden="true"])',
  positionLongClass:    '.positive-pl',
  positionShortClass:   '.negative-pl',
  tpslCheckbox:         '.place-order-stop-selector .okui-checkbox-input, [class*="stopSelector"] .okui-checkbox-input',
  tpPriceInput:         'input[aria-label="tpTriggerPx"], input[labelbasic="TP trigger price"]',
  slPriceInput:         'input[aria-label="slTriggerPx"], input[labelbasic="SL trigger price"]',
  tpslSubTab:           '[role="tab"][data-pane-id*="conditional"]',
  tpslOrderRow:         'tr.okui-table-row:not([aria-hidden="true"])',
};

// ── CSS selector value whitelist ──────────────────────────────────────────────
// Allowed characters: alphanumeric, space, and safe CSS punctuation.
// Rejects: script tags, javascript: protocol, CSS expression(), and
// anything outside the safe character set.
const _SELECTOR_SAFE_RE = /^[\w\s\-\[\]="'.*#:,()^$|+~>/@]+$/;
const _SELECTOR_DENY_RE = /<script|javascript:|expression\s*\(/i;

const _MAX_PAYLOAD_BYTES = 4096;

function _isValidSelectorValue(val) {
  if (typeof val !== 'string') return false;
  if (_SELECTOR_DENY_RE.test(val)) return false;
  if (!_SELECTOR_SAFE_RE.test(val)) return false;
  return true;
}

function _validatePayload(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  if (JSON.stringify(payload).length > _MAX_PAYLOAD_BYTES) return false;
  for (const val of Object.values(payload)) {
    if (!_isValidSelectorValue(val)) return false;
  }
  return true;
}

// ── _verifySignature reference ────────────────────────────────────────────────
// service-worker.js defines _verifySignature in the same module scope.
// Both files are loaded into the same service worker global — the function
// is available here without re-importing.

// ── fetchSelectors ────────────────────────────────────────────────────────────

async function fetchSelectors() {
  const stored = await chrome.storage.local.get([
    'license_key',
    'hotkey_selectors_etag',
    'hotkey_selectors_payload',
  ]);
  const { license_key, hotkey_selectors_etag } = stored;

  if (!license_key) {
    // No license yet — keep existing/default, nothing to do
    return;
  }

  const headers = { 'X-License-Key': license_key };
  if (hotkey_selectors_etag) headers['If-None-Match'] = hotkey_selectors_etag;

  let res;
  try {
    res = await fetch(`${_SF_LICENSE_SERVER}/hotkey/selectors`, { headers });
  } catch {
    // Network failure — leave existing storage intact (fallback handled by getSelectors)
    return;
  }

  // 304 — nothing changed
  if (res.status === 304) return;

  // 401 — license invalid, fall through to fallback
  if (res.status === 401) return;

  if (res.status !== 200) return;

  // Read body text for signature verification
  let rawText;
  try {
    rawText = await res.text();
  } catch {
    return;
  }

  // Size guard (raw bytes, conservative UTF-8 estimate using length)
  if (rawText.length > _MAX_PAYLOAD_BYTES) return;

  // Signature verification
  const sigB64 = res.headers.get('X-Signature');
  if (!sigB64) return; // Require signature — reject unsigned responses

  let parsed;
  try { parsed = JSON.parse(rawText); } catch { return; }

  // Canonical JSON for signature check (sorted keys, same as server)
  const canonical = JSON.stringify(parsed, Object.keys(parsed).sort());
  const sigOk = await _verifySignature(sigB64, canonical);
  if (!sigOk) return;

  // Payload must have a 'selectors' key containing the selector map
  const payload = parsed.selectors ?? parsed;
  if (!_validatePayload(payload)) return;

  const etag = res.headers.get('ETag') || '';
  await chrome.storage.local.set({
    hotkey_selectors_payload:    payload,
    hotkey_selectors_version:    parsed.version ?? null,
    hotkey_selectors_etag:       etag,
    hotkey_selectors_updated_at: Date.now(),
  });
}

// ── getSelectors ──────────────────────────────────────────────────────────────

async function getSelectors() {
  const result = await chrome.storage.local.get('hotkey_selectors_payload');
  return result.hotkey_selectors_payload || ENVIRONMENT_DEFAULT;
}
