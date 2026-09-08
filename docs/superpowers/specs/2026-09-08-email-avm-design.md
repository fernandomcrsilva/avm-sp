# AVM por e-mail — design

**Data:** 2026-09-08 · **Estado:** para revisão do dono · **Depende de:** PR #23 (leitura do carnê de IPTU) mergeado.

## 1. Objetivo

Um e-mail com a **certidão de ônus reais (matrícula)** e o **carnê de IPTU** de um apartamento em São Paulo
chega a `avm@heybrain.uk`; o AVM responde ao remetente, sem intervenção humana, com a estimativa no corpo
da mensagem e o relatório completo em Excel anexo. Fluxo de uma licitação: quem envia não abre o site nem
preenche nada.

Fica de fora: relatório em PDF (só Excel + corpo), histórico ou armazenamento de qualquer coisa, mais de
um imóvel por e-mail, canais que não sejam e-mail.

## 2. O que foi verificado (2026-09-08)

| Fato | Como foi verificado | Consequência |
|---|---|---|
| `heybrain.uk` tem Email Routing ativo (MX `route*.mx.cloudflare.net`, SPF, DMARC `p=reject`); regra `contato@` → Gmail; catch-all desligado | `dig`, API `/zones/{id}/email/routing/rules` | Receber em `avm@` é criar uma regra, não configurar DNS |
| `heybrain.uk` está habilitado para **Email Sending** | `npx wrangler email sending list` | Responder pelo binding `send_email` já é possível |
| Conta está no **Workers Paid** | confirmado pelo dono | CPU até 30 s (ampliável a 5 min), 3.000 envios/mês inclusos, Workers AI e Browser Run inclusos |
| Envio para destinatário arbitrário exige Paid; Free só envia a endereços verificados | docs Email Service · pricing | Sem Paid o desenho não existe |
| Limite de mensagem: 25 MiB na entrada; **5 MiB na saída** (25 só para destinos verificados) | docs Email Service · limits | O Excel tem ~50 KB; nunca reenviar os PDFs de volta |
| `env.AI.toMarkdown()` extrai texto de PDF sem biblioteca; em imagem devolve *descrição*, não OCR | docs Workers AI · Markdown Conversion | Texto de PDF sem dependência; OCR precisa de modelo de visão |
| Modelos de visão disponíveis: `@cf/google/gemma-4-26b-a4b-it` (US$ 0,10/M tokens de entrada, 0,30/M de saída, 256k de contexto, 140 idiomas), `@cf/qwen/qwen3.8-27b`, `@cf/meta/llama-3.2-11b-vision-instruct` (campo `image` documentado) | docs Workers AI · models | Gemma 4 como modelo principal; Llama 3.2 Vision como reserva |
| `unpdf` 1.8.1 roda em Workers (build serverless); `extractImages(pdf, página)` devolve pixels brutos `{data, width, height, channels: 1|3|4}`; `renderPageAsImage` **não** roda em Workers (precisa de canvas) | README do unpdf | Página escaneada = imagem embutida; extrair e codificar PNG no Worker |
| `postal-mime` 3.0.0 parseia MIME em Workers | npm | Única biblioteca nova na entrega 1 |
| Rate Limiting binding aceita `period` de 10 ou 60 s | docs Workers · rate limiting | Limite por remetente é por minuto, não por hora |
| Os módulos do site são puros: `AVMMatricula` (extração), `AvmPredict` (cálculo), `AVMExcel` (Excel) expõem-se em `globalThis`, sem DOM | leitura de `site/assets/*.js`; `tests/*.test.mjs` já os carregam em Node | O Worker reaproveita os três — uma fonte de verdade |

## 3. Arquitetura

```
remetente ── SMTP ──▶ Email Routing (heybrain.uk) ── regra avm@ ──▶ Worker avm-sp · handler email()
                                                                        │
                    ┌───────────────────────────────────────────────────┤ tudo em memória, nada gravado
                    │ 1. remetente na lista?  não → setReject           │
                    │ 2. limite por remetente (EMAIL_RL)                │
                    │ 3. postal-mime → anexos PDF/imagem                │
                    │ 4. texto: env.AI.toMarkdown (PDF com texto)       │
                    │    ou OCR: unpdf → PNG → gemma-4 (entrega 2)      │
                    │ 5. AVMMatricula.detectDocumentType/extract*       │
                    │ 6. AvmReport.estimate (AvmPredict) + Nominatim    │
                    │ 7. AvmReport.build → AVMExcel.buildWorkbook       │
                    │ 8. env.EMAIL.send → remetente (In-Reply-To)       │
                    └───────────────────────────────────────────────────┘
```

