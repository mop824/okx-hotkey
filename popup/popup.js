/**
 * popup.js — Settings UI logic for OKX Hotkey extension (v2)
 *
 * Handles:
 * - Dynamic action add/remove
 * - Per-action hotkey recording
 * - Per-action sound upload (base64) + preview
 * - General settings: seedCap, soundEnabled, donationMode
 * - Load/save to chrome.storage.local (v2 schema)
 * - Backward-compatible migration from v1 slots schema
 *
 * Storage schema source of truth: DEFAULT_ACTIONS, DEFAULT_GENERAL, and loadSettings() in this file.
 * content/main.js is the other authoritative copy — keep in sync manually.
 */

'use strict';

// ── Action type definitions ───────────────────────────────────────────────────

const ACTION_TYPES = [
  { type: 'MARKET_BUY',    label: '시장가 매수',      hasPct: true  },
  { type: 'MARKET_SELL',   label: '시장가 매도',      hasPct: true  },
  { type: 'LIMIT_BUY',     label: '지정가 매수',      hasPct: true  },
  { type: 'LIMIT_SELL',    label: '지정가 매도',      hasPct: true  },
  { type: 'TICK_BUY',      label: '틱 매수',          hasPct: true, hasTicks: true  },
  { type: 'TICK_SELL',     label: '틱 매도',          hasPct: true, hasTicks: true  },
  { type: 'PARTIAL_CLOSE', label: '부분 청산',        hasPct: true  },
  { type: 'CLOSE_PAIR',    label: '페어 청산',        hasPct: false },
  { type: 'CLOSE_ALL',     label: '전체 청산',        hasPct: false },
  { type: 'FLIP',          label: '포지션 반전',      hasPct: false },
  { type: 'CANCEL_LAST',   label: '마지막 주문 취소', hasPct: false },
  { type: 'CANCEL_ALL',    label: '전체 주문 취소',   hasPct: false },
  { type: 'CHASE_ORDER',   label: '주문 체이스',      hasPct: false },
];

const DEFAULT_GENERAL = {
  soundEnabled: true,
  seedCap: 0,
  donationMode: false
};

const DEFAULT_ACTIONS = [
  {
    id: 'init_mktbuy',
    type: 'MARKET_BUY',
    label: '시장가 매수',
    hotkey: { key: '1', ctrl: true, shift: true, alt: false },
    percentage: 5,
    sound: null,
    soundName: null
  },
  {
    id: 'init_mktsell',
    type: 'MARKET_SELL',
    label: '시장가 매도',
    hotkey: { key: '2', ctrl: true, shift: true, alt: false },
    percentage: 5,
    sound: null,
    soundName: null
  },
  {
    id: 'init_closeall',
    type: 'CLOSE_ALL',
    label: '전체 청산',
    hotkey: { key: 'c', ctrl: true, shift: true, alt: false },
    percentage: 100,
    sound: null,
    soundName: null
  }
];

// ── State ─────────────────────────────────────────────────────────────────────

let currentActions = [];     // Array of action objects (in-memory, mirrors DOM)
let recordingId = null;      // ID of the action card currently recording a hotkey

// ── Utilities ─────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ── Hotkey formatting ──────────────────────────────────────────────────────────

function formatHotkey(hotkey) {
  if (!hotkey || !hotkey.key) return '(없음)';
  const parts = [];
  if (hotkey.ctrl)  parts.push('Ctrl');
  if (hotkey.shift) parts.push('Shift');
  if (hotkey.alt)   parts.push('Alt');
  parts.push(hotkey.key.toUpperCase());
  return parts.join('+');
}

function eventToHotkey(e) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  if (!e.ctrlKey && !e.shiftKey && !e.altKey) return null;
  return {
    key:   e.key.toLowerCase(),
    ctrl:  e.ctrlKey,
    shift: e.shiftKey,
    alt:   e.altKey
  };
}

// ── Action card rendering ──────────────────────────────────────────────────────

/**
 * Build and return a single action card element.
 * @param {object} action
 * @returns {HTMLElement}
 */
