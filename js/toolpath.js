/**
 * LowRider Forge — toolpath generation.
 *
 * Transforms parsed SVG geometry into machine space, then emits ordered
 * motion for the four operation types. All output is in machine space:
 * millimetres, Y-up, Z=0 on top of the material, negative Z into the work.
 *
 * A "move" is { t, x, y, z, f } where t is rapid | plunge | cut | arc.
 * Arc moves carry i, j (centre offset from the move's start point) and ccw.
 */
(function (Forge) {
  'use strict';

  var G = Forge.geometry;
  var OP_COLORS = {
    engrave: '#16a34a', 'profile-out': '#2563eb',
    'profile-in': '#c026d3', drill: '#ea580c', pocket: '#0d9488',
    vcarve: '#7c3aed'
  };
  var OP_ORDER = {
    drill: 0, 'profile-in': 1, engrave: 2, pocket: 2, vcarve: 2, 'profile-out': 3
  };

  /* ---- job-space transform ------------------------------------------- */

  /**
   * Apply scale, rotation, Y-flip and placement to parsed geometry.
   * Result is in machine space and classified against the hole threshold.
   */
  function prepareJob(geometry, s) {
    var scale = (s.scale || 100) / 100;
    var rot = ((s.rotation || 0) % 360 + 360) % 360;
    var rad = rot * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);

    function place(p) {
      var x = p[0] * scale, y = -p[1] * scale;       // scale, then SVG Y-down -> Y-up
      return [x * cos - y * sin, x * sin + y * cos];  // rotate CCW in machine space
    }

    var moved = geometry.subpaths.map(function (sp) {
      return { points: sp.points.map(place), closed: sp.closed };
    }).filter(function (sp) {
      // Drop any subpath carrying a non-finite coordinate so a malformed SVG
      // (overflowing transform, degenerate arc) can never reach the gcode.
      return sp.points.length > 0 && sp.points.every(function (p) {
        return isFinite(p[0]) && isFinite(p[1]);
      });
    });

    var b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    moved.forEach(function (sp) {
      var bb = G.bbox(sp.points);
      b.minX = Math.min(b.minX, bb.minX); b.minY = Math.min(b.minY, bb.minY);
      b.maxX = Math.max(b.maxX, bb.maxX); b.maxY = Math.max(b.maxY, bb.maxY);
    });
    // In text-sign mode, lock job bounds to the declared sign dimensions so
    // resizing or repositioning text/shapes never changes the sign envelope.
    if (geometry && geometry.isText &&
        isFinite(geometry.signWidthMm) && isFinite(geometry.signHeightMm)) {
      var signPts = [
        place([0, 0]),
        place([geometry.signWidthMm, 0]),
        place([geometry.signWidthMm, geometry.signHeightMm]),
        place([0, geometry.signHeightMm])
      ];
      var sb = G.bbox(signPts);
      b.minX = Math.min(b.minX, sb.minX); b.minY = Math.min(b.minY, sb.minY);
      b.maxX = Math.max(b.maxX, sb.maxX); b.maxY = Math.max(b.maxY, sb.maxY);
    }

    var margin = s.stockMargin != null ? s.stockMargin : 0;
    // A fully degenerate input (every subpath dropped) leaves b unbounded —
    // collapse it to the origin so stock size and placement stay finite.
    if (!isFinite(b.minX)) {
      b = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }
    var tx, ty;
    if (s.originPosition === 'center') {
      tx = -(b.minX + b.maxX) / 2; ty = -(b.minY + b.maxY) / 2;
    } else if (s.originPosition === 'top-left') {
      tx = margin - b.minX; ty = -margin - b.maxY;
    } else if (s.originPosition === 'custom') {
      tx = (s.customOriginX || 0) - b.minX; ty = (s.customOriginY || 0) - b.minY;
    } else { // bottom-left (default) — keeps every coordinate positive
      tx = margin - b.minX; ty = margin - b.minY;
    }

    var threshold = s.holeThreshold != null ? s.holeThreshold : 50;
    var subpaths = moved.map(function (sp) {
      var pts = sp.points.map(function (p) { return [p[0] + tx, p[1] + ty]; });
      var ar = sp.closed ? Math.abs(G.area(pts)) : 0;
      return {
        points: pts,
        closed: sp.closed,
        area: ar,
        bbox: G.bbox(pts),
        winding: sp.closed && G.area(pts) >= 0 ? 'ccw' : 'cw',
        type: !sp.closed ? 'open' : (ar < threshold ? 'hole' : 'outer')
      };
    });

    var partBbox = {
      minX: b.minX + tx, minY: b.minY + ty, maxX: b.maxX + tx, maxY: b.maxY + ty
    };
    return {
      source: geometry && geometry.trace ? { trace: geometry.trace } : null,
      subpaths: subpaths,
      partBbox: partBbox,
      partWidth: partBbox.maxX - partBbox.minX,
      partHeight: partBbox.maxY - partBbox.minY,
      stock: {
        minX: partBbox.minX - margin, minY: partBbox.minY - margin,
        maxX: partBbox.maxX + margin, maxY: partBbox.maxY + margin
      },
      stockWidth: partBbox.maxX - partBbox.minX + 2 * margin,
      stockHeight: partBbox.maxY - partBbox.minY + 2 * margin
    };
  }

  /* ---- pass depths ---------------------------------------------------- */

  /** Step from 0 down to finalZ in DOC increments; last step is always finalZ.
      The DOC is widened if needed so a tiny value cannot generate a runaway
      pass count that would freeze the browser. */
  function computeDepths(finalZ, doc) {
    if (finalZ >= 0) return [finalZ];
    doc = Math.abs(doc) > 1e-6 ? Math.abs(doc) : Math.abs(finalZ);
    var maxPasses = 1000;
    if (Math.abs(finalZ) / doc > maxPasses) doc = Math.abs(finalZ) / maxPasses;
    var depths = [], z = 0;
    while (depths.length < maxPasses) {
      z -= doc;
      if (z <= finalZ + 1e-6) break;
      depths.push(z);
    }
    depths.push(finalZ);
    return depths;
  }

  /* ---- plunge / descent ---------------------------------------------- */

  /** Z descent from `fromZ` to `toZ`, honouring the plunge style. */
  function descend(fromZ, toZ, ctx) {
    var m = [];
    if (toZ >= fromZ) { return [{ t: 'plunge', z: toZ, f: ctx.feedPlunge }]; }
    if (ctx.plungeStyle !== 'peck') {
      return [{ t: 'plunge', z: toZ, f: ctx.feedPlunge }];
    }
    var step = Math.max(0.8, ctx.peckStep), targets = [], z = fromZ;
    while (true) {
      z -= step;
      if (z <= toZ + 1e-6) { targets.push(toZ); break; }
      targets.push(z);
    }
    var cz = fromZ;
    for (var i = 0; i < targets.length; i++) {
      if (cz !== fromZ) m.push({ t: 'rapid', z: cz + 0.5 });
      m.push({ t: 'plunge', z: targets[i], f: ctx.feedPlunge });
      cz = targets[i];
      if (i < targets.length - 1) m.push({ t: 'rapid', z: fromZ });
    }
    return m;
  }

  /* ---- tabs ----------------------------------------------------------- */

  function placeTabs(poly, ctx) {
    if (!ctx.tabsEnabled || ctx.tabCount < 1) return [];
    var cum = G.cumulative(poly, true), total = cum[cum.length - 1];
    if (total <= 0) return [];
    var tabs = [];
    if (ctx.tabPlacement === 'manual' && ctx.manualTabs && ctx.manualTabs.length) {
      ctx.manualTabs.forEach(function (frac) {
        var d = ((frac % 1) + 1) % 1 * total;
        var p = G.pointAtDistance(poly, true, cum, d);
        tabs.push({ dist: d, x: p[0], y: p[1] });
      });
    } else {
      for (var i = 0; i < ctx.tabCount; i++) {
        var d2 = (i + 0.5) / ctx.tabCount * total;
        var p2 = G.pointAtDistance(poly, true, cum, d2);
        tabs.push({ dist: d2, x: p2[0], y: p2[1] });
      }
    }
    return tabs;
  }

  /** Z along the perimeter: rises to tabZ over a short ramp at each tab. */
  function tabZAt(dist, depthZ, tabs, ctx, total) {
    var z = depthZ, half = ctx.tabWidth / 2, ramp = Math.max(0.5, Math.min(2.5, ctx.tabWidth));
    for (var i = 0; i < tabs.length; i++) {
      var dd = dist - tabs[i].dist;
      dd = ((dd % total) + total) % total;
      if (dd > total / 2) dd -= total;
      var ad = Math.abs(dd), here;
      if (ad <= half) here = ctx.tabZ;
      else if (ad <= half + ramp) here = ctx.tabZ + (ad - half) / ramp * (depthZ - ctx.tabZ);
      else here = depthZ;
      if (here > z) z = here;
    }
    return z;
  }

  /* ---- closed-path cutting ------------------------------------------- */

  /**
   * Walk one full loop of a closed polygon, returning ordered { x, y, d }
   * points (d = perimeter distance). When tabs are present, extra points are
   * inserted at the tab ramp boundaries so the Z profile is reproduced
   * exactly — without this, a tab that lands on a long straight edge between
   * two polygon vertices would never be cut, because Z is only ever set at
   * the vertices.
   */
  function perimeterWalk(poly, cum, total, tabs, ctx, rampDist) {
    var n = poly.length, out = [], crit = [];
    if (tabs && tabs.length && total > 1e-9) {
      var half = ctx.tabWidth / 2;
      var ramp = Math.max(0.5, Math.min(2.5, ctx.tabWidth));
      tabs.forEach(function (tb) {
        [-(half + ramp), -half, half, half + ramp].forEach(function (o) {
          crit.push(((tb.dist + o) % total + total) % total);
        });
      });
    }
    // a point exactly at the helical ramp end lets the ramp finish on schedule
    // and be recut at full depth, instead of stretching to the next vertex
    if (rampDist > 1e-9 && rampDist < total) crit.push(rampDist);
    for (var k = 1; k <= n; k++) {
      var d0 = cum[k - 1], d1 = cum[k], seg = d1 - d0;
      var a = poly[(k - 1) % n], b = poly[k % n];
      if (seg > 1e-9 && crit.length) {
        var inside = [];
        for (var c = 0; c < crit.length; c++) {
          if (crit[c] > d0 + 1e-6 && crit[c] < d1 - 1e-6) inside.push(crit[c]);
        }
        inside.sort(function (p, q) { return p - q; });
        for (var s = 0; s < inside.length; s++) {
          var t = (inside[s] - d0) / seg;
          out.push({ x: a[0] + (b[0] - a[0]) * t,
                     y: a[1] + (b[1] - a[1]) * t, d: inside[s] });
        }
      }
      out.push({ x: b[0], y: b[1], d: d1 });
    }
    return out;
  }

  /**
   * Cut one closed polygon at `depth`. When `withTabs` is set the tab Z
   * profile is applied so the bit never descends past tabZ at a tab — the
   * holding tab then survives every pass, not only the final one. Also
   * handles helical (ramped) entry. Returns { moves, tabs }.
   */
  function cutClosed(poly, depth, ctx, withTabs) {
    var moves = [];
    var tabs = (withTabs && ctx.applyTabs) ? placeTabs(poly, ctx) : [];
    var cum = G.cumulative(poly, true), total = cum[cum.length - 1];
    var helical = ctx.plungeStyle === 'helical';
    var rampDist = helical ? Math.min(total * 0.5, Math.max(6, ctx.toolDiameter * 2)) : 0;

    moves.push({ t: 'rapid', x: poly[0][0], y: poly[0][1], z: ctx.safeZ });
    moves.push({ t: 'rapid', z: ctx.preStockZ });

    var zAt = function (d) {
      return tabs.length ? tabZAt(d, depth, tabs, ctx, total) : depth;
    };
    var walk = perimeterWalk(poly, cum, total, tabs, ctx, rampDist);

    if (helical) {
      // ramp from pre-stock height down to depth over the first rampDist
      moves.push({ t: 'cut', x: poly[0][0], y: poly[0][1],
                   z: ctx.preStockZ, f: ctx.feedPlunge });
      walk.forEach(function (p) {
        var z = p.d < rampDist
          ? ctx.preStockZ + (p.d / rampDist) * (zAt(p.d) - ctx.preStockZ)
          : zAt(p.d);
        moves.push({ t: 'cut', x: p.x, y: p.y, z: z, f: ctx.feedCut });
      });
      // recut the ramped section at full depth
      for (var j = 0; j < walk.length && walk[j].d < rampDist + 1e-6; j++) {
        moves.push({ t: 'cut', x: walk[j].x, y: walk[j].y,
                     z: zAt(walk[j].d), f: ctx.feedCut });
      }
    } else {
      descend(ctx.preStockZ, zAt(0), ctx).forEach(function (m) { moves.push(m); });
      walk.forEach(function (p) {
        moves.push({ t: 'cut', x: p.x, y: p.y, z: zAt(p.d), f: ctx.feedCut });
      });
    }
    moves.push({ t: 'rapid', z: ctx.safeZ });
    return { moves: moves, tabs: tabs };
  }

  /* ---- operations ----------------------------------------------------- */

  function engraveSubpath(sub, ctx) {
    var pts = sub.points, moves = [];
    moves.push({ t: 'rapid', x: pts[0][0], y: pts[0][1], z: ctx.safeZ });
    moves.push({ t: 'rapid', z: ctx.preStockZ });
    descend(ctx.preStockZ, ctx.finalDepth, ctx).forEach(function (m) { moves.push(m); });
    for (var i = 1; i < pts.length; i++) {
      moves.push({ t: 'cut', x: pts[i][0], y: pts[i][1], z: ctx.finalDepth, f: ctx.feedCut });
    }
    if (sub.closed) {
      moves.push({ t: 'cut', x: pts[0][0], y: pts[0][1], z: ctx.finalDepth, f: ctx.feedCut });
    }
    moves.push({ t: 'rapid', z: ctx.safeZ });
    return { kind: 'engrave', color: OP_COLORS.engrave, moves: moves, tabs: [] };
  }

  function profileSubpath(sub, ctx, outward) {
    var dist = outward ? ctx.toolOffset : -ctx.toolOffset;
    var polys = G.offset(sub.points, dist, { joinType: 'miter', miterLimit: 2 });
    if (!polys.length) {
      return { kind: outward ? 'profile-out' : 'profile-in', empty: true,
               color: OP_COLORS[outward ? 'profile-out' : 'profile-in'], moves: [], tabs: [] };
    }
    var depths = computeDepths(ctx.finalDepth, ctx.docPerPass);
    var allMoves = [], allTabs = [];
    polys.forEach(function (poly) {
      depths.forEach(function (depth, di) {
        // Apply the tab profile on EVERY pass. An intermediate pass that ran
        // the full perimeter at depth would cut straight through the tab
        // location and destroy the holding tab before the final pass.
        var r = cutClosed(poly, depth, ctx, true);
        r.moves.forEach(function (m) { allMoves.push(m); });
        if (di === depths.length - 1) {
          r.tabs.forEach(function (t) { allTabs.push(t); });
        }
      });
    });
    return {
      kind: outward ? 'profile-out' : 'profile-in',
      color: OP_COLORS[outward ? 'profile-out' : 'profile-in'],
      moves: allMoves, tabs: allTabs, offsetPolys: polys, passes: depths.length
    };
  }

  function drillSubpath(sub, ctx) {
    var c = G.centroid(sub.points);
    var meanR = 0;
    sub.points.forEach(function (p) { meanR += Math.hypot(p[0] - c[0], p[1] - c[1]); });
    meanR /= sub.points.length;
    var holeD = ctx.targetHoleDiameter > 0 ? ctx.targetHoleDiameter : meanR * 2;
    var hpr = holeD / 2 - ctx.toolDiameter / 2;        // helical-path radius
    var depths = computeDepths(ctx.finalDepth, ctx.docPerPass);
    var moves = [];

    if (hpr <= 0.05) {
      // bit is as wide as / wider than the hole — plunge in place (oversized)
      moves.push({ t: 'rapid', x: c[0], y: c[1], z: ctx.safeZ });
      moves.push({ t: 'rapid', z: ctx.preStockZ });
      depths.forEach(function (depth) {
        moves.push({ t: 'plunge', x: c[0], y: c[1], z: depth, f: ctx.feedPlunge });
        var retract = Math.min(ctx.safeZ, depth + ctx.peckRetract);
        moves.push({ t: 'rapid', z: retract });
      });
      moves.push({ t: 'rapid', z: ctx.safeZ });
      return { kind: 'drill', color: OP_COLORS.drill, moves: moves, tabs: [],
               passes: depths.length,
               drill: { x: c[0], y: c[1], r: ctx.toolDiameter / 2, oversized: true } };
    }

    // bit narrower than the hole — plunge at centre and trace a circle
    moves.push({ t: 'rapid', x: c[0], y: c[1], z: ctx.safeZ });
    moves.push({ t: 'rapid', z: ctx.preStockZ });
    var cz = ctx.preStockZ;
    depths.forEach(function (depth) {
      descend(cz, depth, ctx).forEach(function (m) {
        moves.push(Object.assign({ x: c[0], y: c[1] }, m));
      });
      moves.push({ t: 'cut', x: c[0] + hpr, y: c[1], z: depth, f: ctx.feedCut });
      moves.push({ t: 'arc', x: c[0] + hpr, y: c[1], z: depth,
                   i: -hpr, j: 0, ccw: false, f: ctx.feedCut });
      moves.push({ t: 'cut', x: c[0], y: c[1], z: depth, f: ctx.feedCut });
      cz = depth;
    });
    moves.push({ t: 'rapid', z: ctx.safeZ });
    return { kind: 'drill', color: OP_COLORS.drill, moves: moves, tabs: [],
             passes: depths.length,
             drill: { x: c[0], y: c[1], r: hpr, oversized: false } };
  }

  /* ---- stats ---------------------------------------------------------- */

  function accumulateStats(ops, ctx) {
    var cut = 0, plunge = 0, rapid = 0, zPasses = 0;
    var b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    function expand(x, y) {
      if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x;
      if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y;
    }
    ops.forEach(function (op) {
      var cx = 0, cy = 0;
      op.moves.forEach(function (m) {
        var nx = m.x != null ? m.x : cx, ny = m.y != null ? m.y : cy;
        if (m.t === 'rapid') {
          rapid += Math.hypot(nx - cx, ny - cy);
        } else if (m.t === 'plunge') {
          plunge += 1; // Z-only motion, but the XY position still counts
          expand(nx, ny);
        } else if (m.t === 'cut') {
          cut += Math.hypot(nx - cx, ny - cy);
          expand(nx, ny);
        } else if (m.t === 'arc') {
          var r = Math.hypot(m.i, m.j);
          var acx = cx + m.i, acy = cy + m.j;
          var sa = Math.atan2(cy - acy, cx - acx);
          var ea = Math.atan2(ny - acy, nx - acx);
          var sweep;
          if (m.ccw) {
            sweep = ea - sa;
            if (sweep < 0) sweep += Math.PI * 2;
          } else {
            sweep = sa - ea;
            if (sweep < 0) sweep += Math.PI * 2;
          }
          if (Math.abs(nx - cx) < 1e-6 && Math.abs(ny - cy) < 1e-6) sweep = Math.PI * 2;
          cut += r * sweep;
          // conservative bounds: full circle around the centre
          expand(acx - r, acy - r); expand(acx + r, acy + r);
        }
        cx = nx; cy = ny;
      });
      if (op.passes) zPasses += op.passes;
      else if (!op.empty) zPasses += 1;
    });
    var sec = (cut / Math.max(1, ctx.feedCut) + rapid / Math.max(1, ctx.rapidFeed)) * 60 +
              plunge * 1.2;
    return {
      cutLength: cut, rapidLength: rapid, zPasses: zPasses,
      estSeconds: sec,
      bounds: isFinite(b.minX) ? b : { minX: 0, minY: 0, maxX: 0, maxY: 0 }
    };
  }

  /* ---- pocket clearing ------------------------------------------------ */

  /**
   * Clear the inside of every filled region (filled text, solid shapes) with
   * concentric inward shells. Counters — the holes inside letters like O, A,
   * e — are preserved automatically because cleanRegion normalises the input
   * with the even-odd rule. Returns one whole-job operation.
   */
  function pocketAll(job, ctx) {
    var contours = [];
    job.subpaths.forEach(function (sp) {
      if (sp.closed && sp.points && sp.points.length >= 3) contours.push(sp.points);
    });
    if (!contours.length) return null;
    if (!(ctx.toolDiameter > 0)) return null;   // validation explains why
    var region = G.cleanRegion(contours);
    if (!region.length) return null;

    // Concentric shells: the first cut runs a tool-radius in from the edge,
    // then step inward by ~45% of the tool diameter until nothing is left.
    var stepover = Math.max(0.35, ctx.toolDiameter * 0.45);
    var maxShells = 700;
    var maxShellPoints = 120000;
    var shellPoints = 0;
    var shells = [], ring = G.offsetRegion(region, -ctx.toolDiameter / 2), guard = 0;
    while (ring.length && guard++ < maxShells) {
      for (var ri = 0; ri < ring.length; ri++) shellPoints += ring[ri].length;
      if (shellPoints > maxShellPoints) break;
      shells.push(ring);
      ring = G.offsetRegion(ring, -stepover);
    }
    if (!shells.length) {
      return { kind: 'pocket', color: OP_COLORS.pocket, moves: [], tabs: [],
               empty: true };
    }

    var depths = computeDepths(ctx.finalDepth, ctx.docPerPass);
    var moves = [];
    ctx.applyTabs = false;
    depths.forEach(function (depth) {
      // inner shells first, so the visible edge shell is cut last and clean
      for (var si = shells.length - 1; si >= 0; si--) {
        shells[si].forEach(function (contour) {
          cutClosed(contour, depth, ctx, false).moves.forEach(function (m) {
            moves.push(m);
          });
        });
      }
    });
    return {
      kind: 'pocket',
      color: OP_COLORS.pocket,
      moves: moves,
      tabs: [],
      passes: depths.length,
      capped: !!ring.length
    };
  }

  /* ---- V-carving ------------------------------------------------------ */

  /**
   * V-carve every filled region. The region boundary is eroded inward in
   * small steps; each ring is cut at a depth set by the V-bit's half-angle
   * (depth = inset / tan(halfAngle)), so the bit's flanks meet the surface
   * exactly on the design outline and form a continuous V. Depth is capped
   * at |finalDepth| — wider areas flatten there (true 2-color HDPE behaviour),
   * and once flat the bottom is cleared at a coarser step. Returns one
   * whole-job operation, or null when it cannot run (validation explains why).
   */
  function vcarveAll(job, ctx) {
    var contours = [];
    job.subpaths.forEach(function (sp) {
      if (sp.closed && sp.points && sp.points.length >= 3) contours.push(sp.points);
    });
    if (!contours.length) return null;
    if (!(ctx.vAngle > 0 && ctx.vAngle < 180)) return null;
    var tanHalf = Math.tan((ctx.vAngle / 2) * Math.PI / 180);
    if (!(tanHalf > 1e-4)) return null;
    var region = G.cleanRegion(contours);
    if (!region.length) return null;

    var xyStep = 0.4;                          // ring spacing on the V flanks
    var maxDepth = Math.abs(ctx.finalDepth);   // depth cap — wider areas flatten
    var insetCap = maxDepth * tanHalf;         // inset at which depth hits the cap
    // a V-bit only cuts at its tip once the bottom is flat, so clear that
    // region at a coarser step to keep the toolpath a sane size
    var flatStep = Math.max(xyStep, 2 * maxDepth * tanHalf * 0.4);

    var moves = [], deepest = 0, inset = 0, rings = 0, guard = 0;
    ctx.applyTabs = false;
    var ring = region;
    while (guard++ < 8000) {
      var step = inset < insetCap ? xyStep : flatStep;
      inset += step;
      ring = G.offsetRegion(ring, -step);
      if (!ring.length) break;
      var depth = -Math.min(inset / tanHalf, maxDepth);
      if (-depth > deepest) deepest = -depth;
      rings++;
      ring.forEach(function (contour) {
        cutClosed(contour, depth, ctx, false).moves.forEach(function (m) {
          moves.push(m);
        });
      });
    }
    if (!moves.length) {
      return { kind: 'vcarve', color: OP_COLORS.vcarve, moves: [], tabs: [],
               empty: true };
    }
    return { kind: 'vcarve', color: OP_COLORS.vcarve, moves: moves, tabs: [],
             passes: rings, depthReached: deepest };
  }

  /* ---- public build --------------------------------------------------- */

  /**
   * Build a full toolpath.
   * @param {object} job   output of prepareJob
   * @param {object} s     settings
   * @param {object} bit   selected bit row (may be null)
   * @returns {object} { ops, stats, warnings }
   */
  function build(job, s, bit) {
    var bitD = bit && bit.diameter_mm > 0 ? bit.diameter_mm : 0;
    var toolOffset = s.toolOffsetOverride > 0
      ? s.toolOffsetOverride
      : bitD / 2 + (s.finishingAllowance != null ? s.finishingAllowance : 0.15);

    var ctx = {
      safeZ: s.safeZ != null ? s.safeZ : 10,
      preStockZ: s.preStockZ != null ? s.preStockZ : 2,
      finalDepth: s.finalDepth != null ? s.finalDepth : -1,
      docPerPass: s.docPerPass != null ? s.docPerPass : 1,
      feedCut: s.feedCut > 0 ? s.feedCut : 1000,
      feedPlunge: s.feedPlunge > 0 ? s.feedPlunge : 400,
      rapidFeed: s.rapidFeed > 0 ? s.rapidFeed : 5000,
      plungeStyle: s.plungeStyle || 'straight',
      peckRetract: s.peckRetract != null ? s.peckRetract : 2,
      peckStep: Math.max(0.8, s.docPerPass || 2),
      toolOffset: toolOffset,
      toolDiameter: bitD,
      vAngle: bit && bit.v_angle_deg > 0 ? bit.v_angle_deg : 0,
      targetHoleDiameter: s.targetHoleDiameter || 0,
      tabsEnabled: !!s.tabsEnabled,
      tabCount: s.tabCount != null ? s.tabCount : 4,
      tabWidth: s.tabWidth != null ? s.tabWidth : 6,
      tabPlacement: s.tabPlacement || 'even',
      manualTabs: s.manualTabs || null,
      tabZ: Math.min(0, (s.finalDepth || -1) + (s.tabThickness != null ? s.tabThickness : 1.5))
    };

    var op = s.operation || 'engrave';
    var ops = [], warnings = [], openSkipped = 0;

    // Pocket and V-carve are whole-job operations — every closed region at once.
    if (op === 'pocket') {
      var pocketed = pocketAll(job, ctx);
      if (pocketed && pocketed.moves && pocketed.moves.length) {
        ops.push(pocketed);
        if (pocketed.capped) {
          warnings.push(
            'Pocket complexity was capped to keep the browser responsive. ' +
            'Use a larger bit, increase scale tolerance, or split the job.'
          );
        }
      } else if (pocketed && pocketed.empty) {
        warnings.push('The closed shapes are too small to pocket with this bit.');
      }
    } else if (op === 'vcarve') {
      var carved = vcarveAll(job, ctx);
      if (carved && carved.moves && carved.moves.length) {
        ops.push(carved);
      } else if (carved && carved.empty) {
        warnings.push('The shapes are too small to V-carve with this bit.');
      }
    }

    job.subpaths.forEach(function (sub) {
      if (op === 'pocket' || op === 'vcarve' ||
          !sub.points || sub.points.length < 2) return;
      var built = null;

      if (op === 'engrave') {
        built = engraveSubpath(sub, ctx);
      } else if (sub.type === 'hole' && op !== 'profile-in') {
        // small features always get a drill cycle (spec §8 rule 3, gotcha 13)
        built = drillSubpath(sub, ctx);
      } else if (op === 'drill') {
        if (!sub.closed) { openSkipped++; return; }
        built = drillSubpath(sub, ctx);
      } else if (op === 'profile-out') {
        if (!sub.closed) { openSkipped++; return; }
        ctx.applyTabs = ctx.tabsEnabled;
        built = profileSubpath(sub, ctx, true);
      } else if (op === 'profile-in') {
        if (!sub.closed) { openSkipped++; return; }
        ctx.applyTabs = false;
        built = profileSubpath(sub, ctx, false);
      }

      if (built) {
        if (built.empty) {
          warnings.push('A contour was too small to offset ' +
            (op === 'profile-in' ? 'inward' : 'outward') +
            ' with this bit — skipped.');
        } else {
          ops.push(built);
        }
      }
    });

    if (openSkipped > 0) {
      warnings.push(openSkipped + ' open contour(s) skipped — "' + op +
        '" needs closed paths. Use the Engrave operation for open lines.');
    }
    if (!ops.length && !warnings.length) {
      warnings.push('No toolpath was generated for this geometry.');
    }

    ops.sort(function (a, b) { return OP_ORDER[a.kind] - OP_ORDER[b.kind]; });

    return { ops: ops, warnings: warnings, stats: accumulateStats(ops, ctx), ctx: ctx };
  }

  Forge.toolpath = {
    prepareJob: prepareJob,
    build: build,
    computeDepths: computeDepths,
    OP_COLORS: OP_COLORS
  };
})(typeof window !== 'undefined' ? (window.Forge = window.Forge || {})
                                 : (global.Forge = global.Forge || {}));
