/**
 * Rate Plan Logger
 * Logs every rate plan encountered across audits for data gathering.
 * Stored in localStorage, exportable as JSON/CSV.
 * Foundation for future plan suggestion engine.
 */

window.RatePlanLogger = (function () {
  const STORAGE_KEY = 'dtg_rateplan_log';

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
   * @param {Array} plans - from RatePlanAnalyzer.analyze().plans
   */
  function logPlans(carrier, clientName, plans) {
    const log = getLog();
    const now = new Date().toISOString().split('T')[0];

    for (const plan of plans) {
      const key = `${carrier}::${plan.planName}`;

      if (!log[key]) {
        log[key] = {
          carrier,
          planName: plan.planName,
          firstSeen: now,
          lastSeen: now,
          clients: [clientName],
          totalLinesSeen: plan.lineCount,
          avgMRC: plan.perLine,
          occurrences: 1,
          history: [],
        };
      } else {
        log[key].lastSeen = now;
        if (!log[key].clients.includes(clientName)) {
          log[key].clients.push(clientName);
        }
        log[key].totalLinesSeen += plan.lineCount;
        log[key].avgMRC = ((log[key].avgMRC * log[key].occurrences) + plan.perLine) / (log[key].occurrences + 1);
        log[key].occurrences++;
      }

      // Add history entry
      log[key].history.push({
        date: now,
        client: clientName,
        lineCount: plan.lineCount,
        perLine: plan.perLine,
        totalMonthly: plan.totalMonthly,
        zeroUsagePercent: plan.zeroUsagePercent,
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

    const headers = ['Carrier', 'Plan Name', 'First Seen', 'Last Seen', 'Clients', 'Total Lines Seen', 'Avg MRC', 'Occurrences'];
    const rows = plans.map(p => [
      p.carrier,
      `"${p.planName}"`,
      p.firstSeen,
      p.lastSeen,
      `"${p.clients.join(', ')}"`,
      p.totalLinesSeen,
      p.avgMRC.toFixed(2),
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
      clients: [...new Set(plans.flatMap(p => p.clients))],
      totalLinesSeen: plans.reduce((s, p) => s + p.totalLinesSeen, 0),
      oldestEntry: plans.length > 0 ? plans.reduce((m, p) => p.firstSeen < m ? p.firstSeen : m, plans[0].firstSeen) : null,
      newestEntry: plans.length > 0 ? plans.reduce((m, p) => p.lastSeen > m ? p.lastSeen : m, plans[0].lastSeen) : null,
    };
  }

  return {
    logPlans,
    getAllPlans,
    getPlansByCarrier,
    exportCSV,
    exportJSON,
    clearLog,
    getStats,
  };
})();
