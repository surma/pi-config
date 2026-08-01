#!/usr/bin/env bash
set -euo pipefail

version="$(pi --version)"
package_dir="${PI_TEST_PACKAGE_DIR:-$HOME/.pi/pkg/pi-$version}"
if [[ ! -d "$package_dir/node_modules/typebox" ]]; then
	printf 'Pi package dependencies not found at %s\n' "$package_dir" >&2
	exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/../.." && pwd)"
tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

mkdir -p "$tmp/extensions/escape-debug" "$tmp/tests" "$tmp/node_modules/@mariozechner"
cp "$repo_dir/extensions/bash-jobs.ts" "$tmp/extensions/"
cp "$repo_dir/extensions/escape-debug/log.ts" "$tmp/extensions/escape-debug/"
cp "$repo_dir/tests/bash-jobs.test.ts" "$tmp/tests/"
ln -s log.ts "$tmp/extensions/escape-debug/log.js"
ln -s "$package_dir" "$tmp/node_modules/@mariozechner/pi-coding-agent"
ln -s "$package_dir/node_modules/typebox" "$tmp/node_modules/typebox"

PI_ESCAPE_DEBUG_LOG="$tmp/escape-debug.log" node --experimental-transform-types --test "$tmp/tests/bash-jobs.test.ts"
