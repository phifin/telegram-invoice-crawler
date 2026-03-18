"use strict";

function safeString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function getFirst(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return "";
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return value;
  const raw = String(value).trim();
  // preserve non-numeric tax codes like "KCT", "KKKNT", "0%"
  if (!/^-?[\d.,]+$/.test(raw)) return raw;
  const cleaned = raw.replace(/\./g, "").replace(/,/g, ".");
  const parsed = Number(cleaned);
  return Number.isNaN(parsed) ? raw : parsed;
}

function toInteger(value) {
  const n = toNumber(value);
  return typeof n === "number" ? Math.trunc(n) : 0;
}

function normalizeDate(value) {
  const s = safeString(value);
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) {
    return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return s;
}

function normalizeWhitespace(text) {
  return safeString(text)
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function normalizeMultilineText(text) {
  return safeString(text)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
}

function extractMatch(text, regex, groupIndex = 1) {
  const m = text.match(regex);
  return m ? safeString(m[groupIndex]) : "";
}

function parseMoneyText(s) {
  const raw = safeString(s);
  if (!raw) return 0;
  const digits = raw.replace(/[^\d-]/g, "");
  return digits ? Number(digits) : 0;
}

function emptyInvoiceShape() {
  return {
    id: "",
    pban: "",
    thdon: "",
    khmshdon: 0,
    khhdon: "",
    shdon: 0,
    tdlap: "",
    dvtte: "VND",
    tgia: 1,
    thtttoan: "",
    msttcgp: "",
    nbten: "",
    nbmst: "",
    nbdchi: "",
    nbstkhoan: "",
    nbtnhang: "",
    nmten: "",
    nmmst: "",
    nmdchi: "",
    hdhhdvu: [],
    thttltsuat: [],
    tgtcthue: 0,
    tgtthue: 0,
    ttcktmai: 0,
    tgtttbso: 0,
    tgtttbchu: "",
  };
}

function normalizeInvoiceOutput(raw) {
  const out = emptyInvoiceShape();

  out.id = safeString(raw.id);
  out.pban = safeString(raw.pban);
  out.thdon = safeString(raw.thdon);
  out.khmshdon = toInteger(raw.khmshdon);
  out.khhdon = safeString(raw.khhdon);
  out.shdon = toInteger(raw.shdon);
  out.tdlap = normalizeDate(raw.tdlap);
  out.dvtte = safeString(raw.dvtte || "VND") || "VND";
  out.tgia = typeof raw.tgia === "number" ? raw.tgia : Number(raw.tgia || 1) || 1;
  out.thtttoan = safeString(raw.thtttoan);
  out.msttcgp = safeString(raw.msttcgp);
  out.nbten = safeString(raw.nbten);
  out.nbmst = safeString(raw.nbmst);
  out.nbdchi = safeString(raw.nbdchi);
  out.nbstkhoan = safeString(raw.nbstkhoan);
  out.nbtnhang = safeString(raw.nbtnhang);
  out.nmten = safeString(raw.nmten);
  out.nmmst = safeString(raw.nmmst);
  out.nmdchi = safeString(raw.nmdchi);

  out.hdhhdvu = Array.isArray(raw.hdhhdvu)
    ? raw.hdhhdvu.map((item, index) => {
        const sl = toNumber(item.soluong);
        const dg = toNumber(item.dongia);
        const ti = toNumber(item.tien);
        const ts = toNumber(item.tsuat);
        return {
          tchat: toInteger(getFirst(item.tchat, 1)),
          stt: toInteger(getFirst(item.stt, index + 1)),
          ma: safeString(item.ma),
          ten: safeString(item.ten),
          dvtinh: safeString(item.dvtinh),
          soluong: typeof sl === "number" ? sl : item.soluong,
          dongia: typeof dg === "number" ? dg : item.dongia,
          tien: typeof ti === "number" ? ti : item.tien,
          tsuat: typeof ts === "number" ? ts : safeString(item.tsuat),
        };
      })
    : [];

  out.thttltsuat = Array.isArray(raw.thttltsuat)
    ? raw.thttltsuat.map((item) => {
        const ts = toNumber(item.tsuat);
        return {
          tsuat: typeof ts === "number" ? ts : safeString(item.tsuat),
          thtien: typeof toNumber(item.thtien) === "number" ? toNumber(item.thtien) : 0,
          tthue: typeof toNumber(item.tthue) === "number" ? toNumber(item.tthue) : 0,
        };
      })
    : [];

  out.tgtcthue = typeof toNumber(raw.tgtcthue) === "number" ? toNumber(raw.tgtcthue) : 0;
  out.tgtthue = typeof toNumber(raw.tgtthue) === "number" ? toNumber(raw.tgtthue) : 0;
  out.ttcktmai = typeof toNumber(raw.ttcktmai) === "number" ? toNumber(raw.ttcktmai) : 0;
  out.tgtttbso = typeof toNumber(raw.tgtttbso) === "number" ? toNumber(raw.tgtttbso) : 0;
  out.tgtttbchu = safeString(raw.tgtttbchu);

  return out;
}

module.exports = {
  safeString,
  getFirst,
  toNumber,
  toInteger,
  normalizeDate,
  normalizeWhitespace,
  normalizeMultilineText,
  extractMatch,
  parseMoneyText,
  emptyInvoiceShape,
  normalizeInvoiceOutput,
};
