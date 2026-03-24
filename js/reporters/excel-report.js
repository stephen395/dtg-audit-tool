/**
 * Excel Report Generator
 * Creates a 4-sheet workbook using SheetJS (xlsx).
 * Sheets: Zero Usage, Device Payments, All Lines, Rate Plan Summary
 * Formatting matches the billread skill's Line-Level Detail Excel spec.
 */

window.ExcelReporter = (function () {

  function fmtMoney(val) {
    return val != null ? val.toFixed(2) : '0.00';
  }

  /**
   * Generate the full Excel workbook
   * @param {Object} data - { carrier, clientName, billingPeriod, zeroUsageResults, usageReport, ratePlans, profiles }
   * @returns {XLSX.WorkBook}
   */
  function generate(data) {
    const { carrier, clientName, billingPeriod, zeroUsageResults, usageReport, ratePlans, profiles } = data;
    const wb = XLSX.utils.book_new();
    const carrierName = { att: 'AT&T', verizon: 'Verizon', tmobile: 'T-Mobile' }[carrier] || carrier;

    // ── Sheet 1: Zero Usage & Recommendations ──
    const zuHeaders = [
      'Wireless Number', 'User Name', 'Device Type', 'Rate Plan',
      '90-Day GB Total', '90-Day GB Avg', '90-Day Min Total', '90-Day Min Avg',
      '90-Day Msg Total', '90-Day Msg Avg', 'MRC (3-Mo Avg)', 'Contract End',
      'Action', 'Reason', 'Monthly Savings', 'One-Time Cost'
    ];

    const zuData = zeroUsageResults.map(r => [
      r.wireless,
      r.userName,
      r.deviceType || '',
      r.ratePlan || '',
      (r.gbTotal || 0).toFixed(3),
      (r.gbAvg || 0).toFixed(3),
      r.minTotal || r.totalMin90d || 0,
      (r.minAvg || 0).toFixed(1),
      r.msgTotal || r.totalMsg90d || 0,
      (r.msgAvg || 0).toFixed(1),
      fmtMoney(r.mrc || 0),
      r.contractEnd || '',
      r.action,
      r.reason,
      fmtMoney(r.monthlySavings || 0),
      fmtMoney(r.oneTimeCost || 0),
    ]);

    // Add savings summary row at top
    const totalSavings = zeroUsageResults.reduce((s, r) => s + (r.monthlySavings || 0), 0);
    const zuTitle = [
      [`${carrierName} Zero Usage & Recommendations — ${clientName}`],
      [`Cancelling out-of-contract lines could save → $${totalSavings.toFixed(2)}/month`],
      [],
    ];

    const zuSheet = XLSX.utils.aoa_to_sheet([...zuTitle, zuHeaders, ...zuData]);

    // Add total row
    XLSX.utils.sheet_add_aoa(zuSheet, [[
      'TOTAL', '', '', '', '', '', '', '', '', '',
      fmtMoney(zeroUsageResults.reduce((s, r) => s + (r.mrc || 0), 0)),
      '', '', '',
      fmtMoney(totalSavings),
      fmtMoney(zeroUsageResults.reduce((s, r) => s + (r.oneTimeCost || 0), 0)),
    ]], { origin: -1 });

    // Column widths
    zuSheet['!cols'] = [
      { wch: 15 }, { wch: 20 }, { wch: 14 }, { wch: 35 },
      { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
      { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 12 },
      { wch: 16 }, { wch: 45 }, { wch: 14 }, { wch: 14 },
    ];

    XLSX.utils.book_append_sheet(wb, zuSheet, 'Zero Usage');

    // ── Sheet 2: Device Payments ──
    const dpHeaders = [
      'Wireless Number', 'User Name', 'Device Type', 'Rate Plan',
      'DPA Payment', 'Promo Credit', 'Net Equipment',
      'Payment Progress', 'Remaining Mo.', 'Has Promo?', 'Contract End'
    ];

    const dpaLines = Object.values(profiles).filter(p => p.hasActiveContract && p.monthlyInstallment > 0);
    const dpData = dpaLines.map(p => [
      p.wireless,
      p.userName,
      p.deviceType || '',
      p.ratePlan || '',
      fmtMoney(p.monthlyInstallment || 0),
      fmtMoney(p.promoCredit || 0),
      fmtMoney((p.monthlyInstallment || 0) + (p.promoCredit || 0)),
      p.dpaProgress || '',
      p.remainingMonths || '',
      (p.promoCredit && p.promoCredit < 0) ? 'Yes' : 'No',
      p.contractEnd || '',
    ]);

    const dpTitle = [
      [`${carrierName} Device Payments — ${clientName}`],
      [`DPA Lines: ${dpaLines.length} | Billing Period: ${billingPeriod || 'N/A'}`],
      [],
    ];

    const dpSheet = XLSX.utils.aoa_to_sheet([...dpTitle, dpHeaders, ...dpData]);
    dpSheet['!cols'] = [
      { wch: 15 }, { wch: 20 }, { wch: 14 }, { wch: 35 },
      { wch: 14 }, { wch: 14 }, { wch: 14 },
      { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
    ];

    XLSX.utils.book_append_sheet(wb, dpSheet, 'Device Payments');

    // ── Sheet 3: All Lines ──
    const allHeaders = [
      'Wireless Number', 'User Name', 'Device Type', 'Rate Plan',
      'Monthly Charges', 'Equipment Charges', 'Total Charges',
      'Voice (min)', 'Data (GB)', 'Messages',
      'Zero Usage?', 'Has DPA?', 'Recommendation'
    ];

    const allData = usageReport.lines.map(l => {
      const zu = zeroUsageResults.find(r => r.wireless === l.wireless);
      return [
        l.wireless,
        l.userName,
        l.deviceType || '',
        l.ratePlan || '',
        fmtMoney(l.monthlyCharges),
        fmtMoney(l.equipmentCharges),
        fmtMoney(l.totalCharges),
        l.minTotal || 0,
        (l.gbTotal || 0).toFixed(3),
        l.msgTotal || 0,
        l.zeroUsage ? 'Yes' : '',
        l.hasActiveContract ? 'Yes' : '',
        zu ? zu.action : '',
      ];
    });

    const allTitle = [
      [`${carrierName} All Lines Inventory — ${clientName} — ${billingPeriod || 'Current'}`],
      [],
    ];

    const allSheet = XLSX.utils.aoa_to_sheet([...allTitle, allHeaders, ...allData]);

    // Total row
    XLSX.utils.sheet_add_aoa(allSheet, [[
      'TOTAL', `${usageReport.lines.length} lines`, '', '',
      fmtMoney(usageReport.summary.totalMonthlyCharges),
      fmtMoney(usageReport.summary.totalEquipment),
      fmtMoney(usageReport.summary.totalCharges),
      '', '', '', '', '', '',
    ]], { origin: -1 });

    allSheet['!cols'] = [
      { wch: 15 }, { wch: 20 }, { wch: 14 }, { wch: 35 },
      { wch: 14 }, { wch: 16 }, { wch: 14 },
      { wch: 12 }, { wch: 10 }, { wch: 10 },
      { wch: 12 }, { wch: 10 }, { wch: 16 },
    ];

    XLSX.utils.book_append_sheet(wb, allSheet, 'All Lines');

    // ── Sheet 4: Rate Plan Summary ──
    const rpHeaders = [
      'Rate Plan', '# Lines', 'Total Monthly', 'Per Line',
      'Zero Usage Lines', '% Zero Usage'
    ];

    const rpData = ratePlans.plans.map(p => [
      p.planName,
      p.lineCount,
      fmtMoney(p.totalMonthly),
      fmtMoney(p.perLine),
      p.zeroUsageLines,
      p.zeroUsagePercent.toFixed(0) + '%',
    ]);

    // Total row
    rpData.push([
      'TOTAL',
      ratePlans.summary.totalLines,
      fmtMoney(ratePlans.summary.totalMonthly),
      fmtMoney(ratePlans.summary.totalMonthly / Math.max(ratePlans.summary.totalLines, 1)),
      '',
      '',
    ]);

    const rpTitle = [
      [`${carrierName} Rate Plan Summary — ${clientName}`],
      [],
    ];

    const rpSheet = XLSX.utils.aoa_to_sheet([...rpTitle, rpHeaders, ...rpData]);
    rpSheet['!cols'] = [
      { wch: 45 }, { wch: 10 }, { wch: 16 }, { wch: 12 },
      { wch: 14 }, { wch: 12 },
    ];

    XLSX.utils.book_append_sheet(wb, rpSheet, 'Rate Plan Summary');

    return wb;
  }

  /**
   * Generate and trigger download
   */
  function download(data) {
    const wb = generate(data);
    const carrier = { att: 'ATT', verizon: 'VZW', tmobile: 'TMO' }[data.carrier] || data.carrier.toUpperCase();
    const date = new Date().toISOString().split('T')[0];
    const filename = `${carrier}_Audit_LineDetail_${data.clientName.replace(/\s+/g, '_')}_${date}.xlsx`;
    XLSX.writeFile(wb, filename);
  }

  return { generate, download };
})();
