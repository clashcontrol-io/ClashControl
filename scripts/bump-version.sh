#!/usr/bin/env bash
# Auto-increment version based on change severity and inject into index.html, README, CHANGELOG
# Called by pre-commit hook — pure bash, no Python dependency
#
# Severity detection:
#   MAJOR — breaking changes: CDN/dependency swaps, reducer shape changes, removed public APIs
#   MINOR — new features: new components, new reducer cases, new UI sections
#   PATCH — everything else: bug fixes, style tweaks, refactors
#
# Override: set BUMP=major|minor|patch before committing to force a level

set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
VERSION_FILE="$REPO_ROOT/version.json"
INDEX_FILE="$REPO_ROOT/index.html"
README_FILE="$REPO_ROOT/README.md"
CHANGELOG_FILE="$REPO_ROOT/CHANGELOG.md"

if [ ! -f "$VERSION_FILE" ]; then
  echo "version.json not found, skipping version bump"
  exit 0
fi

# Check if index.html is being committed
if ! git diff --cached --name-only | grep -q "index.html"; then
  exit 0
fi

# Read current version from version.json (pure bash, no python)
MAJOR=$(grep -o '"major"[[:space:]]*:[[:space:]]*[0-9]*' "$VERSION_FILE" | grep -o '[0-9]*$')
MINOR=$(grep -o '"minor"[[:space:]]*:[[:space:]]*[0-9]*' "$VERSION_FILE" | grep -o '[0-9]*$')
PATCH=$(grep -o '"patch"[[:space:]]*:[[:space:]]*[0-9]*' "$VERSION_FILE" | grep -o '[0-9]*$')
LABEL=$(grep -o '"label"[[:space:]]*:[[:space:]]*"[^"]*"' "$VERSION_FILE" | sed 's/.*: *"//;s/"$//')

# ── Determine bump level from staged diff ──
DIFF=$(git diff --cached -- "$INDEX_FILE")

if [ -n "$BUMP" ]; then
  # Manual override via environment variable
  LEVEL="$BUMP"
  echo "  Version bump forced to: $LEVEL"
else
  LEVEL="patch"

  # MAJOR signals: CDN/dependency swaps or INIT state shape rewrite.
  # Only triggers when a script tag or INIT definition is CHANGED (added AND removed),
  # not when lines are merely moved or new globals are added.
  ADDED_SCRIPTS=$(printf '%s\n' "$DIFF" | grep -cE '^\+.*<script.*(src=|cdn)' || true)
  REMOVED_SCRIPTS=$(printf '%s\n' "$DIFF" | grep -cE '^\-.*<script.*(src=|cdn)' || true)
  ADDED_SCRIPTS=${ADDED_SCRIPTS:-0}
  REMOVED_SCRIPTS=${REMOVED_SCRIPTS:-0}
  if [ "$ADDED_SCRIPTS" -gt 0 ] && [ "$REMOVED_SCRIPTS" -gt 0 ]; then
    LEVEL="major"
  elif echo "$DIFF" | grep -qE '^\+.*var INIT\s*=' && echo "$DIFF" | grep -qE '^\-.*var INIT\s*='; then
    LEVEL="major"
  fi

  # MINOR signals (only upgrade if still patch): new components, new reducer cases
  if [ "$LEVEL" = "patch" ]; then
    if echo "$DIFF" | grep -qE "^\+\s*case '[A-Z_]+'"; then
      LEVEL="minor"
    elif echo "$DIFF" | grep -qE '^\+\s*function [A-Z][a-zA-Z]+\('; then
      LEVEL="minor"
    elif echo "$DIFF" | grep -qE '^\+.*var (STAT|INIT_FILTERS)\['; then
      LEVEL="minor"
    fi
  fi

  echo "  Auto-detected bump level: $LEVEL (from staged diff)"
fi

# Apply bump
case "$LEVEL" in
  major)
    MAJOR=$((MAJOR + 1))
    MINOR=0
    PATCH=0
    ;;
  minor)
    MINOR=$((MINOR + 1))
    PATCH=0
    ;;
  *)
    PATCH=$((PATCH + 1))
    ;;
esac

# Get git short hash and date
GIT_HASH=$(git rev-parse --short HEAD 2>/dev/null || echo "dev")
BUILD_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
HUMAN_DATE=$(date -u +"%Y-%m-%d")

# Build version string
VERSION="${MAJOR}.${MINOR}.${PATCH}"
if [ -n "$LABEL" ]; then
  VERSION="${VERSION}-${LABEL}"
fi

# Update version.json (pure bash)
cat > "$VERSION_FILE" << VJSON
{
  "major": ${MAJOR},
  "minor": ${MINOR},
  "patch": ${PATCH},
  "label": "${LABEL}"
}
VJSON
echo "  Version bumped to $VERSION"

# Inject version into index.html
sed -i "s|var CC_VERSION = .*|var CC_VERSION = {v:'${VERSION}',hash:'${GIT_HASH}',date:'${BUILD_DATE}'};|" "$INDEX_FILE"

# Update README version badge
if [ -f "$README_FILE" ]; then
  if grep -q "^> Version:" "$README_FILE"; then
    sed -i "s|^> Version:.*|> Version: **v${VERSION}** (${HUMAN_DATE})|" "$README_FILE"
  else
    sed -i "1 a\\> Version: **v${VERSION}** (${HUMAN_DATE})" "$README_FILE"
  fi
fi

# Auto-append to CHANGELOG: get the commit message being committed
COMMIT_MSG_FILE="$REPO_ROOT/.git/COMMIT_EDITMSG"
if [ -f "$CHANGELOG_FILE" ] && [ -f "$COMMIT_MSG_FILE" ]; then
  COMMIT_SUBJECT=$(head -1 "$COMMIT_MSG_FILE" | sed 's/^ *//')
  if [ -n "$COMMIT_SUBJECT" ] && ! echo "$COMMIT_SUBJECT" | grep -qi "^merge"; then
    if ! grep -q "^## v${VERSION}" "$CHANGELOG_FILE"; then
      sed -i "/^# Changelog/a\\\\n## v${VERSION} (${HUMAN_DATE})\\n- ${COMMIT_SUBJECT}" "$CHANGELOG_FILE"
    fi
  fi
fi

# Re-stage the modified files
git add "$VERSION_FILE" "$INDEX_FILE"
[ -f "$README_FILE" ] && git add "$README_FILE"
[ -f "$CHANGELOG_FILE" ] && git add "$CHANGELOG_FILE"

echo "  Version: $VERSION (${GIT_HASH}, ${BUILD_DATE})"
