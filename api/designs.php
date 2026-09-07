<?php
/**
 * LowRider Forge — /api/designs, /api/shares and /api/shared.
 *
 * A design is the whole working document, not just the machining settings a
 * preset carries: the settings plus whatever artwork the client needs to
 * rebuild identical geometry. That distinction matters because the geometry
 * pipeline is deterministic given its inputs, and the gcode is only
 * reproducible if every input comes back exactly as it went in:
 *
 *   text mode    settings alone are enough — unless the sign uses an uploaded
 *                font, whose bytes must travel with the design or the text
 *                re-lays out in a fallback face and cuts a different shape.
 *   svg mode     the SVG source text, which the browser otherwise holds only
 *                in memory.
 *   bitmap mode  the original image bytes, so the same trace parameters
 *                produce the same contours.
 *
 * Those bytes live in design_assets rather than in the designs row, so that
 * listing "My designs" never drags megabytes across the wire.
 */
declare(strict_types=1);

defined('FORGE_APP') || exit('Direct access denied');

const FORGE_ASSET_KINDS = ['svg', 'bitmap', 'font'];
const FORGE_INPUT_MODES = ['text', 'svg', 'bitmap'];

/* ------------------------------------------------------------------ */
/* Shaping                                                             */
/* ------------------------------------------------------------------ */

/** List-view shape: metadata only, never the artwork bytes. */
function design_summary(array $r): array
{
    return [
        'id'          => (int) $r['id'],
        'name'        => $r['name'],
        'input_mode'  => $r['input_mode'],
        'operation'   => $r['operation'],
        'bit_id'      => $r['bit_id'] === null ? null : (int) $r['bit_id'],
        'material_id' => $r['material_id'] === null ? null : (int) $r['material_id'],
        'notes'       => $r['notes'],
        'created_at'  => (int) $r['created_at'],
        'updated_at'  => (int) $r['updated_at'],
        'copied_from' => $r['copied_from'] === null ? null : (int) $r['copied_from'],
        'asset_bytes' => isset($r['asset_bytes']) ? (int) $r['asset_bytes'] : 0,
        'share_count' => isset($r['share_count']) ? (int) $r['share_count'] : 0,
    ];
}

