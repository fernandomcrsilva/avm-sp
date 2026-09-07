"use strict";

let model = null;
let latestReport = null;
let documentReadState = null;
let lastGeocodeRequestAt = 0;
let lastGeocodedAddress = "";

const $ = (id) => document.getElementById(id);
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("pt-BR");
const decimal = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const areaNumber = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 4 });
const VARIABLE_LABELS = { area: "Área privativa", age: "Idade", pattern: "Padrão IPTU", fiscal: "Valor fiscal PGV" };

function setTab(name) {
  document.querySelectorAll(".tab").forEach((button) => {
    const active = button.dataset.tab === name;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("is-active", view.id === name));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function cepDigits(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 8);
}

function formatCep(value) {
  const digits = cepDigits(value);
  return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
}

function numericField(id) {
  const input = $(id);
  if (Number.isFinite(input.valueAsNumber)) return input.valueAsNumber;
  return Number(String(input.value || "").trim().replace(",", "."));
}

function normalizeAddressKey(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLocaleLowerCase("pt-BR");
}

function setReaderStatus(type, message) {
  const status = $("matricula-status");
  status.className = `reader-status${type ? ` ${type}` : ""}`;
  status.textContent = message;
}

function cachedGeocode(key) {
  try {
    const value = localStorage.getItem(`avm-sp:geocode:${key}`);
    return value ? JSON.parse(value) : null;
  } catch (_) {
    return null;
  }
}

function saveGeocode(key, value) {
  try {
    localStorage.setItem(`avm-sp:geocode:${key}`, JSON.stringify(value));
  } catch (_) {
    // O preenchimento funciona mesmo quando o armazenamento local está indisponível.
  }
}

async function locateAddress(force = false) {
  const address = $("address").value.trim();
  const key = normalizeAddressKey(address);
  if (address.length < 5 || (!force && key === lastGeocodedAddress)) return null;
  const button = $("lookup-address");
  button.disabled = true;
  $("address-lookup-status").textContent = "Consultando CEP e bairro…";

  try {
    let selected = cachedGeocode(key);
    if (!selected) {
      const elapsed = Date.now() - lastGeocodeRequestAt;
      if (elapsed < 1100) await new Promise((resolve) => setTimeout(resolve, 1100 - elapsed));
      const params = new URLSearchParams({
        q: `${address}, São Paulo, SP, Brasil`,
        format: "jsonv2",
        addressdetails: "1",
        countrycodes: "br",
        limit: "5",
        dedupe: "1",
        "accept-language": "pt-BR",
      });
      lastGeocodeRequestAt = Date.now();
      const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`serviço de endereço respondeu ${response.status}`);
      const results = await response.json();
      const candidate = results.find((item) => item.address?.postcode) || results[0];
      if (!candidate) throw new Error("endereço não localizado em São Paulo");
      const details = candidate.address || {};
      selected = {
        cep: details.postcode || "",
        district: details.suburb || details.neighbourhood || details.quarter || details.city_district || "",
        displayName: candidate.display_name || address,
      };
      saveGeocode(key, selected);
    }

    if (selected.cep) $("cep").value = formatCep(selected.cep);
    if (selected.district) $("district").value = selected.district;
    if (!selected.cep && !selected.district) throw new Error("CEP e bairro não disponíveis para este endereço");
    lastGeocodedAddress = key;
    if (documentReadState) documentReadState.geocode = "OpenStreetMap/Nominatim";
    const completed = [selected.cep ? `CEP ${formatCep(selected.cep)}` : null, selected.district || null].filter(Boolean).join(" · ");
    $("address-lookup-status").innerHTML = `${escapeHtml(completed)} preenchido automaticamente. Confira antes de emitir o relatório. Dados © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>.`;
    calculate();
    return selected;
  } catch (error) {
    $("address-lookup-status").textContent = `Não foi possível preencher automaticamente: ${error.message}. Informe ou confira CEP e bairro manualmente.`;
    return null;
  } finally {
    button.disabled = false;
  }
}

