# DEPLOY — arquitetura e decisões

## Resumo

- **O que é**: site estático que estima o valor de apartamentos em São Paulo com um modelo Ridge hedônico
  treinado offline. A inferência roda no navegador lendo `model.json`. Não há backend de predição, banco,
  conta nem cookie.
- **Canal por e-mail** (desde 2026-09-08): o mesmo Worker recebe em `avm@heybrain.uk` a matrícula e o documento de IPTU de
  remetentes autorizados e devolve, sem intervenção humana, a estimativa no corpo da mensagem e o relatório em Excel.
  Tudo em memória, na invocação; nada é gravado. Escaneados passam por OCR no Workers AI. Spec:
  [docs/superpowers/specs/2026-09-08-email-avm-design.md](docs/superpowers/specs/2026-09-08-email-avm-design.md).
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
   └── POST /api/erro (aviso técnico anônimo) ──▶ src/worker.js ──▶ Workers Logs (7 dias, Paid; só linhas próprias)
```

```
remetente ── SMTP ──▶ Email Routing (heybrain.uk) ── regra avm@ ──▶ Worker avm-sp · handler email()
                                                                        │
                    ┌───────────────────────────────────────────────────┤ tudo em memória, nada gravado
                    │ 1. remetente na lista (segredo ALLOWED_SENDERS)?  │ não → setReject (bounce)
                    │ 2. resposta automática de alguém? descarta        │
                    │ 3. limite por remetente (EMAIL_RL, 3/min); 20 MiB │
                    │ 4. postal-mime → anexos PDF/imagem (≤ 6, ≤ 10 MiB)│
                    │ 5. texto: env.AI.toMarkdown (PDF com texto)       │
                    │    ou OCR: unpdf → PNG → gemma-4 (Workers AI)     │
                    │ 6. AVMMatricula.extract* (mesmos leitores do site)│
                    │ 7. AvmReport.estimate (AvmPredict) + Nominatim    │
                    │ 8. AvmReport.build → AVMExcel.buildWorkbook       │
                    │ 9. env.EMAIL.send → remetente (In-Reply-To)       │
                    └───────────────────────────────────────────────────┘
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
| Worker para `/api/erro` e para o handler `email()` | Sem backend de predição para o site, mas o prompt pede captura de erro de front e a licitação pede o canal por e-mail. `run_worker_first` só em `/api/*`; assets e `_headers` intactos. Payload de `/api/erro` sem dado do imóvel. |
| Uptime por GitHub Actions | Health Checks da Cloudflare só a partir do Pro. Cron de 30 min em `/version.json`. |
| Branch `main` protegida com `check` obrigatório, inclusive para admins | Todo código entra por PR, e é o merge em `main` que publica. Sem deploy da máquina como caminho normal. |
| Build e deploy no Cloudflare Workers Builds, não no GitHub Actions | O repositório está ligado ao Worker: cada push em `main` roda `npm run build` e `npx wrangler deploy`. O CI fica só com o `check` e não guarda token da Cloudflare. Em troca, produção sai a cada merge — o portão é o PR. |
| Matrículas de teste fora do git | 20 PDFs reais com CPF/RG de terceiros; LGPD. `testes/` ignorado. |
| Canal de e-mail no **mesmo Worker**, handler `email()` ao lado do `fetch()` | Um deploy (Workers Builds já publica no merge), um `wrangler.jsonc`, os módulos do site importados direto (`AVMMatricula`, `AvmPredict`, `AvmReport`, `AVMExcel`): site e e-mail produzem o mesmo relatório para as mesmas entradas. Um segundo Worker só duplicaria pipeline e bindings. |
| Síncrono, na invocação do e-mail, **sem estado** | Sem fila, DO, R2 ou banco: o que entra sai na mesma invocação e nada é retido — é a afirmação mais forte possível na privacidade. CPU do Paid (`cpu_ms` 60000) sobra; toMarkdown, Workers AI e Nominatim são I/O. |
| Lista de remetentes autorizados (`ALLOWED_SENDERS`, segredo) e só o envelope autoriza | Caixa aberta = OCR e CPU pagos por qualquer spam e PDFs de desconhecidos abertos no servidor. `From`/`Reply-To` são falsificáveis; `message.from` (MAIL FROM) não. Decisão do dono. |
| OCR via Workers AI (Gemma 4), não Tesseract nem Browser Rendering | Decisão do dono. Tesseract WASM não cabe no Worker; Browser Rendering custaria 30–60 s por e-mail. O modelo só transcreve — os campos vêm dos mesmos leitores do site; erro de transcrição vira "Faltou", nunca número inventado. |
| Uma resposta por e-mail recebido, sempre | Relatório, recusa ou "faltou isto" — o remetente nunca fica sem saber. Se o envio falhar, `setReject` para que receba um bounce. `Auto-Submitted` não é permitido no Email Sending; vai `X-Auto-Response-Suppress`. |
| Logs de invocação **desligados** (`observability.logs.invocation_logs: false`) | O registro automático de um evento de e-mail traz remetente e destinatário; a privacidade promete linhas técnicas sem dados pessoais. As linhas próprias (`front_error`, `email_*`) bastam para operar. |

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

## Custo

Cloudflare **Workers Paid** (já contratado pelo dono; o canal por e-mail exige — no Free o Email Sending só entrega a
endereços verificados): assets sem custo; `/api/erro` e o handler de e-mail contam contra 10 M invocações/mês e 30 M
ms de CPU inclusos. **Email Sending**: 3.000 envios/mês inclusos, depois US$ 0,35 por 1.000. **Workers AI**: por token
(Gemma 4: US$ 0,10/M de entrada, US$ 0,30/M de saída ≈ US$ 0,002 por página transcrita, < US$ 0,02 por e-mail com 8
páginas); PDF com texto não gera custo de OCR. GitHub Free (Actions dentro da franquia); registro `.uk` renovado
anualmente pela Cloudflare ao preço de custo.

Estimativa: sem e-mails, **zero** além do plano e do domínio; 1.000 e-mails/mês com metade escaneada, **≈ US$ 10** além
do plano. Alerta de gasto: Compute & AI → Workers AI (RUNBOOK, "Desligar só o OCR").
