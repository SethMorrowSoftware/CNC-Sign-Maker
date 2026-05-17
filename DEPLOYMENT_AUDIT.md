# Deployment & Reliability Audit (cPanel/Zhost)

Date: 2026-05-17

This audit reviews the current codebase with focus on recent text-sign and V-carve improvements, runtime safety, and install-on-shared-host reliability.

## Executive result

The project is in good shape for a simple cPanel deployment: no build step, lazy DB bootstrap, no framework dependencies, and clear runtime error messages for common host misconfiguration.

## What was reviewed

- Architecture and install path assumptions (`README.md`, `install.sh`).
- API robustness and shared-host compatibility (`api/index.php`, `api/db.php`, `api/jobs.php`).
- Client toolpath safety checks (`js/validation.js`).
- Text-sign generation and font pipeline (`js/text-geometry.js`, `js/app.js`).
- Front-end UX affordances and guidance copy (`js/app.js`, `css/styles.css`, `index.html`).

## Verified strengths

1. **Shared-host reliability by design**
   - API routing supports query-string fallback instead of relying on `PATH_INFO`.
   - DB bootstrap is lazy and idempotent.
   - SQLite pragma choices avoid WAL/NFS pitfalls commonly seen on cPanel hosts.

2. **Safety-first CNC validation**
   - Pre-flight checks block dangerous settings (envelope overflow, bad tab thickness, missing bit for compensated operations, invalid V-bit angle).
   - Material-aware warnings/errors (e.g., HDPE with multi-flute tooling) and chip-load guidance are built in.

3. **Recent feature quality (text + V-carve)**
   - Text is converted to geometry through bundled/uploaded fonts and fed through the same geometry/toolpath pipeline as SVG.
   - V-carve depth validation uses path-reached depth rather than only user-entered final depth.

4. **Operational resilience**
   - Jobs API sanitizes filenames and constrains payload size for stored gcode.
   - Errors returned to operators are actionable while server internals are kept out of client responses.

## cPanel/Zhost readiness checklist

- [ ] PHP 8.1+ enabled for the target directory.
- [ ] `pdo_sqlite` enabled.
- [ ] `data/` and `data/jobs/` writable by the hosting account.
- [ ] App uploaded under final path (root or subfolder) and opened once to trigger DB creation.
- [ ] `/api/index.php?r=health` returns JSON `{"ok":true,...}`.
- [ ] Generate one sample gcode file and confirm download works.

## Remaining recommendations (non-blocking)

- Add a tiny smoke-test script (health endpoint + write/delete job fixture) for post-deploy verification.
- Add optional CSP headers for stricter browser hardening on hosts that allow header config.
- Add a short operator runbook section for first-cut dry run (air pass, zeroing, and checklist).

## Conclusion

The application is deployable now on typical cPanel shared hosting with minimal setup and already contains many guardrails that reduce operator and configuration mistakes.
