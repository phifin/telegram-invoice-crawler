"use strict";

const { safeString, toNumber } = require("../utils/common");

/**
 * Validates and checks derived math invariants on a parsed invoice.
 * Incorporates 3 levels: REQUIRED, WARNING, DERIVED
 * 
 * @param {object} invoice 
 * @param {object} logger 
 * @returns {object} { isValid: boolean, errors: array }
 */
function validateAndEnhanceInvoice(invoice, logger) {
  const errors = [];
  let isValid = true;
  
  // Helpers
  const addError = (field, level, reason, value) => {
    errors.push({ field, level, reason, value });
    if (level === "REQUIRED") isValid = false;
    if (logger) logger.debug(`[VALIDATION ${level}] ${field}: ${reason} (value: ${value})`);
  };

  // 1. REQUIRED checks (Hard Fail)
  if (!safeString(invoice.shdon) && !safeString(invoice.khhdon)) {
    addError("shdon/khhdon", "REQUIRED", "Missing invoice number and serial", invoice.shdon);
  }
  if (!safeString(invoice.tdlap)) {
    addError("tdlap", "REQUIRED", "Missing creation date", invoice.tdlap);
  }
  if (!safeString(invoice.nbten)) {
    addError("nbten", "REQUIRED", "Missing seller name", invoice.nbten);
  }
  if (!invoice.hdhhdvu || invoice.hdhhdvu.length === 0) {
    addError("hdhhdvu", "REQUIRED", "No line items successfully parsed", "[]");
  }
  if (toNumber(invoice.tgtttbso) <= 0) {
    addError("tgtttbso", "REQUIRED", "Total amount is missing or zero", invoice.tgtttbso);
  }

  // 2. WARNING checks (Soft Fail)
  if (!safeString(invoice.nbdchi)) {
    addError("nbdchi", "WARNING", "Missing seller address", invoice.nbdchi);
  } else if (invoice.nbdchi.length <= 5) {
    addError("nbdchi", "WARNING", "Seller address seems suspiciously short", invoice.nbdchi);
  }
  if (!safeString(invoice.thtttoan)) {
    addError("thtttoan", "WARNING", "Missing payment method", invoice.thtttoan);
  }
  if (!safeString(invoice.nmten)) {
    addError("nmten", "WARNING", "Missing buyer name", invoice.nmten);
  }

  // 3. DERIVED/CHECK (Recompute Math invariants to verify sanity without hard-failing if it's borderline)
  let calcAmtBefore = 0;
  let calcTaxAmt = 0;
  
  for (let i = 0; i < invoice.hdhhdvu.length; i++) {
    const item = invoice.hdhhdvu[i];
    const itemTotal = toNumber(item.tien);
    const itemQty = toNumber(item.soluong);
    const itemPrice = toNumber(item.dongia);
    calcAmtBefore += itemTotal;
    
    if (typeof itemQty !== "number" || itemQty <= 0) {
      addError(`hdhhdvu[${i}].soluong`, "REQUIRED", "Quantity is missing or invalid", item.soluong);
    }
    if (typeof itemPrice !== "number" || itemPrice < 0) {
      addError(`hdhhdvu[${i}].dongia`, "REQUIRED", "Unit price is missing or invalid", item.dongia);
    }
    if (typeof itemTotal !== "number" || itemTotal < 0) {
      addError(`hdhhdvu[${i}].tien`, "REQUIRED", "Line amount is missing or invalid", item.tien);
    }

    // Bounds check on items to prevent DB explosion
    if (itemPrice > 1e13) {
      addError(`hdhhdvu[${i}].dongia`, "REQUIRED", "Unit price astronomically large", item.dongia);
    }
    if (itemTotal > 1e13) {
      addError(`hdhhdvu[${i}].tien`, "REQUIRED", "Line amount astronomically large", item.tien);
    }
    if (typeof itemQty === "number" && typeof itemPrice === "number" && typeof itemTotal === "number") {
      const diff = Math.abs(itemQty * itemPrice - itemTotal);
      if (diff > 1) {
        addError(`hdhhdvu[${i}]`, "CHECK", "Quantity x Unit price does not match line amount", `qty:${itemQty} price:${itemPrice} amount:${itemTotal}`);
      }
    }

    const itemVatAmount = toNumber(item.tthue || item._taxAmount);
    const itemTotalAfterTax = toNumber(item.tgtttbso || item._totalAfterTax);
    if (typeof itemVatAmount === "number" && typeof itemTotalAfterTax === "number" && itemTotalAfterTax > 0) {
      const diff = Math.abs(itemTotal + itemVatAmount - itemTotalAfterTax);
      if (diff > 1) {
        addError(
          `hdhhdvu[${i}]`,
          "CHECK",
          "Amount before VAT + VAT amount does not match total after VAT",
          `before:${itemTotal} vat:${itemVatAmount} after:${itemTotalAfterTax}`,
        );
      }
    }
  }

  invoice.thttltsuat.forEach((ts, index) => {
    calcTaxAmt += toNumber(ts.tthue);
    if (toNumber(ts.thtien) > 1e13 || toNumber(ts.tthue) > 1e13) {
      addError(`thttltsuat[${index}]`, "REQUIRED", "Tax summary contains absurd magnitude", ts);
    }
  });

  const parsedTotal = toNumber(invoice.tgtttbso);
  const parsedAmtBefore = toNumber(invoice.tgtcthue);
  const parsedTaxAmt = toNumber(invoice.tgtthue);

  // Check Math constraints
  if (parsedAmtBefore > 0 && Math.abs(calcAmtBefore - parsedAmtBefore) > 100) {
    addError("tgtcthue", "CHECK", "Sum of items does NOT match declared amount before tax", `Sum:${calcAmtBefore} vs Declared:${parsedAmtBefore}`);
  }

  if (parsedTaxAmt > 0 && Math.abs(calcTaxAmt - parsedTaxAmt) > 100) {
    addError("tgtthue", "CHECK", "Tax summary does NOT match declared total tax", `Summary:${calcTaxAmt} vs Declared:${parsedTaxAmt}`);
  }

  if (invoice.thttltsuat.length > 0 && invoice.hdhhdvu.length > 0) {
    for (const summaryRow of invoice.thttltsuat) {
      const matchingItems = invoice.hdhhdvu.filter((item) => toNumber(item.tsuat) === toNumber(summaryRow.tsuat));
      if (matchingItems.length === 0) continue;

      const groupBeforeVat = matchingItems.reduce((sum, item) => sum + toNumber(item.tien), 0);
      const groupVat = matchingItems.reduce((sum, item) => sum + toNumber(item.tthue || item._taxAmount), 0);
      const groupAfterVat = matchingItems.reduce((sum, item) => sum + toNumber(item.tgtttbso || item._totalAfterTax), 0);

      if (Math.abs(groupBeforeVat - toNumber(summaryRow.thtien)) > 1) {
        addError(`thttltsuat[${summaryRow.tsuat}]`, "CHECK", "Item subtotal does not match VAT summary subtotal", `items:${groupBeforeVat} summary:${summaryRow.thtien}`);
      }
      if (Math.abs(groupVat - toNumber(summaryRow.tthue)) > 1) {
        addError(`thttltsuat[${summaryRow.tsuat}]`, "CHECK", "Item VAT sum does not match VAT summary tax", `items:${groupVat} summary:${summaryRow.tthue}`);
      }
      if (summaryRow._totalAmount && Math.abs(groupAfterVat - toNumber(summaryRow._totalAmount)) > 1) {
        addError(`thttltsuat[${summaryRow.tsuat}]`, "CHECK", "Item total-after-VAT sum does not match VAT summary total", `items:${groupAfterVat} summary:${summaryRow._totalAmount}`);
      }
    }
  }

  if (invoice._grandTotals) {
    const allBeforeVat = invoice.hdhhdvu.reduce((sum, item) => sum + toNumber(item.tien), 0);
    const allVat = invoice.hdhhdvu.reduce((sum, item) => sum + toNumber(item.tthue || item._taxAmount), 0);
    const allAfterVat = invoice.hdhhdvu.reduce((sum, item) => sum + toNumber(item.tgtttbso || item._totalAfterTax), 0);

    if (Math.abs(allBeforeVat - toNumber(invoice._grandTotals.amountBeforeVat)) > 1) {
      addError("grandTotals.amountBeforeVat", "CHECK", "Grand subtotal from items does not match grand summary", `items:${allBeforeVat} summary:${invoice._grandTotals.amountBeforeVat}`);
    }
    if (Math.abs(allVat - toNumber(invoice._grandTotals.vatAmount)) > 1) {
      addError("grandTotals.vatAmount", "CHECK", "Grand VAT from items does not match grand summary", `items:${allVat} summary:${invoice._grandTotals.vatAmount}`);
    }
    if (Math.abs(allAfterVat - toNumber(invoice._grandTotals.totalAmount)) > 1) {
      addError("grandTotals.totalAmount", "CHECK", "Grand total-after-VAT from items does not match grand summary", `items:${allAfterVat} summary:${invoice._grandTotals.totalAmount}`);
    }
  }

  const expectedTotal = parsedAmtBefore + parsedTaxAmt;
  if (expectedTotal > 0 && Math.abs(expectedTotal - parsedTotal) > 100) {
     addError("tgtttbso", "CHECK", "Subtotal + Tax != Total Payment", `Subtotal:${parsedAmtBefore} + Tax:${parsedTaxAmt} != Total:${parsedTotal}`);
  }

  if (parsedTotal > 1e13) {
    addError("tgtttbso", "REQUIRED", "Total amount is astronomically large (likely unseparated concatenation error)", parsedTotal);
  }

  return { isValid, errors };
}

module.exports = { validateAndEnhanceInvoice };
