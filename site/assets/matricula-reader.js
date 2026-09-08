(function attachMatriculaReader(global) {
  "use strict";

  const MAX_FILE_BYTES = 25 * 1024 * 1024;
  const MAX_TEXT_PAGES = 12;
  const MAX_OCR_PAGES = 4;
  const NUMBER_PATTERN = "(?:\\d{1,4}(?:\\.\\d{3})*(?:,\\d+)?|\\d{1,4}(?:[.,]\\d+)?)";
  const AREA_UNIT = "(?:m\\s*[²2]|metros?\\s+quadrados?)";
  // Script clássico: no navegador currentScript está sempre definido; em Node (tests/) só a extração é usada.
  const SCRIPT_BASE_URL = typeof document !== "undefined" && document.currentScript ? new URL(".", document.currentScript.src) : null;

  function resolveAssetUrl(fileName) {
    return new URL(fileName, SCRIPT_BASE_URL).href;
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/\u00ad/g, "")
      .replace(/[\t\r]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ ]{2,}/g, " ")
      .trim();
  }

  function parsePtNumber(value) {
    let raw = String(value || "").replace(/\s/g, "");
    if (raw.includes(",")) raw = raw.replaceAll(".", "").replace(",", ".");
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function canonicalStreetType(value) {
    const key = value.toLocaleUpperCase("pt-BR").replaceAll(".", "");
    const names = {
      R: "Rua", RUA: "Rua", AV: "Avenida", AVENIDA: "Avenida", ALAMEDA: "Alameda",
      TRAVESSA: "Travessa", PRACA: "Praça", "PRAÇA": "Praça", ESTRADA: "Estrada",
      RODOVIA: "Rodovia", LARGO: "Largo", VIELA: "Viela", PASSAGEM: "Passagem",
    };
    return names[key] || value;
  }

  function titleCaseStreet(value) {
    const keepLower = new Set(["da", "das", "de", "do", "dos", "e"]);
    return String(value).toLocaleLowerCase("pt-BR").split(/\s+/).map((part, index) => {
      if (index > 0 && keepLower.has(part)) return part;
      return part ? part[0].toLocaleUpperCase("pt-BR") + part.slice(1) : part;
    }).join(" ");
  }

  function extractAddress(text) {
    const flat = cleanText(text).replace(/\s*\n\s*/g, " ");
    const street = "(RUA|R\\.|AVENIDA|AV\\.|ALAMEDA|TRAVESSA|PRAÇA|PRACA|ESTRADA|RODOVIA|LARGO|VIELA|PASSAGEM)";
    const marker = "(?:,\\s*(?:(?:N(?:ÚMERO|UMERO|[º°O])?|NRO)\\.?\\s*)?|\\s+(?:(?:N(?:ÚMERO|UMERO|[º°O])?|NRO)\\.?\\s*))";
    const regex = new RegExp(`\\b${street}\\s+([\\p{L}\\d][\\p{L}\\d .'’´-]{1,90}?)${marker}(\\d{1,6}(?:\\.\\d{3})?[A-Z]?)\\b`, "giu"); // "nº 2.650" com ponto de milhar
    const candidates = [];
    for (const match of flat.matchAll(regex)) {
      const name = match[2].replace(/[.,;:\s]+$/g, "").trim();
      if (name.length < 3) continue;
      const before = flat.slice(Math.max(0, match.index - 110), match.index).toLocaleLowerCase("pt-BR");
      const closeBefore = flat.slice(Math.max(0, match.index - 55), match.index).toLocaleLowerCase("pt-BR");
      const after = flat.slice(match.index, match.index + match[0].length + 100).toLocaleLowerCase("pt-BR");
      let score = 0;
      if (/im[oó]vel|apartamento|unidade|situad|localizad|sito|objeto/.test(closeBefore + after)) score += 6;
      if (/cart[oó]rio|registro de im[oó]veis|oficial|tabeli[aã]o|serventia/.test(closeBefore)) score -= 8;
      if (match.index < flat.length * 0.35) score += 2;
      candidates.push({
        address: `${canonicalStreetType(match[1])} ${titleCaseStreet(name)}, ${match[3].replace(".", "")}`,
        score,
        index: match.index,
      });
    }
    candidates.sort((a, b) => b.score - a.score || a.index - b.index);
    return candidates[0]?.address || null;
  }

  function extractArea(text) {
    const flat = cleanText(text).replace(/\s*\n\s*/g, " ");
    const definitions = [
      ["Área privativa", 50, "(?:área\\s+)?(?:real\\s+)?privativa(?:\\s+(?:total|coberta|principal|da\\s+unidade))?"],
    ];
    const candidates = [];
    definitions.forEach(([label, priority, expression]) => {
      const regex = new RegExp(`${expression}[^0-9]{0,55}(${NUMBER_PATTERN})\\s*${AREA_UNIT}(?![\\p{L}\\d])`, "giu");
      for (const match of flat.matchAll(regex)) {
        const area = parsePtNumber(match[1]);
        if (!(area > 5 && area < 5000)) continue;
        const inModelRange = area >= 35 && area <= 250;
        candidates.push({ area, label, score: priority + (inModelRange ? 5 : 0), index: match.index });
      }
    });
    candidates.sort((a, b) => b.score - a.score || a.index - b.index);
    if (!candidates.length) return { area: null, areaLabel: null };
    return { area: Math.round(candidates[0].area * 10000) / 10000, areaLabel: candidates[0].label };
  }

  function extractFields(text) {
    const cleaned = cleanText(text);
    const area = extractArea(cleaned);
    const cepMatch = cleaned.match(/\b\d{5}-?\d{3}\b/);
    return {
      address: extractAddress(cleaned),
      area: area.area,
      areaLabel: area.areaLabel,
      cep: cepMatch ? cepMatch[0].replace(/(\d{5})(\d{3})/, "$1-$2") : null,
      textLength: cleaned.length,
    };
  }

  // Carnê ou matrícula? Uma matrícula cita "contribuinte" e "IPTU" nas averbações, então cada lado pontua e
  // os marcadores fortes (cabeçalho do carnê, cartório) pesam mais. Sem texto (digitalizado) cai em matrícula
  // e o OCR decide depois.
  function detectDocumentType(text) {
    const flat = cleanText(text).normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleUpperCase("pt-BR");
    const score = (patterns, weight) => patterns.reduce((total, pattern) => total + (pattern.test(flat) ? weight : 0), 0);
    const iptu = score([/NOTIFICACAO DE LANCAMENTO/, /IMPOSTO PREDIAL/], 3) + score([/\bIPTU\b/, /NUMERO DO CONTRIBUINTE/, /VALOR VENAL/, /TIPO\s*\/\s*PADRAO/], 1);
    const matricula = score([/REGISTRO DE IMOVEIS/, /\bMATRICULA\b/], 3) + score([/\bOFICIAL\b/, /AVERBACAO/, /\bAV\.\s*\d/], 1);
    return iptu > matricula ? "iptu" : "matricula";
  }

  // Notificação de Lançamento do IPTU (PMSP): traz o que a matrícula não tem — ano de construção, tipo/padrão
  // e valor do m² do terreno (VM2T da PGV). A área construída do carnê é ignorada de propósito: o modelo usa a
  // área privativa da matrícula. Só o tipo 2 (residencial vertical) vira código; os demais ficam fora do modelo.
  const IPTU_STREET_ABBREVIATIONS = { R: "Rua", AV: "Avenida", AL: "Alameda", TV: "Travessa", PC: "Praça", "PÇ": "Praça", EST: "Estrada", ROD: "Rodovia", LGO: "Largo", VLA: "Viela" };

  function extractIptuFields(text) {
    // O cadastro abrevia o logradouro sem ponto ("R VERGUEIRO, 2650"); expandido, o extrator da matrícula serve.
    const flat = cleanText(text).replace(/\s*\n\s*/g, " ")
      .replace(/\b(R|AV|AL|TV|PC|PÇ|EST|ROD|LGO|VLA)\s+(?=\p{L})/gu, (_, abbreviation) => `${IPTU_STREET_ABBREVIATIONS[abbreviation]} `);
    const first = (regex) => flat.match(regex)?.[1] ?? null;
    const year = Number(first(/ano\s+d[aeo]\s+constru[çc][ãa]o(?:\s+corrigido)?[^0-9]{0,15}((?:19|20)\d{2})\b/iu));
    const pattern = flat.match(/(?:tipo\s*\/\s*padr[ãa]o|padr[ãa]o(?:\s+d[aeo]\s+constru[çc][ãa]o)?)[^0-9A-Z]{0,15}(\d)\s*[-–/ ]?\s*([A-E])\b/iu)
      || flat.match(/\btipo[^0-9]{0,6}(\d)[^A-Z]{0,25}padr[ãa]o[^A-Z]{0,6}([A-E])\b/iu);
    // "Valor do m² do Terreno" ou "Valor Unitário do Terreno"; "Valor Venal do Terreno" (total) fica de fora.
    const fiscal = parsePtNumber(first(new RegExp(`valor\\s+(?:unit[áa]rio\\s+(?:do\\s+m\\s*[²2]?\\s+)?|do\\s+m\\s*[²2]?\\s+)d[eo]\\s+terreno[^0-9]{0,20}(${NUMBER_PATTERN})`, "iu")));
    const cep = first(/\bCEP\b[^0-9]{0,6}(\d{5}-?\d{3})\b/iu) || first(/\b(\d{5}-\d{3})\b/u);
    const letterIndex = pattern ? "ABCDE".indexOf(pattern[2].toUpperCase()) : -1;
    return {
      sql: first(/\b(\d{3}\.\d{3}\.\d{4}-\d)\b/u), // setor.quadra.lote-dígito, formato do cadastro imobiliário de SP
      yearBuilt: year >= 1900 && year <= new Date().getFullYear() + 1 ? year : null,
      patternCode: pattern && pattern[1] === "2" && letterIndex >= 0 ? 20 + letterIndex : null,
      patternLabel: pattern ? `${pattern[1]}-${pattern[2].toUpperCase()}` : null,
      fiscal: fiscal > 0 ? fiscal : null,
      address: extractAddress(flat),
      cep: cep ? cep.replace(/(\d{5})-?(\d{3})/, "$1-$2") : null,
      textLength: flat.length,
    };
  }

  const READERS = {
    matricula: { extract: extractFields, complete: (f) => Boolean(f.address && f.area), missing: (f) => [!f.address && "Endereço não localizado", !f.area && "Área privativa não localizada"] },
    iptu: { extract: extractIptuFields, complete: (f) => Boolean(f.yearBuilt && f.patternCode && f.fiscal), missing: (f) => [!f.yearBuilt && "Ano de construção não localizado", !f.patternCode && (f.patternLabel ? `Tipo/padrão ${f.patternLabel} não é residencial vertical (2-A a 2-E)` : "Tipo/padrão não localizado"), !f.fiscal && "Valor do m² do terreno não localizado"] },
  };

  async function loadPdf(file, onProgress) {
    onProgress({ message: "Lendo o texto do PDF…", progress: 0.08 });
    const pdfjs = await import(resolveAssetUrl("vendor/pdf.min.mjs"));
    pdfjs.GlobalWorkerOptions.workerSrc = resolveAssetUrl("vendor/pdf.worker.min.mjs");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data: bytes }).promise;
    const parts = [];
    const pageCount = Math.min(pdf.numPages, MAX_TEXT_PAGES);
    for (let index = 1; index <= pageCount; index += 1) {
      const page = await pdf.getPage(index);
      const content = await page.getTextContent();
      parts.push(content.items.map((item) => `${item.str}${item.hasEOL ? "\n" : " "}`).join(""));
      onProgress({ message: `Lendo texto do PDF — página ${index} de ${pageCount}…`, progress: 0.08 + (index / pageCount) * 0.3 });
    }
    return { pdf, text: parts.join("\n") };
  }

  async function createOcrWorker(onProgress) {
    if (!global.Tesseract?.createWorker) throw new Error("O recurso de OCR não pôde ser carregado.");
    // Tudo local: o worker escolhe a variante do core (simd/relaxedsimd/base, sempre -lstm) dentro do
    // diretório e monta vendor/tessdata-…/por.traineddata.gz a partir de langPath. Sem CDN.
    return global.Tesseract.createWorker("por", 1, {
      workerPath: resolveAssetUrl("vendor/tesseract-worker.min.js"),
      corePath: resolveAssetUrl("vendor/tesseract-core-7.0.0"),
      langPath: resolveAssetUrl("vendor/tessdata-4.0.0_best_int"),
      cacheMethod: "none", // o cache HTTP imutável já cobre; evita gravar 2,4 MB no IndexedDB
      workerBlobURL: false,
      logger: (message) => {
        if (message.status === "recognizing text") {
          onProgress({ message: `Reconhecendo o documento por OCR — ${Math.round((message.progress || 0) * 100)}%…`, progress: 0.42 + (message.progress || 0) * 0.5 });
        }
      },
    });
  }

  async function ocrImage(file, onProgress) {
    onProgress({ message: "Preparando reconhecimento OCR…", progress: 0.4 });
    const worker = await createOcrWorker(onProgress);
    try {
      const result = await worker.recognize(file);
      return result.data.text || "";
    } finally {
      await worker.terminate();
    }
  }

  async function ocrPdf(pdf, onProgress) {
    onProgress({ message: "O PDF parece digitalizado. Iniciando OCR…", progress: 0.4 });
    const worker = await createOcrWorker(onProgress);
    const parts = [];
    const pageCount = Math.min(pdf.numPages, MAX_OCR_PAGES);
    try {
      for (let index = 1; index <= pageCount; index += 1) {
        const page = await pdf.getPage(index);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(1.7, Math.sqrt(25e6 / (base.width * base.height))); // teto de 25 Mpx por página (VULN-012)
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport, intent: "print" }).promise; // sem requestAnimationFrame: renderiza mesmo com a aba em segundo plano
        onProgress({ message: `Aplicando OCR — página ${index} de ${pageCount}…`, progress: 0.42 });
        const result = await worker.recognize(canvas);
        parts.push(result.data.text || "");
        canvas.width = 1;
        canvas.height = 1;
      }
      return parts.join("\n");
    } finally {
      await worker.terminate();
    }
  }

  async function read(file, onProgress = () => {}) {
    if (!file) throw new Error("Selecione um documento em PDF ou imagem.");
    if (file.size > MAX_FILE_BYTES) throw new Error("O arquivo deve ter no máximo 25 MB.");
    const isPdf = file.type === "application/pdf" || file.name.toLocaleLowerCase("pt-BR").endsWith(".pdf");
    const isImage = /^image\/(png|jpeg|webp)$/i.test(file.type);
    if (!isPdf && !isImage) throw new Error("Formato não aceito. Use PDF, JPG, PNG ou WebP.");

    let text = "";
    let method = "OCR";
    let warning = null;
    let pdf = null;
    try {
      if (isPdf) {
        const loaded = await loadPdf(file, onProgress);
        pdf = loaded.pdf;
        text = loaded.text;
        method = "texto do PDF";
        const firstPass = READERS[detectDocumentType(text)];
        if (!firstPass.complete(firstPass.extract(text))) { // camada de texto insuficiente (ou ausente): OCR completa
          try {
            const ocrText = await ocrPdf(pdf, onProgress);
            text = `${text}\n${ocrText}`;
            method = loaded.text.trim() ? "texto do PDF + OCR" : "OCR";
          } catch (error) {
            warning = `OCR indisponível: ${error.message}`;
          }
        }
      } else {
        text = await ocrImage(file, onProgress);
      }
    } finally {
      if (pdf) await pdf.destroy();
    }

    const type = detectDocumentType(text); // só agora o texto está completo (com OCR, se houve)
    const reader = READERS[type];
    onProgress({ message: type === "iptu" ? "Interpretando ano, padrão e valor do terreno…" : "Interpretando endereço e área…", progress: 0.95 });
    const fields = reader.extract(text);
    const checks = reader.missing(fields);
    const missing = checks.filter(Boolean);
    warning = [warning, ...missing].filter(Boolean).join(". ") || null;
    if (missing.length === checks.length) {
      throw new Error(`Não foi possível ler ${type === "iptu" ? "o carnê de IPTU" : "a matrícula"}. ${warning}. Confira a nitidez do documento.`);
    }
    return { type, ...fields, method, warning, fileName: file.name };
  }

  global.AVMMatricula = Object.freeze({ detectDocumentType, extractFields, extractIptuFields, parsePtNumber, read, resolveAssetUrl });
}(typeof window !== "undefined" ? window : globalThis));
