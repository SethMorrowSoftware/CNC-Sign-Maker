/**
 * LowRider Forge — bitmap tracing (phase 1 MVP).
 * Converts high-contrast bitmaps into closed/open polylines in mm space.
 */
(function (Forge) {
  'use strict';

  function traceImageBitmap(bitmap, opts) {
    opts = opts || {};
    var maxW = 1400;
    var scale = bitmap.width > maxW ? (maxW / bitmap.width) : 1;
    var w = Math.max(1, Math.round(bitmap.width * scale));
    var h = Math.max(1, Math.round(bitmap.height * scale));
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(bitmap, 0, 0, w, h);
    var img = cx.getImageData(0, 0, w, h);
    return traceImageData(img, Object.assign({ sourceWidth: bitmap.width, sourceHeight: bitmap.height }, opts));
  }

  function traceImageData(img, opts) {
    opts = opts || {};
    var w = img.width, h = img.height, d = img.data;
    var threshold = isFinite(opts.threshold) ? opts.threshold : 145;
    var minAreaPx = isFinite(opts.minAreaPx) ? Math.max(0, opts.minAreaPx) : 20;
    var mmPerPixel = isFinite(opts.mmPerPixel) && opts.mmPerPixel > 0 ? opts.mmPerPixel : 0.2;
    var simplifyMm = isFinite(opts.simplifyMm) ? Math.max(0.02, opts.simplifyMm) : 0.08;

    var grid = new Uint8Array((w + 1) * (h + 1));
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = (y * w + x) * 4;
        var a = d[i + 3] / 255;
        var lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) * a + (1 - a) * 255;
        if (lum < threshold) grid[y * (w + 1) + x] = 1;
      }
    }

    var loops = traceLoops(grid, w, h);
    var subpaths = [];
    var nodesBefore = 0, nodesAfter = 0;
    for (var k = 0; k < loops.length; k++) {
      if (Math.abs(polygonArea(loops[k])) < minAreaPx) continue;
      nodesBefore += Math.max(0, loops[k].length - 1);
      var simp = simplifyDP(loops[k], simplifyMm / mmPerPixel, true);
      if (simp.length < 3) continue;
      nodesAfter += Math.max(0, simp.length - 1);
      var pts = simp.map(function (p) { return [p[0] * mmPerPixel, p[1] * mmPerPixel]; });
      subpaths.push({ points: pts, closed: true });
    }

    return {
      width_mm: w * mmPerPixel,
      height_mm: h * mmPerPixel,
      hadUnits: true,
      subpaths: subpaths,
      trace: {
        widthPx: w, heightPx: h, threshold: threshold,
        nodesBefore: nodesBefore, nodesAfter: nodesAfter
      }
    };
  }

  function traceLoops(grid, w, h) {
    var edges = new Map();
    function addEdge(x1, y1, x2, y2) {
      var k = x1 + ',' + y1;
      var a = edges.get(k); if (!a) { a = []; edges.set(k, a); }
      a.push([x2, y2]);
    }
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (!grid[y * (w + 1) + x]) continue;
        if (y === 0 || !grid[(y - 1) * (w + 1) + x]) addEdge(x, y, x + 1, y);
        if (x === w - 1 || !grid[y * (w + 1) + (x + 1)]) addEdge(x + 1, y, x + 1, y + 1);
        if (y === h - 1 || !grid[(y + 1) * (w + 1) + x]) addEdge(x + 1, y + 1, x, y + 1);
        if (x === 0 || !grid[y * (w + 1) + (x - 1)]) addEdge(x, y + 1, x, y);
      }
    }
    var loops = [];
    while (edges.size) {
      var startKey = edges.keys().next().value;
      var parts = startKey.split(',');
      var sx = +parts[0], sy = +parts[1], cx = sx, cy = sy;
      var loop = [[cx, cy]];
      var guard = 0;
      while (guard++ < 200000) {
        var key = cx + ',' + cy;
        var nexts = edges.get(key);
        if (!nexts || !nexts.length) break;
        var nxt = nexts.pop();
        if (!nexts.length) edges.delete(key);
        cx = nxt[0]; cy = nxt[1];
        loop.push([cx, cy]);
        if (cx === sx && cy === sy) break;
      }
      if (loop.length > 3 && loop[loop.length - 1][0] === sx && loop[loop.length - 1][1] === sy) loops.push(loop);
    }
    return loops;
  }

  function polygonArea(pts) { var a = 0; for (var i = 0; i < pts.length - 1; i++) a += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1]; return a / 2; }
  function simplifyDP(points, tol, closed) {
    if (points.length < 4) return points.slice();
    var pts = closed ? points.slice(0, -1) : points.slice();
    var keep = new Uint8Array(pts.length); keep[0] = 1; keep[pts.length - 1] = 1;
    var stack = [[0, pts.length - 1]];
    while (stack.length) {
      var s = stack.pop(), a = s[0], b = s[1], maxD = -1, idx = -1;
      for (var i = a + 1; i < b; i++) {
        var d = perpDist(pts[i], pts[a], pts[b]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > tol && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    var out = []; for (var j = 0; j < pts.length; j++) if (keep[j]) out.push(pts[j]);
    if (closed && out.length > 2) out.push(out[0]);
    return out;
  }
  function perpDist(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    if (Math.abs(dx) + Math.abs(dy) < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / Math.hypot(dx, dy);
  }

  Forge.BitmapTracer = { traceImageBitmap: traceImageBitmap, traceImageData: traceImageData };
})(window.Forge = window.Forge || {});
