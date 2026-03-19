"use strict";

const logger = require("../../logger");
const { safeString, toInteger } = require("../utils/common");
const {
  extract,
  KNOWN_UNITS,
  parseQuantity,
  resolvePriceAmountPair,
  resolveTaxTotalPair,
  resolveSummaryMoneyTuple,
} = require("./pdf-utils");

function isTemplateMinvoiceDetailedVat(rawText, lines) {
  const hasMinvoice = /MINVOICE|M-INVOICE/i.test(rawText);
  const hasDetailedHeaders =
    /Tiền thuế/i.test(rawText) &&
    /Thành tiền\s*sau thuế/i.test(rawText) &&
    /Tổng hợp/i.test(rawText) &&
    /Tổng cộng tiền thanh toán/i.test(rawText);
  const hasVatRows = lines.some((line) => /^\d.*(?:10|8|5|0)%/.test(line));
  return hasMinvoice && hasDetailedHeaders && hasVatRows;
}

function findItemTableBounds(lines) {
  let start = -1;
  let end = -1;

  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && /^STT$/i.test(lines[i])) {
      start = i;
    }
    if (start !== -1 && /^Tổng hợp$/i.test(lines[i])) {
      end = i;
      break;
    }
  }

  return { start, end };
}

function findSummaryBounds(lines, summaryStart) {
  let end = lines.length;
  for (let i = summaryStart + 1; i < lines.length; i++) {
    if (/^Tổng số tiền viết bằng chữ/i.test(lines[i]) || /^Signature valid$/i.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start: summaryStart, end };
}

function findUnitWithNumericSuffix(text) {
  const sortedUnits = KNOWN_UNITS.slice().sort((a, b) => b.length - a.length);
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
  if (rawSuffix.length > 1) variants.push(rawSuffix.slice(1));

  for (const variant of variants) {
    for (let i = 1; i < Math.min(variant.length, 8); i++) {
      const qtyRaw = variant.slice(0, i);
      const leftMoneyBlob = variant.slice(i);
      if (!/^\d+(?:[.,]\d+)?$/.test(qtyRaw) || !leftMoneyBlob) continue;

      const qty = parseQuantity(qtyRaw);
      const priceAmount = resolvePriceAmountPair(leftMoneyBlob, qty, logger, `MINVOICE row ${sttRaw} left`);
      if (!priceAmount) continue;

      const score = (priceAmount.score || 0) + (qty === 1 ? 10 : 0) - i - (variant !== rawSuffix ? 2 : 0);
      if (!best || score > best.score) {
        best = { qty, priceAmount, score, normalizedFrom: variant };
      }
    }
  }

  return best;
}

function parseItemRowDetailed(row) {
  const s = safeString(row);
  const percentMatches = [...s.matchAll(/(10|8|5|0)%/g)];
  const fallbackPercentMatches = percentMatches.length ? percentMatches : [...s.matchAll(/(\d{1,2})%/g)];

  for (let idx = fallbackPercentMatches.length - 1; idx >= 0; idx--) {
    const percentMatch = fallbackPercentMatches[idx];
    const taxRateStr = `${percentMatch[1]}%`;
    const leftOfPercent = s.slice(0, percentMatch.index);
    const rightBlob = s.slice(percentMatch.index + taxRateStr.length);
    const sttMatch = leftOfPercent.match(/^(\d+)(.*)$/);
    if (!sttMatch) continue;

    const sttRaw = sttMatch[1];
    const rest = sttMatch[2];
    const unitMatch = findUnitWithNumericSuffix(rest);
    if (!unitMatch) continue;

    const name = rest.slice(0, unitMatch.index).trim();
    let qtyAndMoney = rest.slice(unitMatch.index + unitMatch.unit.length);
    if (name && /\d$/.test(name) && qtyAndMoney[0] === name[name.length - 1]) {
      qtyAndMoney = qtyAndMoney.slice(1);
    }

    const left = resolveStructuredLeftBlob(qtyAndMoney, sttRaw);
    if (!left) continue;
    const right = resolveTaxTotalPair(rightBlob, left.priceAmount.amount, logger, `MINVOICE row ${sttRaw} right`);

    logger.debug(`[MINVOICE_DETAILED_VAT] raw item row: ${row}`);
    logger.debug(`[MINVOICE_DETAILED_VAT] normalized item row: ${s}`);
    logger.debug(
      `[MINVOICE_DETAILED_VAT] tail row ${sttRaw}: qty=${left.qty}, unitPrice=${left.priceAmount.price}, amountBeforeVat=${left.priceAmount.amount}, vatRate=${taxRateStr}, vatAmount=${right.taxAmount}, amountAfterVat=${right.totalAfterTax}`,
    );

    return {
      tchat: 1,
      stt: toInteger(sttRaw),
      ma: "",
      ten: name,
      dvtinh: unitMatch.unit,
      soluong: left.qty,
      dongia: left.priceAmount.price,
      tien: left.priceAmount.amount,
      tsuat: toInteger(taxRateStr.replace("%", "")),
      _taxAmount: right.taxAmount,
      _totalAfterTax: right.totalAfterTax,
      _rawRow: row,
      _normalizedRow: s,
      _tailTokens: {
        qty: left.qty,
        unitPrice: left.priceAmount.price,
        amountBeforeVat: left.priceAmount.amount,
        vatRate: toInteger(taxRateStr.replace("%", "")),
        vatAmount: right.taxAmount,
        amountAfterVat: right.totalAfterTax,
      },
    };
  }

  logger.debug(`[MINVOICE_DETAILED_VAT] rejected item row: ${row}`);
  return null;
}

function parseItemsMinvoiceDetailedVat(lines) {
  const { start, end } = findItemTableBounds(lines);
  if (start === -1 || end === -1) return [];

  const rows = lines.slice(start + 1, end).filter((line) => /^\d/.test(line));
  const items = rows.map(parseItemRowDetailed).filter(Boolean);
  logger.debug(`[MINVOICE_DETAILED_VAT] item rows parsed: ${items.length}`);
  return items;
}

function parseSummaryMinvoiceDetailedVat(lines, rawText, invoice) {
  const summaryStart = lines.findIndex((line) => /^Tổng hợp$/i.test(line));
  if (summaryStart === -1) return;

  const { start, end } = findSummaryBounds(lines, summaryStart);
  const section = lines.slice(start, end);
  const perVatRate = [];

  for (const line of section) {
    const s = safeString(line);
    const vatRow = s.match(/^:\s*(10|8|5|0)%([\d.]+)$/);
    if (!vatRow) continue;

    const solved = resolveSummaryMoneyTuple(vatRow[2], 3, logger);
    if (!solved) continue;

    perVatRate.push({
      tsuat: toInteger(vatRow[1]),
      thtien: solved.thtien,
      tthue: solved.tthue,
      _totalAmount: solved.tong,
      _rawRow: s,
    });
    logger.debug(`[MINVOICE_DETAILED_VAT] summary row parsed: ${s}`);
  }

  invoice.thttltsuat = perVatRate;

  const grandTotalLine = section.find((line) => /^:\s*[\d.]+$/.test(line));
  if (grandTotalLine) {
    const solved = resolveSummaryMoneyTuple(grandTotalLine.replace(/^:\s*/, ""), 3, logger);
    if (solved) {
      invoice.tgtcthue = solved.thtien;
      invoice.tgtthue = solved.tthue;
      invoice.tgtttbso = solved.tong;
      invoice._grandTotals = {
        amountBeforeVat: solved.thtien,
        vatAmount: solved.tthue,
        totalAmount: solved.tong,
        _rawRow: grandTotalLine,
      };
      logger.debug(`[MINVOICE_DETAILED_VAT] grand total row parsed: ${grandTotalLine}`);
    }
  }

  invoice.tgtttbchu =
    extract(rawText, /Tổng số tiền viết bằng chữ:\s*([^\n]+)/i) ||
    extract(rawText, /Tổng số tiền viết bằng chữ\s*:\s*([^\n]+)/i);
}

module.exports = {
  isTemplateMinvoiceDetailedVat,
  parseItemsMinvoiceDetailedVat,
  parseSummaryMinvoiceDetailedVat,
};
