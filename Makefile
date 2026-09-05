.DEFAULT_GOAL := help
SHELL         := /bin/bash
# Make every recipe run with strict bash semantics: fail on first unset var
# (-u), first error (-e), and first pipe failure (pipefail). Without this,
# multi-line `&&` chains silently swallow errors in non-last commands.
.SHELLFLAGS   := -eu -o pipefail -c

APP_NAME      := puml2drawio
CURRENTTAG    := $(shell git describe --tags --abbrev=0 2>/dev/null || echo "dev")

# Source of truth: .nvmrc (Node major) and CATALYST_REF (pinned catalyst release tag, e.g. v1.3.0)
NODE_VERSION  := $(shell cat .nvmrc 2>/dev/null || echo 24)
CATALYST_REF  := $(shell tr -d '[:space:]' < CATALYST_REF 2>/dev/null)

# === Tool Versions ===
# hadolint, act, trivy, shellcheck and node are pinned in .mise.toml — one
# source of truth for local dev (mise-activated shell) and CI (jdx/mise-action).
# Only tools that mise cannot manage stay pinned in the Makefile.
# Docker image, consumed via `docker run`.
# renovate: datasource=docker depName=minlag/mermaid-cli
MERMAID_CLI_VERSION := 11.17.0
# Docker image, consumed via `docker run`.
# renovate: datasource=docker depName=plantuml/plantuml
PLANTUML_VERSION    := 1.2026.8
# Docker image tag (v-prefixed), consumed via `docker run`.
# renovate: datasource=docker depName=rlespinasse/drawio-export
DRAWIO_EXPORT_TAG   := v4.59.1
# Minimal container used by diagrams-png for chown.
# renovate: datasource=docker depName=alpine
ALPINE_VERSION      := 3.24.1

# Docker coordinates
DOCKER_IMAGE    := $(APP_NAME)
DOCKER_REGISTRY ?= ghcr.io
DOCKER_REPO     ?= andriykalashnykov/$(DOCKER_IMAGE)
DOCKER_TAG      ?= $(CURRENTTAG)
GHCR_USER       ?= andriykalashnykov

# Put mise shims first so tools declared in .mise.toml (hadolint, act, trivy,
# shellcheck, node) are on PATH in every sub-shell even when mise hasn't been
# `eval "$$(mise activate)"`d (fresh terminals, minimal CI containers, act
# runners). Falls back to $HOME/.local/bin for any tool installed there.
# See /makefile skill §5c.
export PATH := $(HOME)/.local/share/mise/shims:$(HOME)/.local/bin:$(PATH)

# Corepack provisions the pnpm version pinned in package.json's `packageManager`
# field on first use of an uncached version (e.g. after a pnpm bump). It prompts
# for interactive download consent by default, which stalls `make deps`. Disable
# the prompt so the (already-pinned, deterministic) download proceeds silently.
export COREPACK_ENABLE_DOWNLOAD_PROMPT := 0

# CI-safe pnpm install (locked in CI, flexible locally)
PNPM_INSTALL := pnpm install $(if $(CI),--frozen-lockfile,)

#help: @ List available tasks
help:
	@echo "Usage: make COMMAND"
	@echo "Commands:"
	@grep -E '[a-zA-Z\.\-]+:.*?@ .*$$' $(MAKEFILE_LIST) | tr -d '#' | awk 'BEGIN {FS = ":.*?@ "}; {printf "\033[32m%-24s\033[0m %s\n", $$1, $$2}'

#deps: @ Install mise-managed tools (node, hadolint, act, trivy, shellcheck), pnpm and build vendored catalyst
deps:
	@if [ -z "$${CI:-}" ] && ! command -v mise >/dev/null 2>&1; then \
		echo "Installing mise (no root required, installs to ~/.local/bin)..."; \
		curl -fsSL https://mise.run | sh; \
		echo ""; \
		echo "mise installed. Activate in your shell, then re-run 'make deps':"; \
		echo '  bash: echo '\''eval "$$(~/.local/bin/mise activate bash)"'\'' >> ~/.bashrc'; \
		echo '  zsh:  echo '\''eval "$$(~/.local/bin/mise activate zsh)"''  >> ~/.zshrc'; \
		exit 0; \
	fi
	@# `mise install` runs in BOTH local (mise shell-activated) and CI (jdx/mise-action
	@# pre-installs mise). Reads .mise.toml — node, hadolint, act, trivy, shellcheck.
	@if command -v mise >/dev/null 2>&1; then \
		mise install; \
	else \
		command -v node >/dev/null 2>&1 || { echo "Error: Node.js >=$(NODE_VERSION) required."; exit 1; }; \
	fi
	@command -v pnpm >/dev/null 2>&1 || { echo "Enabling pnpm via corepack..."; corepack enable pnpm; }
	@command -v git >/dev/null 2>&1 || { echo "Error: git required."; exit 1; }
	@$(PNPM_INSTALL)
	@$(MAKE) --no-print-directory fetch-catalyst

