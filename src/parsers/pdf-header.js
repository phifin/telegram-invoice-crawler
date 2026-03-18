"use strict";

const { safeString, toInteger } = require("../utils/common");
const {
  extract,
  isLikelyLabelLine,
  findLineIndex,
  findValueAfterLabelBlock,
  findMultiLineAddressAfterLabelBlock,
} = require("./pdf-utils");

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function parseLongDate(rawText) {
  const m = rawText.match(
    /Ngày\s*(?:\(date\))?\s*(\d{1,2})\s*tháng\s*(?:\(month\))?\s*(\d{1,2})\s*năm\s*(?:\(year\))?\s*(\d{4})/i,
  );
  if (!m) return "";
  const dd = m[1].padStart(2, "0");
  const mm = m[2].padStart(2, "0");
  const yyyy = m[3];
  return `${yyyy}-${mm}-${dd}`;
}

function parseHeader(rawText, lines, invoice) {
  invoice.thdon =
    extract(rawText, /(HÓA ĐƠN GIÁ TRỊ GIA TĂNG)/i) || "Hóa đơn giá trị gia tăng";

  invoice.khhdon =
    findValueAfterLabelBlock(lines, /^Ký hiệu$/i) ||
    extract(rawText, /Ký hiệu\s*\(Serial No\.?\)\s*:\s*([A-Z0-9]+)/i) ||
    extract(rawText, /Ký hiệu\(Serial No\.?\):\s*([A-Z0-9]+)/i);

  invoice.shdon = toInteger(
    findValueAfterLabelBlock(lines, /^Số$/i) ||
      extract(rawText, /Số\s*\(No\.?\)\s*:\s*(\d+)/i) ||
      extract(rawText, /Số\(No\.?\):\s*(\d+)/i),
  );

  invoice.tdlap = parseLongDate(rawText);

  invoice.msttcgp =
    extract(rawText, /Mã của cơ quan thuế\s*:\s*([A-Z0-9-]+)/i) ||
    extract(rawText, /Mã của cơ quan thuế:\s*([A-Z0-9-]+)/i);

  invoice.thtttoan =
    findValueAfterLabelBlock(lines, /^Hình thức thanh toán$/i) ||
    extract(rawText, /Hình thức thanh toán\s*\(Payment method\)\s*:\s*([^\n]+)/i) ||
    extract(rawText, /Hình thức thanh toán\(Payment method\):\s*([^\n]+)/i);

  invoice.dvtte = "VND";
  invoice.tgia = 1;
  invoice.khmshdon = 1;
}

// ---------------------------------------------------------------------------
// Seller
// ---------------------------------------------------------------------------

function parseSeller(lines, rawText, invoice) {
  const sellerStart = findLineIndex(lines, (line) => /^Đơn vị bán hàng$/i.test(line));
  const buyerStart = findLineIndex(lines, (line) => /^Họ tên người mua hàng$/i.test(line));

  const searchEnd = buyerStart !== -1 ? buyerStart : lines.length;
  const sellerLines = lines.slice(sellerStart === -1 ? 0 : sellerStart, searchEnd);

  invoice.nbten =
    findValueAfterLabelBlock(sellerLines, /^Đơn vị bán hàng$/i) ||
    extract(rawText, /Đơn vị bán hàng\(Seller\):\s*([^\n]+)/i);

  invoice.nbmst =
    findValueAfterLabelBlock(sellerLines, /^Mã số thuế$/i) ||
    extract(rawText, /Mã số thuế\(Tax code\):\s*([0-9-]+)/i);

  invoice.nbdchi =
    findMultiLineAddressAfterLabelBlock(sellerLines, /^Địa chỉ$/i) ||
    extract(rawText, /Địa chỉ\(Address\):\s*(.+?)\nViệt Nam/i);

  if (
    invoice.nbdchi &&
    !/Việt Nam$/i.test(invoice.nbdchi) &&
    rawText.includes("Việt Nam")
  ) {
    const idx = sellerLines.findIndex((line) => /^Địa chỉ$/i.test(line));
    if (idx !== -1) {
      const addrIdx = findLineIndex(sellerLines, (line) => /^:/.test(line), idx + 1);
      if (addrIdx !== -1 && sellerLines[addrIdx + 1] === "Việt Nam") {
        invoice.nbdchi = `${invoice.nbdchi} Việt Nam`.trim();
      }
    }
  }

  const stk = findValueAfterLabelBlock(sellerLines, /^Số tài khoản$/i);
  invoice.nbstkhoan = stk && !isLikelyLabelLine(stk) ? stk : "";

  const bank = findValueAfterLabelBlock(sellerLines, /^Tên ngân hàng$/i);
  invoice.nbtnhang = bank && !isLikelyLabelLine(bank) ? bank : "";
}

// ---------------------------------------------------------------------------
// Buyer
// ---------------------------------------------------------------------------

function parseBuyer(lines, rawText, invoice) {
  const buyerStart = findLineIndex(lines, (line) => /^Họ tên người mua hàng$/i.test(line));
  const invoiceTitleStart = findLineIndex(lines, (line) =>
    /^HÓA ĐƠN GIÁ TRỊ GIA TĂNG$/i.test(line),
  );

  const buyerLines =
    buyerStart !== -1
      ? lines.slice(buyerStart, invoiceTitleStart !== -1 ? invoiceTitleStart : lines.length)
      : [];

  invoice.nmten =
    findValueAfterLabelBlock(buyerLines, /^Họ tên người mua hàng$/i) ||
    extract(rawText, /Họ tên người mua hàng\(Buyer's fullname\):\s*([^\n]+)/i);

  invoice.nmdchi = findValueAfterLabelBlock(buyerLines, /^Địa chỉ$/i) || "";

  const buyerTax = findValueAfterLabelBlock(buyerLines, /^Mã số thuế$/i);
  invoice.nmmst = buyerTax && !isLikelyLabelLine(buyerTax) ? buyerTax : "";
}

module.exports = { parseHeader, parseSeller, parseBuyer };
