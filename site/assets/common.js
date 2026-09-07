/* Carrega o model.json (URL com fingerprint em <link id="model-url">) e preenche versão/data no rodapé. */
(function (root) {
  "use strict";
  const dateFmt = new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" });

  async function loadModel() {
    const link = document.getElementById("model-url");
    const response = await fetch(link.href);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  function isoDate(value) {
    const [y, m, d] = String(value).split("-").map(Number);
    return dateFmt.format(new Date(y, m - 1, d));
  }

  function monthLabel(value) {
    const [y, m] = String(value).split("-").map(Number);
    return new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(new Date(y, m - 1, 1));
  }

  function fillVersion(model) {
    document.querySelectorAll("[data-model-version]").forEach((el) => { el.textContent = model.version; });
    document.querySelectorAll("[data-model-trained]").forEach((el) => { el.textContent = isoDate(model.trained_at); });
  }

  // Aviso técnico anônimo para POST /api/erro (Workers Logs). Nunca inclui dados do imóvel nem do usuário:
  // só tipo do erro, mensagem do próprio código, script de origem, página e versão do modelo. Máx. 5 por página.
  let reported = 0;
  let modelVersion = null;
  function report(kind, detail = {}) {
    if (reported >= 5) return;
    reported += 1;
    const payload = JSON.stringify({
      kind,
      message: detail.message ? String(detail.message).slice(0, 200) : undefined,
      source: detail.source ? String(detail.source).split("?")[0].split("/").pop().slice(0, 120) : undefined,
      codes: detail.codes,
      page: location.pathname,
      model_version: modelVersion,
    });
    try {
      if (!navigator.sendBeacon || !navigator.sendBeacon("/api/erro", new Blob([payload], { type: "application/json" }))) {
        fetch("/api/erro", { method: "POST", body: payload, headers: { "content-type": "application/json" }, keepalive: true }).catch(() => {});
      }
    } catch (_) { /* sem rede: o erro já está na tela */ }
  }
  window.addEventListener("error", (event) => {
    if (!event.filename || new URL(event.filename, location.href).origin !== location.origin) return; // só scripts próprios
    report("js_error", { message: event.message, source: event.filename });
  });
  window.addEventListener("unhandledrejection", (event) => {
    report("unhandled_rejection", { message: event.reason && (event.reason.message || String(event.reason)) });
  });

  const originalLoad = loadModel;
  async function loadModelTracked() {
    const model = await originalLoad();
    modelVersion = model.version;
    return model;
  }

  root.AvmCommon = { loadModel: loadModelTracked, fillVersion, isoDate, monthLabel, report };
})(globalThis);
