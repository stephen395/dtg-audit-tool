/**
 * Rate Plan Analyzer
 * Aggregates lines by rate plan, calculates per-plan metrics,
 * detects group discounts, and captures rate codes.
 */

window.RatePlanAnalyzer = (function () {

  // AT&T group discount patterns — plan names that indicate line-count tiers
  const GROUP_DISCOUNT_PATTERNS = [
    { pattern: /1-3\s*lines?/i, tier: '1-3 Lines' },
    { pattern: /1-4\s*lines?/i, tier: '1-4 Lines' },
    { pattern: /4\+?\s*lines?/i, tier: '4+ Lines' },
    { pattern: /5\+?\s*lines?/i, tier: '5+ Lines' },
    { pattern: /10\+?\s*lines?/i, tier: '10+ Lines' },
    { pattern: /\b(\d+)\s*-\s*(\d+)\s*lines?\b/i, tier: null }, // dynamic: "X-Y Lines"
    { pattern: /\b(\d+)\+\s*lines?\b/i, tier: null }, // dynamic: "N+ Lines"
    { pattern: /group\s*discount/i, tier: 'Group Discount' },
    { pattern: /multi-?line/i, tier: 'Multi-Line' },
    { pattern: /business\s+unlimited.*?-\s*(.+)/i, tier: null }, // capture tier suffix
  ];

  /**
   * Detect group discount tier from a plan name
   * @returns {{ detected: boolean, tier: string, discountType: string }}
   */
  function detectGroupDiscount(planName) {
    if (!planName) return { detected: false, tier: 'none', discountType: 'none' };

    const name = planName.trim();

    // Check for explicit line-count patterns
    for (const gd of GROUP_DISCOUNT_PATTERNS) {
      const match = name.match(gd.pattern);
      if (match) {
        let tier = gd.tier;
        if (!tier && match[1] && match[2]) {
          tier = `${match[1]}-${match[2]} Lines`;
        } else if (!tier && match[1]) {
          tier = `${match[1]}+ Lines`;
        } else if (!tier && match.length > 1) {
          tier = match[1] || 'Group';
        }
        return { detected: true, tier: tier || 'Group', discountType: 'line-count' };
      }
    }

    // Check for AT&T plan tier suffixes that imply group pricing
    // e.g., "Business Unlimited Performance" vs "Business Unlimited Performance - 5+ Lines"
    if (/unlimited/i.test(name)) {
      if (/starter|performance|elite|premium|advanced/i.test(name)) {
        // Has a tier keyword but no explicit line count — might be single-line rate
        return { detected: false, tier: 'standard', discountType: 'none' };
      }
    }

    return { detected: false, tier: 'none', discountType: 'none' };
  }

  /**
   * Extract the line-count tier bucket from actual line count
   */
  function getLineCountTier(lineCount) {
    if (lineCount >= 10) return '10+ Lines';
    if (lineCount >= 5) return '5+ Lines';
    if (lineCount >= 4) return '4+ Lines';
    if (lineCount >= 1) return '1-3 Lines';
    return 'Unknown';
  }

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
        const groupInfo = detectGroupDiscount(planName);
        planMap[planName] = {
          planName,
          rateCode: '',
          rateCodes: new Set(),
          lineCount: 0,
          totalMonthly: 0,
          zeroUsageLines: 0,
          lines: [],
          totalGB: 0,
          totalMin: 0,
          totalMsg: 0,
          groupDiscount: groupInfo,
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

      // Capture rate code
      const code = p.rateCode || p.rate_code || '';
      if (code) plan.rateCodes.add(code);
    }

    // Convert to array and calculate per-line metrics
    const plans = Object.values(planMap).map(plan => {
      const rateCodes = [...plan.rateCodes];
      return {
        planName: plan.planName,
        rateCode: rateCodes[0] || '',
        rateCodes: rateCodes,
        lineCount: plan.lineCount,
        totalMonthly: plan.totalMonthly,
        perLine: plan.lineCount > 0 ? plan.totalMonthly / plan.lineCount : 0,
        zeroUsageLines: plan.zeroUsageLines,
        zeroUsagePercent: plan.lineCount > 0 ? (plan.zeroUsageLines / plan.lineCount) * 100 : 0,
        avgGB: plan.lineCount > 0 ? plan.totalGB / plan.lineCount : 0,
        avgMin: plan.lineCount > 0 ? plan.totalMin / plan.lineCount : 0,
        lines: plan.lines,
        totalGB: plan.totalGB,
        totalMin: plan.totalMin,
        totalMsg: plan.totalMsg,
        groupDiscount: plan.groupDiscount,
        lineCountTier: getLineCountTier(plan.lineCount),
      };
    });

    // Sort by line count descending
    plans.sort((a, b) => b.lineCount - a.lineCount);

    const summary = {
      uniquePlans: plans.length,
      totalLines: plans.reduce((s, p) => s + p.lineCount, 0),
      totalMonthly: plans.reduce((s, p) => s + p.totalMonthly, 0),
      highZeroUsagePlans: plans.filter(p => p.zeroUsagePercent > 30).length,
      groupDiscountPlans: plans.filter(p => p.groupDiscount.detected).length,
    };

    return { plans, summary };
  }

  return { analyze, detectGroupDiscount, getLineCountTier };
})();
