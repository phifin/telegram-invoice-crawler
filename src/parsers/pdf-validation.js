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
