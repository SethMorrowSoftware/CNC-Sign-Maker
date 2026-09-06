<?php
/**
 * LowRider Forge — /api/jobs. Optional persistence of generated gcode.
 *
 * The gcode itself stays on disk under data/jobs rather than in MySQL: these
 * are multi-megabyte text files that only ever get written once and streamed
 * back whole, which is what a filesystem is for. The row in `jobs` carries the
 * metadata and, crucially, the owner — the download handler checks it before
 * it reads a byte, so job ids are not a way to walk other people's cuts.
 */
declare(strict_types=1);

defined('FORGE_APP') || exit('Direct access denied');

/** Strip anything that could escape the jobs directory. */
function safe_gcode_name(string $name): string
{
    $name = basename($name);
    $name = preg_replace('/[^A-Za-z0-9._-]+/', '_', $name) ?? 'job';
    $name = trim($name, '._-');
    if ($name === '') {
        $name = 'job';
    }
    // Cap the length: "id_" + name must stay under NAME_MAX (255 bytes) or
    // file_put_contents fails with ENAMETOOLONG and a misleading
    // permissions error. 120 chars leaves ample headroom.
    if (strlen($name) > 120) {
        $name = substr($name, 0, 120);
        $name = rtrim($name, '._-');
    }
    if (!preg_match('/\.gcode$/i', $name)) {
        $name .= '.gcode';
    }
    return $name;
}

/** Create data/jobs on demand, keeping the deny rule that protects it. */
function forge_jobs_dir(): string
{
    $dir     = forge_data_dir();
    $jobsDir = $dir . '/jobs';
    if (!is_dir($dir)) {
        @mkdir($dir, 0775, true);
        // The committed data/.htaccess denies web access on Apache. If an
        // operator wipes data/ to reset, the recreated directory must get
        // the same protection or saved gcode becomes directly downloadable.
        if (is_dir($dir) && !is_file($dir . '/.htaccess')) {
            @file_put_contents($dir . '/.htaccess',
                "# LowRider Forge — keep saved jobs off the web.\n"
                . "<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n"
                . "<IfModule !mod_authz_core.c>\n  Order allow,deny\n  Deny from all\n</IfModule>\n");
        }
    }
    if (!is_dir($jobsDir)) {
        @mkdir($jobsDir, 0775, true);
    }
    if (!is_dir($jobsDir) || !is_writable($jobsDir)) {
        throw new RuntimeException(
            'The gcode directory is not writable: ' . $jobsDir . '. Set its '
            . 'permissions to 0755 (or 0775) so the web server can save jobs there.'
        );
    }
    return $jobsDir;
}

