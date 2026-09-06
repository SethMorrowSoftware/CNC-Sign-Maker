<?php
/**
 * LowRider Forge — one-shot SQLite → MySQL import.
 *
 * Versions before 2.0 kept the bit, material, preset and job library in
 * data/forge.sqlite. This copies that content into the MySQL database
 * configured in api/config.php so an existing install is not stranded by the
 * upgrade. Run it once, from a shell, in the project root:
 *
 *     php tools/migrate-sqlite-to-mysql.php --owner=you@example.com
 *     php tools/migrate-sqlite-to-mysql.php --owner=system --dry-run
 *
 * Options:
 *   --owner=<email>   Give the imported rows to this account. Create it first
 *                     by registering in the browser. Rows land in that user's
 *                     private library.
 *   --owner=system    Import into the shared built-in library (owner 0)
 *                     instead, where every account can read them but nobody
 *                     can edit them in place.
 *   --db=<path>       SQLite file to read. Default: data/forge.sqlite
 *   --dry-run         Report what would be imported and change nothing.
 *
 * The import is additive and safe to re-run: a row whose name already exists
 * for the target owner is skipped, never overwritten. Nothing is deleted from
 * the SQLite file, so it stays a rollback point.
 *
 * Saved gcode files are left where they are under data/jobs; only the rows
 * that point at them move.
 */
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit("This script only runs from the command line.\n");
}

define('FORGE_APP', true);
require dirname(__DIR__) . '/api/db.php';

/* ---- arguments ---------------------------------------------------- */

$opts = [];
foreach (array_slice($argv, 1) as $arg) {
    if (preg_match('/^--([a-z-]+)(?:=(.*))?$/', $arg, $m)) {
        $opts[$m[1]] = $m[2] ?? true;
    }
}

$dryRun     = isset($opts['dry-run']);
$sqlitePath = (string) ($opts['db'] ?? (forge_data_dir() . '/forge.sqlite'));
$ownerOpt   = $opts['owner'] ?? null;

function fail(string $msg): void
{
    fwrite(STDERR, "ERROR: $msg\n");
    exit(1);
}

function say(string $msg): void
{
    fwrite(STDOUT, $msg . "\n");
}

if ($ownerOpt === null) {
    fail("--owner is required.\n"
        . "  --owner=you@example.com   import into that account's private library\n"
        . "  --owner=system            import into the shared built-in library");
}
if (!extension_loaded('pdo_sqlite')) {
    fail('The pdo_sqlite extension is needed to read the old database.');
}
if (!is_file($sqlitePath)) {
    fail("No SQLite database at $sqlitePath. Pass --db=<path> if it lives elsewhere.");
}

/* ---- connect ------------------------------------------------------- */

