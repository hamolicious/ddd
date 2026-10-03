#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
started=$SECONDS

step() {
  local name="$1"
  shift
  printf '\n\033[1m==> %s\033[0m\n' "$name"
  if ! "$@"; then
    printf '\n\033[1;31mfull-test failed at: %s\033[0m\n' "$name" >&2
    exit 1
  fi
}

in_dir() {
  local dir="$1"
  shift
  (cd "$repo/$dir" && "$@")
}

e2e_port="${DDD_E2E_PORT:-$((20000 + RANDOM % 20000))}"
e2e_db="${DDD_E2E_DB:-ddd_e2e_full_$$}"
collab_offset="${DDD_COLLAB_PORT_OFFSET:-$((10000 + RANDOM % 4000 * 10))}"

step "no comments or docstrings" node "$repo/scripts/check-comments.mjs"
step "mongo is up" docker compose -f "$repo/docker-compose.yaml" up -d --wait mongo

step "web: generated files" in_dir web npm run --silent check:generated
step "web: plugin graph" in_dir web npm run --silent check:plugins
step "web: typecheck" in_dir web npm run --silent typecheck
step "web: unit tests" in_dir web npx vitest run --bail=1
step "web: collab tests" in_dir web env DDD_COLLAB_PORT_OFFSET="$collab_offset" npx vitest run --config vitest.collab.config.ts --bail=1

step "rust: format" in_dir backend cargo fmt --all --check
step "rust: clippy" in_dir backend cargo clippy --workspace --all-targets -- -D warnings
step "rust: tests" in_dir backend cargo test --workspace --all-targets

step "flutter: dependencies" in_dir app flutter pub get
step "flutter: format" in_dir app dart format --output=none --set-exit-if-changed lib test
step "flutter: analyze" in_dir app flutter analyze
step "flutter: tests" in_dir app flutter test --fail-fast

step "build: server binary" in_dir backend cargo build --bin ddd
step "build: app and plugins" in_dir . mise run web-build
step "build: example plugins" in_dir web node scripts/build-examples.mjs
e2e_root="$repo/web/test-results/full-test-$$-build"
mkdir -p "$e2e_root"
trap 'rm -rf "$e2e_root"' EXIT
step "snapshot the build for the browser tests" cp -r "$repo/web/app/dist" "$e2e_root/dist"
step "compose the plugin registry" in_dir . node "$repo/web/scripts/compose-plugins.mjs" "$e2e_root/plugins" --include-examples=extra-task-states,search-probe
step "browser tests (port $e2e_port, database $e2e_db)" in_dir web env DDD_E2E_PORT="$e2e_port" DDD_E2E_DB="$e2e_db" \
  DDD_E2E_WEB_DIST="$e2e_root/dist" DDD_E2E_PLUGINS="$e2e_root/plugins" \
  npx playwright test --config playwright.app.config.ts --max-failures=1 --reporter=list --output "$repo/web/test-results/full-test-$$"

printf '\n\033[1;32mfull-test passed in %ss\033[0m\n' "$((SECONDS - started))"
