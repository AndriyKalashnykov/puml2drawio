#!/usr/bin/env bash
# Test scripts/action-entrypoint.sh by stubbing `node` to echo its argv,
# then asserting the expected arg vector for various INPUT_* permutations.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTRYPOINT="${ROOT}/scripts/action-entrypoint.sh"

TMPDIR_=$(mktemp -d)
trap 'rm -rf "${TMPDIR_}"' EXIT

# Stub `node`: prints each argv entry on its own line.
mkdir -p "${TMPDIR_}/bin"
cat > "${TMPDIR_}/bin/node" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@"
EOF
chmod +x "${TMPDIR_}/bin/node"

STUB_PATH="${TMPDIR_}/bin:${PATH}"

PASS=0
FAIL=0

# Invoke the entrypoint with the given env var assignments and compare its
# newline-joined argv output to the expected single-line value.
assert_args() {
    local desc="$1"; shift
    local expected="$1"; shift
    local actual
    actual=$(env -i PATH="${STUB_PATH}" "$@" bash "${ENTRYPOINT}" 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')
    if [ "${actual}" = "${expected}" ]; then
        echo "PASS: ${desc}"
        PASS=$((PASS + 1))
    else
        echo "FAIL: ${desc}"
        echo "  expected: ${expected}"
        echo "  actual:   ${actual}"
        FAIL=$((FAIL + 1))
    fi
}

assert_args "no INPUT_* vars: only cli.mjs, no flags" \
    "/app/src/cli.mjs"

assert_args "INPUT_INPUT only" \
    "/app/src/cli.mjs diagram.puml" \
    INPUT_INPUT=diagram.puml

assert_args "input + output" \
    "/app/src/cli.mjs diagram.puml --output out.drawio" \
    INPUT_INPUT=diagram.puml INPUT_OUTPUT=out.drawio

# GitHub's container-action runtime injects HYPHENATED input ids
# (`layout-direction` -> INPUT_LAYOUT-DIRECTION, NOT _underscore_).
# These cases use the REAL names — they are exactly what would have
# caught the skip-unsupported bug. An underscore-fallback case follows.
assert_args "input + layout flags (hyphenated env, real GitHub form)" \
    "/app/src/cli.mjs diagram.puml --layout-direction LR --nodesep 80" \
    INPUT_INPUT=diagram.puml 'INPUT_LAYOUT-DIRECTION=LR' INPUT_NODESEP=80

assert_args "fail-fast=true emits --fail-fast (hyphenated env)" \
    "/app/src/cli.mjs diagram.puml --fail-fast" \
    INPUT_INPUT=diagram.puml 'INPUT_FAIL-FAST=true'

assert_args "fail-fast=false emits no flag (hyphenated env)" \
    "/app/src/cli.mjs diagram.puml" \
    INPUT_INPUT=diagram.puml 'INPUT_FAIL-FAST=false'

assert_args "skip-unsupported=true emits --skip-unsupported (hyphenated env — the bug that shipped)" \
    "/app/src/cli.mjs diagram.puml --skip-unsupported" \
    INPUT_INPUT=diagram.puml 'INPUT_SKIP-UNSUPPORTED=true'

assert_args "skip-unsupported=false emits no flag" \
    "/app/src/cli.mjs diagram.puml" \
    INPUT_INPUT=diagram.puml 'INPUT_SKIP-UNSUPPORTED=false'

assert_args "exclude forwards --exclude (INPUT_EXCLUDE, no hyphen)" \
    "/app/src/cli.mjs docs --exclude sequence-*.puml" \
    INPUT_INPUT=docs 'INPUT_EXCLUDE=sequence-*.puml'

assert_args "underscore form still works (defensive fallback)" \
    "/app/src/cli.mjs diagram.puml --fail-fast" \
    INPUT_INPUT=diagram.puml INPUT_FAIL_FAST=true

assert_args "empty-string INPUT_OUTPUT / output-ext are skipped" \
    "/app/src/cli.mjs diagram.puml" \
    INPUT_INPUT=diagram.puml INPUT_OUTPUT= 'INPUT_OUTPUT-EXT='

assert_args "summary=true emits --summary" \
    "/app/src/cli.mjs diagram.puml --summary" \
    INPUT_INPUT=diagram.puml INPUT_SUMMARY=true

assert_args "summary=false emits no flag" \
    "/app/src/cli.mjs diagram.puml" \
    INPUT_INPUT=diagram.puml INPUT_SUMMARY=false

assert_args "all flags set (hyphenated env for hyphenated ids)" \
    "/app/src/cli.mjs diagram.puml --output out.drawio --output-ext .xml --layout-direction TB --nodesep 50 --edgesep 10 --ranksep 50 --marginx 20 --marginy 20 --fail-fast --exclude seq-*.puml --skip-unsupported --quiet --summary" \
    INPUT_INPUT=diagram.puml \
    INPUT_OUTPUT=out.drawio \
    'INPUT_OUTPUT-EXT=.xml' \
    'INPUT_LAYOUT-DIRECTION=TB' \
    INPUT_NODESEP=50 \
    INPUT_EDGESEP=10 \
    INPUT_RANKSEP=50 \
    INPUT_MARGINX=20 \
    INPUT_MARGINY=20 \
    'INPUT_FAIL-FAST=true' \
    'INPUT_EXCLUDE=seq-*.puml' \
    'INPUT_SKIP-UNSUPPORTED=true' \
    INPUT_QUIET=true \
    INPUT_SUMMARY=true

assert_args "stdin mode with - positional" \
    "/app/src/cli.mjs -" \
    INPUT_INPUT=-

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
