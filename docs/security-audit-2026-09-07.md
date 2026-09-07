# Auditoria de segurança — 2026-09-07

Nota geral 86/100 (B). Critical 0 · High 0 · Medium 7 · Low 8 · Info 13. Escopo: todo o código próprio em `main` (`0f353c5`, v1.0.1).
Método: 8 agentes especialistas (vulnerabilidades, autorização, segredos, dependências, IaC/CI, ameaças, código IA, lógica),
OWASP Top 10:2021, CWE Top 25, STRIDE, MITRE ATT&CK. Nenhum segredo em 24 commits; nenhum indicador de código malicioso;
nenhuma dependência suspeita em 105 pacotes; nenhum prompt injection no repositório.

| Categoria | Nota | Peso |
|---|---|---|
| Vulnerabilidades | 94 | 20% |
| Autorização e acesso | 65 | 15% |
| Segredos | 96 | 10% |
| Dependências | 86 | 10% |
| IaC e CI | 81 | 10% |
| Inteligência de ameaças | 98 | 15% |
| Código gerado por IA | 96 | 10% |
| Lógica e desenho | 66 | 10% |

## Médias

**VULN-001 · `${{ github.ref_name }}` interpolado em `run:` do job `deploy`** — CWE-78 — `.github/workflows/ci.yml:94`.
Nome de tag vira shell com `CLOUDFLARE_API_TOKEN` no ambiente. Fix: `env: { REF: "${{ github.ref_name }}", SHA: "${{ github.sha }}" }`,
validar `[[ "$REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]`, usar `"$REF"`/`"$SHA"` no comando.

**VULN-002 · Token de produção (escopo de conta) exposto ao job `preview`, que executa código do PR** — CWE-269/668 — `ci.yml:49-68`, `wrangler.jsonc:8`.
`npm ci` roda lifecycle scripts do PR; `versions upload` executa `build.command` (build.mjs da branch do PR) com o token no `env` do job.
Fix no código: `npm ci --ignore-scripts` nos jobs com token; remover `build.command` do wrangler.jsonc e rodar `npm run build` num passo sem token;
token só no `env:` do passo do wrangler. Fix no GitHub (usuário): segredo como *environment secret*; `environment: preview` com aprovador
ou preview só em push para `main`.

**VULN-003 · Produção por tag `v*` em qualquer commit ou `workflow_dispatch` em qualquer branch** — CWE-284/863 — `ci.yml:76`.
Fix no código: `actions/checkout` com `fetch-depth: 0` e `git merge-base --is-ancestor "$GITHUB_SHA" origin/main` antes do upload;
dispatch só se `github.ref == 'refs/heads/main'`. Fix no GitHub (usuário): ruleset de tags `v*` restrito a admins; ambiente `production`
com *deployment branches and tags* = `main`, `v*` e aprovador obrigatório.

**VULN-004 · `model.json` editado à mão passa no CI** — CWE-345 — `tests/parity.test.mjs:17-36`, `scripts/parity_fixture.py:76-84`.
A paridade aceita `reference: "formula"` gerada do próprio model.json. Fix: `assert.equal(fixture.reference, "sklearn")` no teste;
publicar `model_sha256` em `version.json` (build.mjs) e na metodologia. Opcional: job em tag que baixa fontes, confere hashes, retreina e exige model.json idêntico.

**VULN-005 · `/api/erro` sem limite efetivo e validação tardia** — CWE-770/346/400/117 — `src/worker.js:17-39`, `wrangler.jsonc`.
`*.workers.dev` não passa pelo rate limit da zona; corpo lido antes do teto; sem `Content-Type`/`Sec-Fetch-Site`; `message` livre no log.
Fix: antes de ler o corpo → `url.hostname !== "avm.heybrain.uk"` → 404; `sec-fetch-site !== "same-origin"` → 403; `content-type` não JSON → 415;
`content-length` ausente ou > 2048 → 413; remover caracteres de controle de `message`/`source`; Rate Limiting binding do Workers
(`"ratelimits": [{ "name": "ERRO_RL", "namespace_id": "1001", "simple": { "limit": 5, "period": 60 } }]`, chave `cf-connecting-ip`) → 429.

**VULN-006 · Variável desabilitada gera resumo "Dentro do domínio" com atributo fora do domínio e R$/m² derivado dele** — CWE-451 — `site/assets/app.js:247-302`, `site/assets/xlsx-export.js:149-166`, `site/index.html:123`.
Fix: em `latestReport.property` marcar atributos de variáveis desabilitadas como "não usada" (não imprimir valor); `pricePerM2` só com `area` habilitada;
`scope` = "modelo reduzido (sem X)" quando houver variável desabilitada; nunca renderizar NaN (resumo e Excel).

