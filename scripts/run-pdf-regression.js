"use strict";

const fs = require("fs");
const path = require("path");
const { parsePdfInvoice } = require("../src/parsers/pdf.parser");

function assertRows(file, actualRows, expectedRows, label) {
  if (actualRows.length !== expectedRows.length) {
    throw new Error(`${file}: expected ${expectedRows.length} ${label}, got ${actualRows.length}`);
  }

  for (let i = 0; i < expectedRows.length; i++) {
    const actual = actualRows[i];
    const expected = expectedRows[i];
    for (const key of Object.keys(expected)) {
      if (actual[key] !== expected[key]) {
        throw new Error(`${file}: ${label} ${i + 1} field ${key} expected ${expected[key]} got ${actual[key]}`);
      }
    }
  }
}

async function main() {
  const dir = path.join(__dirname, "..", "test_files");
  const files = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".pdf")).sort();
  let failed = false;

  for (const file of files) {
    const fullPath = path.join(dir, file);
    const result = await parsePdfInvoice(fs.readFileSync(fullPath));
    const summary = {
      file,
      itemCount: result.hdhhdvu.length,
      subtotal: result.tgtcthue,
      tax: result.tgtthue,
      total: result.tgtttbso,
      errors: result._validationErrors || [],
    };

    console.log(JSON.stringify(summary, null, 2));

    const requiredErrors = summary.errors.filter((error) => error.level === "REQUIRED");
    if (
      requiredErrors.length > 0 ||
      summary.itemCount < 1 ||
      typeof summary.total !== "number" ||
      summary.total <= 0
    ) {
      failed = true;
    }

    if (result.shdon === 750 && String(result.nbmst || "") === "0106026495998" && String(result.nmmst || "") === "0311389477") {
      const expectedItems = [
        { stt: 1, soluong: 18, dongia: 22727, tien: 409091, tsuat: 10, tthue: 40909, tgtttbso: 450000 },
        { stt: 2, soluong: 21, dongia: 27273, tien: 572727, tsuat: 10, tthue: 57273, tgtttbso: 630000 },
        { stt: 3, soluong: 20, dongia: 92593, tien: 1851852, tsuat: 8, tthue: 148148, tgtttbso: 2000000 },
        { stt: 4, soluong: 20, dongia: 83333, tien: 1666667, tsuat: 8, tthue: 133333, tgtttbso: 1800000 },
      ];
      assertRows(file, result.hdhhdvu, expectedItems, "item");

      const expectedSummary = [
        { tsuat: 8, thtien: 3518519, tthue: 281481, _totalAmount: 3800000 },
        { tsuat: 10, thtien: 981818, tthue: 98182, _totalAmount: 1080000 },
      ];
      assertRows(file, result.thttltsuat, expectedSummary, "summary");
    }

    if (result.shdon === 755 && String(result.nbmst || "") === "0106026495998" && String(result.nmmst || "") === "0311389477") {
      const expectedItems = [
        { stt: 1, soluong: 5, dongia: 27273, tien: 136364, tsuat: 10, tthue: 13636, tgtttbso: 150000 },
        { stt: 2, soluong: 12, dongia: 92593, tien: 1111111, tsuat: 8, tthue: 88889, tgtttbso: 1200000 },
        { stt: 3, soluong: 18, dongia: 83333, tien: 1500000, tsuat: 8, tthue: 120000, tgtttbso: 1620000 },
      ];
      assertRows(file, result.hdhhdvu, expectedItems, "item");

      const expectedSummary = [
        { tsuat: 8, thtien: 2611111, tthue: 208889, _totalAmount: 2820000 },
        { tsuat: 10, thtien: 136364, tthue: 13636, _totalAmount: 150000 },
      ];
      assertRows(file, result.thttltsuat, expectedSummary, "summary");

      if (result.tgtcthue !== 2747475 || result.tgtthue !== 222525 || result.tgtttbso !== 2970000) {
        throw new Error(
          `${file}: totals expected beforeVat=2747475 vat=222525 total=2970000 got beforeVat=${result.tgtcthue} vat=${result.tgtthue} total=${result.tgtttbso}`,
        );
      }
    }
  }

  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
