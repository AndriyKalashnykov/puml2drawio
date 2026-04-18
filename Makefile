.DEFAULT_GOAL := help
SHELL         := /bin/bash

APP_NAME      := puml2drawio
CURRENTTAG    := $(shell git describe --tags --abbrev=0 2>/dev/null || echo "dev")

# Source of truth: .nvmrc (Node major) and CATALYST_REF (pinned upstream SHA)
NODE_VERSION  := $(shell cat .nvmrc 2>/dev/null || echo 24)
CATALYST_REF  := $(shell tr -d '[:space:]' < CATALYST_REF 2>/dev/null)

# === Tool Versions ===
# hadolint, act, trivy, shellcheck and node are pinned in .mise.toml — one
# source of truth for local dev (mise-activated shell) and CI (jdx/mise-action).
# Only tools that mise cannot manage stay pinned in the Makefile.
# renovate: datasource=docker depName=minlag/mermaid-cli
MERMAID_CLI_VERSION := 11.12.0    # Docker image, consumed via `docker run`
# renovate: datasource=docker depName=plantuml/plantuml
PLANTUML_VERSION    := 1.2026.2   # Docker image, consumed via `docker run`
# renovate: datasource=docker depName=rlespinasse/drawio-export
DRAWIO_EXPORT_TAG   := v4.48.0    # Docker image tag (v-prefixed), consumed via `docker run`
# renovate: datasource=docker depName=alpine
ALPINE_VERSION      := 3.22.0     # Minimal container used by diagrams-png for chown

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

# CI-safe pnpm install (locked in CI, flexible locally)
PNPM_INSTALL := pnpm install $(if $(CI),--frozen-lockfile,)

#help: @ List available tasks
help:
	@echo "Usage: make COMMAND"
	@echo "Commands:"
	@grep -E '[a-zA-Z\.\-]+:.*?@ .*$$' $(MAKEFILE_LIST) | tr -d '#' | awk 'BEGIN {FS = ":.*?@ "}; {printf "\033[32m%-22s\033[0m %s\n", $$1, $$2}'

#deps: @ Install mise-managed tools (node, hadolint, act, trivy, shellcheck), pnpm and build vendored catalyst
deps:
	@if [ -z "$$CI" ] && ! command -v mise >/dev/null 2>&1; then \
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
# Temporarily sourced from AndriyKalashnykov/catalyst (fork) while upstream PRs
# for https://github.com/localgod/catalyst/issues/554 are pending review. Flip
# CATALYST_REPO back to localgod/catalyst once the fixes land upstream.
fetch-catalyst:
	@CATALYST_REPO=https://github.com/AndriyKalashnykov/catalyst.git bash scripts/fetch-catalyst.sh

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
action-test:
	@bash test/action-entrypoint.test.sh

#lint: @ Lint JS syntax + Dockerfile + shell scripts
lint: deps lint-docker lint-shell
	@find src test -name '*.mjs' -print0 | xargs -0 -n1 node --check

#lint-docker: @ Lint Dockerfile with hadolint (mise-managed)
lint-docker: deps
	@hadolint Dockerfile

#lint-shell: @ Lint shell scripts with shellcheck (mise-managed)
lint-shell: deps
	@shellcheck scripts/*.sh

#vulncheck: @ Scan pnpm dependencies for known CVEs (moderate+; informational)
vulncheck: deps
	@# pnpm 10.33 still queries npm's retired /-/npm/v1/security/audits endpoint
	@# (npm migrated to a bulk advisory endpoint; pnpm hasn't caught up yet, see
	@# https://github.com/pnpm/pnpm/issues ). Treat as informational — trivy-fs
	@# below gates the build on real CVEs, secrets, and misconfigs.
	@pnpm audit --audit-level=moderate || echo "note: pnpm audit endpoint returned 410 — trivy-fs is the real CVE gate"

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
	FAILED=0; \
	for md in $$MD_FILES; do \
		echo "Validating Mermaid blocks in $$md..."; \
		LOG=$$(mktemp); \
		if docker run --rm -v "$$PWD:/data" \
			minlag/mermaid-cli:$(MERMAID_CLI_VERSION) \
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
static-check: lint vulncheck trivy-fs mermaid-lint
	@echo "Static check passed."

#image-build: @ Build Docker image (pinned CATALYST_REF)
# CATALYST_REPO mirrors the fetch-catalyst override while upstream PRs are
# pending (see issue #554 on localgod/catalyst). Flip back to the Dockerfile
# default (localgod/catalyst.git) once the fixes land upstream.
image-build: require-docker
	@docker buildx build --load \
		--build-arg CATALYST_REPO=https://github.com/AndriyKalashnykov/catalyst.git \
		--build-arg CATALYST_REF=$(CATALYST_REF) \
		-t $(DOCKER_IMAGE):$(DOCKER_TAG) \
		$(if $(filter-out dev,$(DOCKER_TAG)),-t $(DOCKER_IMAGE):latest,) .

#image-run: @ Run built image (override with ARGS="diagrams/ -o out/")
# Run under the host UID/GID (overrides the image's USER 10001) so anything
# written to the mounted $PWD lands host-owned. Without this, the container
# user cannot write into a host-owned build/ and the run fails with EACCES.
image-run:
	@docker run --rm --user "$$(id -u):$$(id -g)" \
		-v "$(PWD):/work" -w /work $(DOCKER_IMAGE):$(DOCKER_TAG) $(ARGS)

#image-sample: @ Convert sample/example.puml via the built image
image-sample: image-build
	@mkdir -p build
	@docker run --rm --user "$$(id -u):$$(id -g)" \
		-v "$(PWD):/work" -w /work \
		$(DOCKER_IMAGE):$(DOCKER_TAG) sample/example.puml -o build/sample.drawio
	@echo "Output: build/sample.drawio"

#diagrams-png: @ Render every sample/*.puml side-by-side (expected vs actual) PNGs into build/png/
diagrams-png: image-build
	@PLANTUML_IMAGE=plantuml/plantuml:$(PLANTUML_VERSION) \
		DRAWIO_EXPORT_IMAGE=rlespinasse/drawio-export:$(DRAWIO_EXPORT_TAG) \
		ALPINE_IMAGE=alpine:$(ALPINE_VERSION) \
		DOCKER_IMAGE=$(DOCKER_IMAGE) DOCKER_TAG=$(DOCKER_TAG) \
		bash scripts/diagrams-png.sh

#image-push: @ Tag and push image to $(DOCKER_REGISTRY)/$(DOCKER_REPO)
image-push: image-build
	@if [ -n "$$GH_ACCESS_TOKEN" ] && echo "$(DOCKER_REGISTRY)" | grep -q "ghcr.io"; then \
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
		grep -q 'mxGraphModel' "$$out" || { echo "FAIL: output missing mxGraphModel"; rm -f "$$out"; exit 1; } && \
		mv "$$out" build/sample.drawio
	@echo "E2E passed: build/sample.drawio ($$(wc -c < build/sample.drawio) bytes) contains mxGraphModel"

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
renovate-validate:
	@if [ -n "$$GH_ACCESS_TOKEN" ]; then \
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
	image-build image-run image-sample image-push image-stop diagrams-png e2e \
	ci ci-run renovate-validate release release-floating-tags
