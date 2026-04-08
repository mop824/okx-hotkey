/**
 * executor.js — Execute DOM actions on OKX trading UI
 *
 * OKX uses React, so plain .value = '...' assignments won't trigger re-renders.
 * We must use the native input value setter + dispatch synthetic events.
 *
 * Tab and button selection strategy:
 *   - Order type tabs: .okui-tabs-pane-spacing[role="tab"], text "Limit"/"Market"/"TP/SL"
 *   - Submit buttons: button.okui-positivebutton (buy) / button.okui-negativebutton (sell)
 *   - Direction (hedge mode only): .okui-tabs-pane-segmented[role="tab"], text "Open"/"Close"
 *   - One-way mode: no direction tabs — direction chosen by which submit button is clicked
 */

window.OKXExecutor = (() => {
  const S = window.OKX_SELECTORS;

  // ── React-compatible input setter ─────────────────────────────────────────

  /**
   * Set an input's value in a way React will detect.
   * OKX uses React controlled inputs; plain assignment is ignored by React's reconciler.
   * Using the native HTMLInputElement setter bypasses React's value tracking,
   * then the dispatched "input" event causes React to pick up the new value.
   * @param {HTMLInputElement} input
   * @param {string|number} value
   */
  function setInputValue(input, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * Small async delay helper.
   * @param {number} ms
   */
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Click a DOM element, logging a warning if not found.
   * @param {string|Element} selectorOrEl
   * @returns {boolean} true if clicked
   */
  function clickEl(selectorOrEl) {
    const el = typeof selectorOrEl === 'string'
      ? document.querySelector(selectorOrEl)
      : selectorOrEl;
    if (!el) {
      console.warn('[OKX Hotkey] clickEl: element not found', selectorOrEl);
      return false;
    }
    el.click();
    return true;
  }

  // ── Text-content tab clicker ──────────────────────────────────────────────

  /**
   * Find and click a tab element matching the given CSS class and text content.
   *
   * Verified strategy: OKX tabs use role="tab" and stable okui-* class names.
   * Text content is the most reliable identifier since OKX does not provide
   * data-testid on individual tab items.
   *
   * @param {string} tabClass — CSS selector for the tab group (e.g. S.orderTypeTab)
   * @param {string} text — Tab text to match (case-insensitive)
   * @returns {Promise<boolean>}
   */
  async function clickTabByText(tabClass, text) {
    const tabs = document.querySelectorAll(tabClass);
    for (const tab of tabs) {
      if (tab.textContent.trim().toLowerCase() === text.toLowerCase()) {
        // Skip clicking if already active
        if (tab.getAttribute('aria-selected') === 'true') {
          return true;
        }
        tab.click();
        await delay(80);
        return true;
      }
    }
    console.warn('[OKX Hotkey] clickTabByText: no tab matched', { tabClass, text });
    return false;
  }

  // ── Order type selection ──────────────────────────────────────────────────

  /**
   * Switch to Market order type.
   * Verified tab class: .okui-tabs-pane-spacing[role="tab"], text "Market".
   */
  async function selectMarketOrder() {
    const ok = await clickTabByText(S.orderTypeTab, 'Market');
    if (!ok) throw new Error('[OKX Hotkey] selectMarketOrder: Market tab not found');
    await delay(80);
  }

  /**
   * Switch to Limit order type.
   * Verified tab class: .okui-tabs-pane-spacing[role="tab"], text "Limit".
   */
  async function selectLimitOrder() {
    const ok = await clickTabByText(S.orderTypeTab, 'Limit');
    if (!ok) throw new Error('[OKX Hotkey] selectLimitOrder: Limit tab not found');
    await delay(80);
  }

  // ── Direction / side selection ────────────────────────────────────────────

  /**
   * Select the correct direction tab based on action and mode.
   *
   * One-way mode: no direction tabs exist. The Buy/Sell submit buttons handle
   * direction. This function is a no-op for one-way mode.
   *
   * Hedge mode: segmented Open/Close tabs exist. Click the appropriate one.
   * Long/short sub-direction inside each mode is determined by submitBuy/submitSell.
   *
   * @param {'buy'|'sell'|'open_long'|'open_short'|'close_long'|'close_short'} direction
   * @param {'one-way'|'hedge'|'n/a'} tradingMode
   */
  async function selectDirection(direction, tradingMode) {
    if (tradingMode === 'hedge') {
      // Hedge mode: click Open/Close segmented tabs (if they exist)
      const tabText = direction.startsWith('open') ? 'Open' : 'Close';
      const tabs = document.querySelectorAll(S.directionTab);
      let found = false;
      for (const tab of tabs) {
        if (tab.textContent.trim().toLowerCase() === tabText.toLowerCase()) {
          tab.click();
          await delay(80);
          found = true;
          break;
        }
      }
      if (!found) {
        console.warn('[OKX Hotkey] selectDirection: hedge tab not found, skipping');
      }
    }
    // One-way mode: no direction tabs — direction is chosen by which submit button is clicked
    // Do nothing here; submitBuy/submitSell handle direction.
    await delay(50);
  }

  // ── Input helpers ─────────────────────────────────────────────────────────

  /**
   * Get the order form element.
   * @returns {Element|null}
   */
  function getOrderForm() {
    return document.querySelector(S.orderForm);
  }

  /**
   * Find the price input inside the order form.
   * Verified: price input lives inside a container with class .price-input.
   * @param {Element} formEl
   * @returns {HTMLInputElement|null}
   */
  function findPriceInput(formEl) {
    const container = formEl.querySelector(S.priceInputContainer);
    return container ? container.querySelector(S.inputField) : null;
  }

  /**
   * Find the amount/size input inside the order form.
   * Verified: all .okui-input-input fields except the one inside .price-input.
   * @param {Element} formEl
   * @returns {HTMLInputElement|null}
   */
  function findAmountInput(formEl) {
    const priceInput = findPriceInput(formEl);
    const inputs = formEl.querySelectorAll(S.inputField);
    for (const input of inputs) {
      if (input !== priceInput) return input;
    }
    return null;
  }

  // ── Fill inputs ──────────────────────────────────────────────────────────

  /**
   * Fill in the price input field (limit orders).
   * Verified: price input is inside .price-input container within the order form.
   * @param {number} price
   */
  async function fillPrice(price) {
    const form = getOrderForm();
    if (!form) throw new Error('[OKX Hotkey] fillPrice: order form not found');
    const input = findPriceInput(form);
    if (!input) throw new Error('[OKX Hotkey] fillPrice: price input not found');
    input.focus();
    setInputValue(input, price);
    await delay(50);
  }

  /**
   * Fill in the amount/size input field.
   * Verified: amount input is the .okui-input-input not inside .price-input.
   * @param {number} amount
   */
  async function fillAmount(amount) {
    const form = getOrderForm();
    if (!form) throw new Error('[OKX Hotkey] fillAmount: order form not found');
    const input = findAmountInput(form);
    if (!input) throw new Error('[OKX Hotkey] fillAmount: amount input not found');
    input.focus();
    setInputValue(input, amount);
    await delay(50);
  }

  // ── Percentage slider ──────────────────────────────────────────────────────

  /**
   * Click a percentage slider node by its text value.
   *
   * Verified DOM: slider nodes are .okui-slider-mark-node with a child
   * .okui-slider-mark-node-text containing a <span> with text like "25%".
   *
   * @param {number} percent — 0, 25, 50, 75, or 100
   * @returns {Promise<boolean>}
   */
  async function clickSliderPercent(percent) {
    const nodes = document.querySelectorAll(S.sliderNode);
    const target = String(percent) + '%';
    for (const node of nodes) {
      const textEl = node.querySelector(S.sliderNodeText);
      if (textEl && textEl.textContent.trim() === target) {
        node.click();
        await delay(80);
        return true;
      }
    }
    console.warn('[OKX Hotkey] clickSliderPercent: no node found for', target);
    return false;
  }

  // ── Submit buttons ────────────────────────────────────────────────────────

  /**
   * Click the Buy submit button.
   * Verified: button.okui-positivebutton inside the order form.
   * In one-way mode this IS the direction selector — no separate direction tab needed.
   */
  async function submitBuy() {
    const form = getOrderForm();
    if (!form) throw new Error('[OKX Hotkey] submitBuy: order form not found');
    const btn = form.querySelector(S.submitBuy);
    if (!btn) throw new Error('[OKX Hotkey] submitBuy: buy button not found');
    btn.click();
    await delay(100);
  }

  /**
   * Click the Sell submit button.
   * Verified: button.okui-negativebutton inside the order form.
   * In one-way mode this IS the direction selector — no separate direction tab needed.
   */
  async function submitSell() {
    const form = getOrderForm();
    if (!form) throw new Error('[OKX Hotkey] submitSell: order form not found');
    const btn = form.querySelector(S.submitSell);
    if (!btn) throw new Error('[OKX Hotkey] submitSell: sell button not found');
    btn.click();
    await delay(100);
  }

  // ── Order management ──────────────────────────────────────────────────────

  /**
   * Cancel a specific order row by clicking its cancel button.
   * Verified: per-row cancel button has class .btn-fill-grey.
   * Falls back to text-content search within the row.
   * @param {Element} orderRowEl
   */
  async function cancelOrderRow(orderRowEl) {
    let cancelBtn = orderRowEl.querySelector(S.cancelButton);
    if (!cancelBtn) {
      const buttons = orderRowEl.querySelectorAll('button');
      for (const btn of buttons) {
        if (/cancel|취소/i.test(btn.textContent.trim())) {
          cancelBtn = btn;
          break;
        }
      }
    }
    if (!cancelBtn) throw new Error('[OKX Hotkey] cancelOrderRow: cancel button not found');
    cancelBtn.click();
    await delay(100);
  }

  /**
   * Click the "Cancel All" button.
   * Verified: button.cancel-all class.
   * Falls back to text-content search if class selector misses.
   */
  async function cancelAllOrders() {
    const btn = document.querySelector(S.cancelAllButton);
    if (!btn) {
      // Text-content fallback
      const buttons = document.querySelectorAll('button');
      for (const b of buttons) {
        const text = b.textContent.trim().toLowerCase();
        if (text.includes('cancel all') || text.includes('전체 취소')) {
          b.click();
          await delay(100);
          return;
        }
      }
      throw new Error('[OKX Hotkey] cancelAllOrders: Cancel All button not found');
    }
    btn.click();
    await delay(100);
  }

  /**
   * Click a bottom panel tab by text content (e.g. "Open orders", "Open positions").
   * Bottom tabs are .okui-tabs-pane-underline[role="tab"] in the lower panel area.
   * Uses partial text matching (case-insensitive).
   * @param {string} tabText — partial text to match (e.g. "open orders")
   * @returns {Promise<boolean>}
   */
  async function ensureBottomTab(tabText) {
    const tabs = document.querySelectorAll('.okui-tabs-pane-underline[role="tab"]');
    const target = tabText.toLowerCase();
    for (const tab of tabs) {
      if (tab.textContent.trim().toLowerCase().includes(target)) {
        tab.click();
        await delay(200);
        return true;
      }
    }
    console.warn('[OKX Hotkey] ensureBottomTab: tab not found for', tabText);
    return false;
  }

  return {
    setInputValue,
    delay,
    clickEl,
    clickTabByText,
    findPriceInput,
    findAmountInput,
    getOrderForm,
    selectMarketOrder,
    selectLimitOrder,
    selectDirection,
    fillPrice,
    fillAmount,
    clickSliderPercent,
    submitBuy,
    submitSell,
    cancelOrderRow,
    cancelAllOrders,
    ensureBottomTab,
  };
})();
