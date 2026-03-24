/**
 * Rate Plan Analyzer
 * Aggregates lines by rate plan, calculates per-plan metrics,
 * and identifies high zero-usage plans.
 */

window.RatePlanAnalyzer = (function () {

  /**
   * Analyze rate plans from profiles
   * @param {Object} profiles - { wirelessNumber: profileObj }
   * @returns {Object} { plans, summary }
   */
  function analyze(profiles) {
    const planMap = {};

    for (const [wn, p] of Object.entries(profiles)) {
      if (p.status === 'Cancelled') continue;

      const planName = p.ratePlan || 'Unknown';
      if (!planMap[planName]) {
        planMap[planName] = {
          planName,
          lineCount: 0,
          totalMonthly: 0,
          zeroUsageLines: 0,
          lines: [],
          totalGB: 0,
          totalMin: 0,
          totalMsg: 0,
        };
      }

      const plan = planMap[planName];
      plan.lineCount++;
      plan.totalMonthly += p.latestMonthly || p.mrc || 0;
      plan.totalGB += p.gbTotal || 0;
      plan.totalMin += p.minTotal || p.totalMin90d || 0;
      plan.totalMsg += p.msgTotal || p.totalMsg90d || 0;
      if (p.zeroUsage) plan.zeroUsageLines++;
      plan.lines.push(wn);
    }

    // Convert to array and calculate per-line metrics
    const plans = Object.values(planMap).map(plan => ({
      ...plan,
      perLine: plan.lineCount > 0 ? plan.totalMonthly / plan.lineCount : 0,
      zeroUsagePercent: plan.lineCount > 0 ? (plan.zeroUsageLines / plan.lineCount) * 100 : 0,
      avgGB: plan.lineCount > 0 ? plan.totalGB / plan.lineCount : 0,
      avgMin: plan.lineCount > 0 ? plan.totalMin / plan.lineCount : 0,
    }));

    // Sort by line count descending
    plans.sort((a, b) => b.lineCount - a.lineCount);

    const summary = {
      uniquePlans: plans.length,
      totalLines: plans.reduce((s, p) => s + p.lineCount, 0),
      totalMonthly: plans.reduce((s, p) => s + p.totalMonthly, 0),
      highZeroUsagePlans: plans.filter(p => p.zeroUsagePercent > 30).length,
    };

    return { plans, summary };
  }

  return { analyze };
})();
