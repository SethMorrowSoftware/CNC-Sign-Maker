# LowRider Forge

A self-hosted web tool that turns **typed text, parametric shapes and uploaded
SVG files, and traced bitmap images** into FluidNC-compatible gcode for the **LowRider v4** CNC. Built for
engraving and cutting signs, plaques, fixtures and parts with predictable,
repeatable output.

Lay out a sign straight from the built-in **text generator** — pick a font, set
the sign size, type the text, drop in shapes and a border — or **upload an SVG**
of your own artwork. Every cut is previewed on a live canvas before a single
line of gcode is written.

All geometry and gcode generation runs **client-side in the browser**. The PHP
backend only stores bits, materials, presets and (optionally) finished gcode, so
the core of the tool keeps working even when the backend is unreachable.

---

## Contents

- [Highlights](#highlights)
- [Requirements](#requirements)
- [Install](#install)
- [Security &amp; deployment hardening](#security--deployment-hardening)
- [Quick start](#quick-start)
- [The interface](#the-interface)
- [Artwork](#artwork)
  - [Text signs](#text-signs)
  - [The shape builder](#the-shape-builder)
  - [SVG upload](#svg-upload)
  - [Bitmap tracing](#bitmap-tracing)
- [Operations](#operations)
- [Settings reference](#settings-reference)
- [Materials &amp; bits](#materials--bits)
- [Job presets](#job-presets)
- [Pre-flight validation](#pre-flight-validation)
- [The preview](#the-preview)
- [Generating gcode](#generating-gcode)
- [API](#api)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)

---

## Highlights

- **Text-sign generator** — type a sign, choose a font, auto-fit the text or set
  an exact letter height, align and nudge it, and cut a square or rounded frame.
- **Parametric shape builder** — drop in arrows, stars, hexagons, rings, pills,
  borders and more, sized in millimetres, each with its own anchor, offset and
  rotation. Quick-layout presets arrange text and shapes in one click.
- **Six operations** — engrave, pocket, V-carve, profile-out, profile-in and
  drill — selectable per job.
- **Live toolpath preview** — machine envelope, stock, reference geometry, the
  colour-coded toolpath, rapid moves, holding tabs and the work origin, all
  redrawn as you tune settings. Drag text and shapes directly on the canvas.
- **Pre-flight validation** — blocks dangerous jobs and surfaces hard-won CNC
  gotchas (thin tabs, melt-prone tooling, over-deep cuts) before any gcode is
  generated.
- **Documented, reproducible gcode** — every file carries a header recording
  every parameter used. An *air pass* option re-emits the job 25&nbsp;mm above
  the stock so you can dry-run the toolpath in space first.
- **Material &amp; bit library** — a seeded sign-shop starter set you can edit,
  extend and save job presets against.
- **Self-hosted, no build step** — vanilla HTML/CSS/JavaScript plus a tiny
  PHP&nbsp;+&nbsp;SQLite backend. No framework, no package manager, no compile.

## Requirements

- **PHP 8.1+** with the `pdo_sqlite` extension (bundled with most PHP builds).
- A modern browser — Chrome, Firefox, Edge or Safari (ES2020+).
- No build step, no Node, no package manager, no framework.

## Install

### Local (development)

```bash
git clone <this-repo> lowrider-forge
cd lowrider-forge
./install.sh                      # optional — creates data/ and seeds the database
php -S localhost:8000 router.php  # serve from the project root
```

Then open <http://localhost:8000>.

> Launch the built-in server **with `router.php`** as shown. PHP's built-in
> server ignores `.htaccess`, so without the router the `data/` directory —
> the SQLite database and any saved gcode — is reachable over HTTP. `router.php`
> denies `data/` and dotfiles and passes everything else through; on Apache it
> is ignored (the `.htaccess` rules apply). See
> [Security &amp; deployment hardening](#security--deployment-hardening).

### Shared cPanel hosting (production)

1. Upload the project folder into — or next to — `public_html`, for example
   `public_html/forge/`.
2. In cPanel **MultiPHP Manager**, set that directory to **PHP 8.1 or newer**.
3. Make sure `data/` is writable by the account. On the suEXEC / PHP-FPM setup
   cPanel uses by default a `0755` directory is enough.
4. Open the URL. The SQLite database is created and seeded automatically on the
   first request — no build step, no SSH, no `install.sh` required.

The app never assumes its install path, so a subdirectory
(`example.com/forge/`) behaves exactly like a document root. The database
deliberately uses a rollback journal rather than WAL, because cPanel home
directories are usually NFS-backed and SQLite's WAL mode is not NFS-safe.

## Security &amp; deployment hardening

The tool ships **no authentication** and is built for a **trusted local
network** — never expose it to the public internet. Beyond that, how the
`data/` directory (the SQLite database plus saved gcode) is kept off the web
depends on the server you run it on:

- **Apache / cPanel (production).** The bundled `.htaccess` files already deny
  direct access to `data/`, the database, dotfiles and the spec/installer —
  nothing more to do.
- **PHP built-in server (local dev).** `.htaccess` is **ignored**. Always start
  it with the bundled router: `php -S localhost:8000 router.php`. The router
  returns `404` for any request under `data/` or to a dotfile and serves
  everything else unchanged.
- **nginx.** `.htaccess` is **ignored**. Add deny rules to your server block
  before routing the API through PHP-FPM:

  ```nginx
  location ^~ /data/ { deny all; return 404; }
  location ~ /\.     { deny all; return 404; }
  ```

If you cannot apply server rules, move `data/` outside the web root and update
`forge_data_dir()` in `api/db.php` to point at the new location.

## Quick start

1. **Choose your artwork.** Type sign text (the default), upload an SVG, or switch to *Trace bitmap* at the top of the Artwork panel.
2. **Pick an operation** — engrave, pocket, V-carve, profile-out, profile-in or
   drill.
3. **Choose a material and bit.** Selecting a material auto-fills the
   recommended feeds, depth of cut and final depth.
4. **Tune the settings** in the right-hand tabs (Operation, Tabs, Geometry,
   Machine, Bit, Material).
5. **Watch the preview** — the machine envelope, stock, toolpath, tabs and work
   origin update live.
6. **Clear the pre-flight checks.** Any error blocks gcode generation.
7. **Generate gcode**, review it, then download — or download an *air pass*
   first to dry-run the toolpath 25&nbsp;mm above the material.

Your settings, selected bit and material are autosaved to the browser, so the
session is restored when you reload the page.

## The interface

A single-page app in three columns (stacked on narrow screens):

| Column | Contents |
|--------|----------|
| **Left** | Artwork (text, SVG, or bitmap tracing), operation picker, material &amp; bit pickers, job presets, pre-flight checks, the **Generate gcode** button. |
| **Centre** | The live toolpath preview and its toolbar. |
| **Right** | Settings tabs (Operation, Tabs, Geometry, Machine, Bit, Material) and a live job summary — stock size, runtime estimate, Z-pass count, chip load, cut distance and rapid distance. |

## Artwork

Start every job from one of three sources, chosen with the switch at the top of the Artwork panel.

### Text signs

The text generator lays your text out in a chosen font and feeds it into the
same toolpath pipeline as an uploaded SVG — the sign generator is just another
geometry source.

- **Fonts.** The picker ships with a 30-strong type library spanning sans,
  condensed, heavy, slab, serif, display, script and hand-lettered faces.
  Six core faces (Montserrat, Oswald, Archivo Black, Roboto Slab, Merriweather
  and Pacifico) are bundled with the tool; the remaining 24 are fetched the
  first time you select them. You can also **upload your own** `.ttf`, `.otf`
  or `.woff` font.
- **Sizing.** Set the sign width and height in millimetres, then either let the
  text **auto-fit** the usable area or switch off *Fit text to sign* and dial in
  an exact **letter height** (capital-letter height).
- **Placement.** Choose an alignment (left / centre / right), a placement
  anchor (centre, the four corners, the top/bottom edges), and nudge the text
  with X/Y offsets. Line spacing and letter spacing are tunable. You can also
  **drag the text directly on the preview** to reposition it.
- **Frame.** Optionally cut a frame border with square or rounded corners, set
  its inset from the sign edge, its corner radius, and the padding between the
  text and the frame.

For lettering, match the operation to the look you want:

- **Outline** — pick **Engrave** to trace each letter's outline.
- **Filled** — pick **Pocket** to clear each letter solid. Counters (the holes
  in O, A, e) are kept automatically.
- **V-carved** — pick **V-carve** with a V-bit for crisp, true V-cut lettering.

Cutting the sign blank to its outside size is a separate job — use a pre-cut
blank, or profile-out a rectangle.

### The shape builder

Below the text controls, the shape builder adds reusable parametric vector
graphics to the sign — all sized in millimetres:

- **Shapes** — rectangle, rounded rectangle, ellipse, circle, triangle,
  pentagon, hexagon, octagon, diamond, star, arrows (left/right/up/down), cross/plus,
  chevron, trapezoid, parallelogram, banner/ribbon, heart, gear and
  lightning bolt — plus matching **border** variants (rectangular, rounded,
  ellipse, hexagon, pill, ring).
- Each shape has a **width, height, anchor, X/Y offset and rotation**, plus
  shape-specific parameters (corner radius, border thickness, star points,
  arrow head/shaft ratios, gear teeth, and so on).
- **Add shape** drops in the shape configured at the top of the builder;
  **Add border** drops in a border framed to the sign.
- **Auto-fit** scales a shape to the usable sign area (with or without keeping
  its aspect ratio); **Auto-fit all** does every shape at once.
- **Quick layout presets** arrange the text and shapes together — text top /
  shape bottom, shape top / text bottom, side by side either way, and
  centred overlap.
- Shapes can also be **dragged on the preview** to reposition them, clamped to
  the usable sign interior so the sign envelope never changes.

### SVG upload

Switch to *Upload SVG* to drop in your own artwork. The parser walks every
element, applies nested transforms, resolves units to millimetres (mm / cm / in
/ pt / pc / px, case-insensitive) and tessellates curves (`C / S / Q / T / A`)
into line segments at a controllable tolerance. It handles paths, rectangles,
circles, ellipses, lines, polylines, polygons, `<use>` references (including
`<use>` of `<symbol>` with width/height overrides), and respects
`preserveAspectRatio` so viewport-resized files cut at the correct proportions.
Files with `<style>.hidden{display:none}` plus `class="hidden"` honour the
hidden layers — common pattern from Inkscape and Illustrator exports.

Each closed subpath is classified as an **outer profile** or a **hole** by area
(the *hole-vs-trace threshold*); open subpaths become engraving lines. Open
paths that visually close (last vertex within 0.01 mm of the first) are
promoted to closed automatically. Four test SVGs ship in `samples/` — a square,
a circle, a holes plate and a text sign.

> `<text>` elements are not rasterised. An SVG containing only text raises a
> clear error directing you to convert text to paths in your editor (Inkscape:
> *Path → Object to Path*) or use the built-in Text sign mode.

### Bitmap tracing

Switch to *Trace bitmap* to convert high-contrast raster artwork (PNG, JPG,
WebP, BMP) into closed contours you can engrave, pocket, profile, drill or
V-carve.

- **Input limits.** Bitmap uploads are capped at 8 MB; oversized images are
  downscaled for tracing (up to 1400 px wide) to keep tracing responsive.
- **Trace controls.**
  - **Threshold** controls black/white segmentation (lower = darker pixels kept).
  - **MM per pixel** sets the physical size of traced geometry.
  - **Min island area** removes tiny specks/noise islands.
  - **Simplify** reduces node count while preserving contour shape.
- **Presets.** Logo, line-art and stencil presets provide tuned defaults for
  common artwork types.
- **Worker tracing.** Tracing runs in a Web Worker when available, with a
  main-thread fallback if worker execution fails.
- **Stale-result protection.** Rapid control changes cannot apply outdated trace
  results; only the most recent run updates the geometry/preview.

Use the trace info panel to review contour count and node reduction (before →
after simplification) before generating toolpaths.


## Operations

| Operation | What it does |
|-----------|--------------|
| **Engrave** | Traces the path centreline. For shallow cuts (≤ DOC) it's a single pass; deeper engraves step down in DOC increments like every other op. No tool compensation — outline lettering for text, plus open engraving lines. |
| **Pocket** | Clears the inside of every closed shape with concentric passes — solid, filled lettering. Counters (the holes in O, A, e) are kept. |
| **V-carve** | V-carves closed shapes with a V-bit for crisp V-cut lettering. Cut depth follows the bit's included angle so the flanks meet the surface exactly on the outline; the final depth caps how deep wide areas go. |
| **Profile out** | Cuts **outside** a closed path (tool radius + finishing allowance). Multi-depth, with holding tabs. |
| **Profile in** | Cuts **inside** a closed path — pockets and opening cutouts. Multi-depth. |
| **Drill** | Plunge- or circle-bores **circular** closed features. Holes smaller than the bit are plunge-drilled oversized. Non-circular small features (squares, irregular blobs) automatically fall back to profile-in so the cutter follows the actual shape — drilling a square as a circle would gouge past the corners by ~40%. |

**Cut order.** Small closed features (below the *hole-vs-trace threshold*) are
always given a drill cycle and emitted **first**, while the bit is freshest;
outer profiles are emitted **last**, because once the outline is cut the part
can move.

**Holding tabs.** On profile-out jobs, tabs leave thin material bridges so the
part stays connected to the stock. Tabs are evenly spaced and the tab Z profile
is applied on **every depth pass** — an intermediate pass can never cut straight
through a tab and break the part loose before the job finishes. When the
material thickness is known (selected from the library), the tab Z anchors to
the material bottom so the **tab thickness** setting equals the actual
remaining material — without that, through-cut overage would silently produce a
tab thinner than requested (e.g. a 1.5 mm setting could leave only 0.85 mm).

**Drill chip clearing.** Multi-pass drilling retracts above the stock surface
between every depth pass (and between every peck when peck mode is on), then
rapids back down through the cleared hole — so chips evacuate properly even
deep into a hole.

## Settings reference

Settings live in the six right-hand tabs.

**Operation** — final depth (negative = below the surface), depth of cut per
pass, cut feed, plunge feed, finishing allowance, tool-offset override (0 =
auto: tool radius + finishing), plunge style (straight / peck / helical-ramp)
and peck-retract height.

**Tabs** *(profile-out only)* — enable tabs, tabs per profile, tab thickness
(material left under the bit) and tab width (the flat-top length along the
perimeter).

**Geometry** — uniform scale, rotation (0 / 90 / 180 / 270°), origin position,
custom origin X/Y, stock margin, the hole-vs-trace area threshold, a target hole
diameter, and the curve tessellation tolerance.

**Machine** — job name, machine cutting area X/Y, safe Z, pre-stock Z, rapid
feed (for runtime estimates), spindle RPM, an M0-pause toggle, the output
filename pattern and an optional header-comment template.

**Bit** — name, cutting diameter, shank diameter, flute count, cutting length,
type (upcut / downcut / compression / O-flute / V-bit), V-bit included angle and
notes. **Update / Save as new / Delete** manage the bit library.

**Material** — name, thickness, recommended bit type, recommended RPM, cut and
plunge feeds, recommended DOC, through-cut overage and notes. The same
**Update / Save as new / Delete** controls manage the material library.

### The work origin

By default the work origin is the **front-left corner of the stock**, with
**Z = 0 on top of the material** — the recommended setup, which keeps every
coordinate positive. The Geometry tab can move the origin to the centre,
top-left or a custom point; with the centre or top-left origin the toolpath
spans negative coordinates by design, so set the machine work zero at that
point. The gcode header states the origin used on every file.

## Materials & bits

The database is seeded on first run with a sign-shop starter set — end mills,
O-flutes, compression bits, V-bits and ball-nose bits, plus materials covering
foam, PVC board, HDPE, plywood, MDF, hardboard, acrylic, composite panel,
hardwood and aluminium. Selecting a material auto-fills the recommended feeds,
DOC and (for through-cuts) the final depth.

Everything is editable: change a value and **Update** it, **Save as new** to
branch a variant, or **Delete** it. New entries you create are kept in the
SQLite database.

## Job presets

A preset captures the full job — operation, bit, material and every setting.
**Save current settings as preset** stores it on the server; the **Job presets**
picker loads or deletes saved presets. Four sample presets ship with the tool
(foam engrave, plywood profile-cut with tabs, HDPE 2-colour sign engrave and an
aluminium 6061 profile).

## Pre-flight validation

Before any gcode can be generated, the validator runs a battery of safety
checks. Anything at **error** level blocks generation; warnings and info notices
are advisory. Many issues offer a one-click **Apply fix**.

The validator encodes the hard-won lessons from real bench time:

**Catastrophic — blocks generation:**

- **Final depth must be negative.** Zero or positive `finalDepth` would drive
  the bit upward into the spindle instead of cutting. Blocked.
- **Safe Z must be positive.** A zero or negative Safe Z lets the bit drag
  across the work during rapids.
- **Bit cutting length** is checked against `|cut depth|` — once the cut goes
  deeper than the flutes, the non-cutting shank rubs the cut wall. A cut within
  1&nbsp;mm of the flute length raises a warning to double-check collet
  clearance.
- **HDPE with a multi-flute bit** — multi-flute bits melt HDPE and can flame.
- **Negative XY coordinates** with the front-left origin block generation,
  so the LowRider's positive-only work area is never violated.
- **Tabs below 1&nbsp;mm** thick are blocked — they snap mid-cut.
- **V-carving** requires a V-bit with a valid included angle.

**Bad practice — warnings:**

- **DOC larger than the bit diameter** — heavy chip load, breakage risk.
- **Plunge feed faster than cut feed** — plunging is the hardest move on a bit.
- **O-flute-recommended materials** (Sintra, ACM, PVC foam, etc.) with a
  multi-flute bit — generalises the HDPE/acrylic rule to any plastic the
  material library tags for O-flute use.
- **V-bit on a profile / drill / pocket op** — V-bits only cut at the flank.
- **Chip load** outside the 0.05–0.30&nbsp;mm window.
- **Tabs above 2&nbsp;mm** thick — will hold well but need flush-trim cleanup.
- **Through-cut depth** is sanity-checked against material thickness and the
  spoilboard overage (profile-out only — profile-in is rarely a through-cut).
- **Stock margin smaller than the tool offset** on profile-out warns the
  outside toolpath may run off the stock — with a one-click fix that's
  suppressed when bumping the margin would push the part off the machine.
- **Deep straight plunges** (per-plunge depth > 3× bit diameter, or 5 mm with
  no bit info) suggest switching to peck or helical plunge.
- **Spindle RPM far from the material recommendation** (info).

**Informational:**

- **M0 pauses are off by default** — they silently halt the program. Turning
  them on raises an info banner.
- **The machine envelope** is checked; if the job would fit rotated, a 90°
  rotation is offered (re-check after rotating if you have a custom origin).
- **Oversized drilled holes** (hole diameter ≤ bit diameter) raise a warning
  and are documented in the gcode header.
- **Non-circular small features** trigger a notice when drill is selected,
  noting the auto-fallback to profile-in. Set a *target hole diameter* on the
  Geometry tab to force a drill cycle anyway.
- **Parametric-looking parts** suggest you regenerate the SVG at the correct
  size rather than scaling it.
- **Bitmap traces** above 30k nodes raise an info ("cut may be slower than
  expected"); above 120k raises a warn ("preview and cut will be slow").
- **Nominal plywood thickness** is flagged — measure your actual stock.

## The preview

The centre canvas draws the machine envelope (dashed blue), the stock (grey
fill), the reference geometry, the colour-coded toolpath, rapid moves, holding
tabs (red ✕) and the work origin (red crosshair at 0,0).

- **Pan** — drag with the left or middle mouse button.
- **Zoom** — scroll the wheel, or use the **+ / − / Fit** buttons.
- **Hover** — a tooltip shows X, Y, current Z and feed rate.
- **Toggles** — show or hide rapids, tabs and the reference geometry.
- In text mode, **left-drag the text or any shape** directly on the canvas to
  reposition it.

## Generating gcode

Every generated file follows a fixed structure: a documented header, a safe
preamble (`G21 G90 G94 G17`, spindle off, rapid to safe Z, optional M0 pause,
`M3 S`), the operation body (drills first, profiles last, with a comment per
operation) and a footer that parks the machine — **spindle off (`M5`) before
the rapid back to (0,0)**, then optional M0, then `M30`. The M5-before-park
order means the spindle is never spinning during the return rapid, which
matters if a VFD is wired (it's a no-op for the manual Makita).

- **The header** records the job name, material, bit, operation, final depth and
  pass count, spindle RPM (with the matching Makita dial number), feeds, the
  work origin, the stock size, the machine-envelope check result and the
  generation timestamp.
- **Air pass** — the modal can re-emit the whole job with every Z raised
  25&nbsp;mm so you can dry-run the toolpath above the stock before cutting.
- **Filename** — built from a template (`{job}_{material}_{bit}_{date}.gcode` by
  default); air-pass files are prefixed `AIRPASS_`. Pathological patterns that
  sanitise to empty fall back to `job.gcode`.
- **Coordinates** are emitted with explicit per-segment feeds; full circles use
  `G2/G3` with `I/J` centre offsets. Non-finite coordinates can never reach the
  file (the emitter clamps and skips degenerate arcs defensively).

From the modal you can **Copy** the gcode, **Download** the `.gcode` file, or
**Save to server** to keep a copy in `data/jobs/`.

## API

All endpoints are served by `api/index.php` and return JSON. The client
addresses them with a query-string route — `api/index.php?r=bits/3` — because
`PATH_INFO` is not reliably populated on shared cPanel PHP-FPM / CGI setups. The
`PATH_INFO` form (`api/index.php/bits/3`) still works as a fallback.

```
GET/POST/PUT/DELETE   bits          bits/:id
GET/POST/PUT/DELETE   materials     materials/:id
GET/POST/DELETE       presets       presets/:id
POST                  jobs/save     persist generated gcode
GET                   jobs          jobs/:id   (download)
GET                   health
```

No authentication — the tool assumes a trusted local network (see *Known
limitations*).

## Project layout

```
index.html               Single-page app
css/styles.css            Theme
js/
  app.js                  State, form generation, event wiring (text/SVG/bitmap)
  svg-parser.js           SVG -> millimetre geometry (transforms, units, curves)
  bitmap-tracer.js        Bitmap raster -> traced contour geometry
  workers/trace-worker.js Workerized bitmap tracing pipeline
  text-geometry.js        Typed text + font -> sign geometry
  shapes.js               Parametric shape library
  geometry.js             Polygon offsetting (Clipper) + geometry helpers
  toolpath.js             Operation toolpaths (engrave/pocket/v-carve/profile/drill)
  gcode-emitter.js        Toolpath -> FluidNC gcode
  preview.js              Canvas rendering, pan/zoom, hover, drag
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

## Troubleshooting

- **Axes move the wrong direction.** This is a FluidNC config issue, out of
  scope for this tool. Add the `:low` modifier to the motor `direction_pin` in
  your controller YAML — and remember `:low` *must be single-quoted in YAML*.
- **Job size looks wrong after upload.** If the SVG had no explicit units the
  size is assumed at 96&nbsp;dpi; correct it with the *Scale* setting. The SVG
  info panel flags files with no physical units.
- **"Backend unavailable".** gcode generation still works fully — only preset,
  bit and material storage needs PHP. Check that `data/` is writable and that
  the `pdo_sqlite` extension is enabled (cPanel → *Select PHP Version* →
  *Extensions*). The tool surfaces the exact cause in the error toast.
- **HTTP 500 on every page.** A small number of hosts forbid `Options` in
  `.htaccess`. If so, delete the `Options -Indexes` line from the root
  `.htaccess`.
- **An inside cut is skipped.** The contour was too small to offset inward with
  the chosen bit. Use a smaller bit or a different operation.
- **A request body was dropped (HTTP 413).** A large preset or saved job
  exceeded the host `post_max_size`; raise it in cPanel *MultiPHP INI Editor*.

## Known limitations

- Polygon offsetting handles the common cases well; pathological
  self-intersecting input may need manual review (flagged by the validator).
- Manual tab placement (drag-on-canvas) is not yet implemented — tabs are
  evenly spaced.
- Profile-out and profile-in offset *every* contour the same way. A part with an
  interior window needs two operations — profile-out for the outer edge and
  profile-in for the window — and the validator flags this when it sees nested
  contours.
- `<text>` elements in uploaded SVGs are not rasterised; convert text to paths
  before export, or use the built-in text generator. (The parser raises a
  clear error if you forget.)
- Arc *fitting* is not done — curves are emitted as tessellated polylines,
  except the drill-circle cycle, which uses true `G2`.
- The shape library's `pillBorder` renders as an ellipse border (not a true
  stadium with straight sides). A real stadium would need the shape API to
  know the target width/height aspect — out of scope for v1.
- There is no authentication; deploy the tool only on a trusted local network.
  On non-Apache servers the `data/` directory must be protected explicitly —
  see [Security &amp; deployment hardening](#security--deployment-hardening).

See `spec.md` for the full design specification.
