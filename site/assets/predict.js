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

  // Domínio de treino (model.applicability). Devolve motivos de recusa; lista vazia = dentro do domínio.
  // Só verifica variáveis habilitadas: uma variável desabilitada não entra no modelo escolhido.
  // O preço estimado é verificado à parte em priceReason(), porque só existe depois do cálculo.
  const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  const num = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
  const between = (x, [lo, hi]) => Number.isFinite(x) && x >= lo && x <= hi;

  // Cada motivo é { code, text }: o texto vai para a tela, só o código vai para o aviso técnico.
  function limitReasons(model, input) {
    const a = model.applicability;
    const enabled = input.enabledVariables || [];
    const reasons = [];
    if (enabled.includes("area") && !between(input.area, a.area_m2)) {
      reasons.push({ code: "area", text: `área de ${num.format(input.area)} m² fora da faixa de treino de ${a.area_m2[0]} a ${a.area_m2[1]} m²` });
    }
    if (enabled.includes("age") && !between(input.yearBuilt, a.year_built)) {
      reasons.push({ code: "year", text: `ano de conclusão ${input.yearBuilt} fora da faixa de treino de ${a.year_built[0]} a ${a.year_built[1]}` });
    }
    if (enabled.includes("pattern") && !a.pattern_codes.includes(Number(input.pattern))) {
      reasons.push({ code: "pattern", text: `padrão IPTU código ${input.pattern} sem transações na base de treino` });
    }
    if (enabled.includes("fiscal") && !between(input.fiscal, a.fiscal_vm2t_brl)) {
      reasons.push({ code: "fiscal", text: `valor fiscal (VM2T) de ${brl.format(input.fiscal)}/m² fora da faixa observada de ${brl.format(a.fiscal_vm2t_brl[0])} a ${brl.format(a.fiscal_vm2t_brl[1])}/m²` });
    }
    if (!input.declared) {
      reasons.push({ code: "declared", text: `sem a confirmação de que é apartamento residencial (uso IPTU ${a.use_iptu}), com inscrição predial ativa, em compra e venda` });
    }
    return reasons;
  }

  function priceReason(model, price) {
    const [lo, hi] = model.applicability.price_brl;
    if (between(price, [lo, hi])) return null;
    return { code: "price", text: `valor central estimado de ${brl.format(price)} fora da faixa de preços de treino de ${brl.format(lo)} a ${brl.format(hi)}` };
  }

  root.AvmPredict = { modelKey, features, logPrice, interval, limitReasons, priceReason };
})(typeof globalThis !== "undefined" ? globalThis : this);
