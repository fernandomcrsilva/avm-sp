# AVM por e-mail — Entrega 3 (privacidade, documentação, manual) — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar o canal por e-mail para quem **opera** e para quem **envia**: privacidade e termos dizem exatamente o que é processado e o que a Cloudflare retém; `DEPLOY.md` e `RUNBOOK.md` permitem a outra pessoa ativar, testar e desligar o canal sem perguntar nada; o manual ganha o capítulo "Envio por e-mail" e volta publicado em `/manual`. O pipeline não muda.

**Architecture:** Só documentação, mais dois ajustes pequenos que a documentação exige para ser verdadeira: `wrangler.jsonc` desliga os **logs de invocação** (o registro automático de um evento de e-mail carrega o envelope — remetente e destinatário — e a privacidade promete linhas sem dados pessoais), e um script gera o `.eml` do teste local a partir dos fixtures sintéticos (o RUNBOOK cita um `teste.eml` que não existe no repositório). O manual é regenerado com o WeasyPrint, como `scripts/render-manual.sh` já faz — verificado nesta máquina em 2026-09-08 (venv de rascunho via `uv`; reproduz as 10 páginas atuais).

**Tech Stack:** Markdown/HTML estático; WeasyPrint 70 (venv fora do repositório), poppler `pdftoppm`, Pillow do sistema; `unpdf@1.8.1` (já em `dependencies`) para ler PDF nos testes; Node 22 `node:test`; wrangler 4.128 (`deploy --dry-run` valida o `wrangler.jsonc`).

**Spec:** `docs/superpowers/specs/2026-09-08-email-avm-design.md` — seção 6 (Entrega 3), com 4.6 (privacidade), 7 (segurança) e 8 (custo) como fontes dos textos.

## Global Constraints

