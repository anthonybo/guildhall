#!/bin/sh
# Fail if docs/ no longer matches what the code renders.
#
# The images are deterministic, so a difference means somebody changed how the app
# looks and did not regenerate — which is how a README quietly starts lying about
# the program. Run `npm run docs` to fix.

set -eu
cd "$(dirname "$0")/.."

before=$(shasum docs/*.svg 2>/dev/null || echo none)
sh tools/make-docs-images.sh >/dev/null
after=$(shasum docs/*.svg)

if [ "$before" != "$after" ]; then
	echo "docs/ images are stale — regenerated them for you. Commit the change." >&2
	exit 1
fi
