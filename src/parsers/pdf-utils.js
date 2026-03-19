"use strict";

const { safeString, toNumber, toInteger } = require("../utils/common");

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

function normalizePdfExtract(text) {
  return safeString(text)
    .replace(/\u00ad/g, "") // soft hyphen
    .replace(/\u00a0/g, " ") // nbsp
    .replace(/[\u2010-\u2015\u2212]/g, "-") // unicode dashes / minus
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function splitLines(text) {
  return normalizePdfExtract(text)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
}

function extract(text, regex, group = 1) {
  const match = text.match(regex);
  return match ? safeString(match[group]) : "";
}

function cleanColonValue(value) {
  return safeString(value).replace(/^:\s*/, "").trim();
}

function isLikelyLabelLine(line) {
  return (
    /^\(.+\)$/.test(line) ||
    /^(Đơn vị bán hàng|Mã số thuế|Địa chỉ|Mã cửa hàng|Tên cửa hàng|Số tài khoản|Tên ngân hàng|Họ tên người mua hàng|Tên đơn vị|Căn cước công dân|Hình thức thanh toán|Ngày|Ký hiệu|Số|Người mua hàng|Người bán hàng|STT|Tổng hợp|Thuế suất|Tổng tiền chưa thuế|Tổng tiền thuế|Giá trị thanh toán|Tổng tiền chịu thuế suất|Tổng tiền KCT GTGT|Tổng cộng tiền thanh toán|Tổng số tiền viết bằng chữ)/i.test(
      line,
    )
  );
}

function findLineIndex(lines, predicate, start = 0) {
  for (let i = start; i < lines.length; i++) {
    if (predicate(lines[i], i)) return i;
  }
  return -1;
}

function findValueAfterLabelBlock(lines, labelStartRegex, start = 0, maxLookahead = 6) {
  const labelIndex = findLineIndex(lines, (line) => labelStartRegex.test(line), start);
  if (labelIndex === -1) return "";

  for (let i = labelIndex + 1; i <= Math.min(lines.length - 1, labelIndex + maxLookahead); i++) {
    const line = lines[i];
    if (/^:/.test(line)) {
      const value = cleanColonValue(line);
      if (value && !isLikelyLabelLine(value)) return value;
      return "";
    }
  }
  return "";
}

function findMultiLineAddressAfterLabelBlock(lines, labelStartRegex, start = 0, maxLookahead = 10) {
  const labelIndex = findLineIndex(lines, (line) => labelStartRegex.test(line), start);
  if (labelIndex === -1) return "";

  const chunks = [];
  let seenColonLine = false;

  for (let i = labelIndex + 1; i <= Math.min(lines.length - 1, labelIndex + maxLookahead); i++) {
    const line = lines[i];
    if (!seenColonLine) {
      if (/^:/.test(line)) {
        const first = cleanColonValue(line);
        if (first) chunks.push(first);
        seenColonLine = true;
      }
      continue;
    }
    if (isLikelyLabelLine(line)) break;
    chunks.push(safeString(line));
  }

  return chunks.join(" ").trim();
}

// ---------------------------------------------------------------------------
// Money helpers
// ---------------------------------------------------------------------------

const KNOWN_UNITS = [
  "Đơn vị",
  "Phần",
  "Suất",
  "Chai",
  "Lon",
  "Hộp",
  "Gói",
  "Cái",
  "Ly",
  "Kg",
  "g",
];

function parseMoney(s) {
  const str = safeString(s).replace(/\./g, "").replace(/,/g, "");
  const n = Number(str);
  return Number.isNaN(n) ? 0 : n;
}

function parseQuantity(s) {
  const raw = safeString(s).replace(/\./g, "").replace(/,/g, ".");
  const n = Number(raw);
  return Number.isNaN(n) ? 0 : n;
}

function partitionIntoValidNumbers(str, count) {
  const isVndMoney = (s) => {
    if (s === "0") return true;
    if (/^[1-9]\d{0,2}(?:\.\d{3})+$/.test(s)) return true;
    if (/^[1-9]\d*$/.test(s)) return true;
    return false;
  };

  const isQuantity = (s) => {
    if (/^\d+$/.test(s)) return true;
    if (/^\d+[.,]\d+$/.test(s)) return true;
    return false;
  };

  function partition(s, partsLeft, position) {
    if (!s) return [];
    if (partsLeft === 1) {
      const valid = position === 0 ? (isQuantity(s) || isVndMoney(s)) : isVndMoney(s);
      return valid ? [[s]] : [];
    }
    const results = [];
    for (let i = 1; i < s.length; i++) {
      const prefix = s.slice(0, i);
      const valid = position === 0 ? (isQuantity(prefix) || isVndMoney(prefix)) : isVndMoney(prefix);
      if (!valid) continue;
      
      const suffixPartitions = partition(s.slice(i), partsLeft - 1, position + 1);
      for (const sp of suffixPartitions) {
        results.push([prefix, ...sp]);
      }
    }
    return results;
  }
  
  return partition(str, count, 0);
}

function scoreMoney(value) {
  if (value < 0) return -1000;
  if (value === 0) return 2;
  if (value <= 1e9) return 20;
  if (value <= 1e12) return 8;
  return -1000;
}

function scoreMathDiff(diff) {
  if (diff <= 1) return 100 - diff;
  if (diff <= 10) return 70 - diff;
  if (diff <= 100) return 20 - diff / 10;
  return -1000;
}

function logCandidateDecision(logger, prefix, rawInput, best, rejections) {
  if (!logger) return;
  logger.debug(`${prefix} raw='${rawInput}' chosen=${JSON.stringify(best || null)}`);
  for (const rejection of rejections) {
    logger.debug(`${prefix} rejected=${JSON.stringify(rejection)}`);
  }
}

function resolvePriceAmountPair(str, qty, logger, context = "pair") {
  const candidates = partitionIntoValidNumbers(str, 2);
  if (!candidates || candidates.length === 0) {
    logCandidateDecision(logger, `[${context}]`, str, null, [{ candidate: str, reason: "no valid partitions" }]);
    return null;
  }

  let best = null;
  let maxScore = -Infinity;
  const rejections = [];

  for (const candidate of candidates) {
    const price = parseMoney(candidate[0]);
    const amount = parseMoney(candidate[1]);
    const diff = Math.abs(qty * price - amount);
    let score = scoreMoney(price) + scoreMoney(amount) + scoreMathDiff(diff);

    if (qty <= 0 || qty > 1e6) {
      rejections.push({ candidate, reason: "invalid quantity", qty });
      continue;
    }
    if (price > 1e12 || amount > 1e12) {
      rejections.push({ candidate, reason: "exceeds bounds", price, amount });
      continue;
    }
    if (amount < price && qty >= 1) {
      score -= 25;
    }

    if (score > maxScore) {
      if (best) {
        rejections.push({ candidate: best.raw, reason: `superseded by higher score ${score}` });
      }
      maxScore = score;
      best = { price, amount, raw: candidate, diff, score };
    } else {
      rejections.push({ candidate, reason: `lower score ${score}`, diff, qty, price, amount });
    }
  }

  logCandidateDecision(logger, `[${context}]`, str, best, rejections);
  return best;
}

function resolveTaxTotalPair(str, baseAmount, logger, context = "tax-total") {
  const cleanStr = safeString(str).replace(/[^\d.]/g, "");
  if (!cleanStr) {
    return { taxAmount: 0, totalAfterTax: baseAmount, raw: [], diff: 0, score: 0 };
  }

  const candidates = partitionIntoValidNumbers(cleanStr, 2);
  if (!candidates || candidates.length === 0) {
    const fallbackTotal = parseMoney(cleanStr);
    const fallback = {
      taxAmount: Math.max(0, fallbackTotal - baseAmount),
      totalAfterTax: fallbackTotal || baseAmount,
      raw: [cleanStr],
      diff: Math.abs((fallbackTotal || baseAmount) - baseAmount),
      score: fallbackTotal ? 1 : 0,
    };
    logCandidateDecision(logger, `[${context}]`, cleanStr, fallback, [{ candidate: cleanStr, reason: "fallback single number" }]);
    return fallback;
  }

  let best = null;
  let maxScore = -Infinity;
  const rejections = [];

  for (const candidate of candidates) {
    const taxAmount = parseMoney(candidate[0]);
    const totalAfterTax = parseMoney(candidate[1]);
    const diff = Math.abs(baseAmount + taxAmount - totalAfterTax);
    let score = scoreMoney(taxAmount) + scoreMoney(totalAfterTax) + scoreMathDiff(diff);

    if (totalAfterTax > 1e12 || taxAmount > 1e12) {
      rejections.push({ candidate, reason: "exceeds bounds", taxAmount, totalAfterTax });
      continue;
    }
    if (totalAfterTax < baseAmount) {
      score -= 30;
    }

    if (score > maxScore) {
      if (best) {
        rejections.push({ candidate: best.raw, reason: `superseded by higher score ${score}` });
      }
      maxScore = score;
      best = { taxAmount, totalAfterTax, raw: candidate, diff, score };
    } else {
      rejections.push({ candidate, reason: `lower score ${score}`, diff, baseAmount, taxAmount, totalAfterTax });
    }
  }

  logCandidateDecision(logger, `[${context}]`, cleanStr, best, rejections);
  return best;
}

function resolveItemMoneyTuple(str, logger, context = "item-tuple") {
  const candidates = partitionIntoValidNumbers(str, 3);
  if (!candidates || candidates.length === 0) {
    logCandidateDecision(logger, `[${context}]`, str, null, [{ candidate: str, reason: "no valid partitions" }]);
    return null;
  }

  let best = null;
  let maxScore = -Infinity;
  const rejections = [];

  for (const candidate of candidates) {
    try {
      const qty = parseQuantity(candidate[0]);
      const price = parseMoney(candidate[1]);
      const amtBefore = parseMoney(candidate[2]);
      const diff = Math.abs(qty * price - amtBefore);
      let score = scoreMathDiff(diff) + scoreMoney(price) + scoreMoney(amtBefore);

      if (qty <= 0 || qty > 1e6) {
        rejections.push({ candidate, reason: "invalid quantity", qty });
        continue;
      }
      if (price > 1e12 || amtBefore > 1e12) {
        rejections.push({ candidate, reason: "exceeds bounds", qty, price, amtBefore });
        continue;
      }
      if (qty === 1) score += 8;
      if (amtBefore < price && qty >= 1) score -= 25;

      if (score > maxScore) {
        if (best) {
          rejections.push({ candidate: best.raw, reason: `superseded by higher score ${score}` });
        }
        maxScore = score;
        best = { qty, price, amtBefore, raw: candidate, diff, score };
      } else {
        rejections.push({ candidate, reason: `lower score ${score}`, diff, qty, price, amtBefore });
      }
    } catch (error) {
      rejections.push({ candidate, reason: "parse error", message: error.message });
    }
  }

  logCandidateDecision(logger, `[${context}]`, str, best, rejections);
  return best;
}

function resolveSummaryMoneyTuple(str, count, logger) {
  const cleanStr = str.replace(/[^\d.]/g, "");
  const candidates = partitionIntoValidNumbers(cleanStr, count);
  if (!candidates || candidates.length === 0) {
    if (logger) logger.debug(`[resolveSummaryMoneyTuple] No valid partitions for '${cleanStr}' count=${count}`);
    return null;
  }
  
  let best = null;
  let maxScore = -Infinity;
  const rejections = [];
  
  for (const c of candidates) {
    if (count === 3) {
      const thtien = parseMoney(c[0]);
      const tthue = parseMoney(c[1]);
      const tong = parseMoney(c[2]);
      
      if (thtien > 1e12 || tthue > 1e12 || tong > 1e12) {
        rejections.push({ candidate: c, reason: "out of bounds" });
        continue;
      }
      
      const diff = Math.abs(thtien + tthue - tong);
      let score = scoreMoney(thtien) + scoreMoney(tthue) + scoreMoney(tong) + scoreMathDiff(diff);
      if (tong < thtien || tong < tthue) score -= 120;
      if (tthue > thtien) score -= 90;
      if (thtien > 0 && tthue > thtien * 0.5) score -= 60;
      if (thtien > tong) score -= 120;
      
      if (score > maxScore) {
        maxScore = score;
        best = { thtien, tthue, tong, raw: c, diff, score };
      } else {
        rejections.push({ candidate: c, reason: "math invariant lower score", diff, score });
      }
    } else if (count === 2) {
      const first = parseMoney(c[0]);
      const second = parseMoney(c[1]);
      if (first > 1e12 || second > 1e12) {
        rejections.push({ candidate: c, reason: "out of bounds", first, second });
        continue;
      }
      const score = scoreMoney(first) + scoreMoney(second) + (second >= first ? 25 : -25);
      if (score > maxScore) {
        maxScore = score;
        best = { thtien: first, tthue: 0, tong: second, raw: c, diff: Math.abs(second - first), score };
      } else {
        rejections.push({ candidate: c, reason: "lower score", score, first, second });
      }
    }
  }
  
  logCandidateDecision(logger, "[summary-tuple]", cleanStr, best, rejections);
  return best;
}

module.exports = {
  normalizePdfExtract,
  splitLines,
  extract,
  cleanColonValue,
  isLikelyLabelLine,
  findLineIndex,
  findValueAfterLabelBlock,
  findMultiLineAddressAfterLabelBlock,
  KNOWN_UNITS,
  parseMoney,
  parseQuantity,
  partitionIntoValidNumbers,
  resolvePriceAmountPair,
  resolveTaxTotalPair,
  resolveItemMoneyTuple,
  resolveSummaryMoneyTuple,
};
