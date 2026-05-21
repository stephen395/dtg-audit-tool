/**
 * Zero Usage Analyzer
 * Identifies lines with zero usage across 90 days and generates recommendations.
 * Ported from att_audit.py analyze_zero_usage()
 *
 * SOURCE-OF-TRUTH: usage fields (gbTotal, minTotal, msgTotal, zeroUsage) are
 * CSV-authoritative; financial fields (mrc, latestMonthly, hasActiveContract,
 * remainingMonths, etf) are PDF-authoritative. The merge step in app.js
 * already applied the rule; this analyzer reads merged fields directly.
 * See SOURCE_OF_TRUTH.md.
 */

window.ZeroUsageAnalyzer = (function () {
  const SUSPENSION_FEE = 10.00;

  /**
   * Build a peer-rate map: { ratePlanName: averageMRC } from lines that
   * are actively billed at the plan's full rate this cycle.
   *
   * Plan-mode MRC substitution (Genserve learning): a line that shows
   * MRC=$0 because it's currently suspended — but has a known plan name
   * — is recoverable at the peer rate, not just the $10 suspension fee.
   * Without this, the audit undercounts cancel-savings for any suspended
   * line on a plan whose name doesn't carry the MRC (MY BIZ PLAN, etc.).
   */
  function buildPeerRateMap(profiles) {
    const peerSums = {};
    for (const p of Object.values(profiles)) {
      const plan = (p.ratePlan || '').trim();
      if (!plan || plan === 'Unknown') continue;
      // Only count lines that look like full-month active billing —
      // skip suspended, refund, one-time-only, and proration cases so
      // we don't dilute the peer rate.
      if (p.lineStatus && p.lineStatus !== 'active-full-month' &&
          p.lineStatus !== 'active-with-credits') continue;
      const mrc = Number(p.mrc || p.latestMonthly || 0);
      if (mrc <= 0.01) continue;
      if (!peerSums[plan]) peerSums[plan] = { sum: 0, count: 0 };
      peerSums[plan].sum += mrc;
      peerSums[plan].count++;
    }
    const peerMap = {};
    for (const [plan, agg] of Object.entries(peerSums)) {
      peerMap[plan] = agg.sum / agg.count;
    }
    return peerMap;
  }

  /**
   * Look up the plan-mode MRC for a suspended/zero-MRC line. Returns
   * the line's own MRC if it has one; otherwise the peer-rate average
   * for its plan; otherwise 0.
   */
  function planModeMRC(p, peerRateMap) {
    const own = Number(p.mrc || p.latestMonthly || 0);
    if (own > 0.01) return own;
    const plan = (p.ratePlan || '').trim();
    if (plan && peerRateMap[plan]) return peerRateMap[plan];
    return 0;
  }

  /**
   * Analyze profiles for zero usage lines and generate recommendations.
   * @param {Object} profiles - { wirelessNumber: profileObj }
   * @param {string} carrier - 'att' | 'verizon' | 'tmobile'
   * @returns {Array} Sorted array of zero-usage recommendations
   */
  function analyze(profiles, carrier) {
    const results = [];
    const peerRateMap = buildPeerRateMap(profiles);

    for (const [wn, p] of Object.entries(profiles)) {
      if (!p.zeroUsage) continue;
      if (p.status === 'Cancelled') continue;

      const rec = { ...p };
      // Plan-mode MRC: what this line WOULD be costing at peer rate if
      // it weren't suspended/$0 this cycle. Used for cancel-savings math.
      const planModeRate = planModeMRC(p, peerRateMap);

      if (p.doNotCancel) {
        rec.action = 'KEEP';
        rec.reason = 'Line marked DO NOT CANCEL';
        rec.monthlySavings = 0;
        rec.oneTimeCost = 0;
      } else if (p.status === 'Suspended' || p.lineStatus === 'suspended') {
        if (!p.hasActiveContract) {
          rec.action = 'CANCEL';
          // Plan-mode substitution: if there's a known peer rate, the
          // monthly recovery is suspension fee + peer rate's worth of
          // future billing avoided once the carrier reactivates.
          if (planModeRate > SUSPENSION_FEE) {
            rec.reason = `Suspended, no contract — cancel to save $${SUSPENSION_FEE.toFixed(2)}/mo suspension fee (plan-mode MRC at peer rate: $${planModeRate.toFixed(2)})`;
            rec.monthlySavings = SUSPENSION_FEE;
            rec.planModeMRC = planModeRate;
          } else {
            rec.reason = 'Already suspended, no contract — cancel to save $10/mo suspension fee';
            rec.monthlySavings = SUSPENSION_FEE;
          }
          rec.oneTimeCost = 0;
        } else if (p.remainingMonths <= 2) {
          rec.action = 'CANCEL SOON';
          rec.reason = `Suspended, contract ends in ${p.remainingMonths} months — cancel when complete`;
          rec.monthlySavings = SUSPENSION_FEE;
          rec.planModeMRC = planModeRate;
          rec.oneTimeCost = 0;
        } else {
          rec.action = 'KEEP SUSPENDED';
          rec.reason = `Keep suspended until contract ends (${p.remainingMonths} months)`;
          rec.monthlySavings = 0;
          rec.planModeMRC = planModeRate;
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
