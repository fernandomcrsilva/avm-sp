# AVM por e-mail — Entrega 1 — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um e-mail com matrícula + carnê de IPTU (PDFs com camada de texto) enviado a `avm@heybrain.uk` por remetente autorizado recebe, sem intervenção humana, a estimativa no corpo e o relatório Excel anexo — ou uma explicação exata do porquê não.

**Architecture:** O Worker `avm-sp` ganha um handler `email()`; o pipeline (`src/email.js`) é puro e reaproveita os módulos do site (`AVMMatricula`, `AvmPredict`, `AVMExcel`) mais um módulo novo, `site/assets/report.js` (`AvmReport`), **extraído de `app.js`** para que site e Worker produzam o mesmo relatório e a mesma identificação. Síncrono, em memória, sem armazenamento. Texto dos PDFs via `env.AI.toMarkdown`; resposta via binding `send_email`.

**Tech Stack:** Cloudflare Workers (Paid), Email Routing + Email Sending (`send_email`), Workers AI (`toMarkdown`), `postal-mime` 3.0.0, Node 22 `node:test`, wrangler 4.128.

**Spec:** `docs/superpowers/specs/2026-09-08-email-avm-design.md` — seções 3, 4 e 7 são a Entrega 1.

## Global Constraints

- Tudo em Português-BR (código comentado, mensagens, commits, PR). Acentuação correta.
- Branch `email-avm` + PR; `npm run check` verde antes de qualquer merge; merge em `main` **publica** (Workers Builds). Nunca rodar `npm run build`/`check` com `wrangler dev` aberto.
- **Pré-requisito:** PR #23 (`leitura-iptu`) mergeado em `main`; o plano usa `AVMMatricula.detectDocumentType` e `extractIptuFields`.
- Não tocar: CSP/`_headers`, tipografia, `site/assets/xlsx-export.js`, Nominatim do site, `train_model.py`.
- Nenhum armazenamento (sem R2/KV/D1/DO); nenhum log com e-mail, nome de arquivo, endereço, SQL ou valores. Só `error.name` em erros.
- Remetente = `message.from` (envelope). Uma resposta por e-mail. Falha ao responder → `setReject`.
- `send_email` sem `"remote": true` no `wrangler.jsonc`.
- Única dependência nova: `postal-mime@3.0.0` em `dependencies` (exata).
- Limites (spec 4.1): `rawSize` ≤ 20 MiB; ≤ 6 anexos; ≤ 10 MiB por anexo; texto < 200 caracteres = não lido; texto truncado em 200.000 caracteres; `EMAIL_RL` 3/60 s por remetente.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `site/assets/report.js` (novo) | `AvmReport`: rótulos, `patternLabel`, `localSupport`, `riskList`, `estimate`, `build`. Puro; script clássico em `globalThis`. |
| `site/assets/app.js` (modificar) | Passa a chamar `AvmReport`; perde as funções movidas. |
| `site/index.html` (modificar) | Carrega `assets/report.js` depois de `predict.js` e antes de `app.js`. |
| `tests/report.test.mjs` (novo) | `estimate`/`build` em Node. |
| `tests/fixtures/textos.mjs` (novo) | Textos sintéticos do carnê e da matrícula, compartilhados pelos testes. |
| `tests/iptu-reader.test.mjs` (modificar) | Importa os textos do fixture. |
| `src/email.js` (novo) | Pipeline: `parseInbound`, `readDocuments`, `buildInputs`, `compose`, `processEmail`. Sem `env` direto: recebe `deps`. |
| `src/worker.js` (modificar) | Handler `email()`: guardas, chama `processEmail`, envia, loga. |
| `tests/email.test.mjs` (novo) | Pipeline e handler com `env`/`message` falsos. |
| `wrangler.jsonc`, `package.json` (modificar) | Bindings, vars, limites; dependência. |
| `site/privacidade.html`, `site/termos.html`, `RUNBOOK.md`, `README.md` (modificar) | Privacidade/termos mínimos da spec 4.6; operação para ativar o canal. |

---

### Task 1: Preparar a branch

**Files:** nenhum arquivo de código.

- [ ] **Step 1: Confirmar que o #23 está em `main`**

Run: `git fetch origin && git log --oneline origin/main -3`
Expected: um commit "Leitura do carnê de IPTU junto com a matrícula…" aparece. Se não aparecer, **parar**: o dono precisa mergear o #23 primeiro.

- [ ] **Step 2: Atualizar `email-avm` sobre `main`**

```bash
git checkout email-avm
git rebase origin/main
npm ci
npm run check
```
Expected: rebase limpo (a branch só tem a spec), `check` verde com 18 testes.

---

### Task 2: `site/assets/report.js` — extrair `AvmReport` de `app.js`

**Files:**
- Create: `site/assets/report.js`
- Modify: `site/assets/app.js` (linhas 14, 184–219, 262–314 da versão pós-#23)
- Modify: `site/index.html:189` (bloco de `<script>`)
- Test: `tests/report.test.mjs`

**Interfaces:**
- Consumes: `AvmPredict.{limitReasons, modelKey, logPrice, interval, priceReason, confidence}` (`site/assets/predict.js`), `model.json`.
- Produces (usado pelas Tasks 5 e 6):
  - `AvmReport.VARIABLE_LABELS: { area, age, pattern, fiscal }`
  - `AvmReport.patternLabel(model, code) → string`
  - `AvmReport.localSupport(model, cep8) → stats | null`
  - `AvmReport.riskList(v, stats, disabled) → string[]`
  - `AvmReport.estimate(model, v) → { refused: [{code, text}] } | { modelKey, selected, interval: {value, low, high}, areaUsed, stats, disabled }`
  - `AvmReport.build(model, v, computed, now = new Date()) → Promise<report>` (mesmo objeto que hoje é `latestReport`)

- [ ] **Step 1: Escrever o teste que falha**

`tests/report.test.mjs`:

```js
// AvmReport é o único lugar que monta o relatório: site (app.js) e Worker (src/email.js) chamam o mesmo
// código, então a identificação e os avisos são idênticos para as mesmas entradas. Rodar: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const model = JSON.parse(readFileSync(new URL("site/assets/model.json", root), "utf8"));
vm.runInThisContext(readFileSync(new URL("site/assets/predict.js", root), "utf8"));
vm.runInThisContext(readFileSync(new URL("site/assets/report.js", root), "utf8"));
const { AvmPredict, AvmReport } = globalThis;

const exemplo = () => ({
  address: "Rua Vergueiro, 2650", district: "Paraíso", cep: "04109-002", cep8: "04109002",
  area: 78, age: 8, yearBuilt: model.applicability.base_year - 8, pattern: "22", fiscal: 6500,
  financing: "SFH", funds: "SBPE", declared: true, enabledVariables: ["area", "age", "pattern", "fiscal"],
  documentSource: { fileName: "iptu.pdf + matricula.pdf", method: "texto do PDF", addressFound: true, areaFound: true, areaLabel: "Área privativa", ageFound: true, patternFound: true, fiscalFound: true, cepFromDocument: true, geocode: null },
});

test("estimate recusa fora do domínio com os textos de AvmPredict", () => {
  const v = { ...exemplo(), area: 300 };
  const out = AvmReport.estimate(model, v);
  assert.deepEqual(out.refused, AvmPredict.limitReasons(model, v));
  assert.ok(out.refused.length > 0);
});

test("estimate reproduz a sequência do site", () => {
  const v = exemplo();
  const out = AvmReport.estimate(model, v);
  assert.equal(out.refused, undefined);
  const key = AvmPredict.modelKey(model, v.enabledVariables);
  const interval = AvmPredict.interval(AvmPredict.logPrice(model, key, v), model.models[key].conformal_q80_log);
  assert.equal(out.modelKey, key);
  assert.equal(out.interval.value, interval.value);
  assert.deepEqual(out.disabled, []);
  assert.equal(out.stats.level, "CEP4");
});

test("build: identificação estável, patternLabel, avisos de leitura automática", async () => {
  const v = exemplo();
  const computed = AvmReport.estimate(model, v);
  const now = new Date("2026-09-08T12:00:00Z");
  const a = await AvmReport.build(model, v, computed, now);
  const b = await AvmReport.build(model, v, computed, now);
  assert.match(a.id, /^AVM-SP-20260908-[0-9A-F]{12}$/);
  assert.equal(a.id, b.id);
  assert.equal(a.property.patternLabel, "2-C");
  assert.equal(a.result.estimate, Math.round(computed.interval.value));
  assert.equal(a.result.pricePerM2, Math.round(computed.interval.value / 78));
  assert.ok(a.risks.some((r) => r.includes("leitura automática de iptu.pdf + matricula.pdf")));
  assert.ok(a.risks.some((r) => r.includes("VM2T")));
  assert.equal(a.variables.labels.area, "Área privativa");
  assert.equal(typeof a.model.trainedAt, "string");
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/report.test.mjs`
Expected: FAIL — `ENOENT ... site/assets/report.js`.

- [ ] **Step 3: Criar `site/assets/report.js`**

Conteúdo integral (as funções `patternLabel`, `localSupport`, `riskList` e o objeto do relatório são cópia fiel do `app.js`, só trocando `model` global por parâmetro):

```js
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
      "Os preços de treino são os valores declarados nas guias de ITBI, que podem diferir do preço efetivamente pago.",
      "Condomínio, dormitórios, banheiros, vagas, andar, vista e estado de conservação não entram no modelo.",
      "A área informada é a privativa; as transações que treinaram o modelo trazem a área construída do cadastro do IPTU, que inclui a fração das áreas comuns. Por partir de uma definição menor de área, a estimativa tende a ficar abaixo do valor de mercado.",
    ];
    if (v.documentSource) {
      const s = v.documentSource;
      const parts = [s.addressFound && "o endereço", s.areaFound && "a área", s.ageFound && "a idade", s.patternFound && "o padrão", s.fiscalFound && "o valor fiscal"].filter(Boolean);
      if (parts.length) risks.push(`${parts.join(", ")} ${parts.length > 1 ? "foram preenchidos" : "foi preenchido"} por leitura automática de ${s.fileName} e ${parts.length > 1 ? "devem" : "deve"} ser conferido${parts.length > 1 ? "s" : ""} nos documentos.`);
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
        source: model.source,
        pgvSource: model.pgv_source,
      },
      risks: riskList(v, stats, disabled),
    };
  }

  root.AvmReport = { VARIABLE_LABELS, patternLabel, localSupport, riskList, estimate, build };
})(typeof globalThis !== "undefined" ? globalThis : this);
```

- [ ] **Step 4: Rodar o teste e ver passar**

Run: `node --test tests/report.test.mjs`
Expected: 3 pass.

- [ ] **Step 5: `app.js` passa a usar `AvmReport`**

Em `site/assets/app.js`:

a) Linha 14 — trocar
```js
const VARIABLE_LABELS = { area: "Área privativa", age: "Idade", pattern: "Padrão IPTU", fiscal: "Valor fiscal PGV" };
```
por
```js
const VARIABLE_LABELS = AvmReport.VARIABLE_LABELS; // rótulos e relatório vivem em report.js, compartilhado com o Worker de e-mail
```

