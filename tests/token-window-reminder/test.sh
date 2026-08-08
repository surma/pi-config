#!/usr/bin/env bash
set -euo pipefail

version="$(pi --version)"
package_dir="${PI_TEST_PACKAGE_DIR:-$HOME/.pi/pkg/pi-$version}"
if [[ ! -d "$package_dir/node_modules/@earendil-works/pi-coding-agent" ]]; then
	printf 'Pi package dependencies not found at %s\n' "$package_dir" >&2
	exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/../.." && pwd)"
tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

mkdir -p "$tmp/extensions/lib" "$tmp/tests/token-window-reminder"
cp "$repo_dir/extensions/token-window-reminder.ts" "$tmp/extensions/"
cp "$repo_dir/extensions/lib/compaction-settings.ts" "$tmp/extensions/lib/"
cp "$script_dir/continuation.test.ts" "$tmp/tests/token-window-reminder/"
ln -s token-window-reminder.ts "$tmp/extensions/token-window-reminder.js"
ln -s compaction-settings.ts "$tmp/extensions/lib/compaction-settings.js"
ln -s "$package_dir/node_modules" "$tmp/node_modules"

node --experimental-transform-types --test "$tmp/tests/token-window-reminder/continuation.test.ts"
