#!/usr/bin/env bash
# ── Build WASM Clash Engine ────────────────────────────────────
# Compiles the Rust engine to WebAssembly and places output in addons/
#
# Usage:
#   ./scripts/build-wasm-engine.sh           # release build
#   ./scripts/build-wasm-engine.sh --dev     # debug build (faster compile, larger binary)
#   ./scripts/build-wasm-engine.sh --check   # rebuild into a temp dir and fail if it
#                                            # differs from the committed pkg (CI)
#
# Reproducible by construction: the rustc version is pinned in
# engine/rust-toolchain.toml, dependency versions in engine/Cargo.lock (committed),
# and wasm-pack / wasm-bindgen below. The output does not depend on the checkout path.
#
# Prerequisites:
#   - rustup (rustup.rs) — the pinned toolchain + wasm32 target install on first use
#   - wasm-pack $WASM_PACK_VERSION (cargo install wasm-pack --locked --version $WASM_PACK_VERSION)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENGINE_DIR="$PROJECT_DIR/engine"
PKG_DIR="$PROJECT_DIR/addons/wasm-engine-pkg"
OUT_DIR="$PKG_DIR"
WASM_PACK_VERSION="0.15.0"
PKG_FILES="clashcontrol_engine.js clashcontrol_engine_bg.wasm clashcontrol_engine.d.ts clashcontrol_engine_bg.wasm.d.ts"

# ── Check prerequisites ─────────────────────────────────────────

if ! command -v rustc &>/dev/null; then
  echo "✗ Rust not found. Install: https://rustup.rs"
  exit 1
fi

if ! wasm-pack --version 2>/dev/null | grep -q " $WASM_PACK_VERSION"; then
  echo "→ Installing wasm-pack $WASM_PACK_VERSION..."
  cargo install wasm-pack --locked --version "$WASM_PACK_VERSION"
fi

# ── Build mode ──────────────────────────────────────────────────

PROFILE="--release"
CHECK=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK=1
  OUT_DIR="$(mktemp -d)"
fi
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
wasm-pack build --target web $PROFILE --out-dir "$OUT_DIR" --out-name clashcontrol_engine
# wasm-pack also writes package.json/README/.gitignore ('*'); the app only loads these four.
find "$OUT_DIR" -maxdepth 1 -type f | while read -r f; do
  case " $PKG_FILES " in *" $(basename "$f") "*) ;; *) rm -f "$f" ;; esac
done
echo ""

if [[ $CHECK -eq 1 ]]; then
  status=0
  for f in $PKG_FILES; do
    if cmp -s "$OUT_DIR/$f" "$PKG_DIR/$f"; then echo "✓ $f matches"; else echo "✗ $f differs from the committed pkg"; status=1; fi
  done
  rm -rf "$OUT_DIR"
  [[ $status -eq 0 ]] || { echo "Rebuild the pkg with ./scripts/build-wasm-engine.sh and commit it."; exit 1; }
  exit 0
fi

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
