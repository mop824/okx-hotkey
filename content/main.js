/**
 * main.js — Entry point for OKX Hotkey Trading extension
 *
 * Responsibilities:
 * 1. Init: load settings, set up hotkey listeners
 * 2. Hotkey dispatch: match key combo to action, execute
 * 3. Sound playback: per-action base64 audio after successful execution
 * 4. Donation mode: replace buy/sell button text via MutationObserver
 * 5. SPA navigation: MutationObserver re-detects page type on URL change
 *
 * Storage schema source of truth: getDefaultSettings() and migrateFromSlots() in this file.
 * popup/popup.js is the other authoritative copy — keep in sync manually.
 */

;(async function OKXHotkeyMain() {
  'use strict';

  // Guard: prevent double-init on SPA re-renders
  if (window.__okxHotkeyInitialized) return;
  window.__okxHotkeyInitialized = true;

  // ── State ──────────────────────────────────────────────────────────────────

  let settings = null;
  let detectorState = { pageType: 'unknown', tradingMode: 'unknown', ready: false };
  let hotkeyListener = null;
  let donationObserver = null;

  // ── Settings loading ──────────────────────────────────────────────────────

  async function loadSettings() {
    try {
      const result = await chrome.storage.local.get(['settings']);
      if (!result.settings) {
        settings = getDefaultSettings();
        return;
      }
      const saved = result.settings;

      // Migrate v1 slots → v2 actions if needed
      if (saved.slots && !saved.actions) {
        settings = migrateFromSlots(saved);
        chrome.storage.local.set({ settings });
        return;
      }

      settings = {
        actions: Array.isArray(saved.actions) ? saved.actions : [],
        general: { ...getDefaultSettings().general, ...(saved.general || {}) }
      };
    } catch (err) {
      console.error('[OKX Hotkey] Failed to load settings:', err);
      settings = getDefaultSettings();
    }
  }

  function getDefaultSettings() {
    return {
      actions: [
        {
          id: 'default_mktbuy',
          type: 'MARKET_BUY',
          label: '시장가 매수',
          hotkey: { key: '1', ctrl: true, shift: true, alt: false },
          percentage: 5,
          sound: null,
          soundName: null
        },
        {
          id: 'default_mktsell',
          type: 'MARKET_SELL',
          label: '시장가 매도',
          hotkey: { key: '2', ctrl: true, shift: true, alt: false },
          percentage: 5,
          sound: null,
          soundName: null
        },
        {
          id: 'default_closeall',
          type: 'CLOSE_ALL',
          label: '전체 청산',
          hotkey: { key: 'c', ctrl: true, shift: true, alt: false },
          percentage: 100,
          sound: null,
          soundName: null
        }
      ],
      general: {
        soundEnabled: true,
        seedCap: 0,
        donationMode: false
      }
    };
  }

  function migrateFromSlots(oldSettings) {
    const actions = (oldSettings.slots || []).map(slot => ({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      type: slot.id,
      label: slot.label || slot.id,
      hotkey: slot.hotkey || { key: '', ctrl: false, shift: false, alt: false },
      percentage: slot.percentage || 0,
      sound: null,
      soundName: null
    }));
    const oldGeneral = oldSettings.general || {};
    return {
      actions,
      general: {
        soundEnabled: oldGeneral.soundEnabled !== undefined ? oldGeneral.soundEnabled : true,
        seedCap: oldGeneral.seedCap || 0,
        donationMode: false
      }
    };
  }

  // ── Hotkey matching ───────────────────────────────────────────────────────

  function normalizeKey(e) {
    return e.key.toLowerCase();
  }

  function matchesHotkey(e, hotkey) {
    if (!hotkey || !hotkey.key) return false;
    return (
      normalizeKey(e) === hotkey.key.toLowerCase() &&
      !!e.ctrlKey  === !!hotkey.ctrl  &&
      !!e.shiftKey === !!hotkey.shift &&
      !!e.altKey   === !!hotkey.alt   &&
      !e.metaKey
    );
  }

  // ── Sound playback ────────────────────────────────────────────────────────

  let audioCtx = null;

  function playActionSound(action, soundKey = 'default') {
    if (!settings.general.soundEnabled) return;

    // Route soundKey to the correct sound data field
    const soundMap = {
      'default': action.sound,
      'add':     action.soundAdd || action.sound,
      'profit':  action.soundProfit || action.sound,
      'loss':    action.soundLoss || action.sound,
    };
    const soundData = soundMap[soundKey] || action.sound;

    if (!soundData) return;
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      // Decode base64 data URL directly (avoids CSP blocking fetch on data: URLs)
      const base64 = soundData.split(',')[1];
      const binaryStr = atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      audioCtx.decodeAudioData(bytes.buffer)
        .then(audioBuffer => {
          const source = audioCtx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(audioCtx.destination);
          source.start(0);
        })
        .catch(err => {
          console.warn('[OKX Hotkey] Sound playback failed:', err);
        });
    } catch (err) {
      console.warn('[OKX Hotkey] Sound init failed:', err);
    }
  }

  // ── Hotkey handler ────────────────────────────────────────────────────────

  async function handleKeydown(e) {
    if (!settings) return;

    const target = e.target;
    const isTextInput = (
      (target.tagName === 'INPUT' && !target.closest('.place-order-container-common')) ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable
    );
    if (isTextInput) return;

    for (const action of settings.actions) {
      if (!matchesHotkey(e, action.hotkey)) continue;

      e.preventDefault();
      e.stopImmediatePropagation();

      // Resume AudioContext during user gesture to comply with autoplay policy
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
      }

      await executeAction(action);
      break;
    }
  }

  // ── Action execution ──────────────────────────────────────────────────────

  async function executeAction(action) {
    detectorState = OKXDetector.getState();

    if (!detectorState.ready) {
      OKXOverlay.error('OKX 트레이딩 페이지를 인식하지 못했습니다');
      return;
    }

    const pctLabel = action.percentage > 0 ? ` ${action.percentage}%` : '';
    const toast = OKXOverlay.loading(`${action.label}${pctLabel} 실행 중...`);

    try {
      const ctx = {
        pageType:    detectorState.pageType,
        tradingMode: detectorState.tradingMode,
        percentage:  action.percentage,
        ticks:       action.ticks || 1,
        seedCap:     settings.general.seedCap || 0
      };

      const result = await OKXActions.execute(action.type, ctx);
      const message = typeof result === 'object' ? result.message : result;
      const soundKey = typeof result === 'object' ? (result.soundKey || 'default') : 'default';
      OKXOverlay.update(toast, message || `${action.label} 완료`, 'success');
      playActionSound(action, soundKey);
    } catch (err) {
      console.error(`[OKX Hotkey] Action ${action.type} failed:`, err);
      OKXOverlay.update(toast, `오류: ${err.message}`, 'error');
    }
  }

  // ── Listener management ───────────────────────────────────────────────────

  function attachKeyListener() {
    if (hotkeyListener) {
      document.removeEventListener('keydown', hotkeyListener, true);
    }
    hotkeyListener = handleKeydown;
    document.addEventListener('keydown', hotkeyListener, true);
  }

  // ── Donation mode ─────────────────────────────────────────────────────────

  const DONATION_BUY_PATTERNS  = /^(Buy|매수|Long|Buy\s*\(Long\))$/i;
  const DONATION_SELL_PATTERNS = /^(Sell|매도|Short|Sell\s*\(Short\))$/i;
  const DONATION_TEXT = 'Donation';

  /**
   * Replace buy/sell text nodes inside a button element.
   * Only replaces text nodes (not icons/children with sub-elements).
   */
  function replaceDonationText(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const trimmed = node.textContent.trim();
      if (DONATION_BUY_PATTERNS.test(trimmed) || DONATION_SELL_PATTERNS.test(trimmed)) {
        node.textContent = DONATION_TEXT;
      }
    }
  }

  function applyDonationMode() {
    if (!settings || !settings.general.donationMode) return;
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      replaceDonationText(btn);
    }
  }

  function startDonationObserver() {
    if (donationObserver) return;
    applyDonationMode();
    let donationPending = false;
    donationObserver = new MutationObserver(() => {
      if (donationPending) return;
      donationPending = true;
      requestAnimationFrame(() => {
        applyDonationMode();
        donationPending = false;
      });
    });
    donationObserver.observe(document.body, { childList: true, subtree: true, characterData: false });
  }

  function stopDonationObserver() {
    if (donationObserver) {
      donationObserver.disconnect();
      donationObserver = null;
    }
  }

  function syncDonationMode() {
    if (settings && settings.general.donationMode) {
      startDonationObserver();
    } else {
      stopDonationObserver();
    }
  }

  // ── Settings change listener (from popup) ─────────────────────────────────

  chrome.storage.onChanged.addListener((changes) => {
    if (!changes.settings) return;
    const saved = changes.settings.newValue;
    if (!saved) return;

    settings = {
      actions: Array.isArray(saved.actions) ? saved.actions : [],
      general: { ...getDefaultSettings().general, ...(saved.general || {}) }
    };

    syncDonationMode();
  });

  // ── SPA navigation detection ──────────────────────────────────────────────

  let lastUrl = window.location.href;

  const navObserver = new MutationObserver(() => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      console.log('[OKX Hotkey] SPA navigation detected, re-detecting page...');
      detectorState = OKXDetector.getState();
      // Re-apply donation mode after navigation
      if (settings && settings.general.donationMode) {
        setTimeout(applyDonationMode, 500);
      }
    }
  });

  navObserver.observe(document.body, { childList: true, subtree: true });

  // ── Init ──────────────────────────────────────────────────────────────────

  async function init() {
    console.log('[OKX Hotkey] Initializing...');
    await loadSettings();

    detectorState = OKXDetector.getState();
    console.log('[OKX Hotkey] Detected:', detectorState);

    attachKeyListener();
    syncDonationMode();

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'GET_STATUS') {
        const fresh = OKXDetector.getState();
        // Use fresh detection, fall back to cached if fresh returns unknown
        // (handles React re-render transitions where form temporarily disappears)
        const result = {
          ready:       fresh.ready || detectorState.ready,
          pageType:    fresh.pageType !== 'unknown' ? fresh.pageType : detectorState.pageType,
          tradingMode: fresh.tradingMode !== 'unknown' ? fresh.tradingMode : detectorState.tradingMode
        };
        // Update cache if fresh detection succeeded
        if (fresh.tradingMode !== 'unknown') detectorState = fresh;
        sendResponse(result);
      }
      return false;
    });

    console.log('[OKX Hotkey] Ready. Page:', detectorState.pageType, '/ Mode:', detectorState.tradingMode);
  }

  init().catch(err => {
    console.error('[OKX Hotkey] Init failed:', err);
  });

})();
