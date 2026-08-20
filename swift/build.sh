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

# The Finder icon, built before the Info.plist is closed so its key can go inside.
#
# Allowed to fail without failing the build: the icon is a nicety, and an older
# macOS without the symbol should still get a working app. But when it works it
# matters more than it sounds — with no icon the bundle is a blank sheet in
# /Applications and shows nothing in Spotlight, so when the menu bar item goes away
# there is no obvious thing to click to get it back.
ICON_KEY=""
if command -v iconutil >/dev/null 2>&1; then
	ICONSET=".build/GuildhallBar.iconset"
	rm -rf "$ICONSET"
	if swiftc -O -o .build/make-icon icon.swift >/dev/null 2>&1 &&
		.build/make-icon "$ICONSET" >/dev/null 2>&1 &&
		iconutil -c icns "$ICONSET" -o .build/AppIcon.icns >/dev/null 2>&1; then
		mkdir -p "$APP/Contents/Resources"
		cp .build/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
		ICON_KEY="	<key>CFBundleIconFile</key>
	<string>AppIcon</string>"
	else
		echo "note: could not build the app icon, continuing without one" >&2
	fi
fi

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
$ICON_KEY
</dict>
PATHS
echo '</plist>' >> "$APP/Contents/Info.plist"

# One line that turns every plist mistake into a build failure instead of an app
# that will not launch and says nothing about why.
plutil -lint "$APP/Contents/Info.plist" >/dev/null

echo "built $(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")"

if [ "${1:-}" = "--install" ]; then
	[ -w /Applications ] || { echo "/Applications is not writable by you" >&2; exit 1; }
	# Take the launchd job down for the duration, not just the process.
	#
	# `pkill` is an abnormal exit, and the agent now restarts on those — deliberately,
	# because a bundle replaced under a running app gets the process SIGKILLed for an
	# invalid code signature and the icon used to just vanish until the next login. The
	# consequence is that pkill alone would have launchd relaunch the app in the middle
	# of `rm -rf`/`cp -R` and start a half-copied binary. Booting the job out first
	# makes the window empty, and it is bootstrapped again at the end.
	LABEL="gui/$(id -u)/dev.guildhall.bar"
	AGENT="$HOME/Library/LaunchAgents/dev.guildhall.bar.plist"
	RELOAD=no
	if launchctl print "$LABEL" >/dev/null 2>&1; then
		launchctl bootout "$LABEL" 2>/dev/null || true
		RELOAD=yes
	fi
	# And any copy started by hand, which launchd knows nothing about.
	pkill -x GuildhallBar 2>/dev/null || true
	# Replace rather than merge: a stale executable inside an existing bundle is a
	# genuinely confusing thing to debug.
	rm -rf /Applications/GuildhallBar.app
	cp -R "$APP" /Applications/GuildhallBar.app
	# Ad-hoc signature so the bundle is well-formed. It buys nothing for
	# distribution — the cdhash changes every build, so any TCC grant is re-prompted
	# — but an unsigned bundle is a different class of odd behaviour to debug.
	codesign --force --sign - --identifier dev.guildhall.bar /Applications/GuildhallBar.app >/dev/null 2>&1 || true

	# Tell Launch Services the bundle changed, so Finder picks up the icon and
	# Spotlight can find it. Without this the old blank icon can persist from cache,
	# and `open -a` may still resolve the bundle that was just deleted.
	LSREG=/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister
	[ -x "$LSREG" ] && "$LSREG" -f /Applications/GuildhallBar.app >/dev/null 2>&1 || true

	# Bring it back, UNLESS the caller said it will.
	#
	# The bootout above always happens — it is what makes the window safe, since a
	# bundle replaced under a running app gets the process SIGKILLed. Only the
	# re-bootstrap is conditional: install-mac.sh installs the plist and loads the job
	# right after calling this, and with both of us bootstrapping, the job was
	# bootstrapped twice. launchd answers a bootstrap for an already-loaded label with
	# `Bootstrap failed: 5: Input/output error`. It was intermittent because `bootout`
	# returns before the job is really gone — a GUI app still has to finish quitting —
	# so it failed only for whoever's app was slower to exit.
	if [ "$RELOAD" = yes ] && [ "${2:-}" != "--no-reload" ] && [ -f "$AGENT" ]; then
		launchctl bootstrap "gui/$(id -u)" "$AGENT" 2>/dev/null || true
	fi
	echo "installed /Applications/GuildhallBar.app"
	echo "open it with: open -a GuildhallBar, or double-click it in /Applications"
fi
