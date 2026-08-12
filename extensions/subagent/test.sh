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

sources=(child.ts dispatch-event.ts index.ts ipc.ts ipc-child.ts lifecycle.ts liveness.ts live-state.ts lock.ts owner.ts registry.ts result-store.ts settlement-notifications.ts ui.ts zellij.ts managed-session.ts retained-cleanup-leases.ts zellij-manager.ts)
tests=(guard.test.ts ipc.test.ts ipc-child.test.ts child-bridge.test.ts lifecycle.test.ts liveness.test.ts live-state.test.ts lock.test.ts dispatch-event.test.ts launch.test.ts owner.test.ts registry.test.ts result-store.test.ts settlement-notifications.test.ts tools.test.ts ui.test.ts managed-session.test.ts retained-cleanup-leases.test.ts zellij-guardian.test.ts zellij-manager.test.ts)
cp "${sources[@]/#/$script_dir/}" "${tests[@]/#/$script_dir/}" "$script_dir/zellij-guardian.mjs" "$tmp"/
for source in "${sources[@]}"; do ln -s "$source" "$tmp/${source%.ts}.js"; done
mkdir -p "$tmp/node_modules/@mariozechner" "$tmp/node_modules/@sinclair"
ln -s "$package_dir" "$tmp/node_modules/@mariozechner/pi-coding-agent"
ln -s "$package_dir/node_modules/@earendil-works/pi-tui" "$tmp/node_modules/@mariozechner/pi-tui"
ln -s "$package_dir/node_modules/@earendil-works" "$tmp/node_modules/@earendil-works"
ln -s "$package_dir/node_modules/typebox" "$tmp/node_modules/@sinclair/typebox"

env -u ZELLIJ -u ZELLIJ_PANE_ID -u ZELLIJ_SESSION_NAME \
	node --experimental-transform-types --test "$@" "${tests[@]/#/$tmp/}"
