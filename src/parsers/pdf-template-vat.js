"use strict";

const logger = require("../../logger");
const { safeString, toNumber, toInteger } = require("../utils/common");
const {
  extract,
  cleanColonValue,
  KNOWN_UNITS,
  parseMoney,
  partitionIntoValidNumbers,
  resolveItemMoneyTuple,
  resolveSummaryMoneyTuple,
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

    const percentMatch = s.match(/(\d{1,3}%)([\d.,]*)$/);
    if (!percentMatch) continue;

    const taxRateStr = percentMatch[1];
    const rightOfPercent = percentMatch[2];
    const leftOfPercent = s.slice(0, percentMatch.index);

    const trailingNumMatch = leftOfPercent.match(/([\d.,]+)$/);
    if (!trailingNumMatch) continue;

    const leftNumbersStr = trailingNumMatch[1];
    const nameStr = leftOfPercent.slice(0, trailingNumMatch.index);

    const sttMatch = nameStr.match(/^(\d+)(.*)$/);
    if (!sttMatch) continue;

    const sttRaw = sttMatch[1];
    let nameUnit = sttMatch[2];

    const solvedLeft = resolveItemMoneyTuple(leftNumbersStr, logger);
    if (!solvedLeft) continue;

    let taxAmt = 0;
    let totalAfterTax = 0;
    if (rightOfPercent) {
      const candidates = partitionIntoValidNumbers(rightOfPercent, 2);
      if (candidates && candidates.length) {
        let bestC = candidates[0];
        let bestDiff = 999999;
        for (const c of candidates) {
          const t = parseMoney(c[0]);
          const tot = parseMoney(c[1]);
          const diff = Math.abs(t + solvedLeft.amtBefore - tot);
          if (diff < bestDiff) { bestDiff = diff; bestC = c; }
        }
        taxAmt = parseMoney(bestC[0]);
        totalAfterTax = parseMoney(bestC[1]);
      } else {
        const fallback = rightOfPercent.match(/^([\d.,]+)([\d.,]+)$/);
        if (fallback) {
          taxAmt = parseMoney(fallback[1]);
          totalAfterTax = parseMoney(fallback[2]);
        }
      }
    }

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
      soluong: solvedLeft.qty,
      dongia: solvedLeft.price,
      tien: solvedLeft.amtBefore,
      tsuat: toInteger(taxRateStr.replace("%", "")),
      _taxAmount: taxAmt,
      _totalAfterTax: totalAfterTax,
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
  const solved = resolveSummaryMoneyTuple(m[2], 3, logger);
  if (solved) {
    return { tsuat, thtien: solved.thtien, tthue: solved.tthue, tong: solved.tong };
  }
  return null;
}

function parseCompactTotalLine(line) {
  const raw = cleanColonValue(line);
  if (/^\d+%/.test(raw)) return null;

  const moneyRun = raw.replace(/[^\d.]/g, "");
  if (!moneyRun) return null;

  let solved = resolveSummaryMoneyTuple(moneyRun, 3, logger);
  if (solved) return { tgtcthue: solved.thtien, tgtthue: solved.tthue, tgtttbso: solved.tong };

  solved = resolveSummaryMoneyTuple(moneyRun, 2, logger);
  if (solved) return { tgtcthue: solved.thtien, tgtthue: 0, tgtttbso: solved.tong };

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
