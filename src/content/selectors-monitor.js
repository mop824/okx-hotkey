/**
 * selectors-monitor.js — Detects broken OKX DOM selectors and reports to server
 *
 * Signal 1: Critical selectors missing 5s after page load (trade form not found)
 * Signal 2: Click handler couldn't find a target element (injected by executor.js
 *           via reportSelectorFailure global)
 *
 * Debounce: same selector_name → at most 1 report per 5 minutes
 * (chrome.storage.local key: "selector_fail_ts_<name>")
 */

;(function OKXSelectorsMonitor() {
  'use strict';

  // Critical selectors to probe (name → selector key in window.OKX_SELECTORS)
  const CRITICAL_SELECTORS = ['orderForm', 'submitBuy', 'submitSell', 'availableBalance'];

  const DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes
  const STORAGE_KEY_PREFIX = 'selector_fail_ts_';

  // ── Debounce check ──────────────────────────────────────────────────────────

  async function canReport(selectorName) {
    const key = STORAGE_KEY_PREFIX + selectorName;
    const result = await chrome.storage.local.get(key);
    const lastTs = result[key] || 0;
    return Date.now() - lastTs >= DEBOUNCE_MS;
  }

  async function markReported(selectorName) {
    const key = STORAGE_KEY_PREFIX + selectorName;
    await chrome.storage.local.set({ [key]: Date.now() });
  }

  // ── Report trigger ──────────────────────────────────────────────────────────

  async function triggerReport(selectorName, failureType) {
    const allowed = await canReport(selectorName);
    if (!allowed) return;

    await markReported(selectorName);

    chrome.runtime.sendMessage({
      type: 'REPORT_SELECTOR_FAILURE',
      payload: {
        selector_name: selectorName,
        failure_type:  failureType,
        page_url:      window.location.href,
        user_agent:    navigator.userAgent,
      }
    }, () => {
      // Ignore response / lastError — fire-and-forget
      void chrome.runtime.lastError;
    });
  }

  // ── Signal 1: page-load probe ───────────────────────────────────────────────

  function probeSelectors() {
    const S = window.OKX_SELECTORS;
    if (!S) return; // selectors not loaded yet — skip

    // Only probe if a trade form context exists on the page at all.
    // Absence of orderForm itself is the primary signal.
    const tradePageHint = document.querySelector('[class*="place-order"], [class*="trade-panel"]');
    if (!tradePageHint) return; // not a trade page — don't fire false positives

    for (const name of CRITICAL_SELECTORS) {
      const selector = S[name];
      if (!selector) continue;
      // Use querySelectorAll to tolerate comma-separated selectors
      try {
        const found = document.querySelectorAll(selector).length > 0;
        if (!found) {
          triggerReport(name, 'page_load_miss');
        }
      } catch (_) {
        // Invalid selector string — don't report (not a server-side breakage)
      }
    }
  }

  // ── Signal 2: click handler miss (called by executor.js) ───────────────────

  // Exposed as a global so executor.js can call it without a circular import.
  window.OKXMonitor = {
    reportClickMiss: function(selectorName) {
      triggerReport(selectorName, 'click_miss');
    }
  };

  // ── Init ────────────────────────────────────────────────────────────────────

  // Wait 5s after document_idle for React/SPA to finish rendering
  setTimeout(probeSelectors, 5000);

})();
