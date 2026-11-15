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

# Face backends on a phone: fidelity, cross-browser consistency, speed and memory
matrix *flags: build
    uv run bench/matrix.py dist {{ flags }}

# Compare face snapshots with the browser's rendering (target: phone, firefox, chromium)
parity target="phone" *flags: build
    uv run bench/parity.py dist --target {{ target }} {{ flags }}

# Hybrid rendering in desktop Firefox: effects, Lab input and scrolling across handovers
hybrid-check: build
    node bench/hybrid-check.ts

# Erratic scrolling on a phone, frame by frame, a fresh Firefox session per query
scroll-trace serial *flags: build
    uv run bench/scroll_trace.py {{ serial }} dist {{ flags }}

# Whole cards on a phone: CSS, Firefox WebGL and Chrome WebGL, compared pairwise
card-parity serial *flags: build
    uv run bench/card_parity.py dist --serial {{ serial }} {{ flags }}

# --- Combined ---

# What the pre-push hook runs
check:
    .githooks/pre-push
