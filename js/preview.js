/**
 * LowRider Forge — canvas toolpath preview.
 *
 * Renders the machine envelope, stock, reference geometry, the computed
 * toolpath (colour-coded per operation), rapids, tabs and the work origin.
 * Pan with middle/left drag, zoom with the wheel. Hover shows X/Y/Z/feed.
 */
(function (Forge) {
  'use strict';

  var COL = {
    bg: '#0d1117', grid: 'rgba(255,255,255,0.04)', gridMajor: 'rgba(255,255,255,0.08)',
    envelope: '#3b82f6', stock: 'rgba(148,163,184,0.14)', stockEdge: 'rgba(148,163,184,0.55)',
    geometry: 'rgba(148,163,184,0.45)', rapid: 'rgba(226,232,240,0.28)',
    tab: '#ef4444', origin: '#ef4444', text: 'rgba(226,232,240,0.75)'
  };

  function createPreview(canvas) {
    var ctx = canvas.getContext('2d');
    var view = { scale: 1, panX: 60, panY: 60 };
    var scene = null;
    var dpr = 1, cssW = 0, cssH = 0;
    var hover = null, dragging = false, lastX = 0, lastY = 0;
    var customDrag = null;
    var options = { showRapids: true, showTabs: true, showGeometry: true };

    var tip = document.createElement('div');
    tip.className = 'preview-tip';
    tip.style.display = 'none';
    canvas.parentNode.appendChild(tip);

    /* ---- coordinate mapping (machine mm, Y-up  <->  screen px) ---- */
    function toScreenX(x) { return view.panX + x * view.scale; }
    function toScreenY(y) { return cssH - (view.panY + y * view.scale); }
    function toWorldX(sx) { return (sx - view.panX) / view.scale; }
    function toWorldY(sy) { return (cssH - sy - view.panY) / view.scale; }

    function resize() {
      dpr = window.devicePixelRatio || 1;
      var r = canvas.getBoundingClientRect();
      cssW = r.width; cssH = r.height;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /* ---- fit the machine envelope (or stock) into view ---- */
    function fit() {
      resize();
      var w = scene && scene.job ? scene.job.stockWidth : (scene ? scene.machineX : 1270);
      var h = scene && scene.job ? scene.job.stockHeight : (scene ? scene.machineY : 2540);
      var ox = 0, oy = 0;
      if (scene && scene.job) { ox = scene.job.stock.minX; oy = scene.job.stock.minY; }
      // include the origin (0,0) in the fitted area
      var minX = Math.min(ox, 0), minY = Math.min(oy, 0);
      var maxX = Math.max(ox + w, 0), maxY = Math.max(oy + h, 0);
      var pad = 40;
      var sx = (cssW - 2 * pad) / Math.max(1, maxX - minX);
      var sy = (cssH - 2 * pad) / Math.max(1, maxY - minY);
      view.scale = Math.max(0.05, Math.min(sx, sy));
      view.panX = pad - minX * view.scale +
        (cssW - 2 * pad - (maxX - minX) * view.scale) / 2;
      view.panY = pad - minY * view.scale +
        (cssH - 2 * pad - (maxY - minY) * view.scale) / 2;
      render();
    }

    /* ---- grid ---- */
    function drawGrid() {
      var step = 10;
      while (step * view.scale < 24) step *= (step === 10 ? 5 : (step === 50 ? 2 : 5));
      var x0 = toWorldX(0), x1 = toWorldX(cssW);
      var y0 = toWorldY(cssH), y1 = toWorldY(0);
      ctx.lineWidth = 1;
      for (var gx = Math.floor(x0 / step) * step; gx <= x1; gx += step) {
        ctx.strokeStyle = gx % (step * 5) === 0 ? COL.gridMajor : COL.grid;
        line(toScreenX(gx), 0, toScreenX(gx), cssH);
      }
      for (var gy = Math.floor(y0 / step) * step; gy <= y1; gy += step) {
        ctx.strokeStyle = gy % (step * 5) === 0 ? COL.gridMajor : COL.grid;
        line(0, toScreenY(gy), cssW, toScreenY(gy));
      }
    }
    function line(x1, y1, x2, y2) {
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    function rect(x, y, w, h) {
      ctx.beginPath();
      ctx.rect(toScreenX(x), toScreenY(y + h), w * view.scale, h * view.scale);
    }

    /* ---- main render ---- */
    function render() {
      if (!cssW) resize();
      ctx.fillStyle = COL.bg;
      ctx.fillRect(0, 0, cssW, cssH);
      drawGrid();

      var machX = scene ? scene.machineX : 1270;
      var machY = scene ? scene.machineY : 2540;

      // machine envelope
      ctx.strokeStyle = COL.envelope;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([8, 6]);
      rect(0, 0, machX, machY); ctx.stroke();
      ctx.setLineDash([]);

      if (scene && scene.job) {
        var job = scene.job, st = job.stock;
        // stock
        ctx.fillStyle = COL.stock;
        rect(st.minX, st.minY, st.maxX - st.minX, st.maxY - st.minY); ctx.fill();
        ctx.strokeStyle = COL.stockEdge; ctx.lineWidth = 1; ctx.stroke();

        // reference geometry
        if (options.showGeometry) {
          ctx.strokeStyle = COL.geometry; ctx.lineWidth = 1;
          job.subpaths.forEach(function (sp) { strokePoly(sp.points, sp.closed); });
        }

        // toolpath
        if (scene.toolpath) {
          drawToolpath(scene.toolpath);
          if (options.showTabs) {
            scene.toolpath.ops.forEach(function (op) {
              (op.tabs || []).forEach(drawTab);
            });
          }
        }
      }

      drawOrigin();
      drawScaleBar();
      drawHud(machX, machY);
    }

    function strokePoly(pts, closed) {
      if (pts.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(toScreenX(pts[0][0]), toScreenY(pts[0][1]));
      for (var i = 1; i < pts.length; i++) {
        ctx.lineTo(toScreenX(pts[i][0]), toScreenY(pts[i][1]));
      }
      if (closed) ctx.closePath();
      ctx.stroke();
    }

    function drawToolpath(tp) {
      var cx, cy;
      // rapids underneath (position tracked continuously across operations)
      if (options.showRapids) {
        ctx.strokeStyle = COL.rapid; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
        cx = 0; cy = 0;
        tp.ops.forEach(function (op) {
          op.moves.forEach(function (m) {
            var nx = m.x != null ? m.x : cx, ny = m.y != null ? m.y : cy;
            if (m.t === 'rapid' && (nx !== cx || ny !== cy)) {
              line(toScreenX(cx), toScreenY(cy), toScreenX(nx), toScreenY(ny));
            }
            cx = nx; cy = ny;
          });
        });
        ctx.setLineDash([]);
      }
      // cutting moves
      ctx.lineWidth = 1.8; ctx.lineJoin = 'round';
      cx = 0; cy = 0;
      tp.ops.forEach(function (op) {
        ctx.strokeStyle = op.color;
        op.moves.forEach(function (m) {
          var nx = m.x != null ? m.x : cx, ny = m.y != null ? m.y : cy;
          if (m.t === 'cut') {
            line(toScreenX(cx), toScreenY(cy), toScreenX(nx), toScreenY(ny));
          } else if (m.t === 'arc') {
            var ccx = cx + m.i, ccy = cy + m.j, r = Math.hypot(m.i, m.j) * view.scale;
            ctx.beginPath();
            ctx.arc(toScreenX(ccx), toScreenY(ccy), r, 0, 2 * Math.PI);
            ctx.stroke();
          }
          cx = nx; cy = ny;
        });
      });
      // oversized drill markers
      tp.ops.forEach(function (op) {
        if (op.drill && op.drill.oversized) {
          ctx.strokeStyle = op.color; ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(toScreenX(op.drill.x), toScreenY(op.drill.y),
            Math.max(3, op.drill.r * view.scale), 0, 2 * Math.PI);
          ctx.stroke();
        }
      });
    }

    function drawTab(t) {
      var x = toScreenX(t.x), y = toScreenY(t.y), s = 4;
      ctx.strokeStyle = COL.tab; ctx.lineWidth = 2;
      line(x - s, y - s, x + s, y + s);
      line(x - s, y + s, x + s, y - s);
    }

    function drawOrigin() {
      var x = toScreenX(0), y = toScreenY(0), s = 11;
      ctx.strokeStyle = COL.origin; ctx.lineWidth = 1.5;
      line(x - s, y, x + s, y);
      line(x, y - s, x, y + s);
      ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI); ctx.stroke();
      ctx.fillStyle = COL.origin;
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText('0,0', x + s + 3, y + 4);
    }

    function drawScaleBar() {
      var target = 90, mm = target / view.scale;
      var pow = Math.pow(10, Math.floor(Math.log10(mm)));
      var nice = [1, 2, 5, 10].map(function (n) { return n * pow; })
        .reduce(function (a, b) { return Math.abs(b - mm) < Math.abs(a - mm) ? b : a; });
      var px = nice * view.scale;
      var x = cssW - px - 18, y = cssH - 22;
      ctx.strokeStyle = COL.text; ctx.lineWidth = 1.5;
      line(x, y, x + px, y); line(x, y - 4, x, y + 4); line(x + px, y - 4, x + px, y + 4);
      ctx.fillStyle = COL.text; ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(nice + ' mm', x + px / 2, y - 6);
      ctx.textAlign = 'left';
    }

    function drawHud(machX, machY) {
      ctx.fillStyle = COL.text;
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText('Machine ' + machX + ' x ' + machY + ' mm', 12, 18);
      if (scene && scene.job) {
        ctx.fillText('Stock ' + round1(scene.job.stockWidth) + ' x ' +
          round1(scene.job.stockHeight) + ' mm', 12, 34);
      }
    }
    function round1(n) { return Math.round(n * 10) / 10; }

    /* ---- hover tooltip ---- */
    function updateTip(sx, sy) {
      if (!scene || !scene.toolpath) { tip.style.display = 'none'; return; }
      var wx = toWorldX(sx), wy = toWorldY(sy);
      var best = null, bd = Infinity;
      scene.toolpath.ops.forEach(function (op) {
        var cx = 0, cy = 0;
        op.moves.forEach(function (m) {
          var nx = m.x != null ? m.x : cx, ny = m.y != null ? m.y : cy;
          if (m.t === 'cut' || m.t === 'arc' || m.t === 'plunge') {
            var d = Math.hypot(nx - wx, ny - wy);
            if (d < bd) { bd = d; best = m; }
          }
          cx = nx; cy = ny;
        });
      });
      var html = 'X ' + wx.toFixed(1) + '  Y ' + wy.toFixed(1);
      if (best && bd * view.scale < 14) {
        html += '<br>Z ' + (best.z != null ? best.z.toFixed(2) : '--') +
          '  F ' + (best.f ? Math.round(best.f) : '--');
      }
      tip.innerHTML = html;
      tip.style.display = 'block';
      tip.style.left = (sx + 14) + 'px';
      tip.style.top = (sy + 14) + 'px';
    }

    /* ---- events ---- */
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = canvas.getBoundingClientRect();
      var mx = e.clientX - r.left, my = e.clientY - r.top;
      var wx = toWorldX(mx), wy = toWorldY(my);
      var factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      view.scale = Math.max(0.03, Math.min(200, view.scale * factor));
      view.panX = mx - wx * view.scale;
      view.panY = cssH - my - wy * view.scale;
      render();
    }, { passive: false });

    canvas.addEventListener('mousedown', function (e) {
      if (e.button === 0 && scene && scene.interaction &&
          typeof scene.interaction.onPointerDown === 'function') {
        var r0 = canvas.getBoundingClientRect();
        var sx0 = e.clientX - r0.left, sy0 = e.clientY - r0.top;
        var start = scene.interaction.onPointerDown({
          worldX: toWorldX(sx0), worldY: toWorldY(sy0),
          screenX: sx0, screenY: sy0, event: e
        });
        if (start && start.capture) {
          customDrag = start;
          dragging = false;
          canvas.style.cursor = 'grabbing';
          e.preventDefault();
          return;
        }
      }
      if (e.button === 1 || e.button === 0) {
        dragging = true; lastX = e.clientX; lastY = e.clientY;
        canvas.style.cursor = 'grabbing';
        e.preventDefault();
      }
    });
    window.addEventListener('mouseup', function () {
      if (customDrag && typeof customDrag.onEnd === 'function') customDrag.onEnd();
      customDrag = null;
      dragging = false; canvas.style.cursor = '';
    });
    canvas.addEventListener('mousemove', function (e) {
      var r = canvas.getBoundingClientRect();
      if (customDrag && typeof customDrag.onMove === 'function') {
        var sxm = e.clientX - r.left, sym = e.clientY - r.top;
        customDrag.onMove({
          worldX: toWorldX(sxm), worldY: toWorldY(sym),
          screenX: sxm, screenY: sym, event: e
        });
      } else if (dragging) {
        view.panX += e.clientX - lastX;
        view.panY -= e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        render();
      } else {
        updateTip(e.clientX - r.left, e.clientY - r.top);
      }
    });
    canvas.addEventListener('mouseleave', function () {
      tip.style.display = 'none';
    });
    window.addEventListener('resize', function () { resize(); render(); });

    return {
      get options() { return options; },
      draw: function (s) { scene = s; render(); },
      setScene: function (s) { scene = s; },
      render: render,
      fit: fit,
      zoom: function (factor) {
        view.scale = Math.max(0.03, Math.min(200, view.scale * factor));
        render();
      }
    };
  }

  Forge.createPreview = createPreview;
})(window.Forge = window.Forge || {});