**Decisões de arquitetura**

| Decisão | Justificativa |
|---|---|
| Mesmo Worker `avm-sp`, handler `email()` ao lado do `fetch()` | Um deploy (Workers Builds já publica no merge), um `wrangler.jsonc`, os módulos do site importados direto. Um segundo Worker só duplicaria pipeline e bindings. |
| Síncrono, dentro da invocação do e-mail, **sem estado** | Wall-clock ilimitado; CPU do Paid sobra (toMarkdown, Workers AI e Nominatim são I/O). Sem fila, DO, R2 ou banco: o que entra sai na mesma invocação e nada é retido. É a afirmação mais forte possível na privacidade. |
| Lista de remetentes autorizados | Caixa aberta = OCR e CPU pagos por qualquer spam, e PDFs de desconhecidos abertos no servidor. Decisão do dono. |
| Uma resposta por e-mail recebido, sempre | Relatório, recusa ou "faltou isto" — o remetente nunca fica sem saber o que aconteceu. Se o envio falhar, `setReject` para que o remetente receba um bounce. |
| Código do cálculo e do relatório compartilhado (`site/assets/report.js`) | Hoje a sequência limitReasons → modelKey → logPrice → interval → priceReason e a montagem do `latestReport` estão dentro de `app.js`. Extraídas para um módulo puro, site e Worker produzem o **mesmo relatório e a mesma identificação** para as mesmas entradas. |
| OCR via Workers AI, não Tesseract nem Browser Run | Decisão do dono. Tesseract WASM não cabe no Worker; Browser Run custaria 30–60 s por e-mail. |

## 4. Entrega 1 — e-mail → relatório (PDFs com camada de texto)

### 4.1 Fluxo do handler `email(message, env, ctx)`

Ordem fixa, barato antes de caro, como em `POST /api/erro`:

