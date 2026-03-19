"use strict";

const { Router } = require("express");
const config = require("../../config");
const logger = require("../../logger");
const {
  extractTelegramMessage,
  extractTelegramDocument,
  isSupportedInvoiceFile,
  getTelegramFilePath,
  downloadTelegramFile,
} = require("../services/telegram.service");
const { parseInvoice } = require("../services/invoice-parser.service");
const { uploadInvoice } = require("../services/upload.service");

const router = Router();

router.get("/", (_req, res) => {
  logger.debug("GET / healthcheck");
  res.status(200).send("Telegram webhook bot is running");
});

router.post(`/telegram/webhook/${config.WEBHOOK_SECRET}`, (req, res) => {
  // Respond immediately — Telegram requires a fast 200
  res.sendStatus(200);

  // Process asynchronously, never block the response
  handleUpdate(req.body).catch((err) => {
    logger.error("Unhandled error in handleUpdate:", err.message, err.stack);
  });
});

async function handleUpdate(update) {
  logger.info("Webhook hit");
  logger.debug("Update keys:", Object.keys(update || {}));

  // --- extract message ---
  const msg = extractTelegramMessage(update);
  if (!msg) {
    logger.debug("Skip: no message or edited_message in update");
    return;
  }

  logger.debug("Incoming message meta:", {
    updateId: update.update_id,
    chatId: msg.chat?.id,
    chatType: msg.chat?.type,
    messageId: msg.message_id,
    hasDocument: !!msg.document,
    text: msg.text || null,
  });

  // --- extract document ---
  const document = extractTelegramDocument(msg);
  if (!document) {
    logger.debug("Skip: message has no document");
    return;
  }

  const fileName = document.file_name || "unknown";

  logger.debug("Document info:", {
    fileId: document.file_id,
    fileUniqueId: document.file_unique_id,
    fileName,
    mimeType: document.mime_type,
    fileSize: document.file_size,
  });

  // --- validate extension ---
  if (!isSupportedInvoiceFile(fileName)) {
    logger.debug(`Skip: unsupported extension — ${fileName}`);
    return;
  }

  logger.info(`Accepted file: ${fileName}`);

  try {
    // --- getFile ---
    logger.debug("Calling Telegram getFile...");
    const filePath = await getTelegramFilePath(document.file_id);
    logger.debug("Resolved filePath:", filePath);

    // --- download ---
    logger.info("Downloading file...");
    const buffer = await downloadTelegramFile(filePath);
    const baseBinary = buffer.toString("base64");

    logger.debug("Download stats:", {
      fileName,
      bufferSize: buffer.length,
      base64Length: baseBinary.length,
    });

    // --- parse ---
    logger.info("Parsing invoice locally...");
    const parsedData = await parseInvoice(buffer, fileName);
    logger.debug("Parse result:", JSON.stringify(parsedData, null, 2));

    if (parsedData._validationErrors && parsedData._validationErrors.length > 0) {
      const warnings = parsedData._validationErrors.filter((e) => e.level === "WARNING");
      const checks = parsedData._validationErrors.filter((e) => e.level === "CHECK");
      const errors = parsedData._validationErrors.filter((e) => e.level === "REQUIRED");
      
      if (warnings.length > 0) {
        logger.warn(`Invoice validation warnings for ${fileName}:`, JSON.stringify(warnings));
      }
      if (checks.length > 0) {
        logger.warn(`Invoice validation checks for ${fileName}:`, JSON.stringify(checks));
      }
      if (errors.length > 0) {
        throw new Error(`Validation failed for ${fileName}. Critical errors: ` + JSON.stringify(errors));
      }
    }

    // Strip private internal metadata before uploading
    delete parsedData._isValid;
    delete parsedData._validationErrors;

    // --- upload ---
    await uploadInvoice(fileName, baseBinary, parsedData);
  } catch (err) {
    logger.error("Processing error:", {
      stage: err.stage || "unknown",
      message: err.message,
      responseStatus: err.response?.status,
      responseData: err.response?.data,
    });
  }
}

module.exports = router;
