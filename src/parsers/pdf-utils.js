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

/**
 * Split a concatenated Vietnamese money string (dot-separated groups)
 * into `count` numeric values, working right-to-left.
 *
 * e.g. splitCompactMoneyRun("83.3336.66790.000", 3) → [83333, 6667, 90000]
 */
function splitCompactMoneyRun(raw, count) {
  const s = raw.replace(/[^\d.]/g, "");
  if (!s) return null;

  const parts = s.split(".");
  const result = [];
  let right = parts.length;

  for (let v = 0; v < count; v++) {
    if (right < 1) return null;
    const tail = parts[right - 1];
    if (tail.length !== 3) return null;
    right--;

    if (right === 0) {
      result.unshift(Number(tail));
      continue;
    }

    const isLast = v === count - 1;
    const valueParts = [tail];
    if (isLast) {
      for (let j = right - 1; j >= 0; j--) valueParts.unshift(parts[j]);
      right = 0;
    } else {
      valueParts.unshift(parts[right - 1]);
      right--;
    }
    result.unshift(Number(valueParts.join("")));
  }

  return result.length === count ? result : null;
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
  splitCompactMoneyRun,
};
