# Pendências para colocar o AVM SP em produção

## Resumo executivo

O frontend e o modelo demonstrativo estão funcionais e a versão 7 já está hospedada com acesso restrito. Para uso público ou institucional, ainda faltam componentes de confiabilidade, integração cadastral, rastreabilidade, segurança, privacidade e governança do modelo.

| Item | Situação atual | Necessário antes do uso público/institucional | Prioridade |
|---|---|---|---|
| Frontend, cálculo e relatório | Implementados | Testes completos e homologação | Alta |
| Exportação Excel | Implementada | Validar conteúdo, fórmulas e compatibilidade | Alta |
| Leitura de matrícula | PDF.js local; extrai endereço e área privativa | Completar o OCR local e testar todas as matrículas | Bloqueadora |
| CEP e bairro | Consulta direta ao Nominatim | Adotar serviço com capacidade/SLA, cache central e contingência | Alta |
| Idade, padrão IPTU e valor fiscal PGV | Digitados pelo usuário | Integrar consulta oficial pelo imóvel e registrar a competência da PGV | Bloqueadora |
| Modelo AVM | Modelo estático incluído | Automatizar dados, retreinamento, validação e monitoramento | Bloqueadora |
| Auditoria dos relatórios | Resultado existe apenas no navegador | Persistir relatório, entradas, modelo e evidências de forma imutável | Bloqueadora |
| Segurança e LGPD | Sem autenticação ou backend | Definir perfis, retenção, privacidade, logs e controles | Bloqueadora |
| Acesso ao site | Ativo e restrito ao proprietário | Decidir público-alvo e alterar acesso somente após homologação | Alta |

## 1. Completar o OCR da matrícula

O erro anterior do `pdf.worker.min.mjs` foi corrigido: o PDF.js e seu worker estão dentro do projeto. Porém, o OCR de páginas digitalizadas ainda não é inteiramente autônomo. O pacote contém o Tesseract e seu worker, mas não contém o núcleo WebAssembly nem os dados de idioma português.

Para finalizar:

1. Embutir uma versão fixa do Tesseract Core/WASM.
2. Embutir `por.traineddata.gz` e configurar explicitamente `corePath`, `workerPath` e `langPath`.
3. Impedir dependências silenciosas de CDN.
4. Executar testes de regressão com as 20 matrículas incluídas.
5. Definir critérios de aceite para endereço e, sobretudo, área privativa.
6. Exibir revisão humana obrigatória quando a extração estiver ambígua.

## 2. Automatizar os dados cadastrais e a PGV

Hoje o endereço da matrícula pode preencher CEP e bairro, mas idade, padrão cadastral do IPTU e valor fiscal por metro quadrado precisam ser digitados. Para reduzir erro operacional, o sistema deve resolver o imóvel cadastralmente e obter, de fonte oficial:

- SQL ou identificador cadastral do imóvel;
- ano da construção ou idade;
- padrão cadastral do IPTU;
- valor fiscal por metro quadrado correspondente na PGV;
- lei, anexo, exercício e data de vigência da PGV utilizada.

É necessário tratar endereço incompleto, unidade em condomínio, múltiplas inscrições, divergência entre matrícula e cadastro e ausência de correspondência. A solução deve permitir confirmação humana e registrar a origem de cada dado.

## 3. Tornar o treinamento reproduzível

O repositório contém o algoritmo, mas não inclui os arquivos brutos de ITBI e PGV usados no treinamento. Para uma produção auditável:

1. Criar uma rotina automática de aquisição das fontes oficiais.
2. Registrar URL, data, hash, licença e competência de cada arquivo.
3. Versionar dados tratados, código, parâmetros, métricas e artefato final.
4. Fixar versões das bibliotecas Python em um arquivo de dependências.
5. Promover um modelo novo somente após aprovação e validação independente.
6. Definir periodicidade de atualização e política de reversão.

## 4. Implementar governança do modelo

