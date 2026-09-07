/* Página /metodologia: todo número vem do model.json. */
"use strict";

const $ = (id) => document.getElementById(id);
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("pt-BR");
const decimal = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (value) => `${decimal.format(value)}%`;
const text = (id, value) => { $(id).textContent = value; };

function renderBars(container, items) {
  const max = Math.max(...items.map((item) => item.count));
  const host = $(container);
  host.replaceChildren(...items.map((item) => {
    const wrap = document.createElement("div");
    wrap.className = "bar-item";
    wrap.title = `${item.label}: ${number.format(item.count)} transações`;
    const count = document.createElement("b");
    count.textContent = number.format(item.count);
    const bar = document.createElement("i");
    bar.style.height = `${Math.max(3, (item.count / max) * 170)}px`; // CSSOM: permitido pela CSP sem unsafe-inline
    const label = document.createElement("span");
    label.textContent = item.label;
    wrap.append(count, bar, label);
    return wrap;
  }));
}

function renderImportance(model) {
  const max = Math.max(...model.feature_effects.map((item) => item.importance));
  $("importance-chart").replaceChildren(...model.feature_effects.map((item) => {
    const row = document.createElement("div");
    row.className = "importance-item";
    row.title = item.feature;
    const name = document.createElement("span");
    name.textContent = item.feature;
    const track = document.createElement("div");
    track.className = "importance-track";
    const fill = document.createElement("i");
    fill.style.width = `${(item.importance / max) * 100}%`;
    track.append(fill);
    const value = document.createElement("b");
    value.textContent = pct(item.importance * 100);
    row.append(name, track, value);
    return row;
  }));
}

function render(model) {
  const a = model.applicability;
  const m = model.metrics;
  const h = model.hyperparameters;
  AvmCommon.fillVersion(model);
  document.querySelectorAll("[data-coverage]").forEach((el) => { el.textContent = h.interval_nominal_coverage_pct; });

  text("sum-models", `${number.format(h.models_fitted)} Ridge`);
  text("eda-rows", number.format(model.eda.rows_model));
  text("metric-r2", decimal.format(m.r2_log));
  text("metric-mdape", pct(m.med_ape_pct));

  text("m-sheets", `${model.source.sheets[0]} a ${model.source.sheets.at(-1)}`);
  text("m-date-min", AvmCommon.isoDate(model.source.transaction_date_min));
  text("m-date-max", AvmCommon.isoDate(model.source.transaction_date_max));
  text("m-nature", a.nature);
  text("m-area", `${a.area_m2[0]} a ${a.area_m2[1]} m²`);
  text("m-year", `${a.year_built[0]} a ${a.year_built[1]}`);
  text("m-price", `${money.format(a.price_brl[0])} a ${money.format(a.price_brl[1])}`);
  text("m-price-m2", `${money.format(a.price_m2_brl[0])} a ${money.format(a.price_m2_brl[1])}/m²`);
  text("m-rows-raw", number.format(model.eda.rows_raw));
  text("m-rows-model", number.format(model.eda.rows_model));
  $("m-src-page").href = model.source.page_url;
  $("m-src-file").href = model.source.download_url;
  $("m-src-pgv").href = model.pgv_source.law_url;
  text("m-src-sha", model.source.sha256);
  text("m-pgv-sha", model.pgv_source.sha256);
  text("m-pgv-rows", number.format(model.pgv_source.rows_parsed));
  text("m-pgv-squares", number.format(model.pgv_source.tax_squares));

  text("m-alpha", decimal.format(h.alpha));
  text("m-patterns", model.patterns.map((item) => item.label).join(", "));
  text("m-split", `${number.format(model.eda.rows_train)} treino · ${number.format(model.eda.rows_calibration)} calibração · ${number.format(model.eda.rows_test)} teste`);

  renderBars("area-chart", model.eda.area_hist);
  renderBars("price-chart", model.eda.price_m2_hist);
  renderBars("fiscal-chart", model.eda.fiscal_hist);
  renderImportance(model);

  text("v-r2", decimal.format(m.r2_log));
  text("v-mape", pct(m.mape_pct));
  text("v-mdape", pct(m.med_ape_pct));
  text("v-rmse", money.format(m.rmse_brl));
  text("v-coverage", pct(m.interval_80_coverage_pct));
  text("v-test", number.format(m.test_rows));
  text("v-mae", money.format(m.mae_brl));

  $("sub-models").replaceChildren(...Object.entries(model.models).map(([key, sub]) => {
    const tr = document.createElement("tr");
    [key, pct(sub.metrics.mape_pct), pct(sub.metrics.med_ape_pct), pct(sub.metrics.interval_80_coverage_pct), decimal.format(sub.metrics.r2_log)]
      .forEach((value) => { const td = document.createElement("td"); td.textContent = value; tr.append(td); });
    return tr;
  }));

  $("limits-list").replaceChildren(...[
    `Apartamentos residenciais: uso IPTU ${a.use_iptu}, com inscrição predial ativa (situação "${a.sql_status}").`,
    `Transações de natureza "${a.nature}", com proporção transmitida integral.`,
    `Área construída de ${a.area_m2[0]} a ${a.area_m2[1]} m².`,
    `Ano de conclusão da construção (ACC no IPTU) de ${a.year_built[0]} a ${a.year_built[1]}, ou seja, idade de ${a.age_years[0]} a ${a.age_years[1]} anos em ${a.base_year}.`,
    `Padrões cadastrais presentes na base: ${model.patterns.map((item) => item.label).join(", ")}.`,
    `Valor fiscal do terreno (VM2T) entre ${money.format(a.fiscal_vm2t_brl[0])} e ${money.format(a.fiscal_vm2t_brl[1])} por m².`,
    `Valor estimado entre ${money.format(a.price_brl[0])} e ${money.format(a.price_brl[1])}.`,
  ].map((item) => { const li = document.createElement("li"); li.textContent = item; return li; }));

  const libs = [["Python", model.libraries.python], ["pandas", model.libraries.pandas], ["NumPy", model.libraries.numpy], ["scikit-learn", model.libraries.scikit_learn]];
  $("libraries").replaceChildren(...libs.map(([name, version]) => {
    const div = document.createElement("div");
    const small = document.createElement("small");
    small.textContent = name;
    const strong = document.createElement("strong");
    strong.textContent = `v${version}`;
    div.append(small, strong);
    return div;
  }));
  text("m-reference", AvmCommon.monthLabel(model.reference_date));
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    render(await AvmCommon.loadModel());
    $("method-loading").hidden = true;
    $("method-content").hidden = false;
  } catch (error) {
    $("method-loading").textContent = `Não foi possível carregar o modelo (${error.message}). Recarregue a página.`;
  }
});
