# LowRider Forge — Geometry-to-Gcode Web Tool Specification

A self-hosted web application for reliably converting text, SVG, and bitmap geometry into FluidNC-compatible gcode for the LowRider v4 CNC. Designed for engraving and cutting signs, fixtures, and parts from real-world SVG input with predictable, repeatable output.

## 1. Project Goals

1. **Reliability over feature breadth.** Better to do five operations excellently than fifteen poorly.
2. **Real-world tuned.** Every setting tunable that has caused a real-world problem in actual use (hard-won list at the bottom of this doc).
3. **Visual confidence.** No cut runs without the operator seeing exactly what the bit will trace, where origin lands, and where tabs go.
4. **No surprises.** Generated gcode includes header comments documenting every parameter used. Files are reproducible from saved presets.
5. **Self-hostable.** Vanilla stack (HTML/CSS/JS/PHP) so it runs on any LAMP/LEMP host without exotic dependencies.

## 2. Tech Stack

**Frontend:**
- Vanilla HTML/CSS/JavaScript (no framework). Modern ES2020+.
- Canvas API for toolpath preview rendering.
- File API for SVG upload, Blob/URL for gcode download.
- LocalStorage for in-session preset autosave.

**Backend:**
- PHP 8.1+ (no framework needed — keep it simple).
- SQLite for preset/material/bit storage (single-file DB, zero setup).
- File I/O for gcode artifacts (optional persistence; primary delivery is download).

**Geometry libraries:**
- Client-side: a polygon offsetting library is mandatory. Recommended: a JS port of the Clipper library (e.g. `clipper-lib` or `polygon-clipping`). Hand-rolling polygon offset is a trap — corners and self-intersections are non-trivial.
- SVG path parsing: write a small parser for `M / L / H / V / C / S / Q / T / A / Z` commands. Treat curves by tessellating into line segments at a controllable tolerance (default 0.1mm).

**Why this stack:** Vanilla JS keeps the project alive across years without framework churn. PHP is the lowest-friction backend for a hobbyist-grade web app on a shared host. SQLite eliminates database setup.

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          BROWSER                                │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐    │
│  │ Text/SVG/Bitmap│  │ Toolpath     │  │  Settings panel    │    │
│  │ SVG parse    │→ │ generation   │→ │  (live preview)    │    │
│  └──────────────┘  └──────────────┘  └────────────────────┘    │
│         │                  │                    │              │
│         └──────────────────┼────────────────────┘              │
│                            ↓                                   │
│                    ┌───────────────┐                           │
│                    │   Canvas      │                           │
│                    │   preview     │                           │
│                    └───────────────┘                           │
│                            ↓                                   │
│                    ┌───────────────┐                           │
│                    │ Gcode emitter │                           │
│                    └───────────────┘                           │
│                            ↓                                   │
│                    ┌───────────────┐                           │
│                    │  Download .gcode                          │
│                    └───────────────┘                           │
└───────────────┬─────────────────────────────────────────────────┘
                │ HTTP (only for preset persistence)
                ↓
