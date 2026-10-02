#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

render() {
  mkdir -p "$(dirname "$3")"
  if [[ "${4:-}" == opaque ]]; then
    rsvg-convert -w "$2" -h "$2" "$1" | magick - -background white -alpha remove -alpha off -define png:exclude-chunks=date,time "PNG24:$3"
  else
    rsvg-convert -w "$2" -h "$2" "$1" -o "$3"
  fi
}

any=brand/icon.svg
mask=brand/icon-maskable.svg

render $any 32 desktop/icons/32x32.png
render $any 128 desktop/icons/128x128.png
render $any 256 desktop/icons/128x128@2x.png
render $any 512 desktop/icons/icon.png

for d in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  render $any "${d#*:}" "app/android/app/src/main/res/mipmap-${d%%:*}/ic_launcher.png"
done

ios=app/ios/Runner/Assets.xcassets/AppIcon.appiconset
for spec in 20x20@1x:20 20x20@2x:40 20x20@3x:60 29x29@1x:29 29x29@2x:58 29x29@3x:87 \
            40x40@1x:40 40x40@2x:80 40x40@3x:120 60x60@2x:120 60x60@3x:180 \
            76x76@1x:76 76x76@2x:152 83.5x83.5@2x:167 1024x1024@1x:1024; do
  render $mask "${spec#*:}" "$ios/Icon-App-${spec%%:*}.png" opaque
done

for s in 16 32 64 128 256 512 1024; do
  render $any $s "app/macos/Runner/Assets.xcassets/AppIcon.appiconset/app_icon_$s.png"
done

render $any 16 app/web/favicon.png
render $any 192 app/web/icons/Icon-192.png
render $any 512 app/web/icons/Icon-512.png
render $mask 192 app/web/icons/Icon-maskable-192.png
render $mask 512 app/web/icons/Icon-maskable-512.png

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
for s in 16 24 32 48 64 256; do render $any $s "$tmp/$s.png"; done
magick "$tmp"/{16,24,32,48,64,256}.png -define png:exclude-chunks=date,time app/windows/runner/resources/app_icon.ico
