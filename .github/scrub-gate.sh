#!/usr/bin/env bash
# scrub-gate.sh — no personal/infra strings in the tree.
#
# HARD: strings that may never appear anywhere.
# SOFT: the bare author handle is allowed only in LICENSE, README.md,
#       package.json, and github.com/<handle>/ URLs.
#
# Usage:  bash .github/scrub-gate.sh      Exit: 0 = clean, 1 = hits found.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail=0

HARD='178\.104\.140\.96|wiklob\.dev|linear\.app/wiklob|com\.wiklob\.claude|/Users/wiklob|minter_recoil|Wiktor|carteblanche|cbapp'
hits="$(grep -RInE "$HARD" . --exclude-dir=.git --exclude=scrub-gate.sh 2>/dev/null || true)"
if [ -n "$hits" ]; then
  echo "HARD hits (never allowed):"
  printf '%s\n' "$hits"
  fail=1
fi

soft="$(grep -RInE '\bwiklob\b' . --exclude-dir=.git --exclude=scrub-gate.sh 2>/dev/null \
  | grep -v 'github\.com/wiklob/' \
  | grep -vE '^\./(LICENSE|README\.md|package\.json):' || true)"
if [ -n "$soft" ]; then
  echo "SOFT hits (bare handle outside LICENSE/README/package.json/github URLs):"
  printf '%s\n' "$soft"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "FAIL: scrub gate found personal strings."
  exit 1
fi
echo "PASS: scrub gate clean."
exit 0
