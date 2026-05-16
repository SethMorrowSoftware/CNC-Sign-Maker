/**
 * LowRider Forge — geometry operations.
 *
 * Polygon offsetting is delegated to the vendored Clipper library (the spec
 * calls hand-rolled offsetting "a trap"). Everything else — area, perimeter,
 * point-in-polygon, arc-length sampling — is small and self-contained.
 *
 * Coordinate convention here is machine space: millimetres, Y-up. A polygon
 * wound counter-clockwise therefore has a positive signed area.
 */
(function (Forge) {
  'use strict';

  var SCALE = 10000; // mm -> integer for Clipper

  function clipper() {
    var C = (typeof window !== 'undefined' && window.ClipperLib) ||
            (typeof ClipperLib !== 'undefined' && ClipperLib) || null;
    if (!C) throw new Error('Clipper library failed to load (js/lib/clipper.js).');
    return C;
  }

  function toClipper(points) {
    var out = [];
    for (var i = 0; i < points.length; i++) {
      out.push({ X: Math.round(points[i][0] * SCALE), Y: Math.round(points[i][1] * SCALE) });
    }
    return out;
  }
  function fromClipper(path) {
    var out = [];
    for (var i = 0; i < path.length; i++) out.push([path[i].X / SCALE, path[i].Y / SCALE]);
    return out;
  }

  /** Signed polygon area (Y-up: positive == counter-clockwise). */
  function area(points) {
    var a = 0, n = points.length;
    for (var i = 0; i < n; i++) {
      var j = (i + 1) % n;
      a += points[i][0] * points[j][1] - points[j][0] * points[i][1];
    }
    return a / 2;
  }

  /** Perimeter length. Closed polygons include the closing segment. */
  function perimeter(points, closed) {
    var d = 0, n = points.length;
    var lim = closed ? n : n - 1;
    for (var i = 0; i < lim; i++) {
      var j = (i + 1) % n;
      d += Math.hypot(points[j][0] - points[i][0], points[j][1] - points[i][1]);
    }
    return d;
  }

  function bbox(points) {
    var b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (var i = 0; i < points.length; i++) {
      b.minX = Math.min(b.minX, points[i][0]); b.maxX = Math.max(b.maxX, points[i][0]);
      b.minY = Math.min(b.minY, points[i][1]); b.maxY = Math.max(b.maxY, points[i][1]);
    }
    return b;
  }

  /** Area-weighted centroid; falls back to bbox centre for degenerate input. */
  function centroid(points) {
    var a = 0, cx = 0, cy = 0, n = points.length;
    for (var i = 0; i < n; i++) {
      var j = (i + 1) % n;
      var cross = points[i][0] * points[j][1] - points[j][0] * points[i][1];
      a += cross;
      cx += (points[i][0] + points[j][0]) * cross;
      cy += (points[i][1] + points[j][1]) * cross;
    }
    if (Math.abs(a) < 1e-9) {
      var b = bbox(points);
      return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
    }
    return [cx / (3 * a), cy / (3 * a)];
  }

  /** Ray-cast point-in-polygon test. */
  function pointInPolygon(pt, poly) {
    var inside = false, n = poly.length;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > pt[1]) !== (yj > pt[1])) &&
          (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  function reverse(points) { return points.slice().reverse(); }

  function ensureWinding(points, want) {
    var ccw = area(points) >= 0;
    if ((want === 'ccw') !== ccw) return reverse(points);
    return points.slice();
  }

  /** Cumulative arc length at each vertex (closed adds the wrap entry). */
  function cumulative(points, closed) {
    var c = [0], n = points.length, lim = closed ? n : n - 1;
    for (var i = 0; i < lim; i++) {
      var j = (i + 1) % n;
      c.push(c[c.length - 1] +
        Math.hypot(points[j][0] - points[i][0], points[j][1] - points[i][1]));
    }
    return c;
  }

  /** Interpolated [x,y] at perimeter distance `dist` (wraps when closed). */
  function pointAtDistance(points, closed, cum, dist) {
    var total = cum[cum.length - 1];
    if (total <= 0) return points[0].slice();
    if (closed) { dist = ((dist % total) + total) % total; }
    else { dist = Math.max(0, Math.min(total, dist)); }
    var lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (cum[mid] <= dist) lo = mid; else hi = mid;
    }
    var seg = cum[hi] - cum[lo];
    var t = seg > 1e-9 ? (dist - cum[lo]) / seg : 0;
    var a = points[lo % points.length], b = points[hi % points.length];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  /**
   * Offset a closed polygon. Positive delta grows it (outward), negative
   * shrinks it (inward). Returns an array of polygons — an inward offset can
   * split one polygon into several, or collapse it to none.
   *
   * @param {number[][]} points
   * @param {number} delta  millimetres
   * @param {object} [opts] { joinType: 'miter'|'round'|'square', miterLimit }
   * @returns {number[][][]}
   */
  function offset(points, delta, opts) {
    opts = opts || {};
    if (points.length < 3) return [];
    if (Math.abs(delta) < 1e-6) return [points.slice()];

    var C = clipper();
    var jt = C.JoinType.jtMiter;
    if (opts.joinType === 'round') jt = C.JoinType.jtRound;
    else if (opts.joinType === 'square') jt = C.JoinType.jtSquare;

    var co = new C.ClipperOffset(opts.miterLimit || 2.0, 0.05 * SCALE);
    co.AddPath(toClipper(points), jt, C.EndType.etClosedPolygon);
    var solution = new C.Paths();
    co.Execute(solution, delta * SCALE);

    var result = [];
    for (var i = 0; i < solution.length; i++) {
      if (solution[i].length >= 3) {
        result.push(ensureWinding(fromClipper(solution[i]), 'ccw'));
      }
    }
    return result;
  }

  Forge.geometry = {
    SCALE: SCALE,
    area: area,
    perimeter: perimeter,
    bbox: bbox,
    centroid: centroid,
    pointInPolygon: pointInPolygon,
    reverse: reverse,
    ensureWinding: ensureWinding,
    cumulative: cumulative,
    pointAtDistance: pointAtDistance,
    offset: offset
  };
})(typeof window !== 'undefined' ? (window.Forge = window.Forge || {})
                                 : (global.Forge = global.Forge || {}));
