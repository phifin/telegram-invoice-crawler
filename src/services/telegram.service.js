"use strict";

const axios = require("axios");
const config = require("../../config");
const logger = require("../../logger");

/**
 * Extract message object from a Telegram update.
 * @param {object} update
 * @returns {object|null}
 */
function extractTelegramMessage(update) {
  return update.message || update.edited_message || null;
}

/**
 * Extract document from a Telegram message.
 * @param {object} msg
 * @returns {object|null}
 */
function extractTelegramDocument(msg) {
  return msg.document || null;
}

/**
 * Check if the file extension is a supported invoice format (.pdf or .xml).
 * @param {string} fileName
 * @returns {boolean}
 */
function isSupportedInvoiceFile(fileName) {
  const lower = String(fileName || "").toLowerCase();
  return lower.endsWith(".pdf") || lower.endsWith(".xml");
}

/**
 * Call Telegram getFile API and return the file_path string.
 * @param {string} fileId
 * @returns {Promise<string>}
 */
async function getTelegramFilePath(fileId) {
  const resp = await axios.get(`${config.TELEGRAM_API}/getFile`, {
    params: { file_id: fileId },
    timeout: 30000,
  });

  logger.debug("getFile response:", resp.data);

  if (!resp.data?.ok || !resp.data?.result?.file_path) {
    throw new Error("getFile failed: missing file_path in response");
  }

  return resp.data.result.file_path;
}

/**
 * Download a Telegram file as a Buffer.
 * @param {string} filePath  — the file_path returned by getFile
 * @returns {Promise<Buffer>}
 */
async function downloadTelegramFile(filePath) {
  const fileUrl = `${config.TELEGRAM_FILE_API}/${filePath}`;
  logger.debug("Downloading file from:", fileUrl);

  const resp = await axios.get(fileUrl, {
    responseType: "arraybuffer",
    timeout: 120000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  return Buffer.from(resp.data);
}

module.exports = {
  extractTelegramMessage,
  extractTelegramDocument,
  isSupportedInvoiceFile,
  getTelegramFilePath,
  downloadTelegramFile,
};
