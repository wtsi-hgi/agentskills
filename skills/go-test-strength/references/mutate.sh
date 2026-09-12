#!/usr/bin/env bash
#
# One mutant against one package: apply, build, test, restore.
#
#   mutate.sh <workdir> <pkg> <file> <old.txt> <new.txt> <label>
#
# <old.txt> holds the exact source text to replace and <new.txt> its
# replacement. Both are matched literally, so Go punctuation cannot be mangled
# by a pattern. The target file — and any testdata/ fixtures, which a mutant
# running in update mode can rewrite — are always restored, including on failure.
#
# Prints "<VERDICT>  <label>":
#
#   KILLED    the suite failed, so the tests defend that behaviour
#   SURVIVED  the suite passed, so triage this one for equivalence
#   INVALID   the text did not match uniquely, or the mutant did not compile,
#             so the run produced no evidence at all. Never count it as
#             SURVIVED: fix the mutant and rerun.

set -u

if [ $# -ne 6 ]; then
    sed -n '3,6p' "$0" >&2
    exit 2
fi

work=$1 pkg=$2 file=$3 oldfile=$4 newfile=$5 label=$6
target="$work/$pkg/$file"

command -v python3 >/dev/null 2>&1 || {
    echo "mutate.sh needs python3 for literal replacement" >&2
    exit 2
}

[ -f "$target" ] || { echo "no such file: $target" >&2; exit 2; }

backup=$(mktemp)
cp "$target" "$backup"
# Snapshot testdata/ too: a mutant that runs tests in update mode rewrites the
# package's golden fixtures, and later mutants must not run against poisoned
# state. rm -rf + re-copy (not in-place restore) so files a mutant deleted come back.
tdata=""
if [ -d "$work/$pkg/testdata" ]; then
    tdata=$(mktemp -d)
    cp -R "$work/$pkg/testdata/." "$tdata/"
fi
trap 'cp "$backup" "$target"; rm -f "$backup"
      if [ -n "$tdata" ]; then
          rm -rf "$work/$pkg/testdata" && cp -R "$tdata/." "$work/$pkg/testdata/"
          rm -rf "$tdata"
      fi' EXIT

verdict() { printf '%-9s %s\n' "$1" "$label"; exit 0; }

python3 - "$target" "$oldfile" "$newfile" <<'PY' || verdict INVALID
import sys

target, oldfile, newfile = sys.argv[1:4]
src = open(target).read()
old = open(oldfile).read()

if src.count(old) != 1:
    sys.stderr.write("pattern occurs %d times, need exactly 1\n" % src.count(old))
    sys.exit(1)

open(target, "w").write(src.replace(old, open(newfile).read()))
PY

# -run '^$' compiles the package and its tests without running any, so a
# mutant that breaks compilation is separated from one the tests caught.
(cd "$work" && go test ./"$pkg"/ -run '^$' -count=1 >/dev/null 2>&1) || verdict INVALID

if (cd "$work" && go test ./"$pkg"/ -count=1 -timeout 120s >/dev/null 2>&1); then
    verdict SURVIVED
fi

verdict KILLED
