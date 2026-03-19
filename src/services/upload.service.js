"use strict";

const axios = require("axios");
const config = require("../../config");
const logger = require("../../logger");

function stripInternalFields(value) {
  if (Array.isArray(value)) {
    return value.map(stripInternalFields);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith("_")) continue;
    out[key] = stripInternalFields(child);
  }
  return out;
}

/**
 * POST invoice data to the target API.
 * @param {string} fileName
 * @param {string} baseBinary  — base64-encoded file content
 * @param {object} parsedData  — normalized invoice JSON
 * @returns {Promise<void>}
 */
async function uploadInvoice(fileName, baseBinary, parsedData) {
  // Backend expects a flat document: fileName + pdfBinary + all invoice fields at root level
  const payload = { fileName, pdfBinary: baseBinary, ...stripInternalFields(parsedData) };

  logger.debug("Posting to TARGET_API:", config.TARGET_API);
  logger.debug(
    "Outbound payload:",
    JSON.stringify({ ...payload, pdfBinary: `[masked:${baseBinary.length} chars]` }, null, 2),
  );

  const resp = await axios.post(config.TARGET_API, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 120000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  // Truncate response data to avoid flooding logs
  const preview = JSON.stringify(resp.data).slice(0, 300);
  logger.info("TARGET_API response:", { status: resp.status, data: preview });
}

module.exports = { uploadInvoice };
