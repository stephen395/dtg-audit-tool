/**
 * Zero Usage Analyzer
 * Identifies lines with zero usage across 90 days and generates recommendations.
 * Ported from att_audit.py analyze_zero_usage()
 */

window.ZeroUsageAnalyzer = (function () {
  const SUSPENSION_FEE = 10.00;

  /**
   * Analyze profiles for zero usage lines and generate recommendations.
   * @param {Object} profiles - { wirelessNumber: profileObj }
   * @param {string} carrier - 'att' | 'verizon' | 'tmobile'
   * @returns {Array} Sorted array of zero-usage recommendations
   */
  function analyze(profiles, carrier) {
    const results = [];

    for (const [wn, p] of Object.entries(profiles)) {
      if (!p.zeroUsage) continue;
      if (p.status === 'Cancelled') continue;

      const rec = { ...p };

      if (p.doNotCancel) {
        rec.action = 'KEEP';
        rec.reason = 'Line marked DO NOT CANCEL';
        rec.monthlySavings = 0;
        rec.oneTimeCost = 0;
      } else if (p.status === 'Suspended') {
        if (!p.hasActiveContract) {
          rec.action = 'CANCEL';
          rec.reason = 'Already suspended, no contract — cancel to save $10/mo suspension fee';
          rec.monthlySavings = SUSPENSION_FEE;
          rec.oneTimeCost = 0;
        } else if (p.remainingMonths <= 2) {
          rec.action = 'CANCEL SOON';
          rec.reason = `Suspended, contract ends in ${p.remainingMonths} months — cancel when complete`;
          rec.monthlySavings = SUSPENSION_FEE;
          rec.oneTimeCost = 0;
        } else {
          rec.action = 'KEEP SUSPENDED';
          rec.reason = `Keep suspended until contract ends (${p.remainingMonths} months)`;
          rec.monthlySavings = 0;
          rec.oneTimeCost = 0;
        }
      } else if (!p.hasActiveContract) {
        rec.action = 'CANCEL';
        rec.reason = 'No contract/installment — cancel immediately';
        rec.monthlySavings = p.mrc || p.latestTotal || 0;
        rec.oneTimeCost = 0;
      } else if (p.hasActiveContract && p.remainingMonths <= 1) {
        rec.action = 'CANCEL';
        rec.reason = `Contract ends in ${p.remainingMonths} months — cancel now or when complete`;
        rec.monthlySavings = p.mrc || p.latestTotal || 0;
        rec.oneTimeCost = 0;
      } else {
        // Has active contract — compare options
        const remaining = p.remainingMonths;
        const planCost = (p.latestMonthly || 0) + (p.latestTaxes || 0) + (p.latestFees || 0);
        const etf = p.etf || 0;
        const costSuspend = SUSPENSION_FEE * remaining;
        const savingsFromSuspend = (planCost - SUSPENSION_FEE) * remaining;

        if (etf > 0 && etf <= costSuspend) {
          rec.action = 'CANCEL + PAY ETF';
          rec.reason = `ETF ($${etf.toFixed(2)}) < suspension cost ($${costSuspend.toFixed(2)}) over ${remaining} months`;
          rec.monthlySavings = p.mrc || p.latestTotal || 0;
          rec.oneTimeCost = etf;
        } else if (savingsFromSuspend > 0) {
          rec.action = 'SUSPEND';
          rec.reason = `Suspend saves $${(planCost - SUSPENSION_FEE).toFixed(2)}/mo for ${remaining} months until contract ends`;
          rec.monthlySavings = planCost - SUSPENSION_FEE;
          rec.oneTimeCost = 0;
        } else {
          rec.action = 'KEEP';
          rec.reason = `Contract ends in ${remaining} months, suspension doesn't save enough`;
          rec.monthlySavings = 0;
          rec.oneTimeCost = 0;
        }
      }

      results.push(rec);
    }

    // Sort: CANCEL first, then SUSPEND, then KEEP
    const order = {
      'CANCEL': 0, 'CANCEL SOON': 1, 'SUSPEND': 2,
      'CANCEL + PAY ETF': 3, 'KEEP SUSPENDED': 4, 'KEEP': 5
    };
    results.sort((a, b) => (order[a.action] || 9) - (order[b.action] || 9) || (b.monthlySavings - a.monthlySavings));

    return results;
  }

  /**
   * Generate summary stats from zero usage results
   */
  function summarize(results) {
    const cancels = results.filter(r => ['CANCEL', 'CANCEL SOON', 'CANCEL + PAY ETF'].includes(r.action));
    const suspends = results.filter(r => r.action === 'SUSPEND');
    const keeps = results.filter(r => ['KEEP', 'KEEP SUSPENDED'].includes(r.action));

    return {
      totalZeroUsage: results.length,
      cancelCount: cancels.length,
      cancelSavings: cancels.reduce((s, r) => s + r.monthlySavings, 0),
      suspendCount: suspends.length,
      suspendSavings: suspends.reduce((s, r) => s + r.monthlySavings, 0),
      keepCount: keeps.length,
      totalMonthlySavings: results.reduce((s, r) => s + r.monthlySavings, 0),
      totalOneTimeCost: results.reduce((s, r) => s + r.oneTimeCost, 0),
      outOfContract: results.filter(r => !r.hasActiveContract).length,
      inContract: results.filter(r => r.hasActiveContract).length,
    };
  }

  return { analyze, summarize };
})();