function renderActionCard(action) {
  const typeDef = ACTION_TYPES.find(t => t.type === action.type) || { hasPct: true, hasTicks: false };

  const card = document.createElement('div');
  card.className = 'action-card';
  card.dataset.id = action.id;
  card.draggable = true;

  // Drag events
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', action.id);
    // Defer adding class so the drag image captures the normal look
    requestAnimationFrame(() => card.classList.add('dragging'));
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    document.querySelectorAll('.action-card.drag-over').forEach(el => el.classList.remove('drag-over'));
  });
  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.action-card.drag-over').forEach(el => el.classList.remove('drag-over'));
    card.classList.add('drag-over');
  });
  card.addEventListener('dragleave', (e) => {
    // Only remove if leaving to outside this card
    if (!card.contains(e.relatedTarget)) {
      card.classList.remove('drag-over');
    }
  });
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.classList.remove('drag-over');
    const draggedId = e.dataTransfer.getData('text/plain');
    if (draggedId === action.id) return;

    const list = $('actions-list');
    const draggedCard = list.querySelector(`[data-id="${draggedId}"]`);
    if (!draggedCard) return;

    // Determine insert position: if mouse is in the bottom half of target, insert after
    const rect = card.getBoundingClientRect();
    const insertAfter = e.clientY > rect.top + rect.height / 2;

    if (insertAfter) {
      card.after(draggedCard);
    } else {
      card.before(draggedCard);
    }

    // Sync currentActions order to match DOM
    const newOrder = Array.from(list.querySelectorAll('.action-card')).map(c => c.dataset.id);
    currentActions.sort((a, b) => newOrder.indexOf(a.id) - newOrder.indexOf(b.id));
  });

  // Top row
  const row = document.createElement('div');
  row.className = 'action-card__row';

  // Drag handle
  const handleEl = document.createElement('span');
  handleEl.className = 'drag-handle';
  handleEl.textContent = '\u22EE\u22EE'; // ⋮⋮
  handleEl.title = '드래그하여 순서 변경';
  // Prevent handle drag from triggering hotkey recording or other clicks
  handleEl.addEventListener('mousedown', (e) => e.stopPropagation());

  // Label
  const labelEl = document.createElement('span');
  labelEl.className = 'action-card__label';
  labelEl.textContent = action.label;

  // Hotkey input
  const hotkeyEl = document.createElement('div');
  hotkeyEl.className = 'hotkey-input';
  hotkeyEl.tabIndex = 0;
  hotkeyEl.textContent = formatHotkey(action.hotkey);
  hotkeyEl.dataset.hotkey = JSON.stringify(action.hotkey || {});
  hotkeyEl.title = '클릭 후 키 입력';

  hotkeyEl.addEventListener('click', () => startRecording(action.id, hotkeyEl));
  hotkeyEl.addEventListener('keydown', (e) => {
    if (recordingId === action.id) {
      e.preventDefault();
      e.stopPropagation();
      const hk = eventToHotkey(e);
      if (hk) stopRecording(action.id, hotkeyEl, hk);
    } else if (e.key === 'Enter' || e.key === ' ') {
      startRecording(action.id, hotkeyEl);
    }
  });
  hotkeyEl.addEventListener('blur', () => {
    if (recordingId === action.id) cancelRecording(action.id, hotkeyEl);
  });

  // Percentage wrapper
  const pctWrapper = document.createElement('div');
  pctWrapper.className = 'pct-wrapper' + (typeDef.hasPct ? '' : ' pct-wrapper--hidden');

  const pctInput = document.createElement('input');
  pctInput.type = 'number';
  pctInput.className = 'pct-input';
  pctInput.min = 1;
  pctInput.max = 100;
  pctInput.step = 1;
  pctInput.value = typeDef.hasPct ? (action.percentage || 5) : 0;

  const pctUnit = document.createElement('span');
  pctUnit.className = 'pct-unit';
  pctUnit.textContent = '%';

  pctWrapper.appendChild(pctInput);
  pctWrapper.appendChild(pctUnit);

  // Ticks wrapper (for TICK_BUY / TICK_SELL only)
  const ticksWrapper = document.createElement('div');
  ticksWrapper.className = 'ticks-wrapper' + (typeDef.hasTicks ? '' : ' ticks-wrapper--hidden');

  const ticksInput = document.createElement('input');
  ticksInput.type = 'number';
  ticksInput.className = 'ticks-input';
  ticksInput.min = 1;
  ticksInput.max = 10;
  ticksInput.step = 1;
  ticksInput.value = typeDef.hasTicks ? (action.ticks || 1) : 1;

  const ticksUnit = document.createElement('span');
  ticksUnit.className = 'ticks-unit';
  ticksUnit.textContent = '틱';

  ticksWrapper.appendChild(ticksInput);
  ticksWrapper.appendChild(ticksUnit);

  // Sound controls (upload + play)
  const soundControls = document.createElement('div');
  soundControls.className = 'sound-controls';

  const uploadBtn = document.createElement('button');
  uploadBtn.className = 'btn-icon' + (action.sound ? ' has-sound' : '');
  uploadBtn.title = action.soundName || '소리 업로드 (mp3/wav/ogg)';
  uploadBtn.textContent = '🔊';

  const playBtn = document.createElement('button');
  playBtn.className = 'btn-icon';
  playBtn.title = '소리 미리 듣기';
  playBtn.textContent = '▶';
  playBtn.style.display = action.sound ? '' : 'none';

  // Hidden file input for sound upload
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'audio/mp3,audio/wav,audio/ogg,audio/*';
  fileInput.style.display = 'none';

  uploadBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;

    if (file.size > 1024 * 1024) {
      showFeedback('경고: 파일이 1MB를 초과합니다. 저장되지만 느릴 수 있습니다.', 'error');
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      // Update in-memory action
      const idx = currentActions.findIndex(a => a.id === action.id);
      if (idx !== -1) {
        currentActions[idx].sound = dataUrl;
        currentActions[idx].soundName = file.name;
      }
      // Update this card's action reference too (for preview)
      action.sound = dataUrl;
      action.soundName = file.name;

      uploadBtn.classList.add('has-sound');
      uploadBtn.title = file.name;
      playBtn.style.display = '';
      updateSoundName(card, file.name);
    };
    reader.readAsDataURL(file);
    fileInput.value = '';
  });

  playBtn.addEventListener('click', () => {
    if (!action.sound) return;
    try {
      new Audio(action.sound).play().catch(err => {
        showFeedback(`소리 재생 오류: ${err.message}`, 'error');
      });
    } catch (err) {
      showFeedback(`소리 재생 오류: ${err.message}`, 'error');
    }
  });

  soundControls.appendChild(uploadBtn);
  soundControls.appendChild(playBtn);
  soundControls.appendChild(fileInput);

  // Delete button
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn-icon btn-delete';
  deleteBtn.title = '삭제';
  deleteBtn.textContent = '✕';
  deleteBtn.addEventListener('click', () => removeAction(action.id));

  row.appendChild(handleEl);
  row.appendChild(labelEl);
  row.appendChild(hotkeyEl);
  row.appendChild(pctWrapper);
  row.appendChild(ticksWrapper);
  row.appendChild(soundControls);
  row.appendChild(deleteBtn);

  card.appendChild(row);

  // Sound name display (if already has a sound)
  if (action.soundName) {
    const nameEl = document.createElement('div');
    nameEl.className = 'action-card__sound-name';
    nameEl.textContent = `🔊 ${action.soundName}`;
    card.appendChild(nameEl);
  }

  return card;
}

