// Worker mínimo: recebe avisos técnicos anônimos do front em POST /api/erro e os grava em Workers Logs.
// Tudo o mais é servido pelo binding de assets (html_handling, not_found_handling e _headers continuam valendo).
// Só roda antes dos assets em /api/* (assets.run_worker_first). Nenhum dado do imóvel ou do usuário é aceito:
// o corpo é validado campo a campo e truncado; IP/UA não são gravados além do que a plataforma já registra.
const MAX_BODY = 2048;
const KINDS = new Set(["model_load_failed", "js_error", "unhandled_rejection", "ocr_failed", "refused"]);
const TEXT = (value, max) => (typeof value === "string" ? value.slice(0, max) : undefined);
const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/erro") {
      return env.ASSETS.fetch(request); // 404.html e _headers vêm do próprio serviço de assets
    }
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { ...SECURITY_HEADERS, allow: "POST" } });
    }
    const raw = await request.text();
    if (raw.length > MAX_BODY) return new Response(null, { status: 413, headers: SECURITY_HEADERS });
    let body;
    try { body = JSON.parse(raw); } catch { return new Response(null, { status: 400, headers: SECURITY_HEADERS }); }
    if (!body || !KINDS.has(body.kind)) return new Response(null, { status: 400, headers: SECURITY_HEADERS });

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
    return new Response(null, { status: 204, headers: SECURITY_HEADERS });
  },
};
