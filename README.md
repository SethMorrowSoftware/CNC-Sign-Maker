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
backend stores accounts, saved designs, bits, materials, presets and
(optionally) finished gcode, so the core of the tool keeps working even signed
out or when the backend is unreachable.

Since **v2.0** the tool is multi-user: sign in to save a whole design — artwork
included — to a MySQL database, keep a private bit and material library, and
hand someone a **share link** that opens the design read-only in their browser.
Everything still works without an account; an account is what makes it
persist.

---

## Contents

- [Highlights](#highlights)
- [Requirements](#requirements)
- [Install](#install)
- [Upgrading from 1.x](#upgrading-from-1x)
- [Accounts, designs and sharing](#accounts-designs-and-sharing)
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
- **Material &amp; bit library** — a seeded sign-shop starter set shared by every
  account, plus your own private bits and materials. Editing a built-in one
  makes you a private copy rather than changing it for everybody.
- **Saved designs** — the whole document, not just the settings: the uploaded
  SVG, the traced bitmap, even an uploaded font travel with it, so reopening a
  design a year later produces byte-for-byte the same gcode.
- **Share links** — hand someone an unguessable URL. They see the design
  read-only, can preview and download gcode from it, and can save a copy of
  their own if they have an account. Revoke the link at any time.
- **Invite-only accounts** — the first person to register becomes the
  administrator and invites everyone else. No public sign-up form.
- **Self-hosted, no build step** — vanilla HTML/CSS/JavaScript plus a tiny
  PHP&nbsp;+&nbsp;MySQL backend. No framework, no package manager, no compile.

## Requirements

- **PHP 8.1+** with the `pdo_mysql` extension (bundled with most PHP builds).
- **MySQL 5.7+ or MariaDB 10.3+** — a database and a user with full privileges
  on it. Every cPanel plan has this; create both under *MySQL Databases*.
- A modern browser — Chrome, Firefox, Edge or Safari (ES2020+).
- **HTTPS**, if the install is reachable from the internet. The session cookie
  is marked `Secure` automatically once the site is served over TLS.
- No build step, no Node, no package manager, no framework, no Composer.

## Install

### Local (development)

```bash
git clone <this-repo> lowrider-forge
cd lowrider-forge
cp api/config.sample.php api/config.php   # then fill in your MySQL credentials
./install.sh                              # creates the schema and seeds the library
php -S localhost:8000 router.php          # serve from the project root
```

Then open <http://localhost:8000> and register — the first account created on
a fresh install becomes the administrator.

> Launch the built-in server **with `router.php`** as shown. PHP's built-in
> server ignores `.htaccess`, so without the router the `data/` directory —
> every saved gcode file — is downloadable over HTTP by anyone, bypassing the
> ownership checks the API applies. `router.php` denies `data/`, `tools/`,
> `api/config.php` and dotfiles and passes everything else through; on Apache
> it is ignored (the `.htaccess` rules apply). See
> [Security &amp; deployment hardening](#security--deployment-hardening).

### Shared cPanel hosting (production)

1. In cPanel **MySQL Databases**, create a database and a user, and add the
   user to the database with **ALL PRIVILEGES**. cPanel prefixes both names
   with your account name, e.g. `myaccount_forge` and `myaccount_forgeuser`.
2. Upload the project folder into — or next to — `public_html`, for example
   `public_html/forge/`.
3. Copy `api/config.sample.php` to `api/config.php` and paste in the database
   name, user and password from step 1.
4. In cPanel **MultiPHP Manager**, set that directory to **PHP 8.1 or newer**,
   and in *Select PHP Version → Extensions* make sure `pdo_mysql` is ticked.
5. Make sure `data/` is writable by the account, so saved gcode files can be
   written. On the suEXEC / PHP-FPM setup cPanel uses by default a `0755`
   directory is enough.
6. Open the URL and register. **The first account becomes the administrator**,
   so do this before announcing the URL to anyone — on a fresh install that
   window is open to whoever arrives first. Invite everyone else from the
   account menu.

The app never assumes its install path, so a subdirectory
(`example.com/forge/`) behaves exactly like a document root; the session cookie
is scoped to that path, so two installs on one hostname do not fight.

If you would rather not keep credentials in a file, every setting in
`api/config.php` can come from an environment variable instead —
`FORGE_DB_NAME`, `FORGE_DB_USER`, `FORGE_DB_PASS` and so on. The names are
listed in `api/config.sample.php`.

### Creating the administrator from a shell

If the sign-up window has already closed — or you locked yourself out — create
or repair the admin account directly:

```bash
php tools/create-admin.php --email=you@example.com --password='a long password'
php tools/create-admin.php --email=you@example.com --promote   # existing account
php tools/create-admin.php --email=you@example.com --reset --password='new one'
```

## Upgrading from 1.x

Version 1.x stored the library in `data/forge.sqlite`. Version 2 uses MySQL, so
that content has to be copied across once:

1. Follow the install steps above so the MySQL schema exists.
2. Register your account in the browser (it becomes the administrator).
3. Import the old library into that account:

   ```bash
   php tools/migrate-sqlite-to-mysql.php --owner=you@example.com --dry-run
   php tools/migrate-sqlite-to-mysql.php --owner=you@example.com
   ```

   Use `--owner=system` instead to put the rows in the shared built-in library
   where every account can read them.

The import is additive and safe to re-run. Rows identical to ones the tool
already ships are skipped; rows you had **customised** — a seeded bit whose
cutting length you corrected, say — are imported under a `... (imported)` name
rather than being silently dropped, and the summary tells you how many. Presets
are re-bound to their bit and material **by name**, because the ids are
renumbered by the move; any that could not be matched are reported so you can
re-pick them.

Nothing is deleted from `data/forge.sqlite`, so keep it as a rollback point
until you are satisfied, then delete it.

Saved gcode files stay where they are in `data/jobs/`; only the rows that point
at them move.

## Accounts, designs and sharing

### Signing in

The tool works fully **signed out**: artwork, toolpaths, the preview,
validation and gcode download all run in the browser and never needed the
server. An account adds persistence — saved designs, share links, saved gcode,
and a private bit and material library.

Registration is **invite-only**. An administrator creates an invite from the
account menu (*Administration → Invites*), optionally pinned to one email
address and with an expiry, and sends the link however they like. Nothing here
sends mail: shared hosts block or silently drop PHP `mail()` often enough that
depending on it would strand people waiting for a message that never arrives.

The single exception is the very first account on a fresh install, which
becomes the administrator. That window closes the moment it is used.

### Designs versus presets

They are different things, and the difference matters:

- A **preset** is machining settings — operation, depths, feeds, tabs. It is
  what you reach for when cutting *different* artwork the *same* way.
- A **design** is the whole working document: the settings **plus the artwork**
  — the uploaded SVG text, the traced bitmap's original bytes, the shapes, and
  an uploaded font if the sign uses one.

That last part is the point. The geometry pipeline is deterministic given its
inputs, so a design reopened next year produces the same gcode — but only if
every input comes back exactly as it went in. An uploaded font that did not
travel with the design would silently re-lay the text in a fallback face and
cut a different shape.

Save with **Save design** in the header; **Save as new…** forks the current
work into a second design. *My designs* lists what you have, and opens,
duplicates, renames and deletes them. Design names are per-account, so you and
a colleague can both have a "Front door sign".

The LocalStorage autosave is still there and still per-browser: it is the
scratchpad that survives a reload. A saved design is the durable copy.

### Share links

*Share* on a saved design mints an unguessable URL — 32 random bytes — that
opens the design in the normal editor marked **read only**. The recipient can
adjust settings, preview and download gcode; they cannot change your copy. If
they have an account, **Save a copy** forks it into theirs.

The token is the credential: anyone holding the link can view the design, so
treat it like a password. Links can be given an expiry, and **Revoke** kills
one immediately. Deleting a design revokes every link to it. The share dialog
shows how many times each link has been opened and when it was last used.

The token is stripped from the address bar as soon as the page loads, so it
does not end up bookmarked or sent as a `Referer` to the font CDN.

> **Check the tooling before you cut.** A shared design records *which* bit and
> material it used, and the recipient may not have those rows in their library.
> The tool says so with a warning when it happens — pick the closest match
> before running the job.

### The shared library

The 19 bits, 20 materials and 4 presets the tool ships with belong to a
built-in library that every account can read and **nobody can edit in place**.
Editing one makes you a private copy instead (named `... (mine)`), so retuning
feeds for your plywood never moves the numbers under somebody else's saved
preset. Bits and materials you create are yours alone.

### Administration

Administrators get an *Administration* entry in the account menu:

- **Invites** — create, copy and revoke invite links.
- **Users** — see every account, disable or re-enable one, and promote or
  demote administrators.

Accounts are disabled, never deleted: designs, presets and saved jobs hang off
the user id, and deleting the row would cascade away every design that user
ever shared. Disabling ends their sessions immediately. The last active
administrator cannot be demoted or disabled, and you cannot lock out your own
admin account.

## Security &amp; deployment hardening

Version 2 ships authentication, so unlike 1.x this is no longer a
trusted-local-network-only tool. It is still a **self-hosted shop tool**, not a
hardened SaaS product — deploy it accordingly.

**What the tool does for you**

- Passwords are hashed with `password_hash()` (bcrypt) and re-hashed on sign-in
  whenever PHP's default cost changes. Nothing stores a password.
- Sessions live in the `sessions` table, not in PHP's own session storage: on
  shared hosting PHP's default session directory is frequently a shared `/tmp`
  readable by every account on the box. The cookie carries 32 random bytes and
  the database stores only their SHA-256, so a database read cannot be replayed
  as a login.
- The session cookie is `HttpOnly`, `SameSite=Lax`, scoped to the app's own
  path, and `Secure` whenever the request arrives over HTTPS.
- Every state-changing request carries a CSRF token in an `X-Forge-CSRF`
  header, on top of `SameSite=Lax` and the JSON-only content type.
- Failed sign-ins are throttled per email and, far more loosely, per IP — a
  whole shop shares one public address, so the IP bucket blunts a spray across
  many accounts rather than policing one person's typing.
- Every design, preset, saved job and private library row is checked against
  the signed-in user before it is read or written. Somebody else's design
  answers `404`, not `403`, so the id space cannot be walked to count what an
  install holds.
- Changing a password ends every other session for that account.

**What you still have to do**

- **Serve it over HTTPS.** Without TLS the session cookie travels in clear.
- **Register the first account immediately after install.** On a fresh
  database the first person to reach the sign-up form becomes the
  administrator. Set `allow_first_admin_signup` to `false` in `api/config.php`
  once that account exists if you want the window explicitly nailed shut.
- **Treat share links as passwords.** They are bearer tokens by design; anyone
  holding one can view that design. Give them an expiry, and revoke them when
  a job is done.
- **Keep `api/config.php` out of the web.** It holds the database password. The
  bundled `.htaccess` denies it and the file aborts on direct access, but if
  you run something other than Apache, add your own rule.
- **Keep `data/` off the web.** It holds every saved gcode file, and the
  filenames are guessable. How depends on the server:

  - **Apache / cPanel (production).** The bundled `.htaccess` files already
    deny `data/`, `tools/`, `api/config.php`, dotfiles and the spec/installer —
    nothing more to do.
  - **PHP built-in server (local dev).** `.htaccess` is **ignored**. Always
    start it with the bundled router: `php -S localhost:8000 router.php`.
  - **nginx.** `.htaccess` is **ignored**. Add deny rules to your server block
    before routing the API through PHP-FPM:

    ```nginx
    location ^~ /data/  { deny all; return 404; }
    location ^~ /tools/ { deny all; return 404; }
    location = /api/config.php { deny all; return 404; }
    location ~ /\.      { deny all; return 404; }
    ```

If you cannot apply server rules, move `data/` outside the web root and update
`forge_data_dir()` in `api/db.php` to point at the new location.

**Known limits of this threat model**

- Share tokens are stored in the clear so an owner can copy a link again later
  rather than seeing it exactly once. A database read therefore exposes live
  share links — but the same read already exposes the designs themselves, so
  this widens nothing that matters.
- There is no email verification, no password-reset-by-email and no
  two-factor. All three want reliable outbound mail, which shared hosting does
  not dependably provide. A locked-out user needs an administrator running
  `php tools/create-admin.php --reset`.
- Uploaded artwork is not scanned. An SVG is parsed by the client's own parser
  and never rendered as markup, and a shared design's bytes are served as JSON,
  not as a document — but do not treat this as a general-purpose file host.

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
session is restored when you reload the page. That autosave does **not** carry
the artwork — an uploaded SVG, a traced bitmap and an uploaded font live only
in the tab you loaded them in. To keep those, sign in and **Save design**
(step 8).

8. **Save the design** if you want it back later, or a link to send someone.
   *Save design* in the header stores the whole document — settings **and**
   artwork — against your account; *Share* mints a read-only link to it.

## The interface

A single-page app in three columns (stacked on narrow screens):

| Column | Contents |
|--------|----------|
| **Header** | The open design's name, **Save**, **Save as new…**, **Share** and **My designs**, plus the server status pill and the account menu. |
| **Left** | Artwork (text, SVG, or bitmap tracing), operation picker, material &amp; bit pickers, job presets, pre-flight checks, the **Generate gcode** button. |
| **Centre** | The live toolpath preview and its toolbar. |
| **Right** | Settings tabs (Operation, Tabs, Geometry, Machine, Bit, Material) and a live job summary — stock size, runtime estimate, Z-pass count, chip load, cut distance and rapid distance. |

A design opened through somebody else's share link adds a banner under the
header marking it read-only, with **Save a copy** to fork it into your own
account.

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

Everything is editable, but the seeded set is shared by every account and so
is read-only: **Update** on a built-in bit or material saves you a private copy
named `... (mine)` instead of changing it for everybody. **Save as new**
branches a variant outright, and **Delete** removes one of your own. Entries you
create are yours alone and live in the MySQL database. All of this needs an
account; signed out, the seeded library is read-only.

## Job presets

A preset captures the machining settings — operation, bit, material and every
setting — but **not** the artwork. It is what you reach for when cutting
different artwork the same way; to keep the artwork too, save a
[design](#accounts-designs-and-sharing) instead.

**Save current settings as preset** stores it against your account; the **Job
presets** picker loads or deletes saved presets. Preset names are per-account,
so you and a colleague can each have a "My preset" without overwriting each
other. Four sample presets ship with the tool (foam engrave, plywood
profile-cut with tabs, HDPE 2-colour sign engrave and an aluminium 6061
profile); those are read-only.

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
GET                   health                     no auth, no database

POST                  auth/register              invite token, or the first account
POST                  auth/login
POST                  auth/logout
GET                   auth/me                    current user + CSRF token
POST                  auth/password              change own password
POST                  auth/profile               change own display name

GET/POST              invites       invites/check admin; check is public
DELETE                invites/:id                admin — revoke
GET                   users                      admin
PUT                   users/:id                  admin — role / disabled

GET/POST              designs                    list mine / create
GET/PUT/DELETE        designs/:id
POST                  designs/:id/copy           duplicate my own
GET/POST              designs/:id/shares         list / mint a share link
DELETE                shares/:id                 revoke a share link
GET                   shared/:token              public read-only view
POST                  shared/:token/copy         fork into my account

GET/POST/PUT/DELETE   bits          bits/:id
GET/POST/PUT/DELETE   materials     materials/:id
GET/POST/DELETE       presets       presets/:id
POST                  jobs/save                  persist generated gcode
GET                   jobs          jobs/:id     (download)
DELETE                jobs/:id
```

Reads of `bits`, `materials`, `presets`, `health` and `shared/:token` work
signed out — that is what keeps the tool usable without an account. Everything
that writes requires a session **and** the `X-Forge-CSRF` header carrying the
token from `auth/me`. Rows you do not own answer `404`.

A `PUT designs/:id` is a partial save: any field the request omits keeps its
stored value, and omitting `assets` entirely leaves the artwork alone. Sending
`"assets": {}` is how you clear it, and `"assets": {"svg": {"unchanged": true}}`
keeps a stored asset without re-uploading it.

Editing a built-in bit or material returns **201** with a new, private row —
the fork — rather than 200 with the original. The response carries
`forked_from` so the client can follow it.

## Project layout

```
index.html               Single-page app
css/styles.css            Theme
js/
  app.js                  State, form generation, event wiring (text/SVG/bitmap)
  account.js              Sign-in / register dialogs, account menu, admin panel
  designs.js              Saved designs, the share dialog, read-only banner
  ui.js                   Shared DOM helpers, modals, base64, formatting
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
  presets.js              API client (accounts, designs, sharing, library)
  lib/clipper.js          Vendored Clipper 6.4.2 (Boost license)
  lib/opentype.js         Vendored opentype.js (MIT) — reads font outlines
api/
  index.php               Router
  config.php              MySQL credentials (gitignored; copy the .sample)
  db.php                  MySQL schema, migrations, seed data, helpers
  auth.php                Sessions, CSRF, registration, login throttle
  invites.php             Invite links + the admin user list
  designs.php             Saved designs, artwork assets, share links
  bits.php / materials.php / presets.php / jobs.php
tools/
  create-admin.php        Create / promote / reset an admin from a shell
  migrate-sqlite-to-mysql.php   One-shot 1.x import
data/                     Saved gcode files (created at runtime)
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
- **"Backend unavailable".** gcode generation still works fully — only
  accounts, designs and library storage need PHP. Check that the `pdo_mysql`
  extension is enabled (cPanel → *Select PHP Version* → *Extensions*). The tool
  surfaces the exact cause in the error toast.
- **"Could not connect to MySQL".** The message repeats what the driver said.
  On cPanel both the database name and the user name carry your account prefix
  (`myaccount_forge`), and the user must be added to the database with ALL
  PRIVILEGES under *MySQL Databases*.
- **"The database is not configured yet".** `api/config.php` is missing or has
  empty credentials. Copy `api/config.sample.php` over it and fill it in.
- **Sign-in does not stick.** The session cookie is scoped to the app's path
  and marked `Secure` over HTTPS. If you are behind a proxy that terminates
  TLS, make sure it forwards `X-Forwarded-Proto`; otherwise set
  `'cookie_secure' => true` in `api/config.php`.
- **Locked out of the only admin account.** Run
  `php tools/create-admin.php --email=you@example.com --reset --password='...'`
  from a shell.
- **HTTP 500 on every page.** A small number of hosts forbid `Options` in
  `.htaccess`. If so, delete the `Options -Indexes` line from the root
  `.htaccess`.
- **An inside cut is skipped.** The contour was too small to offset inward with
  the chosen bit. Use a smaller bit or a different operation.
- **A request body was dropped (HTTP 413).** A large design, preset or saved
  job exceeded the host `post_max_size`; raise it in cPanel *MultiPHP INI
  Editor*. A design carries its artwork, so one with a 4&nbsp;MB SVG or an
  8&nbsp;MB bitmap is genuinely that big. MySQL's `max_allowed_packet` has to
  clear the same bar, and `max_design_bytes` in `api/config.php` caps it from
  the tool's side (12&nbsp;MB by default).

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
- Accounts are invite-only with no email verification, no
  password-reset-by-email and no two-factor: all three need reliable outbound
  mail, which shared hosting does not dependably provide. A locked-out user
  needs an administrator with shell access.
- Share links are bearer tokens. Anyone holding the URL can view that design
  until it expires or is revoked.
- A shared design records which bit and material it used, and the recipient may
  not have those rows. The tool warns when it happens, but it cannot pick a
  substitute for you — check the tooling before cutting somebody else's design.
- Designs are not versioned: saving overwrites the stored copy, with no
  history to roll back to. Use **Save as new…** before a change you might want
  to undo.
- There is no way to transfer a design's ownership, and accounts are disabled
  rather than deleted, so a departing user's designs stay in their account.
  On non-Apache servers the `data/` directory must be protected explicitly —
  see [Security &amp; deployment hardening](#security--deployment-hardening).

See `spec.md` for the full design specification.
