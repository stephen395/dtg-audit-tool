/**
 * DTG Wireless Audit Tool — Audit Pipeline
 * Bridges the inline UI with parser/analyzer/reporter modules.
 * Called by the inline JS via window.DTG.runAudit(state)
 */

(function () {

  // Ensure DTG namespace exists
  window.DTG = window.DTG || {};

  function fmtMoney(val) {
    if (val == null) return '$0';
    if (Math.abs(val) >= 1000) return '$' + Math.round(val).toLocaleString();
    return '$' + val.toFixed(2);
  }

  /**
   * Main audit pipeline — called from inline JS when "Run Audit" is clicked
   * @param {Object} uiState - { carrier, carrierName, files: {usage, upgrade, pdf}, clientName }
   */
  window.DTG.runAudit = async function (uiState) {
    const DTG = window.DTG;
    DTG.showProcessing(true);

    try {
      // ── Step 1: Parse files ──
      DTG.updateProcessingStatus('Parsing uploaded files...');
      DTG.updateProcessingProgress(10);

      const carrier = uiState.carrier; // 'att', 'verizon', 'tmobile'
      const clientName = uiState.clientName || 'Client';

      // Parse CSV/TXT files
      const usageFile = uiState.files.usage;
      const upgradeFile = uiState.files.upgrade;
      const pdfFile = uiState.files.pdf;

      let parsedUsage = null;
      let parsedUpgrade = null;

      if (usageFile) {
        parsedUsage = await parseFileAsync(usageFile);
      }
      if (upgradeFile) {
        parsedUpgrade = await parseFileAsync(upgradeFile);
      }

      DTG.updateProcessingProgress(30);
      DTG.updateProcessingStatus('Building line profiles...');

      // ── Step 2: Run carrier-specific parser ──
      let result;
      if (carrier === 'att') {
        result = window.ATTParser.parse(
          parsedUsage ? parsedUsage.rows : [],
          parsedUpgrade ? parsedUpgrade.rows : null
        );
      } else if (carrier === 'verizon') {
        // Verizon: detect file types from headers
        const files = [];
        if (parsedUsage) {
          const headers = Object.keys(parsedUsage.rows[0] || {});
          const type = window.VerizonParser.detectFileType(headers);
          if (type) files.push({ type, rows: parsedUsage.rows });
          // If it's wirelessSummary but not detected, try as wirelessSummary
          if (!type) files.push({ type: 'wirelessSummary', rows: parsedUsage.rows });
        }
        if (parsedUpgrade) {
          const headers = Object.keys(parsedUpgrade.rows[0] || {});
          const type = window.VerizonParser.detectFileType(headers);
          if (type) files.push({ type, rows: parsedUpgrade.rows });
        }
        result = window.VerizonParser.parse(files);
      } else if (carrier === 'tmobile') {
        result = window.TMobileParser.parse(parsedUsage ? parsedUsage.rows : []);
      } else {
        throw new Error('Unknown carrier: ' + carrier);
      }

      const profiles = result.profiles;
      const meta = result.meta || {};

      DTG.updateProcessingProgress(50);
      DTG.updateProcessingStatus('Analyzing zero usage lines...');

      // ── Step 3: Run analyzers ──
      const zeroUsageResults = window.ZeroUsageAnalyzer.analyze(profiles, carrier);
      const zeroUsageSummary = window.ZeroUsageAnalyzer.summarize(zeroUsageResults);

      DTG.updateProcessingProgress(65);
      DTG.updateProcessingStatus('Generating usage report...');

      const usageReport = window.UsageReportAnalyzer.analyze(profiles);

      DTG.updateProcessingProgress(75);
      DTG.updateProcessingStatus('Analyzing rate plans...');

      const ratePlans = window.RatePlanAnalyzer.analyze(profiles);

      // Log rate plans for future suggestions
      window.RatePlanLogger.logPlans(carrier, clientName, ratePlans.plans);

      // ── Step 4: Parse bill PDF if provided ──
      let billData = null;
      if (pdfFile) {
        DTG.updateProcessingProgress(85);
        DTG.updateProcessingStatus('Reading bill PDF...');
        try {
          billData = await window.BillPDFParser.parse(pdfFile);
        } catch (e) {
          console.warn('Bill PDF parse error:', e);
        }
      }

      DTG.updateProcessingProgress(90);
      DTG.updateProcessingStatus('Rendering results...');

      // ── Step 5: Store results and render ──
      const auditData = {
        carrier,
        clientName,
        billingPeriod: meta.billingPeriods ? meta.billingPeriods.join(' → ') : '',
        profiles,
        meta,
        zeroUsageResults,
        zeroUsageSummary,
        usageReport,
        ratePlans,
        billData,
      };

      // Store for export functions
      window.DTG.auditData = auditData;

      // Render all tabs
      renderDashboard(auditData);
      renderZeroUsageTable(auditData);
      renderUsageTable(auditData);
      renderRatePlanTable(auditData);
      setupExportButtons(auditData);

      DTG.updateProcessingProgress(100);
      DTG.updateProcessingStatus('Complete!');

      setTimeout(() => {
        DTG.showProcessing(false);
        DTG.showResults();
      }, 600);

    } catch (err) {
      console.error('Audit pipeline error:', err);
      DTG.showProcessing(false);
      alert('Audit failed: ' + err.message + '\n\nCheck console for details.');
    }
  };

  /**
   * Parse a file using PapaParse (auto-detect delimiter)
   */
  function parseFileAsync(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target.result;
        const firstLine = text.split('\n')[0];
        const delimiter = firstLine.includes('\t') ? '\t' : ',';

        Papa.parse(text, {
          header: true,
          delimiter,
          skipEmptyLines: true,
          complete: (results) => {
            resolve({ rows: results.data, headers: results.meta.fields || [] });
          },
          error: (err) => reject(err),
        });
      };
      reader.onerror = () => reject(new Error('File read error'));
      reader.readAsText(file);
    });
  }

  // ── RENDER FUNCTIONS ──

  function renderDashboard(data) {
    const container = document.getElementById('tab-dashboard');
    if (!container) return;

    const zu = data.zeroUsageSummary;
    const ur = data.usageReport;
    const inv = ur.inventory;
    const rp = data.ratePlans;

    // Find or create content area
    let content = container.querySelector('.dashboard-dynamic');
    if (!content) {
      content = document.createElement('div');
      content.className = 'dashboard-dynamic';
      container.appendChild(content);
    }

    content.innerHTML = `
      <style>
        .kpi-section { margin-bottom: 24px; }
        .kpi-section .section-title { font-size: 13px; font-weight: 600; color: #a1a1aa; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
        .kpi-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 12px; }
        .kpi-card { background: #1e1f2a; border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 16px; text-align: center; }
        .kpi-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b6b76; margin-bottom: 8px; }
        .kpi-value { font-size: 24px; font-weight: 800; color: #e4e4e7; }
        .kpi-sub { font-size: 10px; color: #6b6b76; margin-top: 4px; }
        .kpi-green .kpi-value { color: #22c55e; }
        .kpi-red .kpi-value { color: #ef4444; }
        .kpi-orange .kpi-value { color: #f59e0b; }
      </style>

      <div class="kpi-section">
        <div class="section-title">Spend Overview</div>
        <div class="kpi-row">
          ${kpiCard('Total Monthly', fmtMoney(ur.summary.totalCharges))}
          ${kpiCard('Rate Plan Charges', fmtMoney(ur.summary.totalMonthlyCharges))}
          ${kpiCard('Equipment (Net)', fmtMoney(ur.summary.totalEquipment))}
          ${kpiCard('Avg Per Line', fmtMoney(ur.summary.avgChargesPerLine))}
        </div>
      </div>

      <div class="kpi-section">
        <div class="section-title">Current Inventory</div>
        <div class="kpi-row">
          ${kpiCard('Total Lines', inv.total)}
          ${kpiCard('Smartphones', inv.smartphones)}
          ${kpiCard('Tablets', inv.tablets)}
          ${kpiCard('Hotspots', inv.hotspots)}
          ${kpiCard('Watches', inv.watches)}
        </div>
      </div>

      <div class="kpi-section">
        <div class="section-title">Savings & Optimization</div>
        <div class="kpi-row">
          ${kpiCard('Zero Usage Lines', zu.totalZeroUsage, 'red', 'no 90-day usage')}
          ${kpiCard('Suggest Cancel', zu.cancelCount, '', 'no contract')}
          ${kpiCard('Cancel Savings', fmtMoney(zu.cancelSavings), 'green', '/month')}
          ${kpiCard('Total Savings', fmtMoney(zu.totalMonthlySavings), 'green', 'if all acted on')}
        </div>
        <div class="kpi-row">
          ${kpiCard('Suggest Suspend', zu.suspendCount, 'orange', 'has contract')}
          ${kpiCard('Suspend Savings', fmtMoney(zu.suspendSavings), 'green', '/month')}
          ${kpiCard('Annual Projection', fmtMoney(zu.totalMonthlySavings * 12), 'green', 'projected')}
          ${kpiCard('One-Time Costs', fmtMoney(zu.totalOneTimeCost), '', 'ETF if canceling')}
        </div>
      </div>

      <div class="kpi-section">
        <div class="section-title">Rate Plans</div>
        <div class="kpi-row">
          ${kpiCard('Unique Plans', rp.summary.uniquePlans)}
          ${kpiCard('Total Monthly', fmtMoney(rp.summary.totalMonthly))}
          ${kpiCard('High Zero-Usage Plans', rp.summary.highZeroUsagePlans, rp.summary.highZeroUsagePlans > 0 ? 'red' : '', '>30% zero usage')}
        </div>
      </div>
    `;
  }

  function kpiCard(label, value, color, sub) {
    const cls = color ? `kpi-${color}` : '';
    return `<div class="kpi-card ${cls}">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${value}</div>
      ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
    </div>`;
  }

  function renderZeroUsageTable(data) {
    const panel = document.getElementById('tab-zero-usage');
    if (!panel) return;

    let content = panel.querySelector('.zu-dynamic');
    if (!content) {
      content = document.createElement('div');
      content.className = 'zu-dynamic';
      panel.appendChild(content);
    }

    const zu = data.zeroUsageSummary;
    let html = `
      <style>
        .audit-table-wrap { overflow-x: auto; margin-top: 12px; }
        .audit-table { width: 100%; border-collapse: collapse; font-size: 12px; }
        .audit-table th { background: #1a3a5c; color: #fff; padding: 8px 10px; text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.03em; position: sticky; top: 0; }
        .audit-table td { padding: 6px 10px; border-bottom: 1px solid rgba(255,255,255,0.05); color: #e4e4e7; }
        .audit-table tr:nth-child(even) { background: rgba(255,255,255,0.02); }
        .audit-table tr:hover { background: rgba(255,255,255,0.05); }
        .audit-table .num { text-align: right; font-variant-numeric: tabular-nums; }
        .action-cancel { color: #ef4444; font-weight: 600; }
        .action-suspend { color: #f59e0b; font-weight: 600; }
        .action-keep { color: #6b6b76; }
        .savings-banner { background: rgba(34,197,94,0.1); border: 1px solid rgba(34,197,94,0.3); border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; color: #22c55e; font-weight: 600; }
        .table-search { background: #1e1f2a; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; padding: 8px 12px; color: #e4e4e7; width: 300px; margin-bottom: 8px; }
      </style>
      <div class="savings-banner">
        Cancelling out-of-contract lines could save → <strong>${fmtMoney(zu.cancelSavings)}/month</strong>
        &nbsp;|&nbsp; ${zu.totalZeroUsage} zero usage lines found
      </div>
      <input type="text" class="table-search" placeholder="Search lines..." oninput="DTG.filterZU(this.value)">
      <div class="audit-table-wrap">
        <table class="audit-table" id="zu-results-table">
          <thead><tr>
            <th>Wireless</th><th>User Name</th><th>Device</th><th>Rate Plan</th>
            <th>90d GB</th><th>90d Min</th><th>90d Msg</th>
            <th>MRC</th><th>Contract End</th><th>Action</th><th>Savings/mo</th>
          </tr></thead>
          <tbody>
    `;

    for (const r of data.zeroUsageResults) {
      const cls = r.action.includes('CANCEL') ? 'action-cancel' : (r.action === 'SUSPEND' ? 'action-suspend' : 'action-keep');
      html += `<tr>
        <td>${r.wireless}</td>
        <td>${r.userName}</td>
        <td>${r.deviceType || ''}</td>
        <td title="${r.ratePlan}">${(r.ratePlan || '').substring(0, 35)}</td>
        <td class="num">${(r.gbTotal || 0).toFixed(2)}</td>
        <td class="num">${r.minTotal || r.totalMin90d || 0}</td>
        <td class="num">${r.msgTotal || r.totalMsg90d || 0}</td>
        <td class="num">${fmtMoney(r.mrc || 0)}</td>
        <td>${r.contractEnd || ''}</td>
        <td class="${cls}" title="${r.reason}">${r.action}</td>
        <td class="num" style="color:#22c55e">${fmtMoney(r.monthlySavings || 0)}</td>
      </tr>`;
    }

    html += '</tbody></table></div>';
    content.innerHTML = html;
  }

  window.DTG.filterZU = function (q) {
    const rows = document.querySelectorAll('#zu-results-table tbody tr');
    const query = q.toLowerCase();
    rows.forEach(r => { r.style.display = r.textContent.toLowerCase().includes(query) ? '' : 'none'; });
  };

  function renderUsageTable(data) {
    const panel = document.getElementById('tab-usage');
    if (!panel) return;

    let content = panel.querySelector('.usage-dynamic');
    if (!content) {
      content = document.createElement('div');
      content.className = 'usage-dynamic';
      panel.appendChild(content);
    }

    let html = `
      <input type="text" class="table-search" placeholder="Search lines..." oninput="DTG.filterUsage(this.value)">
      <div class="audit-table-wrap">
        <table class="audit-table" id="usage-results-table">
          <thead><tr>
            <th>Wireless</th><th>User Name</th><th>Device</th><th>Rate Plan</th>
            <th>Data (GB)</th><th>Voice (min)</th><th>Messages</th>
            <th>Monthly</th><th>Total</th><th>Zero?</th>
          </tr></thead>
          <tbody>
    `;

    for (const l of data.usageReport.lines) {
      html += `<tr>
        <td>${l.wireless}</td>
        <td>${l.userName}</td>
        <td>${l.deviceType}</td>
        <td title="${l.ratePlan}">${(l.ratePlan || '').substring(0, 35)}</td>
        <td class="num">${l.gbTotal.toFixed(2)}</td>
        <td class="num">${l.minTotal || 0}</td>
        <td class="num">${l.msgTotal || 0}</td>
        <td class="num">${fmtMoney(l.monthlyCharges)}</td>
        <td class="num">${fmtMoney(l.totalCharges)}</td>
        <td style="${l.zeroUsage ? 'color:#ef4444;font-weight:600' : ''}">${l.zeroUsage ? 'YES' : ''}</td>
      </tr>`;
    }

    html += '</tbody></table></div>';
    content.innerHTML = html;
  }

  window.DTG.filterUsage = function (q) {
    const rows = document.querySelectorAll('#usage-results-table tbody tr');
    const query = q.toLowerCase();
    rows.forEach(r => { r.style.display = r.textContent.toLowerCase().includes(query) ? '' : 'none'; });
  };

  function renderRatePlanTable(data) {
    const panel = document.getElementById('tab-rateplans');
    if (!panel) return;

    let content = panel.querySelector('.rp-dynamic');
    if (!content) {
      content = document.createElement('div');
      content.className = 'rp-dynamic';
      panel.appendChild(content);
    }

    let html = `
      <div class="audit-table-wrap">
        <table class="audit-table">
          <thead><tr>
            <th>Rate Plan</th><th># Lines</th><th>Total Monthly</th><th>Per Line</th>
            <th>Zero Usage</th><th>% Zero</th>
          </tr></thead>
          <tbody>
    `;

    for (const p of data.ratePlans.plans) {
      const highZero = p.zeroUsagePercent > 30;
      html += `<tr>
        <td>${p.planName}</td>
        <td class="num">${p.lineCount}</td>
        <td class="num">${fmtMoney(p.totalMonthly)}</td>
        <td class="num">${fmtMoney(p.perLine)}</td>
        <td class="num">${p.zeroUsageLines}</td>
        <td class="num" style="${highZero ? 'color:#ef4444;font-weight:600' : ''}">${p.zeroUsagePercent.toFixed(0)}%</td>
      </tr>`;
    }

    // Total row
    html += `<tr style="background:rgba(34,197,94,0.1)">
      <td><strong>TOTAL</strong></td>
      <td class="num"><strong>${data.ratePlans.summary.totalLines}</strong></td>
      <td class="num"><strong>${fmtMoney(data.ratePlans.summary.totalMonthly)}</strong></td>
      <td class="num"><strong>${fmtMoney(data.ratePlans.summary.totalMonthly / Math.max(data.ratePlans.summary.totalLines, 1))}</strong></td>
      <td></td><td></td>
    </tr>`;

    html += '</tbody></table></div>';

    // Rate plan database stats
    const stats = window.RatePlanLogger.getStats();
    html += `<div style="margin-top:24px;padding:16px;background:#1e1f2a;border-radius:10px;border:1px solid rgba(255,255,255,0.08)">
      <div style="font-weight:600;margin-bottom:8px">Rate Plan Database</div>
      <div style="color:#6b6b76;font-size:12px">${stats.totalPlans} unique plans logged across ${stats.clients.length} client(s)</div>
    </div>`;

    content.innerHTML = html;
  }

  function setupExportButtons(data) {
    const panel = document.getElementById('tab-exports');
    if (!panel) return;

    // Wire up export card clicks
    const cards = panel.querySelectorAll('.export-card');
    cards.forEach(card => {
      const type = card.dataset.export;
      card.style.cursor = 'pointer';
      card.onclick = () => {
        switch (type) {
          case 'pdf': downloadPDF(data); break;
          case 'excel': downloadExcel(data); break;
          case 'csv': downloadCSV(data); break;
          case 'plandb': downloadPlanDB(); break;
        }
      };
    });

    // Also expose globally
    window.DTG.downloadPDF = () => downloadPDF(data);
    window.DTG.downloadExcel = () => downloadExcel(data);
    window.DTG.downloadCSV = () => downloadCSV(data);
    window.DTG.downloadPlanDB = () => downloadPlanDB();
  }

  function downloadPDF(data) {
    window.PDFReporter.download({
      carrier: data.carrier,
      clientName: data.clientName,
      billingPeriod: data.billingPeriod,
      zeroUsage: { results: data.zeroUsageResults, summary: data.zeroUsageSummary },
      usageReport: data.usageReport,
      ratePlans: data.ratePlans,
      meta: data.meta,
    });
  }

  function downloadExcel(data) {
    window.ExcelReporter.download({
      carrier: data.carrier,
      clientName: data.clientName,
      billingPeriod: data.billingPeriod,
      zeroUsageResults: data.zeroUsageResults,
      usageReport: data.usageReport,
      ratePlans: data.ratePlans,
      profiles: data.profiles,
    });
  }

  function downloadCSV(data) {
    const rows = [
      ['Wireless', 'User Name', 'Device Type', 'Rate Plan', 'MRC', 'Action', 'Monthly Savings', 'Reason'].join(','),
      ...data.zeroUsageResults.map(r => [
        r.wireless, `"${r.userName}"`, r.deviceType || '', `"${r.ratePlan || ''}"`,
        (r.mrc || 0).toFixed(2), r.action, (r.monthlySavings || 0).toFixed(2), `"${r.reason}"`
      ].join(','))
    ].join('\n');

    downloadBlob(rows, 'text/csv', `ZeroUsage_${data.clientName}_${dateStr()}.csv`);
  }

  function downloadPlanDB() {
    const csv = window.RatePlanLogger.exportCSV();
    downloadBlob(csv, 'text/csv', `RatePlanDatabase_${dateStr()}.csv`);
  }

  function downloadBlob(content, type, filename) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function dateStr() {
    return new Date().toISOString().split('T')[0];
  }

})();
