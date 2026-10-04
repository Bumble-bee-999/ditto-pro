#!/bin/sh
# Boots the real Electron app under a virtual display and drives it. Needs: xvfb, a few sample media files.
set -e
cd "$(dirname "$0")/.."
SMOKE_MEDIA=${SMOKE_MEDIA:-$(ls -d /tmp/ditto-test-* | tail -1)}
export SMOKE_MEDIA
UD=$(mktemp -d)
exec xvfb-run -a -s "-screen 0 1700x1000x24" node_modules/electron/dist/electron --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist --disable-dev-shm-usage --use-fake-device-for-media-stream --user-data-dir="$UD" test/smoke.js
