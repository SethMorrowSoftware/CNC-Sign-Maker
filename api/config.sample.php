<?php
/**
 * LowRider Forge — configuration template.
 *
 * Copy this file to api/config.php and fill in your MySQL credentials:
 *
 *     cp api/config.sample.php api/config.php
 *
 * api/config.php is gitignored and denied by the bundled .htaccess. It is
 * never served as text because every request to it is executed by PHP, and
 * the FORGE_APP guard below aborts it if it somehow is.
 *
 * Every key can also come from an environment variable instead (see the
 * FORGE_ENV_* names in the comments), which suits hosts where you would
 * rather not keep credentials in a file at all. A value set here wins over
 * the environment.
 */
declare(strict_types=1);

defined('FORGE_APP') || exit('Direct access denied');

return [
    /* ---- database -------------------------------------------------------
     * Create the database and user in cPanel → "MySQL Databases" first, then
     * paste the credentials here. cPanel prefixes both with your account
     * name, e.g. "myaccount_forge" and "myaccount_forgeuser".
     */
    'db_host'    => 'localhost',   // FORGE_DB_HOST
    'db_port'    => 3306,          // FORGE_DB_PORT
    'db_name'    => 'forge',       // FORGE_DB_NAME
    'db_user'    => 'forge',       // FORGE_DB_USER
    'db_pass'    => '',            // FORGE_DB_PASS

    // Unix socket instead of TCP. Leave empty unless your host requires it
    // (some cPanel boxes only accept /var/lib/mysql/mysql.sock).
    'db_socket'  => '',            // FORGE_DB_SOCKET

    /* ---- sessions -------------------------------------------------------
     * Sessions live in the `sessions` table, not in PHP's own session
     * storage: on shared hosting PHP's default session directory is often
     * readable by every account on the box.
     */

    // How long a login lasts, in seconds. Default 30 days.
    'session_lifetime' => 60 * 60 * 24 * 30,   // FORGE_SESSION_LIFETIME

    // Cookie name. Change it if you run two installs on one hostname.
    'session_cookie'   => 'forge_session',     // FORGE_SESSION_COOKIE

    // Send the session cookie only over HTTPS. 'auto' (the default) sets it
    // whenever the request arrives over HTTPS, which is what you want. Force
    // it to true once your site is HTTPS-only.
    'cookie_secure'    => 'auto',              // FORGE_COOKIE_SECURE

    /* ---- limits ---------------------------------------------------------
     * Designs carry their artwork (an SVG up to 4 MB, or a traced bitmap and
     * an uploaded font up to 8 MB each), so a single save can be large. Keep
     * this at or below the host's post_max_size and MySQL's
     * max_allowed_packet or saves will fail with a confusing error.
     */
    'max_design_bytes' => 12 * 1024 * 1024,    // FORGE_MAX_DESIGN_BYTES
    'max_gcode_bytes'  => 8 * 1024 * 1024,     // FORGE_MAX_GCODE_BYTES

    /* ---- accounts -------------------------------------------------------
     * Registration is invite-only. An admin creates invite links from the
     * account menu. The single exception is the very first account on a
     * fresh install: while the users table is empty, anyone who can reach
     * the app may register, and that first account becomes the admin.
     * Set this to false once you have created it if the install is
     * internet-facing and you want the window shut explicitly.
     */
    'allow_first_admin_signup' => true,        // FORGE_ALLOW_FIRST_ADMIN

    // Failed logins per email and per IP before a temporary lockout, and how
    // long that lockout lasts in seconds.
    'login_max_attempts' => 8,                 // FORGE_LOGIN_MAX_ATTEMPTS
    'login_lockout_secs' => 900,               // FORGE_LOGIN_LOCKOUT_SECS
];
