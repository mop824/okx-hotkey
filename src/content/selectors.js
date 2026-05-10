/**
 * selectors.js — OKX DOM selector config (dynamic + fallback)
 *
 * On startup: requests selectors from background via GET_SELECTORS message.
 * Background reads chrome.storage.local (populated by selectors-fetcher.js).
 * Falls back to ENVIRONMENT_DEFAULT if background does not respond or
 * storage is empty.
 *
 * Static values below (ENVIRONMENT_DEFAULT) are the canonical fallback.
 * They match selectors-fetcher.js ENVIRONMENT_DEFAULT exactly.
 */

// ── ENVIRONMENT_DEFAULT ───────────────────────────────────────────────────────
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

// Initialise with defaults immediately so other content scripts can use
// window.OKX_SELECTORS synchronously before the async response arrives.
window.OKX_SELECTORS = Object.assign({}, ENVIRONMENT_DEFAULT);

// ── Dynamic load ──────────────────────────────────────────────────────────────
// Request stored selectors from background (populated by selectors-fetcher.js).
// Update window.OKX_SELECTORS in-place so all existing references see the update.
chrome.runtime.sendMessage({ type: 'GET_SELECTORS' }, (response) => {
  if (chrome.runtime.lastError) return; // background not ready — keep defaults
  if (response && response.selectors && typeof response.selectors === 'object') {
    Object.assign(window.OKX_SELECTORS, response.selectors);
  }
});
