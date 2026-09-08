# RUNBOOK — AVM SP (avm.heybrain.uk)

Site estático em Cloudflare Workers Static Assets + um Worker mínimo (`src/worker.js`, só `POST /api/erro`).
Repositório: https://github.com/fernandomcrsilva/avm-sp · Worker: `avm-sp` (conta HeyBrain!) · Produção: https://avm.heybrain.uk · Preview: `*.avm-sp.heybrain.workers.dev` (noindex).

## O que está no ar

```bash
curl -s https://avm.heybrain.uk/version.json   # git_sha, built_at, model_version, model_trained_at, model_sha256
npx wrangler deployments list                   # versão ativa e histórico
npx wrangler versions list                      # versões enviadas (com tag/mensagem)
```

## Publicar

Caminho normal: **pull request → check verde → merge em `main`**. O merge publica: o Cloudflare Workers Builds
está ligado ao repositório e roda `npm run build` + `npx wrangler deploy` a cada push em `main`.
Nada sai da máquina local para produção.

1. Branch + PR para `main`. O CI (`.github/workflows/ci.yml`, job `check`) roda build, lint, validador do `model.json`,
   paridade Python↔JS, limites e orçamento de tamanho. É o único portão: depois do merge, vai para o ar.
2. Merge em `main` (só com `check` verde; a branch não aceita push direto nem force-push).
3. Acompanhe o build em Cloudflare → Workers & Pages → `avm-sp` → Deployments (etapas Initializing, Cloning,
   Installing, Building, Deploying). Leva ~35 s.
4. Confira o que está no ar:

```bash
curl -s https://avm.heybrain.uk/version.json   # git_sha deve ser o do merge
```

O `wrangler deploy` do Workers Builds aplica também os **triggers** (rota, Custom Domain, cron), ao contrário do
antigo `versions deploy`.

O CI não tem mais acesso à Cloudflare: os jobs `preview` e `deploy` saíram do workflow em 2026-09-08, junto com o
uso do `CLOUDFLARE_API_TOKEN`. O environment secret `production` ficou sem uso — revogue o token na Cloudflare e
remova o secret quando confirmar que nada mais depende dele. O build da Cloudflare usa a própria credencial da conta.

Versionamento: as tags `vX.Y.Z` deixaram de disparar deploy. Continuam úteis para marcar releases no histórico,
se você quiser, mas não são mais o caminho de produção.

## Reverter

Toda versão enviada fica guardada. Reverter é apontar 100% do tráfego para uma versão anterior:

```bash
npx wrangler versions list                      # ache o id da última versão boa (tag/mensagem ajudam)
npx wrangler versions deploy <id-anterior>@100% -y
curl -s https://avm.heybrain.uk/version.json    # confirme git_sha/model_version (até ~1 min para propagar)
```

Testado em 2026-09-07: `versions deploy dd6e835c@100%` → `/version.json` voltou ao SHA anterior em ~75 s; `versions deploy f27111ae@100%` restaurou a v1.0.0.

Atalho equivalente: `npx wrangler rollback` (interativo; escolhe uma implantação anterior). Depois de reverter,
corrija em PR: o merge em `main` publica de novo. Não há banco nem estado: reverter o Worker reverte tudo.

Gradual (canário): `npx wrangler versions deploy <nova>@10% <atual>@90% -y`, depois ajuste os percentuais.

## Atualizar o modelo (nova base de ITBI ou nova PGV)

1. Baixe a planilha oficial e o PDF dos anexos da PGV para `data/raw/` (pasta fora do git). URLs oficiais em
   `data/sources.lock.json`. Se a Prefeitura publicou arquivo novo, a URL muda (tem data no caminho).
2. Atualize `data/sources.lock.json`: `download_url`, `published` e o novo `sha256` (`sha256sum data/raw/<arquivo>`).
   O treino **recusa** rodar com hash divergente; isso é proposital.
3. Se a janela de datas, o ano-base ou os limites mudarem, ajuste `LIMITS`, `BASE_YEAR` e `REFERENCE_DATE` em
   `train_model.py`. A `version` do modelo também está lá.
