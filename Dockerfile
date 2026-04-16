# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=24-alpine

FROM node:${NODE_VERSION} AS catalyst-builder
RUN apk add --no-cache git
ARG CATALYST_REPO=https://github.com/localgod/catalyst.git
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
