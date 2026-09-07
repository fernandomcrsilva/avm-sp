(function attachExcelExporter(global) {
  "use strict";

  const encoder = new TextEncoder();

  function xml(value) {
    return String(value).replace(/[&<>'"]/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", '"': "&quot;",
    }[char]));
  }

  function columnName(index) {
    let value = index + 1;
    let name = "";
    while (value > 0) {
      value -= 1;
      name = String.fromCharCode(65 + (value % 26)) + name;
      value = Math.floor(value / 26);
    }
    return name;
  }

  function cell(value, style) {
    return { value, style: style || 0 };
  }

  function worksheetXml(rows, options) {
    const settings = options || {};
    const maxCols = Math.max(1, ...rows.map((row) => row.length));
    const maxRows = Math.max(1, rows.length);
    const columns = (settings.widths || []).map((width, index) =>
      `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
    const sheetRows = rows.map((row, rowIndex) => {
      const cells = row.map((raw, colIndex) => {
        if (raw === null || raw === undefined || raw === "") return "";
        const item = raw && typeof raw === "object" && Object.hasOwn(raw, "value") ? raw : cell(raw, rowIndex === 0 ? 1 : 0);
        if (item.value === null || item.value === undefined || (typeof item.value === "number" && !Number.isFinite(item.value))) return ""; // nunca "null"/"NaN" na planilha
        const ref = `${columnName(colIndex)}${rowIndex + 1}`;
        const style = item.style ? ` s="${item.style}"` : "";
        if (typeof item.value === "number" && Number.isFinite(item.value)) {
          return `<c r="${ref}"${style}><v>${item.value}</v></c>`;
        }
        if (typeof item.value === "boolean") {
          return `<c r="${ref}" t="b"${style}><v>${item.value ? 1 : 0}</v></c>`;
        }
        return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(item.value)}</t></is></c>`;
      }).join("");
      return `<row r="${rowIndex + 1}"${rowIndex === 0 ? ' ht="26" customHeight="1"' : ""}>${cells}</row>`;
    }).join("");
    const merges = settings.merges && settings.merges.length
      ? `<mergeCells count="${settings.merges.length}">${settings.merges.map((ref) => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>`
      : "";
    const frozen = settings.freezeRow
      ? '<sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      : '<sheetViews><sheetView showGridLines="0" workbookViewId="0"/></sheetViews>';
    const autoFilter = settings.autoFilter ? `<autoFilter ref="${settings.autoFilter}"/>` : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${columnName(maxCols - 1)}${maxRows}"/>${frozen}
  <sheetFormatPr defaultRowHeight="18"/>
  ${columns ? `<cols>${columns}</cols>` : ""}
  <sheetData>${sheetRows}</sheetData>${merges}${autoFilter}
  <pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.2" footer="0.2"/>
