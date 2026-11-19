#!/usr/bin/env bash
# Export only committed source. Never package .env, data volumes or local evidence.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
[[ $# == 1 ]] || { echo "Usage: $0 OUTPUT_DIRECTORY" >&2; exit 2; }
version=$(cat VERSION)
revision=$(git rev-parse HEAD)
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo "Commit the release inputs before packaging." >&2
  exit 1
fi
mkdir -p "$1"
archive="$1/kbchat-$version-source.tar.gz"
[[ ! -e "$archive" ]] || { echo "Archive already exists: $archive" >&2; exit 1; }
git archive --format=tar --prefix="kbchat-$version/" HEAD | gzip -n > "$archive"
printf 'version=%s\ncommit=%s\n' "$version" "$revision" > "$1/RELEASE.txt"
(cd "$1" && shasum -a 256 "kbchat-$version-source.tar.gz" > SHA256SUMS)
echo "Created $archive at commit $revision"
