# Vector Tracing (Bitmap → CNC Paths) Implementation Plan

## Purpose

This document proposes a production-ready way to add **bitmap vector tracing** to LowRider Forge so users can upload PNG/JPG/WebP artwork, convert it into clean vector geometry, and then run the same proven toolpath pipeline used today for text/shapes/SVG.

The approach is designed to be:

- **Modern**: clear workflow, progressive controls, live preview.
- **Professional**: deterministic output and explicit quality settings.
- **User-friendly**: sane defaults, explainers, and preflight guidance.
- **Reliable**: defensive limits and predictable runtime on shared hosting.
- **cPanel-safe**: no daemon services, no build step, no mandatory server image tooling.

---

## Current Architecture Fit (What already helps us)

LowRider Forge already uses a strong architecture for this feature:

1. The geometry/toolpath/gcode pipeline is client-side and already accepts normalized subpaths, so traced vectors can be fed in exactly like parsed SVG subpaths.
2. The app controller already supports a multi-input workflow (`text` + `svg`) and schema-driven settings, so we can add a third input mode without redesigning the app.
3. The SVG parser already outputs closed/open subpaths with winding and area classification behavior aligned with downstream toolpath generation.
4. Shared-host constraints are already addressed in backend design (SQLite + NFS-safe pragmas + route fallback), so vector tracing should stay browser-side and avoid server-heavy image processing.

---

## Product UX Proposal

## 1) Add a new Artwork mode: **Trace Bitmap**

Extend the existing artwork mode switch:

- Text
- Upload SVG
- **Trace Bitmap (new)**

In Trace Bitmap mode:

- Accept image upload (`.png`, `.jpg`, `.jpeg`, `.webp`, optional `.bmp`).
- Show image metadata (pixel dimensions, file size, estimated mm scale).
- Show a 3-step guided workflow:
  1. **Prepare image** (contrast/threshold/noise).
  2. **Trace to vector** (centerline vs outline strategy).
  3. **Review + commit** to geometry.

## 2) Beginner defaults + Advanced panel

Default flow should work with one click:

- Preset profiles: `Logo (high contrast)`, `Line art`, `Text/photo mask`, `Stencil prep`.
- Single **Quality slider** (Fast ↔ Detailed).

Advanced controls (collapsible):

- Threshold (for monochrome segmentation).
- Blur radius.
- Speckle filter minimum area.
- Corner simplification tolerance.
- Min feature width warning threshold.
- Hole fill/invert toggle.
- Trace mode:
  - **Outline trace** (fills become contours).
  - **Centerline trace** (single-stroke look; best for engraving).

## 3) Visual confidence

Preview overlay toggles:

- Original image.
- Processed binary image.
- Traced vectors.
- Final cut paths.

This keeps user trust high and shortens trial/error.

---

## Technical Design

## 1) Keep tracing entirely client-side

**Why:** best reliability on cPanel shared hosting, no external services, no PHP image extensions dependency.

Client-side pipeline:

1. Decode image via browser APIs (`createImageBitmap` fallback to `<img>` + canvas).
2. Normalize to grayscale and optional denoise.
3. Threshold to binary mask (manual or Otsu auto).
4. Connected-components cleanup (remove tiny islands).
5. Trace contours from binary mask.
6. Simplify polygons (Douglas-Peucker or Visvalingam).
7. Convert pixel coordinates → mm coordinates.
8. Emit Forge-compatible subpaths.

## 2) Add a dedicated tracing module

Create `js/bitmap-tracer.js` with a stable interface:

```js
const traced = Forge.BitmapTracer.trace(imageData, {
  mode: 'outline',
  threshold: 140,
  blurPx: 1,
  minIslandPx: 12,
  simplifyMm: 0.08,
  mmPerPixel: 0.1
});

// returns:
// {
//   width_mm,
//   height_mm,
//   subpaths: [{ points, closed, typeHint }],
//   diagnostics: { islandsRemoved, nodesBefore, nodesAfter }
// }
```

Then adapt in `js/app.js` so traced output is normalized into the same geometry shape consumed by `toolpath.js`.

## 3) Use Web Worker for responsiveness

