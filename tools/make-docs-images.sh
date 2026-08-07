#!/bin/sh
# Regenerate the README images. From the repo root:
#
#     sh tools/make-docs-images.sh
#
# Everything is drawn from the fictional office in src/demo.ts, so the images are
# reproducible, contain nobody's real project names or half-finished sentences, and
# change only when the layout does.
#
# tools/shot.ts composites the same layers the terminal does — sprites, monitors
# and level badges are kitty images, so a plain ANSI capture would show only the
# half-block fallback, which looks like a different program.

set -eu
cd "$(dirname "$0")/.."

npx tsx tools/shot.ts --cols 100 --rows 58 -o docs/room.svg
npx tsx tools/shot.ts --cols 72 --rows 40 -o docs/narrow.svg
