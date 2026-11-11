#!/bin/bash
# Compila l'app del cruscotto in app/build/. Con --installa la copia in ~/Applications.
#   NOME_APP   nome dell'app (default "Cruscotto agenti")
#   BUNDLE_ID  identificativo (default io.github.flusso-agenti.cruscotto)
# L'app avvia il server dalla cartella che contiene app/: se sposti il repo, ricompila.
set -euo pipefail
cd "$(dirname "$0")"

NOME="${NOME_APP:-Cruscotto agenti}"
ID="${BUNDLE_ID:-io.github.flusso-agenti.cruscotto}"
CARTELLA="$(cd .. && pwd)"
VERSIONE="0.1.0"
APP="build/$NOME.app"

swift build -c release
BIN="$(swift build -c release --show-bin-path)/CruscottoClaude"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/CruscottoClaude"

if [ ! -f build/AppIcon.icns ] || [ icona.swift -nt build/AppIcon.icns ]; then
  rm -rf build/AppIcon.iconset
  swift icona.swift build/AppIcon.iconset
  iconutil -c icns build/AppIcon.iconset -o build/AppIcon.icns
fi
cp build/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$NOME</string>
  <key>CFBundleDisplayName</key><string>$NOME</string>
  <key>CFBundleIdentifier</key><string>$ID</string>
  <key>CFBundleExecutable</key><string>CruscottoClaude</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSIONE</string>
  <key>CFBundleVersion</key><string>$(date +%Y%m%d%H%M)</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CartellaCruscotto</key><string>$CARTELLA</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>Il cruscotto apre il Terminale per avviare le sessioni Claude dei task.</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
EOF

codesign --force --deep --sign - "$APP"
echo "Creata: $(pwd)/$APP"

if [ "${1:-}" = "--installa" ]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/$NOME.app"
  cp -R "$APP" "$HOME/Applications/"
  echo "Installata: $HOME/Applications/$NOME.app"
fi
