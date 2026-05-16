<?php
/** LowRider Forge — /api/presets. Save / load full job settings. */
declare(strict_types=1);

defined('FORGE_APP') || exit('Direct access denied');

function preset_row(PDO $db, int $id): ?array
{
    $s = $db->prepare('SELECT * FROM presets WHERE id = ?');
    $s->execute([$id]);
    $row = $s->fetch();
    if ($row) {
        $row['settings'] = json_decode((string) $row['settings_json'], true);
    }
    return $row ?: null;
}

function handle_presets(string $method, ?int $id): void
{
    $db = forge_db();

    switch ($method) {
        case 'GET':
            if ($id !== null) {
                $row = preset_row($db, $id);
                $row ? json_response($row) : json_response(['error' => 'Preset not found'], 404);
            }
            $rows = $db->query('SELECT * FROM presets ORDER BY name')->fetchAll();
            foreach ($rows as &$r) {
                $r['settings'] = json_decode((string) $r['settings_json'], true);
            }
            json_response($rows);
            break;

        case 'POST':
            $body = read_json_body();
            $name      = require_str($body, 'name');
            $operation = require_str($body, 'operation');
            $settings  = $body['settings'] ?? $body['settings_json'] ?? [];
            if (is_string($settings)) {
                $settings = json_decode($settings, true) ?: [];
            }
            $now = time();
            $params = [
                'name'        => $name,
                'bit_id'      => ni($body['bit_id'] ?? null),
                'material_id' => ni($body['material_id'] ?? null),
                'operation'   => $operation,
                'sj'          => json_encode($settings, JSON_UNESCAPED_SLASHES),
                'now'         => $now,
            ];
            // Upsert by unique name so "Save preset" overwrites cleanly.
            $s = $db->prepare('INSERT INTO presets
                (name,bit_id,material_id,operation,settings_json,created_at,updated_at)
                VALUES (:name,:bit_id,:material_id,:operation,:sj,:now,:now)
                ON CONFLICT(name) DO UPDATE SET
                    bit_id=excluded.bit_id, material_id=excluded.material_id,
                    operation=excluded.operation, settings_json=excluded.settings_json,
                    updated_at=excluded.updated_at');
            $s->execute($params);
            $s = $db->prepare('SELECT id FROM presets WHERE name = ?');
            $s->execute([$name]);
            json_response(preset_row($db, (int) $s->fetchColumn()), 201);
            break;

        case 'DELETE':
            if ($id === null) {
                json_response(['error' => 'DELETE requires an id'], 400);
            }
            $s = $db->prepare('DELETE FROM presets WHERE id = ?');
            $s->execute([$id]);
            json_response(['deleted' => $s->rowCount() > 0]);
            break;

        default:
            json_response(['error' => 'Method not allowed'], 405);
    }
}
