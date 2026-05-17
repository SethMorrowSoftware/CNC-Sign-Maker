<?php
/** LowRider Forge — /api/jobs. Optional persistence of generated gcode. */
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
    if (!preg_match('/\.gcode$/i', $name)) {
        $name .= '.gcode';
    }
    return $name;
}

function handle_jobs(string $method, ?int $id, ?string $action): void
{
    $db = forge_db();

    // POST /api/jobs/save  — persist a generated gcode file.
    if ($method === 'POST' && $action === 'save') {
        $body  = read_json_body();
        $gcode = (string) ($body['gcode'] ?? '');
        if ($gcode === '') {
            json_response(['error' => 'gcode body is empty'], 400);
        }
        if (strlen($gcode) > 8 * 1024 * 1024) {
            json_response(['error' => 'gcode exceeds 8 MB limit'], 413);
        }

        $filename = safe_gcode_name((string) ($body['filename'] ?? 'job.gcode'));
        $settings = $body['settings'] ?? [];
        $settingsJson = json_encode($settings, JSON_UNESCAPED_SLASHES);
        if ($settingsJson === false) {
            json_response(['error' => 'settings contains invalid UTF-8'], 400);
        }
        $svgHash  = substr((string) ($body['svg_hash'] ?? ''), 0, 64);
        $now      = time();

        $s = $db->prepare('INSERT INTO jobs
            (filename,preset_id,svg_hash,gcode_path,settings_json,created_at)
            VALUES (?,?,?,?,?,?)');
        $s->execute([
            $filename,
            ni($body['preset_id'] ?? null),
            $svgHash,
            '',
            $settingsJson,
            $now,
        ]);
        $jobId = (int) $db->lastInsertId();

        $stored = $jobId . '_' . $filename;
        $path   = forge_data_dir() . '/jobs/' . $stored;
        if (file_put_contents($path, $gcode) === false) {
            json_response(['error' => 'Could not write gcode file (check data/jobs permissions)'], 500);
        }
        $db->prepare('UPDATE jobs SET gcode_path = ? WHERE id = ?')->execute([$stored, $jobId]);

        json_response(['id' => $jobId, 'filename' => $filename, 'bytes' => strlen($gcode)], 201);
    }

    // GET /api/jobs        — list metadata.
    // GET /api/jobs/:id    — download stored gcode.
    if ($method === 'GET') {
        if ($id === null) {
            json_response($db->query(
                'SELECT id,filename,svg_hash,created_at FROM jobs ORDER BY id DESC LIMIT 100'
            )->fetchAll());
        }
        $s = $db->prepare('SELECT * FROM jobs WHERE id = ?');
        $s->execute([$id]);
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
        $s = $db->prepare('SELECT gcode_path FROM jobs WHERE id = ?');
        $s->execute([$id]);
        $gp = $s->fetchColumn();
        if ($gp) {
            @unlink(forge_data_dir() . '/jobs/' . basename((string) $gp));
        }
        $db->prepare('DELETE FROM jobs WHERE id = ?')->execute([$id]);
        json_response(['deleted' => true]);
    }

    json_response(['error' => 'Method not allowed'], 405);
}
