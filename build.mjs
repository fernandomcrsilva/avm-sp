// Build do site estático: copia site/ para dist/ e dá fingerprint (sha256[0:8]) a tudo em assets/,
// reescrevendo as referências entre aspas. Só stdlib do Node; não há bundler.
// ponytail: ordem fixa (folhas → scripts → html) em vez de grafo de dependências. Hoje só
// matricula-reader.js referencia vendor/, e index.html referencia o resto. Se um script passar a
// importar outro script, mova-o para a lista de folhas ou generalize.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, posix, relative, sep } from "node:path";

const SRC = "site";
const OUT = "dist";
const QUOTES = ['"', "'", "`"];

rmSync(OUT, { recursive: true, force: true });
cpSync(SRC, OUT, { recursive: true });

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
const rel = (file) => relative(OUT, file).split(sep).join("/");
const sha8 = (buffer) => createHash("sha256").update(buffer).digest("hex").slice(0, 8);

// Diretórios versionados no nome (ex.: vendor/tessdata-4.0.0/) não recebem fingerprint por arquivo:
// o worker do Tesseract monta os nomes (por.traineddata.gz, core .wasm.js) a partir do diretório.
const VERSIONED_DIR = /^assets\/vendor\/(tesseract-core|tessdata)-[^/]+\//;
const assets = walk(join(OUT, "assets")).filter((file) => !VERSIONED_DIR.test(rel(file)));
const isScript = (file) => /\.(js|mjs)$/.test(file) && !rel(file).startsWith("assets/vendor/");
const leaves = assets.filter((file) => !isScript(file));
const scripts = assets.filter(isScript);
const renamed = new Map(); // caminho original → caminho com fingerprint (ambos relativos a dist/)

function fingerprint(file) {
  const buffer = readFileSync(file);
  const ext = extname(file); // "" para arquivos sem extensão (ex.: PDFJS-LICENSE)
  const target = `${ext ? file.slice(0, -ext.length) : file}.${sha8(buffer)}${ext}`;
  renameSync(file, target);
  renamed.set(rel(file), rel(target));
}

// Substitui "caminho/relativo" por "caminho/relativo.sha8" para cada asset já renomeado,
// resolvendo o caminho relativo ao diretório do arquivo que referencia.
function rewrite(file) {
  const dir = posix.dirname(rel(file));
  let text = readFileSync(file, "utf8");
  let changed = false;
  for (const [from, to] of renamed) {
    // relativo ao arquivo ("assets/app.js" em index.html, "vendor/x.mjs" em assets/*.js)
    // ou absoluto a partir da raiz ("/assets/styles.css" em 404.html, que é servido em qualquer path)
    const pairs = [[posix.relative(dir, from), posix.relative(dir, to)], [`/${from}`, `/${to}`]];
    for (const [a, b] of pairs) {
      for (const q of QUOTES) {
        const needle = `${q}${a}${q}`;
        if (text.includes(needle)) {
          text = text.split(needle).join(`${q}${b}${q}`);
          changed = true;
        }
      }
    }
  }
  if (changed) writeFileSync(file, text);
}

for (const file of leaves) fingerprint(file);
for (const file of scripts) { rewrite(file); fingerprint(file); }
for (const file of walk(OUT).filter((file) => file.endsWith(".html"))) rewrite(file);

// /version.json: o que está no ar sem abrir o dashboard (Fase 8). Servido com no-store via _headers.
const model = JSON.parse(readFileSync(join(SRC, "assets", "model.json"), "utf8"));
const gitSha = process.env.GITHUB_SHA || (() => { try { return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(); } catch { return "unknown"; } })();
writeFileSync(join(OUT, "version.json"), `${JSON.stringify({
  git_sha: gitSha,
  built_at: new Date().toISOString(),
  model_version: model.version,
  model_trained_at: model.trained_at,
  model_asset: renamed.get("assets/model.json"),
}, null, 1)}\n`);
console.log(`${renamed.size} assets com fingerprint em ${OUT}/`);
for (const [from, to] of renamed) console.log(`  ${from} -> ${to}`);