┌─────────────────────────────────────────────────────────────────┐
│                            PHP                                  │
│  /api/presets  /api/materials  /api/bits  /api/jobs/save        │
│                            ↓                                    │
│                        SQLite DB                                │
└─────────────────────────────────────────────────────────────────┘
```

**Critical design decision:** all geometry and gcode generation happens **client-side**. PHP only handles persistence. This means:
- No round-trip latency when adjusting settings.
- Live preview updates as the operator drags sliders.
- The tool works offline once loaded (good for shop computers with flaky wifi).

## 4. Geometry Ingestion Requirements


### 4.1 Text sign generator
- Built-in typed-text geometry generation with font loading (`opentype.js`) and layout controls (fit-to-sign, letter height, alignment, anchor, offsets, spacing, frame, and parametric graphics).

### 4.2 SVG upload parsing
The SVG parser must handle transformed/nested real-world files and resolve units to millimetres. Curves are tessellated by configurable tolerance.

### 4.3 Bitmap tracing
- Accept PNG/JPG/JPEG/WebP/BMP uploads (max 8 MB).
- Decode with `createImageBitmap`, then downscale for tracing responsiveness (current implementation caps width at 1400 px).
- Convert RGBA to luminance + alpha-aware grayscale and threshold into a binary grid.
- Trace pixel-edge loops into closed contours.
- Apply filters/cleanup: min-island area and Douglas-Peucker simplification.
- Convert traced points into mm geometry using mm-per-pixel scaling.
- Run tracing in a Web Worker (`js/workers/trace-worker.js`) with main-thread fallback.
- Guard against stale async results: only the latest trace run can commit geometry.

The parser must reliably handle SVGs from the real-world tools the user employs:
- OpenSCAD exports (e.g. the V1 strut_plate.svg — single big `<path>` with many `M..L..z` subpaths).
- Inkscape exports (multiple `<path>` elements, possibly with transforms).
- Illustrator/Affinity exports (likely with deeply nested transforms).
- Hand-made SVGs.

**Required parser behavior:**

1. **Walk every element** in the SVG. Apply CSS/XML `transform=` attributes cumulatively as you descend.
2. **Resolve units.** SVG can specify `width="800mm"`, `width="800"` (units depend on viewBox), or pixel sizes. Compute the SVG-unit to mm ratio at the root and apply to all coordinates.
3. **Tessellate curves.** Convert `C / S / Q / T / A` segments to line segments at a configurable chord-tolerance (default 0.1mm). Lower tolerance for finer detail; higher for faster preview.
4. **Identify closed subpaths.** A subpath ending in `Z` is a closed polygon. Group consecutive open path commands until the next `M` or `Z`.
5. **Classify each subpath** as one of:
   - **Hole** (small closed polygon, e.g. bolt-clearance hole) — flag by user-settable area threshold (default <50mm²).
   - **Outer profile** (large closed polygon).
   - **Open curve / engraving line** (not closed).
6. **Winding-order detection.** Determine if each polygon is CW or CCW. Holes inside outer profiles must have opposite winding from their parent (per SVG even-odd or non-zero fill rules).
7. **Bounding box.** Compute overall and per-subpath bounding boxes for centering / scaling.

**Recommended parser interface:**
```javascript
const geometry = parseSvg(svgText);
// geometry = {
//   width_mm, height_mm,
//   subpaths: [
//     { type: 'outer'|'hole'|'open', points: [[x,y],...], closed: bool, winding: 'cw'|'ccw' },
//     ...
//   ]
// }
```

## 5. Operation Types

The tool supports six operations, selectable per-job:

### 5.1 Engrave (centerline)
- Bit traces the path centerline at a single shallow depth.
- No tool radius compensation.
- Useful for: logos, signage on two-color HDPE, dimensional verification ("groove-center to groove-center"), text.

### 5.2 Profile cut outer (with tabs)
- Bit traces the path **outside** the geometry, offset outward by `tool_radius + finishing_allowance`.
- Multi-depth passes from 0 down to final depth.
- Tabs on final pass only: bit lifts at N evenly-spaced positions to leave material connections.
- Useful for: cutting out part outlines.

### 5.3 Pocket
- Bit traces the path **inside** the geometry, offset inward.
- Multi-depth passes.
- Useful for: cutting opening cutouts.

### 5.4 V-carve
- V-carves every closed contour with a V-bit using included-angle geometry.
- Final depth is a cap; wider regions may hit the cap while narrow regions run shallower.

### 5.5 Profile in
- Multi-depth internal profile offset for interior cutouts/openings.

### 5.6 Drill / hole circle
- For small features where `bit_diameter > hole_diameter`: single plunge cycle at hole center (creates oversized hole).
- For features where `bit_diameter < hole_diameter`: bit plunges at center, traces a circle at radius `(hole_d/2 - bit_r)`, returns. Multi-depth pecking optional.
- Useful for: M3/M5/M6 mounting hole patterns.

## 6. Settings Catalog

Every setting that has caused a real-world problem during actual cutting. Settings group into Material, Bit, Operation, Job, and Output.

### 6.1 Bit settings (per-bit preset)
| Setting | Type | Default | Note |
|---|---|---|---|
| Name | string | — | e.g. "1/4 single-flute O-flute (HDPE)" |
| Diameter (mm) | float | — | Cutting diameter, not shank |
| Shank diameter (mm) | float | — | For documentation |
| Flute count | int | 2 | 1 for plastics, 2-3 for wood |
| Cutting length (mm) | float | — | Max plunge before chuck collision |
| Type | enum | upcut | upcut / downcut / compression / O-flute / V-bit |

### 6.2 Material settings (per-material preset)
| Setting | Type | Default | Note |
|---|---|---|---|
| Name | string | — | e.g. "1/4 inch plywood" |
| Thickness (mm) | float | — | Nominal — operator should measure actual |
| Recommended bit type | enum | — | Filters bit picker |
| Recommended RPM | int | — | Informational (Makita is manual) |
| Recommended cut feed | int | — | mm/min |
| Recommended plunge feed | int | — | mm/min |
| Recommended DOC per pass | float | — | mm |
| Through-cut overage | float | 0.65mm | How much deeper than thickness for clean through |

### 6.3 Operation settings (per-job)
| Setting | Type | Default | Note |
|---|---|---|---|
| Operation | enum | engrave | engrave / pocket / vcarve / profile-out / profile-in / drill |
| Final depth (mm) | float | — | Negative = below stock surface |
| DOC per pass (mm) | float | — | Positive value |
| Finishing allowance (mm) | float | 0.15 | Added to offset for clean edge |
| Tool offset override (mm) | float | auto | Auto = `tool_radius + finishing` |
| Plunge style | enum | straight | straight / peck / helical |
| Peck retract distance (mm) | float | 2.0 | Only for peck plunge |

### 6.4 Tabs (profile-out only)
| Setting | Type | Default | Note |
|---|---|---|---|
| Enable tabs | bool | true | |
| Tab count per profile | int | 4 | |
| Tab thickness (mm) | float | 1.5 | Material left below bit at tab |
| Tab width (mm) | float | 6.0 | Along perimeter |
| Tab placement | enum | even | currently even spacing in implementation |

### 6.5 Job geometry settings
| Setting | Type | Default | Note |
|---|---|---|---|
| Scale (%) | float | 100 | Uniform scaling |
| Rotation | enum | 0° | 0 / 90 / 180 / 270 CW or CCW |
| Origin position | enum | bottom-left | bottom-left / center / top-left / custom |
| Stock margin (mm) | float | 0 | Extra stock around part bounds (0 = stock equals part size) |
| Hole-vs-trace threshold (mm²) | int | 50 | Subpaths below this area = drill cycle |
| Target hole diameter (mm) | float | — | For closed circles below threshold |

### 6.6 Machine / output settings
| Setting | Type | Default | Note |
|---|---|---|---|
| Machine cutting area X (mm) | int | 1270 | Validates job fits |
| Machine cutting area Y (mm) | int | 2540 | Validates job fits |
| Safe Z (mm) | float | 10 | Rapid height above stock |
| Pre-stock Z (mm) | float | 2 | Last height before plunge |
| Rapid feed (mm/min) | int | 5000 | For time estimates |
| Use M0 pauses | bool | false | True = pause for manual router on/off |
| Spindle RPM in M3 | int | 18000 | Informational unless VFD connected |
| Filename pattern | string | `{job}_{material}_{bit}_{date}.gcode` | Templated |
| Header comment template | textarea | — | Templated with job parameters |

## 7. UI Layout

Single-page application, three columns desktop / stacked mobile:

```
┌─────────────────────────────────────────────────────────────────┐
│  LEFT (320px)        │  CENTER (flex)    │  RIGHT (320px)       │
│                      │                   │                      │
│  Artwork:            │   ┌────────────┐  │  Settings (tabs):    │
│   - Text sign        │   │            │  │   - Operation        │
│   - Upload SVG       │   │  Canvas    │  │   - Tabs             │
│   - Trace bitmap     │   │  preview   │  │   - Geometry         │
│  Operation picker    │   │            │  │   - Machine          │
│  Material picker     │   │            │  │   - Bit              │
│  Bit picker          │   │            │  │   - Material         │
│  Job presets         │   └────────────┘  │                      │
│                      │                   │  Live job summary:   │
│  Pre-flight checks:  │   Toolbar:        │   - Stock required   │
│   - Fits machine? ✓  │     [Zoom +/-]    │   - Est. runtime     │
│   - Bit can reach    │     [Fit]         │   - Total Z passes   │
│     full depth? ✓    │     [Rapids]      │   - Chip load        │
│   - HDPE + flutes?   │     [Tabs]        │   - Cut distance     │
│   - Tabs ≥ 1mm?      │     [Reference]   │   - Rapid distance   │
│                      │                   │                      │
│  Buttons:            │                   │                      │
│   [Generate gcode]   │                   │                      │
│   [Save preset]      │                   │                      │
└─────────────────────────────────────────────────────────────────┘
```

**Canvas preview details:**
- Background: machine envelope as a dashed blue rectangle (sized per machine settings).
- Material/stock outline as a filled light gray rectangle.
- Original SVG geometry as thin light gray lines (reference).
- Computed toolpath as colored lines: green for engrave, blue for profile-out, magenta for profile-in, orange for drill plunges.
- Rapid moves as faint dashed lines (toggleable).
- Tabs as small red X marks on the toolpath.
- Origin marker (red crosshair at 0,0).
- Tooltip on hover: shows X, Y, current Z, current feed rate.
- Pan: middle-click drag. Zoom: scroll wheel.

## 8. Gcode Generation Rules

Every generated file follows this structure:

```gcode
; ====== {Job name} ======
; Material: {material}
; Bit: {bit}
; Operation: {operation}
; Final depth: {z}mm   DOC: {doc}mm × {n} passes
; Spindle: {rpm} RPM (dial {makita_dial})  -- INFO ONLY for manual router
; Feed: {feed} mm/min cut, {plunge} mm/min plunge
; Origin: FRONT-LEFT of stock, Z=0 on material top
; Stock needed: {sx} × {sy} mm
; Machine envelope check: {fits/warning}
; Generated by LowRider Forge v{version} on {timestamp}
;
G21    ; mm
G90    ; absolute coords
G94    ; feed per minute
G17    ; XY plane
M5     ; spindle off (no-op for manual router)
G0 Z{safe_z}
{optional M0 pause for manual router on}
M3 S{rpm}   ; no-op for manual router; informational

