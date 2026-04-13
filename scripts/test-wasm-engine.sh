#!/usr/bin/env bash
# ── Test WASM Clash Engine ─────────────────────────────────────
# Runs all test levels:
#   1. Rust unit tests (cargo test) — fast, no browser needed
#   2. WASM build verification — ensures wasm-pack succeeds
#   3. Binary size check — fails if WASM exceeds size budget
#
# Usage:
#   ./scripts/test-wasm-engine.sh           # all tests
#   ./scripts/test-wasm-engine.sh --quick   # Rust tests only (no WASM build)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENGINE_DIR="$PROJECT_DIR/engine"
OUT_DIR="$PROJECT_DIR/addons/wasm-engine-pkg"
MAX_WASM_KB=100  # fail if .wasm exceeds this (currently ~35 KB)

QUICK=false
if [[ "${1:-}" == "--quick" ]]; then
  QUICK=true
fi

echo "══════════════════════════════════════════════════"
echo "  WASM Clash Engine Tests"
echo "══════════════════════════════════════════════════"
echo ""

PASS=0
FAIL=0

# ── 1. Rust unit tests ──────────────────────────────────────────

echo "── Rust unit tests ────────────────────────────────"
cd "$ENGINE_DIR"
if cargo test 2>&1; then
  PASS=$((PASS + 1))
  echo "✓ Rust unit tests passed"
else
  FAIL=$((FAIL + 1))
  echo "✗ Rust unit tests FAILED"
fi
echo ""

if $QUICK; then
  echo "── Quick mode: skipping WASM build tests ─────────"
  echo ""
  echo "Results: $PASS passed, $FAIL failed"
  exit $FAIL
fi

# ── 2. WASM build ───────────────────────────────────────────────

echo "── WASM build verification ────────────────────────"
if wasm-pack build --target web --release --out-dir "$OUT_DIR" 2>&1; then
  PASS=$((PASS + 1))
  echo "✓ WASM build succeeded"
else
  FAIL=$((FAIL + 1))
  echo "✗ WASM build FAILED"
fi
echo ""

# ── 3. Binary size check ───────────────────────────────────────

echo "── Binary size check ──────────────────────────────"
WASM_FILE="$OUT_DIR/clashcontrol_engine_bg.wasm"
if [ -f "$WASM_FILE" ]; then
  WASM_SIZE=$(wc -c < "$WASM_FILE")
  WASM_KB=$((WASM_SIZE / 1024))
  if [ "$WASM_KB" -le "$MAX_WASM_KB" ]; then
    PASS=$((PASS + 1))
    echo "✓ WASM size: ${WASM_KB} KB (budget: ${MAX_WASM_KB} KB)"
  else
    FAIL=$((FAIL + 1))
    echo "✗ WASM size: ${WASM_KB} KB EXCEEDS budget of ${MAX_WASM_KB} KB"
  fi
else
  FAIL=$((FAIL + 1))
  echo "✗ WASM file not found at $WASM_FILE"
fi
echo ""

# ── 4. Verify exported functions ───────────────────────────────

echo "── Export verification ─────────────────────────────"
JS_GLUE="$OUT_DIR/clashcontrol_engine.js"
if [ -f "$JS_GLUE" ]; then
  MISSING=0
  for FN in mesh_intersect mesh_min_distance batch_intersect; do
    if grep -q "export function $FN" "$JS_GLUE"; then
      echo "  ✓ $FN exported"
    else
      echo "  ✗ $FN NOT exported"
      MISSING=$((MISSING + 1))
    fi
  done
  if [ "$MISSING" -eq 0 ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
else
  FAIL=$((FAIL + 1))
  echo "✗ JS glue file not found"
fi
echo ""

# ── Summary ────────────────────────────────────────────────────

echo "══════════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "══════════════════════════════════════════════════"
exit $FAIL