/** Load a design's assets as base64, keyed by kind. */
function design_assets(PDO $db, int $designId): array
{
    $s = $db->prepare('SELECT kind, asset_key, filename, mime, byte_size, data
                       FROM design_assets WHERE design_id = ?');
    $s->execute([$designId]);
    $out = [];
    foreach ($s->fetchAll() as $a) {
        $out[$a['kind']] = [
            'kind'        => $a['kind'],
            'key'         => $a['asset_key'],
            'filename'    => $a['filename'],
            'mime'        => $a['mime'],
            'byte_size'   => (int) $a['byte_size'],
            'data_base64' => base64_encode((string) $a['data']),
        ];
    }
    return $out;
}

/** Full shape: everything the client needs to reconstruct the design. */
function design_full(PDO $db, array $r): array
{
    $out = design_summary($r);
    $out['settings'] = json_decode((string) $r['settings_json'], true);
    $out['svg_hash'] = $r['svg_hash'];
    $out['assets']   = design_assets($db, (int) $r['id']);
    return $out;
}

/**
 * Fetch a design the caller owns, or 404.
 *
 * Deliberately 404 and not 403 for someone else's design: a 403 would confirm
 * that the id exists, letting anyone walk the id space to count how many
 * designs the install holds.
 */
function design_owned(PDO $db, int $id, int $userId): array
{
    $s = $db->prepare('SELECT * FROM designs WHERE id = ? AND owner_id = ?');
    $s->execute([$id, $userId]);
    $row = $s->fetch();
    if (!$row) {
        json_response(['error' => 'Design not found.'], 404);
    }
    return $row;
}

/* ------------------------------------------------------------------ */
/* Payload validation                                                  */
/* ------------------------------------------------------------------ */

/**
 * Validate and decode the assets block of a save.
 *
 * Returns [kind => ['key','filename','mime','bytes']]. An entry marked
 * `unchanged` is skipped here and carried over from the stored row by the
 * caller, so re-saving a design with a 4 MB SVG does not re-upload it on
 * every keystroke-driven save.
 */
function design_read_assets(array $body, int &$totalBytes): ?array
{
    // No `assets` key at all means "leave the artwork exactly as it is". An
    // empty object means "remove all of it". The difference matters: a
    // partial save that forgot to mention the artwork must not delete it.
    if (!array_key_exists('assets', $body)) {
        return null;
    }
    $assets = $body['assets'];
    if (!is_array($assets)) {
        json_response(['error' => 'assets must be an object.'], 400);
    }

    $max = max(1024, (int) forge_cfg('max_design_bytes', 12 * 1024 * 1024));
    $out = [];

    foreach ($assets as $kind => $a) {
        if (!in_array($kind, FORGE_ASSET_KINDS, true)) {
            json_response(['error' => 'Unknown asset kind: ' . (string) $kind], 400);
        }
        if ($a === null) {
            continue;   // explicit removal
        }
        if (!is_array($a)) {
            json_response(['error' => "Asset '$kind' must be an object or null."], 400);
        }
        if (!empty($a['unchanged'])) {
            $out[$kind] = ['unchanged' => true];
            continue;
        }

        $b64 = (string) ($a['data_base64'] ?? '');
        if ($b64 === '') {
            json_response(['error' => "Asset '$kind' has no data."], 400);
        }
        $bytes = base64_decode($b64, true);
        if ($bytes === false) {
            json_response(['error' => "Asset '$kind' is not valid base64."], 400);
        }
        $totalBytes += strlen($bytes);
        if ($totalBytes > $max) {
            json_response([
                'error' => 'This design is larger than the ' . round($max / 1048576, 1)
                    . ' MB limit. Reduce the artwork size, or raise max_design_bytes '
                    . 'in api/config.php (and the host post_max_size and MySQL '
                    . 'max_allowed_packet to match).',
            ], 413);
        }

        $out[$kind] = [
            'key'      => clamp_str($a['key'] ?? '', 190) ?: null,
            'filename' => clamp_str($a['filename'] ?? '', 255) ?: null,
            'mime'     => clamp_str($a['mime'] ?? '', 100) ?: null,
            'bytes'    => $bytes,
        ];
    }

    return $out;
}

/** Replace a design's assets with the validated set. Null leaves them alone. */
function design_write_assets(PDO $db, int $designId, ?array $assets): void
{
    if ($assets === null) {
        return;
    }
    $now = time();
    foreach (FORGE_ASSET_KINDS as $kind) {
        if (!array_key_exists($kind, $assets)) {
            // Absent from the payload means "remove it": a design switched
            // from SVG to text mode should not keep dragging the old SVG.
            $db->prepare('DELETE FROM design_assets WHERE design_id = ? AND kind = ?')
               ->execute([$designId, $kind]);
            continue;
        }
        if (!empty($assets[$kind]['unchanged'])) {
            continue;
        }
        $a = $assets[$kind];
        $db->prepare('DELETE FROM design_assets WHERE design_id = ? AND kind = ?')
           ->execute([$designId, $kind]);
        $s = $db->prepare('INSERT INTO design_assets
            (design_id,kind,asset_key,filename,mime,byte_size,sha256,data,created_at)
            VALUES (?,?,?,?,?,?,?,?,?)');
        $s->bindValue(1, $designId, PDO::PARAM_INT);
        $s->bindValue(2, $kind);
        $s->bindValue(3, $a['key']);
        $s->bindValue(4, $a['filename']);
        $s->bindValue(5, $a['mime']);
        $s->bindValue(6, strlen($a['bytes']), PDO::PARAM_INT);
        $s->bindValue(7, hash('sha256', $a['bytes']));
        $s->bindValue(8, $a['bytes'], PDO::PARAM_LOB);
        $s->bindValue(9, $now, PDO::PARAM_INT);
        $s->execute();
    }
}

/**
 * Common field extraction for create and update.
 *
 * On an update, $existing supplies the fallback for every field the request
 * leaves out, so a partial save — renaming a design, say — cannot blank the
 * settings it did not mention.
 */
function design_fields(array $body, ?array $existing = null): array
{
    // The value to use for a field the request left out: whatever the stored
    // row already has, or the create-time default when there is no row.
    $keep = static function (string $key, $fallback) use ($existing) {
        return $existing === null ? $fallback : $existing[$key];
    };

    if (array_key_exists('input_mode', $body)) {
        $mode = (string) $body['input_mode'];
        if (!in_array($mode, FORGE_INPUT_MODES, true)) {
            $mode = 'text';
        }
    } else {
        $mode = $existing === null ? 'text' : (string) $existing['input_mode'];
    }

    if (array_key_exists('settings', $body)) {
        $settings = $body['settings'];
        if (!is_array($settings)) {
            json_response(['error' => 'settings must be an object.'], 400);
        }
        $settingsJson = json_encode($settings, JSON_UNESCAPED_SLASHES);
        if ($settingsJson === false) {
            json_response(['error' => 'settings contains invalid UTF-8.'], 400);
        }
    } else {
        $settingsJson = $existing === null ? '{}' : (string) $existing['settings_json'];
    }

    return [
        'input_mode'    => $mode,
        'operation'     => array_key_exists('operation', $body)
            ? clamp_str($body['operation'], 32, 'engrave')
            : ($existing === null ? 'engrave' : (string) $existing['operation']),
        'bit_id'        => array_key_exists('bit_id', $body)
            ? ni($body['bit_id']) : $keep('bit_id', null),
        'material_id'   => array_key_exists('material_id', $body)
            ? ni($body['material_id']) : $keep('material_id', null),
        'settings_json' => $settingsJson,
        'svg_hash'      => array_key_exists('svg_hash', $body)
            ? (clamp_str($body['svg_hash'], 64) ?: null) : $keep('svg_hash', null),
        'notes'         => array_key_exists('notes', $body)
            ? (clamp_str($body['notes'], 2000) ?: null) : $keep('notes', null),
    ];
}

/**
 * A name that does not collide with one this user already has.
 *
 * UNIQUE (owner_id, name) is what keeps two accounts from overwriting each
 * other, but it also means a copy has to be renamed rather than rejected.
 */
function design_unique_name(PDO $db, int $ownerId, string $base, ?int $excludeId = null): string
{
    $base = clamp_str($base, 150, 'Untitled design');
    $sql  = 'SELECT 1 FROM designs WHERE owner_id = ? AND name = ?'
          . ($excludeId !== null ? ' AND id <> ?' : '') . ' LIMIT 1';
    $s = $db->prepare($sql);

    $candidate = $base;
    for ($n = 2; $n < 500; $n++) {
        $params = [$ownerId, $candidate];
        if ($excludeId !== null) {
            $params[] = $excludeId;
        }
        $s->execute($params);
        if (!$s->fetchColumn()) {
            return $candidate;
        }
        $candidate = $base . ' (' . $n . ')';
    }
    // 500 collisions on one name is not a real workflow; fall back to
    // something guaranteed unique rather than looping forever.
    return mb_substr($base, 0, 140) . ' (' . dechex(random_int(0x100000, 0xffffff)) . ')';
}

/**
 * Insert a design plus its assets in one transaction.
 * Returns the new id.
 */
function design_insert(PDO $db, int $ownerId, string $name, array $f, ?array $assets, ?int $copiedFrom = null): int
{
    $now = time();
    $db->beginTransaction();
    try {
        $db->prepare('INSERT INTO designs
            (owner_id,name,input_mode,operation,bit_id,material_id,settings_json,
             svg_hash,notes,copied_from,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
           ->execute([
               $ownerId, $name, $f['input_mode'], $f['operation'],
               $f['bit_id'], $f['material_id'], $f['settings_json'],
               $f['svg_hash'], $f['notes'], $copiedFrom, $now, $now,
           ]);
        $id = (int) $db->lastInsertId();
        // A create has nothing to carry over, so any "unchanged" marker the
        // client sent is meaningless here and is dropped.
        design_write_assets($db, $id, $assets === null ? null
            : array_filter($assets, static function ($a) { return empty($a['unchanged']); }));
        $db->commit();
        return $id;
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }
}

/* ------------------------------------------------------------------ */
/* /api/designs                                                        */
/* ------------------------------------------------------------------ */

function handle_designs(string $method, ?int $id, array $parts): void
{
    $db  = forge_db();
    $sub = $parts[2] ?? null;

    // designs/:id/shares — the share links on one design.
    if ($id !== null && $sub === 'shares') {
        handle_design_shares($db, $method, $id);
    }

    // designs/:id/copy — duplicate one of my own designs.
    if ($id !== null && $sub === 'copy' && $method === 'POST') {
        forge_require_csrf();
        $me  = forge_require_user();
        $row = design_owned($db, $id, (int) $me['id']);
        $body = read_json_body();

        $name = design_unique_name($db, (int) $me['id'],
            clamp_str($body['name'] ?? '', 150) ?: ($row['name'] . ' (copy)'));

        $newId = design_copy_row($db, $row, (int) $me['id'], $name);
        $s = $db->prepare('SELECT * FROM designs WHERE id = ?');
        $s->execute([$newId]);
        json_response(design_full($db, $s->fetch()), 201);
    }

    switch ($method) {
        case 'GET':
            $me = forge_require_user();
            if ($id === null) {
                $s = $db->prepare(
                    'SELECT d.*,
                            (SELECT COALESCE(SUM(a.byte_size),0) FROM design_assets a
                             WHERE a.design_id = d.id) AS asset_bytes,
                            (SELECT COUNT(*) FROM design_shares sh
                             WHERE sh.design_id = d.id AND sh.revoked_at IS NULL) AS share_count
                     FROM designs d WHERE d.owner_id = ?
                     ORDER BY d.updated_at DESC, d.id DESC LIMIT 500');
                $s->execute([$me['id']]);
                json_response(array_map('design_summary', $s->fetchAll()));
            }
            json_response(design_full($db, design_owned($db, $id, (int) $me['id'])));
            break;

        case 'POST':
            forge_require_csrf();
            $me   = forge_require_user();
            $body = read_json_body();
            $f    = design_fields($body);
            $total = strlen($f['settings_json']);
            $assets = design_read_assets($body, $total);

            $name = design_unique_name($db, (int) $me['id'],
                clamp_str($body['name'] ?? '', 150, 'Untitled design'));
            $newId = design_insert($db, (int) $me['id'], $name, $f, $assets);

            $s = $db->prepare('SELECT * FROM designs WHERE id = ?');
            $s->execute([$newId]);
            json_response(design_full($db, $s->fetch()), 201);
            break;

        case 'PUT':
            if ($id === null) {
                json_response(['error' => 'PUT requires an id'], 400);
            }
            forge_require_csrf();
            $me   = forge_require_user();
            $row  = design_owned($db, $id, (int) $me['id']);
            $body = read_json_body();
            $f    = design_fields($body, $row);
            $total = strlen($f['settings_json']);
            $assets = design_read_assets($body, $total);

            $name = array_key_exists('name', $body)
                ? design_unique_name($db, (int) $me['id'],
                    clamp_str($body['name'] ?? '', 150, (string) $row['name']), $id)
                : (string) $row['name'];

            $db->beginTransaction();
            try {
                $db->prepare('UPDATE designs SET
                        name=?, input_mode=?, operation=?, bit_id=?, material_id=?,
                        settings_json=?, svg_hash=?, notes=?, updated_at=?
                    WHERE id = ? AND owner_id = ?')
                   ->execute([
                       $name, $f['input_mode'], $f['operation'], $f['bit_id'],
                       $f['material_id'], $f['settings_json'], $f['svg_hash'],
                       $f['notes'], time(), $id, $me['id'],
                   ]);
                design_write_assets($db, $id, $assets);
                $db->commit();
            } catch (Throwable $e) {
                if ($db->inTransaction()) {
                    $db->rollBack();
                }
                throw $e;
            }

            $s = $db->prepare('SELECT * FROM designs WHERE id = ?');
            $s->execute([$id]);
            json_response(design_full($db, $s->fetch()));
            break;

        case 'DELETE':
            if ($id === null) {
                json_response(['error' => 'DELETE requires an id'], 400);
            }
            forge_require_csrf();
            $me = forge_require_user();
            design_owned($db, $id, (int) $me['id']);
            // Assets and share links cascade, so every link to this design
            // stops working the moment it is deleted.
            $db->prepare('DELETE FROM designs WHERE id = ? AND owner_id = ?')
               ->execute([$id, $me['id']]);
            json_response(['deleted' => true]);
            break;

        default:
            json_response(['error' => 'Method not allowed'], 405);
    }
}

/** Duplicate a design row and its assets into $ownerId's account. */
function design_copy_row(PDO $db, array $row, int $ownerId, string $name): int
{
    $now = time();
    $db->beginTransaction();
    try {
        $db->prepare('INSERT INTO designs
            (owner_id,name,input_mode,operation,bit_id,material_id,settings_json,
             svg_hash,notes,copied_from,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
           ->execute([
               $ownerId, $name, $row['input_mode'], $row['operation'],
               $row['bit_id'], $row['material_id'], $row['settings_json'],
               $row['svg_hash'], $row['notes'], (int) $row['id'], $now, $now,
           ]);
        $newId = (int) $db->lastInsertId();

        // Copy the artwork server-side rather than round-tripping megabytes
        // through the browser to duplicate a design it already has.
        $db->prepare('INSERT INTO design_assets
                (design_id,kind,asset_key,filename,mime,byte_size,sha256,data,created_at)
              SELECT ?, kind, asset_key, filename, mime, byte_size, sha256, data, ?
              FROM design_assets WHERE design_id = ?')
           ->execute([$newId, $now, (int) $row['id']]);

        $db->commit();
        return $newId;
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }
}

/* ------------------------------------------------------------------ */
/* Share links                                                         */
/* ------------------------------------------------------------------ */

function share_row(array $r): array
{
    return [
        'id'             => (int) $r['id'],
        'design_id'      => (int) $r['design_id'],
        'token'          => $r['token'],
        'url'            => forge_app_url() . '?share=' . rawurlencode((string) $r['token']),
        'created_at'     => (int) $r['created_at'],
        'expires_at'     => $r['expires_at'] === null ? null : (int) $r['expires_at'],
        'revoked_at'     => $r['revoked_at'] === null ? null : (int) $r['revoked_at'],
        'view_count'     => (int) $r['view_count'],
        'last_viewed_at' => $r['last_viewed_at'] === null ? null : (int) $r['last_viewed_at'],
        'active'         => $r['revoked_at'] === null
            && ($r['expires_at'] === null || (int) $r['expires_at'] > time()),
    ];
}

function handle_design_shares(PDO $db, string $method, int $designId): void
{
    $me = forge_require_user();
    design_owned($db, $designId, (int) $me['id']);

    if ($method === 'GET') {
        $s = $db->prepare('SELECT * FROM design_shares WHERE design_id = ? ORDER BY id DESC');
        $s->execute([$designId]);
        json_response(array_map('share_row', $s->fetchAll()));
    }

    if ($method === 'POST') {
        forge_require_csrf();
        $body = read_json_body();
        $days = (int) ($body['expires_days'] ?? 0);
        $days = max(0, min(3650, $days));
        $now  = time();

        $db->prepare('INSERT INTO design_shares
            (design_id,token,created_by,created_at,expires_at)
            VALUES (?,?,?,?,?)')
           ->execute([
               $designId, forge_token(), $me['id'], $now,
               $days === 0 ? null : $now + $days * 86400,
           ]);
        $s = $db->prepare('SELECT * FROM design_shares WHERE id = ?');
        $s->execute([(int) $db->lastInsertId()]);
        json_response(share_row($s->fetch()), 201);
    }

    json_response(['error' => 'Method not allowed'], 405);
}

/** /api/shares/:id — revoke a link. Only the design's owner may. */
function handle_shares(string $method, ?int $id): void
{
    if ($method !== 'DELETE' || $id === null) {
        json_response(['error' => 'Method not allowed'], 405);
    }
    forge_require_csrf();
    $db = forge_db();
    $me = forge_require_user();

    $s = $db->prepare('SELECT sh.id FROM design_shares sh
                       JOIN designs d ON d.id = sh.design_id
                       WHERE sh.id = ? AND d.owner_id = ?');
    $s->execute([$id, $me['id']]);
    if (!$s->fetchColumn()) {
        json_response(['error' => 'Share link not found.'], 404);
    }
    $u = $db->prepare('UPDATE design_shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL');
    $u->execute([time(), $id]);
    json_response(['revoked' => $u->rowCount() > 0]);
}

/* ------------------------------------------------------------------ */
/* /api/shared/:token — the public read-only view                      */
/* ------------------------------------------------------------------ */

function handle_shared(string $method, array $parts): void
{
    $db    = forge_db();
    $token = clamp_str($parts[1] ?? '', 64);
    $sub   = $parts[2] ?? null;

    if ($token === '') {
        json_response(['error' => 'Share link is missing its token.'], 400);
    }

    $s = $db->prepare(
        'SELECT sh.id AS share_id, sh.token, sh.expires_at, sh.revoked_at,
                d.*, u.display_name AS owner_name
         FROM design_shares sh
         JOIN designs d ON d.id = sh.design_id
         JOIN users   u ON u.id = d.owner_id
         WHERE sh.token = ? LIMIT 1');
    $s->execute([$token]);
    $row = $s->fetch();

    // One message for "never existed", "revoked" and "expired". Telling them
    // apart would let someone probing tokens learn which ones were once real.
    if (!$row
        || $row['revoked_at'] !== null
        || ($row['expires_at'] !== null && (int) $row['expires_at'] < time())) {
        json_response([
            'error' => 'This share link is not available. It may have been revoked or expired.',
            'code'  => 'share_unavailable',
        ], 404);
    }

    // shared/:token/copy — take a copy into my own account.
    if ($sub === 'copy') {
        if ($method !== 'POST') {
            json_response(['error' => 'Method not allowed'], 405);
        }
        forge_require_csrf();
        $me   = forge_require_user();
        $body = read_json_body();
        $name = design_unique_name($db, (int) $me['id'],
            clamp_str($body['name'] ?? '', 150) ?: ($row['name'] . ' (copy)'));
        $newId = design_copy_row($db, $row, (int) $me['id'], $name);
        $d = $db->prepare('SELECT * FROM designs WHERE id = ?');
        $d->execute([$newId]);
        json_response(design_full($db, $d->fetch()), 201);
    }

    if ($method !== 'GET') {
        json_response(['error' => 'Method not allowed'], 405);
    }

    // Best-effort view accounting — never worth failing the read over.
    try {
        $db->prepare('UPDATE design_shares SET view_count = view_count + 1, last_viewed_at = ?
                      WHERE id = ?')->execute([time(), (int) $row['share_id']]);
    } catch (Throwable $e) { /* ignore */ }

    $out = design_full($db, $row);
    // The recipient gets the design and a display name, never the owner's
    // email or user id, and never the ids of anyone else's rows.
    unset($out['copied_from']);
    $out['read_only']  = true;
    $out['owner_name'] = $row['owner_name'];
    $out['share']      = ['token' => $row['token']];

    // A share link must not be indexed or leak its token through a Referer.
    header('X-Robots-Tag: noindex, nofollow, noarchive');
    json_response($out);
}
