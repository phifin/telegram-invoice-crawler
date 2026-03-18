"use strict";

const logger = require("../../logger");
const { safeString, toNumber, toInteger } = require("../utils/common");
const {
  extract,
  KNOWN_UNITS,
  parseMoney,
} = require("./pdf-utils");
const { parseCompactVatSummaryLine, parseCompactTotalLine } = require("./pdf-template-vat");
const { parseCompactKctSummaryLine } = require("./pdf-template-kct");

// ---------------------------------------------------------------------------
// Generic item parser (fallback)
// ---------------------------------------------------------------------------

function parseItemsGeneric(lines) {
  const items = [];
  let sttCounter = 0;

  for (const line of lines) {
    const s = safeString(line);
    if (!/^\d/.test(s)) continue;

    // Try VAT_RATES compact pattern
    if (/\d+%/.test(s)) {
      const vatMatch = s.match(
        /^(\d+)(.+?)(\d+)([\d.,]+)([\d.,]+)(\d{1,3}%)([\d.,]+)([\d.,]+)$/,
      );
      if (vatMatch) {
        const [, sttRaw, nameUnit, qtyRaw, unitPriceRaw, amtBeforeRaw, taxRateRaw, taxAmtRaw, totalAfterTaxRaw] = vatMatch;
        sttCounter++;
        let name = nameUnit.trim();
        let unit = "";
        for (const candidate of KNOWN_UNITS) {
          if (nameUnit.endsWith(candidate)) {
            unit = candidate;
            name = nameUnit.slice(0, -candidate.length).trim();
            break;
          }
        }
        items.push({
          tchat: 1,
          stt: toInteger(sttRaw) || sttCounter,
          ma: "",
          ten: safeString(name),
          dvtinh: safeString(unit),
          soluong: toNumber(qtyRaw),
          dongia: parseMoney(unitPriceRaw),
          tien: parseMoney(amtBeforeRaw),
          tsuat: toInteger(taxRateRaw.replace("%", "")),
          _taxAmount: parseMoney(taxAmtRaw),
          _totalAfterTax: parseMoney(totalAfterTaxRaw),
        });
        continue;
      }
    }

    // Try KCT pattern
    if (s.includes("KCT")) {
      const { parseItemsKct } = require("./pdf-template-kct");
      const kctItems = parseItemsKct([line]);
      items.push(...kctItems);
      continue;
    }

    // Whitespace-split fallback
    const parts = s.split(/\s+/);
    if (parts.length < 4) continue;
    const tien = parseMoney(parts[parts.length - 1]);
    if (!tien) continue;
    sttCounter++;
    items.push({
      tchat: 1,
      stt: toInteger(parts[0]) || sttCounter,
      ma: "",
      ten: safeString(parts[1]),
      dvtinh: "",
      soluong: toNumber(parts[parts.length - 3]),
      dongia: parseMoney(parts[parts.length - 2]),
      tien,
      tsuat: 0,
    });
  }

  logger.info(`[GENERIC] parseItemsGeneric: found ${items.length} items`);
  return items;
}

// ---------------------------------------------------------------------------
// Generic summary parser (fallback)
// ---------------------------------------------------------------------------

function parseSummaryGeneric(lines, rawText, invoice) {
  const thttltsuat = [];

  // Try VAT_RATES tax summary
  for (let i = 0; i < lines.length; i++) {
    if (!/Tổng tiền chịu thuế suất/i.test(lines[i])) continue;
    for (let j = i + 1; j <= Math.min(lines.length - 1, i + 5); j++) {
      if (!/^:/.test(lines[j])) continue;
      const parsed = parseCompactVatSummaryLine(lines[j]);
      if (parsed) thttltsuat.push({ tsuat: parsed.tsuat, thtien: parsed.thtien, tthue: parsed.tthue });
      break;
    }
  }

  // Try KCT summary if nothing found yet
  if (!thttltsuat.length) {
    for (let i = 0; i < lines.length; i++) {
      if (!/Tổng tiền KCT GTGT/i.test(lines[i])) continue;
      for (let j = i + 1; j <= Math.min(lines.length - 1, i + 5); j++) {
        if (!/^:/.test(lines[j])) continue;
        const parsed = parseCompactKctSummaryLine(lines[j]);
        if (parsed) {
          thttltsuat.push({ tsuat: "KCT", thtien: parsed.tgtcthue, tthue: parsed.tgtthue });
          invoice.tgtcthue = parsed.tgtcthue;
          invoice.tgtthue = parsed.tgtthue;
          invoice.tgtttbso = parsed.tgtttbso;
        }
        break;
      }
      break;
    }
  }

  invoice.thttltsuat = thttltsuat;

  // Try total line
  for (let i = 0; i < lines.length; i++) {
    if (!/^Tổng cộng tiền thanh toán$/i.test(lines[i])) continue;
    for (let j = i + 1; j <= Math.min(lines.length - 1, i + 5); j++) {
      if (!/^:/.test(lines[j])) continue;
      const totals = parseCompactTotalLine(lines[j]);
      if (totals) {
        invoice.tgtcthue = invoice.tgtcthue || totals.tgtcthue;
        invoice.tgtthue = invoice.tgtthue || totals.tgtthue;
        invoice.tgtttbso = totals.tgtttbso;
      }
      break;
    }
    break;
  }

  if (!invoice.tgtcthue && thttltsuat.length)
    invoice.tgtcthue = thttltsuat.reduce((s, x) => s + Number(x.thtien || 0), 0);
  if (!invoice.tgtthue && thttltsuat.length)
    invoice.tgtthue = thttltsuat.reduce((s, x) => s + Number(x.tthue || 0), 0);
  if (!invoice.tgtttbso && (invoice.tgtcthue || invoice.tgtthue))
    invoice.tgtttbso = invoice.tgtcthue + invoice.tgtthue;

  invoice.tgtttbchu =
    extract(rawText, /Tổng số tiền viết bằng chữ:\s*([^\n]+)/i) ||
    extract(rawText, /Tổng số tiền viết bằng chữ\s*:\s*([^\n]+)/i);

  logger.info("[GENERIC] parseSummaryGeneric:", {
    thttltsuat: invoice.thttltsuat,
    tgtcthue: invoice.tgtcthue,
    tgtthue: invoice.tgtthue,
    tgtttbso: invoice.tgtttbso,
  });
}

module.exports = { parseItemsGeneric, parseSummaryGeneric };