/**
 * Update (or add) the sound name bar on an existing card.
 */
function updateSoundName(card, soundName) {
  let nameEl = card.querySelector('.action-card__sound-name');
  if (!nameEl) {
    nameEl = document.createElement('div');
    nameEl.className = 'action-card__sound-name';
    card.appendChild(nameEl);
  }
  nameEl.textContent = soundName ? `🔊 ${soundName}` : '';
}

// ── Hotkey recording ──────────────────────────────────────────────────────────

function startRecording(actionId, el) {
  // Cancel any existing recording
  if (recordingId && recordingId !== actionId) {
    const prevCard = $('actions-list').querySelector(`[data-id="${recordingId}"]`);
    if (prevCard) {
      const prevEl = prevCard.querySelector('.hotkey-input');
      if (prevEl) cancelRecording(recordingId, prevEl);
    }
  }
  recordingId = actionId;
  el.classList.add('recording');
  el.textContent = '키 입력...';
  el.focus();
}

function stopRecording(actionId, el, hotkey) {
  recordingId = null;
  el.classList.remove('recording');
  el.dataset.hotkey = JSON.stringify(hotkey);
  el.textContent = formatHotkey(hotkey);
}

function cancelRecording(actionId, el) {
  recordingId = null;
  el.classList.remove('recording');
  try {
    const hk = JSON.parse(el.dataset.hotkey);
    el.textContent = formatHotkey(hk);
  } catch {
    el.textContent = '(없음)';
  }
}

// ── Actions list rendering ─────────────────────────────────────────────────────

function renderActionsList() {
  const list = $('actions-list');
  list.innerHTML = '';

  for (const action of currentActions) {
    list.appendChild(renderActionCard(action));
  }

  updateEmptyState();
}

