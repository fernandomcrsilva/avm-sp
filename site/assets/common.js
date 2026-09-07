/* Carrega o model.json (URL com fingerprint em <link id="model-url">) e preenche versão/data no rodapé. */
(function (root) {
  "use strict";
  const dateFmt = new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" });
  const hex = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const sha256Hex = async (data) => hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : data));
  let modelSha256 = null; // do arquivo realmente carregado: bate com model_sha256 de /version.json e da fixture de paridade

  async function loadModel() {
    const link = document.getElementById("model-url");
    const response = await fetch(link.href);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    modelSha256 = await sha256Hex(bytes);
    return JSON.parse(new TextDecoder().decode(bytes));
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
      navigator.sendBeacon("/api/erro", new Blob([payload], { type: "application/json" }));
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

  root.AvmCommon = { loadModel: loadModelTracked, fillVersion, isoDate, monthLabel, report, sha256Hex, modelSha256: () => modelSha256 };
})(globalThis);
