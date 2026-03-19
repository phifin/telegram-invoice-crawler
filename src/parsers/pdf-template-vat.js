"use strict";

const logger = require("../../logger");
const { safeString, toNumber, toInteger } = require("../utils/common");
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
    const variants = [rawSuffix];
    if (rawSuffix.length > 1) {
      variants.push(rawSuffix.slice(1));
    }

    for (const variant of variants) {
      for (let i = 1; i < Math.min(variant.length, 8); i++) {
        const qtyRaw = variant.slice(0, i);
        const leftMoneyBlob = variant.slice(i);
        if (!/^\d+(?:[.,]\d+)?$/.test(qtyRaw) || !leftMoneyBlob) continue;

        const qty = parseQuantity(qtyRaw);
        const priceAmount = resolvePriceAmountPair(leftMoneyBlob, qty, logger, `VAT row ${sttRaw} left`);
        if (!priceAmount) continue;

        const score = (priceAmount.score || 0) + (qty === 1 ? 10 : 0) - i - (variant !== rawSuffix ? 2 : 0);
        if (!best || score > best.score) {
          best = { qty, leftMoneyBlob, priceAmount, score, normalizedFrom: variant };
        }
      }
    }
    return best;
  }

  for (const line of lines) {
    const s = safeString(line);
    if (!/^\d/.test(s)) continue;
    if (!/\d+%/.test(s)) continue;

    logger.debug(`[VAT_RATES] Raw row: ${s}`);

    let parsed = null;
    const percentMatches = [...s.matchAll(/(10|8|5|0)%/g)];
    const fallbackPercentMatches = percentMatches.length ? percentMatches : [...s.matchAll(/(\d{1,2})%/g)];
    for (let idx = fallbackPercentMatches.length - 1; idx >= 0 && !parsed; idx--) {
      const percentMatch = fallbackPercentMatches[idx];
      const taxRateStr = `${percentMatch[1]}%`;
      const leftOfPercent = s.slice(0, percentMatch.index);
      const rightMoneyBlob = s.slice(percentMatch.index + taxRateStr.length);
      const sttMatch = leftOfPercent.match(/^(\d+)(.*)$/);
      if (!sttMatch) continue;

      const sttRaw = sttMatch[1];
      const rest = sttMatch[2];
      const unitMatch = findUnitWithNumericSuffix(rest);
      if (!unitMatch) continue;

      const nameRaw = rest.slice(0, unitMatch.index);
      let qtyAndMoney = rest.slice(unitMatch.index + unitMatch.unit.length);
      if (nameRaw && /\d$/.test(nameRaw) && qtyAndMoney[0] === nameRaw[nameRaw.length - 1]) {
        qtyAndMoney = qtyAndMoney.slice(1);
      }
      const structuredLeft = resolveStructuredLeftBlob(qtyAndMoney, sttRaw);
      const taxTotal = structuredLeft
        ? resolveTaxTotalPair(rightMoneyBlob, structuredLeft.priceAmount.amount, logger, `VAT row ${sttRaw} right`)
        : null;

      logger.debug(
        `[VAT_RATES] Structured row ${sttRaw}: normalized='${s}', qtyAndMoney='${qtyAndMoney}', rightBlob='${rightMoneyBlob}', unit='${unitMatch.unit}'`,
      );

      if (structuredLeft && taxTotal) {
        parsed = {
          strategy: "A",
          sttRaw,
          nameUnit: safeString(nameRaw),
          unit: safeString(unitMatch.unit),
          qty: structuredLeft.qty,
          price: structuredLeft.priceAmount.price,
          amount: structuredLeft.priceAmount.amount,
          taxRate: toInteger(taxRateStr.replace("%", "")),
          taxAmount: taxTotal.taxAmount,
          totalAfterTax: taxTotal.totalAfterTax,
        };
      }
    }

    if (!parsed) {
      for (let idx = fallbackPercentMatches.length - 1; idx >= 0; idx--) {
        const percentMatch = fallbackPercentMatches[idx];
        const taxRateStr = `${percentMatch[1]}%`;
        const rightOfPercent = s.slice(percentMatch.index + taxRateStr.length);
        const leftOfPercent = s.slice(0, percentMatch.index);
        const trailingNumMatch = leftOfPercent.match(/([\d.,]+)$/);
        if (!trailingNumMatch) continue;

        const leftNumbersStr = trailingNumMatch[1];
        const nameStr = leftOfPercent.slice(0, trailingNumMatch.index);
        const sttMatch = nameStr.match(/^(\d+)(.*)$/);
        if (!sttMatch) continue;

        const sttRaw = sttMatch[1];
        const nameUnit = sttMatch[2];
        const solvedLeft = resolveItemMoneyTuple(leftNumbersStr, logger, `VAT row ${sttRaw} compact-left`);
        if (!solvedLeft) continue;

        const taxTotal = resolveTaxTotalPair(rightOfPercent, solvedLeft.amtBefore, logger, `VAT row ${sttRaw} compact-right`);
        parsed = {
          strategy: "B",
          sttRaw,
          nameUnit,
          unit: "",
          qty: solvedLeft.qty,
          price: solvedLeft.price,
          amount: solvedLeft.amtBefore,
          taxRate: toInteger(taxRateStr.replace("%", "")),
          taxAmount: taxTotal.taxAmount,
          totalAfterTax: taxTotal.totalAfterTax,
        };
        logger.debug(`[VAT_RATES] Fallback row ${sttRaw}: normalized='${s}', leftBlob='${leftNumbersStr}', rightBlob='${rightOfPercent}'`);
        break;
      }
    }

    if (!parsed) {
      logger.debug(`[VAT_RATES] Rejected row: ${s}`);
      continue;
    }

    sttCounter++;
    let name = parsed.nameUnit;
    let unit = parsed.unit || "";

    for (const candidate of KNOWN_UNITS) {
      if (!unit && parsed.nameUnit.endsWith(candidate)) {
        unit = candidate;
        name = parsed.nameUnit.slice(0, -candidate.length).trim();
        break;
      }
    }
    if (!unit) {
      const fallback = parsed.nameUnit.match(/^(.*?)([A-Za-zÀ-ỹĐđ\s]+)$/u);
      if (fallback) {
        name = fallback[1].trim();
        unit = fallback[2].trim();
      }
    }

    items.push({
      tchat: 1,
      stt: toInteger(parsed.sttRaw) || sttCounter,
      ma: "",
      ten: safeString(name),
      dvtinh: safeString(unit),
      soluong: parsed.qty,
      dongia: parsed.price,
      tien: parsed.amount,
      tsuat: parsed.taxRate,
      _taxAmount: parsed.taxAmount,
      _totalAfterTax: parsed.totalAfterTax,
    });
    logger.debug(
      `[VAT_RATES] Accepted row ${parsed.sttRaw} using strategy ${parsed.strategy}: qty=${parsed.qty}, price=${parsed.price}, amount=${parsed.amount}, tax=${parsed.taxAmount}, total=${parsed.totalAfterTax}`,
    );
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