Large image tracing can block UI. Run heavy stages in a worker:

- `js/workers/trace-worker.js` for image preprocess + contour extraction.
- Main thread remains interactive and can show progress.

If worker unavailable, fallback to main-thread tracing with a warning toast.

## 4) Geometry contract

Before sending to toolpath:

- Enforce max node cap per job (e.g., 250k total points).
- Remove degenerate rings and self-zero edges.
- Ensure closed contour winding is normalized.
- Map tiny closed loops to `hole`/`outer` classification using existing area threshold behavior.

---

## cPanel/Shared Hosting Reliability Strategy

1. **No new backend requirement** for basic tracing.
2. Persist trace settings into existing preset JSON only.
3. Keep upload limits client-side (same-style caps as SVG/font limits).
4. Avoid temp file processing server-side to prevent permission/cleanup issues.
5. Optional future server tracing endpoint can be feature-flagged, but should never be required.

---

## Quality & Safety Rules (CNC-specific)

Add trace-specific preflight checks in `js/validation.js`:

- Warning if smallest feature < bit diameter.
- Warning when open-path count is high for non-engrave operations.
- Warning if contour density implies likely chatter or excessive runtime.
- Warning if traced geometry exceeds machine bounds after scaling.

Add operation hints in UI:

- For centerline trace: recommend **Engrave**.
- For solid silhouettes: recommend **Pocket/Profile** depending intent.

---

## Performance Budgets

Suggested guardrails:

- Max bitmap input: 8 MP default (configurable).
- Max trace compute target: < 2.5s for 4 MP on a mid-range desktop.
- Max vector points after simplify: 250k hard cap with actionable error.
- Memory cap behavior: fail with guided suggestion (downscale / raise simplify).

---

## Proposed Phased Rollout

### Phase 1 — MVP (high-impact, low-risk)

- Add Trace Bitmap mode UI + upload.
- Implement monochrome threshold + contour trace + simplify.
- Feed traced vectors into existing geometry pipeline.
- Add preflight warnings and preview overlays.
- Save/restore trace settings in localStorage and presets.

### Phase 2 — Professional controls

- Add centerline mode for engraving-first workflows.
- Add worker-based tracing and progress UI.
- Add quick presets (logo/line-art/stencil).
- Add node/complexity diagnostics panel.

### Phase 3 — Production polish

- Manual cleanup tools (delete island, smooth segment, close gap).
- Auto-stencil bridges for enclosed islands.
- Batch trace profiles per material/bit.

---

## Recommended File-Level Changes

- `index.html`: add trace mode controls and overlay toggles.
- `js/app.js`: integrate new input mode, state, and pipeline branch.
- `js/validation.js`: add trace-specific safety checks.
- `js/preview.js`: add source/processed/vector overlays.
- `js/bitmap-tracer.js` (new): core tracing engine.
- `js/workers/trace-worker.js` (new): async tracing path.
- `css/styles.css`: panel layout/states for trace UX.
- `README.md`: user docs for bitmap-to-vector workflow.

---

## Suggested Acceptance Criteria

1. User can upload a PNG logo and generate valid gcode without external tools.
2. Same uploaded image with same settings yields deterministic vectors.
3. Traced output respects current machine/material/bit validation.
4. UI remains responsive during tracing on common shop laptops.
5. Feature works on shared cPanel hosting with no additional PHP extensions.

---

## Risk Register + Mitigations

- **Risk:** noisy images produce unusable vectors.  
  **Mitigation:** presets + min-island filter + simplify + clear warnings.

- **Risk:** too many points cause slow toolpaths.  
  **Mitigation:** hard node limits + simplification + quality slider.

- **Risk:** user confusion between outline and centerline semantics.  
  **Mitigation:** mode-specific helper text + operation recommendations.

- **Risk:** perceived inaccuracy from pixel source scaling.  
  **Mitigation:** explicit mm scale control + dimension readout + bbox preview.

---

## Recommended Next Step

Implement Phase 1 behind a small feature flag (`traceBitmapEnabled`) and ship with 2–3 curated demo images in `samples/` so operators can validate behavior quickly before using their own artwork.
