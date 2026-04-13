#!/usr/bin/env bash
# ── Release Smart Bridge ─────────────────────────────────────────
# Bumps bridge-version.json and pushes to main, which triggers the
# GitHub Actions workflow (.github/workflows/release-smart-bridge.yml)
# to build binaries and publish a GitHub release automatically.
#
# Usage:
#   ./scripts/release-smart-bridge.sh           # bumps patch (0.2.0 → 0.2.1)
#   ./scripts/release-smart-bridge.sh 0.3.0     # set specific version

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
VERSION_FILE="$PROJECT_DIR/bridge-version.json"

# ── Resolve version ──────────────────────────────────────────────

if [ -n "${1:-}" ]; then
  NEW_VERSION="$1"
else
  CURRENT=$(node -p "require('$VERSION_FILE').version")
  # Auto-bump patch
  IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
  NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))"
fi

TAG="bridge-v$NEW_VERSION"

echo "══════════════════════════════════════════════════"
echo "  Smart Bridge Release — $TAG"
echo "══════════════════════════════════════════════════"
echo ""

# ── Confirm ──────────────────────────────────────────────────────

CURRENT_VERSION=$(node -p "require('$VERSION_FILE').version")
echo "  Current: bridge-v$CURRENT_VERSION  →  New: $TAG"
echo ""
read -p "Bump bridge-version.json to $NEW_VERSION and push? [y/N] " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

# ── Update bridge-version.json ───────────────────────────────────

echo "→ Updating bridge-version.json..."
node -e "
  var fs = require('fs');
  fs.writeFileSync('$VERSION_FILE', JSON.stringify({ version: '$NEW_VERSION' }, null, 0) + '\n');
"
echo "  ✓ bridge-version.json → $NEW_VERSION"
echo ""

# ── Commit and push ──────────────────────────────────────────────

echo "→ Committing version bump..."
cd "$PROJECT_DIR"
git add bridge-version.json
git commit -m "chore: bump Smart Bridge to $TAG"
echo "  ✓ Committed"

echo "→ Pushing to main..."
git push origin main
echo "  ✓ Pushed"
echo ""

echo "══════════════════════════════════════════════════"
echo "  ✓ GitHub Actions will now build and publish $TAG"
echo "  Watch: https://github.com/clashcontrol-io/ClashControl/actions"
echo "══════════════════════════════════════════════════"
