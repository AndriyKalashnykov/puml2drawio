#!/bin/sh
# Entrypoint for the GitHub Action wrapper. Translates INPUT_* env vars
# (auto-injected by GitHub Actions from action.yml inputs) into CLI args,
# skipping empty ones so defaults/env fallbacks in the CLI kick in.
set -eu

set --

[ -n "${INPUT_INPUT:-}" ] && set -- "$@" "${INPUT_INPUT}"
[ -n "${INPUT_OUTPUT:-}" ] && set -- "$@" --output "${INPUT_OUTPUT}"
[ -n "${INPUT_OUTPUT_EXT:-}" ] && set -- "$@" --output-ext "${INPUT_OUTPUT_EXT}"
[ -n "${INPUT_LAYOUT_DIRECTION:-}" ] && set -- "$@" --layout-direction "${INPUT_LAYOUT_DIRECTION}"
[ -n "${INPUT_NODESEP:-}" ] && set -- "$@" --nodesep "${INPUT_NODESEP}"
[ -n "${INPUT_EDGESEP:-}" ] && set -- "$@" --edgesep "${INPUT_EDGESEP}"
[ -n "${INPUT_RANKSEP:-}" ] && set -- "$@" --ranksep "${INPUT_RANKSEP}"
[ -n "${INPUT_MARGINX:-}" ] && set -- "$@" --marginx "${INPUT_MARGINX}"
[ -n "${INPUT_MARGINY:-}" ] && set -- "$@" --marginy "${INPUT_MARGINY}"
[ "${INPUT_FAIL_FAST:-false}" = "true" ] && set -- "$@" --fail-fast
[ "${INPUT_QUIET:-false}" = "true" ] && set -- "$@" --quiet

exec node /app/src/cli.mjs "$@"
