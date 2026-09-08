// AvmReport é o único lugar que monta o relatório: site (app.js) e Worker (src/email.js) chamam o mesmo
// código, então a identificação e os avisos são idênticos para as mesmas entradas. Rodar: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const model = JSON.parse(readFileSync(new URL("site/assets/model.json", root), "utf8"));
vm.runInThisContext(readFileSync(new URL("site/assets/predict.js", root), "utf8"));
vm.runInThisContext(readFileSync(new URL("site/assets/report.js", root), "utf8"));
const { AvmPredict, AvmReport } = globalThis;

const exemplo = () => ({
  address: "Rua Vergueiro, 2650", district: "Paraíso", cep: "04109-002", cep8: "04109002",
  area: 78, age: 8, yearBuilt: model.applicability.base_year - 8, pattern: "22", fiscal: 6500,
  financing: "SFH", funds: "SBPE", declared: true, enabledVariables: ["area", "age", "pattern", "fiscal"],
  documentSource: { fileName: "iptu.pdf + matricula.pdf", method: "texto do PDF", addressFound: true, areaFound: true, areaLabel: "Área privativa", ageFound: true, patternFound: true, fiscalFound: true, cepFromDocument: true, geocode: null },
});

test("estimate recusa fora do domínio com os textos de AvmPredict", () => {
  const v = { ...exemplo(), area: 300 };
  const out = AvmReport.estimate(model, v);
  assert.deepEqual(out.refused, AvmPredict.limitReasons(model, v));
  assert.ok(out.refused.length > 0);
});

test("estimate reproduz a sequência do site", () => {
  const v = exemplo();
  const out = AvmReport.estimate(model, v);
  assert.equal(out.refused, undefined);
  const key = AvmPredict.modelKey(model, v.enabledVariables);
  const interval = AvmPredict.interval(AvmPredict.logPrice(model, key, v), model.models[key].conformal_q80_log);
  assert.equal(out.modelKey, key);
  assert.equal(out.interval.value, interval.value);
  assert.deepEqual(out.disabled, []);
  assert.equal(out.stats.level, "CEP4");
});

test("build: identificação estável, patternLabel, avisos de leitura automática", async () => {
  const v = exemplo();
  const computed = AvmReport.estimate(model, v);
  const now = new Date("2026-09-08T12:00:00Z");
  const a = await AvmReport.build(model, v, computed, now);
  const b = await AvmReport.build(model, v, computed, now);
  assert.match(a.id, /^AVM-SP-20260908-[0-9A-F]{12}$/);
  assert.equal(a.id, b.id);
  assert.equal(a.property.patternLabel, "2-C");
  assert.equal(a.result.estimate, Math.round(computed.interval.value));
  assert.equal(a.result.pricePerM2, Math.round(computed.interval.value / 78));
  assert.ok(a.risks.some((r) => r.includes("leitura automática de iptu.pdf + matricula.pdf")));
  assert.ok(a.risks.some((r) => r.includes("VM2T")));
  assert.equal(a.variables.labels.area, "Área privativa");
  assert.equal(typeof a.model.trainedAt, "string");
});

test("riskList avisa quando parte do texto veio de OCR", () => {
  const v = exemplo();
  v.documentSource.method = "texto do PDF + OCR (Workers AI)";
  const risks = AvmReport.riskList(v, null, []);
  assert.ok(risks.some((r) => r.includes("obtida por OCR (Workers AI)")));
  assert.equal(AvmReport.riskList(exemplo(), null, []).some((r) => r.includes("OCR")), false);
});
