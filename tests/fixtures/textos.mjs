// Textos sintéticos, sem dado pessoal, no layout da Notificação de Lançamento do IPTU (PMSP) e de uma
// matrícula. Usados pelos testes do leitor e do pipeline de e-mail. Quando carnês reais entrarem em testes/
// (fora do git), os trechos dos campos entram aqui como casos adicionais.
export const CARNE = `
PREFEITURA DO MUNICÍPIO DE SÃO PAULO
SECRETARIA MUNICIPAL DA FAZENDA
NOTIFICAÇÃO DE LANÇAMENTO
IMPOSTO PREDIAL E TERRITORIAL URBANO - IPTU 2026
Número do Contribuinte: 042.115.0087-3
Local do imóvel: R VERGUEIRO, 2650 AP 81 - VILA MARIANA - CEP 04109-002
DADOS DO IMÓVEL
Área do Terreno (m²): 62,50   Área Construída (m²): 98,00   Área Ocupada (m²): 31,10
Testada (m): 12,00   Fração Ideal: 0,004512
Ano da Construção Corrigido: 2018
Tipo/Padrão: 2-C   Fator de Obsolescência: 0,90
CÁLCULO DO IMPOSTO
Valor do m² do Terreno (R$): 6.500,00
Valor do m² de Construção (R$): 2.361,00
Valor Venal do Terreno (R$): 406.250,00
Valor Venal da Construção (R$): 208.281,00
Valor Venal do Imóvel (R$): 614.531,00
`;

export const MATRICULA = `
OFICIAL DE REGISTRO DE IMÓVEIS DA CAPITAL - 1ª CIRCUNSCRIÇÃO
MATRÍCULA Nº 123.456
IMÓVEL: apartamento nº 81, localizado no 8º andar do edifício situado na Rua Vergueiro, nº 2.650,
com a área privativa de 78,00 m², área comum de 22,10 m², área total de 100,10 m².
Contribuinte nº 042.115.0087-3. AV.1 - Averbação de construção.
`;

// Mesma matrícula sem a palavra "apartamento": o modelo só cobre apartamentos, então isto tem de ser recusado.
export const MATRICULA_CASA = MATRICULA.replace("apartamento nº 81, localizado no 8º andar do edifício", "prédio residencial");

// Certidão de Dados Cadastrais do Imóvel (portal da PMSP) em ordem de leitura — é o que o OCR devolve.
export const CERTIDAO = `
PREFEITURA DE SÃO PAULO
Certidão de Dados Cadastrais do Imóvel - IPTU 2024
Cadastro do Imóvel: 123.456.0789-0
Local do Imóvel: R VERGUEIRO, 2650 AP 81   VILA MARIANA   CEP 04109-002
Dados cadastrais do terreno:
Área incorporada (m²): 1.200   Área não incorporada (m²): 0   Área total (m²): 1.200
Testada (m): 25,00   Fração ideal: 0,0250
Dados cadastrais da construção:
Área construída (m²): 98   Área ocupada pela construção (m²): 600
Ano da construção corrigido: 2018
Padrão da construção: 2-C   Uso: residência
Valores de m² (R$):
- da área incorporada: 6.500,00
- da área não incorporada: 0,00
- da construção: 2.361,00
Valores para fins de cálculo do IPTU (R$):
- da área incorporada: 195.000,00
- da área não incorporada: 0,00
- da construção: 231.378,00
`;

// A mesma certidão como a camada de texto do PDF a devolve: colunas embaralhadas e valor colado antes do rótulo.
export const CERTIDAO_EMBARALHADA = `
2.361,00- da construção:
Certidão de Dados Cadastrais do Imóvel - IPTU 2024
Valores de m² (R$):
123.456.0789-0Cadastro do Imóvel:
231.378,00- da construção:
0,00- da área não incorporada:
195.000,00- da área incorporada:
6.500,00- da área incorporada:
Dados cadastrais da construção:
Área construída (m²): Padrão da construção: 2-C
2018Ano da construção corrigido:
Local do Imóvel: R VERGUEIRO, 2650 AP 81 CEP 04109-002
`;
