#!/usr/bin/env bash
# Clone localgod/catalyst at the SHA pinned in CATALYST_REF, build it,
# and leave dist/ + runtime node_modules under vendor/catalyst/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${SCRIPT_DIR}/.."
REPO="${CATALYST_REPO:-https://github.com/localgod/catalyst.git}"
REF_FILE="${ROOT}/CATALYST_REF"
REF="${CATALYST_REF:-$(tr -d '[:space:]' < "${REF_FILE}")}"
VENDOR="${ROOT}/vendor/catalyst"

if [[ -z "${REF}" ]]; then
  echo "error: CATALYST_REF is empty" >&2
  exit 1
fi

if [[ -d "${VENDOR}/.git" ]]; then
  current="$(git -C "${VENDOR}" rev-parse HEAD 2>/dev/null || echo '')"
  if [[ "${current}" == "${REF}" && -d "${VENDOR}/dist" ]]; then
    echo "catalyst already at ${REF} with dist/; skipping"
    exit 0
  fi
  echo "updating catalyst to ${REF}"
  git -C "${VENDOR}" fetch --quiet origin
  git -C "${VENDOR}" checkout --quiet "${REF}"
else
  rm -rf "${VENDOR}"
  mkdir -p "$(dirname "${VENDOR}")"
  echo "cloning ${REPO}"
  git clone --quiet "${REPO}" "${VENDOR}"
  git -C "${VENDOR}" checkout --quiet "${REF}"
fi

echo "building catalyst at ${REF}"
(
  cd "${VENDOR}"
  npm ci --silent
  # Upstream catalyst's build script is `tsc`, but typescript isn't declared
  # in its devDependencies (upstream bug). Install it transiently when
  # missing so the build works regardless. Pinned to TypeScript 5.x — catalyst's
  # tsconfig.json (moduleResolution=node10, implicit rootDir) is incompatible
  # with TS 7+ which raises rootDir and node10-deprecation errors. --no-save
  # keeps package-lock.json untouched, and npm prune afterwards trims it.
  if [ ! -x node_modules/.bin/tsc ]; then
    npm install --no-save --silent 'typescript@~5.7'
  fi
  # Upstream catalyst has pre-existing type errors (missing `dagre` namespace,
  # implicit any on node/edge params). TypeScript still emits dist/ by default
  # (noEmitOnError=false), so we accept tsc's non-zero exit and verify the
  # artefact was produced afterwards. Capture tsc output so it doesn't reach
  # the surrounding shell (the GitHub Actions tsc problem matcher would
  # otherwise turn every `error TSxxxx:` line into a red failure annotation).
  build_log=$(mktemp)
  npm run build --silent > "${build_log}" 2>&1 || true
  if [ ! -s dist/catalyst.mjs ]; then
    echo "error: catalyst build did not produce dist/catalyst.mjs" >&2
    cat "${build_log}" >&2
    rm -f "${build_log}"
    exit 1
  fi
  rm -f "${build_log}"
  # `npm prune --omit=dev` leaves residual transitive devDep trees in place
  # (observed: @babel/@vitest/@rolldown/oxlint remain even after prune,
  # shipping 5 HIGH CVEs into the runtime image). Wipe node_modules and
  # reinstall prod-only + --ignore-scripts for a clean runtime tree.
  rm -rf node_modules
  npm install --omit=dev --ignore-scripts --silent
)

echo "catalyst ready at ${VENDOR}/dist"
