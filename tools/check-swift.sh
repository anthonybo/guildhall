#!/bin/sh
#
# Build the menu bar app, so a Swift compile error cannot pass the commit hook.
#
# `npm run check` covered src/ and web/ and knew nothing about swift/. The whole
# component was unchecked: a compile error, a data race the Swift 6 mode rejects,
# and a pile of warnings all went in without a gate noticing. The Swift 6 language
# mode is set in Package.swift, so concurrency mistakes fail here rather than
# being mentioned in output nobody reads.
#
# Skipped, not failed, where there is no toolchain — a Linux CI box or a machine
# without Xcode should still be able to check the parts it has.
set -eu
cd "$(dirname "$0")/.."

if ! command -v swift >/dev/null 2>&1; then
	echo "swift: no toolchain, skipping the menu bar app"
	exit 0
fi

# -warnings-as-errors so the next one is impossible to ignore. The app builds clean
# today, which is the only honest moment to turn this on.
if swift build --package-path swift -Xswiftc -warnings-as-errors 2>&1 | grep -E "error|warning:"; then
	echo "swift: build produced errors or warnings"
	exit 1
fi
echo "swift: builds clean"
