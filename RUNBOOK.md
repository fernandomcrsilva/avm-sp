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

Caminho normal: **pull request → preview → merge → tag**. Nada sai da máquina local para produção.

1. Branch + PR para `main`. O CI (`.github/workflows/ci.yml`, job `check`) roda build, lint, validador do `model.json`,
   paridade Python↔JS, limites e orçamento de tamanho. O PR não tem acesso ao token da Cloudflare.
2. Merge em `main` (só com `check` verde; a branch não aceita push direto nem force-push). O push em `main` roda o job
   `preview`: `wrangler versions upload` e a URL `https://<id>-avm-sp.heybrain.workers.dev` no resumo do run
   (Actions → ci → o run do merge → Summary). Produção não muda; confira o preview antes da tag.
3. Produção: crie e envie uma tag `vX.Y.Z` (ou dispare o workflow manualmente em Actions → ci → Run workflow, só em `main`).
   O job `deploy` recusa tag fora do formato `vX.Y.Z` e commit que não esteja em `main`; depois faz
   `versions upload --tag vX.Y.Z` e `versions deploy <id>@100%`, espera a propagação (~1 min)
   e confere que `/version.json` traz o SHA do commit.

```bash
git tag v1.0.0 && git push origin v1.0.0
```

Segredo necessário: `CLOUDFLARE_API_TOKEN` como **environment secret** de `production` (Settings → Environments → production),
cujos *deployment branches and tags* são `main` e `v*`. Os jobs `preview` e `deploy` usam `environment: production`; o job `check`
(o único que roda em PR) não vê o token. No CI ele só existe no `env:` dos passos do wrangler; o build e o `npm ci --ignore-scripts` rodam sem ele.
Não deixe cópia em Settings → Secrets and variables → Actions.
Token criado no dashboard da Cloudflare com permissão **Account → Workers Scripts → Edit** (+ Account Settings → Read), restrito à conta HeyBrain!,
validade de 1 ano: **rotacionar até 2027-09-07** (criar novo, `gh secret set CLOUDFLARE_API_TOKEN`, revogar o antigo).
Nunca commitar o token; nunca colar em log.

Mudanças em **triggers** (rota, Custom Domain, cron) não entram por `versions deploy`: rode `npx wrangler triggers deploy`
(ou `npx wrangler deploy`) uma vez, localmente, com autorização explícita. Foi assim que `avm.heybrain.uk` foi criado.

## Reverter

Toda versão enviada fica guardada. Reverter é apontar 100% do tráfego para uma versão anterior:

```bash
npx wrangler versions list                      # ache o id da última versão boa (tag/mensagem ajudam)
npx wrangler versions deploy <id-anterior>@100% -y
curl -s https://avm.heybrain.uk/version.json    # confirme git_sha/model_version (até ~1 min para propagar)
```

Testado em 2026-09-07: `versions deploy dd6e835c@100%` → `/version.json` voltou ao SHA anterior em ~75 s; `versions deploy f27111ae@100%` restaurou a v1.0.0.

Atalho equivalente: `npx wrangler rollback` (interativo; escolhe uma implantação anterior). Depois de reverter,
corrija em PR e publique por tag normalmente. Não há banco nem estado: reverter o Worker reverte tudo.

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
6. Confira `/metodologia` no preview: períodos, amostra, MAPE, cobertura e limites vêm todos do `model.json`.
7. PR → preview → merge → tag. O `og-image.png` e os textos não têm números do modelo; não precisam mudar.

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

## Observabilidade

- Workers Logs (retenção de 3 dias no plano Free; confira no dashboard se o plano mudar): dashboard → Workers & Pages → avm-sp → Logs. Avisos do front chegam como
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
