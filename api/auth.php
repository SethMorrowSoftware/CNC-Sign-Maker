<?php
/**
 * LowRider Forge — accounts and sessions.
 *
 * Sessions live in the `sessions` table rather than in PHP's own session
 * storage. On shared hosting PHP's default session save path is frequently a
 * shared /tmp readable by every account on the box, which would put one
 * tenant's login cookies in another tenant's reach. Owning the table also
 * makes revocation, expiry and "sign out everywhere" ordinary SQL.
 *
 * The cookie carries 32 random bytes; the database stores only the SHA-256 of
 * that token, so a database read cannot be replayed as a login.
 *
 * Registration is invite-only, with one deliberate exception: while the users
 * table is empty, the first person to register becomes the admin. That is the
 * only way to bootstrap an install with no shell access, and it closes the
 * moment that first account exists.
 */
declare(strict_types=1);

defined('FORGE_APP') || exit('Direct access denied');

const FORGE_MIN_PASSWORD = 10;

/**
 * How much more slack the per-IP login throttle gets than the per-email one.
 * Everyone in a shop shares one public address, so the IP bucket exists to
 * blunt a spray across many accounts, not to police one person's typing.
 */
const FORGE_IP_THROTTLE_FACTOR = 6;

/* ------------------------------------------------------------------ */
/* Request context                                                     */
/* ------------------------------------------------------------------ */

/**
 * The app's base path, derived from this script's own URL.
 *
 * api/index.php sits one directory below the app root, so /forge/api/index.php
 * yields /forge. Scoping the cookie to that path keeps two installs on one
 * hostname from overwriting each other's session.
 */
function forge_base_path(): string
{
    $script = (string) ($_SERVER['SCRIPT_NAME'] ?? '/api/index.php');
    $base   = str_replace('\\', '/', dirname(dirname($script)));
    return ($base === '' || $base === '.' || $base === '/') ? '/' : rtrim($base, '/') . '/';
}

