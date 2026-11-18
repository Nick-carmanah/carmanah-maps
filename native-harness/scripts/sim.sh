#!/bin/bash
# Drive the harness in the iOS simulator from the Mac.
#
#   scripts/sim.sh <simulator-udid> '<command json>' [timeout-seconds]
#
# Writes maps/_harness/command.json into the app's Library/NoCloud, relaunches
# the app (console output to .scratch/console.log), and waits for
# maps/_harness/results/done.json. Results land in the same folder; this
# script copies them to .scratch/results/.
set -euo pipefail
UDID="$1"; CMD="$2"; TIMEOUT="${3:-600}"
BUNDLE=com.carmanahwildfire.mapsharness
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$(xcrun simctl get_app_container "$UDID" "$BUNDLE" data)"
H="$DATA/Library/NoCloud/maps/_harness"
mkdir -p "$H/results" "$HERE/.scratch/results"
rm -f "$H/results/done.json"
printf '%s' "$CMD" > "$H/command.json"
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
( xcrun simctl launch --console-pty "$UDID" "$BUNDLE" > "$HERE/.scratch/console.log" 2>&1 & )
start=$(date +%s)
until [ -f "$H/results/done.json" ]; do
  if [ $(( $(date +%s) - start )) -gt "$TIMEOUT" ]; then echo "timed out"; exit 1; fi
  perl -e 'select(undef,undef,undef,1)'
done
cp "$H"/results/*.json "$HERE/.scratch/results/"
echo "done in $(( $(date +%s) - start )) s"
ls -t "$H/results" | head -8
