/**
 * Usage Report Generator
 * Produces the full line inventory with usage data and device type breakdown.
 * Works with both CSV-parsed profiles and PDF-parsed profiles.
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
      // Cancelled lines drop off the roster. Suspended lines stay on it —
      // they're still billed (often a $10/mo suspension fee) and the user
      // wants to see them flagged so they can decide cancel vs reactivate.
      if (p.status === 'Cancelled') continue;

      // Normalize field names — CSV uses latestMonthly, PDF uses mrc
      const mrc = p.mrc || p.latestMonthly || p.monthlyCharges || 0;
      const equipCharge = p.equipment || p.equipmentCharges || p.monthlyInstallment || p.equipmentCharge || 0;
      const totalCharges = p.totalCharges || p.latestTotal || 0;
      const taxes = p.taxes || p.latestTaxes || 0;
      const fees = p.fees || p.latestFees || 0;

      const line = {
        wireless: wn,
        userName: p.userName || 'Unknown',
        // Carry the carrier-reported status through so the Usage Report tab
        // can render an "Active" / "Suspended" badge on each row.
        status: p.status || 'Active',
        deviceType: p.deviceType || 'Unknown',
        ratePlan: p.ratePlan || '',
        ban: p.ban || '',
        costCenter: p.costCenter || '',

        // Usage
        gbTotal: p.gbTotal || 0,
        gbAvg: p.gbAvg || 0,
        minTotal: p.minTotal || p.totalMin90d || 0,
        minAvg: p.minAvg || 0,
        msgTotal: p.msgTotal || p.totalMsg90d || 0,
        msgAvg: p.msgAvg || 0,

        // Charges — normalized
        mrc: mrc,
        monthlyCharges: mrc,
        equipmentCharges: equipCharge,
        totalCharges: totalCharges,
        taxes: taxes,
        fees: fees,
        activityCharges: p.activityCharges || 0,
        oneTimeCharges: p.oneTimeCharges || [],

        // Equipment details (from PDF)
        equipmentName: p.equipmentName || '',
        equipmentInstallment: p.equipmentInstallment || '',
        equipmentFinanced: p.equipmentFinanced || 0,
        equipmentRemaining: p.equipmentRemaining || 0,
        equipmentEstablished: p.equipmentEstablished || '',

        // Flags
        zeroUsage: p.zeroUsage,
        hasActiveContract: p.hasActiveContract,
        contractEnd: p.contractEnd || p.contractEndDate || '',
        contractType: p.contractType || '',
      };

      lines.push(line);

      // Inventory count
      inventory.total++;
      const dt = (line.deviceType || '').toLowerCase();
      if (dt.includes('smartphone') || dt.includes('phone')) inventory.smartphones++;
      else if (dt.includes('tablet')) inventory.tablets++;
      else if (dt.includes('hotspot') || dt.includes('jetpack') || dt.includes('data device') || dt.includes('connected device') || dt.includes('broadband') || dt.includes('mifi')) inventory.hotspots++;
      else if (dt.includes('watch') || dt.includes('wearable')) inventory.watches++;
      else inventory.other++;
    }

    // Sort by data usage descending (highest usage at top, zero usage at bottom)
    lines.sort((a, b) => {
      const usageA = a.gbTotal + (a.minTotal || 0) / 1000 + (a.msgTotal || 0) / 1000;
      const usageB = b.gbTotal + (b.minTotal || 0) / 1000 + (b.msgTotal || 0) / 1000;
      return usageB - usageA;
    });

    // Summary stats
    const totalMRC = lines.reduce((s, l) => s + l.mrc, 0);
    const totalEquip = lines.reduce((s, l) => s + l.equipmentCharges, 0);
    const totalChargesAll = lines.reduce((s, l) => s + l.totalCharges, 0);
    const upgradeEligible = lines.filter(l => !l.hasActiveContract && (l.deviceType || '').toLowerCase().includes('phone')).length;
    const inContract = lines.filter(l => l.hasActiveContract).length;

    // ── Bill breakdown — sums the LATEST billing cycle values across all
    // profiles. Adding plan + activity + surcharges + taxes reproduces the
    // carrier's "Current Charges" total so "Total Monthly Spend" on the
    // dashboard matches what the client actually pays this month.
    const allProfiles = Object.values(profiles);
    const billPlan       = allProfiles.reduce((s, p) => s + (p.latestMonthly || 0), 0);
    const billActivity   = allProfiles.reduce((s, p) => s + (p.latestActivity || 0), 0);
    const billSurcharges = allProfiles.reduce((s, p) => s + (p.latestFees || 0), 0);
    const billTaxes      = allProfiles.reduce((s, p) => s + (p.latestTaxes || 0), 0);
    const billTotal      = allProfiles.reduce((s, p) => s + (p.latestTotal || 0), 0);
    // Equipment installments come from the contract file (not the bill CSV),
    // so we still surface them separately for the device-payments panel.
    const billEquipment  = allProfiles.reduce((s, p) => s + (p.monthlyInstallment || 0), 0);

    const suspendedCount = lines.filter(l => (l.status || '').toLowerCase() === 'suspended').length;
    const activeCount    = lines.length - suspendedCount;

    const summary = {
      totalLines: lines.length,
      activeCount,
      suspendedCount,
      totalMRC: totalMRC,
      totalMonthlyCharges: totalMRC,
      totalCharges: totalChargesAll,
      totalEquipment: totalEquip,
      zeroUsageCount: lines.filter(l => l.zeroUsage).length,
      zeroUsagePercent: lines.length > 0 ? (lines.filter(l => l.zeroUsage).length / lines.length * 100) : 0,
      avgChargesPerLine: lines.length > 0 ? totalMRC / lines.length : 0,
      upgradeEligible: upgradeEligible,
      inContract: inContract,
      outOfContract: lines.length - inContract,
      // Actual bill breakdown (latest billing cycle — matches client's current bill)
      billTotal,
      billPlan,
      billEquipment,
      billActivity,
      billSurcharges,
      billTaxes,
      avgBillPerLine: lines.length > 0 ? billTotal / lines.length : 0,
    };

    return { lines, inventory, summary };
  }

  return { analyze };
})();