b) Apagar inteiras as funções `patternLabel`, `localSupport` e `riskList` (linhas 184–219).

c) Em `calculate()`, substituir o bloco que vai de `const reasons = AvmPredict.limitReasons(model, v); // recusa ANTES de calcular` até o fechamento de `latestReport = { ... };` (inclusive) por:

```js
  const computed = AvmReport.estimate(model, v); // recusa ANTES de calcular
  if (computed.refused) return refuse(computed.refused);
  const report = await AvmReport.build(model, v, computed); // identificação reprodutível (hash) — assíncrona
  if (seq !== calcSeq) return; // outra estimativa começou enquanto o hash era calculado
  latestReport = report;
  renderResult(latestReport);
```
(e remover o `renderResult(latestReport);` que já existia logo abaixo, para não chamar duas vezes).

d) Nada mais em `app.js` referenciava `patternLabel(`, `localSupport(` ou `riskList(` fora de `calculate()` — conferir com `grep -n 'patternLabel(\|localSupport(\|riskList(' site/assets/app.js`; a única ocorrência restante deve ser `v.patternLabel` em `renderResult`.

- [ ] **Step 6: `index.html` carrega `report.js`**

Em `site/index.html`, no bloco final de scripts, inserir depois da linha `<script src="assets/predict.js" defer></script>`:
```html
  <script src="assets/report.js" defer></script>
```
(ordem final: tesseract, matricula-reader, xlsx-export, common, predict, **report**, app).

- [ ] **Step 7: Rodar tudo**

Run: `npm run check`
Expected: lint ok, validador ok, 21 testes verdes (18 + 3). O `build` deve listar `assets/report.js` entre os arquivos com fingerprint.

- [ ] **Step 8: Verificar no navegador**

Abrir o preview `site-dev` (serve `site/` direto; não usar `wrangler-dev` para não depender de `dist/`), carregar `/`, marcar a confirmação e conferir que a estimativa do exemplo aparece com "Identificação AVM-SP-…" e que "Baixar Excel" produz arquivo. Console sem erros. Fechar o preview antes do próximo `npm run check`.

- [ ] **Step 9: Commit**

```bash
git add site/assets/report.js site/assets/app.js site/index.html tests/report.test.mjs
git commit -m "AvmReport: recusa, cálculo e montagem do relatório saem de app.js para site/assets/report.js

Módulo puro compartilhado com o Worker de e-mail (Entrega 1): mesma identificação e mesmos avisos
para as mesmas entradas. app.js só chama estimate/build; comportamento do site inalterado.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Fixture de textos + `postal-mime` + `parseInbound`

**Files:**
- Create: `tests/fixtures/textos.mjs`
- Modify: `tests/iptu-reader.test.mjs` (remover as constantes `CARNE` e `MATRICULA`, importar do fixture)
- Modify: `package.json` (`dependencies`)
- Create: `src/email.js` (início)
- Test: `tests/email.test.mjs` (início)

**Interfaces:**
- Produces: `tests/fixtures/textos.mjs` exporta `CARNE` e `MATRICULA` (strings).
- Produces: `parseInbound(raw: ArrayBuffer) → Promise<{ messageId: string|null, subject: string, attachments: Array<{ fileName, mimeType, bytes: Uint8Array }>, ignored: string[] }>` e `LIMITS`.
- Produces (para os testes seguintes): helper `mime({ from, subject, messageId, attachments: [[name, type, content]] }) → string` em `tests/email.test.mjs`.

- [ ] **Step 1: Mover os textos para o fixture**

`tests/fixtures/textos.mjs`:
```js
// Textos sintéticos, sem dado pessoal, no layout da Notificação de Lançamento do IPTU (PMSP) e de uma
// matrícula. Usados pelos testes do leitor e do pipeline de e-mail. Quando carnês reais entrarem em testes/
// (fora do git), os trechos dos campos entram aqui como casos adicionais.
export const CARNE = `
PREFEITURA DO MUNICÍPIO DE SÃO PAULO
SECRETARIA MUNICIPAL DA FAZENDA
NOTIFICAÇÃO DE LANÇAMENTO
IMPOSTO PREDIAL E TERRITORIAL URBANO - IPTU 2026
Número do Contribuinte: 042.115.0087-3
Local do imóvel: R VERGUEIRO, 2650 AP 81 - VILA MARIANA - CEP 04109-002
DADOS DO IMÓVEL
Área do Terreno (m²): 62,50   Área Construída (m²): 98,00   Área Ocupada (m²): 31,10
Testada (m): 12,00   Fração Ideal: 0,004512
Ano da Construção Corrigido: 2018
Tipo/Padrão: 2-C   Fator de Obsolescência: 0,90
CÁLCULO DO IMPOSTO
Valor do m² do Terreno (R$): 6.500,00
Valor do m² de Construção (R$): 2.361,00
Valor Venal do Terreno (R$): 406.250,00
Valor Venal da Construção (R$): 208.281,00
Valor Venal do Imóvel (R$): 614.531,00
`;

export const MATRICULA = `
OFICIAL DE REGISTRO DE IMÓVEIS DA CAPITAL - 1ª CIRCUNSCRIÇÃO
MATRÍCULA Nº 123.456
IMÓVEL: apartamento nº 81, localizado no 8º andar do edifício situado na Rua Vergueiro, nº 2.650,
com a área privativa de 78,00 m², área comum de 22,10 m², área total de 100,10 m².
Contribuinte nº 042.115.0087-3. AV.1 - Averbação de construção.
`;

// Mesma matrícula sem a palavra "apartamento": o modelo só cobre apartamentos, então isto tem de ser recusado.
export const MATRICULA_CASA = MATRICULA.replace("apartamento nº 81, localizado no 8º andar do edifício", "prédio residencial");
```

Em `tests/iptu-reader.test.mjs`: apagar as constantes `CARNE` e `MATRICULA` e acrescentar, após os imports:
```js
import { CARNE, MATRICULA } from "./fixtures/textos.mjs";
```
Run: `node --test tests/iptu-reader.test.mjs` → 6 pass.

- [ ] **Step 2: Instalar `postal-mime`**

```bash
npm install --save-exact postal-mime@3.0.0
```
Expected: `package.json` ganha `"dependencies": { "postal-mime": "3.0.0" }`; `package-lock.json` atualizado. `node -e "import('postal-mime').then(m => console.log(typeof m.default.parse))"` imprime `function`.

- [ ] **Step 3: Escrever o teste que falha**

`tests/email.test.mjs`:
```js
// Pipeline do AVM por e-mail (src/email.js) e handler email() do Worker. Node puro: env, message e serviços
// falsos; o texto dos PDFs vem do fixture, então os bytes dos anexos não importam. Rodar: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { CARNE, MATRICULA, MATRICULA_CASA } from "./fixtures/textos.mjs";
import { LIMITS, parseInbound } from "../src/email.js";

// Monta um e-mail multipart/mixed em RFC 5322. attachments: [[nome, tipo MIME, conteúdo (string)]].
export function mime({ from = "pessoa@exemplo.gov.br", subject = "Avaliação do apartamento", messageId = "<abc123@exemplo.gov.br>", attachments = [] } = {}) {
  const boundary = "fronteira-avm";
  const parts = attachments.map(([name, type, content]) => [
    `--${boundary}`, `Content-Type: ${type}; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`,
    "Content-Transfer-Encoding: base64", "", Buffer.from(content).toString("base64"),
  ].join("\r\n"));
  return [
    `From: Pessoa <${from}>`, "To: avm@heybrain.uk", `Subject: ${subject}`, messageId ? `Message-ID: ${messageId}` : null,
    "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "", "Seguem os documentos.",
    ...parts, `--${boundary}--`, "",
  ].filter((line) => line !== null).join("\r\n");
}

