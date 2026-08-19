/* =========================================================================
   UI primitives: icons, toasts, modals, and the price-cell binder that keeps
   streaming numbers cheap to update.
   ========================================================================= */
(function (PT) {
  'use strict';

  const U = PT.util;
  const el = U.el;

  /* --------------------------------------------------------------- icons */
  /* 20px stroke icons, inlined so the app needs no icon font or sprite. */
  const ICON_PATHS = {
    trade: 'M3 17l5-6 4 4 5-8 4 5',
    portfolio: 'M3 6h18v12H3zM3 10h18M8 6V4h8v2',
    orders: 'M4 6h16M4 12h16M4 18h10',
    ai: 'M12 3l2.2 5.3L20 10l-5.8 1.7L12 17l-2.2-5.3L4 10l5.8-1.7z',
    compare: 'M4 19V9M10 19V5M16 19v-7M22 19h-20',
    settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-2.9 1.2v.2a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.6 1.7 1.7 0 00-1.9.4l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00-1.2-2.9h-.2a2 2 0 110-4h.1a1.7 1.7 0 001.6-1.1 1.7 1.7 0 00-.4-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3h.1a1.7 1.7 0 001-1.5v-.2a2 2 0 114 0v.1a1.7 1.7 0 001 1.6 1.7 1.7 0 001.9-.4l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9v.1a1.7 1.7 0 001.5 1h.2a2 2 0 110 4h-.1a1.7 1.7 0 00-1.6 1z',
    search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3',
    close: 'M18 6L6 18M6 6l12 12',
    plus: 'M12 5v14M5 12h14',
    check: 'M20 6L9 17l-5-5',
    alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L14.7 3.9a2 2 0 00-3.4 0z',
    trending: 'M23 6l-9.5 9.5-5-5L1 18M17 6h6v6',
    wallet: 'M20 12V8H6a2 2 0 010-4h12v4M4 6v12a2 2 0 002 2h14v-4M18 12a2 2 0 000 4h4v-4z',
    clock: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2',
    refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0114.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0020.5 15',
    send: 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z',
    info: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 16v-4M12 8h.01',
  };

  function icon(name, size = 18) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICON_PATHS[name] || ICON_PATHS.info);
    svg.appendChild(path);
    return svg;
  }

  /* -------------------------------------------------------------- toasts */

  function toast({ title, message, kind = 'info', timeout = 4200 }) {
    const host = document.getElementById('toasts');
    if (!host) return;
    const node = el('div', { class: `toast toast--${kind}` }, [
      el('div', { class: 'toast__body' }, [
        el('div', { class: 'toast__title', text: title }),
        message ? el('div', { class: 'toast__msg', text: message }) : null,
      ]),
    ]);
    host.appendChild(node);
    const close = () => {
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), 200);
    };
    node.addEventListener('click', close);
    if (timeout) setTimeout(close, timeout);
    // Keep the stack shallow enough to stay readable.
    while (host.children.length > 4) host.firstChild.remove();
  }

  /* -------------------------------------------------------------- modals */

  let openModal = null;

  function modal({ title, body, actions, width, onClose }) {
    closeModal();
    const scrim = el('div', { class: 'scrim' });
    const box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    if (width) box.style.width = `min(${width}px, calc(100vw - 32px))`;

    const closeBtn = el('button', { class: 'btn btn--ghost btn--icon', title: 'Close', 'aria-label': 'Close' }, icon('close', 16));
    box.appendChild(el('div', { class: 'modal__head' }, [
      el('div', { class: 'modal__title', text: title }), closeBtn,
    ]));
    box.appendChild(el('div', { class: 'modal__body' }, body));
    if (actions && actions.length) box.appendChild(el('div', { class: 'modal__foot' }, actions));

    document.body.appendChild(scrim);
    document.body.appendChild(box);

    const dismiss = () => { closeModal(); if (onClose) onClose(); };
    closeBtn.addEventListener('click', dismiss);
    scrim.addEventListener('click', dismiss);
    openModal = { scrim, box, dismiss };

    // Focus the first interactive control for keyboard users.
    const focusable = box.querySelector('input, select, textarea, button.btn--primary');
    if (focusable) setTimeout(() => focusable.focus(), 50);
    return openModal;
  }

  function closeModal() {
    if (!openModal) return;
    openModal.scrim.remove();
    openModal.box.remove();
    openModal = null;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openModal) openModal.dismiss();
  });

  /* ------------------------------------------------------- price binding */

  /**
   * Streaming price cells are updated directly rather than re-rendered, and
   * flashes are coalesced so a fast tape cannot strobe.
   */
  const FLASH_MIN_GAP = 120;

  const FLASH_CLASSES = ['is-up-a', 'is-up-b', 'is-down-a', 'is-down-b'];

  function makePriceCell(className) {
    const node = el('span', { class: (className || '') + ' tick num' });
    node._lastRendered = null;
    node._lastFlash = 0;
    node._flashPhase = 0;
    return node;
  }

  function setPrice(node, value, formatter) {
    if (!node) return;
    const text = (formatter || U.fmtUSD)(value);
    if (node.textContent === text) return;

    const prev = node._lastRendered;
    node.textContent = text;
    node._lastRendered = value;

    if (prev == null || !isFinite(prev) || !isFinite(value) || value === prev) return;
    const now = Date.now();
    if (now - node._lastFlash < FLASH_MIN_GAP) return;
    node._lastFlash = now;

    // Alternate between two identical rules so a rapid re-tick restarts the
    // animation without forcing a synchronous layout.
    node._flashPhase = node._flashPhase ? 0 : 1;
    const cls = (value > prev ? 'is-up-' : 'is-down-') + (node._flashPhase ? 'a' : 'b');
    node.classList.remove(...FLASH_CLASSES);
    node.classList.add(cls);
    clearTimeout(node._flashTimer);
    node._flashTimer = setTimeout(() => node.classList.remove(cls), 470);
  }

  /** Freshness badge derived from a quote's own grade. */
  function statusBadge(grade, source) {
    const map = {
      live: { cls: 'badge--live', text: 'Live' },
      delayed: { cls: 'badge--delayed', text: 'Delayed' },
      cached: { cls: 'badge--delayed', text: 'Cached' },
      stale: { cls: 'badge--delayed', text: 'Stale' },
      loading: { cls: 'badge--closed', text: 'Connecting' },
      none: { cls: 'badge--closed', text: 'No data' },
    };
    const m = map[grade] || map.none;
    const node = el('span', { class: `badge ${m.cls}`, title: source ? `Source: ${source}` : '' }, [
      el('span', { class: 'dot' + (grade === 'live' ? ' dot--pulse' : '') }),
      m.text,
    ]);
    return node;
  }

  /* ------------------------------------------------------------- tooltip */

  let tipNode = null;
  function showTip(target, text) {
    hideTip();
    tipNode = el('div', { class: 'tip', text });
    document.body.appendChild(tipNode);
    const r = target.getBoundingClientRect();
    const t = tipNode.getBoundingClientRect();
    tipNode.style.left = U.clamp(r.left + r.width / 2 - t.width / 2, 6, window.innerWidth - t.width - 6) + 'px';
    tipNode.style.top = (r.top - t.height - 6 < 6 ? r.bottom + 6 : r.top - t.height - 6) + 'px';
  }
  function hideTip() { if (tipNode) { tipNode.remove(); tipNode = null; } }

  function bindTip(node, text) {
    let timer;
    node.addEventListener('mouseenter', () => { timer = setTimeout(() => showTip(node, text), 380); });
    node.addEventListener('mouseleave', () => { clearTimeout(timer); hideTip(); });
    return node;
  }

  /* --------------------------------------------------------------- misc */

  /** Signed value + arrow. Direction is never carried by colour alone. */
  function changeText(pct) {
    if (pct == null || !isFinite(pct)) return '—';
    const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '·';
    return `${arrow} ${U.fmtPct(pct)}`;
  }

  function emptyState(iconName, title, message, action) {
    return el('div', { class: 'empty' }, [
      el('div', { class: 'empty__icon' }, icon(iconName, 28)),
      el('div', { class: 'empty__title', text: title }),
      el('div', { class: 'empty__msg', text: message }),
      action || null,
    ]);
  }

  function confirmDialog({ title, message, confirmLabel = 'Confirm', danger, onConfirm }) {
    const confirm = el('button', { class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`, text: confirmLabel });
    confirm.addEventListener('click', () => { closeModal(); onConfirm(); });
    modal({
      title,
      width: 440,
      body: el('div', { class: 'sec', style: 'font-size:13px;line-height:1.6' }, message),
      actions: [el('button', { class: 'btn', text: 'Cancel', onclick: closeModal }), confirm],
    });
  }

  PT.ui = {
    icon, toast, modal, closeModal, confirmDialog,
    makePriceCell, setPrice, statusBadge, changeText, emptyState,
    bindTip, showTip, hideTip,
  };
})(window.PT);