function handle_jobs(string $method, ?int $id, ?string $action): void
{
    $db = forge_db();

    // POST /api/jobs/save  — persist a generated gcode file.
    if ($method === 'POST' && $action === 'save') {
        forge_require_csrf();
        $me    = forge_require_user();
        $body  = read_json_body();
        $gcode = (string) ($body['gcode'] ?? '');
        if ($gcode === '') {
            json_response(['error' => 'gcode body is empty'], 400);
        }
        $maxGcode = max(1024, (int) forge_cfg('max_gcode_bytes', 8 * 1024 * 1024));
        if (strlen($gcode) > $maxGcode) {
            json_response(['error' => 'gcode exceeds the '
                . round($maxGcode / 1048576, 1) . ' MB limit'], 413);
        }

        $filename = safe_gcode_name((string) ($body['filename'] ?? 'job.gcode'));
        $settings = $body['settings'] ?? [];
        $settingsJson = json_encode($settings, JSON_UNESCAPED_SLASHES);
        if ($settingsJson === false) {
            json_response(['error' => 'settings contains invalid UTF-8'], 400);
        }
        $svgHash  = clamp_str($body['svg_hash'] ?? '', 64) ?: null;
        $now      = time();

        // A design id only counts when this user owns that design, so a saved
        // job can never be attached to somebody else's work.
        $designId = ni($body['design_id'] ?? null);
        if ($designId !== null) {
            $chk = $db->prepare('SELECT 1 FROM designs WHERE id = ? AND owner_id = ?');
            $chk->execute([$designId, $me['id']]);
            if (!$chk->fetchColumn()) {
                $designId = null;
            }
        }

        $jobsDir = forge_jobs_dir();

        $s = $db->prepare('INSERT INTO jobs
            (owner_id,filename,preset_id,design_id,svg_hash,gcode_path,settings_json,created_at)
            VALUES (?,?,?,?,?,?,?,?)');
        $s->execute([
            (int) $me['id'],
            $filename,
            ni($body['preset_id'] ?? null),
            $designId,
            $svgHash,
            '',
            $settingsJson,
            $now,
        ]);
        $jobId = (int) $db->lastInsertId();

        $stored = $jobId . '_' . $filename;
        $path   = $jobsDir . '/' . $stored;
        // A partial write (disk quota hit mid-write) returns a short byte
        // count, not false — a truncated gcode file that ends mid-move would
        // halt the machine at depth. Verify the full length landed, and
        // remove the orphaned row + partial file on failure.
        $written = file_put_contents($path, $gcode);
        if ($written === false || $written !== strlen($gcode)) {
            @unlink($path);
            $db->prepare('DELETE FROM jobs WHERE id = ?')->execute([$jobId]);
            json_response(['error' => $written === false
                ? 'Could not write gcode file (check data/jobs permissions)'
                : 'Gcode file was only partially written (disk full?) — save aborted'], 500);
        }
        $db->prepare('UPDATE jobs SET gcode_path = ? WHERE id = ?')->execute([$stored, $jobId]);

        json_response(['id' => $jobId, 'filename' => $filename, 'bytes' => strlen($gcode)], 201);
    }

    // GET /api/jobs        — list my saved jobs.
    // GET /api/jobs/:id    — download my stored gcode.
    if ($method === 'GET') {
        $me = forge_require_user();
        if ($id === null) {
            $s = $db->prepare(
                'SELECT id,filename,svg_hash,design_id,created_at FROM jobs
                 WHERE owner_id = ? ORDER BY id DESC LIMIT 100');
            $s->execute([$me['id']]);
            json_response($s->fetchAll());
        }
        $s = $db->prepare('SELECT * FROM jobs WHERE id = ? AND owner_id = ?');
        $s->execute([$id, $me['id']]);
        $job = $s->fetch();
        if (!$job) {
            json_response(['error' => 'Job not found'], 404);
        }
        $path = forge_data_dir() . '/jobs/' . basename((string) $job['gcode_path']);
        if (!$job['gcode_path'] || !is_file($path)) {
            json_response(['error' => 'Stored gcode file is missing'], 410);
        }
        $downloadName = safe_gcode_name((string) ($job['filename'] ?? 'job.gcode'));

        http_response_code(200);
        header('Content-Type: text/plain; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . $downloadName . '"');
        header('Content-Length: ' . filesize($path));
        readfile($path);
        exit;
    }

    if ($method === 'DELETE' && $id !== null) {
        forge_require_csrf();
        $me = forge_require_user();
        $s = $db->prepare('SELECT gcode_path FROM jobs WHERE id = ? AND owner_id = ?');
        $s->execute([$id, $me['id']]);
        $gp = $s->fetchColumn();
        if ($gp === false) {
            json_response(['error' => 'Job not found'], 404);
        }
        if ($gp) {
            @unlink(forge_data_dir() . '/jobs/' . basename((string) $gp));
        }
        $db->prepare('DELETE FROM jobs WHERE id = ? AND owner_id = ?')->execute([$id, $me['id']]);
        json_response(['deleted' => true]);
    }

    json_response(['error' => 'Method not allowed'], 405);
}
