#!/usr/bin/env bash
# Auto-increment version based on change severity and inject into index.html, README, CHANGELOG
# Called by pre-commit hook (on main only) or GitHub Actions CI after merge to main.
#
# Modes:
#   Pre-commit (default) — runs on local commits to main; uses staged diff + COMMIT_EDITMSG
#   CI (CI_VERSION_BUMP=1) — runs in GitHub Actions after merge; uses HEAD^..HEAD diff + git log
#
# Severity detection:
#   MAJOR — breaking changes: CDN/dependency swaps, reducer shape changes, removed public APIs
#   MINOR — new features: new components, new reducer cases, new UI sections
#   PATCH — everything else: bug fixes, style tweaks, refactors
#
# Override: set BUMP=major|minor|patch to force a level

set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
VERSION_FILE="$REPO_ROOT/version.json"
INDEX_FILE="$REPO_ROOT/index.html"
README_FILE="$REPO_ROOT/README.md"
CHANGELOG_FILE="$REPO_ROOT/CHANGELOG.md"
SW_FILE="$REPO_ROOT/sw.js"

if [ ! -f "$VERSION_FILE" ]; then
  echo "version.json not found, skipping version bump"
  exit 0
fi

# ── Branch guard (pre-commit mode only) ──────────────────────────
# In CI mode (CI_VERSION_BUMP=1) this guard is bypassed — the workflow
# already ensures we only run on pushes to main.
if [ -z "$CI_VERSION_BUMP" ]; then
  CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "")
  if [ "$CURRENT_BRANCH" != "main" ]; then
    exit 0
  fi
  # Check if index.html is being committed
  if ! git diff --cached --name-only | grep -q "index.html"; then
    exit 0
  fi
fi

# ── Diff source ───────────────────────────────────────────────────
if [ -n "$CI_VERSION_BUMP" ]; then
  # CI: look at what just landed on main
  if ! git diff HEAD^..HEAD --name-only | grep -q "index.html"; then
    echo "  index.html not changed in this merge, skipping version bump"
    exit 0
  fi
  DIFF=$(git diff HEAD^..HEAD -- "$INDEX_FILE")
else
  DIFF=$(git diff --cached -- "$INDEX_FILE")
fi

# ── Read current version ──────────────────────────────────────────
MAJOR=$(grep -o '"major"[[:space:]]*:[[:space:]]*[0-9]*' "$VERSION_FILE" | grep -o '[0-9]*$')
MINOR=$(grep -o '"minor"[[:space:]]*:[[:space:]]*[0-9]*' "$VERSION_FILE" | grep -o '[0-9]*$')
PATCH=$(grep -o '"patch"[[:space:]]*:[[:space:]]*[0-9]*' "$VERSION_FILE" | grep -o '[0-9]*$')
LABEL=$(grep -o '"label"[[:space:]]*:[[:space:]]*"[^"]*"' "$VERSION_FILE" | sed 's/.*: *"//;s/"$//')

# ── Determine bump level ──────────────────────────────────────────
if [ -n "$BUMP" ]; then
  LEVEL="$BUMP"
  echo "  Version bump forced to: $LEVEL"
else
  LEVEL="patch"

  ADDED_SCRIPTS=$(printf '%s\n' "$DIFF" | grep -cE '^\+.*<script.*(src=|cdn)' || true)
  REMOVED_SCRIPTS=$(printf '%s\n' "$DIFF" | grep -cE '^\-.*<script.*(src=|cdn)' || true)
  ADDED_SCRIPTS=${ADDED_SCRIPTS:-0}
  REMOVED_SCRIPTS=${REMOVED_SCRIPTS:-0}
  if [ "$ADDED_SCRIPTS" -gt 0 ] && [ "$REMOVED_SCRIPTS" -gt 0 ]; then
    LEVEL="major"
  elif echo "$DIFF" | grep -qE '^\+.*var INIT\s*=' && echo "$DIFF" | grep -qE '^\-.*var INIT\s*='; then
    LEVEL="major"
  fi

  if [ "$LEVEL" = "patch" ]; then
    if echo "$DIFF" | grep -qE "^\+\s*case '[A-Z_]+'"; then
      LEVEL="minor"
    elif echo "$DIFF" | grep -qE '^\+\s*function [A-Z][a-zA-Z]+\('; then
      LEVEL="minor"
    elif echo "$DIFF" | grep -qE '^\+.*var (STAT|INIT_FILTERS)\['; then
      LEVEL="minor"
    fi
  fi

  echo "  Auto-detected bump level: $LEVEL (from diff)"
