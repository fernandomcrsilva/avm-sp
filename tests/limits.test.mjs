// Recusa fora do domínio de treino: AvmPredict.limitReasons/priceReason leem model.applicability.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const model = JSON.parse(readFileSync(new URL("site/assets/model.json", root), "utf8"));
vm.runInThisContext(readFileSync(new URL("site/assets/predict.js", root), "utf8"));
const { AvmPredict } = globalThis;
const ok = { area: 78, yearBuilt: 2018, pattern: "22", fiscal: 6500, declared: true, enabledVariables: ["area", "age", "pattern", "fiscal"] };

test("imóvel típico passa sem motivos", () => {
  assert.deepEqual(AvmPredict.limitReasons(model, ok), []);
  assert.equal(AvmPredict.priceReason(model, 500_000), null);
});

test("cada limite gera um motivo", () => {
  const a = model.applicability;
  assert.equal(AvmPredict.limitReasons(model, { ...ok, area: a.area_m2[1] + 50 }).length, 1);
  assert.equal(AvmPredict.limitReasons(model, { ...ok, yearBuilt: a.year_built[0] - 1 }).length, 1);
  assert.equal(AvmPredict.limitReasons(model, { ...ok, pattern: "99" }).length, 1);
  assert.equal(AvmPredict.limitReasons(model, { ...ok, fiscal: a.fiscal_vm2t_brl[1] * 2 }).length, 1);
  assert.equal(AvmPredict.limitReasons(model, { ...ok, declared: false }).length, 1);
  assert.match(AvmPredict.priceReason(model, a.price_brl[1] * 2), /fora da faixa de preços/);
  assert.match(AvmPredict.priceReason(model, a.price_brl[0] / 2), /fora da faixa de preços/);
});

test("variável desabilitada não é verificada; área vazia com área desabilitada passa", () => {
  const reasons = AvmPredict.limitReasons(model, { ...ok, area: NaN, enabledVariables: ["age", "pattern", "fiscal"] });
  assert.deepEqual(reasons, []);
});
