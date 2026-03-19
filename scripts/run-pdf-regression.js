"use strict";

const fs = require("fs");
const path = require("path");
const { parsePdfInvoice } = require("../src/parsers/pdf.parser");

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

    if (file.includes("1C26MTS_750_0311389477_18-03-2026")) {
      const expectedItems = [
        { stt: 1, soluong: 18, dongia: 22727, tien: 409091, tsuat: 10, _taxAmount: 40909, _totalAfterTax: 450000 },
        { stt: 2, soluong: 21, dongia: 27273, tien: 572727, tsuat: 10, _taxAmount: 57273, _totalAfterTax: 630000 },
        { stt: 3, soluong: 20, dongia: 92593, tien: 1851852, tsuat: 8, _taxAmount: 148148, _totalAfterTax: 2000000 },
        { stt: 4, soluong: 20, dongia: 83333, tien: 1666667, tsuat: 8, _taxAmount: 133333, _totalAfterTax: 1800000 },
      ];

      if (result.hdhhdvu.length !== expectedItems.length) {
        throw new Error(`${file}: expected ${expectedItems.length} items, got ${result.hdhhdvu.length}`);
      }

      for (let i = 0; i < expectedItems.length; i++) {
        const actual = result.hdhhdvu[i];
        const expected = expectedItems[i];
        for (const key of Object.keys(expected)) {
          if (actual[key] !== expected[key]) {
            throw new Error(`${file}: item ${i + 1} field ${key} expected ${expected[key]} got ${actual[key]}`);
          }
        }
      }

      const expectedSummary = [
        { tsuat: 8, thtien: 3518519, tthue: 281481, _totalAmount: 3800000 },
        { tsuat: 10, thtien: 981818, tthue: 98182, _totalAmount: 1080000 },
      ];

      if (result.thttltsuat.length !== expectedSummary.length) {
        throw new Error(`${file}: expected ${expectedSummary.length} summary rows, got ${result.thttltsuat.length}`);
      }

      for (let i = 0; i < expectedSummary.length; i++) {
        const actual = result.thttltsuat[i];
        const expected = expectedSummary[i];
        for (const key of Object.keys(expected)) {
          if (actual[key] !== expected[key]) {
            throw new Error(`${file}: summary ${i + 1} field ${key} expected ${expected[key]} got ${actual[key]}`);
          }
        }
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
