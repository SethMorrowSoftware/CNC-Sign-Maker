/**
 * LowRider Forge — text sign geometry.
 *
 * Turns typed text + a font into millimetre geometry by laying out glyph
 * outlines (via the vendored opentype.js) and emitting an SVG string that the
 * existing parseSvg -> toolpath -> gcode pipeline consumes unchanged. The
 * sign generator is therefore just another geometry source, like file upload.
 */
(function (Forge) {
  'use strict';

  function ot() {
    var O = (typeof window !== 'undefined' && window.opentype) ||
            (typeof opentype !== 'undefined' && opentype) || null;
    if (!O) throw new Error('Font engine failed to load (js/lib/opentype.js).');
    return O;
  }

  // Reference em size for layout. The real sign size is applied by the SVG
  // group transform, so all layout maths happens in these stable units.
  var REF = 1000;

  /* ---- bundled font catalogue ---------------------------------------- */
  var FONTS = [
    { key: 'montserrat',    name: 'Montserrat — sans',     file: 'fonts/montserrat.woff' },
    { key: 'oswald',        name: 'Oswald — condensed',    file: 'fonts/oswald.woff' },
    { key: 'archivo-black', name: 'Archivo Black — heavy', file: 'fonts/archivo-black.woff' },
    { key: 'roboto-slab',   name: 'Roboto Slab — slab',    file: 'fonts/roboto-slab.woff' },
    { key: 'merriweather',  name: 'Merriweather — serif',  file: 'fonts/merriweather.woff' },
    { key: 'pacifico',      name: 'Pacifico — script',     file: 'fonts/pacifico.woff' },

    { key: 'anton',         name: 'Anton — bold sans', file: 'https://raw.githubusercontent.com/google/fonts/main/ofl/anton/Anton-Regular.ttf' },
    { key: 'bangers',       name: 'Bangers — comic display', file: 'https://raw.githubusercontent.com/google/fonts/main/ofl/bangers/Bangers-Regular.ttf' },
    { key: 'bebas-neue',    name: 'Bebas Neue — tall display', file: 'https://raw.githubusercontent.com/google/fonts/main/ofl/bebasneue/BebasNeue-Regular.ttf' },
    { key: 'caveat',        name: 'Caveat — handwritten', file: 'https://raw.githubusercontent.com/google/fonts/main/ofl/caveat/Caveat-Regular.ttf' },
    { key: 'comfortaa',     name: 'Comfortaa — rounded sans', file: 'https://raw.githubusercontent.com/google/fonts/main/ofl/comfortaa/Comfortaa-Regular.ttf' },
    { key: 'dm-serif-display', name: 'DM Serif Display — classic serif', file: 'https://raw.githubusercontent.com/google/fonts/main/ofl/dmserifdisplay/DMSerifDisplay-Regular.ttf' },
    { key: 'fira-sans',     name: 'Fira Sans — humanist sans', file: 'https://raw.githubusercontent.com/google/fonts/main/ofl/firasans/FiraSans-Regular.ttf' },
    { key: 'great-vibes',   name: 'Great Vibes — formal script', file: 'https://raw.githubusercontent.com/google/fonts/main/ofl/greatvibes/GreatVibes-Regular.ttf' },
    { key: 'josefin-sans',  name: 'Josefin Sans — vintage sans', file: 'https://raw.githubusercontent.com/google/fonts/main/ofl/josefinsans/JosefinSans-Regular.ttf' },
    { key: 'lobster',       name: 'Lobster — script', file: 'https://raw.githubusercontent.com/google/fonts/main/ofl/lobster/Lobster-Regular.ttf' },
    { key: 'nunito',        name: 'Nunito — rounded sans', file: 'https://raw.githubusercontent.com/google/fonts/main/ofl/nunito/Nunito-Regular.ttf' },
    { key: 'orbitron',      name: 'Orbitron — techno sans', file: 'https://raw.githubusercontent.com/google/fonts/main/ofl/orbitron/Orbitron-Regular.ttf' },
    { key: 'playfair-display', name: 'Playfair Display — elegant serif', file: 'https://raw.githubusercontent.com/google/fonts/main/ofl/playfairdisplay/PlayfairDisplay-Regular.ttf' },
    { key: 'pt-serif',      name: 'PT Serif — book serif', file: 'https://raw.githubusercontent.com/google/fonts/main/ofl/ptserif/PTSerif-Regular.ttf' },
    { key: 'quicksand',     name: 'Quicksand — soft sans', file: 'https://raw.githubusercontent.com/google/fonts/main/ofl/quicksand/Quicksand-Regular.ttf' },
    { key: 'raleway',       name: 'Raleway — geometric sans', file: 'https://raw.githubusercontent.com/google/fonts/main/ofl/raleway/Raleway-Regular.ttf' },
    { key: 'rubik',         name: 'Rubik — modern sans', file: 'https://raw.githubusercontent.com/google/fonts/main/ofl/rubik/Rubik-Regular.ttf' },
    { key: 'teko',          name: 'Teko — industrial condensed', file: 'https://raw.githubusercontent.com/google/fonts/main/ofl/teko/Teko-Regular.ttf' },
    { key: 'amatic-sc',     name: 'Amatic SC — hand-lettered', file: 'https://raw.githubusercontent.com/google/fonts/main/ofl/amaticsc/AmaticSC-Regular.ttf' },
    { key: 'alegreya',      name: 'Alegreya — literary serif', file: 'https://raw.githubusercontent.com/google/fonts/main/ofl/alegreya/Alegreya-Regular.ttf' },
    { key: 'barlow-condensed', name: 'Barlow Condensed — narrow sans', file: 'https://raw.githubusercontent.com/google/fonts/main/ofl/barlowcondensed/BarlowCondensed-Regular.ttf' },
    { key: 'cinzel',        name: 'Cinzel — roman capitals', file: 'https://raw.githubusercontent.com/google/fonts/main/ofl/cinzel/Cinzel-Regular.ttf' },
    { key: 'fredoka',       name: 'Fredoka — playful sans', file: 'https://raw.githubusercontent.com/google/fonts/main/ofl/fredoka/Fredoka-Regular.ttf' },
    { key: 'abril-fatface', name: 'Abril Fatface — display serif', file: 'https://raw.githubusercontent.com/google/fonts/main/ofl/abrilfatface/AbrilFatface-Regular.ttf' }
  ];

  var cache = {};      // key -> parsed Font

  /** Load (and cache) a font by catalogue key or uploaded key. Promise<Font>. */
  function loadFont(key) {
    if (cache[key]) return Promise.resolve(cache[key]);
    var entry = FONTS.filter(function (f) { return f.key === key; })[0];
    if (!entry) return Promise.reject(new Error('Unknown font: ' + key));
    return fetch(entry.file).then(function (r) {
      if (!r.ok) throw new Error('could not load ' + entry.file);
      return r.arrayBuffer();
    }).then(function (buf) {
      var font = ot().parse(buf);
      cache[key] = font;
      return font;
    });
  }

  /** Register an uploaded font file. Returns { key, name }. */
  function addUploadedFont(name, arrayBuffer) {
    var font = ot().parse(arrayBuffer);
    var key = 'upload:' + name + ':' + Date.now();
    cache[key] = font;
    FONTS.push({ key: key, name: name + ' (uploaded)', file: null, uploaded: true });
    return { key: key, name: name + ' (uploaded)' };
  }

  /** Cap height (height of an uppercase letter) in REF units. */
  function capHeight(font) {
    var os2 = font.tables && font.tables.os2;
    if (os2 && os2.sCapHeight > 0) {
      return os2.sCapHeight / font.unitsPerEm * REF;
    }
    var g = font.charToGlyph('H');
    if (g && g.getMetrics) {
      var m = g.getMetrics();
      if (m && m.yMax > m.yMin) return (m.yMax - m.yMin) / font.unitsPerEm * REF;
    }
    return font.ascender / font.unitsPerEm * REF * 0.72;
  }

  function round(v) { return Math.round(v * 1000) / 1000; }

  /* ---- build --------------------------------------------------------- */

  /**
   * Build sign geometry from text.
   * @param {object} opts
   *   text, font (parsed Font),
   *   signWidthMm, signHeightMm,
   *   letterHeightMm, fitToSign,
   *   align ('left'|'center'|'right'), lineSpacing, letterSpacingPct,
   *   border, borderInsetMm, paddingMm, tessellationTolerance
   * @returns {object} geometry (parseSvg output) with sign metadata attached
   */
  function build(opts) {
    var font = opts.font;
    if (!font) throw new Error('No font loaded yet — pick a font.');
    var O = ot();
    var emPerUnit = REF / font.unitsPerEm;
    var cap = capHeight(font);

    var lines = String(opts.text == null ? '' : opts.text).replace(/\r/g, '').split('\n');
    var letterSpace = (opts.letterSpacingPct || 0) / 100 * REF;
    var lineSpacing = opts.lineSpacing > 0 ? opts.lineSpacing : 1;
    var lineAdvance = (font.ascender - font.descender) / font.unitsPerEm * REF * lineSpacing;

    // --- lay out every line, collect glyph placements ---
    var placed = [], lineWidths = [];
    for (var li = 0; li < lines.length; li++) {
      var penX = 0, chars = Array.from(lines[li]);
      for (var ci = 0; ci < chars.length; ci++) {
        var g = font.charToGlyph(chars[ci]);
        placed.push({ glyph: g, x: penX, line: li });
        penX += (g && g.advanceWidth ? g.advanceWidth : 0) * emPerUnit + letterSpace;
      }
      lineWidths.push(penX > 0 ? penX - letterSpace : 0);
    }
    var blockWidth = Math.max.apply(null, lineWidths.concat([0]));
    var alignF = opts.align === 'center' ? 0.5 : opts.align === 'right' ? 1 : 0;

    // --- combine every glyph outline into one path ---
    var combined = new O.Path();
    for (var p = 0; p < placed.length; p++) {
      var it = placed[p];
      if (!it.glyph) continue;
      var lineX = (blockWidth - lineWidths[it.line]) * alignF;
      var baseY = cap + it.line * lineAdvance;
      combined.extend(it.glyph.getPath(lineX + it.x, baseY, REF));
    }
    var hasText = combined.commands.length > 0;

    // --- sign frame + placement ---
    var signW = opts.signWidthMm > 0 ? opts.signWidthMm : 200;
    var signH = opts.signHeightMm > 0 ? opts.signHeightMm : 100;
    var border = !!opts.border;
    var inset = border ? Math.max(0, opts.borderInsetMm || 0) : 0;
    var pad = Math.max(0, opts.paddingMm || 0);
    var ix = inset + pad, iy = inset + pad;
    var iW = Math.max(1, signW - 2 * ix), iH = Math.max(1, signH - 2 * iy);

    var parts = [];
    if (border) {
      parts.push('<rect x="' + round(inset) + '" y="' + round(inset) +
        '" width="' + round(signW - 2 * inset) + '" height="' +
        round(signH - 2 * inset) + '" fill="none"/>');
    }
    if (hasText) {
      var box = combined.getBoundingBox();
      var tw = Math.max(1e-6, box.x2 - box.x1), th = Math.max(1e-6, box.y2 - box.y1);
      var s;
      if (opts.fitToSign) {
        s = Math.min(iW / tw, iH / th);
      } else {
        s = (opts.letterHeightMm > 0 ? opts.letterHeightMm : 25) / Math.max(1e-6, cap);
        // never let an explicit height overflow the sign interior
        s = Math.min(s, iW / tw, iH / th);
      }
      // centre the scaled text block inside the interior
      var tx = ix + (iW - tw * s) / 2 - box.x1 * s;
      var ty = iy + (iH - th * s) / 2 - box.y1 * s;
      // opentype emits glyph contours without an explicit close command — add
      // a Z to each so every subpath reads as a closed polygon downstream.
      var d = combined.toPathData(3).split('M')
        .filter(function (seg) { return seg.length; })
        .map(function (seg) { return 'M' + seg + 'Z'; }).join('');
      parts.push('<g transform="translate(' + round(tx) + ',' + round(ty) +
        ') scale(' + round(s) + ')"><path d="' + d + '"/></g>');
    }
    if (!parts.length) {
      throw new Error('Enter sign text, or enable the frame, to generate geometry.');
    }

    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + round(signW) +
      'mm" height="' + round(signH) + 'mm" viewBox="0 0 ' + round(signW) + ' ' +
      round(signH) + '">' + parts.join('') + '</svg>';

    var geometry = Forge.parseSvg(svg, {
      tessellationTolerance: opts.tessellationTolerance
    });
    geometry.signWidthMm = signW;
    geometry.signHeightMm = signH;
    geometry.isText = true;
    return geometry;
  }

  Forge.textGeometry = {
    FONTS: FONTS,
    loadFont: loadFont,
    addUploadedFont: addUploadedFont,
    build: build
  };
})(typeof window !== 'undefined' ? (window.Forge = window.Forge || {})
                                 : (global.Forge = global.Forge || {}));