**VULN-007 · Vendor sem manifesto de proveniência nem verificação no CI** — CWE-494/1357 — `site/assets/vendor/`, `ci.yml`, `RUNBOOK.md`.
Fix: gerar `site/assets/vendor/SHA256SUMS` a partir de `npm pack pdfjs-dist@5.6.205 tesseract.js@7.0.0 tesseract.js-core@7.0.0 @tesseract.js-data/por@1.0.0`
(comparar com os arquivos atuais e registrar o resultado), `sha256sum -c` no job `check`, seção "atualizar vendor" no RUNBOOK.

## Baixas

- **VULN-008** Actions por tag mutável — CWE-829 — `ci.yml:26-29,57-58,85-86`. Fixar por SHA completo com versão em comentário; subir para checkout v5, setup-node v5, setup-python v6.
- **VULN-009** `GITHUB_TOKEN` com `pull-requests: write` em todos os jobs; `uptime.yml` sem `permissions` — CWE-250. Workflow `permissions: { contents: read }`; job `preview` com `pull-requests: write`; uptime `permissions: {}`.
- **VULN-010** Checkbox `#declared` pré-marcado e exemplo emitido sem ação do usuário com endereço real — CWE-1188 — `site/index.html:104`, `app.js` `resetExample`. Desmarcado por padrão; exemplo preenche campos mas não confirma; endereço fictício.
- **VULN-011** `applicability.price_m2_brl` não é verificado — CWE-20 — `site/assets/predict.js:60-86`. `priceReason(model, price, area)` com código `price_m2` quando `area` habilitada; caso em `tests/limits.test.mjs`.
- **VULN-012** Canvas de OCR sem teto de pixels — CWE-789 — `site/assets/matricula-reader.js:162-166`. Escala = `min(1.7, sqrt(25e6 / (w*h)))`.
- **VULN-013** `docs/v7/MANIFESTO_SHA256.txt` lista 20 números de matrícula reais; `docs/v7/README-v7.md:68` e `VERSAO_E_ORIGEM.txt:6` publicam URL/handle de terceiro — CWE-200. Remover as linhas `testes/…` e `.openai/…` do manifesto; substituir a URL por "hospedagem anterior, privada, desativada".
- **VULN-014** Sem Dependabot — CWE-1104. `.github/dependabot.yml` com `npm`, `pip` (requirements.lock) e `github-actions`, semanal. Usuário: ativar Dependabot alerts.
- **VULN-015** `requirements.lock` sem hashes — CWE-494. `requirements.in` + `uv pip compile --generate-hashes`; instalar com `--require-hashes`; ajustar RUNBOOK.

## Informativos

`<option value="${item.code}">` sem escape em `app.js` (usar `new Option`); beacon `ocr_failed` envia `error.message` de biblioteca (enviar só `error.name`);
retenção de Workers Logs no Free é 3 dias (corrigir `wrangler.jsonc:15` e RUNBOOK); passos do CI com `| grep -v` sem `pipefail` (`shell: bash`);
`.gitignore` sem `.dev.vars.*`, `*.pem`, `*.key`, `.npmrc`; "Identificação" do resumo aleatória (usar hash das entradas + versão, 12 hex);
resposta do Nominatim sem `Array.isArray`; `npx lighthouse@12` sem versão completa no RUNBOOK; `tessdata-4.0.0_best_int/` sem LICENSE (Apache-2.0);
`cep4_stats` com grupos n<5 (um com n=1) — suprimir n<5 em `train_model.py` `stats_by` (app.js já cai para cep3);
HSTS só da zona (adicionar `Strict-Transport-Security: max-age=15552000` em `/*` do `_headers`); `--no-sandbox` no script local de imagens;
domínio já expirou uma vez (segundo método de pagamento, lembrete).

## Cadeias

CHAIN-001 (MEDIUM 60): VULN-002 ou VULN-003 + VULN-004 → modelo fabricado em produção com selo de fontes oficiais; VULN-005 cega a detecção.
CHAIN-002 (LOW 18): PDF forjado → prefill → estimativa e Nominatim com valores do atacante; sem XSS nem exfiltração.

## Ações que só o dono do repositório faz no GitHub/Cloudflare

1. Settings → Environments → production: required reviewers; deployment branches and tags = `main` e `v*`; mover `CLOUDFLARE_API_TOKEN` para environment secret.
2. Settings → Rules: ruleset de tags `v*` restrito a administradores.
3. Settings → Code security: ativar Dependabot alerts.
4. Confirmar no dashboard da Cloudflare a retenção real do Workers Logs no plano atual.