try {
    $old = new PDO('sqlite:' . $sqlitePath, null, null, [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
} catch (PDOException $e) {
    fail('Could not open the SQLite database: ' . $e->getMessage());
}

try {
    $db = forge_db();   // creates the MySQL schema and seeds it if needed
} catch (RuntimeException $e) {
    fail($e->getMessage());
}

$ownerId = 0;
if ($ownerOpt !== 'system') {
    $s = $db->prepare('SELECT id, display_name FROM users WHERE email = ?');
    $s->execute([mb_strtolower(trim((string) $ownerOpt))]);
    $u = $s->fetch();
    if (!$u) {
        fail("No account with the email '$ownerOpt'. Register it in the browser "
            . 'first, then re-run this. (Or use --owner=system for the shared library.)');
    }
    $ownerId = (int) $u['id'];
    say("Importing into the library of {$u['display_name']} <{$ownerOpt}> (user $ownerId).");
} else {
    say('Importing into the shared built-in library (owner 0).');
}
say('Source: ' . $sqlitePath);
if ($dryRun) {
    say('DRY RUN — nothing will be written.');
}
say('');

/** Does the old database have this table? */
function old_has_table(PDO $old, string $name): bool
{
    $s = $old->prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?");
    $s->execute([$name]);
    return (bool) $s->fetchColumn();
}

/** Old-schema column list, so a database from any 1.x build still imports. */
function old_columns(PDO $old, string $table): array
{
    return $old->query("PRAGMA table_info($table)")->fetchAll(PDO::FETCH_COLUMN, 1);
}

$stats = [];

/* ---- bits and materials -------------------------------------------- */

/**
 * Copy rows from one table into the target owner's library.
 *
 * $map is [newColumn => oldColumn]; an old column that does not exist in this
 * particular 1.x database yields null rather than aborting the import.
 *
 * Name collisions are the interesting part. Under 1.x a user could edit a
 * seeded bit in place, so a row whose name matches a built-in may be either
 * untouched seed data or the shop's own corrected numbers. Skipping both would
 * silently discard the corrections, and importing both would litter the
 * library with duplicates — so the values decide: identical rows are skipped
 * as already present, and rows that differ are imported under a suffixed name
 * and reported.
 */
function import_named(PDO $old, PDO $db, string $table, array $map,
                      int $ownerId, bool $dryRun): array
{
    if (!old_has_table($old, $table)) {
        return ['skipped' => 0, 'imported' => 0, 'renamed' => 0, 'missing' => true];
    }
    $have = old_columns($old, $table);
    $rows = $old->query("SELECT * FROM $table")->fetchAll();

    $cols = array_keys($map);
    $ins  = $db->prepare("INSERT INTO $table (owner_id," . implode(',', $cols) . ') VALUES (?'
          . str_repeat(',?', count($cols)) . ')');
    // Look at every visible row of that name: the target owner's own, and the
    // shared built-in library.
    $lookup = $db->prepare("SELECT * FROM $table WHERE name = ? AND owner_id IN (?, 0)");

    $imported = 0; $skipped = 0; $renamed = 0;
    foreach ($rows as $r) {
        $name = (string) ($r['name'] ?? '');
        if ($name === '') { $skipped++; continue; }

        $values = [];
        foreach ($map as $newCol => $oldCol) {
            $values[$newCol] = in_array($oldCol, $have, true) ? ($r[$oldCol] ?? null) : null;
        }

        $lookup->execute([$name, $ownerId]);
        $clash = $lookup->fetchAll();
        $importName = $name;
        if ($clash) {
            $identical = false;
            foreach ($clash as $c) {
                if (rows_match($c, $values)) { $identical = true; break; }
            }
            if ($identical) { $skipped++; continue; }
            $importName = mb_substr($name, 0, 170) . ' (imported)';
            // If even the suffixed name is taken, this has already been run.
            $lookup->execute([$importName, $ownerId]);
            if ($lookup->fetchAll()) { $skipped++; continue; }
            $renamed++;
        }
        $values['name'] = $importName;

        if (!$dryRun) {
            $params = [$ownerId];
            foreach ($map as $newCol => $_) {
                $params[] = $values[$newCol];
            }
            $ins->execute($params);
        }
        $imported++;
    }
    return ['skipped' => $skipped, 'imported' => $imported,
            'renamed' => $renamed, 'missing' => false];
}

/**
 * Do the values a 1.x row carries match the row already in MySQL?
 *
 * Numbers are compared as floats so 6 and 6.0 count as the same value, and
 * empty string and NULL are treated alike — SQLite was loose about both.
 */
function rows_match(array $existing, array $values): bool
{
    foreach ($values as $col => $v) {
        if ($col === 'name') {
            continue;
        }
        $e = $existing[$col] ?? null;
        if (($e === null || $e === '') && ($v === null || $v === '')) {
            continue;
        }
        if (is_numeric($e) && is_numeric($v)) {
            if (abs((float) $e - (float) $v) > 1e-9) {
                return false;
            }
            continue;
        }
        if ((string) $e !== (string) $v) {
            return false;
        }
    }
    return true;
}

$stats['bits'] = import_named($old, $db, 'bits', [
    'name'              => 'name',
    'diameter_mm'       => 'diameter_mm',
    'shank_diameter_mm' => 'shank_diameter_mm',
    'flute_count'       => 'flute_count',
    'cutting_length_mm' => 'cutting_length_mm',
    'type'              => 'type',
    'v_angle_deg'       => 'v_angle_deg',
    'notes'             => 'notes',
], $ownerId, $dryRun);

$stats['materials'] = import_named($old, $db, 'materials', [
    'name'                    => 'name',
    'thickness_mm'            => 'thickness_mm',
    'recommended_bit_type'    => 'recommended_bit_type',
    'recommended_rpm'         => 'recommended_rpm',
    'recommended_feed_cut'    => 'recommended_feed_cut',
    'recommended_feed_plunge' => 'recommended_feed_plunge',
    'recommended_doc_mm'      => 'recommended_doc_mm',
    'through_cut_overage_mm'  => 'through_cut_overage_mm',
    'notes'                   => 'notes',
], $ownerId, $dryRun);

/* ---- presets -------------------------------------------------------- */

/**
 * Presets carry bit_id / material_id, and those ids do not survive the move —
 * MySQL assigns its own. Rebind them by name instead, preferring a row the
 * target owner has and falling back to the built-in library.
 */
function resolve_ref(PDO $old, PDO $db, string $table, $oldId, int $ownerId): ?int
{
    if ($oldId === null || $oldId === '') {
        return null;
    }
    $s = $old->prepare("SELECT name FROM $table WHERE id = ?");
    $s->execute([(int) $oldId]);
    $name = $s->fetchColumn();
    if ($name === false) {
        return null;
    }
    $q = $db->prepare("SELECT id FROM $table WHERE name = ? AND owner_id IN (?, 0)
                       ORDER BY owner_id DESC LIMIT 1");
    $q->execute([$name, $ownerId]);
    $id = $q->fetchColumn();
    return $id === false ? null : (int) $id;
}

$presetStats = ['imported' => 0, 'skipped' => 0, 'renamed' => 0,
                'missing' => false, 'unbound' => 0];
if (!old_has_table($old, 'presets')) {
    $presetStats['missing'] = true;
} else {
    $lookup = $db->prepare('SELECT operation, settings_json FROM presets
                            WHERE name = ? AND owner_id IN (?, 0)');
    $ins = $db->prepare('INSERT INTO presets
        (owner_id,name,bit_id,material_id,operation,settings_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)');
    foreach ($old->query('SELECT * FROM presets')->fetchAll() as $p) {
        $name = (string) ($p['name'] ?? '');
        if ($name === '') { $presetStats['skipped']++; continue; }

        $operation = (string) ($p['operation'] ?? 'engrave');
        $settings  = (string) ($p['settings_json'] ?? '{}');

        // Same rule as bits and materials: an identical preset is seed data
        // that is already here, a differing one is the shop's own version and
        // comes in under a suffixed name rather than being dropped. The bit
        // and material ids are excluded from the comparison because they are
        // renumbered by the import.
        $lookup->execute([$name, $ownerId]);
        $importName = $name;
        $clash = $lookup->fetchAll();
        if ($clash) {
            $identical = false;
            foreach ($clash as $c) {
                if ((string) $c['operation'] === $operation
                    && json_decode((string) $c['settings_json'], true)
                       == json_decode($settings, true)) {
                    $identical = true;
                    break;
                }
            }
            if ($identical) { $presetStats['skipped']++; continue; }
            $importName = mb_substr($name, 0, 170) . ' (imported)';
            $lookup->execute([$importName, $ownerId]);
            if ($lookup->fetchAll()) { $presetStats['skipped']++; continue; }
            $presetStats['renamed']++;
        }

        $bitId = resolve_ref($old, $db, 'bits', $p['bit_id'] ?? null, $ownerId);
        $matId = resolve_ref($old, $db, 'materials', $p['material_id'] ?? null, $ownerId);
        if (($p['bit_id'] ?? null) !== null && $bitId === null) {
            $presetStats['unbound']++;
        }

        if (!$dryRun) {
            $now = time();
            $ins->execute([
                $ownerId, $importName, $bitId, $matId, $operation, $settings,
                (int) ($p['created_at'] ?? $now),
                (int) ($p['updated_at'] ?? $now),
            ]);
        }
        $presetStats['imported']++;
    }
}
$stats['presets'] = $presetStats;

/* ---- jobs ----------------------------------------------------------- */

$jobStats = ['imported' => 0, 'skipped' => 0, 'missing' => false];
if (!old_has_table($old, 'jobs')) {
    $jobStats['missing'] = true;
} elseif ($ownerId === 0) {
    // A saved gcode file belongs to whoever cut it; there is no sensible way
    // to attach one to the shared library.
    say('Skipping jobs: --owner=system has no account to attach them to.');
    $jobStats['missing'] = true;
} else {
    $ins = $db->prepare('INSERT INTO jobs
        (owner_id,filename,preset_id,svg_hash,gcode_path,settings_json,created_at)
        VALUES (?,?,?,?,?,?,?)');
    // jobs has no unique key, so re-running would otherwise stack duplicate
    // rows pointing at the same file. The stored filename is unique per job
    // (it is prefixed with the old row id), which makes it the natural key.
    $seen = $db->prepare('SELECT 1 FROM jobs WHERE owner_id = ? AND gcode_path = ?');
    foreach ($old->query('SELECT * FROM jobs')->fetchAll() as $j) {
        $path = (string) ($j['gcode_path'] ?? '');
        // A row whose file is already gone would only produce a 410 on
        // download, so leave it behind.
        if ($path === '' || !is_file(forge_data_dir() . '/jobs/' . basename($path))) {
            $jobStats['skipped']++;
            continue;
        }
        $seen->execute([$ownerId, $path]);
        if ($seen->fetchColumn()) {
            $jobStats['skipped']++;
            continue;
        }
        if (!$dryRun) {
            $ins->execute([
                $ownerId,
                (string) ($j['filename'] ?? 'job.gcode'),
                null,   // preset ids do not survive; the settings snapshot does
                (string) ($j['svg_hash'] ?? ''),
                $path,
                (string) ($j['settings_json'] ?? '{}'),
                (int) ($j['created_at'] ?? time()),
            ]);
        }
        $jobStats['imported']++;
    }
}
$stats['jobs'] = $jobStats;

/* ---- report --------------------------------------------------------- */

say('');
foreach ($stats as $table => $s) {
    if (!empty($s['missing'])) {
        say(sprintf('  %-10s not present in the old database — nothing to do', $table));
        continue;
    }
    say(sprintf('  %-10s %d imported, %d skipped (already present)',
        $table, $s['imported'], $s['skipped']));
    if (!empty($s['renamed'])) {
        say(sprintf('  %-10s %d of those differ from a built-in of the same name and '
            . 'came in as "... (imported)".', '', $s['renamed']));
    }
    // In a dry run nothing was written, so a preset pointing at a bit this
    // same run would have created cannot resolve. Saying it "lost" the
    // reference would send the operator hunting a problem that is not there.
    if (!empty($s['unbound']) && !$dryRun) {
        say(sprintf('  %-10s %d preset(s) lost their bit reference — the bit was not '
            . 'found by name. Re-pick the bit on those presets.', '', $s['unbound']));
    }
}
say('');
say($dryRun
    ? 'Dry run finished. Re-run without --dry-run to write these rows.'
    : 'Import finished. The SQLite file is untouched — keep it until you are '
      . 'satisfied, then delete data/forge.sqlite.');
