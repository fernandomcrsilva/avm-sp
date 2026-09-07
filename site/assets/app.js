"use strict";

let model = null;
let latestReport = null;
let documentReadState = null;
let lastGeocodeRequestAt = 0;
const geocodeCache = new Map(); // só memória desta aba: nada do endereço fica gravado no navegador

const $ = (id) => document.getElementById(id);
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("pt-BR");
const decimal = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const areaNumber = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 4 });
const VARIABLE_LABELS = { area: "Área construída", age: "Idade", pattern: "Padrão IPTU", fiscal: "Valor fiscal PGV" };
const EXAMPLE = { address: "Rua Vergueiro, 2650", cep: "04109-002", area: 78, yearBuilt: 2018, pattern: "22", fiscal: 6500 };

function cepDigits(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 8);
}

function formatCep(value) {
  const digits = cepDigits(value);
  return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
}

function numericField(id) {
  return $(id).valueAsNumber; // NaN quando vazio ou inválido
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function setReaderStatus(type, message) {
  const status = $("matricula-status");
  status.className = `reader-status${type ? ` ${type}` : ""}`;
  status.textContent = message;
}

function setBadge(text, kind) {
  const badge = $("scope-badge");
  badge.textContent = text;
  badge.className = `status-badge ${kind}`;
}

// Geocodificação: só por clique explícito. É o único momento em que algo digitado sai do navegador.
async function locateAddress() {
  const address = $("address").value.trim();
  const status = $("address-lookup-status");
  if (address.length < 5) {
    status.textContent = "Digite o endereço com número antes de localizar.";
    return;
  }
  const key = address.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").toLocaleLowerCase("pt-BR");
  const button = $("lookup-address");
  button.disabled = true;
  status.textContent = "Consultando o OpenStreetMap…";
  try {
    let selected = geocodeCache.get(key);
    if (!selected) {
      const elapsed = Date.now() - lastGeocodeRequestAt;
      if (elapsed < 1100) await new Promise((resolve) => setTimeout(resolve, 1100 - elapsed)); // política de uso do Nominatim: 1 req/s
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
      const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
        headers: { Accept: "application/json" },
        referrerPolicy: "no-referrer",
      });
      if (!response.ok) throw new Error(`serviço respondeu ${response.status}`);
      const results = await response.json();
      const candidate = results.find((item) => item.address?.postcode) || results[0];
      if (!candidate) throw new Error("endereço não localizado em São Paulo");
      const details = candidate.address || {};
      selected = { cep: details.postcode || "", district: details.suburb || details.neighbourhood || details.quarter || details.city_district || "" };
      geocodeCache.set(key, selected);
    }
    if (!selected.cep) throw new Error("CEP não disponível para este endereço");
    $("cep").value = formatCep(selected.cep);
    if (documentReadState) documentReadState.geocode = "OpenStreetMap/Nominatim";
    status.innerHTML = `CEP ${escapeHtml(formatCep(selected.cep))}${selected.district ? ` · ${escapeHtml(selected.district)}` : ""} preenchido. Confira. Dados © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>.`;
    calculate();
  } catch (error) {
    status.textContent = `Não foi possível localizar: ${error.message}. Informe o CEP manualmente, se quiser.`;
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
    $("cep").value = result.cep ? formatCep(result.cep) : "";
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
    setReaderStatus("success", `Leitura concluída por ${result.method}: ${found.length ? found.join(" e ") : "nada reconhecido"}. Confira os dados; a área da matrícula é a privativa, e o modelo usa a área construída do IPTU.${warning}`);
    calculate();
  } catch (error) {
    setReaderStatus("error", error.message);
    AvmCommon.report("ocr_failed", { message: error.message }); // mensagem do leitor, sem conteúdo do documento
  } finally {
    input.disabled = false;
    input.value = "";
  }
}

function activeVariables() {
  return [...document.querySelectorAll("[data-variable]")].filter((input) => input.checked).map((input) => input.dataset.variable);
}

function getInputs() {
  const yearBuilt = numericField("year-built");
  return {
    address: $("address").value.trim(),
    cep: formatCep($("cep").value),
    cep8: cepDigits($("cep").value),
    area: numericField("area"),
    yearBuilt,
    age: Number.isFinite(yearBuilt) ? model.applicability.base_year - yearBuilt : NaN,
    pattern: String($("pattern").value),
    fiscal: numericField("fiscal"),
    declared: $("declared").checked,
    enabledVariables: activeVariables(),
    documentSource: documentReadState ? { ...documentReadState } : null,
  };
}

