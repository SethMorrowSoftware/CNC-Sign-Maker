/**
 * LowRider Forge — application controller.
 *
 * Owns the working state, builds the settings forms from a schema, runs the
 * parse -> toolpath -> validate -> preview pipeline and wires every control.
 */
(function (Forge) {
  'use strict';

  var VERSION = '1.0.0';

  /* ---- defaults ------------------------------------------------------- */
  var DEFAULTS = {
    operation: 'engrave',
    finalDepth: -3, docPerPass: 1.5, feedCut: 1500, feedPlunge: 500,
    finishingAllowance: 0.15, toolOffsetOverride: 0,
    plungeStyle: 'straight', peckRetract: 2,
    tabsEnabled: true, tabCount: 4, tabThickness: 1.5, tabWidth: 6, tabPlacement: 'even',
    scale: 100, rotation: 0, originPosition: 'bottom-left',
    customOriginX: 0, customOriginY: 0,
    stockMargin: 10, holeThreshold: 50, targetHoleDiameter: 0,
    tessellationTolerance: 0.1,
    machineX: 1270, machineY: 2540, safeZ: 10, preStockZ: 2,
    rapidFeed: 5000, useM0: false, spindleRpm: 18000,
    filenamePattern: '{job}_{material}_{bit}_{date}.gcode',
    headerTemplate: '', jobName: 'job',
    inputMode: 'text',
    textContent: 'SIGN', fontKey: 'montserrat',
    signWidth: 300, signHeight: 150,
    fitToSign: true, letterHeight: 60,
    textAlign: 'center', lineSpacing: 1.1, letterSpacing: 0,
    frame: false, frameInset: 8, textPadding: 12
  };

  var OP_HINTS = {
    engrave: 'Traces the path centerline at a single depth. No tool compensation. ' +
      'For text this gives outline lettering.',
    pocket: 'Clears the inside of every closed shape — solid, filled lettering. ' +
      'Counters (the holes in O, A, e) are kept.',
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
        unit: 'mm', hint: 'Added to the tool offset for a clean edge.' },
      { key: 'toolOffsetOverride', label: 'Tool offset override', type: 'number', step: 0.1,
        min: 0, unit: 'mm', hint: '0 = auto (tool radius + finishing allowance).' },
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
        hint: 'Distance from work zero to the nearest geometry.' },
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
    { key: 'lineSpacing', label: 'Line spacing', type: 'number', step: 0.05, min: 0.5,
      unit: '×', hint: 'Gap between lines, as a multiple.' },
    { key: 'letterSpacing', label: 'Letter spacing', type: 'number', step: 1, unit: '%',
      hint: 'Extra space between letters.' },
    { key: 'frame', label: 'Cut a frame border', type: 'checkbox' },
    { key: 'frameInset', label: 'Frame inset', type: 'number', step: 1, min: 0, unit: 'mm',
      hint: 'Distance of the frame from the sign edge.',
      dependsOn: { key: 'frame', value: true } },
    { key: 'textPadding', label: 'Text padding', type: 'number', step: 1, min: 0, unit: 'mm',
      hint: 'Gap between the text and the sign or frame edge.' }
  ];

  /* ---- state ---------------------------------------------------------- */
  var state = {
    settings: Object.assign({}, DEFAULTS),
    geometry: null, job: null, toolpath: null, validation: null,
    svgText: null, svgName: null, svgHash: null,
    bits: [], materials: [], presets: [],
    bit: null, material: null, font: null,
    serverUp: false
  };
  var preview = null;
  var lastGcode = '';

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
  function buildField(field, value, onChange) {
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
        return input.value === '' ? null : parseFloat(input.value);
      }
      if (field.type === 'select' && field.numeric) return parseFloat(input.value);
      return input.value;
    }
    var evt = (field.type === 'select' || field.type === 'checkbox') ? 'change' : 'input';
    input.addEventListener(evt, function () { onChange(field.key, read(), field); });

    row._input = input;
    return row;
  }

  function buildForm(container, schema, getValue, onChange) {
    container.innerHTML = '';
    var map = {};
    schema.forEach(function (field) {
      var row = buildField(field, getValue(field.key), onChange);
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
      state.toolpath = Forge.toolpath.build(state.job, s, state.bit);
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
      machineX: s.machineX, machineY: s.machineY
    });
    renderValidation();
    renderLiveValues();
    $('#generate-btn').disabled = !state.toolpath.ops.length || state.validation.hasError;
    autosave();
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
        lineSpacing: state.settings.lineSpacing,
        letterSpacingPct: state.settings.letterSpacing,
        border: state.settings.frame,
        borderInsetMm: state.settings.frameInset,
        paddingMm: state.settings.textPadding,
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
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    $('#text-panel').classList.toggle('hidden', mode !== 'text');
    $('#svg-panel').classList.toggle('hidden', mode === 'text');
    if (mode === 'text') {
      if (state.font) { rebuildTextNow(); preview.fit(); }
      else loadFontThen(function () { rebuildTextNow(); preview.fit(); });
    } else {
      reparseAndRecompute();
      if (state.geometry) preview.fit();
    }
  }

  function onFontUpload(file) {
    if (!file) return;
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
        toast('Could not read that font file: ' + e.message, 'error');
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
                        : 'Upload an SVG to begin.'));
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
  function renderLiveValues() {
    var stock = '—', runtime = '—', passes = '—', chip = '—';
    if (state.job) {
      stock = round1(state.job.stockWidth) + ' × ' +
        round1(state.job.stockHeight) + ' mm';
    }
    if (state.toolpath) {
      var sec = state.toolpath.stats.estSeconds;
      runtime = sec >= 60
        ? Math.floor(sec / 60) + 'm ' + Math.round(sec % 60) + 's'
        : Math.round(sec) + 's';
      passes = String(state.toolpath.stats.zPasses);
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
      toast('Could not parse SVG: ' + e.message, 'error');
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
      if (m.recommended_feed_cut) s.feedCut = m.recommended_feed_cut;
      if (m.recommended_feed_plunge) s.feedPlunge = m.recommended_feed_plunge;
      if (m.recommended_doc_mm) s.docPerPass = m.recommended_doc_mm;
      if (m.recommended_rpm) s.spindleRpm = m.recommended_rpm;
      if (m.thickness_mm > 0 && (s.operation === 'profile-out' || s.operation === 'drill')) {
        s.finalDepth = -(m.thickness_mm + (m.through_cut_overage_mm || 0.65));
      }
      syncAllForms();
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
    setOperationUI(state.settings.operation);
  }

  /* ---- operation picker ---------------------------------------------- */
  function setOperationUI(op) {
    state.settings.operation = op;
    Array.prototype.forEach.call($('#operation-picker').children, function (b) {
      b.classList.toggle('active', b.dataset.op === op);
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
    $('#modal-sub').textContent = lines + ' lines · ' +
      (lastGcode.length / 1024).toFixed(1) + ' KB' +
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

  function loadPreset() {
    var id = $('#preset-picker').value;
    if (!id) return;
    var p = state.presets.filter(function (x) { return String(x.id) === id; })[0];
    if (!p) return;
    if (p.settings) {
      Object.keys(DEFAULTS).forEach(function (k) {
        if (p.settings[k] !== undefined) state.settings[k] = p.settings[k];
      });
    }
    state.settings.operation = p.operation || state.settings.operation;
    if (p.bit_id) selectBit(p.bit_id);
    if (p.material_id) selectMaterial(p.material_id, false);
    syncAllForms();
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
    textAlign: 1, lineSpacing: 1, letterSpacing: 1, frame: 1, frameInset: 1,
    textPadding: 1 };

  function onSettingChange(key, value, field) {
    state.settings[key] = value;
    if (field && field.dependsOn === undefined) {
      refreshVisibility(forms.geometry, SCHEMA.geometry, state.settings);
      refreshVisibility(forms.text, TEXT_SCHEMA, state.settings);
    }
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

  function wireUI() {
    /* settings forms */
    forms.operation = buildForm($('#form-operation'), SCHEMA.operation,
      getSetting, onSettingChange);
    forms.tabs = buildForm($('#form-tabs'), SCHEMA.tabs, getSetting, onSettingChange);
    forms.geometry = buildForm($('#form-geometry'), SCHEMA.geometry,
      getSetting, onSettingChange);
    forms.machine = buildForm($('#form-machine'), SCHEMA.machine,
      getSetting, onSettingChange);
    forms.bit = buildForm($('#form-bit'), BIT_SCHEMA,
      function () { return ''; }, onBitChange);
    forms.material = buildForm($('#form-material'), MATERIAL_SCHEMA,
      function () { return ''; }, onMaterialChange);
    forms.text = buildForm($('#form-text'), TEXT_SCHEMA, getSetting, onSettingChange);
    refreshVisibility(forms.geometry, SCHEMA.geometry, state.settings);
    refreshVisibility(forms.text, TEXT_SCHEMA, state.settings);
    populateFontSelect();

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
      if (navigator.clipboard) {
        navigator.clipboard.writeText(lastGcode).then(function () {
          toast('gcode copied to clipboard.');
        });
      }
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
    [['engrave', 'Engrave'], ['pocket', 'Pocket'], ['profile-out', 'Profile out'],
     ['profile-in', 'Profile in'], ['drill', 'Drill']].forEach(function (p) {
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
        Object.keys(DEFAULTS).forEach(function (k) {
          if (saved.settings[k] !== undefined) state.settings[k] = saved.settings[k];
        });
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
