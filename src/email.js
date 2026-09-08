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
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function attachmentType(att) {
  const name = String(att.filename || "").toLocaleLowerCase("pt-BR");
  const type = String(att.mimeType || "").toLocaleLowerCase("pt-BR").split(";")[0].trim();
  if (type === PDF_TYPE || name.endsWith(".pdf")) return PDF_TYPE;
  if (IMAGE_TYPES.has(type)) return type;
  return null;
}

// Lê o MIME e separa o que o pipeline aceita (PDF; imagens ficam para a Entrega 2) do que é ignorado.
export async function parseInbound(raw) {
  const parsed = await PostalMime.parse(raw);
  const attachments = [];
  const ignored = [];
  for (const att of parsed.attachments || []) {
    const fileName = att.filename || "anexo";
    const mimeType = attachmentType(att);
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

export { model }; // o mesmo model.json do site, empacotado no Worker
