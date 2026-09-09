// scripts/eml-exemplo.mjs gera o e-mail do teste local do RUNBOOK ("Estimativa por e-mail"): carnê e matrícula
// sintéticos (tests/fixtures/textos.mjs) como PDFs com camada de texto, num multipart/mixed com Message-ID.
// Aqui: o PDF tem texto de verdade (o pdf.js lê de volta, acentos inclusive) e o .eml passa pelo parseInbound
// do pipeline. Rodar: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { extractText, getDocumentProxy } from "unpdf";
import { textPdf } from "./fixtures/pdf.mjs";
import { CARNE } from "./fixtures/textos.mjs";
import { parseInbound } from "../src/email.js";

test("textPdf: o texto sai de volta pelo pdf.js, com acentos e símbolos do WinAnsi", async () => {
  const pdf = await getDocumentProxy(textPdf(CARNE.trim().split("\n")));
  const { text } = await extractText(pdf, { mergePages: true });
  assert.equal(pdf.numPages, 1);
  assert.match(text, /Ano da Construção Corrigido: 2018/);
  assert.match(text, /Área Construída \(m²\): 98,00/);
  assert.match(text, /Valor do m² do Terreno \(R\$\): 6\.500,00/);
});

test("textPdf: caractere fora do Latin-1 vira hífen em vez de quebrar o PDF", async () => {
  const pdf = await getDocumentProxy(textPdf(["a — b (c) \\ d"]));
  const { text } = await extractText(pdf, { mergePages: true });
  assert.match(text, /a - b \(c\) \\ d/);
});

test("eml-exemplo: gera um e-mail que o pipeline aceita, com os dois PDFs", async () => {
  const script = new URL("../scripts/eml-exemplo.mjs", import.meta.url).pathname;
  const eml = execFileSync(process.execPath, [script], { encoding: "utf8" });
  assert.match(eml, /^From: .*teste@exemplo\.gov\.br/m);
  assert.match(eml, /^To: avm@heybrain\.uk/m);
  assert.match(eml, /^Message-ID: <local-\d+@exemplo\.gov\.br>/m);
  const inbound = await parseInbound(new TextEncoder().encode(eml).buffer);
  assert.deepEqual(inbound.attachments.map((a) => [a.fileName, a.mimeType]), [["iptu.pdf", "application/pdf"], ["matricula.pdf", "application/pdf"]]);
  assert.deepEqual(inbound.ignored, []);
  assert.equal(new TextDecoder("latin1").decode(inbound.attachments[0].bytes.subarray(0, 5)), "%PDF-");
});