; --- Operation body (drills first, then profiles) ---
{generated toolpath}

; --- Footer ---
G0 Z{safe_z}
G0 X0 Y0
M5
{optional M0 pause for manual router off}
M30
```

**Hard rules drawn from real-world experience:**

1. **No `M0` pauses by default.** They block the program waiting for cycle-start which trips users up. Optional flag for those who want them.
2. **All XY coordinates positive.** Translate geometry after rotation/scaling so origin is bottom-left of bounding box plus margin. The LowRider homes front-right with positive-X-and-Y work area.
3. **Drill operations before profiles.** Plunge cycles when bit is freshest = cleanest holes.
4. **Outer profiles last.** Once outer is cut, part can move — anything depending on it being held must happen earlier.
5. **Multi-depth passes step from 0 down to final.** Never start at final depth on pass one. Always include final depth as the last pass even if it's a small step.
6. **Tabs only on the final pass.** Earlier passes go through full perimeter without lifting.
7. **Plunge feed always slower than cut feed.** Typically 25-40% of cut feed.
8. **Per-segment feed rate annotation.** Every `G1` line includes `F` value. FluidNC tolerates omitted F (uses previous), but explicit F survives any controller quirk.
9. **G2/G3 arc center via I/J offset, not R.** Full-circle support requires I/J because R-form ambiguates direction.

## 9. Toolpath Generation Algorithm

For each subpath, by operation type:

### Engrave
```
for each subpath:
    G0 X{first}, G0 Z{pre-stock}
    G1 Z{final-depth} F{plunge}
    for each subsequent point:
        G1 X Y F{cut}
    G0 Z{safe}
