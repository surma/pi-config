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

mkdir -p "$tmp/extensions/lib" "$tmp/extensions/escape-debug" "$tmp/tests/goal"
cp "$repo_dir/extensions/goal.ts" "$tmp/extensions/"
cp "$repo_dir/extensions/lib/goal-continuation.ts" "$tmp/extensions/lib/"
cp "$repo_dir/extensions/escape-debug/log.ts" "$tmp/extensions/escape-debug/"
cp "$script_dir/continuation.test.ts" "$script_dir/wiring.test.ts" "$tmp/tests/goal/"
ln -s goal-continuation.ts "$tmp/extensions/lib/goal-continuation.js"
ln -s log.ts "$tmp/extensions/escape-debug/log.js"
ln -s "$package_dir/node_modules" "$tmp/node_modules"

PI_ESCAPE_DEBUG_LOG="$tmp/escape-debug.log" node --experimental-transform-types --test \
	"$tmp/tests/goal/continuation.test.ts" \
	"$tmp/tests/goal/wiring.test.ts"
