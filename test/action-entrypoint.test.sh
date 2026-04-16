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

assert_args "input + layout flags" \
    "/app/src/cli.mjs diagram.puml --layout-direction LR --nodesep 80" \
    INPUT_INPUT=diagram.puml INPUT_LAYOUT_DIRECTION=LR INPUT_NODESEP=80

assert_args "fail-fast=true emits --fail-fast" \
    "/app/src/cli.mjs diagram.puml --fail-fast" \
    INPUT_INPUT=diagram.puml INPUT_FAIL_FAST=true

assert_args "fail-fast=false emits no flag" \
    "/app/src/cli.mjs diagram.puml" \
    INPUT_INPUT=diagram.puml INPUT_FAIL_FAST=false

assert_args "empty-string INPUT_OUTPUT / OUTPUT_EXT are skipped" \
    "/app/src/cli.mjs diagram.puml" \
    INPUT_INPUT=diagram.puml INPUT_OUTPUT= INPUT_OUTPUT_EXT=

assert_args "all flags set" \
    "/app/src/cli.mjs diagram.puml --output out.drawio --output-ext .xml --layout-direction TB --nodesep 50 --edgesep 10 --ranksep 50 --marginx 20 --marginy 20 --fail-fast --quiet" \
    INPUT_INPUT=diagram.puml \
    INPUT_OUTPUT=out.drawio \
    INPUT_OUTPUT_EXT=.xml \
    INPUT_LAYOUT_DIRECTION=TB \
    INPUT_NODESEP=50 \
    INPUT_EDGESEP=10 \
    INPUT_RANKSEP=50 \
    INPUT_MARGINX=20 \
    INPUT_MARGINY=20 \
    INPUT_FAIL_FAST=true \
    INPUT_QUIET=true

assert_args "stdin mode with - positional" \
    "/app/src/cli.mjs -" \
    INPUT_INPUT=-

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
