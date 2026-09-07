# AVM SP — Precificação Imobiliária — versão 7

Aplicativo web para estimativa de valor de apartamentos residenciais no município de São Paulo/SP.

## Escopo atual

- Apartamentos residenciais.
- Área privativa entre 35 m² e 250 m², inclusive, com valores decimais.
- Até 20 anos de construção.
- Valor de avaliação de até R$ 2.250.000,00.
- Operações no SFH ou SFI, com indicação de origem de recursos SBPE ou outros.
- Variáveis iniciais: área privativa, idade, padrão cadastral do IPTU e valor fiscal por metro quadrado da PGV.
- Cada variável pode ser habilitada ou desabilitada antes do cálculo.
- O valor de condomínio não é usado na precificação.
- O treinamento considera somente transações classificadas como compra e venda.

## O que está nesta pasta

| Caminho | Conteúdo |
|---|---|
| `.openai/hosting.json` | Configuração de publicação do site estático. |
| `dist/index.html` | Página principal e estrutura do frontend. |
| `dist/assets/app.js` | Regras de interface, precificação, relatório e geocodificação. |
| `dist/assets/matricula-reader.js` | Leitura local de PDF/imagem, extração de endereço e área privativa. |
| `dist/assets/model.json` | Parâmetros e métricas do modelo AVM publicado. |
| `dist/assets/styles.css` | Estilos visuais responsivos. |
| `dist/assets/xlsx-export.js` | Geração do relatório em Excel. |
| `dist/assets/vendor/` | Bibliotecas embarcadas e respectivas licenças. |
| `methodology/train_model.py` | Rotina Python de tratamento dos dados e treinamento. |
| `testes/matriculas_reais/` | Vinte matrículas públicas e índice de fontes para testes controlados. Não publicar. |
| `PENDENCIAS_PARA_PRODUCAO.md` | Diagnóstico priorizado para finalizar o produto. |
| `MANIFESTO_SHA256.txt` | Integridade SHA-256 de todos os arquivos do pacote. |

## Modelo incluído

- Identificação: `SP-AVM-ITBI-PGV-2026.07-R2`.
- 18.258 transações tratadas.
- Divisão temporal: 12.780 registros de treino, 2.739 de calibração e 2.739 de teste.
- R² em log: 0,8226.
- MAE: R$ 109.064,45.
- MdAPE: 17,05%.
- Cobertura observada do intervalo nominal de 80%: 80,72%.

Essas métricas descrevem a amostra de teste existente. Elas não substituem validação independente, monitoramento de estabilidade ou análise técnica e jurídica da garantia quando exigidos.

## Executar localmente

É necessário servir a pasta por HTTP; abrir o HTML diretamente pode bloquear módulos JavaScript.

Linux/macOS:

```bash
python3 -m http.server 8000 --directory dist
```

Windows:

```powershell
py -m http.server 8000 --directory dist
```

Depois, acesse `http://localhost:8000`.

## Publicação

A aplicação é um site estático. O diretório publicado é `dist`, conforme `.openai/hosting.json`. A versão 7 atualmente está ativa no endereço:

https://avm-sp-engenharia-2026.edurs1957.chatgpt.site

O acesso está restrito ao proprietário. Torná-lo público é uma decisão de publicação separada e não foi executada na preparação deste pacote.

## Reproduzir o treinamento

O algoritmo está em `methodology/train_model.py`. A rotina espera os arquivos oficiais de ITBI e PGV em caminhos configuráveis. Os arquivos-fonte brutos não estão neste pacote; é necessário obter, registrar e versionar as fontes oficiais antes de refazer o modelo.

## Atenção aos documentos de teste

As matrículas em `testes/matriculas_reais` são documentos reais disponibilizados publicamente por fonte oficial. Podem conter nomes, documentos, endereços e outros dados pessoais. Use somente em ambiente controlado, com acesso restrito, e exclua essa pasta de qualquer implantação pública.