4. Treine no ambiente fixado (`requirements.lock`, Python 3.12):
   ```bash
   uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python --require-hashes -r requirements.lock
   .venv/bin/python train_model.py --trained-at AAAA-MM-DD
   ```
   O `requirements.lock` vem de `uv pip compile --python-version 3.12 --generate-hashes requirements.in -o requirements.lock`;
   para subir uma versão, edite `requirements.in` e recompile. Grupos de CEP com menos de 5 transações não entram em `cep4_stats`.
   Saída: `site/assets/model.json` e `tests/parity_fixture.json` (referência scikit-learn). O teste de paridade **exige**
   a fixture do scikit-learn com o sha256 do `model.json`: um `model.json` editado à mão, ou uma fixture "formula" de
   `scripts/parity_fixture.py`, reprova no CI (VULN-004). O sha256 vai para `/version.json` e para `/metodologia`.
5. `npm run check` (validador com faixas sãs, paridade 1e-9, build). Se o validador reprovar métricas, não publique.
6. Confira `/metodologia` localmente (`python3 -m http.server --directory site`): períodos, amostra, MAPE, cobertura e limites vêm todos do `model.json`.
7. PR → check verde → merge: o merge publica. O `og-image.png` e os textos não têm números do modelo; não precisam mudar.

## Atualizar o vendor (pdf.js, tesseract.js, core WASM, idioma)

Os arquivos em `site/assets/vendor/` são cópias exatas de pacotes do npm; `site/assets/vendor/SHA256SUMS` diz de qual
pacote e arquivo cada um veio, e o CI (`sha256sum -c`) reprova qualquer divergência (VULN-007). Para atualizar:

```bash
cd "$(mktemp -d)" && npm pack pdfjs-dist@<ver> tesseract.js@<ver> tesseract.js-core@<ver> @tesseract.js-data/por@<ver>
for t in *.tgz; do mkdir "${t%.tgz}" && tar -xzf "$t" -C "${t%.tgz}"; done   # copie os arquivos listados no SHA256SUMS
```
Depois, no repositório: renomeie os diretórios versionados (`tesseract-core-<ver>/`, `tessdata-…/`) e as referências em
`matricula-reader.js`, atualize as versões no cabeçalho (linhas `#`) do `SHA256SUMS` e regenere as linhas de hash:

```bash
cd site/assets/vendor && { grep '^#' SHA256SUMS; find . -type f ! -name SHA256SUMS | sort | sed 's#^\./##' | xargs sha256sum; } > SHA256SUMS.new && mv SHA256SUMS.new SHA256SUMS && sha256sum --strict -c SHA256SUMS
```
Teste o OCR no navegador (`npx wrangler dev --assets <cópia do dist> --port 8788` com um PDF) antes do PR.

## Configurações da zona que importam (heybrain.uk)

- SSL/TLS **Full (strict)**, Always Use HTTPS **on**, TLS mínimo **1.2**, HSTS **on** (180 dias, sem preload).
- **Bot Fight Mode desligado** e JavaScript Detections desligado. Se religar, a Cloudflare injeta script inline
  bloqueado pela CSP: erro de console e Lighthouse Boas Práticas cai para 93. Block AI Bots continua ligado.
- Rate limit `freio-de-custo-api`: bloqueia `/api/*` acima de 100 req/10 s por IP (vale para `/api/erro`, mas só no domínio).
- `_headers` só vale para respostas de assets; as do Worker (`/api/erro`) trazem cabeçalhos no código.
- `/api/erro` (no código, vale também em `*.workers.dev`): só `avm.heybrain.uk` (404), só `POST` (405), só `Sec-Fetch-Site: same-origin` (403),
  só `Content-Type: application/json` (415), `Content-Length` obrigatório e ≤ 2048 (413), 5 avisos/min por IP pelo binding
  `ERRO_RL` do `wrangler.jsonc` (429). Teste local: `npx wrangler dev` e os `fetch` listados em `docs/aceite-seguranca-*.md`.

## Estimativa por e-mail (avm@heybrain.uk)

Handler `email()` em `src/worker.js`; pipeline em `src/email.js`; spec em `docs/superpowers/specs/2026-09-08-email-avm-design.md`.

Sem o segredo `ALLOWED_SENDERS`, **todo** e-mail é recusado — é o estado do Worker logo depois do merge, antes do passo 1.

