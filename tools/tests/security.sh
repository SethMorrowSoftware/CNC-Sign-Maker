#!/usr/bin/env bash
#
# LowRider Forge — security tests.
#
# These check the properties the README's "Security & deployment hardening"
# section claims: cookie flags, that sessions are stored as hashes rather than
# replayable tokens, bcrypt password storage, that a hostile design name stays
# data, share-token entropy and opaque failures, expiry and revocation,
# disabled accounts losing access at once, password changes evicting other
# sessions, and that injection and traversal attempts are parameters and 404s.
#
# Needs: a running server, bash, curl, python3, and a MySQL client that can
# read the database directly (several assertions inspect stored rows).
#
# It expects two accounts to exist already: admin@example.com with the
# password "correct-horse-battery" and bob@example.com with
# "bobs-long-password". Create them by running tools/tests/api.sh first
# against the same empty database, or register them by hand.
#
#   FORGE_MYSQL='mysql -uroot forge' ./tools/tests/security.sh
#
set -u
BASE="${FORGE_BASE:-http://127.0.0.1:8088}/api/index.php"
SCR="$(mktemp -d)"
trap 'rm -rf "$SCR"' EXIT
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ok   $1"; else FAIL=$((FAIL+1)); echo "  FAIL $1: expected [$2] got [$3]"; fi; }
contains() { if grep -qi -- "$2" <<<"$3"; then PASS=$((PASS+1)); echo "  ok   $1"; else FAIL=$((FAIL+1)); echo "  FAIL $1: [$2] not found in [$(head -c 200 <<<"$3")]"; fi; }
notcontains() { if grep -qi -- "$2" <<<"$3"; then FAIL=$((FAIL+1)); echo "  FAIL $1: found [$2]"; else PASS=$((PASS+1)); echo "  ok   $1"; fi; }

