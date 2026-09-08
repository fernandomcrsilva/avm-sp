# AVM por e-mail — Entrega 2 (OCR via Workers AI) — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carnê ou matrícula **escaneados** (PDF sem camada de texto, ou imagem anexada) passam a ser lidos: a página vira imagem, um modelo de visão do Workers AI transcreve, e o texto cai nos **mesmos extratores** da Entrega 1 — o modelo nunca decide um campo.

**Architecture:** `src/ocr.js` (novo) extrai a imagem embutida de cada página com `unpdf`, reduz e codifica em PNG cinza sem biblioteca (deflate nativo), e chama o modelo de visão em paralelo por página. `src/email.js` ganha um passo `ocrPass` entre `readDocuments` e `buildInputs`: documentos ilegíveis ou incompletos ganham o texto transcrito e são reclassificados. `documentSource.method` carimba "OCR (Workers AI)" no relatório, no Excel e nos avisos. Nada é retido.

**Tech Stack:** Cloudflare Workers (Paid), Workers AI (`@cf/google/gemma-4-26b-a4b-it`; reserva `@cf/meta/llama-3.2-11b-vision-instruct`), `unpdf@1.8.1`, `CompressionStream("deflate")`, Node 22+ `node:test`, wrangler 4.128.

**Spec:** `docs/superpowers/specs/2026-09-08-email-avm-design.md` — seção 5 (Entrega 2), com as regras da seção 4 mantidas.

## Global Constraints

