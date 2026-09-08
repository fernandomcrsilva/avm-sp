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

export { model }; // o mesmo model.json do site, empacotado no Worker