1. **Remetente.** `message.from` (envelope SMTP, não o cabeçalho `From`, que é falsificável), em minúsculas, contra `env.ALLOWED_SENDERS`. Fora da lista → `message.setReject("Remetente não autorizado para o AVM SP.")`; log `email_rejected {reason:"unauthorized"}`; fim. Nenhum byte do corpo é lido.
2. **Limite.** `env.EMAIL_RL.limit({ key: from })`; estourou → `setReject("Limite de envios atingido; aguarde um minuto.")`; log `{reason:"ratelimit"}`.
3. **Tamanho.** `message.rawSize > 20 MiB` → `setReject("Mensagem grande demais (máximo 20 MB).")`; log `{reason:"too_large"}`.
4. **MIME.** `raw = await new Response(message.raw).arrayBuffer()` (o stream é de uso único); `PostalMime.parse(raw)`. Anexos considerados: até 6, cada um ≤ 10 MiB, com `mimeType` `application/pdf` ou nome `.pdf` (imagens `png/jpeg/webp` só na entrega 2; na 1 entram na lista de "não processados"). Corpo do e-mail é ignorado.
5. **Texto.** Para cada PDF: `env.AI.toMarkdown({ name, blob }, { output: { format: "text" }, conversionOptions: { pdf: { excludeMetadata: true } } })` → texto (teto de 200.000 caracteres). Falha do serviço ou texto com menos de 200 caracteres → documento marcado `unreadable` (na entrega 2 vira gatilho do OCR).
6. **Classificação e extração.** `AVMMatricula.detectDocumentType(texto)` → `extractFields` (matrícula) ou `extractIptuFields` (carnê). Mais de uma matrícula ou mais de um carnê no mesmo e-mail → resposta "um imóvel por e-mail" (recusa determinística; não se tenta adivinhar o par).
7. **Premissa do modelo.** O texto da matrícula precisa conter `apartamento` (`/\bapartamento\b/i`). Não contém → recusa "o modelo cobre apenas apartamentos residenciais". Compra e venda, SFH e SBPE entram como premissa declarada no relatório (não afetam a estimativa; o remetente é informado).
8. **Entradas.** Mesmo objeto `v` que `getInputs()` monta no site: `address` (matrícula; carnê como reserva), `cep`/`cep8` (carnê; matrícula como reserva), `area` (só matrícula), `yearBuilt` e `age = base_year − yearBuilt` (carnê), `pattern` (carnê, código 20–24), `fiscal` (carnê, valor do m² do terreno), `financing:"SFH"`, `funds:"SBPE"`, `declared:true`, `enabledVariables` = as quatro, `documentSource` = `{ fileName: "a.pdf + b.pdf", method: "texto do PDF", addressFound, areaFound, areaLabel, ageFound, patternFound, fiscalFound, cepFromDocument, geocode }`. Campo obrigatório ausente (`area`, `yearBuilt`, `pattern`, `fiscal`, `address`) → resposta "faltou" listando exatamente o quê e de qual documento se esperava.
9. **Bairro.** Uma consulta ao Nominatim (mesmos parâmetros do site; `User-Agent: AVM-SP/1 (avm@heybrain.uk)`; `AbortSignal.timeout(5000)`) para `district`; o CEP do documento prevalece sobre o geocodificado (mesma regra do site desde o PR #23). Falha → `district = ""`, sem erro.
10. **Estimativa.** `AvmReport.estimate(model, v)` (ver 4.2): recusa por domínio → resposta "Recusada" com os mesmos textos que o site mostra; senão `AvmReport.build(...)` → objeto de relatório idêntico ao `latestReport` do site (mesma identificação `AVM-SP-AAAAMMDD-XXXXXXXXXXXX`, mesmo `sha256` das entradas + versão do modelo).
11. **Excel.** `AVMExcel.buildWorkbook(report)` → bytes.
12. **Resposta.** `env.EMAIL.send({...})` (4.4). Falha no envio → log `email_send_failed {status}` e `message.setReject("Falha temporária ao responder. Reenvie em alguns minutos.")`.
13. **Log.** Sempre uma linha: `email_processed { outcome: "report"|"refused"|"incomplete"|"unreadable"|"error", documents, unreadable, ocr_pages, ms }`. Nunca endereço de e-mail, nome de arquivo, endereço do imóvel ou valores.

### 4.2 Componentes

| Arquivo | Papel | Estado |
|---|---|---|
| `site/assets/report.js` (**novo**) | `AvmReport`: `VARIABLE_LABELS`, `patternLabel`, `localSupport`, `riskList`, `estimate(model, v)` → `{ refused: reasons }` ou `{ modelKey, selected, interval, areaUsed, stats, disabled }`, e `build(model, v, computed, timestamp, digest)` → relatório. Tudo movido de `app.js` sem alterar comportamento; `app.js` passa a chamar. Script clássico expondo `globalThis.AvmReport`, como `predict.js`. `index.html` carrega antes de `app.js`. | extraído de `app.js` |
| `src/email.js` (**novo**) | Pipeline puro dos passos 4–11 e composição das respostas: `parseInbound(raw)`, `readDocuments(texts)`, `buildInputs(docs, model)`, `compose(outcome, report|reasons|missing)` → `{ subject, text, html, attachments }`. Recebe `env` só para `AI`/`EMAIL`/`fetch` injetáveis. Importa `../site/assets/{matricula-reader,predict,report,xlsx-export}.js` (efeito colateral em `globalThis`) e `../site/assets/model.json` (JSON module; o wrangler empacota). | novo |
| `src/worker.js` | Ganha `async email(message, env, ctx)` com os passos 1–3, 12–13 e a chamada a `email.js`. `fetch()` intocado. | alterado |
| `wrangler.jsonc` | `"send_email": [{ "name": "EMAIL" }]`, `"ai": { "binding": "AI" }`, `EMAIL_RL` em `ratelimits` (`namespace_id: "1002"`, `simple: { limit: 3, period: 60 }`), `"vars": { "EMAIL_FROM": "avm@heybrain.uk" }`, `"limits": { "cpu_ms": 60000 }` (folga para a entrega 2). | alterado |
| `package.json` | `dependencies: { "postal-mime": "3.0.0" }` (hoje só há `devDependencies`). | alterado |
| segredo `ALLOWED_SENDERS` | `npx wrangler secret put ALLOWED_SENDERS` — itens separados por vírgula; `@dominio.gov.br` autoriza o domínio exato (sem subdomínios), `pessoa@empresa.com.br` autoriza o endereço. Comparação em minúsculas. Fica fora do repositório: identifica o cliente da licitação. | operação do dono |
| regra de roteamento | Dashboard → Email Service → Email Routing → `heybrain.uk` → Routing rules → Create address `avm` → Action **Send to a Worker** → `avm-sp` (ou `npx wrangler email routing rules create`, ver `--help`). **Só depois** de privacidade e termos publicados (4.6). | operação do dono |

### 4.3 O que muda no site

Nada visível. `app.js` encolhe: `calculate()` chama `AvmReport.estimate` e `AvmReport.build`; `riskList`, `localSupport`, `patternLabel` e `VARIABLE_LABELS` saem de `app.js`. `AvmCommon.sha256Hex` continua onde está (usa `crypto.subtle`, que existe no Worker). O Excel (`xlsx-export.js`) não muda. A CSP não muda (script `'self'`).

### 4.4 A resposta

`env.EMAIL.send` com: `to: message.from`; `from: { email: env.EMAIL_FROM, name: "AVM SP" }`; `subject: "Re: " + assunto original` (ou `"AVM SP — estimativa"` se vazio); `headers: { "In-Reply-To": <Message-ID original>, "References": <idem> }` para a resposta cair na mesma conversa; `text` e `html` (HTML mínimo, sem imagens ou CSS externo); em caso de relatório, `attachments: [{ filename: "<id>.xlsx", content: <ArrayBuffer>, type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", disposition: "attachment" }]`.

Corpo quando há relatório (texto; o HTML espelha):

```
AVM SP — estimativa estatística de valor. Não é laudo nem avaliação (NBR 14653-2).

Identificação: AVM-SP-20260908-3F2A9C71B0D4
Imóvel: Rua Vergueiro, 2650 · CEP 04109-002 · Paraíso
Dados usados: área privativa 78 m² (matrícula) · idade 8 anos / 2018 (IPTU) · padrão 2-C (IPTU) · VM2T R$ 6.500/m² (IPTU)
Faixa de 80% de probabilidade: R$ 360.740 a R$ 693.045
Valor central: R$ 500.009 (R$ 6.410/m²)

Documentos lidos: iptu.pdf, matricula.pdf — texto do PDF.
Premissas: apartamento residencial (conforme a matrícula); compra e venda; SFH / SBPE registrados no relatório, sem efeito na estimativa.
Avisos: <cada item de report.risks em uma linha>

O relatório completo está no Excel anexo. Metodologia: https://avm.heybrain.uk/metodologia
Mensagem automática. Os anexos foram processados em memória e não foram armazenados.
```

Corpo quando não há relatório — mesmo cabeçalho, e um destes blocos:

- **Recusada:** "A estimativa foi recusada porque o imóvel está fora do domínio do modelo:" + lista de `reasons[].text` (os mesmos do site) + "Não há relatório."
- **Faltou:** "Não foi possível estimar. Faltou:" + itens como "área privativa (esperada na matrícula)", "ano de construção (esperado no carnê de IPTU)", "nenhum carnê de IPTU identificado entre os anexos" + "Reenvie com os documentos completos, em um único e-mail."
- **Não lido:** "Não foi possível ler: iptu.pdf (sem camada de texto)." — na entrega 1 seguido de "Envie o PDF original digital." (na entrega 2 este caso vira OCR).
- **Ambíguo:** "Foram encontradas 2 matrículas. Envie um imóvel por e-mail."

### 4.5 Erros e limites

| Situação | Resposta | Custo de envio |
|---|---|---|
| Remetente fora da lista, limite, tamanho | `setReject` (bounce SMTP) | nenhum |
| MIME inválido / sem anexo PDF | `send` "Faltou" | 1 e-mail |
| `toMarkdown` falha ou texto curto | `send` "Não lido" (E1) / OCR (E2) | 1 e-mail |
| Campo ausente, ambíguo, não é apartamento, fora do domínio | `send` com a explicação | 1 e-mail |
| `send` falha | `setReject` + log `email_send_failed` | nenhum |
| Exceção não prevista | `try/catch` externo: log `email_processed {outcome:"error"}` (só `error.name`) + `setReject("Erro interno ao processar. Tente novamente.")` | nenhum |

CPU esperada na entrega 1: parse MIME + extração + Excel < 500 ms. Wall-clock: toMarkdown (segundos) + Nominatim (≤ 5 s).

### 4.6 Privacidade mínima que **acompanha** a entrega 1

O canal só é ativado (regra de roteamento) depois de publicado. Texto factual, sem juridiquês, em `site/privacidade.html` (seção nova "Estimativa por e-mail") e `site/termos.html` (parágrafo):

- o que é recebido: a mensagem e os anexos enviados a `avm@heybrain.uk`;
- onde é processado: nos servidores da Cloudflare (Workers), em memória, durante o processamento daquela mensagem; nada é gravado — nem a mensagem, nem os anexos, nem o relatório;
- o que sai: o endereço do imóvel vai ao OpenStreetMap/Nominatim (como no site); na entrega 2, a imagem da página escaneada vai ao Workers AI da Cloudflare para transcrição;
- o que é registrado: linhas técnicas sem dados pessoais (resultado, número de documentos, tempo), por 7 dias;
- quem pode usar: só remetentes previamente autorizados; os demais recebem a mensagem de volta;
- ao enviar, o remetente declara que se trata de apartamento residencial em compra e venda e aceita os termos; a estimativa não é laudo.

O dono valida a base legal (LGPD) desse texto; a spec descreve o que o sistema faz, não a qualificação jurídica.

### 4.7 Testes

`tests/email.test.mjs` (Node puro, como `worker.test.mjs`): importa `src/worker.js`; `env` falso com `EMAIL.send` (grava chamadas), `AI.toMarkdown` (devolve textos sintéticos por nome de arquivo — reusa os do `iptu-reader.test.mjs`), `EMAIL_RL.limit`, `ALLOWED_SENDERS`, `EMAIL_FROM`; `fetch` global substituído para o Nominatim. `message` falso: `{ from, to, headers, raw: ReadableStream de um MIME multipart montado no teste com dois anexos, rawSize, setReject (espião) }`.

Casos: remetente fora da lista → `setReject`, `send` não chamado, corpo não lido; limite → `setReject`; dois PDFs válidos → um `send`, com `.xlsx` anexo cujo tamanho > 0, corpo com `AVM-SP-`, faixa e "texto do PDF", `In-Reply-To` igual ao `Message-ID`; só a matrícula → "Faltou" citando carnê; matrícula sem "apartamento" → recusa; área 300 m² → "Recusada" com o texto de limite do site; texto vazio → "Não lido"; duas matrículas → "um imóvel por e-mail"; `send` rejeita → `setReject`. Mais `tests/report.test.mjs`: `AvmReport.estimate/build` reproduzem o que `parity_fixture.json` espera para um caso, e o `id` é estável para as mesmas entradas e data.

`npm run check` continua o portão: `wrangler deploy --dry-run` no lint prova que `postal-mime` e os imports do site empacotam. Teste manual local: `npx wrangler dev` e `POST http://localhost:8787/cdn-cgi/handler/email?from=…&to=avm@heybrain.uk` com um `.eml` (`Content-Type: message/rfc822`); o wrangler simula o `send_email` localmente e mostra o envio no terminal.

### 4.8 Aceite da entrega 1

- E-mail de remetente autorizado com matrícula + carnê digitais → resposta em menos de 60 s, na mesma conversa, com Excel abrindo no Excel/LibreOffice e `id` igual ao que o site gera para as mesmas entradas.
- Remetente não autorizado → bounce; nada no log além de `email_rejected`.
- Cada caso de 4.4 produz o texto previsto. `npm run check` verde. Privacidade e termos publicados antes da regra existir.

## 5. Entrega 2 — OCR para escaneados via Workers AI

### 5.1 Gatilho

Documento marcado `unreadable` no passo 5 (texto < 200 caracteres ou falha do toMarkdown), **ou** leitor incompleto após o texto (mesma regra do site: `READERS[tipo].complete(fields)` falso) — então as páginas viram imagem e passam pelo modelo; o texto transcrito é **concatenado** ao texto existente e volta aos **mesmos extratores**. Anexos de imagem (`png/jpeg/webp`, ≤ 5 MiB) vão direto ao modelo, sem recodificar.

### 5.2 Componentes

| Arquivo | Papel |
|---|---|
| `src/ocr.js` (**novo**) | `pageImages(pdfBytes, maxPages = 4)`: `unpdf.getDocumentProxy` → por página `extractImages(pdf, n)` → maior imagem da página (escaneado = uma imagem por página; página sem imagem é pulada). `encodePng(image, maxSide = 1600)`: reduz por fator inteiro `f = ceil(max(w, h) / maxSide)` com média de bloco, converte a cinza (luma se `channels` 3/4), grava PNG tipo de cor 0, 8 bits, filtro 0, `IDAT` via `CompressionStream("deflate")` (formato zlib, o que o PNG exige), CRC32 próprio (tabela). Se o PNG passar de 4 MiB, repete com `f + 1`. `transcribe(ai, pngBytes)`: chamada ao modelo (5.3) → texto. |
| `src/email.js` | Passo 5 ganha o ramo OCR; `documentSource.method` vira `"OCR (Workers AI)"` ou `"texto do PDF + OCR (Workers AI)"`, que o relatório e o `riskList` já exibem como leitura automática a conferir. |
| `package.json` | `dependencies: { "unpdf": "1.8.1" }`. |

### 5.3 Modelo

`env.AI.run("@cf/google/gemma-4-26b-a4b-it", { messages: [ { role: "system", content: "Você é um OCR. Transcreva fielmente todo o texto da imagem, em português, preservando rótulos, números, pontuação e a ordem de leitura. Não resuma, não explique, não invente." }, { role: "user", content: [ { type: "text", text: "Transcreva esta página." }, { type: "image_url", image_url: { url: "data:image/png;base64,…" } } ] } ], max_tokens: 4096, temperature: 0, chat_template_kwargs: { enable_thinking: false } })` → `response.response`.

**Primeira tarefa da entrega (spike, meia hora):** confirmar com uma página real que o binding aceita esse formato de imagem para o Gemma 4 — a página do modelo não documenta o campo. Se rejeitar, o modelo passa a ser `@cf/meta/llama-3.2-11b-vision-instruct` (`{ prompt, image: "data:image/png;base64,…" }`, documentado). O formato que funcionar fica registrado num comentário em `src/ocr.js`; o resto da entrega não muda.

### 5.4 Limites e custo

- Até 4 páginas por documento (igual ao site), 2 documentos → ≤ 8 chamadas por e-mail. Cada chamada ≈ 1,5 k tokens de imagem + ≤ 4 k de saída → **menos de US$ 0,002 por página** no Gemma 4.
- CPU: extrair pixels e codificar um PNG cinza de 1600 px ≈ 100–300 ms por página → < 3 s por e-mail; dentro de `cpu_ms: 60000` com folga. Memória: uma página por vez, buffers liberados entre páginas.
- Wall-clock: 5–15 s por página no modelo → um e-mail escaneado completo responde em 1–2 min. Aceitável para o fluxo; informado na privacidade e no manual.
- O texto transcrito passa pelos mesmos regexes; o modelo não decide campo nenhum. Erro de transcrição aparece como campo ausente ("Faltou") ou valor fora do domínio ("Recusada"), nunca como número inventado silenciosamente — e o relatório carimba "OCR (Workers AI)" na origem e nos avisos.

### 5.5 Testes

`tests/ocr.test.mjs`: `encodePng` gera PNG válido para `channels` 1, 3 e 4 (assinatura, `IHDR` com as dimensões reduzidas, CRCs recalculados batem, `IDAT` descomprime com `DecompressionStream("deflate")` para `height × (width + 1)` bytes); redução de 3200 px → 1600 px; `pageImages` num PDF mínimo com `/XObject /Image` `DeviceGray` 8 × 8 sem filtro, gerado no próprio teste (bytes escritos à mão, como o `mkpdf` usado nos testes manuais do PR #23) → uma imagem 8 × 8. `tests/email.test.mjs` ganha o caso "PDF sem texto + `AI.run` falso devolve o texto do carnê → relatório com `method` OCR e aviso correspondente". O spike de 5.3 é manual (`wrangler dev --remote` ou deploy de preview) e seu resultado entra no comentário do código.

### 5.6 Aceite da entrega 2

Carnê escaneado real (dos que o dono vai colocar em `testes/`) + matrícula digital → relatório com os quatro campos; `documentSource.method` cita OCR; custo por e-mail visível no dashboard do Workers AI abaixo de US$ 0,02. Página em branco ou ilegível → "Faltou" ou "Não lido", nunca número inventado.

## 6. Entrega 3 — privacidade, termos, documentação, manual

| Onde | O quê |
|---|---|
| `site/privacidade.html` | Completar a seção da entrega 1 com o OCR (imagem da página → Workers AI da Cloudflare, sem retenção pelo serviço) e o tempo de resposta. |
| `site/termos.html` | Parágrafo do canal por e-mail: mesmas condições do site; envio = declaração de apartamento residencial em compra e venda; não é laudo. |
| `DEPLOY.md` | Diagrama da seção 3; linhas novas na tabela de decisões (mesmo Worker, sem estado, lista de remetentes, Workers AI); "Segurança e privacidade" passa a distinguir **site** (tudo no navegador) de **e-mail** (processamento em memória na Cloudflare); "Custo" ganha Paid, Email Sending (3.000/mês inclusos, depois US$ 0,35/1.000) e Workers AI (por token). |
| `RUNBOOK.md` | Seção "Estimativa por e-mail": criar/desligar a regra de roteamento; `wrangler secret put ALLOWED_SENDERS` (formato, como adicionar/remover remetente); teste local com `.eml`; o que procurar em Workers Logs (`event: email_*`); como responder a "não recebi resposta" (log → `outcome`); como desativar o canal em um passo (desabilitar a regra). |
| `tools/manual-pdf.html` → `site/manual-avm-sp-v7.pdf` e imagens | Capítulo "Envio por e-mail": endereço, o que anexar (matrícula digital + carnê; um imóvel por e-mail), o que volta e em quanto tempo, o que fazer com cada mensagem de erro, aviso de que OCR exige conferência. Regeneração via `scripts/render-manual.sh` **exige Chromium** — não há nesta máquina; roda na máquina do dono ou num contêiner. |
| `README.md` | Uma linha na tabela de documentos e no layout (`src/email.js`, `src/ocr.js`, `site/assets/report.js`). |

Aceite: textos publicados; `/manual` mostra o capítulo novo; RUNBOOK permite a outra pessoa ativar, testar e desligar o canal sem perguntar nada.

## 7. Segurança

- **Fronteira de confiança:** o e-mail inteiro é entrada hostil. Ordem barato→caro; nada é lido antes de o remetente passar. Só `message.from` (envelope) autoriza — `From`, `Reply-To` e o corpo não valem para nada.
- **Anexos:** só PDF (e imagens na entrega 2) por `mimeType`/extensão; ≤ 6 anexos, ≤ 10 MiB cada; o parse do PDF acontece no serviço `toMarkdown` (fora do isolate) e, na entrega 2, no `unpdf` com teto de 4 páginas e imagem por página. Nenhum byte de anexo volta na resposta.
- **Resposta:** só para `message.from`; `send_email` sem `destination_address` fixo porque o destinatário varia, mas o remetente já foi autorizado. Excel anexo ≤ 5 MiB (limite da saída); hoje ~50 KB.
- **Sem retenção:** nenhum binding de armazenamento; `ctx.waitUntil` não é usado para gravar nada. Logs sem e-mail, nome de arquivo, endereço, valores ou SQL.
- **Segredos:** `ALLOWED_SENDERS` via `wrangler secret`, nunca em `vars` nem no repositório.
- **Abuso:** lista de remetentes + `EMAIL_RL` (3/min por remetente) + tetos de tamanho; um remetente comprometido custa no pior caso 3 e-mails/min × custo de OCR (≈ US$ 0,02) até o dono removê-lo da lista.
- **CSP, `_headers`, tipografia, Excel e Nominatim do site:** intocados.

## 8. Custo mensal estimado

Workers Paid já pago. Por e-mail: 1 envio (3.000/mês inclusos), CPU < 1 s (30 M ms inclusos), 0–8 chamadas de OCR (< US$ 0,02). Mil e-mails/mês com metade escaneada: **≈ US$ 10 além do plano.** Sem OCR: zero além do plano.

## 9. Ordem e dependências

1. Mergear PR #23 (extratores) — pré-requisito de tudo.
2. **E1** em uma PR: `report.js` + `email.js` + `worker.js` + `wrangler.jsonc` + testes + privacidade/termos mínimos. Depois do merge: dono cria o segredo e a regra; teste real com um e-mail do próprio dono na lista.
3. **E2** em uma PR: spike do modelo → `ocr.js` + ramo OCR + testes. Depende dos carnês escaneados reais em `testes/` para o aceite.
4. **E3** em uma PR (docs e manual). Pode começar em paralelo à E2; o manual só fecha com o Chromium do dono.

Regras do repositório valem: branch + PR, `npm run check` verde, merge em `main` publica; nada de tag sem ok.
