#!/usr/bin/env bash
# Serve the page to an Android phone over USB and open it in Firefox there.
#
# Usage: scripts/phone.sh [QUERY] [DIR]
#   QUERY  page query string, default "?gl&lab&hud"
#   DIR    a built copy to serve statically (e.g. dist); default is the Vite dev server
#
# The phone reaches the server as localhost through `adb reverse`, so it works without
# Wi-Fi. The screen stays on while this runs. Ctrl+C stops the server, removes the port
# forward and restores the phone's screen settings.
#
# Environment: ANDROID_SERIAL picks a phone when several are attached; PORT (default 5174);
# BROWSER_PKG (default org.mozilla.firefox).
set -euo pipefail

query=${1:-"?gl&lab&hud"}
dir=${2:-}
port=${PORT:-5174}
pkg=${BROWSER_PKG:-org.mozilla.firefox}
cd "$(dirname "$0")/.."

if [[ -z ${ANDROID_SERIAL:-} ]]; then
  mapfile -t devices < <(adb devices | awk 'NR > 1 && $2 == "device" { print $1 }')
  if ((${#devices[@]} != 1)); then
    echo "phone: expected one attached device, found ${#devices[@]}; set ANDROID_SERIAL" >&2
    exit 1
  fi
  export ANDROID_SERIAL=${devices[0]}
fi

stay_on=$(adb shell settings get global stay_on_while_plugged_in | tr -d '\r')
server=""

cleanup() {
  trap - INT TERM EXIT
  echo
  echo "phone: stopping"
  if [[ -n $server ]] && kill -0 "$server" 2>/dev/null; then
    kill "$server" 2>/dev/null || true
    wait "$server" 2>/dev/null || true
  fi
  adb reverse --remove "tcp:$port" 2>/dev/null || true
  if [[ $stay_on == null ]]; then
    adb shell settings delete global stay_on_while_plugged_in >/dev/null || true
  else
    adb shell settings put global stay_on_while_plugged_in "$stay_on" || true
  fi
}
trap cleanup EXIT
trap 'exit 0' INT TERM

if [[ -n $dir ]]; then
  python3 -m http.server "$port" --bind 127.0.0.1 --directory "$dir" &
else
  pnpm exec vite --host 127.0.0.1 --port "$port" --strictPort &
fi
server=$!

for _ in $(seq 100); do
  curl -sf -o /dev/null "http://127.0.0.1:$port/" && break
  kill -0 "$server" 2>/dev/null || { echo "phone: server exited" >&2; exit 1; }
  sleep 0.1
done

adb reverse "tcp:$port" "tcp:$port" >/dev/null
# 3 = stay awake while charging over AC or USB.
adb shell settings put global stay_on_while_plugged_in 3
adb shell input keyevent KEYCODE_WAKEUP
url="http://localhost:$port/$query"
adb shell am start -a android.intent.action.VIEW -d "'$url'" "$pkg" >/dev/null
echo "phone: opened $url on $ANDROID_SERIAL; Ctrl+C to stop"
wait "$server"
