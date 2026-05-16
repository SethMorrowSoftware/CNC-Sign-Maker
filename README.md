# LowRider Forge

A self-hosted web tool that converts SVG files into FluidNC-compatible gcode
for the **LowRider v4** CNC. Built for engraving and cutting signs, fixtures
and parts with predictable, repeatable output.

All geometry and gcode generation runs **client-side** in the browser — the
PHP backend only stores bits, materials, presets and (optionally) finished
gcode. The tool keeps working with no network once the page has loaded.

---

## Requirements

- PHP **8.1+** with the `pdo_sqlite` extension (bundled with most PHP builds).
- A modern browser (Chrome, Firefox, Edge, Safari — ES2020+).
- No build step, no package manager, no framework.

## Install

```bash
git clone <this-repo> lowrider-forge
cd lowrider-forge
./install.sh          # creates data/, seeds the SQLite database
php -S localhost:8000  # serve from the project root
```

Then open <http://localhost:8000>.

`install.sh` is optional — the database is created and seeded automatically on
the first API request. For a shared LAMP host, point the document root at the
project folder and make sure `data/` is writable by the web server.

## Project layout

```
index.html              Single-page app
css/styles.css           Theme
js/
  app.js                 State, form generation, event wiring
  svg-parser.js           SVG -> millimetre geometry (transforms, units, curves)
  geometry.js             Polygon offsetting (Clipper) + geometry helpers
  toolpath.js             Operation toolpaths (engrave/profile/drill)
  gcode-emitter.js        Toolpath -> FluidNC gcode
  preview.js              Canvas rendering, pan/zoom, hover
  validation.js           Pre-flight safety checks
  presets.js              API client + LocalStorage autosave
  lib/clipper.js          Vendored Clipper 6.4.2 (Boost license)
api/
  index.php               Router
  db.php                  SQLite schema, seed data, helpers
  bits.php / materials.php / presets.php / jobs.php
data/                     SQLite database + saved jobs (created at runtime)
samples/                  Test SVGs (square, circle, holes plate, text)
```

## Workflow

1. **Upload an SVG** (drag-and-drop, browse, or load a sample).
2. **Pick the operation** — engrave, profile-out, profile-in or drill.
3. **Choose material and bit.** Selecting a material auto-fills the
   recommended feeds, DOC and depth.
4. **Tune settings** in the right-hand tabs (Operation, Tabs, Geometry,
   Machine, Bit, Material).
5. **Watch the preview** — machine envelope, stock, toolpath, tabs and the
   work origin update live.
6. **Clear the pre-flight checks.** Errors block gcode generation.
7. **Generate gcode**, review it, then download — or download an *air pass*
   (all Z raised 25 mm) to dry-run the toolpath first.

The work origin is always the **front-left corner of the stock**, with
**Z = 0 on top of the material**. The gcode header restates this on every file.

## Operations

| Operation    | What it does |
|--------------|--------------|
| Engrave      | Traces the path centerline at one depth. No tool compensation. |
| Profile out  | Cuts outside a closed path (tool radius + finishing). Multi-depth, tabs on the final pass. |
| Profile in   | Cuts inside a closed path — pockets and openings. Multi-depth. |
| Drill        | Plunge or helical-bore each closed feature. Holes smaller than the bit are plunge-drilled oversized. |

Small closed features (below the *hole-vs-trace threshold*) are always given a
drill cycle and emitted **first**, while the bit is freshest; outer profiles
are emitted **last** because once cut, the part can move.

## Codified gotchas

The validator encodes the hard-won lessons from spec section 14:

- **M0 pauses are off by default** — they silently halt the program. Turning
  them on raises an info banner.
- **Tabs below 1 mm are blocked**; above 2 mm raises a flush-trim warning.
- **HDPE + multi-flute bit is a blocking error** — multi-flute bits melt HDPE.
- **Bit cutting length is checked** against final depth (`|depth| + 2 mm`).
- **Chip load** is checked against the 0.05–0.30 mm window.
- **Through-cut depth** is sanity-checked against material thickness and the
  spoilboard overage.
- **Parametric parts** trigger an info banner suggesting you regenerate the
  SVG at the correct size rather than scaling it.
- Nominal **plywood thickness** is flagged — measure your actual stock.

## Troubleshooting

- **Axes move the wrong direction.** This is a FluidNC config issue, out of
  scope for this tool. Add the `:low` modifier to the motor `direction_pin` in
  your controller YAML — and remember `:low` *must be single-quoted in YAML*.
- **Job size looks wrong after upload.** If the SVG had no explicit units the
  size is assumed at 96 dpi; correct it with the *Scale* setting.
- **"Backend unavailable".** gcode generation still works fully — only preset
  saving/loading needs the PHP server. Check that `data/` is writable.
- **An inside cut is skipped.** The contour was too small to offset inward
  with the chosen bit. Use a smaller bit or a different operation.

## API

All endpoints are under `api/index.php` and return JSON.

```
GET/POST/PUT/DELETE  /bits          /bits/:id
GET/POST/PUT/DELETE  /materials     /materials/:id
GET/POST/DELETE      /presets       /presets/:id
POST                 /jobs/save     persist generated gcode
GET                  /jobs          /jobs/:id  (download)
GET                  /health
```

## Known limitations (v1)

- Polygon offsetting handles the common cases well; pathological
  self-intersecting input may need manual review (flagged by the validator).
- Manual tab placement (drag-on-canvas) is not yet implemented — tabs are
  evenly spaced.
- `<text>` elements are not rasterised; convert text to paths before export.
- Arc *fitting* is not done — curves are emitted as tessellated polylines
  except for the drill-circle cycle, which uses true `G2`.

See `spec.md` for the full design specification.
