#!/bin/sh
# Regenerate the README images. From the repo root:
#
#     sh tools/make-docs-images.sh
#
# Everything is drawn from the fictional office in src/demo.ts, so the images are
# reproducible, contain nobody's real project names or half-finished sentences, and
# change only when the layout does. Images are forced off (GUILDHALL_NO_IMAGES) so
# the room renders in half blocks, which is what an SVG can carry.

set -eu
cd "$(dirname "$0")/.."

render() {
	GUILDHALL_NO_IMAGES=1 COLUMNS="$2" LINES="$3" npx tsx src/main.ts --demo --once 2>/dev/null \
		| python3 tools/ansi-to-svg.py -o "$1"
}

render docs/room.svg 104 40
GUILDHALL_NO_IMAGES=1 COLUMNS=72 LINES=30 npx tsx src/main.ts --demo --once 2>/dev/null \
	| python3 tools/ansi-to-svg.py -o docs/narrow.svg -t "the same office at 72 columns"
