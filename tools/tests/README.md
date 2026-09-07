# Test suites

Optional developer tooling. The app itself still needs no build step and no
package manager — nothing here is required to run or deploy LowRider Forge, and
deleting this directory changes nothing.

They exist because v2.0 turned a single-operator tool into a multi-user one,
and the properties that keeps — that one account cannot reach another's
designs, that the shared library cannot be edited out from under everybody,
that a revoked share link is really dead — are not visible by reading a diff.

| Suite | What it covers | Needs |
|---|---|---|
| `api.sh` | Accounts, invites, designs, artwork round-trips, share links, ownership isolation across two accounts, the built-in-library fork rule | bash, curl, python3, a running server, an **empty** database |
| `security.sh` | Cookie flags, session hashing, password storage, stored-XSS input, share-token entropy and revocation, disabled accounts, injection and traversal | the above plus a MySQL client that can read the database |

## Running them

Both start from an empty database, because `api.sh` registers the first
account and that account becomes the administrator.

```bash
mysql -uroot -e 'DROP DATABASE IF EXISTS forge; CREATE DATABASE forge'
php -S localhost:8088 router.php &
./tools/tests/api.sh                                   # 89 checks
FORGE_MYSQL='mysql -uroot forge' ./tools/tests/security.sh   # 33 checks
```

`api.sh` leaves behind the two accounts `security.sh` expects, so run them in
that order against the same database.

Point either at another install with `FORGE_BASE=https://example.com/forge` —
but note that both write real data, so never aim them at an install you care
about.

## Not included

The browser-level tests written alongside this change — anonymous use, the
sign-up flow, artwork and uploaded fonts surviving a save/reload, and a share
link opening read-only in a second browser profile — need Playwright, and
therefore npm. That would contradict the project's no-package-manager rule, so
they are not shipped here.

The one thing they cover that these suites cannot is worth knowing about: a
design that uses an **uploaded font** must emit byte-identical gcode after a
save, a page reload and a reopen. That is the assertion that caught the font
cache returning the previously loaded face. If you touch font loading or design
restore, verify it by hand: upload a font, save the design, reload the page,
reopen it, and diff the generated gcode.
