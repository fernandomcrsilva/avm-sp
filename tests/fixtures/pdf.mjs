// PDFs mínimos escritos à mão para os testes: scannedPdf (só imagem, "escaneado") e textPdf (camada de texto).
// PDF "escaneado": cada página é só uma imagem DeviceGray 8 bits, sem filtro, com um gradiente
// horizontal (pixel x = x * 255 / (width - 1)). Bytes escritos à mão, como o mkpdf dos testes manuais da E1.
const latin1 = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

// Serializa os objetos 1..n com a tabela xref e o trailer. Comum aos dois geradores.
function assemble(objects) {
  const parts = [latin1("%PDF-1.4\n")];
  const offsets = [];
  let position = parts[0].length;
  objects.forEach((body, index) => {
    offsets.push(position);
    const chunk = concat([latin1(`${index + 1} 0 obj\n`), body, latin1("\nendobj\n")]);
    parts.push(chunk);
    position += chunk.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`;
  parts.push(latin1(xref));
  return concat(parts);
}

// PDF mínimo COM camada de texto (Helvetica, WinAnsi): uma linha por Tj, como um PDF "digital" que o toMarkdown
// lê. Caracteres fora do Latin-1 (travessão, aspas curvas) viram "-": o WinAnsi não os tem e o latin1 os
// truncaria em outro caractere.
export function textPdf(lines) {
  const esc = (s) => s.replace(/[^ -ÿ]/g, "-").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const body = latin1(`BT /F1 11 Tf 40 800 Td 14 TL ${lines.map((line) => `(${esc(line)}) Tj T*`).join(" ")} ET`);
  return assemble([
    latin1("<< /Type /Catalog /Pages 2 0 R >>"),
    latin1("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    latin1("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"),
    concat([latin1(`<< /Length ${body.length} >>\nstream\n`), body, latin1("\nendstream")]),
    latin1("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
  ]);
}

// strips > 1 divide a página em faixas horizontais (uma imagem por faixa, desenhadas de cima para baixo), como os
// escaneados "em tiras" do caso real 01 (12 imagens de 764×85 por página).
export function scannedPdf({ width = 8, height = 8, pages = 1, strips = 1 } = {}) {
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) pixels[y * width + x] = Math.round((x * 255) / Math.max(1, width - 1));
  const stripHeight = height / strips; // o teste usa altura divisível
  const objects = []; // Uint8Array por objeto, na ordem 1..n
  const pageIds = [];
  objects.push(latin1("<< /Type /Catalog /Pages 2 0 R >>"));
  objects.push(null); // 2: Pages, preenchido depois
  for (let p = 0; p < pages; p += 1) {
    const pageId = objects.length + 1, contentId = pageId + 1, firstImageId = pageId + 2;
    pageIds.push(pageId);
    const xobjects = Array.from({ length: strips }, (_, s) => `/Im${s} ${firstImageId + s} 0 R`).join(" ");
    objects.push(latin1(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${contentId} 0 R /Resources << /XObject << ${xobjects} >> >> >>`));
    // de cima para baixo: a faixa s ocupa y de (height - (s+1)·stripHeight) a (height - s·stripHeight)
    const content = Array.from({ length: strips }, (_, s) => `q ${width} 0 0 ${stripHeight} 0 ${height - (s + 1) * stripHeight} cm /Im${s} Do Q`).join(" ");
    objects.push(concat([latin1(`<< /Length ${content.length} >>\nstream\n`), latin1(content), latin1("\nendstream")]));
    for (let s = 0; s < strips; s += 1) {
      const slice = pixels.subarray(s * stripHeight * width, (s + 1) * stripHeight * width);
      objects.push(concat([latin1(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${stripHeight} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${slice.length} >>\nstream\n`), slice, latin1("\nendstream")]));
    }
  }
  objects[1] = latin1(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`);
  return assemble(objects);
}
