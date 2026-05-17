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

    /* --- final depth must be below the surface --- */
    if (finalDepth >= 0) {
      add('warn', 'Final depth is ' + finalDepth + 'mm. Depth should be ' +
        'negative — below the material surface. A zero or positive value ' +
        'leaves the bit at or above the stock and cuts nothing.');
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

    /* --- bit reach vs final depth (spec §10, gotcha 7) --- */
    if (bit && bit.cutting_length_mm > 0) {
      if (Math.abs(finalDepth) + 2 >= bit.cutting_length_mm) {
        add('error', 'Final depth ' + finalDepth + 'mm needs more reach than the bit has ' +
          '(cutting length ' + bit.cutting_length_mm + 'mm, 2mm safety margin). ' +
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

    /* --- stock margin vs tool offset (spec §10) --- */
    var toolOffset = s.toolOffsetOverride > 0
      ? s.toolOffsetOverride
      : (bit && bit.diameter_mm > 0 ? bit.diameter_mm / 2 : 0) +
        (s.finishingAllowance != null ? s.finishingAllowance : 0.15);
    if (op === 'profile-out' && s.stockMargin <= toolOffset) {
      add('warn', 'Stock margin (' + s.stockMargin + 'mm) is smaller than the tool ' +
        'offset (' + fmt(toolOffset) + 'mm). The outside toolpath may run off the stock.',
        { id: 'stock-margin', suggest: { stockMargin: Math.ceil(toolOffset + 5) } });
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

    /* --- deep plunge without pecking (spec §10, gotcha) --- */
    if (op === 'engrave' && Math.abs(finalDepth) > 30 && s.plungeStyle !== 'peck') {
      add('warn', 'Engrave plunges ' + Math.abs(finalDepth) + 'mm in one move. ' +
        'Switch the plunge style to "peck" to clear chips.');
    }

    /* --- tabs (gotcha 5) --- */
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

    /* --- HDPE + multi-flute (gotcha 6) --- */
    if (material && /hdpe/i.test(material.name || '') && bit && bit.flute_count > 1) {
      add('error', 'Multi-flute bits melt HDPE. Use a single-flute O-flute bit.');
    }
    if (material && /acrylic/i.test(material.name || '') && bit && bit.flute_count > 1) {
      add('warn', 'Acrylic cuts best with a single-flute O-flute bit — multi-flute ' +
        'bits tend to melt and chip it.');
    }

    /* --- through-cut depth vs material thickness (gotcha 4, 15) --- */
    if (material && material.thickness_mm > 0 && (op === 'profile-out' || op === 'profile-in')) {
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
