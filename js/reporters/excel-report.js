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
    const { carrier, clientName, billingPeriod, zeroUsageResults, usageReport, ratePlans, profiles, planComparison, planComparisonSummary, allMeta, meta } = data;
    const wb = XLSX.utils.book_new();
    const carrierName = { att: 'AT&T', verizon: 'Verizon', tmobile: 'T-Mobile' }[carrier] || carrier;
    // Prefer the unfiltered allMeta when present (multi-BAN audits) so the
    // "By BAN" sheet always lists every active sub-account, not just whichever
    // one the dashboard happened to be filtered to at export time.
    const reportMeta = allMeta || meta || {};

    // ── Sheet 1: Zero Usage & Recommendations ──
    const zuHeaders = [
      'Wireless Number', 'Account #', 'User Name', 'Device Type', 'Rate Plan',
      '90-Day GB Total', '90-Day GB Avg', '90-Day Min Total', '90-Day Min Avg',
      '90-Day Msg Total', '90-Day Msg Avg', 'MRC', 'Contract End',
      'Action', 'Reason', 'Monthly Savings', 'One-Time Cost'
    ];

    const zuData = zeroUsageResults.map(r => [
      r.wireless,
      r.ban || '',
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
      'TOTAL', '', '', '', '', '', '', '', '', '', '',
      fmtMoney(zeroUsageResults.reduce((s, r) => s + (r.mrc || 0), 0)),
      '', '', '',
      fmtMoney(totalSavings),
      fmtMoney(zeroUsageResults.reduce((s, r) => s + (r.oneTimeCost || 0), 0)),
    ]], { origin: -1 });

    // Column widths
    zuSheet['!cols'] = [
      { wch: 15 }, { wch: 22 }, { wch: 20 }, { wch: 14 }, { wch: 35 },
      { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
      { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 12 },
      { wch: 16 }, { wch: 45 }, { wch: 14 }, { wch: 14 },
    ];

    XLSX.utils.book_append_sheet(wb, zuSheet, 'Zero Usage');

    // ── Sheet 1.5: By BAN (only if multi-account) ─────────────────────────
    // Per-sub-account snapshot for multi-BAN audits. For single-BAN clients
    // we skip this sheet — it would just be a one-row table.
    const byBan = (reportMeta && reportMeta.byBan) || {};
    const activeBans = (reportMeta && reportMeta.activeBans) || Object.keys(byBan);
    if (activeBans.length > 1) {
      const banHeaders = [
        'Account #', 'Bill Name', 'Lines (latest)', 'Latest Bill',
        'Plan Charges', 'Equipment', 'Surcharges', 'Taxes',
        '90-day Spend', 'Zero-Usage Lines',
      ];
      const banRows = activeBans
        .filter(b => byBan[b])
        .sort((a, b) => (byBan[b].billLatest || 0) - (byBan[a].billLatest || 0))
        .map(b => {
          const i = byBan[b];
          return [
            b,
            i.billName || '',
            i.latestLineCount || 0,
            fmtMoney(i.billLatest || 0),
            fmtMoney(i.billLatestPlan || 0),
            fmtMoney(i.billLatestEquipment || 0),
            fmtMoney(i.billLatestFees || 0),
            fmtMoney(i.billLatestTaxes || 0),
            fmtMoney(i.totalSpend90d || 0),
            i.zeroUsageCount || 0,
          ];
        });
      const banTotals = [
        'TOTAL', '',
        banRows.reduce((s, r) => s + (Number(r[2]) || 0), 0),
        fmtMoney(activeBans.reduce((s, b) => s + ((byBan[b] && byBan[b].billLatest) || 0), 0)),
        fmtMoney(activeBans.reduce((s, b) => s + ((byBan[b] && byBan[b].billLatestPlan) || 0), 0)),
        fmtMoney(activeBans.reduce((s, b) => s + ((byBan[b] && byBan[b].billLatestEquipment) || 0), 0)),
        fmtMoney(activeBans.reduce((s, b) => s + ((byBan[b] && byBan[b].billLatestFees) || 0), 0)),
        fmtMoney(activeBans.reduce((s, b) => s + ((byBan[b] && byBan[b].billLatestTaxes) || 0), 0)),
        fmtMoney(activeBans.reduce((s, b) => s + ((byBan[b] && byBan[b].totalSpend90d) || 0), 0)),
        banRows.reduce((s, r) => s + (Number(r[9]) || 0), 0),
      ];
      const banTitle = [
        [`${carrierName} By Sub-Account (BAN) — ${clientName}`],
        [`${activeBans.length} active BANs (dormant sub-accounts excluded)`],
        [],
      ];
      const banSheet = XLSX.utils.aoa_to_sheet([...banTitle, banHeaders, ...banRows, banTotals]);
      banSheet['!cols'] = [
        { wch: 22 }, { wch: 28 }, { wch: 14 }, { wch: 14 },
        { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 },
        { wch: 14 }, { wch: 16 },
      ];
      XLSX.utils.book_append_sheet(wb, banSheet, 'By BAN');
    }

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
      'Rate Plan', 'Rate Code', '# Lines', 'Per Line', 'Total Monthly',
      'Group Discount', 'Line Count Tier', 'Zero Usage Lines', '% Zero Usage'
    ];

    const rpData = ratePlans.plans.map(p => {
      const gd = p.groupDiscount || {};
      return [
        p.planName,
        p.rateCode || '',
        p.lineCount,
        fmtMoney(p.perLine),
        fmtMoney(p.totalMonthly),
        gd.detected ? gd.tier : '',
        p.lineCountTier || '',
        p.zeroUsageLines,
        p.zeroUsagePercent.toFixed(0) + '%',
      ];
    });

    // Total row
    rpData.push([
      'TOTAL',
      '',
      ratePlans.summary.totalLines,
      fmtMoney(ratePlans.summary.totalMonthly / Math.max(ratePlans.summary.totalLines, 1)),
      fmtMoney(ratePlans.summary.totalMonthly),
      '',
      '',
      '',
      '',
    ]);

    const rpTitle = [
      [`${carrierName} Rate Plan Summary — ${clientName}`],
      [],
    ];

    const rpSheet = XLSX.utils.aoa_to_sheet([...rpTitle, rpHeaders, ...rpData]);
    rpSheet['!cols'] = [
      { wch: 45 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 16 },
      { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 12 },
    ];

    XLSX.utils.book_append_sheet(wb, rpSheet, 'Rate Plan Summary');

    // ── Sheet 5: Rate Plan Comparison ──
    if (planComparison && planComparison.length > 0) {
      const pcHeaders = [
        'Wireless Number', 'User Name', 'Current Plan', 'Current MRC',
        'Proposed Plan', 'Proposed MRC', 'Monthly Savings'
      ];

      const pcData = planComparison.map(p => [
        p.wireless,
        p.userName,
        p.currentPlan,
        fmtMoney(p.currentMRC),
        p.proposedPlan || '',
        p.proposedMRC !== null ? fmtMoney(p.proposedMRC) : '',
        p.proposedMRC !== null ? fmtMoney(p.savings) : '',
      ]);

      const summary = planComparisonSummary || {};
      const pcTitle = [
        [`${carrierName} Rate Plan Comparison — ${clientName}`],
        [`Current Total: $${(summary.currentTotal || 0).toFixed(2)}/mo → Proposed: $${(summary.proposedTotal || 0).toFixed(2)}/mo | Annual Savings: $${(summary.annualSavings || 0).toFixed(2)}`],
        [],
      ];

      const pcSheet = XLSX.utils.aoa_to_sheet([...pcTitle, pcHeaders, ...pcData]);

      // Total row
      XLSX.utils.sheet_add_aoa(pcSheet, [[
        'TOTAL', `${planComparison.length} lines`, '',
        fmtMoney(summary.currentTotal || 0),
        `${summary.linesChanged || 0} changed`,
        fmtMoney(summary.proposedTotal || 0),
        fmtMoney(summary.monthlySavings || 0),
      ]], { origin: -1 });

      pcSheet['!cols'] = [
        { wch: 15 }, { wch: 20 }, { wch: 35 }, { wch: 14 },
        { wch: 35 }, { wch: 14 }, { wch: 14 },
      ];

      XLSX.utils.book_append_sheet(wb, pcSheet, 'Plan Comparison');
    }

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
