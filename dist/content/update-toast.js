/**
 * update-toast.js — 업데이트 알림 토스트 (우하단 카드)
 *
 * 표시 조건:
 *   1. SHOW_UPDATE_TOAST 메시지 수신 시
 *   2. 페이지 로드 시 storage에 latest_version 있고 dismissed_version과 다를 때
 *
 * 닫기: dismissed_version 저장 → 같은 버전 재표시 안 함
 * 받기: download_url을 새 탭으로 오픈
 */

;(function OKXUpdateToast() {
  'use strict';

  const TOAST_ID = 'okx-hotkey-update-toast';

  // ── Context guard ─────────────────────────────────────────────────────────
  function _toastContextAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  function removeExisting() {
    const el = document.getElementById(TOAST_ID);
    if (el) el.parentNode.removeChild(el);
  }

  function showToast(latestVersion, downloadUrl) {
    removeExisting();

    const host = document.createElement('div');
    host.id = TOAST_ID;

    // Shadow DOM으로 OKX 페이지 스타일 충돌 차단
    const shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      :host-context(body) {}
      .wrap {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 2147483647;
        background: #1e1e2e;
        color: #e0e0e0;
        border: 1px solid #3a3a5c;
        border-radius: 10px;
        padding: 14px 16px;
        display: flex;
        align-items: flex-start;
        gap: 10px;
        min-width: 240px;
        max-width: 320px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        font-family: -apple-system, sans-serif;
        font-size: 13px;
        line-height: 1.4;
        animation: slide-in 0.25s ease;
      }
      @keyframes slide-in {
        from { opacity: 0; transform: translateY(12px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .icon { font-size: 18px; flex-shrink: 0; margin-top: 1px; }
      .body { flex: 1; }
      .msg  { margin-bottom: 10px; font-weight: 500; }
      .actions { display: flex; gap: 8px; }
      .btn-dl {
        background: #4f5bd5;
        color: #fff;
        border: none;
        border-radius: 6px;
        padding: 5px 12px;
        font-size: 12px;
        cursor: pointer;
        font-family: inherit;
      }
      .btn-dl:hover { background: #3a46c0; }
      .btn-close {
        background: none;
        border: 1px solid #555;
        border-radius: 6px;
        color: #aaa;
        padding: 5px 10px;
        font-size: 12px;
        cursor: pointer;
        font-family: inherit;
      }
      .btn-close:hover { background: #2a2a3e; }
    `;

    const wrap = document.createElement('div');
    wrap.className = 'wrap';

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = '🔔';

    const body = document.createElement('div');
    body.className = 'body';

    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = `새 버전 ${latestVersion} 떴어`;

    const actions = document.createElement('div');
    actions.className = 'actions';

    const btnDl = document.createElement('button');
    btnDl.className = 'btn-dl';
    btnDl.textContent = '받기';
    const SAFE = /^https:\/\/(github\.com\/mop824\/okx-hotkey\/|objects\.githubusercontent\.com\/)/;
    btnDl.addEventListener('click', () => {
      if (downloadUrl && SAFE.test(downloadUrl)) window.open(downloadUrl, '_blank');
    });

    const btnClose = document.createElement('button');
    btnClose.className = 'btn-close';
    btnClose.textContent = '✕';
    btnClose.addEventListener('click', () => {
      if (_toastContextAlive()) {
        try { chrome.storage.local.set({ dismissed_version: latestVersion }); } catch (_) { /* extension context invalidated */ }
      }
      removeExisting();
    });

    actions.appendChild(btnDl);
    actions.appendChild(btnClose);
    body.appendChild(msg);
    body.appendChild(actions);
    wrap.appendChild(icon);
    wrap.appendChild(body);
    shadow.appendChild(style);
    shadow.appendChild(wrap);
    document.body.appendChild(host);
  }

  // 페이지 로드 시 storage 체크
  if (_toastContextAlive()) {
    try {
      chrome.storage.local.get(['latest_version', 'download_url', 'dismissed_version'], (result) => {
        const { latest_version, download_url, dismissed_version } = result;
        if (!latest_version) return;
        if (latest_version === dismissed_version) return;
        // content script도 manifest 버전 접근 가능 — SW 비교를 재확인
        try {
          const current = chrome.runtime.getManifest().version;
          const la = latest_version.replace(/^v/, '').split('.').map(s => parseInt(s, 10) || 0);
          const lb = current.replace(/^v/, '').split('.').map(s => parseInt(s, 10) || 0);
          let newer = false;
          for (let i = 0; i < Math.max(la.length, lb.length); i++) {
            const diff = (la[i] || 0) - (lb[i] || 0);
            if (diff > 0) { newer = true; break; }
            if (diff < 0) break;
          }
          if (newer) showToast(latest_version, download_url);
        } catch (_) {
          // Extension context 무효 — 표시 건너뜀
        }
      });
    } catch (_) { /* extension context invalidated */ }
  }

  // SW로부터 메시지 수신
  chrome.runtime.onMessage.addListener((msg, sender) => {
    try {
      if (sender.id !== chrome.runtime.id) return;
    } catch (_) {
      return;
    }
    if (msg.type === 'SHOW_UPDATE_TOAST') {
      showToast(msg.latest_version, msg.download_url);
    }
  });

})();
