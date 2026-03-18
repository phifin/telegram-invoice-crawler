"use strict";

const pdfParse = require("pdf-parse");
const logger = require("../../logger");
const {
  safeString,
  toNumber,
  toInteger,
  normalizeInvoiceOutput,
  emptyInvoiceShape,
} = require("../utils/common");

const DEBUG_PDF = true;

function normalizePdfExtract(text) {
  return safeString(text)
    .replace(/\u00ad/g, "") // soft hyphen
    .replace(/\u00a0/g, " ") // nbsp
    .replace(/[‐-‒–—―]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
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

function isLikelyLabelLine(line) {
  return (
    /^\(.+\)$/.test(line) ||
    /^(Đơn vị bán hàng|Mã số thuế|Địa chỉ|Mã cửa hàng|Tên cửa hàng|Số tài khoản|Họ tên người mua hàng|Tên đơn vị|Căn cước công dân|Hình thức thanh toán|Ngày|Ký hiệu|Số|Người mua hàng|Người bán hàng|STT|Tổng hợp|Thuế suất|Tổng tiền chưa thuế|Tổng tiền thuế|Giá trị thanh toán|Tổng tiền chịu thuế suất|Tổng cộng tiền thanh toán|Tổng số tiền viết bằng chữ)/i.test(
      line,
    )
  );
}

function cleanColonValue(value) {
  return safeString(value).replace(/^:\s*/, "").trim();
}

function findLineIndex(lines, predicate, start = 0) {
  for (let i = start; i < lines.length; i++) {
    if (predicate(lines[i], i)) return i;
  }
  return -1;
}

function findValueAfterLabelBlock(
  lines,
  labelStartRegex,
  start = 0,
  maxLookahead = 6,
) {
  const labelIndex = findLineIndex(
    lines,
    (line) => labelStartRegex.test(line),
    start,
  );
  if (labelIndex === -1) return "";

  for (
    let i = labelIndex + 1;
    i <= Math.min(lines.length - 1, labelIndex + maxLookahead);
    i++
  ) {
    const line = lines[i];
    if (/^:/.test(line)) {
      const value = cleanColonValue(line);
      if (value && !isLikelyLabelLine(value)) return value;
      return "";
    }
  }

  return "";
}

function findMultiLineAddressAfterLabelBlock(
  lines,
  labelStartRegex,
  start = 0,
  maxLookahead = 10,
) {
  const labelIndex = findLineIndex(
    lines,
    (line) => labelStartRegex.test(line),
    start,
  );
  if (labelIndex === -1) return "";

  const chunks = [];
  let seenColonLine = false;

  for (
    let i = labelIndex + 1;
    i <= Math.min(lines.length - 1, labelIndex + maxLookahead);
    i++
  ) {
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

function parseLongDate(rawText) {
  const m = rawText.match(
    /Ngày\s*\(date\)\s*(\d{1,2})\s*tháng\s*\(month\)\s*(\d{1,2})\s*năm\s*\(year\)\s*(\d{4})/i,
  );
  if (!m) return "";
  const dd = m[1].padStart(2, "0");
  const mm = m[2].padStart(2, "0");
  const yyyy = m[3];
  return `${yyyy}-${mm}-${dd}`;
}

function parseHeader(rawText, lines, invoice) {
  invoice.thdon =
    extract(rawText, /(HÓA ĐƠN GIÁ TRỊ GIA TĂNG)/i) ||
    "Hóa đơn giá trị gia tăng";

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
    extract(
      rawText,
      /Hình thức thanh toán\s*\(Payment method\)\s*:\s*([^\n]+)/i,
    ) ||
    extract(rawText, /Hình thức thanh toán\(Payment method\):\s*([^\n]+)/i);

  invoice.dvtte = "VND";
  invoice.tgia = 1;
  invoice.khmshdon = 1;
}

function parseSeller(lines, rawText, invoice) {
  const sellerStart = findLineIndex(lines, (line) =>
    /^Đơn vị bán hàng$/i.test(line),
  );
  const buyerStart = findLineIndex(lines, (line) =>
    /^Họ tên người mua hàng$/i.test(line),
  );

  const searchEnd = buyerStart !== -1 ? buyerStart : lines.length;
  const sellerLines = lines.slice(
    sellerStart === -1 ? 0 : sellerStart,
    searchEnd,
  );

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
      const addrIdx = findLineIndex(
        sellerLines,
        (line) => /^:/.test(line),
        idx + 1,
      );
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

function parseBuyer(lines, rawText, invoice) {
  const buyerStart = findLineIndex(lines, (line) =>
    /^Họ tên người mua hàng$/i.test(line),
  );
  const invoiceTitleStart = findLineIndex(lines, (line) =>
    /^HÓA ĐƠN GIÁ TRỊ GIA TĂNG$/i.test(line),
  );

  const buyerLines =
    buyerStart !== -1
      ? lines.slice(
          buyerStart,
          invoiceTitleStart !== -1 ? invoiceTitleStart : lines.length,
        )
      : [];

  invoice.nmten =
    findValueAfterLabelBlock(buyerLines, /^Họ tên người mua hàng$/i) ||
    extract(rawText, /Họ tên người mua hàng\(Buyer's fullname\):\s*([^\n]+)/i);

  invoice.nmdchi = findValueAfterLabelBlock(buyerLines, /^Địa chỉ$/i) || "";

  const buyerTax = findValueAfterLabelBlock(buyerLines, /^Mã số thuế$/i);
  invoice.nmmst = buyerTax && !isLikelyLabelLine(buyerTax) ? buyerTax : "";
}

function parseCompactNumberString(raw) {
  const s = safeString(raw).replace(/[^\d]/g, "");
  return s ? Number(s) : 0;
}

function parseCompactSummaryValueLine(line) {
  const raw = cleanColonValue(line);
  const m = raw.match(/^(\d+%)(\d+)\.(\d{3})(\d+)\.(\d{3})(\d+)\.(\d{3})$/);

  if (!m) return null;

  return {
    tsuat: toInteger(m[1].replace("%", "")),
    thtien: Number(`${m[2]}${m[3]}`),
    tthue: Number(`${m[4]}${m[5]}`),
    tong: Number(`${m[6]}${m[7]}`),
  };
}

function parseTotalCompactLine(line) {
  const raw = cleanColonValue(line);
  const m = raw.match(/^(\d+)\.(\d{3})(\d+)\.(\d{3})(\d+)\.(\d{3})$/);

  if (!m) return null;

  return {
    tgtcthue: Number(`${m[1]}${m[2]}`),
    tgtthue: Number(`${m[3]}${m[4]}`),
    tgtttbso: Number(`${m[5]}${m[6]}`),
  };
}

function parseItems(lines) {
  const items = [];

  for (const line of lines) {
    const compact = safeString(line);
    if (!/^\d/.test(compact)) continue;
    if (!/%\d/.test(compact)) continue;

    const m = compact.match(
      /^(\d+)(.+?)(\d)(\d+\.\d{3})(\d+\.\d{3})(\d+%)(\d+\.\d{3})(\d+\.\d{3})$/,
    );

    if (!m) continue;

    const [
      ,
      stt,
      nameUnitRaw,
      qtyRaw,
      unitPriceRaw,
      amountBeforeTaxRaw,
      taxRateRaw,
    ] = m;
    const taxAmountRaw = m[7];
    const totalAfterTaxRaw = m[8];

    let name = nameUnitRaw;
    let unit = "";

    const unitCandidates = [
      "Cái",
      "Ly",
      "Phần",
      "Suất",
      "Hộp",
      "Chai",
      "Lon",
      "Kg",
      "Gói",
    ];
    for (const candidate of unitCandidates) {
      if (nameUnitRaw.endsWith(candidate)) {
        unit = candidate;
        name = nameUnitRaw.slice(0, -candidate.length);
        break;
      }
    }

    if (!unit) {
      const fallback = nameUnitRaw.match(/(.+?)([A-Za-zÀ-ỹĐđ]+)$/u);
      if (fallback) {
        name = fallback[1];
        unit = fallback[2];
      }
    }

    items.push({
      tchat: 1,
      stt: toInteger(stt),
      ma: "",
      ten: safeString(name),
      dvtinh: safeString(unit),
      soluong: toInteger(qtyRaw),
      dongia: toNumber(unitPriceRaw),
      tien: toNumber(amountBeforeTaxRaw),
      tsuat: toInteger(taxRateRaw.replace("%", "")),
      _taxAmount: toNumber(taxAmountRaw),
      _amountAfterTax: toNumber(totalAfterTaxRaw),
    });
  }

  return items;
}

function parseTaxSummary(lines) {
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/^Tổng tiền chịu thuế suất$/i.test(lines[i])) continue;

    const valueLine =
      lines[i + 2] && /^:/.test(lines[i + 2]) ? lines[i + 2] : "";
    if (!valueLine) continue;

    const parsed = parseCompactSummaryValueLine(valueLine);
    if (parsed) {
      result.push({
        tsuat: parsed.tsuat,
        thtien: parsed.thtien,
        tthue: parsed.tthue,
      });
    }
  }

  return result;
}

function parseSummary(rawText, lines, invoice) {
  invoice.thttltsuat = parseTaxSummary(lines);

  for (let i = 0; i < lines.length; i++) {
    if (!/^Tổng cộng tiền thanh toán$/i.test(lines[i])) continue;

    const valueLine =
      lines[i + 2] && /^:/.test(lines[i + 2]) ? lines[i + 2] : "";
    if (!valueLine) continue;

    const totals = parseTotalCompactLine(valueLine);
    if (totals) {
      invoice.tgtcthue = totals.tgtcthue;
      invoice.tgtthue = totals.tgtthue;
      invoice.tgtttbso = totals.tgtttbso;
      break;
    }
  }

  if (!invoice.tgtcthue && invoice.thttltsuat.length) {
    invoice.tgtcthue = invoice.thttltsuat.reduce(
      (sum, item) => sum + Number(item.thtien || 0),
      0,
    );
  }

  if (!invoice.tgtthue && invoice.thttltsuat.length) {
    invoice.tgtthue = invoice.thttltsuat.reduce(
      (sum, item) => sum + Number(item.tthue || 0),
      0,
    );
  }

  invoice.tgtttbchu =
    extract(rawText, /Tổng số tiền viết bằng chữ:\s*([^\n]+)/i) ||
    extract(rawText, /Tổng số tiền viết bằng chữ\s*:\s*([^\n]+)/i);
}

async function parsePdfInvoice(buffer) {
  const pdfData = await pdfParse(buffer);
  const rawText = normalizePdfExtract(pdfData.text);
  const lines = splitLines(pdfData.text);

  logger.info("PDF text extracted length:", rawText.length);
  logger.info("PDF lines extracted:", lines.length);

  if (DEBUG_PDF) {
    logger.info("========== PDF RAW OUTPUT ==========");
    logger.info("Meta:", {
      numpages: pdfData.numpages,
      numrender: pdfData.numrender,
      info: pdfData.info,
      metadata: pdfData.metadata,
      version: pdfData.version,
    });
    logger.info("---------- RAW TEXT ----------");
    logger.info("\n" + rawText);
    logger.info("---------- LINES ----------");
    lines.forEach((line, idx) => {
      logger.info(`[${idx}] ${line}`);
    });
    logger.info("========== END DEBUG ==========");
  }

  const invoice = emptyInvoiceShape();

  parseHeader(rawText, lines, invoice);
  parseSeller(lines, rawText, invoice);
  parseBuyer(lines, rawText, invoice);
  invoice.hdhhdvu = parseItems(lines);
  parseSummary(rawText, lines, invoice);

  logger.info("PDF parser intermediate:", {
    khhdon: invoice.khhdon,
    shdon: invoice.shdon,
    tdlap: invoice.tdlap,
    thtttoan: invoice.thtttoan,
    msttcgp: invoice.msttcgp,
    nbten: invoice.nbten,
    nbmst: invoice.nbmst,
    nbdchi: invoice.nbdchi,
    nbstkhoan: invoice.nbstkhoan,
    nmten: invoice.nmten,
    nmmst: invoice.nmmst,
    nmdchi: invoice.nmdchi,
    itemCount: invoice.hdhhdvu.length,
    thttltsuat: invoice.thttltsuat,
    tgtcthue: invoice.tgtcthue,
    tgtthue: invoice.tgtthue,
    tgtttbso: invoice.tgtttbso,
    tgtttbchu: invoice.tgtttbchu,
  });

  return normalizeInvoiceOutput(invoice);
}

module.exports = { parsePdfInvoice };
