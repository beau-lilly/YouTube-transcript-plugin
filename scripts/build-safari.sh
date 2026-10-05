#!/bin/sh
# Makes an Xcode project that wraps the extension for Safari (macOS and iOS).
# Run on a Mac with Xcode installed. Then open the project in Xcode and run it.
set -eu
cd "$(dirname "$0")/.."

if ! command -v xcrun >/dev/null 2>&1; then
  echo "error: xcrun not found. Run this script on macOS with Xcode installed." >&2
  exit 1
fi

bundle_id="${BUNDLE_ID:-com.example.youtube-transcript}"

xcrun safari-web-extension-converter extension \
  --project-location safari \
  --app-name "YouTube Transcript" \
  --bundle-identifier "$bundle_id" \
  --swift \
  --copy-resources \
  --no-open \
  --force

echo "Wrote safari/YouTube Transcript/. Open the .xcodeproj in Xcode and run the macOS or iOS scheme."
