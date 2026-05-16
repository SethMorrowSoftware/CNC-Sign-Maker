/**
 * LowRider Forge — persistence client.
 *
 * Thin wrapper over the PHP API for bits / materials / presets / jobs, plus
 * LocalStorage autosave of the working settings. The geometry and gcode
 * pipeline never touches the network — only persistence does — so the tool
 * keeps working if the server is unreachable.
 */
(function (Forge) {
  'use strict';

  var BASE = 'api/index.php';
  var TIMEOUT_MS = 12000;

  /* Build a query-string route (api/index.php?r=bits/5). PATH_INFO is
     unreliable on shared cPanel hosts, so the route always travels in ?r=. */
  function routeUrl(path) {
    return BASE + '?r=' + encodeURIComponent(String(path).replace(/^\/+/, ''));
  }

  function request(method, path, body) {
    var opts = { method: method, headers: { 'Accept': 'application/json' } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    var timer = null;
    if (typeof AbortController !== 'undefined') {
      var ctrl = new AbortController();
      opts.signal = ctrl.signal;
      timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
    }
    return fetch(routeUrl(path), opts).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          throw new Error((data && data.error) || ('HTTP ' + res.status));
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
    jobUrl:        function (id) { return routeUrl('jobs/' + id); }
  };

  /* ---- LocalStorage autosave (spec: in-session preset autosave) ---- */

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
