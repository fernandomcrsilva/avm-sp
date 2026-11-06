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

Modelo de avaliação automática (AVM) de apartamentos residenciais em São Paulo. Ele devolve uma estimativa pontual e uma faixa de 80% de probabilidade, e a inferência roda inteira no navegador.

- **Modelo:** regressão Ridge hedônica sobre ln(preço), com um modelo para cada subconjunto das entradas (área, idade, padrão construtivo do IPTU e valor fiscal da PGV), 15 modelos ao todo. Cada subconjunto tem seu próprio intervalo conformal, então o app continua funcionando quando o usuário não sabe alguma entrada.
- **Validação:** divisão temporal, com 70% para treino, 15% para calibração e 15% para teste.
- **Resultados:** no modelo completo, com 2.739 transações de teste, R² (log) de 0,82, MAPE de 21,2%, erro percentual mediano de 17,1% e cobertura empírica de 80,7% para o intervalo de 80%.
- **Engenharia:** o treino em Python (pandas e scikit-learn) exporta um `model.json`, que um runtime em JS reproduz. O CI confere a paridade entre Python e JS, os limites de aplicabilidade e o esquema do modelo. O app roda no Cloudflare Workers, e um canal por e-mail usa OCR do Workers AI para ler documentos do imóvel.

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
