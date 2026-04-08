/**
 * selectors.js — Centralized OKX DOM selector config
 *
 * Selectors verified via headless Chrome scraping of live OKX pages.
 * OKX uses the okui-* design system. Key stability notes:
 *   - okui-* class names are stable (design system, not build artifacts)
 *   - data-testid attributes are stable
 *   - Hash-suffixed IDs like #_r_4o_ are NOT stable — never use them
 *   - Hash-suffixed classes like index_availableRow__H1d0q are NOT stable — use data-testid
 *   - Price input identified by .price-input container class; amount by exclusion
 *
 * Update this file when OKX changes their DOM — no other files need changing.
 */

// Expose as global since content scripts can't use ES module imports
window.OKX_SELECTORS = {
  // ── FORM CONTAINER ──────────────────────────────────────────────────────────
  // Verified: .place-order-container-common wraps the entire trading panel
  orderForm: '.place-order-container-common',

  // ── INPUT IDENTIFICATION ────────────────────────────────────────────────────
  // Price input: ancestor has .price-input class on form-item
  // Amount input: the other .okui-input-input in the form (not inside .price-input)
  priceInputContainer: '.price-input',
  inputField: '.okui-input-input',

  // ── ORDER TYPE TABS (Limit / Market / TP-SL) ────────────────────────────────
  // Verified: .okui-tabs-pane-spacing with role="tab", text "Limit"/"Market"/"TP/SL"
  orderTypeTab: '.okui-tabs-pane-spacing[role="tab"]',

  // ── SUBMIT BUTTONS ──────────────────────────────────────────────────────────
  // Verified: In one-way mode, Buy/Sell ARE the submit buttons (no separate direction tabs)
  // Buy (Long): button.okui-positivebutton
  // Sell (Short): button.okui-negativebutton
  submitBuy: 'button.okui-positivebutton',
  submitSell: 'button.okui-negativebutton',

  // ── DIRECTION TABS (hedge mode only) ────────────────────────────────────────
  // In one-way mode these don't exist. In hedge mode: Open/Close segmented tabs (unverified)
  directionTab: '.okui-tabs-pane-segmented[role="tab"]',

  // ── BALANCE ─────────────────────────────────────────────────────────────────
  // Verified: data-testid stable. Text: "Available6,996.26 USDT"
  availableBalance: '[data-testid="max-asset"]',
  maxTrade: '[data-testid="max-trade"]',

  // ── PERCENTAGE SLIDER ───────────────────────────────────────────────────────
  // Verified: 5 nodes (0%/25%/50%/75%/100%)
  sliderNode: '.okui-slider-mark-node',
  sliderNodeText: '.okui-slider-mark-node-text',

  // ── LAST PRICE ──────────────────────────────────────────────────────────────
  // Verified: span.last shows last traded price (e.g. "71,704.6")
  lastPrice: 'span.last',

  // ── ORDER BOOK ──────────────────────────────────────────────────────────────
  // Order book is CANVAS-rendered — individual bid/ask rows NOT in DOM.
  // Best bid/ask cannot be read from DOM. Use lastPrice as proxy.
  // Tick size shown in ladder: div with class containing "ladderSelectWrap"
  orderBookContainer: '.order-book-box',

  // ── OPEN ORDERS TABLE ───────────────────────────────────────────────────────
  // Verified: standard table inside .order-table-box
  // Data rows: tr.okui-table-row (skip tr[aria-hidden="true"] measure rows)
  orderRow: '.order-table-box .okui-table-row:not([aria-hidden="true"])',

  // ── CANCEL BUTTONS ──────────────────────────────────────────────────────────
  // Verified: "Cancel all" = button.cancel-all, per-row "Cancel" = button.btn-fill-grey
  cancelAllButton: 'button.cancel-all',
  cancelButton: 'button.btn-fill-grey',

  // ── CHASE BUTTON ─────────────────────────────────────────────────────────────
  // Chase button on unfilled limit orders — needs logged-in session to verify.
  // actions.js uses this; fallback to text-content search if not found.
  chaseButton: '[data-testid="chase-order"], button[class*="chase"], [aria-label*="Chase"]',

  // ── POSITION (futures) ──────────────────────────────────────────────────────
  // Verified from live scrape: position table is in .position-box (NOT .order-table-box).
  // .order-table-box is for open orders only. No aria-hidden filter needed here.
  positionRow: '.position-box .okui-table-row',
};
