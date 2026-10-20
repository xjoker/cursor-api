#!/bin/sh
# Stronger, Linux-only check (SAF-102): run the suite inside an empty network namespace (only lo),
# so even a guard bypass (child without NODE_OPTIONS, worker thread, native binary) cannot reach
# the network. Needs unprivileged user namespaces (`unshare -rn`); CI runs this.
# Credentials are removed first: every CURSOR_* variable and anything named like a key/token/
# secret/password/pepper. Usage: sh scripts/test-offline.sh [files...]
set -eu
cd "$(dirname "$0")/.."
unset_args=""
for name in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | grep -Ei '^CURSOR_|KEY|TOKEN|SECRET|PASSWORD|PEPPER|CREDENTIAL' || true); do
  unset_args="$unset_args -u $name"
done
# shellcheck disable=SC2086
exec unshare -rn sh -c 'ip link set lo up 2>/dev/null || true; exec env '"$unset_args"' node scripts/run-tests.mjs "$@"' sh "$@"