- Português-BR em tudo (código comentado, textos, commits, PR). Acentuação correta.
- Branch `email-ocr` a partir de `main` (que já contém a Entrega 1, #24). PR; `npm run check` verde antes de qualquer merge; merge em `main` **publica**. Nunca rodar `npm run build`/`check` com um `wrangler dev` **deste projeto** aberto.
- Não tocar: `site/assets/xlsx-export.js`, `site/_headers`/CSP, CSS, `train_model.py`. `site/assets/matricula-reader.js` só ganha **uma** linha de export (`isComplete`).
- Única dependência nova: `unpdf@1.8.1` em `dependencies` (exata). Sem `"remote": true` em bindings.
- Nada persistido; logs sem e-mail, nome de arquivo, endereço, SQL ou valores — o OCR só acrescenta o contador `ocr_pages`.
- O modelo **transcreve**; os campos continuam vindo de `AVMMatricula.extractFields`/`extractIptuFields`. Erro de transcrição vira "Faltou"/"Recusada"/"Não lido", nunca número inventado.
- Limites (spec 5.4): ≤ 4 páginas por documento, ≤ 8 páginas por e-mail (`LIMITS.maxOcrPagesPerDoc`, `LIMITS.maxOcrPagesPerEmail`); imagem anexada ≤ 5 MiB (`LIMITS.maxImageBytes`); PNG enviado ao modelo ≤ 4 MiB (`LIMITS.maxPngBytes`), lado maior ≤ 1600 px, cinza 8 bits; uma página em memória por vez; transcrições em paralelo.
- Cabeçalhos de saída inalterados (`Auto-Submitted` continua proibido). `limits.cpu_ms` já é 60000.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `src/ocr.js` (novo) | `crc32`, `toBase64`, `encodePng`, `pageImages`, `ocrPayload`, `transcribe`, `ocrDocument`. Puro: recebe `ai` injetado. |
| `src/email.js` (modificar) | Imagens voltam a `attachments`; `extractTexts` guarda `bytes`/`mimeType`; novo `ocrPass`; `processEmail` chama `ocrPass`; `LIMITS` novos. |
| `site/assets/matricula-reader.js` (modificar, 1 linha) | Exporta `isComplete(type, fields)` — a mesma regra de completude que decide o OCR no site. |
| `site/assets/report.js` (modificar) | `riskList` acrescenta o aviso de OCR quando `documentSource.method` cita OCR. |
| `tests/fixtures/pdf.mjs` (novo) | `scannedPdf()` — PDF mínimo com uma imagem `DeviceGray` embutida (página escaneada sintética). |
| `tests/ocr.test.mjs` (novo) | PNG válido (CRC, inflate, dimensões, cinza), redução, `pageImages`, `transcribe`/`ocrDocument` com `ai` falso. |
| `tests/email.test.mjs` (modificar) | Casos de OCR ponta a ponta. `tests/report.test.mjs` ganha o aviso. |
| `site/privacidade.html`, `RUNBOOK.md`, `README.md` (modificar) | Texto do OCR (imagem da página → Workers AI), limites, custo. |
| `package.json` (modificar) | `unpdf`. |

---

### Task 1: Preparar a branch e fazer o spike do formato de imagem (controlador)

**Files:** nenhum arquivo do repositório é alterado pelo spike (tudo no scratchpad).

**Por quê:** a página do modelo não documenta como passar imagem ao Gemma 4 pelo binding. O spike decide, em meia hora, o par `OCR_MODEL`/`ocrPayload` que a Task 3 transcreve. Precisa de `wrangler dev` com o binding `ai` (remoto) — ferramenta da sessão, por isso é do controlador.

- [ ] **Step 1: Branch**

```bash
git fetch origin && git checkout -q main && git pull -q --ff-only && git checkout -b email-ocr && npm ci && npm run check
```
Expected: `check` verde (44 testes).

- [ ] **Step 2: Imagem de teste com texto do carnê**

`$SCRATCH/ocr-spike/make-png.py` (Pillow do sistema, versão 12):

```python
# Gera uma "página escaneada" sintética: o texto do carnê renderizado em cinza, 1600 px de largura. Descartável.
from PIL import Image, ImageDraw, ImageFont
import sys
lines = [
    "PREFEITURA DO MUNICÍPIO DE SÃO PAULO - SECRETARIA MUNICIPAL DA FAZENDA",
    "NOTIFICAÇÃO DE LANÇAMENTO", "IMPOSTO PREDIAL E TERRITORIAL URBANO - IPTU 2026",
    "Número do Contribuinte: 042.115.0087-3",
    "Local do imóvel: R VERGUEIRO, 2650 AP 81 - VILA MARIANA - CEP 04109-002",
    "DADOS DO IMÓVEL",
    "Área do Terreno (m²): 62,50   Área Construída (m²): 98,00",
    "Ano da Construção Corrigido: 2018", "Tipo/Padrão: 2-C   Fator de Obsolescência: 0,90",
    "CÁLCULO DO IMPOSTO", "Valor do m² do Terreno (R$): 6.500,00", "Valor Venal do Imóvel (R$): 614.531,00",
]
img = Image.new("L", (1600, 1100), 255)
draw = ImageDraw.Draw(img)
font = ImageFont.load_default(size=34)
y = 60
for line in lines:
    draw.text((60, y), line, fill=20, font=font)
    y += 80
img.save(sys.argv[1])
print("ok", img.size)
```

Run: `python3 $SCRATCH/ocr-spike/make-png.py $SCRATCH/ocr-spike/carne.png`

- [ ] **Step 3: Worker descartável**

`$SCRATCH/ocr-spike/wrangler.jsonc`:
```jsonc
{ "name": "avm-ocr-spike", "main": "index.js", "compatibility_date": "2026-09-07", "ai": { "binding": "AI" } }
```

`$SCRATCH/ocr-spike/index.js`:
```js
// Spike: qual formato de imagem o binding aceita para o Gemma 4? POST com o PNG no corpo; ?variant=a|b|llama.
const SYSTEM = "Você é um OCR. Transcreva fielmente todo o texto da imagem, em português, preservando rótulos, números, pontuação e a ordem de leitura. Não resuma, não explique, não invente.";
const toBase64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(s); };
export default {
  async fetch(request, env) {
    const variant = new URL(request.url).searchParams.get("variant") || "a";
    const bytes = new Uint8Array(await request.arrayBuffer());
    const dataUri = `data:image/png;base64,${toBase64(bytes)}`;
    const user = "Transcreva esta página.";
    const payloads = {
      a: ["@cf/google/gemma-4-26b-a4b-it", { messages: [{ role: "system", content: SYSTEM }, { role: "user", content: [{ type: "text", text: user }, { type: "image_url", image_url: { url: dataUri } }] }], max_tokens: 4096, temperature: 0, chat_template_kwargs: { enable_thinking: false } }],
      b: ["@cf/google/gemma-4-26b-a4b-it", { messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }], image: dataUri, max_tokens: 4096, temperature: 0 }],
      llama: ["@cf/meta/llama-3.2-11b-vision-instruct", { messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }], image: dataUri, max_tokens: 4096 }],
    };
    const [model, input] = payloads[variant];
    const started = Date.now();
    try {
      const result = await env.AI.run(model, input);
      return Response.json({ variant, model, ms: Date.now() - started, keys: Object.keys(result || {}), result });
    } catch (error) {
      return Response.json({ variant, model, ms: Date.now() - started, error: String(error?.message || error) }, { status: 500 });
    }
  },
};
```

Em `.claude/launch.json`, acrescentar (temporariamente; remover ao fim do spike):
```json
{ "name": "ocr-spike", "runtimeExecutable": "npx", "runtimeArgs": ["wrangler", "dev", "--config", "<SCRATCH>/ocr-spike/wrangler.jsonc", "--port", "8799"], "port": 8799 }
```
(substituir `<SCRATCH>` pelo caminho absoluto do scratchpad). Abrir o preview `ocr-spike`.

- [ ] **Step 4: Rodar as variantes**

```bash
for v in a b llama; do echo "== $v"; curl -s -X POST "http://localhost:8799/?variant=$v" --data-binary @$SCRATCH/ocr-spike/carne.png -H 'Content-Type: application/octet-stream' | head -c 1500; echo; done
```

**Regra de decisão (registrar no ledger e no comentário de `src/ocr.js`):**
1. Se a variante **a** responde 200 e o texto devolvido contém `2018` e `6.500` (ou `6500`) → `OCR_MODEL = "@cf/google/gemma-4-26b-a4b-it"`, `ocrPayload` = variante **a**, e o campo de texto é o que aparecer em `keys` (`response` esperado).
2. Senão, se **b** passa nesse mesmo critério → Gemma 4 com `image` na raiz (variante **b**).
3. Senão → `OCR_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"`, variante **llama**. Se a resposta for erro de licença, o dono roda uma vez `curl …/ai/run/@cf/meta/llama-3.2-11b-vision-instruct -d '{"prompt":"agree"}'` com um token da conta (docs "Llama Vision Tutorial", passo 1) e o spike é repetido.
4. Anotar também o `ms` da variante escolhida e o tamanho do PNG: é o que dimensiona a espera por e-mail (≤ 8 páginas em paralelo ≈ um `ms`).

- [ ] **Step 5: Fechar o spike**

Parar o preview; remover a entrada `ocr-spike` de `.claude/launch.json` (`git diff` deve ficar vazio); o scratchpad pode ficar. Registrar no ledger: `Ruling: OCR_MODEL=<…>, payload=<a|b|llama>, campo=<response|…>, ms=<…>`.

---

### Task 1b: Calibrar os extratores com os documentos reais (Certidão de Dados Cadastrais e variantes de matrícula)

**Files:**
- Modify: `site/assets/matricula-reader.js` (`detectDocumentType`, `extractArea`, `extractIptuFields`)
- Modify: `tests/fixtures/textos.mjs` (fixtures novas, sem dados pessoais)
- Modify: `tests/iptu-reader.test.mjs`
- Modify: `src/email.js` (`buildInputs`: "carnê de IPTU" → "IPTU") e `tests/email.test.mjs` (as mesmas strings)

**Por quê:** os 10 casos reais mostraram que o documento de IPTU que circula em laudos é a **Certidão de Dados Cadastrais do Imóvel** (portal da PMSP), não o carnê: SQL em "Cadastro do Imóvel:", ano em "Ano da construção corrigido:", padrão em "Padrão da construção: 2-C", VM2T em "Valores de m² (R$): – da área incorporada: N". Na camada de texto do PDF as colunas saem embaralhadas e o valor vem colado **antes** do rótulo ("2022Ano da construção corrigido:", "122.004.0918-3Cadastro do Imóvel:"). Nas matrículas apareceram "41,06 m2 de área privativa" (valor antes) e "área de uso privativo de 118,73 m²". Sem isto, a E2 transcreveria certo e ainda responderia "Faltou".

**Interfaces:** as mesmas de hoje (`detectDocumentType(text)`, `extractFields(text)`, `extractIptuFields(text)`); só o alcance muda.

- [ ] **Step 1: Fixtures**

Acrescentar a `tests/fixtures/textos.mjs` (valores inventados; layout copiado do documento real):

```js
// Certidão de Dados Cadastrais do Imóvel (portal da PMSP) em ordem de leitura — é o que o OCR devolve.
export const CERTIDAO = `
PREFEITURA DE SÃO PAULO
Certidão de Dados Cadastrais do Imóvel - IPTU 2024
Cadastro do Imóvel: 123.456.0789-0
Local do Imóvel: R VERGUEIRO, 2650 AP 81   VILA MARIANA   CEP 04109-002
Dados cadastrais do terreno:
Área incorporada (m²): 1.200   Área não incorporada (m²): 0   Área total (m²): 1.200
Testada (m): 25,00   Fração ideal: 0,0250
Dados cadastrais da construção:
Área construída (m²): 98   Área ocupada pela construção (m²): 600
Ano da construção corrigido: 2018
Padrão da construção: 2-C   Uso: residência
Valores de m² (R$):
- da área incorporada: 6.500,00
- da área não incorporada: 0,00
- da construção: 2.361,00
Valores para fins de cálculo do IPTU (R$):
- da área incorporada: 195.000,00
- da área não incorporada: 0,00
- da construção: 231.378,00
`;

// A mesma certidão como a camada de texto do PDF a devolve: colunas embaralhadas e valor colado antes do rótulo.
export const CERTIDAO_EMBARALHADA = `
2.361,00- da construção:
Certidão de Dados Cadastrais do Imóvel - IPTU 2024
Valores de m² (R$):
123.456.0789-0Cadastro do Imóvel:
231.378,00- da construção:
0,00- da área não incorporada:
195.000,00- da área incorporada:
6.500,00- da área incorporada:
Dados cadastrais da construção:
Área construída (m²): Padrão da construção: 2-C
2018Ano da construção corrigido:
Local do Imóvel: R VERGUEIRO, 2650 AP 81 CEP 04109-002
`;
```

- [ ] **Step 2: Testes que falham**

Acrescentar a `tests/iptu-reader.test.mjs` (importar `CERTIDAO, CERTIDAO_EMBARALHADA` do fixture):

```js
test("certidão de dados cadastrais em ordem de leitura: SQL, ano, padrão e VM2T", () => {
  assert.equal(AVMMatricula.detectDocumentType(CERTIDAO), "iptu");
  const f = AVMMatricula.extractIptuFields(CERTIDAO);
  assert.equal(f.sql, "123.456.0789-0");
  assert.equal(f.yearBuilt, 2018);
  assert.equal(f.patternCode, 22);
  assert.equal(f.fiscal, 6500); // "Valores de m²" → "da área incorporada"; os 195.000 do bloco de cálculo não entram
  assert.equal(f.cep, "04109-002");
  assert.equal(f.address, "Rua Vergueiro, 2650");
});

test("certidão com camada de texto embaralhada: valor antes do rótulo, SQL colado, VM2T pela faixa plausível", () => {
  assert.equal(AVMMatricula.detectDocumentType(CERTIDAO_EMBARALHADA), "iptu");
  const f = AVMMatricula.extractIptuFields(CERTIDAO_EMBARALHADA);
  assert.equal(f.sql, "123.456.0789-0");
  assert.equal(f.yearBuilt, 2018);
  assert.equal(f.patternCode, 22);
  assert.equal(f.fiscal, 6500);
});

test("legenda 'Certidão de Dados Cadastrais do Imóvel' sozinha classifica como IPTU", () => {
  assert.equal(AVMMatricula.detectDocumentType("Figura 2 - Certidão de Dados Cadastrais do Imóvel"), "iptu");
});

test("matrícula: área privativa antes do rótulo, 'área de uso privativo' e rótulo com dois-pontos", () => {
  assert.equal(AVMMatricula.extractFields("consta na matrícula de 41,06 m2 de área privativa.").area, 41.06);
  assert.equal(AVMMatricula.extractFields("área de uso privativo de 118,73 m², área de uso comum de 35,89 m²").area, 118.73);
  assert.equal(AVMMatricula.extractFields("Área Privativa : 26,549 m² Área Comum : 10,910 m²").area, 26.549);
});
```

Em `tests/email.test.mjs`, trocar nas asserções as strings `"(esperado no carnê de IPTU)"` por `"(esperado no IPTU)"` e `"nenhum carnê de IPTU identificado entre os anexos"` por `"nenhum documento de IPTU identificado entre os anexos"` (todas as ocorrências).

- [ ] **Step 3: Rodar e ver falhar**

Run: `node --test tests/iptu-reader.test.mjs tests/email.test.mjs`
Expected: FAIL nos 4 testes novos (tipo "matricula", campos `null`) e nas strings de "Faltou".

- [ ] **Step 4: `site/assets/matricula-reader.js`**

a) `detectDocumentType` — marcadores da certidão:
```js
    const iptu = score([/NOTIFICACAO DE LANCAMENTO/, /IMPOSTO PREDIAL/, /CERTIDAO DE DADOS CADASTRAIS/], 3) + score([/\bIPTU\b/, /NUMERO DO CONTRIBUINTE/, /CADASTRO DO IMOVEL/, /VALOR VENAL/, /TIPO\s*\/\s*PADRAO/, /PADRAO DA CONSTRUCAO/], 1);
```

