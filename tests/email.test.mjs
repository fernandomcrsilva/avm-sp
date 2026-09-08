// Pipeline do AVM por e-mail (src/email.js) e handler email() do Worker. Node puro: env, message e serviços
// falsos; o texto dos PDFs vem do fixture, então os bytes dos anexos não importam. Rodar: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { CARNE, MATRICULA, MATRICULA_CASA } from "./fixtures/textos.mjs";
import { LIMITS, parseInbound, readDocuments, buildInputs, compose } from "../src/email.js";

// Monta um e-mail multipart/mixed em RFC 5322. attachments: [[nome, tipo MIME, conteúdo (string)]].
export function mime({ from = "pessoa@exemplo.gov.br", subject = "Avaliação do apartamento", messageId = "<abc123@exemplo.gov.br>", attachments = [] } = {}) {
  const boundary = "fronteira-avm";
  const parts = attachments.map(([name, type, content]) => [
    `--${boundary}`, `Content-Type: ${type}; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`,
    "Content-Transfer-Encoding: base64", "", Buffer.from(content).toString("base64"),
  ].join("\r\n"));
  return [
    `From: Pessoa <${from}>`, "To: avm@heybrain.uk", `Subject: ${subject}`, messageId ? `Message-ID: ${messageId}` : null,
    "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "", "Seguem os documentos.",
    ...parts, `--${boundary}--`, "",
  ].filter((line) => line !== null).join("\r\n");
}

const raw = (options) => new TextEncoder().encode(mime(options)).buffer;

test("parseInbound: só PDFs e imagens, respeitando os tetos", async () => {
  const parsed = await parseInbound(raw({ attachments: [
    ["iptu.pdf", "application/pdf", "%PDF-1.4 carne"],
    ["matricula.PDF", "application/octet-stream", "%PDF-1.4 matricula"], // tipo genérico, extensão .pdf
    ["foto.jpg", "image/jpeg", "jpeg"],
    ["planilha.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "x"],
  ] }));
  assert.equal(parsed.messageId, "<abc123@exemplo.gov.br>");
  assert.equal(parsed.subject, "Avaliação do apartamento");
  assert.deepEqual(parsed.attachments.map((a) => [a.fileName, a.mimeType]), [["iptu.pdf", "application/pdf"], ["matricula.PDF", "application/pdf"], ["foto.jpg", "image/jpeg"]]);
  assert.ok(parsed.attachments[0].bytes instanceof Uint8Array && parsed.attachments[0].bytes.length > 0);
  assert.deepEqual(parsed.ignored, ["planilha.xlsx"]);
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
    "ano de construção (esperado no carnê de IPTU)",
    "padrão cadastral (esperado no carnê de IPTU)",
    "valor do m² do terreno (esperado no carnê de IPTU)",
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
    "https://avm.heybrain.uk/metodologia", "processados em memória e não foram armazenados",
  ]) assert.ok(norm(out.text).includes(norm(trecho)), `faltou no texto: ${trecho}`);
  assert.ok(norm(out.html).includes("<p>") && norm(out.html).includes(report.id) && !norm(out.html).includes("<script"));
});

test("compose: recusa, faltou, não lido e ambíguo", () => {
  const refused = compose("refused", { subject: "", reasons: [{ code: "area", text: "área privativa acima de 250 m²" }] });
  assert.equal(refused.subject, "AVM SP — estimativa");
  assert.ok(norm(refused.text).includes("recusada porque o imóvel está fora do domínio do modelo") && norm(refused.text).includes("área privativa acima de 250 m²") && norm(refused.text).includes("Não há relatório."));
  const missing = compose("missing", { subject: "x", missing: ["área privativa (esperada na matrícula)"], unreadable: ["iptu.pdf"], ignored: [] });
  assert.ok(norm(missing.text).includes("Faltou:") && norm(missing.text).includes("- área privativa (esperada na matrícula)") && norm(missing.text).includes("Não foi possível ler: iptu.pdf (sem camada de texto)") && norm(missing.text).includes("Reenvie com os documentos completos, em um único e-mail."));
  const unreadable = compose("unreadable", { subject: "x", unreadable: ["a.pdf", "b.pdf"] });
  assert.ok(norm(unreadable.text).includes("Não foi possível ler: a.pdf, b.pdf (sem camada de texto).") && norm(unreadable.text).includes("Envie o PDF original digital."));
  const ambiguous = compose("ambiguous", { subject: "x", ambiguous: "matricula" });
  assert.ok(norm(ambiguous.text).includes("mais de uma matrícula") && norm(ambiguous.text).includes("Envie um imóvel por e-mail."));
  const notApartment = compose("refused", { subject: "x", reasons: [{ code: "apartment", text: "a matrícula não descreve um apartamento; o modelo cobre apenas apartamentos residenciais" }] });
  assert.ok(norm(notApartment.text).includes("não descreve um apartamento"));
});
