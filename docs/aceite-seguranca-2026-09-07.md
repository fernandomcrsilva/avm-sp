# Aceite de segurança — 2026-09-07

Fechamento da [auditoria de 2026-09-07](security-audit-2026-09-07.md) (nota 86/100; 7 MEDIUM, 8 LOW, 13 INFO).
Tudo o que era corrigível em código entrou por quatro PRs em `main`, cada um com `npm run check` local e o job `check` verdes:

| PR | Escopo | Commit em `main` |
|---|---|---|
| [#5](https://github.com/fernandomcrsilva/avm-sp/pull/5) | CI endurecido | `eec5729` |
| [#11](https://github.com/fernandomcrsilva/avm-sp/pull/11) | Worker `/api/erro` | `5e8186d` |
| [#12](https://github.com/fernandomcrsilva/avm-sp/pull/12) | Modelo e limites | `2492f27` |
| [#13](https://github.com/fernandomcrsilva/avm-sp/pull/13) | Proveniência e higiene | `073e48c` |

Estados: **corrigido** (código em `main`), **pendente do usuário** (só se faz no GitHub/Cloudflare), **corrigido + pendente** (as duas partes).
Os comandos de verificação rodam na raiz do repositório; os que citam `avm.heybrain.uk` valem depois do deploy da tag.

## Médias

| Achado | Estado | PR | Verificação |
|---|---|---|---|
| VULN-001 `ref_name` no shell | corrigido | #5 | `grep -nE 'REF: |"\$REF" =~' .github/workflows/ci.yml` → `env: REF` e a regex `^v[0-9]+\.[0-9]+\.[0-9]+$` antes do `wrangler versions upload --tag "$REF"`. |
| VULN-002 token no job de PR | corrigido + pendente | #5 | `grep -nE 'ignore-scripts|CLOUDFLARE_API_TOKEN' .github/workflows/ci.yml` (token só em `env:` dos passos do wrangler; `npm ci --ignore-scripts` nos jobs `preview` e `deploy`); `grep -c '"build"' wrangler.jsonc` → `0`. Depois: job `preview` só em push para `main` com `environment: production` (PR nunca vê o token). **Usuário**: criar o environment secret e apagar o repository secret. |
| VULN-003 deploy de qualquer commit | corrigido + pendente | #5 | `grep -nE 'fetch-depth|merge-base|refs/heads/main' .github/workflows/ci.yml`. **Usuário**: ruleset de tags `v*` e *deployment branches and tags* no environment. |
| VULN-004 `model.json` editado à mão passa | corrigido | #12 | `npm test` (parity exige `reference: "sklearn"`); `sha256sum site/assets/model.json` = `jq -r .model_sha256 tests/parity_fixture.json` = `curl -s https://avm.heybrain.uk/version.json \| jq -r .model_sha256` = valor exibido em `/metodologia`. |
| VULN-005 `/api/erro` sem limite | corrigido | #11 | `npm test` (`tests/worker.test.mjs`); em produção: `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -H 'Sec-Fetch-Site: same-origin' --data '{"kind":"js_error"}' https://avm.heybrain.uk/api/erro` → `204`; sem `Sec-Fetch-Site` → `403`; `-H 'Content-Type: text/plain'` → `415`; `-X GET` → `405`; a mesma chamada em `https://avm-sp.heybrain.workers.dev/api/erro` → `404`; 6ª chamada válida no mesmo minuto → `429`. |
| VULN-006 resumo com variável desabilitada | corrigido | #12 | No site: desmarque "Idade" → resumo mostra "não usada nesta estimativa (variável desabilitada)" e domínio "modelo reduzido (sem Idade)"; desmarque "Área construída" → sem valor unitário; Excel sem célula `null`/`NaN`. Verificado no `wrangler dev` em 2026-09-07. |
| VULN-007 vendor sem proveniência | corrigido | #13 | `cd site/assets/vendor && sha256sum --strict -c SHA256SUMS` (também no job `check`). Comparação com `npm pack` dos 4 pacotes: 14 de 14 arquivos idênticos. |

## Baixas

| Achado | Estado | PR | Verificação |
|---|---|---|---|
| VULN-008 actions por tag mutável | corrigido | #5 | `grep -cE 'uses: actions/[a-z-]+@[0-9a-f]{40} # v' .github/workflows/ci.yml` → `7`. |
| VULN-009 `GITHUB_TOKEN` largo | corrigido | #5 | `grep -nA2 '^permissions' .github/workflows/ci.yml .github/workflows/uptime.yml` → `contents: read` no workflow, `pull-requests: write` só no job `preview`, `permissions: {}` no uptime. |
| VULN-010 `#declared` pré-marcado | corrigido | #12 | `grep -c 'id="declared" type="checkbox" checked' site/index.html` → `0`; no site, a carga inicial mostra "Aguardando confirmação" e o exemplo é "Rua Exemplo, 100". |
| VULN-011 `price_m2_brl` não verificado | corrigido | #12 | `npm test` (caso "preço por m² só é verificado com a área habilitada" em `tests/limits.test.mjs`). |
| VULN-012 canvas de OCR sem teto | corrigido | #12 | `grep -n '25e6' site/assets/matricula-reader.js`. |
| VULN-013 dados de terceiros em `docs/v7` | corrigido | #13 | `grep -cE 'pdfs/[0-9]{13}|hosting\.json  |chatgpt\.site|edurs1957' docs/v7/*` → `0` em todos (os nomes de pasta `testes/` e `.openai/` continuam citados no texto; o que saiu foram os 20 números de matrícula, o hash do `hosting.json` e a URL com handle). |
| VULN-014 sem Dependabot | corrigido + pendente | #5 | `.github/dependabot.yml` (npm, pip, github-actions); o Dependabot já abriu os PRs #6 a #9. **Usuário**: ativar Dependabot alerts. |
| VULN-015 `requirements.lock` sem hashes | corrigido | #13 | `uv pip install --python .venv/bin/python --require-hashes --dry-run -r requirements.lock` → "Would make no changes". |

## Informativos

| Item | Estado | PR |
|---|---|---|
| `<option>` sem escape → `new Option` | corrigido | #12 |
| beacon `ocr_failed` envia só `error.name` | corrigido | #11 |
| retenção do Workers Logs = 3 dias (wrangler.jsonc, RUNBOOK, DEPLOY) | corrigido + pendente (confirmar no dashboard) | #13 |
| `shell: bash` (pipefail) nos passos com pipe | corrigido | #5 |
| `.gitignore`: `.dev.vars.*`, `*.pem`, `*.key`, `.npmrc` | corrigido | #13 |
| identificação do resumo = sha256(entradas + versão)[0:12] | corrigido | #12 |
| `Array.isArray` na resposta do Nominatim | corrigido | #12 |
| `npx lighthouse@12.8.2` no RUNBOOK | corrigido | #13 |
| LICENSE Apache-2.0 em `tessdata-4.0.0_best_int/` | corrigido | #13 |
| `cep4_stats` sem grupos n<5 (retreinado; só `cep4_stats` mudou) | corrigido | #13 |
| HSTS `max-age=15552000` em `/*` do `_headers` | corrigido | #13 |
| `--no-sandbox` no script de imagens | corrigido | #13 |
| domínio já expirou uma vez | pendente do usuário | — |

Não feito, de propósito: o job opcional que retreina em tag (VULN-004) fica fora, conforme a regra "o CI não retreina" do aceite de 2026-09-07.

## Só o dono do repositório faz

1. GitHub → Settings → Environments → `production`: required reviewers; *deployment branches and tags* = `main` e `v*`; mover `CLOUDFLARE_API_TOKEN` para environment secret (e remover o repository secret).
2. GitHub → Settings → Rules: ruleset de tags `v*` restrito a administradores.
3. GitHub → Settings → Code security: ativar Dependabot alerts. Decidir os PRs #6 a #9 do Dependabot (majors das actions e wrangler 4.129.0).
4. Cloudflare → Workers & Pages → avm-sp → Logs: confirmar a retenção real no plano atual (o código assume 3 dias).
5. Cloudflare → Billing: segundo método de pagamento para a renovação do `heybrain.uk` (vence 2027-08-29).

## Publicação

Publicado em 2026-09-07 com ok explícito do dono:

- `v1.0.2` foi criada em `6069e66` (merge do #10), antes dos merges de #12, #13 e #14; o CI a implantou (o commit está em `main`).
- `v1.0.3` em `8a7f37b` (`main` completa) substituiu a anterior; `versions deploy` 100% e `/version.json` conferido pelo job `deploy`.

Conferido em produção depois da `v1.0.3`: `git_sha 8a7f37b…`, `model_sha256 bc5f566f…` igual ao `sha256sum site/assets/model.json`
e à fixture de paridade; cabeçalhos CSP, HSTS, `nosniff`, Referrer-Policy, Permissions-Policy, COOP e CORP presentes em `/`;
`/api/erro` → 204 (same-origin JSON), 403 (sem `Sec-Fetch-Site`), 415 (`text/plain`), 405 (GET), 404 em `avm-sp.heybrain.workers.dev`;
HTML publicado sem `#declared` pré-marcado; `/metodologia` com o campo do SHA-256; `SHA256SUMS` servido em `/assets/vendor/`.

Comandos usados:

```bash
curl -s https://avm.heybrain.uk/version.json                       # git_sha da tag e model_sha256
curl -sI https://avm.heybrain.uk/ | grep -iE 'content-security|strict-transport|x-content|referrer|permissions|cross-origin'
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -H 'Sec-Fetch-Site: same-origin' --data '{"kind":"js_error"}' https://avm.heybrain.uk/api/erro   # 204
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' --data '{"kind":"js_error"}' https://avm.heybrain.uk/api/erro   # 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: text/plain' -H 'Sec-Fetch-Site: same-origin' --data '{"kind":"js_error"}' https://avm.heybrain.uk/api/erro   # 415
curl -s -o /dev/null -w '%{http_code}\n' https://avm.heybrain.uk/api/erro   # 405
```
