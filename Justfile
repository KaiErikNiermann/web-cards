set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# List recipes
default:
    @just --list

# --- Development setup ---

# Install dependencies
install:
    pnpm install

# --- Development ---

# Start the Vite dev server
dev *flags:
    pnpm dev {{ flags }}

# Serve the page to the USB phone and open it in Firefox; Ctrl+C cleans up
phone query="?gl&lab&hud":
    scripts/phone.sh "{{ query }}"

# Build, then serve the built copy to the USB phone
phone-build query="?gl&lab&hud": build
    scripts/phone.sh "{{ query }}" dist

# --- Library ---

# Typecheck and build into dist/
build:
    pnpm build

# Build a single-file copy
build-single:
    pnpm build:single

# Types, TS/CSS lint, token discipline and markup rules
lint:
    pnpm lint

# Unit tests
test:
    pnpm test

# --- Benchmarks ---

# Desktop browser benchmark
bench *args:
    pnpm bench {{ args }}

# --- Combined ---

# What the pre-push hook runs
check:
    .githooks/pre-push
