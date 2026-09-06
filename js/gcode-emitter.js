/**
 * LowRider Forge — gcode emitter.
 *
 * Converts a toolpath into FluidNC-compatible gcode following the structure
 * in spec section 8: a documented header, a safe preamble, the operation
 * body (drills first, profiles last) and a footer that parks the machine.
 */
(function (Forge) {
  'use strict';

  /* Makita RT0701/RT0700 speed dial -> approximate RPM (informational). */
  var MAKITA_DIAL = [
    { dial: 1, rpm: 10000 }, { dial: 2, rpm: 12000 }, { dial: 3, rpm: 17000 },
    { dial: 4, rpm: 22000 }, { dial: 5, rpm: 27000 }, { dial: 6, rpm: 30000 }
  ];
  function makitaDial(rpm) {
    var best = MAKITA_DIAL[0];
    MAKITA_DIAL.forEach(function (d) {
      if (Math.abs(d.rpm - rpm) < Math.abs(best.rpm - rpm)) best = d;
    });
    return best.dial;
  }

  /** Format a coordinate: 3 decimals, trailing zeros trimmed, no "-0".
      A non-finite value is clamped to 0 so a stray NaN can never emit a
      line the controller would reject. null/undefined also clamp to 0
      explicitly — relying on isFinite(null)===true would silently emit a
      0 where the caller meant "no value", which is unsafe near arcs. */
  function fmt(n) {
    if (n == null || !isFinite(n)) return '0';
    var r = Math.round(n * 1000) / 1000;
    return String(r === 0 ? 0 : r);
  }

  function applyTemplate(str, tokens) {
    return str.replace(/\{(\w+)\}/g, function (m, k) {
      return tokens[k] != null ? String(tokens[k]) : m;
    });
  }

  /** Build an output filename from the templated pattern. */
  function buildFilename(pattern, tokens) {
    var name = applyTemplate(pattern || '{job}_{material}_{bit}_{date}.gcode', tokens);
    name = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|-+$/g, '');
    if (!/\.gcode$/i.test(name)) name += '.gcode';
    // After stripping, a pathological pattern (e.g. "!!!") could leave just
    // ".gcode" — a hidden file on Unix. Fall through to the standard default.
    if (!name || name === '.gcode') return 'job.gcode';
    return name;
  }

  /** Human description of where the gcode origin sits, for the header. */
  function originLabel(origin) {
    switch (origin) {
      case 'center':   return 'CENTRE of the job';
      case 'top-left': return 'TOP-LEFT of the job';
      case 'custom':   return 'CUSTOM placement (see Geometry settings)';
      default:         return 'FRONT-LEFT of stock';
    }
  }

  /**
   * Emit gcode text.
   * @param {object} toolpath  output of Forge.toolpath.build
   * @param {object} s         settings
   * @param {object} ctx       { bit, material, version, timestamp,
   *                             stockWidth, stockHeight, envelopeOk,
   *                             airPass, airPassOffset }
   * @returns {string}
   */
  function emit(toolpath, s, ctx) {
    var L = [];
    var zOff = ctx.airPass ? (ctx.airPassOffset || 25) : 0;
    var safeZ = (s.safeZ != null ? s.safeZ : 10) + zOff;
    var rpm = s.spindleRpm || 18000;
    var depths = Forge.toolpath.computeDepths(
      s.finalDepth != null ? s.finalDepth : -1,
      s.docPerPass != null ? s.docPerPass : 1);

    var tokens = {
      job: ctx.jobName || 'job',
      material: ctx.material && ctx.material.name ? ctx.material.name : 'unspecified',
      bit: ctx.bit && ctx.bit.name ? ctx.bit.name : 'unspecified',
      operation: s.operation || 'engrave',
      depth: s.finalDepth,
      doc: s.docPerPass,
      passes: depths.length,
      feed: s.feedCut,
      plunge: s.feedPlunge,
      rpm: rpm,
      date: (ctx.timestamp || '').slice(0, 10),
      time: (ctx.timestamp || '').slice(11, 19),
      version: ctx.version || '2.0.0'
    };

    /* ---- header comment block ---- */
    if (s.headerTemplate && s.headerTemplate.trim()) {
      applyTemplate(s.headerTemplate, tokens).split('\n').forEach(function (line) {
        L.push(/^\s*;/.test(line) ? line : '; ' + line);
      });
    } else {
      L.push('; ====== ' + tokens.job + ' ======');
      L.push('; Material: ' + tokens.material);
      var bitDetail = '';
      if (ctx.bit) {
        var bd = [];
        if (ctx.bit.diameter_mm != null) bd.push(ctx.bit.diameter_mm + 'mm');
        if (ctx.bit.type) bd.push(ctx.bit.type);
        if (ctx.bit.v_angle_deg > 0) bd.push(ctx.bit.v_angle_deg + ' deg');
        if (bd.length) bitDetail = ' (' + bd.join(', ') + ')';
      }
      L.push('; Bit: ' + tokens.bit + bitDetail);
      L.push('; Operation: ' + tokens.operation);
      L.push('; Final depth: ' + s.finalDepth + 'mm   DOC: ' + s.docPerPass +
        'mm x ' + depths.length + ' passes');
      L.push('; Spindle: ' + rpm + ' RPM (dial ' + makitaDial(rpm) +
        ')  -- INFO ONLY for manual router');
      L.push('; Feed: ' + s.feedCut + ' mm/min cut, ' + s.feedPlunge + ' mm/min plunge');
      L.push('; Origin: ' + originLabel(s.originPosition) + ', Z=0 on material top');
      L.push('; Stock needed: ' + fmt(ctx.stockWidth) + ' x ' + fmt(ctx.stockHeight) + ' mm');
      L.push('; Machine envelope check: ' +
        (ctx.envelopeOk ? 'OK — job fits' : 'WARNING — job exceeds machine envelope'));
      if (ctx.airPass) {
        L.push('; *** AIR PASS — all Z raised ' + zOff + 'mm. No material is cut. ***');
      }
      L.push('; Generated by LowRider Forge v' + tokens.version + ' on ' +
        (ctx.timestamp || ''));
    }
    L.push(';');

    /* ---- safe preamble ---- */
    L.push('G21    ; millimetres');
    L.push('G90    ; absolute coordinates');
    L.push('G94    ; feed per minute');
    L.push('G17    ; XY plane');
    L.push('M5     ; spindle off (no-op for a manual router)');
    L.push('G0 Z' + fmt(safeZ));
    if (s.useM0) L.push('M0     ; PAUSE — switch the router ON, then press Cycle Start');
    L.push('M3 S' + rpm + '   ; informational unless a VFD is wired');
    L.push('');

    /* ---- operation body ---- */
    // cx/cy/cz hold the last *emitted* coordinate, rounded to output
    // precision, so float noise can never emit a redundant axis word.
    var cx = null, cy = null, cz = null;
    function q(n) {
      // null/undefined also clamp to 0 — isFinite(null) is true, which would
      // otherwise silently turn a missing axis into an emitted X0/Y0/Z0.
      if (n == null || !isFinite(n)) return 0;
      var r = Math.round(n * 1000) / 1000;
      return r === 0 ? 0 : r;
    }

    function moveWords(m) {
      var w = '';
      if (m.x != null) { var rx = q(m.x); if (rx !== cx) { w += ' X' + rx; cx = rx; } }
      if (m.y != null) { var ry = q(m.y); if (ry !== cy) { w += ' Y' + ry; cy = ry; } }
      if (m.z != null) { var rz = q(m.z + zOff); if (rz !== cz) { w += ' Z' + rz; cz = rz; } }
      return w;
    }

    toolpath.ops.forEach(function (op, i) {
      if (!op.moves.length) return;
      L.push('; --- ' + op.kind + ' [' + (i + 1) + '/' + toolpath.ops.length + '] ---');
      op.moves.forEach(function (m) {
        if (m.t === 'rapid') {
          var w = moveWords(m);
          if (w) L.push('G0' + w);
        } else if (m.t === 'arc') {
          // endpoint must be stated explicitly for a full circle.
          // x and y are required on an arc; if either is missing, skip —
          // emitting (X0 Y0) on an arc would send the bit to the origin
          // mid-circle, which is catastrophic. F falls back to s.feedCut
          // so a missing m.f never produces "FNaN".
          if (m.x == null || m.y == null ||
              !isFinite(m.x) || !isFinite(m.y) ||
              !isFinite(m.i) || !isFinite(m.j)) {
            return;
          }
          var rx = q(m.x), ry = q(m.y);
          var aw = ' X' + rx + ' Y' + ry;
          var rz = q(m.z + zOff);
          if (rz !== cz) { aw += ' Z' + rz; cz = rz; }
          aw += ' I' + fmt(m.i) + ' J' + fmt(m.j);
          cx = rx; cy = ry;
          var arcF = (m.f && isFinite(m.f) && m.f > 0) ? m.f
                                                       : (s.feedCut || 1000);
          L.push((m.ccw ? 'G3' : 'G2') + aw + ' F' + Math.round(arcF));
        } else { // plunge or cut
          var cw = moveWords(m);
          if (cw) L.push('G1' + cw + ' F' + Math.round(m.f || s.feedCut));
        }
      });
      L.push('');
    });

    /* ---- footer ---- */
    L.push('; --- footer ---');
    L.push('G0 Z' + fmt(safeZ));
    // Stop the spindle BEFORE the parking move. The bit is at safeZ above the
    // stock, so dragging is unlikely, but if a future VFD is wired the spindle
    // would otherwise still be on through the rapid back to (0,0) — and a
    // mis-set safeZ would let it drag across the freshly cut part.
    L.push('M5     ; spindle off');
    L.push('G0 X0 Y0');
    if (s.useM0) L.push('M0     ; PAUSE — switch the router OFF');
    L.push('M30    ; program end');
    L.push('');

    return L.join('\n');
  }

  Forge.gcode = {
    emit: emit,
    buildFilename: buildFilename,
    makitaDial: makitaDial
  };
})(typeof window !== 'undefined' ? (window.Forge = window.Forge || {})
                                 : (global.Forge = global.Forge || {}));