```

### Profile out
```
offset_path = polygon_offset(subpath, +offset_distance, mitre_join)
tabs = place_tabs(offset_path, count, half_width)
depths = compute_pass_depths(final_z, doc)
for depth in depths:
    G0 X{first of offset_path}, G0 Z{pre-stock}
    G1 Z{depth} F{plunge}
    if depth == final and tabs:
        for each point:
            z = tab_z if near_tab(point) else depth
            G1 X Y Z F{cut}
    else:
        for each point:
            G1 X Y F{cut}
    G0 Z{safe}
```

### Drill hole
```
hpr = (hole_d/2) - bit_r  ; can be negative for oversized hole
if hpr <= 0:
    # bit bigger than hole — just plunge
    G0 X{center}, G0 Z{pre-stock}
    for depth in depths:
        G1 Z{depth} F{plunge}
        G0 Z{retract}  ; peck
    G0 Z{safe}
else:
    # trace a circle inside the hole
    for depth in depths:
        G1 Z{depth} F{plunge}
        G1 X{center+hpr} Y{center} F{cut}
        G2 X{center+hpr} Y{center} I{-hpr} J0 F{cut}
        G1 X{center} Y{center} F{cut}
    G0 Z{safe}
```

## 10. Validation & Safety Checks (run before allowing download)

| Check | Action if fail |
|---|---|
| Geometry fits within machine envelope | Block download; show overlap on canvas |
| Final depth ≤ bit cutting length | Block download |
| Stock margin > tool radius + offset | Warning; offer to auto-adjust |
| Hole diameter < bit diameter on a "drill" feature | Warning; suggest larger hole or smaller bit |
| Feed rate × flutes × RPM = chip load outside 0.05-0.30mm | Warning; suggest revised feed |
| Total Z descent > 30mm without peck plunge | Warning; suggest peck |
| Machine envelope X/Y mismatch with SVG orientation | Suggest rotation |
| Multiple closed contours overlap | Warning; manual review needed |

## 11. Data Model (SQLite)

```sql
CREATE TABLE bits (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    diameter_mm REAL NOT NULL,
    shank_diameter_mm REAL,
    flute_count INTEGER NOT NULL,
    cutting_length_mm REAL,
    type TEXT NOT NULL,
    notes TEXT
);

