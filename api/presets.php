<?php
/**
 * LowRider Forge — /api/presets. Save / load full job settings.
 *
 * A preset is machining settings only; the artwork lives in a design (see
 * api/designs.php). Presets are per-account, plus the four the tool ships
 * with under owner 0, which everyone can load and nobody can overwrite.
 *
 * The upsert here is keyed on (owner_id, name), not on name alone. Under the
 * old single-tenant schema "Save preset" upserted by name globally, so two
 * accounts saving "My preset" would silently overwrite each other.
 */
declare(strict_types=1);

defined('FORGE_APP') || exit('Direct access denied');

function preset_row(PDO $db, int $id): ?array
{
    $s = $db->prepare('SELECT * FROM presets WHERE id = ?');
    $s->execute([$id]);
    $row = $s->fetch();
    if (!$row) {
        return null;
    }
    return preset_shape($row);
}

function preset_shape(array $row): array
{
    $row['settings'] = json_decode((string) $row['settings_json'], true);
    $row['owner_id'] = (int) $row['owner_id'];
    $row['builtin']  = $row['owner_id'] === FORGE_SYSTEM_OWNER;
    $row['editable'] = !$row['builtin'] && $row['owner_id'] === forge_current_user_id();
    return $row;
}

function preset_visible(array $row): bool
{
    $owner = (int) $row['owner_id'];
    return $owner === FORGE_SYSTEM_OWNER || $owner === forge_current_user_id();
}

function handle_presets(string $method, ?int $id): void
{
    $db  = forge_db();
    $uid = forge_current_user_id();

    switch ($method) {
        case 'GET':
            if ($id !== null) {
                $s = $db->prepare('SELECT * FROM presets WHERE id = ?');
                $s->execute([$id]);
                $row = $s->fetch();
                if (!$row || !preset_visible($row)) {
                    json_response(['error' => 'Preset not found'], 404);
                }
                json_response(preset_shape($row));
            }
            $s = $db->prepare('SELECT * FROM presets WHERE owner_id IN (0, ?)
                               ORDER BY owner_id, name');
            $s->execute([$uid]);
            json_response(array_map('preset_shape', $s->fetchAll()));
            break;

        case 'POST':
            forge_require_csrf();
            $me   = forge_require_user();
            $body = read_json_body();
            $name      = clamp_str(require_str($body, 'name'), 190);
            $operation = clamp_str(require_str($body, 'operation'), 32);
            $settings  = $body['settings'] ?? $body['settings_json'] ?? [];
            if (is_string($settings)) {
                $decoded = json_decode($settings, true);
                if (!is_array($decoded)) {
                    // Silently storing an empty preset on undecodable JSON
                    // would report success while dropping every setting.
                    json_response(['error' => 'settings is not valid JSON'], 400);
                }
                $settings = $decoded;
            }
            $settingsJson = json_encode($settings, JSON_UNESCAPED_SLASHES);
            if ($settingsJson === false) {
                json_response(['error' => 'settings contains invalid UTF-8'], 400);
            }

            $now = time();
            // created_at and updated_at get their own placeholders even though
            // they carry the same value: prepared statements are native (see
            // PDO::ATTR_EMULATE_PREPARES in api/db.php), and MySQL rejects a
            // named parameter that appears twice in one statement.
            $params = [
                'owner_id'    => (int) $me['id'],
                'name'        => $name,
                'bit_id'      => ni($body['bit_id'] ?? null),
                'material_id' => ni($body['material_id'] ?? null),
                'operation'   => $operation,
                'sj'          => $settingsJson,
                'created'     => $now,
                'updated'     => $now,
            ];
            // Upsert on the (owner_id, name) key so "Save preset" overwrites
            // this user's own preset of that name and nobody else's.
            $s = $db->prepare('INSERT INTO presets
                (owner_id,name,bit_id,material_id,operation,settings_json,created_at,updated_at)
                VALUES (:owner_id,:name,:bit_id,:material_id,:operation,:sj,:created,:updated)
                ON DUPLICATE KEY UPDATE
                    bit_id=VALUES(bit_id), material_id=VALUES(material_id),
                    operation=VALUES(operation), settings_json=VALUES(settings_json),
                    updated_at=VALUES(updated_at)');
            $s->execute($params);

            $s = $db->prepare('SELECT id FROM presets WHERE owner_id = ? AND name = ?');
            $s->execute([$me['id'], $name]);
            json_response(preset_row($db, (int) $s->fetchColumn()), 201);
            break;

        case 'DELETE':
            if ($id === null) {
                json_response(['error' => 'DELETE requires an id'], 400);
            }
            forge_require_csrf();
            $me = forge_require_user();
            $s  = $db->prepare('SELECT owner_id FROM presets WHERE id = ?');
            $s->execute([$id]);
            $owner = $s->fetchColumn();
            if ($owner === false) {
                json_response(['error' => 'Preset not found'], 404);
            }
            if ((int) $owner === FORGE_SYSTEM_OWNER) {
                json_response([
                    'error' => 'This preset ships with the tool and is shared by every '
                        . 'account, so it cannot be deleted.',
                ], 403);
            }
            if ((int) $owner !== (int) $me['id']) {
                json_response(['error' => 'Preset not found'], 404);
            }
            $s = $db->prepare('DELETE FROM presets WHERE id = ? AND owner_id = ?');
            $s->execute([$id, $me['id']]);
            json_response(['deleted' => $s->rowCount() > 0]);
            break;

        default:
            json_response(['error' => 'Method not allowed'], 405);
    }
}
