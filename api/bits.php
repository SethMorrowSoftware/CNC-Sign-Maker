<?php
/**
 * LowRider Forge — /api/bits CRUD.
 *
 * The seeded sign-shop set belongs to owner 0 and is read-only: it is shared
 * by every account, so letting one user edit a shared bit in place would
 * silently change the tool geometry under everyone else's saved presets.
 * Editing a built-in bit therefore forks it into a private copy instead —
 * the user gets what they asked for, nobody else's library moves.
 */
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
        'name'              => clamp_str(require_str($body, 'name'), 190),
        'diameter_mm'       => $dia,
        'shank_diameter_mm' => nf($body['shank_diameter_mm'] ?? null),
        'flute_count'       => max(1, ni($body['flute_count'] ?? null) ?? 2),
        'cutting_length_mm' => nf($body['cutting_length_mm'] ?? null),
        'type'              => $type,
        'v_angle_deg'       => nf($body['v_angle_deg'] ?? null),
        'notes'             => clamp_str($body['notes'] ?? '', 2000),
    ];
}

/** Add the flags the UI needs to decide what a user may do with a row. */
function bit_row(array $r): array
{
    $r['owner_id'] = (int) $r['owner_id'];
    $r['builtin']  = $r['owner_id'] === FORGE_SYSTEM_OWNER;
    $r['editable'] = !$r['builtin'] && $r['owner_id'] === forge_current_user_id();
    return $r;
}

function bit_by_id(PDO $db, int $id): ?array
{
    $s = $db->prepare('SELECT * FROM bits WHERE id = ?');
    $s->execute([$id]);
    return $s->fetch() ?: null;
}

/** A bit is visible when it is built in, or when the caller owns it. */
function bit_visible(array $row): bool
{
    $owner = (int) $row['owner_id'];
    return $owner === FORGE_SYSTEM_OWNER || $owner === forge_current_user_id();
}

function handle_bits(string $method, ?int $id): void
{
    $db  = forge_db();
    $uid = forge_current_user_id();

    switch ($method) {
        case 'GET':
            if ($id !== null) {
                $row = bit_by_id($db, $id);
                if (!$row || !bit_visible($row)) {
                    json_response(['error' => 'Bit not found'], 404);
                }
                json_response(bit_row($row));
            }
            // Built-ins first, then the user's own, each alphabetical — the
            // pickers read as one list with the shipped set on top.
            $s = $db->prepare('SELECT * FROM bits WHERE owner_id IN (0, ?)
                               ORDER BY owner_id, name');
            $s->execute([$uid]);
            json_response(array_map('bit_row', $s->fetchAll()));
            break;

        case 'POST':
            forge_require_csrf();
            $me = forge_require_user();
            $p  = bit_payload(read_json_body());
            $p['owner_id'] = (int) $me['id'];
            try {
                $s = $db->prepare('INSERT INTO bits
                    (owner_id,name,diameter_mm,shank_diameter_mm,flute_count,cutting_length_mm,type,v_angle_deg,notes)
                    VALUES (:owner_id,:name,:diameter_mm,:shank_diameter_mm,:flute_count,:cutting_length_mm,:type,:v_angle_deg,:notes)');
                $s->execute($p);
            } catch (PDOException $e) {
                // Only a UNIQUE/constraint violation means "name taken".
                // A read-only database or full disk also throws PDOException
                // and must surface as a 500 with the real cause, not send the
                // user renaming in circles.
                if ((string) $e->getCode() === '23000') {
                    json_response(['error' => 'You already have a bit with that name'], 409);
                }
                throw $e;
            }
            json_response(bit_row(bit_by_id($db, (int) $db->lastInsertId())), 201);
            break;

        case 'PUT':
            if ($id === null) {
                json_response(['error' => 'PUT requires an id'], 400);
            }
            forge_require_csrf();
            $me  = forge_require_user();
            $p   = bit_payload(read_json_body());
            $row = bit_by_id($db, $id);
            if (!$row || !bit_visible($row)) {
                json_response(['error' => 'Bit not found'], 404);
            }

            if ((int) $row['owner_id'] === FORGE_SYSTEM_OWNER) {
                // Fork the built-in rather than refusing the edit. The name is
                // nudged only if the user kept the original, so two accounts
                // can each hold their own "1/4in upcut" without colliding.
                $p['owner_id'] = (int) $me['id'];
                if ($p['name'] === (string) $row['name']) {
                    $p['name'] = clamp_str($p['name'] . ' (mine)', 190);
                }
                try {
                    $s = $db->prepare('INSERT INTO bits
                        (owner_id,name,diameter_mm,shank_diameter_mm,flute_count,cutting_length_mm,type,v_angle_deg,notes)
                        VALUES (:owner_id,:name,:diameter_mm,:shank_diameter_mm,:flute_count,:cutting_length_mm,:type,:v_angle_deg,:notes)');
                    $s->execute($p);
                } catch (PDOException $e) {
                    if ((string) $e->getCode() === '23000') {
                        json_response(['error' => 'You already have a bit with that name'], 409);
                    }
                    throw $e;
                }
                $new = bit_row(bit_by_id($db, (int) $db->lastInsertId()));
                $new['forked_from'] = $id;
                json_response($new, 201);
            }

            $p['id'] = $id;
            try {
                $s = $db->prepare('UPDATE bits SET
                    name=:name, diameter_mm=:diameter_mm, shank_diameter_mm=:shank_diameter_mm,
                    flute_count=:flute_count, cutting_length_mm=:cutting_length_mm,
                    type=:type, v_angle_deg=:v_angle_deg, notes=:notes WHERE id=:id');
                $s->execute($p);
            } catch (PDOException $e) {
                if ((string) $e->getCode() === '23000') {
                    json_response(['error' => 'You already have a bit with that name'], 409);
                }
                throw $e;
            }
            json_response(bit_row(bit_by_id($db, $id)));
            break;

        case 'DELETE':
            if ($id === null) {
                json_response(['error' => 'DELETE requires an id'], 400);
            }
            forge_require_csrf();
            $me  = forge_require_user();
            $row = bit_by_id($db, $id);
            if (!$row || !bit_visible($row)) {
                json_response(['error' => 'Bit not found'], 404);
            }
            if ((int) $row['owner_id'] === FORGE_SYSTEM_OWNER) {
                json_response([
                    'error' => 'This bit ships with the tool and is shared by every '
                        . 'account, so it cannot be deleted. Edit it to make your own copy.',
                ], 403);
            }
            $s = $db->prepare('DELETE FROM bits WHERE id = ? AND owner_id = ?');
            $s->execute([$id, $me['id']]);
            json_response(['deleted' => $s->rowCount() > 0]);
            break;

        default:
            json_response(['error' => 'Method not allowed'], 405);
    }
}