</worksheet>`;
  }

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function join(parts) {
    const size = parts.reduce((total, part) => total + part.length, 0);
    const output = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { output.set(part, offset); offset += part.length; }
    return output;
  }

  function u16(view, offset, value) { view.setUint16(offset, value, true); }
  function u32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

  function zipStore(entries) {
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    for (const entry of entries) {
      const name = encoder.encode(entry.name);
      const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
      const crc = crc32(data);
      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      u32(lv, 0, 0x04034B50); u16(lv, 4, 20); u16(lv, 6, 0x0800); u16(lv, 8, 0);
      u16(lv, 10, dosTime); u16(lv, 12, dosDate); u32(lv, 14, crc); u32(lv, 18, data.length); u32(lv, 22, data.length);
      u16(lv, 26, name.length); u16(lv, 28, 0); local.set(name, 30);
      localParts.push(local, data);

      const central = new Uint8Array(46 + name.length);
      const cv = new DataView(central.buffer);
      u32(cv, 0, 0x02014B50); u16(cv, 4, 20); u16(cv, 6, 20); u16(cv, 8, 0x0800); u16(cv, 10, 0);
      u16(cv, 12, dosTime); u16(cv, 14, dosDate); u32(cv, 16, crc); u32(cv, 20, data.length); u32(cv, 24, data.length);
      u16(cv, 28, name.length); u16(cv, 30, 0); u16(cv, 32, 0); u16(cv, 34, 0); u16(cv, 36, 0);
      u32(cv, 38, 0); u32(cv, 42, localOffset); central.set(name, 46);
      centralParts.push(central);
      localOffset += local.length + data.length;
    }

    const centralData = join(centralParts);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    u32(ev, 0, 0x06054B50); u16(ev, 4, 0); u16(ev, 6, 0); u16(ev, 8, entries.length); u16(ev, 10, entries.length);
    u32(ev, 12, centralData.length); u32(ev, 16, localOffset); u16(ev, 20, 0);
    return join([...localParts, centralData, end]);
  }

  function buildWorkbook(report) {
    const p = report.property;
    const r = report.result;
    const m = report.model;
    const used = (key, value) => (report.variables.disabled.includes(key) ? "Não usada (variável desabilitada)" : value); // VULN-006

    const summaryRows = [
      [cell("AVM SP — ESTIMATIVA ESTATÍSTICA DE VALOR", 3)],
      [],
      [cell("Identificação", 4), cell(report.id, 4)],
      ["Data e hora de emissão", new Date(report.issuedAt).toLocaleString("pt-BR")],
      ["Finalidade", report.purpose],
      [],
      [cell("RESULTADO", 4), cell("VALOR", 4)],
      [`Faixa de ${m.coverageNominal}% — limite inferior`, cell(r.interval80[0], 2)],
      [`Faixa de ${m.coverageNominal}% — limite superior`, cell(r.interval80[1], 2)],
      ["Valor central", cell(r.estimate, 2)],
      ["Valor unitário", r.pricePerM2 === null ? "Não calculado (área não usada)" : cell(r.pricePerM2, 2)],
      ["Domínio", r.scope],
      ["Data-base dos preços", m.referenceDateLabel],
      ["Valor fiscal PGV informado", used("fiscal", cell(p.fiscal, 2))],
      ["Área construída informada", used("area", cell(p.area, 8))],
      ["Ano de conclusão / idade", used("age", `${p.yearBuilt} / ${p.age}`)],
      ["Variáveis ativas", report.variables.enabled.map((item) => report.variables.labels[item]).join(", ")],
      ["Modelo selecionado", report.variables.modelKey],
      ["Origem do preenchimento", p.documentSource ? `${p.documentSource.fileName} — ${p.documentSource.method}` : "Informação manual"],
      [],
      [cell("OBSERVAÇÃO", 4), cell("DESCRIÇÃO", 4)],
      ["Natureza", "Estimativa estatística gerada automaticamente, sem vistoria e sem análise jurídica. Não é laudo nem avaliação de imóvel na acepção da NBR 14653-2 e não serve para garantia, financiamento, inventário ou fins judiciais."],
      ["Base", "Somente transações declaradas como 1.Compra e venda em guias de ITBI pagas; não são anúncios."],
      ["Condomínio", "O valor da taxa condominial não integra as variáveis do modelo nem influencia a precificação."],
    ];

    const propertyRows = [
      [cell("DADOS DECLARADOS DO IMÓVEL", 3)],
      [],
      ["Endereço", "CEP", "Cidade", "UF", "Tipologia", "Área construída (m²)", "Ano de conclusão (IPTU)", "Idade (anos)", "Padrão IPTU", "VM2T PGV (R$/m² terreno)", "Variáveis ativas", "Variáveis desabilitadas"].map((v) => cell(v, 1)),
      [p.address || "", p.cep || "", "São Paulo", "SP", "Apartamento residencial", used("area", cell(p.area, 8)), used("age", cell(p.yearBuilt, 5)), used("age", cell(p.age, 5)), used("pattern", `${p.patternLabel} (cód. ${p.pattern})`), used("fiscal", cell(p.fiscal, 2)), report.variables.enabled.map((item) => report.variables.labels[item]).join(", "), report.variables.disabled.length ? report.variables.disabled.map((item) => report.variables.labels[item]).join(", ") : "Nenhuma"],
      [],
      [cell("Nota", 4), cell("O modelo foi treinado com a área construída do cadastro do IPTU; a área privativa da matrícula pode diferir. Endereço e CEP não entram no cálculo do valor.", 4)],
    ];

    const modelRows = [
      [cell("MODELO, MÉTRICAS E RASTREABILIDADE", 3)],
      [],
      [cell("Campo", 1), cell("Valor", 1)],
      ["Versão", m.version],
      ["Treinado em", m.trainedAt],
      ["Algoritmo", m.algorithm],
      ["Modelo selecionado", report.variables.modelKey],
      ["Variáveis ativas", report.variables.enabled.map((item) => report.variables.labels[item]).join(", ")],
      ["Variáveis desabilitadas", report.variables.disabled.length ? report.variables.disabled.map((item) => report.variables.labels[item]).join(", ") : "Nenhuma"],
      ["Variável alvo", m.hyperparameters.target],
      ["Regularização alpha", cell(m.hyperparameters.alpha, 6)],
      ["Variáveis candidatas", m.hyperparameters.candidate_variables],
      ["Modelos ajustados", cell(m.hyperparameters.models_fitted, 5)],
      ["Validação", m.hyperparameters.validation],
      ["Intervalo", m.hyperparameters.interval],
      ["Área contínua", m.hyperparameters.continuous_area ? "Sim" : "Não"],
      ["Filtro da natureza", m.hyperparameters.nature_filter],
      ["Amostra tratada", cell(m.eda.rows_model, 5)],
      ["Treino / calibração / teste", `${m.eda.rows_train} / ${m.eda.rows_calibration} / ${m.eda.rows_test}`],
      ["R² em log — modelo selecionado", cell(m.metrics.r2_log, 6)],
      ["MAPE — modelo selecionado", cell(m.metrics.mape_pct / 100, 7)],
      ["MdAPE — modelo selecionado", cell(m.metrics.med_ape_pct / 100, 7)],
      ["RMSE — modelo selecionado", cell(m.metrics.rmse_brl, 2)],
      ["Cobertura do intervalo — modelo selecionado", cell(m.metrics.interval_80_coverage_pct / 100, 7)],
      ["Registros no teste", cell(m.metrics.test_rows, 5)],
      ["R² em log — modelo completo", cell(m.defaultMetrics.r2_log, 6)],
      ["MdAPE — modelo completo", cell(m.defaultMetrics.med_ape_pct / 100, 7)],
      ["Variável condomínio", "Excluída do treinamento e da inferência"],
      ["Vínculo PGV no treinamento", m.pgvSource.training_join],
      ["VM2T para o imóvel", m.pgvSource.subject_input],
      ["Cobertura do vínculo PGV", cell(m.pgvSource.pgv_join_coverage_pct / 100, 7)],
      ["Compras e vendas brutas", cell(m.pgvSource.purchase_sale_rows_raw, 5)],
      ["Outras naturezas ignoradas", cell(m.pgvSource.other_natures_ignored_raw, 5)],
      ["Fonte", m.source.name],
      ["Período das transações", `${m.source.transaction_date_min} a ${m.source.transaction_date_max}`],
      ["SHA-256 da base", m.source.sha256],
    ];

    const riskRows = [
      [cell("RISCOS E CONDICIONANTES", 3)],
      [],
      [cell("Nº", 1), cell("Risco / condicionante", 1)],
      ...report.risks.map((risk, index) => [cell(index + 1, 5), risk]),
    ];

    const sourceRows = [
      [cell("FONTES E REFERÊNCIAS", 3)],
      [],
      [cell("Fonte", 1), cell("Aplicação", 1), cell("URL", 1)],
      [m.source.name, "Base oficial de transações declaradas", m.source.page_url],
      [`Planilha oficial (${m.source.sheets[0]} a ${m.source.sheets.at(-1)})`, "Arquivo usado no treinamento", m.source.download_url],
      [m.pgvSource.name, "Fonte do VM2T do Anexo II", m.pgvSource.law_url],
      ["OpenStreetMap / Nominatim", "Localização de CEP por endereço, só quando acionada", "https://www.openstreetmap.org/copyright"],
    ];

    const sheets = [
      { name: "Resumo", xml: worksheetXml(summaryRows, { widths: [30, 84], merges: ["A1:B1"] }) },
      { name: "Dados do Imóvel", xml: worksheetXml(propertyRows, { widths: [34, 14, 16, 8, 24, 20, 16, 12, 18, 24, 36, 36], merges: ["A1:L1", "B6:L6"], freezeRow: true, autoFilter: "A3:L4" }) },
      { name: "Modelo", xml: worksheetXml(modelRows, { widths: [34, 72], merges: ["A1:B1"], freezeRow: true }) },
      { name: "Riscos", xml: worksheetXml(riskRows, { widths: [8, 110], merges: ["A1:B1"], freezeRow: true }) },
      { name: "Fontes", xml: worksheetXml(sourceRows, { widths: [48, 42, 105], merges: ["A1:C1"], freezeRow: true, autoFilter: `A3:C${sourceRows.length}` }) },
    ];

    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

    const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="15000"/></bookViews>
  <sheets>${sheets.map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets>
  <calcPr calcId="191029" fullCalcOnLoad="1"/>
</workbook>`;

    const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}
  <Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="4"><numFmt numFmtId="164" formatCode="&quot;R$&quot; #,##0"/><numFmt numFmtId="165" formatCode="0.0000"/><numFmt numFmtId="166" formatCode="0.00%"/><numFmt numFmtId="167" formatCode="0.####"/></numFmts>
  <fonts count="3"><font><sz val="11"/><name val="Aptos"/><family val="2"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="16"/><name val="Aptos Display"/></font></fonts>
  <fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF071A2B"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF007B79"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFDCE5E9"/></bottom><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="9">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="3" borderId="0" xfId="0" applyFill="1" applyFont="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

    const created = new Date(report.issuedAt).toISOString();
    const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xml(report.id)}</dc:title><dc:creator>AVM/SP</dc:creator><dc:description>Relatório individualizado de precificação imobiliária</dc:description><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>
</cp:coreProperties>`;
    const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>AVM/SP</Application><AppVersion>1.0</AppVersion></Properties>`;

    const entries = [
      { name: "[Content_Types].xml", data: contentTypes },
      { name: "_rels/.rels", data: rootRels },
      { name: "docProps/core.xml", data: core },
      { name: "docProps/app.xml", data: app },
      { name: "xl/workbook.xml", data: workbook },
      { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
      { name: "xl/styles.xml", data: styles },
      ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, data: sheet.xml })),
    ];
    return zipStore(entries);
  }

  const api = { buildWorkbook };
  global.AVMExcel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof window !== "undefined" ? window : globalThis));
