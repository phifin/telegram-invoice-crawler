"use strict";

const pdfParse = require("pdf-parse");
const logger = require("../../logger");
const { normalizeInvoiceOutput, emptyInvoiceShape } = require("../utils/common");

const { normalizePdfExtract, splitLines } = require("./pdf-utils");
const { parseHeader, parseSeller, parseBuyer } = require("./pdf-header");
const { isTemplateVatRates, parseItemsVatRates, parseSummaryVatRates } = require("./pdf-template-vat");
const { isTemplateKct, parseItemsKct, parseSummaryKct } = require("./pdf-template-kct");
const { parseItemsGeneric, parseSummaryGeneric } = require("./pdf-template-generic");
const { validateAndEnhanceInvoice } = require("./pdf-validation");
const { runHeuristicFallbackParser } = require("./pdf-strategy-b");

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

  logger.debug(`[TEMPLATE] Detected Strategy A: ${templateName}`);

  let parseError = null;
  try {
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
  } catch (err) {
    parseError = err;
    logger.debug(`[STRATEGY A] Exception during parsing: ${err.message}`);
  }

  let normalizedA = normalizeInvoiceOutput(invoice);
  let validateA = validateAndEnhanceInvoice(normalizedA, logger);

  if (!validateA.isValid || parseError) {
    logger.warn(`[STRATEGY A] Failed (Valid: ${validateA.isValid}). Falling back to STRATEGY B (Heuristic Parser).`);
    
    const fallbackInvoice = emptyInvoiceShape();
    Object.assign(fallbackInvoice, invoice);
    fallbackInvoice.hdhhdvu = [];
    fallbackInvoice.thttltsuat = [];
    fallbackInvoice.tgtcthue = 0;
    fallbackInvoice.tgtthue = 0;
    fallbackInvoice.tgtttbso = 0;
    
    try {
      runHeuristicFallbackParser(lines, fallbackInvoice, logger);
      const normalizedB = normalizeInvoiceOutput(fallbackInvoice);
      const validateB = validateAndEnhanceInvoice(normalizedB, logger);
      
      if (validateB.isValid || (!validateA.isValid && validateB.errors.length < validateA.errors.length)) {
        logger.info("[STRATEGY B] Succeed or better. Using fallback parser result.");
        normalizedA = normalizedB;
        validateA = validateB;
      } else {
        logger.warn("[STRATEGY B] Failed as well. Returning Strategy A.");
      }
    } catch (fallbackErr) {
      logger.error(`[STRATEGY B] Exception during fallback: ${fallbackErr.message}`);
    }
  }

  normalizedA._validationErrors = validateA.errors;
  normalizedA._isValid = validateA.isValid;

  logger.debug("PDF parser intermediate:", {
    template: templateName,
    khhdon: normalizedA.khhdon,
    shdon: normalizedA.shdon,
    tdlap: normalizedA.tdlap,
    thtttoan: normalizedA.thtttoan,
    msttcgp: normalizedA.msttcgp,
    nbten: normalizedA.nbten,
    nbmst: normalizedA.nbmst,
    nbdchi: normalizedA.nbdchi,
    nbstkhoan: normalizedA.nbstkhoan,
    nbtnhang: normalizedA.nbtnhang,
    nmten: normalizedA.nmten,
    nmmst: normalizedA.nmmst,
    nmdchi: normalizedA.nmdchi,
    itemCount: normalizedA.hdhhdvu.length,
    thttltsuat: normalizedA.thttltsuat,
    tgtcthue: normalizedA.tgtcthue,
    tgtthue: normalizedA.tgtthue,
    tgtttbso: normalizedA.tgtttbso,
    tgtttbchu: normalizedA.tgtttbchu,
    isValid: normalizedA._isValid,
  });

  return normalizedA;
}

module.exports = { parsePdfInvoice };
