#!/usr/bin/env bash
# Convert PUML file(s) to PNG via plantuml/plantuml.
#
# INPUT may be a single .puml file or a directory (all *.puml under it,
# non-recursive). Output lands in $OUTPUT_DIR/<stem>.puml.png — the
# `.puml.png` suffix distinguishes these from drawio-sourced PNGs that
# scripts/drawio-to-png.sh produces for the same stem.
#
# Required env:
#   PLANTUML_IMAGE  pinned plantuml/plantuml Docker image (e.g. plantuml/plantuml:1.2026.2)
#   INPUT           file or directory path (relative to $PWD) containing .puml sources
#   OUTPUT_DIR      directory (relative to $PWD) to write *.puml.png into
set -euo pipefail

: "${PLANTUML_IMAGE:?missing}"
: "${INPUT:?missing}"
: "${OUTPUT_DIR:?missing}"

if [ ! -e "$INPUT" ]; then
  echo "puml-to-png: input path not found: $INPUT" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
UID_GID="$(id -u):$(id -g)"

# Collect the concrete list of .puml paths so later renames know exactly
# which outputs to expect. Supports both `file.puml` and `dir/` inputs.
declare -a PUML_FILES=()
if [ -d "$INPUT" ]; then
  while IFS= read -r -d '' f; do PUML_FILES+=("$f"); done \
    < <(find "$INPUT" -maxdepth 1 -name '*.puml' -print0 | sort -z)
else
  PUML_FILES=("$INPUT")
fi

if [ ${#PUML_FILES[@]} -eq 0 ]; then
  echo "puml-to-png: no .puml files found under $INPUT" >&2
  exit 1
fi

# `-e JAVA_TOOL_OPTIONS=-Duser.home=/tmp`: the container runs as
# `--user $UID:$GID`, a UID with no /etc/passwd entry. OpenJDK's getpwuid()
# then fails and the `user.home` system property falls back to the literal
# string "?", so the JVM font-info cache (`${user.home}/.java/fonts/...`)
# is written to a `?/` dir in the bind-mounted repo root. Java derives
# `user.home` from getpwuid, NOT from $HOME, so `-e HOME=/tmp` does NOT
# fix this (empirically verified — it still littered). Overriding
# `-Duser.home=/tmp` via JAVA_TOOL_OPTIONS is the mechanism the JVM honours;
# /tmp is world-writable (1777) so the cache lands there, ephemeral and
# unmounted. Verified: `./?` gone, PNG renders identically (230x519).
docker run --rm --user "$UID_GID" -e JAVA_TOOL_OPTIONS=-Duser.home=/tmp \
  -v "$PWD:/data" -w /data \
  "$PLANTUML_IMAGE" -tpng -o "/data/$OUTPUT_DIR" "${PUML_FILES[@]}"

# plantuml emits `<stem>.png`; rename to `<stem>.puml.png` so drawio-sourced
# PNGs for the same stem don't clobber these.
for puml in "${PUML_FILES[@]}"; do
  stem="$(basename "$puml" .puml)"
  src="$OUTPUT_DIR/$stem.png"
  dst="$OUTPUT_DIR/$stem.puml.png"
  if [ -f "$src" ]; then
    mv "$src" "$dst"
  fi
done

echo
echo "Rendered PUML → PNG in $OUTPUT_DIR/:"
find "$OUTPUT_DIR" -maxdepth 1 -name '*.puml.png' -print | sort
