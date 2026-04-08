/**
 * overlay.js — Toast notification overlay for action feedback
 *
 * Non-intrusive bottom-right notifications:
 * - Green for success, red for failure
 * - Auto-dismiss after 2000ms (hard-coded)
 * - Doesn't block trading UI
 */

window.OKXOverlay = (() => {
  const CONTAINER_ID = 'okx-hotkey-overlay';
  const OVERLAY_DURATION = 2000; // ms, hard-coded

  /**
   * Ensure the toast container exists in the DOM.
   * @returns {HTMLElement}
   */
  function ensureContainer() {
    let container = document.getElementById(CONTAINER_ID);
    if (!container) {
      container = document.createElement('div');
      container.id = CONTAINER_ID;
      document.body.appendChild(container);
    }
    return container;
  }

  /**
   * Show a toast notification.
   * @param {string} message — Main text
   * @param {'info'|'success'|'error'|'loading'} type
   * @param {number} [duration] — Override duration in ms (0 = no auto-dismiss)
   * @returns {HTMLElement} The toast element (to update later)
   */
  function show(message, type = 'info', duration) {
    const container = ensureContainer();
    const toast = document.createElement('div');
    toast.className = `okx-hotkey-toast okx-hotkey-toast--${type}`;

    const icon = document.createElement('span');
    icon.className = 'okx-hotkey-toast__icon';
    icon.textContent = type === 'success' ? '✓'
      : type === 'error' ? '✗'
      : type === 'loading' ? '⟳'
      : 'ℹ';

    const text = document.createElement('span');
    text.className = 'okx-hotkey-toast__text';
    text.textContent = message;

    toast.appendChild(icon);
    toast.appendChild(text);
    container.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
      toast.classList.add('okx-hotkey-toast--visible');
    });

    // Auto-dismiss
    const dismissAfter = duration !== undefined ? duration : OVERLAY_DURATION;
    if (dismissAfter > 0) {
      setTimeout(() => dismiss(toast), dismissAfter);
    }

    return toast;
  }

  /**
   * Update an existing toast's message and type.
   * @param {HTMLElement} toast
   * @param {string} message
   * @param {'info'|'success'|'error'|'loading'} type
   * @param {number} [duration] — auto-dismiss after update (default: OVERLAY_DURATION)
   */
  function update(toast, message, type, duration) {
    if (!toast || !toast.parentNode) return;

    toast.className = `okx-hotkey-toast okx-hotkey-toast--${type} okx-hotkey-toast--visible`;

    const icon = toast.querySelector('.okx-hotkey-toast__icon');
    const text = toast.querySelector('.okx-hotkey-toast__text');

    if (icon) {
      icon.textContent = type === 'success' ? '✓'
        : type === 'error' ? '✗'
        : type === 'loading' ? '⟳'
        : 'ℹ';
    }
    if (text) text.textContent = message;

    const dismissAfter = duration !== undefined ? duration : OVERLAY_DURATION;
    if (dismissAfter > 0) {
      setTimeout(() => dismiss(toast), dismissAfter);
    }
  }

  /**
   * Dismiss (fade out + remove) a toast.
   * @param {HTMLElement} toast
   */
  function dismiss(toast) {
    if (!toast || !toast.parentNode) return;
    toast.classList.remove('okx-hotkey-toast--visible');
    toast.classList.add('okx-hotkey-toast--hiding');
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300); // match CSS transition
  }

  /**
   * Show a success + auto-dismiss toast.
   */
  function success(message) {
    return show(message, 'success');
  }

  /**
   * Show an error + auto-dismiss toast.
   */
  function error(message) {
    return show(message, 'error');
  }

  /**
   * Show a loading toast (no auto-dismiss). Returns element to update later.
   */
  function loading(message) {
    return show(message, 'loading', 0);
  }

  return { show, update, dismiss, success, error, loading };
})();