A="$SCR/sec-a"; B="$SCR/sec-b"; N="$SCR/sec-n"
rm -f "$A" "$B" "$N"
jq() { python3 -c "import sys,json;d=json.load(sys.stdin)
v=d
for k in '$1'.split('.'):
  if k=='': continue
  v = v[int(k)] if isinstance(v,list) else (v.get(k) if isinstance(v,dict) else None)
  if v is None: break
print('' if v is None else (json.dumps(v) if isinstance(v,(dict,list)) else ('true' if v is True else 'false' if v is False else v)))"; }

# api.sh finishes by deliberately tripping the login throttle, so a run in the
# documented order would arrive here locked out of admin@example.com. Clear it.
${FORGE_MYSQL:-mariadb -uroot forge} -e "DELETE FROM auth_throttle" 2>/dev/null || {
  echo "Could not reach MySQL. Set FORGE_MYSQL, e.g." >&2
  echo "  FORGE_MYSQL='mysql -uroot forge' $0" >&2
  exit 1
}

echo "== 1. session cookie flags =="
echo '{"email":"admin@example.com","password":"correct-horse-battery"}' > "$SCR/l.json"
HDRS=$(curl -s -D - -o "$SCR/l.out" -c "$A" -X POST -H 'Content-Type: application/json' --data-binary "@$SCR/l.json" "$BASE?r=auth/login")
contains "cookie is HttpOnly" "HttpOnly" "$HDRS"
contains "cookie is SameSite=Lax" "SameSite=Lax" "$HDRS"
contains "cookie path is scoped" "path=/" "$HDRS"
contains "responses vary by cookie" "Vary: Cookie" "$HDRS"
contains "nosniff" "X-Content-Type-Options: nosniff" "$HDRS"
contains "no-store" "Cache-Control: no-store" "$HDRS"
CSRF=$(jq csrf < "$SCR/l.out")
# The raw session token must never appear in a response body.
RAWCOOKIE=$(awk '/forge_session/{print $7}' "$A")
BODY=$(cat "$SCR/l.out")
notcontains "session token absent from the body" "$RAWCOOKIE" "$BODY"

echo "== 2. the stored session is a hash, not the token =="
# Several sessions can share a created_at second, so look the row up by the
# value under test rather than by ordering.
EXPECT=$(printf '%s' "$RAWCOOKIE" | sha256sum | cut -d' ' -f1)
STORED=$(${FORGE_MYSQL:-mariadb -uroot forge} -N -e "SELECT token_hash FROM sessions WHERE token_hash='$EXPECT'")
check "stored value is a sha256 hex" "64" "${#STORED}"
check "the cookie's hash is the stored session key" "$EXPECT" "$STORED"
notcontains "raw token is not stored" "$RAWCOOKIE" "$(${FORGE_MYSQL:-mariadb -uroot forge} -N -e 'SELECT * FROM sessions')"

echo "== 3. password hashing =="
HASH=$(${FORGE_MYSQL:-mariadb -uroot forge} -N -e "SELECT password_hash FROM users WHERE email='admin@example.com'")
contains "bcrypt hash stored" '^\$2y\$' "$HASH"
notcontains "plaintext password absent" "correct-horse-battery" "$(${FORGE_MYSQL:-mariadb -uroot forge} -N -e 'SELECT * FROM users')"

echo "== 4. a design name is data, never markup =="
python3 - "$SCR/xss.json" <<'EOF'
import json, sys
json.dump({"name": "<img src=x onerror=alert(1)>\"'</script>",
           "input_mode": "text", "operation": "engrave",
           "settings": {"textContent": "X"}}, open(sys.argv[1], "w"))
EOF
R=$(curl -s -b "$A" -X POST -H 'Content-Type: application/json' -H "X-Forge-CSRF: $CSRF" \
     --data-binary "@$SCR/xss.json" "$BASE?r=designs")
XID=$(echo "$R" | jq id)
STORED_NAME=$(echo "$R" | jq name)
check "hostile name stored verbatim" '<img src=x onerror=alert(1)>"'"'"'</script>' "$STORED_NAME"
CT=$(curl -s -D - -o /dev/null -b "$A" "$BASE?r=designs" | grep -i '^content-type')
contains "list is served as JSON, not HTML" "application/json" "$CT"

echo "== 5. share tokens are unguessable and opaque on failure =="
R=$(curl -s -b "$A" -X POST -H 'Content-Type: application/json' -H "X-Forge-CSRF: $CSRF" -d '{}' \
     "$BASE?r=designs/$XID/shares")
TOK=$(echo "$R" | jq token)
check "43 chars of base64url" "43" "${#TOK}"
# 32 random bytes; two links must never collide or be sequential.
R2=$(curl -s -b "$A" -X POST -H 'Content-Type: application/json' -H "X-Forge-CSRF: $CSRF" -d '{}' \
     "$BASE?r=designs/$XID/shares")
TOK2=$(echo "$R2" | jq token)
if [ "$TOK" != "$TOK2" ]; then PASS=$((PASS+1)); echo "  ok   two links differ"; else FAIL=$((FAIL+1)); echo "  FAIL two links identical"; fi
UNKNOWN=$(curl -s "$BASE?r=shared/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
check "unknown token is a plain 404 message" "share_unavailable" "$(echo "$UNKNOWN" | jq code)"
RT=$(curl -s -D - -o /dev/null "$BASE?r=shared/$TOK")
contains "shared response asks not to be indexed" "X-Robots-Tag: noindex" "$RT"

echo "== 6. an expired share link is dead =="
SID=$(echo "$R" | jq id)
${FORGE_MYSQL:-mariadb -uroot forge} -e "UPDATE design_shares SET expires_at = UNIX_TIMESTAMP()-60 WHERE id = $SID"
check "expired link 404s" "404" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE?r=shared/$TOK")"
check "expired reason is opaque" "share_unavailable" "$(curl -s "$BASE?r=shared/$TOK" | jq code)"

echo "== 7. a disabled account loses access immediately =="
echo '{"email":"bob@example.com","password":"bobs-long-password"}' > "$SCR/b.json"
curl -s -c "$B" -X POST -H 'Content-Type: application/json' --data-binary "@$SCR/b.json" "$BASE?r=auth/login" > "$SCR/b.out"
check "bob signed in" "bob@example.com" "$(jq user.email < "$SCR/b.out")"
BOBID=$(${FORGE_MYSQL:-mariadb -uroot forge} -N -e "SELECT id FROM users WHERE email='bob@example.com'")
${FORGE_MYSQL:-mariadb -uroot forge} -e "UPDATE users SET disabled=1 WHERE id=$BOBID"
check "disabled account is rejected" "401" "$(curl -s -o /dev/null -w '%{http_code}' -b "$B" "$BASE?r=designs")"
check "disabled account cannot sign in" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data-binary "@$SCR/b.json" "$BASE?r=auth/login")"
check "every session of the disabled account is dropped" "0" "$(${FORGE_MYSQL:-mariadb -uroot forge} -N -e "SELECT COUNT(*) FROM sessions WHERE user_id=$BOBID")"
${FORGE_MYSQL:-mariadb -uroot forge} -e "UPDATE users SET disabled=0 WHERE id=$BOBID"

echo "== 8. changing a password evicts other sessions =="
curl -s -c "$B" -X POST -H 'Content-Type: application/json' --data-binary "@$SCR/b.json" "$BASE?r=auth/login" > "$SCR/b.out"
CSRFB=$(jq csrf < "$SCR/b.out")
cp "$B" "$SCR/sec-b2"     # a second device holding the same account
curl -s -c "$SCR/sec-b3" -X POST -H 'Content-Type: application/json' --data-binary "@$SCR/b.json" "$BASE?r=auth/login" > /dev/null
BEFORE=$(${FORGE_MYSQL:-mariadb -uroot forge} -N -e "SELECT COUNT(*) FROM sessions WHERE user_id=$BOBID")
if [ "$BEFORE" -ge 2 ]; then PASS=$((PASS+1)); echo "  ok   several sessions exist ($BEFORE)"; else FAIL=$((FAIL+1)); echo "  FAIL expected >=2 sessions, got $BEFORE"; fi
curl -s -b "$B" -X POST -H 'Content-Type: application/json' -H "X-Forge-CSRF: $CSRFB" \
  -d '{"current_password":"bobs-long-password","new_password":"bobs-newer-password"}' "$BASE?r=auth/password" >/dev/null
check "other sessions evicted" "1" "$(${FORGE_MYSQL:-mariadb -uroot forge} -N -e "SELECT COUNT(*) FROM sessions WHERE user_id=$BOBID")"
check "the evicted device is signed out" "401" "$(curl -s -o /dev/null -w '%{http_code}' -b "$SCR/sec-b3" "$BASE?r=designs")"

echo "== 9. SQL injection attempts are parameters, not code =="
INJ='designs/1%20OR%201=1'
check "a malformed id is a 404, not a listing" "404" "$(curl -s -o /dev/null -w '%{http_code}' -b "$B" "$BASE?r=$INJ")"
python3 - "$SCR/inj.json" <<'EOF'
import json, sys
json.dump({"name": "'; DROP TABLE designs; --", "input_mode": "text",
           "operation": "engrave", "settings": {}}, open(sys.argv[1], "w"))
EOF
CSRFB=$(curl -s -b "$B" "$BASE?r=auth/me" | jq csrf)
curl -s -b "$B" -X POST -H 'Content-Type: application/json' -H "X-Forge-CSRF: $CSRFB" \
  --data-binary "@$SCR/inj.json" "$BASE?r=designs" >/dev/null
check "designs table still exists" "1" "$(${FORGE_MYSQL:-mariadb -uroot forge} -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='forge' AND table_name='designs'")"
check "the string was stored as data" "1" "$(${FORGE_MYSQL:-mariadb -uroot forge} -N -e "SELECT COUNT(*) FROM designs WHERE name = \"'; DROP TABLE designs; --\"")"

