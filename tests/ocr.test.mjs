// OCR da Entrega 2: PNG cinza gerado sem biblioteca (validado por inflate e CRC), imagens embutidas via unpdf,
// e a chamada ao modelo com `ai` falso. Rodar: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { getDocumentProxy } from "unpdf";
import { crc32, toBase64, encodePng, pageImages, ocrPayload, transcribe, ocrDocument, OCR_MODEL } from "../src/ocr.js";
import { scannedPdf } from "./fixtures/pdf.mjs";

const be32 = (bytes, at) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;

// Lê os chunks do PNG, confere cada CRC e devolve IHDR + IDAT concatenado.
function parsePng(png) {
  assert.deepEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "assinatura PNG");
  const chunks = [];
  let at = 8;
  while (at < png.length) {
    const length = be32(png, at);
    const type = String.fromCharCode(...png.slice(at + 4, at + 8));
    const data = png.slice(at + 8, at + 8 + length);
    const crc = be32(png, at + 8 + length);
    assert.equal(crc, crc32(png.slice(at + 4, at + 8 + length)), `CRC do chunk ${type}`);
    chunks.push({ type, data });
    at += 12 + length;
  }
  return chunks;
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

test("crc32 bate com o valor conhecido", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test("toBase64 em blocos é igual ao Buffer", () => {
  const bytes = Uint8Array.from({ length: 20000 }, (_, i) => (i * 31) & 255);
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString("base64"));
});

test("encodePng: cinza 8 bits, filtro 0, IDAT inflado com o tamanho certo, sem redução quando cabe", async () => {
  const width = 5, height = 3;
  const data = Uint8Array.from({ length: width * height }, (_, i) => (i * 17) & 255);
  const png = await encodePng({ data, width, height, channels: 1 });
  const chunks = parsePng(png);
  assert.deepEqual(chunks.map((c) => c.type), ["IHDR", "IDAT", "IEND"]);
  const ihdr = chunks[0].data;
  assert.equal(be32(ihdr, 0), width);
  assert.equal(be32(ihdr, 4), height);
  assert.deepEqual([...ihdr.slice(8, 13)], [8, 0, 0, 0, 0]); // 8 bits, cinza, deflate, filtro adaptativo, sem entrelace
  const raw = await inflate(chunks[1].data);
  assert.equal(raw.length, height * (width + 1));
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * (width + 1)], 0, "byte de filtro da linha");
    assert.deepEqual([...raw.slice(y * (width + 1) + 1, (y + 1) * (width + 1))], [...data.slice(y * width, (y + 1) * width)]);
  }
});

test("encodePng: RGB e RGBA viram cinza pela luminância", async () => {
  const rgb = await encodePng({ data: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]), width: 4, height: 1, channels: 3 });
  const rgba = await encodePng({ data: Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]), width: 4, height: 1, channels: 4 });
  for (const png of [rgb, rgba]) {
    const raw = await inflate(parsePng(png)[1].data);
    assert.deepEqual([...raw], [0, 76, 150, 29, 255]); // filtro 0 + luma de vermelho, verde, azul, branco (0,299/0,587/0,114)
  }
});

test("encodePng: reduz por fator inteiro até o lado maior caber em maxSide (média de bloco)", async () => {
  const width = 3200, height = 20;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data[y * width + x] = x % 2 ? 200 : 100; // pares de colunas 100/200 → média 150
  const png = await encodePng({ data, width, height, channels: 1 }, 1600);
  const chunks = parsePng(png);
  assert.equal(be32(chunks[0].data, 0), 1600);
  assert.equal(be32(chunks[0].data, 4), 10);
  const raw = await inflate(chunks[1].data);
  assert.equal(raw.length, 10 * 1601);
  assert.equal(raw[1], 150);
});

// pdf.js entrega DeviceGray 8 bits expandido (RGB ou RGBA); o gradiente é conferido pelo primeiro canal de cada pixel.
const firstChannelRow = (image, row = 0) => Array.from({ length: image.width }, (_, x) => image.data[(row * image.width + x) * image.channels]);
const GRADIENTE_8 = [0, 36, 73, 109, 146, 182, 219, 255];

test("pageImages: devolve a imagem embutida de cada página, no máximo maxPages", async () => {
  const one = await pageImages(scannedPdf({ width: 8, height: 8 }));
  assert.equal(one.length, 1);
  assert.equal(one[0].width, 8);
  assert.equal(one[0].height, 8);
  assert.ok([1, 3, 4].includes(one[0].channels), `canais: ${one[0].channels}`);
  assert.equal(one[0].page, 1);
  assert.deepEqual(firstChannelRow(one[0]), GRADIENTE_8);
  const three = await pageImages(scannedPdf({ pages: 3 }), 2);
  assert.deepEqual(three.map((i) => i.page), [1, 2]);
});

test("pageImages: página escaneada em faixas é remontada de cima para baixo", async () => {
  const [page] = await pageImages(scannedPdf({ width: 8, height: 8, strips: 4 }));
  assert.equal(page.width, 8);
  assert.equal(page.height, 8); // 4 faixas de 2 linhas empilhadas
  for (const row of [0, 3, 7]) assert.deepEqual(firstChannelRow(page, row), GRADIENTE_8);
});

test("pageImages: PDF inválido → lista vazia, sem lançar", async () => {
  assert.deepEqual(await pageImages(new TextEncoder().encode("%PDF-1.4 lixo")), []);
});

