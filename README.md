[![CI](https://github.com/andriykalashnykov/puml2drawio/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/andriykalashnykov/puml2drawio/actions/workflows/ci.yml)
[![Hits](https://hits.sh/github.com/andriykalashnykov/puml2drawio.svg?view=today-total&style=plastic)](https://hits.sh/github.com/andriykalashnykov/puml2drawio/)
[![License: MIT](https://img.shields.io/badge/License-MIT-brightgreen.svg)](https://opensource.org/licenses/MIT)
[![Renovate enabled](https://img.shields.io/badge/renovate-enabled-brightgreen.svg)](https://app.renovatebot.com/dashboard#github/andriykalashnykov/puml2drawio)

# puml2drawio

Dockerized CLI that converts PlantUML C4 diagrams (`.puml`) to draw.io XML (`.drawio`). Designed to drop into CI pipelines that commit PlantUML sources and want draw.io output rendered or committed back downstream. Wraps the [localgod/catalyst](https://github.com/localgod/catalyst) JavaScript library (pinned by commit SHA, tracked by Renovate).

```mermaid
flowchart LR
  puml[".puml files<br/>(PlantUML C4)"] -->|stdin / file / dir| cli["puml2drawio CLI<br/>(yargs)"]
  cli --> conv["Catalyst<br/>(vendored)"]
  conv -->|dagre layout| drawio[".drawio XML"]
  drawio -->|stdout / file / dir| out[("CI artefact /<br/>commit-back")]

  subgraph "Docker image: ghcr.io/andriykalashnykov/puml2drawio"
    cli
    conv
  end
```

Data-flow view of a conversion: PlantUML source enters via stdin, a file path, or a directory; the CLI delegates layout + XML emission to the vendored catalyst library; draw.io XML leaves via stdout, a file, or a mirrored output directory. The CLI and catalyst both live inside the published Docker image — consumers bind-mount their workspace at `/work`.

| Component | Technology |
|-----------|-----------|
| Language | Node.js 24 (ES modules) |
| CLI parser | yargs |
| Conversion engine | [localgod/catalyst](https://github.com/localgod/catalyst) (vendored at pinned SHA) |
| Container base | `node:24-alpine` (non-root `app` user) |
| Registry | GitHub Container Registry (GHCR), multi-arch `linux/amd64` + `linux/arm64` |
| Signing | [cosign](https://docs.sigstore.dev/cosign/overview/) keyless OIDC on tag pushes |
| Tests | Vitest |
| Version manager | mise — `.mise.toml` single source of truth; `jdx/mise-action` in CI for tool parity |

## Quick Start

The Docker image and GitHub Action both accept the same three input modes — **single file**, **directory (recursive)**, and **stdin**. Pick the one that fits your pipeline.

### Convert a single file (Docker)

```bash
docker run --rm -v "$PWD:/work" -w /work \
  ghcr.io/andriykalashnykov/puml2drawio:latest \
  diagram.puml -o diagram.drawio
```

Or write to stdout (omit `-o`):

```bash
docker run --rm -v "$PWD:/work" -w /work \
  ghcr.io/andriykalashnykov/puml2drawio:latest \
  diagram.puml > diagram.drawio
```

### Convert several files (shell loop over individual files)

When each input needs a distinct output path or per-file flags, loop in the shell:

```bash
for f in architecture.puml deployment.puml runtime.puml; do
  docker run --rm -v "$PWD:/work" -w /work \
    ghcr.io/andriykalashnykov/puml2drawio:latest \
    "$f" -o "build/${f%.puml}.drawio"
done
```

### Convert a whole folder (recursive, one call)

Input directory is walked recursively for `*.puml` (case-insensitive); output mirrors the input tree under `-o`. One invocation, any nesting depth:

```bash
docker run --rm -v "$PWD:/work" -w /work \
  ghcr.io/andriykalashnykov/puml2drawio:latest \
  diagrams/ -o build/drawio/ --layout-direction=LR
```

Example tree transformation:

```text
diagrams/                        build/drawio/
  context.puml                     context.drawio
  sequence.puml          →         sequence.drawio
  nested/                          nested/
    flow.puml                        flow.drawio
    deeper/                          deeper/
      detail.puml                      detail.drawio
```

Useful flags in folder mode:

| Flag | Effect |
|------|--------|
| `--output-ext .xml` | Change output extension (default `.drawio`) |
| `--fail-fast` | Stop at the first failing file (default: attempt all, exit 1 at the end listing failures) |
| `-q`, `--quiet` | Suppress per-file progress lines on stderr |
| `--layout-direction=LR` | Horizontal layout (`TB`/`BT`/`LR`/`RL`; default `TB`) |

`-o` is **required** when the input is a directory — without it the CLI exits code 2 with `error: --output is required when input is a directory`.

### Pipe mode (stdin → stdout)

For one-off conversions in shell pipelines:

```bash
cat diagram.puml | docker run --rm -i \
  ghcr.io/andriykalashnykov/puml2drawio:latest - > diagram.drawio
```

The `-` positional tells the CLI to read from stdin. Output goes to stdout by default; add `-o file.drawio` to write to a file instead.

### GitHub Action — single file

```yaml
- name: Convert one diagram
  uses: andriykalashnykov/puml2drawio@v1
  with:
    input: docs/architecture.puml
    output: build/architecture.drawio
```

### GitHub Action — whole folder (recursive)

```yaml
- name: Convert all diagrams
  uses: andriykalashnykov/puml2drawio@v1
  with:
    input: docs/diagrams
    output: build/drawio
    layout-direction: LR
    quiet: 'true'

- name: Upload converted diagrams
  uses: actions/upload-artifact@v4
  with:
    name: drawio-diagrams
    path: build/drawio/
```

Behind the scenes, the Action runs the published GHCR image (`docker://ghcr.io/andriykalashnykov/puml2drawio:1`) — no per-consumer build, ~12 MB pull. Everything described above (folder mode, `-o` required, `--fail-fast`, `--output-ext`) applies through `with:` inputs (`fail-fast: 'true'`, `output-ext: '.xml'`, etc.).

**Pinning options for `uses:`** — pick one based on how strictly you want to gate updates:

| Pin | Rolls forward on | Use when |
|-----|------------------|----------|
| `@v1` | every `v1.x.y` release (latest patch+minor in v1) | most consumers — gets bug fixes automatically, breaks only on a v2 major bump that you'd review explicitly |
| `@v1.0` | every `v1.0.x` patch | stricter consumers — patches only, no minor-version drift |
| `@v1.0.1` | nothing (immutable) | reproducible builds, audited supply chain |
| `@<commit-sha>` | nothing (immutable, doesn't redirect) | strictest pin; couple with Renovate's `helpers:pinGitHubActionDigests` to auto-PR new SHAs |

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| [GNU Make](https://www.gnu.org/software/make/) | 3.81+ | Task orchestration |
| [Git](https://git-scm.com/) | latest | Required to fetch vendored catalyst |
| [Docker](https://www.docker.com/) | latest | Image build + image-based tests + mermaid-lint |
| [Node.js](https://nodejs.org/) | 24 (from `.nvmrc`) | Runtime for CLI + Vitest (auto-installed by mise) |
| [pnpm](https://pnpm.io/) | per `packageManager` in `package.json` | Wrapper dependency management (auto-enabled via corepack) |
| [mise](https://mise.jdx.dev/) | latest | Installs Node 24, hadolint, act, trivy, shellcheck per `.mise.toml` (auto-installed by `make deps`) |

One-shot setup:

```bash
make deps
```

First run installs mise to `~/.local/bin` and exits, asking for shell activation. The second run installs everything pinned in `.mise.toml` (Node, hadolint, act, trivy, shellcheck), enables pnpm via corepack, and builds the vendored catalyst.

## Architecture

The project is a thin wrapper around catalyst, not a fork.

- **`CATALYST_REF`** — file holding the pinned commit SHA of `localgod/catalyst`. Renovate tracks `main` via a `git-refs` custom manager and opens PRs (never auto-merged) when the upstream branch advances.
- **`scripts/fetch-catalyst.sh`** — clones the pinned SHA into `vendor/catalyst/`, runs `npm ci && npm run build`, then prunes dev deps. Idempotent; skipped when `vendor/catalyst/` already matches.
- **`src/runner.mjs`** — yargs-based dispatch. Three modes: stdin (`-`), single file, directory (recursed for `*.puml`). In directory mode, `-o` is required; output mirrors the input tree.
- **`src/options.mjs`** — pure option resolution, three-tier precedence: flag → env var → default. Returns `Object.freeze(...)`.
- **`src/convert.mjs`** — dynamically imports catalyst from `vendor/catalyst/dist/catalyst.mjs` so pure-logic tests run without the vendored build.
- **`Dockerfile`** — three stages. `catalyst-builder` clones + builds catalyst at `CATALYST_REF` (passed as build arg). `deps` installs the wrapper's pnpm prod deps. Runtime stage runs as non-root, `WORKDIR /work` so consumers mount their working directory.
- **`action.yml` + `scripts/action-entrypoint.sh`** — the shim translates non-empty `INPUT_*` env vars into CLI args, avoiding the "`--output=` with empty string" failure mode that direct expression interpolation would hit.

## CLI Reference

```text
puml2drawio <input> [options]

Positional:
  input    Input .puml file, directory (recursed), or "-" for stdin

Options:
  -o, --output             Output file (single input) or directory (batch)
      --output-ext         Output extension in batch mode (default: .drawio)
      --layout-direction   Dagre direction: TB | BT | LR | RL (default: TB)
      --nodesep            Node separation in px (default: 50)
      --edgesep            Edge separation in px (default: 10)
      --ranksep            Rank separation in px (default: 50)
      --marginx            X margin in px (default: 20)
      --marginy            Y margin in px (default: 20)
      --fail-fast          Stop on first error in batch mode
  -q, --quiet              Suppress per-file progress
      --help, --version
```

Every layout option also reads from an environment variable — useful for the GitHub Action or when the CLI is invoked through a wrapper script. **Precedence: explicit flag > env var > default.**

| Flag | Env var |
|------|---------|
| `--layout-direction` | `CATALYST_LAYOUT_DIRECTION` |
| `--nodesep` | `CATALYST_NODESEP` |
| `--edgesep` | `CATALYST_EDGESEP` |
| `--ranksep` | `CATALYST_RANKSEP` |
| `--marginx` | `CATALYST_MARGINX` |
| `--marginy` | `CATALYST_MARGINY` |

## Available Make Targets

Run `make help` to see every target.

### Build & Run

| Target | Description |
|--------|-------------|
| `make deps` | Install mise-managed Node, pnpm, and vendored catalyst |
| `make fetch-catalyst` | Re-clone/build catalyst at the pinned `CATALYST_REF` (idempotent) |
| `make build` | Install deps and build Docker image |
| `make image-build` | Build Docker image only |
| `make image-run ARGS="..."` | Run image with custom CLI args against `$PWD` |
| `make image-sample` | Batch-convert every `sample/*.puml` via the built image → `build/*.drawio` |
| `make image-push` | Tag + push image to GHCR (requires `docker login` or `GH_ACCESS_TOKEN`) |
| `make image-stop` | Stop any running puml2drawio container |
| `make require-docker` | Fail fast when docker CLI is not on PATH (prerequisite of `image-*` and `mermaid-lint`) |
| `make clean` | Remove `node_modules/`, `vendor/`, `coverage/`, `build/`, `dist/` |

### Diagram Rendering & Layout

| Target | Description |
|--------|-------------|
| `make puml-png` | Render PUML → PNG via `plantuml/plantuml` (`INPUT=<file\|dir>` `OUTPUT_DIR=<dir>`; defaults `sample` → `build/png/*.puml.png`) |
| `make drawio-png` | Render drawio → PNG via `rlespinasse/drawio-export` (`INPUT=<file\|dir>` `OUTPUT_DIR=<dir>`; defaults `build` → `build/png/*.drawio.png`) |
| `make diagrams-png` | Side-by-side: render every `sample/*.puml` twice (source via plantuml, catalyst-output via drawio-export) for visual diff |
| `make drawio-layout INPUT=<file> [OUTPUT=<file>] [DIRECTION=…]` | Re-layout a drawio file via [elkjs](https://github.com/kieler/elkjs). Handles dense diagrams better than catalyst's built-in dagre — use when the auto-layout is cramped. Default output: overwrite in-place. `DIRECTION=` is `AUTO` / `DOWN` / `UP` / `LEFT` / `RIGHT`; `AUTO` (default) picks per diagram — see below |

**`make drawio-layout` — direction selection**

The elkjs layout direction dominates the look of the output. With `DIRECTION=AUTO` (the default), `drawio-layout` inspects the parsed structure and picks:

| Diagram shape | Auto-picks | Rationale |
|---|---|---|
| Nested boundaries (any `container=1` shape inside another) | `DOWN` | Deployment / dense Container — vertical flow keeps the outer boundary narrow enough to fit children |
| One flat boundary with >3 children | `DOWN` | Dense Container — horizontal would explode the page width |
| Otherwise (sparse Context-style) | `RIGHT` | Landscape reads naturally for single-boundary diagrams with a few peers |

Override per-diagram when the pick isn't what you want:

```bash
# Typical: let the heuristic decide
make image-sample                                        # produce build/*.drawio
make drawio-layout INPUT=build/c4-context.drawio         # → (direction=RIGHT, auto)
make drawio-layout INPUT=build/c4-container.drawio       # → (direction=DOWN, auto)

# Force a specific direction
make drawio-layout INPUT=build/foo.drawio DIRECTION=DOWN   # portrait
make drawio-layout INPUT=build/foo.drawio DIRECTION=RIGHT  # landscape

# Separate output file
make drawio-layout INPUT=build/foo.drawio OUTPUT=build/foo.laid.drawio

# Direct CLI (same knobs, plus --nodesep/--edgesep/--ranksep tuning)
node src/layout-drawio-cli.mjs build/foo.drawio -o out.drawio --direction=RIGHT --ranksep=150
```

The effective direction is printed on stderr so logs show which pick was used (`(direction=RIGHT, auto)` vs `(direction=DOWN)`).

### Quality & Testing

| Target | Description |
|--------|-------------|
| `make test` | Vitest unit tests — pure logic, seconds |
| `make test-coverage` | Vitest with v8 coverage (80% thresholds) |
| `make integration-test` | Vitest integration tests — real catalyst via `vendor/catalyst/dist/`, real fs; tens of seconds |
| `make action-test` | Shell test for `scripts/action-entrypoint.sh` (INPUT_* → CLI arg mapping) |
| `make e2e` | End-to-end: convert `sample/example.puml` via built Docker image, assert output contains `mxGraphModel`; minutes on first build |
| `make lint` | `node --check` JS + hadolint (Dockerfile) + shellcheck (scripts) |
| `make lint-docker` | Hadolint only |
| `make lint-shell` | Shellcheck on `scripts/*.sh` |
| `make mermaid-lint` | Validate Mermaid diagrams in markdown via pinned `minlag/mermaid-cli` |
| `make vulncheck` | `pnpm audit --audit-level=moderate` |
| `make trivy-fs` | Trivy filesystem scan (CRITICAL/HIGH, exit non-zero on findings) |
| `make static-check` | `lint` + `vulncheck` + `trivy-fs` + `mermaid-lint` composite gate |

### CI

| Target | Description |
|--------|-------------|
| `make ci` | Full local CI: static-check + test + integration-test + action-test + e2e |
| `make ci-run` | Execute `.github/workflows/ci.yml` locally via [act](https://github.com/nektos/act) |
| `make renovate-validate` | Validate `renovate.json` via `npx --yes renovate --platform=local` |
| `make release` | Interactive semver tag prompt (main-branch only, validates `vN.N.N`, pushes) |
| `make release-floating-tags VERSION=vX.Y.Z` | Retarget floating `vX` / `vX.Y` tags to the just-released `vX.Y.Z` (run after publish CI is green) |

### Diagnostics

| Target | Description |
|--------|-------------|
| `make deps-check` | Show installed versions of node, pnpm, mise, docker, hadolint, shellcheck, act, trivy, CATALYST_REF |

## CI/CD

One SHA-pinned workflow — `.github/workflows/ci.yml` — covers everything. Triggers: push to `main`, tags `v*`, PRs, and `workflow_call` (reusable).

| Job | Needs | Purpose |
|-----|-------|---------|
| `static-check` | — | `make static-check` — lint (JS + hadolint + shellcheck) + pnpm audit + Trivy fs scan + mermaid-lint |
| `build` | `static-check` | `make build` — Docker image build validation |
| `test` | `static-check` | Vitest with v8 coverage (80% thresholds), artifact upload |
| `integration-test` | `static-check` | `make integration-test` + `make action-test` — vitest against real catalyst + fs, plus shell test of the Action entrypoint shim |
| `e2e` | `build`, `test` | `make e2e` — convert `sample/example.puml` via built image, assert output contains `mxGraphModel` |
| `docker` | `static-check`, `build`, `test` | Single-arch scan build → Trivy image scan (CRITICAL/HIGH blocking) → `--version` smoke test → multi-arch `linux/amd64,linux/arm64` build (push on tags only) → cosign keyless OIDC signing (tags only) → multi-arch manifest verification |
| `ci-pass` | all above | Aggregates `needs.*.result`; fails if any upstream job failed. Single branch-protection gate. |

A separate scheduled workflow (`.github/workflows/action-consumer-test.yml`) runs nightly: it invokes the action via `uses: ./` against a synthetic PlantUML input and asserts the converted output. Not part of `ci-pass`.

Buildkit in-manifest attestations (`provenance: false`, `sbom: false`) stay disabled so the GHCR "OS / Arch" tab renders. Cosign provides the supply-chain signature instead of in-manifest attestations.

Git tags use `vX.Y.Z`; `docker/metadata-action` strips the `v` to produce bare-semver image tags (`X.Y.Z`, `X.Y`, `X`). `:latest` only applies on tag pushes via `flavor: latest=${{ startsWith(github.ref, 'refs/tags/') }}`.

### Required Secrets and Variables

| Name | Type | Used by | How to obtain |
|------|------|---------|---------------|
| `GITHUB_TOKEN` | Secret (auto) | `docker` job — GHCR login, cosign OIDC | Auto-provisioned by GitHub Actions; no manual setup |

No other secrets are required. Cosign uses GitHub OIDC (`id-token: write` job permission) to obtain a short-lived Sigstore certificate — no keys to rotate.

### Verifying a published image

```bash
# multi-arch manifest
docker buildx imagetools inspect ghcr.io/andriykalashnykov/puml2drawio:latest

# cosign signature (tagged releases)
cosign verify ghcr.io/andriykalashnykov/puml2drawio:v1.0.0 \
  --certificate-identity-regexp 'https://github\.com/andriykalashnykov/puml2drawio/.+' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Contributing

Contributions welcome — open a PR. Before submitting, run `make ci` locally and confirm a clean `ci-pass`.

## License

[MIT](LICENSE).
