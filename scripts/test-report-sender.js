/**
 * test-report-sender.js — Unit tests for report-sender.js validation & rate-limit logic
 *
 * Run: node scripts/test-report-sender.js
 *
 * All Chrome APIs are stubbed inline. No browser or extension context needed.
 * Tests 6 scenarios from the spec.
 */

'use strict';

// ── Inline validation logic (mirrors report-sender.js) ───────────────────────

const _SELECTOR_NAME_RE = /^\w+$/;
const _OKX_TRADE_URL_RE = /^https:\/\/www\.okx\.com\/trade-/;

function _validatePayload(p) {
  if (!p || typeof p !== 'object') return false;
  if (typeof p.selector_name !== 'string' || !_SELECTOR_NAME_RE.test(p.selector_name)) return false;
  if (typeof p.page_url !== 'string' || !_OKX_TRADE_URL_RE.test(p.page_url)) return false;
  if (typeof p.user_agent !== 'string') return false;
  if (p.user_agent.length > 256) return false;
  for (let i = 0; i < p.user_agent.length; i++) {
    if (p.user_agent.charCodeAt(i) > 127) return false;
  }
  return true;
}

// ── Rate-limit stub ──────────────────────────────────────────────────────────

const DEBOUNCE_MS = 5 * 60 * 1000;
const _REPORT_STORAGE_PREFIX = 'report_sent_ts_';

function makeStorage(initialState = {}) {
  const store = { ...initialState };
  return {
    get: async (key) => ({ [key]: store[key] }),
    set: async (obj) => Object.assign(store, obj),
    _raw: store,
  };
}

async function _canSendReport(storage, selectorName) {
  const key = _REPORT_STORAGE_PREFIX + selectorName;
  const result = await storage.get(key);
  const lastTs = result[key] || 0;
  return Date.now() - lastTs >= DEBOUNCE_MS;
}

async function _markSent(storage, selectorName) {
  const key = _REPORT_STORAGE_PREFIX + selectorName;
  await storage.set({ [key]: Date.now() });
}

// ── Fetch stub ───────────────────────────────────────────────────────────────

function makeFetch(statusCode) {
  return async (_url, _opts) => ({ status: statusCode });
}

// ── Full sendReport simulation ────────────────────────────────────────────────

async function simulateSendReport({ payload, storage, fetchFn, licenseKey = 'LK-TEST-VALID' }) {
  if (!_validatePayload(payload)) return { sent: false, reason: 'validation_failed' };

  const allowed = await _canSendReport(storage, payload.selector_name);
  if (!allowed) return { sent: false, reason: 'rate_limited' };

  if (!licenseKey) return { sent: false, reason: 'no_license' };

  const res = await fetchFn('/hotkey/report', {});
  await _markSent(storage, payload.selector_name);

  if (res.status === 202) return { sent: true, reason: '202_accepted' };
  if (res.status === 401) return { sent: true, reason: '401_no_retry' };
  if (res.status === 429) return { sent: true, reason: '429_no_retry' };
  return { sent: true, reason: `unexpected_${res.status}` };
}

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

