/**
 * main.js — Entry point for OKX Hotkey Trading extension
 *
 * Responsibilities:
 * 1. License gate: check status before activating hotkeys
 * 2. Init: load settings, set up hotkey listeners
 * 3. Hotkey dispatch: match key combo to action, execute
 * 4. Sound playback: per-action base64 audio after successful execution
 * 5. Donation mode: replace buy/sell button text via MutationObserver
 * 6. SPA navigation: MutationObserver re-detects page type on URL change
 */

;(async function OKXHotkeyMain() {
  'use strict';

  if (window.__okxHotkeyInitialized) return;
  window.__okxHotkeyInitialized = true;

  // ── Context guard ─────────────────────────────────────────────────────────
  function _mainContextAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  // ── State ──────────────────────────────────────────────────────────────────

  let settings = null;
  let detectorState = { pageType: 'unknown', tradingMode: 'unknown', ready: false };
  let hotkeyListener = null;
  let donationObserver = null;
  let detectRetryInterval = null;
  let licenseActive = false;

  // ── License gate ──────────────────────────────────────────────────────────

  const STATUS_MESSAGES = {
    revoked:          '단체방 재가입 후 재인증이 필요합니다.',
    server_unreachable: '서버 연결 불가. 잠시 후 다시 시도해주세요.',
    suspended:        '라이선스가 일시 정지되었습니다.',
    unregistered:     '익스텐션 팝업에서 인증을 완료해주세요.',
  };

  async function checkLicenseStatus() {
    if (!_mainContextAlive()) return 'unregistered';
    try {
      const result = await chrome.storage.local.get(['license_status']);
      return result.license_status || 'unregistered';
    } catch (_) { return 'unregistered'; } // extension context invalidated
  }

  function applyLicenseState(status) {
    if (status === 'active') {
      licenseActive = true;
      if (!hotkeyListener) attachKeyListener();
    } else {
      licenseActive = false;
      detachKeyListener();
    }
  }

  function detachKeyListener() {
    if (hotkeyListener) {
      document.removeEventListener('keydown', hotkeyListener, true);
      hotkeyListener = null;
    }
  }

  // ── License message listener ──────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // MED-B10: reject messages from sources other than this extension.
    // Guard chrome.runtime.id access — throws if extension context invalidated.
    try {
      if (sender.id !== chrome.runtime.id) return;
    } catch (_) {
      // Extension context invalidated (e.g. after update/reload); silently ignore.
      return;
    }
    if (msg.type === 'LICENSE_STATUS') {
      applyLicenseState(msg.status);
    }
    if (msg.type === 'GET_STATUS') {
      const fresh = OKXDetector.getState();
      const result = {
        ready:       fresh.ready || detectorState.ready,
        pageType:    fresh.pageType !== 'unknown' ? fresh.pageType : detectorState.pageType,
        tradingMode: fresh.tradingMode !== 'unknown' ? fresh.tradingMode : detectorState.tradingMode
      };
      if (fresh.tradingMode !== 'unknown') detectorState = fresh;
      sendResponse(result);
    }
    return false;
  });

  // ── Detection retry ───────────────────────────────────────────────────────

  function startDetectRetry() {
    if (detectRetryInterval) clearInterval(detectRetryInterval);
    detectRetryInterval = setInterval(() => {
      const fresh = OKXDetector.getState();
      if (fresh.tradingMode !== 'unknown') {
        detectorState = fresh;
        clearInterval(detectRetryInterval);
        detectRetryInterval = null;
        console.log('[OKX Hotkey] Re-detected:', detectorState);
      }
    }, 500);
    setTimeout(() => {
      if (detectRetryInterval) {
        clearInterval(detectRetryInterval);
        detectRetryInterval = null;
      }
    }, 10000);
  }

  // ── Pair detection ────────────────────────────────────────────────────────

  const TRADING_ACTION_TYPES_CONTENT = [
    'MARKET_BUY','MARKET_SELL','LIMIT_BUY','LIMIT_SELL','TICK_BUY','TICK_SELL',
    'CLOSE_PAIR','CLOSE_ALL','CLOSE_LONG_MARKET','CLOSE_LONG_LIMIT',
    'CLOSE_SHORT_MARKET','CLOSE_SHORT_LIMIT','FLIP'
  ];

  function isTradingActionContent(type) {
    return TRADING_ACTION_TYPES_CONTENT.includes(type);
  }

  function detectProfileFromUrl() {
    const m = window.location.href.match(/\/(btc|eth)(?:usd[t]?|-)/i);
    if (!m) return 'other';
    return m[1].toLowerCase();
  }

  // ── Settings loading ──────────────────────────────────────────────────────

  async function loadSettings() {
    try {
      if (!_mainContextAlive()) { settings = getDefaultSettings(); return; }
      const result = await chrome.storage.local.get(['settings']);
      if (!result.settings) {
        settings = getDefaultSettings();
        return;
      }
      const saved = result.settings;

      // v2 format
      if (saved.version === 2 && saved.profiles && saved.global) {
        const profileId = detectProfileFromUrl();
        const profile = saved.profiles[profileId] || saved.profiles.btc || {};
        settings = {
          actions: Array.isArray(profile.actions) ? profile.actions : [],
          general: {
            soundEnabled:  saved.global.soundEnabled !== undefined ? saved.global.soundEnabled : true,
            donationMode:  !!saved.global.donationMode,
            seedCap:       profile.seedCap || 0,
            tpsl:          profile.tpsl || { mode: 'pct', tp: 0, sl: 0 },
            tradingSound:  saved.global.tradingSound || {}
          }
        };
        return;
      }

      // Legacy v0 (slots)
      if (saved.slots && !saved.actions) {
        settings = migrateFromSlots(saved);
        return;
      }

      // Legacy v1 (has general + actions, no version) — migrate to v2 and save
      if (!saved.version && saved.general && saved.actions) {
        const oldGeneral = saved.general || {};
        const oldActions = Array.isArray(saved.actions) ? saved.actions : [];
        const profileActions = oldActions.map(a => ({ ...a }));
        const v2 = {
          version: 2,
          global: {
            soundEnabled: oldGeneral.soundEnabled !== undefined ? oldGeneral.soundEnabled : true,
            donationMode: !!oldGeneral.donationMode,
            tradingSound: {}
          },
          profiles: {
            btc:   { actions: profileActions.map(a => ({ ...a })), seedCap: oldGeneral.seedCap || 0, tpsl: { mode: 'pct', tp: oldGeneral.tpPct || 0, sl: oldGeneral.slPct || 0 } },
            eth:   { actions: profileActions.map(a => ({ ...a })), seedCap: oldGeneral.seedCap || 0, tpsl: { mode: 'pct', tp: oldGeneral.tpPct || 0, sl: oldGeneral.slPct || 0 } },
            other: { actions: profileActions.map(a => ({ ...a })), seedCap: oldGeneral.seedCap || 0, tpsl: { mode: 'pct', tp: oldGeneral.tpPct || 0, sl: oldGeneral.slPct || 0 } }
          },
          activeTab: 'btc'
        };
        if (_mainContextAlive()) {
          try { chrome.storage.local.set({ settings: v2 }); } catch (_) { /* extension context invalidated */ }
        }
        const profileId = detectProfileFromUrl();
        const profile = v2.profiles[profileId] || v2.profiles.btc;
        settings = {
          actions: profile.actions,
          general: {
            soundEnabled: v2.global.soundEnabled,
            donationMode: v2.global.donationMode,
            seedCap:      profile.seedCap,
            tpsl:         profile.tpsl,
            tradingSound: v2.global.tradingSound
          }
        };
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
        },
        {
          id: 'default_mktsell',
          type: 'MARKET_SELL',
          label: '시장가 매도',
          hotkey: { key: '2', ctrl: true, shift: true, alt: false },
          percentage: 5,
        },
        {
          id: 'default_closeall',
          type: 'CLOSE_ALL',
          label: '전체 청산',
          hotkey: { key: 'c', ctrl: true, shift: true, alt: false },
          percentage: 100,
        }
      ],
      general: {
        soundEnabled: true,
        seedCap: 0,
        donationMode: false,
        tpsl: { mode: 'pct', tp: 0, sl: 0 },
        tradingSound: {}
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
    }));
    const oldGeneral = oldSettings.general || {};
    return {
      actions,
      general: {
        soundEnabled: oldGeneral.soundEnabled !== undefined ? oldGeneral.soundEnabled : true,
        seedCap: oldGeneral.seedCap || 0,
        donationMode: false,
        tpsl: { mode: 'pct', tp: 0, sl: 0 },
        tradingSound: {}
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

    let soundData;
    if (isTradingActionContent(action.type)) {
      // Use global trading sound
      const ts = settings.general.tradingSound || {};
      const globalMap = {
        'default': ts.sound,
        'add':     ts.soundAdd     || ts.sound,
        'profit':  ts.soundProfit  || ts.sound,
        'loss':    ts.soundLoss    || ts.sound,
      };
      soundData = globalMap[soundKey] || ts.sound;
    } else {
      // Utility action — use per-action sound
      const soundMap = {
        'default': action.sound,
        'add':     action.soundAdd    || action.sound,
        'profit':  action.soundProfit || action.sound,
        'loss':    action.soundLoss   || action.sound,
      };
      soundData = soundMap[soundKey] || action.sound;
    }

    if (!soundData) return;
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
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
    if (!settings || !licenseActive) return;

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
      const tpsl = settings.general.tpsl || { mode: 'pct', tp: 0, sl: 0 };
      const ctx = {
        pageType:    detectorState.pageType,
        tradingMode: detectorState.tradingMode,
        percentage:  action.percentage,
        ticks:       action.ticks || 100,
        seedCap:     settings.general.seedCap || 0,
        tpsl:        tpsl
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
    // MED-B8: scope to order form — donation text only meaningful on Buy/Sell buttons
    const S = window.OKX_SELECTORS;
    const form = document.querySelector(S.orderForm);
    if (!form) return;
    const buttons = form.querySelectorAll('button');
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

  // ── Settings change listener ──────────────────────────────────────────────

  chrome.storage.onChanged.addListener((changes) => {
    if (!_mainContextAlive()) return; // extension context invalidated
    if (!changes.settings) return;
    const saved = changes.settings.newValue;
    if (!saved) return;

    if (saved.version === 2 && saved.profiles && saved.global) {
      const profileId = detectProfileFromUrl();
      const profile = saved.profiles[profileId] || saved.profiles.btc || {};
      settings = {
        actions: Array.isArray(profile.actions) ? profile.actions : [],
        general: {
          soundEnabled:  saved.global.soundEnabled !== undefined ? saved.global.soundEnabled : true,
          donationMode:  !!saved.global.donationMode,
          seedCap:       profile.seedCap || 0,
          tpsl:          profile.tpsl || { mode: 'pct', tp: 0, sl: 0 },
          tradingSound:  saved.global.tradingSound || {}
        }
      };
    } else {
      settings = {
        actions: Array.isArray(saved.actions) ? saved.actions : [],
        general: { ...getDefaultSettings().general, ...(saved.general || {}) }
      };
    }

    syncDonationMode();
  });

  // ── SPA navigation detection ──────────────────────────────────────────────

  let lastUrl = window.location.href;

  const navObserver = new MutationObserver(() => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      // MED-3: disconnect before heavy work to avoid re-entrant callbacks
      navObserver.disconnect();
      console.log('[OKX Hotkey] SPA navigation detected, re-detecting page...');
      detectorState = OKXDetector.getState();
      if (detectorState.tradingMode === 'unknown' && detectorState.pageType !== 'unknown') {
        startDetectRetry();
      }
      // Reload settings so correct profile is applied for new URL
      loadSettings().then(() => {
        if (settings && settings.general.donationMode) {
          setTimeout(applyDonationMode, 500);
        }
      }).catch(err => console.warn('[OKX Hotkey] settings reload failed', err));
      // Re-attach observer after navigation handling
      navObserver.observe(document.body, { childList: true, subtree: true });
    }
  });

  // ── Init ──────────────────────────────────────────────────────────────────

  async function init() {
    console.log('[OKX Hotkey] Initializing...');
    // MED-B7: start navObserver only after settings loaded to avoid stale-settings race
    await loadSettings().catch(err => console.warn('[OKX Hotkey] settings reload failed', err));

    detectorState = OKXDetector.getState();
    console.log('[OKX Hotkey] Detected:', detectorState);

    if (detectorState.tradingMode === 'unknown' && detectorState.pageType !== 'unknown') {
      startDetectRetry();
    }

    // License check before enabling hotkeys
    const licenseStatus = await checkLicenseStatus();
    applyLicenseState(licenseStatus);

    syncDonationMode();
    navObserver.observe(document.body, { childList: true, subtree: true });

    console.log('[OKX Hotkey] Ready. Page:', detectorState.pageType, '/ Mode:', detectorState.tradingMode);
  }

  init().catch(err => {
    console.error('[OKX Hotkey] Init failed:', err);
  });

})();
