#!/bin/bash
set -euo pipefail
children=()
cleanup() {
  trap - TERM INT EXIT
  for pid in "${children[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  wait || true
}
trap cleanup TERM INT EXIT
# X is reachable only inside the studio container.
rm -f "/tmp/.X${DISPLAY#:}-lock" "/tmp/.X11-unix/X${DISPLAY#:}"
Xvfb "$DISPLAY" -screen 0 "${PILOT_RESOLUTION:-1440x900x24}" -ac -nolisten tcp & children+=("$!")
node -e 'const net=require("net"); let n=0; const check=()=>{const s=net.connect("/tmp/.X11-unix/X"+process.env.DISPLAY.slice(1)); s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>{if(++n>100)process.exit(1);setTimeout(check,200)});};check();'
openbox --sm-disable & children+=("$!")
blender --factory-startup -noaudio --window-fullscreen --python /opt/pilot/bootstrap.py & children+=("$!")
node -e 'const net=require("net"); let n=0; const check=()=>{const s=net.connect(9876,"127.0.0.1");s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>{if(++n>300)process.exit(1);setTimeout(check,200)});};check();'
x11vnc -display "$DISPLAY" -forever -shared -nopw -listen 127.0.0.1 -rfbport 5900 -noxdamage -quiet & children+=("$!")
node dist/server/apps/runner/index.js & children+=("$!")
# A failed desktop/Blender/runner restarts the whole consistent execution unit.
wait -n "${children[@]}"
exit 1
