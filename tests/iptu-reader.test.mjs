// Leitura da Notificação de Lançamento do IPTU (PMSP): detecção do tipo de documento e extração das três
// variáveis que a matrícula não traz (ano de construção → idade, tipo/padrão → código 20-24, valor do m² do
// terreno → VM2T). O texto abaixo reproduz o layout do carnê sem nenhum dado pessoal; quando os carnês reais
// entrarem em testes/, os trechos dos campos entram aqui como casos adicionais.
// Rodar: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { CARNE, MATRICULA, CERTIDAO, CERTIDAO_EMBARALHADA } from "./fixtures/textos.mjs";

const root = new URL("../", import.meta.url);
vm.runInThisContext(readFileSync(new URL("site/assets/matricula-reader.js", root), "utf8"));
const { AVMMatricula } = globalThis;

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

test("certidão de dados cadastrais em ordem de leitura: SQL, ano, padrão e VM2T", () => {
  assert.equal(AVMMatricula.detectDocumentType(CERTIDAO), "iptu");
  const f = AVMMatricula.extractIptuFields(CERTIDAO);
  assert.equal(f.sql, "123.456.0789-0");
  assert.equal(f.yearBuilt, 2018);
  assert.equal(f.patternCode, 22);
  assert.equal(f.fiscal, 6500); // Valores de m² → de terreno; os 195.000 do bloco de cálculo não entram
  assert.equal(f.cep, "04109-002");
  assert.equal(f.address, "Rua Vergueiro, 2650");
});

test("certidão com camada de texto embaralhada: valor antes do rótulo, SQL colado, VM2T pela faixa plausível", () => {
  assert.equal(AVMMatricula.detectDocumentType(CERTIDAO_EMBARALHADA), "iptu");
  const f = AVMMatricula.extractIptuFields(CERTIDAO_EMBARALHADA);
  assert.equal(f.sql, "123.456.0789-0");
  assert.equal(f.yearBuilt, 2018);
  assert.equal(f.patternCode, 22);
  assert.equal(f.fiscal, 6500);
  assert.notEqual(f.fiscal, 195000);
});

test("legenda 'Certidão de Dados Cadastrais do Imóvel' sozinha classifica como IPTU", () => {
  assert.equal(AVMMatricula.detectDocumentType("Figura 2 - Certidão de Dados Cadastrais do Imóvel"), "iptu");
});

test("SQL: fronteira à esquerda evita casar o fim de um número maior; cola no rótulo seguinte funciona", () => {
  assert.equal(AVMMatricula.extractIptuFields("IPTU Cadastro 1123.456.0789-0 x").sql, null);
  assert.equal(AVMMatricula.extractIptuFields("IPTU Cadastro do Imóvel: 123.456.0789-0Cadastro").sql, "123.456.0789-0");
});

test("isEmpty: nenhum campo extraído é 'vazio'; parcial ou null não conta como vazio/completo", () => {
  assert.equal(AVMMatricula.isEmpty("matricula", { address: null, area: null }), true);
  assert.equal(AVMMatricula.isEmpty("iptu", { yearBuilt: 2018, patternCode: null, fiscal: null }), false);
  assert.equal(AVMMatricula.isEmpty("iptu", null), true);
});

test("matrícula: área privativa antes do rótulo, 'área de uso privativo' e rótulo com dois-pontos", () => {
  assert.equal(AVMMatricula.extractFields("consta na matrícula de 41,06 m2 de área privativa.").area, 41.06);
  assert.equal(AVMMatricula.extractFields("área de uso privativo de 118,73 m², área de uso comum de 35,89 m²").area, 118.73);
  assert.equal(AVMMatricula.extractFields("Área Privativa : 26,549 m² Área Comum : 10,910 m²").area, 26.549);
});