async function readMatricula(event) {
  const input = event.target;
  const file = input.files?.[0];
  if (!file) return;
  input.disabled = true;
  setReaderStatus("busy", "Preparando a leitura da matrícula…");
  try {
    const result = await globalThis.AVMMatricula.read(file, ({ message }) => setReaderStatus("busy", message));
    $("address").value = result.address || "";
    $("area").value = result.area ? String(result.area) : "";
    $("cep").value = "";
    $("district").value = "";
    documentReadState = {
      fileName: result.fileName,
      method: result.method,
      addressFound: Boolean(result.address),
      areaFound: Boolean(result.area),
      areaLabel: result.areaLabel,
      geocode: null,
    };
    const found = [result.address ? "endereço" : null, result.area ? `${result.areaLabel.toLocaleLowerCase("pt-BR")} ${areaNumber.format(result.area)} m²` : null].filter(Boolean);
    const warning = result.warning ? ` ${result.warning}.` : "";
    setReaderStatus("success", `Leitura concluída por ${result.method}: ${found.join(" e ")}. Confira os dados.${warning}`);
    if (result.address) await locateAddress(true);
    calculate();
  } catch (error) {
    setReaderStatus("error", error.message);
  } finally {
    input.disabled = false;
    input.value = "";
  }
}

function activeVariables() {
  return [...document.querySelectorAll("[data-variable]")]
    .filter((input) => input.checked)
    .map((input) => input.dataset.variable);
}

function getInputs() {
  return {
    address: $("address").value.trim(),
    district: $("district").value.trim(),
    cep: formatCep($("cep").value),
    cep8: cepDigits($("cep").value),
    area: numericField("area"),
    age: numericField("age"),
    pattern: String($("pattern").value),
    fiscal: numericField("fiscal"),
    system: $("system").value,
    funding: $("funding").value,
    enabledVariables: activeVariables(),
    documentSource: documentReadState ? { ...documentReadState } : null,
  };
}

function selectedModelKey(enabled) {
  return model.variable_order.filter((variable) => enabled.includes(variable)).join("+");
}

function patternLabel(code) {
  return model.patterns.find((item) => String(item.code) === String(code))?.label || `código ${code}`;
}

function rawPrediction(v) {
  const modelKey = selectedModelKey(v.enabledVariables);
  const selected = model.models[modelKey];
  if (!selected) throw new Error("Combinação de variáveis sem modelo treinado.");

  const logArea = Math.log(v.area / 80);
  const logFiscal = Math.log(v.fiscal / 3000);
  const numericValues = {
    log_area: logArea,
    log_area2: logArea ** 2,
    log_area3: logArea ** 3,
    age: v.age,
    age2: (v.age / 10) ** 2,
    log_fiscal: logFiscal,
    log_fiscal2: logFiscal ** 2,
  };

  let logValue = selected.intercept;
  selected.numeric.features.forEach((feature, index) => {
    const standardized = (numericValues[feature] - selected.numeric.means[index]) / selected.numeric.scales[index];
    logValue += standardized * selected.numeric.coefficients[index];
  });
  if (v.enabledVariables.includes("pattern")) {
    logValue += selected.category_coefficients.pattern?.[v.pattern] || 0;
  }

  return {
    value: Math.exp(logValue),
    cep3: v.cep8.slice(0, 3),
    cep4: v.cep8.slice(0, 4),
    modelKey,
    selectedModel: selected,
  };
}