#deps-check: @ Show installed tool versions
deps-check:
	@printf "  %-16s %s\n" "node:" "$$(command -v node >/dev/null 2>&1 && node --version || echo 'NOT installed')"
	@printf "  %-16s %s\n" "pnpm:" "$$(command -v pnpm >/dev/null 2>&1 && pnpm --version || echo 'NOT installed')"
	@printf "  %-16s %s\n" "mise:" "$$(command -v mise >/dev/null 2>&1 && mise --version || echo 'NOT installed')"
	@printf "  %-16s %s\n" "docker:" "$$(command -v docker >/dev/null 2>&1 && docker --version | head -1 || echo 'NOT installed')"
	@printf "  %-16s %s\n" "hadolint:" "$$(command -v hadolint >/dev/null 2>&1 && hadolint --version || echo 'NOT installed')"
	@printf "  %-16s %s\n" "shellcheck:" "$$(command -v shellcheck >/dev/null 2>&1 && shellcheck --version | head -2 | tail -1 || echo 'NOT installed')"
	@printf "  %-16s %s\n" "act:" "$$(command -v act >/dev/null 2>&1 && act --version || echo 'NOT installed')"
	@printf "  %-16s %s\n" "trivy:" "$$(command -v trivy >/dev/null 2>&1 && trivy --version | head -1 || echo 'NOT installed')"
	@printf "  %-16s %s\n" "CATALYST_REF:" "$(CATALYST_REF)"

#require-docker: @ Fail fast when docker CLI is not on PATH
require-docker:
	@command -v docker >/dev/null 2>&1 || { echo "Error: docker required."; exit 1; }

#fetch-catalyst: @ Clone and build catalyst at pinned CATALYST_REF
# Canonical source is AndriyKalashnykov/catalyst. That is the default in
# scripts/fetch-catalyst.sh + Dockerfile, so no CATALYST_REPO override here.
fetch-catalyst:
	@bash scripts/fetch-catalyst.sh

#clean: @ Remove build artefacts (node_modules, coverage, vendored catalyst, build/, dist/)
clean:
	@rm -rf node_modules coverage vendor build dist

#build: @ Install deps and build Docker image
build: deps image-build

#test: @ Run unit tests (vitest)
test: deps
	@pnpm run test

#test-coverage: @ Run tests with v8 coverage report
test-coverage: deps
	@pnpm run test:coverage

#integration-test: @ Run vitest integration tests (real catalyst, real fs)
integration-test: deps
	@test -f vendor/catalyst/dist/catalyst.mjs || { \
		echo "Error: vendor/catalyst/dist/catalyst.mjs not found — run 'make fetch-catalyst'"; \
		exit 1; \
	}
	@pnpm exec vitest run -c vitest.integration.config.mjs

#action-test: @ Test GitHub Action entrypoint shim (scripts/action-entrypoint.sh)
action-test: deps
	@bash test/action-entrypoint.test.sh

#lint: @ Lint JS syntax + Dockerfile + shell scripts
lint: deps lint-docker lint-shell
	@find src test -name '*.mjs' -print0 | xargs -0 -n1 node --check
	@# Guard: shell scripts must be executable. The Write tool creates files
	@# 0644; a 100644 .sh that CI invokes as ./script fails with exit 126.
	@NONEXEC=$$(find scripts test -name '*.sh' -not -perm -u+x 2>/dev/null); \
		[ -z "$$NONEXEC" ] || { echo "Error: non-executable shell scripts:"; echo "$$NONEXEC"; exit 1; }

