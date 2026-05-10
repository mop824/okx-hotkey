/**
 * test-selectors-fetcher.js — Unit test simulation for selectors-fetcher.js
 *
 * Run: node scripts/test-selectors-fetcher.js
 *
 * Simulates the validation logic inline (no Chrome APIs needed).
 * Tests all 6 scenarios + ENVIRONMENT_DEFAULT fallback.
 */

'use strict';

// ── Inline validation logic (mirrors selectors-fetcher.js) ───────────────────

const _MAX_PAYLOAD_BYTES = 4096;
const _SELECTOR_SAFE_RE = /^[\w\s\-\[\]="'.*#:,()^$|+~>/@]+$/;
const _SELECTOR_DENY_RE = /<script|javascript:|expression\s*\(/i;

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

// Simulate signature verification: returns true if sigB64 === "VALID_SIG",
// false otherwise (avoids need for real ECDSA key in unit tests).
async function _verifySignature(sigB64, _canonical) {
  return sigB64 === 'VALID_SIG';
}

// Simulate the full fetchSelectors() decision tree.
// Returns { stored: <payload or null>, reason: <string> }.
async function simulateFetch({ status, body, sig, etag, licenseKey = 'KEY123' }) {
  if (!licenseKey) return { stored: null, reason: 'no_license' };

  if (status === 304) return { stored: 'UNCHANGED', reason: '304_not_modified' };
  if (status === 401) return { stored: null, reason: '401_license_invalid_fallback' };
  if (status !== 200) return { stored: null, reason: `unexpected_status_${status}` };

  if (!body) return { stored: null, reason: 'empty_body' };

  const rawText = typeof body === 'string' ? body : JSON.stringify(body);
  if (rawText.length > _MAX_PAYLOAD_BYTES) return { stored: null, reason: 'payload_too_large' };

  if (!sig) return { stored: null, reason: 'missing_signature' };

  let parsed;
  try { parsed = JSON.parse(rawText); } catch { return { stored: null, reason: 'invalid_json' }; }

  const canonical = JSON.stringify(parsed, Object.keys(parsed).sort());
  const sigOk = await _verifySignature(sig, canonical);
  if (!sigOk) return { stored: null, reason: 'signature_invalid_fallback' };

  const payload = parsed.selectors ?? parsed;
  if (!_validatePayload(payload)) return { stored: null, reason: 'payload_validation_failed' };

  return { stored: payload, reason: 'ok' };
}

// ── ENVIRONMENT_DEFAULT (mirrors selectors-fetcher.js) ───────────────────────
const ENVIRONMENT_DEFAULT = {
  orderForm: '.place-order-container-common',
  submitBuy: 'button.okui-positivebutton',
};

async function getSelectors(storedPayload) {
  return storedPayload || ENVIRONMENT_DEFAULT;
}

// ── Test runner ───────────────────────────────────────────────────────────────

const VALID_SELECTORS = { selectors: { orderForm: '.place-order-container-common', submitBuy: 'button.okui-positivebutton' } };
let passed = 0;
let failed = 0;

async function runTests() {
  const tests = [
    // ── Test 1: 200 with valid signature → stored ────────────────────────────
    {
      label: '1. 정상 응답 → storage 저장됨',
      run: async () => {
        const r = await simulateFetch({ status: 200, body: VALID_SELECTORS, sig: 'VALID_SIG' });
        return r.stored !== null && r.reason === 'ok';
      }
    },

    // ── Test 2: 200 with invalid signature → reject + fallback ───────────────
    {
      label: '2. 서명 검증 실패 → 거부 + 폴백',
      run: async () => {
        const r = await simulateFetch({ status: 200, body: VALID_SELECTORS, sig: 'BAD_SIG' });
        const sel = await getSelectors(r.stored);
        return r.stored === null && r.reason === 'signature_invalid_fallback'
          && sel === ENVIRONMENT_DEFAULT;
      }
    },

    // ── Test 3: 4KB+ payload → reject + fallback ─────────────────────────────
    {
      label: '3. 4KB 초과 응답 → 거부 + 폴백',
      run: async () => {
        const bigBody = 'x'.repeat(4097);
        const r = await simulateFetch({ status: 200, body: bigBody, sig: 'VALID_SIG' });
        const sel = await getSelectors(r.stored);
        return r.stored === null && r.reason === 'payload_too_large'
          && sel === ENVIRONMENT_DEFAULT;
      }
    },

    // ── Test 4: selector with <script> tag → reject + fallback ───────────────
    {
      label: '4. 잘못된 셀렉터 (<script> 태그) → 거부 + 폴백',
      run: async () => {
        const malicious = { selectors: { orderForm: '<script>alert(1)</script>' } };
        const r = await simulateFetch({ status: 200, body: malicious, sig: 'VALID_SIG' });
        const sel = await getSelectors(r.stored);
        return r.stored === null && r.reason === 'payload_validation_failed'
          && sel === ENVIRONMENT_DEFAULT;
      }
    },

    // ── Test 5: 401 → fallback ────────────────────────────────────────────────
    {
      label: '5. 401 → 폴백',
      run: async () => {
        const r = await simulateFetch({ status: 401, body: null, sig: null });
        const sel = await getSelectors(r.stored);
        return r.stored === null && r.reason === '401_license_invalid_fallback'
          && sel === ENVIRONMENT_DEFAULT;
      }
    },

    // ── Test 6: 304 → existing value unchanged ────────────────────────────────
    {
      label: '6. 304 → 기존 값 유지',
      run: async () => {
        const r = await simulateFetch({ status: 304, body: null, sig: null });
        // 304 means "do nothing" — stored value stays as-is
        return r.stored === 'UNCHANGED' && r.reason === '304_not_modified';
      }
    },

    // ── Test 7: server unreachable → ENVIRONMENT_DEFAULT ─────────────────────
    {
      label: '7. 서버 미응답 (network error) → ENVIRONMENT_DEFAULT 폴백',
      run: async () => {
        // Simulate network error: no storage entry, getSelectors returns default
        const sel = await getSelectors(null);
        return sel === ENVIRONMENT_DEFAULT
          && sel.orderForm === '.place-order-container-common';
      }
    },

    // ── Test 8: javascript: in selector value → reject ────────────────────────
    {
      label: '8. javascript: 주입 셀렉터 → 거부',
      run: async () => {
        const malicious = { selectors: { orderForm: 'javascript:alert(1)' } };
        const r = await simulateFetch({ status: 200, body: malicious, sig: 'VALID_SIG' });
        return r.stored === null && r.reason === 'payload_validation_failed';
      }
    },

    // ── Test 9: expression() CSS injection → reject ───────────────────────────
    {
      label: '9. expression() CSS 주입 → 거부',
      run: async () => {
        const malicious = { selectors: { orderForm: 'div[style="width:expression(alert(1))"]' } };
        const r = await simulateFetch({ status: 200, body: malicious, sig: 'VALID_SIG' });
        return r.stored === null && r.reason === 'payload_validation_failed';
      }
    },
  ];

  for (const test of tests) {
    try {
      const ok = await test.run();
      if (ok) {
        console.log(`  ✅ ${test.label}`);
        passed++;
      } else {
        console.log(`  ❌ ${test.label}`);
        failed++;
      }
    } catch (err) {
      console.log(`  ❌ ${test.label} — threw: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n결과: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

runTests();
