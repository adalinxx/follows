#!/bin/sh
# Builds the site follows.social serves: the page from app/ at the root, with
# the library (src/) and the Lattice SDK (vendor/) beside it. In the repository
# the page reaches them as ../src/ and ../vendor/; at the root they are ./.
# /app/ stays as a redirect to /, keeping any #/ link.
#
#   site/build.sh [out]     # default: _site
set -eu
cd "$(dirname "$0")/.."
out="${1:-_site}"
rm -rf "$out"
mkdir -p "$out"
cp -R app/. "$out/"
cp -R src "$out/src"
cp vendor/lattice-sdk.js "$out/vendor/lattice-sdk.js"
rm -rf "$out/vendor/moniker-sdk/.git" "$out/vendor/moniker-sdk/test" "$out/vendor/moniker-sdk/node_modules"

for f in "$out/app.js" "$out/lib.mjs"; do
  sed -e 's#"\.\./vendor/#"./vendor/#g' -e 's#"\.\./src/#"./src/#g' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done
# Nothing the page loads may still climb out of the site.
if grep -n '"\.\./' "$out/app.js" "$out/lib.mjs" "$out/index.html"; then
  echo "build: a path above still leaves the site" >&2; exit 1
fi

mkdir -p "$out/app"
cp site/app-redirect.html "$out/app/index.html"
echo "built $out"
