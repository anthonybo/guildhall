#!/bin/sh
#
# Build GuildhallBar.app.
#
#   sh swift/build.sh              build it into swift/.build/GuildhallBar.app
#   sh swift/build.sh --install    and copy it to /Applications
#
# Why a script and not an Xcode project: SwiftPM produces a bare executable, and
# a menu bar app is that executable plus an Info.plist saying "no dock icon".
# That is the entire difference, and it is eleven lines here against several
# thousand lines of generated XML that would conflict on every edit.
#
# The app is NOT code-signed. It runs on the machine that built it, which is the
# only machine it is for. Handing it to somebody else means signing and
# notarising it, and that needs a Developer ID this project does not have.
set -eu
cd "$(dirname "$0")"

swift build -c release

APP=".build/GuildhallBar.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

cp .build/release/GuildhallBar "$APP/Contents/MacOS/GuildhallBar"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>GuildhallBar</string>
	<key>CFBundleIdentifier</key>
	<string>dev.guildhall.bar</string>
	<key>CFBundleExecutable</key>
	<string>GuildhallBar</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>0.1.0</string>
	<key>LSMinimumSystemVersion</key>
	<string>13.0</string>
	<!--
		The whole reason this needs a bundle. Without LSUIElement the app takes a
		dock icon and a menu bar of its own, which is wrong for something whose
		entire interface is one status item.
	-->
	<key>LSUIElement</key>
	<true/>
PLIST

# Where to find guildhall itself, baked in at build time.
#
# The app shells out to `guildhall --set-control-password` so the control password
# is hashed by the one implementation that has always done it, rather than a second
# copy in Swift. It cannot find that by PATH: launchd starts the app with almost no
# environment, so nvm's node is not on it.
#
# Baking absolute paths is honest here — the app is unsigned and built for the
# machine it is built on, which is the same reason it is not distributable.
cat >> "$APP/Contents/Info.plist" <<PATHS
	<key>GHNode</key>
	<string>$(command -v node)</string>
	<key>GHEntry</key>
	<string>$(pwd)/../dist/main.mjs</string>
</dict>
PATHS
echo '</plist>' >> "$APP/Contents/Info.plist"

echo "built $(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")"

if [ "${1:-}" = "--install" ]; then
	# Replace rather than merge: a stale executable inside an existing bundle is a
	# genuinely confusing thing to debug.
	rm -rf /Applications/GuildhallBar.app
	cp -R "$APP" /Applications/GuildhallBar.app
	echo "installed /Applications/GuildhallBar.app"
	echo "open it with: open -a GuildhallBar"
fi
