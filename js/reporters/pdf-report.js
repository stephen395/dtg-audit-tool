/**
 * PDF Report Generator
 * Creates KPI dashboard-style PDF using jsPDF + jsPDF-AutoTable.
 * Replicates the billread skill's Master Summary PDF layout.
 */

window.PDFReporter = (function () {
  // Colors
  const DARK_BLUE = [26, 58, 92];
  const LIGHT_BLUE = [232, 240, 254];
  const GREEN = [39, 174, 96];
  const RED = [231, 76, 60];
  const ORANGE = [230, 126, 34];
  const CARD_BG = [247, 248, 250];
  const CARD_BORDER = [226, 229, 234];
  const WHITE = [255, 255, 255];
  const GRAY = [113, 128, 150];
  const ALT_ROW = [249, 249, 249];

  function fmtMoney(val) {
    if (Math.abs(val) >= 1000) return '$' + Math.round(val).toLocaleString();
    return '$' + val.toFixed(2);
  }

  /**
   * Draw a KPI card on the PDF
   */
  function drawCard(doc, x, y, w, h, label, value, opts = {}) {
    const { color, subLabel, fontSize = 18 } = opts;

    // Card background
    doc.setFillColor(...CARD_BG);
    doc.setDrawColor(...CARD_BORDER);
    doc.roundedRect(x, y, w, h, 2, 2, 'FD');

    // Label (top)
    doc.setFontSize(7);
    doc.setTextColor(...GRAY);
    doc.setFont('helvetica', 'normal');
    doc.text(label.toUpperCase(), x + w / 2, y + 8, { align: 'center' });

    // Value (center)
    doc.setFontSize(fontSize);
    doc.setTextColor(...(color || DARK_BLUE));
    doc.setFont('helvetica', 'bold');
    doc.text(String(value), x + w / 2, y + h / 2 + 3, { align: 'center' });

    // Sub-label (bottom)
    if (subLabel) {
      doc.setFontSize(6);
      doc.setTextColor(...GRAY);
      doc.setFont('helvetica', 'normal');
      doc.text(subLabel, x + w / 2, y + h - 4, { align: 'center' });
    }
  }

  /**
   * Draw a section header
   */
  function drawSection(doc, x, y, title) {
    doc.setFontSize(11);
    doc.setTextColor(...DARK_BLUE);
    doc.setFont('helvetica', 'bold');
    doc.text(title, x, y);
    return y + 4;
  }

  /**
   * Generate the full audit PDF report
   * @param {Object} data - { carrier, clientName, billingPeriod, zeroUsage, usageReport, ratePlans, meta }
   * @returns {jsPDF} The PDF document
   */
  function generate(data) {
    const { carrier, clientName, billingPeriod, zeroUsage, usageReport, ratePlans, meta } = data;
    const doc = new jspdf.jsPDF({ orientation: 'portrait', unit: 'mm', format: 'letter' });
    const pageW = doc.internal.pageSize.getWidth();
    const margin = 15;
    const contentW = pageW - margin * 2;
    let y = margin;

    // ── HEADER ──
    const carrierName = { att: 'AT&T', verizon: 'VERIZON', tmobile: 'T-MOBILE' }[carrier] || carrier.toUpperCase();
    doc.setFontSize(16);
    doc.setTextColor(...DARK_BLUE);
    doc.setFont('helvetica', 'bold');
    doc.text(`${carrierName} WIRELESS AUDIT REPORT`, pageW / 2, y, { align: 'center' });
    y += 6;

    doc.setFontSize(9);
    doc.setTextColor(...GRAY);
    doc.setFont('helvetica', 'normal');
    const genDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    doc.text(`${clientName} | ${billingPeriod || 'N/A'} | Generated ${genDate}`, pageW / 2, y, { align: 'center' });
    y += 3;

    doc.setFontSize(9);
    doc.text(`Total Lines: ${usageReport.summary.totalLines} | Zero Usage: ${zeroUsage.summary.totalZeroUsage}`, pageW / 2, y, { align: 'center' });
    y += 8;

    // ── SECTION 1: SPEND OVERVIEW ──
    y = drawSection(doc, margin, y, 'Spend Overview');
    y += 2;

    const cardW = (contentW - 8) / 3;
    const cardH = 22;

    // Row 1: Total Current, Total Lines, Avg per Line
    drawCard(doc, margin, y, cardW, cardH, 'Total Monthly', fmtMoney(usageReport.summary.totalCharges));
    drawCard(doc, margin + cardW + 4, y, cardW, cardH, 'Rate Plan Charges', fmtMoney(usageReport.summary.totalMonthlyCharges));
    drawCard(doc, margin + (cardW + 4) * 2, y, cardW, cardH, 'Equipment (Net)', fmtMoney(usageReport.summary.totalEquipment));
    y += cardH + 4;

    // ── SECTION 2: CURRENT INVENTORY ──
    y = drawSection(doc, margin, y, 'Current Inventory');
    y += 2;

    const inv = usageReport.inventory;
    const cardW5 = (contentW - 16) / 5;

    drawCard(doc, margin, y, cardW5, cardH, 'Total Lines', String(inv.total));
    drawCard(doc, margin + (cardW5 + 4), y, cardW5, cardH, 'Smartphones', String(inv.smartphones));
    drawCard(doc, margin + (cardW5 + 4) * 2, y, cardW5, cardH, 'Tablets', String(inv.tablets));
    drawCard(doc, margin + (cardW5 + 4) * 3, y, cardW5, cardH, 'Hotspots', String(inv.hotspots));
    drawCard(doc, margin + (cardW5 + 4) * 4, y, cardW5, cardH, 'Watches', String(inv.watches));
    y += cardH + 4;

    // ── SECTION 3: SAVINGS & OPTIMIZATION ──
    y = drawSection(doc, margin, y, 'Savings & Optimization — Recommendations');
    y += 2;

    const zu = zeroUsage.summary;
    const tallH = 28;
    const midW = (contentW - 8 - cardW * 2) / 2;

    // Left tall card: Zero Usage Lines
    drawCard(doc, margin, y, cardW - 4, tallH, 'Zero Usage Lines', String(zu.totalZeroUsage), {
      color: RED, subLabel: 'lines with no 90-day usage', fontSize: 22
    });

    // Middle cards: Cancel + Suspend stacked
    const midX = margin + cardW;
    const midH = tallH / 2 - 1;
    drawCard(doc, midX, y, midW, midH, 'Suggest Cancels', String(zu.cancelCount), { subLabel: 'no contract, no usage' });
    drawCard(doc, midX, y + midH + 2, midW, midH, 'Suggest Suspend', String(zu.suspendCount), { subLabel: 'has contract or seasonal' });

    drawCard(doc, midX + midW + 4, y, midW, midH, 'Cancel Savings', fmtMoney(zu.cancelSavings), { color: GREEN, subLabel: '/month' });
    drawCard(doc, midX + midW + 4, y + midH + 2, midW, midH, 'Suspend Savings', fmtMoney(zu.suspendSavings), { color: GREEN, subLabel: '/month' });

    // Right tall card: Total Savings
    drawCard(doc, pageW - margin - cardW + 4, y, cardW - 4, tallH, 'Total Savings', fmtMoney(zu.totalMonthlySavings), {
      color: GREEN, subLabel: '/month if all acted on', fontSize: 20
    });
    y += tallH + 6;

    // ── SECTION 4: ZERO USAGE BREAKDOWN ──
    y = drawSection(doc, margin, y, 'Zero Usage Breakdown');
    y += 2;

    const cardW4 = (contentW - 12) / 4;
    drawCard(doc, margin, y, cardW4, cardH, 'Out of Contract', String(zu.outOfContract), { color: GREEN, subLabel: 'free to cancel' });
    drawCard(doc, margin + (cardW4 + 4), y, cardW4, cardH, 'In Contract', String(zu.inContract), { color: ORANGE, subLabel: 'has installment/term' });
    drawCard(doc, margin + (cardW4 + 4) * 2, y, cardW4, cardH, 'One-Time Cost', fmtMoney(zu.totalOneTimeCost), { subLabel: 'ETF if canceling' });
    drawCard(doc, margin + (cardW4 + 4) * 3, y, cardW4, cardH, 'Annual Savings', fmtMoney(zu.totalMonthlySavings * 12), { color: GREEN, subLabel: 'projected' });
    y += cardH + 8;

    // ── PAGE 2: DETAIL TABLES ──
    doc.addPage();
    y = margin;

    // Top Rate Plans table
    y = drawSection(doc, margin, y, 'Top Rate Plans');
    y += 2;

    const planTableData = ratePlans.plans.slice(0, 20).map(p => [
      p.planName.substring(0, 45),
      String(p.lineCount),
      fmtMoney(p.totalMonthly),
      fmtMoney(p.perLine),
      String(p.zeroUsageLines),
      p.zeroUsagePercent.toFixed(0) + '%',
    ]);

    // Add total row
    planTableData.push([
      'TOTAL',
      String(ratePlans.summary.totalLines),
      fmtMoney(ratePlans.summary.totalMonthly),
      fmtMoney(ratePlans.summary.totalMonthly / Math.max(ratePlans.summary.totalLines, 1)),
      '',
      '',
    ]);

    doc.autoTable({
      startY: y,
      head: [['Rate Plan', '# Lines', 'Total Monthly', 'Per Line', 'Zero Usage', '% Zero']],
      body: planTableData,
      theme: 'grid',
      styles: { fontSize: 7, cellPadding: 2 },
      headStyles: { fillColor: DARK_BLUE, textColor: WHITE, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: ALT_ROW },
      columnStyles: {
        0: { cellWidth: 65 },
        1: { halign: 'center', cellWidth: 15 },
        2: { halign: 'right', cellWidth: 25 },
        3: { halign: 'right', cellWidth: 20 },
        4: { halign: 'center', cellWidth: 18 },
        5: { halign: 'center', cellWidth: 15 },
      },
      didParseCell: function (data) {
        // Highlight total row
        if (data.row.index === planTableData.length - 1) {
          data.cell.styles.fillColor = LIGHT_BLUE;
          data.cell.styles.fontStyle = 'bold';
        }
        // Highlight high zero usage %
        if (data.column.index === 5 && data.row.index < planTableData.length - 1) {
          const pct = parseFloat(data.cell.raw);
          if (pct > 30) {
            data.cell.styles.textColor = RED;
            data.cell.styles.fontStyle = 'bold';
          }
        }
      },
    });

    // ── FOOTER ──
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFontSize(7);
      doc.setTextColor(...GRAY);
      doc.text('Dedicated Telecom Group — Confidential', margin, doc.internal.pageSize.getHeight() - 8);
      doc.text(`Page ${i} of ${pageCount}`, pageW - margin, doc.internal.pageSize.getHeight() - 8, { align: 'right' });
    }

    return doc;
  }

  /**
   * Generate and trigger download
   */
  function download(data) {
    const doc = generate(data);
    const carrier = { att: 'ATT', verizon: 'VZW', tmobile: 'TMO' }[data.carrier] || data.carrier.toUpperCase();
    const date = new Date().toISOString().split('T')[0];
    const filename = `${carrier}_Audit_${data.clientName.replace(/\s+/g, '_')}_${date}.pdf`;
    doc.save(filename);
  }

  return { generate, download };
})();
