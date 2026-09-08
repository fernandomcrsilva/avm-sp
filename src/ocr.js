// OCR da Entrega 2 (spec §5): a página escaneada vira PNG cinza e um modelo de visão do Workers AI transcreve o
// texto, que segue para os MESMOS extratores da matrícula e do carnê — o modelo nunca decide um campo.
// Puro: recebe `ai` injetado; nada é gravado. PNG escrito sem biblioteca (deflate nativo do runtime).
import { getDocumentProxy, extractImages } from "unpdf";

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// btoa em blocos: String.fromCharCode(...array) estoura a pilha em imagens de alguns MB.
export function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

const be32 = (value) => Uint8Array.of((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);

function chunk(type, data) {
  const typeBytes = Uint8Array.from(type, (c) => c.charCodeAt(0));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(12 + data.length);
  out.set(be32(data.length), 0);
  out.set(body, 4);
  out.set(be32(crc32(body)), 8 + data.length);
  return out;
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate")); // "deflate" = zlib, o que o PNG exige
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Reduz por fator inteiro (média de bloco) e converte a cinza (luminância); devolve PNG tipo de cor 0, 8 bits, filtro 0.
export async function encodePng({ data, width, height, channels }, maxSide = 1600) {
  const factor = Math.max(1, Math.ceil(Math.max(width, height) / maxSide));
  const outWidth = Math.floor(width / factor);
  const outHeight = Math.floor(height / factor);
  const gray = (index) => {
    if (channels === 1) return data[index];
    const at = index * channels;
    return 0.299 * data[at] + 0.587 * data[at + 1] + 0.114 * data[at + 2];
  };
  const raw = new Uint8Array(outHeight * (outWidth + 1)); // byte de filtro (0) + pixels, por linha
  const area = factor * factor;
  for (let y = 0; y < outHeight; y += 1) {
    const row = y * (outWidth + 1);
    raw[row] = 0;
    for (let x = 0; x < outWidth; x += 1) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy += 1) for (let dx = 0; dx < factor; dx += 1) sum += gray((y * factor + dy) * width + (x * factor + dx));
      raw[row + 1 + x] = Math.round(sum / area);
    }
  }
  const ihdr = new Uint8Array(13);
  ihdr.set(be32(outWidth), 0);
  ihdr.set(be32(outHeight), 4);
  ihdr.set([8, 0, 0, 0, 0], 8); // 8 bits, cinza, deflate, filtro adaptativo (linhas com 0), sem entrelace
  const idat = await deflate(raw);
  const signature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  const parts = [signature, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { png.set(part, offset); offset += part.length; }
  return png;
}

// Página escaneada "em faixas" (várias imagens da mesma largura, caso real 01): empilha na ordem dos operadores,
// que é de cima para baixo. Caso contrário, a maior imagem é a página.
function composePage(found) {
  const usable = found.filter((image) => image.data && image.width > 0 && image.height > 0);
  if (!usable.length) return null;
  const [first] = usable;
  if (usable.length > 1 && usable.every((image) => image.width === first.width && image.channels === first.channels)) {
    const height = usable.reduce((total, image) => total + image.height, 0);
    const data = new Uint8Array(first.width * height * first.channels);
    let offset = 0;
    for (const image of usable) {
      const length = image.width * image.height * image.channels;
      data.set(image.data.subarray(0, length), offset);
      offset += length;
    }
    return { data, width: first.width, height, channels: first.channels };
  }
  return usable.reduce((best, image) => (!best || image.width * image.height > best.width * best.height ? image : best), null);
}

// Uma imagem por página. Páginas sem imagem são puladas; PDF inválido devolve lista vazia (o chamador trata
// como "não lido").
export async function pageImages(pdfBytes, maxPages = 4) {
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(pdfBytes));
  } catch (_) {
    return [];
  }
  const images = [];
  const pageCount = Math.min(pdf.numPages, maxPages);
  for (let page = 1; page <= pageCount; page += 1) {
    try {
      const composed = composePage(await extractImages(pdf, page));
      if (composed) images.push({ ...composed, page });
    } catch (_) { /* página com imagem que o pdf.js não decodifica (ex.: JPX): pulada */ }
  }
  return images;
}
