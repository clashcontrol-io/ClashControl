#!/usr/bin/env bash
# Auto-increment patch version and inject into index.html, README, CHANGELOG
# Called by pre-commit hook

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

# Read current version
MAJOR=$(python3 -c "import json; print(json.load(open('$VERSION_FILE'))['major'])")
MINOR=$(python3 -c "import json; print(json.load(open('$VERSION_FILE'))['minor'])")
PATCH=$(python3 -c "import json; print(json.load(open('$VERSION_FILE'))['patch'])")
LABEL=$(python3 -c "import json; print(json.load(open('$VERSION_FILE')).get('label',''))")

# Increment patch
PATCH=$((PATCH + 1))

# Get git short hash and date
GIT_HASH=$(git rev-parse --short HEAD 2>/dev/null || echo "dev")
BUILD_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
HUMAN_DATE=$(date -u +"%Y-%m-%d")

# Build version string
VERSION="${MAJOR}.${MINOR}.${PATCH}"
if [ -n "$LABEL" ]; then
  VERSION="${VERSION}-${LABEL}"
fi

# Update version.json
python3 -c "
import json
d = json.load(open('$VERSION_FILE'))
d['patch'] = $PATCH
json.dump(d, open('$VERSION_FILE','w'), indent=2)
print('  Version bumped to $VERSION')
"

# Inject version into index.html
sed -i "s|var CC_VERSION = .*|var CC_VERSION = {v:'${VERSION}',hash:'${GIT_HASH}',date:'${BUILD_DATE}'};|" "$INDEX_FILE"

# Update README version badge
if [ -f "$README_FILE" ]; then
  # Update or insert version line after the title
  if grep -q "^> Version:" "$README_FILE"; then
    sed -i "s|^> Version:.*|> Version: **v${VERSION}** (${HUMAN_DATE})|" "$README_FILE"
  else
    sed -i "1 a\\> Version: **v${VERSION}** (${HUMAN_DATE})" "$README_FILE"
  fi
fi

# Auto-append to CHANGELOG: get the commit message being committed
# The commit message is available via .git/COMMIT_EDITMSG during hooks
COMMIT_MSG_FILE="$REPO_ROOT/.git/COMMIT_EDITMSG"
if [ -f "$CHANGELOG_FILE" ] && [ -f "$COMMIT_MSG_FILE" ]; then
  # Read first line of commit message (subject)
  COMMIT_SUBJECT=$(head -1 "$COMMIT_MSG_FILE" | sed 's/^ *//')
  # Skip if it's a merge commit or empty
  if [ -n "$COMMIT_SUBJECT" ] && ! echo "$COMMIT_SUBJECT" | grep -qi "^merge"; then
    # Check if this version header already exists
    if ! grep -q "^## v${VERSION}" "$CHANGELOG_FILE"; then
      # Prepend new entry after the first line (# Changelog)
      sed -i "/^# Changelog/a\\\\n## v${VERSION} (${HUMAN_DATE})\\n- ${COMMIT_SUBJECT}" "$CHANGELOG_FILE"
    fi
  fi
fi

# Re-stage the modified files
git add "$VERSION_FILE" "$INDEX_FILE"
[ -f "$README_FILE" ] && git add "$README_FILE"
[ -f "$CHANGELOG_FILE" ] && git add "$CHANGELOG_FILE"

echo "  Version: $VERSION (${GIT_HASH}, ${BUILD_DATE})"
