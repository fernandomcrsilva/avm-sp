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
const VARIABLE_LABELS = AvmReport.VARIABLE_LABELS; // rótulos e relatório vivem em report.js, compartilhado com o Worker de e-mail
const EXAMPLE = { address: "Rua Vergueiro, 2.650", district: "Vila Mariana", cep: "04109-002", area: 78, age: 8, pattern: "22", fiscal: 6500, financing: "SFH", funds: "SBPE" }; // o CEP só mostra a região
let calcSeq = 0; // a identificação é assíncrona (hash): só a última estimativa iniciada pode renderizar

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

// Geocodificação: automática quando o usuário termina de editar o endereço, e sob demanda pelo botão.
// É o único momento em que algo digitado sai do navegador.
async function locateAddress(auto) {
  const address = $("address").value.trim();
  const status = $("address-lookup-status");
  if (address.length < 5) {
    if (!auto) status.textContent = "Digite o endereço com número antes de localizar.";
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
      if (!Array.isArray(results)) throw new Error("resposta inesperada do serviço");
      const candidate = results.find((item) => item.address?.postcode) || results[0];
      if (!candidate) throw new Error("endereço não localizado em São Paulo");
      const details = candidate.address || {};
      selected = { cep: details.postcode || "", district: details.suburb || details.neighbourhood || details.quarter || details.city_district || "" };
      geocodeCache.set(key, selected);
    }
    if (!selected.cep) throw new Error("CEP não disponível para este endereço");
    if (!documentReadState?.cepFromDocument) $("cep").value = formatCep(selected.cep); // o CEP lido do carnê/matrícula é o da unidade: vale mais que o geocodificado
    if (selected.district) $("district").value = selected.district; // CEP e bairro vêm da mesma consulta: um endereço novo troca os dois
    if (documentReadState) documentReadState.geocode = "OpenStreetMap/Nominatim";
    status.innerHTML = `CEP ${escapeHtml($("cep").value)}${selected.district ? ` · ${escapeHtml(selected.district)}` : ""} preenchido. Confira. Dados © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>.`;
    calculate();
  } catch (error) {
    status.textContent = `Não foi possível localizar: ${error.message}. Informe o CEP manualmente, se quiser.`;
  } finally {
    button.disabled = false;
  }
}

// Leva um documento lido para o formulário. A matrícula manda no endereço e na área; o IPTU, na idade, no
// padrão e no VM2T (o endereço do carnê só entra se a matrícula não trouxe). Devolve o que foi reconhecido.
function applyDocument(result, state) {
  const found = [];
  if (result.type === "iptu") {
    if (result.yearBuilt) { $("age").value = String(model.applicability.base_year - result.yearBuilt); state.ageFound = true; found.push(`ano de construção ${result.yearBuilt}`); }
    if (result.patternCode && [...$("pattern").options].some((option) => option.value === String(result.patternCode))) { $("pattern").value = String(result.patternCode); state.patternFound = true; found.push(`padrão ${result.patternLabel}`); }
    if (result.fiscal) { $("fiscal").value = String(result.fiscal); state.fiscalFound = true; found.push(`VM2T ${money.format(result.fiscal)}/m²`); }
    if (result.address && !$("address").value.trim()) { $("address").value = result.address; state.addressFound = true; found.push("endereço"); }
    if (result.cep && !cepDigits($("cep").value)) { $("cep").value = formatCep(result.cep); state.cepFromDocument = true; }
  } else {
    if (result.address) { $("address").value = result.address; state.addressFound = true; found.push("endereço"); }
    if (result.area) { $("area").value = String(result.area); state.areaFound = true; state.areaLabel = result.areaLabel; found.push(`${result.areaLabel.toLocaleLowerCase("pt-BR")} ${areaNumber.format(result.area)} m²`); }
    if (result.cep) { $("cep").value = formatCep(result.cep); state.cepFromDocument = true; }
  }
  return found;
}