CREATE TABLE materials (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    thickness_mm REAL,
    recommended_rpm INTEGER,
    recommended_feed_cut INTEGER,
    recommended_feed_plunge INTEGER,
    recommended_doc_mm REAL,
    through_cut_overage_mm REAL DEFAULT 0.65,
    notes TEXT
);

CREATE TABLE presets (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    bit_id INTEGER REFERENCES bits(id),
    material_id INTEGER REFERENCES materials(id),
    operation TEXT NOT NULL,
    settings_json TEXT NOT NULL,
    created_at INTEGER,
    updated_at INTEGER
);

CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    filename TEXT NOT NULL,
    preset_id INTEGER REFERENCES presets(id),
    svg_hash TEXT NOT NULL,
    gcode_path TEXT,
    settings_json TEXT NOT NULL,
    created_at INTEGER
);
```

## 12. PHP API Surface

Minimal endpoints — most work is client-side:

```
GET  /api/bits           → list of all bits
POST /api/bits           → create bit
PUT  /api/bits/:id       → update
DELETE /api/bits/:id     → delete

GET  /api/materials      → list of all materials
POST /api/materials      → create
PUT  /api/materials/:id  → update
DELETE /api/materials/:id

GET  /api/presets        → list
POST /api/presets        → save current settings as preset
GET  /api/presets/:id    → load preset

