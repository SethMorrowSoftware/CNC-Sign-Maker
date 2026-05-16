<?php
/**
 * LowRider Forge — API router.
 * Single entry point. The frontend calls api/index.php/<resource>[/<id>].
 * PATH_INFO routing works under `php -S` and Apache without rewrite rules.
 */
declare(strict_types=1);

define('FORGE_APP', true);
require __DIR__ . '/db.php';

header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

$method = $_SERVER['REQUEST_METHOD'];
if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$path  = $_SERVER['PATH_INFO'] ?? '';
$parts = array_values(array_filter(explode('/', $path), 'strlen'));
$resource = $parts[0] ?? '';
$id       = isset($parts[1]) && ctype_digit($parts[1]) ? (int) $parts[1] : null;
$action   = $parts[1] ?? null;

require __DIR__ . '/bits.php';
require __DIR__ . '/materials.php';
require __DIR__ . '/presets.php';
require __DIR__ . '/jobs.php';

try {
    switch ($resource) {
        case 'bits':
            handle_bits($method, $id);
            break;
        case 'materials':
            handle_materials($method, $id);
            break;
        case 'presets':
            handle_presets($method, $id);
            break;
        case 'jobs':
            handle_jobs($method, $id, $action);
            break;
        case 'health':
            json_response(['ok' => true, 'version' => FORGE_VERSION, 'php' => PHP_VERSION]);
            break;
        default:
            json_response(['error' => 'Unknown endpoint: /' . $resource], 404);
    }
} catch (Throwable $e) {
    json_response(['error' => $e->getMessage()], 500);
}
