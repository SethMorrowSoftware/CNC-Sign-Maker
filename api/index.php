<?php
/**
 * LowRider Forge — API router.
 *
 * Single entry point. The frontend calls api/index.php?r=<resource>[/<id>].
 *
 * Routing uses a query-string parameter because PATH_INFO
 * (api/index.php/<resource>) is unreliable on shared cPanel hosting — many
 * PHP-FPM / CGI handlers do not populate $_SERVER['PATH_INFO']. PATH_INFO is
 * still accepted as a fallback so existing links keep working.
 */
declare(strict_types=1);

define('FORGE_APP', true);

header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');
header('Cache-Control: no-store');

require __DIR__ . '/db.php';

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// Prefer the query-string route; fall back to PATH_INFO.
$route = (string) ($_GET['r'] ?? '');
if ($route === '') {
    $route = (string) ($_SERVER['PATH_INFO'] ?? '');
}
$parts    = array_values(array_filter(explode('/', $route), 'strlen'));
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
        case '':
            json_response(['error' => 'No API endpoint specified.'], 404);
            break;
        default:
            json_response(['error' => 'Unknown endpoint: ' . $resource], 404);
    }
} catch (RuntimeException $e) {
    // Operator-actionable configuration problems — safe and useful to surface.
    json_response(['error' => $e->getMessage()], 503);
} catch (Throwable $e) {
    // Unexpected — log the detail server-side, return a generic message so no
    // filesystem path or SQL ever reaches the browser.
    error_log('LowRider Forge API error: ' . $e->getMessage()
        . ' @ ' . $e->getFile() . ':' . $e->getLine());
    json_response(['error' => 'Internal server error. See the server error log for detail.'], 500);
}
