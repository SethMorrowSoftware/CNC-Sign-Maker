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
- PHP 8.1+ with `pdo_mysql` and `mbstring` (neither is compiled in by
  default; both are standard on cPanel). No Composer: nothing here may depend
  on a package manager, because the target host has no shell.
- MySQL 5.7+ / MariaDB 10.3+ for accounts, saved designs, share links and the
  preset/material/bit library. (Through v1 this was SQLite; v2 moved to MySQL
  when the tool became multi-user — see section 20.)
- File I/O for gcode artifacts (optional persistence; primary delivery is download).
- Authentication is hand-rolled on PHP's own primitives — `password_hash`,
  `random_bytes`, `hash_equals`. They are sufficient, and a vendored auth
  library would violate the no-package-manager constraint above.

**Geometry libraries:**
- Client-side: a polygon offsetting library is mandatory. Recommended: a JS port of the Clipper library (e.g. `clipper-lib` or `polygon-clipping`). Hand-rolling polygon offset is a trap — corners and self-intersections are non-trivial.
- SVG path parsing: write a small parser for `M / L / H / V / C / S / Q / T / A / Z` commands. Treat curves by tessellating into line segments at a controllable tolerance (default 0.1mm).

**Why this stack:** Vanilla JS keeps the project alive across years without framework churn. PHP is the lowest-friction backend for a hobbyist-grade web app on a shared host. MySQL is the one database every shared-hosting plan already provides a control panel for, and unlike SQLite it does not depend on file locking over NFS home directories.

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
                │ HTTP (only for persistence — never for geometry)
                ↓
┌─────────────────────────────────────────────────────────────────┐
│                            PHP                                  │
│  /api/auth  /api/designs  /api/shared  /api/invites  /api/users │
│  /api/presets  /api/materials  /api/bits  /api/jobs/save        │
│                            ↓                                    │
│                          MySQL                                  │
│   users · sessions · invites · designs · design_assets ·        │
│   design_shares · bits · materials · presets · jobs             │
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
2. **Resolve units.** SVG can specify `width="800mm"`, `width="800"` (units depend on viewBox), or pixel sizes. Compute the SVG-unit to mm ratio at the root and apply to all coordinates. Unit suffix is matched case-insensitively (`100MM`, `5IN` parse the same as `100mm`, `5in`).
3. **Honour `preserveAspectRatio`** on the root `<svg>` (default `xMidYMid meet` — uniform scale with centering). Non-uniform `width`/`height` against `viewBox` no longer silently stretches geometry.
4. **Tessellate curves.** Convert `C / S / Q / T / A` segments to line segments at a configurable chord-tolerance (default 0.1mm). Degenerate cubics with coincident endpoints are detected and treated as flat — without this guard, self-returning curves (legal SVG) recurse to depth 24 and produce ~33M points.
5. **Resolve `<use>` references.** Including `<use>` of `<symbol>` (which is otherwise skipped), with `width`/`height` overrides that scale the instance against the symbol's viewBox.
6. **CSS hidden classes.** Parse `<style>` blocks for `.classname{display:none}` / `visibility:hidden` rules and skip elements whose `class` attribute matches.
7. **Identify closed subpaths.** A subpath ending in `Z` is a closed polygon. Open paths whose last vertex lies within 0.01 mm of the first are promoted to closed automatically (many hand-made SVGs omit the `Z`).
8. **Classify each subpath** as one of:
   - **Hole** (small closed polygon, e.g. bolt-clearance hole) — flag by user-settable area threshold (default <50mm²).
   - **Outer profile** (large closed polygon).
   - **Open curve / engraving line** (not closed).
