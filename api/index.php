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
 *
 * Authentication is per-handler, not blanket: reading the bit and material
 * library, checking health and opening a share link all work signed out,
 * because the tool is usable anonymously and only persistence needs an
 * account. Every handler that writes calls forge_require_user() and
 * forge_require_csrf() itself.
 */
declare(strict_types=1);

define('FORGE_APP', true);

header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');
header('Cache-Control: no-store');
// Responses differ by signed-in user, so no shared cache may reuse one
// account's library or design list for another.
header('Vary: Cookie');

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

/**
 * What may follow a resource name: a numeric id, or one of the listed words.
 *
 * Without this, "designs/1 OR 1=1" and "jobs/../../etc/passwd" both parse to a
 * null id and quietly fall through to the collection listing. Nothing unsafe
 * reaches the database or the filesystem either way — ids are bound
 * parameters and job paths go through basename() — but answering a malformed
 * request with a successful listing is the kind of surprise that hides real
 * bugs. Resources absent from this map take a free-form second segment on
 * purpose: auth/<action> and shared/<token>.
 */
const FORGE_ID_ROUTES = [
    'bits'      => [],
    'materials' => [],
    'presets'   => [],
    'designs'   => [],
    'shares'    => [],
    'users'     => [],
    'jobs'      => ['save'],
    'invites'   => ['check'],
];
if (isset($parts[1]) && $id === null && isset(FORGE_ID_ROUTES[$resource])
    && !in_array($parts[1], FORGE_ID_ROUTES[$resource], true)) {
    json_response(['error' => 'Not found.'], 404);
}

require __DIR__ . '/auth.php';
require __DIR__ . '/invites.php';
require __DIR__ . '/bits.php';
require __DIR__ . '/materials.php';
require __DIR__ . '/presets.php';
require __DIR__ . '/designs.php';
require __DIR__ . '/jobs.php';

try {
    switch ($resource) {
        case 'auth':
            handle_auth($method, $action);
            break;
        case 'invites':
            handle_invites($method, $id, $action);
            break;
        case 'users':
            handle_users($method, $id, $action);
            break;
        case 'bits':
            handle_bits($method, $id);
            break;
        case 'materials':
            handle_materials($method, $id);
            break;
        case 'presets':
            handle_presets($method, $id);
            break;
        case 'designs':
            handle_designs($method, $id, $parts);
            break;
        case 'shares':
            handle_shares($method, $id);
            break;
        case 'shared':
            handle_shared($method, $parts);
            break;
        case 'jobs':
            handle_jobs($method, $id, $action);
            break;
        case 'health':
            // Deliberately does not touch the database: this is how the
            // client decides whether the backend is reachable at all, and it
            // must answer even while MySQL is misconfigured.
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
    // filesystem path, SQL or credential ever reaches the browser.
    error_log('LowRider Forge API error: ' . $e->getMessage()
        . ' @ ' . $e->getFile() . ':' . $e->getLine());
    json_response(['error' => 'Internal server error. See the server error log for detail.'], 500);
}
