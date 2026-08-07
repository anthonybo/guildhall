#!/bin/sh
# Fail if web/app.js or web/app.css no longer matches what the sources compile to.
#
# The bundle is a tracked build artifact, so it can disagree with the source it
# was built from — and when it does, the browser draws a different program than
# the terminal. That is exactly what happened to the nameplates: the terminal
# tripled them while the browser kept serving the old 1:1 plates.
#
# Only `npm start` and `npm run build` rebuild it, so anyone who edits the room
# and releases without having run the app ships the stale one. esbuild's output
# is byte-stable for the same input, so a difference here is always a real drift.
# Run `npm run build` to fix.

set -eu
cd "$(dirname "$0")/.."

before=$(shasum web/app.js web/app.css 2>/dev/null || echo none)
npm run --silent build:web
after=$(shasum web/app.js web/app.css)

if [ "$before" != "$after" ]; then
	echo "web/app.js or web/app.css was stale — rebuilt it for you. Commit the change." >&2
	exit 1
fi
