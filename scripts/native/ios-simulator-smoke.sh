#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
EVIDENCE="$ROOT/native-evidence"
mkdir -p "$EVIDENCE"
xcodebuild -version | tee "$EVIDENCE/xcode-version.txt"
python3 - "$EVIDENCE/xcode-version.txt" <<'PY'
import pathlib,re,sys
text=pathlib.Path(sys.argv[1]).read_text()
match=re.search(r'Xcode (\d+)',text)
assert match and int(match[1])>=26, 'Capacitor 8 requires Xcode 26+'
PY
xcrun simctl list devices available -j > "$EVIDENCE/simulators.json"
DEVICE=$(python3 - "$EVIDENCE/simulators.json" <<'PY'
import json,sys
data=json.load(open(sys.argv[1]))['devices']
for runtime in sorted(data,reverse=True):
    if '.iOS-' not in runtime: continue
    for device in data[runtime]:
        if device.get('isAvailable') and device['name'].startswith('iPhone'):
            print(device['udid']);sys.exit(0)
raise SystemExit('No available iPhone simulator in the selected Xcode image')
PY
)
printf '%s\n' "$DEVICE" > "$EVIDENCE/simulator-udid.txt"
xcrun simctl bootstatus "$DEVICE" -b | tee "$EVIDENCE/simulator-boot.txt"
APP="$RUNNER_TEMP/tcghub-derived/Build/Products/Debug-iphonesimulator/App.app"
test -s "$APP/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist" | grep -Fx 'kr.tcghub.app'
xcrun simctl install "$DEVICE" "$APP"
xcrun simctl launch --terminate-running-process "$DEVICE" kr.tcghub.app | tee "$EVIDENCE/launch.txt"
PID=$(awk -F ': ' '/kr\.tcghub\.app:/{print $2}' "$EVIDENCE/launch.txt" | tr -d '\r')
test -n "$PID"
sleep 12
kill -0 "$PID"
xcrun simctl spawn "$DEVICE" log show --last 2m --style compact --predicate 'process == "App"' > "$EVIDENCE/runtime.log" || true
xcrun simctl io "$DEVICE" screenshot "$EVIDENCE/ios-home.png"
# A harmless app-scheme URL checks native dispatch without consuming an OAuth
# code or creating/deleting accounts. Unrelated app URLs must be ignored.
xcrun simctl openurl "$DEVICE" 'kr.tcghub.app://unrelated?source=native-validation'
sleep 3
kill -0 "$PID"
python3 - "$EVIDENCE" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1])
d={'unsignedSimulatorBuild':True,'installed':True,'launched':True,'processAliveAfterInitialLoad':True,'unrelatedDeepLinkDidNotTerminateApp':True,'physicalDevice':False,'oauthProviderSignIn':False,'screenAssertions':False}
(p/'ios-smoke-result.json').write_text(json.dumps(d,indent=2)+'\n')
print(json.dumps(d))
PY
