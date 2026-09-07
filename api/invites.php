<?php
/**
 * LowRider Forge — /api/invites and /api/users (administrators only).
 *
 * Registration is invite-only, so this is how accounts come into existence
 * after the first-admin bootstrap. An invite is a single-use random token; the
 * admin copies the link and sends it however they like. Nothing here sends
 * mail — shared hosts block or silently drop PHP mail() often enough that
 * depending on it would strand people at a wall waiting for a message that
 * never arrives.
 */
declare(strict_types=1);

defined('FORGE_APP') || exit('Direct access denied');

/** Absolute URL of the app root, used to build a copyable invite link. */
function forge_app_url(): string
{
    $scheme = forge_is_https() ? 'https' : 'http';
    $host   = (string) ($_SERVER['HTTP_HOST'] ?? 'localhost');
    // HTTP_HOST is client-supplied. It only ever lands in a link the admin
    // copies for themselves, but strip anything that is not a host:port so a
    // crafted header cannot smuggle a path or a second URL into the string.
    if (!preg_match('/^[A-Za-z0-9.\-]+(:\d+)?$/', $host)) {
        $host = 'localhost';
    }
    return $scheme . '://' . $host . forge_base_path();
}

function invite_row(array $r): array
{
    return [
        'id'         => (int) $r['id'],
        'token'      => $r['token'],
        'url'        => forge_app_url() . '?invite=' . rawurlencode((string) $r['token']),
        'email'      => $r['email'],
        'role'       => $r['role'],
        'note'       => $r['note'],
        'created_at' => (int) $r['created_at'],
        'expires_at' => $r['expires_at'] === null ? null : (int) $r['expires_at'],
        'used_at'    => $r['used_at'] === null ? null : (int) $r['used_at'],
        'revoked_at' => $r['revoked_at'] === null ? null : (int) $r['revoked_at'],
        'status'     => invite_status($r),
    ];
}

function invite_status(array $r): string
{
    if ($r['used_at'] !== null)    return 'used';
    if ($r['revoked_at'] !== null) return 'revoked';
    if ($r['expires_at'] !== null && (int) $r['expires_at'] < time()) return 'expired';
    return 'open';
}