b) `extractArea` — rótulo antes **ou** depois do valor, e "uso privativo":
```js
    const label = "(?:(?:área\\s+)?(?:real\\s+)?privativa(?:\\s+(?:total|coberta|principal|da\\s+unidade))?|área\\s+de\\s+uso\\s+privativo)";
    const definitions = [
      ["Área privativa", 50, `${label}[^0-9]{0,55}(${NUMBER_PATTERN})\\s*${AREA_UNIT}(?![\\p{L}\\d])`],          // "área privativa de 78,00 m²"
      ["Área privativa", 50, `(${NUMBER_PATTERN})\\s*${AREA_UNIT}\\s+de\\s+${label}(?![\\p{L}])`],                  // "41,06 m2 de área privativa"
    ];
    const candidates = [];
    definitions.forEach(([label, priority, expression]) => {
      const regex = new RegExp(expression, "giu");
      ...
```
(o corpo do `forEach` continua igual: o número está sempre no grupo 1.)

c) `extractIptuFields` — certidão:
```js
    const year = Number(first(/ano\s+d[aeo]\s+constru[çc][ãa]o(?:\s+corrigido)?[^0-9]{0,15}((?:19|20)\d{2})\b/iu)
      || first(/((?:19|20)\d{2})\s*ano\s+d[aeo]\s+constru[çc][ãa]o(?:\s+corrigido)?/iu)); // camada de texto em colunas: valor antes do rótulo
```
```js
    // VM2T: carnê ("Valor do m² do Terreno"), certidão em ordem de leitura ("Valores de m² … da área incorporada") ou
    // certidão embaralhada (valor colado antes de "- da área incorporada:"); neste último caso só um valor na faixa
    // plausível de VM2T (100–60.000 R$/m²) serve — os totais do bloco de cálculo ficam de fora. ponytail: heurística
    // de faixa em vez de reconstruir as colunas; se a PGV mudar de ordem de grandeza, ajustar aqui.
    const money = `(${NUMBER_PATTERN})`;
    let fiscal = parsePtNumber(first(new RegExp(`valor\\s+(?:unit[áa]rio\\s+(?:do\\s+m\\s*[²2]?\\s+)?|do\\s+m\\s*[²2]?\\s+)d[eo]\\s+terreno[^0-9]{0,20}${money}`, "iu")))
      || parsePtNumber(first(new RegExp(`valores\\s+de\\s+m\\s*[²2]?[\\s\\S]{0,160}?da\\s+[áa]rea\\s+incorporada:?\\s*${money}`, "iu")));
    if (!fiscal && /valores\s+de\s+m/iu.test(flat)) {
      for (const match of flat.matchAll(new RegExp(`${money}\\s*-?\\s*da\\s+[áa]rea\\s+incorporada:`, "giu"))) {
        const value = parsePtNumber(match[1]);
        if (value >= 100 && value <= 60000) { fiscal = value; break; }
      }
    }
```
e o SQL sem exigir fronteira depois do dígito verificador (vem colado no rótulo na camada de texto):
```js
      sql: first(/(\d{3}\.\d{3}\.\d{4}-\d)(?!\d)/u),
```
Conferir que `CARNE` (E1) continua passando: o regex A é tentado primeiro.

- [ ] **Step 5: `src/email.js` — mensagens**

Em `buildInputs`, trocar `"(esperado no carnê de IPTU)"` por `"(esperado no IPTU)"` nas três mensagens e `"nenhum carnê de IPTU identificado entre os anexos"` por `"nenhum documento de IPTU identificado entre os anexos"`.

- [ ] **Step 6: Rodar tudo**

Run: `npm run check`
Expected: verde — 48 testes (44 + 4). Se o teste da certidão embaralhada falhar no VM2T com `195000`, a faixa não está sendo aplicada (o regex B pode ter casado "Valores de m²" seguido, 160 caracteres adiante, do "195.000,00- da área incorporada:"); nesse caso restringir o regex B a exigir `-\s*da\s+área\s+incorporada:?\s*${money}` **imediatamente** após um número **não** — ou seja, trocar `[\s\S]{0,160}?` por `[^0-9]{0,160}?` (nenhum dígito entre o rótulo "Valores de m²" e o valor).

- [ ] **Step 7: Conferir contra os documentos reais (controlador)**

Rodar o script de calibração (Node carregando `matricula-reader.js` sobre `testes/documentos_10_apartamentos/split/*.txt` e `testes/…/ocr_10_iptu.txt`): esperado — `ocr_10_iptu.txt` classificado `iptu` com SQL, ano 1973, padrão 2-C; `06_iptu.txt` com SQL e ano 2022 e padrão 2-C (VM2T pode continuar `null` na camada de texto embaralhada real — o OCR da E2 resolve); `04_matricula.txt` com área 41,06; `09_matricula.txt` com área 118,73. Registrar o resultado no ledger.

- [ ] **Step 8: Commit**

```bash
git add site/assets/matricula-reader.js tests/fixtures/textos.mjs tests/iptu-reader.test.mjs src/email.js tests/email.test.mjs
git commit -m "Leitores: Certidão de Dados Cadastrais do IPTU (SQL, ano, padrão, VM2T por 'Valores de m²') e variantes de área privativa

Calibrado com 10 casos reais (testes/, fora do git): valor antes do rótulo, SQL colado, colunas embaralhadas
na camada de texto, 'área de uso privativo'. Mensagens de 'Faltou' falam em IPTU (carnê ou certidão).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `src/ocr.js` — PNG cinza sem biblioteca e imagens das páginas (`unpdf`)

**Files:**
- Create: `src/ocr.js`
- Create: `tests/fixtures/pdf.mjs`
- Create: `tests/ocr.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `crc32(bytes: Uint8Array) → number`; `toBase64(bytes) → string`; `encodePng(image: { data, width, height, channels }, maxSide = 1600) → Promise<Uint8Array>` (PNG tipo de cor 0, 8 bits, reduzido por fator inteiro); `pageImages(pdfBytes: Uint8Array, maxPages = 4) → Promise<Array<{ data, width, height, channels, page }>>` (uma imagem por página — a maior —, páginas sem imagem puladas); `scannedPdf({ width = 8, height = 8, pages = 1 }) → Uint8Array` no fixture.

- [ ] **Step 1: Instalar `unpdf`**

```bash
npm install --save-exact unpdf@1.8.1
```
Expected: `package.json` → `"dependencies": { "postal-mime": "3.0.0", "unpdf": "1.8.1" }`.

- [ ] **Step 2: Fixture — PDF com imagem embutida**

