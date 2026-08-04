/**
 * LowRider Forge — SVG parser.
 *
 * Walks every element, accumulates transforms, resolves units to millimetres
 * and tessellates curves into line segments at a controllable chord tolerance.
 * Output is a flat list of subpaths in document (Y-down) millimetre space.
 */
(function (Forge) {
  'use strict';

  /* ---- 2x3 affine matrix [a,b,c,d,e,f]: x' = a*x+c*y+e, y' = b*x+d*y+f ---- */
  var Mat = {
    identity: function () { return [1, 0, 0, 1, 0, 0]; },
    mul: function (m, n) {
      return [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5]
      ];
    },
    apply: function (m, x, y) {
      return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    }
  };

  /* Parse an SVG transform="" attribute into a single matrix. */
  function parseTransform(str) {
    var m = Mat.identity();
    if (!str) return m;
    var re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g, t;
    while ((t = re.exec(str)) !== null) {
      var a = t[2].split(/[\s,]+/).map(parseFloat).filter(function (n) { return !isNaN(n); });
      var local;
      switch (t[1]) {
        case 'matrix':    local = a.length === 6 ? a : null; break;
        case 'translate': local = [1, 0, 0, 1, a[0] || 0, a[1] || 0]; break;
        case 'scale':
          local = [a.length ? a[0] : 1, 0, 0, a.length > 1 ? a[1] : (a.length ? a[0] : 1), 0, 0];
          break;
        case 'rotate':
          var r = (a[0] || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
          local = [c, s, -s, c, 0, 0];
          if (a.length === 3) {
            local = Mat.mul([1, 0, 0, 1, a[1], a[2]],
                    Mat.mul(local, [1, 0, 0, 1, -a[1], -a[2]]));
          }
          break;
        case 'skewX': local = [1, 0, Math.tan((a[0] || 0) * Math.PI / 180), 1, 0, 0]; break;
        case 'skewY': local = [1, Math.tan((a[0] || 0) * Math.PI / 180), 0, 1, 0, 0]; break;
      }
      if (local) m = Mat.mul(m, local);
    }
    return m;
  }

  /* Convert an SVG length string to millimetres (unitless == CSS px).
     Unit suffix is matched case-insensitively — some tools emit "100MM"
     or "5IN" and silently failing the match would treat the file as
     unitless. */
  function lengthToMm(str) {
    if (str == null) return null;
    var m = /^\s*([-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)\s*([a-zA-Z%]*)\s*$/.exec(String(str));
    if (!m) return null;
    var v = parseFloat(m[1]);
    switch (m[2].toLowerCase()) {
      case 'mm': return v;
      case 'cm': return v * 10;
      case 'in': return v * 25.4;
      case 'pt': return v * 25.4 / 72;
      case 'pc': return v * 25.4 / 6;
      case 'px': case '': return v * 25.4 / 96;
      default: return null; // % or unknown
    }
  }

  /* True only when a length carries an explicit physical unit (mm/cm/in/pt/pc).
     Unitless or px values depend on the 96-dpi assumption and warrant a notice. */
  function hasPhysicalUnit(str) {
    if (str == null) return false;
    var m = /([a-zA-Z%]+)\s*$/.exec(String(str).trim());
    return !!m && /^(mm|cm|in|pt|pc)$/i.test(m[1]);
  }

  /* ---- curve tessellation -------------------------------------------- */

  function flattenCubic(p0, p1, p2, p3, tol, out, depth) {
    if (depth > 24) { out.push(p3); return; }
    // flatness: max control-point deviation from the chord
    var dx = p3[0] - p0[0], dy = p3[1] - p0[1];
    var chord2 = dx * dx + dy * dy;
    // Degenerate cubic — endpoints coincide. Without this guard, a self-
    // returning cubic (legal SVG, common in stylised blobs) keeps failing
    // the flatness check `0 < 0` and recurses to depth 24, producing ~33M
    // points and hanging the browser. Use absolute distance from p0 to the
    // control points as the deviation measure instead.
    if (chord2 < 1e-12) {
      var d1a = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      var d2a = Math.hypot(p2[0] - p0[0], p2[1] - p0[1]);
      if (d1a < tol && d2a < tol) {
        out.push(p3);
        return;
      }
      // Real loop curve with coincident endpoints — split and recurse.
      var p01z = mid(p0, p1), p12z = mid(p1, p2), p23z = mid(p2, p3);
      var p012z = mid(p01z, p12z), p123z = mid(p12z, p23z);
      var mz = mid(p012z, p123z);
      flattenCubic(p0, p01z, p012z, mz, tol, out, depth + 1);
      flattenCubic(mz, p123z, p23z, p3, tol, out, depth + 1);
      return;
    }
    var d1 = Math.abs((p1[0] - p3[0]) * dy - (p1[1] - p3[1]) * dx);
    var d2 = Math.abs((p2[0] - p3[0]) * dy - (p2[1] - p3[1]) * dx);
    if ((d1 + d2) * (d1 + d2) < tol * tol * chord2) {
      out.push(p3);
      return;
    }
    var p01 = mid(p0, p1), p12 = mid(p1, p2), p23 = mid(p2, p3);
    var p012 = mid(p01, p12), p123 = mid(p12, p23), m = mid(p012, p123);
    flattenCubic(p0, p01, p012, m, tol, out, depth + 1);
    flattenCubic(m, p123, p23, p3, tol, out, depth + 1);
  }
  function mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }

  /* Elliptical arc -> array of cubic-bezier control quadruples (user space).
     Per SVG spec: start == end means "no segment" (the arc is omitted). */
  function arcToBeziers(x1, y1, rx, ry, phi, largeArc, sweep, x2, y2) {
    if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]];
    if (Math.abs(x1 - x2) < 1e-9 && Math.abs(y1 - y2) < 1e-9) return [];
    rx = Math.abs(rx); ry = Math.abs(ry);
    var rad = phi * Math.PI / 180, cosP = Math.cos(rad), sinP = Math.sin(rad);
    var dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    var x1p = cosP * dx + sinP * dy, y1p = -sinP * dx + cosP * dy;
    var lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lambda > 1) { var s = Math.sqrt(lambda); rx *= s; ry *= s; }
    var sign = largeArc === sweep ? -1 : 1;
    var num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    var den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    var co = sign * Math.sqrt(Math.max(0, num / den));
    var cxp = co * rx * y1p / ry, cyp = -co * ry * x1p / rx;
    var cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
    var cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
    var ang = function (ux, uy, vx, vy) {
      var d = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
      var c = Math.min(1, Math.max(-1, (ux * vx + uy * vy) / d));
      return (ux * vy - uy * vx < 0 ? -1 : 1) * Math.acos(c);
    };
    var theta = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    var delta = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && delta > 0) delta -= 2 * Math.PI;
    if (sweep && delta < 0) delta += 2 * Math.PI;

    var segCount = Math.ceil(Math.abs(delta) / (Math.PI / 2));
    var beziers = [], step = delta / segCount;
    var k = 4 / 3 * Math.tan(step / 4);
    for (var i = 0; i < segCount; i++) {
      var a0 = theta + i * step, a1 = a0 + step;
      var e = function (ang2) {
        var c = Math.cos(ang2), s2 = Math.sin(ang2);
        return [cx + rx * c * cosP - ry * s2 * sinP, cy + rx * c * sinP + ry * s2 * cosP];
      };
      var p0 = e(a0), p3 = e(a1);
      var d0 = [-rx * Math.sin(a0) * cosP - ry * Math.cos(a0) * sinP,
                -rx * Math.sin(a0) * sinP + ry * Math.cos(a0) * cosP];
      var d3 = [-rx * Math.sin(a1) * cosP - ry * Math.cos(a1) * sinP,
                -rx * Math.sin(a1) * sinP + ry * Math.cos(a1) * cosP];
      beziers.push([p0[0] + k * d0[0], p0[1] + k * d0[1],
                    p3[0] - k * d3[0], p3[1] - k * d3[1], p3[0], p3[1]]);
    }
    return beziers;
  }

  /* ---- path-data parsing --------------------------------------------- */

  /* Scan a `d` string into [{cmd, args:[]}], handling arc flags correctly. */
  function scanPath(d) {
    var i = 0, n = d.length, segs = [];
    function ws() { while (i < n && /[\s,]/.test(d[i])) i++; }
    function num() {
      ws();
      var m = /^[-+]?(?:[0-9]*\.[0-9]+|[0-9]+\.?)(?:[eE][-+]?[0-9]+)?/.exec(d.slice(i));
      if (!m) return null;
      i += m[0].length;
      return parseFloat(m[0]);
    }
    function flag() {
      ws();
      if (d[i] === '0' || d[i] === '1') { var f = d[i] === '1' ? 1 : 0; i++; return f; }
      // Non-conforming flag — return null so the caller aborts the arc
      // rather than misreading it as a number and desyncing the next 5
      // arguments.
      return null;
    }
    var counts = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
    while (i < n) {
      ws();
      if (i >= n) break;
      var c = d[i];
      if (!/[MmLlHhVvCcSsQqTtAaZz]/.test(c)) { i++; continue; }
      i++;
      var up = c.toUpperCase(), need = counts[up];
      if (need === 0) { segs.push({ cmd: c, args: [] }); continue; }
      do {
        var args = [];
        for (var k = 0; k < need; k++) {
          var v = (up === 'A' && (k === 3 || k === 4)) ? flag() : num();
          if (v === null) { args = null; break; }
          args.push(v);
        }
        if (!args) break;
        segs.push({ cmd: c, args: args });
        // implicit repeat: subsequent M args become L
        if (up === 'M') { c = c === 'M' ? 'L' : 'l'; up = 'L'; need = 2; }
        ws();
      } while (i < n && /[-+.0-9]/.test(d[i]));
    }
    return segs;
  }

  /* Parse `d` into subpaths of user-space points (curves tessellated). */
  function parsePathData(d, ctm, tol) {
    var segs = scanPath(d);
    var subs = [], cur = null;
    var cx = 0, cy = 0, sx = 0, sy = 0;     // current / subpath-start point
    var pcx = 0, pcy = 0, pqx = 0, pqy = 0; // previous cubic / quad control
    var prev = '';

    function tp(x, y) { return Mat.apply(ctm, x, y); } // to mm
    function start(x, y) {
      cur = { points: [tp(x, y)], closed: false };
      subs.push(cur);
      cx = sx = x; cy = sy = y;
    }
    function lineTo(x, y) {
      if (!cur) start(cx, cy);
      cur.points.push(tp(x, y));
      cx = x; cy = y;
    }
    function curveTo(c1x, c1y, c2x, c2y, ex, ey) {
      if (!cur) start(cx, cy);
      var pts = [];
      flattenCubic(tp(cx, cy), tp(c1x, c1y), tp(c2x, c2y), tp(ex, ey), tol, pts, 0);
      for (var j = 0; j < pts.length; j++) cur.points.push(pts[j]);
      cx = ex; cy = ey;
    }

    for (var s = 0; s < segs.length; s++) {
      var cmd = segs[s].cmd, a = segs[s].args, rel = cmd === cmd.toLowerCase();
      var up = cmd.toUpperCase(), ox = rel ? cx : 0, oy = rel ? cy : 0;
      switch (up) {
        case 'M': start(ox + a[0], oy + a[1]); break;
        case 'L': lineTo(ox + a[0], oy + a[1]); break;
        case 'H': lineTo((rel ? cx : 0) + a[0], cy); break;
        case 'V': lineTo(cx, (rel ? cy : 0) + a[0]); break;
        case 'C':
          curveTo(ox + a[0], oy + a[1], ox + a[2], oy + a[3], ox + a[4], oy + a[5]);
          pcx = ox + a[2]; pcy = oy + a[3];
          break;
        case 'S':
          var rcx = /[CS]/.test(prev) ? 2 * cx - pcx : cx;
          var rcy = /[CS]/.test(prev) ? 2 * cy - pcy : cy;
          curveTo(rcx, rcy, ox + a[0], oy + a[1], ox + a[2], oy + a[3]);
          pcx = ox + a[0]; pcy = oy + a[1];
          break;
        case 'Q':
          var q1x = ox + a[0], q1y = oy + a[1], qex = ox + a[2], qey = oy + a[3];
          curveTo(cx + 2 / 3 * (q1x - cx), cy + 2 / 3 * (q1y - cy),
                  qex + 2 / 3 * (q1x - qex), qey + 2 / 3 * (q1y - qey), qex, qey);
          pqx = q1x; pqy = q1y;
          break;
        case 'T':
          var tx = /[QT]/.test(prev) ? 2 * cx - pqx : cx;
          var ty = /[QT]/.test(prev) ? 2 * cy - pqy : cy;
          var tex = ox + a[0], tey = oy + a[1];
          curveTo(cx + 2 / 3 * (tx - cx), cy + 2 / 3 * (ty - cy),
                  tex + 2 / 3 * (tx - tex), tey + 2 / 3 * (ty - tey), tex, tey);
          pqx = tx; pqy = ty;
          break;
        case 'A':
          var ex = ox + a[5], ey = oy + a[6];
          var bz = arcToBeziers(cx, cy, a[0], a[1], a[2], a[3], a[4], ex, ey);
          for (var b = 0; b < bz.length; b++) {
            curveTo(bz[b][0], bz[b][1], bz[b][2], bz[b][3], bz[b][4], bz[b][5]);
          }
          break;
        case 'Z':
          if (cur) { cur.closed = true; }
          cx = sx; cy = sy; cur = null;
          break;
      }
      prev = up;
    }
    return subs;
  }

  /* ---- primitive shapes ---------------------------------------------- */

  function num(el, name, def) {
    var raw = el.getAttribute(name);
    // Geometry attributes may carry unit suffixes ("10mm" on a rect width is
    // valid SVG). A browser resolves them to user units at 96 dpi; a bare
    // parseFloat would silently read the number as user units — 3.78x off.
    if (raw != null && /(mm|cm|in|pt|pc)\s*$/i.test(String(raw).trim())) {
      var mm = lengthToMm(raw);
      if (mm != null) return mm * 96 / 25.4; // physical units -> user units
    }
    var v = parseFloat(raw);
    return isNaN(v) ? (def || 0) : v;
  }

  function shapeToSubpaths(el, ctm, tol) {
    var tag = el.tagName.toLowerCase(), pts, i;
    function tp(x, y) { return Mat.apply(ctm, x, y); }

    if (tag === 'rect') {
      var x = num(el, 'x'), y = num(el, 'y'), w = num(el, 'width'), h = num(el, 'height');
      if (w <= 0 || h <= 0) return [];
      var rx = parseFloat(el.getAttribute('rx')), ry = parseFloat(el.getAttribute('ry'));
      // Per SVG spec, negative rx/ry are invalid and treated as absent.
      if (isNaN(rx) || rx < 0) rx = NaN;
      if (isNaN(ry) || ry < 0) ry = NaN;
      if (isNaN(rx) && isNaN(ry)) {
        return [{ points: [tp(x, y), tp(x + w, y), tp(x + w, y + h), tp(x, y + h)], closed: true }];
      }
      rx = isNaN(rx) ? ry : rx; ry = isNaN(ry) ? rx : ry;
      // Zero or near-zero corner radius — emit the simple rectangle.
      if (rx < 1e-6 && ry < 1e-6) {
        return [{ points: [tp(x, y), tp(x + w, y), tp(x + w, y + h), tp(x, y + h)], closed: true }];
      }
      rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
      var d = 'M' + (x + rx) + ',' + y +
        'H' + (x + w - rx) + 'A' + rx + ',' + ry + ' 0 0 1 ' + (x + w) + ',' + (y + ry) +
        'V' + (y + h - ry) + 'A' + rx + ',' + ry + ' 0 0 1 ' + (x + w - rx) + ',' + (y + h) +
        'H' + (x + rx) + 'A' + rx + ',' + ry + ' 0 0 1 ' + x + ',' + (y + h - ry) +
        'V' + (y + ry) + 'A' + rx + ',' + ry + ' 0 0 1 ' + (x + rx) + ',' + y + 'Z';
      return parsePathData(d, ctm, tol);
    }
    if (tag === 'circle' || tag === 'ellipse') {
      var cxx = num(el, 'cx'), cyy = num(el, 'cy');
      var ex = tag === 'circle' ? num(el, 'r') : num(el, 'rx');
      var ey = tag === 'circle' ? num(el, 'r') : num(el, 'ry');
      if (ex <= 0 || ey <= 0) return [];
      var d2 = 'M' + (cxx + ex) + ',' + cyy +
        'A' + ex + ',' + ey + ' 0 0 1 ' + (cxx - ex) + ',' + cyy +
        'A' + ex + ',' + ey + ' 0 0 1 ' + (cxx + ex) + ',' + cyy + 'Z';
      return parsePathData(d2, ctm, tol);
    }
    if (tag === 'line') {
      return [{ points: [tp(num(el, 'x1'), num(el, 'y1')), tp(num(el, 'x2'), num(el, 'y2'))],
                closed: false }];
    }
    if (tag === 'polyline' || tag === 'polygon') {
      var nums = (el.getAttribute('points') || '').split(/[\s,]+/).map(parseFloat)
        .filter(function (v) { return !isNaN(v); });
      pts = [];
      for (i = 0; i + 1 < nums.length; i += 2) pts.push(tp(nums[i], nums[i + 1]));
      if (pts.length < 2) return [];
      return [{ points: pts, closed: tag === 'polygon' }];
    }
    return [];
  }

  /* ---- DOM walk ------------------------------------------------------- */

  // <symbol> is normally skipped (only realised via <use>), but the walker
  // accepts it as a root when entered through <use> — see walk()/isUseTarget.
  var SKIP = { defs: 1, clippath: 1, mask: 1, metadata: 1, title: 1, desc: 1, style: 1 };
  var SKIP_AS_ROOT = { symbol: 1 };
  var SHAPES = { path: 1, rect: 1, circle: 1, ellipse: 1, line: 1, polyline: 1, polygon: 1 };

  /** Collect classnames that resolve to display:none / visibility:hidden in
      a <style> block. Handles the common Inkscape/Illustrator "hidden layer"
      pattern: <style>.hidden{display:none}</style> + class="hidden". */
  function collectHiddenClasses(root) {
    var out = {};
    var styles = root.getElementsByTagName ? root.getElementsByTagName('style') : null;
    if (!styles) return out;
    for (var i = 0; i < styles.length; i++) {
      var text = styles[i].textContent || '';
      // Strip /* comments */ first.
      text = text.replace(/\/\*[\s\S]*?\*\//g, '');
      // Match each rule with at least one .class selector and a hidden decl.
      var re = /([^{}]+)\{([^}]*)\}/g, m;
      while ((m = re.exec(text)) !== null) {
        var sel = m[1], decls = m[2];
        if (!/display\s*:\s*none/i.test(decls) &&
            !/visibility\s*:\s*hidden/i.test(decls)) continue;
        var cre = /\.([A-Za-z_][\w-]*)/g, c;
        while ((c = cre.exec(sel)) !== null) out[c[1]] = true;
      }
    }
    return out;
  }

  function isHidden(el, hiddenClasses) {
    var st = (el.getAttribute('style') || '');
    if (el.getAttribute('display') === 'none' || /display\s*:\s*none/.test(st)) return true;
    if (el.getAttribute('visibility') === 'hidden' || /visibility\s*:\s*hidden/.test(st)) return true;
    if (hiddenClasses) {
      var cls = el.getAttribute('class') || '';
      if (cls) {
        var parts = cls.split(/\s+/);
        for (var k = 0; k < parts.length; k++) {
          if (parts[k] && hiddenClasses[parts[k]]) return true;
        }
      }
    }
    return false;
  }

  /** Depth-first search for an element id (works without doc.getElementById). */
  function findById(root, id) {
    if (root.nodeType === 1 && root.getAttribute && root.getAttribute('id') === id) {
      return root;
    }
    for (var c = root.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1) {
        var hit = findById(c, id);
        if (hit) return hit;
      }
    }
    return null;
  }

  /** Parse a viewBox attribute into [minX, minY, w, h], or null. */
  function parseViewBox(el) {
    var vb = (el.getAttribute('viewBox') || '').split(/[\s,]+/).map(parseFloat)
      .filter(function (v) { return !isNaN(v); });
    return (vb.length === 4 && vb[2] > 0 && vb[3] > 0) ? vb : null;
  }

  /** Matrix mapping a viewBox into a w x h viewport honouring
      preserveAspectRatio (default "xMidYMid meet": uniform scale, centred).
      Shared by the root <svg>, nested <svg> viewports and <use>-of-symbol. */
  function viewBoxToViewport(vb, w, h, par) {
    var sxRaw = w / vb[2], syRaw = h / vb[3];
    par = (par || 'xMidYMid meet').trim();
    var parTokens = par.split(/\s+/);
    var align = parTokens[0] || 'xMidYMid';
    var meetOrSlice = (parTokens[1] || 'meet').toLowerCase();
    var sx, sy, tx, ty;
    if (align.toLowerCase() === 'none') {
      sx = sxRaw; sy = syRaw;
      tx = -vb[0] * sx; ty = -vb[1] * sy;
    } else {
      var uniform = meetOrSlice === 'slice'
        ? Math.max(sxRaw, syRaw)
        : Math.min(sxRaw, syRaw);
      sx = uniform; sy = uniform;
      var slackX = w - vb[2] * uniform;
      var slackY = h - vb[3] * uniform;
      var fx = /xMin/i.test(align) ? 0 : /xMax/i.test(align) ? 1 : 0.5;
      var fy = /YMin/.test(align) ? 0 : /YMax/.test(align) ? 1 : 0.5;
      tx = -vb[0] * sx + slackX * fx;
      ty = -vb[1] * sy + slackY * fy;
    }
    return [sx, 0, 0, sy, tx, ty];
  }

  /** Compute the transform a <use> applies when it instantiates a
      <symbol> or <svg> — translate by (x, y), then if the target has a
      viewBox and the <use> has width/height, map the viewBox into the
      use box honouring the target's preserveAspectRatio (symbols default
      to "xMidYMid meet": UNIFORM scale, centred — independent X/Y scales
      would cut a reused emblem distorted). */
  function useTransform(useEl, target) {
    var ux = num(useEl, 'x'), uy = num(useEl, 'y');
    var m = [1, 0, 0, 1, ux, uy];
    var targetTag = (target.tagName || '').toLowerCase();
    if (targetTag !== 'symbol' && targetTag !== 'svg') return m;
    var vb = parseViewBox(target);
    if (!vb) return m;
    var wAttr = useEl.getAttribute('width'), hAttr = useEl.getAttribute('height');
    var w = wAttr != null && wAttr !== '' ? parseFloat(wAttr) : null;
    var h = hAttr != null && hAttr !== '' ? parseFloat(hAttr) : null;
    if (w == null && h == null) {
      // No use box: content renders at viewBox scale, but the viewBox
      // origin must still map to the use point.
      return Mat.mul(m, [1, 0, 0, 1, -vb[0], -vb[1]]);
    }
    if (w == null) w = vb[2] * (h / vb[3]);
    if (h == null) h = vb[3] * (w / vb[2]);
    if (!(w > 0) || !(h > 0)) return m;
    return Mat.mul(m, viewBoxToViewport(vb, w, h,
      target.getAttribute('preserveAspectRatio')));
  }

  function walk(el, ctm, tol, out, root, depth, isUseTarget, hiddenClasses) {
    if (depth > 40 || el.nodeType !== 1 || !el.tagName) return;
    var tag = el.tagName.toLowerCase();
    if (SKIP[tag] || isHidden(el, hiddenClasses)) return;
    // <symbol> is skipped unless we entered it via <use>. <use> resolution
    // sets isUseTarget=true on the first call only — children of the symbol
    // are walked normally.
    if (SKIP_AS_ROOT[tag] && !isUseTarget) return;

    var local = parseTransform(el.getAttribute('transform'));
    var here = Mat.mul(ctm, local);

    // A nested <svg> establishes its own viewport: translate to (x, y), then
    // map its viewBox into its width/height box. Walking it like a <g> would
    // cut pasted-in icon files at the raw viewBox unit scale and position.
    // Skipped when entered via <use> — useTransform already applied the
    // viewport mapping for that path.
    if (tag === 'svg' && depth > 0 && !isUseTarget) {
      here = Mat.mul(here, [1, 0, 0, 1, num(el, 'x'), num(el, 'y')]);
      var nvb = parseViewBox(el);
      if (nvb) {
        var nwAttr = el.getAttribute('width'), nhAttr = el.getAttribute('height');
        var nw = nwAttr != null && nwAttr !== '' ? parseFloat(nwAttr) : null;
        var nh = nhAttr != null && nhAttr !== '' ? parseFloat(nhAttr) : null;
        if (nw == null && nh != null) nw = nh * nvb[2] / nvb[3];
        else if (nh == null && nw != null) nh = nw * nvb[3] / nvb[2];
        if (nw > 0 && nh > 0) {
          here = Mat.mul(here, viewBoxToViewport(nvb, nw, nh,
            el.getAttribute('preserveAspectRatio')));
        } else {
          here = Mat.mul(here, [1, 0, 0, 1, -nvb[0], -nvb[1]]);
        }
      }
    }

    if (tag === 'use') {
      var href = el.getAttribute('href') || el.getAttribute('xlink:href') || '';
      if (href.charAt(0) === '#') {
        var ref = findById(root, href.slice(1));
        if (ref && ref !== el) {
          walk(ref, Mat.mul(here, useTransform(el, ref)),
               tol, out, root, depth + 1, true, hiddenClasses);
        }
      }
      return;
    }
    if (SHAPES[tag]) {
      var subs = tag === 'path'
        ? parsePathData(el.getAttribute('d') || '', here, tol)
        : shapeToSubpaths(el, here, tol);
      for (var i = 0; i < subs.length; i++) out.push(subs[i]);
    }
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1) walk(c, here, tol, out, root, depth + 1, false, hiddenClasses);
    }
  }

  /* ---- geometry helpers ---------------------------------------------- */

  function signedArea(pts) {
    var a = 0;
    for (var i = 0, n = pts.length; i < n; i++) {
      var j = (i + 1) % n;
      a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
    }
    return a / 2;
  }
  function bboxOf(pts) {
    var b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (var i = 0; i < pts.length; i++) {
      b.minX = Math.min(b.minX, pts[i][0]); b.maxX = Math.max(b.maxX, pts[i][0]);
      b.minY = Math.min(b.minY, pts[i][1]); b.maxY = Math.max(b.maxY, pts[i][1]);
    }
    return b;
  }
  function dedupe(pts, closed) {
    var out = [pts[0]];
    for (var i = 1; i < pts.length; i++) {
      var p = out[out.length - 1];
      if (Math.abs(pts[i][0] - p[0]) > 1e-6 || Math.abs(pts[i][1] - p[1]) > 1e-6) {
        out.push(pts[i]);
      }
    }
    if (closed && out.length > 1) {
      var f = out[0], l = out[out.length - 1];
      if (Math.abs(f[0] - l[0]) < 1e-6 && Math.abs(f[1] - l[1]) < 1e-6) out.pop();
    }
    return out;
  }

  /* ---- public API ----------------------------------------------------- */

  /**
   * Parse an SVG string into millimetre geometry.
   * @param {string} svgText
   * @param {object} [opts] - { tessellationTolerance: mm }
   * @returns {object} geometry
   */
  Forge.parseSvg = function (svgText, opts) {
    opts = opts || {};
    var tol = opts.tessellationTolerance > 0 ? opts.tessellationTolerance : 0.1;

    var doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    var perr = doc.getElementsByTagName && doc.getElementsByTagName('parsererror');
    if (perr && perr.length) throw new Error('SVG is not well-formed XML.');
    var svg = doc.documentElement;
    if (!svg || !svg.tagName || svg.tagName.toLowerCase() !== 'svg') {
      throw new Error('No <svg> root element found.');
    }

    // --- unit resolution ---
    var vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(parseFloat)
      .filter(function (v) { return !isNaN(v); });
    var wAttr = svg.getAttribute('width'), hAttr = svg.getAttribute('height');
    var wMm = lengthToMm(wAttr);
    var hMm = lengthToMm(hAttr);
    var hadPhysicalUnits = hasPhysicalUnit(wAttr) || hasPhysicalUnit(hAttr);
    var root, docW, docH;

    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
      // A file that declares only ONE of width/height sizes the other from
      // the viewBox aspect ratio in a browser (intrinsic aspect). Falling
      // back to px-at-96dpi for the missing axis would fake an aspect
      // mismatch here, and the "meet" branch below would then uniformly
      // shrink BOTH axes — a sign cut at a fraction of its declared size,
      // with the units warning suppressed because one axis had real units.
      if (wMm != null && hMm == null) hMm = wMm * vb[3] / vb[2];
      else if (hMm != null && wMm == null) wMm = hMm * vb[2] / vb[3];
      var vpW = wMm != null ? wMm : vb[2] * 25.4 / 96;
      var vpH = hMm != null ? hMm : vb[3] * 25.4 / 96;
      // Honor preserveAspectRatio (default "xMidYMid meet" — uniform scale,
      // centered). Independent X/Y scales would stretch parts whenever the
      // viewport aspect ratio differs from the viewBox aspect — cutting
      // physically wrong-sized parts.
      root = viewBoxToViewport(vb, vpW, vpH,
        svg.getAttribute('preserveAspectRatio'));
      docW = vpW; docH = vpH;
    } else {
      var k = 25.4 / 96; // 1 user unit == 1 CSS px
      root = [k, 0, 0, k, 0, 0];
      docW = wMm; docH = hMm;
    }

    // <text> warning — README documents that text isn't rasterised.
    // clip-path/mask references are counted too: the walker emits the FULL
    // unclipped outline for such elements, which can cut far more geometry
    // than the artwork the user proofed on screen — surface a warning.
    var textCount = 0, clipMaskCount = 0;
    (function scan(n) {
      if (n.nodeType === 1 && n.tagName) {
        var t = n.tagName.toLowerCase();
        if (t === 'text' || t === 'tspan') textCount++;
        if (!SKIP[t] && n.getAttribute &&
            (n.getAttribute('clip-path') || n.getAttribute('mask'))) {
          clipMaskCount++;
        }
      }
      for (var c = n.firstChild; c; c = c.nextSibling) scan(c);
    })(svg);

    // --- walk ---
    var hiddenClasses = collectHiddenClasses(svg);
    var raw = [];
    walk(svg, Mat.mul(root, parseTransform(svg.getAttribute('transform'))),
         tol, raw, svg, 0, false, hiddenClasses);

    // --- assemble subpaths ---
    var subpaths = [], all = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (var i = 0; i < raw.length; i++) {
      var pts = dedupe(raw[i].points, raw[i].closed);
      if (pts.length < 2) continue;
      var closed = raw[i].closed && pts.length >= 3;
      // Promote open paths that visually close (last vertex within a small
      // tolerance of the first) to closed — many exporters omit the Z
      // command for hand-built paths.
      if (!closed && pts.length >= 4) {
        var f = pts[0], l = pts[pts.length - 1];
        if (Math.abs(f[0] - l[0]) < 0.01 && Math.abs(f[1] - l[1]) < 0.01) {
          closed = true;
          pts = pts.slice(0, -1);
        }
      }
      var sa = closed ? signedArea(pts) : 0;
      var bb = bboxOf(pts);
      all.minX = Math.min(all.minX, bb.minX); all.minY = Math.min(all.minY, bb.minY);
      all.maxX = Math.max(all.maxX, bb.maxX); all.maxY = Math.max(all.maxY, bb.maxY);
      subpaths.push({
        points: pts,
        closed: closed,
        signedArea: sa,
        area: Math.abs(sa),
        winding: sa >= 0 ? 'cw' : 'ccw', // document space is Y-down
        bbox: bb,
        perimeter: Forge.geometry ? Forge.geometry.perimeter(pts, closed) : 0
      });
    }
    if (!subpaths.length) {
      if (textCount > 0) {
        throw new Error('No drawable geometry — this SVG contains ' + textCount +
          ' <text> element(s) which are not rasterised. Convert text to paths ' +
          'in your editor (Inkscape: Path -> Object to Path) or use the built-in ' +
          'Text sign mode.');
      }
      throw new Error('No drawable geometry found in SVG.');
    }

    var bw = all.maxX - all.minX, bh = all.maxY - all.minY;

    // parametric-part heuristic (spec gotcha #8): many similar repeated shapes
    var sizes = {}, repeated = 0;
    for (i = 0; i < subpaths.length; i++) {
      var key = Math.round((subpaths[i].bbox.maxX - subpaths[i].bbox.minX)) + 'x' +
                Math.round((subpaths[i].bbox.maxY - subpaths[i].bbox.minY));
      sizes[key] = (sizes[key] || 0) + 1;
      if (sizes[key] === 4) repeated++;
    }

    return {
      subpaths: subpaths,
      bbox: all,
      width_mm: bw,
      height_mm: bh,
      docWidthMm: docW,
      docHeightMm: docH,
      hadViewBox: vb.length === 4,
      hadUnits: hadPhysicalUnits,
      hint: {
        parametric: subpaths.length > 16 && repeated > 0,
        clipMask: clipMaskCount
      },
      tolerance: tol
    };
  };

  /** Classify a subpath given the hole-area threshold (mm^2). */
  Forge.classifySubpath = function (sub, holeThresholdMm2) {
    if (!sub.closed) return 'open';
    return sub.area < holeThresholdMm2 ? 'hole' : 'outer';
  };

  Forge.Mat = Mat;
})(window.Forge = window.Forge || {});
