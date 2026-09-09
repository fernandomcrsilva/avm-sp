// /manual mostra o PDF como imagens (Chrome do Android não exibe PDF em iframe): o número de páginas do PDF, o
// de arquivos p*.webp e o de <img> no HTML têm de bater, e o texto do botão ("N páginas · K KB") também. Quem
// regenera o manual (scripts/render-manual.sh) e esquece o site/manual.html cai aqui. Rodar: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { getDocumentProxy } from "unpdf";

const site = new URL("../site/", import.meta.url);
const html = readFileSync(new URL("manual.html", site), "utf8");
const pdfPath = new URL("manual-avm-sp-v7.pdf", site);

test("manual: PDF, imagens .webp e <img> têm o mesmo número de páginas", async () => {
  const pdf = await getDocumentProxy(new Uint8Array(readFileSync(pdfPath)));
  const n = pdf.numPages;
  const webps = readdirSync(new URL("assets/manual/", site)).filter((f) => /^p\d\d\.webp$/.test(f));
  const imgs = [...html.matchAll(/<img src="assets\/manual\/(p\d\d\.webp)"/g)].map((m) => m[1]);
  assert.equal(webps.length, n, "arquivos .webp");
  assert.deepEqual(imgs, webps.sort(), "cada .webp aparece uma vez, em ordem");
  const totals = [...html.matchAll(/página \d+ de (\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(totals.length, n, "um alt por página");
  assert.ok(totals.every((t) => t === n), `alts dizem "de ${n}"`);
  assert.match(html, new RegExp(`${n} páginas · `), "texto do botão");
});

test("manual: o tamanho anunciado do PDF está certo (± 10 KB)", () => {
  const kb = Number(html.match(/(\d+) KB<\/small>/)[1]);
  assert.ok(Math.abs(kb - statSync(pdfPath).size / 1024) <= 10, `anunciado ${kb} KB`);
});
