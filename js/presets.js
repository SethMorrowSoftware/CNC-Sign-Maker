/**
 * LowRider Forge — persistence client.
 *
 * Thin wrapper over the PHP API for accounts, designs, sharing, bits,
 * materials, presets and jobs, plus LocalStorage autosave of the working
 * settings. The geometry and gcode pipeline never touches the network — only
 * persistence does — so the tool keeps working, signed out or offline, and
 * only saving and sharing need an account.
 */
(function (Forge) {
  'use strict';

  var BASE = 'api/index.php';
  var TIMEOUT_MS = 12000;
  // Saving a design ships its artwork with it: a 4 MB SVG or an 8 MB bitmap
  // takes longer than a settings round-trip, and aborting mid-upload would
  // look like data loss.
  var UPLOAD_TIMEOUT_MS = 120000;

  /* The CSRF token for the current session. Set by Forge.account on sign-in
     and cleared on sign-out; every mutating request carries it as a header.
     The session cookie is already SameSite=Lax and the API only accepts JSON,
     so this is the third layer rather than the only one. */
  var csrfToken = null;

  /* Build a query-string route (api/index.php?r=bits/5). PATH_INFO is
     unreliable on shared cPanel hosts, so the route always travels in ?r=. */
  function routeUrl(path, query) {
    var url = BASE + '?r=' + encodeURIComponent(String(path).replace(/^\/+/, ''));
    if (query) {
      Object.keys(query).forEach(function (k) {
        if (query[k] == null) return;
        url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(query[k]);
      });
    }
    return url;
  }

  function request(method, path, body, opts) {
    opts = opts || {};
    var init = {
      method: method,
      headers: { 'Accept': 'application/json' },
      // Session cookies must ride along even when the app is served from a
      // path the browser treats as a different origin context.
      credentials: 'same-origin'
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (method !== 'GET' && method !== 'HEAD' && csrfToken) {
      init.headers['X-Forge-CSRF'] = csrfToken;
    }

    var timer = null;
    var limit = opts.timeout || (body !== undefined ? UPLOAD_TIMEOUT_MS : TIMEOUT_MS);
    if (typeof AbortController !== 'undefined') {
      var ctrl = new AbortController();
      init.signal = ctrl.signal;
      timer = setTimeout(function () { ctrl.abort(); }, limit);
    }

    return fetch(routeUrl(path, opts.query), init).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var err = new Error((data && data.error) || ('HTTP ' + res.status));
          // Callers branch on these: an auth_required means "open the sign-in
          // dialog", not "show a red toast and give up".
          err.status = res.status;
          err.code = data && data.code;
          throw err;
        }
        return data;
      });
    }).then(function (v) {
      if (timer) clearTimeout(timer);
      return v;
    }, function (e) {
      if (timer) clearTimeout(timer);
      if (e && e.name === 'AbortError') {
        throw new Error('the server did not respond in time');
      }
      throw e;
    });
  }

  var api = {
    health:        function () { return request('GET', '/health'); },

    /* ---- accounts ---- */
    me:            function () { return request('GET', '/auth/me'); },
    login:         function (b) { return request('POST', '/auth/login', b); },
    logout:        function () { return request('POST', '/auth/logout', {}); },
    register:      function (b) { return request('POST', '/auth/register', b); },
    changePassword:function (b) { return request('POST', '/auth/password', b); },
    updateProfile: function (b) { return request('POST', '/auth/profile', b); },

    /* ---- admin ---- */
    listInvites:   function () { return request('GET', '/invites'); },
    createInvite:  function (b) { return request('POST', '/invites', b || {}); },
    revokeInvite:  function (id) { return request('DELETE', '/invites/' + id); },
    checkInvite:   function (t) {
      return request('GET', '/invites/check', undefined, { query: { token: t } });
    },
    listUsers:     function () { return request('GET', '/users'); },
    updateUser:    function (id, b) { return request('PUT', '/users/' + id, b); },

    /* ---- designs ---- */
    listDesigns:   function () { return request('GET', '/designs'); },
    getDesign:     function (id) { return request('GET', '/designs/' + id); },
    createDesign:  function (d) { return request('POST', '/designs', d); },
    updateDesign:  function (id, d) { return request('PUT', '/designs/' + id, d); },
    deleteDesign:  function (id) { return request('DELETE', '/designs/' + id); },
    copyDesign:    function (id, b) { return request('POST', '/designs/' + id + '/copy', b || {}); },

    /* ---- sharing ---- */
    listShares:    function (id) { return request('GET', '/designs/' + id + '/shares'); },
    createShare:   function (id, b) { return request('POST', '/designs/' + id + '/shares', b || {}); },
    revokeShare:   function (id) { return request('DELETE', '/shares/' + id); },
    getShared:     function (token) { return request('GET', '/shared/' + token); },
    copyShared:    function (token, b) { return request('POST', '/shared/' + token + '/copy', b || {}); },

    /* ---- library ---- */
    listBits:      function () { return request('GET', '/bits'); },
    createBit:     function (b) { return request('POST', '/bits', b); },
    updateBit:     function (id, b) { return request('PUT', '/bits/' + id, b); },
    deleteBit:     function (id) { return request('DELETE', '/bits/' + id); },

    listMaterials: function () { return request('GET', '/materials'); },
    createMaterial:function (m) { return request('POST', '/materials', m); },
    updateMaterial:function (id, m) { return request('PUT', '/materials/' + id, m); },
    deleteMaterial:function (id) { return request('DELETE', '/materials/' + id); },

    listPresets:   function () { return request('GET', '/presets'); },
    savePreset:    function (p) { return request('POST', '/presets', p); },
    deletePreset:  function (id) { return request('DELETE', '/presets/' + id); },

    saveJob:       function (j) { return request('POST', '/jobs/save', j); },
    jobUrl:        function (id) { return routeUrl('jobs/' + id); },

    setCsrf:       function (t) { csrfToken = t || null; },
    getCsrf:       function () { return csrfToken; }
  };

  /* ---- LocalStorage autosave (spec: in-session preset autosave) ----
     Still the working scratchpad even for signed-in users: it survives a
     reload without a round-trip and keeps the tool usable offline. A saved
     design in the database is the durable copy; this is the unsaved one. */

  var KEY = 'lowrider-forge.session';
  var store = {
    save: function (settings) {
      try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* quota */ }
    },
    load: function () {
      try {
        var raw = localStorage.getItem(KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    },
    clear: function () {
      try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    }
  };

  Forge.api = api;
  Forge.store = store;
})(window.Forge = window.Forge || {});
