#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
port=16080

command -v lsof >/dev/null 2>&1 || {
  printf '%s\n' 'lsof is required to check the development port.' >&2
  exit 1
}

pids=$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN || :)
[ -n "$pids" ] || exit 0

# Check every listener before stopping any process.
for pid in $pids; do
  cwd=$(lsof -a -p "$pid" -d cwd -Fn | sed -n 's/^n//p')
  if [ "$cwd" != "$project_root" ]; then
    printf 'Port %s belongs to another project (PID %s, cwd: %s); refusing to stop it.\n' "$port" "$pid" "$cwd" >&2
    exit 1
  fi
done

printf 'Stopping this project on port %s (PID: %s)...\n' "$port" "$pids"
kill $pids

attempt=0
while lsof -nP -t -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 50 ]; then
    printf 'Port %s was not released within 5 seconds; startup stopped.\n' "$port" >&2
    exit 1
  fi
  sleep 0.1
done
