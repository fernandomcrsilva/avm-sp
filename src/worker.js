// Worker mínimo: recebe avisos técnicos anônimos do front em POST /api/erro e os grava em Workers Logs.
// Tudo o mais é servido pelo binding de assets (html_handling, not_found_handling e _headers continuam valendo).
// Só roda antes dos assets em /api/* (assets.run_worker_first). Nenhum dado do imóvel ou do usuário é aceito:
// o corpo é validado campo a campo e truncado; IP/UA não são gravados além do que a plataforma já registra.
// Auditoria 2026-09-07 (VULN-005): tudo o que é barato é verificado ANTES de ler o corpo (host, método, origem,
// tipo, tamanho declarado, limite por IP); caracteres de controle saem do que vai para o log.
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
};