- Português-BR em tudo (textos, comentários, commits, PR), com acentuação correta.
- Branch `email-docs` a partir de `main` (que já contém as Entregas 1 e 2, PRs #24 e #25). PR; `npm run check` verde antes de qualquer merge; merge em `main` **publica**. Nunca rodar `npm run build`/`check` com um `wrangler dev` **deste projeto** aberto.
- **Nenhuma dependência nova no repositório.** O WeasyPrint vive só num venv de rascunho fora do repositório; `unpdf` e `postal-mime` já existem. `package.json` muda só o glob do `lint`.
- Não tocar: `src/email.js`, `src/ocr.js`, `src/worker.js`, `site/assets/*.js`, `site/_headers` (CSP), `site/assets/styles.css`, `train_model.py`, `site/index.html`.
- Nada de `testes/` (dados pessoais de terceiros) em texto, exemplo, fixture, imagem ou commit. Exemplos só com os fixtures sintéticos de `tests/fixtures/textos.mjs` (Rua Vergueiro 2650, ap. 81, contribuinte 042.115.0087-3 — fictícios).
- Nunca escrever o valor de `ALLOWED_SENDERS` em lugar nenhum; só o comando `npx wrangler secret put ALLOWED_SENDERS`.
- Os textos afirmam o que a Cloudflare faz **conforme a documentação verificada** (tabela abaixo). Sem juridiquês; a base legal (LGPD) é do dono, não do texto.
- Mensagens de erro citadas no manual são as **literais** de `src/email.js` e `src/worker.js` (listadas na Task 5). Não parafrasear.
- O manual continua "Versão 7 · Setembro de 2026"; o arquivo continua `site/manual-avm-sp-v7.pdf` (é o link do botão de download e o nome que o usuário conhece).
- Documento de IPTU: nos textos, "documento de IPTU (carnê ou Certidão de Dados Cadastrais do Imóvel)" — os casos reais mostraram que o que circula é a Certidão, não o carnê.

## Fatos verificados em 2026-09-08 (base dos textos)

| Fato | Fonte | Consequência |
|---|---|---|
| O **log de invocação** automático de um evento de e-mail tem como mensagem o destinatário e carrega o envelope (`mailFrom`, `rcptTo`, `rawSize` — `TraceItemEmailEventInfo`); pode ser desligado com `observability.logs.invocation_logs = false` sem perder os `console.log` próprios | docs Workers → Observability → Workers Logs, "Invocation Logs" | Desligar: a privacidade promete "linhas técnicas sem dados pessoais" e o RUNBOOK deixa de pedir ao dono para "conferir a linha de invocação" |
| Workers Logs retém **7 dias** no plano Paid | idem | `DEPLOY.md` ainda diz "3 dias no Free" — corrigir |
| O **Activity log** do Email Service guarda, por mensagem recebida (Routing) e enviada (Sending), remetente, destinatário, assunto, message ID, decisão e situação da entrega, **sem o conteúdo**; consultável por **31 dias**; não é desligável | docs Email Service → Observability → Logs e Metrics ("retained for the past 31 days") | Privacidade declara; RUNBOOK usa como primeira parada do "não recebi resposta" |
| **Email preview** (Email Sending → domínio → Settings) guarda HTML, texto, cabeçalhos, **anexos** e raw de cada mensagem **enviada** por ≈ 7 dias; vem **ligado por padrão** em domínios novos | docs Email Service → Configuration → Domains, "Email preview" | RUNBOOK: desligar **antes** de ativar o canal (senão o Excel com os dados do imóvel fica guardado); privacidade afirma que está desligado |
| WeasyPrint 70 instala com `uv` nesta máquina (pango, gobject e harfbuzz presentes) e reproduz o manual atual: 10 páginas A4, ≈ 203 KB | spike nesta sessão: `uv venv … && uv pip install weasyprint`; `pdfinfo` | O manual **fecha nesta entrega**; a spec dizia "exige Chromium" — está desatualizada: o script já usa WeasyPrint desde a PR #18 |
| `unpdf` roda em Node: `getDocumentProxy(bytes).numPages` e `extractText(pdf, { mergePages: true })` devolvem `10` e o texto do manual | executado nesta sessão | Testes de consistência de `/manual` e do PDF sintético sem dependência nova |
| Textos literais das respostas e das recusas | `src/email.js` (`compose`) e `src/worker.js` (`setReject`) | Tabela de mensagens do manual (Task 5) |

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `tests/fixtures/mime.mjs` (novo) | `mime()` — montador de e-mail RFC 5322 multipart, **movido** de `tests/email.test.mjs` para ser reutilizado pelo script. |
| `tests/fixtures/pdf.mjs` (modificar) | `textPdf(lines)` — PDF mínimo **com camada de texto** (Helvetica/WinAnsi); `assemble(objects)` comum aos dois geradores. |
| `scripts/eml-exemplo.mjs` (novo) | Escreve na saída padrão o e-mail do teste local: carnê + matrícula sintéticos como PDFs de texto. |
| `tests/eml-exemplo.test.mjs` (novo) | O PDF de texto é lido de volta pelo pdf.js; o `.eml` gerado passa pelo `parseInbound`. |
| `tests/email.test.mjs` (modificar) | Só troca a definição local de `mime()` pelo import. |
| `package.json` (modificar) | Glob do `lint` inclui `scripts/*.mjs` e `tests/fixtures/*.mjs`. |
| `wrangler.jsonc` (modificar) | `invocation_logs: false`; comentários que ainda dizem "só POST /api/erro". |
| `RUNBOOK.md` (modificar) | Linha de abertura; seção "Estimativa por e-mail" reescrita (ativar com Email preview desligado, `.eml` pelo script, onde olhar, desligar); "Observabilidade". |
| `site/privacidade.html`, `site/termos.html` (modificar) | Texto completo do canal: duas exceções, o que a Cloudflare retém (31 dias, sem conteúdo; preview desligado), documento de IPTU. |
| `DEPLOY.md` (modificar) | Resumo, diagrama (site + e-mail), decisões, "Segurança e privacidade" (site × e-mail), "Custo" (Paid, Email Sending, Workers AI), 7 dias. |
| `README.md` (modificar) | Linha da spec na tabela de documentos; `tests/` cita o canal de e-mail. |
| `tools/manual-pdf.html` (modificar) | Capítulo "10. Envio por e-mail". |
| `scripts/render-manual.sh` (modificar, só comentário) | Como obter o WeasyPrint com `uv` sem instalar nada no sistema. |
| `site/manual-avm-sp-v7.pdf`, `site/assets/manual/p*.webp` (regenerar) | Saída do script. |
| `site/manual.html`, `site/sitemap.xml` (modificar) | Número de páginas, tamanho, `<img>` novas, descrições; `lastmod` 2026-09-08 em manual/termos/privacidade. |
| `tests/manual.test.mjs` (novo) | PDF, `.webp` e `<img>` com o mesmo número de páginas; tamanho anunciado correto. |

---

### Task 1: `.eml` de exemplo para o teste local (fixtures + script + teste)

**Files:**
- Create: `tests/fixtures/mime.mjs`
- Modify: `tests/fixtures/pdf.mjs`
- Create: `scripts/eml-exemplo.mjs`
- Create: `tests/eml-exemplo.test.mjs`
- Modify: `tests/email.test.mjs` (linhas 10–44: a função `mime` e o comentário acima dela saem; entra um import)
- Modify: `package.json` (script `lint`)

**Interfaces:**
- Consumes: `CARNE`, `MATRICULA` de `tests/fixtures/textos.mjs`; `parseInbound(arrayBuffer)` de `src/email.js` (devolve `{ messageId, subject, attachments: [{ fileName, mimeType, bytes }], ignored: [nomes] }`); `latin1`, `concat` já existentes em `tests/fixtures/pdf.mjs`.
- Produces: `mime(options): string` (mesma assinatura de hoje) em `tests/fixtures/mime.mjs`; `textPdf(lines: string[]): Uint8Array` em `tests/fixtures/pdf.mjs`; `node scripts/eml-exemplo.mjs` → RFC 5322 na saída padrão (a Task 2 cita este comando no RUNBOOK).

- [ ] **Step 1: Branch**

```bash
git checkout main && git pull && git checkout -b email-docs
```

- [ ] **Step 2: Mover `mime()` para `tests/fixtures/mime.mjs`**

Recorte de `tests/email.test.mjs` o bloco que começa no comentário `// Monta um e-mail multipart/mixed em RFC 5322…` (3 linhas de comentário) e termina no `}` que fecha `export function mime(…)` (a linha `const raw = (options) => …` **fica** no teste). Cole em `tests/fixtures/mime.mjs` com este cabeçalho:

```js
// Monta um e-mail multipart/mixed em RFC 5322 para testes e para o .eml do teste local (scripts/eml-exemplo.mjs).
// attachments: [[nome, tipo MIME, conteúdo (string ou Uint8Array), disposition?]].
// related: [[nome, tipo, conteúdo, cid]] — vira UM multipart/related aninhado (corpo text/html com cid: + as
// imagens inline), caso real de logotipo de assinatura embutido no HTML.
export function mime({ from = "pessoa@exemplo.gov.br", subject = "Avaliação do apartamento", messageId = "<abc123@exemplo.gov.br>", attachments = [], extraHeaders = {}, related = [] } = {}) {
  // … corpo idêntico ao que estava em tests/email.test.mjs …
}
```

Em `tests/email.test.mjs`, logo abaixo de `import { scannedPdf } from "./fixtures/pdf.mjs";`, acrescente:

```js
import { mime } from "./fixtures/mime.mjs";
```

- [ ] **Step 3: Conferir que nada mudou nos testes de e-mail**

Run: `node --test tests/email.test.mjs`
Expected: mesmo número de testes de antes, todos `ok` (hoje a suíte inteira tem 80; este arquivo é a maior parte).

- [ ] **Step 4: Escrever o teste que falha**

Crie `tests/eml-exemplo.test.mjs`:

```js
// scripts/eml-exemplo.mjs gera o e-mail do teste local do RUNBOOK ("Estimativa por e-mail"): carnê e matrícula
// sintéticos (tests/fixtures/textos.mjs) como PDFs com camada de texto, num multipart/mixed com Message-ID.
// Aqui: o PDF tem texto de verdade (o pdf.js lê de volta, acentos inclusive) e o .eml passa pelo parseInbound
// do pipeline. Rodar: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { extractText, getDocumentProxy } from "unpdf";
import { textPdf } from "./fixtures/pdf.mjs";
import { CARNE } from "./fixtures/textos.mjs";
import { parseInbound } from "../src/email.js";

test("textPdf: o texto sai de volta pelo pdf.js, com acentos e símbolos do WinAnsi", async () => {
  const pdf = await getDocumentProxy(textPdf(CARNE.trim().split("\n")));
  const { text } = await extractText(pdf, { mergePages: true });
  assert.equal(pdf.numPages, 1);
  assert.match(text, /Ano da Construção Corrigido: 2018/);
  assert.match(text, /Área Construída \(m²\): 98,00/);
  assert.match(text, /Valor do m² do Terreno \(R\$\): 6\.500,00/);
});

test("textPdf: caractere fora do Latin-1 vira hífen em vez de quebrar o PDF", async () => {
  const pdf = await getDocumentProxy(textPdf(["a — b (c) \\ d"]));
  const { text } = await extractText(pdf, { mergePages: true });
  assert.match(text, /a - b \(c\) \\ d/);
});

test("eml-exemplo: gera um e-mail que o pipeline aceita, com os dois PDFs", async () => {
  const script = new URL("../scripts/eml-exemplo.mjs", import.meta.url).pathname;
  const eml = execFileSync(process.execPath, [script], { encoding: "utf8" });
  assert.match(eml, /^From: .*teste@exemplo\.gov\.br/m);
  assert.match(eml, /^To: avm@heybrain\.uk/m);
  assert.match(eml, /^Message-ID: <local-\d+@exemplo\.gov\.br>/m);
  const inbound = await parseInbound(new TextEncoder().encode(eml).buffer);
  assert.deepEqual(inbound.attachments.map((a) => [a.fileName, a.mimeType]), [["iptu.pdf", "application/pdf"], ["matricula.pdf", "application/pdf"]]);
  assert.deepEqual(inbound.ignored, []);
  assert.equal(new TextDecoder("latin1").decode(inbound.attachments[0].bytes.subarray(0, 5)), "%PDF-");
});
```

- [ ] **Step 5: Rodar o teste e ver falhar**

Run: `node --test tests/eml-exemplo.test.mjs`
Expected: FAIL — `textPdf` não é exportado por `./fixtures/pdf.mjs` (SyntaxError de import) ou `scripts/eml-exemplo.mjs` não existe.

- [ ] **Step 6: `textPdf` e `assemble` em `tests/fixtures/pdf.mjs`**

Substitua o trecho final de `scannedPdf` — de `const parts = [latin1("%PDF-1.4\n")];` até `return concat(parts);` — por `return assemble(objects);` e acrescente, depois de `concat`:

```js
// Serializa os objetos 1..n com a tabela xref e o trailer. Comum aos dois geradores.
function assemble(objects) {
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

// PDF mínimo COM camada de texto (Helvetica, WinAnsi): uma linha por Tj, como um PDF "digital" que o toMarkdown
// lê. Caracteres fora do Latin-1 (travessão, aspas curvas) viram "-": o WinAnsi não os tem e o latin1 os
// truncaria em outro caractere.
export function textPdf(lines) {
  const esc = (s) => s.replace(/[^ -ÿ]/g, "-").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const body = latin1(`BT /F1 11 Tf 40 800 Td 14 TL ${lines.map((line) => `(${esc(line)}) Tj T*`).join(" ")} ET`);
  return assemble([
    latin1("<< /Type /Catalog /Pages 2 0 R >>"),
    latin1("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    latin1("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"),
    concat([latin1(`<< /Length ${body.length} >>\nstream\n`), body, latin1("\nendstream")]),
    latin1("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
  ]);
}
```

Atualize o comentário de abertura do arquivo para: `// PDFs mínimos escritos à mão para os testes: scannedPdf (só imagem, "escaneado") e textPdf (camada de texto).` seguido do comentário atual do gradiente.

- [ ] **Step 7: O script**

Crie `scripts/eml-exemplo.mjs`:

```js
#!/usr/bin/env node
// Gera na saída padrão o e-mail do teste local do RUNBOOK ("Estimativa por e-mail"): carnê e matrícula
// sintéticos (tests/fixtures/textos.mjs, sem dado pessoal) como PDFs com camada de texto, num multipart/mixed
// com Message-ID. Remetente teste@exemplo.gov.br — o domínio que .dev.vars autoriza.
// Uso: node scripts/eml-exemplo.mjs > exemplo.eml
import { mime } from "../tests/fixtures/mime.mjs";
import { textPdf } from "../tests/fixtures/pdf.mjs";
import { CARNE, MATRICULA } from "../tests/fixtures/textos.mjs";

const pdf = (text) => textPdf(text.trim().split("\n"));
process.stdout.write(mime({
  from: "teste@exemplo.gov.br",
  subject: "Teste local do AVM por e-mail",
  messageId: `<local-${Date.now()}@exemplo.gov.br>`,
  attachments: [["iptu.pdf", "application/pdf", pdf(CARNE)], ["matricula.pdf", "application/pdf", pdf(MATRICULA)]],
}));
```

(`mime()` faz `Buffer.from(content)`; aceita `Uint8Array`.)

- [ ] **Step 8: Lint passa a cobrir os arquivos novos**

Em `package.json`, no script `lint`, troque `for f in site/assets/*.js src/*.js build.mjs tests/*.mjs; do` por:

```
for f in site/assets/*.js src/*.js build.mjs scripts/*.mjs tests/*.mjs tests/fixtures/*.mjs; do
```

- [ ] **Step 9: Rodar e ver passar**

Run: `node --test tests/eml-exemplo.test.mjs && npm test && npm run lint`
Expected: 3 testes novos `ok`; suíte inteira verde (83); `lint ok`.

- [ ] **Step 10: Provar o `.eml` de ponta a ponta (opcional, exige rede — pule se o `wrangler dev` não puder subir)**

Em outro terminal, `npx wrangler dev` (com `.dev.vars` contendo `ALLOWED_SENDERS=@exemplo.gov.br`). Depois:

```bash
node scripts/eml-exemplo.mjs > /tmp/exemplo.eml
curl --request POST 'http://localhost:8787/cdn-cgi/local/email' --url-query 'from=teste@exemplo.gov.br' --url-query 'to=avm@heybrain.uk' --data-binary @/tmp/exemplo.eml
```

Expected: no terminal do `wrangler dev`, a linha `{"event":"email_processed","outcome":"report",…}` e o e-mail simulado com o assunto `Re: Teste local do AVM por e-mail`. Encerre o `wrangler dev` **antes** de qualquer `npm run check`.

- [ ] **Step 11: Commit**

```bash
git add tests/fixtures/mime.mjs tests/fixtures/pdf.mjs tests/email.test.mjs tests/eml-exemplo.test.mjs scripts/eml-exemplo.mjs package.json
git commit -m "Teste local do canal de e-mail: scripts/eml-exemplo.mjs gera o .eml a partir dos fixtures (PDF com texto)"
```

---

### Task 2: `wrangler.jsonc` sem logs de invocação + RUNBOOK operacional completo

**Files:**
- Modify: `wrangler.jsonc` (linhas 2, 5 e o bloco `observability`)
- Modify: `RUNBOOK.md` (linha 3; seção `## Estimativa por e-mail (avm@heybrain.uk)` inteira; primeiro item de `## Observabilidade`)

**Interfaces:**
- Consumes: `node scripts/eml-exemplo.mjs` (Task 1); eventos de log `email_rejected` (`reason`: unauthorized / ratelimit / too_large), `email_dropped` (`reason: auto_submitted`), `email_processed` (`outcome`: report / refused / missing / unreadable / ambiguous / error; `documents`, `unreadable`, `ocr_pages`, `ms`), `email_send_failed` (`error`) — de `src/worker.js`, inalterado.
- Produces: nada consumido por outras tasks. O texto de `wrangler.jsonc` é citado em `DEPLOY.md` (Task 4) e em `site/privacidade.html` (Task 3) como fato: "sem logs de invocação".

- [ ] **Step 1: `wrangler.jsonc`**

Linha 2 (comentário de abertura) passa a:

```jsonc
  // Cloudflare Workers Static Assets + um Worker (src/worker.js): POST /api/erro e o handler email() da estimativa por e-mail.
```

Linha 5 passa a:

```jsonc
  "main": "src/worker.js", // POST /api/erro (avisos técnicos anônimos → Workers Logs) e email() (avm@heybrain.uk); o resto é asset
```

O bloco `observability` (comentário + linha) passa a:

```jsonc
  // Workers Logs (retenção de 7 dias no plano Paid) só com as linhas próprias (front_error, email_*). Sem logs de
  // invocação: o registro automático de um evento de e-mail traz o envelope (remetente e destinatário), e a
  // privacidade promete linhas técnicas sem dados pessoais. Para /api/erro, a linha própria já tem tudo que se usa.
  "observability": { "enabled": true, "logs": { "invocation_logs": false, "head_sampling_rate": 1 } },
```

- [ ] **Step 2: Validar a configuração**

Run: `npm run build && npm run lint`
Expected: `lint ok` (o `wrangler deploy --dry-run` aceita o JSONC). Se reclamar de `invocation_logs`, a chave está fora de `logs` — conferir a indentação.

- [ ] **Step 3: RUNBOOK — abertura**

Linha 3 passa a:

```markdown
Site estático em Cloudflare Workers Static Assets + um Worker (`src/worker.js`): `POST /api/erro` e o handler `email()` da estimativa por e-mail (`avm@heybrain.uk`).
```

- [ ] **Step 4: RUNBOOK — seção "Estimativa por e-mail" inteira**

Substitua tudo entre `## Estimativa por e-mail (avm@heybrain.uk)` e a linha em branco antes de `## Observabilidade` por:

````markdown
## Estimativa por e-mail (avm@heybrain.uk)

Handler `email()` em `src/worker.js`; pipeline em `src/email.js`; OCR em `src/ocr.js`; spec em `docs/superpowers/specs/2026-09-08-email-avm-design.md`; o que o remetente vê está no capítulo 10 do manual (`/manual`).

Sem o segredo `ALLOWED_SENDERS`, **todo** e-mail é recusado — é o estado do Worker logo depois de um deploy limpo, antes do passo 2.

**Ativar (uma vez, depois de privacidade e termos publicados):**
1. Desligar a pré-visualização de mensagens enviadas: Dashboard → Compute & AI → Email Service → **Email Sending** → `heybrain.uk` → Settings → **Enable email preview: off**. Ligada (o padrão em domínio novo), a Cloudflare guarda por ~7 dias cada resposta inteira — inclusive o Excel com os dados do imóvel —, e a privacidade afirma o contrário.
2. Remetentes autorizados: `npx wrangler secret put ALLOWED_SENDERS` e colar a lista separada por vírgulas — `@orgao.sp.gov.br` autoriza o domínio exato (sem subdomínios), `pessoa@empresa.com.br` autoriza o endereço. Espaços e maiúsculas não importam. Vale no próximo e-mail; não há deploy.
3. Regra de roteamento: Dashboard → Compute & AI → Email Service → **Email Routing** → `heybrain.uk` → Routing rules → Create address `avm` → Action **Send to a Worker** → `avm-sp`. (Equivalente: `npx wrangler email routing rules create --help`.)
4. Teste real: de um endereço que esteja na lista, mandar um e-mail com uma matrícula e um documento de IPTU digitais (PDF com texto). A resposta chega na mesma conversa em menos de um minuto, com o `.xlsx`. Com escaneado, até ~2 minutos.
5. Conferir os registros desse e-mail (abaixo, "Ler o que aconteceu"): em Workers Logs deve haver só a linha `email_processed`, sem endereço nem arquivo; no Activity log do Email Service aparecem o remetente, o assunto e a entrega — é o que a página de privacidade declara.

**Trocar remetentes:** repetir `npx wrangler secret put ALLOWED_SENDERS` com a lista completa nova (substitui a anterior; vale no próximo e-mail). Para remover alguém, colar a lista sem ele.

**Desligar o canal (um passo):** Email Routing → `heybrain.uk` → Routing rules → regra `avm` → **Disable**. O Worker continua no ar para o site; e-mails para `avm@` passam a ser rejeitados pelo MX da Cloudflare (o remetente recebe bounce). Religar = Enable na mesma regra.

**Desligar só o OCR:** não há chave própria; as alavancas são tirar o remetente de `ALLOWED_SENDERS` ou desabilitar a regra. Pior caso de custo com um remetente comprometido: 3 e-mails/min × 8 páginas × ~US$ 0,002 ≈ US$ 3/hora — configure um alerta de gasto em Compute & AI → Workers AI.

**Teste local (sem tocar em produção):** `npx wrangler dev` com `ALLOWED_SENDERS=@exemplo.gov.br` em `.dev.vars` (arquivo ignorado pelo git). O `.eml` sai de um script, com carnê e matrícula sintéticos como PDFs com texto:

```bash
node scripts/eml-exemplo.mjs > exemplo.eml
curl --request POST 'http://localhost:8787/cdn-cgi/local/email' --url-query 'from=teste@exemplo.gov.br' --url-query 'to=avm@heybrain.uk' --data-binary @exemplo.eml
```

O terminal do `wrangler dev` mostra a linha `email_processed` (`outcome: report`) e o e-mail de resposta simulado; o texto dos PDFs e o OCR usam o Workers AI da conta (remoto), então precisa de rede e de login no wrangler. Anexos binários não aparecem no simulador — o Excel é coberto por `tests/email.test.mjs`. Para testar recusa, troque o `from` por um domínio fora da lista (`email_rejected`, `reason: unauthorized`). Encerre o `wrangler dev` antes de `npm run build`/`check`.

**Ler o que aconteceu — dois lugares:**
- *Workers Logs* (dashboard → Workers & Pages → `avm-sp` → Logs; 7 dias): filtrar `event: email_*`. `email_rejected` (`reason`: unauthorized / ratelimit / too_large) não abriu o e-mail; `email_dropped` (`reason: auto_submitted`) era resposta automática de alguém e foi descartado sem bounce; `email_processed` traz `outcome` (report / refused / missing / unreadable / ambiguous / error), `documents`, `unreadable`, `ocr_pages` (> 0 = houve transcrição) e `ms`; `email_send_failed` = a resposta não saiu e o remetente recebeu bounce. Nenhuma linha traz endereço, arquivo ou valores; os logs de invocação estão desligados no `wrangler.jsonc` justamente porque trariam o remetente.
- *Activity log do Email Service* (Compute & AI → Email Service → Email Routing ou Email Sending → `heybrain.uk` → Activity; 31 dias): uma linha por mensagem recebida (remetente, destinatário, assunto, SPF/DKIM/DMARC, ação — "Worker") e por resposta enviada (Sent / Delivered / Delivery failed / Rejected / Failed). É registro da Cloudflare, não desligável; a privacidade o declara.

**"Não recebi resposta":**
1. Activity log de *Routing*: a mensagem chegou? Se não há linha, o e-mail não saiu do remetente ou foi para outro endereço — pedir o comprovante de envio. Se a ação não é "Worker", a regra `avm` está desabilitada ou não existe.
2. Workers Logs: qual foi o `outcome`? `email_rejected: unauthorized` → incluir o remetente em `ALLOWED_SENDERS`; `ratelimit` → mais de 3 por minuto; `too_large` → mais de 20 MB; `email_processed` com `outcome: error` → abrir issue com a linha (tem só `error.name`); `email_dropped` → o remetente mandou como resposta automática (`Auto-Submitted`/`Precedence`), pedir para reenviar normalmente.
3. Activity log de *Sending*: a resposta consta como Delivered? "Delivery failed" = o servidor do remetente recusou (reputação, caixa cheia): pedir outro endereço. "Rejected" = o endereço está na lista de supressão da conta (bounce anterior): Email Sending → Suppressions → remover.

**Limites (o que o remetente vê no manual):** 3 e-mails por minuto por remetente; 20 MB por mensagem; 6 anexos de até 10 MB (PDF, PNG, JPEG ou WebP; imagem só entre 20 KB e 5 MB). PDF com camada de texto é lido direto; escaneado ou imagem passa por OCR no Workers AI (até 4 páginas por documento e 8 por e-mail). Custo do OCR: da ordem de US$ 0,002 por página no Gemma 4 — acompanhar em Compute & AI → Workers AI. Se o binding recusar uma imagem (payload grande), a página cai como "sem texto legível" — o `ocr_pages` continua contando a tentativa.
````

- [ ] **Step 5: RUNBOOK — Observabilidade**

O primeiro item de `## Observabilidade` passa a começar com:

```markdown
- Workers Logs (retenção de 7 dias no plano Paid; confira no dashboard se o plano mudar; **sem logs de invocação** desde 2026-09-08 — o registro automático de um e-mail traz o remetente, e a privacidade promete linhas sem dados pessoais): dashboard → Workers & Pages → avm-sp → Logs. Avisos do front chegam como
```

e o resto do item (`{"event":"front_error",…}` em diante) fica como está.

- [ ] **Step 6: Conferir que não sobrou texto antigo**

Run: `grep -n "só \`POST /api/erro\`\|teste.eml\|linha de invocação\|só POST /api/erro" RUNBOOK.md wrangler.jsonc`
Expected: nenhuma linha.

- [ ] **Step 7: Commit**

```bash
git add wrangler.jsonc RUNBOOK.md
git commit -m "Canal de e-mail: sem logs de invocação (traziam o remetente); RUNBOOK completo para ativar, testar e desligar"
```

---

### Task 3: Privacidade e termos completos

**Files:**
- Modify: `site/privacidade.html` (metas `og:description`/`twitter:description`/`description`; `<p class="lead">`; item "A matrícula e o carnê" da seção 1; seção 5 inteira; seção 6)
- Modify: `site/termos.html` (seção 1, uma frase; seção 7, uma frase)

**Interfaces:**
- Consumes: os fatos da tabela "Fatos verificados" (31 dias, sem conteúdo; preview desligado — Task 2 garante que o RUNBOOK manda desligar antes de ativar; `invocation_logs: false` — Task 2).
- Produces: nada. O manual (Task 5) aponta para `/privacidade`.

- [ ] **Step 1: Metas**

Nas três metas de descrição de `site/privacidade.html` (`og:description`, `twitter:description`, `name="description"`), o texto passa a:

```
Política de privacidade do AVM SP: o cálculo roda no seu navegador, sem cookies, sem contas e sem envio de dados, exceto o endereço na busca de CEP; e o que o canal por e-mail processa e registra.
```

- [ ] **Step 2: Parágrafo de abertura**

`<p class="lead">` passa a terminar em:

```html
Esta página explica as duas exceções — a busca de CEP e a estimativa por e-mail — e o que o provedor de hospedagem vê.</p>
```

(o começo, "O AVM SP foi construído para funcionar **inteiramente no seu navegador**. Não há conta, não há cookie, não há banco de dados e não há servidor que receba o que você digita.", fica.)

- [ ] **Step 3: Seção 1, item dos documentos**

`<li><strong>A matrícula e o carnê de IPTU</strong> que você seleciona:` passa a `<li><strong>A matrícula e o documento de IPTU</strong> (carnê ou Certidão de Dados Cadastrais do Imóvel) que você seleciona:` — o resto do item igual.

- [ ] **Step 4: Seção 5 inteira**

Substitua de `<h2>5. Estimativa por e-mail</h2>` até o `<p>` que termina em `não um laudo.</p>` por:

```html
      <h2>5. Estimativa por e-mail</h2>
      <p>Remetentes previamente autorizados podem enviar a matrícula e o documento de IPTU (carnê ou Certidão de Dados Cadastrais do Imóvel) para <a href="mailto:avm@heybrain.uk">avm@heybrain.uk</a> e receber a estimativa por resposta automática. Nesse canal o processamento <strong>não</strong> acontece no seu navegador:</p>
      <ul>
        <li><strong>O que é recebido:</strong> a mensagem e os anexos enviados a esse endereço.</li>
        <li><strong>Onde é processado:</strong> nos servidores da Cloudflare (Workers), em memória, durante o processamento daquela mensagem — em geral menos de um minuto; até dois minutos quando há OCR. O texto dos PDFs é extraído pelo serviço de conversão de documentos da Cloudflare (Workers AI). Páginas escaneadas e imagens são transcritas por um modelo de visão do Workers AI, também da Cloudflare, que recebe a imagem da página e devolve o texto e que, conforme a política da Cloudflare, não usa nem retém a imagem. Nós não gravamos nada: nem a mensagem, nem os anexos, nem o relatório. A pré-visualização de mensagens enviadas que a Cloudflare oferece para o domínio está desligada.</li>
        <li><strong>O que sai:</strong> o endereço do imóvel, para o Nominatim (OpenStreetMap), como no site. Nenhum dado vai a serviços fora da Cloudflare e da OpenStreetMap Foundation.</li>
        <li><strong>O que é registrado:</strong> nos nossos registros técnicos, linhas sem dados pessoais — resultado (relatório, recusa, faltou), quantidade de documentos e tempo de processamento — por sete dias. O serviço de e-mail da Cloudflare, por sua vez, mantém o registro de entrega de cada mensagem recebida e respondida — endereço do remetente, destinatário, assunto e situação da entrega, sem o conteúdo — por até 31 dias, conforme a <a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noreferrer">política de privacidade da Cloudflare</a>. Evite dados pessoais no assunto.</li>
        <li><strong>Quem pode usar:</strong> só remetentes autorizados; mensagens de outros endereços são devolvidas sem que os anexos sejam abertos.</li>
      </ul>
      <p>Quando há OCR, o relatório e a resposta avisam que parte do texto foi transcrita automaticamente e deve ser conferida no documento original.</p>
      <p>Ao enviar, o remetente declara que se trata de apartamento residencial em compra e venda e aceita os <a href="/termos">termos de uso</a>. A resposta é uma estimativa estatística, não um laudo.</p>
```

- [ ] **Step 5: Seção 6**

A primeira frase `Como não guardamos dados pessoais, não há o que acessar, corrigir ou excluir do nosso lado.` passa a:

```
Como não guardamos dados pessoais, não há o que acessar, corrigir ou excluir do nosso lado; os registros de entrega do serviço de e-mail da Cloudflare expiram sozinhos em 31 dias.
```

- [ ] **Step 6: Termos**

Em `site/termos.html`, seção 1, `O cálculo acontece no seu navegador.` passa a:

```
O cálculo acontece no seu navegador ou, no canal por e-mail (seção 7), nos servidores descritos na <a href="/privacidade">política de privacidade</a>.
```

Seção 7: depois de `e pode ser uma recusa ou um pedido de documentos completos.` insira ` Um imóvel por mensagem; o que anexar, os limites e o significado de cada resposta estão no capítulo 10 do <a href="/manual">manual</a>.` (antes de `O processamento é descrito…`).

- [ ] **Step 7: Verificar**

Run: `npm run build && grep -c "carnê de IPTU" site/privacidade.html; grep -c "31 dias" site/privacidade.html; grep -c "seção 7" site/termos.html`
Expected: build ok; `0`; `2`; `1`. Abrir `dist/privacidade.html` e `dist/termos.html` e ler as seções alteradas de ponta a ponta (frases inteiras, sem tag quebrada; `python3 -m http.server --directory dist 8790` e o navegador, ou `sed -n '/<h2>5\./,/<h2>6\./p' dist/privacidade.html`).

- [ ] **Step 8: Commit**

```bash
git add site/privacidade.html site/termos.html
git commit -m "Privacidade e termos: o que o canal de e-mail processa e o que a Cloudflare registra (31 dias, sem conteúdo)"
```

---

### Task 4: `DEPLOY.md` e `README.md`

**Files:**
- Modify: `DEPLOY.md` (Resumo; diagrama; tabela de decisões; "Segurança e privacidade"; "Custo")
- Modify: `README.md` (tabela de documentos; item `tests/` do layout)

**Interfaces:** consome os fatos da tabela e a spec §3, §7, §8; nada produzido para outras tasks.

- [ ] **Step 1: Resumo**

Depois do primeiro item (`- **O que é**: …`), insira:

```markdown
- **Canal por e-mail** (desde 2026-09-08): o mesmo Worker recebe em `avm@heybrain.uk` a matrícula e o documento de IPTU de
  remetentes autorizados e devolve, sem intervenção humana, a estimativa no corpo da mensagem e o relatório em Excel.
  Tudo em memória, na invocação; nada é gravado. Escaneados passam por OCR no Workers AI. Spec:
  [docs/superpowers/specs/2026-09-08-email-avm-design.md](docs/superpowers/specs/2026-09-08-email-avm-design.md).
```

- [ ] **Step 2: Diagrama**

No diagrama existente, a linha `└── POST /api/erro (aviso técnico anônimo) ──▶ src/worker.js ──▶ Workers Logs (3 dias no Free)` passa a `└── POST /api/erro (aviso técnico anônimo) ──▶ src/worker.js ──▶ Workers Logs (7 dias, Paid; só linhas próprias)`. Logo depois do bloco de código do diagrama (antes de "Fontes de treino…"), acrescente:

````markdown
```
remetente ── SMTP ──▶ Email Routing (heybrain.uk) ── regra avm@ ──▶ Worker avm-sp · handler email()
                                                                        │
                    ┌───────────────────────────────────────────────────┤ tudo em memória, nada gravado
                    │ 1. remetente na lista (segredo ALLOWED_SENDERS)?  │ não → setReject (bounce)
                    │ 2. resposta automática de alguém? descarta        │
                    │ 3. limite por remetente (EMAIL_RL, 3/min); 20 MB  │
                    │ 4. postal-mime → anexos PDF/imagem (≤ 6, ≤ 10 MB) │
                    │ 5. texto: env.AI.toMarkdown (PDF com texto)       │
                    │    ou OCR: unpdf → PNG → gemma-4 (Workers AI)     │
                    │ 6. AVMMatricula.extract* (mesmos leitores do site)│
                    │ 7. AvmReport.estimate (AvmPredict) + Nominatim    │
                    │ 8. AvmReport.build → AVMExcel.buildWorkbook       │
                    │ 9. env.EMAIL.send → remetente (In-Reply-To)       │
                    └───────────────────────────────────────────────────┘
```
````

- [ ] **Step 3: Decisões**

A linha `| Worker mínimo só para \`/api/erro\` | …` passa a:

```markdown
| Worker para `/api/erro` e para o handler `email()` | Sem backend de predição para o site, mas o prompt pede captura de erro de front e a licitação pede o canal por e-mail. `run_worker_first` só em `/api/*`; assets e `_headers` intactos. Payload de `/api/erro` sem dado do imóvel. |
```

E acrescente, no fim da tabela (depois de "Matrículas de teste fora do git"):

```markdown
| Canal de e-mail no **mesmo Worker**, handler `email()` ao lado do `fetch()` | Um deploy (Workers Builds já publica no merge), um `wrangler.jsonc`, os módulos do site importados direto (`AVMMatricula`, `AvmPredict`, `AvmReport`, `AVMExcel`): site e e-mail produzem o mesmo relatório para as mesmas entradas. Um segundo Worker só duplicaria pipeline e bindings. |
| Síncrono, na invocação do e-mail, **sem estado** | Sem fila, DO, R2 ou banco: o que entra sai na mesma invocação e nada é retido — é a afirmação mais forte possível na privacidade. CPU do Paid (`cpu_ms` 60000) sobra; toMarkdown, Workers AI e Nominatim são I/O. |
| Lista de remetentes autorizados (`ALLOWED_SENDERS`, segredo) e só o envelope autoriza | Caixa aberta = OCR e CPU pagos por qualquer spam e PDFs de desconhecidos abertos no servidor. `From`/`Reply-To` são falsificáveis; `message.from` (MAIL FROM) não. Decisão do dono. |
| OCR via Workers AI (Gemma 4), não Tesseract nem Browser Rendering | Decisão do dono. Tesseract WASM não cabe no Worker; Browser Rendering custaria 30–60 s por e-mail. O modelo só transcreve — os campos vêm dos mesmos leitores do site; erro de transcrição vira "Faltou", nunca número inventado. |
| Uma resposta por e-mail recebido, sempre | Relatório, recusa ou "faltou isto" — o remetente nunca fica sem saber. Se o envio falhar, `setReject` para que receba um bounce. `Auto-Submitted` não é permitido no Email Sending; vai `X-Auto-Response-Suppress`. |
| Logs de invocação **desligados** (`observability.logs.invocation_logs: false`) | O registro automático de um evento de e-mail traz remetente e destinatário; a privacidade promete linhas técnicas sem dados pessoais. As linhas próprias (`front_error`, `email_*`) bastam para operar. |
```

- [ ] **Step 4: Segurança e privacidade**

Substitua a seção inteira por:

```markdown
## Segurança e privacidade

**Site.** Cabeçalhos em toda resposta de asset (`site/_headers`): CSP fechada, `nosniff`, `Referrer-Policy`,
`Permissions-Policy`, COOP e CORP. HSTS de 180 dias na zona e também em `_headers` (sem preload). Sem cookies, sem
`localStorage`, sem analytics. Dados do imóvel, matrícula e documento de IPTU ficam no navegador; o endereço sai ao ser
preenchido ou alterado, para o Nominatim, e nada mais.

**E-mail.** O e-mail inteiro é entrada hostil: guardas na ordem barato → caro (remetente → resposta automática →
limite → tamanho) e nada do corpo é lido antes de o remetente passar. Anexos só PDF/PNG/JPEG/WebP por tipo e extensão,
≤ 6 e ≤ 10 MiB cada; o parse do PDF acontece no `toMarkdown` (fora do isolate) ou no `unpdf` com tetos (12 Mpx, 4
páginas). Nenhum byte de anexo volta na resposta; o Excel (~50 KB) fica longe do limite de 5 MiB da saída. Processamento
em memória nos servidores da Cloudflare; nenhum binding de armazenamento. O que a Cloudflare retém, e a privacidade
declara: Workers Logs 7 dias (só linhas próprias, sem endereço, arquivo ou valores); Activity log do Email Service 31
dias (remetente, destinatário, assunto, situação da entrega — sem conteúdo); a pré-visualização de mensagens enviadas
fica **desligada** (RUNBOOK, "Ativar", passo 1). Abuso: lista de remetentes + `EMAIL_RL` (3/min) + tetos; pior caso com
um remetente comprometido ≈ US$ 3/hora de OCR até ser removido da lista.
```

- [ ] **Step 5: Custo**

Substitua a seção inteira por:

```markdown
## Custo

Cloudflare **Workers Paid** (já contratado pelo dono; o canal por e-mail exige — no Free o Email Sending só entrega a
endereços verificados): assets sem custo; `/api/erro` e o handler de e-mail contam contra 10 M invocações/mês e 30 M
ms de CPU inclusos. **Email Sending**: 3.000 envios/mês inclusos, depois US$ 0,35 por 1.000. **Workers AI**: por token
(Gemma 4: US$ 0,10/M de entrada, US$ 0,30/M de saída ≈ US$ 0,002 por página transcrita, < US$ 0,02 por e-mail com 8
páginas); PDF com texto não gera custo de OCR. GitHub Free (Actions dentro da franquia); registro `.uk` renovado
anualmente pela Cloudflare ao preço de custo.

Estimativa: sem e-mails, **zero** além do plano e do domínio; 1.000 e-mails/mês com metade escaneada, **≈ US$ 10** além
do plano. Alerta de gasto: Compute & AI → Workers AI (RUNBOOK, "Desligar só o OCR").
```

- [ ] **Step 6: README**

Na tabela de documentos, depois da linha de `RUNBOOK.md`, insira:

```markdown
| [docs/superpowers/specs/2026-09-08-email-avm-design.md](docs/superpowers/specs/2026-09-08-email-avm-design.md) | Canal por e-mail (`avm@heybrain.uk`): arquitetura, entregas, segurança, custo |
```

No layout, o item `tests/` passa a: ``- `tests/` paridade Python↔JS, limites de aplicabilidade, validador, canal de e-mail (pipeline, OCR, leitores de IPTU), consistência do manual``.

- [ ] **Step 7: Verificar**

Run: `grep -n "3 dias\|Workers Free\|Worker mínimo só\|zero\*\*, além" DEPLOY.md; grep -c "email-avm-design" README.md`
Expected: nenhuma linha do primeiro grep; `1` (README). Ler `DEPLOY.md` inteiro uma vez: a tabela de decisões continua com uma linha por `|` (Markdown de tabela quebra com `|` solto dentro da célula — não há nenhum nos textos acima).

- [ ] **Step 8: Commit**

```bash
git add DEPLOY.md README.md
git commit -m "DEPLOY.md: canal de e-mail (diagrama, decisões, privacidade site × e-mail, custo Paid); README aponta a spec"
```

---

### Task 5: Manual — capítulo "Envio por e-mail", PDF e imagens regenerados, `/manual` atualizado

**Files:**
- Create: `tests/manual.test.mjs`
- Modify: `tools/manual-pdf.html` (nova `<section>` depois da seção 9, antes de `</body>`)
- Modify: `scripts/render-manual.sh` (só o comentário de cabeçalho)
- Regenerate: `site/manual-avm-sp-v7.pdf`, `site/assets/manual/p*.webp`
- Modify: `site/manual.html` (metas, `<small>` do botão, lista de `<img>`), `site/sitemap.xml` (`lastmod`)

**Interfaces:**
- Consumes: `getDocumentProxy` de `unpdf` (Node); o WeasyPrint num venv de rascunho; `pdftoppm` (poppler) e Pillow do `python3` do sistema — `scripts/render-manual.sh` já recebe `WEASYPRINT` e `PYTHON` por variável de ambiente.
- Produces: `/manual` com N páginas (N ≥ 11), `tests/manual.test.mjs` como guarda para quem regenerar o manual e esquecer o HTML.

- [ ] **Step 1: Teste de consistência (passa no estado atual — é a guarda para os passos seguintes)**

Crie `tests/manual.test.mjs`:

```js
// /manual mostra o PDF como imagens (Chrome do Android não exibe PDF em iframe): o número de páginas do PDF, o
// de arquivos p*.webp e o de <img> no HTML têm de bater, e o texto do botão ("N páginas · K KB") também. Quem
// regenera o manual (scripts/render-manual.sh) e esquece o site/manual.html cai aqui. Rodar: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { getDocumentProxy } from "unpdf";

const site = new URL("../site/", import.meta.url);
const html = readFileSync(new URL("manual.html", site), "utf8");
const pdfPath = new URL("manual-avm-sp-v7.pdf", site);

test("manual: PDF, imagens .webp e <img> têm o mesmo número de páginas", async () => {
  const pdf = await getDocumentProxy(new Uint8Array(readFileSync(pdfPath)));
  const n = pdf.numPages;
  const webps = readdirSync(new URL("assets/manual/", site)).filter((f) => /^p\d\d\.webp$/.test(f));
  const imgs = [...html.matchAll(/<img src="assets\/manual\/(p\d\d)\.webp"/g)].map((m) => m[1]);
  assert.equal(webps.length, n, "arquivos .webp");
  assert.deepEqual(imgs, webps.sort(), "cada .webp aparece uma vez, em ordem");
  const totals = [...html.matchAll(/página \d+ de (\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(totals.length, n, "um alt por página");
  assert.ok(totals.every((t) => t === n), `alts dizem "de ${n}"`);
  assert.match(html, new RegExp(`${n} páginas · `), "texto do botão");
});

test("manual: o tamanho anunciado do PDF está certo (± 10 KB)", () => {
  const kb = Number(html.match(/(\d+) KB<\/small>/)[1]);
  assert.ok(Math.abs(kb - statSync(pdfPath).size / 1024) <= 10, `anunciado ${kb} KB`);
});
```

Run: `node --test tests/manual.test.mjs`
Expected: 2 `ok` (hoje: 10 páginas, 10 `.webp`, 10 `<img>`, "10 páginas · 200 KB", PDF de ≈ 199 KB).

- [ ] **Step 2: O capítulo**

Em `tools/manual-pdf.html`, logo antes de `</body>`, insira:

```html
<section>
  <h1>10. Envio por e-mail</h1>
  <p>Para quem recebe os documentos por e-mail e não usa a tela: um e-mail para <a href="mailto:avm@heybrain.uk">avm@heybrain.uk</a> com a matrícula e o documento de IPTU devolve, sem intervenção humana, a estimativa no corpo da mensagem e o relatório em Excel — o mesmo que o aplicativo gera. O canal só aceita mensagens de endereços previamente autorizados pelo responsável pelo serviço; para autorizar um endereço, escreva para <a href="mailto:contato@heybrain.uk">contato@heybrain.uk</a>.</p>
  <h2>O que anexar</h2>
  <table>
    <thead><tr><th style="width:30%">Documento</th><th>O que precisa conter</th></tr></thead>
    <tbody>
      <tr><td>Matrícula (certidão de ônus reais ou matrícula atualizada)</td><td>Identificação do imóvel como apartamento, endereço e <strong>área privativa</strong>. De preferência o PDF digital emitido pelo cartório.</td></tr>
      <tr><td>Documento de IPTU</td><td>Notificação de Lançamento (carnê) ou <strong>Certidão de Dados Cadastrais do Imóvel</strong>, do portal da Prefeitura: número do contribuinte (SQL), ano da construção corrigido, padrão da construção e valor do m² de terreno.</td></tr>
    </tbody>
  </table>
  <ul>
    <li><strong>Um imóvel por e-mail.</strong> Mais de uma matrícula ou mais de um IPTU na mesma mensagem é devolvido sem cálculo.</li>
    <li>Formatos: PDF, PNG, JPEG ou WebP. Até 6 anexos de 10 MB; mensagem de até 20 MB. Imagens muito pequenas (menos de 20 KB) são ignoradas.</li>
    <li>PDF com texto é lido direto. Escaneado ou foto passa por OCR (até 4 páginas por documento).</li>
    <li>Até 3 e-mails por minuto por remetente.</li>
  </ul>
  <h2>O que volta e em quanto tempo</h2>
  <p>A resposta chega na mesma conversa (assunto "Re: …"), em geral em <strong>menos de um minuto</strong>; com OCR, em até dois minutos. O corpo traz a identificação da avaliação, o imóvel, os dados usados e de qual documento saiu cada um, a faixa de 80% de probabilidade, o valor central e por m², as premissas e os avisos. O Excel anexo é o mesmo relatório do aplicativo (capítulo 8). Guarde o e-mail e o Excel junto com os documentos enviados.</p>
  <div class="box laranja"><strong>Documentos escaneados exigem conferência</strong>
    <p>Quando o texto veio de OCR, a resposta e o relatório avisam. Confira ano da construção, padrão, valor do m² de terreno e área privativa no documento original antes de usar o resultado.</p>
  </div>
  <h2>Cada resposta e o que fazer</h2>
  <table>
    <thead><tr><th style="width:44%">Mensagem recebida</th><th>O que significa e o que fazer</th></tr></thead>
    <tbody>
      <tr><td>Relatório com faixa de valor e Excel anexo</td><td>Estimativa concluída. Leia os avisos: são os mesmos alertas da tela.</td></tr>
      <tr><td>"A estimativa foi recusada porque o imóvel está fora do domínio do modelo"</td><td>Área, idade ou valor fora dos limites do modelo (capítulo 2). Não há relatório; encaminhe para análise técnica (capítulo 9).</td></tr>
      <tr><td>"Não foi possível estimar. Faltou: …"</td><td>O dado listado não foi encontrado nos documentos. Confira se o IPTU anexado é do mesmo imóvel e traz o campo; reenvie tudo em um único e-mail.</td></tr>
      <tr><td>"Não foi possível ler: … (sem texto legível)"</td><td>O arquivo não tem texto e o OCR não conseguiu transcrever (foto ruim, página em branco, arquivo protegido). Envie o PDF original digital.</td></tr>
      <tr><td>"Foi encontrada mais de uma matrícula" / "Foi encontrado mais de um documento de IPTU"</td><td>Dois imóveis na mesma mensagem. Envie um imóvel por e-mail.</td></tr>
      <tr><td>"Ignorados: …" (no fim de uma resposta)</td><td>Anexos que não são PDF nem imagem (planilhas, .docx, logotipos de assinatura). Não afetam o cálculo.</td></tr>
      <tr><td>Mensagem devolvida pelo servidor: "Remetente não autorizado para o AVM SP."</td><td>O endereço não está na lista. Peça a inclusão a contato@heybrain.uk e reenvie do endereço autorizado.</td></tr>
      <tr><td>Devolvida: "Limite de envios atingido; aguarde um minuto."</td><td>Mais de 3 e-mails no mesmo minuto. Aguarde e reenvie.</td></tr>
      <tr><td>Devolvida: "Mensagem grande demais (máximo 20 MB)."</td><td>Reduza os anexos: PDF original em vez de fotos, ou menos páginas.</td></tr>
      <tr><td>Devolvida: "Erro interno ao processar. Tente novamente." ou "Falha temporária ao responder. Reenvie em alguns minutos."</td><td>Falha do lado do serviço. Reenvie; se persistir, escreva para contato@heybrain.uk.</td></tr>
      <tr><td>Nada em 5 minutos, sem devolução</td><td>Confira o destinatário (avm@heybrain.uk) e se o envio saiu do endereço autorizado. Respostas automáticas (fora do escritório, listas) são descartadas sem aviso. Persistindo, contato@heybrain.uk.</td></tr>
    </tbody>
  </table>
  <div class="box azul"><strong>Privacidade</strong>
    <p>Os anexos são processados em memória nos servidores da Cloudflare e não são armazenados; nada volta anexado além do Excel. O que fica registrado e por quanto tempo está em <a href="https://avm.heybrain.uk/privacidade">avm.heybrain.uk/privacidade</a>. Evite dados pessoais no assunto.</p>
  </div>
</section>
```

- [ ] **Step 3: Comentário do script de renderização**

Em `scripts/render-manual.sh`, substitua as duas linhas de comentário que começam em `# Precisa de weasyprint, pdftoppm (poppler) e Pillow` por:

```sh
# Precisa de weasyprint, pdftoppm (poppler) e Pillow. Nada disso entra no repositório: Pillow e poppler vêm do sistema
# (Arch: python-pillow poppler; Debian: python3-pil poppler-utils) e o WeasyPrint de um venv descartável com o uv:
#   uv venv --python 3.12 /tmp/wp && uv pip install --python /tmp/wp/bin/python weasyprint
#   WEASYPRINT=/tmp/wp/bin/weasyprint PYTHON=/usr/bin/python3 scripts/render-manual.sh
# Depois: ajustar o número de páginas, o tamanho e os <img> em site/manual.html (tests/manual.test.mjs cobra).
```

- [ ] **Step 4: Regenerar PDF e imagens**

```bash
uv venv --python 3.12 /tmp/wp && uv pip install --python /tmp/wp/bin/python weasyprint
WEASYPRINT=/tmp/wp/bin/weasyprint PYTHON=/usr/bin/python3 scripts/render-manual.sh
pdfinfo site/manual-avm-sp-v7.pdf | grep -E "Pages|Page size"
```

Expected: `Pages: 11` ou `12` (o capítulo tem duas tabelas; se passar de 12, encurte a tabela de mensagens — nunca o texto das mensagens literais), `Page size: 595.276 x 841.89 pts (A4)`; `site/assets/manual/` só com `p01.webp … pNN.webp` (o script apaga os antigos). Se o WeasyPrint reclamar de biblioteca (`libgobject`/`libpango`), instale `pango` pelo gerenciador do sistema — não altere o script.

- [ ] **Step 5: Olhar as páginas novas**

```bash
pdftoppm -r 60 -f 11 -png site/manual-avm-sp-v7.pdf /tmp/manual-p
```

Abra `/tmp/manual-p-11.png` (e `-12.png` se existir) com a ferramenta de leitura de imagem: cabeçalho "AVM SP | Manual de utilização", título "10. Envio por e-mail", tabelas dentro da margem, nenhuma linha cortada no rodapé. Se uma tabela quebrar de página no meio de uma linha, acrescente `tbody tr { page-break-inside: avoid; }` ao `<style>` de `tools/manual-pdf.html` e regenere (Step 4).

- [ ] **Step 6: `site/manual.html`**

1. Nas três metas de descrição (`og:description`, `twitter:description`, `name="description"`), acrescente ao fim, antes do ponto final: ` e como enviar matrícula e IPTU por e-mail`.
2. `<small>Documento de orientação operacional, versão 7 · 10 páginas · 200 KB</small>` → `N páginas · K KB`, com N = `pdfinfo … | grep Pages` e K = tamanho do PDF em KB arredondado à dezena (`stat -c %s site/manual-avm-sp-v7.pdf`, ÷ 1024).
3. Na lista `<div class="manual-pages">`, troque `de 10"` por `de N"` em todos os `alt` e acrescente, depois de `p10.webp`, uma linha por página nova no mesmo formato (`loading="lazy" decoding="async"`), por exemplo:

```html
      <img src="assets/manual/p11.webp" width="1240" height="1753" loading="lazy" decoding="async" alt="Manual de utilização do AVM SP, página 11 de N">
```

(altura: `python3 -c "from PIL import Image; print(Image.open('site/assets/manual/p11.webp').size)"` — deve dar `(1240, 1753)`; se der outra altura, use a impressa.)

- [ ] **Step 7: `site/sitemap.xml`**

`<lastmod>2026-09-07</lastmod>` → `<lastmod>2026-09-08</lastmod>` nas URLs `/manual`, `/termos` e `/privacidade` (as outras duas ficam).

- [ ] **Step 8: Rodar tudo**

Run: `node --test tests/manual.test.mjs && npm run check`
Expected: os dois testes do manual `ok`; `check` verde (o build dá fingerprint aos `.webp` novos e reescreve os `src` em `manual.html`). Confira `dist/manual.html` tem N `<img>` com hash.

- [ ] **Step 9: Commit**

```bash
git add tools/manual-pdf.html scripts/render-manual.sh site/manual-avm-sp-v7.pdf site/assets/manual site/manual.html site/sitemap.xml tests/manual.test.mjs
git commit -m "Manual: capítulo 10, Envio por e-mail (o que anexar, o que volta, cada mensagem); PDF e páginas regenerados; teste de consistência de /manual"
```

---

### Task 6: Verificação do aceite (controlador, nesta sessão)

Sem arquivos novos. O aceite da spec §6 é: *textos publicados; `/manual` mostra o capítulo novo; RUNBOOK permite a outra pessoa ativar, testar e desligar o canal sem perguntar nada.*

- [ ] **Step 1: Suíte e textos obsoletos**

```bash
npm run check
grep -rn "3 dias\|só POST /api/erro\|teste\.eml\|carnê de IPTU\" que\|linha de invocação" DEPLOY.md RUNBOOK.md README.md wrangler.jsonc site/privacidade.html site/termos.html
```

Expected: `check` verde (85 testes: 80 + 3 do `.eml` + 2 do manual); grep sem linhas.

- [ ] **Step 2: Ver no navegador**

`npx wrangler dev` (preview `wrangler-dev`) → `/manual` (as páginas 11+ aparecem, botão diz N páginas), `/privacidade` (seção 5) e `/termos` (seções 1 e 7). Encerrar o `wrangler dev`.

- [ ] **Step 3: Leitura do RUNBOOK como operador**

Ler "Estimativa por e-mail" do início ao fim fingindo não conhecer o projeto: cada passo tem onde clicar ou o comando exato; nenhum "ver com o dono".

- [ ] **Step 4: Entregar**

`superpowers:finishing-a-development-branch` → PR `email-docs` → `main` com a descrição: o que muda para o remetente (manual), para o operador (RUNBOOK, `invocation_logs`), para o leitor da privacidade (31 dias, preview desligado), e o lembrete de que o merge publica. **Depois do merge, é do dono:** Email preview **off** em Email Sending → `heybrain.uk` (passo 1 do "Ativar") antes de a regra `avm` existir ou ser religada; conferir no Activity log um e-mail real.

---

## Auto-revisão do plano

- **Cobertura da spec §6:** privacidade (Task 3) ✔; termos (Task 3) ✔; `DEPLOY.md` — diagrama, decisões, segurança site × e-mail, custo (Task 4) ✔; `RUNBOOK.md` — regra criar/desligar, `ALLOWED_SENDERS` formato e troca, teste local com `.eml` (Task 1 + 2), Workers Logs `email_*`, "não recebi resposta", desativar em um passo (Task 2) ✔; manual — capítulo com endereço, o que anexar, um imóvel por e-mail, o que volta e em quanto tempo, cada mensagem de erro, aviso de OCR (Task 5) ✔, regenerado nesta máquina (WeasyPrint, não Chromium — a spec estava desatualizada quanto à ferramenta, não quanto ao resultado) ✔; `README.md` (Task 4) ✔.
- **Além da spec, exigido pelos fatos verificados:** `invocation_logs: false` (Task 2) e Email preview desligado (Task 2, passo 1 do "Ativar"; declarado na Task 3). Sem eles, a frase "nada é gravado / linhas sem dados pessoais" seria falsa.
- **Placeholders:** nenhum "TBD"/"similar à Task N"; todos os textos estão inteiros; N e K do manual saem de comandos dados no próprio passo.
- **Consistência de nomes:** `mime()` (Task 1) → importado por `scripts/eml-exemplo.mjs` e `tests/email.test.mjs`; `textPdf(lines)` (Task 1) → `tests/eml-exemplo.test.mjs` e o script; `node scripts/eml-exemplo.mjs` (Task 1) → RUNBOOK (Task 2); `parseInbound` devolve `{ attachments: [{ fileName, mimeType, bytes }], ignored }` — conferido em `src/email.js:39-60` e no teste existente; `getDocumentProxy(Uint8Array).numPages` e `extractText(pdf, { mergePages: true }).text` — executados nesta sessão sobre o manual atual.