test("pageImages: destrói o documento ao terminar (segunda leitura dos mesmos bytes continua funcionando)", async () => {
  const bytes = scannedPdf({ pages: 2 });
  const first = await pageImages(bytes);
  const second = await pageImages(bytes);
  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  assert.deepEqual(second.map((i) => i.page), [1, 2]);
});

test("loadingTask.destroy() existe no proxy do unpdf e pode ser chamado após a leitura", async () => {
  const pdf = await getDocumentProxy(scannedPdf());
  assert.equal(typeof pdf.loadingTask.destroy, "function");
  await pdf.loadingTask.destroy();
  // Nesta build do unpdf, pdf.getPage(1) após destroy() lança SINCRONAMENTE (TypeError: Cannot read properties of
  // null (reading 'sendWithPromise')), não devolve uma promise rejeitada — por isso não há assert.rejects aqui.
});

// O Gemma 4 pelo binding responde no formato OpenAI (spike da Task 1): o texto está em choices[0].message.content.
const respostaModelo = (text) => ({ choices: [{ finish_reason: "stop", index: 0, message: { role: "assistant", content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
function aiFalso(text = "Ano da Construção Corrigido: 2018") {
  const calls = [];
  return { calls, run: async (model, input) => { calls.push({ model, input }); return respostaModelo(text); } };
}

test("transcribe aceita também o formato { response } da reserva Llama", async () => {
  const ai = { run: async () => ({ response: "texto llama" }) };
  assert.equal(await transcribe(ai, { bytes: Uint8Array.of(1), mimeType: "image/png" }), "texto llama");
});

test("transcribe: manda a imagem como data URI no formato escolhido no spike e devolve o texto", async () => {
  const ai = aiFalso();
  const text = await transcribe(ai, { bytes: Uint8Array.of(137, 80, 78, 71), mimeType: "image/png" });
  assert.equal(text, "Ano da Construção Corrigido: 2018");
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].model, OCR_MODEL);
  assert.equal(JSON.stringify(ai.calls[0].input).includes("data:image/png;base64,iVBORw=="), true);
  assert.equal(JSON.stringify(ai.calls[0].input).includes("Transcreva"), true);
});

test("ocrDocument: PDF escaneado de 3 páginas → uma transcrição por página, em paralelo, até maxPages", async () => {
  const ai = aiFalso("linha");
  const out = await ocrDocument(ai, { bytes: scannedPdf({ pages: 3 }), mimeType: "application/pdf" }, { maxPages: 2 });
  assert.equal(out.pages, 2);
  assert.equal(out.attempted, 2);
  assert.equal(ai.calls.length, 2);
  assert.equal(out.text, "linha\nlinha");
  for (const call of ai.calls) assert.equal(JSON.stringify(call.input).includes("data:image/png;base64,"), true);
});

test("ocrDocument: imagem anexada vai direto ao modelo, sem recodificar; acima do teto → vazio", async () => {
  const ai = aiFalso("texto da foto");
  const jpeg = Uint8Array.of(255, 216, 255, 224);
  const out = await ocrDocument(ai, { bytes: jpeg, mimeType: "image/jpeg" }, {});
  assert.deepEqual(out, { text: "texto da foto", pages: 1, attempted: 1 });
  assert.equal(JSON.stringify(ai.calls[0].input).includes("data:image/jpeg;base64,/9j/4A=="), true);
  const grande = await ocrDocument(aiFalso(), { bytes: new Uint8Array(5 * 1024 * 1024 + 1), mimeType: "image/jpeg" }, {});
  assert.deepEqual(grande, { text: "", pages: 0, attempted: 0 });
});

test("ocrDocument: falha do modelo numa página não derruba as outras; PDF sem imagem → vazio", async () => {
  let n = 0;
  const ai = { run: async () => { n += 1; if (n === 1) throw new Error("modelo indisponível"); return { response: `p${n}` }; } };
  const out = await ocrDocument(ai, { bytes: scannedPdf({ pages: 2 }), mimeType: "application/pdf" }, {});
  assert.equal(out.pages, 1);
  assert.equal(out.attempted, 2);
  assert.equal(out.text, "p2");
  assert.deepEqual(await ocrDocument(aiFalso(), { bytes: new TextEncoder().encode("%PDF-1.4 lixo"), mimeType: "application/pdf" }, {}), { text: "", pages: 0, attempted: 0 });
});

test("pageImages: transform roda por página, antes de a próxima ser extraída", async () => {
  const order = [];
  const out = await pageImages(scannedPdf({ pages: 3 }), 4, async (image) => { order.push(`t${image.page}`); return image.page; });
  assert.deepEqual(out, [1, 2, 3]);
  assert.deepEqual(order, ["t1", "t2", "t3"]);
  // transform que falha numa página só pula aquela página
  const partial = await pageImages(scannedPdf({ pages: 3 }), 4, async (image) => { if (image.page === 2) throw new Error("falhou"); return image.page; });
  assert.deepEqual(partial, [1, 3]);
});

test("ocrDocument: página cujo PNG não cabe no teto é descartada, as outras seguem", async () => {
  const ai = aiFalso("ok");
  const out = await ocrDocument(ai, { bytes: scannedPdf({ pages: 2 }), mimeType: "application/pdf" }, { maxPngBytes: 10 }); // teto absurdo: nenhum PNG cabe
  assert.deepEqual(out, { text: "", pages: 0, attempted: 0 });
  assert.equal(ai.calls.length, 0);
});
