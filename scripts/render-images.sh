#!/usr/bin/env sh
# Gera site/og-image.png (1200x630), site/icon-512.png e site/icon-192.png a partir de tools/*.html
# com um Chromium headless. Rode depois de alterar tools/og-image.html ou site/favicon.svg.
# Uso: CHROME_PATH=/caminho/para/chrome scripts/render-images.sh
set -eu
CHROME="${CHROME_PATH:-chromium}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
shot() { "$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --default-background-color=00000000 --window-size="$2" --screenshot="$3" "file://$ROOT/$1" >/dev/null 2>&1; }
shot tools/og-image.html 1200,630 "$ROOT/site/og-image.png"
shot tools/icon.html 512,512 "$ROOT/site/icon-512.png"
shot tools/icon.html 192,192 "$ROOT/site/icon-192.png"
ls -la "$ROOT"/site/og-image.png "$ROOT"/site/icon-512.png "$ROOT"/site/icon-192.png
