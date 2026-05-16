<?php
/**
 * LowRider Forge — SQLite layer.
 * Lazy-creates the database, schema and seed library on first use so the
 * tool works on any host with zero setup. install.sh is optional.
 */
declare(strict_types=1);

defined('FORGE_APP') || exit('Direct access denied');

const FORGE_VERSION = '1.0.0';

function forge_data_dir(): string
{
    return dirname(__DIR__) . '/data';
}

function forge_db(): PDO
{
    static $db = null;
    if ($db instanceof PDO) {
        return $db;
    }

    $dir = forge_data_dir();
    if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
        throw new RuntimeException('Cannot create data directory: ' . $dir);
    }
    $jobsDir = $dir . '/jobs';
    if (!is_dir($jobsDir)) {
        @mkdir($jobsDir, 0775, true);
    }

    $path = $dir . '/forge.sqlite';
    $fresh = !file_exists($path);

    $db = new PDO('sqlite:' . $path, null, null, [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $db->exec('PRAGMA journal_mode = WAL');
    $db->exec('PRAGMA foreign_keys = ON');

    forge_init_schema($db);
    if ($fresh || (int) $db->query('SELECT COUNT(*) FROM bits')->fetchColumn() === 0) {
        forge_seed($db);
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
        SQL);
}

function forge_seed(PDO $db): void
{
    // --- Bits (spec section 13) ---
    $bits = [
        ['1/4" 2-flute upcut (general wood/foam)', 6.35, 6.35, 2, 25.0, 'upcut',
            'General purpose for wood and rigid foam.'],
        ['1/8" 2-flute upcut (detail wood, SpeTool W04021)', 3.175, 3.175, 2, 25.4, 'upcut',
            'Fine detail in wood. Long reach.'],
        ['1/4" single-flute O-flute (plastics)', 6.35, 6.35, 1, 25.0, 'O-flute',
            'Mandatory for HDPE and acrylic — clears chips, avoids melting.'],
        ['1/8" single-flute O-flute (plastic detail)', 3.175, 3.175, 1, 17.0, 'O-flute',
            'Detail work in plastics. Short cutting length — watch depth.'],
        ['60 deg V-bit (sign engraving)', 12.7, 6.35, 1, 12.0, 'V-bit',
            'V-carving / engraving. Effective diameter varies with depth.'],
        ['1/4" single-flute aluminium', 6.35, 6.35, 1, 18.0, 'upcut',
            'For 6061. Slow feeds, shallow DOC, single flute clears swarf.'],
    ];
    $stmt = $db->prepare('INSERT INTO bits
        (name,diameter_mm,shank_diameter_mm,flute_count,cutting_length_mm,type,notes)
        VALUES (?,?,?,?,?,?,?)');
    foreach ($bits as $b) {
        $stmt->execute($b);
    }

    // --- Materials (spec section 13) ---
    $materials = [
        ['1.5" rigid insulation foam', 38.0, 'upcut', 18000, 3000, 1200, 12.0, 1.0,
            'Soft — fast feeds fine. Watch for tear-out with dull bits.'],
        ['1/4" plywood', 6.35, 'upcut', 18000, 2000, 700, 3.0, 0.65,
            'Measure your actual thickness before cutting; nominal 1/4" plywood is often 5.5-6.0mm.'],
        ['1/4" MDF', 6.35, 'upcut', 18000, 2200, 800, 3.0, 0.65,
            'Dusty. Nominal thickness usually accurate to +/-0.2mm.'],
        ['1/4" hardboard', 6.35, 'upcut', 18000, 2000, 700, 3.0, 0.65,
            'Dense and abrasive on bits.'],
        ['1/2" plywood', 12.7, 'upcut', 18000, 1800, 600, 3.0, 0.65,
            'Measure actual thickness; voids possible in cheaper ply.'],
        ['2-color HDPE (engraving stock)', 3.175, 'O-flute', 18000, 1500, 500, 1.0, 0.5,
            'Cap layer 0.3-0.5mm thick and varies by manufacturer. Single-flute O-flute only.'],
        ['HDPE solid 6mm', 6.0, 'O-flute', 18000, 1800, 600, 2.0, 0.6,
            'Single-flute O-flute mandatory — multi-flute bits melt HDPE.'],
        ['1/4" acrylic (cast)', 6.35, 'O-flute', 18000, 1400, 450, 1.5, 0.5,
            'Cast acrylic only — extruded melts and chips. Single-flute O-flute.'],
        ['6061-T6 aluminium 3mm', 3.0, 'upcut', 18000, 800, 250, 0.5, 0.3,
            'Slow feeds, shallow DOC. Use lubricant. Single-flute aluminium bit.'],
    ];
    $stmt = $db->prepare('INSERT INTO materials
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
    $presets = [
        ['Foam dimensional engrave',
            $idOf($db, 'bits', '1/8" 2-flute upcut'),
            $idOf($db, 'materials', 'foam'),
            'engrave',
            ['finalDepth' => -4, 'docPerPass' => 4, 'feedCut' => 2000, 'feedPlunge' => 800]],
        ['Plywood profile cut with tabs',
            $idOf($db, 'bits', '1/8" 2-flute upcut'),
            $idOf($db, 'materials', '1/4" plywood'),
            'profile-out',
            ['finalDepth' => -7, 'docPerPass' => 3, 'feedCut' => 2000, 'feedPlunge' => 700,
             'tabsEnabled' => true, 'tabCount' => 4, 'tabThickness' => 1.5, 'tabWidth' => 6]],
        ['HDPE 2-color sign engrave',
            $idOf($db, 'bits', '1/8" single-flute O-flute'),
            $idOf($db, 'materials', '2-color HDPE'),
            'engrave',
            ['finalDepth' => -0.5, 'docPerPass' => 0.5, 'feedCut' => 1500, 'feedPlunge' => 500]],
        ['Aluminium 6061 profile',
            $idOf($db, 'bits', 'aluminium'),
            $idOf($db, 'materials', '6061'),
            'profile-out',
            ['finalDepth' => -3.3, 'docPerPass' => 0.5, 'feedCut' => 800, 'feedPlunge' => 250,
             'tabsEnabled' => true, 'tabCount' => 6, 'tabThickness' => 1.0, 'tabWidth' => 6]],
    ];
    $stmt = $db->prepare('INSERT INTO presets
        (name,bit_id,material_id,operation,settings_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?)');
    foreach ($presets as $p) {
        $stmt->execute([$p[0], $p[1], $p[2], $p[3], json_encode($p[4]), $now, $now]);
    }
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

function json_response($data, int $code = 200): void
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    exit;
}

function read_json_body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) {
        return [];
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        json_response(['error' => 'Request body must be a JSON object'], 400);
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
        json_response(['error' => "Field '$key' is required"], 400);
    }
    return $v;
}
