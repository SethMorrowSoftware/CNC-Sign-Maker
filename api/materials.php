<?php
/**
 * LowRider Forge — /api/materials CRUD.
 *
 * Same ownership rule as bits: the seeded set belongs to owner 0, is shared
 * by every account and is read-only. Editing one forks a private copy, so a
 * user retuning feeds for their own plywood never changes the numbers under
 * someone else's saved preset.
 */
declare(strict_types=1);

defined('FORGE_APP') || exit('Direct access denied');

function material_payload(array $body): array
{
    return [
        'name'                    => clamp_str(require_str($body, 'name'), 190),
        'thickness_mm'            => nf($body['thickness_mm'] ?? null),
        'recommended_bit_type'    => clamp_str($body['recommended_bit_type'] ?? '', 32),
        'recommended_rpm'         => ni($body['recommended_rpm'] ?? null),
        'recommended_feed_cut'    => ni($body['recommended_feed_cut'] ?? null),
        'recommended_feed_plunge' => ni($body['recommended_feed_plunge'] ?? null),
        'recommended_doc_mm'      => nf($body['recommended_doc_mm'] ?? null),
        'through_cut_overage_mm'  => nf($body['through_cut_overage_mm'] ?? null) ?? 0.65,
        'notes'                   => clamp_str($body['notes'] ?? '', 2000),
    ];
}

/** Add the flags the UI needs to decide what a user may do with a row. */
function material_row(array $r): array
{
    $r['owner_id'] = (int) $r['owner_id'];
    $r['builtin']  = $r['owner_id'] === FORGE_SYSTEM_OWNER;
    $r['editable'] = !$r['builtin'] && $r['owner_id'] === forge_current_user_id();
    return $r;
}

function material_by_id(PDO $db, int $id): ?array
{
    $s = $db->prepare('SELECT * FROM materials WHERE id = ?');
    $s->execute([$id]);
    return $s->fetch() ?: null;
}

function material_visible(array $row): bool
{
    $owner = (int) $row['owner_id'];
    return $owner === FORGE_SYSTEM_OWNER || $owner === forge_current_user_id();
}

const MATERIAL_INSERT_SQL = 'INSERT INTO materials
    (owner_id,name,thickness_mm,recommended_bit_type,recommended_rpm,recommended_feed_cut,
     recommended_feed_plunge,recommended_doc_mm,through_cut_overage_mm,notes)
    VALUES (:owner_id,:name,:thickness_mm,:recommended_bit_type,:recommended_rpm,
     :recommended_feed_cut,:recommended_feed_plunge,:recommended_doc_mm,
     :through_cut_overage_mm,:notes)';

function handle_materials(string $method, ?int $id): void
{
    $db  = forge_db();
    $uid = forge_current_user_id();

    switch ($method) {
        case 'GET':
            if ($id !== null) {
                $row = material_by_id($db, $id);
                if (!$row || !material_visible($row)) {
                    json_response(['error' => 'Material not found'], 404);
                }
                json_response(material_row($row));
            }
            $s = $db->prepare('SELECT * FROM materials WHERE owner_id IN (0, ?)
                               ORDER BY owner_id, name');
            $s->execute([$uid]);
            json_response(array_map('material_row', $s->fetchAll()));
            break;

        case 'POST':
            forge_require_csrf();
            $me = forge_require_user();
            $p  = material_payload(read_json_body());
            $p['owner_id'] = (int) $me['id'];
            try {
                $db->prepare(MATERIAL_INSERT_SQL)->execute($p);
            } catch (PDOException $e) {
                // Only a UNIQUE/constraint violation means "name taken".
                // A read-only database or full disk also throws PDOException
                // and must surface as a 500 with the real cause, not send the
                // user renaming in circles.
                if ((string) $e->getCode() === '23000') {
                    json_response(['error' => 'You already have a material with that name'], 409);
                }
                throw $e;
            }
            json_response(material_row(material_by_id($db, (int) $db->lastInsertId())), 201);
            break;

        case 'PUT':
            if ($id === null) {
                json_response(['error' => 'PUT requires an id'], 400);
            }
            forge_require_csrf();
            $me  = forge_require_user();
            $p   = material_payload(read_json_body());
            $row = material_by_id($db, $id);
            if (!$row || !material_visible($row)) {
                json_response(['error' => 'Material not found'], 404);
            }

            if ((int) $row['owner_id'] === FORGE_SYSTEM_OWNER) {
                // Fork the built-in rather than refusing the edit.
                $p['owner_id'] = (int) $me['id'];
                if ($p['name'] === (string) $row['name']) {
                    $p['name'] = clamp_str($p['name'] . ' (mine)', 190);
                }
                try {
                    $db->prepare(MATERIAL_INSERT_SQL)->execute($p);
                } catch (PDOException $e) {
                    if ((string) $e->getCode() === '23000') {
                        json_response(['error' => 'You already have a material with that name'], 409);
                    }
                    throw $e;
                }
                $new = material_row(material_by_id($db, (int) $db->lastInsertId()));
                $new['forked_from'] = $id;
                json_response($new, 201);
            }

            $p['id'] = $id;
            try {
                $s = $db->prepare('UPDATE materials SET
                    name=:name, thickness_mm=:thickness_mm, recommended_bit_type=:recommended_bit_type,
                    recommended_rpm=:recommended_rpm, recommended_feed_cut=:recommended_feed_cut,
                    recommended_feed_plunge=:recommended_feed_plunge, recommended_doc_mm=:recommended_doc_mm,
                    through_cut_overage_mm=:through_cut_overage_mm, notes=:notes WHERE id=:id');
                $s->execute($p);
            } catch (PDOException $e) {
                if ((string) $e->getCode() === '23000') {
                    json_response(['error' => 'You already have a material with that name'], 409);
                }
                throw $e;
            }
            json_response(material_row(material_by_id($db, $id)));
            break;

        case 'DELETE':
            if ($id === null) {
                json_response(['error' => 'DELETE requires an id'], 400);
            }
            forge_require_csrf();
            $me  = forge_require_user();
            $row = material_by_id($db, $id);
            if (!$row || !material_visible($row)) {
                json_response(['error' => 'Material not found'], 404);
            }
            if ((int) $row['owner_id'] === FORGE_SYSTEM_OWNER) {
                json_response([
                    'error' => 'This material ships with the tool and is shared by every '
                        . 'account, so it cannot be deleted. Edit it to make your own copy.',
                ], 403);
            }
            $s = $db->prepare('DELETE FROM materials WHERE id = ? AND owner_id = ?');
            $s->execute([$id, $me['id']]);
            json_response(['deleted' => $s->rowCount() > 0]);
            break;

        default:
            json_response(['error' => 'Method not allowed'], 405);
    }
}
