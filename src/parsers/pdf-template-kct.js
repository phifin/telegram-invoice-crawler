"use strict";

const logger = require("../../logger");
const { safeString, toInteger } = require("../utils/common");
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

function isTemplateKct(rawText, lines) {
  const hasKctSummary = /Tổng tiền KCT GTGT/i.test(rawText);
  const hasKctInLines = lines.some((l) => /KCT/.test(l));
  return hasKctSummary || hasKctInLines;
}

// ---------------------------------------------------------------------------
// Item parser
// ---------------------------------------------------------------------------
/*
 * KCT item line (compact, no spaces):
 * {stt}{name}{unit}{qty}{unitPrice}{amtBefore}KCT{taxAmt}{totalAfterTax}
 *
 * Example: "1Học phí tiếng anhĐơn vị11.000.0001.000.000KCT01.000.000"
 */

function parseItemsKct(lines) {
  const items = [];
  let sttCounter = 0;

  for (const line of lines) {
    const s = safeString(line);
    if (!/^\d/.test(s)) continue;
    if (!s.includes("KCT")) continue;

    const kctIdx = s.indexOf("KCT");
    const leftPart = s.slice(0, kctIdx);
    const rightPart = s.slice(kctIdx + 3);

    // Right part: taxAmount (often 0) + totalAfterTax
    const rightMoney = rightPart.replace(/[^\d.]/g, "");
    let taxAmount = 0;
    let totalAfterTax = 0;
    const rightMoneyMatch = rightMoney.match(/^(\d+)([\d.]+)$/);
    if (rightMoneyMatch) {
      taxAmount = toInteger(rightMoneyMatch[1]);
      totalAfterTax = parseMoney(rightMoneyMatch[2]);
    } else {
      totalAfterTax = parseMoney(rightMoney);
    }

    // Left part: {stt}{name}{unit}{qty}{unitPrice}{amtBefore}
    const sttMatch = leftPart.match(/^(\d+)(.*)/);
    if (!sttMatch) continue;

    const sttRaw = sttMatch[1];
    const rest = sttMatch[2];

    // Extract trailing money values
    const moneyMatches = [...rest.matchAll(/(\d[\d.]*\.\d{3}|\d+)/g)];
    let unitPrice = 0;
    let amtBefore = 0;
    let nameUnitPart = rest;

    if (moneyMatches.length >= 2) {
      const lastTwo = moneyMatches.slice(-2);
      amtBefore = parseMoney(lastTwo[1][0]);
      unitPrice = parseMoney(lastTwo[0][0]);
      nameUnitPart = rest.slice(0, lastTwo[0].index);
    } else if (moneyMatches.length === 1) {
      amtBefore = parseMoney(moneyMatches[0][0]);
      nameUnitPart = rest.slice(0, moneyMatches[0].index);
    }

    // Extract unit and qty from nameUnitPart
    let qty = 1;
    let unit = "";
    let name = nameUnitPart;

    for (const candidate of KNOWN_UNITS) {
      const idx = nameUnitPart.indexOf(candidate);
      if (idx !== -1) {
        const before = nameUnitPart.slice(0, idx).trim();
        const afterUnit = nameUnitPart.slice(idx + candidate.length).trim();
        unit = candidate;
        const qtyM = afterUnit.match(/^(\d+)/);
        if (qtyM) {
          qty = toInteger(qtyM[1]);
          name = before;
        } else {
          name = before;
        }
        break;
      }
    }

    if (!unit) {
      const qtyUnitMatch = nameUnitPart.match(/^(.*?)([A-Za-zÀ-ỹĐđ ]+?)(\d+)$/u);
      if (qtyUnitMatch) {
        name = qtyUnitMatch[1].trim();
        unit = qtyUnitMatch[2].trim();
        qty = toInteger(qtyUnitMatch[3]);
      } else {
        name = nameUnitPart.trim();
      }
    }

    sttCounter++;
    items.push({
      tchat: 1,
      stt: toInteger(sttRaw) || sttCounter,
      ma: "",
      ten: safeString(name),
      dvtinh: safeString(unit),
      soluong: qty || 1,
      dongia: unitPrice || amtBefore,
      tien: amtBefore,
      tsuat: "KCT",
      _taxAmount: taxAmount,
      _totalAfterTax: totalAfterTax,
    });
  }

  logger.info(`[KCT] parseItemsKct: found ${items.length} items`);
  return items;
}

// ---------------------------------------------------------------------------
// Summary parser
// ---------------------------------------------------------------------------
/*
 * KCT compact summary line: ":/4.000.00004.000.000"
 * "/" is a zero-placeholder for tgtthue.
 */

function parseCompactKctSummaryLine(line) {
  const raw = cleanColonValue(line);
  const hasSlash = raw.startsWith("/");
  const moneyStr = raw.replace(/^\//, "").replace(/[^\d.]/g, "");
  if (!moneyStr) return null;

  const split3 = splitCompactMoneyRun(moneyStr, 3);
  if (split3) return { tgtcthue: split3[0], tgtthue: split3[1], tgtttbso: split3[2] };

  const split2 = splitCompactMoneyRun(moneyStr, 2);
  if (split2) return { tgtcthue: split2[0], tgtthue: 0, tgtttbso: split2[1] };

  return { tgtcthue: parseMoney(moneyStr), tgtthue: 0, tgtttbso: parseMoney(moneyStr) };
}

function parseSummaryKct(lines, rawText, invoice) {
  let kctThtien = 0;
  let kctTthue = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!/^Tổng tiền KCT GTGT$/i.test(lines[i])) continue;
    for (let j = i + 1; j <= Math.min(lines.length - 1, i + 5); j++) {
      if (!/^:/.test(lines[j])) continue;
      const parsed = parseCompactKctSummaryLine(lines[j]);
      if (parsed) {
        kctThtien = parsed.tgtcthue;
        kctTthue = parsed.tgtthue;
        invoice.tgtcthue = parsed.tgtcthue;
        invoice.tgtthue = parsed.tgtthue;
        invoice.tgtttbso = parsed.tgtttbso;
      }
      break;
    }
    break;
  }

  if (!invoice.tgtttbso) {
    for (let i = 0; i < lines.length; i++) {
      if (!/^Tổng cộng tiền thanh toán$/i.test(lines[i])) continue;
      for (let j = i + 1; j <= Math.min(lines.length - 1, i + 5); j++) {
        if (!/^:/.test(lines[j])) continue;
        const parsed = parseCompactKctSummaryLine(lines[j]);
        if (parsed) {
          invoice.tgtcthue = invoice.tgtcthue || parsed.tgtcthue;
          invoice.tgtthue = invoice.tgtthue || parsed.tgtthue;
          invoice.tgtttbso = parsed.tgtttbso;
        }
        break;
      }
      break;
    }
  }

  invoice.thttltsuat = [{ tsuat: "KCT", thtien: kctThtien, tthue: kctTthue }];

  invoice.tgtttbchu =
    extract(rawText, /Tổng số tiền viết bằng chữ:\s*([^\n]+)/i) ||
    extract(rawText, /Tổng số tiền viết bằng chữ\s*:\s*([^\n]+)/i);

  logger.info("[KCT] parseSummaryKct:", {
    thttltsuat: invoice.thttltsuat,
    tgtcthue: invoice.tgtcthue,
    tgtthue: invoice.tgtthue,
    tgtttbso: invoice.tgtttbso,
  });
}

module.exports = {
  isTemplateKct,
  parseItemsKct,
  parseSummaryKct,
  parseCompactKctSummaryLine,
};
