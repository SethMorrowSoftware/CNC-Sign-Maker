<?php
/** LowRider Forge — /api/materials CRUD. */
declare(strict_types=1);

defined('FORGE_APP') || exit('Direct access denied');

function material_payload(array $body): array
{
    return [
        'name'                    => require_str($body, 'name'),
        'thickness_mm'            => nf($body['thickness_mm'] ?? null),
        'recommended_bit_type'    => trim((string) ($body['recommended_bit_type'] ?? '')),
        'recommended_rpm'         => ni($body['recommended_rpm'] ?? null),
        'recommended_feed_cut'    => ni($body['recommended_feed_cut'] ?? null),
        'recommended_feed_plunge' => ni($body['recommended_feed_plunge'] ?? null),
        'recommended_doc_mm'      => nf($body['recommended_doc_mm'] ?? null),
        'through_cut_overage_mm'  => nf($body['through_cut_overage_mm'] ?? null) ?? 0.65,
        'notes'                   => trim((string) ($body['notes'] ?? '')),
    ];
}

function handle_materials(string $method, ?int $id): void
{
    $db = forge_db();

    switch ($method) {
        case 'GET':
            if ($id !== null) {
                $s = $db->prepare('SELECT * FROM materials WHERE id = ?');
                $s->execute([$id]);
                $row = $s->fetch();
                $row ? json_response($row) : json_response(['error' => 'Material not found'], 404);
            }
            json_response($db->query('SELECT * FROM materials ORDER BY name')->fetchAll());
            break;

        case 'POST':
            $p = material_payload(read_json_body());
            try {
                $s = $db->prepare('INSERT INTO materials
                    (name,thickness_mm,recommended_bit_type,recommended_rpm,recommended_feed_cut,
                     recommended_feed_plunge,recommended_doc_mm,through_cut_overage_mm,notes)
                    VALUES (:name,:thickness_mm,:recommended_bit_type,:recommended_rpm,
                     :recommended_feed_cut,:recommended_feed_plunge,:recommended_doc_mm,
                     :through_cut_overage_mm,:notes)');
                $s->execute($p);
            } catch (PDOException $e) {
                // Only a UNIQUE/constraint violation means "name taken".
                // A read-only database or full disk also throws PDOException
                // and must surface as a 500 with the real cause, not send the
                // user renaming in circles.
                if ((string) $e->getCode() === '23000') {
                    json_response(['error' => 'A material with that name already exists'], 409);
                }
                throw $e;
            }
            $s = $db->prepare('SELECT * FROM materials WHERE id = ?');
            $s->execute([(int) $db->lastInsertId()]);
            json_response($s->fetch(), 201);
            break;

        case 'PUT':
            if ($id === null) {
                json_response(['error' => 'PUT requires an id'], 400);
            }
            $p = material_payload(read_json_body());
            $p['id'] = $id;
            $exists = $db->prepare('SELECT 1 FROM materials WHERE id = ?');
            $exists->execute([$id]);
            if (!$exists->fetchColumn()) {
                json_response(['error' => 'Material not found'], 404);
            }
            try {
                $s = $db->prepare('UPDATE materials SET
                    name=:name, thickness_mm=:thickness_mm, recommended_bit_type=:recommended_bit_type,
                    recommended_rpm=:recommended_rpm, recommended_feed_cut=:recommended_feed_cut,
                    recommended_feed_plunge=:recommended_feed_plunge, recommended_doc_mm=:recommended_doc_mm,
                    through_cut_overage_mm=:through_cut_overage_mm, notes=:notes WHERE id=:id');
                $s->execute($p);
            } catch (PDOException $e) {
                // Only a UNIQUE/constraint violation means "name taken".
                // A read-only database or full disk also throws PDOException
                // and must surface as a 500 with the real cause, not send the
                // user renaming in circles.
                if ((string) $e->getCode() === '23000') {
                    json_response(['error' => 'A material with that name already exists'], 409);
                }
                throw $e;
            }
            $s = $db->prepare('SELECT * FROM materials WHERE id = ?');
            $s->execute([$id]);
            json_response($s->fetch());
            break;

        case 'DELETE':
            if ($id === null) {
                json_response(['error' => 'DELETE requires an id'], 400);
            }
            $s = $db->prepare('DELETE FROM materials WHERE id = ?');
            $s->execute([$id]);
            json_response(['deleted' => $s->rowCount() > 0]);
            break;

        default:
            json_response(['error' => 'Method not allowed'], 405);
    }
}