function patternLabel(code) {
  return model.patterns.find((item) => String(item.code) === String(code))?.label || `código ${code}`;
}

function localSupport(cep8) {
  if (cep8.length !== 8) return null;
  const exact = model.cep4_stats[cep8.slice(0, 4)];
  if (exact) return { ...exact, level: "CEP4", key: cep8.slice(0, 4) };
  const broad = model.cep3_stats[cep8.slice(0, 3)];
  if (broad) return { ...broad, level: "CEP3", key: cep8.slice(0, 3) };
  return null;
}

function riskList(v, stats, disabled) {
  const risks = [
    "Os preços de treino são os valores declarados nas guias de ITBI, que podem diferir do preço efetivamente pago.",
    "Condomínio, dormitórios, banheiros, vagas, andar, vista e estado de conservação não entram no modelo.",
    "O modelo usa a área construída do cadastro do IPTU. Se a área informada foi a privativa da matrícula, a estimativa parte de uma definição diferente da usada no treino.",
  ];
  if (v.documentSource) {
    const parts = [v.documentSource.addressFound ? "o endereço" : null, v.documentSource.areaFound ? "a área" : null].filter(Boolean);
    if (parts.length) risks.push(`${parts.join(" e ")} ${parts.length > 1 ? "foram preenchidos" : "foi preenchido"} por leitura automática da matrícula e ${parts.length > 1 ? "devem" : "deve"} ser conferido${parts.length > 1 ? "s" : ""} no documento.`);
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

function showPanel(which) {
  $("model-loading").hidden = which !== "loading";
  $("refusal").hidden = which !== "refusal";
  $("result-content").hidden = which !== "result";
}

function refuse(reasons) {
  latestReport = null;
  setBadge("Recusada", "out");
  AvmCommon.report("refused", { codes: reasons.map((r) => r.code) }); // só o código do limite, nunca o valor
  $("refusal-reasons").replaceChildren(...reasons.map((reason) => {
    const li = document.createElement("li");
    li.textContent = reason.text;
    return li;
  }));
  showPanel("refusal");
}

function calculate(event) {
  if (event) event.preventDefault();
  if (!model) return;
  const v = getInputs();
  $("cep").value = v.cep;
  $("age-note").textContent = Number.isFinite(v.age)
    ? `${v.age} ${v.age === 1 ? "ano" : "anos"} em ${model.applicability.base_year}, o ano-base do modelo.`
    : "Informe o ano de conclusão da construção.";

  const required = { area: v.area, age: v.yearBuilt, fiscal: v.fiscal };
  const missing = v.enabledVariables.filter((key) => key in required && !Number.isFinite(required[key]));
  if (missing.length || !v.enabledVariables.length) {
    latestReport = null;
    setBadge("Dados incompletos", "pending");
    $("model-loading").textContent = "Preencha os campos das variáveis habilitadas para estimar.";
    showPanel("loading");
    return;
  }

  const reasons = AvmPredict.limitReasons(model, v); // recusa ANTES de calcular
  if (reasons.length) return refuse(reasons);

  const modelKey = AvmPredict.modelKey(model, v.enabledVariables);
  const selected = model.models[modelKey];
  if (!selected) return refuse([{ code: "model", text: "combinação de variáveis sem modelo treinado" }]);
  const logValue = AvmPredict.logPrice(model, modelKey, v);
  const interval = AvmPredict.interval(logValue, selected.conformal_q80_log);
  const priceReason = AvmPredict.priceReason(model, interval.value);
  if (priceReason) return refuse([priceReason]);

  const stats = localSupport(v.cep8);
  const disabled = model.variable_order.filter((variable) => !v.enabledVariables.includes(variable));
  const timestamp = new Date();
  const fingerprint = crypto.randomUUID().slice(0, 8).toUpperCase();

  latestReport = {
    id: `AVM-SP-${timestamp.toISOString().slice(0, 10).replaceAll("-", "")}-${fingerprint}`,
    issuedAt: timestamp.toISOString(),
    purpose: "Estimativa estatística de valor, para uso informativo",
    property: { ...v, patternLabel: patternLabel(v.pattern) },
    variables: { enabled: v.enabledVariables, disabled, labels: VARIABLE_LABELS, modelKey },
    result: {
      estimate: Math.round(interval.value),
      pricePerM2: Number.isFinite(v.area) && v.area > 0 ? Math.round(interval.value / v.area) : null,
      interval80: [Math.round(interval.low), Math.round(interval.high)],
      scope: "Dentro do domínio de treino",
      localSupport: stats,
    },
    model: {
      version: model.version,
      trainedAt: AvmCommon.isoDate(model.trained_at),
      algorithm: model.hyperparameters.algorithm,
      referenceDate: model.reference_date,
      referenceDateLabel: AvmCommon.monthLabel(model.reference_date),
      coverageNominal: model.hyperparameters.interval_nominal_coverage_pct,
      metrics: selected.metrics,
      defaultMetrics: model.metrics,
      hyperparameters: model.hyperparameters,
      libraries: model.libraries,
      eda: model.eda,
      source: model.source,
      pgvSource: model.pgv_source,
    },
    risks: riskList(v, stats, disabled),
  };
  renderResult(latestReport);
}

function dl(rows) {
  return rows.filter(([, value]) => value !== null && value !== undefined && value !== "").map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd>`).join("");
}

function renderResult(report) {
  const { property: v, result, variables } = report;
  const range = `${money.format(result.interval80[0])} a ${money.format(result.interval80[1])}`;
  setBadge("Dentro do domínio", "ok");
  $("interval").textContent = range;
  $("estimate").textContent = money.format(result.estimate);
  $("price-m2").textContent = result.pricePerM2 ? `· ${money.format(result.pricePerM2)}/m²` : "";
  $("result-model-key").textContent = variables.enabled.length === 4 ? "completo (4 variáveis)" : variables.enabled.map((item) => VARIABLE_LABELS[item]).join(" + ");
  $("result-reference").textContent = report.model.referenceDateLabel;
  $("support-count").textContent = result.localSupport ? `${number.format(result.localSupport.n)} (${result.localSupport.level} ${result.localSupport.key})` : v.cep8.length === 8 ? "nenhuma" : "sem CEP";
  $("local-median").textContent = result.localSupport ? `${money.format(result.localSupport.median_price_m2)}/m²` : "—";
  $("district-support").textContent = result.localSupport
    ? `${number.format(result.localSupport.n)} transações da base na região ${result.localSupport.level} ${result.localSupport.key}. O CEP não entra no preço.`
    : "O CEP não entra no preço; mostra quantas transações da base ficam na mesma região.";
  const mainRisk = report.risks.find((risk) => /Modelo reduzido|Poucas transações|VM2T/.test(risk)) || report.risks[0];
  $("risk-box").innerHTML = `<strong>Atenção.</strong> ${escapeHtml(mainRisk)}`;

  $("report-id").textContent = `Identificação ${report.id}`;
  $("report-interval").textContent = range;
  $("report-estimate").textContent = `valor central ${money.format(result.estimate)}`;
  $("report-property").innerHTML = dl([
    ["Endereço informado", v.address ? `${v.address}, São Paulo/SP` : null],
    ["CEP", v.cep8.length === 8 ? v.cep : null],
    ["Área construída", `${areaNumber.format(v.area)} m²`],
    ["Ano de conclusão / idade", `${v.yearBuilt} / ${v.age} ${v.age === 1 ? "ano" : "anos"}`],
    ["Padrão IPTU", `${v.patternLabel} (código ${v.pattern})`],
    ["Valor fiscal PGV", `${money.format(v.fiscal)}/m² de terreno (VM2T informado)`],
    ["Variáveis ativas", variables.enabled.map((item) => VARIABLE_LABELS[item]).join(", ")],
    ["Variáveis desabilitadas", variables.disabled.length ? variables.disabled.map((item) => VARIABLE_LABELS[item]).join(", ") : "Nenhuma"],
    ["Origem do preenchimento", v.documentSource ? `${v.documentSource.fileName} · ${v.documentSource.method}` : "Informação manual"],
  ]);
  $("report-values").innerHTML = dl([
    [`Faixa de ${model.hyperparameters.interval_nominal_coverage_pct}% de probabilidade`, range],
    ["Valor central", money.format(result.estimate)],
    ["Valor unitário", result.pricePerM2 ? `${money.format(result.pricePerM2)}/m²` : null],
    ["Data-base dos preços", report.model.referenceDateLabel],
    ["Domínio", result.scope],
  ]);
  $("report-model").innerHTML = dl([
    ["Versão", report.model.version],
    ["Treinado em", report.model.trainedAt],
    ["Modelo selecionado", variables.modelKey],
    ["Algoritmo", report.model.algorithm],
    ["Amostra de treino", `${number.format(report.model.eda.rows_model)} compras e vendas`],
    ["Erro percentual mediano deste modelo", `${decimal.format(report.model.metrics.med_ape_pct)}%`],
    [`Cobertura observada da faixa de ${model.hyperparameters.interval_nominal_coverage_pct}%`, `${decimal.format(report.model.metrics.interval_80_coverage_pct)}%`],
    ["Fontes", `${model.source.name} (${model.source.publisher}); ${model.pgv_source.name}`],
    ["Transações na região do CEP", result.localSupport ? `${number.format(result.localSupport.n)} (${result.localSupport.level}; não altera o preço)` : null],
  ]);
  $("report-risks").innerHTML = report.risks.map((risk) => `<li>${escapeHtml(risk)}</li>`).join("");
  $("report-time").textContent = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(report.issuedAt));
  showPanel("result");
}

function populatePatterns() {
  $("pattern").innerHTML = model.patterns.map((item) => `<option value="${item.code}">${escapeHtml(item.label)} · ${number.format(item.n)} transações</option>`).join("");
  $("pattern").value = model.patterns.some((item) => String(item.code) === EXAMPLE.pattern) ? EXAMPLE.pattern : String(model.patterns[0].code);
}

// Limites vêm do model.json (applicability): nada de número fixo no HTML.
function applyLimitsToForm() {
  const a = model.applicability;
  $("area").min = a.area_m2[0]; $("area").max = a.area_m2[1];
  $("year-built").min = a.year_built[0]; $("year-built").max = a.year_built[1];
  $("fiscal").min = a.fiscal_vm2t_brl[0]; $("fiscal").max = a.fiscal_vm2t_brl[1];
  $("scope-area").textContent = `${a.area_m2[0]}–${a.area_m2[1]} m²`;
  $("scope-year").textContent = `construção ${a.year_built[0]}–${a.year_built[1]}`;
  $("scope-price").textContent = `${money.format(a.price_brl[0])} a ${money.format(a.price_brl[1])}`;
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
  $("address").value = EXAMPLE.address;
  $("cep").value = EXAMPLE.cep;
  $("area").value = EXAMPLE.area;
  $("year-built").value = EXAMPLE.yearBuilt;
  $("pattern").value = EXAMPLE.pattern;
  $("fiscal").value = EXAMPLE.fiscal;
  $("declared").checked = true;
  $("address-lookup-status").textContent = "Só sai do seu navegador se você clicar em Localizar CEP: o endereço é então enviado ao OpenStreetMap (Nominatim) para preencher o CEP.";
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
  $("valuation-form").addEventListener("submit", calculate);
  $("valuation-form").addEventListener("input", debounce(calculate, 180));
  $("matricula-file").addEventListener("change", readMatricula);
  $("lookup-address").addEventListener("click", locateAddress);
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
    model = await AvmCommon.loadModel();
    AvmCommon.fillVersion(model);
    document.querySelectorAll("[data-coverage]").forEach((el) => { el.textContent = model.hyperparameters.interval_nominal_coverage_pct; });
    $("declare-use").textContent = model.applicability.use_iptu;
    $("footer-src-itbi").href = model.source.page_url;
    $("footer-src-pgv").href = model.pgv_source.law_url;
    populatePatterns();
    applyLimitsToForm();
    updateVariableControls();
    resetExample();
  } catch (error) {
    $("model-loading").textContent = `Não foi possível carregar o modelo (${error.message}). Verifique a conexão e recarregue a página.`;
    AvmCommon.report("model_load_failed", { message: error.message });
    $("model-loading").classList.add("is-error");
    setBadge("Indisponível", "out");
  }
}

document.addEventListener("DOMContentLoaded", init);