echo "== 10. path traversal on a job download =="
check "a traversal path is a 404, not a listing" "404" "$(curl -s -o /dev/null -w '%{http_code}' -b "$A" "$BASE?r=jobs/../../../etc/passwd")"
check "traversal via action" "404" "$(curl -s -o /dev/null -w '%{http_code}' -b "$A" "$BASE?r=../../etc/passwd")"

echo "== 11. logout really ends the session =="
CSRFA=$(curl -s -b "$A" "$BASE?r=auth/me" | jq csrf)
curl -s -b "$A" -X POST -H "X-Forge-CSRF: $CSRFA" -H 'Content-Type: application/json' -d '{}' "$BASE?r=auth/logout" >/dev/null
check "session gone after logout" "401" "$(curl -s -o /dev/null -w '%{http_code}' -b "$A" "$BASE?r=designs")"

echo "== 12. an unknown email is not distinguishable by timing =="
# The nonexistent-account path must verify against a dummy hash generated with
# the live PASSWORD_DEFAULT. A hard-coded literal pins the bcrypt cost (PHP 8.4
# moved it to 12) and makes this path several times faster, which enumerates
# accounts one request at a time.
${FORGE_MYSQL:-mariadb -uroot forge} -e "DELETE FROM auth_throttle" 2>/dev/null
echo '{"email":"nobody-at-all@example.com","password":"wrong-password-here"}' > "$SCR/unknown.json"
echo '{"email":"admin@example.com","password":"wrong-password-here"}' > "$SCR/known.json"
# Warm up: the first unknown-email attempt in a worker also generates the dummy.
curl -s -o /dev/null "$BASE?r=auth/login" -X POST -H 'Content-Type: application/json' --data-binary "@$SCR/unknown.json"
timed() {
  local total=0 t
  for _ in 1 2 3; do
    t=$(curl -s -o /dev/null -w '%{time_total}' "$BASE?r=auth/login" \
        -X POST -H 'Content-Type: application/json' --data-binary "@$1")
    total=$(python3 -c "print($total + $t)")
  done
  python3 -c "print($total / 3)"
}
T_KNOWN=$(timed "$SCR/known.json")
T_UNKNOWN=$(timed "$SCR/unknown.json")
RATIO=$(python3 -c "print(round(max($T_KNOWN,$T_UNKNOWN) / max(min($T_KNOWN,$T_UNKNOWN), 1e-6), 2))")
if python3 -c "import sys; sys.exit(0 if $RATIO < 1.5 else 1)"; then
  PASS=$((PASS+1)); echo "  ok   known and unknown emails take similar time (ratio ${RATIO}x)"
else
  FAIL=$((FAIL+1)); echo "  FAIL timing leaks account existence: known ${T_KNOWN}s vs unknown ${T_UNKNOWN}s (${RATIO}x)"
fi
${FORGE_MYSQL:-mariadb -uroot forge} -e "DELETE FROM auth_throttle" 2>/dev/null

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
