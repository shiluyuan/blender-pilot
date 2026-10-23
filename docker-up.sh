#!/usr/bin/env bash
set -euo pipefail
PILOT_REPO_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' 'Python 3 is required for deployment configuration. On Ubuntu: sudo apt-get install python3' >&2
  exit 1
fi
if ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))'; then
  printf '%s\n' 'Python 3.9 or newer is required.' >&2
  exit 1
fi
exec python3 "$PILOT_REPO_DIR/scripts/deploy.py" "$@"
