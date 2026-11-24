# backend-rust local entrypoints.
#
# Intentionally NOT wired into scripts/ci (PLAN.md §6 red line): these targets
# are for `make`-on-a-dev-machine use only. Nothing here deploys or takes
# traffic.

CARGO ?= cargo
NODE ?= node

.DEFAULT_GOAL := help

.PHONY: help build test doc fmt fmt-check lint check check-offline capture clean

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-16s %s\n", $$1, $$2}'

build: ## Build the whole workspace
	$(CARGO) build --workspace

test: ## Run all tests
	$(CARGO) test --workspace

doc: ## Build rustdoc
	$(CARGO) doc --workspace --no-deps

fmt: ## Format all Rust sources
	$(CARGO) fmt --all

fmt-check: ## Verify formatting without writing
	$(CARGO) fmt --all --check

lint: ## Clippy, deny warnings
	$(CARGO) clippy --workspace --all-targets -- -D warnings

check: fmt-check lint test ## Format check + clippy + tests

check-offline: ## Prove the workspace builds without registry access
	$(CARGO) build --workspace --locked --offline
	$(CARGO) test --workspace --locked --offline

capture: ## Regenerate the transit golden corpus from the transit-js oracle
	$(NODE) fixtures/gen-transit-corpus.mjs

clean: ## Remove build artifacts
	$(CARGO) clean
