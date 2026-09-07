<?php
/**
 * LowRider Forge — create or promote an administrator from the command line.
 *
 * Normally the first person to register on a fresh install becomes the admin
 * and invites everyone else. This is the way back in when that is not
 * possible: the admin account was disabled, its password was lost, or
 * allow_first_admin_signup was turned off before an admin existed.
 *
 *     php tools/create-admin.php --email=you@example.com --password='...' --name='Your Name'
 *     php tools/create-admin.php --email=you@example.com --promote
 *     php tools/create-admin.php --email=you@example.com --password='...' --reset
 *
 * Options:
 *   --email=<address>    The account to create or act on. Required.
 *   --password=<secret>  Password for a new account, or the replacement with
 *                        --reset. At least 10 characters.
 *   --name=<label>       Display name for a new account.
 *   --promote            Make an existing account an administrator and
 *                        re-enable it if it was disabled.
 *   --reset              Set a new password on an existing account and end
 *                        all of its sessions.
 *
 * Passing a password on the command line puts it in your shell history. On a
 * shared box, prefer `--promote` on an account you registered in the browser.
 */
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit("This script only runs from the command line.\n");
}

define('FORGE_APP', true);
require dirname(__DIR__) . '/api/db.php';
require dirname(__DIR__) . '/api/auth.php';

$opts = [];
foreach (array_slice($argv, 1) as $arg) {
    if (preg_match('/^--([a-z-]+)(?:=(.*))?$/', $arg, $m)) {
        $opts[$m[1]] = $m[2] ?? true;
    }
}

function fail(string $msg): void
{
    fwrite(STDERR, "ERROR: $msg\n");
    exit(1);
}
function say(string $msg): void
{
    fwrite(STDOUT, $msg . "\n");
}

$email = mb_strtolower(trim((string) ($opts['email'] ?? '')));
if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    fail('--email=<address> is required and must be a valid address.');
}

try {
    $db = forge_db();
} catch (RuntimeException $e) {
    fail($e->getMessage());
}

$s = $db->prepare('SELECT * FROM users WHERE email = ?');
$s->execute([$email]);
$user = $s->fetch();
$now  = time();

if ($user && isset($opts['promote'])) {
    $db->prepare("UPDATE users SET role = 'admin', disabled = 0, updated_at = ? WHERE id = ?")
       ->execute([$now, (int) $user['id']]);
    say("Promoted {$user['display_name']} <$email> to administrator and enabled the account.");
    exit(0);
}

if ($user && isset($opts['reset'])) {
    $pw = (string) ($opts['password'] ?? '');
    if (mb_strlen($pw) < FORGE_MIN_PASSWORD) {
        fail('--password must be at least ' . FORGE_MIN_PASSWORD . ' characters.');
    }
    $db->prepare('UPDATE users SET password_hash = ?, disabled = 0, updated_at = ? WHERE id = ?')
       ->execute([password_hash($pw, PASSWORD_DEFAULT), $now, (int) $user['id']]);
    // Any session opened with the old password stops working.
    $db->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([(int) $user['id']]);
    say("Password reset for <$email>. All of that account's sessions were ended.");
    exit(0);
}

if ($user) {
    fail("An account already exists for <$email>. Use --promote to make it an "
        . 'administrator, or --reset --password=... to set a new password.');
}

// Falling through to "create an account" here would answer a --promote on a
// missing address by complaining about the password, which sends the operator
// off fixing the wrong thing.
if (isset($opts['promote']) || isset($opts['reset'])) {
    fail("No account exists for <$email>, so there is nothing to "
        . (isset($opts['promote']) ? 'promote' : 'reset') . '. Run this without '
        . '--promote/--reset and with --password=... to create it.');
}

$pw = (string) ($opts['password'] ?? '');
if (mb_strlen($pw) < FORGE_MIN_PASSWORD) {
    fail('--password must be at least ' . FORGE_MIN_PASSWORD . ' characters.');
}
if (strlen($pw) > 72) {
    fail('--password must be 72 bytes or fewer (bcrypt truncates beyond that).');
}
$name = trim((string) ($opts['name'] ?? ''));
if ($name === '') {
    $name = substr($email, 0, (int) strpos($email, '@'));
}

$db->prepare("INSERT INTO users (email,password_hash,display_name,role,created_at,updated_at)
              VALUES (?,?,?,'admin',?,?)")
   ->execute([$email, password_hash($pw, PASSWORD_DEFAULT), $name, $now, $now]);

// Close the first-admin bootstrap window: an account exists now, so the
// browser sign-up form must go back to requiring an invite.
$db->prepare("INSERT IGNORE INTO meta (`key`, `value`) VALUES ('bootstrap_admin', ?)")
   ->execute([(string) $now]);

say("Created administrator $name <$email>.");
say('Sign in at the app URL, then invite others from the account menu.');
