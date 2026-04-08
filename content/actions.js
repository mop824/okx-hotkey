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
   * Detect the unit the amount input expects by checking max-trade text.
   * OKX shows "Max buy0.9755 BTC" or "Max buy1,000 USDT" depending on display mode.
   * @returns {string} Unit like 'BTC', 'USDT', 'ETH', etc.
   */
  function getAmountUnit() {
    const el = document.querySelector('[data-testid="max-trade"]');
    if (!el) return 'USDT';
    const text = el.textContent.trim();
    const match = text.match(/[\d.]\s*([A-Za-z]{2,6})(?:\s|$)/);
    return match ? match[1].toUpperCase() : 'USDT';
  }

  /**
   * Convert USDT amount to the input's expected unit if needed.
   * @param {number} usdtAmount - Amount in USDT
   * @returns {number} Amount in the input's unit
   */
  function convertToInputUnit(usdtAmount) {
    const unit = getAmountUnit();
    if (unit === 'USDT') return usdtAmount;
    const price = R.readLastPrice();
    if (isNaN(price) || price <= 0) throw new Error('현재가를 읽을 수 없어 단위 변환 실패');
    return usdtAmount / price;
  }

  /**
   * Resolve the trade amount based on page type, trading mode, and direction.
   * Shared logic for all 6 buy/sell actions.
   *
   * @param {object} ctx — action context
   * @param {'buy'|'sell'} side — trade side
   * @returns {Promise<number>} resolved amount in the input's unit
   */
  async function resolveAmount(ctx, side) {
    const isBuy = side === 'buy';

    if (ctx.pageType === 'futures' && ctx.tradingMode === 'hedge') {
      await E.selectDirection(isBuy ? 'open_long' : 'open_short', ctx.tradingMode);
      const balance = R.readAvailableBalance();
      if (isNaN(balance) || balance <= 0) throw new Error('가용 잔고를 읽을 수 없습니다');
      const leverage = R.readLeverage();
      let amount = calcAmount(balance, ctx.percentage, 6, ctx.seedCap || 0) * leverage;
      return convertToInputUnit(amount);
    }

    if (ctx.pageType === 'futures' && ctx.tradingMode === 'one-way') {
      const pos = await getPosition();
      const counterDir = isBuy ? 'short' : 'long';
      if (pos.direction === counterDir && pos.size > 0) {
        // Closing counter-position — use position size directly, no leverage
        return calcAmount(pos.size, ctx.percentage);
      }
    }

    // Spot, or futures one-way with no counter-position
    const balance = R.readAvailableBalance();
    if (isNaN(balance) || balance <= 0) throw new Error('가용 잔고를 읽을 수 없습니다');
    const leverage = ctx.pageType === 'futures' ? R.readLeverage() : 1;
    let amount = calcAmount(balance, ctx.percentage, 6, ctx.seedCap || 0) * leverage;
    return convertToInputUnit(amount);
  }

  /**
   * Validate context has required page type.
   * @param {object} ctx
   * @param {'spot'|'futures'|'any'} required
   */
  function requirePage(ctx, required) {
    if (required !== 'any' && ctx.pageType !== required) {
      throw new Error(`이 액션은 ${required === 'futures' ? '선물' : required === 'spot' ? '현물' : required} 페이지에서만 사용 가능합니다`);
    }
    if (ctx.pageType === 'unknown') {
      throw new Error('OKX 트레이딩 페이지를 인식하지 못했습니다');
    }
  }

  /**
   * Read position data with automatic tab switching.
   * Quick path: checks "Open positions (N)" tab text — if N=0, returns immediately (no tab switch).
   * Slow path: switches to positions tab, parses rows, returns size + direction.
   *
   * In hedge mode, direction is determined by the positive-pl / negative-pl span class
   * on cell[1] (Size column). Size values are always positive in hedge mode.
   * In one-way mode, direction is determined by the sign of the size value.
   *
   * @param {'long'|'short'|undefined} direction — optional filter; returns only matching row
   * @returns {Promise<{size: number, direction: 'long'|'short'|null}>}
   */
  async function getPosition(direction) {
    // Quick check: position count from tab text (no tab switching needed)
    const tabs = document.querySelectorAll('.okui-tabs-pane-underline[role="tab"]');
    let posCount = 0;
    for (const tab of tabs) {
      if (tab.textContent.trim().toLowerCase().includes('open positions')) {
        const match = tab.textContent.match(/\((\d+)\)/);
        posCount = match ? parseInt(match[1]) : 0;
        break;
      }
    }
    if (posCount === 0) return { size: 0, direction: null, isProfit: null };

    // Position exists — switch to positions tab and read
    await E.ensureBottomTab('open positions');
    // Poll for position rows instead of fixed delay
    const S = window.OKX_SELECTORS;
    let rows;
    for (let i = 0; i < 8; i++) {
      rows = document.querySelectorAll(S.positionRow);
      if (rows.length > 0) break;
      await E.delay(50);
    }

    // Position table lives in .position-box (NOT .order-table-box which is for orders)
    if (!rows.length) return { size: 0, direction: null, isProfit: null };

    for (const row of rows) {
      const cells = [...row.querySelectorAll('td')];

      // Determine row direction from cell[1] span class (hedge mode):
      // positive-pl = long, negative-pl = short.
      // In one-way mode these classes don't exist; direction falls back to sign.
      let rowDirection = null;
      if (cells[1]) {
        if (cells[1].querySelector(S.positionLongClass)) rowDirection = 'long';
        else if (cells[1].querySelector(S.positionShortClass)) rowDirection = 'short';
      }

      // If direction filter specified, skip non-matching rows (hedge mode)
      if (direction && rowDirection && rowDirection !== direction) continue;

      // Iterate ALL cells to find Size — column order is user-customizable on OKX
      // Hedge mode: size values are always positive (use rowDirection for sign)
      // One-way mode: negative=short, positive=long
      for (const cell of cells) {
        const text = cell.textContent.trim();
        const match = text.match(/^([-+]?[\d,]+\.?\d*)\s+([A-Za-z]{2,6})\s*$/);
        if (match) {
          const rawSize = parseFloat(match[1].replace(/,/g, ''));
          if (!isNaN(rawSize) && rawSize !== 0) {
            // In one-way mode: sign determines direction. In hedge mode: class determines direction.
            const finalDirection = rowDirection || (rawSize < 0 ? 'short' : 'long');
            // Scan for PnL sign in remaining cells
            let isProfit = null;
            for (const c of cells) {
              const t = c.textContent.trim();
              // PnL pattern: starts with + or -, contains % in parentheses
              if (/^[+-]/.test(t) && t.includes('%')) {
                isProfit = t.startsWith('+');
                break;
              }
            }
            return {
              size: Math.abs(rawSize),
              direction: finalDirection,
              isProfit
            };
          }
        }
      }
    }

    console.warn('[OKX Hotkey] getPosition: no matching position found');
    return { size: 0, direction: null, isProfit: null };
  }

  // ── Action: MARKET_BUY ────────────────────────────────────────────────────
  /**
   * Market buy X% of available balance.
   */
  async function marketBuy(ctx) {
    requirePage(ctx, 'any');
    const amount = await resolveAmount(ctx, 'buy');
    if (amount <= 0) throw new Error('계산된 수량이 0입니다');

    let soundKey = 'default';
    if (ctx.pageType === 'futures') {
      if (ctx.tradingMode === 'one-way') {
        const pos = await getPosition();
        if (pos.direction === 'short' && pos.size > 0) {
          soundKey = pos.isProfit ? 'profit' : 'loss'; // closing a short
        } else if (pos.direction === 'long' && pos.size > 0) {
          soundKey = 'add'; // adding to existing long
        }
      } else if (ctx.tradingMode === 'hedge') {
        const pos = await getPosition('long');
        if (pos.size > 0) soundKey = 'add';
      }
    }

    await E.selectMarketOrder();
    if (ctx.pageType !== 'futures' || ctx.tradingMode !== 'hedge') {
      await E.selectDirection('buy', ctx.tradingMode);
    }
    await E.fillAmount(amount);
    await E.submitBuy();
    return { message: `시장가 매수 ${ctx.percentage}% (${amount})`, soundKey };
  }

  // ── Action: MARKET_SELL ───────────────────────────────────────────────────
  /**
   * Market sell X% of available balance (spot) or position (futures).
   */
  async function marketSell(ctx) {
    requirePage(ctx, 'any');
    const amount = await resolveAmount(ctx, 'sell');
    if (amount <= 0) throw new Error('계산된 수량이 0입니다');

    let soundKey = 'default';
    if (ctx.pageType === 'futures') {
      if (ctx.tradingMode === 'one-way') {
        const pos = await getPosition();
        if (pos.direction === 'long' && pos.size > 0) {
          soundKey = pos.isProfit ? 'profit' : 'loss'; // closing a long
        } else if (pos.direction === 'short' && pos.size > 0) {
          soundKey = 'add'; // adding to existing short
        }
      } else if (ctx.tradingMode === 'hedge') {
        const pos = await getPosition('short');
        if (pos.size > 0) soundKey = 'add';
      }
    }

    await E.selectMarketOrder();
    if (ctx.pageType !== 'futures' || ctx.tradingMode !== 'hedge') {
      await E.selectDirection('sell', ctx.tradingMode);
    }
    await E.fillAmount(amount);
    await E.submitSell();
    return { message: `시장가 매도 ${ctx.percentage}% (${amount})`, soundKey };
  }

  // ── Action: LIMIT_BUY ────────────────────────────────────────────────────
  /**
   * Limit buy X% of available balance using the price already in OKX's price field.
   */
  async function limitBuy(ctx) {
    requirePage(ctx, 'any');
    const amount = await resolveAmount(ctx, 'buy');
    if (amount <= 0) throw new Error('계산된 수량이 0입니다');

    let soundKey = 'default';
    if (ctx.pageType === 'futures') {
      if (ctx.tradingMode === 'one-way') {
        const pos = await getPosition();
        if (pos.direction === 'short' && pos.size > 0) {
          soundKey = pos.isProfit ? 'profit' : 'loss'; // closing a short
        } else if (pos.direction === 'long' && pos.size > 0) {
          soundKey = 'add'; // adding to existing long
        }
      } else if (ctx.tradingMode === 'hedge') {
        const pos = await getPosition('long');
        if (pos.size > 0) soundKey = 'add';
      }
    }

    await E.selectLimitOrder();
    if (ctx.pageType !== 'futures' || ctx.tradingMode !== 'hedge') {
      await E.selectDirection('buy', ctx.tradingMode);
    }
    await E.fillAmount(amount);
    await E.submitBuy();
    return { message: `지정가 매수 ${ctx.percentage}% (${amount})`, soundKey };
  }

  // ── Action: LIMIT_SELL ───────────────────────────────────────────────────
  /**
   * Limit sell X% of available balance using the price already in OKX's price field.
   */
  async function limitSell(ctx) {
    requirePage(ctx, 'any');
    const amount = await resolveAmount(ctx, 'sell');
    if (amount <= 0) throw new Error('계산된 수량이 0입니다');

    let soundKey = 'default';
    if (ctx.pageType === 'futures') {
      if (ctx.tradingMode === 'one-way') {
        const pos = await getPosition();
        if (pos.direction === 'long' && pos.size > 0) {
          soundKey = pos.isProfit ? 'profit' : 'loss'; // closing a long
        } else if (pos.direction === 'short' && pos.size > 0) {
          soundKey = 'add'; // adding to existing short
        }
      } else if (ctx.tradingMode === 'hedge') {
        const pos = await getPosition('short');
        if (pos.size > 0) soundKey = 'add';
      }
    }

    await E.selectLimitOrder();
    if (ctx.pageType !== 'futures' || ctx.tradingMode !== 'hedge') {
      await E.selectDirection('sell', ctx.tradingMode);
    }
    await E.fillAmount(amount);
    await E.submitSell();
    return { message: `지정가 매도 ${ctx.percentage}% (${amount})`, soundKey };
  }

  // ── Action: TICK_BUY ─────────────────────────────────────────────────────
  /**
   * Limit buy X% at best bid + 1 tick (favorable queue position).
   */
  async function tickBuy(ctx) {
    requirePage(ctx, 'any');
    const amount = await resolveAmount(ctx, 'buy');
    if (amount <= 0) throw new Error('계산된 수량이 0입니다');

    let soundKey = 'default';
    if (ctx.pageType === 'futures') {
      if (ctx.tradingMode === 'one-way') {
        const pos = await getPosition();
        if (pos.direction === 'short' && pos.size > 0) {
          soundKey = pos.isProfit ? 'profit' : 'loss'; // closing a short
        } else if (pos.direction === 'long' && pos.size > 0) {
          soundKey = 'add'; // adding to existing long
        }
      } else if (ctx.tradingMode === 'hedge') {
        const pos = await getPosition('long');
        if (pos.size > 0) soundKey = 'add';
      }
    }

    const bestBid = R.readBestBid();
    if (isNaN(bestBid)) throw new Error('최우선 매수호가를 읽을 수 없습니다');
    const tickSize = R.readTickSize();
    const tick = isNaN(tickSize) ? 0.01 : tickSize;
    const ticks = ctx.ticks || 1;
    const price = parseFloat((bestBid + tick * ticks).toFixed(String(tick).split('.')[1]?.length || 2));

    await E.selectLimitOrder();
    if (ctx.pageType !== 'futures' || ctx.tradingMode !== 'hedge') {
      await E.selectDirection('buy', ctx.tradingMode);
    }
    await E.fillPrice(price);
    await E.fillAmount(amount);
    await E.submitBuy();
    return { message: `틱 매수 ${ctx.percentage}% @ ${price}`, soundKey };
  }

  // ── Action: TICK_SELL ────────────────────────────────────────────────────
  /**
   * Limit sell X% at best ask - 1 tick.
   */
  async function tickSell(ctx) {
    requirePage(ctx, 'any');
    const amount = await resolveAmount(ctx, 'sell');
    if (amount <= 0) throw new Error('계산된 수량이 0입니다');

    let soundKey = 'default';
    if (ctx.pageType === 'futures') {
      if (ctx.tradingMode === 'one-way') {
        const pos = await getPosition();
        if (pos.direction === 'long' && pos.size > 0) {
          soundKey = pos.isProfit ? 'profit' : 'loss'; // closing a long
        } else if (pos.direction === 'short' && pos.size > 0) {
          soundKey = 'add'; // adding to existing short
        }
      } else if (ctx.tradingMode === 'hedge') {
        const pos = await getPosition('short');
        if (pos.size > 0) soundKey = 'add';
      }
    }

    const bestAsk = R.readBestAsk();
    if (isNaN(bestAsk)) throw new Error('최우선 매도호가를 읽을 수 없습니다');
    const tickSize = R.readTickSize();
    const tick = isNaN(tickSize) ? 0.01 : tickSize;
    const ticks = ctx.ticks || 1;
    const price = parseFloat((bestAsk - tick * ticks).toFixed(String(tick).split('.')[1]?.length || 2));

    await E.selectLimitOrder();
    if (ctx.pageType !== 'futures' || ctx.tradingMode !== 'hedge') {
      await E.selectDirection('sell', ctx.tradingMode);
    }
    await E.fillPrice(price);
    await E.fillAmount(amount);
    await E.submitSell();
    return { message: `틱 매도 ${ctx.percentage}% @ ${price}`, soundKey };
  }

  // ── Action: CLOSE_PAIR ───────────────────────────────────────────────────
  /**
   * Close 100% of current pair's position at market.
   */
  async function closePair(ctx) {
    requirePage(ctx, 'futures');
    if (ctx.tradingMode === 'hedge') throw new Error('헤지 모드에서는 롱 청산/숏 청산 액션을 사용하세요');
    const pos = await getPosition();
    if (!pos.size || pos.size <= 0) throw new Error('청산할 포지션이 없습니다');

    await E.selectMarketOrder();

    const dir = pos.direction === 'long' ? 'sell' : 'buy';
    await E.selectDirection(dir, ctx.tradingMode);

    await E.fillAmount(pos.size);

    if (pos.direction === 'long') {
      await E.submitSell();
    } else {
      await E.submitBuy();
    }

    return { message: `페어 전체 청산 (${pos.size})`, soundKey: pos.isProfit ? 'profit' : 'loss' };
  }

  // ── Action: CLOSE_ALL ────────────────────────────────────────────────────
  /**
   * Close ALL positions at market (emergency exit).
   * Uses the "Close All" button if available, otherwise closes current pair.
   */
  async function closeAll(ctx) {
    requirePage(ctx, 'futures');

    // Switch to positions tab where the Close all button lives
    await E.ensureBottomTab('open positions');
    await E.delay(200);

    // Find Close all button (class: position-function-btn, or text match)
    let closeBtn = document.querySelector('button.position-function-btn:not(.btn-disabled)');

    if (!closeBtn) {
      // Text-content fallback
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent.trim().toLowerCase();
        if ((text.includes('close all') || text.includes('전체 청산') || text.includes('일괄 청산') || text.includes('全平'))
            && !btn.classList.contains('btn-disabled')) {
          closeBtn = btn;
          break;
        }
      }
    }

    if (!closeBtn) throw new Error('전체 청산 버튼을 찾을 수 없습니다');

    const pos = await getPosition();
    const profitKey = pos.isProfit ? 'profit' : 'loss';

    closeBtn.click();
    const confirmBtn = await E.waitForConfirmButton();
    if (confirmBtn) {
      confirmBtn.click();
      await E.delay(100);
    }

    return { message: '전체 포지션 청산', soundKey: profitKey };
  }

  // ── Action: FLIP ─────────────────────────────────────────────────────────
  /**
   * Close current position + open opposite direction same size at market.
   */
  async function flip(ctx) {
    requirePage(ctx, 'futures');
    if (ctx.tradingMode === 'hedge') throw new Error('포지션 반전은 단방향 모드에서만 지원됩니다');

    // Switch to positions tab where the Reverse button lives
    await E.ensureBottomTab('open positions');
    await E.delay(300);

    const S = window.OKX_SELECTORS;
    const rows = document.querySelectorAll(S.positionRow);
    if (!rows.length) throw new Error('반전할 포지션이 없습니다');

    // Find the Reverse button in the position row
    const row = rows[0];
    const buttons = row.querySelectorAll('button');
    let reverseBtn = null;
    for (const btn of buttons) {
      const text = btn.textContent.trim().toLowerCase();
      if (text === 'reverse' || text === '반전' || text === '反向') {
        reverseBtn = btn;
        break;
      }
    }

    if (!reverseBtn) throw new Error('반전 버튼을 찾을 수 없습니다');

    reverseBtn.click();
    const confirmBtn = await E.waitForConfirmButton();
    if (confirmBtn) {
      confirmBtn.click();
      await E.delay(100);
    }

    return { message: '포지션 반전 완료', soundKey: 'default' };
  }

  // ── Action: CANCEL_LAST ──────────────────────────────────────────────────
  /**
   * Cancel the most recent unfilled order.
   */
  async function cancelLast(ctx) {
    requirePage(ctx, 'any');
    await E.ensureBottomTab('open orders');
    let rows;
    for (let i = 0; i < 8; i++) {
      rows = R.readOrderRows();
      if (rows.length > 0) break;
      await E.delay(50);
    }
    if (!rows || rows.length === 0) throw new Error('미체결 주문 없음');

    // Most recent order is typically the first row
    await E.cancelOrderRow(rows[0]);
    return { message: '마지막 주문 취소', soundKey: 'default' };
  }

  // ── Action: CANCEL_ALL ───────────────────────────────────────────────────
  /**
   * Cancel all open orders.
   */
  async function cancelAll(ctx) {
    requirePage(ctx, 'any');
    await E.ensureBottomTab('open orders');
    let rows;
    for (let i = 0; i < 8; i++) {
      rows = R.readOrderRows();
      if (rows.length > 0) break;
      await E.delay(50);
    }
    if (!rows || rows.length === 0) throw new Error('미체결 주문 없음');

    await E.cancelAllOrders();
    return { message: `전체 주문 취소 (${rows.length}건)`, soundKey: 'default' };
  }

  // ── Action: CHASE_ORDER ──────────────────────────────────────────────────
  /**
   * Click the Chase button on the most recent unfilled limit order.
   * OKX's Chase feature moves an unfilled order to the current best bid/ask.
   */
  async function chaseOrder(ctx) {
    requirePage(ctx, 'any');
    await E.ensureBottomTab('open orders');
    let rows;
    for (let i = 0; i < 8; i++) {
      rows = R.readOrderRows();
      if (rows.length > 0) break;
      await E.delay(50);
    }
    if (!rows || rows.length === 0) throw new Error('미체결 주문 없음');

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

    return { message: '마지막 주문 체이스 완료', soundKey: 'default' };
  }

  // ── Action: CLOSE_LONG_MARKET ────────────────────────────────────────────
  /**
   * Close X% of long position at market (hedge mode only).
   * Close long = negativebutton ("Close long") — verified via DOM scraping.
   */
  async function closeLongMarket(ctx) {
    requirePage(ctx, 'futures');
    if (ctx.tradingMode !== 'hedge') throw new Error('이 액션은 헤지 모드 전용입니다');

    const pos = await getPosition('long');
    if (!pos.size || pos.size <= 0) throw new Error('청산할 롱 포지션이 없습니다');

    const amount = calcAmount(pos.size, ctx.percentage);
    if (amount <= 0) throw new Error('계산된 수량이 0입니다');

    await E.selectMarketOrder();
    await E.selectDirection('close_long', ctx.tradingMode);
    await E.fillAmount(amount);
    await E.submitSell();
    return { message: `롱 시장가 청산 ${ctx.percentage}%`, soundKey: pos.isProfit ? 'profit' : 'loss' };
  }

  // ── Action: CLOSE_LONG_LIMIT ─────────────────────────────────────────────
  /**
   * Close X% of long position at limit price (hedge mode only).
   * Price field is left as-is — user sets the price manually.
   */
  async function closeLongLimit(ctx) {
    requirePage(ctx, 'futures');
    if (ctx.tradingMode !== 'hedge') throw new Error('이 액션은 헤지 모드 전용입니다');

    const pos = await getPosition('long');
    if (!pos.size || pos.size <= 0) throw new Error('청산할 롱 포지션이 없습니다');

    const amount = calcAmount(pos.size, ctx.percentage);
    if (amount <= 0) throw new Error('계산된 수량이 0입니다');

    await E.selectLimitOrder();
    await E.selectDirection('close_long', ctx.tradingMode);
    // Don't fill price — leave as-is (user may have set it manually)
    await E.fillAmount(amount);
    await E.submitSell();
    return { message: `롱 지정가 청산 ${ctx.percentage}%`, soundKey: pos.isProfit ? 'profit' : 'loss' };
  }

  // ── Action: CLOSE_SHORT_MARKET ───────────────────────────────────────────
  /**
   * Close X% of short position at market (hedge mode only).
   * Close short = positivebutton ("Close short") — verified via DOM scraping.
   */
  async function closeShortMarket(ctx) {
    requirePage(ctx, 'futures');
    if (ctx.tradingMode !== 'hedge') throw new Error('이 액션은 헤지 모드 전용입니다');

    const pos = await getPosition('short');
    if (!pos.size || pos.size <= 0) throw new Error('청산할 숏 포지션이 없습니다');

    const amount = calcAmount(pos.size, ctx.percentage);
    if (amount <= 0) throw new Error('계산된 수량이 0입니다');

    await E.selectMarketOrder();
    await E.selectDirection('close_short', ctx.tradingMode);
    await E.fillAmount(amount);
    await E.submitBuy();
    return { message: `숏 시장가 청산 ${ctx.percentage}%`, soundKey: pos.isProfit ? 'profit' : 'loss' };
  }

  // ── Action: CLOSE_SHORT_LIMIT ────────────────────────────────────────────
  /**
   * Close X% of short position at limit price (hedge mode only).
   * Price field is left as-is — user sets the price manually.
   */
  async function closeShortLimit(ctx) {
    requirePage(ctx, 'futures');
    if (ctx.tradingMode !== 'hedge') throw new Error('이 액션은 헤지 모드 전용입니다');

    const pos = await getPosition('short');
    if (!pos.size || pos.size <= 0) throw new Error('청산할 숏 포지션이 없습니다');

    const amount = calcAmount(pos.size, ctx.percentage);
    if (amount <= 0) throw new Error('계산된 수량이 0입니다');

    await E.selectLimitOrder();
    await E.selectDirection('close_short', ctx.tradingMode);
    await E.fillAmount(amount);
    await E.submitBuy();
    return { message: `숏 지정가 청산 ${ctx.percentage}%`, soundKey: pos.isProfit ? 'profit' : 'loss' };
  }

  // ── Dispatch table ────────────────────────────────────────────────────────

  const ACTION_MAP = {
    MARKET_BUY: marketBuy,
    MARKET_SELL: marketSell,
    LIMIT_BUY: limitBuy,
    LIMIT_SELL: limitSell,
    TICK_BUY: tickBuy,
    TICK_SELL: tickSell,
    CLOSE_PAIR: closePair,
    CLOSE_ALL: closeAll,
    FLIP: flip,
    CANCEL_LAST: cancelLast,
    CANCEL_ALL: cancelAll,
    CHASE_ORDER: chaseOrder,
    CLOSE_LONG_MARKET: closeLongMarket,
    CLOSE_LONG_LIMIT: closeLongLimit,
    CLOSE_SHORT_MARKET: closeShortMarket,
    CLOSE_SHORT_LIMIT: closeShortLimit,
  };

  /**
   * Execute an action by ID.
   * @param {string} actionId
   * @param {object} ctx — { pageType, tradingMode, percentage, overlay }
   * @returns {Promise<string>} Success message
   */
  async function execute(actionId, ctx) {
    const fn = ACTION_MAP[actionId];
    if (!fn) throw new Error(`알 수 없는 액션: ${actionId}`);
    return fn(ctx);
  }

  return { execute, ACTION_MAP };
})();
