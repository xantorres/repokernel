#!/usr/bin/env bash
set -euo pipefail

run_baseline() {
  set +e
  "$@"
  status=$?
  set -e
  if [ "$status" -ne 0 ] && [ "$status" -ne 1 ]; then
    exit "$status"
  fi
}

mkdir -p fallow-baselines

run_baseline fallow dead-code --save-baseline fallow-baselines/dead-code.json
run_baseline fallow health --save-baseline fallow-baselines/health.json
run_baseline fallow dupes --save-baseline fallow-baselines/dupes.json

biome format --write \
  fallow-baselines/dead-code.json \
  fallow-baselines/health.json \
  fallow-baselines/dupes.json

node scripts/check-fallow-baseline-drift.mjs \
  --base "${FALLOW_BASELINE_DIR:-fallow-baselines}" \
  --head fallow-baselines
