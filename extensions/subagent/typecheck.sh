#!/usr/bin/env bash
# Type-check every source and test file. The test runner strips types instead of
# checking them, so a runtime-green suite proves nothing about type correctness.
#
# Set PI_TEST_PACKAGE_DIR to the Pi package directory.
# Set PI_TSC to a tsc command when tsc is not on PATH.
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

cp "$script_dir"/*.ts "$script_dir"/*.mjs "$tmp"/
mkdir -p "$tmp/node_modules/@mariozechner" "$tmp/node_modules/@sinclair"
ln -s "$package_dir" "$tmp/node_modules/@mariozechner/pi-coding-agent"
ln -s "$package_dir/node_modules/@earendil-works/pi-tui" "$tmp/node_modules/@mariozechner/pi-tui"
ln -s "$package_dir/node_modules/@earendil-works" "$tmp/node_modules/@earendil-works"
ln -s "$package_dir/node_modules/typebox" "$tmp/node_modules/@sinclair/typebox"

printf '{"type":"module"}\n' > "$tmp/package.json"
cat > "$tmp/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "esnext",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "types": []
  },
  "include": ["*.ts"]
}
JSON

if [[ -n "${PI_TSC:-}" ]]; then
	# shellcheck disable=SC2086
	exec $PI_TSC -p "$tmp"
fi
if command -v tsc > /dev/null 2>&1; then
	exec tsc -p "$tmp"
fi
if command -v nix > /dev/null 2>&1; then
	exec nix run nixpkgs#typescript -- -p "$tmp"
fi
printf 'No tsc found. Install TypeScript or set PI_TSC.\n' >&2
exit 1
