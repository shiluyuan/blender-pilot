#!/bin/sh
set -eu
exec "$(dirname "$0")/../docker-up.sh" --configure-only "$@"
