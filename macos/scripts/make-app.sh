#!/bin/bash
# Assembles build/VibeFox.app from the SwiftPM release build, signs it with the Developer ID
# certificate, and zips it for distribution. See docs/SPARKLE.md for the full auto-update
# story (this script implements it end to end, following the Sparkle-and-Notarization
# pitfalls checklist: monotonic build numbers, notarize->staple->sign order, one feed/app).
#
# Usage:
#   scripts/make-app.sh                  build + sign + zip
#   scripts/make-app.sh --skip-sign      build only (CI without the certificate)
#   scripts/make-app.sh --notarize       build + sign + notarize + staple + Sparkle-sign + zip
#
# One-time setup (see docs/SPARKLE.md for the full walkthrough):
#   1. Notarization credentials (Apple ID app-specific password, NOT your Sparkle key):
#        xcrun notarytool store-credentials vibefox-notary \
#          --apple-id <your-apple-id> --team-id CFA9WX4496 --password <app-specific-password>
#   2. Sparkle signing key (stored in your login Keychain, never touches this repo):
#        ./tools/sparkle-bin/generate_keys
#      Paste the printed public key into scripts/Info.plist's SUPublicEDKey.
set -euo pipefail
cd "$(dirname "$0")/.."

IDENTITY="Developer ID Application: Min Li (CFA9WX4496)"
NOTARY_PROFILE="vibefox-notary"
APP=build/VibeFox.app
ZIP=build/VibeFox.zip
SIGN_UPDATE=tools/sparkle-bin/sign_update

swift build -c release

rm -rf "$APP" "$ZIP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$(swift build -c release --show-bin-path)/VibeFox" "$APP/Contents/MacOS/VibeFox"
cp scripts/Info.plist "$APP/Contents/Info.plist"
if [ -f assets/icon.icns ]; then
  cp assets/icon.icns "$APP/Contents/Resources/icon.icns"
  /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string icon" "$APP/Contents/Info.plist" 2>/dev/null || true
fi

# Monotonic build number (Sparkle pitfall #1) — set on the BUILT bundle only, so the source
# template stays a stable "1" in git and every build gets a fresh, strictly-increasing value.
BUILD_NUMBER="$(scripts/bump-build-number.sh)"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$APP/Contents/Info.plist"

# Sparkle's Swift Package binary framework lands in .build/artifacts; bundle it so the app
# doesn't depend on the dev machine's SPM cache. Copy the whole XCFramework's mac-arm64_x86_64
# slice into Contents/Frameworks and fix up the load path.
SPARKLE_FRAMEWORK="$(find .build -path '*Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework' -maxdepth 6 2>/dev/null | head -1)"
if [ -n "$SPARKLE_FRAMEWORK" ]; then
  mkdir -p "$APP/Contents/Frameworks"
  rm -rf "$APP/Contents/Frameworks/Sparkle.framework"
  cp -R "$SPARKLE_FRAMEWORK" "$APP/Contents/Frameworks/Sparkle.framework"
  install_name_tool -change "@rpath/Sparkle.framework/Versions/B/Sparkle" \
    "@executable_path/../Frameworks/Sparkle.framework/Versions/B/Sparkle" \
    "$APP/Contents/MacOS/VibeFox" 2>/dev/null || true
fi

if [ "${1:-}" = "--skip-sign" ]; then
  echo "Built $APP (unsigned, build $BUILD_NUMBER)"
  exit 0
fi

if [ -d "$APP/Contents/Frameworks/Sparkle.framework" ]; then
  # Deep-sign order: innermost bundles/binaries first, outer framework last (its signature
  # seals the whole tree). Every Mach-O in the framework needs its OWN valid signature —
  # missing Updater.app here is exactly what got the first submission rejected as Invalid
  # ("not signed with a valid Developer ID certificate" / "no secure timestamp"). --timestamp
  # is explicit (not just implied by --options runtime) so a flaky TSA round-trip never
  # silently produces an unnotarizable binary again.
  SPARKLE_VERSIONS="$APP/Contents/Frameworks/Sparkle.framework/Versions/B"
  codesign --force --options runtime --timestamp --sign "$IDENTITY" \
    "$SPARKLE_VERSIONS/XPCServices/Downloader.xpc"
  codesign --force --options runtime --timestamp --sign "$IDENTITY" \
    "$SPARKLE_VERSIONS/XPCServices/Installer.xpc"
  codesign --force --options runtime --timestamp --sign "$IDENTITY" \
    "$SPARKLE_VERSIONS/Updater.app"
  codesign --force --options runtime --timestamp --sign "$IDENTITY" \
    "$SPARKLE_VERSIONS/Autoupdate"
  codesign --force --options runtime --timestamp --sign "$IDENTITY" \
    "$APP/Contents/Frameworks/Sparkle.framework"
fi
codesign --force --options runtime --timestamp \
  --entitlements scripts/entitlements.plist \
  --sign "$IDENTITY" "$APP"
codesign --verify --strict --deep "$APP"

# Fail fast, locally, instead of burning a notarization round-trip: enumerate every Mach-O
# under the bundle and confirm each carries a Developer ID signature + secure timestamp.
while IFS= read -r bin; do
  info="$(codesign -dvvv "$bin" 2>&1)"
  echo "$info" | grep -q "Authority=Developer ID Application" || { echo "UNSIGNED (no Developer ID): $bin"; exit 1; }
  echo "$info" | grep -q "^Timestamp=" || { echo "MISSING SECURE TIMESTAMP: $bin"; exit 1; }
done < <(find "$APP" -type f -perm -u+x ! -name "*.dylib" -exec sh -c 'file "$1" | grep -q "Mach-O"' _ {} \; -print)
echo "All Mach-O binaries verified: Developer ID signature + secure timestamp."

if [ "${1:-}" = "--notarize" ]; then
  ditto -c -k --keepParent "$APP" "$ZIP"
  xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP"
  rm -f "$ZIP"
fi

# Distribution artifact (post-staple when notarizing, so the ticket ships inside).
ditto -c -k --keepParent "$APP" "$ZIP"
echo "Built $APP and $ZIP (build $BUILD_NUMBER)"

if [ -x "$SIGN_UPDATE" ]; then
  # sign_update's own stdout already includes BOTH sparkle:edSignature="..." and length="..."
  # (verified by inspection — do not add a second length attribute here).
  SIG_LINE="$("$SIGN_UPDATE" "$ZIP" 2>/dev/null || true)"
  if [ -n "$SIG_LINE" ]; then
    SHORT_VERSION="$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist")"
    echo ""
    echo "Paste this <item> into your published appcast.xml (see macos/appcast.xml):"
    echo ""
    echo "    <item>"
    echo "      <title>Version ${SHORT_VERSION}</title>"
    echo "      <pubDate>$(date -u +"%a, %d %b %Y %H:%M:%S %z")</pubDate>"
    echo "      <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>"
    echo "      <enclosure url=\"https://vibefox.app/releases/VibeFox-${SHORT_VERSION}.zip\""
    echo "                 sparkle:version=\"${BUILD_NUMBER}\""
    echo "                 sparkle:shortVersionString=\"${SHORT_VERSION}\""
    echo "                 type=\"application/octet-stream\""
    echo "                 ${SIG_LINE} />"
    echo "    </item>"
  fi
else
  echo "(tools/sparkle-bin/sign_update not found — skipping appcast signature; see docs/SPARKLE.md)"
fi
