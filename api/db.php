<?php
/**
 * LowRider Forge — MySQL layer.
 *
 * Creates the schema and seeds the starter library on first use, so a fresh
 * install only needs an empty database plus credentials in api/config.php.
 *
 * Hosting note: the tool targets shared cPanel hosting, where the account
 * already has MySQL/MariaDB but no shell, no composer and no migration
 * runner. Everything here therefore has to be idempotent and safe to run on
 * every request: the schema is created with CREATE TABLE IF NOT EXISTS, the
 * additive migrations check information_schema before they alter anything,
 * and the seed uses INSERT IGNORE inside one transaction.
 *
 * Ownership convention: bits, materials, presets and jobs carry an
 * `owner_id`. Zero means "shipped with the tool" — the seeded library, which
 * every user can read and nobody can edit in place. A non-zero owner_id is a
 * row belonging to that user. This is a plain column rather than a foreign
 * key precisely so that owner 0 can exist without a matching users row.
 */
declare(strict_types=1);

defined('FORGE_APP') || exit('Direct access denied');

const FORGE_VERSION = '2.0.0';

// Bumped whenever the seed library changes, so existing databases pick up new
// bits and materials on the next request. Seeding is idempotent.
const FORGE_SEED_VERSION = 3;

/** owner_id of the built-in, read-only library rows. */
const FORGE_SYSTEM_OWNER = 0;

function forge_data_dir(): string
{
    return dirname(__DIR__) . '/data';
}

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Load api/config.php once, layering environment variables underneath it so
 * a host that prefers env vars to a credentials file can use either.
 */
function forge_config(): array
{
    static $cfg = null;
    if ($cfg !== null) {
        return $cfg;
    }

    $env = static function (string $name, $default) {
        $v = getenv($name);
        return ($v === false || $v === '') ? $default : $v;
    };

    $defaults = [
        'db_host'    => $env('FORGE_DB_HOST', 'localhost'),
        'db_port'    => (int) $env('FORGE_DB_PORT', 3306),
        'db_name'    => $env('FORGE_DB_NAME', ''),
        'db_user'    => $env('FORGE_DB_USER', ''),
        'db_pass'    => $env('FORGE_DB_PASS', ''),
        'db_socket'  => $env('FORGE_DB_SOCKET', ''),

        'session_lifetime' => (int) $env('FORGE_SESSION_LIFETIME', 60 * 60 * 24 * 30),
        'session_cookie'   => $env('FORGE_SESSION_COOKIE', 'forge_session'),
        'cookie_secure'    => $env('FORGE_COOKIE_SECURE', 'auto'),

        'max_design_bytes' => (int) $env('FORGE_MAX_DESIGN_BYTES', 12 * 1024 * 1024),
        'max_gcode_bytes'  => (int) $env('FORGE_MAX_GCODE_BYTES', 8 * 1024 * 1024),

        'allow_first_admin_signup' =>
            filter_var($env('FORGE_ALLOW_FIRST_ADMIN', 'true'), FILTER_VALIDATE_BOOLEAN),
        'login_max_attempts' => (int) $env('FORGE_LOGIN_MAX_ATTEMPTS', 8),
        'login_lockout_secs' => (int) $env('FORGE_LOGIN_LOCKOUT_SECS', 900),
    ];

    $file = __DIR__ . '/config.php';
    $fromFile = is_file($file) ? require $file : [];
    if (!is_array($fromFile)) {
        $fromFile = [];
    }
    // Drop empty file values so they cannot blank out a populated env var.
    $fromFile = array_filter($fromFile, static function ($v) {
        return $v !== null && $v !== '';
    });

    $cfg = array_merge($defaults, $fromFile);
    return $cfg;
}

function forge_cfg(string $key, $default = null)
{
    $cfg = forge_config();
    return array_key_exists($key, $cfg) ? $cfg[$key] : $default;
}

/* ------------------------------------------------------------------ */
/* Connection                                                          */
/* ------------------------------------------------------------------ */

/**
 * Open (and, on first use, create + seed) the database.
 * Throws RuntimeException with an operator-friendly message on failure —
 * api/index.php turns those into a 503 the browser can display.
 */
