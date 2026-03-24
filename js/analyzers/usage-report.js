/**
 * Usage Report Generator
 * Produces the full line inventory with usage data and device type breakdown.
 */

window.UsageReportAnalyzer = (function () {

  /**
   * Generate usage report from profiles
   * @param {Object} profiles - { wirelessNumber: profileObj }
   * @returns {Object} { lines, inventory, summary }
   */
  function analyze(profiles) {
    const lines = [];
    const inventory = { smartphones: 0, tablets: 0, hotspots: 0, watches: 0, other: 0, total: 0 };

    for (const [wn, p] of Object.entries(profiles)) {
      if (p.status === 'Cancelled') continue;

      const line = {
        wireless: wn,
        userName: p.userName,
        deviceType: p.deviceType || 'Unknown',
        ratePlan: p.ratePlan,
        ban: p.ban || '',
        costCenter: p.costCenter || '',

        // Usage
        gbTotal: p.gbTotal || 0,
        gbAvg: p.gbAvg || 0,
        minTotal: p.minTotal || p.totalMin90d || 0,
        minAvg: p.minAvg || 0,
        msgTotal: p.msgTotal || p.totalMsg90d || 0,
        msgAvg: p.msgAvg || 0,

        // Charges
        monthlyCharges: p.latestMonthly || 0,
        equipmentCharges: p.equipmentCharges || p.monthlyInstallment || 0,
        totalCharges: p.latestTotal || p.mrc || 0,
        taxes: p.latestTaxes || 0,
        fees: p.latestFees || 0,

        // Flags
        zeroUsage: p.zeroUsage,
        hasActiveContract: p.hasActiveContract,
        contractEnd: p.contractEnd || '',
      };

      lines.push(line);

      // Inventory count
      inventory.total++;
      const dt = (line.deviceType || '').toLowerCase();
      if (dt.includes('smartphone') || dt.includes('phone')) inventory.smartphones++;
      else if (dt.includes('tablet')) inventory.tablets++;
      else if (dt.includes('hotspot') || dt.includes('jetpack') || dt.includes('data device')) inventory.hotspots++;
      else if (dt.includes('watch') || dt.includes('wearable')) inventory.watches++;
      else inventory.other++;
    }

    // Sort by total charges descending
    lines.sort((a, b) => b.totalCharges - a.totalCharges);

    // Summary stats
    const summary = {
      totalLines: lines.length,
      totalMonthlyCharges: lines.reduce((s, l) => s + l.monthlyCharges, 0),
      totalCharges: lines.reduce((s, l) => s + l.totalCharges, 0),
      totalEquipment: lines.reduce((s, l) => s + l.equipmentCharges, 0),
      zeroUsageCount: lines.filter(l => l.zeroUsage).length,
      zeroUsagePercent: lines.length > 0 ? (lines.filter(l => l.zeroUsage).length / lines.length * 100) : 0,
      avgChargesPerLine: lines.length > 0 ? lines.reduce((s, l) => s + l.totalCharges, 0) / lines.length : 0,
    };

    return { lines, inventory, summary };
  }

  return { analyze };
})();
