"use strict";

const { XMLParser } = require("fast-xml-parser");
const {
  safeString,
  toNumber,
  toInteger,
  normalizeInvoiceOutput,
} = require("../utils/common");

function ensureArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === "") return [];
  return [value];
}

function parseExtraInfo(ttKhac) {
  const result = {};
  const ttinList = ensureArray(ttKhac?.TTin);

  for (const item of ttinList) {
    const key = safeString(item?.TTruong);
    const value = safeString(item?.DLieu);
    if (key) result[key] = value;
  }

  return result;
}

function parseItem(item) {
  return {
    tchat: toInteger(item?.TChat),
    stt: toInteger(item?.STT),
    ma: safeString(item?.MHHDVu),
    ten: safeString(item?.THHDVu),
    dvtinh: safeString(item?.DVTinh || ""),
    soluong: toNumber(item?.SLuong),
    dongia: toNumber(item?.DGia),
    tien: toNumber(item?.ThTien),
    tsuat: safeString(item?.TSuat),
  };
}

function parseTaxSummary(item) {
  return {
    tsuat: safeString(item?.TSuat),
    thtien: toNumber(item?.ThTien),
    tthue: toNumber(item?.TThue),
  };
}

function parseXmlInvoice(buffer) {
  const xmlText = buffer.toString("utf8");

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    parseTagValue: false,
    trimValues: true,
  });

  const obj = parser.parse(xmlText);

  const hdon = obj?.HDon || {};
  const dlhdon = hdon?.DLHDon || {};
  const ttChung = dlhdon?.TTChung || {};
  const ndhDon = dlhdon?.NDHDon || {};
  const nBan = ndhDon?.NBan || {};
  const nMua = ndhDon?.NMua || {};
  const tToan = ndhDon?.TToan || {};

  const extraCommon = parseExtraInfo(ttChung?.TTKhac);

  const rawItems = ensureArray(ndhDon?.DSHHDVu?.HHDVu);
  const rawTaxSummary = ensureArray(tToan?.THTTLTSuat?.LTSuat);

  const mapped = {
    id: safeString(dlhdon?.Id),
    pban: safeString(ttChung?.PBan),
    thdon: safeString(ttChung?.THDon),
    khmshdon: toInteger(ttChung?.KHMSHDon),
    khhdon: safeString(ttChung?.KHHDon),
    shdon: toInteger(ttChung?.SHDon),
    tdlap: safeString(ttChung?.NLap),
    dvtte: safeString(ttChung?.DVTTe || "VND"),
    tgia: toNumber(ttChung?.TGia || 1),
    thtttoan: safeString(
      ttChung?.HTTToan || extraCommon["HT thanh toán"] || "",
    ),
    msttcgp: safeString(ttChung?.MSTTCGP || hdon?.MCCQT || ""),
    nbten: safeString(nBan?.Ten),
    nbmst: safeString(nBan?.MST),
    nbdchi: safeString(nBan?.DChi),
    nbstkhoan: safeString(nBan?.STKhoan || ""),
    nbtnhang: safeString(nBan?.TNHang || ""),
    nmten: safeString(
      nMua?.Ten || nMua?.HVTNMHang || extraCommon["Tên người mua"] || "",
    ),
    nmmst: safeString(nMua?.MST || ""),
    nmdchi: safeString(nMua?.DChi || extraCommon["Địa chỉ"] || ""),
    hdhhdvu: rawItems.map(parseItem),
    thttltsuat: rawTaxSummary.map(parseTaxSummary),
    tgtcthue: toNumber(tToan?.TgTCThue),
    tgtthue: toNumber(tToan?.TgTThue),
    ttcktmai: toNumber(tToan?.TTCKTMai || 0),
    tgtttbso: toNumber(tToan?.TgTTTBSo),
    tgtttbchu: safeString(tToan?.TgTTTBChu),
  };

  return normalizeInvoiceOutput(mapped);
}

module.exports = { parseXmlInvoice };
