/**
 * LowRider Forge — accounts UI.
 *
 * Owns the topbar account control, the sign-in / register dialogs, account
 * settings and the administrator panel (invites and users).
 *
 * The tool stays fully usable signed out: artwork, toolpaths, preview and
 * gcode download all run in the browser and never needed the server. An
 * account buys persistence — saved designs, share links and a private bit and
 * material library — so nothing here blocks the app from starting.
 */
(function (Forge) {
  'use strict';

  var ui = Forge.ui;
  var el = ui.el, btn = ui.btn, field = ui.field, input = ui.input;

  var session = { user: null, bootstrap: false };
  var listeners = [];

  function toast(msg, kind) {
    if (Forge.toast) Forge.toast(msg, kind);
  }

  function user() { return session.user; }
  function isAdmin() { return !!session.user && session.user.role === 'admin'; }

  /** Register a callback fired whenever the signed-in user changes. */
  function onChange(fn) { listeners.push(fn); }
  function fireChange() {
    listeners.forEach(function (fn) {
      try { fn(session.user); } catch (e) { /* one listener must not break the rest */ }
    });
  }

  function setSession(data) {
    session.user = (data && data.user) || null;
    session.bootstrap = !!(data && data.bootstrap);
    Forge.api.setCsrf(data && data.csrf);
    renderAccountArea();
    fireChange();
  }

  /* ---- URL parameters -------------------------------------------------- */

  function urlParam(name) {
    try {
      return new URLSearchParams(window.location.search).get(name);
    } catch (e) { return null; }
  }

  /**
   * Drop a one-shot parameter from the address bar.
   *
   * An invite or share token sitting in the URL gets copied into chat logs,
   * bookmarked and sent as a Referer to every font this page fetches. Once it
   * has been consumed there is no reason to keep it on screen.
   */
  function stripParam(name) {
    try {
      var url = new URL(window.location.href);
      if (!url.searchParams.has(name)) return;
      url.searchParams.delete(name);
      window.history.replaceState({}, '', url.pathname + (url.search || '') + url.hash);
    } catch (e) { /* older browser — harmless */ }
  }

  /* ---- topbar ---------------------------------------------------------- */

  var menuOpen = false;

  function renderAccountArea() {
    var area = document.getElementById('account-area');
    if (!area) return;
    area.innerHTML = '';
    menuOpen = false;

    if (!session.user) {
      var signIn = btn('Sign in', 'btn btn-sm', function () { openSignIn(); });
      area.appendChild(signIn);
      if (session.bootstrap) {
        // A brand-new install: the first visitor has to be able to create the
        // administrator account, and there is nobody to invite them.
        area.appendChild(btn('Create admin account', 'btn btn-sm btn-primary',
          function () { openRegister(null); }));
      }
      return;
    }

    var wrap = el('div', 'account-menu-wrap');
    var trigger = btn(session.user.display_name, 'btn btn-sm account-trigger');
    trigger.setAttribute('aria-haspopup', 'true');
    trigger.setAttribute('aria-expanded', 'false');

    var menu = el('div', 'account-menu hidden');
    menu.setAttribute('role', 'menu');

    var who = el('div', 'account-menu-who');
    who.appendChild(el('div', 'account-menu-name', session.user.display_name));
    who.appendChild(el('div', 'account-menu-email', session.user.email));
    if (isAdmin()) who.appendChild(el('span', 'pill pill-ok account-role', 'admin'));
    menu.appendChild(who);

    function item(label, fn) {
      var b = btn(label, 'account-menu-item', function () { closeMenu(); fn(); });
      b.setAttribute('role', 'menuitem');
      menu.appendChild(b);
      return b;
    }
    item('Account settings', openAccountSettings);
    if (isAdmin()) item('Administration', openAdmin);
    item('Sign out', signOut);

    function closeMenu() {
      menu.classList.add('hidden');
      trigger.setAttribute('aria-expanded', 'false');
      menuOpen = false;
    }
    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      menuOpen = !menuOpen;
      menu.classList.toggle('hidden', !menuOpen);
      trigger.setAttribute('aria-expanded', menuOpen ? 'true' : 'false');
    });
    document.addEventListener('click', function () { if (menuOpen) closeMenu(); });
    menu.addEventListener('click', function (e) { e.stopPropagation(); });

    wrap.appendChild(trigger);
    wrap.appendChild(menu);
    area.appendChild(wrap);
  }

  /* ---- sign in --------------------------------------------------------- */

  function openSignIn(reason) {
    var body = el('div', 'form-stack');
    if (reason) body.appendChild(ui.notice(reason + ' — sign in to continue.', 'info'));

    var email = input('email', '', { autocomplete: 'username', required: 'required' });
    var pw = input('password', '', { autocomplete: 'current-password', required: 'required' });
    var err = ui.notice('', 'error');
    err.hidden = true;

    body.appendChild(field('Email', email));
    body.appendChild(field('Password', pw));
    body.appendChild(err);

    var alt = el('p', 'muted small');
    alt.appendChild(document.createTextNode('Accounts are invite-only. '));
    var altLink = btn('Have an invite link?', 'link-btn', function () {
      close();
      openRegister(null);
    });
    alt.appendChild(altLink);
    body.appendChild(alt);

    var submit = btn('Sign in', 'btn btn-primary', doSignIn);
    var close = ui.modal('Sign in', body,
      ui.footRow([btn('Cancel', 'btn', function () { close(); }), submit]));

    function doSignIn() {
      err.hidden = true;
      submit.disabled = true;
      Forge.api.login({ email: email.value.trim(), password: pw.value })
        .then(function (r) {
          setSession(r);
          close();
          toast('Signed in as ' + r.user.display_name + '.');
          return refreshAfterAuth();
        })
        .catch(function (e) {
          err.textContent = e.message;
          err.hidden = false;
          submit.disabled = false;
          pw.focus();
          pw.select();
        });
    }
    [email, pw].forEach(function (i) {
      i.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSignIn(); });
    });
  }

  /* ---- register -------------------------------------------------------- */

  function openRegister(inviteToken) {
    var body = el('div', 'form-stack');
    var isBootstrap = session.bootstrap && !inviteToken;

    if (isBootstrap) {
      body.appendChild(ui.notice(
        'No accounts exist yet, so this first one becomes the administrator. '
        + 'Everyone else joins by invite link.', 'info'));
    }

    var invite = input('text', inviteToken || '', { spellcheck: 'false' });
    var email = input('email', '', { autocomplete: 'username' });
    var name = input('text', '', { autocomplete: 'name' });
    var pw = input('password', '', { autocomplete: 'new-password' });
    var pw2 = input('password', '', { autocomplete: 'new-password' });
    var err = ui.notice('', 'error');
    err.hidden = true;

    if (!isBootstrap) {
      body.appendChild(field('Invite code', invite,
        'The long code from the invite link you were sent.'));
    }
    body.appendChild(field('Email', email));
    body.appendChild(field('Display name', name, 'Shown on designs you share.'));
    body.appendChild(field('Password', pw, 'At least 10 characters.'));
    body.appendChild(field('Confirm password', pw2));
    body.appendChild(err);

    var submit = btn(isBootstrap ? 'Create admin account' : 'Create account',
      'btn btn-primary', doRegister);
    var close = ui.modal(isBootstrap ? 'Create the first account' : 'Create your account',
      body, ui.footRow([btn('Cancel', 'btn', function () { close(); }), submit]));

    // Confirm the invite is still live before the user fills the form in.
    if (inviteToken) {
      Forge.api.checkInvite(inviteToken).then(function (r) {
        if (!r.valid) {
          err.textContent = r.reason === 'used'
            ? 'That invite has already been used. Ask for a fresh link.'
            : r.reason === 'expired'
              ? 'That invite has expired. Ask for a fresh link.'
              : 'That invite link is not recognised.';
          err.hidden = false;
          submit.disabled = true;
        } else if (r.email) {
          // The invite was issued to a specific address; the server enforces
          // it, so pin the field rather than letting the form fail on submit.
          email.value = r.email;
          email.readOnly = true;
        }
      }).catch(function () { /* let the submit report it instead */ });
    }

    function doRegister() {
      err.hidden = true;
      if (pw.value !== pw2.value) {
        err.textContent = 'The two passwords do not match.';
        err.hidden = false;
        return;
      }
      submit.disabled = true;
      Forge.api.register({
        invite: invite.value.trim(),
        email: email.value.trim(),
        display_name: name.value.trim(),
        password: pw.value
      }).then(function (r) {
        setSession(r);
        close();
        stripParam('invite');
        toast(r.bootstrap
          ? 'Administrator account created. You can invite others from the account menu.'
          : 'Welcome, ' + r.user.display_name + '.');
        return refreshAfterAuth();
      }).catch(function (e) {
        err.textContent = e.message;
        err.hidden = false;
        submit.disabled = false;
      });
    }
  }

  /* ---- account settings ------------------------------------------------ */

  function openAccountSettings() {
    var body = el('div', 'form-stack');

    var name = input('text', session.user.display_name, { autocomplete: 'name' });
    body.appendChild(field('Display name', name));
    var nameErr = ui.notice('', 'error'); nameErr.hidden = true;
    body.appendChild(nameErr);
    body.appendChild(btn('Save display name', 'btn', function () {
      nameErr.hidden = true;
      Forge.api.updateProfile({ display_name: name.value.trim() }).then(function (r) {
        session.user = r.user;
        renderAccountArea();
        toast('Display name updated.');
      }).catch(function (e) { nameErr.textContent = e.message; nameErr.hidden = false; });
    }));

    body.appendChild(el('hr', 'form-sep'));

    var cur = input('password', '', { autocomplete: 'current-password' });
    var next = input('password', '', { autocomplete: 'new-password' });
    var next2 = input('password', '', { autocomplete: 'new-password' });
    var pwErr = ui.notice('', 'error'); pwErr.hidden = true;
    body.appendChild(field('Current password', cur));
    body.appendChild(field('New password', next, 'At least 10 characters.'));
    body.appendChild(field('Confirm new password', next2));
    body.appendChild(pwErr);
    body.appendChild(el('p', 'muted small',
      'Changing your password signs you out everywhere else.'));
    body.appendChild(btn('Change password', 'btn', function () {
      pwErr.hidden = true;
      if (next.value !== next2.value) {
        pwErr.textContent = 'The two new passwords do not match.';
        pwErr.hidden = false;
        return;
      }
      Forge.api.changePassword({ current_password: cur.value, new_password: next.value })
        .then(function () {
          cur.value = next.value = next2.value = '';
          toast('Password changed.');
        })
        .catch(function (e) { pwErr.textContent = e.message; pwErr.hidden = false; });
    }));

    var close = ui.modal('Account settings', body,
      ui.footRow([btn('Close', 'btn', function () { close(); })]));
  }

  function signOut() {
    Forge.api.logout().then(function () {
      setSession({ user: null, csrf: null });
      toast('Signed out. The tool still works — only saving needs an account.');
      return refreshAfterAuth();
    }).catch(function (e) { toast('Sign out failed: ' + e.message, 'error'); });
  }

  /**
   * After any auth change the library has to be refetched: which bits,
   * materials and presets exist depends on who is asking.
   */
  function refreshAfterAuth() {
    var jobs = [];
    if (Forge.app) jobs.push(Forge.app.reloadLibrary());
    if (Forge.designs) jobs.push(Forge.designs.refresh());
    return Promise.all(jobs);
  }

  /* ---- administration -------------------------------------------------- */

  function openAdmin() {
    var body = el('div', 'admin-panel');
    var tabs = el('div', 'tabs');
    var invitesPanel = el('div', 'admin-tab-body');
    var usersPanel = el('div', 'admin-tab-body hidden');

    function tab(label, panel) {
      var b = btn(label, 'admin-tab', function () {
        Array.prototype.forEach.call(tabs.children, function (x) {
          x.classList.toggle('active', x === b);
        });
        invitesPanel.classList.toggle('hidden', panel !== invitesPanel);
        usersPanel.classList.toggle('hidden', panel !== usersPanel);
      });
      tabs.appendChild(b);
      return b;
    }
    tab('Invites', invitesPanel).classList.add('active');
    tab('Users', usersPanel);

    body.appendChild(tabs);
    body.appendChild(invitesPanel);
    body.appendChild(usersPanel);

    renderInvites(invitesPanel);
    renderUsers(usersPanel);

    var close = ui.modal('Administration', body,
      ui.footRow([btn('Close', 'btn', function () { close(); })]), { wide: true });
  }

  function renderInvites(panel) {
    panel.innerHTML = '';

    var form = el('div', 'admin-form');
    var email = input('email', '', { placeholder: 'name@example.com (optional)' });
    var note = input('text', '', { placeholder: 'What is this invite for? (optional)' });
    var role = el('select');
    [['user', 'Standard user'], ['admin', 'Administrator']].forEach(function (o) {
      var opt = el('option', null, o[1]); opt.value = o[0]; role.appendChild(opt);
    });
    var days = input('number', '14', { min: '0', max: '365', step: '1' });

    form.appendChild(field('Email (optional)', email,
      'If set, only this address can use the link.'));
    form.appendChild(field('Role', role));
    form.appendChild(field('Expires in (days)', days, '0 means it never expires.'));
    form.appendChild(field('Note', note));
    var formErr = ui.notice('', 'error'); formErr.hidden = true;
    form.appendChild(formErr);
    form.appendChild(btn('Create invite link', 'btn btn-primary', function () {
      formErr.hidden = true;
      Forge.api.createInvite({
        email: email.value.trim(),
        role: role.value,
        note: note.value.trim(),
        expires_days: parseInt(days.value, 10) || 0
      }).then(function (inv) {
        email.value = note.value = '';
        toast('Invite created — copy the link and send it.');
        renderInvites(panel);
        ui.copyText(inv.url).then(function () {
          toast('Invite link copied to the clipboard.');
        }, function () { /* the list shows a Copy button too */ });
      }).catch(function (e) { formErr.textContent = e.message; formErr.hidden = false; });
    }));
    panel.appendChild(form);

    var list = el('div', 'admin-list');
    panel.appendChild(list);
    list.appendChild(el('p', 'muted small', 'Loading invites…'));

    Forge.api.listInvites().then(function (rows) {
      list.innerHTML = '';
      if (!rows.length) {
        list.appendChild(el('p', 'muted small', 'No invites yet.'));
        return;
      }
      rows.forEach(function (r) {
        var row = el('div', 'admin-row');
        var head = el('div', 'admin-row-head');
        head.appendChild(el('span', 'admin-row-title', r.email || 'anyone with the link'));
        head.appendChild(el('span', 'pill pill-' +
          (r.status === 'open' ? 'ok' : r.status === 'used' ? 'muted' : 'warn'), r.status));
        if (r.role === 'admin') head.appendChild(el('span', 'pill pill-warn', 'admin'));
        row.appendChild(head);

        var meta = el('div', 'admin-row-meta');
        meta.appendChild(el('span', null, 'created ' + ui.formatDate(r.created_at)));
        if (r.expires_at) meta.appendChild(el('span', null, 'expires ' + ui.formatDate(r.expires_at)));
        if (r.note) meta.appendChild(el('span', null, r.note));
        row.appendChild(meta);

        var actions = el('div', 'admin-row-actions');
        if (r.status === 'open') {
          actions.appendChild(btn('Copy link', 'btn btn-mini', function () {
            ui.copyText(r.url).then(
              function () { toast('Invite link copied.'); },
              function () { window.prompt('Copy this invite link:', r.url); });
          }));
          actions.appendChild(btn('Revoke', 'btn btn-mini btn-ghost', function () {
            if (!window.confirm('Revoke this invite?')) return;
            Forge.api.revokeInvite(r.id).then(function () {
              toast('Invite revoked.');
              renderInvites(panel);
            }).catch(function (e) { toast('Revoke failed: ' + e.message, 'error'); });
          }));
        }
        row.appendChild(actions);
        list.appendChild(row);
      });
    }).catch(function (e) {
      list.innerHTML = '';
      list.appendChild(ui.notice('Could not load invites: ' + e.message, 'error'));
    });
  }

  function renderUsers(panel) {
    panel.innerHTML = '';
    var list = el('div', 'admin-list');
    panel.appendChild(list);
    list.appendChild(el('p', 'muted small', 'Loading accounts…'));

    Forge.api.listUsers().then(function (rows) {
      list.innerHTML = '';
      rows.forEach(function (u) {
        var row = el('div', 'admin-row');
        var head = el('div', 'admin-row-head');
        head.appendChild(el('span', 'admin-row-title', u.display_name));
        if (u.role === 'admin') head.appendChild(el('span', 'pill pill-warn', 'admin'));
        if (u.disabled) head.appendChild(el('span', 'pill pill-muted', 'disabled'));
        row.appendChild(head);

        var meta = el('div', 'admin-row-meta');
        meta.appendChild(el('span', null, u.email));
        meta.appendChild(el('span', null, u.design_count + ' design(s)'));
        meta.appendChild(el('span', null, u.last_login_at
          ? 'last seen ' + ui.formatDate(u.last_login_at) : 'never signed in'));
        row.appendChild(meta);

        var actions = el('div', 'admin-row-actions');
        var self = session.user && session.user.id === u.id;
        if (!self) {
          actions.appendChild(btn(u.disabled ? 'Enable' : 'Disable',
            'btn btn-mini' + (u.disabled ? '' : ' btn-ghost'), function () {
              if (!u.disabled && !window.confirm(
                'Disable ' + u.display_name + '? Their designs are kept, but they '
                + 'are signed out immediately and cannot sign back in.')) return;
              Forge.api.updateUser(u.id, { disabled: !u.disabled })
                .then(function () { renderUsers(panel); })
                .catch(function (e) { toast('Failed: ' + e.message, 'error'); });
            }));
          actions.appendChild(btn(u.role === 'admin' ? 'Make standard user' : 'Make admin',
            'btn btn-mini btn-ghost', function () {
              Forge.api.updateUser(u.id, { role: u.role === 'admin' ? 'user' : 'admin' })
                .then(function () { renderUsers(panel); })
                .catch(function (e) { toast('Failed: ' + e.message, 'error'); });
            }));
        } else {
          actions.appendChild(el('span', 'muted small', 'This is you.'));
        }
        row.appendChild(actions);
        list.appendChild(row);
      });
    }).catch(function (e) {
      list.innerHTML = '';
      list.appendChild(ui.notice('Could not load accounts: ' + e.message, 'error'));
    });
  }

  /* ---- boot ------------------------------------------------------------ */

  function init() {
    return Forge.api.me().then(function (r) {
      setSession(r);
      var invite = urlParam('invite');
      if (invite && !session.user) {
        openRegister(invite);
      } else if (invite && session.user) {
        toast('You are already signed in, so that invite link was not used.', 'warn');
        stripParam('invite');
      }
      return r;
    }).catch(function (e) {
      // The API being unreachable is not fatal: the tool works offline.
      setSession(null);
      return null;
    });
  }

  Forge.account = {
    init: init,
    user: user,
    isAdmin: isAdmin,
    onChange: onChange,
    promptSignIn: openSignIn,
    openRegister: openRegister,
    stripParam: stripParam,
    urlParam: urlParam
  };
})(window.Forge = window.Forge || {});
