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

function resolveItemMoneyTuple(str, logger) {
  const candidates = partitionIntoValidNumbers(str, 3);
  if (!candidates || candidates.length === 0) {
    if (logger) logger.debug(`[resolveItemMoneyTuple] No valid partitions for '${str}'`);
    return null;
  }
  
  let best = null;
  let maxScore = -1;
  const rejections = [];
  
  for (const c of candidates) {
    try {
      const qs = c[0].replace(/,/g, ".");
      const q = Number(qs);
      const p = parseMoney(c[1]);
      const a = parseMoney(c[2]);
      
      if (p > 1e12 || a > 1e12 || q > 1e6) {
        rejections.push({ candidate: c, reason: "exceeds bounds" });
        continue;
      }
      
      const diff = Math.abs(q * p - a);
      let score = -1;
      if (diff <= 1) {
        score = 100 - diff;
      } else if (diff <= 10) {
        score = 50 - diff;
      }
      
      if (score > maxScore) {
        maxScore = score;
        best = { qty: q, price: p, amtBefore: a, raw: c };
      } else {
        rejections.push({ candidate: c, reason: `math invariant score ${score} <= ${maxScore}` });
      }
    } catch(e) {
      rejections.push({ candidate: c, reason: "parse error" });
    }
  }
  
  if (logger) {
    logger.debug(`[resolveItemMoneyTuple] Evaluated ${candidates.length} candidates for '${str}'. Best:`, best?.raw, `Rejections: ${rejections.length}`);
  }
  
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
  let maxScore = -1;
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
      let score = -1;
      if (diff <= 1) score = 100 - diff;
      else if (diff <= 10) score = 50 - diff;
      
      if (score > maxScore) {
        maxScore = score;
        best = { thtien, tthue, tong, raw: c };
      } else {
        rejections.push({ candidate: c, reason: "math invariant lower score" });
      }
    } else if (count === 2) {
      const tthue = parseMoney(c[0]);
      const tong = parseMoney(c[1]);
      if (tthue > 1e12 || tong > 1e12) continue;
      const score = 100;
      if (score > maxScore) { maxScore = score; best = { thtien: 0, tthue, tong, raw: c }; }
    }
  }
  
  if (logger) {
    logger.debug(`[resolveSummaryMoneyTuple] Evaluated ${candidates.length} candidates for '${cleanStr}'. Best: ${best?.raw}`);
  }
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
  partitionIntoValidNumbers,
  resolveItemMoneyTuple,
  resolveSummaryMoneyTuple,
};
