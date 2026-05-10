/**
 * service-worker.js — Extension lifecycle, message relay, and license validation
 */

'use strict';

// Source of truth: src/config.js — values here are substituted at build time
// via the LICENSE_SERVER_URL env var (build.js substituteEnvVars step).
// MV3 service workers run as ES modules and cannot use importScripts,
// so these constants are kept inline and kept in sync with config.js.
const LICENSE_SERVER = 'https://YOUR_DOMAIN_HERE';
const GRACE_PERIOD_MS = 48 * 60 * 60 * 1000; // must match config.js GRACE_PERIOD_MS
// ECDSA P-256 public key — substituted at build time via OKX_HOTKEY_VERIFY_KEY env var
const HOTKEY_VERIFY_KEY_PEM = 'OKX_HOTKEY_VERIFY_KEY_PLACEHOLDER';

// ── Device ID ─────────────────────────────────────────────────────────────────

async function getOrCreateDeviceId() {
  const result = await chrome.storage.local.get('device_id');
  if (result.device_id) return result.device_id;

  // LOW-B12: use stable platform+brand instead of full UA (minor version updates won't break deviceId)
  const raw = [
    navigator.platform || 'unknown',
    navigator.userAgentData?.brands?.[0]?.brand || navigator.userAgent.split(' ')[0],
    screen.width,
    screen.height,
    Intl.DateTimeFormat().resolvedOptions().timeZone
  ].join('|');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const device_id = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  await chrome.storage.local.set({ device_id });
  return device_id;
}

// ── License validation ────────────────────────────────────────────────────────

