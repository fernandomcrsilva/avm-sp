/* Montagem do relatório do AVM-SP: recusa, cálculo e objeto final. Único lugar onde isso acontece —
 * o site (app.js) e o Worker de e-mail (src/email.js) chamam este módulo, então a identificação e os
 * avisos são idênticos para as mesmas entradas. Puro: sem DOM, sem fetch.
 * ponytail: script clássico em globalThis, como predict.js — sem bundler no site, carregado em Node por vm. */
(function (root) {
  "use strict";

  const VARIABLE_LABELS = { area: "Área privativa", age: "Idade", pattern: "Padrão IPTU", fiscal: "Valor fiscal PGV" };
  const dateFmt = new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" });
  const monthFmt = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" });

  // ponytail: isoDate/monthLabel/sha256Hex repetem AvmCommon de propósito — common.js depende do DOM (listeners
  // de erro na carga) e não pode ser importado pelo Worker. Seis linhas duplicadas valem mais que acoplar.
  function isoDate(value) {
    const [y, m, d] = String(value).split("-").map(Number);
    return dateFmt.format(new Date(y, m - 1, d));
  }

  function monthLabel(value) {
    const [y, m] = String(value).split("-").map(Number);
    return monthFmt.format(new Date(y, m - 1, 1));
  }

  async function sha256Hex(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function patternLabel(model, code) {
    return model.patterns.find((item) => String(item.code) === String(code))?.label || `código ${code}`;
  }

  function localSupport(model, cep8) {
    if (cep8.length !== 8) return null;
    const exact = model.cep4_stats[cep8.slice(0, 4)];
    if (exact) return { ...exact, level: "CEP4", key: cep8.slice(0, 4) };
    const broad = model.cep3_stats[cep8.slice(0, 3)];
    if (broad) return { ...broad, level: "CEP3", key: cep8.slice(0, 3) };
    return null;
  }

  function riskList(v, stats, disabled) {
    const risks = [
      "Os preços de treino são valores declarados em transações, que podem diferir do preço efetivamente pago.",
      "Condomínio, dormitórios, banheiros, vagas, andar, vista e estado de conservação não entram no modelo.",
      "A área informada é a privativa; as transações que treinaram o modelo trazem a área construída do cadastro do IPTU, que inclui a fração das áreas comuns. Por partir de uma definição menor de área, a estimativa tende a ficar abaixo do valor de mercado.",
    ];
    if (v.documentSource) {
      const s = v.documentSource;
      const parts = [s.addressFound && "o endereço", s.areaFound && "a área", s.ageFound && "a idade", s.patternFound && "o padrão", s.fiscalFound && "o valor fiscal"].filter(Boolean);
      if (parts.length) risks.push(`${parts.join(", ")} ${parts.length > 1 ? "foram preenchidos" : "foi preenchido"} por leitura automática de ${s.fileName} e ${parts.length > 1 ? "devem" : "deve"} ser conferido${parts.length > 1 ? "s" : ""} nos documentos.`);
      if (/OCR/.test(s.method || "")) risks.push("Parte do texto dos documentos foi obtida por OCR (Workers AI) e deve ser conferida no documento original antes de qualquer uso.");
    }
    if (v.enabledVariables.includes("fiscal")) {
      risks.push("O VM2T deve ser o do trecho de logradouro e da quadra (SQ) do imóvel; no treino, quadras com várias faces entraram pela mediana.");
    }
    if (disabled.length) {
      risks.push(`Modelo reduzido: ${disabled.map((item) => VARIABLE_LABELS[item]).join(", ")} ${disabled.length === 1 ? "não entrou" : "não entraram"} no cálculo, e a faixa é a desse modelo menor.`);
    }
    if (v.cep8.length === 8 && (!stats || stats.n < 40)) {
      risks.push("Poucas transações na região do CEP informado; a faixa reflete o comportamento geral da cidade, não particularidades locais.");
    }
    risks.push("Não foram verificadas documentação, titularidade, ônus, ocupação, patologias nem a existência física do imóvel.");
    return risks;
  }

  // Recusa ANTES de calcular; depois modelo, ponto, faixa e teto de preço. Devolve { refused } ou o que build() precisa.
  function estimate(model, v) {
    const AvmPredict = root.AvmPredict;
    const reasons = AvmPredict.limitReasons(model, v);
    if (reasons.length) return { refused: reasons };
    const modelKey = AvmPredict.modelKey(model, v.enabledVariables);
    const selected = model.models[modelKey];
    if (!selected) return { refused: [{ code: "model", text: "combinação de variáveis sem modelo treinado" }] };
    const logValue = AvmPredict.logPrice(model, modelKey, v);
    const interval = AvmPredict.interval(logValue, selected.conformal_q80_log);
    const areaUsed = v.enabledVariables.includes("area");
    const priceReason = AvmPredict.priceReason(model, interval.value, areaUsed ? v.area : NaN);
    if (priceReason) return { refused: [priceReason] };
    const stats = localSupport(model, v.cep8);
    const disabled = model.variable_order.filter((variable) => !v.enabledVariables.includes(variable));
    return { modelKey, selected, interval, areaUsed, stats, disabled };
  }

  // Identificação reprodutível: mesmas entradas + mesma versão do modelo + mesma data = mesma identificação.
  async function build(model, v, computed, now = new Date()) {
    const { modelKey, selected, interval, areaUsed, stats, disabled } = computed;
    const digest = await sha256Hex(JSON.stringify([v.address, v.cep8, v.area, v.yearBuilt, v.pattern, v.fiscal, v.enabledVariables, model.version]));
    const fingerprint = digest.slice(0, 12).toUpperCase();
    return {
      id: `AVM-SP-${now.toISOString().slice(0, 10).replaceAll("-", "")}-${fingerprint}`,
      issuedAt: now.toISOString(),
      purpose: "Estimativa estatística de valor, para uso informativo",
      property: { ...v, patternLabel: patternLabel(model, v.pattern) },
      variables: { enabled: v.enabledVariables, disabled, labels: VARIABLE_LABELS, modelKey },
      operation: { financing: v.financing, funds: v.funds },
      confidence: root.AvmPredict.confidence(v, stats, disabled),
      result: {
        estimate: Math.round(interval.value),
        pricePerM2: areaUsed && v.area > 0 ? Math.round(interval.value / v.area) : null, // só com a área no modelo (VULN-006)
        interval80: [Math.round(interval.low), Math.round(interval.high)],
        scope: disabled.length ? `Dentro do domínio de treino do modelo reduzido (sem ${disabled.map((item) => VARIABLE_LABELS[item]).join(", ")})` : "Dentro do domínio de treino",
        localSupport: stats,
      },
      model: {
        version: model.version,
        trainedAt: isoDate(model.trained_at),
        algorithm: model.hyperparameters.algorithm,
        referenceDate: model.reference_date,
        referenceDateLabel: monthLabel(model.reference_date),
        coverageNominal: model.hyperparameters.interval_nominal_coverage_pct,
        metrics: selected.metrics,
        defaultMetrics: model.metrics,
        hyperparameters: model.hyperparameters,
        libraries: model.libraries,
        eda: model.eda,
      },
      risks: riskList(v, stats, disabled),
    };
  }

  root.AvmReport = { VARIABLE_LABELS, patternLabel, localSupport, riskList, estimate, build };
})(typeof globalThis !== "undefined" ? globalThis : this);
