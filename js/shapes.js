(function (Forge) {
  'use strict';

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function round(v) { return Math.round(v * 1000) / 1000; }

  /** Read one shape parameter, clamped to [lo, hi].
      Falls back to `def` whenever the stored value is missing OR is not a
      finite number. Shape params travel in saved presets, job records and the
      LocalStorage session blob — all user-editable JSON — and a null, empty
      string or text value there used to reach clamp() untouched and produce
      NaN path data. Downstream the non-finite vertices are filtered out, so
      the shape silently disappeared from the toolpath instead of failing
      loudly: exactly the kind of wrong output that only shows up in the cut. */
  function param(params, key, def, lo, hi) {
    var v = params ? params[key] : undefined;
    var n = (v === null || v === undefined || v === '') ? def : +v;
    if (!isFinite(n)) n = def;
    return clamp(n, lo, hi);
  }

  function polygonPath(points) {
    if (!points || !points.length) return '';
    var d = 'M' + round(points[0][0]) + ',' + round(points[0][1]);
    for (var i = 1; i < points.length; i++) d += 'L' + round(points[i][0]) + ',' + round(points[i][1]);
    return d + 'Z';
  }

  function rectPath(x, y, w, h) {
    return 'M' + round(x) + ',' + round(y) + 'L' + round(x + w) + ',' + round(y) +
      'L' + round(x + w) + ',' + round(y + h) + 'L' + round(x) + ',' + round(y + h) + 'Z';
  }

  /** Stretch a vertex list so its axis-aligned bbox is exactly (0,0)-(1,1).
      Used to keep declared shape dimensions honest — e.g. pentagon was 95% x 90%
      of its declared bbox before normalization. */
  function normalizeToBbox(pts) {
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      if (pts[i][0] < minX) minX = pts[i][0];
      if (pts[i][0] > maxX) maxX = pts[i][0];
      if (pts[i][1] < minY) minY = pts[i][1];
      if (pts[i][1] > maxY) maxY = pts[i][1];
    }
    var rw = maxX - minX, rh = maxY - minY;
    if (rw < 1e-9 || rh < 1e-9) return pts.slice();
    var out = new Array(pts.length);
    for (var j = 0; j < pts.length; j++) {
      out[j] = [(pts[j][0] - minX) / rw, (pts[j][1] - minY) / rh];
    }
    return out;
  }

  /** Offset a closed polygon inward by `t` in normalized units. Each edge is
      translated perpendicular to itself; consecutive offset lines are
      intersected to find the inner vertices. Returns the inner contour with
      the same winding as the input. Used for border shapes that previously
      offset the X and Y axes independently — producing non-uniform wall
      thickness on diagonal edges. */
  function offsetPolygonInward(poly, t) {
    var n = poly.length;
    if (n < 3) return [];
    var cx = 0, cy = 0;
    for (var i = 0; i < n; i++) { cx += poly[i][0]; cy += poly[i][1]; }
    cx /= n; cy /= n;
    var lines = [];
    for (var k = 0; k < n; k++) {
      var p1 = poly[k], p2 = poly[(k + 1) % n];
      var dx = p2[0] - p1[0], dy = p2[1] - p1[1];
      var len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      var nx = -dy / len, ny = dx / len;
      var mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
      if (nx * (cx - mx) + ny * (cy - my) < 0) { nx = -nx; ny = -ny; }
      lines.push({
        a: [p1[0] + t * nx, p1[1] + t * ny],
        b: [p2[0] + t * nx, p2[1] + t * ny]
      });
    }
    if (!lines.length) return [];
    var inner = [];
    for (var li = 0; li < lines.length; li++) {
      var L1 = lines[li], L2 = lines[(li + 1) % lines.length];
      var x1 = L1.a[0], y1 = L1.a[1], x2 = L1.b[0], y2 = L1.b[1];
      var x3 = L2.a[0], y3 = L2.a[1], x4 = L2.b[0], y4 = L2.b[1];
      var den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
      if (Math.abs(den) < 1e-9) { inner.push([x2, y2]); continue; }
      var u = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
      inner.push([x1 + u * (x2 - x1), y1 + u * (y2 - y1)]);
    }
    return inner;
  }

  var SHAPES = {
    rectangle: { label: 'Rectangle', params: [], path: function () { return ['M0,0L1,0L1,1L0,1Z']; } },
    roundedRect: {
      label: 'Rounded rectangle',
      params: [{ key: 'radius', label: 'Corner radius', min: 0.01, max: 0.49, def: 0.16, step: 0.01, unit: 'ratio' }],
      path: function (params) {
        var r = param(params, 'radius', 0.16, 0.01, 0.49);
        return ['M' + r + ',0L' + (1 - r) + ',0A' + r + ',' + r + ' 0 0 1 1,' + r +
          'L1,' + (1 - r) + 'A' + r + ',' + r + ' 0 0 1 ' + (1 - r) + ',1L' + r + ',1A' + r + ',' + r +
          ' 0 0 1 0,' + (1 - r) + 'L0,' + r + 'A' + r + ',' + r + ' 0 0 1 ' + r + ',0Z'];
      }
    },
    borderRect: {
      label: 'Rectangular border',
      border: true,
      params: [{ key: 'thickness', label: 'Border thickness', min: 0.03, max: 0.45, def: 0.12, step: 0.01, unit: 'ratio' }],
      path: function (params) {
        var t = param(params, 'thickness', 0.12, 0.03, 0.45);
        var x = t, y = t, w = 1 - 2 * t, h = 1 - 2 * t;
        // Inner rectangle traversed in REVERSE order so its winding is
        // opposite the outer — produces a proper annulus under any
        // winding-aware fill rule. Even-odd pocketing works either way.
        var innerRev = 'M' + round(x) + ',' + round(y) +
          'L' + round(x) + ',' + round(y + h) +
          'L' + round(x + w) + ',' + round(y + h) +
          'L' + round(x + w) + ',' + round(y) + 'Z';
        return [rectPath(0, 0, 1, 1), innerRev];
      }
    },
    roundedBorderRect: {
      label: 'Rounded border',
      border: true,
      params: [
        { key: 'thickness', label: 'Border thickness', min: 0.03, max: 0.45, def: 0.12, step: 0.01, unit: 'ratio' },
        { key: 'radius', label: 'Corner radius', min: 0.03, max: 0.49, def: 0.16, step: 0.01, unit: 'ratio' }
      ],
      path: function (params) {
        var t = param(params, 'thickness', 0.12, 0.03, 0.45);
        var rOuter = param(params, 'radius', 0.16, 0.03, 0.49);
        var innerW = 1 - 2 * t;
        var innerH = 1 - 2 * t;
        if (innerW <= 0.01 || innerH <= 0.01) return [];
        var rInner = clamp(rOuter - t, 0.01, Math.min(innerW, innerH) * 0.5 - 0.005);
        // Outer: CW with sweep=1. Inner: CCW with sweep=0, so the annulus is
        // properly hole-wound under any winding-aware fill rule.
        return [
          'M' + rOuter + ',0L' + (1 - rOuter) + ',0A' + rOuter + ',' + rOuter + ' 0 0 1 1,' + rOuter +
            'L1,' + (1 - rOuter) + 'A' + rOuter + ',' + rOuter + ' 0 0 1 ' + (1 - rOuter) + ',1L' + rOuter + ',1A' + rOuter + ',' + rOuter +
            ' 0 0 1 0,' + (1 - rOuter) + 'L0,' + rOuter + 'A' + rOuter + ',' + rOuter + ' 0 0 1 ' + rOuter + ',0Z',
          'M' + (t + rInner) + ',' + t + 'A' + rInner + ',' + rInner + ' 0 0 0 ' + t + ',' + (t + rInner) +
            'L' + t + ',' + (1 - t - rInner) + 'A' + rInner + ',' + rInner + ' 0 0 0 ' + (t + rInner) + ',' + (1 - t) +
            'L' + (1 - t - rInner) + ',' + (1 - t) + 'A' + rInner + ',' + rInner + ' 0 0 0 ' + (1 - t) + ',' + (1 - t - rInner) +
            'L' + (1 - t) + ',' + (t + rInner) + 'A' + rInner + ',' + rInner + ' 0 0 0 ' + (1 - t - rInner) + ',' + t +
            'L' + (t + rInner) + ',' + t + 'Z'
        ];
      }
    },

    ellipse: {
      label: 'Ellipse',
      params: [],
      path: function () { return ['M0.5,0A0.5,0.5 0 1 1 0.5,1A0.5,0.5 0 1 1 0.5,0Z']; }
    },
    ellipseBorder: {
      label: 'Ellipse border',
      border: true,
      params: [{ key: 'thickness', label: 'Border thickness', min: 0.03, max: 0.45, def: 0.12, step: 0.01, unit: 'ratio' }],
      path: function (params) {
        var t = param(params, 'thickness', 0.12, 0.03, 0.45);
        var r = 0.5 - t;
        return ['M0.5,0A0.5,0.5 0 1 1 0.5,1A0.5,0.5 0 1 1 0.5,0Z',
          'M0.5,' + t + 'A' + r + ',' + r + ' 0 1 0 0.5,' + (1 - t) + 'A' + r + ',' + r + ' 0 1 0 0.5,' + t + 'Z'];
      }
    },
    hexagon: {
      label: 'Hexagon',
      params: [{ key: 'inset', label: 'Corner inset', min: 0.1, max: 0.45, def: 0.25, step: 0.01, unit: 'ratio' }],
      path: function (params) {
        var inset = param(params, 'inset', 0.25, 0.1, 0.45);
        return [polygonPath([[inset, 0], [1 - inset, 0], [1, 0.5], [1 - inset, 1], [inset, 1], [0, 0.5]])];
      }
    },
    hexagonBorder: {
      label: 'Hexagon border',
      border: true,
      params: [
        { key: 'inset', label: 'Corner inset', min: 0.1, max: 0.45, def: 0.25, step: 0.01, unit: 'ratio' },
        { key: 'thickness', label: 'Border thickness', min: 0.03, max: 0.24, def: 0.1, step: 0.01, unit: 'ratio' }
      ],
      path: function (params) {
        var inset = param(params, 'inset', 0.25, 0.1, 0.45);
        var t = param(params, 'thickness', 0.1, 0.03, 0.24);
        var outer = [[inset, 0], [1 - inset, 0], [1, 0.5], [1 - inset, 1], [inset, 1], [0, 0.5]];
        // Geometric inward offset so wall thickness is uniform around the
        // ring (the old X/Y inset approach produced visibly thicker diagonal
        // walls than horizontals).
        var inner = offsetPolygonInward(outer, t);
        if (inner.length < 3) return [polygonPath(outer)];
        // Reverse the inner contour so the annulus is properly hole-wound.
        inner.reverse();
        return [polygonPath(outer), polygonPath(inner)];
      }
    },
    pillBorder: {
      label: 'Pill border',
      border: true,
      params: [{ key: 'thickness', label: 'Border thickness', min: 0.03, max: 0.24, def: 0.1, step: 0.01, unit: 'ratio' }],
      // The shape library works in a unit (0..1) box that is later stretched
      // to (w, h). In that unit box, a "pill" with caps of radius 0.5 has
      // both caps meeting at the centre, i.e. it is a circle. After the (w,
      // h) scale, the rendered result is an ellipse — visually identical to
      // ellipseBorder. A true stadium with visible straight sides would need
      // the path generator to know the target w/h aspect, which the current
      // shape API does not pass. Kept as a separate entry for UI clarity and
      // backward-compat with existing presets. Inner arc uses sweep=0 so the
      // annulus is properly hole-wound.
      path: function (params) {
        var t = param(params, 'thickness', 0.1, 0.03, 0.24);
        var rIn = clamp(0.5 - t, 0.08, 0.47);
        return [
          'M0.5,0A0.5,0.5 0 1 1 0.5,1A0.5,0.5 0 1 1 0.5,0Z',
          'M0.5,' + t + 'A' + rIn + ',' + rIn + ' 0 1 0 0.5,' + (1 - t) +
            'A' + rIn + ',' + rIn + ' 0 1 0 0.5,' + t + 'Z'
        ];
      }
    },
    circle: {
      label: 'Circle',
      params: [],
      path: function () { return ['M0.5,0A0.5,0.5 0 1 1 0.5,1A0.5,0.5 0 1 1 0.5,0Z']; }
    },
    ring: {
      label: 'Ring border',
      border: true,
      params: [{ key: 'thickness', label: 'Border thickness', min: 0.03, max: 0.45, def: 0.12, step: 0.01, unit: 'ratio' }],
      path: function (params) {
        var t = param(params, 'thickness', 0.12, 0.03, 0.45);
        var r = 0.5 - t;
        return ['M0.5,0A0.5,0.5 0 1 1 0.5,1A0.5,0.5 0 1 1 0.5,0Z',
          'M0.5,' + t + 'A' + r + ',' + r + ' 0 1 0 0.5,' + (1 - t) + 'A' + r + ',' + r + ' 0 1 0 0.5,' + t + 'Z'];
      }
    },
    arrow: {
      label: 'Arrow right',
      params: [{ key: 'headRatio', label: 'Head length', min: 0.15, max: 0.8, def: 0.35, step: 0.01, unit: 'ratio' }, { key: 'shaftRatio', label: 'Shaft width', min: 0.1, max: 0.9, def: 0.35, step: 0.01, unit: 'ratio' }],
      path: function (params) {
        var hr = param(params, 'headRatio', 0.35, 0.15, 0.8);
        var sr = param(params, 'shaftRatio', 0.35, 0.1, 0.9);
        var y0 = (1 - sr) / 2;
        var y1 = y0 + sr;
        return [polygonPath([[0, y0], [1 - hr, y0], [1 - hr, 0], [1, 0.5], [1 - hr, 1], [1 - hr, y1], [0, y1]])];
      }
    },
    arrowLeft: {
      label: 'Arrow left',
      params: [{ key: 'headRatio', label: 'Head length', min: 0.15, max: 0.8, def: 0.35, step: 0.01, unit: 'ratio' }, { key: 'shaftRatio', label: 'Shaft width', min: 0.1, max: 0.9, def: 0.35, step: 0.01, unit: 'ratio' }],
      path: function (params) {
        var hr = param(params, 'headRatio', 0.35, 0.15, 0.8);
        var sr = param(params, 'shaftRatio', 0.35, 0.1, 0.9);
        var y0 = (1 - sr) / 2;
        var y1 = y0 + sr;
        // Order chosen so the winding matches arrow (right) and every other
        // outer shape — useful if any future code relies on CW-outer.
        return [polygonPath([[1, y1], [hr, y1], [hr, 1], [0, 0.5], [hr, 0], [hr, y0], [1, y0]])];
      }
    },
    // The unit box is SVG document space (Y-down), so y=0 is the TOP edge of
    // the placed shape: "up" points at y=0, "down" at y=1. Head length is a
    // fraction of the HEIGHT here (it runs along Y), and shaft width a
    // fraction of the WIDTH — the transpose of the left/right arrows, which
    // keeps both parameters reading the same way on screen.
    arrowUp: {
      label: 'Arrow up',
      params: [{ key: 'headRatio', label: 'Head length', min: 0.15, max: 0.8, def: 0.35, step: 0.01, unit: 'ratio' }, { key: 'shaftRatio', label: 'Shaft width', min: 0.1, max: 0.9, def: 0.35, step: 0.01, unit: 'ratio' }],
      path: function (params) {
        var hr = param(params, 'headRatio', 0.35, 0.15, 0.8);
        var sr = param(params, 'shaftRatio', 0.35, 0.1, 0.9);
        var x0 = (1 - sr) / 2;
        var x1 = x0 + sr;
        return [polygonPath([[x1, 1], [x0, 1], [x0, hr], [0, hr], [0.5, 0], [1, hr], [x1, hr]])];
      }
    },
    arrowDown: {
      label: 'Arrow down',
      params: [{ key: 'headRatio', label: 'Head length', min: 0.15, max: 0.8, def: 0.35, step: 0.01, unit: 'ratio' }, { key: 'shaftRatio', label: 'Shaft width', min: 0.1, max: 0.9, def: 0.35, step: 0.01, unit: 'ratio' }],
      path: function (params) {
        var hr = param(params, 'headRatio', 0.35, 0.15, 0.8);
        var sr = param(params, 'shaftRatio', 0.35, 0.1, 0.9);
        var x0 = (1 - sr) / 2;
        var x1 = x0 + sr;
        return [polygonPath([[x0, 0], [x1, 0], [x1, 1 - hr], [1, 1 - hr], [0.5, 1], [0, 1 - hr], [x0, 1 - hr]])];
      }
    },
    diamond: { label: 'Diamond', params: [], path: function () { return [polygonPath([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]])]; } },
    star: {
      label: 'Star',
      params: [{ key: 'innerRatio', label: 'Inner radius', min: 0.2, max: 0.8, def: 0.45, step: 0.01, unit: 'ratio' }, { key: 'points', label: 'Points', min: 3, max: 12, def: 5, step: 1, unit: 'count' }],
      path: function (params) {
        var inner = param(params, 'innerRatio', 0.45, 0.2, 0.8);
        var n = Math.round(param(params, 'points', 5, 3, 12));
        var pts = [];
        for (var i = 0; i < n * 2; i++) {
          var a = -Math.PI / 2 + i * Math.PI / n;
          var r = (i % 2 === 0) ? 0.5 : 0.5 * inner;
          pts.push([0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r]);
        }
        // Stars only fill the unit bbox for n in {4, 8, 12}. Stretch so any
        // configuration fills its declared dimensions.
        return [polygonPath(normalizeToBbox(pts))];
      }
    },
    triangle: { label: 'Triangle', params: [],
      path: function () { return [polygonPath([[0.5, 0], [1, 1], [0, 1]])]; } },
    pentagon: { label: 'Pentagon', params: [],
      path: function () {
        var pts = [];
        for (var i = 0; i < 5; i++) {
          var a = -Math.PI / 2 + i * 2 * Math.PI / 5;
          pts.push([0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5]);
        }
        // Regular pentagon inscribed in a unit circle only fills ~95% x 90%
        // of the unit bbox; stretch so width/height honour the declared dims.
        return [polygonPath(normalizeToBbox(pts))];
      } },
    octagon: { label: 'Octagon',
      params: [{ key: 'inset', label: 'Corner inset', min: 0.1, max: 0.45, def: 0.3, step: 0.01, unit: 'ratio' }],
      path: function (p) {
        var n = param(p, 'inset', 0.3, 0.1, 0.45);
        return [polygonPath([[n, 0], [1 - n, 0], [1, n], [1, 1 - n], [1 - n, 1], [n, 1], [0, 1 - n], [0, n]])];
      } },
    cross: { label: 'Cross / plus',
      params: [{ key: 'thickness', label: 'Arm thickness', min: 0.1, max: 0.8, def: 0.34, step: 0.01, unit: 'ratio' }],
      path: function (p) {
        var t = param(p, 'thickness', 0.34, 0.1, 0.8);
        var a = (1 - t) / 2, b = (1 + t) / 2;
        return [polygonPath([[a, 0], [b, 0], [b, a], [1, a], [1, b], [b, b], [b, 1], [a, 1], [a, b], [0, b], [0, a], [a, a]])];
      } },
    chevron: { label: 'Chevron',
      params: [{ key: 'notch', label: 'Notch depth', min: 0.1, max: 0.9, def: 0.5, step: 0.01, unit: 'ratio' }],
      path: function (p) {
        var d = param(p, 'notch', 0.5, 0.1, 0.9);
        return [polygonPath([[0, 0], [1, 0.5], [0, 1], [d, 0.5]])];
      } },
    trapezoid: { label: 'Trapezoid',
      params: [{ key: 'topWidth', label: 'Top width', min: 0.1, max: 0.95, def: 0.6, step: 0.01, unit: 'ratio' }],
      path: function (p) {
        var w = param(p, 'topWidth', 0.6, 0.1, 0.95);
        var x0 = (1 - w) / 2, x1 = (1 + w) / 2;
        return [polygonPath([[x0, 0], [x1, 0], [1, 1], [0, 1]])];
      } },
    parallelogram: { label: 'Parallelogram',
      params: [{ key: 'slant', label: 'Slant', min: 0.05, max: 0.6, def: 0.25, step: 0.01, unit: 'ratio' }],
      path: function (p) {
        var s = param(p, 'slant', 0.25, 0.05, 0.6);
        return [polygonPath([[s, 0], [1, 0], [1 - s, 1], [0, 1]])];
      } },
    banner: { label: 'Banner / ribbon',
      params: [{ key: 'notch', label: 'End notch', min: 0.05, max: 0.45, def: 0.18, step: 0.01, unit: 'ratio' }],
      path: function (p) {
        var n = param(p, 'notch', 0.18, 0.05, 0.45);
        return [polygonPath([[0, 0], [1, 0], [1 - n, 0.5], [1, 1], [0, 1], [n, 0.5]])];
      } },
    heart: { label: 'Heart', params: [],
      path: function () {
        return ['M0.5,0.27C0.5,0.12 0.35,0 0.2,0C0.07,0 0,0.13 0,0.27C0,0.45 0.18,0.62 0.5,1C0.82,0.62 1,0.45 1,0.27C1,0.13 0.93,0 0.8,0C0.65,0 0.5,0.12 0.5,0.27Z'];
      } },
    gear: { label: 'Gear',
      params: [{ key: 'teeth', label: 'Teeth', min: 6, max: 24, def: 10, step: 1, unit: 'count' }],
      path: function (p) {
        var n = Math.round(param(p, 'teeth', 10, 6, 24));
        var rOut = 0.5, rRoot = 0.4, step = 2 * Math.PI / n, pts = [];
        for (var i = 0; i < n; i++) {
          var a = -Math.PI / 2 + i * step;
          [[0.0, rRoot], [0.18, rRoot], [0.30, rOut], [0.70, rOut], [0.82, rRoot]].forEach(function (q) {
            var ang = a + step * q[0];
            pts.push([0.5 + Math.cos(ang) * q[1], 0.5 + Math.sin(ang) * q[1]]);
          });
        }
        // Tooth tips don't quite reach the bbox edges — normalize the outer
        // contour so a gear sized 100x100 really fills 100x100. For odd
        // tooth counts the bbox is NOT centred on the rotation axis, so the
        // true centre (0.5, 0.5) must be mapped through the same
        // normalization — a hard-coded 0.5 leaves the bore visibly
        // eccentric on odd-count gears.
        // Bore drawn with sweep=0 so its winding is opposite the outer gear
        // (CW) — proper hole annulus under any winding-aware fill rule.
        var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (var k = 0; k < pts.length; k++) {
          minX = Math.min(minX, pts[k][0]); maxX = Math.max(maxX, pts[k][0]);
          minY = Math.min(minY, pts[k][1]); maxY = Math.max(maxY, pts[k][1]);
        }
        var rw = Math.max(1e-9, maxX - minX), rh = Math.max(1e-9, maxY - minY);
        var bcx = round((0.5 - minX) / rw), bcy = round((0.5 - minY) / rh);
        var brx = round(0.15 / rw), bry = round(0.15 / rh);
        return [polygonPath(normalizeToBbox(pts)),
                'M' + bcx + ',' + round(bcy - bry) +
                'A' + brx + ',' + bry + ' 0 1 0 ' + bcx + ',' + round(bcy + bry) +
                'A' + brx + ',' + bry + ' 0 1 0 ' + bcx + ',' + round(bcy - bry) + 'Z'];
      } },
    lightning: { label: 'Lightning bolt', params: [],
      path: function () {
        // Reordered so winding is CW like every other outer shape, and
        // normalized so it actually fills the declared bbox (was 0.8 x 1.0).
        var pts = [[0.78, 0], [0.5, 0.42], [0.9, 0.42], [0.3, 1], [0.45, 0.55], [0.1, 0.55], [0.6, 0]];
        return [polygonPath(normalizeToBbox(pts))];
      } }

  };

  Forge.shapes = { SHAPES: SHAPES };
})(typeof window !== 'undefined' ? (window.Forge = window.Forge || {}) : (global.Forge = global.Forge || {}));
