/**
 * actions.js — 12 trading action implementations
 *
 * Each action receives a context object:
 * {
 *   pageType:    'spot' | 'futures'
 *   tradingMode: 'one-way' | 'hedge' | 'n/a'
 *   percentage:  number (0–100)
 *   seedCap:     number (0 = use full balance, >0 = cap balance at this USD value)
 *   overlay:     OKXOverlay instance
 * }
 *
 * Actions use Reader for data and Executor for DOM manipulation.
 */

window.OKXActions = (() => {
  const R = window.OKXReader;
  const E = window.OKXExecutor;

  // ── Utility ───────────────────────────────────────────────────────────────

  /**
   * Calculate trade amount from available balance and percentage.
   * If seedCap > 0, caps the base balance at seedCap (in USD equivalent).
   *
   * @param {number} balance — raw available balance
   * @param {number} percentage
   * @param {number} [decimals=6] — rounding precision
   * @param {number} [seedCap=0] — max balance cap; 0 = use full balance
   * @returns {number}
   */
  function calcAmount(balance, percentage, decimals = 6, seedCap = 0) {
    const effectiveBalance = (seedCap > 0) ? Math.min(balance, seedCap) : balance;
    const raw = effectiveBalance * (percentage / 100);
    const factor = Math.pow(10, decimals);
    return Math.floor(raw * factor) / factor;
  }

  /**
   * Validate context has required page type.
   * @param {object} ctx
   * @param {'spot'|'futures'|'any'} required
   */
  function requirePage(ctx, required) {
    if (required !== 'any' && ctx.pageType !== required) {
      throw new Error(`This action requires ${required} page (current: ${ctx.pageType})`);
    }
    if (ctx.pageType === 'unknown') {
      throw new Error('OKX trading page not detected');
    }
  }

  // ── Action: MARKET_BUY ────────────────────────────────────────────────────
  /**
   * Market buy X% of available balance.
   */
  async function marketBuy(ctx) {
    requirePage(ctx, 'any');
    const balance = R.readAvailableBalance();
    if (isNaN(balance) || balance <= 0) throw new Error('Available balance not readable');

    const amount = calcAmount(balance, ctx.percentage, 6, ctx.seedCap || 0);
    if (amount <= 0) throw new Error(`Calculated amount is 0 (balance: ${balance}, pct: ${ctx.percentage}%)`);

    await E.selectMarketOrder();

    if (ctx.pageType === 'futures' && ctx.tradingMode === 'hedge') {
      await E.selectDirection('open_long', ctx.tradingMode);
    } else {
      await E.selectDirection('buy', ctx.tradingMode);
    }

    await E.fillAmount(amount);
    await E.submitBuy();

    return `시장가 매수 ${ctx.percentage}% (${amount})`;
  }

  // ── Action: MARKET_SELL ───────────────────────────────────────────────────
  /**
   * Market sell X% of available balance (spot) or position (futures).
   */
  async function marketSell(ctx) {
    requirePage(ctx, 'any');
    const balance = R.readAvailableBalance();
    if (isNaN(balance) || balance <= 0) throw new Error('Available balance not readable');

    const amount = calcAmount(balance, ctx.percentage, 6, ctx.seedCap || 0);
    if (amount <= 0) throw new Error(`Calculated amount is 0 (balance: ${balance}, pct: ${ctx.percentage}%)`);

    await E.selectMarketOrder();

    if (ctx.pageType === 'futures' && ctx.tradingMode === 'hedge') {
      await E.selectDirection('open_short', ctx.tradingMode);
    } else {
      await E.selectDirection('sell', ctx.tradingMode);
    }

    await E.fillAmount(amount);
    await E.submitSell();

    return `시장가 매도 ${ctx.percentage}% (${amount})`;
  }

  // ── Action: LIMIT_BUY ────────────────────────────────────────────────────
  /**
   * Limit buy X% of available balance using the price already in OKX's price field.
   */
  async function limitBuy(ctx) {
    requirePage(ctx, 'any');
    const balance = R.readAvailableBalance();
    if (isNaN(balance) || balance <= 0) throw new Error('Available balance not readable');

    const amount = calcAmount(balance, ctx.percentage, 6, ctx.seedCap || 0);
    if (amount <= 0) throw new Error('Calculated amount is 0');

    await E.selectLimitOrder();

    if (ctx.pageType === 'futures' && ctx.tradingMode === 'hedge') {
      await E.selectDirection('open_long', ctx.tradingMode);
    } else {
      await E.selectDirection('buy', ctx.tradingMode);
    }

    await E.fillAmount(amount);
    await E.submitBuy();

    return `지정가 매수 ${ctx.percentage}% (${amount})`;
  }

  // ── Action: LIMIT_SELL ───────────────────────────────────────────────────
  /**
   * Limit sell X% of available balance using the price already in OKX's price field.
   */
  async function limitSell(ctx) {
    requirePage(ctx, 'any');
    const balance = R.readAvailableBalance();
    if (isNaN(balance) || balance <= 0) throw new Error('Available balance not readable');

    const amount = calcAmount(balance, ctx.percentage, 6, ctx.seedCap || 0);
    if (amount <= 0) throw new Error('Calculated amount is 0');

    await E.selectLimitOrder();

    if (ctx.pageType === 'futures' && ctx.tradingMode === 'hedge') {
      await E.selectDirection('open_short', ctx.tradingMode);
    } else {
      await E.selectDirection('sell', ctx.tradingMode);
    }

    await E.fillAmount(amount);
    await E.submitSell();

    return `지정가 매도 ${ctx.percentage}% (${amount})`;
  }

  // ── Action: TICK_BUY ─────────────────────────────────────────────────────
  /**
   * Limit buy X% at best bid + 1 tick (favorable queue position).
   */
  async function tickBuy(ctx) {
    requirePage(ctx, 'any');
    const balance = R.readAvailableBalance();
    if (isNaN(balance) || balance <= 0) throw new Error('Available balance not readable');

    const bestBid = R.readBestBid();
    if (isNaN(bestBid)) throw new Error('Best bid price not readable');

    const tickSize = R.readTickSize();
    const tick = isNaN(tickSize) ? 0.01 : tickSize; // fallback 0.01
    const price = parseFloat((bestBid + tick).toFixed(String(tick).split('.')[1]?.length || 2));

    const amount = calcAmount(balance, ctx.percentage, 6, ctx.seedCap || 0);
    if (amount <= 0) throw new Error('Calculated amount is 0');

    await E.selectLimitOrder();

    if (ctx.pageType === 'futures' && ctx.tradingMode === 'hedge') {
      await E.selectDirection('open_long', ctx.tradingMode);
    } else {
      await E.selectDirection('buy', ctx.tradingMode);
    }

    await E.fillPrice(price);
    await E.fillAmount(amount);
    await E.submitBuy();

    return `틱 매수 ${ctx.percentage}% @ ${price}`;
  }

  // ── Action: TICK_SELL ────────────────────────────────────────────────────
  /**
   * Limit sell X% at best ask - 1 tick.
   */
  async function tickSell(ctx) {
    requirePage(ctx, 'any');
    const balance = R.readAvailableBalance();
    if (isNaN(balance) || balance <= 0) throw new Error('Available balance not readable');

    const amount = calcAmount(balance, ctx.percentage, 6, ctx.seedCap || 0);
    if (amount <= 0) throw new Error('Calculated amount is 0');

    const bestAsk = R.readBestAsk();
    if (isNaN(bestAsk)) throw new Error('Best ask price not readable');

    const tickSize = R.readTickSize();
    const tick = isNaN(tickSize) ? 0.01 : tickSize;
    const price = parseFloat((bestAsk - tick).toFixed(String(tick).split('.')[1]?.length || 2));

    await E.selectLimitOrder();

    if (ctx.pageType === 'futures' && ctx.tradingMode === 'hedge') {
      await E.selectDirection('open_short', ctx.tradingMode);
    } else {
      await E.selectDirection('sell', ctx.tradingMode);
    }

    await E.fillPrice(price);
    await E.fillAmount(amount);
    await E.submitSell();

    return `틱 매도 ${ctx.percentage}% @ ${price}`;
  }

  // ── Action: PARTIAL_CLOSE ────────────────────────────────────────────────
  /**
   * Close X% of current position at market.
   */
  async function partialClose(ctx) {
    requirePage(ctx, 'futures');
    const pos = R.readPosition();
    if (!pos.size || pos.size <= 0) throw new Error('No open position to close');

    const amount = calcAmount(pos.size, ctx.percentage);
    if (amount <= 0) throw new Error('Calculated close amount is 0');

    await E.selectMarketOrder();

    if (ctx.tradingMode === 'hedge') {
      const dir = pos.direction === 'long' ? 'close_long' : 'close_short';
      await E.selectDirection(dir, ctx.tradingMode);
    } else {
      // One-way: close by placing opposite order
      const dir = pos.direction === 'long' ? 'sell' : 'buy';
      await E.selectDirection(dir, ctx.tradingMode);
    }

    await E.fillAmount(amount);

    if (pos.direction === 'long') {
      await E.submitSell();
    } else {
      await E.submitBuy();
    }

    return `${ctx.percentage}% 청산 (${amount}/${pos.size})`;
  }

  // ── Action: CLOSE_PAIR ───────────────────────────────────────────────────
  /**
   * Close 100% of current pair's position at market.
   */
  async function closePair(ctx) {
    requirePage(ctx, 'futures');
    const pos = R.readPosition();
    if (!pos.size || pos.size <= 0) throw new Error('No open position to close');

    await E.selectMarketOrder();

    if (ctx.tradingMode === 'hedge') {
      const dir = pos.direction === 'long' ? 'close_long' : 'close_short';
      await E.selectDirection(dir, ctx.tradingMode);
    } else {
      const dir = pos.direction === 'long' ? 'sell' : 'buy';
      await E.selectDirection(dir, ctx.tradingMode);
    }

    await E.fillAmount(pos.size);

    if (pos.direction === 'long') {
      await E.submitSell();
    } else {
      await E.submitBuy();
    }

    return `페어 전체 청산 (${pos.size})`;
  }

  // ── Action: CLOSE_ALL ────────────────────────────────────────────────────
  /**
   * Close ALL positions at market (emergency exit).
   * Uses the "Close All" button if available, otherwise closes current pair.
   */
  async function closeAll(ctx) {
    requirePage(ctx, 'futures');
    // Try to find a "Close All" positions button on OKX
    const closeAllBtns = Array.from(document.querySelectorAll('button')).filter(btn => {
      const text = btn.textContent.trim().toLowerCase();
      return text.includes('close all') || text.includes('일괄 청산') || text.includes('전체 청산') || text.includes('全平');
    });

    if (closeAllBtns.length > 0) {
      closeAllBtns[0].click();
      await E.delay(200);
      // Handle confirmation dialog if present
      const confirmBtn = Array.from(document.querySelectorAll('button')).find(btn => {
        const text = btn.textContent.trim().toLowerCase();
        return text.includes('confirm') || text.includes('확인') || text.includes('ok');
      });
      if (confirmBtn) confirmBtn.click();
      return '전체 포지션 청산 완료';
    }

    // Fallback: close current pair
    await closePair(ctx);
    return '현재 페어 청산 (전체 청산 버튼 없음)';
  }

  // ── Action: FLIP ─────────────────────────────────────────────────────────
  /**
   * Close current position + open opposite direction same size at market.
   */
  async function flip(ctx) {
    requirePage(ctx, 'futures');
    const pos = R.readPosition();
    if (!pos.size || pos.size <= 0) throw new Error('No open position to flip');

    const originalSize = pos.size;
    const originalDirection = pos.direction;

    // Step 1: Close current position
    await E.selectMarketOrder();
    if (ctx.tradingMode === 'hedge') {
      const closeDir = originalDirection === 'long' ? 'close_long' : 'close_short';
      await E.selectDirection(closeDir, ctx.tradingMode);
    } else {
      const closeDir = originalDirection === 'long' ? 'sell' : 'buy';
      await E.selectDirection(closeDir, ctx.tradingMode);
    }
    await E.fillAmount(originalSize);
    if (originalDirection === 'long') {
      await E.submitSell();
    } else {
      await E.submitBuy();
    }

    // Step 2: Wait for close to register
    await E.delay(500);

    // Step 3: Open opposite position
    await E.selectMarketOrder();
    if (ctx.tradingMode === 'hedge') {
      const openDir = originalDirection === 'long' ? 'open_short' : 'open_long';
      await E.selectDirection(openDir, ctx.tradingMode);
    } else {
      const openDir = originalDirection === 'long' ? 'sell' : 'buy';
      await E.selectDirection(openDir, ctx.tradingMode);
    }
    await E.fillAmount(originalSize);
    if (originalDirection === 'long') {
      await E.submitSell();
    } else {
      await E.submitBuy();
    }

    const newDir = originalDirection === 'long' ? '숏' : '롱';
    return `포지션 반전: ${originalDirection} → ${newDir} (${originalSize})`;
  }

  // ── Action: CANCEL_LAST ──────────────────────────────────────────────────
  /**
   * Cancel the most recent unfilled order.
   */
  async function cancelLast(ctx) {
    requirePage(ctx, 'any');
    await E.ensureBottomTab('open orders');
    const rows = R.readOrderRows();
    if (rows.length === 0) throw new Error('미체결 주문 없음');

    // Most recent order is typically the first row
    await E.cancelOrderRow(rows[0]);
    return '마지막 주문 취소';
  }

  // ── Action: CANCEL_ALL ───────────────────────────────────────────────────
  /**
   * Cancel all open orders.
   */
  async function cancelAll(ctx) {
    requirePage(ctx, 'any');
    await E.ensureBottomTab('open orders');
    const rows = R.readOrderRows();
    if (rows.length === 0) throw new Error('미체결 주문 없음');

    await E.cancelAllOrders();
    return `전체 주문 취소 (${rows.length}건)`;
  }

  // ── Action: CHASE_ORDER ──────────────────────────────────────────────────
  /**
   * Click the Chase button on the most recent unfilled limit order.
   * OKX's Chase feature moves an unfilled order to the current best bid/ask.
   */
  async function chaseOrder(ctx) {
    requirePage(ctx, 'any');
    await E.ensureBottomTab('open orders');
    const rows = R.readOrderRows();
    if (rows.length === 0) throw new Error('미체결 주문 없음');

    const row = rows[0]; // Most recent order is first row

    // Find chase button by text content (most reliable — button has no special class/testid)
    const rowBtns = Array.from(row.querySelectorAll('button'));
    let chaseBtn = rowBtns.find(btn => {
      const t = btn.textContent.trim().toLowerCase();
      return t === 'chase' || t.includes('체이스') || t.includes('追单');
    });

    if (!chaseBtn) {
      // Fallback: try selector-based
      const S = window.OKX_SELECTORS;
      chaseBtn = row.querySelector(S.chaseButton);
    }

    if (!chaseBtn) {
      throw new Error('체이스 버튼을 찾을 수 없습니다 (선택자 업데이트 필요)');
    }

    chaseBtn.click();
    await E.delay(100);

    return '마지막 주문 체이스 완료';
  }

  // ── Dispatch table ────────────────────────────────────────────────────────

  const ACTION_MAP = {
    MARKET_BUY: marketBuy,
    MARKET_SELL: marketSell,
    LIMIT_BUY: limitBuy,
    LIMIT_SELL: limitSell,
    TICK_BUY: tickBuy,
    TICK_SELL: tickSell,
    PARTIAL_CLOSE: partialClose,
    CLOSE_PAIR: closePair,
    CLOSE_ALL: closeAll,
    FLIP: flip,
    CANCEL_LAST: cancelLast,
    CANCEL_ALL: cancelAll,
    CHASE_ORDER: chaseOrder
  };

  /**
   * Execute an action by ID.
   * @param {string} actionId
   * @param {object} ctx — { pageType, tradingMode, percentage, overlay }
   * @returns {Promise<string>} Success message
   */
  async function execute(actionId, ctx) {
    const fn = ACTION_MAP[actionId];
    if (!fn) throw new Error(`Unknown action: ${actionId}`);
    return fn(ctx);
  }

  return { execute, ACTION_MAP };
})();