`tests/fixtures/pdf.mjs`:
```js
// PDF mínimo "escaneado": cada página é só uma imagem DeviceGray 8 bits, sem filtro, com um gradiente
// horizontal (pixel x = x * 255 / (width - 1)). Bytes escritos à mão, como o mkpdf dos testes manuais da E1.
const latin1 = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

// strips > 1 divide a página em faixas horizontais (uma imagem por faixa, desenhadas de cima para baixo), como os
// escaneados "em tiras" do caso real 01 (12 imagens de 764×85 por página).
export function scannedPdf({ width = 8, height = 8, pages = 1, strips = 1 } = {}) {
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) pixels[y * width + x] = Math.round((x * 255) / Math.max(1, width - 1));
  const stripHeight = height / strips; // o teste usa altura divisível
  const objects = []; // Uint8Array por objeto, na ordem 1..n
  const pageIds = [];
  objects.push(latin1("<< /Type /Catalog /Pages 2 0 R >>"));
  objects.push(null); // 2: Pages, preenchido depois
  for (let p = 0; p < pages; p += 1) {
    const pageId = objects.length + 1, contentId = pageId + 1, firstImageId = pageId + 2;
    pageIds.push(pageId);
    const xobjects = Array.from({ length: strips }, (_, s) => `/Im${s} ${firstImageId + s} 0 R`).join(" ");
    objects.push(latin1(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${contentId} 0 R /Resources << /XObject << ${xobjects} >> >> >>`));
    // de cima para baixo: a faixa s ocupa y de (height - (s+1)·stripHeight) a (height - s·stripHeight)
    const content = Array.from({ length: strips }, (_, s) => `q ${width} 0 0 ${stripHeight} 0 ${height - (s + 1) * stripHeight} cm /Im${s} Do Q`).join(" ");
    objects.push(concat([latin1(`<< /Length ${content.length} >>\nstream\n`), latin1(content), latin1("\nendstream")]));
    for (let s = 0; s < strips; s += 1) {
      const slice = pixels.subarray(s * stripHeight * width, (s + 1) * stripHeight * width);
      objects.push(concat([latin1(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${stripHeight} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${slice.length} >>\nstream\n`), slice, latin1("\nendstream")]));
    }
  }
  objects[1] = latin1(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`);
  const parts = [latin1("%PDF-1.4\n")];
  const offsets = [];
  let position = parts[0].length;
  objects.forEach((body, index) => {
    offsets.push(position);
    const chunk = concat([latin1(`${index + 1} 0 obj\n`), body, latin1("\nendobj\n")]);
    parts.push(chunk);
    position += chunk.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`;
  parts.push(latin1(xref));
  return concat(parts);
}
```

- [ ] **Step 3: Escrever os testes que falham**

`tests/ocr.test.mjs`:
```js
// OCR da Entrega 2: PNG cinza gerado sem biblioteca (validado por inflate e CRC), imagens embutidas via unpdf,
// e a chamada ao modelo com `ai` falso. Rodar: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32, toBase64, encodePng, pageImages } from "../src/ocr.js";
import { scannedPdf } from "./fixtures/pdf.mjs";

const be32 = (bytes, at) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;

// Lê os chunks do PNG, confere cada CRC e devolve IHDR + IDAT concatenado.
function parsePng(png) {
  assert.deepEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "assinatura PNG");
  const chunks = [];
  let at = 8;
  while (at < png.length) {
    const length = be32(png, at);
    const type = String.fromCharCode(...png.slice(at + 4, at + 8));
    const data = png.slice(at + 8, at + 8 + length);
    const crc = be32(png, at + 8 + length);
    assert.equal(crc, crc32(png.slice(at + 4, at + 8 + length)), `CRC do chunk ${type}`);
    chunks.push({ type, data });
    at += 12 + length;
  }
  return chunks;
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

test("crc32 bate com o valor conhecido", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test("toBase64 em blocos é igual ao Buffer", () => {
  const bytes = Uint8Array.from({ length: 20000 }, (_, i) => (i * 31) & 255);
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString("base64"));
});

test("encodePng: cinza 8 bits, filtro 0, IDAT inflado com o tamanho certo, sem redução quando cabe", async () => {
  const width = 5, height = 3;
  const data = Uint8Array.from({ length: width * height }, (_, i) => (i * 17) & 255);
  const png = await encodePng({ data, width, height, channels: 1 });
  const chunks = parsePng(png);
  assert.deepEqual(chunks.map((c) => c.type), ["IHDR", "IDAT", "IEND"]);
  const ihdr = chunks[0].data;
  assert.equal(be32(ihdr, 0), width);
  assert.equal(be32(ihdr, 4), height);
  assert.deepEqual([...ihdr.slice(8, 13)], [8, 0, 0, 0, 0]); // 8 bits, cinza, deflate, filtro adaptativo, sem entrelace
  const raw = await inflate(chunks[1].data);
  assert.equal(raw.length, height * (width + 1));
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * (width + 1)], 0, "byte de filtro da linha");
    assert.deepEqual([...raw.slice(y * (width + 1) + 1, (y + 1) * (width + 1))], [...data.slice(y * width, (y + 1) * width)]);
  }
});

test("encodePng: RGB e RGBA viram cinza pela luminância", async () => {
  const rgb = await encodePng({ data: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]), width: 4, height: 1, channels: 3 });
  const rgba = await encodePng({ data: Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]), width: 4, height: 1, channels: 4 });
  for (const png of [rgb, rgba]) {
    const raw = await inflate(parsePng(png)[1].data);
    assert.deepEqual([...raw], [0, 76, 150, 29, 255]); // filtro 0 + luma de vermelho, verde, azul, branco (0,299/0,587/0,114)
  }
});

test("encodePng: reduz por fator inteiro até o lado maior caber em maxSide (média de bloco)", async () => {
  const width = 3200, height = 20;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data[y * width + x] = x % 2 ? 200 : 100; // pares de colunas 100/200 → média 150
  const png = await encodePng({ data, width, height, channels: 1 }, 1600);
  const chunks = parsePng(png);
  assert.equal(be32(chunks[0].data, 0), 1600);
  assert.equal(be32(chunks[0].data, 4), 10);
  const raw = await inflate(chunks[1].data);
  assert.equal(raw.length, 10 * 1601);
  assert.equal(raw[1], 150);
});

// pdf.js entrega DeviceGray 8 bits expandido (RGB ou RGBA); o gradiente é conferido pelo primeiro canal de cada pixel.
const firstChannelRow = (image, row = 0) => Array.from({ length: image.width }, (_, x) => image.data[(row * image.width + x) * image.channels]);
const GRADIENTE_8 = [0, 36, 73, 109, 146, 182, 219, 255];

test("pageImages: devolve a imagem embutida de cada página, no máximo maxPages", async () => {
  const one = await pageImages(scannedPdf({ width: 8, height: 8 }));
  assert.equal(one.length, 1);
  assert.equal(one[0].width, 8);
  assert.equal(one[0].height, 8);
  assert.ok([1, 3, 4].includes(one[0].channels), `canais: ${one[0].channels}`);
  assert.equal(one[0].page, 1);
  assert.deepEqual(firstChannelRow(one[0]), GRADIENTE_8);
  const three = await pageImages(scannedPdf({ pages: 3 }), 2);
  assert.deepEqual(three.map((i) => i.page), [1, 2]);
});

test("pageImages: página escaneada em faixas é remontada de cima para baixo", async () => {
  const [page] = await pageImages(scannedPdf({ width: 8, height: 8, strips: 4 }));
  assert.equal(page.width, 8);
  assert.equal(page.height, 8); // 4 faixas de 2 linhas empilhadas
  for (const row of [0, 3, 7]) assert.deepEqual(firstChannelRow(page, row), GRADIENTE_8);
});

test("pageImages: PDF inválido → lista vazia, sem lançar", async () => {
  assert.deepEqual(await pageImages(new TextEncoder().encode("%PDF-1.4 lixo")), []);
});
```

- [ ] **Step 4: Rodar e ver falhar**

Run: `node --test tests/ocr.test.mjs`
Expected: FAIL — `Cannot find module '../src/ocr.js'`.

- [ ] **Step 5: Criar `src/ocr.js` (parte 1)**

```js
// OCR da Entrega 2 (spec §5): a página escaneada vira PNG cinza e um modelo de visão do Workers AI transcreve o
// texto, que segue para os MESMOS extratores da matrícula e do carnê — o modelo nunca decide um campo.
// Puro: recebe `ai` injetado; nada é gravado. PNG escrito sem biblioteca (deflate nativo do runtime).
import { getDocumentProxy, extractImages } from "unpdf";

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// btoa em blocos: String.fromCharCode(...array) estoura a pilha em imagens de alguns MB.
export function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

const be32 = (value) => Uint8Array.of((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);

function chunk(type, data) {
  const typeBytes = Uint8Array.from(type, (c) => c.charCodeAt(0));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(12 + data.length);
  out.set(be32(data.length), 0);
  out.set(body, 4);
  out.set(be32(crc32(body)), 8 + data.length);
  return out;
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate")); // "deflate" = zlib, o que o PNG exige
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Reduz por fator inteiro (média de bloco) e converte a cinza (luminância); devolve PNG tipo de cor 0, 8 bits, filtro 0.
export async function encodePng({ data, width, height, channels }, maxSide = 1600) {
  const factor = Math.max(1, Math.ceil(Math.max(width, height) / maxSide));
  const outWidth = Math.floor(width / factor);
  const outHeight = Math.floor(height / factor);
  const gray = (index) => {
    if (channels === 1) return data[index];
    const at = index * channels;
    return 0.299 * data[at] + 0.587 * data[at + 1] + 0.114 * data[at + 2];
  };
  const raw = new Uint8Array(outHeight * (outWidth + 1)); // byte de filtro (0) + pixels, por linha
  const area = factor * factor;
  for (let y = 0; y < outHeight; y += 1) {
    const row = y * (outWidth + 1);
    raw[row] = 0;
    for (let x = 0; x < outWidth; x += 1) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy += 1) for (let dx = 0; dx < factor; dx += 1) sum += gray((y * factor + dy) * width + (x * factor + dx));
      raw[row + 1 + x] = Math.round(sum / area);
    }
  }
  const ihdr = new Uint8Array(13);
  ihdr.set(be32(outWidth), 0);
  ihdr.set(be32(outHeight), 4);
  ihdr.set([8, 0, 0, 0, 0], 8); // 8 bits, cinza, deflate, filtro adaptativo (linhas com 0), sem entrelace
  const idat = await deflate(raw);
  const signature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  const parts = [signature, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { png.set(part, offset); offset += part.length; }
  return png;
}

// Página escaneada "em faixas" (várias imagens da mesma largura, caso real 01): empilha na ordem dos operadores,
// que é de cima para baixo. Caso contrário, a maior imagem é a página.
function composePage(found) {
  const usable = found.filter((image) => image.data && image.width > 0 && image.height > 0);
  if (!usable.length) return null;
  const [first] = usable;
  if (usable.length > 1 && usable.every((image) => image.width === first.width && image.channels === first.channels)) {
    const height = usable.reduce((total, image) => total + image.height, 0);
    const data = new Uint8Array(first.width * height * first.channels);
    let offset = 0;
    for (const image of usable) {
      const length = image.width * image.height * image.channels;
      data.set(image.data.subarray(0, length), offset);
      offset += length;
    }
    return { data, width: first.width, height, channels: first.channels };
  }
  return usable.reduce((best, image) => (!best || image.width * image.height > best.width * best.height ? image : best), null);
}

// Uma imagem por página. Páginas sem imagem são puladas; PDF inválido devolve lista vazia (o chamador trata
// como "não lido").
export async function pageImages(pdfBytes, maxPages = 4) {
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(pdfBytes));
  } catch (_) {
    return [];
  }
  const images = [];
  const pageCount = Math.min(pdf.numPages, maxPages);
  for (let page = 1; page <= pageCount; page += 1) {
    try {
      const composed = composePage(await extractImages(pdf, page));
      if (composed) images.push({ ...composed, page });
    } catch (_) { /* página com imagem que o pdf.js não decodifica (ex.: JPX): pulada */ }
  }
  return images;
}
```

- [ ] **Step 6: Rodar e ver passar**

Run: `node --test tests/ocr.test.mjs`
Expected: 8 pass. O pdf.js entrega o `DeviceGray` de 8 bits expandido para RGB ou RGBA (`channels` 3 ou 4); os testes já aceitam 1, 3 ou 4 e conferem o gradiente pelo primeiro canal. `encodePng` converte qualquer canal para cinza.

- [ ] **Step 7: Lint e bundle**

Run: `npm run lint`
Expected: `lint ok`. O `wrangler deploy --dry-run` ainda não empacota `ocr.js` (ninguém o importa); verificar direto: `npx esbuild src/ocr.js --bundle --format=esm --platform=browser --outfile=$SCRATCH/ocr-bundle-check.js` → sem erro. Se o esbuild reclamar de módulos Node (`fs`, `path`, `canvas`) vindos do unpdf, acrescentar `"compatibility_flags": ["nodejs_compat"]` ao `wrangler.jsonc` e repetir com `--platform=node`; anotar no relatório.

- [ ] **Step 8: Commit**

```bash
git add src/ocr.js tests/ocr.test.mjs tests/fixtures/pdf.mjs package.json package-lock.json
git commit -m "OCR: PNG cinza sem biblioteca e imagens embutidas das páginas via unpdf

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `transcribe` e `ocrDocument` — a chamada ao modelo

**Files:**
- Modify: `src/ocr.js`
- Test: `tests/ocr.test.mjs`

**Interfaces:**
- Consumes: resultado do spike (Task 1): `OCR_MODEL`, variante de payload, nome do campo de texto na resposta.
- Produces: `OCR_MODEL`, `OCR_PROMPT`; `ocrPayload(dataUri) → objeto de entrada do modelo`; `transcribe(ai, { bytes, mimeType }) → Promise<string>`; `ocrDocument(ai, { bytes, mimeType }, { maxPages = 4, maxPngBytes = 4 MiB, maxImageBytes = 5 MiB }) → Promise<{ text: string, pages: number }>`.

- [ ] **Step 1: Escrever os testes que falham**

Acrescentar em `tests/ocr.test.mjs` (import também `ocrPayload, transcribe, ocrDocument, OCR_MODEL`):

```js
// O Gemma 4 pelo binding responde no formato OpenAI (spike da Task 1): o texto está em choices[0].message.content.
const respostaModelo = (text) => ({ choices: [{ finish_reason: "stop", index: 0, message: { role: "assistant", content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
function aiFalso(text = "Ano da Construção Corrigido: 2018") {
  const calls = [];
  return { calls, run: async (model, input) => { calls.push({ model, input }); return respostaModelo(text); } };
}

test("transcribe aceita também o formato { response } da reserva Llama", async () => {
  const ai = { run: async () => ({ response: "texto llama" }) };
  assert.equal(await transcribe(ai, { bytes: Uint8Array.of(1), mimeType: "image/png" }), "texto llama");
});

test("transcribe: manda a imagem como data URI no formato escolhido no spike e devolve o texto", async () => {
  const ai = aiFalso();
  const text = await transcribe(ai, { bytes: Uint8Array.of(137, 80, 78, 71), mimeType: "image/png" });
  assert.equal(text, "Ano da Construção Corrigido: 2018");
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].model, OCR_MODEL);
  assert.equal(JSON.stringify(ai.calls[0].input).includes("data:image/png;base64,iVBORw=="), true);
  assert.equal(JSON.stringify(ai.calls[0].input).includes("Transcreva"), true);
});

test("ocrDocument: PDF escaneado de 3 páginas → uma transcrição por página, em paralelo, até maxPages", async () => {
  const ai = aiFalso("linha");
  const out = await ocrDocument(ai, { bytes: scannedPdf({ pages: 3 }), mimeType: "application/pdf" }, { maxPages: 2 });
  assert.equal(out.pages, 2);
  assert.equal(ai.calls.length, 2);
  assert.equal(out.text, "linha\nlinha");
  for (const call of ai.calls) assert.equal(JSON.stringify(call.input).includes("data:image/png;base64,"), true);
});

test("ocrDocument: imagem anexada vai direto ao modelo, sem recodificar; acima do teto → vazio", async () => {
  const ai = aiFalso("texto da foto");
  const jpeg = Uint8Array.of(255, 216, 255, 224);
  const out = await ocrDocument(ai, { bytes: jpeg, mimeType: "image/jpeg" }, {});
  assert.deepEqual(out, { text: "texto da foto", pages: 1 });
  assert.equal(JSON.stringify(ai.calls[0].input).includes("data:image/jpeg;base64,/9j/4A=="), true);
  const grande = await ocrDocument(aiFalso(), { bytes: new Uint8Array(5 * 1024 * 1024 + 1), mimeType: "image/jpeg" }, {});
  assert.deepEqual(grande, { text: "", pages: 0 });
});

test("ocrDocument: falha do modelo numa página não derruba as outras; PDF sem imagem → vazio", async () => {
  let n = 0;
  const ai = { run: async () => { n += 1; if (n === 1) throw new Error("modelo indisponível"); return { response: `p${n}` }; } };
  const out = await ocrDocument(ai, { bytes: scannedPdf({ pages: 2 }), mimeType: "application/pdf" }, {});
  assert.equal(out.pages, 1);
  assert.equal(out.text, "p2");
  assert.deepEqual(await ocrDocument(aiFalso(), { bytes: new TextEncoder().encode("%PDF-1.4 lixo"), mimeType: "application/pdf" }, {}), { text: "", pages: 0 });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/ocr.test.mjs`
Expected: FAIL — `transcribe`/`ocrDocument`/`OCR_MODEL` não exportados.

- [ ] **Step 3: Implementar (parte 2 de `src/ocr.js`)**

Acrescentar ao fim de `src/ocr.js`. **Escolher o bloco `ocrPayload` conforme o spike** (o comentário registra a decisão; apagar as variantes não usadas):

```js
// Decisão do spike (Task 1, 2026-09-08): Gemma 4 com a imagem como parte `image_url` da mensagem (variante a) transcreveu
// corretamente o PNG sintético (3,5 s) e uma certidão real escaneada de 617×838 (8,5 s); a resposta vem no formato OpenAI
// (`choices[0].message.content`). `image` na raiz (variante b) fez o modelo ignorar a imagem. Reserva: Llama 3.2 Vision
// (`{ messages, image }`, texto em `response`, 11 s) — funciona, sem licença pendente.
export const OCR_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const OCR_PROMPT = "Você é um OCR. Transcreva fielmente todo o texto da imagem, em português, preservando rótulos, números, pontuação e a ordem de leitura. Não resuma, não explique, não invente.";
const USER_PROMPT = "Transcreva esta página.";

// Variante a (Gemma 4, imagem como parte da mensagem — formato OpenAI):
export function ocrPayload(dataUri) {
  return {
    messages: [
      { role: "system", content: OCR_PROMPT },
      { role: "user", content: [{ type: "text", text: USER_PROMPT }, { type: "image_url", image_url: { url: dataUri } }] },
    ],
    max_tokens: 4096,
    temperature: 0,
    chat_template_kwargs: { enable_thinking: false },
  };
}
// Variante b (Gemma 4, `image` na raiz) — usar SÓ se o spike escolheu b:
// export function ocrPayload(dataUri) {
//   return { messages: [{ role: "system", content: OCR_PROMPT }, { role: "user", content: USER_PROMPT }], image: dataUri, max_tokens: 4096, temperature: 0 };
// }
// Variante llama (reserva; OCR_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct") — usar SÓ se o spike escolheu llama:
// export function ocrPayload(dataUri) {
//   return { messages: [{ role: "system", content: OCR_PROMPT }, { role: "user", content: USER_PROMPT }], image: dataUri, max_tokens: 4096 };
// }

// Gemma 4 responde no formato OpenAI (choices[0].message.content); a reserva Llama, em `response`.
const responseText = (result) => (typeof result === "string" ? result : String(result?.choices?.[0]?.message?.content ?? result?.response ?? result?.result ?? result?.description ?? ""));

export async function transcribe(ai, { bytes, mimeType }) {
  const result = await ai.run(OCR_MODEL, ocrPayload(`data:${mimeType};base64,${toBase64(bytes)}`));
  return responseText(result).trim();
}

const MIB = 1024 * 1024;

// PDF: uma página por vez em memória (extrai → PNG → descarta os pixels), depois transcreve todas em paralelo.
// Imagem anexada: vai como está. Falha numa página não derruba as outras; nada legível → { text: "", pages: 0 }.
export async function ocrDocument(ai, { bytes, mimeType }, { maxPages = 4, maxPngBytes = 4 * MIB, maxImageBytes = 5 * MIB } = {}) {
  let images = [];
  if (mimeType === "application/pdf") {
    for (const image of await pageImages(bytes, maxPages)) {
      let png = await encodePng(image, 1600);
      for (let side = 1200; png.length > maxPngBytes && side >= 600; side -= 300) png = await encodePng(image, side); // página densa: reduz mais
      if (png.length <= maxPngBytes) images.push({ bytes: png, mimeType: "image/png" });
    }
  } else if (bytes.length <= maxImageBytes) {
    images = [{ bytes, mimeType }];
  }
  const texts = await Promise.all(images.map((image) => transcribe(ai, image).catch(() => null)));
  const ok = texts.filter((text) => text !== null);
  return { text: ok.join("\n"), pages: ok.length };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/ocr.test.mjs`
Expected: 13 pass (8 da parte 1 + 5).

- [ ] **Step 5: Commit**

```bash
git add src/ocr.js tests/ocr.test.mjs
git commit -m "OCR: transcrição por página com o modelo de visão do Workers AI (em paralelo, com tetos)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `ocrPass` no pipeline e o carimbo de OCR no relatório

**Files:**
- Modify: `site/assets/matricula-reader.js` (linha do `global.AVMMatricula = Object.freeze({...})`)
- Modify: `site/assets/report.js` (`riskList`)
- Modify: `src/email.js`
- Test: `tests/email.test.mjs`, `tests/report.test.mjs`

**Interfaces:**
- Consumes: `ocrDocument(ai, { bytes, mimeType }, limits)` (Task 3); `AVMMatricula.detectDocumentType/extractFields/extractIptuFields`; `READERS[type].complete(fields)` interno do reader.
- Produces: `AVMMatricula.isComplete(type, fields) → boolean`; `LIMITS.maxOcrPagesPerDoc = 4`, `LIMITS.maxOcrPagesPerEmail = 8`, `LIMITS.maxImageBytes = 5 MiB`, `LIMITS.maxPngBytes = 4 MiB`; `extractTexts` devolve `{ fileName, text, method, bytes, mimeType }`; `ocrPass(ai, texts, docs, log) → Promise<docs>`; `parseInbound` aceita `image/png|jpeg|webp` de novo (não `related`).

- [ ] **Step 1: Escrever os testes que falham**

Em `tests/report.test.mjs`, acrescentar:
```js
test("riskList avisa quando parte do texto veio de OCR", () => {
  const v = exemplo();
  v.documentSource.method = "texto do PDF + OCR (Workers AI)";
  const risks = AvmReport.riskList(v, null, []);
  assert.ok(risks.some((r) => r.includes("obtida por OCR (Workers AI)")));
  assert.equal(AvmReport.riskList(exemplo(), null, []).some((r) => r.includes("OCR")), false);
});
```

Em `tests/email.test.mjs`, acrescentar (import também `scannedPdf` de `./fixtures/pdf.mjs`; os anexos escaneados usam bytes do fixture):
```js
// OCR (Entrega 2): toMarkdown não vê texto no PDF escaneado; ai.run devolve a transcrição pelo nome do "documento".
const OCR_TEXTS = { carne: CARNE, matricula: MATRICULA, ruido: "kj3h4 kjh34 kjh 3k4jh" };
function aiComOcr(transcricao) {
  const runs = [];
  return {
    runs,
    toMarkdown: async (docs) => docs.map((doc) => ({ name: doc.name, data: TEXTOS[doc.name] ?? "" })), // PDFs escaneados não estão em TEXTOS → ""
    run: async (model, input) => { runs.push({ model, input }); return { choices: [{ message: { content: transcricao(runs.length) } }] }; }, // formato OpenAI do Gemma 4
  };
}
const escaneado = (nome, pages = 1) => [nome, "application/pdf", scannedPdf({ pages })];

test("OCR: carnê escaneado + matrícula digital → relatório com método OCR, aviso e ocr_pages", async () => {
  const ai = aiComOcr(() => OCR_TEXTS.carne);
  const out = await processEmail({ raw: raw({ attachments: [escaneado("iptu-scan.pdf"), ["matricula.pdf", "application/pdf", "%PDF-1.4 m"]] }), subject: "x" }, { ...deps, ai });
  assert.equal(out.outcome, "report", out.reply.text);
  assert.equal(ai.runs.length, 1);
  assert.ok(norm(out.reply.text).includes("Documentos lidos: iptu-scan.pdf + matricula.pdf — OCR (Workers AI) e texto do PDF."));
  assert.ok(out.reply.text.includes("obtida por OCR (Workers AI)"));
  assert.deepEqual(out.log, { documents: 2, unreadable: 0, ocr_pages: 1 });
});

test("OCR: texto do PDF incompleto → OCR completa e o método vira 'texto do PDF + OCR (Workers AI)'", async () => {
  // toMarkdown devolve só o cabeçalho do carnê (sem ano/padrão/VM2T); o OCR traz o resto.
  const parcial = { ...TEXTOS, "iptu-parcial.pdf": CARNE.split("DADOS DO IMÓVEL")[0] + " ".repeat(200) };
  const ai = { toMarkdown: async (docs) => docs.map((doc) => ({ name: doc.name, data: parcial[doc.name] ?? "" })), run: async () => ({ choices: [{ message: { content: CARNE } }] }) };
  const out = await processEmail({ raw: raw({ attachments: [["iptu-parcial.pdf", "application/pdf", scannedPdf()], ["matricula.pdf", "application/pdf", "%PDF-1.4 m"]] }), subject: "x" }, { ...deps, ai });
  assert.equal(out.outcome, "report", out.reply.text);
  assert.ok(norm(out.reply.text).includes("texto do PDF + OCR (Workers AI)"));
});

test("OCR: imagem anexada (jpeg) é transcrita direto; ruído vira 'Faltou', nunca número inventado", async () => {
  const ai = aiComOcr((n) => (n === 1 ? OCR_TEXTS.matricula : OCR_TEXTS.carne));
  const ok = await processEmail({ raw: raw({ attachments: [["matricula.jpg", "image/jpeg", "\xff\xd8\xff\xe0"], escaneado("iptu-scan.pdf")] }), subject: "x" }, { ...deps, ai });
  assert.equal(ok.outcome, "report", ok.reply.text);
  assert.equal(ok.log.ocr_pages, 2);
  assert.ok(JSON.stringify(ai.runs[0].input).includes("data:image/jpeg;base64,"));
  const ruim = await processEmail({ raw: raw({ attachments: [escaneado("iptu-scan.pdf"), ["matricula.pdf", "application/pdf", "%PDF-1.4 m"]] }), subject: "x" }, { ...deps, ai: aiComOcr(() => OCR_TEXTS.ruido) });
  assert.equal(ruim.outcome, "missing");
  assert.ok(ruim.reply.text.includes("ano de construção (esperado no carnê de IPTU)"));
});

test("OCR: teto de 8 páginas por e-mail e 4 por documento", async () => {
  const ai = aiComOcr(() => OCR_TEXTS.ruido);
  const out = await processEmail({ raw: raw({ attachments: [escaneado("a.pdf", 6), escaneado("b.pdf", 6), escaneado("c.pdf", 6)] }), subject: "x" }, { ...deps, ai });
  assert.equal(ai.runs.length, 8); // 4 + 4 + 0
  assert.equal(out.log.ocr_pages, 8);
});

test("OCR: sem imagem nenhuma no PDF → continua 'não lido', sem chamar o modelo", async () => {
  const ai = aiComOcr(() => OCR_TEXTS.carne);
  const out = await processEmail({ raw: raw({ attachments: [["vazio.pdf", "application/pdf", "%PDF-1.4 sem imagem"]] }), subject: "x" }, { ...deps, ai });
  assert.equal(out.outcome, "unreadable");
  assert.equal(ai.runs.length, 0);
});
```
E ajustar o teste antigo de `parseInbound` da Entrega 1: `foto.jpg` volta para `attachments` (`["foto.jpg", "image/jpeg"]`), `image001.png` inline continua em `ignored` só se for `related` — como o `mime()` não aninha `multipart/related`, **remover** `image001.png` desse teste e mantê-lo em `ignored` apenas `planilha.xlsx`; acrescentar um caso explícito: um anexo `image/png` normal vai para `attachments`.

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/report.test.mjs tests/email.test.mjs`
Expected: FAIL — aviso de OCR ausente; `foto.jpg` em `ignored`; escaneados voltam "unreadable" sem OCR.

- [ ] **Step 3: `matricula-reader.js` — uma linha**

Trocar
```js
  global.AVMMatricula = Object.freeze({ detectDocumentType, extractFields, extractIptuFields, parsePtNumber, read, resolveAssetUrl });
```
por
```js
  const isComplete = (type, fields) => Boolean(fields) && READERS[type].complete(fields); // a mesma regra que decide o OCR no site e no Worker
  global.AVMMatricula = Object.freeze({ detectDocumentType, extractFields, extractIptuFields, isComplete, parsePtNumber, read, resolveAssetUrl });
```

- [ ] **Step 4: `report.js` — aviso de OCR**

Em `riskList`, dentro do `if (v.documentSource) { ... }`, depois do `push` existente:
```js
      if (/OCR/.test(s.method || "")) risks.push("Parte do texto dos documentos foi obtida por OCR (Workers AI) e deve ser conferida no documento original antes de qualquer uso.");
```

- [ ] **Step 5: `src/email.js`**

a) Import e limites:
```js
import { ocrDocument } from "./ocr.js";
```
```js
export const LIMITS = Object.freeze({
  maxAttachments: 6,
  maxAttachmentBytes: 10 * 1024 * 1024,
  minTextChars: 200,
  maxTextChars: 200_000,
  maxOcrPagesPerDoc: 4,      // como o site (MAX_OCR_PAGES)
  maxOcrPagesPerEmail: 8,    // spec 5.4: ≤ 8 chamadas ao modelo por e-mail
  maxImageBytes: 5 * 1024 * 1024,
  maxPngBytes: 4 * 1024 * 1024,
});
```

b) `attachmentType` volta a aceitar imagens (o `related` continua indo para `ignored` em `parseInbound`):
```js
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]); // fotos e escaneados avulsos: vão direto ao OCR
function attachmentType(att) {
  const name = String(att.filename || "").toLocaleLowerCase("pt-BR");
  const type = String(att.mimeType || "").toLocaleLowerCase("pt-BR").split(";")[0].trim();
  if (type === PDF_TYPE || name.endsWith(".pdf")) return PDF_TYPE;
  if (IMAGE_TYPES.has(type)) return type;
  return null;
}
```

c) `extractTexts` guarda os bytes para o OCR e marca imagens:
```js
    if (att.mimeType !== PDF_TYPE) { texts.push({ fileName: att.fileName, text: "", method: "imagem", bytes: att.bytes, mimeType: att.mimeType }); continue; }
    ...
    texts.push({ fileName: att.fileName, text, method: "texto do PDF", bytes: att.bytes, mimeType: PDF_TYPE });
```

d) Novo passo, depois de `readDocuments` (e antes de `processEmail`):
```js
// Segunda passada: documento ilegível ou incompleto ganha a transcrição das páginas (OCR) e é reclassificado.
// O modelo só produz texto; os campos continuam vindo dos extratores. Orçamento: 4 páginas por documento, 8 por e-mail.
export async function ocrPass(ai, texts, docs, log) {
  const { isComplete } = globalThis.AVMMatricula;
  let budget = LIMITS.maxOcrPagesPerEmail;
  const out = [...docs];
  for (let i = 0; i < docs.length && budget > 0; i += 1) {
    const doc = docs[i];
    const source = texts[i];
    if (!doc.unreadable && isComplete(doc.type, doc.fields)) continue;
    if (!source.bytes) continue;
    const { text, pages } = await ocrDocument(ai, { bytes: source.bytes, mimeType: source.mimeType }, { maxPages: Math.min(LIMITS.maxOcrPagesPerDoc, budget), maxPngBytes: LIMITS.maxPngBytes, maxImageBytes: LIMITS.maxImageBytes });
    budget -= pages;
    log.ocr_pages += pages;
    if (!text) continue;
    const merged = source.text.trim() ? `${source.text}\n${text}` : text;
    const method = source.text.trim() && source.method === "texto do PDF" ? "texto do PDF + OCR (Workers AI)" : "OCR (Workers AI)";
    [out[i]] = readDocuments([{ fileName: doc.fileName, text: merged, method }]).docs;
  }
  return out;
}
```
(`ocrDocument` já paraleliza as páginas de um documento; documentos são processados em sequência para respeitar o orçamento.)

e) `processEmail`: trocar o trecho
```js
  const texts = await extractTexts(deps.ai, inbound.attachments);
  const { docs, ambiguous } = readDocuments(texts);
  const unreadable = docs.filter((d) => d.unreadable).map((d) => d.fileName);
  const log = { documents: docs.length, unreadable: unreadable.length, ocr_pages: 0 };
```
por
```js
  const texts = await extractTexts(deps.ai, inbound.attachments);
  const log = { documents: texts.length, unreadable: 0, ocr_pages: 0 };
  const first = readDocuments(texts);
  const docs = await ocrPass(deps.ai, texts, first.docs, log);
  const ambiguous = readDocuments(docs.map((d, i) => ({ fileName: d.fileName, text: "", method: d.method }))).ambiguous; // placeholder — ver nota
  const unreadable = docs.filter((d) => d.unreadable).map((d) => d.fileName);
  log.unreadable = unreadable.length;
```
**Nota:** a linha do `ambiguous` acima é um placeholder proibido — a ambiguidade tem de ser recalculada a partir dos `docs` reclassificados, não do texto vazio. Implementar assim: extrair de `readDocuments` a regra de ambiguidade para uma função exportada `ambiguityOf(docs)` (`readable = docs.filter((d) => !d.unreadable)`; mais de uma matrícula → "matricula"; mais de um carnê → "iptu"; senão `null`) e usá-la tanto em `readDocuments` quanto aqui: `const ambiguous = ambiguityOf(docs);`. Apagar a linha placeholder.

f) `method` das imagens: quando o OCR não conseguiu nada, o documento fica `unreadable` com `method: "imagem"`; o `compose` já cita "(sem camada de texto)" — trocar essa frase em `unreadableLine` para "(sem texto legível)", que vale para PDF e imagem.

- [ ] **Step 6: Rodar e ver passar**

Run: `node --test tests/report.test.mjs tests/email.test.mjs tests/ocr.test.mjs tests/iptu-reader.test.mjs`
Expected: todos verdes (report 4, email 24, ocr 11, iptu-reader 6). Ajustes prováveis: o teste E1 "processEmail: … sem texto → não lido" usa `vazio.pdf` com bytes `%PDF-1.4 vazio.pdf` — sem imagem, `pageImages` devolve `[]`, sem chamada ao modelo → continua "unreadable" ✓. O teste E1 "compose: … não lido" compara "(sem camada de texto)" — atualizar para "(sem texto legível)".

- [ ] **Step 7: `npm run check`**

Expected: verde; `lint ok` prova que o dry-run empacota `unpdf` via `worker.js → email.js → ocr.js`. Se falhar por módulo Node do unpdf, aplicar o `nodejs_compat` (Task 2, passo 7) e anotar.

- [ ] **Step 8: Commit**

```bash
git add site/assets/matricula-reader.js site/assets/report.js src/email.js tests/email.test.mjs tests/report.test.mjs
git commit -m "E-mail: OCR para escaneados e imagens — segunda passada com o modelo de visão, mesmos extratores, aviso no relatório

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Privacidade, RUNBOOK e README

**Files:**
- Modify: `site/privacidade.html` (seção "5. Estimativa por e-mail")
- Modify: `RUNBOOK.md` (seção "Estimativa por e-mail")
- Modify: `README.md`

- [ ] **Step 1: `site/privacidade.html`**

Na lista da seção 5, trocar o item **Onde é processado** por:
```html
        <li><strong>Onde é processado:</strong> nos servidores da Cloudflare (Workers), em memória, durante o processamento daquela mensagem. O texto dos PDFs é extraído pelo serviço de conversão de documentos da Cloudflare (Workers AI). Páginas escaneadas e imagens são transcritas por um modelo de visão do Workers AI, também da Cloudflare, que recebe a imagem da página e devolve o texto; o serviço não retém a imagem. Nada é gravado: nem a mensagem, nem os anexos, nem o relatório.</li>
```
e trocar o item **O que sai** por:
```html
        <li><strong>O que sai:</strong> o endereço do imóvel, para o Nominatim (OpenStreetMap), como no site. Nenhum dado vai a serviços fora da Cloudflare e da OpenStreetMap Foundation.</li>
```
Acrescentar, após a lista, antes do parágrafo "Ao enviar…":
```html
      <p>Quando há OCR, o relatório e a resposta avisam que parte do texto foi transcrita automaticamente e deve ser conferida no documento original. A resposta pode levar até dois minutos nesse caso.</p>
```

- [ ] **Step 2: `RUNBOOK.md`**

Na seção "Estimativa por e-mail", trocar a linha de **Limites** por:
```markdown
**Limites:** 3 e-mails por minuto por remetente; 20 MB por mensagem; 6 anexos de até 10 MB (PDF, PNG, JPEG ou WebP). PDF com camada de texto é lido direto; escaneado ou imagem passa por OCR no Workers AI (até 4 páginas por documento e 8 por e-mail, ~1–2 min de resposta). Custo do OCR: da ordem de US$ 0,002 por página no Gemma 4 — acompanhar em Compute & AI → Workers AI no dashboard.
```
Acrescentar a **Ler o que aconteceu**: "`ocr_pages` > 0 indica que houve transcrição; `unreadable` conta documentos que nem o OCR leu."

- [ ] **Step 3: `README.md`**

Na linha do `src/worker.js` do Layout, acrescentar `src/ocr.js` à lista entre parênteses: "(`src/email.js` é o pipeline, `src/ocr.js` o OCR via Workers AI; `site/assets/report.js` monta o relatório para site e e-mail)".

- [ ] **Step 4: `npm run check` e revisão visual**

Verde. Conferir `/privacidade` no preview `site-dev` (controlador). Fechar o preview.

- [ ] **Step 5: Commit**

```bash
git add site/privacidade.html RUNBOOK.md README.md
git commit -m "Privacidade e RUNBOOK: OCR de escaneados via Workers AI (Entrega 2)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Teste real do OCR e PR (controlador)

- [ ] **Step 1: Teste local com o modelo de verdade**

Com o preview `wrangler-dev` deste projeto aberto (o binding `ai` é remoto mesmo em dev; sem `npm run build` ao mesmo tempo) e `.dev.vars` com `ALLOWED_SENDERS=@exemplo.gov.br`, montar um `.eml` com **o PNG do spike** (`carne.png`) como anexo `image/png` mais a matrícula sintética em PDF com texto (o `mkpdf.py` da Entrega 1 gera `matricula-teste.pdf`; se não existir mais no scratchpad, recriar com aquele script) e disparar:

```bash
curl --request POST 'http://localhost:8787/cdn-cgi/local/email' --url-query 'from=teste@exemplo.gov.br' --url-query 'to=avm@heybrain.uk' --data-binary @$SCRATCH/teste-ocr.eml
```
Expected: log `email_processed` com `outcome:"report"` e `ocr_pages:1`; no terminal do wrangler, `send_email binding called` e o arquivo de texto da resposta com "OCR (Workers AI)" em "Documentos lidos" e o aviso de OCR. Se o modelo transcrever mal o PNG sintético (fonte pequena), aumentar `size=` no `make-png.py` para 44 e repetir — o objetivo aqui é o caminho, não a acurácia.

- [ ] **Step 2: PR**

```bash
git push -u origin email-ocr
gh pr create --title "AVM por e-mail — Entrega 2: OCR de escaneados e imagens via Workers AI" --body "$(cat <<'EOF'
Implementa a Entrega 2 da spec `docs/superpowers/specs/2026-09-08-email-avm-design.md` (plano em `docs/superpowers/plans/2026-09-08-email-avm-entrega-2.md`).

## O que muda
- `src/ocr.js`: página escaneada → imagem embutida (`unpdf`) → PNG cinza ≤ 1600 px (sem biblioteca) → modelo de visão do Workers AI transcreve, páginas em paralelo, tetos de 4/documento e 8/e-mail. Imagens anexadas vão direto ao modelo.
- `src/email.js`: segunda passada `ocrPass` para documentos ilegíveis ou incompletos; o texto transcrito cai nos **mesmos extratores** — o modelo não decide campo. `method` vira "OCR (Workers AI)" / "texto do PDF + OCR (Workers AI)".
- `site/assets/report.js`: aviso de OCR nos riscos (relatório, Excel e e-mail). `matricula-reader.js`: exporta `isComplete` (uma linha).
- Privacidade, RUNBOOK e README atualizados.

## Spike
Formato de imagem confirmado com o binding: <modelo / variante / campo / ms> (ver comentário em `src/ocr.js`).

## Verificação
- `npm run check` verde (<N> testes; novos: PNG validado por inflate e CRC, `pageImages` em PDF sintético, `ocrDocument`, casos ponta a ponta com `ai.run` falso).
- Teste local com o modelo real (`wrangler dev` + `/cdn-cgi/local/email`): PNG com o texto do carnê → relatório com `ocr_pages:1`.

## Aceite (dono)
Carnê escaneado real de `testes/` + matrícula digital → relatório com os quatro campos e método OCR; custo por e-mail no dashboard do Workers AI < US$ 0,02.

Merge em `main` publica.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Não mergear.** O aceite da spec 5.6 exige carnê escaneado real em `testes/`; o dono decide.

---

## Self-review (feito ao escrever)

- **Cobertura da spec §5:** 5.1 gatilho (ilegível **ou** incompleto; imagens direto) → Task 4 `ocrPass` + `attachmentType`; 5.2 componentes (`pageImages`, `encodePng`, `transcribe`, `method`) → Tasks 2–4; 5.3 modelo + spike com regra de decisão e reserva → Tasks 1 e 3; 5.4 limites (4/8 páginas, PNG ≤ 4 MiB, paralelo, custo) → `LIMITS` e `ocrDocument`; texto transcrito só passa pelos extratores → `ocrPass`; carimbo no relatório → `riskList` + `method`; 5.5 testes (PNG por inflate/CRC, redução, PDF sintético com XObject, `email.test` com `ai.run` falso) → Tasks 2–4; 5.6 aceite → Task 6 passo 3 (dono). Privacidade da E2 (spec 4.6 "na entrega 2…") → Task 5.
- **Placeholders:** o único trecho marcado como placeholder (Task 4, passo 5e) traz em seguida a instrução exata que o substitui (`ambiguityOf`); a Task 3 mantém as três variantes de `ocrPayload` como código comentado para o implementador apagar as não escolhidas — a escolha vem do spike da Task 1 com regra de decisão fechada.
- **Consistência:** `ocrDocument(ai, { bytes, mimeType }, { maxPages, maxPngBytes, maxImageBytes })` igual nas Tasks 3 e 4; `pageImages(bytes, maxPages)` devolve `{ data, width, height, channels, page }` em Tasks 2 e 3; `scannedPdf({ width, height, pages })` em Tasks 2–4; `LIMITS` novos nomeados uma vez e usados em `ocrPass`; `AVMMatricula.isComplete(type, fields)` definido na Task 4 passo 3 e consumido no passo 5d.
- **Memória do Worker:** `ocrDocument` codifica uma página por vez e só guarda os PNGs (≤ 4 MiB cada, ≤ 4 por documento) antes da paralelização — cabe nos 128 MB.
