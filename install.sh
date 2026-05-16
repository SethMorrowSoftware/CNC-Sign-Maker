#!/usr/bin/env bash
# LowRider Forge — installer.
# Creates the data directory, sets permissions and seeds the SQLite database.
set -e
cd "$(dirname "$0")"

echo "LowRider Forge — install"
echo "------------------------"

# 1. PHP check
if ! command -v php >/dev/null 2>&1; then
  echo "ERROR: php is not installed or not on PATH (PHP 8.1+ required)." >&2
  exit 1
fi
PHP_VER=$(php -r 'echo PHP_VERSION;')
echo "PHP version: $PHP_VER"

if ! php -m | grep -qi pdo_sqlite; then
  echo "ERROR: the PHP pdo_sqlite extension is required." >&2
  exit 1
fi

# 2. Data directory
mkdir -p data/jobs
chmod -R 775 data 2>/dev/null || true
echo "Data directory ready: $(pwd)/data"

# 3. Seed the database
php -r 'define("FORGE_APP",true); require "api/db.php"; forge_db();
        echo "Database seeded: ".forge_data_dir()."/forge.sqlite\n";'

echo
echo "Install complete. Start a local server from this directory with:"
echo "    php -S localhost:8000"
echo "then open http://localhost:8000"
