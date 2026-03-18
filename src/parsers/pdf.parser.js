"use strict";

const pdfParse = require("pdf-parse");
const logger = require("../../logger");
const { normalizeInvoiceOutput, emptyInvoiceShape } = require("../utils/common");

const { normalizePdfExtract, splitLines } = require("./pdf-utils");
const { parseHeader, parseSeller, parseBuyer } = require("./pdf-header");
const { isTemplateVatRates, parseItemsVatRates, parseSummaryVatRates } = require("./pdf-template-vat");
const { isTemplateKct, parseItemsKct, parseSummaryKct } = require("./pdf-template-kct");
const { parseItemsGeneric, parseSummaryGeneric } = require("./pdf-template-generic");

async function parsePdfInvoice(buffer) {
  const pdfData = await pdfParse(buffer);
  const rawText = normalizePdfExtract(pdfData.text);
  const lines = splitLines(pdfData.text);

  logger.debug("PDF text extracted length:", rawText.length);
  logger.debug("PDF lines extracted:", lines.length);

  logger.debug("========== PDF RAW OUTPUT ==========");
  logger.debug("Meta:", {
    numpages: pdfData.numpages,
    numrender: pdfData.numrender,
    info: pdfData.info,
    metadata: pdfData.metadata,
    version: pdfData.version,
  });
  logger.debug("---------- RAW TEXT ----------");
  logger.debug("\n" + rawText);
  logger.debug("---------- LINES ----------");
  lines.forEach((line, idx) => logger.debug(`[${idx}] ${line}`));
  logger.debug("========== END DEBUG ==========");

  const invoice = emptyInvoiceShape();

  // 1. Shared: header / seller / buyer
  parseHeader(rawText, lines, invoice);
  parseSeller(lines, rawText, invoice);
  parseBuyer(lines, rawText, invoice);

  // 2. Template detection (KCT takes priority)
  const useKct = isTemplateKct(rawText, lines);
  const useVatRates = !useKct && isTemplateVatRates(rawText, lines);
  const templateName = useKct ? "KCT" : useVatRates ? "VAT_RATES" : "GENERIC";

  logger.debug(`[TEMPLATE] Detected: ${templateName}`);

  // 3. Template-specific dispatch
  if (useKct) {
    invoice.hdhhdvu = parseItemsKct(lines);
    parseSummaryKct(lines, rawText, invoice);
  } else if (useVatRates) {
    invoice.hdhhdvu = parseItemsVatRates(lines);
    parseSummaryVatRates(lines, rawText, invoice);
  } else {
    invoice.hdhhdvu = parseItemsGeneric(lines);
    parseSummaryGeneric(lines, rawText, invoice);
  }

  logger.debug("PDF parser intermediate:", {
    template: templateName,
    khhdon: invoice.khhdon,
    shdon: invoice.shdon,
    tdlap: invoice.tdlap,
    thtttoan: invoice.thtttoan,
    msttcgp: invoice.msttcgp,
    nbten: invoice.nbten,
    nbmst: invoice.nbmst,
    nbdchi: invoice.nbdchi,
    nbstkhoan: invoice.nbstkhoan,
    nbtnhang: invoice.nbtnhang,
    nmten: invoice.nmten,
    nmmst: invoice.nmmst,
    nmdchi: invoice.nmdchi,
    itemCount: invoice.hdhhdvu.length,
    thttltsuat: invoice.thttltsuat,
    tgtcthue: invoice.tgtcthue,
    tgtthue: invoice.tgtthue,
    tgtttbso: invoice.tgtttbso,
    tgtttbchu: invoice.tgtttbchu,
  });

  return normalizeInvoiceOutput(invoice);
}

module.exports = { parsePdfInvoice };
