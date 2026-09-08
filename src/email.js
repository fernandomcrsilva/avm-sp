// Pipeline do AVM por e-mail (spec docs/superpowers/specs/2026-09-08-email-avm-design.md, seção 4).
// Puro e sem estado: recebe o e-mail bruto e serviços injetados (deps), devolve a resposta pronta. Nada é gravado.
// Reaproveita os módulos do site: os scripts clássicos abaixo se registram em globalThis ao serem importados.
import PostalMime from "postal-mime";
import "../site/assets/predict.js";
import "../site/assets/report.js";
import "../site/assets/matricula-reader.js";
import "../site/assets/xlsx-export.js";
import model from "../site/assets/model.json" with { type: "json" };

export const LIMITS = Object.freeze({
  maxAttachments: 6,
  maxAttachmentBytes: 10 * 1024 * 1024,
  minTextChars: 200,     // abaixo disso o PDF é tratado como sem camada de texto
  maxTextChars: 200_000, // teto do texto extraído por documento
});

const PDF_TYPE = "application/pdf";
// imagens: Entrega 2 (OCR)

function attachmentType(att) {
  const name = String(att.filename || "").toLocaleLowerCase("pt-BR");
  const type = String(att.mimeType || "").toLocaleLowerCase("pt-BR").split(";")[0].trim();
  if (type === PDF_TYPE || name.endsWith(".pdf")) return PDF_TYPE;
  return null;
}

// Lê o MIME e separa o que o pipeline aceita (só PDF) do que é ignorado.
export async function parseInbound(raw) {
  const parsed = await PostalMime.parse(raw);
  const attachments = [];
  const ignored = [];
  for (const att of parsed.attachments || []) {
    const fileName = String(att.filename || "anexo").slice(0, 120);
    const mimeType = att.related ? null : attachmentType(att); // logo de assinatura (inline/related): sempre ignorado
    const bytes = att.content instanceof Uint8Array ? att.content : new Uint8Array(att.content);
    if (!mimeType || bytes.length === 0 || bytes.length > LIMITS.maxAttachmentBytes || attachments.length >= LIMITS.maxAttachments) {
      ignored.push(fileName);
      continue;
    }
    attachments.push({ fileName, mimeType, bytes });
  }
  return {
    messageId: parsed.messageId || null,
    subject: parsed.subject || "",
    attachments,
    ignored,
  };
}

export function formatCep(value) {
  const digits = String(value || "").replace(/\D/g, "").slice(0, 8);
  return digits.length === 8 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : "";
}

// Cada texto vira um documento classificado (carnê ou matrícula) com os campos que o leitor do site extrai.
// Texto curto = PDF sem camada de texto (na Entrega 2 é o gatilho do OCR). Dois do mesmo tipo = ambíguo.
export function readDocuments(texts) {
  const { detectDocumentType, extractFields, extractIptuFields } = globalThis.AVMMatricula;
  const docs = texts.map(({ fileName, text, method }) => {
    const clean = String(text || "").slice(0, LIMITS.maxTextChars);
    const unreadable = clean.trim().length < LIMITS.minTextChars;
    const type = detectDocumentType(clean);
    const fields = unreadable ? null : (type === "iptu" ? extractIptuFields(clean) : extractFields(clean));
    return { fileName, type, method, fields, unreadable, apartment: type === "matricula" && /\bapartamento\b/iu.test(clean) };
  });
  const readable = docs.filter((d) => !d.unreadable);
  const ambiguous = readable.filter((d) => d.type === "matricula").length > 1 ? "matricula"
    : readable.filter((d) => d.type === "iptu").length > 1 ? "iptu" : null;
  return { docs, ambiguous };
}