const raw = (options) => new TextEncoder().encode(mime(options)).buffer;

test("parseInbound: só PDFs e imagens, respeitando os tetos", async () => {
  const parsed = await parseInbound(raw({ attachments: [
    ["iptu.pdf", "application/pdf", "%PDF-1.4 carne"],
    ["matricula.PDF", "application/octet-stream", "%PDF-1.4 matricula"], // tipo genérico, extensão .pdf
    ["foto.jpg", "image/jpeg", "jpeg"],
    ["planilha.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "x"],
  ] }));
  assert.equal(parsed.messageId, "<abc123@exemplo.gov.br>");
  assert.equal(parsed.subject, "Avaliação do apartamento");
  assert.deepEqual(parsed.attachments.map((a) => [a.fileName, a.mimeType]), [["iptu.pdf", "application/pdf"], ["matricula.PDF", "application/pdf"], ["foto.jpg", "image/jpeg"]]);
  assert.ok(parsed.attachments[0].bytes instanceof Uint8Array && parsed.attachments[0].bytes.length > 0);
  assert.deepEqual(parsed.ignored, ["planilha.xlsx"]);
});

test("parseInbound: anexo acima do teto vai para ignorados; mais de 6 anexos, só os 6 primeiros", async () => {
  const grande = "x".repeat(LIMITS.maxAttachmentBytes + 1);
  const many = Array.from({ length: 8 }, (_, i) => [`doc${i}.pdf`, "application/pdf", "%PDF"]);
  const parsed = await parseInbound(raw({ attachments: [["grande.pdf", "application/pdf", grande], ...many] }));
  assert.ok(parsed.ignored.includes("grande.pdf"));
  assert.equal(parsed.attachments.length, LIMITS.maxAttachments);
});

test("parseInbound: sem Message-ID e sem anexos", async () => {
  const parsed = await parseInbound(raw({ messageId: null }));
  assert.equal(parsed.messageId, null);
  assert.deepEqual(parsed.attachments, []);
});
```

- [ ] **Step 4: Rodar e ver falhar**

Run: `node --test tests/email.test.mjs`
Expected: FAIL — `Cannot find module '../src/email.js'`.

- [ ] **Step 5: Criar `src/email.js` com `LIMITS` e `parseInbound`**

```js
// Pipeline do AVM por e-mail (spec docs/superpowers/specs/2026-09-08-email-avm-design.md, seção 4).
// Puro e sem estado: recebe o e-mail bruto e serviços injetados (deps), devolve a resposta pronta. Nada é gravado.
// Reaproveita os módulos do site: os scripts clássicos abaixo se registram em globalThis ao serem importados.
import PostalMime from "postal-mime";
import "../site/assets/predict.js";
import "../site/assets/report.js";
import "../site/assets/matricula-reader.js";
import "../site/assets/xlsx-export.js";
import model from "../site/assets/model.json" with { type: "json" };

export const LIMITS = Object.freeze({
  maxAttachments: 6,
  maxAttachmentBytes: 10 * 1024 * 1024,
  minTextChars: 200,     // abaixo disso o PDF é tratado como sem camada de texto
  maxTextChars: 200_000, // teto do texto extraído por documento
});

const PDF_TYPE = "application/pdf";
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function attachmentType(att) {
  const name = String(att.filename || "").toLocaleLowerCase("pt-BR");
  const type = String(att.mimeType || "").toLocaleLowerCase("pt-BR").split(";")[0].trim();
  if (type === PDF_TYPE || name.endsWith(".pdf")) return PDF_TYPE;
  if (IMAGE_TYPES.has(type)) return type;
  return null;
}

// Lê o MIME e separa o que o pipeline aceita (PDF; imagens ficam para a Entrega 2) do que é ignorado.
export async function parseInbound(raw) {
  const parsed = await PostalMime.parse(raw);
  const attachments = [];
  const ignored = [];
  for (const att of parsed.attachments || []) {
    const fileName = att.filename || "anexo";
    const mimeType = attachmentType(att);
    const bytes = att.content instanceof Uint8Array ? att.content : new Uint8Array(att.content);
    if (!mimeType || bytes.length === 0 || bytes.length > LIMITS.maxAttachmentBytes || attachments.length >= LIMITS.maxAttachments) {
      ignored.push(fileName);
      continue;
    }
    attachments.push({ fileName, mimeType, bytes });
  }
  return {
    messageId: parsed.messageId || null,
    subject: parsed.subject || "",
    attachments,
    ignored,
  };
}

export { model }; // o mesmo model.json do site, empacotado no Worker
```

- [ ] **Step 6: Rodar e ver passar**

Run: `node --test tests/email.test.mjs`
Expected: 3 pass. Se o Node reclamar do `with { type: "json" }`, confirmar `node --version` ≥ 22 (o `engines` do projeto exige).

- [ ] **Step 7: Lint e dry-run**

Run: `npm run lint`
Expected: `lint ok` — o `wrangler deploy --dry-run` empacota `postal-mime`, os scripts do site e o JSON. Se o esbuild rejeitar o `with { type: "json" }`, trocar por `import model from "../site/assets/model.json";` (sem atributo; o wrangler aceita) e, nos testes em Node, carregar o JSON com `readFileSync` e passá-lo por `deps.model` — mas só se o dry-run falhar; o caminho padrão é o atributo.

- [ ] **Step 8: Commit**

```bash
git add tests/fixtures/textos.mjs tests/iptu-reader.test.mjs tests/email.test.mjs src/email.js package.json package-lock.json
git commit -m "E-mail: parseInbound com postal-mime e fixture de textos compartilhada

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `readDocuments` e `buildInputs`

**Files:**
- Modify: `src/email.js`
- Test: `tests/email.test.mjs`

**Interfaces:**
- Consumes: `globalThis.AVMMatricula.{detectDocumentType, extractFields, extractIptuFields}`; `model.applicability.base_year`.
- Produces:
  - `readDocuments(texts: Array<{ fileName, text, method }>) → { docs: Array<{ fileName, type: "matricula"|"iptu", method, fields, unreadable: boolean }>, ambiguous: null | "matricula" | "iptu" }`
  - `buildInputs(docs) → { v } | { missing: string[] } | { notApartment: true } | { ambiguous: "matricula"|"iptu" }`
  - `formatCep(value) → "00000-000"`

- [ ] **Step 1: Escrever os testes que falham**

Acrescentar em `tests/email.test.mjs` (import: `import { LIMITS, parseInbound, readDocuments, buildInputs } from "../src/email.js";`):

```js
const textos = (pares) => pares.map(([fileName, text]) => ({ fileName, text, method: "texto do PDF" }));

test("readDocuments classifica e extrai; buildInputs monta v como o site", () => {
  const { docs, ambiguous } = readDocuments(textos([["iptu.pdf", CARNE], ["matricula.pdf", MATRICULA]]));
  assert.equal(ambiguous, null);
  assert.deepEqual(docs.map((d) => d.type), ["iptu", "matricula"]);
  const out = buildInputs(docs);
  assert.ok(out.v, JSON.stringify(out));
  const v = out.v;
  assert.equal(v.address, "Rua Vergueiro, 2650");
  assert.equal(v.cep, "04109-002");
  assert.equal(v.cep8, "04109002");
  assert.equal(v.area, 78);
  assert.equal(v.yearBuilt, 2018);
  assert.equal(v.age, 2026 - 2018);
  assert.equal(v.pattern, "22");
  assert.equal(v.fiscal, 6500);
  assert.equal(v.financing, "SFH");
  assert.equal(v.funds, "SBPE");
  assert.equal(v.declared, true);
  assert.deepEqual(v.enabledVariables, ["area", "age", "pattern", "fiscal"]);
  assert.equal(v.documentSource.fileName, "iptu.pdf + matricula.pdf");
  assert.equal(v.documentSource.method, "texto do PDF");
  assert.equal(v.documentSource.cepFromDocument, true);
  assert.ok(v.documentSource.areaFound && v.documentSource.ageFound && v.documentSource.patternFound && v.documentSource.fiscalFound && v.documentSource.addressFound);
});

test("readDocuments: texto curto é 'não lido'; só a matrícula → faltam os campos do carnê", () => {
  const { docs } = readDocuments(textos([["matricula.pdf", MATRICULA], ["iptu.pdf", "IPTU"]]));
  assert.equal(docs.find((d) => d.fileName === "iptu.pdf").unreadable, true);
  const out = buildInputs(docs);
  assert.deepEqual(out.missing, [
    "ano de construção (esperado no carnê de IPTU)",
    "padrão cadastral (esperado no carnê de IPTU)",
    "valor do m² do terreno (esperado no carnê de IPTU)",
  ]);
});

test("buildInputs: sem matrícula → faltam área e endereço; sem 'apartamento' → recusa", () => {
  const soIptu = readDocuments(textos([["iptu.pdf", CARNE]]));
  assert.deepEqual(buildInputs(soIptu.docs).missing, ["área privativa (esperada na matrícula)", "nenhuma matrícula identificada entre os anexos"]);
  const casa = readDocuments(textos([["iptu.pdf", CARNE], ["matricula.pdf", MATRICULA_CASA]]));
  assert.deepEqual(buildInputs(casa.docs), { notApartment: true });
});

test("readDocuments: duas matrículas é ambíguo", () => {
  const out = readDocuments(textos([["a.pdf", MATRICULA], ["b.pdf", MATRICULA], ["iptu.pdf", CARNE]]));
  assert.equal(out.ambiguous, "matricula");
  assert.deepEqual(buildInputs(out.docs, out.ambiguous), { ambiguous: "matricula" });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/email.test.mjs`
Expected: FAIL — `readDocuments is not a function` (ou export ausente).

- [ ] **Step 3: Implementar em `src/email.js`**

Acrescentar após `parseInbound`:

```js
export function formatCep(value) {
  const digits = String(value || "").replace(/\D/g, "").slice(0, 8);
  return digits.length === 8 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : "";
}

// Cada texto vira um documento classificado (carnê ou matrícula) com os campos que o leitor do site extrai.
// Texto curto = PDF sem camada de texto (na Entrega 2 é o gatilho do OCR). Dois do mesmo tipo = ambíguo.
export function readDocuments(texts) {
  const { detectDocumentType, extractFields, extractIptuFields } = globalThis.AVMMatricula;
  const docs = texts.map(({ fileName, text, method }) => {
    const clean = String(text || "").slice(0, LIMITS.maxTextChars);
    const unreadable = clean.trim().length < LIMITS.minTextChars;
    const type = detectDocumentType(clean);
    const fields = unreadable ? null : (type === "iptu" ? extractIptuFields(clean) : extractFields(clean));
    return { fileName, type, method, fields, unreadable, apartment: type === "matricula" && /\bapartamento\b/iu.test(clean) };
  });
  const readable = docs.filter((d) => !d.unreadable);
  const ambiguous = readable.filter((d) => d.type === "matricula").length > 1 ? "matricula"
    : readable.filter((d) => d.type === "iptu").length > 1 ? "iptu" : null;
  return { docs, ambiguous };
}

// Monta o mesmo objeto que getInputs() monta no site. Matrícula manda no endereço e na área; carnê nas
// outras três (endereço/CEP do carnê só como reserva). Faltou campo → lista exata, sem adivinhar.
export function buildInputs(docs, ambiguous = null) {
  if (ambiguous) return { ambiguous };
  const matricula = docs.find((d) => d.type === "matricula" && !d.unreadable) || null;
  const iptu = docs.find((d) => d.type === "iptu" && !d.unreadable) || null;
  const m = matricula?.fields || {};
  const i = iptu?.fields || {};
  const missing = [];
  if (!m.area) missing.push("área privativa (esperada na matrícula)");
  if (!matricula) missing.push("nenhuma matrícula identificada entre os anexos");
  if (!i.yearBuilt) missing.push("ano de construção (esperado no carnê de IPTU)");
  if (!i.patternCode) missing.push(i.patternLabel ? `padrão cadastral ${i.patternLabel} não é residencial vertical (2-A a 2-E)` : "padrão cadastral (esperado no carnê de IPTU)");
  if (!i.fiscal) missing.push("valor do m² do terreno (esperado no carnê de IPTU)");
  if (!iptu) missing.push("nenhum carnê de IPTU identificado entre os anexos");
  const address = m.address || i.address || "";
  if (!address) missing.push("endereço (esperado na matrícula ou no carnê)");
  if (missing.length) return { missing };
  if (!matricula.apartment) return { notApartment: true };

  const cep = formatCep(i.cep || m.cep || "");
  const read = [iptu, matricula];
  const yearBuilt = i.yearBuilt;
  return {
    v: {
      address,
      district: "",
      cep,
      cep8: cep.replace("-", ""),
      area: m.area,
      age: model.applicability.base_year - yearBuilt,
      yearBuilt,
      pattern: String(i.patternCode),
      fiscal: i.fiscal,
      financing: "SFH",
      funds: "SBPE",
      declared: true, // premissa verificada acima: a matrícula descreve um apartamento
      enabledVariables: [...model.variable_order],
      documentSource: {
        fileName: read.map((d) => d.fileName).join(" + "),
        method: [...new Set(read.map((d) => d.method))].join(" e "),
        addressFound: true,
        areaFound: true,
        areaLabel: m.areaLabel,
        ageFound: true,
        patternFound: true,
        fiscalFound: true,
        cepFromDocument: Boolean(cep),
        geocode: null,
      },
    },
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/email.test.mjs`
Expected: 7 pass. Se o teste de "só a matrícula" listar também `"nenhum carnê de IPTU identificado entre os anexos"`, está certo que **não** liste: o carnê existe, só está ilegível — `iptu` é `null` porque `unreadable`. Ajuste esperado: contar `unreadable` como "identificado": trocar as duas linhas de "nenhum … identificado" para usar `docs.some((d) => d.type === "matricula")` / `docs.some((d) => d.type === "iptu")` em vez de `!matricula` / `!iptu`. O teste é a referência.

- [ ] **Step 5: Commit**

```bash
git add src/email.js tests/email.test.mjs
git commit -m "E-mail: readDocuments/buildInputs — classificação, extração e o mesmo v do site

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `compose` — textos da resposta

**Files:**
- Modify: `src/email.js`
- Test: `tests/email.test.mjs`

**Interfaces:**
- Produces: `compose(kind, data) → { subject, text, html }` com `kind ∈ "report" | "refused" | "missing" | "unreadable" | "ambiguous"`; `data` = `{ subject, report, unreadable: string[], ignored: string[] }` para `report`; `{ subject, reasons }` para `refused`; `{ subject, missing, unreadable, ignored }` para `missing`; `{ subject, unreadable }` para `unreadable`; `{ subject, ambiguous }` para `ambiguous`.

- [ ] **Step 1: Escrever os testes que falham**

Acrescentar em `tests/email.test.mjs` (import também `compose`, e do report: `import "../site/assets/predict.js"; import "../site/assets/report.js";` já vêm via `src/email.js`, então `globalThis.AvmReport` existe após o import):

```js
async function relatorioExemplo() {
  const { docs } = readDocuments(textos([["iptu.pdf", CARNE], ["matricula.pdf", MATRICULA]]));
  const { v } = buildInputs(docs);
  v.district = "Paraíso";
  const { AvmReport } = globalThis;
  const { model } = await import("../src/email.js");
  return AvmReport.build(model, v, AvmReport.estimate(model, v), new Date("2026-09-08T12:00:00Z"));
}

test("compose(report): identificação, faixa, documentos, premissas, avisos e rodapé", async () => {
  const report = await relatorioExemplo();
  const out = compose("report", { subject: "Avaliação", report, unreadable: [], ignored: ["planilha.xlsx"] });
  assert.equal(out.subject, "Re: Avaliação");
  for (const trecho of [
    "Não é laudo", `Identificação: ${report.id}`, "Rua Vergueiro, 2650 · CEP 04109-002 · Paraíso",
    "área privativa 78 m² (matrícula)", "idade 8 anos / 2018 (IPTU)", "padrão 2-C (IPTU)", "VM2T R$ 6.500/m² (IPTU)",
    "Faixa de 80% de probabilidade: R$", "Valor central: R$", "/m²)",
    "Documentos lidos: iptu.pdf + matricula.pdf — texto do PDF.", "Ignorados: planilha.xlsx.",
    "apartamento residencial (conforme a matrícula)", "SFH / SBPE", report.risks[0],
    "https://avm.heybrain.uk/metodologia", "processados em memória e não foram armazenados",
  ]) assert.ok(out.text.includes(trecho), `faltou no texto: ${trecho}`);
  assert.ok(out.html.includes("<p>") && out.html.includes(report.id) && !out.html.includes("<script"));
});

test("compose: recusa, faltou, não lido e ambíguo", () => {
  const refused = compose("refused", { subject: "", reasons: [{ code: "area", text: "área privativa acima de 250 m²" }] });
  assert.equal(refused.subject, "AVM SP — estimativa");
  assert.ok(refused.text.includes("recusada porque o imóvel está fora do domínio do modelo") && refused.text.includes("área privativa acima de 250 m²") && refused.text.includes("Não há relatório."));
  const missing = compose("missing", { subject: "x", missing: ["área privativa (esperada na matrícula)"], unreadable: ["iptu.pdf"], ignored: [] });
  assert.ok(missing.text.includes("Faltou:") && missing.text.includes("- área privativa (esperada na matrícula)") && missing.text.includes("Não foi possível ler: iptu.pdf (sem camada de texto)") && missing.text.includes("Reenvie com os documentos completos, em um único e-mail."));
  const unreadable = compose("unreadable", { subject: "x", unreadable: ["a.pdf", "b.pdf"] });
  assert.ok(unreadable.text.includes("Não foi possível ler: a.pdf, b.pdf (sem camada de texto).") && unreadable.text.includes("Envie o PDF original digital."));
  const ambiguous = compose("ambiguous", { subject: "x", ambiguous: "matricula" });
  assert.ok(ambiguous.text.includes("mais de uma matrícula") && ambiguous.text.includes("Envie um imóvel por e-mail."));
  const notApartment = compose("refused", { subject: "x", reasons: [{ code: "apartment", text: "a matrícula não descreve um apartamento; o modelo cobre apenas apartamentos residenciais" }] });
  assert.ok(notApartment.text.includes("não descreve um apartamento"));
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/email.test.mjs`
Expected: FAIL — `compose is not a function`.

- [ ] **Step 3: Implementar `compose` em `src/email.js`**

```js
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const areaNumber = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 4 });
const SITE = "https://avm.heybrain.uk";
const HEADER = "AVM SP — estimativa estatística de valor. Não é laudo nem avaliação (NBR 14653-2).";
const FOOTER = `Mensagem automática. Os anexos foram processados em memória e não foram armazenados.`;

const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));

