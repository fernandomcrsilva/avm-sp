// Pipeline do AVM por e-mail (src/email.js) e handler email() do Worker. Node puro: env, message e serviços
// falsos; o texto dos PDFs vem do fixture, então os bytes dos anexos não importam. Rodar: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { CARNE, MATRICULA, MATRICULA_CASA } from "./fixtures/textos.mjs";
import { LIMITS, parseInbound } from "../src/email.js";

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
