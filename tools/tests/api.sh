#!/usr/bin/env bash
#
# LowRider Forge — API, ownership and sharing tests.
#
# These exercise the multi-tenancy rules end to end: that one account cannot
# read, edit, delete or share another's designs, presets, bits or saved jobs;
# that the built-in library forks instead of being edited in place; that
# invites are single-use; and that share links can be minted, copied and
# revoked. Run them after any change to api/ before trusting the isolation.
#
# Needs: a running server, an EMPTY database (it registers the first account,
# which becomes the admin), bash, curl and python3.
#
#   mysql -e 'DROP DATABASE forge; CREATE DATABASE forge'
#   php -S localhost:8088 router.php &
#   ./tools/tests/api.sh
#
# Override the target with FORGE_BASE=https://example.com/forge
#
set -u
BASE="${FORGE_BASE:-http://127.0.0.1:8088}/api/index.php"
SCR="$(mktemp -d)"
trap 'rm -rf "$SCR"' EXIT
PASS=0; FAIL=0

j() { python3 -c "import sys,json
d=json.load(sys.stdin)
v=d
for k in '$1'.split('.'):
  if k=='': continue
  if isinstance(v,list):
    v=v[int(k)] if k.lstrip('-').isdigit() else None
  elif isinstance(v,dict): v=v.get(k)
  else: v=None
  if v is None: break
print('' if v is None else (json.dumps(v) if isinstance(v,(dict,list)) else ('true' if v is True else 'false' if v is False else v)))"; }

check() { # name expected actual
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ok   $1"; else FAIL=$((FAIL+1)); echo "  FAIL $1: expected [$2] got [$3]"; fi
}
checkne() {
  if [ "$2" != "$3" ]; then PASS=$((PASS+1)); echo "  ok   $1"; else FAIL=$((FAIL+1)); echo "  FAIL $1: did not expect [$3]"; fi
}

# api METHOD ROUTE COOKIEJAR CSRF [BODYFILE]  -> prints "STATUS\n<body>"
api() {
  local m="$1" r="$2" jar="$3" csrf="$4" body="${5:-}"
  local args=(-s -w '\n%{http_code}' -X "$m" -b "$jar" -c "$jar" -H 'Accept: application/json')
  [ -n "$csrf" ] && args+=(-H "X-Forge-CSRF: $csrf")
  if [ -n "$body" ]; then args+=(-H 'Content-Type: application/json' --data-binary "@$body"); fi
  curl "${args[@]}" "$BASE?r=$r"
}
status() { tail -1 <<<"$1"; }
bodyof() { sed '$d' <<<"$1"; }

A="$SCR/jar-a"; B="$SCR/jar-b"; N="$SCR/jar-anon"
rm -f "$A" "$B" "$N"

echo "== 1. bootstrap: first registration becomes admin =="
cat > "$SCR/reg.json" <<'EOF'
{"email":"admin@example.com","password":"correct-horse-battery","display_name":"Admin"}
EOF
R=$(api POST auth/register "$A" "" "$SCR/reg.json")
check "register status" "201" "$(status "$R")"
check "role is admin" "admin" "$(bodyof "$R" | j user.role)"
check "bootstrap flag" "true" "$(bodyof "$R" | j bootstrap)"
CSRF_A=$(bodyof "$R" | j csrf)
checkne "csrf issued" "" "$CSRF_A"

echo "== 2. second anonymous registration is refused (invite-only) =="
cat > "$SCR/reg2.json" <<'EOF'
{"email":"bob@example.com","password":"another-long-password","display_name":"Bob"}
EOF
R=$(api POST auth/register "$B" "" "$SCR/reg2.json")
check "no-invite register blocked" "403" "$(status "$R")"
check "invite_required code" "invite_required" "$(bodyof "$R" | j code)"

echo "== 3. CSRF is enforced on writes =="
cat > "$SCR/d1.json" <<'EOF'
{"name":"Shop sign","input_mode":"text","operation":"engrave","settings":{"textContent":"OPEN","fontKey":"montserrat","signWidth":300}}
EOF
R=$(api POST designs "$A" "" "$SCR/d1.json")
check "missing CSRF rejected" "403" "$(status "$R")"
check "csrf code" "csrf" "$(bodyof "$R" | j code)"
R=$(api POST designs "$A" "not-the-token" "$SCR/d1.json")
check "wrong CSRF rejected" "403" "$(status "$R")"

echo "== 4. create a design with an SVG asset =="
python3 - "$SCR/d2.json" <<'EOF'
import base64, json, sys
svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 100 50"><rect x="5" y="5" width="90" height="40"/></svg>'
json.dump({
  "name": "Plate cutout",
  "input_mode": "svg",
  "operation": "profile-out",
  "settings": {"finalDepth": -7, "docPerPass": 3, "graphics": []},
  "svg_hash": "abc123",
  "notes": "A test plate",
  "assets": {"svg": {"filename": "plate.svg", "mime": "image/svg+xml",
                     "data_base64": base64.b64encode(svg.encode()).decode()}}
}, open(sys.argv[1], "w"))
EOF
R=$(api POST designs "$A" "$CSRF_A" "$SCR/d2.json")
check "create design" "201" "$(status "$R")"
D1=$(bodyof "$R" | j id)
check "asset round-trips" "$(python3 -c "import base64;print(base64.b64encode(b'<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100mm\" height=\"50mm\" viewBox=\"0 0 100 50\"><rect x=\"5\" y=\"5\" width=\"90\" height=\"40\"/></svg>').decode())")" "$(bodyof "$R" | j assets.svg.data_base64)"

R=$(api POST designs "$A" "$CSRF_A" "$SCR/d1.json")
check "create second design" "201" "$(status "$R")"
D2=$(bodyof "$R" | j id)

echo "== 5. duplicate name gets suffixed, not rejected =="
R=$(api POST designs "$A" "$CSRF_A" "$SCR/d1.json")
check "dup name status" "201" "$(status "$R")"
check "dup name suffixed" "Shop sign (2)" "$(bodyof "$R" | j name)"
D3=$(bodyof "$R" | j id)

echo "== 6. list designs =="
R=$(api GET designs "$A" "")
check "list count" "3" "$(bodyof "$R" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')"
check "list omits blobs" "" "$(bodyof "$R" | j 0.assets)"

echo "== 7. update with unchanged asset keeps the artwork =="
cat > "$SCR/d2u.json" <<'EOF'
{"name":"Plate cutout v2","input_mode":"svg","operation":"profile-out","settings":{"finalDepth":-8},"assets":{"svg":{"unchanged":true}}}
EOF
R=$(api PUT "designs/$D1" "$A" "$CSRF_A" "$SCR/d2u.json")
check "update status" "200" "$(status "$R")"
check "renamed" "Plate cutout v2" "$(bodyof "$R" | j name)"
checkne "artwork retained" "" "$(bodyof "$R" | j assets.svg.data_base64)"

echo "== 8. omitting the assets key preserves artwork; an empty object clears it =="
cat > "$SCR/d2keep.json" <<'EOF'
{"name":"Plate cutout v3"}
EOF
R=$(api PUT "designs/$D1" "$A" "$CSRF_A" "$SCR/d2keep.json")
check "partial save renames" "Plate cutout v3" "$(bodyof "$R" | j name)"
checkne "partial save keeps artwork" "" "$(bodyof "$R" | j assets.svg.data_base64)"
check "partial save keeps settings" "-8" "$(bodyof "$R" | j settings.finalDepth)"
check "partial save keeps input_mode" "svg" "$(bodyof "$R" | j input_mode)"
cat > "$SCR/d2n.json" <<'EOF'
{"name":"Plate cutout v3","input_mode":"text","operation":"engrave","settings":{},"assets":{}}
EOF
R=$(api PUT "designs/$D1" "$A" "$CSRF_A" "$SCR/d2n.json")
check "explicit empty assets drops artwork" "" "$(bodyof "$R" | j assets.svg)"

echo "== 9. share link =="
echo '{"expires_days":0}' > "$SCR/share.json"
R=$(api POST "designs/$D2/shares" "$A" "$CSRF_A" "$SCR/share.json")
check "share created" "201" "$(status "$R")"
TOKEN=$(bodyof "$R" | j token)
SHARE_ID=$(bodyof "$R" | j id)
check "token length" "43" "${#TOKEN}"

R=$(api GET "shared/$TOKEN" "$N" "")
check "anonymous share read" "200" "$(status "$R")"
check "share is read_only" "true" "$(bodyof "$R" | j read_only)"
check "owner display name" "Admin" "$(bodyof "$R" | j owner_name)"
check "no owner email leak" "" "$(bodyof "$R" | j owner_email)"
check "no owner_id leak" "" "$(bodyof "$R" | j owner_id)"

echo "== 10. invite a second user =="
echo '{"email":"bob@example.com","note":"shop floor"}' > "$SCR/inv.json"
R=$(api POST invites "$A" "$CSRF_A" "$SCR/inv.json")
check "invite created" "201" "$(status "$R")"
INV=$(bodyof "$R" | j token)
R=$(api GET "invites/check&token=$INV" "$N" "")
check "invite check valid" "true" "$(bodyof "$R" | j valid)"

python3 - "$SCR/reg3.json" "$INV" <<'EOF'
import json, sys
json.dump({"email":"bob@example.com","password":"bobs-long-password","display_name":"Bob","invite":sys.argv[2]}, open(sys.argv[1],"w"))
EOF
R=$(api POST auth/register "$B" "" "$SCR/reg3.json")
check "invited register" "201" "$(status "$R")"
check "invited role" "user" "$(bodyof "$R" | j user.role)"
CSRF_B=$(bodyof "$R" | j csrf)

echo "== 11. the invite is single-use =="
R=$(api POST auth/register "$N" "" "$SCR/reg3.json")
check "reused invite blocked" "403" "$(status "$R")"

echo "== 12. ownership isolation =="
R=$(api GET designs "$B" "")
check "bob sees no designs" "0" "$(bodyof "$R" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')"
R=$(api GET "designs/$D2" "$B" "")
check "bob cannot read alice design" "404" "$(status "$R")"
R=$(api DELETE "designs/$D2" "$B" "$CSRF_B")
check "bob cannot delete alice design" "404" "$(status "$R")"
R=$(api PUT "designs/$D2" "$B" "$CSRF_B" "$SCR/d1.json")
check "bob cannot update alice design" "404" "$(status "$R")"
R=$(api GET "designs/$D2/shares" "$B" "")
check "bob cannot list alice shares" "404" "$(status "$R")"
R=$(api DELETE "shares/$SHARE_ID" "$B" "$CSRF_B")
check "bob cannot revoke alice share" "404" "$(status "$R")"

echo "== 13. save a copy of a shared design =="
echo '{}' > "$SCR/empty.json"
R=$(api POST "shared/$TOKEN/copy" "$B" "$CSRF_B" "$SCR/empty.json")
check "bob copies shared design" "201" "$(status "$R")"
check "copy named" "Shop sign (copy)" "$(bodyof "$R" | j name)"
BOBD=$(bodyof "$R" | j id)
R=$(api GET designs "$B" "")
check "bob now has one design" "1" "$(bodyof "$R" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')"
R=$(api POST "shared/$TOKEN/copy" "$N" "" "$SCR/empty.json")
check "anonymous copy needs auth" "401" "$(status "$R")"

echo "== 14. same design name across users does not collide =="
R=$(api POST designs "$B" "$CSRF_B" "$SCR/d1.json")
check "bob can use alice's design name" "201" "$(status "$R")"
check "bob's name not suffixed" "Shop sign" "$(bodyof "$R" | j name)"

echo "== 15. revoking a share kills the link =="
R=$(api DELETE "shares/$SHARE_ID" "$A" "$CSRF_A")
check "revoke ok" "true" "$(bodyof "$R" | j revoked)"
R=$(api GET "shared/$TOKEN" "$N" "")
check "revoked link 404" "404" "$(status "$R")"
check "revoked reason opaque" "share_unavailable" "$(bodyof "$R" | j code)"
R=$(api GET "shared/thistokendoesnotexistatallreally" "$N" "")
check "unknown token same code" "share_unavailable" "$(bodyof "$R" | j code)"

echo "== 16. built-in library is read-only and forks on edit =="
R=$(api GET bits "$A" "")
BITID=$(bodyof "$R" | j 0.id)
check "seed bit is builtin" "true" "$(bodyof "$R" | j 0.builtin)"
check "seed bit not editable" "false" "$(bodyof "$R" | j 0.editable)"
SEEDCOUNT=$(bodyof "$R" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')
check "19 seeded bits" "19" "$SEEDCOUNT"

cat > "$SCR/bit.json" <<'EOF'
{"name":"1/16\" 2-flute upcut (fine detail)","diameter_mm":1.5875,"flute_count":2,"type":"upcut","cutting_length_mm":7.5}
EOF
R=$(api PUT "bits/$BITID" "$A" "$CSRF_A" "$SCR/bit.json")
check "editing a builtin forks" "201" "$(status "$R")"
check "fork records origin" "$BITID" "$(bodyof "$R" | j forked_from)"
check "fork is editable" "true" "$(bodyof "$R" | j editable)"
FORKID=$(bodyof "$R" | j id)
R=$(api GET "bits/$BITID" "$A" "")
check "original untouched" "6" "$(bodyof "$R" | j cutting_length_mm)"
R=$(api DELETE "bits/$BITID" "$A" "$CSRF_A")
check "cannot delete a builtin" "403" "$(status "$R")"
R=$(api GET bits "$B" "")
check "bob does not see alice's fork" "19" "$(bodyof "$R" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')"
R=$(api PUT "bits/$FORKID" "$B" "$CSRF_B" "$SCR/bit.json")
check "bob cannot edit alice's bit" "404" "$(status "$R")"

echo "== 17. presets are per-account (the old upsert-by-name bug) =="
cat > "$SCR/preset.json" <<'EOF'
{"name":"My preset","operation":"engrave","settings":{"finalDepth":-3}}
EOF
R=$(api POST presets "$A" "$CSRF_A" "$SCR/preset.json")
check "alice preset" "201" "$(status "$R")"
APID=$(bodyof "$R" | j id)
cat > "$SCR/preset2.json" <<'EOF'
{"name":"My preset","operation":"pocket","settings":{"finalDepth":-9}}
EOF
R=$(api POST presets "$B" "$CSRF_B" "$SCR/preset2.json")
check "bob preset same name" "201" "$(status "$R")"
BPID=$(bodyof "$R" | j id)
checkne "distinct preset rows" "$APID" "$BPID"
R=$(api GET "presets/$APID" "$A" "")
check "alice preset unchanged" "-3" "$(bodyof "$R" | j settings.finalDepth)"
R=$(api DELETE "presets/$APID" "$B" "$CSRF_B")
check "bob cannot delete alice preset" "404" "$(status "$R")"

echo "== 18. anonymous use still works =="
R=$(api GET bits "$N" "")
check "anon can read bits" "200" "$(status "$R")"
R=$(api GET materials "$N" "")
check "anon can read materials" "200" "$(status "$R")"
R=$(api GET presets "$N" "")
check "anon sees only builtin presets" "4" "$(bodyof "$R" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')"
R=$(api GET designs "$N" "")
check "anon designs needs auth" "401" "$(status "$R")"
R=$(api POST presets "$N" "" "$SCR/preset.json")
check "anon cannot write presets" "401" "$(status "$R")"
R=$(api POST jobs/save "$N" "" "$SCR/preset.json")
check "anon cannot save jobs" "401" "$(status "$R")"

echo "== 19. admin endpoints are admin-only =="
R=$(api GET invites "$B" "")
check "bob cannot list invites" "403" "$(status "$R")"
R=$(api GET users "$B" "")
check "bob cannot list users" "403" "$(status "$R")"
R=$(api GET users "$A" "")
check "admin lists users" "200" "$(status "$R")"
check "user list has 2" "2" "$(bodyof "$R" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')"
check "no password hash leak" "" "$(bodyof "$R" | j 0.password_hash)"
echo '{"disabled":true}' > "$SCR/dis.json"
R=$(api PUT "users/1" "$A" "$CSRF_A" "$SCR/dis.json")
check "admin cannot disable self" "400" "$(status "$R")"

echo "== 20. jobs are owner-scoped =="
python3 - "$SCR/job.json" "$D2" <<'EOF'
import json, sys
json.dump({"filename":"test.gcode","gcode":"G21\nG90\nM5\n","settings":{"a":1},"svg_hash":"x","design_id":int(sys.argv[2])}, open(sys.argv[1],"w"))
EOF
R=$(api POST jobs/save "$A" "$CSRF_A" "$SCR/job.json")
check "alice saves job" "201" "$(status "$R")"
JID=$(bodyof "$R" | j id)
R=$(api GET "jobs/$JID" "$B" "")
check "bob cannot download alice job" "404" "$(status "$R")"
R=$(api GET jobs "$B" "")
check "bob job list empty" "0" "$(bodyof "$R" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')"
R=$(curl -s -w '\n%{http_code}' -b "$A" "$BASE?r=jobs/$JID")
check "alice downloads job" "200" "$(status "$R")"
check "gcode content" "G21" "$(bodyof "$R" | head -1)"

echo "== 21. login, logout, throttle =="
echo '{"email":"admin@example.com","password":"wrong-password-here"}' > "$SCR/bad.json"
for i in $(seq 1 8); do api POST auth/login "$N" "" "$SCR/bad.json" >/dev/null; done
R=$(api POST auth/login "$N" "" "$SCR/bad.json")
check "throttled after 8 failures" "429" "$(status "$R")"
check "throttle code" "throttled" "$(bodyof "$R" | j code)"

echo '{"email":"bob@example.com","password":"bobs-long-password"}' > "$SCR/good.json"
R=$(api POST auth/login "$B" "" "$SCR/good.json")
check "bob can log in" "200" "$(status "$R")"
CSRF_B=$(bodyof "$R" | j csrf)
R=$(api POST auth/logout "$B" "$CSRF_B" "$SCR/empty.json")
check "logout ok" "200" "$(status "$R")"
R=$(api GET designs "$B" "")
check "logged out is anonymous" "401" "$(status "$R")"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