function subjectFor(original) {
  const clean = String(original || "").replace(/[\r\n]+/g, " ").trim();
  return clean ? `Re: ${clean}` : "AVM SP — estimativa";
}

// Um bloco por parágrafo; o HTML é o mesmo texto, parágrafo a parágrafo, sem imagens nem CSS externo.
function render(subject, blocks) {
  const paragraphs = blocks.filter(Boolean);
  return {
    subject,
    text: paragraphs.join("\n\n") + "\n",
    html: `<!doctype html><html lang="pt-BR"><body>${paragraphs.map((p) => `<p>${escapeHtml(p).replaceAll("\n", "<br>")}</p>`).join("")}</body></html>`,
  };
}

const list = (items) => items.map((item) => `- ${item}`).join("\n");
const unreadableLine = (files) => (files.length ? `Não foi possível ler: ${files.join(", ")} (sem camada de texto).` : null);
const ignoredLine = (files) => (files.length ? `Ignorados: ${files.join(", ")}.` : null);

export function compose(kind, data) {
  const subject = subjectFor(data.subject);
  if (kind === "report") {
    const { report } = data;
    const p = report.property;
    const r = report.result;
    const place = [p.address, p.cep ? `CEP ${p.cep}` : null, p.district || null].filter(Boolean).join(" · ");
    return render(subject, [
      HEADER,
      `Identificação: ${report.id}\nImóvel: ${place}\nDados usados: área privativa ${areaNumber.format(p.area)} m² (matrícula) · idade ${p.age} ${p.age === 1 ? "ano" : "anos"} / ${p.yearBuilt} (IPTU) · padrão ${p.patternLabel} (IPTU) · VM2T ${money.format(p.fiscal)}/m² (IPTU)\nFaixa de 80% de probabilidade: ${money.format(r.interval80[0])} a ${money.format(r.interval80[1])}\nValor central: ${money.format(r.estimate)}${r.pricePerM2 ? ` (${money.format(r.pricePerM2)}/m²)` : ""}`,
      [`Documentos lidos: ${p.documentSource.fileName} — ${p.documentSource.method}.`, unreadableLine(data.unreadable || []), ignoredLine(data.ignored || [])].filter(Boolean).join(" "),
      "Premissas: apartamento residencial (conforme a matrícula); compra e venda; SFH / SBPE registrados no relatório, sem efeito na estimativa.",
      `Avisos:\n${list(report.risks)}`,
      `O relatório completo está no Excel anexo. Metodologia: ${SITE}/metodologia`,
      FOOTER,
    ]);
  }
  if (kind === "refused") {
    return render(subject, [HEADER, `A estimativa foi recusada porque o imóvel está fora do domínio do modelo:\n${list(data.reasons.map((reason) => reason.text))}\nNão há relatório.`, `Metodologia e limites: ${SITE}/metodologia`, FOOTER]);
  }
  if (kind === "missing") {
    return render(subject, [HEADER, `Não foi possível estimar. Faltou:\n${list(data.missing)}`, unreadableLine(data.unreadable || []), ignoredLine(data.ignored || []), "Reenvie com os documentos completos, em um único e-mail.", FOOTER]);
  }
  if (kind === "unreadable") {
    return render(subject, [HEADER, unreadableLine(data.unreadable), "Envie o PDF original digital.", FOOTER]);
  }
  if (kind === "ambiguous") {
    const what = data.ambiguous === "iptu" ? "mais de um carnê de IPTU" : "mais de uma matrícula";
    return render(subject, [HEADER, `Foram encontrados ${what} entre os anexos. Envie um imóvel por e-mail.`, FOOTER]);
  }
  throw new Error(`compose: tipo desconhecido ${kind}`);
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/email.test.mjs`
Expected: 9 pass. Se `MATRICULA` do fixture fizer `extractFields` devolver um CEP (não deve: o texto não tem CEP), o `place` ainda sai com o CEP do carnê. Se `report.risks[0]` não bater, o texto está diferente do `riskList` — corrigir o `compose`, nunca o fixture.

- [ ] **Step 5: Commit**

```bash
git add src/email.js tests/email.test.mjs
git commit -m "E-mail: compose — corpo da resposta (relatório, recusa, faltou, não lido, ambíguo)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `processEmail` — texto via `toMarkdown`, bairro via Nominatim, relatório e Excel

**Files:**
- Modify: `src/email.js`
- Test: `tests/email.test.mjs`

**Interfaces:**
- Consumes: `parseInbound`, `readDocuments`, `buildInputs`, `compose`, `globalThis.AvmReport`, `globalThis.AVMExcel.buildWorkbook(report)`.
- Produces: `processEmail({ raw: ArrayBuffer, subject: string }, deps: { ai: { toMarkdown }, fetch, now?: Date }) → Promise<{ outcome: "report"|"refused"|"missing"|"unreadable"|"ambiguous", reply: { subject, text, html, attachments: Array<{ filename, content: Uint8Array, type, disposition }> }, messageId: string|null, log: { documents: number, unreadable: number, ocr_pages: number } }>`.

- [ ] **Step 1: Escrever os testes que falham**

Acrescentar em `tests/email.test.mjs` (import também `processEmail`):

```js
// Serviços falsos: toMarkdown devolve o texto do fixture pelo nome do arquivo; Nominatim devolve um bairro.
const TEXTOS = { "iptu.pdf": CARNE, "matricula.pdf": MATRICULA, "casa.pdf": MATRICULA_CASA, "vazio.pdf": "" };
const ai = { toMarkdown: async (docs) => docs.map((doc) => ({ name: doc.name, mimeType: "application/pdf", format: "text", tokens: 0, data: TEXTOS[doc.name] ?? "" })) };
const nominatimCalls = [];
const fetchFalso = async (url, init) => {
  nominatimCalls.push({ url: String(url), init });
  return { ok: true, json: async () => [{ address: { postcode: "04109-002", suburb: "Paraíso" } }] };
};
const deps = { ai, fetch: fetchFalso, now: new Date("2026-09-08T12:00:00Z") };
const anexos = (nomes) => nomes.map((nome) => [nome, "application/pdf", `%PDF-1.4 ${nome}`]);

test("processEmail: dois PDFs → relatório com Excel anexo e bairro do Nominatim", async () => {
  nominatimCalls.length = 0;
  const out = await processEmail({ raw: raw({ attachments: anexos(["iptu.pdf", "matricula.pdf"]) }), subject: "Avaliação" }, deps);
  assert.equal(out.outcome, "report");
  assert.equal(out.messageId, "<abc123@exemplo.gov.br>");
  assert.equal(out.reply.subject, "Re: Avaliação");
  assert.ok(out.reply.text.includes("Paraíso"));
  assert.equal(out.reply.attachments.length, 1);
  const [xlsx] = out.reply.attachments;
  assert.match(xlsx.filename, /^AVM-SP-20260908-[0-9A-F]{12}\.xlsx$/);
  assert.equal(xlsx.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.ok(xlsx.content instanceof Uint8Array && xlsx.content.length > 1000);
  assert.equal(String.fromCharCode(...xlsx.content.slice(0, 2)), "PK"); // é um zip
  assert.equal(nominatimCalls.length, 1);
  assert.ok(nominatimCalls[0].url.startsWith("https://nominatim.openstreetmap.org/search?"));
  assert.equal(nominatimCalls[0].init.headers["User-Agent"], "AVM-SP/1 (avm@heybrain.uk)");
  assert.deepEqual(out.log, { documents: 2, unreadable: 0, ocr_pages: 0 });
});

test("processEmail: Nominatim falha → relatório sem bairro, sem erro", async () => {
  const out = await processEmail({ raw: raw({ attachments: anexos(["iptu.pdf", "matricula.pdf"]) }), subject: "x" }, { ...deps, fetch: async () => { throw new Error("rede"); } });
  assert.equal(out.outcome, "report");
  assert.ok(out.reply.text.includes("Rua Vergueiro, 2650 · CEP 04109-002\n"));
});

test("processEmail: só matrícula → faltou; matrícula de casa → recusa; sem texto → não lido; duas matrículas → ambíguo", async () => {
  assert.equal((await processEmail({ raw: raw({ attachments: anexos(["matricula.pdf"]) }), subject: "x" }, deps)).outcome, "missing");
  const casa = await processEmail({ raw: raw({ attachments: anexos(["iptu.pdf", "casa.pdf"]) }), subject: "x" }, deps);
  assert.equal(casa.outcome, "refused");
  assert.ok(casa.reply.text.includes("não descreve um apartamento"));
  const vazio = await processEmail({ raw: raw({ attachments: anexos(["vazio.pdf"]) }), subject: "x" }, deps);
  assert.equal(vazio.outcome, "unreadable");
  assert.equal(vazio.log.unreadable, 1);
  const duas = await processEmail({ raw: raw({ attachments: [["a.pdf", "application/pdf", "x"], ["b.pdf", "application/pdf", "y"], ...anexos(["iptu.pdf"])] }), subject: "x" }, { ...deps, ai: { toMarkdown: async (docs) => docs.map((doc) => ({ name: doc.name, data: doc.name === "iptu.pdf" ? CARNE : MATRICULA })) } });
  assert.equal(duas.outcome, "ambiguous");
});

test("processEmail: fora do domínio → recusada com os textos do modelo", async () => {
  const grande = { toMarkdown: async (docs) => docs.map((doc) => ({ name: doc.name, data: doc.name === "iptu.pdf" ? CARNE : MATRICULA.replace("78,00 m²", "300,00 m²") })) };
  const out = await processEmail({ raw: raw({ attachments: anexos(["iptu.pdf", "matricula.pdf"]) }), subject: "x" }, { ...deps, ai: grande });
  assert.equal(out.outcome, "refused");
  assert.ok(out.reply.text.includes("fora do domínio do modelo"));
  assert.deepEqual(out.reply.attachments, []);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/email.test.mjs`
Expected: FAIL — `processEmail is not a function`.

- [ ] **Step 3: Implementar `processEmail` em `src/email.js`**

```js
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "AVM-SP/1 (avm@heybrain.uk)"; // política de uso do Nominatim: identificar a aplicação

// Texto de cada PDF pelo serviço de conversão do Workers AI (sem biblioteca de PDF no Worker).
async function extractTexts(ai, attachments) {
  const texts = [];
  for (const att of attachments) {
    if (att.mimeType !== PDF_TYPE) { texts.push({ fileName: att.fileName, text: "", method: "imagem" }); continue; } // imagens: Entrega 2
    let text = "";
    try {
      const [result] = await ai.toMarkdown(
        [{ name: att.fileName, blob: new Blob([att.bytes], { type: PDF_TYPE }) }],
        { output: { format: "text" }, conversionOptions: { pdf: { excludeMetadata: true } } },
      );
      text = String(result?.data || "");
    } catch (_) {
      text = ""; // serviço indisponível ou PDF corrompido: vira "não lido"
    }
    texts.push({ fileName: att.fileName, text, method: "texto do PDF" });
  }
  return texts;
}

// Uma consulta, só para o bairro; o CEP do documento prevalece (mesma regra do site). Falha → sem bairro.
async function lookupDistrict(fetchFn, v) {
  try {
    const params = new URLSearchParams({ q: `${v.address}, São Paulo, SP, Brasil`, format: "jsonv2", addressdetails: "1", countrycodes: "br", limit: "5", dedupe: "1", "accept-language": "pt-BR" });
    const response = await fetchFn(`${NOMINATIM}?${params}`, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return;
    const results = await response.json();
    const candidate = (Array.isArray(results) ? results : []).find((item) => item.address?.postcode) || results[0];
    const details = candidate?.address || {};
    v.district = details.suburb || details.neighbourhood || details.quarter || details.city_district || "";
    if (!v.cep8 && details.postcode) { v.cep = formatCep(details.postcode); v.cep8 = v.cep.replace("-", ""); }
    if (v.documentSource) v.documentSource.geocode = "OpenStreetMap/Nominatim";
  } catch (_) { /* sem bairro: o relatório sai assim mesmo */ }
}

// Do e-mail bruto à resposta pronta. Nada persiste; deps traz os serviços para o teste injetar os seus.
export async function processEmail({ raw, subject }, deps) {
  const now = deps.now || new Date();
  const inbound = await parseInbound(raw);
  const texts = await extractTexts(deps.ai, inbound.attachments);
  const { docs, ambiguous } = readDocuments(texts);
  const unreadable = docs.filter((d) => d.unreadable).map((d) => d.fileName);
  const log = { documents: docs.length, unreadable: unreadable.length, ocr_pages: 0 };
  const finish = (outcome, reply) => ({ outcome, reply: { ...reply, attachments: reply.attachments || [] }, messageId: inbound.messageId, log });
  const base = { subject: subject ?? inbound.subject, unreadable, ignored: inbound.ignored };

  if (docs.length && unreadable.length === docs.length) return finish("unreadable", compose("unreadable", base));
  const built = buildInputs(docs, ambiguous);
  if (built.ambiguous) return finish("ambiguous", compose("ambiguous", { ...base, ambiguous: built.ambiguous }));
  if (built.missing) return finish("missing", compose("missing", { ...base, missing: built.missing }));
  if (built.notApartment) return finish("refused", compose("refused", { ...base, reasons: [{ code: "apartment", text: "a matrícula não descreve um apartamento; o modelo cobre apenas apartamentos residenciais" }] }));

  const { v } = built;
  await lookupDistrict(deps.fetch, v);
  const { AvmReport, AVMExcel } = globalThis;
  const computed = AvmReport.estimate(model, v);
  if (computed.refused) return finish("refused", compose("refused", { ...base, reasons: computed.refused }));
  const report = await AvmReport.build(model, v, computed, now);
  const bytes = AVMExcel.buildWorkbook(report);
  const content = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return finish("report", { ...compose("report", { ...base, report }), attachments: [{ filename: `${report.id}.xlsx`, content, type: XLSX_TYPE, disposition: "attachment" }] });
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/email.test.mjs`
Expected: 13 pass. Observações prováveis e o que fazer:
- Se `AbortSignal.timeout` não existir no Node em uso, o Node é < 17.3 — o projeto exige 22; atualizar o Node.
- Se `out.reply.text` não contiver `"CEP 04109-002\n"` no caso sem bairro, é o `place` de `compose` terminando diferente — o teste é a referência (o `\n` vem do `Dados usados` na linha seguinte).

- [ ] **Step 5: Commit**

```bash
git add src/email.js tests/email.test.mjs
git commit -m "E-mail: processEmail — texto por toMarkdown, bairro por Nominatim, relatório e Excel

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Handler `email()` no Worker + bindings

**Files:**
- Modify: `src/worker.js`
- Modify: `wrangler.jsonc`
- Test: `tests/email.test.mjs`

**Interfaces:**
- Consumes: `processEmail` (Task 6); bindings `env.EMAIL.send`, `env.EMAIL_RL.limit`, `env.AI`, `env.ALLOWED_SENDERS` (segredo), `env.EMAIL_FROM` (var).
- Produces: `export default { fetch, email }` em `src/worker.js`; `allowedSender(from, list) → boolean` exportado para teste.

- [ ] **Step 1: Escrever os testes que falham**

Acrescentar em `tests/email.test.mjs`:

```js
import worker, { allowedSender } from "../src/worker.js";

test("allowedSender: domínio exato ou endereço exato, sem diferenciar maiúsculas", () => {
  const lista = "@Exemplo.gov.br, pessoa@empresa.com.br";
  assert.equal(allowedSender("Fulano@exemplo.gov.br", lista), true);
  assert.equal(allowedSender("pessoa@EMPRESA.com.br", lista), true);
  assert.equal(allowedSender("x@sub.exemplo.gov.br", lista), false);
  assert.equal(allowedSender("outra@empresa.com.br", lista), false);
  assert.equal(allowedSender("", lista), false);
  assert.equal(allowedSender("a@b.c", ""), false);
  assert.equal(allowedSender("a@b.c", undefined), false);
});

function mensagem({ from = "pessoa@exemplo.gov.br", attachments = anexos(["iptu.pdf", "matricula.pdf"]), messageId = "<abc123@exemplo.gov.br>", size } = {}) {
  const body = mime({ from, attachments, messageId, subject: "Avaliação" });
  const headers = new Headers({ subject: "Avaliação" });
  if (messageId) headers.set("message-id", messageId);
  return {
    from, to: "avm@heybrain.uk", headers,
    raw: new Blob([body]).stream(), rawSize: size ?? body.length,
    rejected: null, setReject(reason) { this.rejected = reason; },
  };
}

function ambiente({ allow = true, sendFails = false } = {}) {
  const sent = [];
  return {
    sent,
    env: {
      ALLOWED_SENDERS: "@exemplo.gov.br",
      EMAIL_FROM: "avm@heybrain.uk",
      EMAIL_RL: { limit: async () => ({ success: allow }) },
      AI: ai,
      EMAIL: { send: async (msg) => { if (sendFails) throw new Error("quota"); sent.push(msg); return { messageId: "<resp@heybrain.uk>" }; } },
      ASSETS: { fetch: async () => new Response("asset") },
    },
  };
}

const logs = [];
const realLog = console.log;
test.before(() => { console.log = (line) => logs.push(JSON.parse(line)); globalThis.fetch = fetchFalso; });
test.after(() => { console.log = realLog; });

test("email(): remetente fora da lista → setReject sem ler nem responder", async () => {
  const { env, sent } = ambiente();
  const msg = mensagem({ from: "spam@outro.com" });
  await worker.email(msg, env, {});
  assert.match(msg.rejected, /não autorizado/);
  assert.equal(sent.length, 0);
  assert.deepEqual(logs.at(-1).event, "email_rejected");
  assert.equal(logs.at(-1).reason, "unauthorized");
  assert.equal("from" in logs.at(-1), false);
});

test("email(): limite e tamanho → setReject", async () => {
  const limitado = ambiente({ allow: false });
  const m1 = mensagem();
  await worker.email(m1, limitado.env, {});
  assert.match(m1.rejected, /Limite/);
  const m2 = mensagem({ size: 21 * 1024 * 1024 });
  await worker.email(m2, ambiente().env, {});
  assert.match(m2.rejected, /grande demais/);
  assert.equal(logs.at(-1).reason, "too_large");
});

test("email(): caminho feliz → um send com Excel, na mesma conversa, e log sem dados pessoais", async () => {
  const { env, sent } = ambiente();
  const msg = mensagem();
  await worker.email(msg, env, {});
  assert.equal(msg.rejected, null);
  assert.equal(sent.length, 1);
  const [mail] = sent;
  assert.equal(mail.to, "pessoa@exemplo.gov.br");
  assert.deepEqual(mail.from, { email: "avm@heybrain.uk", name: "AVM SP" });
  assert.equal(mail.subject, "Re: Avaliação");
  assert.equal(mail.headers["In-Reply-To"], "<abc123@exemplo.gov.br>");
  assert.equal(mail.headers.References, "<abc123@exemplo.gov.br>");
  assert.ok(mail.text.includes("Identificação: AVM-SP-") && mail.html.includes("AVM-SP-"));
  assert.equal(mail.attachments.length, 1);
  assert.match(mail.attachments[0].filename, /\.xlsx$/);
  const log = logs.at(-1);
  assert.equal(log.event, "email_processed");
  assert.equal(log.outcome, "report");
  assert.equal(log.documents, 2);
  assert.equal(typeof log.ms, "number");
  assert.equal(JSON.stringify(log).includes("exemplo.gov.br"), false);
  assert.equal(JSON.stringify(log).includes("iptu.pdf"), false);
});

test("email(): sem Message-ID não manda cabeçalhos de conversa; send falha → setReject", async () => {
  const { env, sent } = ambiente();
  await worker.email(mensagem({ messageId: null }), env, {});
  assert.equal(sent.at(-1).headers, undefined);
  const falho = ambiente({ sendFails: true });
  const msg = mensagem();
  await worker.email(msg, falho.env, {});
  assert.match(msg.rejected, /Falha temporária/);
  assert.equal(logs.at(-1).event, "email_send_failed");
  assert.equal(logs.at(-1).error, "Error");
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/email.test.mjs`
Expected: FAIL — `allowedSender` não exportado / `worker.email is not a function`.

- [ ] **Step 3: Implementar em `src/worker.js`**

No topo, depois do comentário existente, acrescentar o import e as constantes:

```js
import { processEmail } from "./email.js";

// Estimativa por e-mail (spec 2026-09-08, Entrega 1). Guardas na ordem barato → caro; nada do corpo é lido antes
// de o remetente passar. Só o envelope (message.from) autoriza; From/Reply-To são falsificáveis.
const MAX_RAW_BYTES = 20 * 1024 * 1024;

export function allowedSender(from, list) {
  const sender = String(from || "").trim().toLowerCase();
  if (!sender.includes("@")) return false;
  const domain = sender.slice(sender.lastIndexOf("@"));
  return String(list || "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean)
    .some((entry) => (entry.startsWith("@") ? entry === domain : entry === sender));
}
```

E no `export default { ... }`, depois do método `fetch`, acrescentar:

```js
  async email(message, env) {
    const started = Date.now();
    const log = (event, extra) => console.log(JSON.stringify({ event, ...extra, ms: Date.now() - started })); // nunca endereço, arquivo ou valores
    if (!allowedSender(message.from, env.ALLOWED_SENDERS)) { message.setReject("Remetente não autorizado para o AVM SP."); return log("email_rejected", { reason: "unauthorized" }); }
    const { success } = await env.EMAIL_RL.limit({ key: String(message.from).toLowerCase() });
    if (!success) { message.setReject("Limite de envios atingido; aguarde um minuto."); return log("email_rejected", { reason: "ratelimit" }); }
    if (message.rawSize > MAX_RAW_BYTES) { message.setReject("Mensagem grande demais (máximo 20 MB)."); return log("email_rejected", { reason: "too_large" }); }

    let result;
    try {
      const raw = await new Response(message.raw).arrayBuffer(); // o stream é de uso único
      result = await processEmail({ raw, subject: message.headers.get("subject") }, { ai: env.AI, fetch: globalThis.fetch });
    } catch (error) {
      message.setReject("Erro interno ao processar. Tente novamente.");
      return log("email_processed", { outcome: "error", error: error.name });
    }

    const messageId = message.headers.get("message-id") || result.messageId;
    try {
      await env.EMAIL.send({
        to: message.from,
        from: { email: env.EMAIL_FROM, name: "AVM SP" },
        subject: result.reply.subject,
        text: result.reply.text,
        html: result.reply.html,
        ...(messageId ? { headers: { "In-Reply-To": messageId, References: messageId } } : {}),
        ...(result.reply.attachments.length ? { attachments: result.reply.attachments } : {}),
      });
    } catch (error) {
      message.setReject("Falha temporária ao responder. Reenvie em alguns minutos.");
      return log("email_send_failed", { error: error.name });
    }
    return log("email_processed", { outcome: result.outcome, ...result.log });
  },
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/email.test.mjs tests/worker.test.mjs`
Expected: todos verdes (18 no email, 4 no worker). Se `worker.test.mjs` quebrar porque `console.log` foi trocado, é conflito de espiões entre arquivos — o `node --test` roda cada arquivo em processo próprio, então não deve; se acontecer, restaurar `console.log` no `test.after` (já previsto).

- [ ] **Step 5: `wrangler.jsonc`**

Acrescentar, mantendo o que existe:

```jsonc
  // Estimativa por e-mail (Entrega 1): resposta ao remetente pelo Email Sending; texto dos PDFs pelo Workers AI.
  "send_email": [{ "name": "EMAIL" }],
  "ai": { "binding": "AI" },
  "vars": { "EMAIL_FROM": "avm@heybrain.uk" },
  // ALLOWED_SENDERS é segredo (wrangler secret put): identifica o cliente da licitação. Formato na RUNBOOK.
  "limits": { "cpu_ms": 60000 }, // folga para o OCR da Entrega 2; a Entrega 1 usa < 1 s
```
e em `ratelimits`, acrescentar o segundo item:
```jsonc
  "ratelimits": [
    { "name": "ERRO_RL", "namespace_id": "1001", "simple": { "limit": 5, "period": 60 } },
    { "name": "EMAIL_RL", "namespace_id": "1002", "simple": { "limit": 3, "period": 60 } } // por remetente autorizado
  ],
```

- [ ] **Step 6: `npm run check`**

Run: `npm run check`
Expected: verde. O `wrangler deploy --dry-run` aceita os bindings novos sem autenticação. Se reclamar de `limits` ("only supported for the Standard Usage Model"), a conta está no modelo Standard (Paid) — é o esperado; se reclamar mesmo assim, remover `limits` (a Entrega 1 cabe nos 30 s padrão) e anotar na PR.

- [ ] **Step 7: Teste local do handler pelo endpoint do wrangler**

Gerar um `.eml` de teste no scratchpad e disparar contra o `wrangler dev` (**preview `wrangler-dev`**, nunca com `npm run build` rodando ao mesmo tempo):

```bash
node -e '
const fs = require("fs");
const b = "fronteira";
const pdf = (n) => `--${b}\r\nContent-Type: application/pdf; name="${n}"\r\nContent-Disposition: attachment; filename="${n}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from("%PDF-1.4 teste").toString("base64")}`;
fs.writeFileSync(process.env.SCRATCH + "/teste.eml", ["From: teste@exemplo.gov.br","To: avm@heybrain.uk","Subject: Teste local","Message-ID: <local-1@exemplo.gov.br>","MIME-Version: 1.0",`Content-Type: multipart/mixed; boundary="${b}"`,"",`--${b}`,"Content-Type: text/plain","","Seguem.",pdf("iptu.pdf"),pdf("matricula.pdf"),`--${b}--`,""].join("\r\n"));
'
```
Com o preview `wrangler-dev` aberto e `ALLOWED_SENDERS=@exemplo.gov.br` num `.dev.vars` (arquivo já ignorado pelo git? conferir `.gitignore`; se não estiver, acrescentar `.dev.vars`):

```bash
curl --request POST 'http://localhost:8787/cdn-cgi/local/email' --url-query 'from=teste@exemplo.gov.br' --url-query 'to=avm@heybrain.uk' --data-binary @"$SCRATCH/teste.eml"
```
Expected: no terminal do wrangler, `[wrangler:info] send_email binding called` com `To: teste@exemplo.gov.br` e `Subject: Re: Teste local` — o `toMarkdown` de um PDF falso devolve texto vazio, então a resposta é a de "não lido" (sem anexo, o que evita a limitação de `ArrayBuffer` do simulador). Uma linha `{"event":"email_processed","outcome":"unreadable",...}` aparece. Fechar o preview.

- [ ] **Step 8: Commit**

```bash
git add src/worker.js wrangler.jsonc tests/email.test.mjs .gitignore
git commit -m "Worker: handler email() — remetentes autorizados, limite, processEmail e resposta pelo send_email

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Privacidade e termos mínimos, RUNBOOK, README

**Files:**
- Modify: `site/privacidade.html` (após a seção 4, antes da 5)
- Modify: `site/termos.html` (após a seção 6)
- Modify: `RUNBOOK.md` (nova seção antes de "Observabilidade")
- Modify: `README.md` (layout)

- [ ] **Step 1: `site/privacidade.html`**

Inserir antes de `<h2>5. Seus direitos e contato</h2>` (e renumerar a atual seção 5 para 6):

```html
      <h2>5. Estimativa por e-mail</h2>
      <p>Remetentes previamente autorizados podem enviar a matrícula e o carnê de IPTU para <a href="mailto:avm@heybrain.uk">avm@heybrain.uk</a> e receber a estimativa por resposta automática. Nesse canal o processamento <strong>não</strong> acontece no seu navegador:</p>
      <ul>
        <li><strong>O que é recebido:</strong> a mensagem e os anexos enviados a esse endereço.</li>
        <li><strong>Onde é processado:</strong> nos servidores da Cloudflare (Workers), em memória, durante o processamento daquela mensagem. O texto dos PDFs é extraído pelo serviço de conversão de documentos da Cloudflare (Workers AI). Nada é gravado: nem a mensagem, nem os anexos, nem o relatório.</li>
        <li><strong>O que sai:</strong> o endereço do imóvel, para o Nominatim (OpenStreetMap), como no site.</li>
        <li><strong>O que é registrado:</strong> linhas técnicas sem dados pessoais — resultado (relatório, recusa, faltou), quantidade de documentos e tempo de processamento — por sete dias.</li>
        <li><strong>Quem pode usar:</strong> só remetentes autorizados; mensagens de outros endereços são devolvidas sem que os anexos sejam abertos.</li>
      </ul>
      <p>Ao enviar, o remetente declara que se trata de apartamento residencial em compra e venda e aceita os <a href="/termos">termos de uso</a>. A resposta é uma estimativa estatística, não um laudo.</p>
```

- [ ] **Step 2: `site/termos.html`**

Inserir depois do parágrafo da seção 6 e antes de `<h2>7. Alterações e contato</h2>` (renumerar a 7 para 8):

```html
      <h2>7. Estimativa por e-mail</h2>
      <p>O envio de documentos para <a href="mailto:avm@heybrain.uk">avm@heybrain.uk</a>, por remetente autorizado, está sujeito a estes mesmos termos. Ao enviar, o remetente declara que o imóvel é apartamento residencial em operação de compra e venda e que tem autorização para compartilhar os documentos. A resposta automática tem a mesma natureza da estimativa do site — informativa, não é laudo — e pode ser uma recusa ou um pedido de documentos completos. O processamento é descrito na <a href="/privacidade">política de privacidade</a>.</p>
```

- [ ] **Step 3: `RUNBOOK.md` — seção "Estimativa por e-mail"**

Inserir antes de `## Observabilidade`:

```markdown
## Estimativa por e-mail (avm@heybrain.uk)

Handler `email()` em `src/worker.js`; pipeline em `src/email.js`; spec em `docs/superpowers/specs/2026-09-08-email-avm-design.md`.

**Ativar (uma vez, depois de privacidade e termos publicados):**
1. Remetentes autorizados: `npx wrangler secret put ALLOWED_SENDERS` e colar a lista separada por vírgulas — `@orgao.sp.gov.br` autoriza o domínio exato (sem subdomínios), `pessoa@empresa.com.br` autoriza o endereço. Sem espaços obrigatórios; maiúsculas não importam.
2. Regra de roteamento: Dashboard → Compute & AI → Email Service → Email Routing → `heybrain.uk` → Routing rules → Create address `avm` → Action **Send to a Worker** → `avm-sp`. (Equivalente: `npx wrangler email routing rules create --help`.)
3. Teste real: de um endereço que esteja na lista, mandar um e-mail com uma matrícula e um carnê digitais; a resposta chega na mesma conversa em menos de um minuto, com o `.xlsx`.

**Trocar remetentes:** repetir `wrangler secret put ALLOWED_SENDERS` com a lista nova (substitui a anterior; vale no próximo e-mail).

**Desligar o canal:** desabilitar a regra `avm` no dashboard. O Worker continua no ar para o site.

**Teste local:** `npx wrangler dev` (preview `wrangler-dev`) com `ALLOWED_SENDERS=@exemplo.gov.br` em `.dev.vars`, e `curl --request POST 'http://localhost:8787/cdn-cgi/local/email' --url-query 'from=teste@exemplo.gov.br' --url-query 'to=avm@heybrain.uk' --data-binary @teste.eml` (corpo RFC 5322 com `Message-ID`). O `send_email` é simulado no terminal; anexos binários não aparecem no simulador — o Excel é coberto por `tests/email.test.mjs`.

**Ler o que aconteceu:** Workers Logs, filtrar `event: email_*`. `email_rejected` (`reason`: unauthorized / ratelimit / too_large) não abre o e-mail; `email_processed` traz `outcome` (report / refused / missing / unreadable / ambiguous / error), `documents`, `unreadable`, `ms`; `email_send_failed` = resposta não saiu e o remetente recebeu bounce. Nenhuma linha traz endereço, arquivo ou valores. "Não recebi resposta" → procurar o `outcome`; se não há linha, o e-mail não chegou ao Worker (regra desligada ou MX).

**Limites:** 3 e-mails por minuto por remetente; 20 MB por mensagem; 6 anexos de até 10 MB; só PDF com camada de texto (escaneado → resposta "não lido" até a Entrega 2).
```

- [ ] **Step 4: `README.md`**

Na seção Layout, trocar a linha de `src/worker.js` por:
```markdown
- `src/worker.js` Worker: `POST /api/erro` e o handler `email()` da estimativa por e-mail (`src/email.js` é o pipeline; `site/assets/report.js` monta o relatório para site e e-mail)
```

- [ ] **Step 5: `npm run check` e revisão visual**

Run: `npm run check` → verde. Abrir `/privacidade` e `/termos` no preview `site-dev` e conferir numeração e links. Fechar o preview.

- [ ] **Step 6: Commit**

```bash
git add site/privacidade.html site/termos.html RUNBOOK.md README.md
git commit -m "Privacidade, termos e RUNBOOK do canal por e-mail (Entrega 1)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: PR da Entrega 1

**Files:** nenhum.

- [ ] **Step 1: Verificação final**

Run: `npm run check` (preview fechado) → verde; `git status` limpo; `git log --oneline origin/main..HEAD` mostra os commits das Tasks 2–8 mais os da spec.

- [ ] **Step 2: Abrir a PR (a #24, hoje em rascunho, passa a conter a implementação)**

```bash
git push -u origin email-avm
gh pr ready 24
gh pr edit 24 --title "AVM por e-mail — Entrega 1: matrícula + carnê (PDF com texto) → relatório por resposta automática" --body "$(cat <<'EOF'
Implementa a Entrega 1 da spec `docs/superpowers/specs/2026-09-08-email-avm-design.md` (plano em `docs/superpowers/plans/2026-09-08-email-avm-entrega-1.md`).

## O que muda
- `site/assets/report.js` (`AvmReport`): recusa, cálculo e montagem do relatório saem de `app.js`. Site e Worker geram o mesmo relatório e a mesma identificação. Comportamento do site inalterado.
- `src/email.js`: pipeline puro — `parseInbound` (postal-mime), texto por `env.AI.toMarkdown`, `readDocuments`/`buildInputs` com os extratores do site, bairro por Nominatim, `AvmReport` + `AVMExcel`, `compose` das respostas.
- `src/worker.js`: handler `email()` — lista de remetentes (`ALLOWED_SENDERS`, segredo), `EMAIL_RL` 3/min, teto de 20 MB, `send_email` na mesma conversa, `setReject` quando não dá para responder, logs sem dados pessoais.
- `wrangler.jsonc`: `send_email`, `ai`, `EMAIL_RL`, `EMAIL_FROM`, `limits.cpu_ms`.
- Privacidade e termos ganham a seção do canal; RUNBOOK explica ativar, testar, trocar remetentes e desligar.

## Verificação
- `npm run check` verde (lint com dry-run do bundle, validador, testes: report, email, worker, iptu-reader, paridade, limites).
- Handler exercitado localmente por `POST /cdn-cgi/local/email` no `wrangler dev`.

## Depois do merge (dono)
1. `npx wrangler secret put ALLOWED_SENDERS`
2. Regra `avm@heybrain.uk` → Worker `avm-sp` (Email Routing)
3. E-mail real de um remetente da lista com matrícula + carnê digitais.

Merge em `main` publica. Escaneados respondem "não lido" até a Entrega 2 (OCR).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Não mergear.** O dono decide (merge publica), cria o segredo e a regra, e faz o teste real do aceite 4.8.

---

## Self-review (feito ao escrever)

- **Cobertura da spec (seção 4):** 4.1 passos 1–3 → Task 7; 4 → Task 3; 5 → Task 6 (`extractTexts`); 6–8 → Task 4; 9 → Task 6 (`lookupDistrict`); 10–11 → Task 6; 12–13 → Task 7. 4.2 componentes → Tasks 2, 3, 7; segredo e regra → Task 8 (RUNBOOK) e Task 9 (PR). 4.3 → Task 2. 4.4 → Task 5. 4.5 → Tasks 6–7 (cada linha da tabela tem um caso de teste). 4.6 → Task 8. 4.7 → Tasks 2–7 (testes) e Task 7 passo 7 (local). 4.8 → Task 9 passo 3 (aceite real é do dono). Seção 7 (segurança): ordem das guardas, envelope, tetos, sem retenção, segredo, logs — Tasks 3, 6, 7.
- **Fora do plano, de propósito:** imagens como anexo (E2), OCR (E2), DEPLOY.md/manual/privacidade completa (E3).
- **Consistência de nomes:** `parseInbound`, `readDocuments`, `buildInputs`, `compose`, `processEmail`, `allowedSender`, `LIMITS`, `formatCep`, `model` — iguais nas Tasks 3–7 e nos testes. `documentSource` tem os mesmos campos do site pós-#23 (`fileName, method, addressFound, areaFound, areaLabel, ageFound, patternFound, fiscalFound, cepFromDocument, geocode`). `AvmReport.build(model, v, computed, now)` nas Tasks 2, 5 e 6.
