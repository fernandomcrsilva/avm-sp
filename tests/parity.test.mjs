// Paridade Python↔JS: a equação em site/assets/predict.js tem que reproduzir tests/parity_fixture.json
// (gerada pelo sklearn em train_model.py, ou pela fórmula em scripts/parity_fixture.py) dentro de 1e-9 em ln(preço).
// Rodar: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const modelBytes = readFileSync(new URL("site/assets/model.json", root));
const model = JSON.parse(modelBytes.toString("utf8"));
const fixture = JSON.parse(readFileSync(new URL("tests/parity_fixture.json", root), "utf8"));
vm.runInThisContext(readFileSync(new URL("site/assets/predict.js", root), "utf8"));
const { AvmPredict } = globalThis;

test("fixture foi gerada para este model.json", () => {
  assert.equal(fixture.model_sha256, createHash("sha256").update(modelBytes).digest("hex"),
    "model.json mudou: regenere a fixture (train_model.py ou scripts/parity_fixture.py)");
  assert.equal(fixture.model_version, model.version);
});

test(`ln(preço) bate com a referência ${fixture.reference} em todos os modelos e casos`, () => {
  const keys = Object.keys(model.models);
  assert.equal(keys.length, 15);
  let checked = 0;
  for (const { input, expected_log_price } of fixture.cases) {
    for (const key of keys) {
      const js = AvmPredict.logPrice(model, key, input);
      const diff = Math.abs(js - expected_log_price[key]);
      assert.ok(diff < fixture.tolerance_log, `${key} ${JSON.stringify(input)}: |Δ|=${diff}`);
      checked += 1;
    }
  }
  assert.equal(checked, fixture.cases.length * 15);
});

test("modelKey segue variable_order e intervalo é simétrico em log", () => {
  assert.equal(AvmPredict.modelKey(model, ["fiscal", "area"]), "area+fiscal");
  const q = model.models[model.default_model_key].conformal_q80_log;
  const { value, low, high } = AvmPredict.interval(Math.log(500_000), q);
  assert.ok(Math.abs(value - 500_000) < 1e-6);
  assert.ok(Math.abs(Math.log(high) - Math.log(value) - q) < 1e-12);
  assert.ok(Math.abs(Math.log(value) - Math.log(low) - q) < 1e-12);
});