function hashText(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(7, "0").slice(0, 7);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function eligibility(v, estimate, location) {
  const reasons = [];
  if (!v.address) reasons.push("endereço não informado");
  if (!v.district) reasons.push("bairro não informado");
  if (v.cep8.length !== 8) reasons.push("CEP inválido");
  else if (!model.cep3_stats[location.cep3]) reasons.push("CEP sem suporte na base de São Paulo");
  if (!(v.area >= 35 && v.area <= 250)) reasons.push("área fora de 35–250 m²");
  if (!(v.age >= 0 && v.age <= 20)) reasons.push("idade fora de 0–20 anos");
  if (v.enabledVariables.includes("pattern") && !model.patterns.some((item) => String(item.code) === v.pattern)) reasons.push("padrão IPTU sem cobertura");
  if (v.enabledVariables.includes("fiscal") && !(v.fiscal >= model.eda.fiscal_min && v.fiscal <= model.eda.fiscal_max)) {
    reasons.push(`valor fiscal fora do intervalo observado de ${money.format(model.eda.fiscal_min)} a ${money.format(model.eda.fiscal_max)}/m²`);
  }
  if (v.funding !== "SBPE") reasons.push("origem de recursos fora do escopo SBPE definido para o projeto");
  if (!Number.isFinite(estimate)) reasons.push("não foi possível calcular uma estimativa");
  else if (estimate > 2_250_000) reasons.push("valor estimado acima do teto de R$ 2.250.000 definido para o projeto");
  return { ok: reasons.length === 0, reasons };
}

function localSupport(location) {
  const exact = model.cep4_stats[location.cep4];
  if (exact) return { ...exact, level: "CEP4", key: location.cep4 };
  const broad = model.cep3_stats[location.cep3];
  if (broad) return { ...broad, level: "CEP3", key: location.cep3 };
  return null;
}

function confidenceFor(v, interval, stats) {
  const width = (interval.high - interval.low) / interval.value;
  let score = 100;
  if (!stats || stats.n < 15) score -= 34;
  else if (stats.n < 40) score -= 20;
  else if (stats.n < 80) score -= 8;
  score -= (4 - v.enabledVariables.length) * 6;
  if (v.enabledVariables.includes("area") && (v.area < model.eda.area_q1 || v.area > model.eda.area_q3)) score -= 8;
  if (v.enabledVariables.includes("area") && v.area > 170) score -= 12;
  if (v.enabledVariables.includes("fiscal") && (v.fiscal < model.eda.fiscal_q1 || v.fiscal > model.eda.fiscal_q3)) score -= 8;
  if (width > 0.8) score -= 18;
  else if (width > 0.55) score -= 10;
  score = Math.max(20, Math.min(95, Math.round(score)));
  return { score, label: score >= 78 ? "Alta" : score >= 55 ? "Média" : "Baixa" };
}

function riskList(v, scope, confidence, stats) {
  const disabled = model.variable_order.filter((variable) => !v.enabledVariables.includes(variable));
  const risks = [
    "A base oficial contém valores de transação declarados para o ITBI, que podem diferir do preço efetivo ou do valor de mercado.",
    "Taxa de condomínio, dormitórios, banheiros, vagas e estado de conservação não integram o modelo.",
  ];
  if (v.documentSource) {
    if (v.documentSource.addressFound && v.documentSource.areaFound) risks.push("O endereço e a área privativa foram preenchidos por leitura automática da matrícula e devem ser conferidos no documento original antes do uso do relatório.");
    else if (v.documentSource.addressFound) risks.push("O endereço foi preenchido por leitura automática da matrícula e deve ser conferido no documento original antes do uso do relatório.");
    else if (v.documentSource.areaFound) risks.push("A área privativa foi preenchida por leitura automática da matrícula e deve ser conferida no documento original antes do uso do relatório.");
  }
  risks.push("Para o imóvel avaliando, utiliza-se a área privativa informada na matrícula; a base de treinamento contém área construída cadastral, e diferenças entre essas definições podem afetar a estimativa.");
  if (v.enabledVariables.includes("fiscal")) {
    risks.push("O VM2T deve corresponder exatamente ao trecho de logradouro e à SQ do imóvel; no treinamento, quadras com várias faces foram representadas pela mediana dos VM2T.");
  }
  if (disabled.length) risks.push(`Modelo reduzido: ${disabled.map((item) => VARIABLE_LABELS[item]).join(", ")} ${disabled.length === 1 ? "foi desabilitada" : "foram desabilitadas"} no cálculo.`);
  if (!stats || stats.n < 40) risks.push("O suporte amostral da região postal é reduzido; recomenda-se revisão humana e pesquisa complementar.");
  if (v.enabledVariables.includes("area") && v.area > 170) risks.push("A área está na cauda superior da amostra de desenvolvimento.");
  if (confidence.label === "Baixa") risks.push("A confiabilidade calculada é baixa; não se recomenda dispensar inspeção com base apenas neste resultado.");
  if (!scope.ok) risks.push(`Fora do escopo: ${scope.reasons.join("; ")}.`);
  risks.push("Não foram verificadas identidade física, ocupação, documentação, titularidade, ônus, patologias ou alterações do imóvel.");
  return risks;
}

function dl(rows) {
  return rows.map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd>`).join("");
}

function calculate(event) {
  if (event) event.preventDefault();
  if (!model) return;
  const v = getInputs();
  $("cep").value = v.cep;
  if (![v.area, v.age, v.fiscal].every(Number.isFinite) || v.area <= 0 || v.fiscal <= 0 || !v.enabledVariables.length) {
    latestReport = null;
    $("scope-badge").textContent = "Dados incompletos";
    $("scope-badge").className = "status-badge pending";
    $("model-loading").innerHTML = "<strong>Informe a área privativa e os demais campos obrigatórios para calcular.</strong>";
    $("model-loading").hidden = false;
    $("result-content").hidden = true;
    return;
  }

  let prediction;
  try {
    prediction = rawPrediction(v);
  } catch (error) {
    $("scope-badge").textContent = "Modelo indisponível";
    $("scope-badge").className = "status-badge out";
    return;
  }
  const q = prediction.selectedModel.conformal_q80_log;
  const interval = {
    value: prediction.value,
    low: prediction.value * Math.exp(-q),
    high: prediction.value * Math.exp(q),
  };
  const scope = eligibility(v, prediction.value, prediction);
  const stats = localSupport(prediction);
  const confidence = confidenceFor(v, interval, stats);
  const risks = riskList(v, scope, confidence, stats);
  const timestamp = new Date();
  const fingerprint = hashText(JSON.stringify({ ...v, version: model.version, modelKey: prediction.modelKey }));
  const id = `AVM-SP-${timestamp.toISOString().slice(0, 10).replaceAll("-", "")}-${fingerprint}`;

  latestReport = {
    id,
    issuedAt: timestamp.toISOString(),
    purpose: "Precificação automatizada de garantia imobiliária — demonstração técnica",
    property: v,
    variables: {
      enabled: v.enabledVariables,
      disabled: model.variable_order.filter((variable) => !v.enabledVariables.includes(variable)),
      labels: VARIABLE_LABELS,
      modelKey: prediction.modelKey,
    },
    location: { cep3: prediction.cep3, cep4: prediction.cep4 },
    result: {
      estimate: Math.round(prediction.value),
      pricePerM2: Math.round(prediction.value / v.area),
      interval80: [Math.round(interval.low), Math.round(interval.high)],
      scope: scope.ok ? "Dentro do escopo" : "Fora do escopo",
      scopeReasons: scope.reasons,
      confidence,
      localSupport: stats,
    },
    model: {
      version: model.version,
      algorithm: model.hyperparameters.algorithm,
      referenceDate: model.reference_date,
      metrics: prediction.selectedModel.metrics,
      defaultMetrics: model.metrics,
      hyperparameters: model.hyperparameters,
      libraries: model.libraries,
      eda: model.eda,
      source: model.source,
      pgvSource: model.pgv_source,
    },
    risks,
  };

  renderResult(latestReport);
}

function renderResult(report) {
  const { property: v, result, variables } = report;
  const enabledLabels = variables.enabled.map((item) => VARIABLE_LABELS[item]);
  const disabledLabels = variables.disabled.map((item) => VARIABLE_LABELS[item]);
  const scopeBadge = $("scope-badge");
  scopeBadge.textContent = result.scope;
  scopeBadge.className = `status-badge ${result.scope === "Dentro do escopo" ? "ok" : "out"}`;

  $("estimate").textContent = money.format(result.estimate);
  $("price-m2").textContent = `${money.format(result.pricePerM2)} por m²`;
  $("interval").textContent = `${money.format(result.interval80[0])} — ${money.format(result.interval80[1])}`;
  $("confidence").textContent = `${result.confidence.label} · ${result.confidence.score}/100`;
  $("support-count").textContent = result.localSupport ? `${number.format(result.localSupport.n)} transações` : "sem suporte";
  $("local-median").textContent = result.localSupport ? `${money.format(result.localSupport.median_price_m2)}/m²` : "—";
  $("district-support").textContent = result.localSupport
    ? `${number.format(result.localSupport.n)} transações na região ${result.localSupport.level} ${result.localSupport.key}; CEP é usado apenas como suporte, não no preço.`
    : "CEP usado para identificação e suporte; ele não integra a equação de preço.";
  const mainRisk = report.risks.find((risk) => /Fora do escopo|confiabilidade|Modelo reduzido|VM2T/i.test(risk)) || report.risks[0];
  $("risk-box").innerHTML = `<strong>Leitura de risco.</strong> ${escapeHtml(mainRisk)}`;

  $("report-id").textContent = `Identificação ${report.id}`;
  $("report-estimate").textContent = money.format(result.estimate);
  $("report-scope").textContent = `${result.scope} · confiança ${result.confidence.label.toLowerCase()}`;
  $("report-property").innerHTML = dl([
    ["Endereço declarado", `${v.address}, ${v.district}, CEP ${v.cep}, São Paulo/SP`],
    ["Tipologia", "Apartamento residencial"],
    ["Área privativa / idade", `${areaNumber.format(v.area)} m² / ${v.age} ${v.age === 1 ? "ano" : "anos"}`],
    ["Padrão IPTU", `${patternLabel(v.pattern)} (código ${v.pattern})`],
    ["Valor fiscal PGV", `${money.format(v.fiscal)}/m² de terreno (VM2T informado)`],
    ["Sistema / recursos", `${v.system} / ${v.funding}`],
    ["Variáveis ativas", enabledLabels.join(", ")],
    ["Variáveis desabilitadas", disabledLabels.length ? disabledLabels.join(", ") : "Nenhuma"],
    ["Origem do preenchimento", v.documentSource ? `${v.documentSource.fileName} · ${v.documentSource.method}` : "Informação manual"],
  ]);
  $("report-values").innerHTML = dl([
    ["Valor estimado", money.format(result.estimate)],
    ["Valor unitário", `${money.format(result.pricePerM2)}/m²`],
    ["Intervalo de 80%", `${money.format(result.interval80[0])} a ${money.format(result.interval80[1])}`],
    ["Escopo", result.scope],
    ["Confiabilidade", `${result.confidence.label} (${result.confidence.score}/100)`],
    ["Data-base", "Julho de 2026"],
  ]);
  $("report-model").innerHTML = dl([
    ["Versão", model.version],
    ["Modelo selecionado", variables.modelKey],
    ["Algoritmo", model.hyperparameters.algorithm],
    ["Amostra tratada", `${number.format(model.eda.rows_model)} compras e vendas`],
    ["Suporte local", result.localSupport ? `${number.format(result.localSupport.n)} transações (${result.localSupport.level}; não altera o preço)` : "indisponível"],
    ["Erro mediano deste modelo", `${decimal.format(report.model.metrics.med_ape_pct)}%`],
    ["Impressão digital", report.id.split("-").at(-1)],
  ]);
  $("report-risks").innerHTML = report.risks.map((risk) => `<li>${escapeHtml(risk)}</li>`).join("");
  $("report-version").textContent = model.version;
  $("report-time").textContent = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(report.issuedAt));

  $("model-loading").hidden = true;
  $("result-content").hidden = false;
}

function renderBars(container, items) {
  const max = Math.max(...items.map((item) => item.count));
  $(container).innerHTML = items.map((item) => `
    <div class="bar-item" title="${escapeHtml(item.label)}: ${number.format(item.count)} transações">
      <b>${number.format(item.count)}</b>
      <i style="height:${Math.max(3, (item.count / max) * 170)}px"></i>
      <span>${escapeHtml(item.label)}</span>
    </div>`).join("");
}

function renderMethodology() {
  $("eda-rows").textContent = number.format(model.eda.rows_model);
  $("metric-r2").textContent = decimal.format(model.metrics.r2_log);
  $("metric-mdape").textContent = `${decimal.format(model.metrics.med_ape_pct)}%`;
  $("v-r2").textContent = decimal.format(model.metrics.r2_log);
  $("v-mape").textContent = `${decimal.format(model.metrics.mape_pct)}%`;
  $("v-mdape").textContent = `${decimal.format(model.metrics.med_ape_pct)}%`;
  $("v-rmse").textContent = money.format(model.metrics.rmse_brl);
  $("v-coverage").textContent = `${decimal.format(model.metrics.interval_80_coverage_pct)}%`;
  $("v-test").textContent = number.format(model.metrics.test_rows);
  renderBars("area-chart", model.eda.area_hist);
  renderBars("price-chart", model.eda.price_m2_hist);
  renderBars("fiscal-chart", model.eda.fiscal_hist);

  const maxImportance = Math.max(...model.feature_effects.map((item) => item.importance));
  $("importance-chart").innerHTML = model.feature_effects.map((item) => `
    <div class="importance-item" title="${escapeHtml(item.feature)}">
      <span>${escapeHtml(item.feature)}</span>
      <div class="importance-track"><i style="width:${(item.importance / maxImportance) * 100}%"></i></div>
      <b>${decimal.format(item.importance * 100)}%</b>
    </div>`).join("");

  const entries = [["Python", model.libraries.python], ["pandas", model.libraries.pandas], ["NumPy", model.libraries.numpy], ["scikit-learn", model.libraries.scikit_learn]];
  $("libraries").innerHTML = entries.map(([name, version]) => `<div><small>${name}</small><strong>v${escapeHtml(version)}</strong></div>`).join("");
}

function populatePatterns() {
  $("pattern").innerHTML = model.patterns.map((item) => `<option value="${item.code}">${item.label} · ${number.format(item.n)} transações</option>`).join("");
  $("pattern").value = model.patterns.some((item) => item.code === 22) ? "22" : String(model.patterns[0].code);
}

function updateVariableControls(changedInput) {
  let enabled = activeVariables();
  if (!enabled.length && changedInput) {
    changedInput.checked = true;
    enabled = [changedInput.dataset.variable];
  }
  document.querySelectorAll("[data-variable-field]").forEach((field) => {
    field.classList.toggle("is-excluded", !enabled.includes(field.dataset.variableField));
  });
  const description = enabled.length === 4 ? "modelo completo" : `modelo ${enabled.join(" + ")}`;
  $("active-model-note").textContent = `${enabled.length} ${enabled.length === 1 ? "variável ativa" : "variáveis ativas"} · ${description}`;
}

function resetExample() {
  documentReadState = null;
  lastGeocodedAddress = "";
  $("address").value = "Rua Vergueiro, 2.650";
  $("district").value = "Vila Mariana";
  $("cep").value = "04109-002";
  $("area").value = 78;
  $("age").value = 8;
  $("pattern").value = "22";
  $("fiscal").value = 6500;
  $("system").value = "SFH";
  $("funding").value = "SBPE";
  $("address-lookup-status").textContent = "Ao preencher ou alterar o endereço, o aplicativo consulta automaticamente CEP e bairro.";
  setReaderStatus("", "Nenhum documento selecionado.");
  document.querySelectorAll("[data-variable]").forEach((input) => { input.checked = true; });
  updateVariableControls();
  calculate();
}

function downloadXlsx() {
  if (!latestReport) return;
  const bytes = globalThis.AVMExcel.buildWorkbook(latestReport);
  const payload = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(payload);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${latestReport.id}.xlsx`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

async function init() {
  document.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.tab)));
  $("valuation-form").addEventListener("submit", calculate);
  $("valuation-form").addEventListener("input", debounce(calculate, 180));
  $("matricula-file").addEventListener("change", readMatricula);
  $("lookup-address").addEventListener("click", () => locateAddress(true));
  $("address").addEventListener("change", () => locateAddress());
  $("cep").addEventListener("blur", () => { $("cep").value = formatCep($("cep").value); });
  document.querySelectorAll("[data-variable]").forEach((input) => {
    input.addEventListener("change", () => {
      updateVariableControls(input);
      calculate();
    });
  });
  $("reset-form").addEventListener("click", resetExample);
  $("print-report").addEventListener("click", () => window.print());
  $("download-xlsx").addEventListener("click", downloadXlsx);

  try {
    const response = await fetch("assets/model.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    model = await response.json();
    $("header-version").textContent = model.version;
    populatePatterns();
    updateVariableControls();
    renderMethodology();
    calculate();
  } catch (error) {
    $("model-loading").innerHTML = `<strong>Não foi possível carregar o modelo.</strong><span style="animation:none;border:0;width:auto;height:auto">${escapeHtml(error.message)}</span>`;
    $("scope-badge").textContent = "Indisponível";
    $("scope-badge").className = "status-badge out";
  }
}

document.addEventListener("DOMContentLoaded", init);
