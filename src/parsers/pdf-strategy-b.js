"use strict";

const {
  resolveItemMoneyTuple,
  resolveSummaryMoneyTuple,
} = require("./pdf-utils");

/**
 * Heuristic Strategy B:
 * Scans all lines for mathematically sound numeric tuples and builds the best-effort invoice interpretation.
 */
function runHeuristicFallbackParser(lines, invoice, logger) {
  logger.debug("[STRATEGY B] Running heuristic fallback parser...");
  
  const parsedItems = [];
  let sttCounter = 0;
  
  for (const line of lines) {
    if (!/^\d/.test(line)) continue; // item lines usually start with STT
    
    // Normalize string to avoid spaced concatenations
    const s = line.replace(/\s+/g, "");
    // Extract trailing number blob. It might have KCT or % in the middle.
    const trailing = s.match(/([\d.,]+)(?:KCT|%|)?([\d.,]*)$/);
    if (!trailing) continue;
    
    const leftNums = trailing[1];
    
    // Build interpretation candidates for this line
    const solvedLeft = resolveItemMoneyTuple(leftNums, null);
    if (solvedLeft && solvedLeft.amtBefore > 0) {
      sttCounter++;
      // Find where leftNums started to separate name
      const namePart = line.substring(0, line.lastIndexOf(leftNums.charAt(0)));
      
      parsedItems.push({
        tchat: 1,
        stt: sttCounter,
        ten: namePart.trim() || `Item ${sttCounter}`,
        soluong: solvedLeft.qty,
        dongia: solvedLeft.price,
        tien: solvedLeft.amtBefore,
        tsuat: 0, // Fallback doesn't strictly know tax
      });
      logger.debug(`[STRATEGY B] Accepted candidate for line: ${line} -> ${JSON.stringify(solvedLeft)}`);
    } else {
      logger.debug(`[STRATEGY B] Rejected line (no valid math split): ${line}`);
    }
  }
  
  invoice.hdhhdvu = parsedItems;
  
  // Calculate summary 
  const computedSubtotal = parsedItems.reduce((acc, item) => acc + item.tien, 0);
  
  // Search for the best summary line that matches computedSubtotal
  let bestSummary = { thtien: computedSubtotal, tthue: 0, tong: computedSubtotal };
  let maxScore = -1;
  const summaryCandidates = [];
  
  for (const line of lines) {
    if (!/Tổng|tiền|toán|cộng/i.test(line)) continue;
    
    const numsStr = line.replace(/[^\d.]/g, "");
    if (numsStr.length < 4) continue;
    
    const s3 = resolveSummaryMoneyTuple(numsStr, 3, null);
    const s2 = resolveSummaryMoneyTuple(numsStr, 2, null);
    
    if (s3) summaryCandidates.push({ line, type: 3, data: s3 });
    if (s2) summaryCandidates.push({ line, type: 2, data: s2 });
  }
  
  // Score summary candidates based on how close they are to computedSubtotal
  for (const cand of summaryCandidates) {
    let score = 0;
    const diff = Math.abs(cand.data.tong - computedSubtotal);
    if (diff === 0) score = 100;
    else if (diff <= 10) score = 80;
    else if (cand.data.thtien > 0 && Math.abs(cand.data.thtien - computedSubtotal) <= 10) score = 90;
    
    if (score > maxScore) {
      maxScore = score;
      bestSummary = cand.data;
    }
  }
  
  logger.debug(`[STRATEGY B] Evaluated ${summaryCandidates.length} summary candidates. Best score: ${maxScore}`);
  
  invoice.tgtcthue = bestSummary.thtien > 0 ? bestSummary.thtien : computedSubtotal;
  invoice.tgtthue = bestSummary.tthue || 0;
  invoice.tgtttbso = bestSummary.tong || computedSubtotal;
}

module.exports = { runHeuristicFallbackParser };
