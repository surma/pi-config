#!/usr/bin/env bash
set -euo pipefail

version="$(pi --version)"
package_dir="${PI_TEST_PACKAGE_DIR:-$HOME/.pi/pkg/pi-$version}"
if [[ ! -d "$package_dir/node_modules/@earendil-works/pi-tui" ]]; then
	printf 'Pi package dependencies not found at %s\n' "$package_dir" >&2
	exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

cp "$script_dir"/child.ts "$script_dir"/lifecycle.ts "$script_dir"/lifecycle.test.ts "$script_dir"/live-state.ts "$script_dir"/live-state.test.ts "$script_dir"/rpc-dispatcher.ts "$script_dir"/rpc-dispatcher.test.ts "$script_dir"/ui.ts "$script_dir"/ui.test.ts "$tmp"/
ln -s lifecycle.ts "$tmp/lifecycle.js"
ln -s live-state.ts "$tmp/live-state.js"
mkdir -p "$tmp/node_modules/@mariozechner"
ln -s "$package_dir/node_modules/@earendil-works/pi-tui" "$tmp/node_modules/@mariozechner/pi-tui"

node --experimental-transform-types --test "$tmp/lifecycle.test.ts" "$tmp/live-state.test.ts" "$tmp/rpc-dispatcher.test.ts" "$tmp/ui.test.ts"
