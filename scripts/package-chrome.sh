#!/bin/sh
# Makes dist/youtube-transcript-chrome.zip for the Chrome Web Store.
set -eu
cd "$(dirname "$0")/.."
version=$(node -p "require('./extension/manifest.json').version")
mkdir -p dist
out="dist/youtube-transcript-chrome-$version.zip"
rm -f "$out"
(cd extension && zip -qr "../$out" . -x '.*')
echo "Wrote $out"
