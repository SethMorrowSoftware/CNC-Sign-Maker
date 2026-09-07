/**
 * LowRider Forge — shared UI helpers for the account and design panels.
 *
 * Everything here builds DOM with createElement and textContent, never with
 * innerHTML. That was a stylistic nicety while the tool was single-user; now
 * that one account's design name and display name are rendered in another
 * account's browser, it is the thing standing between a shared design and
 * stored XSS. Keep it that way.
 */
(function (Forge) {
  'use strict';

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function btn(label, cls, onClick) {
    var b = el('button', cls || 'btn', label);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  /** A labelled input row matching the existing .field styling. */
  function field(labelText, input, hint) {
    var lab = el('label', 'field');
    lab.appendChild(el('span', null, labelText));
    lab.appendChild(input);
    if (hint) lab.appendChild(el('span', 'field-hint', hint));
    return lab;
  }

  function input(type, value, attrs) {
    var i = el('input');
    i.type = type;
    if (value != null) i.value = value;
    Object.keys(attrs || {}).forEach(function (k) { i.setAttribute(k, attrs[k]); });
    return i;
  }

  /* ---- modal ---------------------------------------------------------- */

  var openStack = [];

  /**
   * Show a modal. Returns a close function.
   *
   * Focus is moved into the dialog and restored on close, and Escape closes
   * the top-most one — the gcode modal already behaves this way and the new
   * dialogs should not feel different.
   */
  function modal(title, bodyNode, footNode, opts) {
    opts = opts || {};
    var previouslyFocused = document.activeElement;

    var wrap = el('div', 'modal');
    var card = el('div', 'modal-card' + (opts.wide ? ' modal-wide' : ''));
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');

    var head = el('div', 'modal-head');
    var h = el('h2', null, title);
    h.id = 'modal-title-' + openStack.length;
    wrap.setAttribute('aria-labelledby', h.id);
    head.appendChild(h);
    var x = btn('×', 'icon-btn', function () { close(); });
    x.setAttribute('aria-label', 'Close');
    head.appendChild(x);
    card.appendChild(head);

    var body = el('div', 'modal-body');
    body.appendChild(bodyNode);
    card.appendChild(body);

    if (footNode) {
      var foot = el('div', 'modal-foot');
      foot.appendChild(footNode);
      card.appendChild(foot);
    }

    wrap.appendChild(card);
    document.body.appendChild(wrap);

    function close() {
      var i = openStack.indexOf(close);
      if (i === -1) return;             // already closed
      openStack.splice(i, 1);
      wrap.remove();
      if (previouslyFocused && previouslyFocused.focus) {
        try { previouslyFocused.focus(); } catch (e) { /* detached */ }
      }
      if (opts.onClose) opts.onClose();
    }

    wrap.addEventListener('mousedown', function (e) {
      if (e.target === wrap && !opts.sticky) close();
    });

    openStack.push(close);
    var focusTarget = card.querySelector('input, select, textarea, button');
    if (focusTarget) focusTarget.focus();
    return close;
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && openStack.length) {
      openStack[openStack.length - 1]();
    }
  });

  /** A row of buttons for a modal footer. */
  function footRow(buttons) {
    var row = el('div', 'modal-foot-actions');
    buttons.forEach(function (b) { if (b) row.appendChild(b); });
    return row;
  }

  /** An inline error/notice line inside a form. */
  function notice(text, kind) {
    var n = el('p', 'form-notice ' + (kind ? 'form-notice-' + kind : ''), text || '');
    n.setAttribute('role', 'status');
    return n;
  }

  /* ---- binary <-> base64 --------------------------------------------- */

  /**
   * Encode an ArrayBuffer as base64.
   *
   * Chunked because String.fromCharCode.apply blows the argument limit — and
   * therefore the stack — somewhere around a hundred thousand bytes, and the
   * artwork this carries runs to eight megabytes.
   */
  function bytesToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var CHUNK = 0x8000;
    var parts = [];
    for (var i = 0; i < bytes.length; i += CHUNK) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
    }
    return btoa(parts.join(''));
  }

  function base64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function base64ToText(b64) {
    return new TextDecoder('utf-8').decode(base64ToBytes(b64));
  }

  function textToBase64(text) {
    return bytesToBase64(new TextEncoder().encode(text).buffer);
  }

  /* ---- formatting ----------------------------------------------------- */

  function formatDate(unixSeconds) {
    if (!unixSeconds) return '—';
    var d = new Date(unixSeconds * 1000);
    var now = Date.now();
    var diff = (now - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
    if (diff < 86400) return Math.floor(diff / 3600) + ' h ago';
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + ' d ago';
    return d.toLocaleDateString();
  }

  function formatBytes(n) {
    if (!n) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  /** Copy to clipboard, falling back to a hidden textarea on http:// hosts. */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = el('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'true');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('copy blocked by the browser'));
    });
  }

  Forge.ui = {
    el: el, btn: btn, field: field, input: input,
    modal: modal, footRow: footRow, notice: notice,
    bytesToBase64: bytesToBase64, base64ToBytes: base64ToBytes,
    base64ToText: base64ToText, textToBase64: textToBase64,
    formatDate: formatDate, formatBytes: formatBytes, copyText: copyText
  };
})(window.Forge = window.Forge || {});
