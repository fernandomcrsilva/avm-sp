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

  root.AvmCommon = { loadModel, fillVersion, isoDate, monthLabel };
})(globalThis);
