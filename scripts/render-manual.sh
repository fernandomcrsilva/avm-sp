#!/usr/bin/env sh
# Gera site/manual-avm-sp-v7.pdf a partir de tools/manual-pdf.html com o WeasyPrint e, do PDF,
# as imagens de página em site/assets/manual/ — o Chrome do Android não exibe PDF em iframe,
# então /manual mostra o documento como imagens e oferece o PDF para download.
# As capturas de tela (tools/manual-shot-*.png) vêm do próprio aplicativo.
# Precisa de weasyprint, pdftoppm (poppler) e Pillow. Nada disso entra no repositório: Pillow e poppler vêm do sistema
# (Arch: python-pillow poppler; Debian: python3-pil poppler-utils) e o WeasyPrint de um venv descartável com o uv:
#   uv venv --python 3.12 /tmp/wp && uv pip install --python /tmp/wp/bin/python weasyprint
#   WEASYPRINT=/tmp/wp/bin/weasyprint PYTHON=/usr/bin/python3 scripts/render-manual.sh
# Depois: ajustar o número de páginas, o tamanho e os <img> em site/manual.html (tests/manual.test.mjs cobra).
set -eu
WP="${WEASYPRINT:-weasyprint}"
PY="${PYTHON:-python3}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PDF="$ROOT/site/manual-avm-sp-v7.pdf"
OUT="$ROOT/site/assets/manual"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

"$WP" "$ROOT/tools/manual-pdf.html" "$PDF"

pdftoppm -r 150 "$PDF" "$TMP/p"
rm -f "$OUT"/p*.webp
mkdir -p "$OUT"
OUT="$OUT" TMP="$TMP" "$PY" - <<'PYEOF'
import glob, os
from PIL import Image
out, tmp = os.environ["OUT"], os.environ["TMP"]
for f in sorted(glob.glob(f"{tmp}/p-*.ppm")):
    n = int(f.rsplit("-", 1)[1].split(".")[0])
    im = Image.open(f).convert("RGB")
    im = im.resize((1240, round(1240 * im.height / im.width)), Image.LANCZOS)
    im.save(f"{out}/p{n:02d}.webp", "WEBP", quality=82, method=6)
PYEOF

ls -la "$PDF"; ls -la "$OUT"
