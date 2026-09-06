/**
 * LowRider Forge — saved designs and share links.
 *
 * Owns the design toolbar in the header, the "My designs" browser, the share
 * dialog and the read-only banner shown when a design is opened through
 * somebody else's link.
 *
 * A design is the whole document — settings plus artwork — as opposed to a
 * preset, which is machining settings only. See api/designs.php for why the
 * artwork has to be stored alongside the settings rather than derived.
 */
(function (Forge) {
  'use strict';

  var ui = Forge.ui;
  var el = ui.el, btn = ui.btn, field = ui.field, input = ui.input;

  /* The design currently open in the editor. id is null for unsaved work;
     shareToken is set only when this came in through a share link. */
  var current = { id: null, name: null, readOnly: false, shareToken: null,
                  ownerName: null, assetKinds: [] };

  function toast(msg, kind) { if (Forge.toast) Forge.toast(msg, kind); }
  function signedIn() { return !!(Forge.account && Forge.account.user()); }

  /* ---- toolbar --------------------------------------------------------- */

  function render() {
    var bar = document.getElementById('topbar-design');
    if (!bar) return;
    bar.innerHTML = '';

    var label = el('span', 'design-name',
      current.name || (current.id ? 'Untitled' : 'Unsaved design'));
    label.title = current.name
      ? 'Open design: ' + current.name
      : 'This design has not been saved to your account yet.';
    bar.appendChild(label);

    if (current.readOnly) {
      bar.appendChild(el('span', 'pill pill-warn', 'read only'));
      bar.appendChild(btn('Save a copy', 'btn btn-sm btn-primary', saveCopyOfShared));
    } else {
      bar.appendChild(btn(current.id ? 'Save' : 'Save design',
        'btn btn-sm btn-primary', save));
      if (current.id) {
        bar.appendChild(btn('Save as new…', 'btn btn-sm', function () { saveAsNew(); }));
        bar.appendChild(btn('Share', 'btn btn-sm', function () { openShare(current.id); }));
      }
    }
    bar.appendChild(btn('My designs', 'btn btn-sm', openBrowser));

    renderBanner();
  }

  function renderBanner() {
    var banner = document.getElementById('readonly-banner');
    if (!banner) return;
    banner.innerHTML = '';
    banner.classList.toggle('hidden', !current.readOnly);
    if (!current.readOnly) return;

    var text = el('div', 'readonly-text');
    text.appendChild(el('strong', null, current.name || 'Shared design'));
    text.appendChild(document.createTextNode(
      current.ownerName ? ' — shared by ' + current.ownerName : ' — shared with you'));
    text.appendChild(el('span', 'muted small',
      ' You can adjust settings, preview and download gcode. Saving writes a '
      + 'copy to your own account; the original is untouched.'));
    banner.appendChild(text);

    var actions = el('div', 'readonly-actions');
    actions.appendChild(btn('Save a copy', 'btn btn-sm btn-primary', saveCopyOfShared));
    actions.appendChild(btn('Dismiss', 'btn btn-sm btn-ghost', function () {
      // Leaving read-only mode does not make this the owner's design — it
      // just detaches it, so the next Save creates a design of the user's own.
      current.readOnly = false;
      current.id = null;
      current.shareToken = null;
      Forge.app.setReadOnly(false);
      render();
    }));
    banner.appendChild(actions);
  }

  function setCurrent(design, opts) {
    opts = opts || {};
    current.id = opts.readOnly ? null : (design ? design.id : null);
    current.name = design ? design.name : null;
    current.readOnly = !!opts.readOnly;
    current.shareToken = opts.shareToken || null;
    current.ownerName = design ? (design.owner_name || null) : null;
    // Which artwork the server holds for this design. captureAssets() may
    // only send an "unchanged" marker for a kind that is actually stored.
    current.assetKinds = design && design.assets ? Object.keys(design.assets) : [];
    render();
  }

  /* ---- saving ---------------------------------------------------------- */

  /** Ask for a name, defaulting to the job name so the two stay in step. */
  function promptName(defaultName) {
    var name = window.prompt('Design name:',
      defaultName || (Forge.app ? Forge.app.jobName() : 'My design'));
    return name === null ? null : name.trim();
  }

  function buildPayload(name, storedKinds) {
    var payload = Forge.app.captureDesign();
    payload.name = name;
    payload.assets = Forge.app.captureAssets(storedKinds);
    return payload;
  }

  function save() {
    if (!signedIn()) {
      Forge.account.promptSignIn('Saving a design needs an account');
      return;
    }
    if (!current.id) { saveAsNew(); return; }

    var payload = buildPayload(current.name, current.assetKinds);
    Forge.api.updateDesign(current.id, payload).then(function (d) {
      Forge.app.markSourceSaved();
      setCurrent(d);
      toast('Design "' + d.name + '" saved.');
    }).catch(function (e) { Forge.app.apiFailed('Save failed', e); });
  }

  function saveAsNew(defaultName) {
    if (!signedIn()) {
      Forge.account.promptSignIn('Saving a design needs an account');
      return;
    }
    var name = promptName(defaultName || current.name);
    if (!name) return;
    // No stored kinds: a create has nothing on the server to carry over, so
    // the artwork must be uploaded in full.
    Forge.api.createDesign(buildPayload(name, [])).then(function (d) {
      Forge.app.markSourceSaved();
      setCurrent(d);
      toast(d.name === name
        ? 'Design "' + d.name + '" saved.'
        : 'Saved as "' + d.name + '" — you already had a design called "' + name + '".');
    }).catch(function (e) { Forge.app.apiFailed('Save failed', e); });
  }

  /** Fork a design opened through a share link into the viewer's account. */
  function saveCopyOfShared() {
    if (!signedIn()) {
      Forge.account.promptSignIn('Saving a copy needs an account');
      return;
    }
    if (!current.shareToken) { saveAsNew(); return; }
    var name = promptName(current.name ? current.name + ' (copy)' : null);
    if (!name) return;
    // Copy server-side: the artwork is already in the database, so there is
    // no reason to push megabytes back up through the browser.
    Forge.api.copyShared(current.shareToken, { name: name }).then(function (d) {
      Forge.app.setReadOnly(false);
      setCurrent(d);
      toast('Saved to your designs as "' + d.name + '".');
    }).catch(function (e) { Forge.app.apiFailed('Copy failed', e); });
  }

  /* ---- opening --------------------------------------------------------- */

  function openDesign(id) {
    return Forge.api.getDesign(id).then(function (d) {
      return Forge.app.applyDesign(d).then(function () {
        setCurrent(d);
        toast('Opened "' + d.name + '".');
      });
    }).catch(function (e) { Forge.app.apiFailed('Could not open the design', e); });
  }

  function newDesign() {
    if (!window.confirm('Start a new design? Unsaved changes to the current one are lost.')) {
      return;
    }
    Forge.app.applyDesign({ settings: {}, input_mode: 'text', operation: 'engrave' })
      .then(function () {
        setCurrent(null);
        toast('Started a new design.');
      });
  }

  /* ---- the design browser ---------------------------------------------- */

  function openBrowser() {
    if (!signedIn()) {
      Forge.account.promptSignIn('Your saved designs need an account');
      return;
    }
    var body = el('div', 'design-browser');
    var list = el('div', 'design-list');
    body.appendChild(list);

    var close = ui.modal('My designs', body, ui.footRow([
      btn('New design', 'btn', function () { close(); newDesign(); }),
      btn('Save current as new…', 'btn', function () { close(); saveAsNew(); }),
      btn('Close', 'btn', function () { close(); })
    ]), { wide: true });

    function reload() {
      list.innerHTML = '';
      list.appendChild(el('p', 'muted small', 'Loading designs…'));
      Forge.api.listDesigns().then(function (rows) {
        list.innerHTML = '';
        if (!rows.length) {
          list.appendChild(el('p', 'muted small',
            'No saved designs yet. Build a sign, then use "Save design".'));
          return;
        }
        rows.forEach(function (d) { list.appendChild(designRow(d, reload, close)); });
      }).catch(function (e) {
        list.innerHTML = '';
        list.appendChild(ui.notice('Could not load designs: ' + e.message, 'error'));
      });
    }
    reload();
  }

  function designRow(d, reload, closeBrowser) {
    var row = el('div', 'design-row' + (d.id === current.id ? ' design-row-open' : ''));

    var head = el('div', 'design-row-head');
    head.appendChild(el('span', 'design-row-title', d.name));
    head.appendChild(el('span', 'pill pill-muted', d.input_mode));
    head.appendChild(el('span', 'pill pill-muted', d.operation));
    if (d.share_count > 0) {
      head.appendChild(el('span', 'pill pill-ok',
        d.share_count === 1 ? '1 link' : d.share_count + ' links'));
    }
    if (d.id === current.id) head.appendChild(el('span', 'pill pill-ok', 'open'));
    row.appendChild(head);

    var meta = el('div', 'design-row-meta');
    meta.appendChild(el('span', null, 'updated ' + ui.formatDate(d.updated_at)));
    if (d.asset_bytes) meta.appendChild(el('span', null, ui.formatBytes(d.asset_bytes) + ' artwork'));
    if (d.notes) meta.appendChild(el('span', 'design-row-note', d.notes));
    row.appendChild(meta);

    var actions = el('div', 'design-row-actions');
    actions.appendChild(btn('Open', 'btn btn-mini', function () {
      closeBrowser();
      openDesign(d.id);
    }));
    actions.appendChild(btn('Share', 'btn btn-mini', function () { openShare(d.id, d.name); }));
    actions.appendChild(btn('Duplicate', 'btn btn-mini btn-ghost', function () {
      Forge.api.copyDesign(d.id, {}).then(function () {
        toast('Design duplicated.');
        reload();
      }).catch(function (e) { toast('Duplicate failed: ' + e.message, 'error'); });
    }));
    actions.appendChild(btn('Rename', 'btn btn-mini btn-ghost', function () {
      var name = window.prompt('Rename design:', d.name);
      if (name === null) return;
      name = name.trim();
      if (!name || name === d.name) return;
      // A rename must not disturb the artwork, so every asset is marked
      // unchanged rather than re-sent.
      // Only the name travels: the server keeps every field the request
      // leaves out, artwork included, so a rename cannot disturb the design.
      Forge.api.updateDesign(d.id, { name: name }).then(function (updated) {
        if (current.id === d.id) { current.name = updated.name; render(); }
        toast('Renamed.');
        reload();
      }).catch(function (e) { toast('Rename failed: ' + e.message, 'error'); });
    }));
    actions.appendChild(btn('Delete', 'btn btn-mini btn-ghost', function () {
      if (!window.confirm('Delete "' + d.name + '"? Every share link to it stops '
        + 'working immediately. This cannot be undone.')) return;
      Forge.api.deleteDesign(d.id).then(function () {
        if (current.id === d.id) setCurrent(null);
        toast('Design deleted.');
        reload();
      }).catch(function (e) { toast('Delete failed: ' + e.message, 'error'); });
    }));
    row.appendChild(actions);
    return row;
  }

  /* ---- sharing --------------------------------------------------------- */

  function openShare(designId, designName) {
    if (!designId) {
      toast('Save the design first, then share it.', 'warn');
      return;
    }
    var body = el('div', 'share-panel');
    body.appendChild(el('p', 'muted small',
      'Anyone with the link can view this design, adjust settings and download '
      + 'gcode from it. They cannot change your copy. Signed-in visitors can '
      + 'save a copy of their own. Treat the link as the password — revoke it '
      + 'to cut off access.'));

    var days = input('number', '0', { min: '0', max: '3650', step: '1' });
    body.appendChild(field('Expires in (days)', days, '0 means it never expires.'));
    var err = ui.notice('', 'error'); err.hidden = true;
    body.appendChild(err);
    body.appendChild(btn('Create a share link', 'btn btn-primary', function () {
      err.hidden = true;
      Forge.api.createShare(designId, { expires_days: parseInt(days.value, 10) || 0 })
        .then(function (s) {
          reload();
          ui.copyText(s.url).then(
            function () { toast('Share link created and copied to the clipboard.'); },
            function () { toast('Share link created.'); });
        })
        .catch(function (e) { err.textContent = e.message; err.hidden = false; });
    }));

    var list = el('div', 'share-list');
    body.appendChild(list);

    var close = ui.modal('Share "' + (designName || current.name || 'design') + '"',
      body, ui.footRow([btn('Close', 'btn', function () { close(); })]), { wide: true });

    function reload() {
      list.innerHTML = '';
      list.appendChild(el('p', 'muted small', 'Loading links…'));
      Forge.api.listShares(designId).then(function (rows) {
        list.innerHTML = '';
        if (!rows.length) {
          list.appendChild(el('p', 'muted small', 'No share links yet.'));
          return;
        }
        rows.forEach(function (s) { list.appendChild(shareRow(s, reload)); });
      }).catch(function (e) {
        list.innerHTML = '';
        list.appendChild(ui.notice('Could not load share links: ' + e.message, 'error'));
      });
    }
    reload();
  }

  function shareRow(s, reload) {
    var row = el('div', 'share-row');

    var head = el('div', 'share-row-head');
    head.appendChild(el('span', 'pill pill-' + (s.active ? 'ok' : 'muted'),
      s.active ? 'active' : (s.revoked_at ? 'revoked' : 'expired')));
    head.appendChild(el('span', 'share-row-meta',
      'created ' + ui.formatDate(s.created_at)
      + (s.expires_at ? ' · expires ' + ui.formatDate(s.expires_at) : '')
      + ' · ' + s.view_count + ' view(s)'
      + (s.last_viewed_at ? ', last ' + ui.formatDate(s.last_viewed_at) : '')));
    row.appendChild(head);

    if (s.active) {
      var url = input('text', s.url, { readonly: 'readonly', spellcheck: 'false' });
      url.className = 'share-url';
      url.addEventListener('focus', function () { url.select(); });
      row.appendChild(url);

      var actions = el('div', 'share-row-actions');
      actions.appendChild(btn('Copy link', 'btn btn-mini', function () {
        ui.copyText(s.url).then(
          function () { toast('Share link copied.'); },
          function () { url.select(); toast('Press Ctrl/Cmd+C to copy.', 'warn'); });
      }));
      actions.appendChild(btn('Revoke', 'btn btn-mini btn-ghost', function () {
        if (!window.confirm('Revoke this link? Anyone holding it loses access '
          + 'immediately.')) return;
        Forge.api.revokeShare(s.id).then(function () {
          toast('Share link revoked.');
          reload();
        }).catch(function (e) { toast('Revoke failed: ' + e.message, 'error'); });
      }));
      row.appendChild(actions);
    }
    return row;
  }

  /* ---- boot ------------------------------------------------------------ */

  /** Open a ?share=… link, if there is one. Returns a Promise. */
  function bootFromUrl() {
    var token = Forge.account ? Forge.account.urlParam('share') : null;
    render();
    if (!token) return Promise.resolve(false);

    return Forge.api.getShared(token).then(function (d) {
      return Forge.app.applyDesign(d, { readOnly: true }).then(function () {
        setCurrent(d, { readOnly: true, shareToken: token });
        // The token stays out of the address bar from here on: it would
        // otherwise be bookmarked, pasted into chat, and sent as a Referer to
        // every font this page fetches from a CDN.
        Forge.account.stripParam('share');
        toast('Opened a shared design (read only).');
        return true;
      });
    }).catch(function (e) {
      Forge.account.stripParam('share');
      toast('That share link could not be opened: ' + e.message, 'error');
      return false;
    });
  }

  /** Re-render after a sign-in or sign-out. */
  function refresh() {
    // A design belonging to the previous account must not stay bound after a
    // sign-out, or the next Save would target a design this session cannot
    // see and fail with a bare 404.
    if (!signedIn() && current.id) {
      current.id = null;
      current.name = null;
    }
    render();
    return Promise.resolve();
  }

  Forge.designs = {
    bootFromUrl: bootFromUrl,
    refresh: refresh,
    render: render,
    open: openDesign,
    save: save,
    saveAsNew: saveAsNew,
    current: function () { return current; }
  };
})(window.Forge = window.Forge || {});
