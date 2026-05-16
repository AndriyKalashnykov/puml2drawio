#!/bin/sh
# Entrypoint for the GitHub Action wrapper. Translates action inputs into
# CLI args, skipping empty ones so CLI defaults / env fallbacks kick in.
#
# IMPORTANT: GitHub's *container* action runtime injects each input id as
# `INPUT_<UPPERCASE>` with HYPHENS PRESERVED (only spaces become `_`). So
# `skip-unsupported` -> `INPUT_SKIP-UNSUPPORTED`, NOT `INPUT_SKIP_UNSUPPORTED`.
# Those names are not valid shell identifiers, so they must be read via
# `printenv`, not `${INPUT_...}`. The previous version read the underscore
# form and silently dropped every hyphenated input (output-ext,
# layout-direction, fail-fast, skip-unsupported) — latent until a consumer
# set one to a non-default value.
set -eu

# Read an action input by its action.yml id. Prefer GitHub's real
# hyphenated env name; fall back to the underscore form (defensive, and
# what local/unit invocations may use).
input() {
  _hy="INPUT_$(printf '%s' "$1" | tr '[:lower:]-' '[:upper:]-')"
  _un="INPUT_$(printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_')"
  _v="$(printenv "$_hy" 2>/dev/null || true)"
  if [ -n "$_v" ]; then
    printf '%s' "$_v"
  else
    printenv "$_un" 2>/dev/null || true
  fi
}

set --

[ -n "$(input input)" ] && set -- "$@" "$(input input)"
[ -n "$(input output)" ] && set -- "$@" --output "$(input output)"
[ -n "$(input output-ext)" ] && set -- "$@" --output-ext "$(input output-ext)"
[ -n "$(input layout-direction)" ] && set -- "$@" --layout-direction "$(input layout-direction)"
[ -n "$(input nodesep)" ] && set -- "$@" --nodesep "$(input nodesep)"
[ -n "$(input edgesep)" ] && set -- "$@" --edgesep "$(input edgesep)"
[ -n "$(input ranksep)" ] && set -- "$@" --ranksep "$(input ranksep)"
[ -n "$(input marginx)" ] && set -- "$@" --marginx "$(input marginx)"
[ -n "$(input marginy)" ] && set -- "$@" --marginy "$(input marginy)"
[ -n "$(input theme)" ] && set -- "$@" --theme "$(input theme)"
[ "$(input fail-fast)" = "true" ] && set -- "$@" --fail-fast
[ -n "$(input exclude)" ] && set -- "$@" --exclude "$(input exclude)"
[ "$(input skip-unsupported)" = "true" ] && set -- "$@" --skip-unsupported
[ "$(input quiet)" = "true" ] && set -- "$@" --quiet
[ "$(input summary)" = "true" ] && set -- "$@" --summary

exec node /app/src/cli.mjs "$@"
