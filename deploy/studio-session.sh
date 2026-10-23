#!/bin/bash
set -euo pipefail
# Runner owns the per-project Xvfb/Blender/VNC lifecycle. No Docker socket.
exec node dist/server/apps/runner/index.js