function forge_db(): PDO
{
    static $db = null;
    if ($db instanceof PDO) {
        return $db;
    }

    if (!extension_loaded('pdo_mysql')) {
        throw new RuntimeException(
            'The PHP "pdo_mysql" extension is not enabled. In cPanel, open '
            . '"Select PHP Version" and tick the pdo_mysql (or mysqlnd) extension.'
        );
    }

    $cfg = forge_config();
    if ($cfg['db_name'] === '' || $cfg['db_user'] === '') {
        throw new RuntimeException(
            'The database is not configured yet. Copy api/config.sample.php to '
            . 'api/config.php and fill in the MySQL database name, user and '
            . 'password you created in cPanel → "MySQL Databases".'
        );
    }

    $dsn = $cfg['db_socket'] !== ''
        ? 'mysql:unix_socket=' . $cfg['db_socket']
        : 'mysql:host=' . $cfg['db_host'] . ';port=' . (int) $cfg['db_port'];
    $dsn .= ';dbname=' . $cfg['db_name'] . ';charset=utf8mb4';

    try {
        $db = new PDO($dsn, (string) $cfg['db_user'], (string) $cfg['db_pass'], [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            // Real prepared statements: emulation would re-quote the LONGTEXT
            // design payloads through the client and trip max_allowed_packet
            // far earlier than the server actually needs to.
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
    } catch (PDOException $e) {
        // The driver's message names the host and user but never the
        // password, so it is safe — and genuinely useful — to pass on.
        throw new RuntimeException(
            'Could not connect to MySQL: ' . $e->getMessage()
            . ' Check the credentials in api/config.php. On cPanel both the '
            . 'database name and the user name carry your account prefix, and '
            . 'the user must be added to the database with ALL PRIVILEGES.'
        );
    }

    // Strict mode makes MySQL reject out-of-range values instead of silently
    // truncating them. A silently truncated settings_json is a design that
    // loads back wrong, which on a CNC tool means cutting the wrong thing.
    try {
        $db->exec("SET SESSION sql_mode = 'STRICT_ALL_TABLES'");
        $db->exec('SET SESSION time_zone = "+00:00"');
    } catch (PDOException $e) {
        error_log('LowRider Forge: session tuning skipped — ' . $e->getMessage());
    }

    forge_init_schema($db);
    forge_migrate($db);

    // Seed (or top up) the library when the stored seed version is behind.
    $seeded = 0;
    try {
        $seeded = (int) ($db->query(
            "SELECT `value` FROM meta WHERE `key` = 'seed_version'")->fetchColumn() ?: 0);
    } catch (Throwable $e) {
        // meta table missing/unreadable — treat as never seeded
    }
    if ($seeded < FORGE_SEED_VERSION) {
        forge_seed($db);
        try {
            $db->prepare("INSERT INTO meta (`key`, `value`) VALUES ('seed_version', ?)
                ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)")
               ->execute([(string) FORGE_SEED_VERSION]);
        } catch (Throwable $e) {
            error_log('LowRider Forge: could not record seed version — ' . $e->getMessage());
        }
    }

    return $db;
}

/**
 * Create every table if it is missing.
 *
 * Each statement is issued separately: PDO's MySQL driver does not reliably
 * run a semicolon-separated batch through exec(), and a half-applied batch
 * would leave the schema in a state the migrations below cannot reason about.
 *
 * Naming widths are deliberate. Every column that carries a UNIQUE or plain
 * index is at most VARCHAR(190), because utf8mb4 costs 4 bytes per character
 * and MySQL 5.7 / MariaDB caps an index prefix at 767 bytes.
 */
function forge_init_schema(PDO $db): void
{
    $tables = [];

    $tables[] = <<<'SQL'
        CREATE TABLE IF NOT EXISTS meta (
            `key`   VARCHAR(64) NOT NULL,
            `value` TEXT,
            PRIMARY KEY (`key`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        SQL;

    $tables[] = <<<'SQL'
        CREATE TABLE IF NOT EXISTS users (
            id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
            email         VARCHAR(190) NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            display_name  VARCHAR(120) NOT NULL,
            role          VARCHAR(16)  NOT NULL DEFAULT 'user',
            disabled      TINYINT(1)   NOT NULL DEFAULT 0,
            created_at    INT UNSIGNED NOT NULL,
            updated_at    INT UNSIGNED NOT NULL,
            last_login_at INT UNSIGNED NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_users_email (email)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        SQL;

    // The cookie carries a random token; only its SHA-256 is stored, so a
    // read of this table cannot be replayed as a login.
    $tables[] = <<<'SQL'
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash   CHAR(64)     NOT NULL,
            user_id      INT UNSIGNED NOT NULL,
            csrf_token   CHAR(43)     NOT NULL,
            created_at   INT UNSIGNED NOT NULL,
            last_seen_at INT UNSIGNED NOT NULL,
            expires_at   INT UNSIGNED NOT NULL,
            user_agent   VARCHAR(255) NULL,
            ip           VARCHAR(45)  NULL,
            PRIMARY KEY (token_hash),
            KEY idx_sessions_user (user_id),
            KEY idx_sessions_expiry (expires_at),
            CONSTRAINT fk_sessions_user FOREIGN KEY (user_id)
                REFERENCES users (id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        SQL;

    $tables[] = <<<'SQL'
        CREATE TABLE IF NOT EXISTS invites (
            id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
            token      VARCHAR(64)  NOT NULL,
            email      VARCHAR(190) NULL,
            role       VARCHAR(16)  NOT NULL DEFAULT 'user',
            note       VARCHAR(255) NULL,
            created_by INT UNSIGNED NULL,
            created_at INT UNSIGNED NOT NULL,
            expires_at INT UNSIGNED NULL,
            used_at    INT UNSIGNED NULL,
            used_by    INT UNSIGNED NULL,
            revoked_at INT UNSIGNED NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_invites_token (token)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        SQL;

    // Failed-login throttle. One row per bucket ("login:ip:..." or
    // "login:email:..."), so brute-force protection needs no Redis.
    $tables[] = <<<'SQL'
        CREATE TABLE IF NOT EXISTS auth_throttle (
            bucket       VARCHAR(190) NOT NULL,
            attempts     INT UNSIGNED NOT NULL DEFAULT 0,
            first_at     INT UNSIGNED NOT NULL,
            last_at      INT UNSIGNED NOT NULL,
            locked_until INT UNSIGNED NULL,
            PRIMARY KEY (bucket),
            KEY idx_throttle_last (last_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        SQL;

    $tables[] = <<<'SQL'
        CREATE TABLE IF NOT EXISTS bits (
            id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
            owner_id          INT UNSIGNED NOT NULL DEFAULT 0,
            name              VARCHAR(190) NOT NULL,
            diameter_mm       DOUBLE NOT NULL,
            shank_diameter_mm DOUBLE NULL,
            flute_count       INT NOT NULL DEFAULT 2,
            cutting_length_mm DOUBLE NULL,
            type              VARCHAR(32) NOT NULL DEFAULT 'upcut',
            v_angle_deg       DOUBLE NULL,
            notes             TEXT NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_bits_owner_name (owner_id, name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        SQL;

    $tables[] = <<<'SQL'
        CREATE TABLE IF NOT EXISTS materials (
            id                      INT UNSIGNED NOT NULL AUTO_INCREMENT,
            owner_id                INT UNSIGNED NOT NULL DEFAULT 0,
            name                    VARCHAR(190) NOT NULL,
            thickness_mm            DOUBLE NULL,
            recommended_bit_type    VARCHAR(32) NULL,
            recommended_rpm         INT NULL,
            recommended_feed_cut    INT NULL,
            recommended_feed_plunge INT NULL,
            recommended_doc_mm      DOUBLE NULL,
            through_cut_overage_mm  DOUBLE NULL DEFAULT 0.65,
            notes                   TEXT NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_materials_owner_name (owner_id, name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        SQL;

    $tables[] = <<<'SQL'
        CREATE TABLE IF NOT EXISTS presets (
            id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
            owner_id      INT UNSIGNED NOT NULL DEFAULT 0,
            name          VARCHAR(190) NOT NULL,
            bit_id        INT UNSIGNED NULL,
            material_id   INT UNSIGNED NULL,
            operation     VARCHAR(32) NOT NULL,
            settings_json MEDIUMTEXT NOT NULL,
            created_at    INT UNSIGNED NULL,
            updated_at    INT UNSIGNED NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_presets_owner_name (owner_id, name),
            KEY idx_presets_bit (bit_id),
            KEY idx_presets_material (material_id),
            CONSTRAINT fk_presets_bit FOREIGN KEY (bit_id)
                REFERENCES bits (id) ON DELETE SET NULL,
            CONSTRAINT fk_presets_material FOREIGN KEY (material_id)
                REFERENCES materials (id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        SQL;

    // A design is the whole working document: the settings plus whatever
    // artwork the pipeline needs to rebuild the geometry byte-for-byte. The
    // heavy bytes (SVG source, bitmap, uploaded font) live in design_assets
    // so that listing "My designs" never drags megabytes across the wire.
    $tables[] = <<<'SQL'
        CREATE TABLE IF NOT EXISTS designs (
            id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
            owner_id      INT UNSIGNED NOT NULL,
            name          VARCHAR(190) NOT NULL,
            input_mode    VARCHAR(16) NOT NULL DEFAULT 'text',
            operation     VARCHAR(32) NOT NULL DEFAULT 'engrave',
            bit_id        INT UNSIGNED NULL,
            material_id   INT UNSIGNED NULL,
            settings_json MEDIUMTEXT NOT NULL,
            svg_hash      VARCHAR(64) NULL,
            notes         TEXT NULL,
            copied_from   INT UNSIGNED NULL,
            created_at    INT UNSIGNED NOT NULL,
            updated_at    INT UNSIGNED NOT NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_designs_owner_name (owner_id, name),
            KEY idx_designs_owner_updated (owner_id, updated_at),
            CONSTRAINT fk_designs_owner FOREIGN KEY (owner_id)
                REFERENCES users (id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        SQL;

    // LONGBLOB, not LONGTEXT: an uploaded .ttf is binary, and a bitmap is
    // stored as its original file bytes so the trace is reproducible.
    $tables[] = <<<'SQL'
        CREATE TABLE IF NOT EXISTS design_assets (
            id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
            design_id  INT UNSIGNED NOT NULL,
            kind       VARCHAR(16)  NOT NULL,
            asset_key  VARCHAR(190) NULL,
            filename   VARCHAR(255) NULL,
            mime       VARCHAR(100) NULL,
            byte_size  INT UNSIGNED NOT NULL DEFAULT 0,
            sha256     CHAR(64) NULL,
            data       LONGBLOB NOT NULL,
            created_at INT UNSIGNED NOT NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_assets_design_kind (design_id, kind),
            CONSTRAINT fk_assets_design FOREIGN KEY (design_id)
                REFERENCES designs (id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        SQL;

    // The share token is stored in the clear so the owner can copy the link
    // again later instead of it being shown exactly once. It is 43 characters
    // of base64url over 32 random bytes, and it only ever unlocks a
    // read-only view of a design that already sits in this same database.
    $tables[] = <<<'SQL'
        CREATE TABLE IF NOT EXISTS design_shares (
            id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
            design_id      INT UNSIGNED NOT NULL,
            token          VARCHAR(64) NOT NULL,
            created_by     INT UNSIGNED NULL,
            created_at     INT UNSIGNED NOT NULL,
            expires_at     INT UNSIGNED NULL,
            revoked_at     INT UNSIGNED NULL,
            view_count     INT UNSIGNED NOT NULL DEFAULT 0,
            last_viewed_at INT UNSIGNED NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_shares_token (token),
            KEY idx_shares_design (design_id),
            CONSTRAINT fk_shares_design FOREIGN KEY (design_id)
                REFERENCES designs (id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        SQL;

    $tables[] = <<<'SQL'
        CREATE TABLE IF NOT EXISTS jobs (
            id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
            owner_id      INT UNSIGNED NOT NULL DEFAULT 0,
            filename      VARCHAR(255) NOT NULL,
            preset_id     INT UNSIGNED NULL,
            design_id     INT UNSIGNED NULL,
            svg_hash      VARCHAR(64) NULL,
            gcode_path    VARCHAR(255) NULL,
            settings_json MEDIUMTEXT NOT NULL,
            created_at    INT UNSIGNED NULL,
            PRIMARY KEY (id),
            KEY idx_jobs_owner (owner_id, id),
            KEY idx_jobs_preset (preset_id),
            KEY idx_jobs_design (design_id),
            CONSTRAINT fk_jobs_preset FOREIGN KEY (preset_id)
                REFERENCES presets (id) ON DELETE SET NULL,
            CONSTRAINT fk_jobs_design FOREIGN KEY (design_id)
                REFERENCES designs (id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        SQL;

    foreach ($tables as $sql) {
        $db->exec($sql);
    }
}

/** True when $table already has a column called $column. */
function forge_has_column(PDO $db, string $table, string $column): bool
{
    try {
        $s = $db->prepare(
            'SELECT 1 FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?
             LIMIT 1');
        $s->execute([$table, $column]);
        return (bool) $s->fetchColumn();
    } catch (Throwable $e) {
        error_log('LowRider Forge: column probe failed — ' . $e->getMessage());
        return true;   // assume present: skipping a migration beats a crash loop
    }
}

/** True when $table already has an index called $index. */
function forge_has_index(PDO $db, string $table, string $index): bool
{
    try {
        $s = $db->prepare(
            'SELECT 1 FROM information_schema.statistics
             WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?
             LIMIT 1');
        $s->execute([$table, $index]);
        return (bool) $s->fetchColumn();
    } catch (Throwable $e) {
        error_log('LowRider Forge: index probe failed — ' . $e->getMessage());
        return true;
    }
}

/**
 * Additive migrations for databases created by an earlier 2.x release.
 *
 * Every step probes information_schema first, so this is safe to run on every
 * request and safe to re-run after a partially applied upgrade. Pre-2.0
 * SQLite databases are not migrated here — they are converted once, offline,
 * by tools/migrate-sqlite-to-mysql.php.
 */
function forge_migrate(PDO $db): void
{
    $steps = [
        // 2.0.0 → 2.0.1: designs gained a free-text note field.
        ['designs', 'notes', 'ALTER TABLE designs ADD COLUMN notes TEXT NULL'],
        ['jobs', 'design_id', 'ALTER TABLE jobs ADD COLUMN design_id INT UNSIGNED NULL'],
    ];

    foreach ($steps as [$table, $column, $sql]) {
        try {
            if (!forge_has_column($db, $table, $column)) {
                $db->exec($sql);
            }
        } catch (Throwable $e) {
            error_log("LowRider Forge: migration $table.$column skipped — " . $e->getMessage());
        }
    }
}

/**
 * Seed the starter library. Idempotent: every insert is INSERT IGNORE against
 * the UNIQUE (owner_id, name) key and the whole batch runs in one
 * transaction, so a concurrent first request or a re-seed after a partial
 * wipe can never raise a duplicate-key error. Seeding is best-effort — a
 * failure here leaves a usable (if emptier) tool.
 *
 * Everything seeded here belongs to owner 0, the built-in library: readable
 * by every account, editable by none. A user who changes a seeded bit gets a
 * private copy instead (see api/bits.php).
 */
function forge_seed(PDO $db): void
{
    try {
        $db->beginTransaction();

        // --- Bits: a standard sign-shop set ---
        // [name, diameter, shank, flutes, cutting length, type, V-angle, notes]
        $bits = [
            // end mills — wood, foam, board
            ['1/16" 2-flute upcut (fine detail)', 1.5875, 3.175, 2, 6.0, 'upcut', null,
                'Tiny detail in wood and plastics. Fragile — light passes, modest feed.'],
            ['1/8" 2-flute upcut (detail wood, SpeTool W04021)', 3.175, 3.175, 2, 25.4, 'upcut', null,
                'Fine detail in wood. Long reach.'],
            ['1/4" 2-flute upcut (general wood/foam)', 6.35, 6.35, 2, 25.0, 'upcut', null,
                'General purpose for wood and rigid foam.'],
            ['1/8" 2-flute downcut (clean top edge)', 3.175, 3.175, 2, 22.0, 'downcut', null,
                'Pushes chips down for a splinter-free top surface. Shallow passes — downcut clears chips poorly.'],
            ['1/4" 2-flute downcut (clean top edge)', 6.35, 6.35, 2, 25.0, 'downcut', null,
                'Clean top face on plywood and laminate. Keep passes shallow.'],
            ['1/8" compression (plywood, both faces clean)', 3.175, 3.175, 2, 22.0, 'compression', null,
                'Up-cut tip plus down-cut body. The first pass must be deep enough to reach the down-cut section.'],
            ['1/4" compression (plywood, both faces clean)', 6.35, 6.35, 2, 28.0, 'compression', null,
                'Clean top and bottom faces on plywood. First pass deeper than the up-cut tip.'],
            // O-flutes — plastics
            ['1/8" single-flute O-flute (plastic detail)', 3.175, 3.175, 1, 17.0, 'O-flute', null,
                'Detail work in plastics. Short cutting length — watch depth.'],
            ['1/4" single-flute O-flute (plastics)', 6.35, 6.35, 1, 25.0, 'O-flute', null,
                'Mandatory for HDPE and acrylic — clears chips, avoids melting.'],
            ['1/4" two-flute O-flute (plastics, fast)', 6.35, 6.35, 2, 25.0, 'O-flute', null,
                'Faster clearing in HDPE/acrylic than single-flute — keep the feed high so it cannot melt.'],
            // V-bits and engraving — sign lettering and V-carving
            ['Tapered engraving bit (2-color HDPE)', 3.175, 6.35, 1, 12.0, 'V-bit', 30.0,
                'Conical engraving bit with a fine tip — crisp lettering in two-color HDPE. V-carves at a 30-degree included angle.'],
            ['20 deg V-bit (fine V-carve)', 6.35, 6.35, 1, 10.0, 'V-bit', 20.0,
                'Narrow V for fine, detailed lettering and intricate V-carving.'],
            ['30 deg V-bit (detail V-carve)', 9.5, 6.35, 1, 11.0, 'V-bit', 30.0,
                'Detailed V-carved lettering. Effective width grows with depth.'],
            ['60 deg V-bit (sign engraving)', 12.7, 6.35, 1, 12.0, 'V-bit', 60.0,
                'The sign-shop workhorse for V-carved lettering.'],
            ['90 deg V-bit (bold V-carve / chamfer)', 19.05, 6.35, 1, 9.0, 'V-bit', 90.0,
                'Wide V for bold lettering, chamfers and edge bevels.'],
            // ball nose — relief
            ['1/8" ball nose (relief / rounded pockets)', 3.175, 3.175, 2, 22.0, 'upcut', null,
                'Rounded tip for relief carving and softened pocket floors.'],
            ['1/4" ball nose (relief carving)', 6.35, 6.35, 2, 25.0, 'upcut', null,
                'Rounded tip for 3D relief and contoured signs.'],
            // aluminium
            ['1/8" single-flute aluminium', 3.175, 3.175, 1, 12.0, 'upcut', null,
                'For 6061 detail. Slow feed, very shallow DOC, single flute clears swarf.'],
            ['1/4" single-flute aluminium', 6.35, 6.35, 1, 18.0, 'upcut', null,
                'For 6061. Slow feeds, shallow DOC, single flute clears swarf.'],
        ];
        $stmt = $db->prepare('INSERT IGNORE INTO bits
            (owner_id,name,diameter_mm,shank_diameter_mm,flute_count,cutting_length_mm,type,v_angle_deg,notes)
            VALUES (0,?,?,?,?,?,?,?,?)');
        foreach ($bits as $b) {
            $stmt->execute($b);
        }

        // --- Materials: a standard sign-shop set ---
        $materials = [
            ['1.5" rigid insulation foam', 38.0, 'upcut', 18000, 3000, 1200, 6.0, 1.0,
                'Soft — fast feeds fine. Foam tolerates DOC beyond the bit diameter; raise it if you like. Watch for tear-out with dull bits.'],
            ['PVC foam board (Sintra) 3mm', 3.0, 'O-flute', 16000, 2500, 800, 2.0, 0.5,
                'Easy to cut and engrave. A single-flute O-flute keeps edges clean.'],
            ['PVC foam board (Sintra) 6mm', 6.0, 'O-flute', 16000, 2200, 700, 2.5, 0.5,
                'Common sign substrate. Keep RPM moderate so it cannot melt.'],
            ['PVC foam board (Sintra) 10mm', 10.0, 'O-flute', 16000, 2000, 600, 3.0, 0.5,
                'Thicker sign board. Single-flute O-flute, moderate RPM.'],
            ['2-color HDPE (engraving stock)', 3.175, 'O-flute', 18000, 1500, 500, 1.0, 0.5,
                'Cap layer 0.3-0.5mm thick and varies by manufacturer. Single-flute O-flute only.'],
            ['HDPE solid 3mm', 3.0, 'O-flute', 18000, 2000, 600, 1.5, 0.6,
                'Single-flute O-flute mandatory — multi-flute bits melt HDPE.'],
            ['HDPE solid 6mm', 6.0, 'O-flute', 18000, 1800, 600, 2.0, 0.6,
                'Single-flute O-flute mandatory — multi-flute bits melt HDPE.'],
            ['HDPE solid 12mm', 12.0, 'O-flute', 18000, 1500, 500, 2.5, 0.6,
                'Thick HDPE. Single-flute O-flute; clear chips well to avoid melting.'],
            ['1/4" plywood', 6.35, 'upcut', 18000, 2000, 700, 3.0, 0.65,
                'Measure your actual thickness before cutting; nominal 1/4" plywood is often 5.5-6.0mm.'],
            ['1/2" plywood', 12.7, 'upcut', 18000, 1800, 600, 3.0, 0.65,
                'Measure actual thickness; voids possible in cheaper ply.'],
            ['Baltic birch plywood 6mm', 6.0, 'compression', 18000, 2000, 700, 4.0, 0.6,
                'Void-free premium ply. A compression bit leaves both faces clean — the first pass must reach past the up-cut tip (~3-4mm), hence the deeper DOC.'],
            ['Baltic birch plywood 12mm', 12.0, 'compression', 18000, 1800, 600, 4.0, 0.6,
                'Premium ply for sign blanks. Compression bit for clean faces — first pass must reach past the up-cut tip (~3-4mm).'],
            ['1/4" MDF', 6.35, 'upcut', 18000, 2200, 800, 3.0, 0.65,
                'Dusty. Nominal thickness usually accurate to +/-0.2mm.'],
            ['1/4" hardboard', 6.35, 'upcut', 18000, 2000, 700, 3.0, 0.65,
                'Dense and abrasive on bits.'],
            ['Cast acrylic 3mm', 3.0, 'O-flute', 18000, 1600, 500, 1.5, 0.5,
                'Cast acrylic only — extruded melts and chips. Single-flute O-flute.'],
            ['1/4" acrylic (cast)', 6.35, 'O-flute', 18000, 1400, 450, 1.5, 0.5,
                'Cast acrylic only — extruded melts and chips. Single-flute O-flute.'],
            ['ACM / Dibond 3mm', 3.0, 'O-flute', 18000, 2000, 600, 1.0, 0.4,
                'Aluminium-skinned composite. Single-flute O-flute, moderate feed — the core cuts easily, the skins do not.'],
            ['Hardwood board (oak / maple)', 19.0, 'upcut', 18000, 1800, 600, 3.0, 0.6,
                'Dense hardwood for routed signs. A climb-mill final pass leaves a clean edge.'],
            ['Cedar sign board', 19.0, 'upcut', 16000, 2400, 800, 4.0, 0.6,
                'Soft and forgiving for carved signs. Watch for fuzzy grain with dull bits.'],
            ['6061-T6 aluminium 3mm', 3.0, 'upcut', 11000, 800, 250, 0.5, 0.3,
                'Slow feeds, shallow DOC, LOW RPM (Makita dial 1-2) — 18k+ RPM dry-cutting 6061 welds chips and snaps bits. Use lubricant. Single-flute aluminium bit.'],
        ];
        $stmt = $db->prepare('INSERT IGNORE INTO materials
            (owner_id,name,thickness_mm,recommended_bit_type,recommended_rpm,recommended_feed_cut,
             recommended_feed_plunge,recommended_doc_mm,through_cut_overage_mm,notes)
            VALUES (0,?,?,?,?,?,?,?,?,?)');
        foreach ($materials as $m) {
            $stmt->execute($m);
        }

        // --- Sample presets (spec section 13) ---
        // Exact names, scoped to the built-in library: the old LIKE '%…%'
        // lookup would rebind a preset to whichever row matched first once
        // users started adding bits of their own.
        $idOf = function (PDO $db, string $table, string $name): ?int {
            $s = $db->prepare("SELECT id FROM $table WHERE owner_id = 0 AND name = ? LIMIT 1");
            $s->execute([$name]);
            $v = $s->fetchColumn();
            return $v === false ? null : (int) $v;
        };

        $now = time();
        $presets = [
            ['Foam dimensional engrave',
                $idOf($db, 'bits', '1/8" 2-flute upcut (detail wood, SpeTool W04021)'),
                $idOf($db, 'materials', '1.5" rigid insulation foam'),
                'engrave',
                ['finalDepth' => -4, 'docPerPass' => 4, 'feedCut' => 2000, 'feedPlunge' => 800]],
            ['Plywood profile cut with tabs',
                $idOf($db, 'bits', '1/8" 2-flute upcut (detail wood, SpeTool W04021)'),
                $idOf($db, 'materials', '1/4" plywood'),
                'profile-out',
                ['finalDepth' => -7, 'docPerPass' => 3, 'feedCut' => 2000, 'feedPlunge' => 700,
                 'tabsEnabled' => true, 'tabCount' => 4, 'tabThickness' => 1.5, 'tabWidth' => 6]],
            ['HDPE 2-color sign engrave',
                $idOf($db, 'bits', '1/8" single-flute O-flute (plastic detail)'),
                $idOf($db, 'materials', '2-color HDPE (engraving stock)'),
                'engrave',
                ['finalDepth' => -0.5, 'docPerPass' => 0.5, 'feedCut' => 1500, 'feedPlunge' => 500]],
            // RPM and plunge style are pinned here: aluminium is the one
            // material where inheriting a wood job's 18k+ RPM straight
            // plunge welds chips and snaps the bit.
            ['Aluminium 6061 profile',
                $idOf($db, 'bits', '1/4" single-flute aluminium'),
                $idOf($db, 'materials', '6061-T6 aluminium 3mm'),
                'profile-out',
                ['finalDepth' => -3.3, 'docPerPass' => 0.5, 'feedCut' => 800, 'feedPlunge' => 250,
                 'spindleRpm' => 11000, 'plungeStyle' => 'peck',
                 'tabsEnabled' => true, 'tabCount' => 6, 'tabThickness' => 1.0, 'tabWidth' => 6]],
        ];
        $stmt = $db->prepare('INSERT IGNORE INTO presets
            (owner_id,name,bit_id,material_id,operation,settings_json,created_at,updated_at)
            VALUES (0,?,?,?,?,?,?,?)');
        foreach ($presets as $p) {
            $stmt->execute([$p[0], $p[1], $p[2], $p[3], json_encode($p[4]), $now, $now]);
        }

        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        error_log('LowRider Forge: seed skipped — ' . $e->getMessage());
    }
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

function json_response($data, int $code = 200): void
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(
        $data,
        JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT | JSON_INVALID_UTF8_SUBSTITUTE
    );
    exit;
}

/**
 * Decode the JSON request body. Detects the common shared-host failure where
 * the body is silently dropped because it exceeds post_max_size.
 */
function read_json_body(): array
{
    $raw       = file_get_contents('php://input');
    $declared  = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
    if (($raw === '' || $raw === false) && $declared > 0) {
        json_response([
            'error' => 'The request body was dropped by the server, which usually '
                . 'means it exceeds the host post_max_size / upload limit. Raise '
                . 'post_max_size and upload_max_filesize in cPanel "MultiPHP INI Editor".',
        ], 413);
    }
    if ($raw === '' || $raw === false) {
        return [];
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        json_response(['error' => 'Request body must be a JSON object.'], 400);
    }
    return $data;
}

/** Cast to float or null. */
function nf($v): ?float
{
    return ($v === null || $v === '') ? null : (float) $v;
}

/** Cast to int or null. */
function ni($v): ?int
{
    return ($v === null || $v === '') ? null : (int) $v;
}

/** Require a non-empty string field. */
function require_str(array $body, string $key): string
{
    $v = trim((string) ($body[$key] ?? ''));
    if ($v === '') {
        json_response(['error' => "Field '$key' is required."], 400);
    }
    return $v;
}

/**
 * Trim a string field to a maximum length.
 *
 * Every VARCHAR in the schema is a hard limit now that sql_mode is strict:
 * an over-long name would abort the INSERT rather than being silently cut,
 * so callers clamp here and the user keeps their save.
 */
function clamp_str($v, int $max, string $default = ''): string
{
    $s = trim((string) ($v ?? ''));
    if ($s === '') {
        return $default;
    }
    return mb_substr($s, 0, $max);
}

/** 32 random bytes as 43 characters of base64url — a share or session token. */
function forge_token(): string
{
    return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
}
