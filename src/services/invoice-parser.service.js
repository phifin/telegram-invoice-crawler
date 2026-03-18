"use strict";

const { safeString } = require("../utils/common");
const { parseXmlInvoice } = require("../parsers/xml.parser");
const { parsePdfInvoice } = require("../parsers/pdf.parser");

/**
 * Entry point for local invoice parsing.
 * Routes to the correct parser based on file extension.
 * @param {Buffer} buffer
 * @param {string} fileName
 * @returns {Promise<object>} normalized invoice JSON
 */
async function parseInvoice(buffer, fileName) {
  const lower = safeString(fileName).toLowerCase();

  if (lower.endsWith(".xml")) {
    return parseXmlInvoice(buffer);
  }

  if (lower.endsWith(".pdf")) {
    return parsePdfInvoice(buffer);
  }

  throw new Error(`Unsupported file type for parsing: ${fileName}`);
}

module.exports = { parseInvoice };
