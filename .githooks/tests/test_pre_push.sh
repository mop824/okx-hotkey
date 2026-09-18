#!/usr/bin/env bash
# Test the .githooks/pre-push guard against crafted stdin, in throwaway repos.
# Usage: bash .githooks/tests/test_pre_push.sh <repo-relative published path>
# e.g.   bash .githooks/tests/test_pre_push.sh dist/config.js
set -u

test_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)
hooks_dir=$(CDPATH= cd -- "$test_dir/.." && pwd -P)
repo_root=$(CDPATH= cd -- "$hooks_dir/.." && pwd -P)
hook=$hooks_dir/pre-push

if [ $# -lt 1 ]; then
  echo "usage: bash .githooks/tests/test_pre_push.sh <repo-relative published path>" 1>&2
  exit 1
fi
fixture=$repo_root/$1
if [ ! -f "$fixture" ]; then
  echo "test_pre_push.sh: fixture '$1' does not exist in the repo at $repo_root" 1>&2
  exit 1
fi

if [ -n "${SPARK_SCRATCH_DIR:-}" ]; then TMPDIR=$SPARK_SCRATCH_DIR; export TMPDIR; fi
work=$(mktemp -d) || exit 1
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT

zero=$(git hash-object --stdin </dev/null)   # empty-blob hash: its length is this repo's hash length
zeros() { printf '0%.0s' $(seq 1 "$1"); }
Zrepo=$(zeros "${#zero}")                    # all-zeros object id, as git sends it for delete / new branch
if [ "${#zero}" -eq 40 ]; then Zother=$(zeros 64); else Zother=$(zeros 40); fi

passed=0
failures=0

new_repo() {
  git init -q "$1"
}

commit_all() {
  local dir=$1
  git -C "$dir" -c user.name=t -c user.email=t@example.invalid add -A || return 1
  git -C "$dir" -c user.name=t -c user.email=t@example.invalid commit -q --no-gpg-sign -F - <<'MSG' || return 1
test
MSG
  git -C "$dir" rev-parse HEAD
}

# The hook is invoked exactly as git invokes it: stdin ref lines, cwd = repo top level.
expect_status() {
  local desc=$1 want=$2 stdin_text=$3 dir=$4 out got
  out=$(cd "$dir" && printf '%s' "$stdin_text" | "$hook" origin testurl 2>&1)
  got=$?
  if [ "$got" -eq "$want" ]; then
    passed=$((passed + 1))
    printf 'PASS %s\n' "$desc"
  else
    failures=$((failures + 1))
    printf 'FAIL %s: expected exit %s, got %s; output:\n%s\n' "$desc" "$want" "$got" "$out" 1>&2
    printf 'passed=%d failed=%d\n' "$passed" "$failures"
    exit 1
  fi
}

expect_output_contains() {
  local desc=$1 needle=$2 stdin_text=$3 dir=$4
  if (cd "$dir" && printf '%s' "$stdin_text" | "$hook" origin testurl 2>&1) | grep -F -q -- "$needle"; then
    passed=$((passed + 1))
    printf 'PASS %s\n' "$desc"
  else
    failures=$((failures + 1))
    printf 'FAIL %s: output did not name %s\n' "$desc" "$needle" 1>&2
    printf 'passed=%d failed=%d\n' "$passed" "$failures"
    exit 1
  fi
}

setup_fail() { echo 'test setup failed' 1>&2; exit 1; }

# 1. dist-only update push against a real published path: must not false-block
r=$work/dist-only; new_repo "$r"
mkdir -p "$r/$(dirname "$1")" && cp "$fixture" "$r/$1"
base=$(commit_all "$r") || setup_fail
echo x > "$r/dist/new-build.js"
head=$(commit_all "$r") || setup_fail
expect_status "dist-only update push passes" 0 "$head $head $head $base
" "$r"

# 2. new branch carrying only the real published path passes
expect_status "new branch with published path passes" 0 "$base $base $base $Zrepo
" "$r"

# 3. new branch (remote zero) whose single commit adds src/foo.js is refused
r=$work/src-add; new_repo "$r"
mkdir -p "$r/src" && echo x > "$r/src/foo.js"
head=$(commit_all "$r") || setup_fail
expect_status "push adding src/foo.js is refused" 1 "$head $head $head $Zrepo
" "$r"
expect_output_contains "src/foo.js refusal names the path" "src/foo.js" "$head $head $head $Zrepo
" "$r"

# 4. update commit adding server/x.js is refused and named
r=$work/server-add; new_repo "$r"
mkdir -p "$r/dist" && echo x > "$r/dist/a.js"
base=$(commit_all "$r") || setup_fail
mkdir -p "$r/server" && echo x > "$r/server/x.js"
head=$(commit_all "$r") || setup_fail
expect_status "push adding server/x.js is refused" 1 "$head $head $head $base
" "$r"
expect_output_contains "server/x.js refusal names the path" "server/x.js" "$head $head $head $base
" "$r"

# 5. branch delete (local sha zero) passes
r=$work/delete; new_repo "$r"
echo x > "$r/README.md"
head=$(commit_all "$r") || setup_fail
expect_status "branch delete passes" 0 "$Zrepo $Zrepo $head $head
" "$r"
expect_status "branch delete passes (other hash length zeros)" 0 "$Zother $Zother $head $head
" "$r"

# 6. new branch with a mixed commit range (dist commit + src commit) is refused
r=$work/mixed; new_repo "$r"
mkdir -p "$r/dist" && echo x > "$r/dist/a.js"
commit_all "$r" >/dev/null || setup_fail
mkdir -p "$r/src" && echo x > "$r/src/leak.js"
head=$(commit_all "$r") || setup_fail
expect_status "new-branch mixed range is refused" 1 "$head $head $head $Zrepo
" "$r"
expect_output_contains "mixed refusal names src/leak.js" "src/leak.js" "$head $head $head $Zrepo
" "$r"

# 7. empty commit range exits 0
r=$work/empty; new_repo "$r"
mkdir -p "$r/dist" && echo x > "$r/dist/a.js"
head=$(commit_all "$r") || setup_fail
expect_status "empty range exits 0" 0 "$head $head $head $head
" "$r"

# 8. every allowlist entry passes, including a dist path containing spaces
r=$work/allow; new_repo "$r"
mkdir -p "$r/dist" "$r/.github/workflows" "$r/.githooks"
cp "$fixture" "$r/$1"
echo x > "$r/dist/file with spaces.js"
echo x > "$r/README.md"
echo x > "$r/release-notes-v9.9.9.md"
echo x > "$r/.gitignore"
echo x > "$r/.github/workflows/ci.yml"
echo x > "$r/.githooks/placeholder"
head=$(commit_all "$r") || setup_fail
expect_status "all allowlist paths pass" 0 "$head $head $head $Zrepo
" "$r"

# 9. a path with spaces outside the allowlist is refused and named verbatim
r=$work/space-out; new_repo "$r"
mkdir -p "$r/src" && echo x > "$r/src/a b.js"
head=$(commit_all "$r") || setup_fail
expect_status "src/a b.js is refused" 1 "$head $head $head $Zrepo
" "$r"
expect_output_contains "spaces-in-path refusal names it" "src/a b.js" "$head $head $head $Zrepo
" "$r"

# 10. empty stdin (no refs to push) exits 0
expect_status "empty stdin exits 0" 0 "" "$repo_root"

printf 'passed=%d failed=0\n' "$passed"
exit 0
