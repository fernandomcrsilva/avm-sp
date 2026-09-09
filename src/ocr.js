// OCR da Entrega 2 (spec §5): a página escaneada vira PNG cinza e um modelo de visão do Workers AI transcreve o
// texto, que segue para os MESMOS extratores da matrícula e do carnê — o modelo nunca decide um campo.
// Puro: recebe `ai` injetado; nada é gravado. PNG escrito sem biblioteca (deflate nativo do runtime).
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";

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
  const outWidth = Math.max(1, Math.floor(width / factor));
  const outHeight = Math.max(1, Math.floor(height / factor));
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

// Imagens desenhadas na página, em pixels brutos. Extração própria porque o extractImages do unpdf descarta o
// bitmap de 1 bit (kind 1, MSB primeiro, 1 = branco) que o pdf.js entrega para JBIG2 e CCITT — o formato de
// quase todo escaneado de cartório e de prefeitura (caso real 02). Aqui ele vira cinza 8 bits.
async function pageObjects(page) {
  const { OPS } = await getResolvedPDFJS();
  const ops = await page.getOperatorList();
  const images = [];
  for (let i = 0; i < ops.fnArray.length; i += 1) {
    if (ops.fnArray[i] !== OPS.paintImageXObject) continue;
    const key = ops.argsArray[i][0];
    const store = String(key).startsWith("g_") ? page.commonObjs : page.objs;
    const image = await new Promise((resolve) => store.get(key, resolve));
    if (!image?.data || !image.width || !image.height) continue;
    const { width, height, data } = image;
    const channels = data.length / (width * height);
    if (channels === 1 || channels === 3 || channels === 4) { images.push({ data, width, height, channels }); continue; }
    if (image.kind !== 1) continue; // 1 = GRAYSCALE_1BPP
    const rowBytes = Math.ceil(width / 8);
    const gray = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) gray[y * width + x] = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
    images.push({ data: gray, width, height, channels: 1 });
  }
  return images;
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

// Uma imagem por página. `transform` (opcional, assíncrono) roda dentro do laço, página a página — é assim que os
// pixels brutos de uma página morrem antes de a próxima ser lida (spec §5.4: uma página em memória por vez).
// Páginas sem imagem são puladas; PDF inválido devolve lista vazia (o chamador trata como "não lido").
export async function pageImages(pdfBytes, maxPages = 4, transform = async (image) => image) {
  let pdf;
  try {
    // teto de 12 Mpx por imagem (A4 a 300 dpi ≈ 8,7 Mpx passa; 600 dpi é descartada pelo pdf.js e a página vira
    // "sem texto legível") — o isolate tem 128 MB e 12 Mpx × 4 canais = 48 MB
    pdf = await getDocumentProxy(new Uint8Array(pdfBytes), { maxImageSize: 12e6 });
  } catch (_) {
    return [];
  }
  const images = [];
  try {
    const pageCount = Math.min(pdf.numPages, maxPages);
    for (let page = 1; page <= pageCount; page += 1) {
      try {
        const composed = composePage(await pageObjects(await pdf.getPage(page)));
        if (composed) images.push(await transform({ ...composed, page }));
      } catch (_) { /* página com imagem que o pdf.js não decodifica (ex.: JPX): pulada */ }
    }
  } finally {
    await pdf.loadingTask?.destroy?.(); // libera transporte e worker do pdf.js; sem isso o documento fica vivo no isolate
  }
  return images;
}

// Decisão do spike (Task 1, 2026-09-08): Gemma 4 com a imagem como parte `image_url` da mensagem (variante a) transcreveu
// corretamente o PNG sintético (3,5 s) e uma certidão real escaneada de 617×838 (8,5 s); a resposta vem no formato OpenAI
// (`choices[0].message.content`). `image` na raiz (variante b) fez o modelo ignorar a imagem. Reserva: Llama 3.2 Vision
// (`{ messages, image }`, texto em `response`, 11 s) — funciona, sem licença pendente.
export const OCR_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const OCR_PROMPT = "Você é um OCR. Transcreva fielmente todo o texto da imagem, em português, preservando rótulos, números, pontuação e a ordem de leitura. Não resuma, não explique, não invente.";
const USER_PROMPT = "Transcreva esta página.";

export function ocrPayload(dataUri) {
  return {
    messages: [
      { role: "system", content: OCR_PROMPT },
      { role: "user", content: [{ type: "text", text: USER_PROMPT }, { type: "image_url", image_url: { url: dataUri } }] },
    ],
    max_tokens: 4096,
    temperature: 0,
    chat_template_kwargs: { enable_thinking: false },
  };
}

// Gemma 4 responde no formato OpenAI (choices[0].message.content); a reserva Llama, em `response`.
const responseText = (result) => (typeof result === "string" ? result : String(result?.choices?.[0]?.message?.content ?? result?.response ?? result?.result ?? result?.description ?? ""));

export async function transcribe(ai, { bytes, mimeType }) {
  const result = await ai.run(OCR_MODEL, ocrPayload(`data:${mimeType};base64,${toBase64(bytes)}`));
  return responseText(result).trim();
}

const MIB = 1024 * 1024;

// PDF: uma página por vez em memória — pageImages extrai a imagem da página e já a codifica em PNG (o `transform`
// abaixo) antes de ler a página seguinte, descartando os pixels brutos no caminho; depois transcreve todas as
// páginas (agora só PNGs) em paralelo. Imagem anexada: vai como está. Falha numa página não derruba as outras;
// nada legível → { text: "", pages: 0, attempted: 0 }. `pages` = transcrições bem-sucedidas; `attempted` = chamadas
// feitas ao modelo, o que conta para o orçamento (Ruling 11: o teto é sobre chamadas, não sobre sucessos).
export async function ocrDocument(ai, { bytes, mimeType }, { maxPages = 4, maxPngBytes = 4 * MIB, maxImageBytes = 5 * MIB } = {}) {
  let images = [];
  if (mimeType === "application/pdf") {
    const encode = async (image) => {
      let png = await encodePng(image, 1600);
      for (let side = 1200; png.length > maxPngBytes && side >= 600; side -= 300) png = await encodePng(image, side); // página densa: reduz mais
      return png.length <= maxPngBytes ? { bytes: png, mimeType: "image/png" } : null;
    };
    images = (await pageImages(bytes, maxPages, encode)).filter(Boolean);
  } else if (bytes.length <= maxImageBytes) {
    images = [{ bytes, mimeType }];
  }
  const texts = await Promise.all(images.map((image) => transcribe(ai, image).catch(() => null)));
  const ok = texts.filter((text) => text !== null);
  return { text: ok.join("\n"), pages: ok.length, attempted: images.length };
}
