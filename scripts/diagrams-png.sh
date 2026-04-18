#!/usr/bin/env bash
# Render every sample/*.puml twice so each diagram has a side-by-side pair
# in build/png/:
#   <name>.puml.png    — rendered from the source PUML via plantuml/plantuml
#   <name>.drawio.png  — rendered from the catalyst-produced drawio via drawio-export
# The source-extension suffix makes the origin of each PNG obvious and
# prevents collisions when the same stem is rendered from both formats.
#
# Required env vars set by the Makefile: PLANTUML_IMAGE, DRAWIO_EXPORT_IMAGE,
# DOCKER_IMAGE, DOCKER_TAG, ALPINE_IMAGE.
set -euo pipefail

: "${PLANTUML_IMAGE:?missing}"
: "${DRAWIO_EXPORT_IMAGE:?missing}"
: "${DOCKER_IMAGE:?missing}"
: "${DOCKER_TAG:?missing}"
: "${ALPINE_IMAGE:?missing}"

if ! ls sample/*.puml >/dev/null 2>&1; then
  echo "No sample/*.puml files found." >&2
  exit 1
fi

mkdir -p build build/png

UID_GID="$(id -u):$(id -g)"

# 1. Render source PUML → PNG (delegates to puml-to-png.sh so the rename +
#    `.puml.png` suffix are produced in one place).
INPUT=sample \
OUTPUT_DIR=build/png \
PLANTUML_IMAGE="$PLANTUML_IMAGE" \
bash scripts/puml-to-png.sh >/dev/null

# 2. Convert each PUML via the wrapper image. Running under the host UID/GID
#    (overrides the image's USER 10001) keeps every produced .drawio host-
#    owned from the start. Catalyst (fork) emits a proper
#    `<diagram id="..." name="...">` so no XML patching is needed.
for puml in sample/*.puml; do
  name="$(basename "$puml" .puml)"
  docker run --rm --user "$UID_GID" -v "$PWD:/work" -w /work \
    "$DOCKER_IMAGE:$DOCKER_TAG" "$puml" -o "build/$name.drawio"
done

# 3. Render drawio → PNG (delegates to drawio-to-png.sh; it applies the
#    `.drawio.png` suffix and handles the chown dance).
INPUT=build \
OUTPUT_DIR=build/png \
DRAWIO_EXPORT_IMAGE="$DRAWIO_EXPORT_IMAGE" \
ALPINE_IMAGE="$ALPINE_IMAGE" \
bash scripts/drawio-to-png.sh >/dev/null

echo
echo "Rendered side-by-side PNGs in build/png/:"
find build/png -maxdepth 1 -name '*.png' -print | sort