function updateEmptyState() {
  const isEmpty = currentActions.length === 0;
  $('actions-empty').style.display = isEmpty ? '' : 'none';
  $('actions-list').style.display  = isEmpty ? 'none' : '';
}

// ── Add / Remove actions ───────────────────────────────────────────────────────

function addAction(typeDef) {
  const newAction = {
    id:         generateId(),
    type:       typeDef.type,
    label:      typeDef.label,
    hotkey:     { key: '', ctrl: false, shift: false, alt: false },
    percentage: typeDef.hasPct ? 5 : 0,
    ticks:      typeDef.hasTicks ? 1 : 0,
    sound:      null,
    soundName:  null
  };
  currentActions.push(newAction);
  const card = renderActionCard(newAction);
  const list = $('actions-list');
  list.appendChild(card);
  updateEmptyState();
  // Scroll to the new card
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function removeAction(actionId) {
  currentActions = currentActions.filter(a => a.id !== actionId);
  const card = $('actions-list').querySelector(`[data-id="${actionId}"]`);
  if (card) card.remove();
  updateEmptyState();
}

// ── Modal (action type picker) ─────────────────────────────────────────────────

function openModal() {
  $('modal-backdrop').style.display = 'flex';
}

function closeModal() {
  $('modal-backdrop').style.display = 'none';
}

function buildModalGrid() {
  const grid = $('action-type-grid');
  grid.innerHTML = '';
  for (const typeDef of ACTION_TYPES) {
    const btn = document.createElement('button');
    btn.className = 'action-type-btn';
    btn.textContent = typeDef.label;
    btn.addEventListener('click', () => {
      closeModal();
      addAction(typeDef);
    });
    grid.appendChild(btn);
  }
}

// ── Collect values from DOM ────────────────────────────────────────────────────

/**
 * Reads latest hotkey + pct values from each card DOM element,
 * merges with currentActions (which already has sound data), and returns array.
 */
function collectActions() {
  const list = $('actions-list');
  const cards = list.querySelectorAll('.action-card');
  return Array.from(cards).map(card => {
    const id = card.dataset.id;
    const existing = currentActions.find(a => a.id === id) || {};

    const hotkeyEl = card.querySelector('.hotkey-input');
    let hotkey = { key: '', ctrl: false, shift: false, alt: false };
    try { hotkey = JSON.parse(hotkeyEl.dataset.hotkey); } catch {}

    const pctInput = card.querySelector('.pct-input');
    const rawPct = pctInput ? (parseInt(pctInput.value, 10) || 0) : 0;
    const actionTypeDef = ACTION_TYPES.find(t => t.type === (existing.type || '')) || { hasPct: true, hasTicks: false };
    const percentage = actionTypeDef.hasPct ? rawPct : 0;

    const ticksInput = card.querySelector('.ticks-input');
    const rawTicks = ticksInput ? (parseInt(ticksInput.value, 10) || 1) : 0;
    const ticks = actionTypeDef.hasTicks ? Math.max(1, Math.min(10, rawTicks)) : 0;

    return {
      id:        id,
      type:      existing.type || '',
      label:     existing.label || '',
      hotkey:    hotkey,
      percentage: percentage,
      ticks:     ticks,
      sound:     existing.sound || null,
      soundName: existing.soundName || null
    };
  });
}

function collectGeneral() {
  return {
    soundEnabled:  $('sound-enabled').checked,
    seedCap:       parseFloat($('seed-cap').value) || 0,
    donationMode:  $('donation-mode').checked
  };
}

// ── Populate DOM from settings ─────────────────────────────────────────────────

function populateGeneral(general) {
  $('seed-cap').value        = general.seedCap !== undefined ? general.seedCap : 0;
  $('sound-enabled').checked = !!general.soundEnabled;
  $('donation-mode').checked = !!general.donationMode;
}

// ── Storage operations ────────────────────────────────────────────────────────

async function loadSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(['settings'], result => {
      const saved = result.settings;

      if (!saved) {
        resolve({
          actions: DEFAULT_ACTIONS.map(a => ({ ...a })),
          general: { ...DEFAULT_GENERAL }
        });
        return;
      }

      // Migrate v1 slots → v2 actions
      if (saved.slots && !saved.actions) {
        const actions = saved.slots.map(slot => ({
          id:         generateId(),
          type:       slot.id,
          label:      slot.label || slot.id,
          hotkey:     slot.hotkey || { key: '', ctrl: false, shift: false, alt: false },
          percentage: slot.percentage || 0,
          sound:      null,
          soundName:  null
        }));
        const oldGeneral = saved.general || {};
        const migratedResult = {
          actions,
          general: {
            soundEnabled: oldGeneral.soundEnabled !== undefined ? oldGeneral.soundEnabled : true,
            seedCap:      oldGeneral.seedCap || 0,
            donationMode: false
          }
        };
        chrome.storage.local.set({ settings: migratedResult });
        resolve(migratedResult);
        return;
      }

      resolve({
        actions: Array.isArray(saved.actions) ? saved.actions : [],
        general: { ...DEFAULT_GENERAL, ...(saved.general || {}) }
      });
    });
  });
}

