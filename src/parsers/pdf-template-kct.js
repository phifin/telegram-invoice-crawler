"use strict";

const logger = require("../../logger");
const { safeString, toInteger } = require("../utils/common");
const {
  extract,
  cleanColonValue,
  KNOWN_UNITS,
  parseQuantity,
  resolvePriceAmountPair,
  resolveTaxTotalPair,
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
  const sortedUnits = KNOWN_UNITS.slice().sort((a, b) => b.length - a.length);

  function findUnitWithNumericSuffix(text) {
    let best = null;
    for (const unit of sortedUnits) {
      let fromIndex = 0;
      while (fromIndex < text.length) {
        const idx = text.indexOf(unit, fromIndex);
        if (idx === -1) break;
        const nextChar = text[idx + unit.length] || "";
        if (/\d/.test(nextChar)) {
          if (!best || idx > best.index || (idx === best.index && unit.length > best.unit.length)) {
            best = { index: idx, unit };
          }
        }
        fromIndex = idx + unit.length;
      }
    }
    return best;
  }

  function resolveStructuredLeftBlob(rawSuffix, sttRaw) {
    let best = null;
    for (let i = 1; i < Math.min(rawSuffix.length, 8); i++) {
      const qtyRaw = rawSuffix.slice(0, i);
      const leftMoneyBlob = rawSuffix.slice(i);
      if (!/^\d+(?:[.,]\d+)?$/.test(qtyRaw) || !leftMoneyBlob) continue;

      const qty = parseQuantity(qtyRaw);
      const priceAmount = resolvePriceAmountPair(leftMoneyBlob, qty, logger, `KCT row ${sttRaw} left`);
      if (!priceAmount) continue;

      const score = (priceAmount.score || 0) + (qty === 1 ? 10 : 0) - i;
      if (!best || score > best.score) {
        best = { qty, leftMoneyBlob, priceAmount, score };
      }
    }
    return best;
  }

  for (const line of lines) {
    const s = safeString(line);
    if (!/^\d/.test(s)) continue;
    if (!s.includes("KCT")) continue;

    logger.debug(`[KCT] Raw row: ${s}`);

    let parsed = null;
    const kctIdx = s.indexOf("KCT");
    const leftPart = s.slice(0, kctIdx);
    const rightPart = s.slice(kctIdx + 3);
    const sttMatch = leftPart.match(/^(\d+)(.*)$/);
    if (sttMatch) {
      const sttRaw = sttMatch[1];
      const rest = sttMatch[2];
      const unitMatch = findUnitWithNumericSuffix(rest);
      if (unitMatch) {
        const nameRaw = rest.slice(0, unitMatch.index);
        const qtyAndMoney = rest.slice(unitMatch.index + unitMatch.unit.length);
        const structuredLeft = resolveStructuredLeftBlob(qtyAndMoney, sttRaw);
        const taxTotal = structuredLeft
          ? resolveTaxTotalPair(rightPart, structuredLeft.priceAmount.amount, logger, `KCT row ${sttRaw} right`)
          : null;

        logger.debug(
          `[KCT] Structured row ${sttRaw}: normalized='${s}', qtyAndMoney='${qtyAndMoney}', rightBlob='${rightPart}', unit='${unitMatch.unit}'`,
        );

        if (structuredLeft && taxTotal) {
          parsed = {
            strategy: "A",
            sttRaw,
            name: safeString(nameRaw),
            unit: safeString(unitMatch.unit),
            qty: structuredLeft.qty,
            price: structuredLeft.priceAmount.price,
            amount: structuredLeft.priceAmount.amount,
            taxAmount: taxTotal.taxAmount,
            totalAfterTax: taxTotal.totalAfterTax,
          };
        }
      }
    }

    if (!parsed) {
      const trailingNumMatch = leftPart.match(/([\d.,]+)$/);
      if (trailingNumMatch) {
        const leftNumbersStr = trailingNumMatch[1];
        const nameUnitPart = leftPart.slice(0, trailingNumMatch.index);
        const sttMatch = nameUnitPart.match(/^(\d+)(.*)$/);
        if (sttMatch) {
          const sttRaw = sttMatch[1];
          const taxTotal = resolveTaxTotalPair(rightPart, 0, logger, `KCT row ${sttRaw} compact-right`);
          const solvedLeft = resolveItemMoneyTuple(leftNumbersStr, logger, `KCT row ${sttRaw} compact-left`);
          if (solvedLeft) {
            parsed = {
              strategy: "B",
              sttRaw,
              name: safeString(sttMatch[2]),
              unit: "",
              qty: solvedLeft.qty,
              price: solvedLeft.price,
              amount: solvedLeft.amtBefore,
              taxAmount: taxTotal.taxAmount,
              totalAfterTax: taxTotal.totalAfterTax || solvedLeft.amtBefore,
            };
            logger.debug(`[KCT] Fallback row ${sttRaw}: normalized='${s}', leftBlob='${leftNumbersStr}', rightBlob='${rightPart}'`);
          }
        }
      }
    }

    if (!parsed) {
      logger.debug(`[KCT] Rejected row: ${s}`);
      continue;
    }

    sttCounter++;
    items.push({
      tchat: 1,
      stt: toInteger(parsed.sttRaw) || sttCounter,
      ma: "",
      ten: safeString(parsed.name),
      dvtinh: safeString(parsed.unit),
      soluong: parsed.qty,
      dongia: parsed.price,
      tien: parsed.amount,
      tsuat: "KCT",
      _taxAmount: parsed.taxAmount,
      _totalAfterTax: parsed.totalAfterTax,
    });
    logger.debug(
      `[KCT] Accepted row ${parsed.sttRaw} using strategy ${parsed.strategy}: qty=${parsed.qty}, price=${parsed.price}, amount=${parsed.amount}, tax=${parsed.taxAmount}, total=${parsed.totalAfterTax}`,
    );
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
