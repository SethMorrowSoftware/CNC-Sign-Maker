#!/usr/bin/env bash
# LowRider Forge — installer.
# Checks the PHP environment, creates the data directory, and creates the
# MySQL schema and starter library from the credentials in api/config.php.
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

if ! php -m | grep -qi pdo_mysql; then
  echo "ERROR: the PHP pdo_mysql extension is required." >&2
  echo "       In cPanel: 'Select PHP Version' -> Extensions -> tick pdo_mysql." >&2
  exit 1
fi

# 2. Credentials
if [ ! -f api/config.php ]; then
  cp api/config.sample.php api/config.php
  chmod 640 api/config.php 2>/dev/null || true
  echo
  echo "Created api/config.php from the sample."
  echo "Edit it now with your MySQL database name, user and password, then"
  echo "re-run ./install.sh. In cPanel, create both under 'MySQL Databases'"
  echo "and remember that cPanel prefixes them with your account name."
  exit 0
fi

# 3. Data directory — saved gcode files still live on disk.
mkdir -p data/jobs
chmod 775 data data/jobs 2>/dev/null || true
echo "Data directory ready: $(pwd)/data"

# 4. Schema + starter library. forge_db() creates every table if missing and
#    seeds the bit/material/preset library, so this is safe to re-run.
php -r 'define("FORGE_APP",true); require "api/db.php";
        $db = forge_db();
        $n = fn($t) => (int) $db->query("SELECT COUNT(*) FROM $t")->fetchColumn();
        printf("Database ready: %d bits, %d materials, %d presets, %d account(s).\n",
               $n("bits"), $n("materials"), $n("presets"), $n("users"));'

echo
echo "Install complete. Start a local server from this directory with:"
echo "    php -S localhost:8000 router.php"
echo "then open http://localhost:8000"
echo
echo "The first person to register becomes the administrator; everyone else"
echo "joins through an invite link created from the account menu. To create"
echo "the admin from here instead:"
echo "    php tools/create-admin.php --email=you@example.com --password='...'"
echo
echo "Upgrading from a 1.x install with a data/forge.sqlite database?"
echo "    php tools/migrate-sqlite-to-mysql.php --owner=you@example.com --dry-run"
