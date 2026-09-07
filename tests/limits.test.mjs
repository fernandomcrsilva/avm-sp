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
  assert.match(AvmPredict.priceReason(model, a.price_brl[1] * 2).text, /fora da faixa de preços/);
  assert.equal(AvmPredict.priceReason(model, a.price_brl[0] / 2).code, "price");
  assert.deepEqual(AvmPredict.limitReasons(model, { ...ok, area: 999, declared: false }).map((r) => r.code), ["area", "declared"]);
});

test("preço por m² só é verificado com a área habilitada", () => {
  const a = model.applicability;
  assert.equal(AvmPredict.priceReason(model, 500_000, 78), null);
  assert.equal(AvmPredict.priceReason(model, a.price_brl[1], a.area_m2[0]).code, "price_m2"); // teto de preço / área mínima > teto por m²
  assert.equal(AvmPredict.priceReason(model, a.price_brl[0], a.area_m2[1]).code, "price_m2"); // piso de preço / área máxima < piso por m²
  assert.equal(AvmPredict.priceReason(model, a.price_brl[0], NaN), null); // área desabilitada: não verifica
  assert.equal(AvmPredict.priceReason(model, a.price_brl[1] * 2, 78).code, "price"); // o preço central vem primeiro
});

test("variável desabilitada não é verificada; área vazia com área desabilitada passa", () => {
  const reasons = AvmPredict.limitReasons(model, { ...ok, area: NaN, enabledVariables: ["age", "pattern", "fiscal"] });
  assert.deepEqual(reasons, []);
});

test("confiança cai com variáveis fora do cálculo e com falta de suporte local", () => {
  const cep = { cep8: "04109002" };
  const forte = { n: 216 };
  assert.equal(AvmPredict.confidence(cep, forte, []).level, "Alta");
  assert.equal(AvmPredict.confidence(cep, forte, ["fiscal"]).level, "Média");
  assert.equal(AvmPredict.confidence(cep, forte, ["fiscal", "pattern"]).level, "Baixa");
  assert.equal(AvmPredict.confidence(cep, forte, ["fiscal", "pattern", "age"]).level, "Baixa"); // não desce abaixo do piso
  assert.equal(AvmPredict.confidence({ cep8: "" }, null, []).level, "Média");
  assert.equal(AvmPredict.confidence(cep, { n: 3 }, []).level, "Média");
  assert.equal(AvmPredict.confidence(cep, null, ["fiscal"]).level, "Baixa");
  assert.deepEqual(AvmPredict.confidence(cep, forte, []).reasons, ["4 variáveis no cálculo", "216 transações na região"]);
});