#lint-docker: @ Lint Dockerfile with hadolint (mise-managed)
lint-docker: deps
	@hadolint Dockerfile

#lint-shell: @ Lint shell scripts with shellcheck (mise-managed)
lint-shell: deps
	@shellcheck scripts/*.sh

#vulncheck: @ Scan pnpm dependencies for known CVEs (moderate+, blocking)
vulncheck: deps
	@pnpm audit --audit-level=moderate

#trivy-fs: @ Scan filesystem for CVEs, secrets, misconfigs (CRITICAL/HIGH) (mise-managed)
trivy-fs: deps
	@# Skip upstream catalyst dev-only subtrees — their dev Dockerfile and
	@# demo-slides package-lock.json are never copied into our runtime image
	@# (.dockerignore excludes vendor/ entirely). Scanning them produces
	@# findings for code we don't ship.
	@trivy fs --scanners vuln,secret,misconfig --severity CRITICAL,HIGH --exit-code 1 \
		--skip-dirs 'vendor/catalyst/.devcontainer' \
		--skip-dirs 'vendor/catalyst/slides' \
		--skip-dirs 'vendor/catalyst/sample' \
		--skip-dirs 'vendor/catalyst/tests' \
		.

#mermaid-lint: @ Validate Mermaid diagrams in markdown files
mermaid-lint: require-docker
	@set -euo pipefail; \
	MD_FILES=$$(grep -lF '```mermaid' README.md CLAUDE.md 2>/dev/null || true); \
	if [ -z "$$MD_FILES" ]; then \
		echo "No Mermaid blocks found — skipping."; \
		exit 0; \
	fi; \
	IMAGE=minlag/mermaid-cli:$(MERMAID_CLI_VERSION); \
	for attempt in 1 2 3; do \
		if docker pull --quiet "$$IMAGE" >/dev/null 2>&1; then break; fi; \
		[ "$$attempt" -eq 3 ] && { echo "Failed to pull $$IMAGE after 3 attempts"; exit 1; }; \
		sleep $$((attempt * 5)); \
	done; \
	FAILED=0; \
	for md in $$MD_FILES; do \
		echo "Validating Mermaid blocks in $$md..."; \
		LOG=$$(mktemp); \
		if docker run --rm -v "$$PWD:/data:ro" \
			"$$IMAGE" \
			-i "/data/$$md" -o "/tmp/$$(basename $$md .md).svg" >"$$LOG" 2>&1; then \
			echo "  ✓ All blocks rendered cleanly."; \
		else \
			echo "  ✗ Parse error in $$md:"; \
			sed 's/^/    /' "$$LOG"; \
			FAILED=$$((FAILED + 1)); \
		fi; \
		rm -f "$$LOG"; \
	done; \
	if [ "$$FAILED" -gt 0 ]; then \
		echo "Mermaid lint: $$FAILED file(s) had parse errors."; \
		exit 1; \
	fi

#static-check: @ Run all static quality checks
static-check: lint vulncheck trivy-fs mermaid-lint examples-check
	@echo "Static check passed."

#examples-check: @ Fail if the committed README example drifted from the converter (run make examples-png to refresh)
# Drift guard for docs/examples/. node src/cli.mjs (vendored catalyst) is
# byte-deterministic for a fixed input — verified — so a plain cmp is safe
# with no false positives and no Docker. A CATALYST_REF bump (or any
# converter change) that alters output fails this until `make examples-png`
# is re-run and docs/examples/ committed. The .drawio is the canonical drift
# signal; the committed PNGs are only ever produced from it by examples-png,
# so guarding the .drawio transitively guards the rendered pair. PNGs are
# NOT byte-checked (plantuml/drawio-export rendering is non-deterministic).
examples-check: deps
	@tmp=$$(mktemp); \
	node src/cli.mjs sample/example.puml -o "$$tmp"; \
	if cmp -s "$$tmp" docs/examples/example.drawio; then \
		rm -f "$$tmp"; echo "examples-check: docs/examples/example.drawio is current"; \
	else \
		rm -f "$$tmp"; \
		echo "FAIL: docs/examples/example.drawio is stale vs the converter — run 'make examples-png' and commit docs/examples/"; \
		exit 1; \
	fi

#image-build: @ Build Docker image (pinned CATALYST_REF)
# Canonical source is AndriyKalashnykov/catalyst; it is the Dockerfile ARG
# CATALYST_REPO default, so no --build-arg override.
# Intentionally NOT prerequisite on `deps`: the Dockerfile's catalyst-builder
# stage clones + builds catalyst from CATALYST_REF itself, so the host's
# vendor/ (produced by `make deps` → fetch-catalyst) is not needed to build
# the image. `make build` runs `deps` first only so host-side unit/integration
# tests have vendor/; the image build is self-contained.
image-build: require-docker
	@docker buildx build --load \
		--build-arg CATALYST_REF=$(CATALYST_REF) \
		--build-arg APK_UPGRADE_BUST=$(shell date -u +%Y%m%d) \
		-t $(DOCKER_IMAGE):$(DOCKER_TAG) \
		$(if $(filter-out dev,$(DOCKER_TAG)),-t $(DOCKER_IMAGE):latest,) .

#image-run: @ Run built image (override with ARGS="diagrams/ -o out/")
# Run under the host UID/GID (overrides the image's USER 10001) so anything
# written to the mounted $PWD lands host-owned. Without this, the container
# user cannot write into a host-owned build/ and the run fails with EACCES.
image-run:
	@docker run --rm --user "$$(id -u):$$(id -g)" \
		-v "$(PWD):/work" -w /work $(DOCKER_IMAGE):$(DOCKER_TAG) $(ARGS)

#image-sample: @ Batch-convert every sample/*.puml via the built image → build/*.drawio
image-sample: image-build
	@mkdir -p build
	@docker run --rm --user "$$(id -u):$$(id -g)" \
		-v "$(PWD):/work" -w /work \
		$(DOCKER_IMAGE):$(DOCKER_TAG) sample -o build/

#puml-png: @ Render PUML → PNG via plantuml (INPUT=<file|dir> OUTPUT_DIR=<dir>, defaults sample → build/png; outputs <stem>.puml.png)
puml-png: require-docker
	@INPUT=$(or $(INPUT),sample) \
		OUTPUT_DIR=$(or $(OUTPUT_DIR),build/png) \
		PLANTUML_IMAGE=plantuml/plantuml:$(PLANTUML_VERSION) \
		bash scripts/puml-to-png.sh

#drawio-png: @ Render drawio → PNG via drawio-export (INPUT=<file|dir> OUTPUT_DIR=<dir>, defaults build → build/png)
drawio-png: require-docker
	@INPUT=$(or $(INPUT),build) \
		OUTPUT_DIR=$(or $(OUTPUT_DIR),build/png) \
		DRAWIO_EXPORT_IMAGE=rlespinasse/drawio-export:$(DRAWIO_EXPORT_TAG) \
		ALPINE_IMAGE=alpine:$(ALPINE_VERSION) \
		bash scripts/drawio-to-png.sh

#drawio-layout: @ Re-layout a drawio via elkjs (INPUT=<file> [OUTPUT=<file>] [DIRECTION=AUTO|DOWN|RIGHT|UP|LEFT], default DIRECTION=AUTO picks per diagram structure)
drawio-layout: deps
	@test -n "$(INPUT)" || { echo "Error: pass INPUT=<path/to/file.drawio>"; exit 2; }
	@node src/layout-drawio-cli.mjs "$(INPUT)" \
		$(if $(OUTPUT),-o "$(OUTPUT)") \
		$(if $(DIRECTION),--direction=$(DIRECTION))

#diagrams-png: @ Render every sample/*.puml side-by-side (expected vs actual) PNGs into build/png/
diagrams-png: image-build
	@PLANTUML_IMAGE=plantuml/plantuml:$(PLANTUML_VERSION) \
		DRAWIO_EXPORT_IMAGE=rlespinasse/drawio-export:$(DRAWIO_EXPORT_TAG) \
		ALPINE_IMAGE=alpine:$(ALPINE_VERSION) \
		DOCKER_IMAGE=$(DOCKER_IMAGE) DOCKER_TAG=$(DOCKER_TAG) \
		bash scripts/diagrams-png.sh

#convert-png: @ Convert PUML → drawio AND render PNG side-by-side in the SAME folder (INPUT=<dir> OUTPUT_DIR=<dir>, defaults sample → build)
# One command, both artefacts in OUTPUT_DIR: <stem>.drawio + <stem>.drawio.png.
# PNG rendering needs the Electron-based drawio-export image (the node runtime
# image has no drawio binary), so it runs as a second containerised pass over
# the just-written .drawio files. INPUT is a directory of .puml (batch/flat;
# drawio-export scans OUTPUT_DIR at depth 1, matching the sample layout).
convert-png: image-build
	@mkdir -p build "$(or $(OUTPUT_DIR),build)"
	@docker run --rm --user "$$(id -u):$$(id -g)" \
		-v "$(PWD):/work" -w /work \
		$(DOCKER_IMAGE):$(DOCKER_TAG) "$(or $(INPUT),sample)" -o "$(or $(OUTPUT_DIR),build)/"
	@INPUT=$(or $(OUTPUT_DIR),build) \
		OUTPUT_DIR=$(or $(OUTPUT_DIR),build) \
		DRAWIO_EXPORT_IMAGE=rlespinasse/drawio-export:$(DRAWIO_EXPORT_TAG) \
		ALPINE_IMAGE=alpine:$(ALPINE_VERSION) \
		bash scripts/drawio-to-png.sh

#examples-png: @ Regenerate the committed README side-by-side example PNGs (sample/example.puml → source vs converted drawio)
# Produces docs/examples/{example.puml.png (plantuml render of the source),
# example.drawio (converted), example.drawio.png (drawio-export render)}.
# Committed so the README can embed a visual before/after; this is the single
# regeneration path — run after a CATALYST_REF bump so the committed PNG never
# drifts from what the converter actually emits.
#
# Conversion runs via `node src/cli.mjs` against the VENDORED catalyst
# (the pinned CATALYST_REF that `make deps` built), NOT the Docker image:
# the image build is unnecessary here, and a stale local image would emit
# pre-fix output. plantuml + drawio-export still need their pinned images.
examples-png: deps require-docker
	@mkdir -p build docs/examples
	@INPUT=sample/example.puml OUTPUT_DIR=docs/examples \
		PLANTUML_IMAGE=plantuml/plantuml:$(PLANTUML_VERSION) \
		bash scripts/puml-to-png.sh
	@node src/cli.mjs sample/example.puml -o docs/examples/example.drawio
	@INPUT=docs/examples/example.drawio OUTPUT_DIR=docs/examples \
		DRAWIO_EXPORT_IMAGE=rlespinasse/drawio-export:$(DRAWIO_EXPORT_TAG) \
		ALPINE_IMAGE=alpine:$(ALPINE_VERSION) \
		bash scripts/drawio-to-png.sh
	@echo "Regenerated docs/examples/: example.puml.png (source) + example.drawio.png (converted)"

#image-push: @ Tag and push image to $(DOCKER_REGISTRY)/$(DOCKER_REPO)
image-push: image-build
	@if [ -n "$${GH_ACCESS_TOKEN:-}" ] && echo "$(DOCKER_REGISTRY)" | grep -q "ghcr.io"; then \
		echo "$$GH_ACCESS_TOKEN" | docker login ghcr.io -u "$(GHCR_USER)" --password-stdin; \
	fi
	@docker tag $(DOCKER_IMAGE):$(DOCKER_TAG) $(DOCKER_REGISTRY)/$(DOCKER_REPO):$(DOCKER_TAG)
	@docker push $(DOCKER_REGISTRY)/$(DOCKER_REPO):$(DOCKER_TAG)

#image-stop: @ Stop any running puml2drawio container
image-stop:
	@docker stop $(APP_NAME) 2>/dev/null || true

#e2e: @ End-to-end test — convert sample/example.puml via built image, assert output
e2e: image-build
	@# Use stdin mode — no host volume mounts, no UID/ownership gymnastics.
	@# Covers the full "Docker image converts PlantUML to draw.io XML" contract
	@# and works identically under act (docker-in-docker path-resolution quirks
	@# make `-v $(PWD):/work` unreliable in nested runners).
	@mkdir -p build
	@out=$$(mktemp) && \
		cat sample/example.puml | docker run --rm -i $(DOCKER_IMAGE):$(DOCKER_TAG) - > "$$out" && \
		test -s "$$out" || { echo "FAIL: empty output"; rm -f "$$out"; exit 1; } && \
		grep -q '<mxfile'      "$$out" || { echo "FAIL: missing <mxfile envelope"; rm -f "$$out"; exit 1; } && \
		grep -q '<mxGraphModel' "$$out" || { echo "FAIL: missing <mxGraphModel"; rm -f "$$out"; exit 1; } && \
		grep -q '<mxCell'      "$$out" || { echo "FAIL: no <mxCell — empty diagram"; rm -f "$$out"; exit 1; } && \
		for label in User API Database; do \
			grep -q "$$label" "$$out" || { echo "FAIL: C4 label '$$label' missing — sample/example.puml content didn't survive conversion"; rm -f "$$out"; exit 1; }; \
		done && \
		mv "$$out" build/sample.drawio
	@echo "E2E passed: build/sample.drawio ($$(wc -c < build/sample.drawio) bytes) carries <mxfile + <mxGraphModel + <mxCell and all three sample C4 labels (User, API, Database)"

#e2e-batch: @ E2E batch test — convert sample/ via built image with bind mount, assert structure + host-owned + fresh output
# Exercises the Docker BATCH path (dir input, -v $PWD bind mount, non-root
# USER 10001 writing host-owned files) that `make e2e` (stdin mode) cannot.
# NOT run under act (`make ci-run`) — nested-container bind mounts are
# unreliable there; the CI `e2e` job invokes this directly on a real runner.
e2e-batch: image-build
	@rm -rf build/e2e-batch && mkdir -p build/e2e-batch
	@before=$$(date +%s); sleep 1; \
	docker run --rm --user "$$(id -u):$$(id -g)" \
		-v "$(PWD):/work" -w /work \
		$(DOCKER_IMAGE):$(DOCKER_TAG) sample -o build/e2e-batch/ ; \
	count=$$(find build/e2e-batch -name '*.drawio' | wc -l); \
	[ "$$count" -ge 1 ] || { echo "FAIL: batch mode produced no .drawio"; exit 1; }; \
	for f in build/e2e-batch/*.drawio; do \
		grep -q '<mxGraphModel' "$$f" || { echo "FAIL: $$f missing <mxGraphModel"; exit 1; }; \
		owner=$$(stat -c '%u' "$$f"); \
		[ "$$owner" = "$$(id -u)" ] || { echo "FAIL: $$f not host-owned (uid $$owner vs $$(id -u)) — bind-mount UID regression"; exit 1; }; \
		mtime=$$(stat -c '%Y' "$$f"); \
		[ "$$mtime" -ge "$$before" ] || { echo "FAIL: $$f mtime predates run — stale/unwritten"; exit 1; }; \
	done; \
	echo "E2E batch passed: $$count .drawio in build/e2e-batch/ — all host-owned, fresh, carry <mxGraphModel"

#e2e-convert-png: @ E2E test for convert-png — assert .drawio AND valid .png land side-by-side, host-owned
# Guards the user-facing convert-png feature: a drawio-export image bump or
# the alpine chown-back regression would otherwise ship silently. Direct on
# the CI runner (Docker-in-Docker), NOT under act.
e2e-convert-png: image-build
	@rm -rf build/e2e-png && mkdir -p build/e2e-png
	@before=$$(date +%s); sleep 1; \
	$(MAKE) --no-print-directory convert-png INPUT=sample OUTPUT_DIR=build/e2e-png >/dev/null; \
	d=$$(find build/e2e-png -name '*.drawio' | wc -l); \
	p=$$(find build/e2e-png -name '*.drawio.png' | wc -l); \
	[ "$$d" -ge 1 ] || { echo "FAIL: convert-png produced no .drawio"; exit 1; }; \
	[ "$$p" -ge 1 ] || { echo "FAIL: convert-png produced no .drawio.png"; exit 1; }; \
	for f in build/e2e-png/*.drawio.png; do \
		owner=$$(stat -c '%u' "$$f"); \
		[ "$$owner" = "$$(id -u)" ] || { echo "FAIL: $$f not host-owned (uid $$owner vs $$(id -u)) — chown-back regression"; exit 1; }; \
		[ "$$(stat -c '%Y' "$$f")" -ge "$$before" ] || { echo "FAIL: $$f stale"; exit 1; }; \
		printf '\x89PNG\r\n\x1a\n' | cmp -s -n 8 - "$$f" || { echo "FAIL: $$f is not a valid PNG (bad magic bytes)"; exit 1; }; \
	done; \
	echo "E2E convert-png passed: $$d .drawio + $$p .drawio.png in build/e2e-png/ — host-owned, fresh, valid PNG signature"

#ci: @ Run full local CI pipeline (static checks + tests + integration + e2e)
ci: deps static-check test integration-test action-test e2e
	@echo "Local CI pipeline passed."

#ci-run: @ Run GitHub Actions workflow (ci.yml) locally via act (mise-managed)
ci-run: deps
	@docker container prune -f 2>/dev/null || true
	@ACT_PORT=$$(shuf -i 40000-59999 -n 1); \
	ARTIFACT_PATH=$$(mktemp -d -t act-artifacts.XXXXXX); \
	act push --workflows .github/workflows/ci.yml \
		--container-architecture linux/amd64 \
		--artifact-server-port "$$ACT_PORT" \
		--artifact-server-path "$$ARTIFACT_PATH"

#renovate-validate: @ Validate Renovate configuration via npx
renovate-validate: deps
	@if [ -n "$${GH_ACCESS_TOKEN:-}" ]; then \
		GITHUB_COM_TOKEN=$$GH_ACCESS_TOKEN npx --yes renovate --platform=local; \
	else \
		echo "Warning: GH_ACCESS_TOKEN not set, some dependency lookups may fail"; \
		npx --yes renovate --platform=local; \
	fi

#release: @ Create and push a new semver tag (interactive, main-branch only)
release:
	@git diff --quiet && git diff --cached --quiet || { echo "Error: working tree has uncommitted changes"; exit 1; }
	@branch=$$(git rev-parse --abbrev-ref HEAD); [ "$$branch" = "main" ] || { echo "Error: must release from main (currently on $$branch)"; exit 1; }
	@bash -c 'read -p "New tag (current: $(CURRENTTAG)): " newtag && \
		echo "$$newtag" | grep -qE "^v[0-9]+\.[0-9]+\.[0-9]+$$" || { echo "Error: tag must match vN.N.N"; exit 1; } && \
		read -p "Create and push $$newtag? [y/N] " ans && [ "$${ans:-N}" = y ] && \
		git tag -a $$newtag -m "$$newtag" && git push origin $$newtag && \
		echo "" && \
		echo "Tag $$newtag pushed. After the publish CI is green, retarget the floating major/minor tags:" && \
		echo "  make release-floating-tags VERSION=$$newtag"'

#release-floating-tags: @ Force-update floating vX and vX.Y tags after a vX.Y.Z release (VERSION=vX.Y.Z)
release-floating-tags:
	@test -n "$(VERSION)" || { echo "Error: pass VERSION=vX.Y.Z (e.g., make release-floating-tags VERSION=v1.0.1)"; exit 1; }
	@echo "$(VERSION)" | grep -qE "^v[0-9]+\.[0-9]+\.[0-9]+$$" || { echo "Error: VERSION must match vN.N.N"; exit 1; }
	@git rev-parse --verify "$(VERSION)" >/dev/null 2>&1 || { echo "Error: tag $(VERSION) does not exist locally; run 'git fetch --tags' first"; exit 1; }
	@major=$$(echo "$(VERSION)" | cut -d. -f1); \
		minor=$$(echo "$(VERSION)" | cut -d. -f1-2); \
		echo "Retargeting $$major and $$minor → $(VERSION)"; \
		git tag -fa "$$major" "$(VERSION)" -m "$$major (latest $$major.x.y)" && \
		git tag -fa "$$minor" "$(VERSION)" -m "$$minor (latest $$minor.x)" && \
		git push --force origin "$$major" "$$minor" && \
		echo "Floating tags $$major and $$minor now point at $(VERSION)."

.PHONY: help deps deps-check require-docker fetch-catalyst clean \
	build test test-coverage integration-test action-test \
	lint lint-docker lint-shell vulncheck trivy-fs mermaid-lint static-check \
	image-build image-run image-sample image-push image-stop puml-png drawio-png drawio-layout diagrams-png convert-png examples-png examples-check e2e e2e-batch e2e-convert-png \
	ci ci-run renovate-validate release release-floating-tags