A Resolução CMN nº 4.676, em sua redação consolidada, permite modelo de precificação próprio ou de terceiros, mas exige critérios, premissas e procedimentos consistentes, documentados e verificáveis, independência em relação à concessão de crédito e relatório individualizado com aspectos e riscos relevantes.

Antes de uso institucional, preparar:

- política de finalidade e limites de uso do AVM;
- validação independente do desenvolvimento;
- segregação entre desenvolvimento, validação e decisão de crédito;
- justificativa institucional para os casos em que a vistoria individual possa ser dispensada;
- monitoramento de erro, cobertura, estabilidade, viés geográfico e mudança de distribuição;
- critérios de encaminhamento obrigatório para avaliação presencial;
- trilha de aprovação, revisão periódica e aposentadoria de versões;
- responsável técnico e jurídico definido pela instituição.

Referência oficial: https://normativos.bcb.gov.br/Lists/Normativos/Attachments/50628/Res_4676_v15_L.pdf

## 5. Criar backend e trilha de auditoria

O aplicativo atual executa tudo no navegador. Isso preserva o documento localmente, mas o relatório e as evidências desaparecem quando a sessão termina. Para operação institucional, é necessário um backend que registre, com integridade:

- usuário, data e finalidade da avaliação;
- entradas fornecidas e respectivas fontes;
- arquivo original ou sua referência protegida e hash;
- versão do algoritmo e do modelo;
- variáveis habilitadas/desabilitadas;
- resultado, intervalo, alertas e decisão de encaminhamento;
- PDF/Excel emitido e histórico de alterações.

O backend deve ter autenticação, perfis de acesso, criptografia, política de retenção, backup, restauração e registros que não possam ser alterados sem evidência.

## 6. Adequar privacidade e segurança

Matrículas podem conter dados pessoais e informações sensíveis para fraude. Antes da abertura do sistema:

- definir base legal, finalidade, minimização e prazo de retenção conforme a LGPD;
- publicar aviso de privacidade e termos de uso;
- não enviar matrículas a terceiros sem informação e base adequadas;
- excluir `testes/` do artefato público;
- configurar CSP, HSTS, permissões do navegador e demais cabeçalhos de segurança;
- verificar dependências e vulnerabilidades;
- realizar teste de segurança e plano de resposta a incidentes;
- impedir indexação e exposição acidental de documentos.

## 7. Substituir a geocodificação pública direta

O navegador consulta o Nominatim público. A aplicação já limita e guarda consultas por navegador, mas o limite se aplica ao uso agregado e o serviço público não oferece garantia para uma aplicação institucional. É necessário usar proxy/cache central ou contratar uma alternativa compatível, manter atribuição ao OpenStreetMap e permitir troca de provedor.

Política oficial: https://operations.osmfoundation.org/policies/nominatim/

## 8. Testes e operação

Criar testes automatizados e evidências de homologação para:

- igualdade entre predição Python e JavaScript;
- todas as 15 combinações possíveis de variáveis;
- limites de 35/250 m², 20 anos e R$ 2,25 milhões;
- decimais de área e formatos monetários brasileiros;
- PDFs com texto, PDFs digitalizados, imagens, arquivos corrompidos e protegidos;
- extração específica de área privativa, sem confusão com área total ou comum;
- geração e abertura do Excel e impressão/PDF;
- navegadores, celulares, acessibilidade e desempenho;
- falhas de geocodificação e indisponibilidade externa.

Também são necessários monitoramento de disponibilidade e erros, alertas, métricas de uso, rotina de backup e um canal de suporte.

## Ordem recomendada

1. Fechar OCR local, privacidade e testes das matrículas.
2. Integrar cadastro IPTU/PGV e definir confirmação humana.
3. Criar pipeline reproduzível de dados e modelo.
4. Implantar backend, autenticação e auditoria.
5. Concluir validação independente, governança e homologação regulatória.
6. Reforçar geocodificação, segurança e monitoramento.
7. Publicar para o público-alvo escolhido e, se desejado, configurar domínio próprio.