POST /api/jobs/save      → optionally persist a generated gcode file
GET  /api/jobs/:id       → download persisted gcode
```

All responses are JSON. No authentication for V1 (assume local network). Future: token-based auth.

## 13. Initial Preset Library (ship with the tool)

**Bits:**
- 1/4" 2-flute upcut (general wood/foam) — diameter 6.35, flutes 2, cutting length 25mm
- 1/8" 2-flute upcut (detail wood, SpeTool W04021) — diameter 3.175, flutes 2, cutting length 25.4mm
- 1/4" single-flute O-flute (plastics) — diameter 6.35, flutes 1, cutting length 25mm
- 1/8" single-flute O-flute (plastic detail) — diameter 3.175, flutes 1, cutting length 17mm
- 60° V-bit (sign engraving) — special handling

**Materials:**
- 1.5" rigid insulation foam (38mm)
- 1/4" plywood (6.35mm, actual usually 5.5-6.5mm — note in tooltip)
- 1/4" MDF (6.35mm)
- 1/4" hardboard (6.35mm)
- 1/2" plywood (12.7mm)
- 2-color HDPE (cap 0.5mm over core, full sheet 1/8" or 1/4")
- HDPE solid (3mm / 6mm / 12mm)
- 1/4" acrylic (cast, NOT extruded)
- 6061-T6 aluminum (3mm — special slow-feed presets)

**Sample presets (linking bit + material + sensible defaults):**
- "Foam dimensional engrave" — 1/8" upcut, foam, engrave at -4mm, F2000
- "Plywood profile cut with tabs" — 1/8" upcut, 1/4" plywood, profile-out, depth -8mm
- "HDPE 2-color sign engrave" — 1/4" O-flute single, 2-color HDPE, engrave at -0.5mm, F1500
- "Aluminum 6061 profile" — 1/4" single-flute aluminum bit (separate from O-flute), 3mm 6061, DOC 0.5mm, F800

## 14. Known-Bad Gotchas to Codify Up Front

Real lessons from real bench time — every one of these caused a problem during my own use of similar workflows. The tool should make them difficult or impossible to repeat:

1. **M0 silently halts the program.** Default it off. If on, the UI shows a warning banner: "Program will pause and require Cycle Start to continue."
2. **`:low` direction-pin modifier needs single quotes in YAML.** This is a config issue not a gcode issue, but noted here so the docs/help cover it.
3. **"1/4 inch" plywood is rarely actually 6.35mm.** Material tooltip: "Measure your actual thickness before cutting; nominal 1/4" plywood is often 5.5-6.0mm."
4. **Unsurfaced spoilboard can have 2mm of dish.** Build in a "through-cut overage" setting (default 0.65mm) that the operator can crank up if their spoilboard is rough.
5. **Tabs too thin = part breaks loose mid-cut.** Don't let tabs go below 1mm thickness. Warning above 2mm: "Will require flush-trim cleanup."
6. **Single flute is mandatory for HDPE.** When user picks an HDPE material with a multi-flute bit, show a red banner: "Multi-flute bits melt HDPE — use single-flute O-flute."
7. **Bit cutting length limits depth.** Validate `abs(final_z) + 2 < bit.cutting_length` (the 2mm safety lets the bit stay above material at safe-Z).
8. **Strut plates and similar parametric parts aren't linearly scalable.** When user uploads an SVG that looks like it might be parametric (multiple repeated brace patterns), show an info banner: "If this is a parametric part designed for a specific dimension, regenerate the SVG at the correct size rather than scaling."
9. **Sharp corners + high feed = wiggle.** When feed × acceleration suggests corner overshoot beyond 0.2mm, suggest dropping the feed.
10. **Two-color HDPE cap layers vary by manufacturer.** Default engrave depth 0.3-0.5mm; document range in the material tooltip.
11. **Machine axes can be reversed by physical rewiring.** If the operator reports "moves wrong direction," the fix is `:low` modifier on motor direction_pin — but the tool can't help with config (out of scope). Document this in a troubleshooting section.
12. **Stock origin convention matters.** Always say "front-left corner of stock" in the gcode header, and reinforce in UI with a diagram. Operators have set origin to center of stock, top-left, etc., and run a job designed for front-left = ruined material.
13. **Hole diameter vs bit diameter.** If hole_d < bit_d, fall back to plunge cycle and clearly note this in the generated gcode header.
14. **Air pass before real cut.** Offer a "generate air pass" toggle that produces a separate gcode file identical to the main one but with all Z values offset by +25mm. Lets the operator verify the toolpath in space before any cutting.
15. **Z=0 reference inconsistency.** Always say "Z=0 on top of material" in header; never assume Z=0 is on the spoilboard.

## 15. Stretch Goals / Future Versions

- **Probe support** for surface mapping (auto-Z-leveling per the diagnostic procedure we already use).
- **G2/G3 arc fitting** for circles instead of polyline approximation — produces cleaner toolpaths and smaller files.
- **Adaptive clearing** for pockets (Trochoidal milling) — complex but valuable for deeper aluminum work.
- **DXF input** in addition to SVG.
- **Post-processor selection**: GRBL, FluidNC, Marlin, gSender flavor — most just need different M-codes.
- **Multi-tool jobs**: one SVG, multiple operations, multiple bits, with tool-change pauses between.
- **Cloud preset sync** (login + shared library).
- **Mobile-friendly preview** that lets operator view the toolpath on a phone while at the machine.
- **Direct upload to FluidNC** via the controller's WebUI API (no SD card swap needed).

## 16. File Structure (as shipped)

```
cnc-sign-maker/
├── index.html                     Single-page app
├── css/
│   └── styles.css
├── js/
│   ├── app.js                     Top-level state, event wiring
│   ├── svg-parser.js              Path parsing, tessellation
│   ├── bitmap-tracer.js           Bitmap raster → traced contour geometry
│   ├── text-geometry.js           Typed text + font → sign geometry
│   ├── shapes.js                  Parametric shape library
│   ├── geometry.js                Polygon ops (uses Clipper)
│   ├── toolpath.js                Generates toolpaths per operation
│   ├── gcode-emitter.js           Toolpath → gcode strings
│   ├── preview.js                 Canvas rendering, pan/zoom, drag
│   ├── validation.js              Pre-flight checks
│   ├── presets.js                 API client + LocalStorage autosave
│   ├── workers/
│   │   └── trace-worker.js        Bitmap tracing in a Web Worker
│   └── lib/
│       ├── clipper.js             Vendored Clipper 6.4.2 (Boost license)
│       └── opentype.js            Vendored opentype.js (MIT)
├── img/
│   └── logo.svg
├── api/
│   ├── index.php                  Router
│   ├── bits.php
│   ├── materials.php
│   ├── presets.php
│   ├── jobs.php
│   └── db.php                     SQLite schema, seed data, helpers
├── fonts/                         Bundled open-licensed sign fonts (+ licenses)
├── samples/                       Test SVGs (square, circle, holes plate, text)
├── data/
│   ├── forge.sqlite               Created on first run (gitignored)
│   ├── .htaccess                  Denies direct web access to data
│   └── jobs/                      Saved gcode files (gitignored)
├── install.sh                     Optional initial DB seed + permissions
├── .htaccess                      Root server config (Apache / cPanel)
├── spec.md                        This document
└── README.md
```

## 17. Quality Standards / Testing

For each release, ship with sample jobs that produce known-good gcode. A reference set of (SVG input, expected gcode output) pairs the developer can diff against to catch regressions.

Test SVGs shipped in `samples/`:
- `square.svg` — a simple square (validates basic offsetting and tabs).
- `circle.svg` — a circle (validates G2/G3 arc emission or polyline approximation).
- `holes-plate.svg` — a plate with multiple holes (validates complex geometry with outer profiles, hole-vs-trace classification and drill cycles).
- `text-sign.svg` — a piece of text (validates curve tessellation).

## 18. Out of Scope (v1)

- FluidNC configuration management (use the controller's WebUI).
- Probe-based auto-leveling (covered in stretch goals).
- Real-time gcode streaming (use FluidNC's WebUI).
- 3D / multi-axis output.
- Lathe or laser conversions.
- Account systems / multi-user.
- DXF / DWG input.
- 3D STL slicing.

---

## Appendix A: Glossary

- **DOC**: Depth Of Cut per pass — how far the bit descends each pass during multi-pass operations.
- **Tool offset**: Distance the bit center travels from the part edge to leave a finished surface; equals bit radius plus finishing allowance.
- **Tab**: A small region where the bit lifts during the final pass, leaving a thin material connection that holds the part to the surrounding stock.
- **Engrave**: A shallow centerline cut tracing the line drawing itself, with no compensation.
- **Profile cut**: A through-cut along the outside (or inside) of a closed path with tool radius compensation.
- **Plunge feed**: Z-axis descent speed during initial entry, typically slower than XY cut feed.
- **Chip load**: Material removed per tooth per revolution; key feed-rate sanity check. Computed as `feed_mm/min ÷ (RPM × flute_count)`.
- **Pre-stock height**: A safe Z just above the material (e.g. 2mm) used as a transition between rapids and plunges.

## Appendix B: Standard Job Workflow (for the user-facing help docs)

1. Upload SVG.
2. Select bit (or accept the auto-suggested one based on material).
3. Select material (or accept the auto-suggested DOC and feeds).
4. Choose operation (engrave / pocket / vcarve / profile-out / profile-in / drill).
5. Set final depth and confirm tabs (for profile-out).
6. Position and rotate to fit your stock and machine envelope.
7. Review preview — visually confirm the toolpath, tabs, origin.
8. Click Generate.
9. Download the gcode.
10. Upload to your controller and run a clean air pass first if you've changed anything material.

---

*This spec captures every gotcha I've hit in real CNC work to date. As you build and run jobs, the gotchas list at section 14 will grow — append to it. That section is the most valuable part of this document.*

## 19. Implementation Status

This spec reflects the currently shipped behavior in the repository, including bitmap tracing, workerized tracing with stale-run protection, six operation modes, and the current tab behavior (even placement). The seeded library ships 19 bits, 20 materials and 4 sample presets (see `api/db.php`), and the shape builder offers 20 base shapes plus 6 border variants (see `js/shapes.js`).