function handle_invites(string $method, ?int $id, ?string $action): void
{
    $db = forge_db();

    // GET invites/check?token=… — public. Lets the sign-up form tell someone
    // their link is dead before they fill the whole thing in.
    if ($method === 'GET' && $action === 'check') {
        $token = clamp_str($_GET['token'] ?? '', 64);
        if ($token === '') {
            json_response(['valid' => false, 'reason' => 'missing']);
        }
        $s = $db->prepare('SELECT * FROM invites WHERE token = ? LIMIT 1');
        $s->execute([$token]);
        $r = $s->fetch();
        if (!$r) {
            json_response(['valid' => false, 'reason' => 'unknown']);
        }
        $status = invite_status($r);
        json_response([
            'valid'  => $status === 'open',
            'reason' => $status,
            // Pre-fills and pins the sign-up form when the invite named an
            // address. Only ever an address the inviter already knew.
            'email'  => $status === 'open' ? $r['email'] : null,
        ]);
    }

    forge_require_admin();

    switch ($method) {
        case 'GET':
            $rows = $db->query('SELECT * FROM invites ORDER BY id DESC LIMIT 200')->fetchAll();
            json_response(array_map('invite_row', $rows));
            break;

        case 'POST':
            forge_require_csrf();
            $me   = forge_current_user();
            $body = read_json_body();

            $email = mb_strtolower(clamp_str($body['email'] ?? '', 190));
            if ($email !== '' && !forge_valid_email($email)) {
                json_response(['error' => 'Enter a valid email address, or leave it blank.'], 400);
            }
            $role = ($body['role'] ?? 'user') === 'admin' ? 'admin' : 'user';
            $days = (int) ($body['expires_days'] ?? 14);
            $days = max(0, min(365, $days));

            $now   = time();
            $token = forge_token();
            $db->prepare('INSERT INTO invites
                (token,email,role,note,created_by,created_at,expires_at)
                VALUES (?,?,?,?,?,?,?)')
               ->execute([
                   $token,
                   $email === '' ? null : $email,
                   $role,
                   clamp_str($body['note'] ?? '', 255) ?: null,
                   $me['id'],
                   $now,
                   $days === 0 ? null : $now + $days * 86400,
               ]);

            $s = $db->prepare('SELECT * FROM invites WHERE id = ?');
            $s->execute([(int) $db->lastInsertId()]);
            json_response(invite_row($s->fetch()), 201);
            break;

        case 'DELETE':
            if ($id === null) {
                json_response(['error' => 'DELETE requires an id'], 400);
            }
            forge_require_csrf();
            // Revoked rather than deleted: the history of who invited whom is
            // worth more than a tidy table.
            $s = $db->prepare('UPDATE invites SET revoked_at = ?
                               WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL');
            $s->execute([time(), $id]);
            json_response(['revoked' => $s->rowCount() > 0]);
            break;

        default:
            json_response(['error' => 'Method not allowed'], 405);
    }
}

/**
 * /api/users — administrators only.
 *
 * Accounts are disabled, never deleted: designs, presets and saved jobs hang
 * off the user id, and deleting the row would cascade every design that user
 * ever shared out of existence.
 */
function handle_users(string $method, ?int $id, ?string $action): void
{
    $db = forge_db();
    $me = forge_require_admin();

    if ($method === 'GET' && $id === null) {
        $rows = $db->query(
            'SELECT u.id, u.email, u.display_name, u.role, u.disabled,
                    u.created_at, u.last_login_at,
                    (SELECT COUNT(*) FROM designs d WHERE d.owner_id = u.id) AS design_count
             FROM users u ORDER BY u.id')->fetchAll();
        json_response(array_map(static function (array $r): array {
            return [
                'id'            => (int) $r['id'],
                'email'         => $r['email'],
                'display_name'  => $r['display_name'],
                'role'          => $r['role'],
                'disabled'      => (int) $r['disabled'] === 1,
                'created_at'    => (int) $r['created_at'],
                'last_login_at' => $r['last_login_at'] === null ? null : (int) $r['last_login_at'],
                'design_count'  => (int) $r['design_count'],
            ];
        }, $rows));
    }

    if ($method === 'PUT' && $id !== null) {
        forge_require_csrf();
        $body = read_json_body();

        $s = $db->prepare('SELECT * FROM users WHERE id = ?');
        $s->execute([$id]);
        $target = $s->fetch();
        if (!$target) {
            json_response(['error' => 'User not found'], 404);
        }

        $disabled = array_key_exists('disabled', $body)
            ? (filter_var($body['disabled'], FILTER_VALIDATE_BOOLEAN) ? 1 : 0)
            : (int) $target['disabled'];
        $role = array_key_exists('role', $body)
            ? (($body['role'] === 'admin') ? 'admin' : 'user')
            : (string) $target['role'];

        // An admin must not be able to lock themselves out, and the last
        // admin must not be able to demote or disable the account that is the
        // only way back into the invite screen.
        if ((int) $target['id'] === (int) $me['id'] && ($disabled === 1 || $role !== 'admin')) {
            json_response(['error' => 'You cannot disable or demote your own admin account.'], 400);
        }
        if ((string) $target['role'] === 'admin' && ($role !== 'admin' || $disabled === 1)) {
            $others = (int) $db->query(
                "SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0")->fetchColumn();
            if ($others <= 1) {
                json_response(['error' => 'This is the only active administrator.'], 400);
            }
        }

        $db->prepare('UPDATE users SET role = ?, disabled = ?, updated_at = ? WHERE id = ?')
           ->execute([$role, $disabled, time(), $id]);
        if ($disabled === 1) {
            // Disabling has to end the sessions too, or the account keeps
            // working until its cookie happens to expire.
            $db->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$id]);
        }
        json_response(['ok' => true, 'id' => $id, 'role' => $role, 'disabled' => $disabled === 1]);
    }

    json_response(['error' => 'Method not allowed'], 405);
}
