#!/usr/bin/env bash
# Run the process-level native-RPC suite:
#   PI_TEST_PACKAGE_DIR=/path/to/pi-0.84.1 ./e2e.sh
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
version="$(pi --version)"
package_dir="${PI_TEST_PACKAGE_DIR:-$HOME/.pi/pkg/pi-$version}"
if [[ ! -d "$package_dir/node_modules/@earendil-works/pi-tui" ]]; then
	printf 'Pi package dependencies not found at %s\n' "$package_dir" >&2
	exit 1
fi

PI_TEST_PACKAGE_DIR="$package_dir" PI_SUBAGENT_E2E_ONLY=1 "$script_dir/test.sh" --test-concurrency=4