fi

# ── Apply bump ────────────────────────────────────────────────────
case "$LEVEL" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  *)     PATCH=$((PATCH + 1)) ;;
esac

GIT_HASH=$(git rev-parse --short HEAD 2>/dev/null || echo "dev")
BUILD_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
HUMAN_DATE=$(date -u +"%Y-%m-%d")

VERSION="${MAJOR}.${MINOR}.${PATCH}"
if [ -n "$LABEL" ]; then VERSION="${VERSION}-${LABEL}"; fi

# ── Write files ───────────────────────────────────────────────────
cat > "$VERSION_FILE" << VJSON
{
  "major": ${MAJOR},
  "minor": ${MINOR},
  "patch": ${PATCH},
  "label": "${LABEL}"
}
VJSON
echo "  Version bumped to $VERSION"

sed -i "s|var CC_VERSION = .*|var CC_VERSION = {v:'${VERSION}',hash:'${GIT_HASH}',date:'${BUILD_DATE}'};|" "$INDEX_FILE"

if [ -f "$README_FILE" ]; then
  if grep -q "^> Version:" "$README_FILE"; then
    sed -i "s|^> Version:.*|> Version: **v${VERSION}** (${HUMAN_DATE})|" "$README_FILE"
  else
    sed -i "1 a\\> Version: **v${VERSION}** (${HUMAN_DATE})" "$README_FILE"
  fi
fi

# ── CHANGELOG entry ───────────────────────────────────────────────
if [ -f "$CHANGELOG_FILE" ]; then
  if [ -n "$CI_VERSION_BUMP" ]; then
    # In CI: use the most recent non-merge commit message from the landed branch
    COMMIT_SUBJECT=$(git log --no-merges -1 --pretty=format:%s 2>/dev/null || echo "")
  else
    COMMIT_MSG_FILE="$REPO_ROOT/.git/COMMIT_EDITMSG"
    COMMIT_SUBJECT=$([ -f "$COMMIT_MSG_FILE" ] && head -1 "$COMMIT_MSG_FILE" | sed 's/^ *//' || echo "")
  fi
  if [ -n "$COMMIT_SUBJECT" ] && ! echo "$COMMIT_SUBJECT" | grep -qi "^merge"; then
    if ! grep -q "^## v${VERSION}" "$CHANGELOG_FILE"; then
      sed -i "/^# Changelog/a\\\\n## v${VERSION} (${HUMAN_DATE})\\n- ${COMMIT_SUBJECT}" "$CHANGELOG_FILE"
    fi
  fi
fi

if [ -f "$SW_FILE" ]; then
  sed -i "s|var CACHE = 'clashcontrol-v[^']*';|var CACHE = 'clashcontrol-v${VERSION}';|" "$SW_FILE"
fi

# ── Re-stage (pre-commit mode only; CI commits separately) ────────
if [ -z "$CI_VERSION_BUMP" ]; then
  git add "$VERSION_FILE" "$INDEX_FILE"
  [ -f "$README_FILE" ] && git add "$README_FILE"
  [ -f "$CHANGELOG_FILE" ] && git add "$CHANGELOG_FILE"
  [ -f "$SW_FILE" ] && git add "$SW_FILE"
fi

echo "  Version: $VERSION (${GIT_HASH}, ${BUILD_DATE})"
