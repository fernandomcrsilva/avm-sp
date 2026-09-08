// Leitura da Notificação de Lançamento do IPTU (PMSP): detecção do tipo de documento e extração das três
// variáveis que a matrícula não traz (ano de construção → idade, tipo/padrão → código 20-24, valor do m² do
// terreno → VM2T). O texto abaixo reproduz o layout do carnê sem nenhum dado pessoal; quando os carnês reais
// entrarem em testes/, os trechos dos campos entram aqui como casos adicionais.
// Rodar: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
vm.runInThisContext(readFileSync(new URL("site/assets/matricula-reader.js", root), "utf8"));
const { AVMMatricula } = globalThis;

const CARNE = `
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

const MATRICULA = `
OFICIAL DE REGISTRO DE IMÓVEIS DA CAPITAL - 1ª CIRCUNSCRIÇÃO
MATRÍCULA Nº 123.456
IMÓVEL: apartamento nº 81, localizado no 8º andar do edifício situado na Rua Vergueiro, nº 2.650,
com a área privativa de 78,00 m², área comum de 22,10 m², área total de 100,10 m².
Contribuinte nº 042.115.0087-3. AV.1 - Averbação de construção.
`;

test("detecta carnê de IPTU e matrícula pelo texto", () => {
  assert.equal(AVMMatricula.detectDocumentType(CARNE), "iptu");
  assert.equal(AVMMatricula.detectDocumentType(MATRICULA), "matricula"); // cita contribuinte e IPTU, mas é matrícula
  assert.equal(AVMMatricula.detectDocumentType(""), "matricula"); // sem texto (digitalizado), o OCR decide depois
});

test("matrícula: número com ponto de milhar ('nº 2.650') não é truncado; só a área privativa entra", () => {
  const fields = AVMMatricula.extractFields(MATRICULA);
  assert.equal(fields.address, "Rua Vergueiro, 2650");
  assert.equal(fields.area, 78);
});

test("extrai SQL, ano, padrão e VM2T do carnê; ignora a área construída", () => {
  const fields = AVMMatricula.extractIptuFields(CARNE);
  assert.equal(fields.sql, "042.115.0087-3");
  assert.equal(fields.yearBuilt, 2018);
  assert.equal(fields.patternCode, 22);
  assert.equal(fields.patternLabel, "2-C");
  assert.equal(fields.fiscal, 6500);
  assert.equal(fields.cep, "04109-002");
  assert.equal(fields.address, "Rua Vergueiro, 2650");
  assert.equal("area" in fields, false, "a área construída do IPTU não pode virar área privativa");
});

test("tolera variações de rótulo e de grafia (OCR)", () => {
  const variante = `IPTU 2026 Notificacao de Lancamento Numero do Contribuinte 118.002.0331-9
Ano de Construcao: 2015 Tipo: 2 Padrao: B Valor Unitario do Terreno R$ 4.312,00`;
  const fields = AVMMatricula.extractIptuFields(variante);
  assert.equal(fields.yearBuilt, 2015);
  assert.equal(fields.patternCode, 21);
  assert.equal(fields.fiscal, 4312);
  assert.equal(fields.sql, "118.002.0331-9");
});

test("tipo que não é residencial vertical fica sem código de padrão", () => {
  const casa = "NOTIFICAÇÃO DE LANÇAMENTO IPTU Ano da Construção Corrigido: 2010 Tipo/Padrão: 1-C Valor do m² do Terreno (R$): 1.200,00";
  const fields = AVMMatricula.extractIptuFields(casa);
  assert.equal(fields.patternCode, null);
  assert.equal(fields.patternLabel, "1-C"); // informado para a mensagem, sem entrar no modelo
  assert.equal(fields.yearBuilt, 2010);
});

test("valores fora do plausível são descartados", () => {
  const fields = AVMMatricula.extractIptuFields("IPTU Ano da Construção: 1850 Tipo/Padrão: 2-F Valor do m² do Terreno: 0,00");
  assert.equal(fields.yearBuilt, null);
  assert.equal(fields.patternCode, null);
  assert.equal(fields.fiscal, null);
});
