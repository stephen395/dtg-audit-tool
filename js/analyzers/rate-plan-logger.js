/**
 * Rate Plan Logger
 * Logs every rate plan encountered across audits.
 * Stored in localStorage + pushed to n8n Data Table for centralized tracking.
 *
 * Captures: plan name, rate code, MRC, group discount info, line-count tier.
 * Upserts by plan_key (carrier::planName) so the same plan is updated, not duplicated.
 */

window.RatePlanLogger = (function () {
  const STORAGE_KEY = 'dtg_rateplan_log';
  const N8N_WEBHOOK = 'https://automation.dedicatedtelecom.com/webhook/rate-plan-receiver';

  function getLog() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch { return {}; }
  }

  function saveLog(log) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(log));
  }

  /**
   * Log rate plans from an audit run
   * @param {string} carrier - 'att' | 'verizon' | 'tmobile'
   * @param {string} clientName - client being audited
   * @param {Array} plans - from RatePlanAnalyzer.analyze().plans (now includes rateCode, groupDiscount, lineCountTier)
   */
  function logPlans(carrier, clientName, plans) {
    const log = getLog();
    const now = new Date().toISOString().split('T')[0];

    for (const plan of plans) {
      const key = `${carrier}::${plan.planName}`;
      const groupInfo = plan.groupDiscount || { detected: false, tier: 'none', discountType: 'none' };

      if (!log[key]) {
        log[key] = {
          carrier,
          planName: plan.planName,
          rateCode: plan.rateCode || '',
          rateCodes: plan.rateCodes || [],
          perLineMRC: plan.perLine || 0,
          avgMRC: plan.perLine || 0,
          groupDiscount: groupInfo.tier || 'none',
          groupDiscountDetected: groupInfo.detected || false,
          discountAmount: 0,
          lineCountTier: plan.lineCountTier || '',
          firstSeen: now,
          lastSeen: now,
          clients: [clientName],
          totalLinesSeen: plan.lineCount,
          occurrences: 1,
          history: [],
        };
      } else {
        // Normalize entries saved under an older schema so field access is safe.
        const entry = log[key];
        if (!Array.isArray(entry.clients)) entry.clients = [];
        if (!Array.isArray(entry.rateCodes)) entry.rateCodes = entry.rateCode ? [entry.rateCode] : [];
        if (!Array.isArray(entry.history)) entry.history = [];
        if (typeof entry.totalLinesSeen !== 'number') entry.totalLinesSeen = 0;
        if (typeof entry.avgMRC !== 'number') entry.avgMRC = 0;
        if (typeof entry.perLineMRC !== 'number') entry.perLineMRC = entry.avgMRC || 0;
        if (typeof entry.occurrences !== 'number') entry.occurrences = 0;
        if (typeof entry.rateCode !== 'string') entry.rateCode = '';
        if (typeof entry.groupDiscount !== 'string') entry.groupDiscount = 'none';
        if (typeof entry.lineCountTier !== 'string') entry.lineCountTier = '';

        entry.lastSeen = now;
        if (!entry.clients.includes(clientName)) {
          entry.clients.push(clientName);
        }
        entry.totalLinesSeen += plan.lineCount;
        entry.avgMRC = ((entry.avgMRC * entry.occurrences) + plan.perLine) / (entry.occurrences + 1);
        entry.perLineMRC = plan.perLine || entry.perLineMRC;
        entry.occurrences++;

        // Update rate code if we got a new one
        if (plan.rateCode && !entry.rateCodes.includes(plan.rateCode)) {
          entry.rateCodes.push(plan.rateCode);
        }
        if (plan.rateCode) entry.rateCode = plan.rateCode;

        // Update group discount info
        if (groupInfo.detected) {
          entry.groupDiscount = groupInfo.tier || entry.groupDiscount;
          entry.groupDiscountDetected = true;
        }
        entry.lineCountTier = plan.lineCountTier || entry.lineCountTier;
      }

      // Add history entry
      log[key].history.push({
        date: now,
        client: clientName,
        lineCount: plan.lineCount,
        perLine: plan.perLine,
        totalMonthly: plan.totalMonthly,
        rateCode: plan.rateCode || '',
        zeroUsagePercent: plan.zeroUsagePercent,
        lineCountTier: plan.lineCountTier || '',
      });

      // Cap history at 100 entries per plan
      if (log[key].history.length > 100) {
        log[key].history = log[key].history.slice(-100);
      }
    }

    saveLog(log);
    return log;
  }

  /**
   * Push all logged plans to n8n Data Table via webhook
   * @param {string} carrier - optional filter by carrier
   * @returns {Promise<{success: boolean, count: number, error?: string}>}
   */
  async function pushToN8N(carrier) {
    const plans = carrier ? getPlansByCarrier(carrier) : getAllPlans();
    if (plans.length === 0) {
      return { success: true, count: 0, message: 'No plans to push' };
    }

    // Transform to n8n schema
    const payload = plans.map(p => ({
      plan_key: `${p.carrier}::${p.planName}`,
      carrier: p.carrier,
      plan_name: p.planName,
      rate_code: p.rateCode || (p.rateCodes && p.rateCodes[0]) || '',
      per_line_mrc: Math.round((p.perLineMRC || p.avgMRC || 0) * 100) / 100,
      avg_mrc: Math.round((p.avgMRC || 0) * 100) / 100,
      group_discount: p.groupDiscount || 'none',
      discount_amount: p.discountAmount || 0,
      line_count_tier: p.lineCountTier || '',
      total_lines_seen: p.totalLinesSeen || 0,
      clients_seen: (p.clients || []).join(', '),
      occurrences: p.occurrences || 1,
      first_seen: p.firstSeen || '',
      last_seen: p.lastSeen || '',
    }));

    try {
      const resp = await fetch(N8N_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plans: payload }),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`n8n responded ${resp.status}: ${text}`);
      }

      console.log(`[RATEPLAN-LOGGER] Pushed ${payload.length} plans to n8n`);
      return { success: true, count: payload.length };
    } catch (err) {
      console.error('[RATEPLAN-LOGGER] n8n push failed:', err.message);
      return { success: false, count: 0, error: err.message };
    }
  }

  /**
   * Push plans from the current audit only (not the full log)
   * @param {string} carrier
   * @param {string} clientName
   * @param {Array} plans - from RatePlanAnalyzer
   */
  async function pushAuditPlans(carrier, clientName, plans) {
    if (!plans || plans.length === 0) return { success: true, count: 0 };

    const now = new Date().toISOString().split('T')[0];
    const log = getLog();

    const payload = plans.map(plan => {
      const key = `${carrier}::${plan.planName}`;
      const existing = log[key] || {};
      const groupInfo = plan.groupDiscount || { detected: false, tier: 'none' };

      return {
        plan_key: key,
        carrier,
        plan_name: plan.planName,
        rate_code: plan.rateCode || '',
        per_line_mrc: Math.round((plan.perLine || 0) * 100) / 100,
        avg_mrc: Math.round((existing.avgMRC || plan.perLine || 0) * 100) / 100,
        group_discount: groupInfo.tier || 'none',
        discount_amount: 0,
        line_count_tier: plan.lineCountTier || '',
        total_lines_seen: (existing.totalLinesSeen || 0) + plan.lineCount,
        clients_seen: existing.clients ? [...new Set([...existing.clients, clientName])].join(', ') : clientName,
        occurrences: (existing.occurrences || 0) + 1,
        first_seen: existing.firstSeen || now,
        last_seen: now,
      };
    });

    try {
      const resp = await fetch(N8N_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plans: payload }),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`n8n responded ${resp.status}: ${text}`);
      }

      console.log(`[RATEPLAN-LOGGER] Pushed ${payload.length} audit plans to n8n for ${clientName}`);
      return { success: true, count: payload.length };
    } catch (err) {
      console.error('[RATEPLAN-LOGGER] n8n audit push failed:', err.message);
      return { success: false, count: 0, error: err.message };
    }
  }

  /**
   * Get all logged plans as sorted array
   */
  function getAllPlans() {
    const log = getLog();
    return Object.values(log).sort((a, b) => b.totalLinesSeen - a.totalLinesSeen);
  }

  /**
   * Get plans by carrier
   */
  function getPlansByCarrier(carrier) {
    return getAllPlans().filter(p => p.carrier === carrier);
  }

  /**
   * Export log as CSV string
   */
  function exportCSV() {
    const plans = getAllPlans();
    if (plans.length === 0) return 'No data';

    const headers = ['Carrier', 'Plan Name', 'Rate Code', 'Per-Line MRC', 'Avg MRC', 'Group Discount', 'Line Count Tier', 'First Seen', 'Last Seen', 'Clients', 'Total Lines Seen', 'Occurrences'];
    const rows = plans.map(p => [
      p.carrier,
      `"${p.planName}"`,
      p.rateCode || '',
      (p.perLineMRC || p.avgMRC || 0).toFixed(2),
      (p.avgMRC || 0).toFixed(2),
      p.groupDiscount || 'none',
      p.lineCountTier || '',
      p.firstSeen,
      p.lastSeen,
      `"${(p.clients || []).join(', ')}"`,
      p.totalLinesSeen,
      p.occurrences,
    ]);

    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }

  /**
   * Export log as JSON string
   */
  function exportJSON() {
    return JSON.stringify(getAllPlans(), null, 2);
  }

  /**
   * Clear the entire log
   */
  function clearLog() {
    localStorage.removeItem(STORAGE_KEY);
  }

  /**
   * Get stats about the log
   */
  function getStats() {
    const plans = getAllPlans();
    return {
      totalPlans: plans.length,
      carriers: [...new Set(plans.map(p => p.carrier))],
      clients: [...new Set(plans.flatMap(p => p.clients || []))],
      totalLinesSeen: plans.reduce((s, p) => s + p.totalLinesSeen, 0),
      groupDiscountPlans: plans.filter(p => p.groupDiscountDetected || (p.groupDiscount && p.groupDiscount !== 'none')).length,
      oldestEntry: plans.length > 0 ? plans.reduce((m, p) => p.firstSeen < m ? p.firstSeen : m, plans[0].firstSeen) : null,
      newestEntry: plans.length > 0 ? plans.reduce((m, p) => p.lastSeen > m ? p.lastSeen : m, plans[0].lastSeen) : null,
    };
  }

  return {
    logPlans,
    pushToN8N,
    pushAuditPlans,
    getAllPlans,
    getPlansByCarrier,
    exportCSV,
    exportJSON,
    clearLog,
    getStats,
  };
})();
