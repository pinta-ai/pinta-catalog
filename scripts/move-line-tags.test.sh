#!/usr/bin/env bash
# Exercise scripts/move-line-tags.mjs against a throwaway repo.
#
# The three branches that matter cannot be reached from the live catalog (it has
# never had a schema bump or an index floor), so they are built here instead.
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/move-line-tags.mjs"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
git init -q .
git config user.email t@t.t
git config user.name t

mkindex() { mkdir -p catalog; printf '%s\n' "$1" > catalog/index.json; }
commit() { git add -A; git commit -q -m "$1"; }

pass=0; fail=0
check() { # check <label> <expected-substring> <actual>
  if grep -q "$2" <<<"$3"; then echo "  ok    $1"; pass=$((pass+1));
  else echo "  FAIL  $1"; echo "        want: $2"; echo "        got:  $3"; fail=$((fail+1)); fi
}

echo "== a stale line tag is advanced =="
mkindex '{"schema_version":1,"generated":"2026-01-01T00:00:00Z","adaptors":[]}'
commit old
git tag manager-v0.1.7
git tag manager-v0.1.9
mkindex '{"schema_version":1,"generated":"2026-06-01T00:00:00Z","adaptors":[]}'
commit new
git tag manager-v0.1.10
out=$(bun "$SCRIPT" --target HEAD)
check "0.1.7 moves"  "would move .*manager-v0.1.7" "$out"
check "0.1.9 moves"  "manager-v0.1.9" "$out"
check "0.1.10 is already there" "manager-v0.1.10  (already at target)" "$out"

echo "== a schema bump parks every older line =="
mkindex '{"schema_version":2,"generated":"2026-07-01T00:00:00Z","adaptors":[]}'
commit bump
out=$(bun "$SCRIPT" --target HEAD)
check "0.1.7 parked"  "manager-v0.1.7  (schema_version 1 -> 2" "$out"
check "0.1.9 parked"  "manager-v0.1.9  (schema_version 1 -> 2" "$out"
check "0.1.10 parked" "manager-v0.1.10  (schema_version 1 -> 2" "$out"
check "nothing moves" "^skipped" "$out"
if grep -q "would move" <<<"$out"; then echo "  FAIL  a bump moved something"; fail=$((fail+1)); else echo "  ok    a bump moved nothing"; pass=$((pass+1)); fi

echo "== a line already past the bump keeps tracking =="
git tag manager-v0.2.0
mkindex '{"schema_version":2,"generated":"2026-08-01T00:00:00Z","adaptors":[]}'
commit post-bump
out=$(bun "$SCRIPT" --target HEAD)
check "0.2.0 moves"    "would move .*manager-v0.2.0" "$out"
check "0.1.9 still parked" "manager-v0.1.9  (schema_version" "$out"

echo "== an index floor parks the lines below it =="
mkindex '{"schema_version":2,"minimumRequiredManagerVersion":"0.2.0","generated":"2026-09-01T00:00:00Z","adaptors":[]}'
commit floor
out=$(bun "$SCRIPT" --target HEAD)
check "0.2.0 is at or above the floor" "would move .*manager-v0.2.0" "$out"
check "0.1.9 below the floor" "manager-v0.1.9  (index declares minimumRequiredManagerVersion 0.2.0)" "$out"

echo "== --apply actually moves, and only what it said =="
before=$(git rev-list -n1 manager-v0.2.0)
bun "$SCRIPT" --target HEAD --apply >/dev/null 2>&1 || true
after=$(git rev-list -n1 manager-v0.2.0)
head=$(git rev-parse HEAD)
[ "$after" = "$head" ] && { echo "  ok    0.2.0 landed on HEAD"; pass=$((pass+1)); } || { echo "  FAIL  0.2.0 did not land ($before -> $after)"; fail=$((fail+1)); }
parked=$(git rev-list -n1 manager-v0.1.9)
[ "$parked" != "$head" ] && { echo "  ok    0.1.9 stayed parked"; pass=$((pass+1)); } || { echo "  FAIL  0.1.9 was moved"; fail=$((fail+1)); }

echo
echo "pass $pass  fail $fail"
[ "$fail" -eq 0 ]
