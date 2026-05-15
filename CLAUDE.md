# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Dockerized CLI that converts PlantUML C4 diagrams to draw.io XML by wrapping the [catalyst](https://github.com/AndriyKalashnykov/catalyst) JavaScript library. The primary artifact is a multi-arch container image published to `ghcr.io/andriykalashnykov/puml2drawio` and a reusable GitHub Action (`action.yml`). Used as a CI step in other repos that author architecture diagrams in PlantUML and want draw.io output committed back or rendered downstream.

## Architecture

The project is a **thin wrapper** around catalyst. It pins `AndriyKalashnykov/catalyst` (the canonical catalyst repo); the wrapper's own code is **not** catalyst — only a release tag is held in `CATALYST_REF`. The pieces:

1. **`CATALYST_REF`** pins a specific release **tag** (e.g. `v1.3.0`) of `AndriyKalashnykov/catalyst` (the canonical catalyst repo). Renovate tracks its tags via a `github-tags` custom manager (see `renovate.json`) — catalyst tags releases but does not cut formal GitHub Releases, so `github-tags` (not `github-releases`) is the correct datasource. Repo-wide automerge is on (`automergeType: pr`), but the `CATALYST_REF` package rule carves out `automerge: false` — bumps to catalyst are API-affecting and need human review.
2. **`scripts/fetch-catalyst.sh`** clones the pinned ref (the `CATALYST_REF` tag) into `vendor/catalyst/`, runs `npm ci`, transiently installs `typescript@~5.7` (`--no-save`) when `tsc` isn't already in `node_modules/.bin` — upstream catalyst's build script is `tsc` but typescript isn't in its devDependencies — runs `npm run build` (tolerated if it exits non-zero since tsc emits `dist/` anyway), then **wipes `node_modules/` and reinstalls with `--omit=dev --ignore-scripts`** (plain `npm prune --omit=dev` leaves transitive devDep trees intact, shipping HIGH CVEs into the image). Idempotent: skips the whole block when the vendored checkout already matches `CATALYST_REF` and has a `dist/`. The Dockerfile's `catalyst-builder` stage mirrors the same defense.
3. **`src/convert.mjs`** imports catalyst lazily via a dynamic `import('../vendor/catalyst/dist/catalyst.mjs')` so unit tests that don't exercise conversion (e.g. `options.test.mjs`, `runner.test.mjs`) run without requiring the vendored build.
4. **Dockerfile** has a three-stage build: `catalyst-builder` stage (alpine + git, clones + builds catalyst, then wipes `node_modules/` and reinstalls with `--omit=dev --ignore-scripts` — `npm prune` leaves transitive devDep trees behind on nested deps), `deps` stage (wrapper's pnpm prod install), `runtime` stage (`node:24-alpine`, **npm/npx/corepack/yarn stripped** — unused at runtime and ship HIGH CVEs in their bundled `minimatch`/`picomatch`/`tar` — non-root `app` user with numeric UID 10001, `WORKDIR /work` so consumers can `-v "$PWD:/work"`).

### CLI surface (`src/runner.mjs`, `src/cli.mjs`)

Yargs-parsed positional input + flags. Input can be a file, a directory (recursed for `*.puml`), a **glob pattern** (`'diagrams/**/*.puml'` — detected by metachars `*?[]{}`, expanded via Node's native `fs.glob`, output tree anchored at the static path prefix; requires `-o`), or `-` (stdin). Layout flags (`--layout-direction`, `--nodesep`, `--edgesep`, `--ranksep`, `--marginx`, `--marginy`) have **three-tier precedence**: explicit flag > `CATALYST_<UPPER>` env var > default in `DEFAULTS`. The precedence logic lives in `src/options.mjs` (`resolveOptions`, returns `Object.freeze`d result). Empty-string env vars are treated as absent. `--output-ext` applies in batch/glob mode, and in single-file mode when `-o` is a directory (derives `<stem><ext>`); it is **not** applied to stdin (no source filename for a stem — by design). `--summary` emits a JSON `{total,converted,failed,files[]}` report — to **stdout** in batch/glob (stdout is otherwise free there), to **stderr** in single/stdin (so the drawio on stdout stays uncorrupted); it is written even on partial failure, before the non-zero exit. The batch/glob convert loop is the shared `convertMany` engine in `src/runner.mjs`.

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
| `make e2e` | End-to-end (stdin mode): run built Docker image against `sample/example.puml`, assert the output carries `<mxfile` + `<mxGraphModel` + at least one `<mxCell` AND all three sample C4 labels (User, API, Database); minutes on first build |
| `make e2e-batch` | End-to-end (batch/bind-mount mode): convert `sample/` via the built image with `-v $PWD`, assert each `.drawio` carries `<mxGraphModel`, is host-owned (non-root UID write back to host), and freshly written. NOT run under act — invoked directly by the CI `e2e` job |
| `make e2e-convert-png` | End-to-end for `convert-png`: assert `.drawio` AND a valid `.drawio.png` (correct magic bytes) land side-by-side, host-owned, fresh. NOT run under act — invoked directly by the CI `e2e` job |
| `make convert-png` | Convert PUML → drawio AND render PNG side-by-side in the **same** `OUTPUT_DIR` (`INPUT=<dir>` `OUTPUT_DIR=<dir>`, defaults `sample` → `build`). PNG pass uses the pinned `rlespinasse/drawio-export` image (the node runtime image has no drawio binary) |
| `make lint` | `node --check` JS + `hadolint` (Dockerfile) + `shellcheck` (scripts) |
| `make lint-shell` | Shellcheck on `scripts/*.sh` |
| `make mermaid-lint` | Validate Mermaid blocks in markdown via pinned `minlag/mermaid-cli` Docker image |
| `make static-check` | `lint` + `vulncheck` (pnpm audit) + `trivy-fs` + `mermaid-lint` |
| `make image-build` | Build local image, tagged `puml2drawio:<CURRENTTAG>` + `:latest` (skipped when CURRENTTAG=`dev`) |
| `make image-sample` | Build + run image against `sample/example.puml`, output `build/sample.drawio` |
| `make image-run ARGS="diagrams/ -o out/"` | Run built image with custom args against mounted `$PWD` |
| `make ci` | Local CI: static-check + test + integration-test + action-test + e2e |
| `make ci-run` | Execute `.github/workflows/ci.yml` locally via `act` (scoped with `--workflows`) |
| `make build` | `deps` + `image-build` — install everything, then build the Docker image |
| `make clean` | Remove `node_modules/`, `vendor/`, `coverage/`, `build/`, `dist/` |
| `make lint-docker` | Hadolint only (subset of `lint`) |
| `make vulncheck` | `pnpm audit --audit-level=moderate` — blocking gate (pnpm 11 fixed the 410-on-bulk-audit endpoint bug that previously forced this to swallow failures) |
| `make trivy-fs` | Trivy filesystem CVE scan (CRITICAL/HIGH, blocking) |
| `make puml-png` / `make drawio-png` / `make diagrams-png` / `make drawio-layout` | Diagram-rendering helpers — see README §"Diagram Rendering & Layout" |
| `make examples-png` | Regenerate the committed README before/after example PNGs in `docs/examples/` (plantuml render of `sample/example.puml` + its converted drawio rendered via drawio-export). Converts via vendored catalyst (`node src/cli.mjs`), NOT the Docker image — single regen path; run after a `CATALYST_REF` bump so the committed PNG can't drift |
| `make image-push` | Tag + push image to `$(DOCKER_REGISTRY)/$(DOCKER_REPO)` |
| `make image-stop` | Stop any running puml2drawio container |
| `make require-docker` | Fail fast when docker CLI is not on PATH (prerequisite of image-* and mermaid-lint) |
| `make renovate-validate` | Validate `renovate.json` via `npx --yes renovate --platform=local` |
| `make release` | Interactive semver tag prompt — main-branch only, clean-tree guard, validates `vN.N.N`, pushes |
| `make release-floating-tags VERSION=vX.Y.Z` | Retarget floating `vX` / `vX.Y` tags after a `vX.Y.Z` release |

First-run note: `make deps` installs mise to `~/.local/bin` and exits, prompting the user to add `eval "$(~/.local/bin/mise activate $SHELL)"` to their shell rc file. The **second** `make deps` runs `mise install` (reading `.mise.toml` + `.nvmrc`) and completes setup.

### Three-layer test pyramid

| Layer | Target | Covers | Requires | Runtime |
|-------|--------|--------|----------|---------|
| Unit | `make test` | Pure logic: `resolveOptions`, `deriveOutputPath`, `collectPumlFiles`, `buildParser` | Node + pnpm | seconds |
| Integration | `make integration-test` | `convertString` / `convertFile` / `runCli` end-to-end against real catalyst + temp fs, including `--fail-fast` semantics in batch mode; child-process tests for `layout-drawio-cli.mjs` (argv parse, AUTO vs explicit direction, in-place overwrite, error exits); a **layout-quality gate** (`layout-quality.integration.test.mjs`) asserting the re-layout output keeps every leaf ≥ the C4 element minimum and overlap-free — the coordinate-blind structural parity gate cannot see this. Also runs `make action-test` (shell test of `scripts/action-entrypoint.sh`) | `vendor/catalyst/dist/` (built by `make deps`) | tens of seconds |
| E2E (stdin) | `make e2e` | Run built Docker image against `sample/example.puml`; assert `<mxfile`/`<mxGraphModel`/`<mxCell` envelope + all three C4 labels (User, API, Database) survive conversion | Docker + `make image-build` | minutes on first build |
| E2E (batch) | `make e2e-batch` | Convert `sample/` via the built image with a `-v $PWD` bind mount; assert each `.drawio` carries `<mxGraphModel`, is host-owned (non-root UID write-back), and freshly written. Covers the batch path act cannot exercise | Docker + `make image-build` | minutes on first build |
| E2E (convert-png) | `make e2e-convert-png` | Run `convert-png` over `sample/`; assert `.drawio` + valid `.drawio.png` (PNG magic bytes) land side-by-side, host-owned, fresh. Guards the convert-png feature + drawio-export chown-back | Docker + `make image-build` | minutes on first build |

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

One SHA-pinned workflow — `.github/workflows/ci.yml` — covers everything. On push to `main`, tags `v*`, PRs, and as a reusable `workflow_call`, it runs eight jobs:

1. **`changes`** — `dorny/paths-filter` detects whether the push/PR touches code-bearing paths. Doc-only changes (README, LICENSE, .gitignore, `*.png`) skip all heavy jobs but still report a green `ci-pass`. Tag pushes (`refs/tags/v*`) force `code=true` so the publish pipeline always runs. The repository ruleset requires `ci-pass` for merges; without this gate, doc-only PRs would deadlock.
2. **`static-check`** (needs changes; gated on `code=true`) — `make static-check` composite gate (lint + hadolint + shellcheck + pnpm audit + Trivy fs + mermaid-lint).
3. **`build`** (needs changes + static-check) — `make build` (= `deps` + `image-build`).
4. **`test`** (needs changes + static-check, parallel with build + integration-test) — Vitest + coverage threshold + artifact upload.
5. **`integration-test`** (needs changes + static-check, parallel with build + test) — `make integration-test` + `make action-test`: runs vitest against real catalyst + fs, plus shell test of the Action entrypoint shim.
6. **`e2e`** (needs changes + build + test) — `make e2e`: convert `sample/example.puml` via the built image, assert output contains `mxGraphModel`.
7. **`docker`** (needs changes + static-check + build + test) — hardened publish pipeline: single-arch scan build → Trivy image scan (CRITICAL/HIGH blocking) → `--version` smoke test → multi-arch `linux/amd64,linux/arm64` build (push on tags only) → cosign keyless OIDC signing (tags only) → multi-arch manifest verification. `provenance: false` + `sbom: false` keep the GHCR "OS / Arch" tab functional; cosign provides the supply-chain signature instead of buildkit in-manifest attestations.
8. **`ci-pass`** (needs all above, `if: always()`) — gate job that aggregates `needs.*.result`. Fails on `failure` OR `cancelled`; treats `skipped` as OK so doc-only changes report green. Single branch-protection check; jobs can be added/renamed without updating Settings.

A separate scheduled workflow (`.github/workflows/action-consumer-test.yml`) runs nightly as a self-consumer test: it invokes the action via `uses: ./` against a synthetic PlantUML input and asserts the converted output. Not part of `ci-pass` — it rebuilds the Docker image from source on every run.

Gates 1–4 of the `docker` job (build, Trivy, smoke test, multi-arch build validation) run on every push including PRs. Gate 5 (registry push + cosign sign + manifest verify) is step-level tag-gated via `if: startsWith(github.ref, 'refs/tags/')`.

Git tags use `vX.Y.Z`; the Docker metadata-action strips the `v` to produce bare-semver image tags (`X.Y.Z`, `X.Y`, `X`). `:latest` only applies to tag pushes via `flavor: latest=${{ startsWith(github.ref, 'refs/tags/') }}`.

## Versioning & pins

- `CATALYST_REF` — pinned release **tag** of `AndriyKalashnykov/catalyst` (the canonical catalyst repo). Single source of truth; the Makefile reads it via `$(shell tr -d '[:space:]' < CATALYST_REF)`, the Dockerfile consumes it as a `--build-arg`, and Renovate tracks new catalyst tags via a `github-tags` custom manager. The regex captures the tag as `currentValue` (`^(?<currentValue>v?\d[\w.+-]*)`); a SHA-shaped value would NOT match — keep `CATALYST_REF` a `vX.Y.Z` tag.
- `.nvmrc` = `24` is the **single source of truth for the Node major**. `.mise.toml` reads it via `idiomatic_version_file_enable_tools = ["node"]` (mise does NOT read `.nvmrc` by default — the setting is required) and pins **no** `node` entry. CI's `setup-node` uses `node-version-file: '.nvmrc'`, so mise and setup-node resolve the same Node — no drift. Never hardcode the Node version elsewhere, and never re-add `node` to `.mise.toml`. `package.json` `engines.node` is `">=24 <25"` (hard major ceiling, matching the `.nvmrc` major): moving to Node 25 is a deliberate synchronized bump of `.nvmrc` + this ceiling, never silent drift.
- Tool versions live in `.mise.toml` (hadolint, act, trivy, shellcheck — **not** node, see above) — renovate's built-in `mise` manager tracks them natively, deriving each datasource from the tool's mise backend. It does **not** consult inline comments, so `.mise.toml` uses plain `#` doc comments (an `# renovate:` keyword or a `custom.regex` over `.mise.toml` would duplicate-PR against the native manager — forbidden, see `/renovate` skill). Only `MERMAID_CLI_VERSION` (Docker-image-only, not mise-supported) stays in the Makefile with a `# renovate:` comment picked up by the generic `customManagers` regex. Adding a new mise-managed tool: just pin it in `.mise.toml` (the native manager tracks it); no `# renovate:` comment, `Makefile`, or `renovate.json` change needed. Adding a Docker-image-only tool: inline the `_VERSION` constant in the Makefile with a `# renovate:` comment.

## Conventions

- **TUnit/xUnit/Maven are irrelevant here** — this is Node; tests are Vitest. Portfolio-wide .NET/Java testing rules do not apply.
- **pnpm-only.** `package.json` sets `packageManager: pnpm@11.1.0`. Never run `npm install` at the wrapper root — it will write `package-lock.json` and cause drift. (Inside `vendor/catalyst/`, npm is used because catalyst itself uses `package-lock.json` upstream.)
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

Deferred work. Keep this list current — resolve items or justify why they're still open.

### Known gaps

- [ ] **SBOM artifact not published** (forward-looking — trigger: consumer asks "what's in this image?") — `provenance: false` + `sbom: false` is correct for GHCR's "OS / Arch" tab rendering, but consumers currently only get the cosign signature. **Action when demand surfaces**: publish a separate SBOM via `anchore/sbom-action` as a release asset (not buildkit in-manifest, which would re-break the GHCR tab). Surfaced 2026-05-14.

- [ ] **PlantUML/drawio container litters a `?/` font-cache dir in the repo root** (cosmetic; never committed — always untracked, so it ships nothing wrong) — `scripts/puml-to-png.sh` and `scripts/drawio-to-png.sh` run `docker run plantuml/plantuml` / `rlespinasse/drawio-export` without setting `HOME`; the containerized JVM/fontconfig writes `~/.java/fonts/…` which, with `HOME` unset, resolves to a literal `?` directory via the `-v "$PWD:/data"` bind mount. Recurs on every `make mermaid-lint` / `puml-png` / `drawio-png` / `examples-png` / `diagrams-png`. **Real fix** (one-pass when next touching the diagram scripts): add `-e HOME=/tmp` to the `docker run` invocations in `scripts/puml-to-png.sh` + `scripts/drawio-to-png.sh` so the JVM writes its cache inside the container, not the host CWD. Surfaced 2026-05-15.

## Roadmap (nice-to-have)

Glob input, `--output-ext` in single-file/stdin, and `--summary` JSON shipped 2026-05-15 (see §"CLI surface"); removed from the roadmap as resolved.

- [ ] **Dark-mode-friendly draw.io output** — **blocked on a defined target palette, not on effort.** Fact-checked 2026-05-15: catalyst v1.3.0 `Catalyst.convert()` has no theme/color option (only `layoutOptions`); colors are baked C4-PlantUML hex (`#08427B`/`#1061B0`/`#ffffff`/…). draw.io's own dark mode darkens the *canvas*, not shape fills, and there is **no canonical "C4 dark" palette spec** to mirror. A real fix is a colour-remap post-processor (same shape as `src/layout-drawio.mjs`) **once a grounded target palette is decided** — inventing replacement hex would be guesswork. **Trigger to act**: a defined dark palette (user-specified, or a documented C4/draw.io dark theme to cite). Then: map fill/stroke/font per element type, add a `--theme dark` flag + a `layout-quality`-style test asserting the remap.
- [ ] **Layout parity with Graphviz dot for dense C4 diagrams** (2026-04-18; re-scoped 2026-05-15 as a research spike, not a mechanical fix). `make drawio-layout` uses elkjs `layered` + `INCLUDE_CHILDREN`; it cannot replicate Graphviz dot's wide sibling packing for dense container diagrams (many peers without intra-cluster edges stack orthogonally to the flow axis). Explored and rejected: `elk.aspectRatio`, `elk.layered.wrapping.strategy=MULTI_EDGE`, `elk.layered.considerModelOrder.strategy=NODES_AND_EDGES`, `elk.separateConnectedComponents=false`, `box`/`rectpacking` (incompatible with cross-hierarchy edges). A real fix is one of: (a) shell out to a `dot` binary + map coordinates back into drawio XML — a major feature with a heavy new system dependency and a coordinate-remap layer (high risk; arguably belongs upstream in catalyst's `LayoutEngine`, which owns layout); (b) a two-pass layered + greedy sibling grid-packing post-step; (c) per-PUML layout hints forwarded as per-container `elk.*` options. All three are exploratory — none is a no-guesswork one-pass change. **Trigger to act**: a decision to take the (a)/(b)/(c) spike, ideally driven upstream in catalyst.