9. **Winding-order detection.** Determine if each polygon is CW or CCW. Holes inside outer profiles must have opposite winding from their parent (per SVG even-odd or non-zero fill rules).
10. **Bounding box.** Compute overall and per-subpath bounding boxes for centering / scaling.

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
- Bit traces the path centerline. Multi-pass when `|finalDepth| > DOC` — steps from 0 down to final depth in DOC increments. Shallow engraves stay single-pass.
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
- **Circularity check first**: only features that are approximately circular (≥ 8 vertices, polygon area within 5% of the equivalent circle's area, and max radial deviation < 8% of mean radius) get a drill cycle. Non-circular small features (squares, irregular blobs) fall back to **profile-in** so the cutter follows the actual shape — drilling a square as a circle would cut a circle ~41% larger than the square's inscribed radius. The operator can override by setting an explicit *target hole diameter*.
- For circular features where `bit_diameter > hole_diameter`: pecked plunge cycle at the hole center (creates oversized hole). Retract above the stock surface between pecks so chips clear.
- For circular features where `bit_diameter < hole_diameter`: bit plunges at center, traces a circle at radius `(hole_d/2 - bit_r)`, returns. Multi-depth with chip-clearing retract above stock between every depth pass.
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
| Tab thickness (mm) | float | 1.5 | Material left under the bit at the tab. When the material thickness is known (selected from the library) **and** the cut goes through it, tab Z anchors to the material bottom so this number is the actual remaining tab. Without material info, the formula falls back to "raise the bit `tabThickness` mm above `finalDepth`" — which can produce a thinner tab when the cut overshoots into the spoilboard. |
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
M5                                  ; spindle off BEFORE parking (no-op on
                                    ;  the Makita, but safe for VFD setups)
G0 X0 Y0
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
depths = compute_pass_depths(final_z, doc)  ; same logic as profile-out
for each subpath:
    G0 X{first}, G0 Z{safe}, G0 Z{pre-stock}
    for depth in depths:
        if open subpath and not first pass:
            G0 Z{pre-stock}, G0 X{first}    ; rapid back to start
        plunge from current Z to depth (honours peck/helical)
        for each subsequent point:
            G1 X Y F{cut} Z{depth}
        if closed: G1 X{first} Y{first} F{cut} Z{depth}
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
if not is_approximately_circular(subpath) and no target hole diameter:
    # cutting a square as a circle would gouge corners — fall back
    return profile_in(subpath)

hpr = (hole_d/2) - bit_r  ; can be near-zero or negative for oversized hole
if hpr <= 0.05:
    # bit at least as wide as hole — peck-plunge in place
    G0 X{center}, G0 Z{safe}, G0 Z{pre-stock}
    for depth in depths:
        if not first pass:
            G0 Z{pre-stock}          ; retract above stock for chip clearing
            G0 Z{prev_depth + 0.5}   ; rapid back into cleared hole
        descend to depth (honours peck plunge style)
    G0 Z{safe}
else:
    # trace a circle inside the hole
    G0 X{center}, G0 Z{safe}, G0 Z{pre-stock}
    for depth in depths:
        if not first pass:
            G0 Z{pre-stock}          ; retract above stock
            G0 Z{prev_depth + 0.5}   ; rapid back into cleared circle
        descend to depth (honours peck)
        G1 X{center+hpr} Y{center} F{cut}
        G2 X{center+hpr} Y{center} I{-hpr} J0 F{cut}
        G1 X{center} Y{center} F{cut}
    G0 Z{safe}
```

Peck retracts inside `descend()` always rise above the stock surface
(`max(preStockZ, fromZ)`), not back to wherever the plunge started — so chips
clear even when the descent begins deep inside an existing hole on pass 2+.

## 10. Validation & Safety Checks (run before allowing download)

**Blocking (error level — gcode generation refused):**

| Check | Action |
|---|---|
| `finalDepth >= 0` | Block — would drive bit upward into spindle / cut nothing |
| `safeZ <= 0` | Block — bit drags during rapids |
| `|reachDepth| + max(2, safeZ) >= bit.cutting_length` | Block — shank rubs at retract |
| Geometry fits within machine envelope | Block; show overlap on canvas |
| Toolpath has negative X/Y on `bottom-left` origin | Block — LowRider work area is positive-only |
| HDPE + multi-flute bit | Block — multi-flute melts HDPE |
| V-carve without a V-bit + valid included angle | Block |
| Tab thickness `< 1mm` | Block — tabs snap mid-cut |

**Warnings (advisory):**

| Check | Action |
|---|---|
| `docPerPass > bit.diameter_mm` (non-engrave/v-carve) | Warn — chip load risk |
| `feedPlunge > feedCut` | Warn — plunge is hardest move |
| O-flute-recommended material + multi-flute bit | Warn — generalises the HDPE/acrylic rule |
| V-bit on profile-out / profile-in / pocket / drill | Warn — no flutes along depth |
| Chip load outside 0.05–0.30 mm window | Warn |
| Per-plunge depth > `max(3, bit.diameter_mm * 3)` mm with `plungeStyle = straight` | Warn — suggest peck/helical |
| Stock margin ≤ tool offset on profile-out | Warn; offer fix (suppressed if fix would exceed envelope) |
| Through-cut depth shallower than material or much deeper than (thickness + overage) | Info / warn (profile-out only) |
| Hole diameter ≤ bit diameter on a drill feature | Warn; oversized hole noted in gcode header |
| Non-circular small feature on drill op | Info — auto-fallback to profile-in |
| Tabs above 2 mm thick | Warn — flush-trim cleanup needed |
| `tabThickness >= |finalDepth|` | Warn — tabs aren't cut into |
| `preStockZ >= safeZ` | Warn — pre-stock should be the smaller of the two |
| Multiple closed contours overlap | Warn — manual review needed |
| Machine envelope X/Y mismatch with SVG orientation | Suggest 90° rotation |
| Bitmap trace > 30k nodes | Info — cut may be slow |
| Bitmap trace > 120k nodes | Warn — preview and cut will be slow |
| Spindle RPM far from material recommendation | Info |

## 11. Data Model (MySQL)

Column widths are deliberate: anything carrying an index is at most
`VARCHAR(190)`, because utf8mb4 costs 4 bytes per character and MySQL 5.7 /
MariaDB caps an index prefix at 767 bytes. `owner_id` is a plain column rather
than a foreign key on the library tables so that owner **0** — the built-in,
read-only library shipped with the tool — can exist with no matching `users`
row. See section 20 for the ownership rules.

```sql
CREATE TABLE users (
    id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    email         VARCHAR(190) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,     -- password_hash(), bcrypt
    display_name  VARCHAR(120) NOT NULL,
    role          VARCHAR(16)  NOT NULL DEFAULT 'user',   -- 'user' | 'admin'
    disabled      TINYINT(1)   NOT NULL DEFAULT 0,
    created_at    INT UNSIGNED NOT NULL,
    updated_at    INT UNSIGNED NOT NULL,
    last_login_at INT UNSIGNED NULL,
    UNIQUE KEY uq_users_email (email)
);

-- Sessions live here, not in PHP's session storage: on shared hosting that is
-- often a /tmp readable by every account on the box. Only the SHA-256 of the
-- cookie's token is stored, so a database read cannot be replayed as a login.
CREATE TABLE sessions (
    token_hash   CHAR(64) PRIMARY KEY,
    user_id      INT UNSIGNED NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token   CHAR(43) NOT NULL,
    created_at   INT UNSIGNED NOT NULL,
    last_seen_at INT UNSIGNED NOT NULL,
    expires_at   INT UNSIGNED NOT NULL,
    user_agent   VARCHAR(255) NULL,
    ip           VARCHAR(45)  NULL
);

CREATE TABLE invites (
    id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    token      VARCHAR(64)  NOT NULL,
    email      VARCHAR(190) NULL,      -- when set, only this address may use it
    role       VARCHAR(16)  NOT NULL DEFAULT 'user',
    note       VARCHAR(255) NULL,
    created_by INT UNSIGNED NULL,
    created_at INT UNSIGNED NOT NULL,
    expires_at INT UNSIGNED NULL,
    used_at    INT UNSIGNED NULL,
    used_by    INT UNSIGNED NULL,
    revoked_at INT UNSIGNED NULL,
    UNIQUE KEY uq_invites_token (token)
);

-- Failed-login throttle, one row per bucket ("login:ip:…" / "login:email:…"),
-- so brute-force protection needs no Redis.
CREATE TABLE auth_throttle (
    bucket       VARCHAR(190) PRIMARY KEY,
    attempts     INT UNSIGNED NOT NULL DEFAULT 0,
    first_at     INT UNSIGNED NOT NULL,
    last_at      INT UNSIGNED NOT NULL,
    locked_until INT UNSIGNED NULL
);

CREATE TABLE bits (
    id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    owner_id          INT UNSIGNED NOT NULL DEFAULT 0,   -- 0 = built-in library
    name              VARCHAR(190) NOT NULL,
    diameter_mm       DOUBLE NOT NULL,
    shank_diameter_mm DOUBLE NULL,
    flute_count       INT NOT NULL DEFAULT 2,
    cutting_length_mm DOUBLE NULL,
    type              VARCHAR(32) NOT NULL DEFAULT 'upcut',
    v_angle_deg       DOUBLE NULL,
    notes             TEXT NULL,
    UNIQUE KEY uq_bits_owner_name (owner_id, name)
);

CREATE TABLE materials (
    id                      INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    owner_id                INT UNSIGNED NOT NULL DEFAULT 0,
    name                    VARCHAR(190) NOT NULL,
    thickness_mm            DOUBLE NULL,
    recommended_bit_type    VARCHAR(32) NULL,
    recommended_rpm         INT NULL,
    recommended_feed_cut    INT NULL,
    recommended_feed_plunge INT NULL,
    recommended_doc_mm      DOUBLE NULL,
    through_cut_overage_mm  DOUBLE NULL DEFAULT 0.65,
    notes                   TEXT NULL,
    UNIQUE KEY uq_materials_owner_name (owner_id, name)
);

-- Machining settings only. UNIQUE is on (owner_id, name), not name: through
-- v1 "Save preset" upserted by name globally, so with two accounts one user
-- saving "My preset" silently overwrote the other's.
CREATE TABLE presets (
    id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    owner_id      INT UNSIGNED NOT NULL DEFAULT 0,
    name          VARCHAR(190) NOT NULL,
    bit_id        INT UNSIGNED NULL REFERENCES bits(id) ON DELETE SET NULL,
    material_id   INT UNSIGNED NULL REFERENCES materials(id) ON DELETE SET NULL,
    operation     VARCHAR(32) NOT NULL,
    settings_json MEDIUMTEXT NOT NULL,
    created_at    INT UNSIGNED NULL,
    updated_at    INT UNSIGNED NULL,
    UNIQUE KEY uq_presets_owner_name (owner_id, name)
);

-- The whole working document: settings plus the artwork needed to rebuild
-- identical geometry. The heavy bytes live in design_assets so that listing
-- "My designs" never drags megabytes across the wire.
CREATE TABLE designs (
    id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    owner_id      INT UNSIGNED NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          VARCHAR(190) NOT NULL,
    input_mode    VARCHAR(16) NOT NULL DEFAULT 'text',   -- text | svg | bitmap
    operation     VARCHAR(32) NOT NULL DEFAULT 'engrave',
    bit_id        INT UNSIGNED NULL,
    material_id   INT UNSIGNED NULL,
    settings_json MEDIUMTEXT NOT NULL,
    svg_hash      VARCHAR(64) NULL,
    notes         TEXT NULL,
    copied_from   INT UNSIGNED NULL,
    created_at    INT UNSIGNED NOT NULL,
    updated_at    INT UNSIGNED NOT NULL,
    UNIQUE KEY uq_designs_owner_name (owner_id, name),
    KEY idx_designs_owner_updated (owner_id, updated_at)
);

-- kind: 'svg' (source text), 'bitmap' (the original image bytes) or 'font'
-- (an uploaded face). LONGBLOB, not LONGTEXT: two of the three are binary.
CREATE TABLE design_assets (
    id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    design_id  INT UNSIGNED NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
    kind       VARCHAR(16)  NOT NULL,
    asset_key  VARCHAR(190) NULL,      -- the settings.fontKey a font restores as
    filename   VARCHAR(255) NULL,
    mime       VARCHAR(100) NULL,
    byte_size  INT UNSIGNED NOT NULL DEFAULT 0,
    sha256     CHAR(64) NULL,
    data       LONGBLOB NOT NULL,
    created_at INT UNSIGNED NOT NULL,
    UNIQUE KEY uq_assets_design_kind (design_id, kind)
);

CREATE TABLE design_shares (
    id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    design_id      INT UNSIGNED NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
    token          VARCHAR(64) NOT NULL,   -- 43 chars of base64url over 32 bytes
    created_by     INT UNSIGNED NULL,
    created_at     INT UNSIGNED NOT NULL,
    expires_at     INT UNSIGNED NULL,
    revoked_at     INT UNSIGNED NULL,
    view_count     INT UNSIGNED NOT NULL DEFAULT 0,
    last_viewed_at INT UNSIGNED NULL,
    UNIQUE KEY uq_shares_token (token)
);

CREATE TABLE jobs (
    id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    owner_id      INT UNSIGNED NOT NULL DEFAULT 0,
    filename      VARCHAR(255) NOT NULL,
    preset_id     INT UNSIGNED NULL REFERENCES presets(id) ON DELETE SET NULL,
    design_id     INT UNSIGNED NULL REFERENCES designs(id) ON DELETE SET NULL,
    svg_hash      VARCHAR(64) NULL,
    gcode_path    VARCHAR(255) NULL,   -- file under data/jobs, not a blob
    settings_json MEDIUMTEXT NOT NULL,
    created_at    INT UNSIGNED NULL
);

CREATE TABLE meta (
    `key`   VARCHAR(64) PRIMARY KEY,
    `value` TEXT
);
```

The schema is created lazily by `forge_init_schema()` on the first request, and
`forge_migrate()` applies additive changes after probing `information_schema`,
so both are safe to run on every request. That is not elegance for its own
sake: the target host has no shell and no migration runner.

## 12. PHP API Surface

Most work is client-side; the API is persistence only.

```
GET  /api/health              → { ok, version, php }   no auth, no database

POST /api/auth/register       → invite token, or the first account on a fresh DB
POST /api/auth/login          → { user, csrf }
POST /api/auth/logout
GET  /api/auth/me             → { user|null, csrf, bootstrap, version }
POST /api/auth/password       → change own password (ends other sessions)
POST /api/auth/profile        → change own display name

GET  /api/invites             → admin: list
POST /api/invites             → admin: mint an invite link
GET  /api/invites/check       → public: is this token still usable?
DELETE /api/invites/:id       → admin: revoke
GET  /api/users               → admin: list accounts
PUT  /api/users/:id           → admin: role / disabled

GET  /api/designs             → my designs (metadata only, no artwork bytes)
POST /api/designs             → create
GET  /api/designs/:id         → full design incl. base64 assets
PUT  /api/designs/:id         → partial save; omitted fields keep their value
DELETE /api/designs/:id       → also revokes every share link to it
POST /api/designs/:id/copy    → duplicate one of my own
GET  /api/designs/:id/shares  → the links on this design
POST /api/designs/:id/shares  → mint one
DELETE /api/shares/:id        → revoke one
GET  /api/shared/:token       → public read-only view of a shared design
POST /api/shared/:token/copy  → fork it into my account (needs an account)

GET  /api/bits           → built-in library + mine
POST /api/bits           → create (mine)
PUT  /api/bits/:id       → update mine; editing a built-in forks it (201)
DELETE /api/bits/:id     → delete mine; a built-in is 403

GET  /api/materials      → as bits
POST /api/materials
PUT  /api/materials/:id
DELETE /api/materials/:id

GET  /api/presets        → built-in + mine
POST /api/presets        → upsert on (owner_id, name)
DELETE /api/presets/:id

POST /api/jobs/save      → persist a generated gcode file
GET  /api/jobs           → my saved jobs
GET  /api/jobs/:id       → download (ownership checked before a byte is read)
DELETE /api/jobs/:id
```

All responses are JSON. Routing travels in `?r=` because `PATH_INFO` is not
reliably populated on shared cPanel PHP-FPM / CGI setups.

**Authorisation is per-handler, not blanket.** Reading the library, checking
health and opening a share link all work signed out, because the tool is usable
anonymously and only persistence needs an account. Every handler that writes
calls `forge_require_user()` and `forge_require_csrf()` itself.

A resource addressed by id rejects a non-numeric second segment outright rather
than falling through to the collection listing, so `designs/1 OR 1=1` and
`jobs/../../etc/passwd` are 404s rather than successful listings. (Neither was
ever unsafe — ids are bound parameters and job paths go through `basename()` —
but answering a malformed request with a successful listing hides real bugs.)

Somebody else's row answers **404**, never 403: a 403 would confirm the id
exists, letting anyone walk the id space to count what an install holds.

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
7. **Bit cutting length limits depth.** Validate `abs(final_z) <= bit.cutting_length` (error past it, warning within 1 mm of it). The flute length limits engagement *in the material*; Safe Z is a rapid height above the stock and must not be added to the comparison — doing so falsely blocks shallow V-carves and engraves with short-flute bits (a 10 mm-flute V-bit cutting 2 mm deep is fine at any Safe Z).
8. **Strut plates and similar parametric parts aren't linearly scalable.** When user uploads an SVG that looks like it might be parametric (multiple repeated brace patterns), show an info banner: "If this is a parametric part designed for a specific dimension, regenerate the SVG at the correct size rather than scaling."
9. **Sharp corners + high feed = wiggle.** When feed × acceleration suggests corner overshoot beyond 0.2mm, suggest dropping the feed.
10. **Two-color HDPE cap layers vary by manufacturer.** Default engrave depth 0.3-0.5mm; document range in the material tooltip.
11. **Machine axes can be reversed by physical rewiring.** If the operator reports "moves wrong direction," the fix is `:low` modifier on motor direction_pin — but the tool can't help with config (out of scope). Document this in a troubleshooting section.
12. **Stock origin convention matters.** Always say "front-left corner of stock" in the gcode header, and reinforce in UI with a diagram. Operators have set origin to center of stock, top-left, etc., and run a job designed for front-left = ruined material.
13. **Hole diameter vs bit diameter.** If hole_d < bit_d, fall back to plunge cycle and clearly note this in the generated gcode header.
14. **Air pass before real cut.** Offer a "generate air pass" toggle that produces a separate gcode file identical to the main one but with all Z values offset by +25mm. Lets the operator verify the toolpath in space before any cutting.
15. **Z=0 reference inconsistency.** Always say "Z=0 on top of material" in header; never assume Z=0 is on the spoilboard.
16. **Tab thickness vs through-cut overage.** "Tab thickness" must mean *material remaining under the bit*, not *bit rise above final depth*. With a 0.65 mm spoilboard overage on a 6.35 mm material, a 1.5 mm "tab thickness" using the naive `tabZ = finalDepth + tabThickness` formula leaves only 0.85 mm of actual material — under the validator's 1 mm minimum and prone to snapping. When material thickness is known, anchor tab Z to the material bottom.
17. **Drill non-circular features.** A small square classified as a "hole" by area would, without a circularity check, be drilled as a circle ~41% larger than its inscribed radius — gouging past every corner. Verify circularity (polygon-vs-circle area ratio and radial uniformity) before drilling; fall back to profile-in for non-circular features.
18. **Engrave depth.** A "single shallow depth" engrave is fine for 0.5–3 mm; for anything deeper, step in DOC increments like every other op. A 5 mm engrave plunged in one move on a small bit will snap the cutter.
19. **Peck retract destination.** On multi-pass drilling, the peck-retract must rise *above the stock surface*, not back to wherever `fromZ` was. Pass 2 starts inside the existing hole — retracting to that fromZ leaves the bit in its own chips.
20. **Spindle-off timing in the footer.** Emit `M5` *before* the rapid back to `X0 Y0`. With a manual Makita it's a no-op; with a wired VFD, keeping the spindle on through the parking move risks dragging a spinning bit across freshly cut work if Safe Z is mis-set.
21. **Safe Z is part of bit reach.** The shank must clear the work at retract, not just the cutting tip. Validate `|final_z| + max(2, safeZ) < bit.cutting_length`.
22. **SVG self-returning cubics.** A cubic Bezier with `p0 == p3` (legal SVG, common in stylized blobs) fails any non-zero flatness test by ratio. Detect zero-chord curves and bound the recursion depth — otherwise 2²⁵ ≈ 33M points get generated and the browser hangs.
23. **SVG viewport aspect handling.** Default `preserveAspectRatio` is uniform with centering. Applying independent X/Y scales when viewport aspect differs from viewBox aspect cuts physically wrong-sized parts.

## 15. Stretch Goals / Future Versions

- **Probe support** for surface mapping (auto-Z-leveling per the diagnostic procedure we already use).
- **G2/G3 arc fitting** for circles instead of polyline approximation — produces cleaner toolpaths and smaller files.
- **Adaptive clearing** for pockets (Trochoidal milling) — complex but valuable for deeper aluminum work.
- **DXF input** in addition to SVG.
- **Post-processor selection**: GRBL, FluidNC, Marlin, gSender flavor — most just need different M-codes.
- **Multi-tool jobs**: one SVG, multiple operations, multiple bits, with tool-change pauses between.
- ~~**Cloud preset sync** (login + shared library).~~ **Delivered in v2.0** —
  see section 20. Accounts, per-user libraries, saved designs and share links.
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
│   ├── account.js                 Sign-in / register, account menu, admin panel
│   ├── designs.js                 Saved designs, share dialog, read-only banner
│   ├── ui.js                      Shared DOM helpers, modals, base64
│   ├── svg-parser.js              Path parsing, tessellation
│   ├── bitmap-tracer.js           Bitmap raster → traced contour geometry
│   ├── text-geometry.js           Typed text + font → sign geometry
│   ├── shapes.js                  Parametric shape library
│   ├── geometry.js                Polygon ops (uses Clipper)
│   ├── toolpath.js                Generates toolpaths per operation
│   ├── gcode-emitter.js           Toolpath → gcode strings
│   ├── preview.js                 Canvas rendering, pan/zoom, drag
│   ├── validation.js              Pre-flight checks
│   ├── presets.js                 API client + LocalStorage autosave (all resources)
│   ├── workers/
│   │   └── trace-worker.js        Bitmap tracing in a Web Worker
│   └── lib/
│       ├── clipper.js             Vendored Clipper 6.4.2 (Boost license)
│       └── opentype.js            Vendored opentype.js (MIT)
├── img/
│   └── logo.svg
├── api/
│   ├── index.php                  Router
│   ├── config.php                 MySQL credentials (gitignored)
│   ├── config.sample.php          Template for the above
│   ├── auth.php                   Sessions, CSRF, registration, login throttle
│   ├── invites.php                Invite links + the admin user list
│   ├── designs.php                Saved designs, artwork assets, share links
│   ├── bits.php
│   ├── materials.php
│   ├── presets.php
│   ├── jobs.php
│   └── db.php                     MySQL schema, migrations, seed data, helpers
├── tools/
│   ├── create-admin.php           Create / promote / reset an admin (CLI only)
│   ├── migrate-sqlite-to-mysql.php  One-shot 1.x import (CLI only)
│   └── .htaccess                  Denies web access to the CLI scripts
├── fonts/                         Bundled open-licensed sign fonts (+ licenses)
├── samples/                       Test SVGs (square, circle, holes plate, text)
├── data/
│   ├── .htaccess                  Denies direct web access to data
│   └── jobs/                      Saved gcode files (gitignored)
├── install.sh                     Schema creation + seed + permissions
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

(Account systems and multi-user were listed here through v1 and were delivered
in v2.0; see section 20. Everything below remains out of scope.)

- FluidNC configuration management (use the controller's WebUI).
- Probe-based auto-leveling (covered in stretch goals).
- Real-time gcode streaming (use FluidNC's WebUI).
- 3D / multi-axis output.
- Lathe or laser conversions.
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

**v2.0** added accounts, MySQL-backed saved designs and share links; section 20
describes that work and supersedes the multi-user exclusion in section 18.
Sections 1-18 below describe the geometry and gcode tool, which v2.0 did not
change.

This spec reflects the currently shipped behavior in the repository, including bitmap tracing, workerized tracing (via `importScripts` of `bitmap-tracer.js` so the algorithm lives in one file) with stale-run protection, six operation modes, and the current tab behavior (even placement, material-aware Z anchoring on through-cuts). The seeded library ships 19 bits, 20 materials and 4 sample presets (see `api/db.php`), and the shape builder offers 22 base shapes plus 6 border variants (see `js/shapes.js`).

### Recent hardening pass (post-audit)

A pre-flight audit before live use surfaced several correctness issues that the current code now fixes:

- **Tab Z on through-cuts** now anchors to the material bottom when the material thickness is known, so the *Tab thickness* setting equals the actual remaining material — the shipped plywood preset used to produce 0.85 mm tabs while the UI said 1.5 mm.
- **Peck drilling** retracts above the stock surface between every peck and every depth pass, then rapids back down through the cleared hole — proper G73-style chip clearing on multi-pass drills.
- **Non-circular drill features** fall back to profile-in instead of being cut as oversized circles (a square classified as a "hole" by area would otherwise be cut as a circle ~41% larger than the design).
- **Engrave** steps in DOC increments like every other operation; shallow engraves stay single-pass.
- **SVG degenerate cubic Beziers** (legal self-returning curves) no longer trigger a 33 M-point recursion that hung the browser.
- **`<use>` of `<symbol>`** now produces geometry (was silently skipped); `<use width/height>` on a viewBox'd target scales the instance correctly.
- **SVG `preserveAspectRatio`** is honoured — the parser used to stretch viewport-resized files.
- **Footer order**: `M5` emits before the parking rapid so a VFD-controlled spindle (if ever wired) doesn't spin through the return move.
- **Validation severity** corrected: `finalDepth >= 0` is now an error; `safeZ <= 0` blocks; the bit cutting-length check compares flute length against cut depth alone (adding Safe Z falsely blocked short-flute V-bits); the through-cut depth check no longer fires (false positive) on profile-in.
- **New validation warnings**: DOC > bit diameter, plunge feed > cut feed, V-bit on a non-V-carve op, O-flute-recommended material with a multi-flute bit (generalises the HDPE/acrylic rule), spindle RPM vs material recommendation.

---

## 20. Accounts, Designs and Sharing (v2.0)

Sections 1-19 describe the single-operator tool. This section describes what
v2.0 added: accounts, per-user storage of whole designs in MySQL, and
read-only share links. It supersedes the "Account systems / multi-user" line
that stood in section 18, and delivers the "Cloud preset sync (login + shared
library)" item from section 15.

### 20.1 The governing constraint

The tool is usable **signed out**. Geometry, toolpaths, validation, the preview
and gcode download all run in the browser and never needed the server; section
3 calls that the critical design decision, and a login wall would throw it
away. So authentication gates *persistence*, not *use*:

| Signed out | Signed in |
|---|---|
| Everything in sections 4-10: artwork, toolpaths, preview, validation, gcode download | plus saved designs, share links, saved gcode, and a private bit/material library |
| Read the built-in library (19 bits, 20 materials, 4 presets) | plus your own rows on top of it |

### 20.2 Designs versus presets

A **preset** (section 6.3) is machining settings. A **design** is the whole
working document: the settings **plus the artwork source**.

The distinction is forced by determinism. The pipeline in section 3 is a pure
function of its inputs, so a design reopened a year later emits identical gcode
— but only if every input returns exactly as it went in. Through v1 nothing
persisted the artwork at all: `state.svgText`, the traced bitmap and any
uploaded font lived only in the tab that loaded them, and the LocalStorage
autosave carried `{settings, bitId, materialId}` and nothing else.

A design therefore stores, per input mode:

| Mode | What must travel with it |
|---|---|
| `text` | settings alone — **unless** the sign uses an uploaded font, whose bytes must be stored or the text re-lays out in a fallback face and cuts a different shape |
| `svg` | the SVG source text (up to 4 MB) |
| `bitmap` | the original image bytes (up to 8 MB), so the same trace parameters produce the same contours |

The uploaded-font case is the one that matters most and is the least obvious:
losing it fails **silently**, with a plausible-looking sign of the wrong
dimensions. `settings.fontKey` is stored alongside the font bytes and the face
is re-registered under the same key before the settings are applied, so the key
resolves rather than falling back.

A related trap the same work exposed: the controller cached the loaded font
without recording *which* font it was, so applying any settings that changed
`fontKey` — a design **or a preset** — re-laid the text in the previously
loaded face. `state.fontKeyLoaded` now gates that.

### 20.3 Ownership rules

`owner_id` **0** is the built-in library shipped with the tool: readable by
every account, editable by none. A non-zero `owner_id` is a private row.

- **Editing a built-in bit or material forks it** into a private copy named
  `… (mine)` and returns 201 with `forked_from`, rather than refusing the edit
  or changing a row that other accounts' presets depend on.
- Deleting a built-in is a 403 that says why.
- `UNIQUE(owner_id, name)` replaces `UNIQUE(name)` throughout. This is not
  cosmetic: preset save is an upsert keyed on that constraint, so under the old
  schema one account saving "My preset" silently overwrote another's.
- A design name that collides is **suffixed**, not rejected — a copy has to go
  somewhere.

### 20.4 Sharing

A share link is 32 random bytes, base64url, in `?share=…`. It opens the design
in the normal editor marked read-only: full preview, full gcode download, no
write access to the original. A signed-in viewer can fork it with
`POST /api/shared/:token/copy`, which duplicates the row and its assets
**server-side** rather than pushing megabytes back up through the browser.

- Links carry an optional expiry and can be revoked; deleting a design cascades
  its links away.
- Revoked, expired and never-existed all answer the same opaque 404, so probing
  cannot distinguish a token that was once real.
- The token is stripped from the address bar on load, so it is not bookmarked
  or sent as a `Referer` to the font CDN (the catalogue fetches 24 of its 30
  faces from `raw.githubusercontent.com`).
- Tokens are stored in the clear so an owner can copy a link again later. A
  database read therefore exposes live links — but that same read already
  exposes the designs, so it widens nothing that matters.
- A shared design names a `bit_id` and `material_id` the recipient may not
  have. The client warns explicitly when either fails to resolve: cutting with
  a silently substituted tool is exactly what section 10 exists to prevent.

### 20.5 Registration and roles

Invite-only. An administrator mints a single-use token, optionally pinned to an
email address and with an expiry, and sends the link. Nothing sends mail:
shared hosts block or drop PHP `mail()` often enough that depending on it would
strand users at a wall.

The bootstrap exception is the first account on an empty `users` table, which
becomes the administrator. Two racing registrations cannot both win it — the
claim is an `INSERT IGNORE` of a sentinel key in `meta`, inside the same
transaction as the user insert, so a later failure rolls the claim back too.

Accounts are **disabled, never deleted**: designs, presets and jobs hang off the
user id, and deleting the row would cascade away every design that user shared.
The last active administrator cannot be demoted or disabled.

### 20.6 Session and CSRF design

Sessions live in a table, not in PHP's session storage, because on shared
hosting the default save path is frequently a `/tmp` readable by every account
on the box. The cookie holds a random token; the row stores only its SHA-256.

Three layers guard state-changing requests, in order of what they cover:
`SameSite=Lax` (blocks a cross-site form POST), the JSON-only content type
(forces a CORS preflight for a cross-origin XHR), and an `X-Forge-CSRF` header
carrying the session's token (covers the contexts where `SameSite` is not
honoured). The header costs one line in the client's `request()` wrapper.

Failed sign-ins are throttled per email, and per IP at six times that
threshold — a whole shop shares one public address, so an IP bucket tight
enough to police one person's typing would let them lock out everybody else.

### 20.7 Why MySQL

SQLite was the right call for a single-operator tool and the wrong one here.
cPanel home directories are usually NFS-backed, which is why v1 had to avoid
WAL mode (see the note in `api/db.php`); concurrent writers on a rollback
journal over NFS is not a foundation for a multi-user service. MySQL is also
the one database every shared-hosting plan already provides a control panel
for.

The port is not mechanical. Each of these was a real behaviour change, not a
syntax swap:

| SQLite | MySQL | Consequence |
|---|---|---|
| `INTEGER PRIMARY KEY` | `AUTO_INCREMENT` | — |
| `INSERT OR IGNORE` | `INSERT IGNORE` | — |
| `ON CONFLICT(x) DO UPDATE … excluded.y` | `ON DUPLICATE KEY UPDATE … VALUES(y)` | — |
| `PRAGMA table_info()` | `information_schema.columns` | migration probing |
| `TEXT UNIQUE` | illegal without a prefix length | every indexed name became `VARCHAR(190)` — utf8mb4 is 4 bytes/char against a 767-byte prefix cap |
| `TEXT` holds anything | `TEXT` caps at 64 KB | a design carrying a 4 MB SVG needs `MEDIUMTEXT`/`LONGBLOB` |
| `UNIQUE TEXT` is case-**sensitive** | default collation is case-**insensitive** | names differing only in case now collide — correct for emails, a behaviour change for library names |
| loose typing | `STRICT_ALL_TABLES` | an over-long name aborts the insert instead of being silently cut, so callers clamp first |
| named parameters may repeat | native prepares reject a repeated name | `VALUES (…, :now, :now)` had to become two placeholders |

That last one only surfaces with `PDO::ATTR_EMULATE_PREPARES => false`, which
this codebase sets so multi-megabyte design payloads are not re-quoted through
the client.

`tools/migrate-sqlite-to-mysql.php` carries a 1.x database across. It compares
values rather than just names: a row identical to a shipped one is skipped as
seed data, and a row that **differs** — a seeded bit whose cutting length the
shop corrected — is imported under a `… (imported)` name instead of being
silently dropped. Preset references are re-bound by name, because ids are
renumbered by the move.

### 20.8 XSS

Through v1 this barely mattered — every DOM write already went through a
`textContent` helper. It matters now: a design name and a display name written
by one account are rendered in another's browser, which makes that discipline
load-bearing. `js/ui.js`, `js/account.js` and `js/designs.js` build DOM with
`createElement` and `textContent` throughout, and no new `innerHTML` write
takes interpolated data. Keep it that way.
