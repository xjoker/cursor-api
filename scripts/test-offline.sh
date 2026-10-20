#!/bin/sh
# Stronger, Linux-only check (SAF-102): run the suite inside an empty network namespace so even
# a guard bypass cannot reach the internet. Needs unprivileged user namespaces (`unshare -rn`).
# Cursor credentials are removed from the environment. Usage: sh scripts/test-offline.sh [files...]
set -eu
cd "$(dirname "$0")/.."
exec unshare -rn sh -c 'ip link set lo up 2>/dev/null || true; exec env -u CURSOR_API_KEY -u CURSOR_TEST_API_KEY node scripts/run-tests.mjs "$@"' sh "$@"
