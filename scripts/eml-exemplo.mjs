// Gera na saída padrão o e-mail do teste local do RUNBOOK ("Estimativa por e-mail"): carnê e matrícula
// sintéticos (tests/fixtures/textos.mjs, sem dado pessoal) como PDFs com camada de texto, num multipart/mixed
// com Message-ID. Remetente teste@exemplo.gov.br — o domínio que .dev.vars autoriza.
// Uso: node scripts/eml-exemplo.mjs > exemplo.eml
import { mime } from "../tests/fixtures/mime.mjs";
import { textPdf } from "../tests/fixtures/pdf.mjs";
import { CARNE, MATRICULA } from "../tests/fixtures/textos.mjs";

const pdf = (text) => textPdf(text.trim().split("\n"));
process.stdout.write(mime({
  from: "teste@exemplo.gov.br",
  subject: "Teste local do AVM por e-mail",
  messageId: `<local-${Date.now()}@exemplo.gov.br>`,
  attachments: [["iptu.pdf", "application/pdf", pdf(CARNE)], ["matricula.pdf", "application/pdf", pdf(MATRICULA)]],
}));
