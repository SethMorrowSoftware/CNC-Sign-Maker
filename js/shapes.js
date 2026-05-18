(function (Forge) {
  'use strict';

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function round(v) { return Math.round(v * 1000) / 1000; }

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

  var SHAPES = {
    rectangle: { label: 'Rectangle', params: [], path: function () { return ['M0,0L1,0L1,1L0,1Z']; } },
    roundedRect: {
      label: 'Rounded rectangle',
      params: [{ key: 'radius', label: 'Corner radius', min: 0.01, max: 0.49, def: 0.16, step: 0.01, unit: 'ratio' }],
      path: function (params) {
        var r = clamp(params.radius == null ? 0.16 : params.radius, 0.01, 0.49);
        return ['M' + r + ',0L' + (1 - r) + ',0A' + r + ',' + r + ' 0 0 1 1,' + r +
          'L1,' + (1 - r) + 'A' + r + ',' + r + ' 0 0 1 ' + (1 - r) + ',1L' + r + ',1A' + r + ',' + r +
          ' 0 0 1 0,' + (1 - r) + 'L0,' + r + 'A' + r + ',' + r + ' 0 0 1 ' + r + ',0Z'];
      }
    },
    borderRect: {
      label: 'Rectangular border',
      params: [{ key: 'thickness', label: 'Border thickness', min: 0.03, max: 0.45, def: 0.12, step: 0.01, unit: 'ratio' }],
      path: function (params) {
        var t = clamp(params.thickness == null ? 0.12 : params.thickness, 0.03, 0.45);
        return [rectPath(0, 0, 1, 1), rectPath(t, t, 1 - 2 * t, 1 - 2 * t)];
      }
    },
    roundedBorderRect: {
      label: 'Rounded border',
      params: [
        { key: 'thickness', label: 'Border thickness', min: 0.03, max: 0.45, def: 0.12, step: 0.01, unit: 'ratio' },
        { key: 'radius', label: 'Corner radius', min: 0.03, max: 0.49, def: 0.16, step: 0.01, unit: 'ratio' }
      ],
      path: function (params) {
        var t = clamp(params.thickness == null ? 0.12 : params.thickness, 0.03, 0.45);
        var rOuter = clamp(params.radius == null ? 0.16 : params.radius, 0.03, 0.49);
        var innerW = 1 - 2 * t;
        var innerH = 1 - 2 * t;
        if (innerW <= 0.01 || innerH <= 0.01) return [];
        var rInner = clamp(rOuter - t, 0.01, Math.min(innerW, innerH) * 0.5 - 0.005);
        return [
          'M' + rOuter + ',0L' + (1 - rOuter) + ',0A' + rOuter + ',' + rOuter + ' 0 0 1 1,' + rOuter +
            'L1,' + (1 - rOuter) + 'A' + rOuter + ',' + rOuter + ' 0 0 1 ' + (1 - rOuter) + ',1L' + rOuter + ',1A' + rOuter + ',' + rOuter +
            ' 0 0 1 0,' + (1 - rOuter) + 'L0,' + rOuter + 'A' + rOuter + ',' + rOuter + ' 0 0 1 ' + rOuter + ',0Z',
          'M' + (t + rInner) + ',' + t + 'L' + (1 - t - rInner) + ',' + t + 'A' + rInner + ',' + rInner + ' 0 0 1 ' + (1 - t) + ',' + (t + rInner) +
            'L' + (1 - t) + ',' + (1 - t - rInner) + 'A' + rInner + ',' + rInner + ' 0 0 1 ' + (1 - t - rInner) + ',' + (1 - t) +
            'L' + (t + rInner) + ',' + (1 - t) + 'A' + rInner + ',' + rInner + ' 0 0 1 ' + t + ',' + (1 - t - rInner) +
            'L' + t + ',' + (t + rInner) + 'A' + rInner + ',' + rInner + ' 0 0 1 ' + (t + rInner) + ',' + t + 'Z'
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
      params: [{ key: 'thickness', label: 'Border thickness', min: 0.03, max: 0.45, def: 0.12, step: 0.01, unit: 'ratio' }],
      path: function (params) {
        var t = clamp(params.thickness == null ? 0.12 : params.thickness, 0.03, 0.45);
        var r = 0.5 - t;
        return ['M0.5,0A0.5,0.5 0 1 1 0.5,1A0.5,0.5 0 1 1 0.5,0Z',
          'M0.5,' + t + 'A' + r + ',' + r + ' 0 1 0 0.5,' + (1 - t) + 'A' + r + ',' + r + ' 0 1 0 0.5,' + t + 'Z'];
      }
    },
    hexagon: {
      label: 'Hexagon',
      params: [{ key: 'inset', label: 'Corner inset', min: 0.1, max: 0.45, def: 0.25, step: 0.01, unit: 'ratio' }],
      path: function (params) {
        var inset = clamp(params.inset == null ? 0.25 : params.inset, 0.1, 0.45);
        return [polygonPath([[inset, 0], [1 - inset, 0], [1, 0.5], [1 - inset, 1], [inset, 1], [0, 0.5]])];
      }
    },
    hexagonBorder: {
      label: 'Hexagon border',
      params: [
        { key: 'inset', label: 'Corner inset', min: 0.1, max: 0.45, def: 0.25, step: 0.01, unit: 'ratio' },
        { key: 'thickness', label: 'Border thickness', min: 0.03, max: 0.24, def: 0.1, step: 0.01, unit: 'ratio' }
      ],
      path: function (params) {
        var inset = clamp(params.inset == null ? 0.25 : params.inset, 0.1, 0.45);
        var t = clamp(params.thickness == null ? 0.1 : params.thickness, 0.03, 0.24);
        var innerInset = clamp(inset + t, 0.12, 0.49);
        var yTop = t;
        var yBot = 1 - t;
        var rightX = 1 - t;
        var leftX = t;
        return [
          polygonPath([[inset, 0], [1 - inset, 0], [1, 0.5], [1 - inset, 1], [inset, 1], [0, 0.5]]),
          polygonPath([[innerInset, yTop], [1 - innerInset, yTop], [rightX, 0.5], [1 - innerInset, yBot], [innerInset, yBot], [leftX, 0.5]])
        ];
      }
    },
    pillBorder: {
      label: 'Pill border',
      params: [{ key: 'thickness', label: 'Border thickness', min: 0.03, max: 0.24, def: 0.1, step: 0.01, unit: 'ratio' }],
      path: function (params) {
        var t = clamp(params.thickness == null ? 0.1 : params.thickness, 0.03, 0.24);
        var rOuter = 0.5;
        var rInner = clamp(rOuter - t, 0.08, 0.47);
        var xLeft = 0;
        var xRight = 1;
        var xLeftInner = t;
        var xRightInner = 1 - t;
        return [
          'M0.5,0L0.5,0A' + rOuter + ',' + rOuter + ' 0 0 1 ' + xRight + ',0.5A' + rOuter + ',' + rOuter + ' 0 0 1 0.5,1A' + rOuter + ',' + rOuter + ' 0 0 1 ' + xLeft + ',0.5A' + rOuter + ',' + rOuter + ' 0 0 1 0.5,0Z',
          'M0.5,' + t + 'A' + rInner + ',' + rInner + ' 0 0 0 ' + xLeftInner + ',0.5A' + rInner + ',' + rInner + ' 0 0 0 0.5,' + (1 - t) + 'A' + rInner + ',' + rInner + ' 0 0 0 ' + xRightInner + ',0.5A' + rInner + ',' + rInner + ' 0 0 0 0.5,' + t + 'Z'
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
      params: [{ key: 'thickness', label: 'Border thickness', min: 0.03, max: 0.45, def: 0.12, step: 0.01, unit: 'ratio' }],
      path: function (params) {
        var t = clamp(params.thickness == null ? 0.12 : params.thickness, 0.03, 0.45);
        var r = 0.5 - t;
        return ['M0.5,0A0.5,0.5 0 1 1 0.5,1A0.5,0.5 0 1 1 0.5,0Z',
          'M0.5,' + t + 'A' + r + ',' + r + ' 0 1 0 0.5,' + (1 - t) + 'A' + r + ',' + r + ' 0 1 0 0.5,' + t + 'Z'];
      }
    },
    arrow: {
      label: 'Arrow right',
      params: [{ key: 'headRatio', label: 'Head length', min: 0.15, max: 0.8, def: 0.35, step: 0.01, unit: 'ratio' }, { key: 'shaftRatio', label: 'Shaft width', min: 0.1, max: 0.9, def: 0.35, step: 0.01, unit: 'ratio' }],
      path: function (params) {
        var hr = clamp(params.headRatio == null ? 0.35 : params.headRatio, 0.15, 0.8);
        var sr = clamp(params.shaftRatio == null ? 0.35 : params.shaftRatio, 0.1, 0.9);
        var y0 = (1 - sr) / 2;
        var y1 = y0 + sr;
        return [polygonPath([[0, y0], [1 - hr, y0], [1 - hr, 0], [1, 0.5], [1 - hr, 1], [1 - hr, y1], [0, y1]])];
      }
    },
    arrowLeft: {
      label: 'Arrow left',
      params: [{ key: 'headRatio', label: 'Head length', min: 0.15, max: 0.8, def: 0.35, step: 0.01, unit: 'ratio' }, { key: 'shaftRatio', label: 'Shaft width', min: 0.1, max: 0.9, def: 0.35, step: 0.01, unit: 'ratio' }],
      path: function (params) {
        var hr = clamp(params.headRatio == null ? 0.35 : params.headRatio, 0.15, 0.8);
        var sr = clamp(params.shaftRatio == null ? 0.35 : params.shaftRatio, 0.1, 0.9);
        var y0 = (1 - sr) / 2;
        var y1 = y0 + sr;
        return [polygonPath([[1, y0], [hr, y0], [hr, 0], [0, 0.5], [hr, 1], [hr, y1], [1, y1]])];
      }
    },
    diamond: { label: 'Diamond', params: [], path: function () { return [polygonPath([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]])]; } },
    star: {
      label: 'Star',
      params: [{ key: 'innerRatio', label: 'Inner radius', min: 0.2, max: 0.8, def: 0.45, step: 0.01, unit: 'ratio' }, { key: 'points', label: 'Points', min: 3, max: 12, def: 5, step: 1, unit: 'count' }],
      path: function (params) {
        var inner = clamp(params.innerRatio == null ? 0.45 : params.innerRatio, 0.2, 0.8);
        var n = Math.round(clamp(params.points == null ? 5 : params.points, 3, 12));
        var pts = [];
        for (var i = 0; i < n * 2; i++) {
          var a = -Math.PI / 2 + i * Math.PI / n;
          var r = (i % 2 === 0) ? 0.5 : 0.5 * inner;
          pts.push([0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r]);
        }
        return [polygonPath(pts)];
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
        return [polygonPath(pts)];
      } },
    octagon: { label: 'Octagon',
      params: [{ key: 'inset', label: 'Corner inset', min: 0.1, max: 0.45, def: 0.3, step: 0.01, unit: 'ratio' }],
      path: function (p) {
        var n = clamp(p.inset == null ? 0.3 : p.inset, 0.1, 0.45);
        return [polygonPath([[n, 0], [1 - n, 0], [1, n], [1, 1 - n], [1 - n, 1], [n, 1], [0, 1 - n], [0, n]])];
      } },
    cross: { label: 'Cross / plus',
      params: [{ key: 'thickness', label: 'Arm thickness', min: 0.1, max: 0.8, def: 0.34, step: 0.01, unit: 'ratio' }],
      path: function (p) {
        var t = clamp(p.thickness == null ? 0.34 : p.thickness, 0.1, 0.8);
        var a = (1 - t) / 2, b = (1 + t) / 2;
        return [polygonPath([[a, 0], [b, 0], [b, a], [1, a], [1, b], [b, b], [b, 1], [a, 1], [a, b], [0, b], [0, a], [a, a]])];
      } },
    chevron: { label: 'Chevron',
      params: [{ key: 'notch', label: 'Notch depth', min: 0.1, max: 0.9, def: 0.5, step: 0.01, unit: 'ratio' }],
      path: function (p) {
        var d = clamp(p.notch == null ? 0.5 : p.notch, 0.1, 0.9);
        return [polygonPath([[0, 0], [1, 0.5], [0, 1], [d, 0.5]])];
      } },
    trapezoid: { label: 'Trapezoid',
      params: [{ key: 'topWidth', label: 'Top width', min: 0.1, max: 0.95, def: 0.6, step: 0.01, unit: 'ratio' }],
      path: function (p) {
        var w = clamp(p.topWidth == null ? 0.6 : p.topWidth, 0.1, 0.95);
        var x0 = (1 - w) / 2, x1 = (1 + w) / 2;
        return [polygonPath([[x0, 0], [x1, 0], [1, 1], [0, 1]])];
      } },
    parallelogram: { label: 'Parallelogram',
      params: [{ key: 'slant', label: 'Slant', min: 0.05, max: 0.6, def: 0.25, step: 0.01, unit: 'ratio' }],
      path: function (p) {
        var s = clamp(p.slant == null ? 0.25 : p.slant, 0.05, 0.6);
        return [polygonPath([[s, 0], [1, 0], [1 - s, 1], [0, 1]])];
      } },
    banner: { label: 'Banner / ribbon',
      params: [{ key: 'notch', label: 'End notch', min: 0.05, max: 0.45, def: 0.18, step: 0.01, unit: 'ratio' }],
      path: function (p) {
        var n = clamp(p.notch == null ? 0.18 : p.notch, 0.05, 0.45);
        return [polygonPath([[0, 0], [1, 0], [1 - n, 0.5], [1, 1], [0, 1], [n, 0.5]])];
      } },
    heart: { label: 'Heart', params: [],
      path: function () {
        return ['M0.5,0.27C0.5,0.12 0.35,0 0.2,0C0.07,0 0,0.13 0,0.27C0,0.45 0.18,0.62 0.5,1C0.82,0.62 1,0.45 1,0.27C1,0.13 0.93,0 0.8,0C0.65,0 0.5,0.12 0.5,0.27Z'];
      } },
    gear: { label: 'Gear',
      params: [{ key: 'teeth', label: 'Teeth', min: 6, max: 24, def: 10, step: 1, unit: 'count' }],
      path: function (p) {
        var n = Math.round(clamp(p.teeth == null ? 10 : p.teeth, 6, 24));
        var rOut = 0.5, rRoot = 0.4, step = 2 * Math.PI / n, pts = [];
        for (var i = 0; i < n; i++) {
          var a = -Math.PI / 2 + i * step;
          [[0.0, rRoot], [0.18, rRoot], [0.30, rOut], [0.70, rOut], [0.82, rRoot]].forEach(function (q) {
            var ang = a + step * q[0];
            pts.push([0.5 + Math.cos(ang) * q[1], 0.5 + Math.sin(ang) * q[1]]);
          });
        }
        return [polygonPath(pts), 'M0.5,0.35A0.15,0.15 0 1 1 0.5,0.65A0.15,0.15 0 1 1 0.5,0.35Z'];
      } },
    lightning: { label: 'Lightning bolt', params: [],
      path: function () {
        return [polygonPath([[0.6, 0], [0.1, 0.55], [0.45, 0.55], [0.3, 1], [0.9, 0.42], [0.5, 0.42], [0.78, 0]])];
      } }

  };

  Forge.shapes = { SHAPES: SHAPES };
})(typeof window !== 'undefined' ? (window.Forge = window.Forge || {}) : (global.Forge = global.Forge || {}));
