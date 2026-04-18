#!/usr/bin/env bash
# Render every sample/*.puml twice:
#   build/png/<name>.expected.png — rendered from the source PUML via plantuml/plantuml
#   build/png/<name>.actual.png   — rendered from the catalyst-produced drawio via drawio-export
# Side-by-side comparison reveals what catalyst drops (Person, System_Ext, boundaries,
# 3-arg Rels, etc.). Required env vars set by the Makefile: PLANTUML_IMAGE,
# DRAWIO_EXPORT_IMAGE, DOCKER_IMAGE, DOCKER_TAG, ALPINE_IMAGE.
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
rm -rf build/png/actual
mkdir -p build/png/actual

UID_GID="$(id -u):$(id -g)"

# 1. Render source PUML → PNG (expected baseline)
docker run --rm --user "$UID_GID" -v "$PWD:/data" -w /data \
  "$PLANTUML_IMAGE" -tpng -o /data/build/png sample/*.puml

for puml in sample/*.puml; do
  name="$(basename "$puml" .puml)"
  mv "build/png/$name.png" "build/png/$name.expected.png"
done

# 2. Convert each PUML via the wrapper image. Running under the host UID/GID
#    (overrides the image's USER 10001) avoids having to chmod build/ world-
#    writable and keeps every produced .drawio host-owned from the start.
#    Catalyst (fork) emits a proper `<diagram id="..." name="...">` so no XML
#    patching is needed anymore.
for puml in sample/*.puml; do
  name="$(basename "$puml" .puml)"
  docker run --rm --user "$UID_GID" -v "$PWD:/work" -w /work \
    "$DOCKER_IMAGE:$DOCKER_TAG" "$puml" -o "build/$name.drawio"
done

# 3. Render drawio → PNG. drawio-export can't run with --user (electron needs
#    a writable HOME), so chown the output afterwards. Pass only *.drawio files
#    so container-owned PNGs from step 1 don't get fed back in.
mkdir -p build/drawio-stage
cp build/*.drawio build/drawio-stage/
docker run --rm -v "$PWD:/data" -w /data \
  "$DRAWIO_EXPORT_IMAGE" \
  --format png --output /data/build/png/actual --remove-page-suffix --border 20 \
  build/drawio-stage
rm -rf build/drawio-stage

docker run --rm -v "$PWD:/data" "$ALPINE_IMAGE" \
  chown -R "$UID_GID" /data/build/png

# 4. Flatten build/png/actual/<name>.png → build/png/<name>.actual.png
for f in build/png/actual/*.png; do
  [ -f "$f" ] || continue
  stem="$(basename "$f" .png)"
  mv "$f" "build/png/$stem.actual.png"
done
rmdir build/png/actual

echo
echo "Rendered side-by-side PNGs in build/png/:"
find build/png -maxdepth 1 -name '*.png' -print | sort
