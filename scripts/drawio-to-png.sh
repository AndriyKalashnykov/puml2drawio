#!/usr/bin/env bash
# Convert drawio file(s) to PNG via rlespinasse/drawio-export.
#
# Input is a single path (file or directory) — drawio-export recurses
# directories looking for *.drawio. Output lands in $OUTPUT_DIR/<stem>.png
# (with the --remove-page-suffix flag so single-page diagrams don't get a
# `-Page-1` suffix appended).
#
# Required env:
#   DRAWIO_EXPORT_IMAGE  pinned drawio-export Docker image (e.g. rlespinasse/drawio-export:v4.48.0)
#   ALPINE_IMAGE         pinned alpine image used for post-run chown
#   INPUT                file or directory path (relative to $PWD) containing .drawio sources
#   OUTPUT_DIR           directory (relative to $PWD) to write *.png into
#
# Why this script exists separately from the inline plantuml path:
# drawio-export runs Electron and needs a writable HOME. Passing `--user`
# on the docker invocation breaks electron-store initialisation, so we let
# the container run as root and chown the output back afterwards via a
# minimal alpine helper.
set -euo pipefail

: "${DRAWIO_EXPORT_IMAGE:?missing}"
: "${ALPINE_IMAGE:?missing}"
: "${INPUT:?missing}"
: "${OUTPUT_DIR:?missing}"

if [ ! -e "$INPUT" ]; then
  echo "drawio-to-png: input path not found: $INPUT" >&2
  exit 1
fi

UID_GID="$(id -u):$(id -g)"
mkdir -p "$OUTPUT_DIR"

# drawio-export walks a directory for *.drawio. Given a single file input,
# stage it into a temp dir so the tool can still run in directory mode (its
# single-file invocation has subtly different output-path semantics).
STAGE="$(mktemp -d -p build drawio-stage.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

if [ -d "$INPUT" ]; then
  find "$INPUT" -maxdepth 1 -name '*.drawio' -print0 | xargs -0 -I{} cp {} "$STAGE/"
else
  cp "$INPUT" "$STAGE/"
fi

if ! find "$STAGE" -maxdepth 1 -name '*.drawio' -print -quit | grep -q .; then
  echo "drawio-to-png: no .drawio files found under $INPUT" >&2
  exit 1
fi

docker run --rm -v "$PWD:/data" -w /data \
  "$DRAWIO_EXPORT_IMAGE" \
  --format png --output "/data/$OUTPUT_DIR" --remove-page-suffix --border 20 \
  "$STAGE"

docker run --rm -v "$PWD:/data" "$ALPINE_IMAGE" \
  chown -R "$UID_GID" "/data/$OUTPUT_DIR"

# drawio-export emits `<stem>.png`; rename to `<stem>.drawio.png` so
# PUML-sourced PNGs for the same stem don't clobber these. Only touch
# stems whose source .drawio file we actually staged — never anything
# pre-existing in the output directory.
for drawio in "$STAGE"/*.drawio; do
  [ -f "$drawio" ] || continue
  stem="$(basename "$drawio" .drawio)"
  src="$OUTPUT_DIR/$stem.png"
  dst="$OUTPUT_DIR/$stem.drawio.png"
  if [ -f "$src" ]; then
    mv "$src" "$dst"
  fi
done

echo
echo "Rendered drawio → PNG in $OUTPUT_DIR/:"
find "$OUTPUT_DIR" -maxdepth 1 -name '*.drawio.png' -print | sort