function forge_is_https(): bool
{
    if (!empty($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off') {
        return true;
    }
    // cPanel terminates TLS at a proxy on some plans and forwards this header.
    return strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
}

function forge_cookie_secure(): bool
{
    $cfg = forge_cfg('cookie_secure', 'auto');
    if ($cfg === 'auto' || $cfg === null) {
        return forge_is_https();
    }
    return filter_var($cfg, FILTER_VALIDATE_BOOLEAN);
}

/**
 * REMOTE_ADDR only. X-Forwarded-For is attacker-controlled unless you know
 * the proxy in front of you, and a spoofable value would let one client evade
 * the login throttle by rotating a header.
 */
function forge_client_ip(): string
{
    return substr((string) ($_SERVER['REMOTE_ADDR'] ?? ''), 0, 45);
}

/* ------------------------------------------------------------------ */
/* Session lookup                                                      */
/* ------------------------------------------------------------------ */

function forge_session_cookie_name(): string
{
    return (string) forge_cfg('session_cookie', 'forge_session');
}

/**
 * The signed-in user for this request, or null.
 *
 * Resolved once and cached: several handlers ask for it, and the ownership
 * checks in bits/materials/presets/designs run on every mutating call.
 */
function forge_current_session(): ?array
{
    static $resolved = false;
    static $session  = null;
    if ($resolved) {
        return $session;
    }
    $resolved = true;

    $raw = (string) ($_COOKIE[forge_session_cookie_name()] ?? '');
    if ($raw === '') {
        return null;
    }
    $hash = hash('sha256', $raw);

    try {
        $db = forge_db();
        $s  = $db->prepare(
            'SELECT s.token_hash, s.user_id, s.csrf_token, s.expires_at,
                    u.id AS uid, u.email, u.display_name, u.role, u.disabled
             FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ? LIMIT 1');
        $s->execute([$hash]);
        $row = $s->fetch();
    } catch (Throwable $e) {
        error_log('LowRider Forge: session lookup failed — ' . $e->getMessage());
        return null;
    }

    $now = time();
    if (!$row || (int) $row['expires_at'] <= $now || (int) $row['disabled'] === 1) {
        if ($row) {
            // Expired or belonging to a disabled account — drop it rather than
            // leaving a dead cookie that keeps hitting the database. A
            // disabled account loses every session, not just this one: the
            // admin endpoint already does that, but an operator who flips the
            // flag straight in SQL should get the same result.
            try {
                if ((int) $row['disabled'] === 1) {
                    $db->prepare('DELETE FROM sessions WHERE user_id = ?')
                       ->execute([(int) $row['user_id']]);
                } else {
                    $db->prepare('DELETE FROM sessions WHERE token_hash = ?')->execute([$hash]);
                }
            } catch (Throwable $e) { /* best effort */ }
            forge_clear_session_cookie();
        }
        return null;
    }

    // Sliding expiry, written at most once a day so an active user does not
    // generate a write on every single request.
    $lifetime = max(3600, (int) forge_cfg('session_lifetime', 2592000));
    if ((int) $row['expires_at'] - $now < $lifetime - 86400) {
        try {
            $db->prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?')
               ->execute([$now, $now + $lifetime, $hash]);
        } catch (Throwable $e) { /* best effort */ }
    }

    forge_session_gc($db);

    $session = [
        'token_hash' => $row['token_hash'],
        'csrf_token' => $row['csrf_token'],
        'user'       => [
            'id'           => (int) $row['uid'],
            'email'        => $row['email'],
            'display_name' => $row['display_name'],
            'role'         => $row['role'],
        ],
    ];
    return $session;
}

function forge_current_user(): ?array
{
    $s = forge_current_session();
    return $s ? $s['user'] : null;
}

/** The signed-in user's id, or 0 for an anonymous request. */
function forge_current_user_id(): int
{
    $u = forge_current_user();
    return $u ? (int) $u['id'] : 0;
}

function forge_is_admin(): bool
{
    $u = forge_current_user();
    return $u !== null && $u['role'] === 'admin';
}

/** 401 unless signed in. Returns the user row. */
function forge_require_user(): array
{
    $u = forge_current_user();
    if (!$u) {
        json_response(['error' => 'Sign in to do that.', 'code' => 'auth_required'], 401);
    }
    return $u;
}

/** 403 unless signed in as an admin. */
function forge_require_admin(): array
{
    $u = forge_require_user();
    if ($u['role'] !== 'admin') {
        json_response(['error' => 'Administrator access is required.', 'code' => 'forbidden'], 403);
    }
    return $u;
}

/**
 * Reject a state-changing request that did not present the session's CSRF
 * token.
 *
 * The cookie is already SameSite=Lax, which blocks a cross-site form POST on
 * its own, and the API only accepts application/json, which forces a CORS
 * preflight for a cross-origin XHR. This header is the third layer: it costs
 * one line in the client's request() wrapper and covers the browsers and
 * embedding contexts where SameSite is not honoured.
 */
function forge_require_csrf(): void
{
    $session = forge_current_session();
    if (!$session) {
        return;   // anonymous requests own nothing that CSRF could abuse
    }
    $sent = (string) ($_SERVER['HTTP_X_FORGE_CSRF'] ?? '');
    if ($sent === '' || !hash_equals((string) $session['csrf_token'], $sent)) {
        json_response([
            'error' => 'Your session token is missing or stale. Reload the page and try again.',
            'code'  => 'csrf',
        ], 403);
    }
}

/** Occasionally sweep expired sessions and stale throttle rows. */
function forge_session_gc(PDO $db): void
{
    // 2% of requests: frequent enough that the tables stay small on a busy
    // install, rare enough that it never dominates a request.
    if (random_int(1, 50) !== 1) {
        return;
    }
    $now = time();
    try {
        $db->prepare('DELETE FROM sessions WHERE expires_at < ?')->execute([$now]);
        $db->prepare('DELETE FROM auth_throttle WHERE last_at < ?')->execute([$now - 86400]);
    } catch (Throwable $e) {
        error_log('LowRider Forge: session GC skipped — ' . $e->getMessage());
    }
}

/* ------------------------------------------------------------------ */
/* Cookie + session lifecycle                                          */
/* ------------------------------------------------------------------ */

function forge_set_session_cookie(string $token, int $expires): void
{
    setcookie(forge_session_cookie_name(), $token, [
        'expires'  => $expires,
        'path'     => forge_base_path(),
        'secure'   => forge_cookie_secure(),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

function forge_clear_session_cookie(): void
{
    setcookie(forge_session_cookie_name(), '', [
        'expires'  => time() - 3600,
        'path'     => forge_base_path(),
        'secure'   => forge_cookie_secure(),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

/** Create a session for $userId and send the cookie. Returns the CSRF token. */
function forge_start_session(PDO $db, int $userId): string
{
    $token    = forge_token();
    $hash     = hash('sha256', $token);
    $csrf     = forge_token();
    $now      = time();
    $lifetime = max(3600, (int) forge_cfg('session_lifetime', 2592000));

    $db->prepare('INSERT INTO sessions
        (token_hash,user_id,csrf_token,created_at,last_seen_at,expires_at,user_agent,ip)
        VALUES (?,?,?,?,?,?,?,?)')
       ->execute([
           $hash, $userId, $csrf, $now, $now, $now + $lifetime,
           clamp_str($_SERVER['HTTP_USER_AGENT'] ?? '', 255),
           forge_client_ip(),
       ]);

    $db->prepare('UPDATE users SET last_login_at = ? WHERE id = ?')->execute([$now, $userId]);
    forge_set_session_cookie($token, $now + $lifetime);
    return $csrf;
}

/* ------------------------------------------------------------------ */
/* Login throttle                                                      */
/* ------------------------------------------------------------------ */

/** Seconds remaining on a lockout for this bucket, or 0 when it is clear. */
function forge_throttle_locked(PDO $db, string $bucket): int
{
    try {
        $s = $db->prepare('SELECT locked_until FROM auth_throttle WHERE bucket = ?');
        $s->execute([$bucket]);
        $until = (int) ($s->fetchColumn() ?: 0);
    } catch (Throwable $e) {
        return 0;
    }
    return $until > time() ? $until - time() : 0;
}

/**
 * Record a failed attempt against a bucket.
 *
 * $limitFactor scales the per-bucket threshold. The email bucket uses 1 — a
 * given account locks after login_max_attempts bad guesses. The IP bucket
 * uses a much higher multiple on purpose: a whole office, or a whole shop
 * floor, shares one public address, and locking that address on eight bad
 * guesses would let one person with a stale password lock out everybody else.
 */
function forge_throttle_fail(PDO $db, string $bucket, int $limitFactor = 1): void
{
    $now      = time();
    $max      = max(1, (int) forge_cfg('login_max_attempts', 8)) * max(1, $limitFactor);
    $lockSecs = max(30, (int) forge_cfg('login_lockout_secs', 900));
    try {
        // A window older than the lockout period starts over, so a legitimate
        // user who mistyped once last week is not one slip from a lockout.
        $db->prepare('INSERT INTO auth_throttle (bucket,attempts,first_at,last_at)
            VALUES (?,1,?,?)
            ON DUPLICATE KEY UPDATE
                attempts = IF(first_at < ? , 1, attempts + 1),
                first_at = IF(first_at < ?, ?, first_at),
                last_at  = ?')
           ->execute([$bucket, $now, $now, $now - $lockSecs, $now - $lockSecs, $now, $now]);
        $db->prepare('UPDATE auth_throttle SET locked_until = ?
                      WHERE bucket = ? AND attempts >= ?')
           ->execute([$now + $lockSecs, $bucket, $max]);
    } catch (Throwable $e) {
        error_log('LowRider Forge: throttle update failed — ' . $e->getMessage());
    }
}

function forge_throttle_clear(PDO $db, string $bucket): void
{
    try {
        $db->prepare('DELETE FROM auth_throttle WHERE bucket = ?')->execute([$bucket]);
    } catch (Throwable $e) { /* best effort */ }
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function forge_valid_email(string $email): bool
{
    return $email !== ''
        && mb_strlen($email) <= 190
        && filter_var($email, FILTER_VALIDATE_EMAIL) !== false;
}

/**
 * Reject a password that is too short.
 *
 * Length is the only rule on purpose: composition rules ("one capital, one
 * symbol") push people toward Password1! and are worse than a longer
 * minimum. password_hash() below uses bcrypt, which silently truncates at 72
 * bytes, so anything longer is capped rather than quietly ignored.
 */
function forge_check_password(string $pw): void
{
    if (mb_strlen($pw) < FORGE_MIN_PASSWORD) {
        json_response(['error' => 'Password must be at least ' . FORGE_MIN_PASSWORD
            . ' characters.'], 400);
    }
    if (strlen($pw) > 72) {
        json_response(['error' => 'Password must be 72 bytes or fewer.'], 400);
    }
}

/** Shape a users row for the client. Never includes the password hash. */
function forge_public_user(array $u): array
{
    return [
        'id'           => (int) $u['id'],
        'email'        => $u['email'],
        'display_name' => $u['display_name'],
        'role'         => $u['role'],
    ];
}

/** True when no account exists yet — the first-admin bootstrap window. */
function forge_no_users_yet(PDO $db): bool
{
    try {
        return (int) $db->query('SELECT COUNT(*) FROM users')->fetchColumn() === 0;
    } catch (Throwable $e) {
        return false;
    }
}

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

function handle_auth(string $method, ?string $action): void
{
    $db = forge_db();

    switch ($action) {
        case 'me':
            if ($method !== 'GET') {
                json_response(['error' => 'Method not allowed'], 405);
            }
            $session = forge_current_session();
            json_response([
                'user'       => $session ? $session['user'] : null,
                'csrf'       => $session ? $session['csrf_token'] : null,
                // Drives the sign-up affordance: the very first visitor to a
                // fresh install needs a register form, everybody else needs
                // an invite link.
                'bootstrap'  => forge_no_users_yet($db)
                    && filter_var(forge_cfg('allow_first_admin_signup', true), FILTER_VALIDATE_BOOLEAN),
                'version'    => FORGE_VERSION,
            ]);
            break;

        case 'login':
            if ($method !== 'POST') {
                json_response(['error' => 'Method not allowed'], 405);
            }
            $body  = read_json_body();
            $email = mb_strtolower(clamp_str($body['email'] ?? '', 190));
            $pw    = (string) ($body['password'] ?? '');
            if ($email === '' || $pw === '') {
                json_response(['error' => 'Email and password are required.'], 400);
            }

            $ipBucket    = 'login:ip:' . forge_client_ip();
            $emailBucket = 'login:email:' . mb_substr($email, 0, 170);
            $wait = max(forge_throttle_locked($db, $ipBucket), forge_throttle_locked($db, $emailBucket));
            if ($wait > 0) {
                json_response(['error' => 'Too many failed sign-in attempts. Try again in '
                    . ceil($wait / 60) . ' minute(s).', 'code' => 'throttled'], 429);
            }

            $s = $db->prepare('SELECT * FROM users WHERE email = ? LIMIT 1');
            $s->execute([$email]);
            $user = $s->fetch();

            // Hash even when the account does not exist, so the response time
            // does not tell an attacker which addresses are registered.
            $hash = $user ? (string) $user['password_hash']
                          : '$2y$10$usesomesillystringfooooooooooooooooooooooooooooooooooooooo';
            $ok = password_verify($pw, $hash) && $user && (int) $user['disabled'] === 0;

            if (!$ok) {
                forge_throttle_fail($db, $ipBucket, FORGE_IP_THROTTLE_FACTOR);
                forge_throttle_fail($db, $emailBucket);
                json_response(['error' => 'That email and password do not match an account.'], 401);
            }

            if (password_needs_rehash($hash, PASSWORD_DEFAULT)) {
                $db->prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
                   ->execute([password_hash($pw, PASSWORD_DEFAULT), time(), (int) $user['id']]);
            }

            forge_throttle_clear($db, $ipBucket);
            forge_throttle_clear($db, $emailBucket);
            $csrf = forge_start_session($db, (int) $user['id']);
            json_response(['user' => forge_public_user($user), 'csrf' => $csrf]);
            break;

        case 'logout':
            if ($method !== 'POST') {
                json_response(['error' => 'Method not allowed'], 405);
            }
            $session = forge_current_session();
            if ($session) {
                forge_require_csrf();
                $db->prepare('DELETE FROM sessions WHERE token_hash = ?')
                   ->execute([$session['token_hash']]);
            }
            forge_clear_session_cookie();
            json_response(['ok' => true]);
            break;

        case 'register':
            if ($method !== 'POST') {
                json_response(['error' => 'Method not allowed'], 405);
            }
            handle_register($db, read_json_body());
            break;

        case 'password':
            if ($method !== 'POST') {
                json_response(['error' => 'Method not allowed'], 405);
            }
            forge_require_csrf();
            $me   = forge_require_user();
            $body = read_json_body();
            $current = (string) ($body['current_password'] ?? '');
            $next    = (string) ($body['new_password'] ?? '');

            $s = $db->prepare('SELECT password_hash FROM users WHERE id = ?');
            $s->execute([$me['id']]);
            $hash = (string) $s->fetchColumn();
            if (!password_verify($current, $hash)) {
                json_response(['error' => 'Your current password is not correct.'], 403);
            }
            forge_check_password($next);
            $db->prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
               ->execute([password_hash($next, PASSWORD_DEFAULT), time(), $me['id']]);

            // Every other session for this account is invalidated: a password
            // change is how you evict someone who has your old one.
            $session = forge_current_session();
            $db->prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?')
               ->execute([$me['id'], $session['token_hash']]);
            json_response(['ok' => true]);
            break;

        case 'profile':
            if ($method !== 'POST') {
                json_response(['error' => 'Method not allowed'], 405);
            }
            forge_require_csrf();
            $me   = forge_require_user();
            $body = read_json_body();
            $name = clamp_str($body['display_name'] ?? '', 120);
            if ($name === '') {
                json_response(['error' => 'Display name is required.'], 400);
            }
            $db->prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?')
               ->execute([$name, time(), $me['id']]);
            $me['display_name'] = $name;
            json_response(['user' => $me]);
            break;

        default:
            json_response(['error' => 'Unknown auth action: ' . (string) $action], 404);
    }
}

/**
 * Create an account.
 *
 * Two ways in: a valid, unused, unexpired, unrevoked invite token, or the
 * first-admin bootstrap while the users table is still empty. Everything runs
 * inside one transaction so two people racing on the same invite — or on the
 * bootstrap window — cannot both get through.
 */
function handle_register(PDO $db, array $body): void
{
    $email = mb_strtolower(clamp_str($body['email'] ?? '', 190));
    $name  = clamp_str($body['display_name'] ?? '', 120);
    $pw    = (string) ($body['password'] ?? '');
    $inviteToken = clamp_str($body['invite'] ?? '', 64);

    if (!forge_valid_email($email)) {
        json_response(['error' => 'Enter a valid email address.'], 400);
    }
    if ($name === '') {
        $name = mb_substr($email, 0, (int) mb_strpos($email, '@'));
    }
    forge_check_password($pw);

    $now = time();
    $db->beginTransaction();
    try {
        $bootstrap = false;
        $role      = 'user';
        $inviteId  = null;

        if (forge_no_users_yet($db)
            && filter_var(forge_cfg('allow_first_admin_signup', true), FILTER_VALIDATE_BOOLEAN)) {
            // Claim the bootstrap by inserting a sentinel key. INSERT IGNORE
            // on a primary key is atomic, so exactly one of two racing
            // registrations gets rowCount 1 and becomes the admin; the other
            // falls through to the invite path. The claim is inside this
            // transaction, so a later failure rolls it back and the next
            // attempt can still bootstrap.
            $claim = $db->prepare("INSERT IGNORE INTO meta (`key`, `value`) VALUES ('bootstrap_admin', ?)");
            $claim->execute([(string) $now]);
            if ($claim->rowCount() === 1) {
                $bootstrap = true;
                $role      = 'admin';
            }
        }

        if (!$bootstrap) {
            if ($inviteToken === '') {
                $db->rollBack();
                json_response([
                    'error' => 'Registration is invite-only. Ask an administrator for an invite link.',
                    'code'  => 'invite_required',
                ], 403);
            }
            $s = $db->prepare('SELECT * FROM invites WHERE token = ? FOR UPDATE');
            $s->execute([$inviteToken]);
            $invite = $s->fetch();
            if (!$invite
                || $invite['used_at'] !== null
                || $invite['revoked_at'] !== null
                || ($invite['expires_at'] !== null && (int) $invite['expires_at'] < $now)) {
                $db->rollBack();
                json_response([
                    'error' => 'That invite link is not valid any more. Ask for a fresh one.',
                    'code'  => 'invite_invalid',
                ], 403);
            }
            // An invite issued for a specific address may only be used by it,
            // otherwise forwarding the link hands the account to someone else.
            if ($invite['email'] !== null && $invite['email'] !== ''
                && mb_strtolower((string) $invite['email']) !== $email) {
                $db->rollBack();
                json_response([
                    'error' => 'That invite was issued for a different email address.',
                    'code'  => 'invite_email_mismatch',
                ], 403);
            }
            $role     = ($invite['role'] === 'admin') ? 'admin' : 'user';
            $inviteId = (int) $invite['id'];
        }

        try {
            $db->prepare('INSERT INTO users
                (email,password_hash,display_name,role,created_at,updated_at)
                VALUES (?,?,?,?,?,?)')
               ->execute([$email, password_hash($pw, PASSWORD_DEFAULT), $name, $role, $now, $now]);
        } catch (PDOException $e) {
            if ((string) $e->getCode() === '23000') {
                $db->rollBack();
                json_response(['error' => 'An account already exists for that email address.'], 409);
            }
            throw $e;
        }
        $userId = (int) $db->lastInsertId();

        if ($inviteId !== null) {
            $db->prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?')
               ->execute([$now, $userId, $inviteId]);
        }

        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }

    $csrf = forge_start_session($db, $userId);
    $s = $db->prepare('SELECT * FROM users WHERE id = ?');
    $s->execute([$userId]);
    json_response([
        'user'      => forge_public_user($s->fetch()),
        'csrf'      => $csrf,
        'bootstrap' => $bootstrap,
    ], 201);
}
