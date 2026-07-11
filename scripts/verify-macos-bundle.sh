#!/usr/bin/env bash
set -euo pipefail

bundle_dir=${1:?"Usage: verify-macos-bundle.sh <bundle-directory>"}
mapfile -t dmgs < <(find "$bundle_dir/dmg" -maxdepth 1 -type f -name '*.dmg' -print)

if [[ ${#dmgs[@]} -ne 1 ]]; then
  echo "Expected one DMG under $bundle_dir/dmg, found ${#dmgs[@]}" >&2
  exit 1
fi

dmg=${dmgs[0]}
mount_dir=$(mktemp -d)

cleanup() {
  hdiutil detach "$mount_dir" -quiet 2>/dev/null || true
  rmdir "$mount_dir" 2>/dev/null || true
}
trap cleanup EXIT

hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mount_dir"

app=$(find "$mount_dir" -maxdepth 1 -type d -name '*.app' -print -quit)
if [[ -z "$app" ]]; then
  echo "No application bundle found in $dmg" >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "$app"
xcrun stapler validate "$app"
spctl --assess --type execute --context context:primary-signature -vv "$app"
