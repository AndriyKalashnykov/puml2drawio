# syntax=docker/dockerfile:1.26@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
ARG NODE_VERSION=24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

FROM node:${NODE_VERSION} AS catalyst-builder
RUN apk add --no-cache git
# Canonical catalyst source.
ARG CATALYST_REPO=https://github.com/AndriyKalashnykov/catalyst.git
ARG CATALYST_REF
WORKDIR /build
RUN test -n "${CATALYST_REF}" || (echo 'CATALYST_REF build-arg is required' >&2 && exit 1)
RUN git clone --quiet "${CATALYST_REPO}" catalyst \
  && git -C catalyst checkout --quiet "${CATALYST_REF}"
WORKDIR /build/catalyst
# Upstream catalyst's build script is `tsc` but typescript isn't in its
# devDependencies (upstream bug at the pinned SHA). Install it transiently
# when missing, pinned to TS 5.x — catalyst's tsconfig.json uses the
# moduleResolution=node10 + implicit-rootDir style that TS 7+ rejects.
# --no-save keeps package-lock.json clean so `npm prune` afterwards trims it.
RUN npm ci --silent \
  && (test -x node_modules/.bin/tsc || npm install --no-save --silent 'typescript@~5.7') \
  && (npm run build --silent > /tmp/tsc.log 2>&1 || true) \
  && (test -s dist/catalyst.mjs || (cat /tmp/tsc.log >&2; exit 1)) \
  && rm -f /tmp/tsc.log \
  && rm -rf node_modules \
  && npm install --omit=dev --ignore-scripts --silent

FROM node:${NODE_VERSION} AS deps
WORKDIR /app
RUN corepack enable pnpm
COPY package.json ./
COPY pnpm-lock.yaml* ./
RUN if [ -f pnpm-lock.yaml ]; then \
      pnpm install --prod --frozen-lockfile; \
    else \
      pnpm install --prod --no-frozen-lockfile; \
    fi

FROM node:${NODE_VERSION} AS runtime
LABEL org.opencontainers.image.title="puml2drawio"
LABEL org.opencontainers.image.description="Convert PlantUML C4 diagrams to draw.io XML"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.source="https://github.com/andriykalashnykov/puml2drawio"
# Upgrade the base image's system packages before shipping. node:24-alpine
# lags Alpine security updates between rebuilds, so its OpenSSL libs
# (libcrypto3/libssl3) carry fixable CVEs (e.g. CVE-2026-45447, fixed in
# openssl 3.5.7-r0) that even a freshly-published base digest still ships.
# This is the Alpine analogue of `apt-get upgrade` — it clears base-lag CVEs
# the blocking Trivy gate flags, including future ones, on every rebuild.
# `--no-cache` leaves no apk index behind so the runtime layer stays minimal.
#
# APK_UPGRADE_BUST defeats the gha build cache on this layer: both CI image
# builds use `cache-from/to: type=gha`, so without a changing input the
# upgraded layer is replayed verbatim and an Alpine CVE fixed *after* the
# layer was first cached would never land (the blocking Trivy image scan
# could redden with no Dockerfile diff). CI feeds ${{ github.run_id }}
# (per-run freshness); the Makefile feeds a date (daily). Under BuildKit, an
# in-scope ARG whose value changes invalidates the cache of the following RUN
# even without referencing it (A/B-verified), so the bare declaration here is
# sufficient — no echo needed.
ARG APK_UPGRADE_BUST=0
RUN apk upgrade --no-cache
# Strip npm/npx/corepack from the runtime image. We never use them at runtime
# (ENTRYPOINT is `node src/cli.mjs`), and npm's bundled node_modules ships
# HIGH CVEs in minimatch/picomatch/tar that Trivy (rightly) flags.
RUN rm -rf /usr/local/lib/node_modules/npm \
      /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/corepack \
      /opt/yarn-* \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg 2>/dev/null; true
RUN addgroup -S app && adduser -S -G app -u 10001 app
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts/action-entrypoint.sh /app/action-entrypoint.sh
RUN chmod +x /app/action-entrypoint.sh
COPY --from=catalyst-builder /build/catalyst/dist ./vendor/catalyst/dist
COPY --from=catalyst-builder /build/catalyst/node_modules ./vendor/catalyst/node_modules
COPY --from=catalyst-builder /build/catalyst/package.json ./vendor/catalyst/package.json
RUN chown -R app:app /app
USER 10001:10001
WORKDIR /work
ENTRYPOINT ["node", "/app/src/cli.mjs"]
CMD ["--help"]
