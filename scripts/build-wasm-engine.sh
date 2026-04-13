#!/usr/bin/env bash
# ── Build WASM Clash Engine ────────────────────────────────────
# Compiles the Rust engine to WebAssembly and places output in addons/
#
# Usage:
#   ./scripts/build-wasm-engine.sh           # release build
#   ./scripts/build-wasm-engine.sh --dev     # debug build (faster compile, larger binary)
#
# Prerequisites:
#   - Rust toolchain (rustup.rs)
#   - wasm-pack (cargo install wasm-pack)
#   - wasm32-unknown-unknown target (rustup target add wasm32-unknown-unknown)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENGINE_DIR="$PROJECT_DIR/engine"
OUT_DIR="$PROJECT_DIR/addons/wasm-engine-pkg"

# ── Check prerequisites ─────────────────────────────────────────

if ! command -v rustc &>/dev/null; then
  echo "✗ Rust not found. Install: https://rustup.rs"
  exit 1
fi

if ! command -v wasm-pack &>/dev/null; then
  echo "→ Installing wasm-pack..."
  cargo install wasm-pack
fi

if ! rustup target list --installed | grep -q wasm32-unknown-unknown; then
  echo "→ Adding wasm32-unknown-unknown target..."
  rustup target add wasm32-unknown-unknown
fi

# ── Build mode ──────────────────────────────────────────────────

PROFILE="--release"
if [[ "${1:-}" == "--dev" ]]; then
  PROFILE="--dev"
  echo "══════════════════════════════════════════════════"
  echo "  WASM Clash Engine — Debug Build"
  echo "══════════════════════════════════════════════════"
else
  echo "══════════════════════════════════════════════════"
  echo "  WASM Clash Engine — Release Build"
  echo "══════════════════════════════════════════════════"
fi
echo ""

# ── Run tests first ─────────────────────────────────────────────

echo "→ Running Rust tests..."
cd "$ENGINE_DIR"
cargo test --quiet
echo "✓ All tests passed"
echo ""

# ── Build WASM ──────────────────────────────────────────────────

echo "→ Building WASM module..."
wasm-pack build --target web $PROFILE --out-dir "$OUT_DIR"
echo ""

# ── Report ──────────────────────────────────────────────────────

WASM_FILE="$OUT_DIR/clashcontrol_engine_bg.wasm"
if [ -f "$WASM_FILE" ]; then
  WASM_SIZE=$(wc -c < "$WASM_FILE")
  WASM_KB=$((WASM_SIZE / 1024))
  echo "✓ WASM binary: ${WASM_KB} KB ($WASM_FILE)"
  echo "✓ JS glue:     $OUT_DIR/clashcontrol_engine.js"
  echo "✓ TypeScript:   $OUT_DIR/clashcontrol_engine.d.ts"
  echo ""
  echo "Files ready in: $OUT_DIR/"
else
  echo "✗ Build failed — no .wasm output"
  exit 1
fi
