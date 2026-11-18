#!/usr/bin/env bash
# Run the Leaguepedia ingest one year at a time into .data/years/.
# Resumable: a year whose file already exists is skipped, and every HTTP response is
# cached under .data/leaguepedia/, so a re-run after a failure is mostly local.
set -u
cd "$(dirname "$0")/.."

FROM=${1:-2013}
TO=${2:-$(date +%Y)}

for (( y=FROM; y<=TO; y++ )); do
  out=".data/years/catalogue-$y.json"
  if [ -f "$out" ]; then
    echo "== $y already done, skipping"
    continue
  fi
  echo "== $y =============================================================="
  node scripts/ingest-leaguepedia.mjs --years "$y" --all-leagues --min-games 15 --out "$out" \
    || echo "!! $y produced nothing (no tournaments, or everything under the game floor)"
done

echo "== all years finished"
