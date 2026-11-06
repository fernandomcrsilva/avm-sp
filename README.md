# AVM SP

Estimativa estatística do valor de apartamentos residenciais em São Paulo, com faixa de 80% de probabilidade,
calculada inteiramente no navegador a partir de transações reais de ITBI e da Planta Genérica de Valores.
**Não é laudo** nem avaliação de imóvel na acepção da NBR 14653-2.

Produção: https://avm.heybrain.uk

| Documento | Conteúdo |
|---|---|
| [DEPLOY.md](DEPLOY.md) | Arquitetura, decisões e justificativas |
| [RUNBOOK.md](RUNBOOK.md) | Publicar, reverter, atualizar o modelo, operar |
| [docs/superpowers/specs/2026-09-08-email-avm-design.md](docs/superpowers/specs/2026-09-08-email-avm-design.md) | Canal por e-mail (`avm@heybrain.uk`): arquitetura, entregas, segurança, custo |
| [docs/aceite-2026-09-07.md](docs/aceite-2026-09-07.md) | Checklist de aceite com evidências e relatório final |
| [docs/security-audit-2026-09-07.md](docs/security-audit-2026-09-07.md) | Auditoria de segurança (8 agentes, 28 achados) |
| [docs/aceite-seguranca-2026-09-07.md](docs/aceite-seguranca-2026-09-07.md) | Fechamento da auditoria: o que foi corrigido, em qual PR, e o que só o dono faz |
| [docs/v7/](docs/v7/) | Documentação do pacote v7 recebido em 2026-09-07 (histórico) |

## Resumo técnico

O AVM SP estima o valor de apartamentos residenciais em São Paulo e mostra, junto com a estimativa, uma faixa onde o valor real deve cair com 80% de probabilidade. Todo o cálculo é feito no navegador.

O modelo é uma regressão Ridge hedônica sobre o logaritmo do preço. Nem todo usuário sabe todos os dados do imóvel (área, idade, padrão construtivo do IPTU e valor fiscal da PGV), então existe um modelo para cada combinação possível dessas entradas, 15 ao todo, cada um com o seu próprio intervalo conformal. Assim o app continua respondendo mesmo quando falta alguma informação.

As transações foram separadas em ordem cronológica: 70% para treino, 15% para calibrar os intervalos e 15% para teste. Nas 2.739 transações de teste, o modelo completo teve R² de 0,82 na escala logarítmica, erro percentual médio (MAPE) de 21,2% e erro percentual mediano de 17,1%. O valor real caiu dentro da faixa de 80% em 80,7% dos casos.

O treino é feito em Python, com pandas e scikit-learn, e gera um `model.json` que o site executa em JavaScript. O CI confere se Python e JavaScript chegam aos mesmos números, se os limites de aplicabilidade são respeitados e se o arquivo do modelo segue o esquema. O site roda no Cloudflare Workers. Há também um canal por e-mail, que lê documentos do imóvel com o OCR do Workers AI.

## Layout

- `site/` fonte do site estático (HTML, CSS, JS, `assets/model.json`, vendor auto-hospedado)
- `dist/` saída de `npm run build` (fingerprint nos assets, `version.json`); ignorado pelo git
- `src/worker.js` Worker: `POST /api/erro` e o handler `email()` da estimativa por e-mail (`src/email.js` é o pipeline, `src/ocr.js` o OCR via Workers AI; `site/assets/report.js` monta o relatório para site e e-mail)
- `train_model.py` treino (Ridge hedônico, 15 modelos, conformal); `data/sources.lock.json` hashes das fontes
- `scripts/` validador do `model.json`, fixture de paridade, geração das imagens
- `tests/` paridade Python↔JS, limites de aplicabilidade, validador, canal de e-mail (pipeline, OCR, leitores de IPTU), consistência do manual
- `.github/workflows/` CI/CD (`ci.yml`) e uptime (`uptime.yml`)

## Rodar

```bash
npm ci && npm run check      # lint, validador, testes, paridade, build
npx wrangler dev             # http://localhost:8787
```

Retreino: veja "Atualizar o modelo" no [RUNBOOK.md](RUNBOOK.md).

## Licença

Código sob [MIT](LICENSE). Bibliotecas em `site/assets/vendor/` mantêm as próprias licenças.
