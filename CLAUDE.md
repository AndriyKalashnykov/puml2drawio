# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Dockerized CLI that converts PlantUML C4 diagrams to draw.io XML by wrapping the [localgod/catalyst](https://github.com/localgod/catalyst) JavaScript library. The primary artifact is a multi-arch container image published to `ghcr.io/andriykalashnykov/puml2drawio` and a reusable GitHub Action (`action.yml`). Used as a CI step in other repos that author architecture diagrams in PlantUML and want draw.io output committed back or rendered downstream.

## Architecture

The project is a **thin wrapper** — catalyst is not forked. Instead:

1. **`CATALYST_REF`** pins a specific upstream commit SHA of `localgod/catalyst`. Renovate tracks `main` via a `git-refs` custom manager (see `renovate.json`) and opens (but never auto-merges) PRs when the upstream branch advances — upstream API changes need human review.
2. **`scripts/fetch-catalyst.sh`** clones the pinned SHA into `vendor/catalyst/`, runs `npm ci`, transiently installs `typescript@~5.7` (`--no-save`) when `tsc` isn't already in `node_modules/.bin` — upstream catalyst's build script is `tsc` but typescript isn't in its devDependencies — runs `npm run build` (tolerated if it exits non-zero since tsc emits `dist/` anyway), then **wipes `node_modules/` and reinstalls with `--omit=dev --ignore-scripts`** (plain `npm prune --omit=dev` leaves transitive devDep trees intact, shipping HIGH CVEs into the image). Idempotent: skips the whole block when the vendored checkout already matches `CATALYST_REF` and has a `dist/`. The Dockerfile's `catalyst-builder` stage mirrors the same defense.
3. **`src/convert.mjs`** imports catalyst lazily via a dynamic `import('../vendor/catalyst/dist/catalyst.mjs')` so unit tests that don't exercise conversion (e.g. `options.test.mjs`, `runner.test.mjs`) run without requiring the vendored build.
4. **Dockerfile** has a three-stage build: `catalyst-builder` stage (alpine + git, clones + builds catalyst, then wipes `node_modules/` and reinstalls with `--omit=dev --ignore-scripts` — `npm prune` leaves transitive devDep trees behind on nested deps), `deps` stage (wrapper's pnpm prod install), `runtime` stage (`node:24-alpine`, **npm/npx/corepack/yarn stripped** — unused at runtime and ship HIGH CVEs in their bundled `minimatch`/`picomatch`/`tar` — non-root `app` user with numeric UID 10001, `WORKDIR /work` so consumers can `-v "$PWD:/work"`).

### CLI surface (`src/runner.mjs`, `src/cli.mjs`)

Yargs-parsed positional input + flags. Input can be a file, a directory (recursed for `*.puml`), or `-` (stdin). Layout flags (`--layout-direction`, `--nodesep`, `--edgesep`, `--ranksep`, `--marginx`, `--marginy`) have **three-tier precedence**: explicit flag > `CATALYST_<UPPER>` env var > default in `DEFAULTS`. The precedence logic lives in `src/options.mjs` (`resolveOptions`, returns `Object.freeze`d result). Empty-string env vars are treated as absent.

### GitHub Action shim (`action.yml` + `scripts/action-entrypoint.sh`)

GitHub Actions injects `inputs.<name>` as `INPUT_<UPPER>` env vars. The shim translates only **non-empty** inputs into CLI args (using `set -- "$@" ...` to be safe with spaces), then `exec`s the CLI. Direct `${{ inputs.foo }}` interpolation into args would produce `--output=` on missing inputs and break the parser — that's why the shim exists.

## Build & Run

All workflows go through the Makefile. Raw `pnpm` / `npm` / `docker` commands will drift from CI.

| Command | Purpose |
|---------|---------|
| `make deps` | Install mise (first run) → Node 24 → pnpm → project deps → build vendored catalyst |
| `make deps-check` | Show versions of every required tool |
| `make fetch-catalyst` | Re-run catalyst fetch/build (idempotent) |
| `make test` | Vitest unit tests — pure logic, no catalyst, seconds |
| `make test-coverage` | Vitest with v8 coverage (`vitest.config.mjs` enforces 80% thresholds) |
| `make integration-test` | Vitest integration tests — real catalyst via `vendor/catalyst/dist/`, real fs, tens of seconds |
| `make action-test` | Shell test for `scripts/action-entrypoint.sh` (INPUT_* → CLI arg mapping) |
| `make e2e` | End-to-end: run built Docker image against `sample/example.puml`, assert output contains `mxGraphModel`, minutes on first build |
| `make lint` | `node --check` JS + `hadolint` (Dockerfile) + `shellcheck` (scripts) |
| `make lint-shell` | Shellcheck on `scripts/*.sh` |
| `make mermaid-lint` | Validate Mermaid blocks in markdown via pinned `minlag/mermaid-cli` Docker image |
| `make static-check` | `lint` + `vulncheck` (pnpm audit) + `trivy-fs` + `mermaid-lint` |
| `make image-build` | Build local image, tagged `puml2drawio:<CURRENTTAG>` + `:latest` (skipped when CURRENTTAG=`dev`) |
| `make image-sample` | Build + run image against `sample/example.puml`, output `build/sample.drawio` |
| `make image-run ARGS="diagrams/ -o out/"` | Run built image with custom args against mounted `$PWD` |
| `make ci` | Local CI: static-check + test + integration-test + action-test + e2e |
| `make ci-run` | Execute `.github/workflows/ci.yml` locally via `act` (scoped with `--workflows`) |
| `make release` | Interactive semver tag prompt — main-branch only, clean-tree guard, validates `vN.N.N`, pushes |

First-run note: `make deps` installs mise to `~/.local/bin` and exits, prompting the user to add `eval "$(~/.local/bin/mise activate $SHELL)"` to their shell rc file. The **second** `make deps` runs `mise install` (reading `.mise.toml` + `.nvmrc`) and completes setup.

### Three-layer test pyramid

| Layer | Target | Covers | Requires | Runtime |
|-------|--------|--------|----------|---------|
| Unit | `make test` | Pure logic: `resolveOptions`, `deriveOutputPath`, `collectPumlFiles`, `buildParser` | Node + pnpm | seconds |
| Integration | `make integration-test` | `convertString` / `convertFile` / `runCli` end-to-end against real catalyst + temp fs. Also runs `make action-test` (shell test of `scripts/action-entrypoint.sh`) | `vendor/catalyst/dist/` (built by `make deps`) | tens of seconds |
| E2E | `make e2e` | Run built Docker image against `sample/example.puml`; assert output contains `mxGraphModel` | Docker + `make image-build` | minutes on first build |

Integration tests skip cleanly when `vendor/catalyst/dist/catalyst.mjs` is missing (allows `make integration-test` on a fresh checkout without `make deps` to fail-fast with a clear message instead).

### Running a single test

```bash
pnpm exec vitest run test/options.test.mjs
pnpm exec vitest run -t 'flag overrides env'                          # filter by test-name substring
pnpm exec vitest run -c vitest.integration.config.mjs                 # integration only
pnpm exec vitest run -c vitest.integration.config.mjs test/convert.integration.test.mjs
```

`make deps` must have been run at least once so catalyst exists at `vendor/catalyst/dist/` — without it, `convert.test.mjs` and any integration test will fail to import.

## CI/CD

One SHA-pinned workflow — `.github/workflows/ci.yml` — covers everything. On push to `main`, tags `v*`, PRs, and as a reusable `workflow_call`, it runs six jobs:

1. **`static-check`** — `make static-check` composite gate (lint + hadolint + shellcheck + pnpm audit + Trivy fs + mermaid-lint).
2. **`build`** (needs static-check) — `make build` validates the Docker image builds.
3. **`test`** (needs static-check, parallel with build + integration-test) — Vitest + coverage threshold + artifact upload.
4. **`integration-test`** (needs static-check, parallel with build + test) — `make integration-test` + `make action-test`: runs vitest against real catalyst + fs, plus shell test of the Action entrypoint shim.
5. **`e2e`** (needs build + test) — `make e2e`: convert `sample/example.puml` via the built image, assert output contains `mxGraphModel`.
6. **`docker`** (needs static-check + build + test) — hardened publish pipeline: single-arch scan build → Trivy image scan (CRITICAL/HIGH blocking) → `--version` smoke test → multi-arch `linux/amd64,linux/arm64` build (push on tags only) → cosign keyless OIDC signing (tags only) → multi-arch manifest verification. `provenance: false` + `sbom: false` keep the GHCR "OS / Arch" tab functional; cosign provides the supply-chain signature instead of buildkit in-manifest attestations.
7. **`ci-pass`** (needs all above, `if: always()`) — gate job that aggregates `needs.*.result`. Single branch-protection check; jobs can be added/renamed without updating Settings.

A separate scheduled workflow (`.github/workflows/action-consumer-test.yml`) runs nightly as a self-consumer test: it invokes the action via `uses: ./` against a synthetic PlantUML input and asserts the converted output. Not part of `ci-pass` — it rebuilds the Docker image from source on every run.

Gates 1–4 of the `docker` job (build, Trivy, smoke test, multi-arch build validation) run on every push including PRs. Gate 5 (registry push + cosign sign + manifest verify) is step-level tag-gated via `if: startsWith(github.ref, 'refs/tags/')`.

Git tags use `vX.Y.Z`; the Docker metadata-action strips the `v` to produce bare-semver image tags (`X.Y.Z`, `X.Y`, `X`). `:latest` only applies to tag pushes via `flavor: latest=${{ startsWith(github.ref, 'refs/tags/') }}`.

## Versioning & pins

- `CATALYST_REF` — pinned SHA of `localgod/catalyst`. Single source of truth; the Makefile reads it via `$(shell tr -d '[:space:]' < CATALYST_REF)`, the Dockerfile consumes it as a `--build-arg`, and Renovate tracks the upstream branch head.
- `.nvmrc` = `24`. `.mise.toml` reads from it. CI uses `node-version-file: '.nvmrc'` on `setup-node`. Never hardcode the Node version elsewhere.
- Tool versions live in `.mise.toml` (hadolint, act, trivy, shellcheck, node) — renovate's built-in `mise` manager tracks them via inline `# renovate:` comments. Only `MERMAID_CLI_VERSION` (Docker-image-only, not mise-supported) stays in the Makefile with a `# renovate:` comment picked up by the generic `customManagers` regex. Adding a new mise-managed tool: pin it in `.mise.toml` with a `# renovate:` comment; no `Makefile` or `renovate.json` change needed. Adding a Docker-image-only tool: inline the `_VERSION` constant in the Makefile with a `# renovate:` comment.

## Conventions

- **TUnit/xUnit/Maven are irrelevant here** — this is Node; tests are Vitest. Portfolio-wide .NET/Java testing rules do not apply.
- **pnpm-only.** `package.json` sets `packageManager: pnpm@10.33.0`. Never run `npm install` at the wrapper root — it will write `package-lock.json` and cause drift. (Inside `vendor/catalyst/`, npm is used because catalyst itself uses `package-lock.json` upstream.)
- **Immutability.** `src/options.mjs` returns `Object.freeze(...)`; `convertString` spreads options into a fresh object before passing to catalyst. Preserve this when extending.
- **Error boundaries.** CLI writes errors to stderr and exits 1 (runtime) or 2 (arg/validation). Batch mode accumulates errors unless `--fail-fast`.
- **Dynamic catalyst import.** Keep it dynamic — pure-logic tests must run without `vendor/catalyst/` existing.
- **Static analysis tools** — the composite `make static-check` gate runs hadolint, shellcheck, pnpm audit, Trivy fs, and `minlag/mermaid-cli` (for Mermaid blocks in markdown). All versions pinned in the Makefile with `# renovate:` comments.

## Skills

Use the following skills when working on related files:

| File(s) | Skill |
|---------|-------|
| `Makefile` | `/makefile` |
| `renovate.json` | `/renovate` |
| `README.md` | `/readme` |
| `.github/workflows/*.{yml,yaml}` | `/ci-workflow` |

When spawning subagents, always pass conventions from the respective skill into the agent's prompt.

## Backlog

Deferred work from initial scaffold (2026-04-16). Keep this list current — resolve items or justify why they're still open.

### Pre-commit verification (not run during scaffold)

- [ ] `make ci` — full local pipeline: `static-check` + `test` + `e2e`. Pulls catalyst and builds the image; ~2–5 min first run.
- [ ] `make ci-run` — executes `.github/workflows/ci.yml` end-to-end via `act`. Confirms the workflow on a fresh runner, not just the host.
- [ ] `pnpm exec vitest run test/options.test.mjs test/runner.test.mjs` — fastest sanity check; pure-logic tests pass without network or Docker. `convert.test.mjs`'s filesystem case also runs standalone.

### Known gaps

- [ ] **No `pnpm-lock.yaml`** yet. First `make deps` / `pnpm install` generates it. Commit so `ci.yml`'s `cache: 'pnpm'` works reliably and `Dockerfile` can use `--frozen-lockfile`.
- [ ] **`make vulncheck` is informational only** (pnpm 10.33 still queries npm's retired `/-/npm/v1/security/audits` endpoint and gets 410). The target swallows the failure with a note; `make trivy-fs` remains the actual CVE gate in `static-check`. Remove the `|| echo ...` swallow once pnpm ships bulk-advisory-endpoint support ([pnpm issue tracker](https://github.com/pnpm/pnpm/issues)).
- [ ] **Upstream catalyst PRs** — two PRs filed (2026-04-16): [#552 add typescript to devDependencies](https://github.com/localgod/catalyst/pull/552) and [#553 explicit rootDir in tsconfig](https://github.com/localgod/catalyst/pull/553). Once both merge upstream, remove the transient `typescript@~5.7` install in `scripts/fetch-catalyst.sh` and `Dockerfile` (the defense-in-depth is still useful for resilience but the primary path becomes `npm ci && npm run build`).

### Nice-to-have

- [ ] Glob input support (`'diagrams/**/*.puml'`) — deliberately excluded from v1; add if user feedback demands it.
- [ ] `--output-ext` support in stdin/single-file modes (currently batch-only).
- [ ] JSON summary output (`--summary`) for CI dashboards.
- [ ] Dark-mode-friendly draw.io output themes.
