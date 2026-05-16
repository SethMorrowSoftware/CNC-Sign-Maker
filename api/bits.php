<?php
/** LowRider Forge — /api/bits CRUD. */
declare(strict_types=1);

defined('FORGE_APP') || exit('Direct access denied');

const BIT_TYPES = ['upcut', 'downcut', 'compression', 'O-flute', 'V-bit'];

function bit_payload(array $body): array
{
    $type = (string) ($body['type'] ?? 'upcut');
    if (!in_array($type, BIT_TYPES, true)) {
        json_response(['error' => 'type must be one of: ' . implode(', ', BIT_TYPES)], 400);
    }
    $dia = nf($body['diameter_mm'] ?? null);
    if ($dia === null || $dia <= 0) {
        json_response(['error' => 'diameter_mm must be a positive number'], 400);
    }
    return [
        'name'              => require_str($body, 'name'),
        'diameter_mm'       => $dia,
        'shank_diameter_mm' => nf($body['shank_diameter_mm'] ?? null),
        'flute_count'       => max(1, ni($body['flute_count'] ?? null) ?? 2),
        'cutting_length_mm' => nf($body['cutting_length_mm'] ?? null),
        'type'              => $type,
        'notes'             => trim((string) ($body['notes'] ?? '')),
    ];
}

function handle_bits(string $method, ?int $id): void
{
    $db = forge_db();

    switch ($method) {
        case 'GET':
            if ($id !== null) {
                $s = $db->prepare('SELECT * FROM bits WHERE id = ?');
                $s->execute([$id]);
                $row = $s->fetch();
                $row ? json_response($row) : json_response(['error' => 'Bit not found'], 404);
            }
            json_response($db->query('SELECT * FROM bits ORDER BY name')->fetchAll());
            break;

        case 'POST':
            $p = bit_payload(read_json_body());
            try {
                $s = $db->prepare('INSERT INTO bits
                    (name,diameter_mm,shank_diameter_mm,flute_count,cutting_length_mm,type,notes)
                    VALUES (:name,:diameter_mm,:shank_diameter_mm,:flute_count,:cutting_length_mm,:type,:notes)');
                $s->execute($p);
            } catch (PDOException $e) {
                json_response(['error' => 'A bit with that name already exists'], 409);
            }
            $s = $db->prepare('SELECT * FROM bits WHERE id = ?');
            $s->execute([(int) $db->lastInsertId()]);
            json_response($s->fetch(), 201);
            break;

        case 'PUT':
            if ($id === null) {
                json_response(['error' => 'PUT requires an id'], 400);
            }
            $p = bit_payload(read_json_body());
            $p['id'] = $id;
            $s = $db->prepare('UPDATE bits SET
                name=:name, diameter_mm=:diameter_mm, shank_diameter_mm=:shank_diameter_mm,
                flute_count=:flute_count, cutting_length_mm=:cutting_length_mm,
                type=:type, notes=:notes WHERE id=:id');
            $s->execute($p);
            if ($s->rowCount() === 0) {
                json_response(['error' => 'Bit not found'], 404);
            }
            $s = $db->prepare('SELECT * FROM bits WHERE id = ?');
            $s->execute([$id]);
            json_response($s->fetch());
            break;

        case 'DELETE':
            if ($id === null) {
                json_response(['error' => 'DELETE requires an id'], 400);
            }
            $s = $db->prepare('DELETE FROM bits WHERE id = ?');
            $s->execute([$id]);
            json_response(['deleted' => $s->rowCount() > 0]);
            break;

        default:
            json_response(['error' => 'Method not allowed'], 405);
    }
}
