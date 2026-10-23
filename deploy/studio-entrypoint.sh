#!/bin/bash
set -euo pipefail
# Initial named-volume ownership only; scene tasks run as uid 1000.
mkdir -p /data /home/pilot /tmp/pilot-runtime
chown 1000:1000 /data /home/pilot /tmp/pilot-runtime
chmod 700 /tmp/pilot-runtime
exec gosu 1000:1000 /opt/pilot/studio-session.sh
