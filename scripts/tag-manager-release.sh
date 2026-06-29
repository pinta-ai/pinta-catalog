#!/usr/bin/env bash
# Create + push a `manager-v<version>` tag pointing at the current origin/main —
# the compatible catalog snapshot a manager release line falls back to.
#
# Usage:
#   scripts/tag-manager-release.sh <version> [--dry-run]
#
#   <version>   manager release line, e.g. 0.1.7 (NOT a prerelease; rc builds
#               collapse onto their line, so tag the line once).
#
# See docs/manager-compat.md.
set -euo pipefail

VERSION="${1:-}"
DRY_RUN=""
for arg in "$@"; do
  [ "$arg" = "--dry-run" ] && DRY_RUN=1
done

if [ -z "$VERSION" ] || [ "$VERSION" = "--dry-run" ]; then
  echo "usage: $0 <version> [--dry-run]   e.g. $0 0.1.7" >&2
  exit 2
fi

# Reject prerelease / leading-v forms — tag the release line only.
if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "error: '$VERSION' must be X.Y.Z with no prerelease suffix or leading 'v'" >&2
  exit 2
fi

TAG="manager-v${VERSION}"

git fetch origin main --quiet
TARGET="$(git rev-parse origin/main)"

if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null 2>&1; then
  echo "error: tag ${TAG} already exists locally — tags are fixed; delete it first if you really mean to move it" >&2
  exit 1
fi
if git ls-remote --exit-code --tags origin "refs/tags/${TAG}" >/dev/null 2>&1; then
  echo "error: tag ${TAG} already exists on origin — refusing to move a published tag" >&2
  exit 1
fi

echo "tag:    ${TAG}"
echo "target: ${TARGET} (origin/main)"

MSG="Manager ${VERSION} compatible catalog snapshot"

if [ -n "$DRY_RUN" ]; then
  echo "(dry-run) would: git tag -a -m \"${MSG}\" ${TAG} ${TARGET} && git push origin ${TAG}"
  exit 0
fi

# Annotated + explicit -m so no editor opens (some git configs force annotation).
git tag -a -m "${MSG}" "${TAG}" "${TARGET}"
git push origin "${TAG}"
echo "pushed ${TAG} -> ${TARGET}"