// Monta o mesmo objeto que getInputs() monta no site. Matrícula manda no endereço e na área; carnê nas
// outras três (endereço/CEP do carnê só como reserva). Faltou campo → lista exata, sem adivinhar.
export function buildInputs(docs, ambiguous = null) {
  if (ambiguous) return { ambiguous };
  const matricula = docs.find((d) => d.type === "matricula" && !d.unreadable) || null;
  const iptu = docs.find((d) => d.type === "iptu" && !d.unreadable) || null;
  const m = matricula?.fields || {};
  const i = iptu?.fields || {};
  const missing = [];
  if (!m.area) missing.push("área privativa (esperada na matrícula)");
  if (!docs.some((d) => d.type === "matricula")) missing.push("nenhuma matrícula identificada entre os anexos");
  if (!i.yearBuilt) missing.push("ano de construção (esperado no carnê de IPTU)");
  if (!i.patternCode) missing.push(i.patternLabel ? `padrão cadastral ${i.patternLabel} não é residencial vertical (2-A a 2-E)` : "padrão cadastral (esperado no carnê de IPTU)");
  if (!i.fiscal) missing.push("valor do m² do terreno (esperado no carnê de IPTU)");
  if (!docs.some((d) => d.type === "iptu")) missing.push("nenhum carnê de IPTU identificado entre os anexos");
  const address = m.address || i.address || "";
  if (!address) missing.push("endereço (esperado na matrícula ou no carnê)");
  if (missing.length) return { missing };
  if (!matricula.apartment) return { notApartment: true };

  const cep = formatCep(i.cep || m.cep || "");
  const read = [iptu, matricula];
  const yearBuilt = i.yearBuilt;
  return {
    v: {
      address,
      district: "",
      cep,
      cep8: cep.replace("-", ""),
      area: m.area,
      age: model.applicability.base_year - yearBuilt,
      yearBuilt,
      pattern: String(i.patternCode),
      fiscal: i.fiscal,
      financing: "SFH",
      funds: "SBPE",
      declared: true, // premissa verificada acima: a matrícula descreve um apartamento
      enabledVariables: [...model.variable_order],
      documentSource: {
        fileName: read.map((d) => d.fileName).join(" + "),
        method: [...new Set(read.map((d) => d.method))].join(" e "),
        addressFound: true,
        areaFound: true,
        areaLabel: m.areaLabel,
        ageFound: true,
        patternFound: true,
        fiscalFound: true,
        cepFromDocument: Boolean(cep),
        geocode: null,
      },
    },
  };
}

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const areaNumber = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 4 });
const SITE = "https://avm.heybrain.uk";
const HEADER = "AVM SP — estimativa estatística de valor. Não é laudo nem avaliação (NBR 14653-2).";
const FOOTER = `Mensagem automática. Os anexos foram processados em memória e não foram armazenados.`;

const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));

function subjectFor(original) {
  const clean = String(original || "").replace(/[\r\n]+/g, " ").trim();
  return clean ? `Re: ${clean}` : "AVM SP — estimativa";
}

// Um bloco por parágrafo; o HTML é o mesmo texto, parágrafo a parágrafo, sem imagens nem CSS externo.
function render(subject, blocks) {
  const paragraphs = blocks.filter(Boolean);
  return {
    subject,
    text: paragraphs.join("\n\n") + "\n",
    html: `<!doctype html><html lang="pt-BR"><body>${paragraphs.map((p) => `<p>${escapeHtml(p).replaceAll("\n", "<br>")}</p>`).join("")}</body></html>`,
  };
}

const list = (items) => items.map((item) => `- ${item}`).join("\n");
const unreadableLine = (files) => (files.length ? `Não foi possível ler: ${files.join(", ")} (sem camada de texto).` : null);
const ignoredLine = (files) => (files.length ? `Ignorados: ${files.join(", ")}.` : null);

// Monta os textos da resposta (assunto, texto puro e HTML) a partir do relatório ou do motivo de não haver um.
export function compose(kind, data) {
  const subject = subjectFor(data.subject);
  if (kind === "report") {
    const { report } = data;
    const p = report.property;
    const r = report.result;
    const place = [p.address, p.cep ? `CEP ${p.cep}` : null, p.district || null].filter(Boolean).join(" · ");
    return render(subject, [
      HEADER,
      `Identificação: ${report.id}\nImóvel: ${place}\nDados usados: área privativa ${areaNumber.format(p.area)} m² (matrícula) · idade ${p.age} ${p.age === 1 ? "ano" : "anos"} / ${p.yearBuilt} (IPTU) · padrão ${p.patternLabel} (IPTU) · VM2T ${money.format(p.fiscal)}/m² (IPTU)\nFaixa de 80% de probabilidade: ${money.format(r.interval80[0])} a ${money.format(r.interval80[1])}\nValor central: ${money.format(r.estimate)}${r.pricePerM2 ? ` (${money.format(r.pricePerM2)}/m²)` : ""}`,
      [`Documentos lidos: ${p.documentSource.fileName} — ${p.documentSource.method}.`, unreadableLine(data.unreadable || []), ignoredLine(data.ignored || [])].filter(Boolean).join(" "),
      "Premissas: apartamento residencial (conforme a matrícula); compra e venda; SFH / SBPE registrados no relatório, sem efeito na estimativa.",
      `Avisos:\n${list(report.risks)}`,
      `O relatório completo está no Excel anexo. Metodologia: ${SITE}/metodologia`,
      FOOTER,
    ]);
  }
  if (kind === "refused") {
    return render(subject, [HEADER, `A estimativa foi recusada porque o imóvel está fora do domínio do modelo:\n${list(data.reasons.map((reason) => reason.text))}\nNão há relatório.`, `Metodologia e limites: ${SITE}/metodologia`, FOOTER]);
  }
  if (kind === "missing") {
    return render(subject, [HEADER, `Não foi possível estimar. Faltou:\n${list(data.missing)}`, unreadableLine(data.unreadable || []), ignoredLine(data.ignored || []), "Reenvie com os documentos completos, em um único e-mail.", FOOTER]);
  }
  if (kind === "unreadable") {
    return render(subject, [HEADER, unreadableLine(data.unreadable), "Envie o PDF original digital.", FOOTER]);
  }
  if (kind === "ambiguous") {
    const what = data.ambiguous === "iptu" ? "mais de um carnê de IPTU" : "mais de uma matrícula";
    return render(subject, [HEADER, `Foram encontrados ${what} entre os anexos. Envie um imóvel por e-mail.`, FOOTER]);
  }
  throw new Error(`compose: tipo desconhecido ${kind}`);
}

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "AVM-SP/1 (avm@heybrain.uk)"; // política de uso do Nominatim: identificar a aplicação

