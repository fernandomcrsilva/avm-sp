// Pipeline do AVM por e-mail (src/email.js) e handler email() do Worker. Node puro: env, message e serviços
// falsos; o texto dos PDFs vem do fixture, então os bytes dos anexos não importam. Rodar: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { CARNE, MATRICULA, MATRICULA_CASA } from "./fixtures/textos.mjs";
import { scannedPdf } from "./fixtures/pdf.mjs";
import { mime } from "./fixtures/mime.mjs";
import { LIMITS, parseInbound, readDocuments, buildInputs, compose, processEmail } from "../src/email.js";
import worker, { allowedSender } from "../src/worker.js";

const raw = (options) => new TextEncoder().encode(mime(options)).buffer;

test("parseInbound: PDFs e imagens entram; outros tipos vão para ignorados", async () => {
  const nomeLongo = `${"a".repeat(300)}.pdf`;
  const parsed = await parseInbound(raw({ attachments: [
    ["iptu.pdf", "application/pdf", "%PDF-1.4 carne"],
    ["matricula.PDF", "application/octet-stream", "%PDF-1.4 matricula"], // tipo genérico, extensão .pdf
    ["foto.jpg", "image/jpeg", "jpeg" + "x".repeat(25 * 1024)],
    ["planilha.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "x"],
    [nomeLongo, "application/pdf", "%PDF-1.4 nome longo"],
  ] }));
  assert.equal(parsed.messageId, "<abc123@exemplo.gov.br>");
  assert.equal(parsed.subject, "Avaliação do apartamento");
  assert.deepEqual(parsed.attachments.map((a) => [a.fileName, a.mimeType]), [["iptu.pdf", "application/pdf"], ["matricula.PDF", "application/pdf"], ["foto.jpg", "image/jpeg"], [nomeLongo.slice(0, 120), "application/pdf"]]);
  assert.ok(parsed.attachments[0].bytes instanceof Uint8Array && parsed.attachments[0].bytes.length > 0);
  assert.deepEqual(parsed.ignored, ["planilha.xlsx"]);
  assert.equal(parsed.attachments[3].fileName.length, 120); // truncado a 120
});

test("parseInbound: imagem PNG normal vai para attachments", async () => {
  const parsed = await parseInbound(raw({ attachments: [["foto.png", "image/png", "png" + "x".repeat(25 * 1024)]] }));
  assert.deepEqual(parsed.attachments.map((a) => [a.fileName, a.mimeType]), [["foto.png", "image/png"]]);
  assert.deepEqual(parsed.ignored, []);
});

test("parseInbound: imagem abaixo de 20 KiB (assinatura) ou acima de 5 MiB vai para ignorados", async () => {
  const parsed = await parseInbound(raw({ attachments: [
    ["logo.png", "image/png", "x".repeat(2 * 1024)],
    ["foto.jpg", "image/jpeg", "y".repeat(30 * 1024)],
    ["gigante.jpg", "image/jpeg", "z".repeat(5 * 1024 * 1024 + 1)],
  ] }));
  assert.deepEqual(parsed.attachments.map((a) => a.fileName), ["foto.jpg"]);
  assert.deepEqual(parsed.ignored, ["logo.png", "gigante.jpg"]);
});

test("parseInbound: imagem embutida no HTML (multipart/related, mesmo tamanho de um escaneado) vai para ignorados; a mesma imagem como anexo normal entra", async () => {
  const imagem = "x".repeat(30 * 1024);
  const comoRelated = await parseInbound(raw({ related: [["logo.png", "image/png", imagem, "logo@x"]] }));
  assert.deepEqual(comoRelated.attachments, []);
  assert.deepEqual(comoRelated.ignored, ["logo.png"]);
  const comoAnexo = await parseInbound(raw({ attachments: [["logo.png", "image/png", imagem]] }));
  assert.deepEqual(comoAnexo.attachments.map((a) => a.fileName), ["logo.png"]);
});

test("parseInbound: anexo acima do teto vai para ignorados; mais de 6 anexos, só os 6 primeiros", async () => {
  const grande = "x".repeat(LIMITS.maxAttachmentBytes + 1);
  const many = Array.from({ length: 8 }, (_, i) => [`doc${i}.pdf`, "application/pdf", "%PDF"]);
  const parsed = await parseInbound(raw({ attachments: [["grande.pdf", "application/pdf", grande], ...many] }));
  assert.ok(parsed.ignored.includes("grande.pdf"));
  assert.equal(parsed.attachments.length, LIMITS.maxAttachments);
});

test("parseInbound: sem Message-ID e sem anexos", async () => {
  const parsed = await parseInbound(raw({ messageId: null }));
  assert.equal(parsed.messageId, null);
  assert.deepEqual(parsed.attachments, []);
});

const textos = (pares) => pares.map(([fileName, text]) => ({ fileName, text, method: "texto do PDF" }));

test("readDocuments classifica e extrai; buildInputs monta v como o site", () => {
  const { docs, ambiguous } = readDocuments(textos([["iptu.pdf", CARNE], ["matricula.pdf", MATRICULA]]));
  assert.equal(ambiguous, null);
  assert.deepEqual(docs.map((d) => d.type), ["iptu", "matricula"]);
  const out = buildInputs(docs);
  assert.ok(out.v, JSON.stringify(out));
  const v = out.v;
  assert.equal(v.address, "Rua Vergueiro, 2650");
  assert.equal(v.cep, "04109-002");
  assert.equal(v.cep8, "04109002");
  assert.equal(v.area, 78);
  assert.equal(v.yearBuilt, 2018);
  assert.equal(v.age, 2026 - 2018);
  assert.equal(v.pattern, "22");
  assert.equal(v.fiscal, 6500);
  assert.equal(v.financing, "SFH");
  assert.equal(v.funds, "SBPE");
  assert.equal(v.declared, true);
  assert.deepEqual(v.enabledVariables, ["area", "age", "pattern", "fiscal"]);
  assert.equal(v.documentSource.fileName, "iptu.pdf + matricula.pdf");
  assert.equal(v.documentSource.method, "texto do PDF");
  assert.equal(v.documentSource.cepFromDocument, true);
  assert.ok(v.documentSource.areaFound && v.documentSource.ageFound && v.documentSource.patternFound && v.documentSource.fiscalFound && v.documentSource.addressFound);
});

test("readDocuments: texto curto é 'não lido'; só a matrícula → faltam os campos do carnê", () => {
  const { docs } = readDocuments(textos([["matricula.pdf", MATRICULA], ["iptu.pdf", "IPTU"]]));
  assert.equal(docs.find((d) => d.fileName === "iptu.pdf").unreadable, true);
  const out = buildInputs(docs);
  assert.deepEqual(out.missing, [
    "ano de construção (esperado no IPTU)",
    "padrão cadastral (esperado no IPTU)",
    "valor do m² do terreno (esperado no IPTU)",
  ]);
});

test("buildInputs: sem matrícula → faltam área e endereço; sem 'apartamento' → recusa", () => {
  const soIptu = readDocuments(textos([["iptu.pdf", CARNE]]));
  assert.deepEqual(buildInputs(soIptu.docs).missing, ["área privativa (esperada na matrícula)", "nenhuma matrícula identificada entre os anexos"]);
  const casa = readDocuments(textos([["iptu.pdf", CARNE], ["matricula.pdf", MATRICULA_CASA]]));
  assert.deepEqual(buildInputs(casa.docs), { notApartment: true });
});

test("readDocuments: duas matrículas é ambíguo", () => {
  const out = readDocuments(textos([["a.pdf", MATRICULA], ["b.pdf", MATRICULA], ["iptu.pdf", CARNE]]));
  assert.equal(out.ambiguous, "matricula");
  assert.deepEqual(buildInputs(out.docs, out.ambiguous), { ambiguous: "matricula" });
});

async function relatorioExemplo() {
  const { docs } = readDocuments(textos([["iptu.pdf", CARNE], ["matricula.pdf", MATRICULA]]));
  const { v } = buildInputs(docs);
  v.district = "Paraíso";
  const { AvmReport } = globalThis;
  const { model } = await import("../src/email.js");
  return AvmReport.build(model, v, AvmReport.estimate(model, v), new Date("2026-09-08T12:00:00Z"));
}

const norm = (s) => String(s).replace(/ /g, " "); // Intl pt-BR usa espaço inseparável depois de "R$"

test("compose(report): identificação, faixa, documentos, premissas, avisos e rodapé", async () => {
  const report = await relatorioExemplo();
  const out = compose("report", { subject: "Avaliação", report, unreadable: [], ignored: ["planilha.xlsx"] });
  assert.equal(out.subject, "Re: Avaliação");
  for (const trecho of [
    "Não é laudo", `Identificação: ${report.id}`, "Rua Vergueiro, 2650 · CEP 04109-002 · Paraíso",
    "área privativa 78 m² (matrícula)", "idade 8 anos / 2018 (IPTU)", "padrão 2-C (IPTU)", "VM2T R$ 6.500/m² (IPTU)",
    "Faixa de 80% de probabilidade: R$", "Valor central: R$", "/m²)",
    "Documentos lidos: iptu.pdf + matricula.pdf — texto do PDF.", "Ignorados: planilha.xlsx.",
    "apartamento residencial (conforme a matrícula)", "SFH / SBPE", report.risks[0],
    "O relatório completo está no Excel anexo.", "processados em memória e não foram armazenados",
  ]) assert.ok(norm(out.text).includes(norm(trecho)), `faltou no texto: ${trecho}`);
  assert.ok(norm(out.html).includes("<p>") && norm(out.html).includes(report.id) && !norm(out.html).includes("<script"));
});

test("compose: recusa, faltou, não lido e ambíguo", () => {
  const refused = compose("refused", { subject: "", reasons: [{ code: "area", text: "área privativa acima de 250 m²" }] });
  assert.equal(refused.subject, "AVM SP — estimativa");
  assert.ok(norm(refused.text).includes("recusada porque o imóvel está fora do domínio do modelo") && norm(refused.text).includes("área privativa acima de 250 m²") && norm(refused.text).includes("Não há relatório."));
  const missing = compose("missing", { subject: "x", missing: ["área privativa (esperada na matrícula)"], unreadable: ["iptu.pdf"], ignored: [] });
  assert.ok(norm(missing.text).includes("Faltou:") && norm(missing.text).includes("- área privativa (esperada na matrícula)") && norm(missing.text).includes("Não foi possível ler: iptu.pdf (sem texto legível)") && norm(missing.text).includes("Reenvie com os documentos completos, em um único e-mail."));
  const unreadable = compose("unreadable", { subject: "x", unreadable: ["a.pdf", "b.pdf"] });
  assert.ok(norm(unreadable.text).includes("Não foi possível ler: a.pdf, b.pdf (sem texto legível).") && norm(unreadable.text).includes("Envie o PDF original digital."));
  const ambiguous = compose("ambiguous", { subject: "x", ambiguous: "matricula" });
  assert.ok(norm(ambiguous.text).includes("mais de uma matrícula") && norm(ambiguous.text).includes("Envie um imóvel por e-mail."));
  const notApartment = compose("refused", { subject: "x", reasons: [{ code: "apartment", text: "a matrícula não descreve um apartamento; o modelo cobre apenas apartamentos residenciais" }] });
  assert.ok(norm(notApartment.text).includes("não descreve um apartamento"));
});

// Serviços falsos: toMarkdown devolve o texto do fixture pelo nome do arquivo; Nominatim devolve um bairro.
const TEXTOS = { "iptu.pdf": CARNE, "matricula.pdf": MATRICULA, "casa.pdf": MATRICULA_CASA, "vazio.pdf": "" };
const ai = { toMarkdown: async (docs) => docs.map((doc) => ({ name: doc.name, mimeType: "application/pdf", format: "text", tokens: 0, data: TEXTOS[doc.name] ?? "" })) };
const nominatimCalls = [];
const fetchFalso = async (url, init) => {
  nominatimCalls.push({ url: String(url), init });
  return { ok: true, json: async () => [{ address: { postcode: "04109-002", suburb: "Paraíso" } }] };
};
const deps = { ai, fetch: fetchFalso, now: new Date("2026-09-08T12:00:00Z") };
const anexos = (nomes) => nomes.map((nome) => [nome, "application/pdf", `%PDF-1.4 ${nome}`]);

test("processEmail: dois PDFs → relatório com Excel anexo e bairro do Nominatim", async () => {
  nominatimCalls.length = 0;
  const out = await processEmail({ raw: raw({ attachments: anexos(["iptu.pdf", "matricula.pdf"]) }), subject: "Avaliação" }, deps);
  assert.equal(out.outcome, "report");
  assert.equal(out.messageId, "<abc123@exemplo.gov.br>");
  assert.equal(out.reply.subject, "Re: Avaliação");
  assert.ok(out.reply.text.includes("Paraíso"));
  assert.equal(out.reply.attachments.length, 1);
  const [xlsx] = out.reply.attachments;
  assert.match(xlsx.filename, /^AVM-SP-20260908-[0-9A-F]{12}\.xlsx$/);
  assert.equal(xlsx.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.ok(xlsx.content instanceof Uint8Array && xlsx.content.length > 1000);
  assert.equal(String.fromCharCode(...xlsx.content.slice(0, 2)), "PK"); // é um zip
  assert.equal(nominatimCalls.length, 1);
  assert.ok(nominatimCalls[0].url.startsWith("https://nominatim.openstreetmap.org/search?"));
  assert.equal(nominatimCalls[0].init.headers["User-Agent"], "AVM-SP/1 (avm@heybrain.uk)");
  assert.deepEqual(out.log, { documents: 2, unreadable: 0, ocr_pages: 0 });
});

test("processEmail: Nominatim falha → relatório sem bairro, sem erro", async () => {
  const out = await processEmail({ raw: raw({ attachments: anexos(["iptu.pdf", "matricula.pdf"]) }), subject: "x" }, { ...deps, fetch: async () => { throw new Error("rede"); } });
  assert.equal(out.outcome, "report");
  assert.ok(out.reply.text.includes("Rua Vergueiro, 2650 · CEP 04109-002\n"));
});

test("processEmail: só matrícula → faltou; matrícula de casa → recusa; sem texto → não lido; duas matrículas → ambíguo", async () => {
  assert.equal((await processEmail({ raw: raw({ attachments: anexos(["matricula.pdf"]) }), subject: "x" }, deps)).outcome, "missing");
  const casa = await processEmail({ raw: raw({ attachments: anexos(["iptu.pdf", "casa.pdf"]) }), subject: "x" }, deps);
  assert.equal(casa.outcome, "refused");
  assert.ok(casa.reply.text.includes("não descreve um apartamento"));
  const vazio = await processEmail({ raw: raw({ attachments: anexos(["vazio.pdf"]) }), subject: "x" }, deps);
  assert.equal(vazio.outcome, "unreadable");
  assert.equal(vazio.log.unreadable, 1);
  const duas = await processEmail({ raw: raw({ attachments: [["a.pdf", "application/pdf", "x"], ["b.pdf", "application/pdf", "y"], ...anexos(["iptu.pdf"])] }), subject: "x" }, { ...deps, ai: { toMarkdown: async (docs) => docs.map((doc) => ({ name: doc.name, data: doc.name === "iptu.pdf" ? CARNE : MATRICULA })) } });
  assert.equal(duas.outcome, "ambiguous");
});

test("processEmail: e-mail sem anexo → Faltou", async () => {
  const out = await processEmail({ raw: raw(), subject: "x" }, deps);
  assert.equal(out.outcome, "missing");
  assert.ok(out.reply.text.includes("nenhuma matrícula identificada entre os anexos"));
  assert.ok(out.reply.text.includes("nenhum documento de IPTU identificado entre os anexos"));
  assert.deepEqual(out.reply.attachments, []);
});

test("processEmail: fora do domínio → recusada com os textos do modelo", async () => {
  const grande = { toMarkdown: async (docs) => docs.map((doc) => ({ name: doc.name, data: doc.name === "iptu.pdf" ? CARNE : MATRICULA.replace("78,00 m²", "300,00 m²") })) };
  const out = await processEmail({ raw: raw({ attachments: anexos(["iptu.pdf", "matricula.pdf"]) }), subject: "x" }, { ...deps, ai: grande });
  assert.equal(out.outcome, "refused");
  assert.ok(out.reply.text.includes("fora do domínio do modelo"));
  assert.deepEqual(out.reply.attachments, []);
});

// OCR (Entrega 2): toMarkdown não vê texto no PDF escaneado; ai.run devolve a transcrição pelo nome do "documento".
const OCR_TEXTS = { carne: CARNE, matricula: MATRICULA, ruido: "kj3h4 kjh34 kjh 3k4jh" };
function aiComOcr(transcricao) {
  const runs = [];
  return {
    runs,
    toMarkdown: async (docs) => docs.map((doc) => ({ name: doc.name, data: TEXTOS[doc.name] ?? "" })), // PDFs escaneados não estão em TEXTOS → ""
    run: async (model, input) => { runs.push({ model, input }); return { choices: [{ message: { content: transcricao(runs.length) } }] }; }, // formato OpenAI do Gemma 4
  };
}
const escaneado = (nome, pages = 1) => [nome, "application/pdf", scannedPdf({ pages })];

test("OCR: carnê escaneado + matrícula digital → relatório com método OCR, aviso e ocr_pages", async () => {
  const ai = aiComOcr(() => OCR_TEXTS.carne);
  const out = await processEmail({ raw: raw({ attachments: [escaneado("iptu-scan.pdf"), ["matricula.pdf", "application/pdf", "%PDF-1.4 m"]] }), subject: "x" }, { ...deps, ai });
  assert.equal(out.outcome, "report", out.reply.text);
  assert.equal(ai.runs.length, 1);
  assert.ok(norm(out.reply.text).includes("Documentos lidos: iptu-scan.pdf + matricula.pdf — OCR (Workers AI) e texto do PDF."));
  assert.ok(out.reply.text.includes("obtida por OCR (Workers AI)"));
  assert.deepEqual(out.log, { documents: 2, unreadable: 0, ocr_pages: 1 });
});

test("OCR: texto do PDF incompleto → OCR completa e o método vira 'texto do PDF + OCR (Workers AI)'", async () => {
  // toMarkdown devolve só o cabeçalho do carnê (sem ano/padrão/VM2T); o OCR traz o resto.
  const parcial = { ...TEXTOS, "iptu-parcial.pdf": CARNE.split("DADOS DO IMÓVEL")[0] + " ".repeat(200) };
  const ai = { toMarkdown: async (docs) => docs.map((doc) => ({ name: doc.name, data: parcial[doc.name] ?? "" })), run: async () => ({ choices: [{ message: { content: CARNE } }] }) };
  const out = await processEmail({ raw: raw({ attachments: [["iptu-parcial.pdf", "application/pdf", scannedPdf()], ["matricula.pdf", "application/pdf", "%PDF-1.4 m"]] }), subject: "x" }, { ...deps, ai });
  assert.equal(out.outcome, "report", out.reply.text);
  assert.ok(norm(out.reply.text).includes("texto do PDF + OCR (Workers AI)"));
});

test("OCR: imagem anexada (jpeg) é transcrita direto; ruído vira 'Faltou', nunca número inventado", async () => {
  const ai = aiComOcr((n) => (n === 1 ? OCR_TEXTS.matricula : OCR_TEXTS.carne));
  const ok = await processEmail({ raw: raw({ attachments: [["matricula.jpg", "image/jpeg", "\xff\xd8\xff\xe0" + "x".repeat(25 * 1024)], escaneado("iptu-scan.pdf")] }), subject: "x" }, { ...deps, ai });
  assert.equal(ok.outcome, "report", ok.reply.text);
  assert.equal(ok.log.ocr_pages, 2);
  assert.ok(JSON.stringify(ai.runs[0].input).includes("data:image/jpeg;base64,"));
  const ruim = await processEmail({ raw: raw({ attachments: [escaneado("iptu-scan.pdf"), ["matricula.pdf", "application/pdf", "%PDF-1.4 m"]] }), subject: "x" }, { ...deps, ai: aiComOcr(() => OCR_TEXTS.ruido) });
  assert.equal(ruim.outcome, "missing");
  assert.ok(ruim.reply.text.includes("ano de construção (esperado no IPTU)")); // brief dizia "esperado no carnê de IPTU"; texto real (Task 1b) é "esperado no IPTU"
});

test("OCR: transcrição longa e sem sentido não vira matrícula fantasma → Faltou, não ambíguo", async () => {
  const ai = aiComOcr(() => "kj3h4 kjh34 ".repeat(60)); // ~720 caracteres, passa do teto de texto curto, mas sem nenhum campo
  const out = await processEmail({ raw: raw({ attachments: [escaneado("iptu-scan.pdf"), ["matricula.pdf", "application/pdf", "%PDF-1.4 m"]] }), subject: "x" }, { ...deps, ai });
  assert.equal(out.outcome, "missing", out.reply.text);
  assert.ok(out.reply.text.includes("nenhum documento de IPTU identificado entre os anexos"));
  assert.ok(out.reply.text.includes("Não foi possível ler: iptu-scan.pdf (sem texto legível)"));
  assert.equal(out.log.unreadable, 1);
});

test("OCR: teto de 8 páginas por e-mail e 4 por documento", async () => {
  const ai = aiComOcr(() => OCR_TEXTS.ruido);
  const out = await processEmail({ raw: raw({ attachments: [escaneado("a.pdf", 6), escaneado("b.pdf", 6), escaneado("c.pdf", 6)] }), subject: "x" }, { ...deps, ai });
  assert.equal(ai.runs.length, 8); // 4 + 4 + 0
  assert.equal(out.log.ocr_pages, 8);
});

test("OCR: falha do modelo também consome o orçamento — nunca mais de 8 chamadas por e-mail", async () => {
  let calls = 0;
  const ai = { toMarkdown: async (docs) => docs.map((doc) => ({ name: doc.name, data: "" })), run: async () => { calls += 1; throw new Error("modelo indisponível"); } };
  const out = await processEmail({ raw: raw({ attachments: [escaneado("a.pdf", 6), escaneado("b.pdf", 6), escaneado("c.pdf", 6)] }), subject: "x" }, { ...deps, ai });
  assert.equal(calls, 8); // 4 + 4 + 0, mesmo sem nenhuma transcrição bem-sucedida
  assert.equal(out.log.ocr_pages, 8);
  assert.equal(out.outcome, "unreadable");
});

test("OCR: sem imagem nenhuma no PDF → continua 'não lido', sem chamar o modelo", async () => {
  const ai = aiComOcr(() => OCR_TEXTS.carne);
  const out = await processEmail({ raw: raw({ attachments: [["vazio.pdf", "application/pdf", "%PDF-1.4 sem imagem"]] }), subject: "x" }, { ...deps, ai });
  assert.equal(out.outcome, "unreadable");
  assert.equal(ai.runs.length, 0);
});

test("allowedSender: domínio exato ou endereço exato, sem diferenciar maiúsculas", () => {
  const lista = "@Exemplo.gov.br, pessoa@empresa.com.br";
  assert.equal(allowedSender("Fulano@exemplo.gov.br", lista), true);
  assert.equal(allowedSender("pessoa@EMPRESA.com.br", lista), true);
  assert.equal(allowedSender("x@sub.exemplo.gov.br", lista), false);
  assert.equal(allowedSender("outra@empresa.com.br", lista), false);
  assert.equal(allowedSender("", lista), false);
  assert.equal(allowedSender("a@b.c", ""), false);
  assert.equal(allowedSender("a@b.c", undefined), false);
});

function mensagem({ from = "pessoa@exemplo.gov.br", attachments = anexos(["iptu.pdf", "matricula.pdf"]), messageId = "<abc123@exemplo.gov.br>", size, extraHeaders = {}, rawThrows = false } = {}) {
  const subject = "Avaliação";
  const body = mime({ from, attachments, messageId, subject, extraHeaders });
  // A plataforma entrega o cabeçalho Subject como o remetente escreveu, codificado em RFC 2047 quando tem acento.
  const headers = new Headers({ subject: `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`, ...extraHeaders });
  if (messageId) headers.set("message-id", messageId);
  const msg = {
    from, to: "avm@heybrain.uk", headers,
    rawSize: size ?? body.length,
    rejected: null, setReject(reason) { this.rejected = reason; },
  };
  // Getter definido à parte: um spread avaliaria (e explodiria) a propriedade na hora de montar o objeto.
  if (rawThrows) Object.defineProperty(msg, "raw", { get() { throw new Error("corpo lido"); } });
  else msg.raw = new Blob([body]).stream();
  return msg;
}

function ambiente({ allow = true, sendFails = false } = {}) {
  const sent = [];
  return {
    sent,
    env: {
      ALLOWED_SENDERS: "@exemplo.gov.br",
      EMAIL_FROM: "avm@heybrain.uk",
      EMAIL_RL: { limit: async () => ({ success: allow }) },
      AI: ai,
      EMAIL: { send: async (msg) => { if (sendFails) throw new Error("quota"); sent.push(msg); return { messageId: "<resp@heybrain.uk>" }; } },
      ASSETS: { fetch: async () => new Response("asset") },
    },
  };
}

const logs = [];
const realLog = console.log;
test.before(() => { console.log = (line) => logs.push(JSON.parse(line)); globalThis.fetch = fetchFalso; });
test.after(() => { console.log = realLog; });

test("email(): remetente fora da lista → setReject sem ler nem responder", async () => {
  const { env, sent } = ambiente();
  const msg = mensagem({ from: "spam@outro.com", rawThrows: true }); // .raw explode se for lido: prova que o handler nem tenta
  await worker.email(msg, env, {});
  assert.match(msg.rejected, /não autorizado/);
  assert.equal(sent.length, 0);
  assert.deepEqual(logs.at(-1).event, "email_rejected");
  assert.equal(logs.at(-1).reason, "unauthorized");
  assert.equal("from" in logs.at(-1), false);
});

test("email(): limite e tamanho → setReject", async () => {
  const limitado = ambiente({ allow: false });
  const m1 = mensagem();
  await worker.email(m1, limitado.env, {});
  assert.match(m1.rejected, /Limite/);
  const m2 = mensagem({ size: 21 * 1024 * 1024 });
  await worker.email(m2, ambiente().env, {});
  assert.match(m2.rejected, /grande demais/);
  assert.equal(logs.at(-1).reason, "too_large");
});

test("email(): caminho feliz → um send com Excel, na mesma conversa, e log sem dados pessoais", async () => {
  const { env, sent } = ambiente();
  const msg = mensagem();
  await worker.email(msg, env, {});
  assert.equal(msg.rejected, null);
  assert.equal(sent.length, 1);
  const [mail] = sent;
  assert.equal(mail.to, "pessoa@exemplo.gov.br");
  assert.deepEqual(mail.from, { email: "avm@heybrain.uk", name: "AVM SP" });
  assert.equal(mail.subject, "Re: Avaliação");
  assert.equal(mail.headers["In-Reply-To"], "<abc123@exemplo.gov.br>");
  assert.equal(mail.headers.References, "<abc123@exemplo.gov.br>");
  assert.ok(mail.text.includes("Identificação: AVM-SP-") && mail.html.includes("AVM-SP-"));
  assert.equal(mail.attachments.length, 1);
  assert.match(mail.attachments[0].filename, /\.xlsx$/);
  const log = logs.at(-1);
  assert.equal(log.event, "email_processed");
  assert.equal(log.outcome, "report");
  assert.equal(log.documents, 2);
  assert.equal(typeof log.ms, "number");
  assert.equal(JSON.stringify(log).includes("exemplo.gov.br"), false);
  assert.equal(JSON.stringify(log).includes("iptu.pdf"), false);
});

test("email(): sem Message-ID não manda cabeçalhos de conversa; send falha → setReject", async () => {
  const { env, sent } = ambiente();
  await worker.email(mensagem({ messageId: null }), env, {});
  assert.equal(sent.at(-1).headers["In-Reply-To"], undefined);
  assert.equal(sent.at(-1).headers["X-Auto-Response-Suppress"], "All");
  const falho = ambiente({ sendFails: true });
  const msg = mensagem();
  await worker.email(msg, falho.env, {});
  assert.match(msg.rejected, /Falha temporária/);
  assert.equal(logs.at(-1).event, "email_send_failed");
  assert.equal(logs.at(-1).error, "Error");
});

test("email(): mensagem automática (Auto-Submitted) é descartada sem resposta e sem bounce", async () => {
  const { env, sent } = ambiente();
  const msg = mensagem({ extraHeaders: { "auto-submitted": "auto-replied" } });
  await worker.email(msg, env, {});
  assert.equal(msg.rejected, null);
  assert.equal(sent.length, 0);
  assert.deepEqual(logs.at(-1), { event: "email_dropped", reason: "auto_submitted", ms: logs.at(-1).ms });
});

test("email(): mensagem em lista (Precedence: bulk) é descartada sem resposta e sem bounce", async () => {
  const { env, sent } = ambiente();
  const msg = mensagem({ extraHeaders: { precedence: "bulk" } });
  await worker.email(msg, env, {});
  assert.equal(msg.rejected, null);
  assert.equal(sent.length, 0);
  assert.equal(logs.at(-1).event, "email_dropped");
  assert.equal(logs.at(-1).reason, "auto_submitted");
});

test("email(): Message-ID longo demais → responde sem cabeçalhos de conversa", async () => {
  const { env, sent } = ambiente();
  const messageId = "<" + "a".repeat(600) + "@exemplo.gov.br>";
  await worker.email(mensagem({ messageId }), env, {});
  assert.equal(sent.length, 1);
  assert.equal(sent.at(-1).headers["In-Reply-To"], undefined);
  assert.equal(sent.at(-1).headers["X-Auto-Response-Suppress"], "All");
});

test("email(): erro inesperado no processamento → setReject, sem send, log só com o nome do erro", async () => {
  const { env, sent } = ambiente();
  const msg = mensagem();
  const original = globalThis.AVMExcel.buildWorkbook; // força uma exceção fora dos try/catch do pipeline
  globalThis.AVMExcel.buildWorkbook = () => { throw new TypeError("planilha indisponível"); };
  try {
    await worker.email(msg, env, {});
  } finally {
    globalThis.AVMExcel.buildWorkbook = original;
  }
  assert.match(msg.rejected, /Erro interno ao processar/);
  assert.equal(sent.length, 0);
  const log = logs.at(-1);
  assert.equal(log.event, "email_processed");
  assert.equal(log.outcome, "error");
  assert.equal(log.error, "TypeError");
  assert.equal(JSON.stringify(log).includes("planilha indisponível"), false); // só error.name, nunca a mensagem
});
