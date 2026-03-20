#!/usr/bin/env bash
# Auto-increment patch version and inject into index.html
# Called by pre-commit hook

set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
VERSION_FILE="$REPO_ROOT/version.json"
INDEX_FILE="$REPO_ROOT/index.html"

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
# Replace the CC_VERSION line
sed -i "s|var CC_VERSION = .*|var CC_VERSION = {v:'${VERSION}',hash:'${GIT_HASH}',date:'${BUILD_DATE}'};|" "$INDEX_FILE"

# Re-stage the modified files
git add "$VERSION_FILE" "$INDEX_FILE"

echo "  Version: $VERSION (${GIT_HASH}, ${BUILD_DATE})"
