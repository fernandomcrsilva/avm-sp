(function attachMatriculaReader(global) {
  "use strict";

  const MAX_FILE_BYTES = 25 * 1024 * 1024;
  const MAX_TEXT_PAGES = 12;
  const MAX_OCR_PAGES = 4;
  const NUMBER_PATTERN = "(?:\\d{1,4}(?:\\.\\d{3})*(?:,\\d+)?|\\d{1,4}(?:[.,]\\d+)?)";
  const AREA_UNIT = "(?:m\\s*[²2]|metros?\\s+quadrados?)";
  const SCRIPT_BASE_URL = new URL(".", document.currentScript.src); // script clássico: sempre definido

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
    const regex = new RegExp(`\\b${street}\\s+([\\p{L}\\d][\\p{L}\\d .'’´-]{1,90}?)${marker}(\\d{1,6}[A-Z]?)\\b`, "giu");
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
        address: `${canonicalStreetType(match[1])} ${titleCaseStreet(name)}, ${match[3]}`,
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
        const viewport = page.getViewport({ scale: 1.7 });
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
    if (!file) throw new Error("Selecione uma matrícula em PDF ou imagem.");
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
        const firstPass = extractFields(text);
        if (!firstPass.address || !firstPass.area) {
          try {
            const ocrText = await ocrPdf(pdf, onProgress);
            text = `${text}\n${ocrText}`;
            method = text.trim() ? "texto do PDF + OCR" : "OCR";
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

    onProgress({ message: "Interpretando endereço e área…", progress: 0.95 });
    const fields = extractFields(text);
    const warnings = [warning];
    if (!fields.address) warnings.push("Endereço não localizado; informe-o manualmente");
    if (!fields.area) warnings.push("Área privativa não localizada; informe-a manualmente");
    warning = warnings.filter(Boolean).join(". ") || null;
    if (!fields.address && !fields.area) {
      throw new Error(`Não foi possível localizar o endereço nem a área privativa. ${warning || "Confira a nitidez do documento e preencha manualmente."}`);
    }
    return { ...fields, method, warning, fileName: file.name };
  }

  global.AVMMatricula = Object.freeze({ extractFields, parsePtNumber, read, resolveAssetUrl });
}(typeof window !== "undefined" ? window : globalThis));
