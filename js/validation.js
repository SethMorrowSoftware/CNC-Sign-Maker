/**
 * LowRider Forge — pre-flight validation.
 *
 * Encodes spec section 10 (safety checks) and the hard-won gotchas of
 * section 14. Any issue at level "error" blocks gcode download.
 *
 * Returns { issues: [{level, msg, id?, suggest?}], envelopeOk, hasError }.
 */
(function (Forge) {
  'use strict';

  var LEVEL_RANK = { error: 0, warn: 1, info: 2 };

  function run(job, toolpath, s, bit, material) {
    job = job || { subpaths: [], hint: null };
    toolpath = toolpath || { ops: [], stats: {}, warnings: [] };
    s = s || {};
    var issues = [];
    function add(level, msg, extra) {
      issues.push(Object.assign({ level: level, msg: msg }, extra || {}));
    }

    var op = s.operation || 'engrave';
    var needsBit = op !== 'engrave';
    var finalDepth = s.finalDepth != null ? s.finalDepth : -1;
    var b = toolpath.stats && toolpath.stats.bounds ? toolpath.stats.bounds : null;
    // V-carve depth comes from the geometry, not finalDepth — check the bit
    // against the depth the toolpath actually reaches.
    var vcarveOp = (toolpath.ops || []).filter(function (o) {
      return o.kind === 'vcarve';
    })[0];
    var reachDepth = (op === 'vcarve' && vcarveOp && vcarveOp.depthReached != null)
      ? -vcarveOp.depthReached : finalDepth;

    /* --- final depth must be below the surface --- */
    if (finalDepth >= 0) {
      add('error', 'Final depth is ' + finalDepth + 'mm. Depth must be ' +
        'negative — below the material surface. A zero value cuts nothing; ' +
        'a positive value would drive the bit upward into the spindle.');
    }

    /* --- safeZ / preStockZ sanity --- */
    if (s.safeZ != null && !(s.safeZ > 0)) {
      add('error', 'Safe Z is ' + s.safeZ + 'mm. Safe Z must be positive — ' +
        'this is the rapid height above the stock surface (Z=0). A zero or ' +
        'negative value lets the bit drag across the work during rapids.');
    }
    if (s.preStockZ != null && !(s.preStockZ > 0)) {
      add('warn', 'Pre-stock Z is ' + s.preStockZ + 'mm. Keep this positive ' +
        '(typical 1-3mm) — it is the last height before each plunge.');
    }
    if (s.safeZ != null && s.preStockZ != null && s.preStockZ >= s.safeZ) {
      add('warn', 'Pre-stock Z (' + s.preStockZ + 'mm) is at or above Safe Z (' +
        s.safeZ + 'mm). Pre-stock should be smaller — it is the height the ' +
        'bit drops to just before each plunge.');
    }

    /* --- machine envelope (spec §10) --- */
    var envelopeOk = true;
    var origin = s.originPosition || 'bottom-left';
    // center / top-left deliberately place work zero inside the job, so the
    // toolpath legitimately spans negative coordinates — the operator sets
    // machine work zero at that point. bottom-left / custom must stay positive.
    var originInside = origin === 'center' || origin === 'top-left';
    if (b && isFinite(b.minX)) {
      var jobW = b.maxX - b.minX, jobH = b.maxY - b.minY;
      var tooBig = jobW > s.machineX + 0.01 || jobH > s.machineY + 0.01;
      var fitsRotated = jobW <= s.machineY + 0.01 && jobH <= s.machineX + 0.01;
      if (tooBig) {
        envelopeOk = false;
        add('error', 'Job is ' + fmt(jobW) + ' x ' + fmt(jobH) + 'mm but the ' +
          'machine envelope is ' + s.machineX + ' x ' + s.machineY +
          'mm. It will not fit.');
        // can it fit if rotated 90 degrees? (spec §10 orientation check)
        if (fitsRotated) {
          add('info', 'The job would fit if rotated 90 degrees.', { id: 'rotate' });
        }
      }
      if (originInside) {
        add('info', 'Origin is the ' + (origin === 'center' ? 'centre' : 'top-left') +
          ' of the job, so the toolpath spans negative coordinates by design. ' +
          'Set the machine work zero at that point — not at a stock corner.');
      } else {
        if (b.minX < -0.01 || b.minY < -0.01) {
          envelopeOk = false;
          add('error', 'Toolpath has negative X/Y coordinates. With the ' + origin +
            ' origin every coordinate must stay positive — raise the stock margin ' +
            'or check the custom origin values.');
        }
        if (!tooBig && (b.maxX > s.machineX + 0.01 || b.maxY > s.machineY + 0.01)) {
          envelopeOk = false;
          add('error', 'Job reaches ' + fmt(b.maxX) + ' x ' + fmt(b.maxY) +
            'mm — past the ' + s.machineX + ' x ' + s.machineY + 'mm envelope. ' +
            'Move it closer to the origin.');
        }
      }
    }

    /* --- bit reach vs cut depth (spec §10, gotcha 7) ---
       The shank clears the work at safeZ, so the bit needs to reach
       (|cutDepth| + safeZ) into the workpiece — anything shorter means the
       shank rubs at retract. Use max(2, safeZ) so a tiny custom safeZ
       cannot mask the rubbing condition. */
    var reachMargin = Math.max(2, s.safeZ > 0 ? s.safeZ : 0);
    if (bit && bit.cutting_length_mm > 0) {
      if (Math.abs(reachDepth) + reachMargin >= bit.cutting_length_mm) {
        add('error', 'Cut depth ' + fmt(reachDepth) + 'mm + safe-Z clearance ' +
          fmt(reachMargin) + 'mm exceeds the bit cutting length (' +
          bit.cutting_length_mm + 'mm). The shank would rub the work. ' +
          'Use a longer bit or a shallower cut.');
      }
    } else if (needsBit) {
      add('info', 'Selected bit has no cutting-length recorded — depth-vs-reach ' +
        'could not be checked.');
    }

    /* --- bit must be selected for radius-compensated work --- */
    if (needsBit && (!bit || !(bit.diameter_mm > 0))) {
      add('error', 'Select a bit — "' + op + '" needs the cutting diameter for ' +
        'tool-radius compensation.');
    }

    /* --- V-carve needs a V-bit with an included angle --- */
    if (op === 'vcarve' && bit && bit.diameter_mm > 0 &&
        !(bit.v_angle_deg > 0 && bit.v_angle_deg < 180)) {
      add('error', 'V-carving needs a V-bit with an included angle. Pick a V-bit, ' +
        'or set the V-bit angle on the Bit tab.');
    }

    /* --- V-bit on a non-V-carve operation ---
       A V-bit only cuts at its flank; using it for profile-out / profile-in /
       drill / pocket would gouge with no continuous flute along depth. */
    if (bit && bit.type === 'V-bit' &&
        (op === 'profile-out' || op === 'profile-in' || op === 'drill' ||
         op === 'pocket')) {
      add('warn', 'Selected bit is a V-bit but the operation is "' + op +
        '". V-bits only cut at the flank — use a regular end mill for ' +
        'profile / drill / pocket work.');
    }

    /* --- DOC vs tool diameter (bad practice → warn) ---
       Standard rule of thumb: DOC <= bit diameter for soft materials,
       <= half diameter for harder ones. A DOC > diameter on a small bit
       loads the cutter heavily and risks breakage. */
    if (bit && bit.diameter_mm > 0 && s.docPerPass > 0 &&
        op !== 'engrave' && op !== 'vcarve') {
      if (s.docPerPass > bit.diameter_mm) {
        add('warn', 'DOC per pass (' + s.docPerPass + 'mm) is larger than the ' +
          'bit diameter (' + bit.diameter_mm + 'mm). The bit is heavily loaded ' +
          'and at risk of breakage. Reduce DOC to at most the bit diameter.');
      }
    }

    /* --- Plunge feed should be slower than cut feed --- */
    if (s.feedCut > 0 && s.feedPlunge > 0 && s.feedPlunge > s.feedCut) {
      add('warn', 'Plunge feed (' + s.feedPlunge + ' mm/min) is faster than ' +
        'cut feed (' + s.feedCut + ' mm/min). Plunging is the hardest move on ' +
        'a bit — keep it at 25-40% of cut feed.');
    }

    /* --- Spindle RPM vs material recommendation --- */
    if (material && material.recommended_rpm > 0 && s.spindleRpm > 0) {
      var rpmDelta = Math.abs(s.spindleRpm - material.recommended_rpm) /
                     material.recommended_rpm;
      if (rpmDelta > 0.35) {
        add('info', 'Spindle RPM (' + s.spindleRpm + ') is ' +
          (s.spindleRpm > material.recommended_rpm ? 'well above' : 'well below') +
          ' the material recommendation (' + material.recommended_rpm + '). ' +
          'For a manual router, set the dial to match.');
      }
    }


    /* --- text-sign usable interior --- */
    // Only meaningful in text mode — signWidth/signHeight are dead state when
    // the user uploaded an SVG or traced a bitmap.
    if (s.inputMode === 'text' && s.signWidth > 0 && s.signHeight > 0) {
      var frameInset = s.frame ? Math.max(0, s.frameInset || 0) : 0;
      var textPad = Math.max(0, s.textPadding || 0);
      var insetTotal = frameInset + textPad;
      var usableW = s.signWidth - 2 * insetTotal;
      var usableH = s.signHeight - 2 * insetTotal;
      if (usableW <= 1 || usableH <= 1) {
        add('warn', 'Frame inset + text padding leave almost no interior area (' +
          fmt(Math.max(0, usableW)) + ' x ' + fmt(Math.max(0, usableH)) +
          'mm). Reduce inset/padding so text and shapes can scale predictably.');
      }
    }

    /* --- stock margin vs tool offset (spec §10) ---
       If the suggested margin would push the part past the machine envelope,
       leave the warning but omit the apply-fix — the user must shrink the
       part or change origin manually. */
    var toolOffset = s.toolOffsetOverride > 0
      ? s.toolOffsetOverride
      : (bit && bit.diameter_mm > 0 ? bit.diameter_mm / 2 : 0) +
        (s.finishingAllowance != null ? s.finishingAllowance : 0.15);
    if (op === 'profile-out' && s.stockMargin <= toolOffset) {
      var suggestedMargin = Math.ceil(toolOffset + 5);
      var extra = { id: 'stock-margin' };
      // Check whether bumping margin would still fit. b is set above when
      // toolpath bounds are available.
      var marginDelta = suggestedMargin - (s.stockMargin || 0);
      if (b && isFinite(b.minX) && s.machineX > 0 && s.machineY > 0) {
        var wouldFit = (b.maxX + marginDelta) <= s.machineX + 0.01 &&
                       (b.maxY + marginDelta) <= s.machineY + 0.01;
        if (wouldFit) extra.suggest = { stockMargin: suggestedMargin };
      } else {
        extra.suggest = { stockMargin: suggestedMargin };
      }
      add('warn', 'Stock margin (' + s.stockMargin + 'mm) is smaller than the tool ' +
        'offset (' + fmt(toolOffset) + 'mm). The outside toolpath may run off the stock.' +
        (extra.suggest ? '' : ' Increasing margin would exceed the machine envelope — ' +
          'shrink the part or change origin instead.'),
        extra);
    }

    /* --- chip load (spec §10) --- */
    if (bit && bit.flute_count > 0 && s.spindleRpm > 0 && s.feedCut > 0) {
      var chip = s.feedCut / (s.spindleRpm * bit.flute_count);
      if (chip < 0.05) {
        add('warn', 'Chip load is ' + chip.toFixed(3) + 'mm — too low (rubbing burns ' +
          'bits). Raise the cut feed or lower RPM. Aim for 0.05-0.30mm.');
      } else if (chip > 0.30) {
        add('warn', 'Chip load is ' + chip.toFixed(3) + 'mm — too high (bit deflection ' +
          'and breakage). Lower the cut feed or raise RPM. Aim for 0.05-0.30mm.');
      }
    }

    /* --- deep plunge without pecking ---
       Per-plunge depth is docPerPass for stepped ops (profile/pocket/drill/
       v-carve when stepping), or |finalDepth| for a non-stepping op. If that
       per-plunge depth exceeds ~3x bit diameter (or 5mm without bit info),
       peck is strongly recommended for chip clearing. */
    var bitD = bit && bit.diameter_mm > 0 ? bit.diameter_mm : 0;
    var perPlungeDepth = (op === 'engrave' &&
        Math.abs(finalDepth) <= (s.docPerPass || Math.abs(finalDepth)))
      ? Math.abs(finalDepth)
      : Math.min(Math.abs(finalDepth), s.docPerPass || Math.abs(finalDepth));
    var plungeThreshold = bitD > 0 ? Math.max(3, bitD * 3) : 5;
    if (perPlungeDepth > plungeThreshold && s.plungeStyle === 'straight' &&
        (op === 'engrave' || op === 'profile-out' || op === 'profile-in' ||
         op === 'pocket' || op === 'drill')) {
      add('warn', 'Per-plunge depth (' + perPlungeDepth.toFixed(1) +
        'mm) is large for a straight plunge. Switch plunge style to "peck" ' +
        '(or "helical" for closed profiles) to clear chips and protect the bit.');
    }

    /* --- tabs (gotcha 5) ---
       Distinguish the user-set "tab thickness" (target remaining material)
       from the actual remaining material the toolpath will leave. They only
       diverge on through-cuts where material thickness is known and the
       toolpath cuts through it. */
    if (op === 'profile-out' && s.tabsEnabled) {
      if (s.tabThickness < 1) {
        add('error', 'Tab thickness ' + s.tabThickness + 'mm is too thin — tabs below ' +
          '1mm snap mid-cut and the part comes loose. Use at least 1mm.');
      } else if (s.tabThickness > 2) {
        add('warn', 'Tab thickness ' + s.tabThickness + 'mm is generous — it will hold ' +
          'well but needs flush-trim cleanup afterwards.');
      }
      if (Math.abs(finalDepth) > 0 && s.tabThickness >= Math.abs(finalDepth)) {
        add('warn', 'Tab thickness is greater than the cut depth — the tabs will not ' +
          'actually be cut into.');
      }
    }

    /* --- HDPE + multi-flute (gotcha 6) ---
       HDPE is the catastrophic case (melts dangerously). Acrylic is the
       chip-quality case. Anything the material library flags as preferring
       an O-flute bit gets a generic warning — covers HDPE/acrylic/PVC under
       custom names that the substring match would otherwise miss. */
    if (material && /hdpe/i.test(material.name || '') && bit && bit.flute_count > 1) {
      add('error', 'Multi-flute bits melt HDPE. Use a single-flute O-flute bit.');
    }
    if (material && /acrylic/i.test(material.name || '') && bit && bit.flute_count > 1) {
      add('warn', 'Acrylic cuts best with a single-flute O-flute bit — multi-flute ' +
        'bits tend to melt and chip it.');
    }
    if (material && bit && bit.flute_count > 1 &&
        material.recommended_bit_type === 'O-flute' &&
        !/hdpe/i.test(material.name || '') &&
        !/acrylic/i.test(material.name || '')) {
      add('warn', 'This material is tagged for an O-flute bit (chip-clearing for ' +
        'plastics). Multi-flute bits may melt or chip it — use a single-flute ' +
        'O-flute instead.');
    }

    /* --- through-cut depth vs material thickness (gotcha 4, 15) ---
       Only applies to profile-out (a real through-cut). Profile-in is an
       inside pocket / opening and rarely intended to go all the way through. */
    if (material && material.thickness_mm > 0 && op === 'profile-out') {
      var th = material.thickness_mm;
      var over = material.through_cut_overage_mm != null ? material.through_cut_overage_mm : 0.65;
      if (Math.abs(finalDepth) < th - 0.05) {
        add('info', 'Final depth ' + finalDepth + 'mm is shallower than the material ' +
          '(' + th + 'mm) — this will not cut all the way through.');
      } else if (Math.abs(finalDepth) > th + over + 1.5) {
        add('warn', 'Final depth ' + finalDepth + 'mm cuts well past the material ' +
          '(' + th + 'mm + ' + over + 'mm overage) — you are cutting into the spoilboard.');
      }
    }

    /* --- oversized drilled holes (gotcha 13) --- */
    var oversized = (toolpath.ops || []).filter(function (o) {
      return o.drill && o.drill.oversized;
    }).length;
    if (oversized > 0) {
      add('warn', oversized + ' hole(s) are smaller than the bit — they will be ' +
        'plunge-drilled oversized to the bit diameter. Check the gcode header.');
    }

    /* --- nested / overlapping outer contours (spec §10). A contour fully
       inside another is a normal window/bore, not a problematic overlap. --- */
    var outers = (job.subpaths || []).filter(function (sp) { return sp.type === 'outer'; });
    var partialOverlap = false, nested = false;
    for (var i = 0; i < outers.length; i++) {
      for (var k = i + 1; k < outers.length; k++) {
        if (!bboxOverlap(outers[i].bbox, outers[k].bbox)) continue;
        if (bboxContains(outers[i].bbox, outers[k].bbox) ||
            bboxContains(outers[k].bbox, outers[i].bbox)) {
          nested = true;
        } else {
          partialOverlap = true;
        }
      }
    }
    if (partialOverlap) {
      add('warn', 'Two outer contours partially overlap — review the preview ' +
        'manually to confirm the cut order is safe.');
    }
    if (nested && op === 'profile-out') {
      add('info', 'An outer contour sits inside another. Profile-out offsets ' +
        'every contour outward, so an interior window is cut oversized by a tool ' +
        'radius — run profile-in separately for interior cutouts.');
    }
    if (nested && op === 'profile-in') {
      add('info', 'An outer contour sits inside another. Profile-in offsets ' +
        'every contour inward, so an outer edge is cut undersized by a tool ' +
        'radius — run profile-out separately for the outer edge.');
    }

    /* --- M0 pauses (gotcha 1) --- */
    if (s.useM0) {
      add('info', 'M0 pauses are enabled — the program will stop and wait for ' +
        'Cycle Start before and after the cut.');
    }

    /* --- parametric part (gotcha 8) --- */
    if (job.hint && job.hint.parametric) {
      add('info', 'This looks like a parametric part (repeated brace patterns). ' +
        'If it was designed for a specific size, regenerate the SVG at the correct ' +
        'dimension rather than scaling it here.');
    }

    /* --- plywood thickness reminder (gotcha 3) --- */
    if (material && /plywood/i.test(material.name || '')) {
      add('info', 'Nominal plywood thickness is often 0.3-0.8mm under the label — ' +
        'measure your actual sheet before cutting.');
    }

    /* --- surface toolpath generation warnings --- */
    (toolpath.warnings || []).forEach(function (w) { add('warn', w); });

    /* --- bitmap trace complexity / fidelity hints --- */
    if (job && job.source && job.source.trace) {
      var t = job.source.trace;
      var nodes = t.nodesAfter || 0;
      // 30 k is where preview/cut start to feel sluggish on modest hardware.
      // 120 k is where the browser may stall outright — keep that as a hard
      // error-style warning.
      if (nodes > 120000) {
        add('warn', 'Bitmap trace generated ' + nodes + ' nodes — preview and cut ' +
          'will be slow. Raise the Simplify (mm) value or use a cleaner source image.');
      } else if (nodes > 30000) {
        add('info', 'Bitmap trace generated ' + nodes + ' nodes — cut may be slower ' +
          'than expected. Raising Simplify (mm) by 0.05 typically halves node count.');
      }
      if (nodes > 0 && t.nodesBefore && nodes / t.nodesBefore > 0.9) {
        add('info', 'Trace simplification is very light. If runtime is high, raise ' +
          'the Simplify (mm) value slightly.');
      }
    }

    issues.sort(function (a, b) { return LEVEL_RANK[a.level] - LEVEL_RANK[b.level]; });
    return {
      issues: issues,
      envelopeOk: envelopeOk,
      hasError: issues.some(function (x) { return x.level === 'error'; })
    };
  }

  function bboxOverlap(a, b) {
    return !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY);
  }
  function bboxContains(a, b) {
    return b.minX >= a.minX - 0.01 && b.maxX <= a.maxX + 0.01 &&
           b.minY >= a.minY - 0.01 && b.maxY <= a.maxY + 0.01;
  }
  function fmt(n) { return (Math.round(n * 10) / 10).toString(); }

  Forge.validation = { run: run };
})(typeof window !== 'undefined' ? (window.Forge = window.Forge || {})
                                 : (global.Forge = global.Forge || {}));