// Matrícula e IPTU pelo mesmo input (multiple): cada arquivo é lido, classificado pelo texto e aplicado aos
// campos que lhe cabem. No primeiro documento o exemplo sai do formulário, para que nenhum valor de amostra
// passe por valor lido. fileName/method ficam como texto único: é o que o relatório e o Excel mostram.
async function readDocuments(event) {
  const input = event.target;
  const files = [...(input.files || [])];
  if (!files.length) return;
  input.disabled = true;
  if (!documentReadState) ["address", "district", "cep", "area", "age", "fiscal"].forEach((id) => { $(id).value = ""; });
  const state = documentReadState || { files: [], methods: [], fileName: "", method: "", addressFound: false, areaFound: false, areaLabel: null, ageFound: false, patternFound: false, fiscalFound: false, cepFromDocument: false, geocode: null };
  const found = new Set(); // matrícula e IPTU podem trazer o mesmo campo (endereço): conta uma vez
  const notes = [];
  for (const file of files) {
    setReaderStatus("busy", `Lendo ${file.name}…`);
    try {
      const result = await globalThis.AVMMatricula.read(file, ({ message }) => setReaderStatus("busy", `${file.name}: ${message}`));
      applyDocument(result, state).forEach((item) => found.add(item));
      if (result.warning) notes.push(`${file.name}: ${result.warning}`);
      if (!state.files.includes(result.fileName)) state.files.push(result.fileName);
      if (!state.methods.includes(result.method)) state.methods.push(result.method);
      state.fileName = state.files.join(" + ");
      state.method = state.methods.join(" e ");
      documentReadState = state;
    } catch (error) {
      notes.push(`${file.name}: ${error.message}`);
      AvmCommon.report("ocr_failed", { message: error.name }); // só o tipo do erro: mensagens de biblioteca podem citar o documento
    }
  }
  if (found.size) {
    setReaderStatus("success", `Leitura concluída (${state.method}): ${[...found].join(", ")}. Confira os dados. Só a área privativa da matrícula é usada; a área construída do IPTU é ignorada.${notes.length ? ` ${notes.join(". ")}.` : ""}`);
    calculate();
    if ($("address").value.trim() && (!cepDigits($("cep").value) || !$("district").value.trim())) locateAddress(true); // completa CEP/bairro pelo endereço lido
  } else {
    setReaderStatus("error", notes.join(". ") || "Nada reconhecido nos documentos.");
  }
  input.disabled = false;
  input.value = "";
}

function activeVariables() {
  return [...document.querySelectorAll("[data-variable]")].filter((input) => input.checked).map((input) => input.dataset.variable);
}

