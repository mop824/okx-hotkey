/**
 * reader.js — Read live trading data from OKX DOM
 *
 * Reads:
 *   - Available balance (USDT or asset)
 *   - Current position size + direction (futures)
 *   - Last price (order book is canvas-rendered; no DOM bid/ask rows)
 *   - Tick size derived from last price decimal places
 *   - Open orders list
 *   - Current price/amount input values
 */

window.OKXReader = (() => {
  const S = window.OKX_SELECTORS;

  /**
   * Parse a numeric string from DOM text, stripping commas and non-numeric chars.
   * Returns NaN if the element is missing or unparseable.
   * @param {string} selector
   * @returns {number}
   */
  function parseNumericEl(selector) {
    const el = document.querySelector(selector);
    if (!el) return NaN;
    const text = el.textContent.trim().replace(/,/g, '').replace(/[^\d.-]/g, '');
    return parseFloat(text);
  }

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

  /**
   * Read available balance from [data-testid="max-asset"].
   *
   * Verified DOM text format: "Available6,996.26 USDT"
   * We strip everything non-numeric (except decimal/negative) to parse the number.
   *
   * @returns {number} Available balance, NaN on failure
   */
  function readAvailableBalance() {
    const el = document.querySelector(S.availableBalance);
    if (!el) {
      console.warn('[OKX Hotkey] readAvailableBalance: [data-testid="max-asset"] not found');
      return NaN;
    }
    const text = el.textContent.trim().replace(/,/g, '').replace(/[^\d.-]/g, '');
    const value = parseFloat(text);
    if (isNaN(value)) {
      console.warn('[OKX Hotkey] readAvailableBalance: could not parse number from', el.textContent);
    }
    return value;
  }

  /**
   * Read max trade amount from [data-testid="max-trade"].
   *
   * Spot DOM text: "Max buy -- BTC"
   * Futures DOM text: "Max long -- Contracts" / "Max short -- Contracts"
   * Returns the numeric value parsed from the text.
   *
   * @returns {number} Max trade amount, NaN on failure
   */
  function readMaxTrade() {
    const el = document.querySelector(S.maxTrade);
    if (!el) {
      console.warn('[OKX Hotkey] readMaxTrade: [data-testid="max-trade"] not found');
      return NaN;
    }
    const text = el.textContent.trim().replace(/,/g, '').replace(/[^\d.-]/g, '');
    return parseFloat(text);
  }

  /**
   * Read last traded price from span.last.
   * Verified: span.last contains the last trade price (e.g. "71,704.6").
   * @returns {number} Last price, NaN on failure
   */
  function readLastPrice() {
    const el = document.querySelector(S.lastPrice);
    if (!el) return NaN;
    const text = el.textContent.trim().replace(/,/g, '');
    return parseFloat(text);
  }

  /**
   * Read best bid price.
   * Order book is canvas-rendered; individual bid rows are NOT in the DOM.
   * Uses last price as proxy.
   * @returns {number}
   */
  function readBestBid() {
    // Order book is canvas-rendered; use last price as best bid proxy
    return readLastPrice();
  }

  /**
   * Read best ask price.
   * Order book is canvas-rendered; individual ask rows are NOT in the DOM.
   * Uses last price as proxy.
   * @returns {number}
   */
  function readBestAsk() {
    // Order book is canvas-rendered; use last price as best ask proxy
    return readLastPrice();
  }

  /**
   * Derive tick size from the decimal precision of the last price.
   * Example: "71,704.6" → 1 decimal → tick size = 0.1
   * @returns {number} Tick size (e.g. 0.1), falls back to 0.1 if unreadable
   */
  function readTickSize() {
    const el = document.querySelector(S.lastPrice);
    if (!el) return 0.1; // safe fallback
    const text = el.textContent.trim();
    const dotIdx = text.indexOf('.');
    if (dotIdx !== -1) {
      const decimals = text.replace(/,/g, '').length - text.replace(/,/g, '').indexOf('.') - 1;
      return Math.pow(10, -decimals);
    }
    return 1; // no decimals = integer prices
  }

  /**
   * Read all open order rows from the orders table.
   * Verified: .order-table-box .okui-table-row:not([aria-hidden="true"])
   * @returns {Element[]} Array of order row DOM elements
   */
  function readOrderRows() {
    return Array.from(document.querySelectorAll(S.orderRow));
  }

  /**
   * Read current price input value (for limit orders).
   * Verified: price input is inside .price-input container.
   * @returns {number}
   */
  function readPriceInput() {
    const form = getOrderForm();
    if (!form) return NaN;
    const input = findPriceInput(form);
    if (!input) return NaN;
    return parseFloat(input.value.replace(/,/g, ''));
  }

  /**
   * Read current amount/size input value.
   * Verified: amount input is the .okui-input-input not inside .price-input.
   * @returns {number}
   */
  function readAmountInput() {
    const form = getOrderForm();
    if (!form) return NaN;
    const input = findAmountInput(form);
    if (!input) return NaN;
    return parseFloat(input.value.replace(/,/g, ''));
  }

  /**
   * Read the current leverage setting from the order form.
   * The leverage button shows text like "10x" or "20x".
   * @returns {number} Leverage multiplier (defaults to 1 if not found)
   */
  function readLeverage() {
    const S = window.OKX_SELECTORS;
    const form = document.querySelector(S.orderForm);
    if (!form) return 1;
    const buttons = form.querySelectorAll('button');
    for (const btn of buttons) {
      const text = btn.textContent.trim();
      const match = text.match(/^(\d+)[xX]$/);
      if (match) return parseInt(match[1], 10);
    }
    return 1;
  }

  return {
    findPriceInput,
    findAmountInput,
    getOrderForm,
    readAvailableBalance,
    readMaxTrade,
    readLastPrice,
    readBestBid,
    readBestAsk,
    readTickSize,
    readOrderRows,
    readPriceInput,
    readAmountInput,
    readLeverage,
  };
})();
