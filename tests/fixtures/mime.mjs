// Monta um e-mail multipart/mixed em RFC 5322 para testes e para o .eml do teste local (scripts/eml-exemplo.mjs).
// attachments: [[nome, tipo MIME, conteúdo (string ou Uint8Array), disposition?]].
// related: [[nome, tipo, conteúdo, cid]] — vira UM multipart/related aninhado (corpo text/html com cid: + as
// imagens inline), caso real de logotipo de assinatura embutido no HTML.
export function mime({ from = "pessoa@exemplo.gov.br", subject = "Avaliação do apartamento", messageId = "<abc123@exemplo.gov.br>", attachments = [], extraHeaders = {}, related = [] } = {}) {
  const boundary = "fronteira-avm";
  const relatedBoundary = "fronteira-related";
  // RFC 2047: assunto com acento chega decorado assim (é o que a plataforma manda de verdade).
  const subjectLine = /[^\x00-\x7f]/.test(subject) ? `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=` : subject;
  const parts = attachments.map(([name, type, content, disposition]) => [
    `--${boundary}`, `Content-Type: ${type}; name="${name}"`,
    disposition === "inline" ? `Content-Disposition: inline; filename="${name}"` : `Content-Disposition: attachment; filename="${name}"`,
    ...(disposition === "inline" ? ["Content-ID: <logo@x>"] : []),
    "Content-Transfer-Encoding: base64", "", Buffer.from(content).toString("base64"),
  ].join("\r\n"));
  const relatedPart = related.length ? [[
    `--${boundary}`, `Content-Type: multipart/related; boundary="${relatedBoundary}"`, "",
    `--${relatedBoundary}`, "Content-Type: text/html; charset=utf-8", "",
    `<html><body>${related.map(([, , , cid]) => `<img src="cid:${cid}">`).join("")}</body></html>`,
    ...related.flatMap(([name, type, content, cid]) => [
      `--${relatedBoundary}`, `Content-Type: ${type}; name="${name}"`,
      `Content-Disposition: inline; filename="${name}"`, `Content-ID: <${cid}>`,
      "Content-Transfer-Encoding: base64", "", Buffer.from(content).toString("base64"),
    ]),
    `--${relatedBoundary}--`,
  ].join("\r\n")] : [];
  return [
    `From: Pessoa <${from}>`, "To: avm@heybrain.uk", `Subject: ${subjectLine}`, messageId ? `Message-ID: ${messageId}` : null,
    ...Object.entries(extraHeaders).map(([name, value]) => `${name}: ${value}`),
    "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "", "Seguem os documentos.",
    ...relatedPart, ...parts, `--${boundary}--`, "",
  ].filter((line) => line !== null).join("\r\n");
}
