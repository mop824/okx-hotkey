/**
 * selectors-monitor.js — Detects broken OKX DOM selectors and reports to server
 *
 * Signal 1: All OKX_SELECTORS keys (page-context filtered) missing 5s after load
 * Signal 2: Click handler couldn't find a target element (called by executor.js
 *           via window.OKXMonitor.reportClickMiss)
 *
 * Guards:
 *   - Page context: spot / swap / futures (URL-based)
 *   - Login guard: skips login_required selectors when not authenticated
 *   - Conditional guard: tpPriceInput/slPriceInput only when TPSL checked,
 *                        positionRow/positionLongClass/positionShortClass only
 *                        when position panel is visible,
 *                        orderRow/cancelAllButton/cancelButton/chaseButton/tpslOrderRow
 *                        only when open-orders table is visible
 *
 * Debounce: same selector_name → at most 1 report per 5 minutes
 * (chrome.storage.local key: "selector_fail_ts_<name>")
 */

;(function OKXSelectorsMonitor() {
  'use strict';

  const DEBOUNCE_MS        = 5 * 60 * 1000;
  const STORAGE_KEY_PREFIX = 'selector_fail_ts_';

  // ── Context guard ────────────────────────────────────────────────────────────
  function _monitorContextAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  // ── Page context ────────────────────────────────────────────────────────────

  function getPageType() {
    const p = window.location.pathname;
    if (p.includes('/trade-spot/'))           return 'spot';
    if (p.includes('/trade-swap/'))           return 'swap';
    if (p.includes('/trade-futures/'))        return 'futures';
    if (p.includes('/trade-margin/'))         return 'margin';
    if (/\/trade-option[s]?\//.test(p))       return 'options';
    return 'unknown';
  }

  // ── Login guard (priority-based, NOT a vote count) ─────────────────────────
  // Rule 1 (veto): login anchor present → not logged in.
  // Rule 2: real balance value → logged in (avatar class unstable, not required).
  // Rule 3: ambiguous → not logged in (safe default).

  function isLoggedIn() {
    if (document.querySelector('a[href*="/account/login"]')) return false;
    const balanceEl = document.querySelector('[data-testid="max-asset"]');
    if (!balanceEl) return false;
    const t = balanceEl.textContent.trim();
    return t !== '' && t !== '--' && !/^0*\.?0*$/.test(t);
  }

  // ── Conditional activation checks ──────────────────────────────────────────

  function isTpslActive() {
    const cb = document.querySelector(
      '.place-order-stop-selector .okui-checkbox-input, [class*="stopSelector"] .okui-checkbox-input'
    );
    return cb && cb.checked;
  }

  function isPositionPanelVisible() {
    return !!document.querySelector('.position-box');
  }

  function isOpenOrdersVisible() {
    return !!document.querySelector('.order-table-box');
  }

  // Selectors that are conditional on runtime UI state — cannot be probed at
  // page-load unless the condition is already met.
  const CONDITIONAL_GUARDS = {
    tpPriceInput:     isTpslActive,
    slPriceInput:     isTpslActive,
    positionRow:      isPositionPanelVisible,
    positionLongClass: isPositionPanelVisible,
    positionShortClass: isPositionPanelVisible,
    orderRow:         isOpenOrdersVisible,
    cancelAllButton:  isOpenOrdersVisible,
    cancelButton:     isOpenOrdersVisible,
    chaseButton:      isOpenOrdersVisible,
    tpslOrderRow:     isOpenOrdersVisible,
  };

  // Selectors that only apply to specific page types (non-exhaustive — keys not
  // listed here are checked on all pages). Values: array of page types.
  const PAGE_SCOPE = {
    priceInputContainer: ['swap'],
    directionTab:        ['spot'],
    positionRow:         ['swap'],
    positionLongClass:   ['swap'],
    positionShortClass:  ['swap'],
    // submitSell is spot-tab-toggled but still present in DOM on spot for some
    // states — omit from PAGE_SCOPE to let the presence check handle it.
  };

  // Selectors that require an authenticated session to be present in DOM.
  const LOGIN_REQUIRED = new Set([
    'availableBalance', 'maxTrade',
    'orderRow', 'cancelAllButton', 'cancelButton', 'chaseButton',
    'positionRow', 'positionLongClass', 'positionShortClass', 'tpslOrderRow',
  ]);

  // ── Debounce ────────────────────────────────────────────────────────────────

  async function canReport(selectorName) {
    if (!_monitorContextAlive()) return false;
    const key = STORAGE_KEY_PREFIX + selectorName;
    try {
      const result = await chrome.storage.local.get(key);
      return Date.now() - (result[key] || 0) >= DEBOUNCE_MS;
    } catch (_) { return false; } // extension context invalidated
  }

  async function markReported(selectorName) {
    if (!_monitorContextAlive()) return;
    try {
      await chrome.storage.local.set({ [STORAGE_KEY_PREFIX + selectorName]: Date.now() });
    } catch (_) { /* extension context invalidated */ }
  }

  // ── Report ──────────────────────────────────────────────────────────────────

  async function triggerReport(selectorName, failureType) {
    if (!await canReport(selectorName)) return;
    await markReported(selectorName);
    if (!_monitorContextAlive()) return;
    try {
      chrome.runtime.sendMessage({
        type: 'REPORT_SELECTOR_FAILURE',
        payload: {
          selector_name: selectorName,
          failure_type:  failureType,
          page_url:      window.location.href,
          user_agent:    navigator.userAgent,
        }
      }, () => { void chrome.runtime.lastError; });
    } catch (_) { /* extension context invalidated */ }
  }

  // ── Signal 1: page-load probe ───────────────────────────────────────────────

  function probeSelectors() {
    const S = window.OKX_SELECTORS;
    if (!S) return;

    // Abort if the trade-form container itself is missing — not a trade page
    const tradePageHint = document.querySelector('[class*="place-order"], [class*="trade-panel"]');
    if (!tradePageHint) return;

    const pageType = getPageType();
    const loggedIn = isLoggedIn();

    for (const [name, selector] of Object.entries(S)) {
      // page-scope filter: unknown page → only probe 'all'-scoped selectors
      const scope = PAGE_SCOPE[name];
      if (pageType === 'unknown' && scope) continue;   // has explicit scope → skip on unknown page
      if (scope && !scope.includes(pageType)) continue;

      // login guard
      if (LOGIN_REQUIRED.has(name) && !loggedIn) continue;

      // conditional guard — condition not met → skip (not a breakage)
      const guard = CONDITIONAL_GUARDS[name];
      if (guard && !guard()) continue;

      try {
        if (document.querySelectorAll(selector).length === 0) {
          triggerReport(name, 'page_load_miss');
        }
      } catch (_) {
        // invalid CSS — skip
      }
    }
  }

  // ── Signal 2: click handler miss (called by executor.js) ───────────────────

  window.OKXMonitor = {
    reportClickMiss: function(selectorName) {
      triggerReport(selectorName, 'click_miss');
    }
  };

  // ── Init ────────────────────────────────────────────────────────────────────

  setTimeout(probeSelectors, 5000);

})();
