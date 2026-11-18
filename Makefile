PNPM ?= pnpm

.DEFAULT_GOAL := help

.PHONY: help install ci ensure-deps dev start lint typecheck test test-api build check migrate-nodes

help:
	@printf '%s\n' \
	  'make install              Install dependencies' \
	  'make ci                   Install dependencies from the lockfile' \
	  'make dev                  Restart this project on port 16080' \
	  'make start                Start production server (build first)' \
	  'make lint                 Run ESLint' \
	  'make typecheck            Run TypeScript checks' \
	  'make test                 Run unit and route tests' \
	  'make test-api             Run API smoke tests (server required)' \
	  'make build                Build production assets' \
	  'make check                Run lint, typecheck, tests and build' \
	  'make migrate-nodes SOURCE=/absolute/path/to/workflow-zjt' \
	  '                          Re-extract workflow node source snapshots'

install:
	$(PNPM) install

ci:
	$(PNPM) install --frozen-lockfile

ensure-deps:
	@if [ ! -x node_modules/.bin/next ]; then \
	  printf '%s\n' 'Dependencies are missing; installing from pnpm-lock.yaml...'; \
	  $(PNPM) install --frozen-lockfile; \
	fi

dev start lint typecheck test test-api build: ensure-deps

dev:
	sh scripts/free-dev-port.sh
	$(PNPM) run dev

start:
	$(PNPM) run start

lint:
	$(PNPM) run lint

typecheck:
	$(PNPM) run typecheck

test:
	$(PNPM) run test

test-api:
	$(PNPM) run test:api

build:
	$(PNPM) run build

check:
	$(MAKE) lint
	$(MAKE) typecheck
	$(MAKE) test
	$(MAKE) build

migrate-nodes:
	@test -n "$(SOURCE)" || { printf '%s\n' 'Usage: make migrate-nodes SOURCE=/absolute/path/to/workflow-zjt' >&2; exit 2; }
	$(PNPM) run migrate:nodes --source="$(SOURCE)"
