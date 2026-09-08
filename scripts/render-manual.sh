#!/usr/bin/env sh
# Gera site/manual-avm-sp-v7.pdf a partir de tools/manual-pdf.html com o WeasyPrint.
# As capturas de tela (tools/manual-shot-*.png) vêm do próprio aplicativo.
# Uso: WEASYPRINT=/caminho/para/weasyprint scripts/render-manual.sh
set -eu
WP="${WEASYPRINT:-weasyprint}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$WP" "$ROOT/tools/manual-pdf.html" "$ROOT/site/manual-avm-sp-v7.pdf"
ls -la "$ROOT/site/manual-avm-sp-v7.pdf"