// Texto de cada PDF pelo serviço de conversão do Workers AI (sem biblioteca de PDF no Worker).
async function extractTexts(ai, attachments) {
  const texts = [];
  for (const att of attachments) {
    // parseInbound só deixa passar PDF (imagens: Entrega 2, ver PDF_TYPE acima); nada mais chega aqui.
    let text = "";
    try {
      const [result] = await ai.toMarkdown(
        [{ name: att.fileName, blob: new Blob([att.bytes], { type: PDF_TYPE }) }],
        { output: { format: "text" }, conversionOptions: { pdf: { excludeMetadata: true } } },
      );
      text = String(result?.data || "");
    } catch (_) {
      text = ""; // serviço indisponível ou PDF corrompido: vira "não lido"
    }
    texts.push({ fileName: att.fileName, text, method: "texto do PDF" });
  }
  return texts;
}

// Uma consulta, só para o bairro; o CEP do documento prevalece (mesma regra do site). Falha → sem bairro.
async function lookupDistrict(fetchFn, v) {
  try {
    const params = new URLSearchParams({ q: `${v.address}, São Paulo, SP, Brasil`, format: "jsonv2", addressdetails: "1", countrycodes: "br", limit: "5", dedupe: "1", "accept-language": "pt-BR" });
    const response = await fetchFn(`${NOMINATIM}?${params}`, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return;
    const results = await response.json();
    const candidate = (Array.isArray(results) ? results : []).find((item) => item.address?.postcode) || results[0];
    const details = candidate?.address || {};
    v.district = details.suburb || details.neighbourhood || details.quarter || details.city_district || "";
    if (!v.cep8 && details.postcode) { v.cep = formatCep(details.postcode); v.cep8 = v.cep.replace("-", ""); }
    if (v.documentSource) v.documentSource.geocode = "OpenStreetMap/Nominatim";
  } catch (_) { /* sem bairro: o relatório sai assim mesmo */ }
}

// Do e-mail bruto à resposta pronta. Nada persiste; deps traz os serviços para o teste injetar os seus.
export async function processEmail({ raw, subject }, deps) {
  const now = deps.now || new Date();
  const inbound = await parseInbound(raw);
  const texts = await extractTexts(deps.ai, inbound.attachments);
  const { docs, ambiguous } = readDocuments(texts);
  const unreadable = docs.filter((d) => d.unreadable).map((d) => d.fileName);
  const log = { documents: docs.length, unreadable: unreadable.length, ocr_pages: 0 };
  const finish = (outcome, reply) => ({ outcome, reply: { ...reply, attachments: reply.attachments || [] }, messageId: inbound.messageId, log });
  const base = { subject: subject ?? inbound.subject, unreadable, ignored: inbound.ignored };

  if (docs.length && unreadable.length === docs.length) return finish("unreadable", compose("unreadable", base));
  const built = buildInputs(docs, ambiguous);
  if (built.ambiguous) return finish("ambiguous", compose("ambiguous", { ...base, ambiguous: built.ambiguous }));
  if (built.missing) return finish("missing", compose("missing", { ...base, missing: built.missing }));
  if (built.notApartment) return finish("refused", compose("refused", { ...base, reasons: [{ code: "apartment", text: "a matrícula não descreve um apartamento; o modelo cobre apenas apartamentos residenciais" }] }));

  const { v } = built;
  await lookupDistrict(deps.fetch, v);
  const { AvmReport, AVMExcel } = globalThis;
  const computed = AvmReport.estimate(model, v);
  if (computed.refused) return finish("refused", compose("refused", { ...base, reasons: computed.refused }));
  const report = await AvmReport.build(model, v, computed, now);
  const bytes = AVMExcel.buildWorkbook(report);
  const content = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return finish("report", { ...compose("report", { ...base, report }), attachments: [{ filename: `${report.id}.xlsx`, content, type: XLSX_TYPE, disposition: "attachment" }] });
}

export { model }; // o mesmo model.json do site, empacotado no Worker
