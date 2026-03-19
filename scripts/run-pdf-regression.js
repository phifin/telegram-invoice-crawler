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
  }

  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