function getInputs() {
  // O usuário informa a idade (manual, item 5); o ano de conclusão é derivado dela e é o que o
  // domínio de treino verifica em AvmPredict.limitReasons.
  const age = numericField("age");
  return {
    address: $("address").value.trim(),
    district: $("district").value.trim(),
    cep: formatCep($("cep").value),
    cep8: cepDigits($("cep").value),
    area: numericField("area"),
    age,
    yearBuilt: Number.isFinite(age) ? model.applicability.base_year - age : NaN,
    pattern: String($("pattern").value),
    fiscal: numericField("fiscal"),
    financing: $("financing").value,
    funds: $("funds").value,
    declared: $("declared").checked,
    enabledVariables: activeVariables(),
    documentSource: documentReadState ? { ...documentReadState } : null,
  };
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

async function calculate(event) {
  if (event) event.preventDefault();
  if (!model) return;
  const seq = ++calcSeq;
  const v = getInputs();
  $("cep").value = v.cep;

  const required = { area: v.area, age: v.age, fiscal: v.fiscal };
  const missing = v.enabledVariables.filter((key) => key in required && !Number.isFinite(required[key]));
  if (missing.length || !v.enabledVariables.length) {
    latestReport = null;
    setBadge("Dados incompletos", "pending");
    $("model-loading").textContent = "Preencha os campos das variáveis habilitadas para estimar.";
    showPanel("loading");
    return;
  }
  if (!v.declared) { // sem a confirmação não há estimativa nem aviso de recusa: é um pré-requisito, não um limite (VULN-010)
    latestReport = null;
    setBadge("Aguardando confirmação", "pending");
    $("model-loading").textContent = "Confirme, abaixo do formulário, que é um apartamento residencial em compra e venda para estimar.";
    showPanel("loading");
    return;
  }

  const computed = AvmReport.estimate(model, v); // recusa ANTES de calcular
  if (computed.refused) return refuse(computed.refused);
  const report = await AvmReport.build(model, v, computed); // identificação reprodutível (hash) — assíncrona
  if (seq !== calcSeq) return; // outra estimativa começou enquanto o hash era calculado
  latestReport = report;
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
  $("confidence").textContent = `${report.confidence.level} · ${report.confidence.reasons.join(", ")}`;
  $("district-support").textContent = result.localSupport
    ? `${number.format(result.localSupport.n)} transações na região ${result.localSupport.level} ${result.localSupport.key}; CEP é usado apenas como suporte, não no preço.`
    : "O CEP é usado apenas como suporte, não no preço.";
  const mainRisk = report.risks.find((risk) => /Modelo reduzido|Poucas transações|VM2T/.test(risk)) || report.risks[0];
  $("risk-box").innerHTML = `<strong>Atenção.</strong> ${escapeHtml(mainRisk)}`;

  $("report-id").textContent = `Identificação ${report.id}`;
  $("report-interval").textContent = range;
  $("report-estimate").textContent = `valor central ${money.format(result.estimate)}`;
  const used = (key, value) => (variables.disabled.includes(key) ? "não usada nesta estimativa (variável desabilitada)" : value); // VULN-006
  $("report-property").innerHTML = dl([
    ["Endereço informado", v.address ? `${v.address}, São Paulo/SP` : null],
    ["Bairro", v.district || null],
    ["CEP", v.cep8.length === 8 ? v.cep : null],
    ["Área privativa", used("area", `${areaNumber.format(v.area)} m²`)],
    ["Idade / ano de conclusão", used("age", `${v.age} ${v.age === 1 ? "ano" : "anos"} / ${v.yearBuilt}`)],
    ["Padrão IPTU", used("pattern", `${v.patternLabel} (código ${v.pattern})`)],
    ["Valor fiscal PGV", used("fiscal", `${money.format(v.fiscal)}/m² de terreno (VM2T informado)`)],
    ["Sistema da operação", `${report.operation.financing} · recursos ${report.operation.funds} (não altera a estimativa)`],
    ["Variáveis ativas", variables.enabled.map((item) => VARIABLE_LABELS[item]).join(", ")],
    ["Variáveis desabilitadas", variables.disabled.length ? variables.disabled.map((item) => VARIABLE_LABELS[item]).join(", ") : "Nenhuma"],
    ["Origem do preenchimento", v.documentSource ? `${v.documentSource.fileName} · ${v.documentSource.method}` : "Informação manual"],
  ]);
  $("report-values").innerHTML = dl([
    [`Faixa de ${model.hyperparameters.interval_nominal_coverage_pct}% de probabilidade`, range],
    ["Valor central", money.format(result.estimate)],
    ["Valor unitário", result.pricePerM2 ? `${money.format(result.pricePerM2)}/m²` : null],
    ["Data-base dos preços", report.model.referenceDateLabel],
    ["Confiança", `${report.confidence.level} — ${report.confidence.reasons.join(", ")}`],
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
    ["Transações na região do CEP", result.localSupport ? `${number.format(result.localSupport.n)} (${result.localSupport.level}; não altera o preço)` : null],
  ]);
  $("report-risks").innerHTML = report.risks.map((risk) => `<li>${escapeHtml(risk)}</li>`).join("");
  $("report-time").textContent = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(report.issuedAt));
  showPanel("result");
}

function populatePatterns() {
  $("pattern").replaceChildren(...model.patterns.map((item) => new Option(`${item.label} · ${number.format(item.n)} transações`, String(item.code))));
  $("pattern").value = model.patterns.some((item) => String(item.code) === EXAMPLE.pattern) ? EXAMPLE.pattern : String(model.patterns[0].code);
}

// Limites vêm do model.json (applicability): nada de número fixo no HTML.
function applyLimitsToForm() {
  const a = model.applicability;
  $("area").min = a.area_m2[0]; $("area").max = a.area_m2[1];
  $("age").min = a.age_years[0]; $("age").max = a.age_years[1];
  $("fiscal").min = a.fiscal_vm2t_brl[0]; $("fiscal").max = a.fiscal_vm2t_brl[1];
  $("scope-area").textContent = `${a.area_m2[0]}–${a.area_m2[1]} m²`;
  $("scope-year").textContent = `${a.age_years[0]}–${a.age_years[1]} anos de idade`;
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
  $("district").value = EXAMPLE.district;
  $("cep").value = EXAMPLE.cep;
  $("area").value = EXAMPLE.area;
  $("age").value = EXAMPLE.age;
  $("pattern").value = EXAMPLE.pattern;
  $("fiscal").value = EXAMPLE.fiscal;
  $("financing").value = EXAMPLE.financing;
  $("funds").value = EXAMPLE.funds;
  // #declared fica como está: o exemplo preenche, mas só o usuário confirma (VULN-010)
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
  $("valuation-form").addEventListener("submit", calculate);
  $("valuation-form").addEventListener("input", debounce(calculate, 180));
  $("matricula-file").addEventListener("change", readDocuments);
  $("lookup-address").addEventListener("click", () => locateAddress(false));
  $("address").addEventListener("change", () => locateAddress(true)); // sai do campo com o endereço alterado
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
