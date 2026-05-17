# LowRider Forge

A self-hosted web tool that turns **typed text or SVG files** into
FluidNC-compatible gcode for the **LowRider v4** CNC. Built for engraving and
cutting signs, fixtures and parts with predictable, repeatable output.

Make a sign straight from the built-in **text sign generator** — pick a font,
set the sign size, type the text — or upload an SVG of your own artwork.

All geometry and gcode generation runs **client-side** in the browser — the
PHP backend only stores bits, materials, presets and (optionally) finished
gcode. The tool keeps working with no network once the page has loaded.

---

## Requirements

- PHP **8.1+** with the `pdo_sqlite` extension (bundled with most PHP builds).
- A modern browser (Chrome, Firefox, Edge, Safari — ES2020+).
- No build step, no package manager, no framework.

## Install

### Local (development)

```bash
git clone <this-repo> lowrider-forge
cd lowrider-forge
./install.sh           # optional — creates data/ and seeds the database
php -S localhost:8000  # serve from the project root
```

Then open <http://localhost:8000>.

### Shared cPanel hosting (production)

1. Upload the project folder into — or next to — `public_html`, for example
   `public_html/forge/`.
2. In cPanel **MultiPHP Manager**, set that directory to **PHP 8.1 or newer**.
3. Make sure `data/` is writable by the account. On the suEXEC / PHP-FPM
   setup cPanel uses by default a `0755` directory is enough.
4. Open the URL. The SQLite database is created and seeded automatically on
   the first request — no build step, no SSH, no `install.sh` required.

The app never assumes its install path, so a subdirectory
(`example.com/forge/`) behaves exactly like a document root. The database
deliberately uses a rollback journal rather than WAL, because cPanel home
directories are usually NFS-backed and SQLite's WAL mode is not NFS-safe.

## Project layout

```
index.html              Single-page app
css/styles.css           Theme
js/
  app.js                 State, form generation, event wiring
  svg-parser.js           SVG -> millimetre geometry (transforms, units, curves)
  text-geometry.js        Typed text + font -> sign geometry
  geometry.js             Polygon offsetting (Clipper) + geometry helpers
  toolpath.js             Operation toolpaths (engrave/pocket/profile/drill)
  gcode-emitter.js        Toolpath -> FluidNC gcode
  preview.js              Canvas rendering, pan/zoom, hover
  validation.js           Pre-flight safety checks
  presets.js              API client + LocalStorage autosave
  lib/clipper.js          Vendored Clipper 6.4.2 (Boost license)
  lib/opentype.js         Vendored opentype.js (MIT) — reads font outlines
api/
  index.php               Router
  db.php                  SQLite schema, seed data, helpers
  bits.php / materials.php / presets.php / jobs.php
data/                     SQLite database + saved jobs (created at runtime)
fonts/                    Bundled open-licensed sign fonts (+ their licenses)
samples/                  Test SVGs (square, circle, holes plate, text)
```

## Workflow

Start from **typed text** or an **SVG file** — use the switch at the top of the
artwork panel.

1. **Type your sign text** (choose a font and sign size), or **upload an SVG**.
2. **Pick the operation** — engrave, pocket, profile-out, profile-in or drill.
3. **Choose material and bit.** Selecting a material auto-fills the
   recommended feeds, DOC and depth.
4. **Tune settings** in the right-hand tabs (Operation, Tabs, Geometry,
   Machine, Bit, Material).
5. **Watch the preview** — machine envelope, stock, toolpath, tabs and the
   work origin update live.
6. **Clear the pre-flight checks.** Errors block gcode generation.
7. **Generate gcode**, review it, then download — or download an *air pass*
   (all Z raised 25 mm) to dry-run the toolpath first.

By default the work origin is the **front-left corner of the stock**, with
**Z = 0 on top of the material** — the recommended setup. The Geometry tab can
move the origin to the centre, top-left or a custom point; with the centre or
top-left origin the toolpath spans negative coordinates by design, so set the
machine work zero at that point. The gcode header states the origin used on
every file.

## Text signs

The text generator lays out your text in a chosen font and feeds it into the
same toolpath pipeline as an SVG. Six fonts ship with the tool (sans,
condensed, heavy, slab, serif and script); you can also upload your own
`.ttf` / `.otf`. For lettering:

- **Outline** — pick the *Engrave* operation to trace each letter's outline.
- **Filled** — pick the *Pocket* operation to clear each letter solid.

Set a letter height, or let the text auto-fit the sign, and optionally cut a
frame border. Cutting the sign blank to its outside size is a separate job —
use a pre-cut blank, or profile-out a rectangle.

## Operations

| Operation    | What it does |
|--------------|--------------|
| Engrave      | Traces the path centerline at one depth. No tool compensation. Outline lettering for text. |
| Pocket       | Clears the inside of every closed shape with concentric passes — solid, filled lettering. Counters (the holes in O, A, e) are kept. |
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
- **"Backend unavailable".** gcode generation still works fully — only preset,
  bit and material storage needs PHP. Check that `data/` is writable and that
  the `pdo_sqlite` extension is enabled (cPanel → *Select PHP Version* →
  *Extensions*). The tool surfaces the exact cause in the error toast.
- **HTTP 500 on every page.** A small number of hosts forbid `Options` in
  `.htaccess`. If so, delete the `Options -Indexes` line from the root
  `.htaccess`.
- **An inside cut is skipped.** The contour was too small to offset inward
  with the chosen bit. Use a smaller bit or a different operation.

## API

All endpoints are served by `api/index.php` and return JSON. The client
addresses them with a query-string route — `api/index.php?r=bits/3` — because
`PATH_INFO` is not reliably populated on shared cPanel PHP-FPM / CGI setups.
The `PATH_INFO` form (`api/index.php/bits/3`) still works as a fallback.

```
GET/POST/PUT/DELETE  bits          bits/:id
GET/POST/PUT/DELETE  materials     materials/:id
GET/POST/DELETE      presets       presets/:id
POST                 jobs/save     persist generated gcode
GET                  jobs          jobs/:id  (download)
GET                  health
```

## Known limitations (v1)

- Polygon offsetting handles the common cases well; pathological
  self-intersecting input may need manual review (flagged by the validator).
- Manual tab placement (drag-on-canvas) is not yet implemented — tabs are
  evenly spaced.
- Profile-out and profile-in offset *every* contour the same way. A part with
  an interior window needs two operations — profile-out for the outer edge,
  profile-in for the window — and the validator flags this when it sees nested
  contours.
- `<text>` elements are not rasterised; convert text to paths before export.
- Arc *fitting* is not done — curves are emitted as tessellated polylines
  except for the drill-circle cycle, which uses true `G2`.

See `spec.md` for the full design specification.