(async function runTests() {
  console.log('\n=== test-report-sender.js ===\n');

  // TC1: Valid payload → sent, fetch called, 202 accepted
  {
    const storage = makeStorage();
    const payload = {
      selector_name: 'submitBuy',
      failure_type:  'page_load_miss',
      page_url:      'https://www.okx.com/trade-swap/btc-usdt-swap',
      user_agent:    'Mozilla/5.0 (compatible)',
    };
    const result = await simulateSendReport({ payload, storage, fetchFn: makeFetch(202) });
    assert('TC1: valid payload → sent', result.sent === true, JSON.stringify(result));
    assert('TC1: reason is 202_accepted', result.reason === '202_accepted');
    // storage should now have a timestamp
    const ts = storage._raw[_REPORT_STORAGE_PREFIX + 'submitBuy'];
    assert('TC1: sent timestamp stored', typeof ts === 'number' && ts > 0);
  }

  // TC2: selector_name with invalid chars (script tag) → validation fails
  {
    const storage = makeStorage();
    const payload = {
      selector_name: '<script>alert(1)</script>',
      failure_type:  'page_load_miss',
      page_url:      'https://www.okx.com/trade-swap/btc-usdt-swap',
      user_agent:    'Mozilla/5.0',
    };
    const result = await simulateSendReport({ payload, storage, fetchFn: makeFetch(202) });
    assert('TC2: XSS selector_name → blocked', result.sent === false);
    assert('TC2: reason is validation_failed', result.reason === 'validation_failed');
  }

  // TC2b: selector_name with dash (not alphanumeric/underscore) → blocked
  {
    const storage = makeStorage();
    const payload = {
      selector_name: 'submit-buy',
      failure_type:  'page_load_miss',
      page_url:      'https://www.okx.com/trade-swap/btc-usdt-swap',
      user_agent:    'Mozilla/5.0',
    };
    const result = await simulateSendReport({ payload, storage, fetchFn: makeFetch(202) });
    assert('TC2b: dash in selector_name → blocked', result.sent === false);
    assert('TC2b: reason is validation_failed', result.reason === 'validation_failed');
  }

  // TC3: page_url is not www.okx.com/trade-* → blocked
  {
    const storage = makeStorage();
    const payload = {
      selector_name: 'availableBalance',
      failure_type:  'click_miss',
      page_url:      'https://evil.com/steal?q=1',
      user_agent:    'Mozilla/5.0',
    };
    const result = await simulateSendReport({ payload, storage, fetchFn: makeFetch(202) });
    assert('TC3: non-OKX URL → blocked', result.sent === false);
    assert('TC3: reason is validation_failed', result.reason === 'validation_failed');
  }

  // TC3b: okx.com but not trade- path → blocked
  {
    const storage = makeStorage();
    const payload = {
      selector_name: 'availableBalance',
      failure_type:  'click_miss',
      page_url:      'https://www.okx.com/markets',
      user_agent:    'Mozilla/5.0',
    };
    const result = await simulateSendReport({ payload, storage, fetchFn: makeFetch(202) });
    assert('TC3b: okx.com non-trade path → blocked', result.sent === false);
  }

  // TC4: same selector within 5 min → rate-limited
  {
    const storage = makeStorage({
      // Pre-populate a timestamp 1 minute ago (within debounce window)
      [_REPORT_STORAGE_PREFIX + 'submitSell']: Date.now() - 60 * 1000,
    });
    const payload = {
      selector_name: 'submitSell',
      failure_type:  'page_load_miss',
      page_url:      'https://www.okx.com/trade-swap/eth-usdt-swap',
      user_agent:    'Mozilla/5.0',
    };
    const result = await simulateSendReport({ payload, storage, fetchFn: makeFetch(202) });
    assert('TC4: same selector within 5min → rate-limited', result.sent === false);
    assert('TC4: reason is rate_limited', result.reason === 'rate_limited');
  }

  // TC4b: same selector after 5+ min → allowed
  {
    const storage = makeStorage({
      // Pre-populate a timestamp 6 minutes ago (outside debounce window)
      [_REPORT_STORAGE_PREFIX + 'orderForm']: Date.now() - 6 * 60 * 1000,
    });
    const payload = {
      selector_name: 'orderForm',
      failure_type:  'page_load_miss',
      page_url:      'https://www.okx.com/trade-spot/btc-usdt',
      user_agent:    'Mozilla/5.0',
    };
    const result = await simulateSendReport({ payload, storage, fetchFn: makeFetch(202) });
    assert('TC4b: same selector after 5+min → allowed', result.sent === true);
  }

  // TC5: 401 response → marked sent (no infinite retry)
  {
    const storage = makeStorage();
    const payload = {
      selector_name: 'submitBuy',
      failure_type:  'page_load_miss',
      page_url:      'https://www.okx.com/trade-swap/btc-usdt-swap',
      user_agent:    'Mozilla/5.0',
    };
    const result = await simulateSendReport({ payload, storage, fetchFn: makeFetch(401) });
    assert('TC5: 401 → no retry (reason 401_no_retry)', result.reason === '401_no_retry');
    // Must be marked sent so second call is rate-limited
    const ts = storage._raw[_REPORT_STORAGE_PREFIX + 'submitBuy'];
    assert('TC5: 401 → sent timestamp stored (prevents retry)', typeof ts === 'number' && ts > 0);
    // Immediate second call → rate-limited
    const result2 = await simulateSendReport({ payload, storage, fetchFn: makeFetch(401) });
    assert('TC5: second immediate call after 401 → rate-limited', result2.reason === 'rate_limited');
  }

  // TC6: 429 response → marked sent, no retry
  {
    const storage = makeStorage();
    const payload = {
      selector_name: 'availableBalance',
      failure_type:  'click_miss',
      page_url:      'https://www.okx.com/trade-swap/btc-usdt-swap',
      user_agent:    'Mozilla/5.0',
    };
    const result = await simulateSendReport({ payload, storage, fetchFn: makeFetch(429) });
    assert('TC6: 429 → no retry (reason 429_no_retry)', result.reason === '429_no_retry');
    const result2 = await simulateSendReport({ payload, storage, fetchFn: makeFetch(429) });
    assert('TC6: second call after 429 → rate-limited', result2.reason === 'rate_limited');
  }

  // TC7: user_agent > 256 chars → blocked
  {
    const storage = makeStorage();
    const payload = {
      selector_name: 'submitBuy',
      failure_type:  'page_load_miss',
      page_url:      'https://www.okx.com/trade-swap/btc-usdt-swap',
      user_agent:    'A'.repeat(257),
    };
    const result = await simulateSendReport({ payload, storage, fetchFn: makeFetch(202) });
    assert('TC7: user_agent > 256 chars → blocked', result.sent === false);
  }

  // TC8: user_agent with non-ASCII chars → blocked
  {
    const storage = makeStorage();
    const payload = {
      selector_name: 'submitBuy',
      failure_type:  'page_load_miss',
      page_url:      'https://www.okx.com/trade-swap/btc-usdt-swap',
      user_agent:    'Mozilla/5.0 (中文)',
    };
    const result = await simulateSendReport({ payload, storage, fetchFn: makeFetch(202) });
    assert('TC8: non-ASCII user_agent → blocked', result.sent === false);
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
