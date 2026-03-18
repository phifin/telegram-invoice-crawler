"use strict";

const logger = require("../../logger");
const { safeString, toNumber, toInteger } = require("../utils/common");
const {
  extract,
  cleanColonValue,
  KNOWN_UNITS,
  parseMoney,
  splitCompactMoneyRun,
} = require("./pdf-utils");

// ---------------------------------------------------------------------------
// Template detection
// ---------------------------------------------------------------------------

function isTemplateVatRates(rawText, lines) {
  const hasVatSummary = /Tổng tiền chịu thuế suất/i.test(rawText);
  const hasVatRateInLines = lines.some((l) => /\d+%\d+/.test(l) || /\d+%$/.test(l));
  return hasVatSummary || hasVatRateInLines;
}

// ---------------------------------------------------------------------------
// Item parser
// ---------------------------------------------------------------------------
/*
 * VAT_RATES item line (compact, no spaces):
 * {stt}{name}{unit}{qty}{unitPrice}{amtBefore}{taxRate%}{taxAmt}{totalAfterTax}
 *
 * Example: "1Combo2Phần1159.000159.00010%15.900174.900"
 */

function parseItemsVatRates(lines) {
  const items = [];
  let sttCounter = 0;

  for (const line of lines) {
    const s = safeString(line);
    if (!/^\d/.test(s)) continue;
    if (!/\d+%/.test(s)) continue;

    const vatMatch = s.match(
      /^(\d+)(.+?)(\d+)([\d.,]+)([\d.,]+)(\d{1,3}%)([\d.,]+)([\d.,]+)$/,
    );
    if (!vatMatch) continue;

    const [, sttRaw, nameUnit, qtyRaw, unitPriceRaw, amtBeforeRaw, taxRateRaw, taxAmtRaw, totalAfterTaxRaw] = vatMatch;

    sttCounter++;
    let name = nameUnit;
    let unit = "";

    for (const candidate of KNOWN_UNITS) {
      if (nameUnit.endsWith(candidate)) {
        unit = candidate;
        name = nameUnit.slice(0, -candidate.length).trim();
        break;
      }
    }
    if (!unit) {
      const fallback = nameUnit.match(/^(.*?)([A-Za-zÀ-ỹĐđ\s]+)$/u);
      if (fallback) {
        name = fallback[1].trim();
        unit = fallback[2].trim();
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
  }

  logger.debug(`[VAT_RATES] parseItemsVatRates: found ${items.length} items`);
  return items;
}

// ---------------------------------------------------------------------------
// Summary parser
// ---------------------------------------------------------------------------
/*
 * Compact tax summary line example: ": 8%83.3336.66790.000"
 * Compact total line example:       ": 110.6069.394120.000"
 */

function parseCompactVatSummaryLine(line) {
  const raw = cleanColonValue(line);
  const m = raw.match(/^(\d+)%([\d.]+)$/);
  if (!m) return null;

  const tsuat = toInteger(m[1]);
  const split = splitCompactMoneyRun(m[2], 3);
  if (split) return { tsuat, thtien: split[0], tthue: split[1], tong: split[2] };

  // basic fallback
  const alt = m[2].match(/^([\d.]+)([\d.]+)([\d.]+)$/);
  if (!alt) return null;
  return { tsuat, thtien: parseMoney(alt[1]), tthue: parseMoney(alt[2]), tong: parseMoney(alt[3]) };
}

function parseCompactTotalLine(line) {
  const raw = cleanColonValue(line);
  if (/^\d+%/.test(raw)) return null;

  const moneyRun = raw.replace(/[^\d.]/g, "");
  if (!moneyRun) return null;

  const split3 = splitCompactMoneyRun(moneyRun, 3);
  if (split3) return { tgtcthue: split3[0], tgtthue: split3[1], tgtttbso: split3[2] };

  const split2 = splitCompactMoneyRun(moneyRun, 2);
  if (split2) return { tgtcthue: split2[0], tgtthue: 0, tgtttbso: split2[1] };

  return null;
}

function parseSummaryVatRates(lines, rawText, invoice) {
  const thttltsuat = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/^Tổng tiền chịu thuế suất$/i.test(lines[i])) continue;
    for (let j = i + 1; j <= Math.min(lines.length - 1, i + 5); j++) {
      if (!/^:/.test(lines[j])) continue;
      const parsed = parseCompactVatSummaryLine(lines[j]);
      if (parsed) thttltsuat.push({ tsuat: parsed.tsuat, thtien: parsed.thtien, tthue: parsed.tthue });
      break;
    }
  }
  invoice.thttltsuat = thttltsuat;

  for (let i = 0; i < lines.length; i++) {
    if (!/^Tổng cộng tiền thanh toán$/i.test(lines[i])) continue;
    for (let j = i + 1; j <= Math.min(lines.length - 1, i + 5); j++) {
      if (!/^:/.test(lines[j])) continue;
      const totals = parseCompactTotalLine(lines[j]);
      if (totals) {
        invoice.tgtcthue = totals.tgtcthue;
        invoice.tgtthue = totals.tgtthue;
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
  if (!invoice.tgtttbso && thttltsuat.length)
    invoice.tgtttbso = invoice.tgtcthue + invoice.tgtthue;

  invoice.tgtttbchu =
    extract(rawText, /Tổng số tiền viết bằng chữ:\s*([^\n]+)/i) ||
    extract(rawText, /Tổng số tiền viết bằng chữ\s*:\s*([^\n]+)/i);

  logger.debug("[VAT_RATES] parseSummaryVatRates:", {
    thttltsuat: invoice.thttltsuat,
    tgtcthue: invoice.tgtcthue,
    tgtthue: invoice.tgtthue,
    tgtttbso: invoice.tgtttbso,
  });
}

module.exports = {
  isTemplateVatRates,
  parseItemsVatRates,
  parseSummaryVatRates,
  parseCompactVatSummaryLine,
  parseCompactTotalLine,
};
