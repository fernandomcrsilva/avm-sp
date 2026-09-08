# DEPLOY — arquitetura e decisões

## Resumo

- **O que é**: site estático que estima o valor de apartamentos em São Paulo com um modelo Ridge hedônico
  treinado offline. A inferência roda no navegador lendo `model.json`. Não há backend de predição, banco,
  conta nem cookie.
- **Onde**: Cloudflare Workers Static Assets, Worker `avm-sp`, conta HeyBrain!, Custom Domain `avm.heybrain.uk`.
  Preview em `*.avm-sp.heybrain.workers.dev` com `X-Robots-Tag: noindex`.
- **Como publica**: PR → CI (`check`) → merge em `main` → Cloudflare Workers Builds (`npm run build` + `npx wrangler deploy`) → produção.
  Rollback = `versions deploy <anterior>@100%` ou `wrangler rollback`. Detalhes no [RUNBOOK.md](RUNBOOK.md).

## Arquitetura

```
navegador ── GET / ──▶ Cloudflare edge ──▶ Workers Static Assets (dist/)  ← _headers (cache, CSP, …)
   │                                        └─ 404.html, html_handling auto-trailing-slash
   ├── GET /assets/model.<sha8>.json (preload; 8 KB brotli) → equação em predict.js → faixa 80%
   ├── OCR opcional: pdf.js + tesseract.js com core WASM e idioma pt embarcados (vendor versionado)
   ├── endereço preenchido/alterado (ou clique em "Localizar") → nominatim.openstreetmap.org (única saída de dado do usuário)
   └── POST /api/erro (aviso técnico anônimo) ──▶ src/worker.js ──▶ Workers Logs (3 dias no Free)
```

Fontes de treino (fora do git, hash conferido): Guias de ITBI pagas (SF-SP) e Anexos I/II da Lei 18.330/2025 (PGV 2026).
`train_model.py` gera `site/assets/model.json` (coeficientes, escalas, quantis conformais, métricas, EDA, limites)
e `tests/parity_fixture.json` (predições do scikit-learn para 17 imóveis × 15 modelos).

## Decisões e justificativas

| Decisão | Por quê |
|---|---|
| Workers Static Assets, não Pages | Caminho recomendado pela Cloudflare para sites estáticos novos; `_headers`, 404 e html_handling nativos; mesmo fluxo de versões do Worker. |
| Sem bundler; `build.mjs` com stdlib do Node | O site são 4 scripts clássicos sem imports. Um script de 90 linhas copia `site/`→`dist/`, dá fingerprint sha8 a tudo em `assets/`, reescreve referências e gera `version.json`. Menos superfície que migrar para Vite. |
| Diretórios versionados no vendor (`tesseract-core-7.0.0/`, `tessdata-4.0.0_best_int/`) sem fingerprint por arquivo | O worker do Tesseract monta os nomes dos arquivos a partir do diretório; versionar o diretório mantém o cache imutável. |
| `model.json` referenciado por `<link rel=preload id=model-url>` | Uma tag serve de preload e de fonte da URL com hash para `app.js`; um só request. |
| Equação única em `predict.js` + fixture do scikit-learn | Paridade Python↔JS a 1e-9 em ln(preço) no CI; o front não pode divergir do treino sem quebrar o build. |
| Limites de aplicabilidade em `model.json` (`applicability`) | Um dicionário `LIMITS` filtra o treino e é exportado; a UI recusa fora dele. Nenhum número fixo no HTML. |
| Recusa antes do cálculo | Fora do domínio de treino não há estimativa: extrapolação silenciosa era o pior defeito do v7. |
| Faixa antes do ponto | O número redondo sozinho passa precisão que o modelo não tem. Cobertura nominal vem do modelo. |
| Posicionamento público, sem SFH/SFI/SBPE | Decisão do dono do projeto. O v7 falava com instituição de crédito; o aviso legal (NBR 14653-2) é o oposto disso. |
| Nominatim consultado ao sair do campo de endereço | Decisão do dono do projeto. Uma consulta por endereço, nunca durante a digitação; sem gravação em `localStorage`, sem Referer, texto explícito na tela e na privacidade; `connect-src` libera só esse host. |
| OCR embarcado (core WASM + português), só variantes SIMD e relaxed-SIMD | Regra "sem CDN de terceiros". 3,9 MB por variante, carregados só quando o usuário abre uma matrícula digitalizada. Navegador sem WASM SIMD (Safari < 16.4) fica sem OCR, mas lê PDF com texto. |
| `intent: "print"` na renderização para OCR | O modo padrão do pdf.js usa `requestAnimationFrame` e trava em aba oculta. |
| CSP com `'wasm-unsafe-eval'` e Nominatim em `connect-src` | Únicas exceções à política do prompt; a primeira compila WebAssembly (não libera `eval`), a segunda é a geocodificação escolhida. Sem `unsafe-inline`: alturas de gráfico via CSSOM. |
| Bot Fight Mode e JavaScript Detections desligados na zona | No plano Free o JSD é obrigatório com Bot Fight Mode e injeta script inline (bloqueado pela CSP, erro de console, Lighthouse 93) e cookie `__cf_bm`. Block AI Bots e rate limit mantidos. |
| SSL Full (strict) na zona | Só há CNAMEs de túnel e Worker; nenhum origin público a validar. |
| Sem web fonts | Decisão do dono do projeto: tipografia original (Inter se instalada, senão a do sistema). |
| Sem Cloudflare Web Analytics | Beacon de terceiro incompatível com a CSP fechada e com "sem dependência de CDN". Métricas de requisição do Worker bastam. |
| Worker mínimo só para `/api/erro` | Sem backend de predição, mas o prompt pede captura de erro de front. `run_worker_first` só em `/api/*`; assets e `_headers` intactos. Payload sem dado do imóvel. |
| Uptime por GitHub Actions | Health Checks da Cloudflare só a partir do Pro. Cron de 30 min em `/version.json`. |
| Branch `main` protegida com `check` obrigatório, inclusive para admins | Todo código entra por PR, e é o merge em `main` que publica. Sem deploy da máquina como caminho normal. |
| Build e deploy no Cloudflare Workers Builds, não no GitHub Actions | O repositório está ligado ao Worker: cada push em `main` roda `npm run build` e `npx wrangler deploy`. O CI fica só com o `check` e não guarda token da Cloudflare. Em troca, produção sai a cada merge — o portão é o PR. |
| Matrículas de teste fora do git | 20 PDFs reais com CPF/RG de terceiros; LGPD. `testes/` ignorado. |

## Segurança e privacidade

Cabeçalhos em toda resposta de asset (`site/_headers`): CSP fechada, `nosniff`, `Referrer-Policy`,
`Permissions-Policy`, COOP e CORP. HSTS de 180 dias na zona e também em `_headers` (sem preload). Sem cookies, sem
`localStorage`, sem analytics. Dados do imóvel e matrícula ficam no navegador; o endereço sai ao ser preenchido ou alterado, para o Nominatim, e nada mais.

## Custo

Cloudflare Workers Free (assets sem custo; `/api/erro` conta contra 100 mil invocações/dia), GitHub Free
(Actions dentro da franquia), registro `.uk` renovado anualmente pela Cloudflare ao preço de custo.
Custo mensal recorrente estimado: **zero**, além do domínio.
