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
      label: 'Arrow',
      params: [{ key: 'headRatio', label: 'Head length', min: 0.15, max: 0.8, def: 0.35, step: 0.01, unit: 'ratio' }, { key: 'shaftRatio', label: 'Shaft width', min: 0.1, max: 0.9, def: 0.35, step: 0.01, unit: 'ratio' }],
      path: function (params) {
        var hr = clamp(params.headRatio == null ? 0.35 : params.headRatio, 0.15, 0.8);
        var sr = clamp(params.shaftRatio == null ? 0.35 : params.shaftRatio, 0.1, 0.9);
        var y0 = (1 - sr) / 2;
        var y1 = y0 + sr;
        return [polygonPath([[0, y0], [1 - hr, y0], [1 - hr, 0], [1, 0.5], [1 - hr, 1], [1 - hr, y1], [0, y1]])];
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
    }
  };

  Forge.shapes = { SHAPES: SHAPES };
})(typeof window !== 'undefined' ? (window.Forge = window.Forge || {}) : (global.Forge = global.Forge || {}));
