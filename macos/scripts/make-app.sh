#!/bin/bash
# Assembles build/VibeFox.app from the SwiftPM release build, signs it with the Developer ID
# certificate, and zips it for distribution.
#
# Usage:
#   scripts/make-app.sh                  build + sign + zip
#   scripts/make-app.sh --skip-sign      build only (CI without the certificate)
#   scripts/make-app.sh --notarize       build + sign + notarize + staple + zip
#
# One-time notarization setup (needs an app-specific password from appleid.apple.com):
#   xcrun notarytool store-credentials vibefox-notary \
#     --apple-id <your-apple-id> --team-id CFA9WX4496 --password <app-specific-password>
set -euo pipefail
cd "$(dirname "$0")/.."

IDENTITY="Developer ID Application: Min Li (CFA9WX4496)"
NOTARY_PROFILE="vibefox-notary"
APP=build/VibeFox.app
ZIP=build/VibeFox.zip

swift build -c release

rm -rf "$APP" "$ZIP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$(swift build -c release --show-bin-path)/VibeFox" "$APP/Contents/MacOS/VibeFox"
cp scripts/Info.plist "$APP/Contents/Info.plist"
if [ -f assets/icon.icns ]; then
  cp assets/icon.icns "$APP/Contents/Resources/icon.icns"
  /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string icon" "$APP/Contents/Info.plist" 2>/dev/null || true
fi

if [ "${1:-}" = "--skip-sign" ]; then
  echo "Built $APP (unsigned)"
  exit 0
fi

codesign --force --options runtime \
  --entitlements scripts/entitlements.plist \
  --sign "$IDENTITY" "$APP"
codesign --verify --strict "$APP"

if [ "${1:-}" = "--notarize" ]; then
  ditto -c -k --keepParent "$APP" "$ZIP"
  xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP"
  rm -f "$ZIP"
fi

# Distribution artifact (post-staple when notarizing, so the ticket ships inside).
ditto -c -k --keepParent "$APP" "$ZIP"
echo "Built $APP and $ZIP"