**Ativar (uma vez, depois de privacidade e termos publicados):**
1. Remetentes autorizados: `npx wrangler secret put ALLOWED_SENDERS` e colar a lista separada por vírgulas — `@orgao.sp.gov.br` autoriza o domínio exato (sem subdomínios), `pessoa@empresa.com.br` autoriza o endereço. Sem espaços obrigatórios; maiúsculas não importam.
2. Regra de roteamento: Dashboard → Compute & AI → Email Service → Email Routing → `heybrain.uk` → Routing rules → Create address `avm` → Action **Send to a Worker** → `avm-sp`. (Equivalente: `npx wrangler email routing rules create --help`.)
3. Teste real: de um endereço que esteja na lista, mandar um e-mail com uma matrícula e um carnê digitais; a resposta chega na mesma conversa em menos de um minuto, com o `.xlsx`.
4. Conferir no Workers Logs a linha de invocação desse e-mail real: se ela trouxer o endereço do remetente, desligar `invocation_logs` no `wrangler.jsonc` ou ajustar o texto da privacidade antes de liberar o canal — a página afirma que só ficam linhas técnicas sem dados pessoais.

**Trocar remetentes:** repetir `wrangler secret put ALLOWED_SENDERS` com a lista nova (substitui a anterior; vale no próximo e-mail).

**Desligar o canal:** desabilitar a regra `avm` no dashboard. O Worker continua no ar para o site.

**Teste local:** `npx wrangler dev` (preview `wrangler-dev`) com `ALLOWED_SENDERS=@exemplo.gov.br` em `.dev.vars`, e `curl --request POST 'http://localhost:8787/cdn-cgi/local/email' --url-query 'from=teste@exemplo.gov.br' --url-query 'to=avm@heybrain.uk' --data-binary @teste.eml` (corpo RFC 5322 com `Message-ID`). O `send_email` é simulado no terminal; anexos binários não aparecem no simulador — o Excel é coberto por `tests/email.test.mjs`.

**Ler o que aconteceu:** Workers Logs, filtrar `event: email_*`. `email_rejected` (`reason`: unauthorized / ratelimit / too_large) não abre o e-mail; `email_processed` traz `outcome` (report / refused / missing / unreadable / ambiguous / error), `documents`, `unreadable`, `ms`; `email_send_failed` = resposta não saiu e o remetente recebeu bounce. Nenhuma linha traz endereço, arquivo ou valores. "Não recebi resposta" → procurar o `outcome`; se não há linha, o e-mail não chegou ao Worker (regra desligada ou MX). `ocr_pages` > 0 indica que houve transcrição; `unreadable` conta documentos que nem o OCR leu.

**Limites:** 3 e-mails por minuto por remetente; 20 MB por mensagem; 6 anexos de até 10 MB (PDF, PNG, JPEG ou WebP). PDF com camada de texto é lido direto; escaneado ou imagem passa por OCR no Workers AI (até 4 páginas por documento e 8 por e-mail, ~1–2 min de resposta). Custo do OCR: da ordem de US$ 0,002 por página no Gemma 4 — acompanhar em Compute & AI → Workers AI no dashboard.

## Observabilidade

- Workers Logs (retenção de 7 dias no plano Paid; confira no dashboard se o plano mudar): dashboard → Workers & Pages → avm-sp → Logs. Avisos do front chegam como
  `{"event":"front_error","kind":...}` com `kind` em `model_load_failed | js_error | unhandled_rejection | ocr_failed | refused`.
  Nunca contêm dados do imóvel; em `refused` só o código do limite.
- Uptime: `.github/workflows/uptime.yml` a cada 30 min (falha = e-mail do GitHub). Rodar à mão: Actions → uptime → Run workflow.
- Lighthouse local: `CHROME_PATH=~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome npx lighthouse@12.8.2 https://avm.heybrain.uk/ --form-factor=mobile --screenEmulation.mobile --throttling-method=simulate`.

## Desenvolvimento local

```bash
npm ci && npm run check          # tudo que o CI roda (o build vem primeiro: o wrangler não constrói mais o dist/)
npx wrangler dev                 # http://localhost:8787 com _headers, 404 e /api/erro reais
```
Não rode `npm run build` (nem `check`) com o `wrangler dev` aberto: o `dist/` é apagado e recriado e o servidor passa a responder 500.
Reinicie o `wrangler dev`. Para servir um arquivo extra em teste (ex.: PDF de matrícula), copie `dist/` para fora e use
`npx wrangler dev --assets <cópia> --port 8788`.

## Domínio

`heybrain.uk` é registrado na Cloudflare (Registrar) com renovação automática; expira em 2027-08-29. Em 2026-08 a
renovação falhou por pagamento e o domínio ficou 10 dias vencido sem ninguém notar. Confira o método de pagamento
antes de agosto e o e-mail de aviso da Cloudflare.
