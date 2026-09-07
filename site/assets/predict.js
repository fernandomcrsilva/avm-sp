/* Equação hedônica do AVM-SP lida do model.json. Único lugar onde a predição é calculada.
 * Espelho de scripts/parity_fixture.py; a paridade com o Python é testada em tests/parity.test.mjs.
 * ponytail: script clássico que expõe globalThis.AvmPredict — o site não tem bundler e o teste em Node
 * carrega este arquivo com vm.runInThisContext. */
(function (root) {
  "use strict";

  function modelKey(model, enabledVariables) {
    return model.variable_order.filter((variable) => enabledVariables.includes(variable)).join("+");
  }

  // input: { area (m²), age (anos, 0–20), pattern (código IPTU, "20".."25"), fiscal (VM2T R$/m²) }
  function features(input) {
    const logArea = Math.log(input.area / 80);
    const logFiscal = Math.log(input.fiscal / 3000);
    const age = Number(input.age);
    return {
      log_area: logArea,
      log_area2: logArea ** 2,
      log_area3: logArea ** 3,
      age,
      age2: (age / 10) ** 2,
      log_fiscal: logFiscal,
      log_fiscal2: logFiscal ** 2,
    };
  }

  // ln(preço) para o modelo `key`. Lança se a combinação não tiver modelo treinado.
  function logPrice(model, key, input) {
    const selected = model.models[key];
    if (!selected) throw new Error(`Combinação de variáveis sem modelo treinado: ${key}`);
    const f = features(input);
    const num = selected.numeric;
    let y = selected.intercept;
    for (let i = 0; i < num.features.length; i += 1) {
      y += num.coefficients[i] * (f[num.features[i]] - num.means[i]) / num.scales[i];
    }
    const patternCoefs = selected.category_coefficients.pattern;
    if (patternCoefs) y += patternCoefs[String(input.pattern)] ?? 0; // categoria desconhecida: 0 (handle_unknown="ignore")
    return y;
  }

  // faixa de 80%: split conformal simétrico em log => multiplicativo em R$
  function interval(logValue, conformalQ80Log) {
    return {
      value: Math.exp(logValue),
      low: Math.exp(logValue - conformalQ80Log),
      high: Math.exp(logValue + conformalQ80Log),
    };
  }

  root.AvmPredict = { modelKey, features, logPrice, interval };
})(typeof globalThis !== "undefined" ? globalThis : this);
