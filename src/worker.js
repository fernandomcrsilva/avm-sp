// Worker mínimo: recebe avisos técnicos anônimos do front em POST /api/erro e os grava em Workers Logs.
// Tudo o mais é servido pelo binding de assets (html_handling, not_found_handling e _headers continuam valendo).
// Só roda antes dos assets em /api/* (assets.run_worker_first). Nenhum dado do imóvel ou do usuário é aceito:
// o corpo é validado campo a campo e truncado; IP/UA não são gravados além do que a plataforma já registra.
// Auditoria 2026-09-07 (VULN-005): tudo o que é barato é verificado ANTES de ler o corpo (host, método, origem,
// tipo, tamanho declarado, limite por IP); caracteres de controle saem do que vai para o log.
import { processEmail } from "./email.js";

// Estimativa por e-mail (spec 2026-09-08, Entrega 1). Guardas na ordem barato → caro; nada do corpo é lido antes
// de o remetente passar. Só o envelope (message.from) autoriza; From/Reply-To são falsificáveis.
const MAX_RAW_BYTES = 20 * 1024 * 1024;

export function allowedSender(from, list) {
  const sender = String(from || "").trim().toLowerCase();
  if (!sender.includes("@")) return false;
  const domain = sender.slice(sender.lastIndexOf("@"));
  return String(list || "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean)
    .some((entry) => (entry.startsWith("@") ? entry === domain : entry === sender));
}

const HOSTS = new Set(["avm.heybrain.uk", "localhost"]); // localhost = wrangler dev. *.workers.dev fica de fora: não passa pelo rate limit da zona.
const MAX_BODY = 2048;
const KINDS = new Set(["model_load_failed", "js_error", "unhandled_rejection", "ocr_failed", "refused"]);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g; // C0, DEL e C1: nada de quebra de linha ou escape ANSI no log
const TEXT = (value, max) => (typeof value === "string" ? value.replace(CONTROL, "").slice(0, max) : undefined);
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};
const reply = (status, extra) => new Response(null, { status, headers: { ...SECURITY_HEADERS, ...extra } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/erro") {
      return env.ASSETS.fetch(request); // 404.html e _headers vêm do próprio serviço de assets
    }
    if (!HOSTS.has(url.hostname)) return reply(404);
    if (request.method !== "POST") return reply(405, { allow: "POST" });
    if (request.headers.get("sec-fetch-site") !== "same-origin") return reply(403); // só o próprio site (sendBeacon/fetch)
    if (!/^application\/json\b/i.test(request.headers.get("content-type") || "")) return reply(415);
    const length = request.headers.get("content-length") || "";
    if (!/^\d{1,4}$/.test(length) || Number(length) > MAX_BODY) return reply(413); // ausente ou grande demais: nem lê
    const { success } = await env.ERRO_RL.limit({ key: request.headers.get("cf-connecting-ip") || "" });
    if (!success) return reply(429, { "retry-after": "60" });

    const raw = await request.text();
    if (raw.length > MAX_BODY) return reply(413);
    let body;
    try { body = JSON.parse(raw); } catch { return reply(400); }
    if (!body || !KINDS.has(body.kind)) return reply(400);

    console.error(JSON.stringify({
      event: "front_error",
      kind: body.kind,
      message: TEXT(body.message, 200),
      source: TEXT(body.source, 120),      // nome do script próprio, sem query string
      codes: Array.isArray(body.codes) ? body.codes.slice(0, 8).map((c) => TEXT(c, 24)) : undefined,
      page: TEXT(body.page, 64),
      model_version: TEXT(body.model_version, 48),
      colo: request.cf?.colo,               // datacenter da Cloudflare, não localização do usuário
    }));
    return reply(204);
  },

  async email(message, env) {
    const started = Date.now();
    const log = (event, extra) => console.log(JSON.stringify({ event, ...extra, ms: Date.now() - started })); // nunca endereço, arquivo ou valores
    if (!allowedSender(message.from, env.ALLOWED_SENDERS)) { message.setReject("Remetente não autorizado para o AVM SP."); return log("email_rejected", { reason: "unauthorized" }); }
    // RFC 3834: não responder a mensagens automáticas — evita laço com respondedores; descartar em silêncio, sem bounce.
    const auto = (message.headers.get("auto-submitted") || "no").toLowerCase();
    const precedence = (message.headers.get("precedence") || "").toLowerCase();
    if (auto !== "no" || ["bulk", "list", "junk"].includes(precedence)) return log("email_dropped", { reason: "auto_submitted" });
    const { success } = await env.EMAIL_RL.limit({ key: String(message.from).toLowerCase() });
    if (!success) { message.setReject("Limite de envios atingido; aguarde um minuto."); return log("email_rejected", { reason: "ratelimit" }); }
    if (message.rawSize > MAX_RAW_BYTES) { message.setReject("Mensagem grande demais (máximo 20 MB)."); return log("email_rejected", { reason: "too_large" }); }

    let result;
    try {
      const raw = await new Response(message.raw).arrayBuffer(); // o stream é de uso único
      // O cabeçalho Subject bruto vem cru (RFC 2047 quando acentuado); processEmail usa o assunto já
      // decodificado pelo postal-mime (inbound.subject), então não é preciso — nem correto — repassá-lo aqui.
      result = await processEmail({ raw }, { ai: env.AI, fetch: globalThis.fetch });
    } catch (error) {
      message.setReject("Erro interno ao processar. Tente novamente.");
      return log("email_processed", { outcome: "error", error: error.name });
    }

    const messageId = message.headers.get("message-id") || result.messageId;
    // Máximo de 512 para o cabeçalho de conversa (o limite da plataforma é 2048 por valor; aqui é bem mais
    // conservador — um Message-ID real não chega perto disso). Longo demais: responde sem ele, nunca falha o envio.
    const headers = {
      "X-Auto-Response-Suppress": "All", // Microsoft: evita que o Outlook do destinatário dispare fora-do-escritório de volta
      ...(messageId && messageId.length <= 512 ? { "In-Reply-To": messageId, References: messageId } : {}),
    };
    try {
      await env.EMAIL.send({
        to: message.from,
        from: { email: env.EMAIL_FROM, name: "AVM SP" },
        subject: result.reply.subject,
        text: result.reply.text,
        html: result.reply.html,
        headers,
        ...(result.reply.attachments.length ? { attachments: result.reply.attachments } : {}),
      });
    } catch (error) {
      message.setReject("Falha temporária ao responder. Reenvie em alguns minutos.");
      return log("email_send_failed", { error: error.name });
    }
    return log("email_processed", { outcome: result.outcome, ...result.log });
  },
};