async function validateLicense() {
  const stored = await chrome.storage.local.get(['license_key', 'device_id', 'license_valid_until']);
  const { license_key, device_id, license_valid_until } = stored;

  if (!license_key) {
    await setLicenseStatus('unregistered');
    return;
  }

  const resolvedDeviceId = device_id || await getOrCreateDeviceId();

  try {
    const res = await fetch(`${LICENSE_SERVER}/hotkey/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key, device_id: resolvedDeviceId })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      const code = errData.detail?.code || 'unknown';
      const statusMap = {
        'LICENSE_INACTIVE':      'revoked',
        'DEVICE_NOT_REGISTERED': 'unregistered',
        'NOT_MEMBER':            'revoked',
      };
      await setLicenseStatus(statusMap[code] || 'revoked');
      return;
    }

    const data = await res.json();

    // MED-B11: strict equality check — truthy data.valid is insufficient
    if (data && data.valid === true) {
      await chrome.storage.local.set({
        license_status:      'active',
        license_valid_until: Date.now() + GRACE_PERIOD_MS,
        license_info: {
          tg_username:  data.tg_username  ?? null,
          device_count: data.device_count ?? null,
          device_limit: data.device_limit ?? null,
        }
      });
      await broadcastLicenseStatus('active');
    } else {
      const allowedStatuses = ['revoked', 'suspended', 'unregistered', 'server_unreachable'];
      const status = (data && typeof data.status === 'string' && allowedStatuses.includes(data.status))
        ? data.status
        : 'revoked';
      await setLicenseStatus(status);
    }
  } catch {
    // Network error — apply grace period
    const validUntil = license_valid_until || 0;
    if (Date.now() < validUntil) {
      await broadcastLicenseStatus('active');
    } else {
      await setLicenseStatus('server_unreachable');
    }
  }
}

async function setLicenseStatus(status) {
  await chrome.storage.local.set({ license_status: status });
  await broadcastLicenseStatus(status);
}

async function broadcastLicenseStatus(status) {
  const tabs = await chrome.tabs.query({ url: '*://www.okx.com/trade-*' });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'LICENSE_STATUS', status }).catch(() => {});
  }
}

// ── Update check ──────────────────────────────────────────────────────────────

function compareVersions(a, b) {
  // Strip leading 'v', split by '.', compare numerically
  const pa = a.replace(/^v/, '').split('.').map(s => parseInt(s, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map(s => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Import ECDSA P-256 public key from PEM (called once, cached in module scope).
let _verifyKeyPromise = null;
function _getVerifyKey() {
  if (!_verifyKeyPromise) {
    _verifyKeyPromise = (async () => {
      try {
        const pem = HOTKEY_VERIFY_KEY_PEM;
        if (!pem || pem === 'OKX_HOTKEY_VERIFY_KEY_PLACEHOLDER') return null;
        // Strip PEM header/footer and decode base64
        const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
        const der  = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        return await crypto.subtle.importKey(
          'spki', der.buffer,
          { name: 'ECDSA', namedCurve: 'P-256' },
          false, ['verify']
        );
      } catch {
        return null;
      }
    })();
  }
  return _verifyKeyPromise;
}

async function _verifySignature(sigB64, canonicalBody) {
  const key = await _getVerifyKey();
  if (!key) return false;
  try {
    const sig  = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
    const data = new TextEncoder().encode(canonicalBody);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, data);
  } catch {
    return false;
  }
}

const _VERSION_RE  = /^v?\d+\.\d+\.\d+(-[\w.]+)?$/;

// Strict download URL allowlist — regex, no prefix matching.
// Rejects: path traversal, query strings, unexpected hosts.
const _DL_PATTERNS = [
  // github.com releases download path
  /^https:\/\/github\.com\/mop824\/okx-hotkey\/releases\/download\/v\d+\.\d+\.\d+\/okx-hotkey-v\d+\.\d+\.\d+\.zip$/,
  // objects.githubusercontent.com redirect (numeric ids + uuid + filename)
  /^https:\/\/objects\.githubusercontent\.com\/github-production-release-asset-[0-9a-f-]+\/\d+\/\d+\/\?/,
  // objects.githubusercontent.com plain path (no query string variant)
  /^https:\/\/objects\.githubusercontent\.com\/[0-9]+\/[0-9]+\/[0-9a-f-]+\/okx-hotkey-v\d+\.\d+\.\d+\.zip$/,
];

function _isAllowedDownloadUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    // Must be HTTPS
    if (parsed.protocol !== 'https:') return false;
    // Host must be exactly one of the two allowed hosts
    if (parsed.host !== 'github.com' && parsed.host !== 'objects.githubusercontent.com') return false;
    // Query strings rejected for github.com (releases/download never needs them)
    if (parsed.host === 'github.com' && parsed.search !== '') return false;
  } catch {
    return false;
  }
  return _DL_PATTERNS.some(re => re.test(url));
}

function _validateUpdateSchema(data) {
  if (typeof data.latest_version !== 'string' || !_VERSION_RE.test(data.latest_version)) return false;
  if (!_isAllowedDownloadUrl(data.download_url)) return false;
  return true;
}

async function checkForUpdate() {
  try {
    const res = await fetch(`${LICENSE_SERVER}/hotkey/latest-version`);
    if (!res.ok) return;

    const rawText = await res.text();
    const sigB64  = res.headers.get('X-Signature');

    // Verify signature: reconstruct canonical JSON (sort_keys) to match server
    if (sigB64) {
      let parsed;
      try { parsed = JSON.parse(rawText); } catch { return; }
      const canonical = JSON.stringify(parsed, Object.keys(parsed).sort());
      const ok = await _verifySignature(sigB64, canonical);
      if (!ok) return; // signature invalid — discard silently
    } else {
      return; // no signature present — reject
    }

    let data;
    try { data = JSON.parse(rawText); } catch { return; }
    if (!_validateUpdateSchema(data)) return;

    await chrome.storage.local.set({
      latest_version: data.latest_version,
      download_url:   data.download_url,
    });

    const current = chrome.runtime.getManifest().version;
    if (compareVersions(data.latest_version, current) > 0) {
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#E53935' });
      const tabs = await chrome.tabs.query({ url: '*://www.okx.com/trade-*' });
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, {
          type:           'SHOW_UPDATE_TOAST',
          latest_version: data.latest_version,
          download_url:   data.download_url,
        }).catch(() => {});
      }
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch {
    // Network failure — silent, retry next alarm
  }
}

// ── Periodic license check ────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'licenseCheck')    await validateLicense();
  if (alarm.name === 'updateCheck')     await checkForUpdate();
  if (alarm.name === 'selectorsRefresh') await fetchSelectors();
});

// ── Install / Update ──────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    console.log('[OKX Hotkey] Extension installed');
  } else if (reason === 'update') {
    console.log('[OKX Hotkey] Extension updated to', chrome.runtime.getManifest().version);
  }
  chrome.alarms.create('licenseCheck',    { periodInMinutes: 720 });
  chrome.alarms.create('updateCheck',     { periodInMinutes: 60 });
  chrome.alarms.create('selectorsRefresh',{ periodInMinutes: 60 });
  validateLicense().catch(err => console.error('[OKX Hotkey] Initial validate failed:', err));
  checkForUpdate();
  fetchSelectors().catch(err => console.error('[OKX Hotkey] Initial selector fetch failed:', err));
});

chrome.runtime.onStartup.addListener(() => {
  validateLicense();
  checkForUpdate();
  fetchSelectors().catch(() => {});
});

// ── Message relay ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'QUERY_STATUS') {
    getActiveOKXTab().then(tab => {
      if (!tab) {
        sendResponse({ ready: false, error: 'No active OKX trade tab found' });
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' }, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ready: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse(response || { ready: false, error: 'No response from content script' });
        }
      });
    });
    return true;
  }

  if (msg.type === 'GET_SELECTORS') {
    getSelectors().then(sel => sendResponse({ selectors: sel })).catch(() => sendResponse({ selectors: null }));
    return true;
  }

  return false;
});

// ── Tab helpers ───────────────────────────────────────────────────────────────

async function getActiveOKXTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || tabs.length === 0) {
        resolve(null);
        return;
      }
      const tab = tabs[0];
      const isOKX = tab.url && tab.url.includes('okx.com/trade-');
      resolve(isOKX ? tab : null);
    });
  });
}
