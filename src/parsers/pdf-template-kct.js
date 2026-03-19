"use strict";

const logger = require("../../logger");
const { safeString, toInteger } = require("../utils/common");
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

    const trailingNumMatch = leftPart.match(/([\d.,]+)$/);
    if (!trailingNumMatch) continue;

    const leftNumbersStr = trailingNumMatch[1];
    const nameUnitPart = leftPart.slice(0, trailingNumMatch.index);

    const solvedLeft = resolveItemMoneyTuple(leftNumbersStr, logger);
    if (!solvedLeft) continue;

    const rightMoney = rightPart.replace(/[^\d.]/g, "");
    let taxAmount = 0;
    let totalAfterTax = 0;
    
    if (rightMoney) {
      const candidates = partitionIntoValidNumbers(rightMoney, 2);
      if (candidates && candidates.length) {
        let bestC = candidates[0];
        let bestDiff = 999999;
        for (const c of candidates) {
          const t = parseMoney(c[0]);
          const tot = parseMoney(c[1]);
          const diff = Math.abs(t + solvedLeft.amtBefore - tot);
          if (diff < bestDiff) { bestDiff = diff; bestC = c; }
        }
        taxAmount = parseMoney(bestC[0]);
        totalAfterTax = parseMoney(bestC[1]);
      } else {
        totalAfterTax = parseMoney(rightMoney);
      }
    }

    const sttMatch = nameUnitPart.match(/^(\d+)(.*)$/);
    if (!sttMatch) continue;
    const sttRaw = sttMatch[1];
    const restStr = sttMatch[2];

    let unit = "";
    let name = restStr;
    for (const candidate of KNOWN_UNITS) {
      const idx = restStr.lastIndexOf(candidate);
      if (idx !== -1 && idx === restStr.length - candidate.length) {
        unit = candidate;
        name = restStr.slice(0, idx).trim();
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
      soluong: solvedLeft.qty,
      dongia: solvedLeft.price,
      tien: solvedLeft.amtBefore,
      tsuat: "KCT",
      _taxAmount: taxAmount,
      _totalAfterTax: totalAfterTax,
    });
  }

  logger.debug(`[KCT] parseItemsKct: found ${items.length} items`);
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
  const moneyStr = raw.replace(/^\//, "").replace(/[^\d.]/g, "");
  if (!moneyStr) return null;

  let solved = resolveSummaryMoneyTuple(moneyStr, 3, logger);
  if (solved) return { tgtcthue: solved.thtien, tgtthue: solved.tthue, tgtttbso: solved.tong };

  solved = resolveSummaryMoneyTuple(moneyStr, 2, logger);
  if (solved) return { tgtcthue: solved.thtien, tgtthue: 0, tgtttbso: solved.tong };

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

  logger.debug("[KCT] parseSummaryKct:", {
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
