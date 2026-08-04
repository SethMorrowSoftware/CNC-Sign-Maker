<?php
/**
 * LowRider Forge — SQLite layer.
 * Lazy-creates the database, schema and seed library on first use so the
 * tool works on any host with zero setup. install.sh is optional.
 *
 * Hosting note: the database deliberately uses a rollback journal, NOT WAL.
 * Shared cPanel accounts frequently keep home directories on NFS, and SQLite
 * WAL mode needs shared-memory mmap that NFS does not provide — WAL there
 * fails with "disk I/O error". A busy timeout lets the handful of concurrent
 * writes a single company generates wait politely for the lock instead of
 * failing immediately.
 */
declare(strict_types=1);

defined('FORGE_APP') || exit('Direct access denied');

const FORGE_VERSION = '1.0.0';

// Bumped whenever the seed library changes, so existing databases pick up new
// bits and materials on the next request. Seeding is idempotent.
const FORGE_SEED_VERSION = 2;

function forge_data_dir(): string
{
    return dirname(__DIR__) . '/data';
}

/**
 * Open (and, on first use, create + seed) the SQLite database.
 * Throws RuntimeException with an operator-friendly message on failure.
 */
function forge_db(): PDO
{
    static $db = null;
    if ($db instanceof PDO) {
        return $db;
    }

    if (!extension_loaded('pdo_sqlite')) {
        throw new RuntimeException(
            'The PHP "pdo_sqlite" extension is not enabled. In cPanel, open '
            . '"Select PHP Version" and tick the pdo_sqlite (or sqlite3) extension.'
        );
    }

    $dir = forge_data_dir();
    if (!is_dir($dir)) {
        @mkdir($dir, 0775, true);
        // The committed data/.htaccess denies web access on Apache. If an
        // operator wipes data/ to reset, the recreated directory must get
        // the same protection or saved gcode becomes directly downloadable.
        if (is_dir($dir) && !is_file($dir . '/.htaccess')) {
            @file_put_contents($dir . '/.htaccess',
                "# LowRider Forge — keep the database and saved jobs off the web.\n"
                . "<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n"
                . "<IfModule !mod_authz_core.c>\n  Order allow,deny\n  Deny from all\n</IfModule>\n");
        }
    }
    if (!is_dir($dir) || !is_writable($dir)) {
        throw new RuntimeException(
            'The data directory is not writable: ' . $dir . '. Set its '
            . 'permissions to 0755 (or 0775) so the web server can create the database.'
        );
    }
    $jobsDir = $dir . '/jobs';
    if (!is_dir($jobsDir)) {
        @mkdir($jobsDir, 0775, true);
    }

    $path = $dir . '/forge.sqlite';

    try {
        $db = new PDO('sqlite:' . $path, null, null, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
    } catch (PDOException $e) {
        throw new RuntimeException(
            'Could not open the database. Check that ' . $dir
            . ' is writable by the web server and has free disk space.'
        );
    }

    // NFS-safe pragmas. busy_timeout makes a locked write wait up to 5s
    // instead of failing instantly with "database is locked".
    try {
        $db->exec('PRAGMA busy_timeout = 5000');
        $db->exec('PRAGMA journal_mode = TRUNCATE');
        $db->exec('PRAGMA synchronous = NORMAL');
        $db->exec('PRAGMA foreign_keys = ON');
    } catch (PDOException $e) {
        // Pragmas are best-effort tuning — never fatal.
    }

    forge_init_schema($db);
    forge_migrate($db);

    // Seed (or top up) the library when the stored seed version is behind.
    $seeded = 0;
    try {
        $seeded = (int) ($db->query(
            "SELECT value FROM meta WHERE key = 'seed_version'")->fetchColumn() ?: 0);
    } catch (Throwable $e) {
        // meta table missing/unreadable — treat as never seeded
    }
    if ($seeded < FORGE_SEED_VERSION) {
        forge_seed($db);
        try {
            $db->prepare("INSERT INTO meta (key, value) VALUES ('seed_version', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value")
               ->execute([(string) FORGE_SEED_VERSION]);
        } catch (Throwable $e) {
            error_log('LowRider Forge: could not record seed version — ' . $e->getMessage());
        }
    }

    return $db;
}

function forge_init_schema(PDO $db): void
{
    $db->exec(<<<'SQL'
        CREATE TABLE IF NOT EXISTS bits (
            id INTEGER PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            diameter_mm REAL NOT NULL,
            shank_diameter_mm REAL,
            flute_count INTEGER NOT NULL DEFAULT 2,
            cutting_length_mm REAL,
            type TEXT NOT NULL DEFAULT 'upcut',
            v_angle_deg REAL,
            notes TEXT
        );
        CREATE TABLE IF NOT EXISTS materials (
            id INTEGER PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            thickness_mm REAL,
            recommended_bit_type TEXT,
            recommended_rpm INTEGER,
            recommended_feed_cut INTEGER,
            recommended_feed_plunge INTEGER,
            recommended_doc_mm REAL,
            through_cut_overage_mm REAL DEFAULT 0.65,
            notes TEXT
        );
        CREATE TABLE IF NOT EXISTS presets (
            id INTEGER PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            bit_id INTEGER REFERENCES bits(id) ON DELETE SET NULL,
            material_id INTEGER REFERENCES materials(id) ON DELETE SET NULL,
            operation TEXT NOT NULL,
            settings_json TEXT NOT NULL,
            created_at INTEGER,
            updated_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS jobs (
            id INTEGER PRIMARY KEY,
            filename TEXT NOT NULL,
            preset_id INTEGER REFERENCES presets(id) ON DELETE SET NULL,
            svg_hash TEXT NOT NULL,
            gcode_path TEXT,
            settings_json TEXT NOT NULL,
            created_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        SQL);
}

/**
 * Additive schema migrations for databases created by an earlier version.
 * Idempotent and best-effort: each step checks before it runs.
 */
function forge_migrate(PDO $db): void
{
    try {
        $cols = $db->query('PRAGMA table_info(bits)')->fetchAll(PDO::FETCH_COLUMN, 1);
        if (!in_array('v_angle_deg', $cols, true)) {
            $db->exec('ALTER TABLE bits ADD COLUMN v_angle_deg REAL');
            // record the included angle for the V-bits the tool ships with
            $angles = [
                'Tapered engraving bit (2-color HDPE)'  => 30,
                '20 deg V-bit (fine V-carve)'           => 20,
                '30 deg V-bit (detail V-carve)'         => 30,
                '60 deg V-bit (sign engraving)'         => 60,
                '90 deg V-bit (bold V-carve / chamfer)' => 90,
            ];
            $st = $db->prepare('UPDATE bits SET v_angle_deg = ? WHERE name = ?');
            foreach ($angles as $name => $deg) {
                $st->execute([$deg, $name]);
            }
        }
    } catch (Throwable $e) {
        error_log('LowRider Forge: bits migration skipped — ' . $e->getMessage());
    }
}

/**
 * Seed the starter library. Idempotent: every insert is INSERT OR IGNORE and
 * the whole batch runs in one transaction, so a concurrent first request or a
 * re-seed after a partial wipe can never raise a UNIQUE-constraint error.
 * Seeding is best-effort — a failure here leaves a usable (if emptier) tool.
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
        $stmt = $db->prepare('INSERT OR IGNORE INTO bits
            (name,diameter_mm,shank_diameter_mm,flute_count,cutting_length_mm,type,v_angle_deg,notes)
            VALUES (?,?,?,?,?,?,?,?)');
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
        $stmt = $db->prepare('INSERT OR IGNORE INTO materials
            (name,thickness_mm,recommended_bit_type,recommended_rpm,recommended_feed_cut,
             recommended_feed_plunge,recommended_doc_mm,through_cut_overage_mm,notes)
            VALUES (?,?,?,?,?,?,?,?,?)');
        foreach ($materials as $m) {
            $stmt->execute($m);
        }

        // --- Sample presets (spec section 13) ---
        $idOf = function (PDO $db, string $table, string $like): ?int {
            $s = $db->prepare("SELECT id FROM $table WHERE name LIKE ? LIMIT 1");
            $s->execute(['%' . $like . '%']);
            $v = $s->fetchColumn();
            return $v === false ? null : (int) $v;
        };

        $now = time();
        // Exact seed names — a LIKE '%…%' lookup silently rebinds a preset
        // to whichever row happens to match first when the library grows.
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
        $stmt = $db->prepare('INSERT OR IGNORE INTO presets
            (name,bit_id,material_id,operation,settings_json,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?)');
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
