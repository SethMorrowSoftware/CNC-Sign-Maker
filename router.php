<?php
/**
 * LowRider Forge — PHP built-in server router.
 *
 * PHP's built-in web server (`php -S host:port router.php`) does NOT honour
 * .htaccess. Without this router the data/ directory — the SQLite database and
 * any saved gcode — is downloadable over HTTP, and the tool ships no
 * authentication. This router denies data/ and dotfiles and lets the built-in
 * server serve everything else (static assets and the api/ scripts) normally.
 *
 * On Apache / cPanel this file is ignored; the bundled .htaccess rules apply
 * instead. It is only consulted when you explicitly pass it to `php -S`.
 *
 * Usage:  php -S localhost:8000 router.php
 */
declare(strict_types=1);

$path = (string) (parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH) ?? '/');
$path = rawurldecode($path);

// Deny the data directory (DB + saved jobs) and any dotfile / dotdir
// (.htaccess, .git, ...). Denying is the safe direction, so an unusual path
// such as /data/../x is refused rather than risking a leak.
if (preg_match('#(?:^|/)data(?:/|$)#', $path) ||
    preg_match('#(?:^|/)\.[^/]#', $path)) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Not found.';
    return true; // request fully handled — do not fall through to the file
}

// Everything else: let the built-in server serve the file or run the PHP
// script (api/index.php handles the JSON API).
return false;
