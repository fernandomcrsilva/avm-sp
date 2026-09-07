// POST /api/erro (src/worker.js): cada verificação barata é feita antes de ler o corpo, na ordem
// host → método → Sec-Fetch-Site → Content-Type → Content-Length → limite por IP; depois JSON e kind.
// Roda em Node puro com env falso; o wrangler dev não permite testar o host (normaliza para localhost).
import { test } from "node:test";
import assert from "node:assert/strict";

const worker = (await import("../src/worker.js")).default;
const logged = [];
const realError = console.error;
console.error = (line) => logged.push(JSON.parse(line));

let allow = true;
const env = {
  ERRO_RL: { limit: async () => ({ success: allow }) },
  ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
};
const OK = { "content-type": "application/json", "sec-fetch-site": "same-origin" };
const body = JSON.stringify({ kind: "js_error", message: "x\n y\u001b[31m", source: "app.js" });
const post = (headers = OK, data = body, url = "https://avm.heybrain.uk/api/erro") =>
  worker.fetch(new Request(url, { method: "POST", headers: { "content-length": String(new TextEncoder().encode(data).length), ...headers }, body: data }), env);

test("fora de /api/erro vai para os assets", async () => {
  assert.equal((await worker.fetch(new Request("https://avm.heybrain.uk/qualquer"), env)).status, 200);
});

test("aceita só same-origin JSON no domínio e sanitiza o log", async () => {
  const response = await post();
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(logged.at(-1).message, "x y[31m");
  assert.equal(logged.at(-1).kind, "js_error");
});

test("recusa antes de ler o corpo: host, método, origem, tipo, tamanho, limite", async () => {
  assert.equal((await post(OK, body, "https://avm-sp.heybrain.workers.dev/api/erro")).status, 404);
  assert.equal((await worker.fetch(new Request("https://avm.heybrain.uk/api/erro"), env)).status, 405);
  assert.equal((await post({ "content-type": "application/json" })).status, 403);
  assert.equal((await post({ ...OK, "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post({ ...OK, "content-type": "text/plain" })).status, 415);
  assert.equal((await post(OK, JSON.stringify({ kind: "js_error", message: "a".repeat(3000) }))).status, 413);
  allow = false;
  const limited = await post();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  allow = true;
});

test("corpo inválido ou kind desconhecido: 400", async () => {
  assert.equal((await post(OK, "{")).status, 400);
  assert.equal((await post(OK, JSON.stringify({ kind: "outro" }))).status, 400);
});

test.after(() => { console.error = realError; });
