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

# Fail loudly if node is missing, rather than baking an empty <string> into the
# plist. Inside a heredoc, `set -e` never sees the substitution's status.
NODE=$(command -v node || true)
[ -n "$NODE" ] || { echo "node not found on PATH — the app needs it to reach guildhall" >&2; exit 1; }
ENTRY=$(cd .. && pwd)/dist/main.mjs
# The version from the one place that owns it. This was hardcoded 0.1.0 while the
# project was at 0.5.6 — the exact failure CLAUDE.md records about a version that
# "sat at 0.1.0 for 55 commits, which made it useless as a signal".
VER=$(node -p "require('./package.json').version" 2>/dev/null || node -p "require('../package.json').version")

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
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
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
esc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
cat >> "$APP/Contents/Info.plist" <<PATHS
	<key>CFBundleShortVersionString</key>
	<string>$(esc "$VER")</string>
	<key>CFBundleVersion</key>
	<string>$(esc "$VER")</string>
	<key>GHNode</key>
	<string>$(esc "$NODE")</string>
	<key>GHEntry</key>
	<string>$(esc "$ENTRY")</string>
</dict>
PATHS
echo '</plist>' >> "$APP/Contents/Info.plist"

# One line that turns every plist mistake into a build failure instead of an app
# that will not launch and says nothing about why.
plutil -lint "$APP/Contents/Info.plist" >/dev/null

echo "built $(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")"

if [ "${1:-}" = "--install" ]; then
	[ -w /Applications ] || { echo "/Applications is not writable by you" >&2; exit 1; }
	# Quit it first. `rm -rf` on a running bundle leaves Launch Services holding a
	# cached copy, so `open -a` can start the old binary or fail outright.
	pkill -x GuildhallBar 2>/dev/null || true
	# Replace rather than merge: a stale executable inside an existing bundle is a
	# genuinely confusing thing to debug.
	rm -rf /Applications/GuildhallBar.app
	cp -R "$APP" /Applications/GuildhallBar.app
	# Ad-hoc signature so the bundle is well-formed. It buys nothing for
	# distribution — the cdhash changes every build, so any TCC grant is re-prompted
	# — but an unsigned bundle is a different class of odd behaviour to debug.
	codesign --force --sign - --identifier dev.guildhall.bar /Applications/GuildhallBar.app >/dev/null 2>&1 || true
	echo "installed /Applications/GuildhallBar.app"
	echo "open it with: open -a GuildhallBar"
fi