async function saveSettings(settings) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ settings }, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}

// ── Status query ──────────────────────────────────────────────────────────────

function queryStatus() {
  const dot  = document.querySelector('.status-dot');
  const text = document.querySelector('.status-text');
  const info = $('page-info');

  chrome.runtime.sendMessage({ type: 'QUERY_STATUS' }, (response) => {
    if (chrome.runtime.lastError || !response) {
      dot.className   = 'status-dot disconnected';
      text.textContent = 'OKX 탭 없음';
      info.style.display = 'none';
      return;
    }
    if (response.ready) {
      dot.className   = 'status-dot connected';
      text.textContent = '연결됨';
      info.style.display = 'flex';
      $('page-type-label').textContent    = response.pageType === 'spot' ? '현물' : '선물/스왑';
      $('trading-mode-label').textContent = response.tradingMode === 'hedge' ? '헤지 모드'
        : response.tradingMode === 'one-way' ? '단방향 모드'
        : response.tradingMode;
    } else {
      dot.className   = 'status-dot disconnected';
      text.textContent = '콘텐츠 스크립트 없음';
      info.style.display = 'none';
    }
  });
}

// ── Feedback ──────────────────────────────────────────────────────────────────

function showFeedback(message, type = 'success') {
  const el = $('feedback');
  el.textContent = message;
  el.className = `feedback ${type}`;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 2800);
}

// ── Global keydown (hotkey recording capture) ─────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (!recordingId) return;
  e.preventDefault();
  e.stopImmediatePropagation();

  const hk = eventToHotkey(e);
  if (!hk) return;

  const card = $('actions-list').querySelector(`[data-id="${recordingId}"]`);
  if (card) {
    const hotkeyEl = card.querySelector('.hotkey-input');
    if (hotkeyEl) stopRecording(recordingId, hotkeyEl, hk);
  }
}, true);

// Cancel recording on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && recordingId) {
    const card = $('actions-list').querySelector(`[data-id="${recordingId}"]`);
    if (card) {
      const hotkeyEl = card.querySelector('.hotkey-input');
      if (hotkeyEl) cancelRecording(recordingId, hotkeyEl);
    }
  }
});

// ── Button event listeners ────────────────────────────────────────────────────

$('btn-add-action').addEventListener('click', openModal);
$('modal-cancel').addEventListener('click', closeModal);
$('modal-backdrop').addEventListener('click', (e) => {
  if (e.target === $('modal-backdrop')) closeModal();
});

$('btn-save').addEventListener('click', async () => {
  try {
    const settings = {
      actions: collectActions(),
      general: collectGeneral()
    };

    // W3: Storage quota guard (~8MB limit)
    if (JSON.stringify(settings).length > 8_000_000) {
      showFeedback('저장 실패: 음원 파일이 너무 큽니다. 일부 소리를 제거하세요.', 'error');
      return;
    }

    // M3: Duplicate hotkey detection (warning only, does not block save)
    const combos = settings.actions
      .map(a => a.hotkey && a.hotkey.key ? formatHotkey(a.hotkey) : null)
      .filter(c => c && c !== '(없음)');
    const seen = new Set();
    const duplicates = new Set();
    for (const combo of combos) {
      if (seen.has(combo)) duplicates.add(combo);
      else seen.add(combo);
    }
    if (duplicates.size > 0) {
      showFeedback(`중복 단축키가 있습니다: ${[...duplicates].join(', ')}`, 'error');
    }

    // Sync currentActions with collected (ensures sound data is preserved)
    currentActions = settings.actions;
    await saveSettings(settings);
    if (duplicates.size === 0) showFeedback('설정 저장 완료', 'success');
  } catch (err) {
    showFeedback(`저장 실패: ${err.message}`, 'error');
  }
});


// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  buildModalGrid();

  const settings = await loadSettings();
  currentActions = settings.actions;
  renderActionsList();
  populateGeneral(settings.general);
  queryStatus();
}

init();
