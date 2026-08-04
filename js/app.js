/**
 * LowRider Forge — application controller.
 *
 * Owns the working state, builds the settings forms from a schema, runs the
 * parse -> toolpath -> validate -> preview pipeline and wires every control.
 */
(function (Forge) {
  'use strict';

  var VERSION = '1.0.0';
  var MAX_SVG_BYTES = 4 * 1024 * 1024;
  var MAX_FONT_BYTES = 8 * 1024 * 1024;
  var MAX_BITMAP_BYTES = 8 * 1024 * 1024;

  /* ---- defaults ------------------------------------------------------- */
  var DEFAULTS = {
    operation: 'engrave',
    finalDepth: -3, docPerPass: 1.5, feedCut: 1500, feedPlunge: 500,
    finishingAllowance: 0.15, toolOffsetOverride: 0,
    plungeStyle: 'straight', peckRetract: 2,
    tabsEnabled: true, tabCount: 4, tabThickness: 1.5, tabWidth: 6, tabPlacement: 'even',
    scale: 100, rotation: 0, originPosition: 'bottom-left',
    customOriginX: 0, customOriginY: 0,
    stockMargin: 0, holeThreshold: 50, targetHoleDiameter: 0,
    tessellationTolerance: 0.1,
    machineX: 1270, machineY: 2540, safeZ: 10, preStockZ: 2,
    rapidFeed: 5000, useM0: false, spindleRpm: 18000,
    filenamePattern: '{job}_{material}_{bit}_{date}.gcode',
    headerTemplate: '', jobName: 'job',
    inputMode: 'text',
    bitmapPreset: 'logo', bitmapThreshold: 145, bitmapMmPerPx: 0.2,
    bitmapMinArea: 20, bitmapSimplify: 0.08,
    textContent: 'SIGN', fontKey: 'montserrat',
    signWidth: 300, signHeight: 150,
    fitToSign: true, letterHeight: 60,
    textAlign: 'center', textAnchor: 'center', textOffsetX: 0, textOffsetY: 0,
    lineSpacing: 1.1, letterSpacing: 0,
    frame: false, frameInset: 8, frameStyle: 'square', frameCornerRadius: 12, textPadding: 12,
    graphics: []
  };

  var OP_HINTS = {
    engrave: 'Traces the path centerline at a single depth. No tool compensation. ' +
      'For text this gives outline lettering.',
    pocket: 'Clears the inside of every closed shape — solid, filled lettering. ' +
      'Counters (the holes in O, A, e) are kept.',
    vcarve: 'V-carves every closed shape with a V-bit — crisp, true V-cut ' +
      'lettering. Depth follows the bit angle; the final depth is the cap.',
    'profile-out': 'Cuts outside the path (tool radius + finishing). Multi-depth, ' +
      'tabs on the final pass. Small features are drilled.',
    'profile-in': 'Cuts inside the path — pockets and opening cutouts. Multi-depth.',
    drill: 'Plunge or helical-bore each closed feature. Holes smaller than the bit ' +
      'are plunged oversized.'
  };

  /* ---- form schemas --------------------------------------------------- */
  function opts(list) {
    return list.map(function (v) {
      return typeof v === 'string' ? { value: v, label: v } : v;
    });
  }

  var SCHEMA = {
    operation: [
      { key: 'finalDepth', label: 'Final depth', type: 'number', step: 0.1, unit: 'mm',
        hint: 'Negative = below the stock surface.' },
      { key: 'docPerPass', label: 'DOC per pass', type: 'number', step: 0.1, min: 0.05,
        unit: 'mm', hint: 'Depth removed each pass. Positive value.' },
      { key: 'feedCut', label: 'Cut feed', type: 'number', step: 50, min: 1, unit: 'mm/min' },
      { key: 'feedPlunge', label: 'Plunge feed', type: 'number', step: 25, min: 1,
        unit: 'mm/min', hint: 'Keep this 25-40% of the cut feed.' },
      { key: 'finishingAllowance', label: 'Finishing allowance', type: 'number', step: 0.05,
        unit: 'mm', hint: 'Added to the tool offset for a clean edge. Profile-in/out only.' },
      { key: 'toolOffsetOverride', label: 'Tool offset override', type: 'number', step: 0.1,
        min: 0, unit: 'mm', hint: '0 = auto (tool radius + finishing allowance). Profile-in/out only.' },
      { key: 'plungeStyle', label: 'Plunge style', type: 'select', options: opts([
        { value: 'straight', label: 'Straight' }, { value: 'peck', label: 'Peck' },
        { value: 'helical', label: 'Helical / ramp' }]) },
      { key: 'peckRetract', label: 'Peck retract', type: 'number', step: 0.5, min: 0,
        unit: 'mm', hint: 'Retract height between pecks.' }
    ],
    tabs: [
      { key: 'tabsEnabled', label: 'Enable tabs', type: 'checkbox' },
      { key: 'tabCount', label: 'Tabs per profile', type: 'number', step: 1, min: 0 },
      { key: 'tabThickness', label: 'Tab thickness', type: 'number', step: 0.1, min: 0,
        unit: 'mm', hint: 'Material left under the bit. Keep at or above 1mm.' },
      { key: 'tabWidth', label: 'Tab width', type: 'number', step: 0.5, min: 0, unit: 'mm',
        hint: 'Flat-top length along the perimeter.' }
    ],
    geometry: [
      { key: 'scale', label: 'Scale', type: 'number', step: 1, min: 1, unit: '%' },
      { key: 'rotation', label: 'Rotation', type: 'select', numeric: true, options: opts([
        { value: 0, label: '0°' }, { value: 90, label: '90°' },
        { value: 180, label: '180°' }, { value: 270, label: '270°' }]) },
      { key: 'originPosition', label: 'Origin position', type: 'select', options: opts([
        { value: 'bottom-left', label: 'Bottom-left (recommended)' },
        { value: 'center', label: 'Center' }, { value: 'top-left', label: 'Top-left' },
        { value: 'custom', label: 'Custom' }]),
        hint: 'The LowRider works in a positive XY area — bottom-left keeps every ' +
          'coordinate positive.' },
      { key: 'customOriginX', label: 'Custom origin X', type: 'number', step: 1, unit: 'mm',
        dependsOn: { key: 'originPosition', value: 'custom' } },
      { key: 'customOriginY', label: 'Custom origin Y', type: 'number', step: 1, unit: 'mm',
        dependsOn: { key: 'originPosition', value: 'custom' } },
      { key: 'stockMargin', label: 'Stock margin', type: 'number', step: 1, min: 0, unit: 'mm',
        hint: 'Extra stock added on each side of the part (0 keeps stock equal to the sign size).' },
      { key: 'holeThreshold', label: 'Hole-vs-trace threshold', type: 'number', step: 5,
        min: 0, unit: 'mm²', hint: 'Closed subpaths below this area become drill cycles.' },
      { key: 'targetHoleDiameter', label: 'Target hole diameter', type: 'number', step: 0.1,
        min: 0, unit: 'mm', hint: '0 = measure each hole from the geometry.' },
      { key: 'tessellationTolerance', label: 'Curve tolerance', type: 'number', step: 0.05,
        min: 0.01, unit: 'mm', hint: 'Lower = finer curves, slower preview.' }
    ],
    machine: [
      { key: 'jobName', label: 'Job name', type: 'text',
        hint: 'Used in the gcode header and filename.' },
      { key: 'machineX', label: 'Machine area X', type: 'number', step: 10, min: 1, unit: 'mm' },
      { key: 'machineY', label: 'Machine area Y', type: 'number', step: 10, min: 1, unit: 'mm' },
      { key: 'safeZ', label: 'Safe Z', type: 'number', step: 1, unit: 'mm',
        hint: 'Rapid height above the stock.' },
      { key: 'preStockZ', label: 'Pre-stock Z', type: 'number', step: 0.5, unit: 'mm',
        hint: 'Last height before the plunge.' },
      { key: 'rapidFeed', label: 'Rapid feed', type: 'number', step: 100, unit: 'mm/min',
        hint: 'Used for runtime estimates.' },
      { key: 'spindleRpm', label: 'Spindle RPM', type: 'number', step: 500, unit: 'rpm',
        hint: 'Informational unless a VFD is connected.' },
      { key: 'useM0', label: 'Use M0 pauses', type: 'checkbox',
        hint: 'Pauses for manual router on/off. Off by default — M0 trips people up.' },
      { key: 'filenamePattern', label: 'Filename pattern', type: 'text' },
      { key: 'headerTemplate', label: 'Header comment template', type: 'textarea',
        hint: 'Optional. Tokens: {job} {material} {bit} {operation} {date} {version}. ' +
          'Blank uses the default header.' }
    ]
  };

  var BIT_SCHEMA = [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'diameter_mm', label: 'Cutting diameter', type: 'number', step: 0.1, min: 0.1,
      unit: 'mm' },
    { key: 'shank_diameter_mm', label: 'Shank diameter', type: 'number', step: 0.1, unit: 'mm' },
    { key: 'flute_count', label: 'Flute count', type: 'number', step: 1, min: 1,
      hint: '1 for plastics, 2-3 for wood.' },
    { key: 'cutting_length_mm', label: 'Cutting length', type: 'number', step: 0.5, unit: 'mm',
      hint: 'Max plunge before the chuck collides.' },
    { key: 'type', label: 'Type', type: 'select',
      options: opts(['upcut', 'downcut', 'compression', 'O-flute', 'V-bit']) },
    { key: 'v_angle_deg', label: 'V-bit angle', type: 'number', step: 1, min: 0, max: 180,
      unit: '°', hint: 'Included angle of a V-bit — required for V-carving.' },
    { key: 'notes', label: 'Notes', type: 'textarea' }
  ];

  var MATERIAL_SCHEMA = [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'thickness_mm', label: 'Thickness', type: 'number', step: 0.1, unit: 'mm',
      hint: 'Nominal — always measure your actual stock.' },
    { key: 'recommended_bit_type', label: 'Recommended bit type', type: 'text' },
    { key: 'recommended_rpm', label: 'Recommended RPM', type: 'number', step: 500, unit: 'rpm' },
    { key: 'recommended_feed_cut', label: 'Recommended cut feed', type: 'number', step: 50,
      unit: 'mm/min' },
    { key: 'recommended_feed_plunge', label: 'Recommended plunge feed', type: 'number',
      step: 25, unit: 'mm/min' },
    { key: 'recommended_doc_mm', label: 'Recommended DOC', type: 'number', step: 0.1, unit: 'mm' },
    { key: 'through_cut_overage_mm', label: 'Through-cut overage', type: 'number', step: 0.05,
      unit: 'mm', hint: 'Extra depth past thickness for a clean through-cut.' },
    { key: 'notes', label: 'Notes', type: 'textarea' }
  ];

  var TEXT_SCHEMA = [
    { key: 'signWidth', label: 'Sign width', type: 'number', step: 5, min: 10, unit: 'mm' },
    { key: 'signHeight', label: 'Sign height', type: 'number', step: 5, min: 10, unit: 'mm' },
    { key: 'fitToSign', label: 'Fit text to sign', type: 'checkbox',
      hint: 'Scale the text to fill the sign automatically.' },
    { key: 'letterHeight', label: 'Letter height', type: 'number', step: 1, min: 1,
      unit: 'mm', hint: 'Capital-letter height.',
      dependsOn: { key: 'fitToSign', value: false } },
    { key: 'textAlign', label: 'Alignment', type: 'select', options: opts([
      { value: 'left', label: 'Left' }, { value: 'center', label: 'Center' },
      { value: 'right', label: 'Right' }]) },
    { key: 'textAnchor', label: 'Text placement', type: 'select', options: opts([
      { value: 'center', label: 'Center' }, { value: 'top-center', label: 'Top center' },
      { value: 'bottom-center', label: 'Bottom center' }, { value: 'top-left', label: 'Top left' },
      { value: 'top-right', label: 'Top right' }, { value: 'bottom-left', label: 'Bottom left' },
      { value: 'bottom-right', label: 'Bottom right' }]) },
    { key: 'textOffsetX', label: 'Text offset X', type: 'number', step: 1, unit: 'mm' },
    { key: 'textOffsetY', label: 'Text offset Y', type: 'number', step: 1, unit: 'mm' },
    { key: 'lineSpacing', label: 'Line spacing', type: 'number', step: 0.05, min: 0.5,
      unit: '×', hint: 'Gap between lines, as a multiple.' },
    { key: 'letterSpacing', label: 'Letter spacing', type: 'number', step: 1, unit: '%',
      hint: 'Extra space between letters.' },
    { key: 'frame', label: 'Cut a frame border', type: 'checkbox' },
    { key: 'frameInset', label: 'Frame inset', type: 'number', step: 1, min: 0, unit: 'mm',
      hint: 'Distance of the frame from the sign edge.',
      dependsOn: { key: 'frame', value: true } },
    { key: 'frameStyle', label: 'Frame style', type: 'select', options: opts([
      { value: 'square', label: 'Square corners' },
      { value: 'rounded', label: 'Rounded corners' }]),
      dependsOn: { key: 'frame', value: true } },
    { key: 'frameCornerRadius', label: 'Frame corner radius', type: 'number', step: 1, min: 0,
      unit: 'mm', hint: 'Used only for rounded frame style.',
      dependsOn: { key: 'frameStyle', value: 'rounded' } },
    { key: 'textPadding', label: 'Text padding', type: 'number', step: 1, min: 0, unit: 'mm',
      hint: 'Gap between the text and the sign or frame edge.' }
  ];

  /* ---- state ---------------------------------------------------------- */
  var state = {
    // graphics gets its own array — a plain Object.assign would alias
    // DEFAULTS.graphics, and every added shape would pollute the defaults.
    settings: Object.assign({}, DEFAULTS, { graphics: [] }),
    geometry: null, job: null, toolpath: null, validation: null,
    svgText: null, svgName: null, svgHash: null,
    bitmapMeta: null,
    bits: [], materials: [], presets: [],
    bit: null, material: null, font: null,
    serverUp: false
  };
  var preview = null;
  var lastGcode = '';
  var bitmapTraceRunId = 0;
  var bitmapTraceWorker = null;

  /* ---- tiny DOM helpers ---------------------------------------------- */
  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function debounce(fn, ms) {
    var t;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }
  function toast(msg, kind) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show ' + (kind || '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = 'toast'; }, 4200);
  }

  /* ---- form building -------------------------------------------------- */
  function buildField(field, value, onChange, defaults) {
    var row = el('div', 'field-row');
    if (field.type === 'textarea') row.classList.add('field-wide');
    row._field = field;

    var input;
    if (field.type === 'select') {
      input = el('select');
      field.options.forEach(function (o) {
        var opt = el('option', null, o.label);
        opt.value = o.value;
        input.appendChild(opt);
      });
      input.value = value;
    } else if (field.type === 'checkbox') {
      input = el('input');
      input.type = 'checkbox';
      input.checked = !!value;
      row.classList.add('field-check');
    } else if (field.type === 'textarea') {
      input = el('textarea');
      input.rows = 3;
      input.value = value == null ? '' : value;
    } else {
      input = el('input');
      input.type = field.type;
      if (field.step != null) input.step = field.step;
      if (field.min != null) input.min = field.min;
      if (field.max != null) input.max = field.max;
      input.value = value == null ? '' : value;
    }
    input.id = 'f-' + field.key;

    var lab = el('label');
    var span = el('span', 'field-label', field.label);
    if (field.unit) {
      var u = el('em', 'field-unit', field.unit);
      span.appendChild(u);
    }
    if (field.type === 'checkbox') {
      lab.appendChild(input);
      lab.appendChild(span);
    } else {
      lab.appendChild(span);
      lab.appendChild(input);
    }
    lab.htmlFor = input.id;
    row.appendChild(lab);

    if (field.hint) row.appendChild(el('p', 'field-hint', field.hint));

    function read() {
      if (field.type === 'checkbox') return input.checked;
      if (field.type === 'number') {
        if (input.value === '') return null;
        var v = parseFloat(input.value);
        if (!isFinite(v)) return null;
        // The HTML min/max attributes are advisory only — typed values land
        // in state unclamped, where e.g. a DOC of 0 means "full depth in one
        // pass" downstream. Enforce the schema bounds on the stored value.
        if (field.min != null && v < field.min) v = field.min;
        if (field.max != null && v > field.max) v = field.max;
        return v;
      }
      if (field.type === 'select' && field.numeric) return parseFloat(input.value);
      return input.value;
    }
    var evt = (field.type === 'select' || field.type === 'checkbox') ? 'change' : 'input';
    input.addEventListener(evt, function () { onChange(field.key, read(), field); });
    // A number field left empty stores null, and the pipeline would quietly
    // substitute hard-coded fallbacks that differ from the documented
    // defaults (e.g. finalDepth -1 instead of -3). Restore the default on
    // blur — not on input, which would fight the user mid-edit.
    if (field.type === 'number' && defaults && defaults[field.key] !== undefined) {
      input.addEventListener('blur', function () {
        if (input.value !== '' && isFinite(parseFloat(input.value))) return;
        input.value = defaults[field.key];
        onChange(field.key, read(), field);
      });
    }

    row._input = input;
    return row;
  }

  function buildForm(container, schema, getValue, onChange, defaults) {
    container.innerHTML = '';
    var map = {};
    schema.forEach(function (field) {
      var row = buildField(field, getValue(field.key), onChange, defaults);
      map[field.key] = row;
      container.appendChild(row);
    });
    return map;
  }

  function syncForm(map, schema, getValue) {
    schema.forEach(function (field) {
      var input = map[field.key]._input;
      var v = getValue(field.key);
      if (field.type === 'checkbox') input.checked = !!v;
      else input.value = v == null ? '' : v;
    });
  }

  function refreshVisibility(map, schema, settings) {
    schema.forEach(function (field) {
      if (field.dependsOn) {
        var on = settings[field.dependsOn.key] === field.dependsOn.value;
        if (field.key === 'frameCornerRadius') {
          on = on && !!settings.frame;
        }
        map[field.key].style.display = on ? '' : 'none';
      }
    });
  }

  /* form element maps */
  var forms = {};

  /* ---- recompute pipeline -------------------------------------------- */
  var recompute = debounce(recomputeNow, 90);

  function recomputeNow() {
    var s = state.settings;
    // The empty-state overlay always tracks whether artwork is loaded.
    $('#preview-empty').classList.toggle('hidden', !!state.geometry);
    if (!state.geometry) {
      state.job = state.toolpath = state.validation = null;
      preview.draw({ machineX: s.machineX, machineY: s.machineY });
      renderValidation();
      renderLiveValues();
      $('#generate-btn').disabled = true;
      return;
    }
    try {
      state.job = Forge.toolpath.prepareJob(state.geometry, s);
      // Pass material so toolpath.build can anchor the tab Z to the material
      // bottom on through-cuts (without it we'd silently produce tabs thinner
      // than the user set, because of the spoilboard-overage offset).
      state.toolpath = Forge.toolpath.build(state.job, s, state.bit, state.material);
      state.validation = Forge.validation.run(
        state.job, state.toolpath, s, state.bit, state.material);
    } catch (e) {
      // Drop stale results so a failed build can never be downloaded.
      state.job = state.toolpath = state.validation = null;
      preview.draw({ machineX: s.machineX, machineY: s.machineY });
      renderValidation();
      renderLiveValues();
      $('#generate-btn').disabled = true;
      toast('Toolpath error: ' + e.message, 'error');
      return;
    }
    preview.draw({
      job: state.job, toolpath: state.toolpath,
      machineX: s.machineX, machineY: s.machineY,
      interaction: buildTextDragInteraction()
    });
    renderValidation();
    renderLiveValues();
    $('#generate-btn').disabled = !state.toolpath.ops.length || state.validation.hasError;
    autosave();
  }

  function uiAnchorPoint(anchor, ix, iy, iW, iH) {
    switch (anchor) {
      case 'top-left': return { x: ix, y: iy };
      case 'top-center': return { x: ix + iW / 2, y: iy };
      case 'top-right': return { x: ix + iW, y: iy };
      case 'mid-left':
      case 'center-left': return { x: ix, y: iy + iH / 2 };
      case 'mid-right':
      case 'center-right': return { x: ix + iW, y: iy + iH / 2 };
      case 'bottom-left': return { x: ix, y: iy + iH };
      case 'bottom-center': return { x: ix + iW / 2, y: iy + iH };
      case 'bottom-right': return { x: ix + iW, y: iy + iH };
      default: return { x: ix + iW / 2, y: iy + iH / 2 };
    }
  }
  function buildTextDragInteraction() {
    if (!state.job || state.settings.inputMode !== 'text' || (state.settings.rotation || 0) !== 0) return null;
    var signW = Math.max(1, parseFloat(state.settings.signWidth) || 1);
    var signH = Math.max(1, parseFloat(state.settings.signHeight) || 1);
    var bbox = state.job.partBbox;
    if (!bbox) return null;
    function localToWorld(lx, ly) {
      return { x: bbox.minX + lx, y: bbox.minY + (signH - ly) };
    }
    var inset = state.settings.frame ? Math.max(0, parseFloat(state.settings.frameInset) || 0) : 0;
    var pad = Math.max(0, parseFloat(state.settings.textPadding) || 0);
    var ix = inset + pad, iy = inset + pad, iW = Math.max(1, signW - 2 * ix), iH = Math.max(1, signH - 2 * iy);

    function collectHandles() {
      var handles = [];
      var ta = uiAnchorPoint(state.settings.textAnchor || 'center', ix, iy, iW, iH);
      var tw = localToWorld(ta.x + (state.settings.textOffsetX || 0), ta.y + (state.settings.textOffsetY || 0));
      handles.push({
        type: 'text',
        worldX: tw.x, worldY: tw.y,
        baseX: state.settings.textOffsetX || 0, baseY: state.settings.textOffsetY || 0,
        minOffsetX: ix - ta.x, maxOffsetX: (ix + iW) - ta.x,
        minOffsetY: iy - ta.y, maxOffsetY: (iy + iH) - ta.y
      });
      (state.settings.graphics || []).forEach(function (g, idx) {
        var a = uiAnchorPoint(g.anchor || 'center', ix, iy, iW, iH);
        var gw = localToWorld(a.x + (g.offsetX || 0), a.y + (g.offsetY || 0));
        handles.push({
          type: 'graphic', idx: idx,
          worldX: gw.x, worldY: gw.y,
          baseX: g.offsetX || 0, baseY: g.offsetY || 0,
          minOffsetX: ix - a.x, maxOffsetX: (ix + iW) - a.x,
          minOffsetY: iy - a.y, maxOffsetY: (iy + iH) - a.y
        });
      });
      return handles;
    }

    function pickHandle(worldX, worldY) {
      var best = null, bestD = Infinity;
      collectHandles().forEach(function (h) {
        var d = Math.hypot(h.worldX - worldX, h.worldY - worldY);
        if (d < bestD) { bestD = d; best = h; }
      });
      if (!best) return null;
      var radius = Math.max(6, Math.min(24, Math.min(signW, signH) * 0.08));
      return bestD <= radius ? best : null;
    }

    return {
      hitTest: function (p) {
        return !!pickHandle(p.worldX, p.worldY);
      },
      onPointerDown: function (p) {
        var best = pickHandle(p.worldX, p.worldY);
        if (!best) return null;
        best.startX = p.worldX;
        best.startY = p.worldY;
        var clampedToastShown = false;  // once per drag, not per pixel
        return {
          capture: true,
          onMove: function (m) {
            var dx = m.worldX - best.startX;
            var dy = m.worldY - best.startY;
            var rawX = best.baseX + dx;
            var rawY = best.baseY - dy;
            var nextX = Math.max(best.minOffsetX, Math.min(best.maxOffsetX, rawX));
            var nextY = Math.max(best.minOffsetY, Math.min(best.maxOffsetY, rawY));
            if ((nextX !== rawX || nextY !== rawY) && !clampedToastShown) {
              toast('Cannot move outside the usable sign area. Sign size is locked.', 'error');
              clampedToastShown = true;
            }
            if (best.type === 'text') {
              state.settings.textOffsetX = nextX;
              state.settings.textOffsetY = nextY;
            } else {
              var g = state.settings.graphics[best.idx];
              if (!g) return;
              g.offsetX = nextX;
              g.offsetY = nextY;
            }
            syncAllForms();
            rebuildTextNow();
          }
        };
      }
    };
  }


  function reparseAndRecompute() {
    if (!state.svgText) { recompute(); return; }
    try {
      state.geometry = Forge.parseSvg(state.svgText, {
        tessellationTolerance: state.settings.tessellationTolerance
      });
    } catch (e) {
      toast('SVG parse error: ' + e.message, 'error');
      return;
    }
    recomputeNow();
  }

  /* ---- text sign generator ------------------------------------------- */
  function populateFontSelect() {
    var sel = $('#font-select');
    if (!sel) return;
    sel.innerHTML = '';
    Forge.textGeometry.FONTS.forEach(function (f) {
      var o = el('option', null, f.name);
      o.value = f.key;
      sel.appendChild(o);
    });
    sel.value = state.settings.fontKey;
  }

  function rebuildTextNow() {
    if (state.settings.inputMode !== 'text') return;
    if (!state.font) { recomputeNow(); return; }   // font still loading
    try {
      state.geometry = Forge.textGeometry.build({
        text: state.settings.textContent,
        font: state.font,
        signWidthMm: state.settings.signWidth,
        signHeightMm: state.settings.signHeight,
        letterHeightMm: state.settings.letterHeight,
        fitToSign: state.settings.fitToSign,
        align: state.settings.textAlign,
        textAnchor: state.settings.textAnchor,
        textOffsetX: state.settings.textOffsetX,
        textOffsetY: state.settings.textOffsetY,
        lineSpacing: state.settings.lineSpacing,
        letterSpacingPct: state.settings.letterSpacing,
        border: state.settings.frame,
        borderInsetMm: state.settings.frameInset,
        borderStyle: state.settings.frameStyle,
        borderRadiusMm: state.settings.frameCornerRadius,
        paddingMm: state.settings.textPadding,
        graphics: state.settings.graphics,
        tessellationTolerance: state.settings.tessellationTolerance
      });
    } catch (e) {
      state.geometry = null;
      recomputeNow();
      toast(e.message, 'warn');
      return;
    }
    state.svgHash = hashString(state.settings.textContent + '|' + state.settings.fontKey);
    $('#preview-empty').classList.add('hidden');
    recomputeNow();
  }
  var rebuildText = debounce(rebuildTextNow, 110);

  function loadFontThen(cb) {
    Forge.textGeometry.loadFont(state.settings.fontKey).then(function (font) {
      state.font = font;
      if (cb) cb();
    }).catch(function (e) {
      // an uploaded font is lost on reload — fall back to a bundled one
      if (state.settings.fontKey !== DEFAULTS.fontKey) {
        state.settings.fontKey = DEFAULTS.fontKey;
        var fs = $('#font-select'); if (fs) fs.value = DEFAULTS.fontKey;
        loadFontThen(cb);
      } else {
        toast('Could not load font: ' + e.message, 'error');
      }
    });
  }

  function regenerate() {
    if (state.settings.inputMode === 'text') rebuildTextNow();
    else reparseAndRecompute();
  }

  function switchInputMode(mode) {
    state.settings.inputMode = mode;
    Array.prototype.forEach.call($('#input-mode').children, function (b) {
      var isActive = b.dataset.mode === mode;
      b.classList.toggle('active', isActive);
      b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
    $('#text-panel').classList.toggle('hidden', mode !== 'text');
    $('#svg-panel').classList.toggle('hidden', mode !== 'svg');
    $('#bitmap-panel').classList.toggle('hidden', mode !== 'bitmap');
    // Leaving bitmap mode: cancel any in-flight trace so its async result
    // cannot land on top of the text/SVG geometry the user is switching to.
    if (mode !== 'bitmap') {
      bitmapTraceRunId++;
      if (bitmapTraceWorker) {
        try { bitmapTraceWorker.terminate(); } catch (e) {}
        bitmapTraceWorker = null;
      }
      setBitmapTraceBusy(false);
    }
    if (mode === 'text') {
      if (state.font) { rebuildTextNow(); preview.fit(); }
      else loadFontThen(function () { rebuildTextNow(); preview.fit(); });
    } else if (mode === 'svg' && state.svgText) {
      reparseAndRecompute();
      if (state.geometry) preview.fit();
    } else if (mode === 'bitmap' && state.bitmapMeta) {
      traceBitmapNow();
      if (state.geometry) preview.fit();
    } else {
      // SVG mode with nothing uploaded — drop any leftover text geometry so
      // the preview shows the empty state, not the previous sign.
      state.geometry = null;
      recomputeNow();
    }
  }







  function applyBitmapPreset(name) {
    var map = {
      logo: { threshold: 145, minArea: 20, simplify: 0.08 },
      line: { threshold: 165, minArea: 8, simplify: 0.05 },
      stencil: { threshold: 135, minArea: 30, simplify: 0.12 }
    };
    var cfg = map[name] || map.logo;
    state.settings.bitmapPreset = map[name] ? name : 'logo';
    state.settings.bitmapThreshold = cfg.threshold;
    state.settings.bitmapMinArea = cfg.minArea;
    state.settings.bitmapSimplify = cfg.simplify;
    syncBitmapControls();
  }

  /** Push the trace settings into the bitmap panel inputs (DOM ← state).
      The params live in state.settings so they autosave and travel with
      presets — MM-per-pixel sets the physical size of a traced sign, and
      losing it between sessions silently resizes the next cut. */
  function syncBitmapControls() {
    var s = state.settings;
    var set = function (id, v) { var n = $('#' + id); if (n && v != null) n.value = v; };
    set('bitmap-preset', s.bitmapPreset);
    set('bitmap-threshold', s.bitmapThreshold);
    set('bitmap-mm-per-px', s.bitmapMmPerPx);
    set('bitmap-min-area', s.bitmapMinArea);
    set('bitmap-simplify', s.bitmapSimplify);
  }

  function setBitmapTraceBusy(on) {
    var n = $('#bitmap-trace-status');
    if (!n) return;
    n.classList.toggle('hidden', !on);
  }
  function cancelBitmapTrace() {
    bitmapTraceRunId++;
    if (bitmapTraceWorker) {
      try { bitmapTraceWorker.terminate(); } catch (e) {}
      bitmapTraceWorker = null;
    }
    setBitmapTraceBusy(false);
    toast('Bitmap trace cancelled.');
  }
  function buildBitmapThumb(bitmap) {
    if (!bitmap || !bitmap.width) return null;
    var maxSide = 160;
    var scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    var w = Math.max(1, Math.round(bitmap.width * scale));
    var h = Math.max(1, Math.round(bitmap.height * scale));
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.className = 'bitmap-thumb';
    c.setAttribute('aria-label', 'Source bitmap preview');
    try { c.getContext('2d').drawImage(bitmap, 0, 0, w, h); } catch (e) { return null; }
    return c;
  }
  function showBitmapInfo(meta, traced) {
    var box = $('#bitmap-info');
    if (!box) return;
    box.innerHTML = '';
    var thumb = buildBitmapThumb(meta && meta.bitmap);
    if (thumb) box.appendChild(thumb);
    box.appendChild(el('div', 'svg-info-name', meta.name || 'image'));
    var sizeText = meta.size < 1024 ? meta.size + ' B' : Math.round(meta.size / 1024) + ' KB';
    box.appendChild(el('div', 'svg-info-dims', meta.width + ' × ' + meta.height + ' px · ' + sizeText));
    if (traced) {
      box.appendChild(el('div', 'svg-info-class', traced.subpaths.length + ' traced contour(s)'));
      if (traced.trace) {
        var before = traced.trace.nodesBefore || 0;
        var after = traced.trace.nodesAfter || 0;
        box.appendChild(el('div', 'svg-info-class', 'Nodes: ' + before + ' → ' + after));
      }
    }
    box.classList.remove('hidden');
  }

  function traceBitmapNow() {
    if (!state.bitmapMeta || !state.bitmapMeta.bitmap || !Forge.BitmapTracer) return;
    var params = {
      threshold: parseFloat(state.settings.bitmapThreshold),
      mmPerPixel: parseFloat(state.settings.bitmapMmPerPx),
      minAreaPx: parseFloat(state.settings.bitmapMinArea),
      simplifyMm: parseFloat(state.settings.bitmapSimplify)
    };
    if (!isFinite(params.threshold)) params.threshold = 145;
    params.threshold = Math.min(255, Math.max(1, params.threshold));
    if (!isFinite(params.mmPerPixel) || params.mmPerPixel <= 0) params.mmPerPixel = 0.2;
    if (!isFinite(params.minAreaPx) || params.minAreaPx < 0) params.minAreaPx = 20;
    if (!isFinite(params.simplifyMm) || params.simplifyMm <= 0) params.simplifyMm = 0.08;

    var runId = ++bitmapTraceRunId;
    if (bitmapTraceWorker) {
      try { bitmapTraceWorker.terminate(); } catch (e) {}
      bitmapTraceWorker = null;
    }

    setBitmapTraceBusy(true);
    var maxW = 1400;
    var scale = state.bitmapMeta.bitmap.width > maxW ? (maxW / state.bitmapMeta.bitmap.width) : 1;
    var w = Math.max(1, Math.round(state.bitmapMeta.bitmap.width * scale));
    var h = Math.max(1, Math.round(state.bitmapMeta.bitmap.height * scale));
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(state.bitmapMeta.bitmap, 0, 0, w, h);
    var img = cx.getImageData(0, 0, w, h);

    function applyTraceGeometry(geometry) {
      if (runId !== bitmapTraceRunId) return;
      // Reject results that complete after the user has moved to a different
      // input mode — otherwise a slow trace would silently overwrite text or
      // SVG geometry the user is now editing.
      if (state.settings.inputMode !== 'bitmap') { setBitmapTraceBusy(false); return; }
      state.geometry = geometry;
      state.svgHash = hashString('bitmap:' + state.bitmapMeta.name + ':' + JSON.stringify(state.geometry.trace || {}));
      showBitmapInfo(state.bitmapMeta, state.geometry);
      $('#preview-empty').classList.add('hidden');
      recomputeNow();
      setBitmapTraceBusy(false);
    }

    if (window.Worker) {
      try {
        var worker = new Worker('js/workers/trace-worker.js');
        bitmapTraceWorker = worker;
        worker.onmessage = function (ev) {
          var r = ev.data || {};
          if (bitmapTraceWorker === worker) bitmapTraceWorker = null;
          worker.terminate();
          if (runId !== bitmapTraceRunId) return;
          if (!r.ok) {
            setBitmapTraceBusy(false);
            toast('Bitmap trace failed: ' + (r.error || 'worker error'), 'error');
            return;
          }
          applyTraceGeometry(r.geometry);
        };
        worker.onerror = function () {
          if (bitmapTraceWorker === worker) bitmapTraceWorker = null;
          worker.terminate();
          if (runId !== bitmapTraceRunId) return;
          setBitmapTraceBusy(false);
          toast('Bitmap trace worker crashed. Falling back to main thread.', 'error');
          try { applyTraceGeometry(Forge.BitmapTracer.traceImageData(img, params)); }
          catch (e3) { toast('Bitmap trace failed: ' + e3.message, 'error'); }
        };
        // Structured-clone the pixel buffer instead of transferring it — if
        // the worker crashes on start, the main-thread fallback below still
        // needs to read img.data, which a transfer would have detached.
        worker.postMessage({ width: img.width, height: img.height, rgba: img.data.buffer, threshold: params.threshold, mmPerPixel: params.mmPerPixel, minAreaPx: params.minAreaPx, simplifyMm: params.simplifyMm });
        return;
      } catch (e) {}
    }
    try {
      applyTraceGeometry(Forge.BitmapTracer.traceImageData(img, params));
    } catch (e2) {
      setBitmapTraceBusy(false);
      toast('Bitmap trace failed: ' + e2.message, 'error');
    }
  }

  function readBitmapFile(file) {
    if (!file) return;
    if (!/\.(png|jpe?g|webp|bmp)$/i.test(file.name || '')) { toast('Please upload PNG/JPG/WebP/BMP.', 'error'); return; }
    if (file.size > MAX_BITMAP_BYTES) { toast('Bitmap file is too large. Maximum allowed size is 8 MB.', 'error'); return; }
    createImageBitmap(file).then(function (bmp) {
      state.bitmapMeta = { name: file.name, size: file.size, width: bmp.width, height: bmp.height, bitmap: bmp };
      if (state.settings.jobName === 'job') state.settings.jobName = (file.name || 'bitmap').replace(/\.[^.]+$/, '');
      // Keep the current trace parameters — re-applying the preset here
      // would silently reset threshold/min-area/simplify tweaks (and with
      // them the traced geometry) on every upload.
      showBitmapInfo(state.bitmapMeta);
      traceBitmapNow();
      preview.fit();
      toast('Loaded bitmap ' + file.name + '.');
    }).catch(function (e) { toast('Could not decode bitmap: ' + e.message, 'error'); });
  }
  function formatShapeParamHint(param, width, height) {
    if (!param || param.unit !== 'ratio') return '';
    var w = isFinite(width) && width > 0 ? width : 0;
    var h = isFinite(height) && height > 0 ? height : 0;
    var minSide = Math.min(w, h);
    if (!(minSide > 0)) return 'Ratio is based on the shape size.';
    var mm = (param.def || 0) * minSide;
    return '≈ ' + mm.toFixed(1) + 'mm at current size (' + minSide.toFixed(0) + 'mm min side).';
  }

  function renderShapeBuilderParams() {
    var box = $('#shape-param-fields');
    if (!box || !Forge.shapes || !Forge.shapes.SHAPES) return;
    var shape = $('#shape-type').value;
    var def = Forge.shapes.SHAPES[shape];
    box.innerHTML = '';
    if (!def || !Array.isArray(def.params)) return;
    def.params.forEach(function (param) {
      var lab = el('label', 'field');
      var title = param.label || param.key;
      if (param.unit === 'ratio') title += ' (%)';
      lab.appendChild(el('span', null, title));
      var inp = el('input');
      inp.type = 'number'; inp.id = 'shape-param-' + param.key;
      inp.step = param.step != null ? param.step : 0.01;
      if (param.min != null) inp.min = param.unit === 'ratio' ? (param.min * 100) : param.min;
      if (param.max != null) inp.max = param.unit === 'ratio' ? (param.max * 100) : param.max;
      inp.value = param.unit === 'ratio' ? (param.def * 100) : param.def;
      lab.appendChild(inp);
      var hint = formatShapeParamHint(param, parseFloat($('#shape-width').value), parseFloat($('#shape-height').value));
      if (hint) lab.appendChild(el('span', 'shape-param-hint', hint));
      box.appendChild(lab);
    });
  }

  function initShapeBuilder() {
    if (!Forge.shapes || !Forge.shapes.SHAPES) return;
    var shapeSel = $('#shape-type');
    var anchorSel = $('#shape-anchor');
    if (!shapeSel || !anchorSel) return;
    var anchorOptions = [
      { value: 'center', label: 'Center' },
      { value: 'top-left', label: 'Top left' },
      { value: 'top-center', label: 'Top center' },
      { value: 'top-right', label: 'Top right' },
      { value: 'center-left', label: 'Center left' },
      { value: 'center-right', label: 'Center right' },
      { value: 'bottom-left', label: 'Bottom left' },
      { value: 'bottom-center', label: 'Bottom center' },
      { value: 'bottom-right', label: 'Bottom right' }
    ];
    anchorOptions.forEach(function (a) { var o = el('option', null, a.label); o.value = a.value; anchorSel.appendChild(o); });
    Object.keys(Forge.shapes.SHAPES).forEach(function (k) {
      var d = Forge.shapes.SHAPES[k];
      var o = el('option', null, d.label ? (d.label + ' (' + k + ')') : k);
      o.value = k; shapeSel.appendChild(o);
    });
    shapeSel.value = 'arrow';
    anchorSel.value = 'center';
    shapeSel.addEventListener('change', renderShapeBuilderParams);
    $('#shape-width').addEventListener('input', renderShapeBuilderParams);
    $('#shape-height').addEventListener('input', renderShapeBuilderParams);
    renderShapeBuilderParams();
  }

  function renderGraphicsList() {
    var box = $('#graphics-list');
    var clearBtn = $('#clear-graphics-btn');
    if (!box) return;
    var list = state.settings.graphics || [];
    if (clearBtn) clearBtn.disabled = !list.length;
    if (!list.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = '';
    box.appendChild(el('div', 'graphics-header', list.length + ' shape' + (list.length === 1 ? '' : 's') + ' in sign'));
    list.forEach(function (g, idx) {
      var row = el('div', 'graphics-row');
      var rowHead = el('div', 'graphics-row-head');
      var shapeLabel = (Forge.shapes && Forge.shapes.SHAPES && Forge.shapes.SHAPES[g.shape] && Forge.shapes.SHAPES[g.shape].label)
        ? Forge.shapes.SHAPES[g.shape].label
        : g.shape;
      rowHead.appendChild(el('div', 'graphics-row-title', (idx + 1) + '. ' + shapeLabel));
      var rowActions = el('div', 'graphics-row-actions');
      var fitBtn = el('button', 'btn btn-ghost btn-mini', 'Auto-fit');
      fitBtn.type = 'button';
      fitBtn.title = 'Fit this shape to the usable sign area.';
      fitBtn.addEventListener('click', function () {
        autoFitGraphic(g, false);
      });
      rowActions.appendChild(fitBtn);
      var fitAspectBtn = el('button', 'btn btn-ghost btn-mini', 'Fit (keep ratio)');
      fitAspectBtn.type = 'button';
      fitAspectBtn.title = 'Fit this shape while keeping aspect ratio.';
      fitAspectBtn.addEventListener('click', function () {
        autoFitGraphic(g, true);
      });
      rowActions.appendChild(fitAspectBtn);
      rowHead.appendChild(rowActions);
      row.appendChild(rowHead);
      var fields = el('div', 'graphics-row-fields');
      function addNum(label, key, step) {
        var lab = el('label', 'field'); lab.appendChild(el('span', null, label));
        var inp = el('input'); inp.type='number'; inp.step=step || 1; inp.value = g[key] || 0;
        inp.addEventListener('input', function(){ var v=parseFloat(inp.value); if(isFinite(v)){ g[key]=v; rebuildText(); renderGraphicsList(); }});
        lab.appendChild(inp); fields.appendChild(lab);
      }
      addNum('W (mm)', 'width', 1);
      addNum('H (mm)', 'height', 1);
      addNum('X offset (mm)', 'offsetX', 0.5);
      addNum('Y offset (mm)', 'offsetY', 0.5);
      addNum('Rotation (°)', 'rotation', 1);

      var anchorLab = el('label', 'field');
      anchorLab.appendChild(el('span', null, 'Anchor'));
      var anchorSel = el('select');
      [
        { value: 'center', label: 'Center' },
        { value: 'top-left', label: 'Top left' },
        { value: 'top-center', label: 'Top center' },
        { value: 'top-right', label: 'Top right' },
        { value: 'center-left', label: 'Center left' },
        { value: 'center-right', label: 'Center right' },
        { value: 'bottom-left', label: 'Bottom left' },
        { value: 'bottom-center', label: 'Bottom center' },
        { value: 'bottom-right', label: 'Bottom right' }
      ].forEach(function (a) {
        var o = el('option', null, a.label); o.value = a.value; anchorSel.appendChild(o);
      });
      anchorSel.value = g.anchor || 'center';
      anchorSel.addEventListener('change', function () { g.anchor = anchorSel.value; rebuildTextNow(); });
      anchorLab.appendChild(anchorSel);
      fields.appendChild(anchorLab);

      var def = Forge.shapes && Forge.shapes.SHAPES ? Forge.shapes.SHAPES[g.shape] : null;
      if (!g.params) g.params = {};
      if (def && Array.isArray(def.params)) {
        def.params.forEach(function (param) {
          var lab = el('label', 'field');
          var pname = (param.label || param.key) + (param.unit === 'ratio' ? ' (%)' : '');
          lab.appendChild(el('span', null, pname));
          var inp = el('input');
          inp.type = 'number';
          inp.step = param.step != null ? param.step : 0.01;
          if (param.min != null) inp.min = param.unit === 'ratio' ? param.min * 100 : param.min;
          if (param.max != null) inp.max = param.unit === 'ratio' ? param.max * 100 : param.max;
          var current = g.params[param.key];
          if (!isFinite(current)) current = param.def;
          inp.value = param.unit === 'ratio' ? current * 100 : current;
          inp.addEventListener('input', function () {
            var num = parseFloat(inp.value);
            if (!isFinite(num)) return;
            if (param.unit === 'ratio') num = num / 100;
            g.params[param.key] = num;
            rebuildTextNow();
          });
          lab.appendChild(inp);
          fields.appendChild(lab);
        });
      }
      row.appendChild(fields);
      var del = el('button', 'link-btn graphics-remove', 'Remove');
      del.type = 'button';
      del.setAttribute('aria-label', 'Remove shape ' + (idx + 1));
      del.addEventListener('click', function () {
        state.settings.graphics.splice(idx, 1);
        renderGraphicsList();
        rebuildTextNow();
      });
      row.appendChild(del);
      box.appendChild(row);
    });
  }

  function signInterior(forBorderShape) {
    var signW = Math.max(1, parseFloat(state.settings.signWidth) || 1);
    var signH = Math.max(1, parseFloat(state.settings.signHeight) || 1);
    var inset = state.settings.frame ? Math.max(0, parseFloat(state.settings.frameInset) || 0) : 0;
    var pad = forBorderShape ? 0 : Math.max(0, parseFloat(state.settings.textPadding) || 0);
    var ix = Math.min(inset + pad, Math.max(0, signW / 2 - 0.5));
    var iy = Math.min(inset + pad, Math.max(0, signH / 2 - 0.5));
    return {
      width: Math.max(1, signW - 2 * ix),
      height: Math.max(1, signH - 2 * iy)
    };
  }

  function autoFitGraphic(g, keepRatio, silent) {
    if (!g) return;
    var isBorderShape = g.shape === 'borderRect' || g.shape === 'ring' || g.shape === 'roundedBorderRect';
    var i = signInterior(isBorderShape);
    var targetW = i.width;
    var targetH = i.height;
    if (keepRatio) {
      var cw = Math.max(0.1, parseFloat(g.width) || 1);
      var ch = Math.max(0.1, parseFloat(g.height) || 1);
      var s = Math.min(targetW / cw, targetH / ch);
      targetW = cw * s;
      targetH = ch * s;
    }
    g.width = Math.max(0.1, targetW);
    g.height = Math.max(0.1, targetH);
    g.anchor = 'center';
    g.offsetX = 0;
    g.offsetY = 0;
    rebuildTextNow();
    renderGraphicsList();
    if (!silent) toast((isBorderShape ? 'Border' : 'Shape') + ' auto-fit to usable sign area.', 'ok');
  }

  function autoFitAllGraphics(keepRatio) {
    var list = state.settings.graphics || [];
    if (!list.length) return;
    list.forEach(function (g) { autoFitGraphic(g, keepRatio, true); });
    renderGraphicsList();
    rebuildTextNow();
    toast('Auto-fit applied to ' + list.length + ' shape' + (list.length === 1 ? '' : 's') + '.', 'ok');
  }

  function applyTextShapeLayout(preset) {
    if (!state.settings.graphics || !state.settings.graphics.length) {
      toast('Add at least one shape first, then apply a layout preset.', 'warn');
      return;
    }

    var layoutMap = {
      'text-top-shape-bottom': {
        textAnchor: 'top-center', textOffsetX: 0, textOffsetY: 6,
        shapeAnchor: 'bottom-center', shapeOffsetX: 0, shapeOffsetY: -6,
        message: 'Applied layout: text top, shape(s) bottom.'
      },
      'shape-top-text-bottom': {
        textAnchor: 'bottom-center', textOffsetX: 0, textOffsetY: -6,
        shapeAnchor: 'top-center', shapeOffsetX: 0, shapeOffsetY: 6,
        message: 'Applied layout: shape(s) top, text bottom.'
      },
      'text-left-shape-right': {
        textAnchor: 'center-left', textOffsetX: 6, textOffsetY: 0,
        shapeAnchor: 'center-right', shapeOffsetX: -6, shapeOffsetY: 0,
        message: 'Applied layout: text left, shape(s) right.'
      },
      'shape-left-text-right': {
        textAnchor: 'center-right', textOffsetX: -6, textOffsetY: 0,
        shapeAnchor: 'center-left', shapeOffsetX: 6, shapeOffsetY: 0,
        message: 'Applied layout: shape(s) left, text right.'
      },
      'centered-overlap': {
        textAnchor: 'center', textOffsetX: 0, textOffsetY: 0,
        shapeAnchor: 'center', shapeOffsetX: 0, shapeOffsetY: 0,
        message: 'Applied layout: centered overlap.'
      }
    };

    var cfg = layoutMap[preset];
    if (!cfg) return;

    state.settings.textAnchor = cfg.textAnchor;
    state.settings.textOffsetX = cfg.textOffsetX;
    state.settings.textOffsetY = cfg.textOffsetY;
    state.settings.fitToSign = true;
    state.settings.graphics.forEach(function (g) {
      g.anchor = cfg.shapeAnchor;
      g.offsetX = cfg.shapeOffsetX;
      g.offsetY = cfg.shapeOffsetY;
    });
    autoFitAllGraphics(true);
    syncAllForms();
    renderGraphicsList();
    rebuildTextNow();
    toast(cfg.message, 'ok');
  }

  function addGraphicFromBuilder(shapeOverride) {
    if (!Forge.shapes || !Forge.shapes.SHAPES) {
      toast('Shape library is unavailable right now.', 'warn');
      return;
    }
    var names = Object.keys(Forge.shapes.SHAPES);
    if (!names.length) {
      toast('No shapes are currently registered.', 'warn');
      return;
    }
    var shapeSel = $('#shape-type');
    var shape = shapeOverride || (shapeSel ? String(shapeSel.value || '').trim() : '');
    if (!shape) return;
    if (!Forge.shapes.SHAPES[shape]) { toast('Unknown shape: ' + shape, 'warn'); return; }

    var width = parseFloat($('#shape-width').value);
    var height = parseFloat($('#shape-height').value);
    var anchor = $('#shape-anchor').value || 'center';
    var validAnchors = {
      center: 1, 'top-left': 1, 'top-center': 1, 'top-right': 1,
      'mid-left': 1, 'mid-right': 1, 'center-left': 1, 'center-right': 1, 'bottom-left': 1, 'bottom-center': 1, 'bottom-right': 1
    };
    anchor = anchor ? String(anchor).trim() : 'center';
    if (!validAnchors[anchor]) anchor = 'center';

    var g = {
      id: 'g:' + Date.now(), shape: shape, anchor: anchor,
      offsetX: 0, offsetY: 0,
      width: isFinite(width) && width > 0 ? width : 40,
      height: isFinite(height) && height > 0 ? height : 20,
      rotation: 0, flipH: false, flipV: false, params: {}
    };

    var def = Forge.shapes.SHAPES[shape];
    if (def && Array.isArray(def.params)) {
      def.params.forEach(function (param) {
        var inp = $('#shape-param-' + param.key);
        if (!inp) return;
        var num = parseFloat(inp.value);
        if (!isFinite(num)) return;
        if (param.unit === 'ratio') num = num / 100;
        g.params[param.key] = num;
      });
    }

    state.settings.graphics.push(g);
    renderGraphicsList();
    rebuildTextNow();
  }

  function onFontUpload(file) {
    if (!file) return;
    if (file.size > MAX_FONT_BYTES) {
      toast('Font file is too large. Maximum allowed size is 8 MB.', 'error');
      return;
    }
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var added = Forge.textGeometry.addUploadedFont(
          file.name.replace(/\.(ttf|otf|woff)$/i, ''), fr.result);
        state.settings.fontKey = added.key;
        populateFontSelect();
        loadFontThen(rebuildTextNow);
        toast('Font "' + added.name + '" added.');
      } catch (e) {
        toast('Could not read that font file: ' + e.message + ' Supported formats are .ttf, .otf, and .woff.', 'error');
      }
    };
    fr.onerror = function () { toast('Could not read the font file.', 'error'); };
    fr.readAsArrayBuffer(file);
  }

  /* ---- validation panel ---------------------------------------------- */
  function renderValidation() {
    var list = $('#validation-list');
    list.innerHTML = '';
    if (!state.validation) {
      list.appendChild(el('li', 'vi vi-info',
        state.geometry ? 'Adjust settings to generate a toolpath.'
                        : 'Load artwork to begin (text sign or SVG).'));
      return;
    }
    var issues = state.validation.issues;
    if (!issues.length) {
      list.appendChild(el('li', 'vi vi-ok', 'All checks passed — ready to generate.'));
      return;
    }
    issues.forEach(function (iss) {
      var li = el('li', 'vi vi-' + iss.level);
      li.appendChild(el('span', 'vi-msg', iss.msg));
      if (iss.suggest) {
        var fix = el('button', 'vi-fix', 'Apply fix');
        fix.addEventListener('click', function () {
          Object.keys(iss.suggest).forEach(function (k) {
            state.settings[k] = iss.suggest[k];
          });
          syncAllForms();
          recomputeNow();
          toast('Setting adjusted.');
        });
        li.appendChild(fix);
      }
      if (iss.id === 'rotate') {
        var rot = el('button', 'vi-fix', 'Rotate 90°');
        rot.addEventListener('click', function () {
          state.settings.rotation = (state.settings.rotation + 90) % 360;
          syncAllForms();
          recomputeNow();
        });
        li.appendChild(rot);
      }
      list.appendChild(li);
    });
  }

  /* ---- live values ---------------------------------------------------- */
  function formatDuration(sec) {
    if (!isFinite(sec) || sec < 0) return '—';
    return sec >= 60
      ? Math.floor(sec / 60) + 'm ' + Math.round(sec % 60) + 's'
      : Math.round(sec) + 's';
  }

  function formatDistance(mm) {
    if (!isFinite(mm) || mm < 0) return '—';
    return mm >= 1000 ? (mm / 1000).toFixed(2) + ' m' : Math.round(mm) + ' mm';
  }

  function renderLiveValues() {
    var stock = '—', runtime = '—', passes = '—', chip = '—', cutDistance = '—', rapidDistance = '—';
    if (state.job) {
      stock = round1(state.job.stockWidth) + ' × ' +
        round1(state.job.stockHeight) + ' mm';
    }
    if (state.toolpath) {
      var sec = state.toolpath.stats.estSeconds;
      runtime = formatDuration(sec);
      passes = String(state.toolpath.stats.zPasses);
      cutDistance = formatDistance(state.toolpath.stats.cutLength);
      rapidDistance = formatDistance(state.toolpath.stats.rapidLength);
    }
    var s = state.settings;
    if (state.bit && state.bit.flute_count > 0 && s.spindleRpm > 0 && s.feedCut > 0) {
      var c = s.feedCut / (s.spindleRpm * state.bit.flute_count);
      chip = c.toFixed(3) + ' mm';
    }
    $('#lv-stock').textContent = stock;
    $('#lv-runtime').textContent = runtime;
    $('#lv-passes').textContent = passes;
    $('#lv-chip').textContent = chip;
    $('#lv-cutlen').textContent = cutDistance;
    $('#lv-rapidlen').textContent = rapidDistance;
  }
  function round1(n) { return Math.round(n * 10) / 10; }

  /* ---- SVG loading ---------------------------------------------------- */
  function hashString(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }

  function loadSvg(text, name) {
    state.svgText = text;
    state.svgName = name;
    state.svgHash = hashString(text);
    try {
      state.geometry = Forge.parseSvg(text, {
        tessellationTolerance: state.settings.tessellationTolerance
      });
    } catch (e) {
      toast('Could not parse SVG: ' + e.message + ' If the file has <text>, convert text to paths first, or use Text sign mode.', 'error');
      return;
    }
    if (name && /\.svg$/i.test(name) && state.settings.jobName === 'job') {
      state.settings.jobName = name.replace(/\.svg$/i, '');
      syncForm(forms.machine, SCHEMA.machine, getSetting);
    }
    showSvgInfo();
    $('#preview-empty').classList.add('hidden');
    recomputeNow();
    preview.fit();
    toast('Loaded ' + (name || 'SVG') + '.');
  }

  function showSvgInfo() {
    var g = state.geometry, box = $('#svg-info');
    var counts = { outer: 0, hole: 0, open: 0 };
    g.subpaths.forEach(function (sp) {
      counts[sp.closed ? (sp.area < state.settings.holeThreshold ? 'hole' : 'outer')
                       : 'open']++;
    });
    box.innerHTML = '';
    box.appendChild(el('div', 'svg-info-name', state.svgName || 'geometry.svg'));
    var dims = el('div', 'svg-info-dims',
      round1(g.width_mm) + ' × ' + round1(g.height_mm) + ' mm  ·  ' +
      g.subpaths.length + ' subpaths');
    box.appendChild(dims);
    box.appendChild(el('div', 'svg-info-class',
      counts.outer + ' outer · ' + counts.hole + ' hole · ' +
      counts.open + ' open'));
    if (!g.hadUnits) {
      box.appendChild(el('div', 'svg-info-warn',
        'No explicit units in the SVG — size assumed at 96 dpi. ' +
        'Check the Scale if the dimensions look wrong.'));
    }
    box.classList.remove('hidden');
  }

  function readFile(file) {
    if (!file) return;
    if (!/\.svg$/i.test(file.name || '')) {
      toast('Please upload an .svg file.', 'error');
      return;
    }
    if (file.size > MAX_SVG_BYTES) {
      toast('SVG file is too large. Maximum allowed size is 4 MB.', 'error');
      return;
    }
    var fr = new FileReader();
    fr.onload = function () { loadSvg(String(fr.result), file.name); };
    fr.onerror = function () { toast('Could not read file.', 'error'); };
    fr.readAsText(file);
  }

  /* ---- library (bits / materials / presets) -------------------------- */
  function getSetting(key) { return state.settings[key]; }

  function populateSelect(sel, items, valueKey, labelKey, current) {
    sel.innerHTML = '';
    items.forEach(function (it) {
      var o = el('option', null, it[labelKey]);
      o.value = it[valueKey];
      sel.appendChild(o);
    });
    if (current != null) sel.value = current;
  }

  function loadLibrary() {
    return Promise.all([
      Forge.api.listBits(), Forge.api.listMaterials(), Forge.api.listPresets()
    ]).then(function (res) {
      state.bits = res[0] || [];
      state.materials = res[1] || [];
      state.presets = res[2] || [];
      state.serverUp = true;
      $('#server-status').textContent = 'server ready';
      $('#server-status').className = 'pill pill-ok';

      populateSelect($('#bit-picker'), state.bits, 'id', 'name');
      populateSelect($('#material-picker'), state.materials, 'id', 'name');
      var pp = $('#preset-picker');
      pp.innerHTML = '<option value="">— choose —</option>';
      state.presets.forEach(function (p) {
        var o = el('option', null, p.name);
        o.value = p.id;
        pp.appendChild(o);
      });
    }).catch(function (e) {
      state.serverUp = false;
      $('#server-status').textContent = 'offline — presets disabled';
      $('#server-status').className = 'pill pill-warn';
      toast('Backend unavailable — gcode generation still works. ' + e.message, 'warn');
    });
  }

  function selectBit(id) {
    var lib = state.bits.filter(function (b) { return String(b.id) === String(id); })[0];
    state.bit = lib ? Object.assign({}, lib) : null;
    $('#bit-picker').value = id;
    syncForm(forms.bit, BIT_SCHEMA, function (k) {
      return state.bit ? state.bit[k] : '';
    });
  }

  function selectMaterial(id, applyRecommended) {
    var lib = state.materials.filter(function (m) {
      return String(m.id) === String(id);
    })[0];
    state.material = lib ? Object.assign({}, lib) : null;
    $('#material-picker').value = id;
    syncForm(forms.material, MATERIAL_SCHEMA, function (k) {
      return state.material ? state.material[k] : '';
    });
    $('#material-note').textContent = state.material && state.material.notes
      ? state.material.notes : '';
    if (applyRecommended && state.material) {
      var m = state.material, s = state.settings;
      // Auto-fill silently replacing settings is how a deliberate partial
      // depth becomes an accidental through-cut — say exactly what changed.
      var applied = [];
      function apply(key, val, label) {
        if (s[key] === val) return;
        s[key] = val;
        applied.push(label + ' ' + val);
      }
      if (m.recommended_feed_cut) apply('feedCut', m.recommended_feed_cut, 'cut feed');
      if (m.recommended_feed_plunge) apply('feedPlunge', m.recommended_feed_plunge, 'plunge feed');
      if (m.recommended_doc_mm) apply('docPerPass', m.recommended_doc_mm, 'DOC');
      if (m.recommended_rpm) apply('spindleRpm', m.recommended_rpm, 'RPM');
      if (m.thickness_mm > 0 && (s.operation === 'profile-out' || s.operation === 'drill')) {
        apply('finalDepth',
          -Math.round((m.thickness_mm + (m.through_cut_overage_mm || 0.65)) * 100) / 100,
          'final depth');
      }
      syncAllForms();
      if (applied.length) {
        toast('Applied ' + m.name + ' recommendations: ' + applied.join(', ') + '.');
      }
    }
  }

  function syncAllForms() {
    syncForm(forms.operation, SCHEMA.operation, getSetting);
    syncForm(forms.tabs, SCHEMA.tabs, getSetting);
    syncForm(forms.geometry, SCHEMA.geometry, getSetting);
    syncForm(forms.machine, SCHEMA.machine, getSetting);
    syncForm(forms.text, TEXT_SCHEMA, getSetting);
    refreshVisibility(forms.geometry, SCHEMA.geometry, state.settings);
    refreshVisibility(forms.text, TEXT_SCHEMA, state.settings);
    var ti = $('#text-input'); if (ti) ti.value = state.settings.textContent;
    var fs = $('#font-select'); if (fs) fs.value = state.settings.fontKey;
    syncBitmapControls();
    setOperationUI(state.settings.operation);
  }

  /* ---- operation picker ---------------------------------------------- */
  function setOperationUI(op) {
    state.settings.operation = op;
    Array.prototype.forEach.call($('#operation-picker').children, function (b) {
      var isActive = b.dataset.op === op;
      b.classList.toggle('active', isActive);
      b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
    $('#op-hint').textContent = OP_HINTS[op] || '';
  }

  /* ---- gcode generation ---------------------------------------------- */
  function buildGcode(airPass) {
    var s = state.settings;
    return Forge.gcode.emit(state.toolpath, s, {
      bit: state.bit, material: state.material, jobName: s.jobName || 'job',
      version: VERSION, timestamp: new Date().toISOString().slice(0, 19),
      stockWidth: state.job.stockWidth, stockHeight: state.job.stockHeight,
      envelopeOk: state.validation.envelopeOk,
      airPass: !!airPass, airPassOffset: 25
    });
  }

  function gcodeFilename(airPass) {
    var s = state.settings;
    var name = Forge.gcode.buildFilename(s.filenamePattern, {
      job: s.jobName || 'job',
      material: state.material ? state.material.name : 'material',
      bit: state.bit ? state.bit.name : 'bit',
      operation: s.operation,
      date: new Date().toISOString().slice(0, 10),
      version: VERSION
    });
    return airPass ? 'AIRPASS_' + name : name;
  }

  function openModal() {
    // Recompute synchronously first — recompute()/rebuildText() are
    // debounced, so a just-changed setting could otherwise pair fresh
    // settings with a stale toolpath in the generated file.
    if (state.settings.inputMode === 'text') rebuildTextNow();
    else recomputeNow();
    if (!state.toolpath || !state.validation) return;
    if (state.validation.hasError) {
      toast('Resolve the blocking errors in pre-flight checks first.', 'error');
      return;
    }
    $('#airpass-toggle').checked = false;
    refreshModal();
    $('#modal-title').textContent = 'Generated gcode — ' + gcodeFilename(false);
    $('#modal').classList.remove('hidden');
  }

  function refreshModal() {
    var air = $('#airpass-toggle').checked;
    lastGcode = buildGcode(air);
    $('#gcode-output').textContent = lastGcode;
    var lines = lastGcode.split('\n').length;
    var runtime = state.toolpath && state.toolpath.stats ? formatDuration(state.toolpath.stats.estSeconds) : null;
    $('#modal-sub').textContent = lines + ' lines · ' +
      (lastGcode.length / 1024).toFixed(1) + ' KB' +
      (runtime && runtime !== '—' ? ' · ~' + runtime : '') +
      (air ? ' · AIR PASS (no material cut)' : '');
  }

  function downloadText(text, filename, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = el('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ---- preset save / load -------------------------------------------- */
  function savePreset() {
    if (!state.serverUp) { toast('Backend offline — cannot save presets.', 'warn'); return; }
    var name = window.prompt('Preset name:', state.settings.jobName || 'My preset');
    if (!name) return;
    Forge.api.savePreset({
      name: name,
      operation: state.settings.operation,
      bit_id: state.bit ? state.bit.id : null,
      material_id: state.material ? state.material.id : null,
      settings: state.settings
    }).then(function () {
      toast('Preset "' + name + '" saved.');
      return loadLibrary();
    }).catch(function (e) { toast('Save failed: ' + e.message, 'error'); });
  }

  /**
   * Copy stored settings over the live ones, key-filtered against DEFAULTS.
   * Values are type-checked (a null or corrupt stored value must never
   * silently replace a live number) and object values — the graphics array —
   * are deep-copied so editing a shape can never mutate the stored source.
   */
  function applyStoredSettings(stored) {
    if (!stored) return;
    Object.keys(DEFAULTS).forEach(function (k) {
      var v = stored[k];
      if (v === undefined || v === null) return;
      if (typeof v !== typeof DEFAULTS[k]) return;
      if (typeof v === 'number' && !isFinite(v)) return;
      state.settings[k] = (typeof v === 'object')
        ? JSON.parse(JSON.stringify(v)) : v;
    });
  }

  function loadPreset() {
    var id = $('#preset-picker').value;
    if (!id) return;
    var p = state.presets.filter(function (x) { return String(x.id) === id; })[0];
    if (!p) return;
    applyStoredSettings(p.settings);
    state.settings.operation = p.operation || state.settings.operation;
    if (p.bit_id) selectBit(p.bit_id);
    if (p.material_id) selectMaterial(p.material_id, false);
    syncAllForms();
    renderGraphicsList();
    switchInputMode(state.settings.inputMode || 'text');
    toast('Preset "' + p.name + '" loaded.');
  }

  /* ---- bit / material CRUD ------------------------------------------- */
  function bitFromForm() {
    var b = {};
    BIT_SCHEMA.forEach(function (f) {
      var inp = forms.bit[f.key]._input;
      b[f.key] = f.type === 'number'
        ? (inp.value === '' ? null : parseFloat(inp.value)) : inp.value;
    });
    return b;
  }
  function materialFromForm() {
    var m = {};
    MATERIAL_SCHEMA.forEach(function (f) {
      var inp = forms.material[f.key]._input;
      m[f.key] = f.type === 'number'
        ? (inp.value === '' ? null : parseFloat(inp.value)) : inp.value;
    });
    return m;
  }

  function wireLibraryButtons() {
    $('#bit-update').addEventListener('click', function () {
      if (!state.bit || !state.bit.id) { toast('No library bit selected.', 'warn'); return; }
      Forge.api.updateBit(state.bit.id, bitFromForm()).then(function () {
        toast('Bit updated.'); return loadLibrary();
      }).then(function () { selectBit(state.bit.id); recomputeNow(); })
        .catch(function (e) { toast('Update failed: ' + e.message, 'error'); });
    });
    $('#bit-new').addEventListener('click', function () {
      var b = bitFromForm();
      Forge.api.createBit(b).then(function (created) {
        toast('Bit "' + created.name + '" created.');
        return loadLibrary().then(function () { selectBit(created.id); recomputeNow(); });
      }).catch(function (e) { toast('Create failed: ' + e.message, 'error'); });
    });
    $('#bit-delete').addEventListener('click', function () {
      if (!state.bit || !state.bit.id) return;
      if (!window.confirm('Delete bit "' + state.bit.name + '"?')) return;
      Forge.api.deleteBit(state.bit.id).then(function () {
        toast('Bit deleted.');
        return loadLibrary();
      }).then(function () {
        if (state.bits[0]) selectBit(state.bits[0].id);
        recomputeNow();
      }).catch(function (e) { toast('Delete failed: ' + e.message, 'error'); });
    });

    $('#material-update').addEventListener('click', function () {
      if (!state.material || !state.material.id) {
        toast('No library material selected.', 'warn'); return;
      }
      Forge.api.updateMaterial(state.material.id, materialFromForm()).then(function () {
        toast('Material updated.'); return loadLibrary();
      }).then(function () { selectMaterial(state.material.id, false); recomputeNow(); })
        .catch(function (e) { toast('Update failed: ' + e.message, 'error'); });
    });
    $('#material-new').addEventListener('click', function () {
      Forge.api.createMaterial(materialFromForm()).then(function (created) {
        toast('Material "' + created.name + '" created.');
        return loadLibrary().then(function () {
          selectMaterial(created.id, false); recomputeNow();
        });
      }).catch(function (e) { toast('Create failed: ' + e.message, 'error'); });
    });
    $('#material-delete').addEventListener('click', function () {
      if (!state.material || !state.material.id) return;
      if (!window.confirm('Delete material "' + state.material.name + '"?')) return;
      Forge.api.deleteMaterial(state.material.id).then(function () {
        toast('Material deleted.');
        return loadLibrary();
      }).then(function () {
        if (state.materials[0]) selectMaterial(state.materials[0].id, false);
        recomputeNow();
      }).catch(function (e) { toast('Delete failed: ' + e.message, 'error'); });
    });
  }

  /* ---- autosave ------------------------------------------------------- */
  function autosave() {
    Forge.store.save({
      settings: state.settings,
      bitId: state.bit ? state.bit.id : null,
      materialId: state.material ? state.material.id : null
    });
  }

  /* ---- wiring --------------------------------------------------------- */
  var TEXT_KEYS = { signWidth: 1, signHeight: 1, fitToSign: 1, letterHeight: 1,
    textAlign: 1, textAnchor: 1, textOffsetX: 1, textOffsetY: 1,
    lineSpacing: 1, letterSpacing: 1, frame: 1, frameInset: 1, frameStyle: 1, frameCornerRadius: 1,
    textPadding: 1, graphics: 1 };

  function onSettingChange(key, value, field) {
    state.settings[key] = value;
    // Always refresh dependent-field visibility — changing a field that
    // others depend on (e.g. frameStyle -> frameCornerRadius) must update
    // them right away, even when the changed field is itself a dependent.
    refreshVisibility(forms.geometry, SCHEMA.geometry, state.settings);
    refreshVisibility(forms.text, TEXT_SCHEMA, state.settings);
    if (key === 'tessellationTolerance') regenerate();
    else if (TEXT_KEYS[key]) {
      if (state.settings.inputMode === 'text') rebuildText();
      else recompute();
    } else recompute();
  }

  function onBitChange(key, value) {
    if (!state.bit) state.bit = {};
    state.bit[key] = value;
    recompute();
  }
  function onMaterialChange(key, value) {
    if (!state.material) state.material = {};
    state.material[key] = value;
    recompute();
  }


  function fallbackCopyText(text) {
    var ta = el('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'true');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      var ok = document.execCommand('copy');
      toast(ok ? 'gcode copied to clipboard.' : 'Copy failed. Select and copy manually.', ok ? undefined : 'warn');
    } catch (e) {
      toast('Copy failed. Select and copy manually.', 'warn');
    }
    document.body.removeChild(ta);
  }

  function wireUI() {
    /* settings forms */
    forms.operation = buildForm($('#form-operation'), SCHEMA.operation,
      getSetting, onSettingChange, DEFAULTS);
    forms.tabs = buildForm($('#form-tabs'), SCHEMA.tabs, getSetting, onSettingChange, DEFAULTS);
    forms.geometry = buildForm($('#form-geometry'), SCHEMA.geometry,
      getSetting, onSettingChange, DEFAULTS);
    forms.machine = buildForm($('#form-machine'), SCHEMA.machine,
      getSetting, onSettingChange, DEFAULTS);
    forms.bit = buildForm($('#form-bit'), BIT_SCHEMA,
      function () { return ''; }, onBitChange);
    forms.material = buildForm($('#form-material'), MATERIAL_SCHEMA,
      function () { return ''; }, onMaterialChange);
    forms.text = buildForm($('#form-text'), TEXT_SCHEMA, getSetting, onSettingChange, DEFAULTS);
    refreshVisibility(forms.geometry, SCHEMA.geometry, state.settings);
    refreshVisibility(forms.text, TEXT_SCHEMA, state.settings);
    populateFontSelect();
    renderGraphicsList();

    /* settings tab switching */
    $('#settings-tabs').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      Array.prototype.forEach.call($('#settings-tabs').children, function (x) {
        x.classList.toggle('active', x === b);
      });
      document.querySelectorAll('.tab-panel').forEach(function (p) {
        p.classList.toggle('active', p.dataset.panel === b.dataset.tab);
      });
    });

    /* operation picker */
    $('#operation-picker').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      setOperationUI(b.dataset.op);
      recompute();
    });

    /* input mode + text sign */
    $('#input-mode').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (b) switchInputMode(b.dataset.mode);
    });
    $('#text-input').addEventListener('input', function () {
      state.settings.textContent = this.value;
      rebuildText();
    });
    $('#font-select').addEventListener('change', function () {
      state.settings.fontKey = this.value;
      loadFontThen(rebuildTextNow);
    });
    $('#font-upload-btn').addEventListener('click', function () {
      $('#font-input').click();
    });
    $('#font-input').addEventListener('change', function () {
      onFontUpload(this.files[0]);
    });
    initShapeBuilder();
    $('#add-graphic-btn').addEventListener('click', function(){ addGraphicFromBuilder(''); });
    $('#add-border-btn').addEventListener('click', function(){
      addGraphicFromBuilder(state.settings.frameStyle === 'rounded' ? 'roundedBorderRect' : 'borderRect');
    });
    $('#fit-all-graphics-btn').addEventListener('click', function(){ autoFitAllGraphics(false); });
    $('#graphics-help').insertAdjacentHTML('afterend',
      '<div class="shape-layout-row">' +
      '<label class="field"><span>Quick layout preset</span><select id="shape-layout-preset">' +
      '<option value="">Choose a layout&hellip;</option>' +
      '<option value="text-top-shape-bottom">Text top, shape bottom</option>' +
      '<option value="shape-top-text-bottom">Shape top, text bottom</option>' +
      '<option value="text-left-shape-right">Text left, shape right</option>' +
      '<option value="shape-left-text-right">Shape left, text right</option>' +
      '<option value="centered-overlap">Centered overlap</option>' +
      '</select></label>' +
      '<button class="btn btn-ghost" id="layout-apply-btn" type="button" title="Apply selected layout preset">Apply layout</button>' +
      '</div>');
    $('#layout-apply-btn').addEventListener('click', function(){
      var preset = $('#shape-layout-preset').value;
      if (!preset) { toast('Choose a layout preset first.', 'warn'); return; }
      applyTextShapeLayout(preset);
    });
    $('#clear-graphics-btn').addEventListener('click', function () {
      if (!state.settings.graphics.length) return;
      state.settings.graphics = [];
      renderGraphicsList();
      rebuildTextNow();
    });

    /* SVG upload */
    var dz = $('#dropzone'), input = $('#svg-input');
    dz.addEventListener('click', function () { input.click(); });
    dz.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        input.click();
      }
    });
    input.addEventListener('change', function () { readFile(input.files[0]); });
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) {
        e.preventDefault(); dz.classList.add('drag');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) {
        e.preventDefault(); dz.classList.remove('drag');
      });
    });
    dz.addEventListener('drop', function (e) {
      if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
    });

    var bdz = $('#bitmap-dropzone'), binput = $('#bitmap-input');
    bdz.addEventListener('click', function () { binput.click(); });
    bdz.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); binput.click(); } });
    binput.addEventListener('change', function () { readBitmapFile(binput.files[0]); });
    ['dragenter', 'dragover'].forEach(function (ev) { bdz.addEventListener(ev, function (e) { e.preventDefault(); bdz.classList.add('drag'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { bdz.addEventListener(ev, function (e) { e.preventDefault(); bdz.classList.remove('drag'); }); });
    bdz.addEventListener('drop', function (e) { if (e.dataTransfer.files[0]) readBitmapFile(e.dataTransfer.files[0]); });
    $('#bitmap-preset').addEventListener('change', function(){ applyBitmapPreset(this.value); autosave(); if (state.settings.inputMode === 'bitmap') traceBitmapNow(); });
    var BITMAP_INPUT_KEYS = {
      'bitmap-threshold': 'bitmapThreshold', 'bitmap-mm-per-px': 'bitmapMmPerPx',
      'bitmap-min-area': 'bitmapMinArea', 'bitmap-simplify': 'bitmapSimplify'
    };
    Object.keys(BITMAP_INPUT_KEYS).forEach(function(id){
      var n = $("#" + id);
      if (n) n.addEventListener('input', debounce(function(){
        var v = parseFloat(n.value);
        if (isFinite(v)) { state.settings[BITMAP_INPUT_KEYS[id]] = v; autosave(); }
        if (state.settings.inputMode === 'bitmap') traceBitmapNow();
      }, 120));
    });
    $('#bitmap-trace-cancel').addEventListener('click', cancelBitmapTrace);

    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    /* sample files */
    document.querySelectorAll('[data-sample]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.dataset.sample;
        fetch('samples/' + name).then(function (r) {
          if (!r.ok) throw new Error('sample not found');
          return r.text();
        }).then(function (t) { loadSvg(t, name); })
          .catch(function (e) { toast('Could not load sample: ' + e.message, 'error'); });
      });
    });

    /* pickers */
    $('#bit-picker').addEventListener('change', function () {
      selectBit(this.value); recompute();
    });
    $('#material-picker').addEventListener('change', function () {
      selectMaterial(this.value, true); recompute();
    });
    $('#load-preset-btn').addEventListener('click', loadPreset);
    $('#delete-preset-btn').addEventListener('click', function () {
      var id = $('#preset-picker').value;
      if (!id || !state.serverUp) return;
      if (!window.confirm('Delete this preset?')) return;
      Forge.api.deletePreset(id).then(function () {
        toast('Preset deleted.'); return loadLibrary();
      }).catch(function (e) { toast('Delete failed: ' + e.message, 'error'); });
    });

    /* preview toolbar */
    $('#zoom-in').addEventListener('click', function () { preview.zoom(1.25); });
    $('#zoom-out').addEventListener('click', function () { preview.zoom(0.8); });
    $('#zoom-fit').addEventListener('click', function () { preview.fit(); });
    $('#zoom-bed').addEventListener('click', function () { preview.fitMachine(); });
    $('#t-rapids').addEventListener('change', function () {
      preview.options.showRapids = this.checked; preview.render();
    });
    $('#t-tabs').addEventListener('change', function () {
      preview.options.showTabs = this.checked; preview.render();
    });
    $('#t-geom').addEventListener('change', function () {
      preview.options.showGeometry = this.checked; preview.render();
    });

    /* generate + preset save */
    $('#generate-btn').addEventListener('click', openModal);
    $('#save-preset-btn').addEventListener('click', savePreset);

    /* modal */
    $('#modal-close').addEventListener('click', function () {
      $('#modal').classList.add('hidden');
    });
    $('#modal').addEventListener('click', function (e) {
      if (e.target === this) this.classList.add('hidden');
    });
    $('#airpass-toggle').addEventListener('change', refreshModal);
    $('#download-gcode').addEventListener('click', function () {
      var air = $('#airpass-toggle').checked;
      downloadText(lastGcode, gcodeFilename(air));
      toast('Downloaded ' + gcodeFilename(air));
    });
    $('#copy-gcode').addEventListener('click', function () {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(lastGcode).then(function () {
          toast('gcode copied to clipboard.');
        }).catch(function () {
          fallbackCopyText(lastGcode);
        });
        return;
      }
      fallbackCopyText(lastGcode);
    });
    $('#save-server').addEventListener('click', function () {
      if (!state.serverUp) { toast('Backend offline.', 'warn'); return; }
      var air = $('#airpass-toggle').checked;
      Forge.api.saveJob({
        filename: gcodeFilename(air), gcode: lastGcode,
        svg_hash: state.svgHash, settings: state.settings
      }).then(function (r) {
        toast('Saved to server (job #' + r.id + ').');
      }).catch(function (e) { toast('Save failed: ' + e.message, 'error'); });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') $('#modal').classList.add('hidden');
    });

    /* legend */
    var legend = $('#legend');
    [['engrave', 'Engrave'], ['pocket', 'Pocket'], ['vcarve', 'V-carve'],
     ['profile-out', 'Profile out'], ['profile-in', 'Profile in'],
     ['drill', 'Drill']].forEach(function (p) {
      var chip = el('span', 'legend-chip');
      var dot = el('span', 'legend-dot');
      dot.style.background = Forge.toolpath.OP_COLORS[p[0]];
      chip.appendChild(dot);
      chip.appendChild(el('span', null, p[1]));
      legend.appendChild(chip);
    });
  }

  /* ---- boot ----------------------------------------------------------- */
  function init() {
    $('#version-pill').textContent = 'v' + VERSION;
    preview = Forge.createPreview($('#preview'));
    wireUI();
    wireLibraryButtons();
    setOperationUI(state.settings.operation);
    preview.draw({ machineX: state.settings.machineX, machineY: state.settings.machineY });
    preview.fit();

    loadLibrary().then(function () {
      var saved = Forge.store.load();
      if (saved && saved.settings) {
        applyStoredSettings(saved.settings);
        renderGraphicsList();
      }
      if (state.bits.length) {
        var bId = saved && saved.bitId &&
          state.bits.some(function (b) { return b.id === saved.bitId; })
          ? saved.bitId : state.bits[0].id;
        selectBit(bId);
      }
      if (state.materials.length) {
        var mId = saved && saved.materialId &&
          state.materials.some(function (m) { return m.id === saved.materialId; })
          ? saved.materialId : state.materials[0].id;
        selectMaterial(mId, !saved);
      }
      if (!Forge.textGeometry.FONTS.some(function (f) {
        return f.key === state.settings.fontKey;
      })) {
        state.settings.fontKey = DEFAULTS.fontKey;
      }
      syncAllForms();
      switchInputMode(state.settings.inputMode || 'text');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window.Forge = window.Forge || {});
