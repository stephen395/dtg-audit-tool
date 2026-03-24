/**
 * DTG Wireless Audit Tool — Audit Pipeline
 * Bridges the inline UI with parser/analyzer/reporter modules.
 * Called via window.DTG.runAudit(state) from the inline HTML JS.
 */

(function () {
  window.DTG = window.DTG || {};

  function fmtMoney(val) {
    if (val == null || isNaN(val)) return '$0.00';
    if (Math.abs(val) >= 1000) return '$' + Math.round(val).toLocaleString();
    return '$' + val.toFixed(2);
  }

  function setKPI(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  // ═══════════════════════════════════════════════════════
  // MAIN AUDIT PIPELINE
  // ═══════════════════════════════════════════════════════
  window.DTG.runAudit = async function (uiState) {
    const DTG = window.DTG;
    DTG.showProcessing(true);

    try {
      DTG.updateProcessingStatus('Parsing uploaded files...');
      DTG.updateProcessingProgress(10);

      const carrier = uiState.carrier;
      const clientName = uiState.clientName || 'Client';

      // Parse CSV/TXT files with PapaParse
      const parsedUsage = uiState.files.usage ? await parseFileAsync(uiState.files.usage) : null;
      const parsedUpgrade = uiState.files.upgrade ? await parseFileAsync(uiState.files.upgrade) : null;

      console.log('[AUDIT] Carrier:', carrier);
      console.log('[AUDIT] Usage file:', parsedUsage ? parsedUsage.rows.length + ' rows, headers: ' + parsedUsage.headers.slice(0, 5).join(', ') : 'none');
      console.log('[AUDIT] Upgrade file:', parsedUpgrade ? parsedUpgrade.rows.length + ' rows, headers: ' + parsedUpgrade.headers.slice(0, 5).join(', ') : 'none');

      DTG.updateProcessingProgress(25);
      DTG.updateProcessingStatus('Building line profiles...');

      // Run carrier-specific parser
      let result;
      if (carrier === 'att') {
        result = window.ATTParser.parse(
          parsedUsage ? parsedUsage.rows : [],
          parsedUpgrade ? parsedUpgrade.rows : null
        );
      } else if (carrier === 'verizon') {
        const files = [];
        if (parsedUsage) {
          const type = window.VerizonParser.detectFileType(parsedUsage.headers) || 'wirelessSummary';
          files.push({ type, rows: parsedUsage.rows });
        }
        if (parsedUpgrade) {
          const type = window.VerizonParser.detectFileType(parsedUpgrade.headers);
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
      const profileCount = Object.keys(profiles).length;

      console.log('[AUDIT] Profiles built:', profileCount);
      if (profileCount > 0) {
        const sample = Object.values(profiles)[0];
        console.log('[AUDIT] Sample:', JSON.stringify({ w: sample.wireless, u: sample.userName, plan: sample.ratePlan, mrc: sample.mrc, zu: sample.zeroUsage, gb: sample.gbTotal }));
      }

      DTG.updateProcessingProgress(45);
      DTG.updateProcessingStatus('Analyzing zero usage lines...');

      const zeroUsageResults = window.ZeroUsageAnalyzer.analyze(profiles, carrier);
      const zeroUsageSummary = window.ZeroUsageAnalyzer.summarize(zeroUsageResults);
      console.log('[AUDIT] Zero usage:', zeroUsageSummary.totalZeroUsage, 'lines, savings:', zeroUsageSummary.totalMonthlySavings);

      DTG.updateProcessingProgress(60);
      DTG.updateProcessingStatus('Generating usage report...');

      const usageReport = window.UsageReportAnalyzer.analyze(profiles);
      console.log('[AUDIT] Usage report:', usageReport.summary.totalLines, 'lines');

      DTG.updateProcessingProgress(75);
      DTG.updateProcessingStatus('Analyzing rate plans...');

      const ratePlans = window.RatePlanAnalyzer.analyze(profiles);
      console.log('[AUDIT] Rate plans:', ratePlans.summary.uniquePlans, 'unique plans');

      window.RatePlanLogger.logPlans(carrier, clientName, ratePlans.plans);

      // Parse bill PDF if provided
      let billData = null;
      if (uiState.files.pdf) {
        DTG.updateProcessingProgress(85);
        DTG.updateProcessingStatus('Reading bill PDF...');
        try {
          billData = await window.BillPDFParser.parse(uiState.files.pdf);
          console.log('[AUDIT] Bill PDF parsed:', billData.pageCount, 'pages, carrier:', billData.carrier);
        } catch (e) {
          console.warn('[AUDIT] Bill PDF error:', e.message);
        }
      }

      DTG.updateProcessingProgress(90);
      DTG.updateProcessingStatus('Rendering results...');

      // Store for exports
      const auditData = {
        carrier, clientName,
        billingPeriod: meta.billingCycles ? meta.billingCycles.join(' → ') : (meta.billingPeriods ? meta.billingPeriods.join(' → ') : ''),
        profiles, meta, zeroUsageResults, zeroUsageSummary, usageReport, ratePlans, billData,
      };
      window.DTG.auditData = auditData;

      // Populate all UI
      populateDashboardKPIs(auditData);
      populateZeroUsageTable(auditData);
      populateUsageTable(auditData);
      populateRatePlanTable(auditData);
      wireExportButtons(auditData);

      DTG.updateProcessingProgress(100);
      DTG.updateProcessingStatus('Complete!');

      setTimeout(() => {
        DTG.showProcessing(false);
        DTG.showResults();
      }, 500);

    } catch (err) {
      console.error('[AUDIT] Pipeline error:', err);
      DTG.showProcessing(false);
      alert('Audit failed: ' + err.message);
    }
  };

  // ═══════════════════════════════════════════════════════
  // FILE PARSING
  // ═══════════════════════════════════════════════════════
  function parseFileAsync(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        let text = e.target.result;
        // Strip BOM
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

        const firstLine = text.split('\n')[0];
        const delimiter = firstLine.includes('\t') ? '\t' : ',';

        Papa.parse(text, {
          header: true,
          delimiter,
          skipEmptyLines: true,
          transformHeader: (h) => h.replace(/^"|"$/g, '').trim(),
          complete: (results) => {
            const cleaned = results.data.map(row => {
              const r = {};
              for (const [k, v] of Object.entries(row)) {
                const ck = k.replace(/^"|"$/g, '').trim();
                r[ck] = typeof v === 'string' ? v.replace(/^"|"$/g, '').trim() : v;
              }
              return r;
            });
            const headers = (results.meta.fields || []).map(h => h.replace(/^"|"$/g, '').trim());
            console.log('[PARSE] File:', file.name, '→', cleaned.length, 'rows, headers:', headers.slice(0, 5));
            resolve({ rows: cleaned, headers });
          },
          error: (err) => reject(err),
        });
      };
      reader.onerror = () => reject(new Error('File read error'));
      reader.readAsText(file);
    });
  }

  // ═══════════════════════════════════════════════════════
  // POPULATE DASHBOARD KPI CARDS (by element ID)
  // ═══════════════════════════════════════════════════════
  function populateDashboardKPIs(data) {
    const ur = data.usageReport;
    const zu = data.zeroUsageSummary;
    const inv = ur.inventory;

    // Spend Overview
    setKPI('kpi-total-spend', fmtMoney(ur.summary.totalCharges));
    setKPI('kpi-avg-cost', fmtMoney(ur.summary.avgChargesPerLine));
    // Calculate surcharges from actual tax/fee fields
    const totalTaxesFees = Object.values(data.profiles).reduce((s, p) => s + (p.latestTaxes || 0) + (p.latestFees || 0), 0);
    setKPI('kpi-surcharges', fmtMoney(totalTaxesFees));
    setKPI('kpi-equipment', fmtMoney(ur.summary.totalEquipment));

    // Inventory
    setKPI('kpi-total-lines', inv.total);
    setKPI('kpi-smartphones', inv.smartphones);
    setKPI('kpi-tablets', inv.tablets);
    setKPI('kpi-wearables', inv.watches + inv.hotspots);

    // Savings
    setKPI('kpi-total-savings', fmtMoney(zu.totalMonthlySavings));
    setKPI('kpi-zero-lines', zu.totalZeroUsage);
    setKPI('kpi-zero-cost', fmtMoney(zu.cancelSavings + zu.suspendSavings));
    setKPI('kpi-plan-opts', data.ratePlans.summary.highZeroUsagePlans);
    setKPI('kpi-plan-savings', fmtMoney(0)); // placeholder for plan optimization
    setKPI('kpi-annual-savings', fmtMoney(zu.totalMonthlySavings * 12));
  }

  // ═══════════════════════════════════════════════════════
  // POPULATE ZERO USAGE TABLE
  // ═══════════════════════════════════════════════════════
  function populateZeroUsageTable(data) {
    const tbody = document.getElementById('zero-usage-tbody');
    const countEl = document.getElementById('zero-usage-table-count');
    const badgeEl = document.getElementById('zero-usage-count');
    const emptyEl = document.getElementById('zero-usage-empty');
    const zu = data.zeroUsageSummary;

    // Update count badge on tab
    if (badgeEl) badgeEl.textContent = data.zeroUsageResults.length;
    if (countEl) countEl.textContent = `${data.zeroUsageResults.length} lines | Save ${fmtMoney(zu.cancelSavings)}/mo by canceling out-of-contract`;

    if (!tbody) {
      console.warn('[AUDIT] zero-usage-tbody not found, falling back to inject');
      injectZeroUsageTable(data);
      return;
    }

    if (data.zeroUsageResults.length === 0) {
      if (emptyEl) emptyEl.classList.remove('hidden');
      return;
    }
    if (emptyEl) emptyEl.classList.add('hidden');

    let html = '';
    for (const r of data.zeroUsageResults) {
      const actionColor = r.action.includes('CANCEL') ? '#ef4444' : (r.action === 'SUSPEND' ? '#f59e0b' : '#6b6b76');
      const contractBadge = r.hasActiveContract
        ? '<span style="background:rgba(239,68,68,0.15);color:#ef4444;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600">YES</span>'
        : '<span style="background:rgba(34,197,94,0.15);color:#22c55e;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600">NO</span>';

      html += `<tr>
        <td>${r.wireless}</td>
        <td>${r.userName}</td>
        <td>${r.deviceType || ''}</td>
        <td title="${r.ratePlan}">${(r.ratePlan || '').substring(0, 40)}</td>
        <td class="number">${fmtMoney(r.mrc || 0)}</td>
        <td style="text-align:center">${contractBadge}</td>
        <td>${r.contractEnd || 'N/A'}</td>
        <td style="color:${actionColor};font-weight:600">${r.action}</td>
        <td style="font-size:11px;color:#a1a1aa;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.reason}">${r.reason}</td>
        <td class="number" style="color:#22c55e;font-weight:600">${fmtMoney(r.monthlySavings || 0)}</td>
      </tr>`;
    }

    // Total row
    html += `<tr style="background:rgba(34,197,94,0.08);font-weight:600">
      <td colspan="4">TOTAL — ${data.zeroUsageResults.length} lines</td>
      <td class="number">${fmtMoney(data.zeroUsageResults.reduce((s,r) => s + (r.mrc||0), 0))}</td>
      <td colspan="4"></td>
      <td class="number" style="color:#22c55e">${fmtMoney(zu.totalMonthlySavings)}</td>
    </tr>`;

    tbody.innerHTML = html;
  }

  function injectZeroUsageTable(data) {
    const panel = document.getElementById('tab-zero-usage');
    if (!panel) return;

    const zu = data.zeroUsageSummary;
    let html = `<div style="margin-bottom:12px;padding:12px 16px;background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);border-radius:8px;color:#22c55e;font-weight:600">
      Cancelling out-of-contract lines could save → ${fmtMoney(zu.cancelSavings)}/month | ${zu.totalZeroUsage} zero usage lines | ${zu.outOfContract} out of contract
    </div>
    <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="background:#1a3a5c;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:0.03em">
        <th style="padding:8px 10px">Number</th>
        <th style="padding:8px 10px">User Name</th>
        <th style="padding:8px 10px">Device</th>
        <th style="padding:8px 10px">Rate Plan</th>
        <th style="padding:8px 10px;text-align:right">MRC</th>
        <th style="padding:8px 10px;text-align:center">Contract?</th>
        <th style="padding:8px 10px">Contract End</th>
        <th style="padding:8px 10px">Action</th>
        <th style="padding:8px 10px">Reason</th>
        <th style="padding:8px 10px;text-align:right">Savings/mo</th>
      </tr></thead><tbody>`;

    for (const r of data.zeroUsageResults) {
      const actionColor = r.action.includes('CANCEL') ? '#ef4444' : (r.action === 'SUSPEND' ? '#f59e0b' : '#6b6b76');
      const contractBadge = r.hasActiveContract
        ? '<span style="background:rgba(239,68,68,0.15);color:#ef4444;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600">YES</span>'
        : '<span style="background:rgba(34,197,94,0.15);color:#22c55e;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600">NO</span>';

      html += `<tr style="border-bottom:1px solid rgba(255,255,255,0.05)">
        <td style="padding:6px 10px;font-variant-numeric:tabular-nums">${r.wireless}</td>
        <td style="padding:6px 10px">${r.userName}</td>
        <td style="padding:6px 10px">${r.deviceType || ''}</td>
        <td style="padding:6px 10px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.ratePlan}">${r.ratePlan || ''}</td>
        <td style="padding:6px 10px;text-align:right;font-variant-numeric:tabular-nums">${fmtMoney(r.mrc || 0)}</td>
        <td style="padding:6px 10px;text-align:center">${contractBadge}</td>
        <td style="padding:6px 10px">${r.contractEnd || 'N/A'}</td>
        <td style="padding:6px 10px;color:${actionColor};font-weight:600">${r.action}</td>
        <td style="padding:6px 10px;font-size:11px;color:#a1a1aa;max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.reason}">${r.reason}</td>
        <td style="padding:6px 10px;text-align:right;color:#22c55e;font-weight:600;font-variant-numeric:tabular-nums">${fmtMoney(r.monthlySavings || 0)}</td>
      </tr>`;
    }

    // Total row
    html += `<tr style="background:rgba(34,197,94,0.08);font-weight:600">
      <td style="padding:8px 10px" colspan="4">TOTAL — ${data.zeroUsageResults.length} lines</td>
      <td style="padding:8px 10px;text-align:right">${fmtMoney(data.zeroUsageResults.reduce((s,r) => s + (r.mrc||0), 0))}</td>
      <td colspan="4"></td>
      <td style="padding:8px 10px;text-align:right;color:#22c55e">${fmtMoney(zu.totalMonthlySavings)}</td>
    </tr>`;

    html += '</tbody></table></div>';
    panel.innerHTML = html;
  }

  // ═══════════════════════════════════════════════════════
  // POPULATE USAGE REPORT TABLE
  // ═══════════════════════════════════════════════════════
  function populateUsageTable(data) {
    const panel = document.getElementById('tab-usage-report');
    if (!panel) return;

    let html = `<div style="margin-bottom:12px;font-size:13px;color:var(--text-secondary)">
      ${data.usageReport.summary.totalLines} lines | Total: ${fmtMoney(data.usageReport.summary.totalCharges)} | Avg: ${fmtMoney(data.usageReport.summary.avgChargesPerLine)}/line
    </div>
    <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="background:#1a3a5c;color:#fff">
        <th style="padding:8px">Wireless</th><th style="padding:8px">User Name</th><th style="padding:8px">Device</th><th style="padding:8px">Rate Plan</th>
        <th style="padding:8px">Data (GB)</th><th style="padding:8px">Voice (min)</th><th style="padding:8px">Messages</th>
        <th style="padding:8px">Monthly</th><th style="padding:8px">Total</th><th style="padding:8px">Zero?</th>
      </tr></thead><tbody>`;

    for (const l of data.usageReport.lines) {
      html += `<tr style="border-bottom:1px solid rgba(255,255,255,0.05)">
        <td style="padding:6px 8px">${l.wireless}</td>
        <td style="padding:6px 8px">${l.userName}</td>
        <td style="padding:6px 8px">${l.deviceType || ''}</td>
        <td style="padding:6px 8px" title="${l.ratePlan}">${(l.ratePlan || '').substring(0, 35)}</td>
        <td style="padding:6px 8px;text-align:right">${l.gbTotal.toFixed(2)}</td>
        <td style="padding:6px 8px;text-align:right">${l.minTotal || 0}</td>
        <td style="padding:6px 8px;text-align:right">${l.msgTotal || 0}</td>
        <td style="padding:6px 8px;text-align:right">${fmtMoney(l.monthlyCharges)}</td>
        <td style="padding:6px 8px;text-align:right">${fmtMoney(l.totalCharges)}</td>
        <td style="padding:6px 8px;${l.zeroUsage ? 'color:#ef4444;font-weight:600' : ''}">${l.zeroUsage ? 'YES' : ''}</td>
      </tr>`;
    }
    html += '</tbody></table></div>';
    panel.innerHTML = html;
  }

  // ═══════════════════════════════════════════════════════
  // POPULATE RATE PLAN TABLE
  // ═══════════════════════════════════════════════════════
  function populateRatePlanTable(data) {
    const panel = document.getElementById('tab-rate-plans');
    if (!panel) return;

    let html = `<style>
      .rp-table { width:100%; border-collapse:collapse; font-size:12px; table-layout:fixed; }
      .rp-table th, .rp-table td { padding:8px 12px; }
      .rp-table th { background:#1a3a5c; color:#fff; font-size:11px; text-transform:uppercase; letter-spacing:0.03em; }
      .rp-table td { border-bottom:1px solid rgba(255,255,255,0.05); }
      .rp-table tr:hover { background:rgba(255,255,255,0.03); }
      .rp-table .col-plan { width:40%; text-align:left; }
      .rp-table .col-num { width:12%; text-align:right; font-variant-numeric:tabular-nums; }
    </style>
    <div style="overflow-x:auto"><table class="rp-table">
      <thead><tr>
        <th class="col-plan">Rate Plan</th>
        <th class="col-num"># Lines</th>
        <th class="col-num">Total Monthly</th>
        <th class="col-num">Per Line</th>
        <th class="col-num">Zero Usage</th>
        <th class="col-num">% Zero</th>
      </tr></thead><tbody>`;

    for (const p of data.ratePlans.plans) {
      const hi = p.zeroUsagePercent > 30;
      html += `<tr>
        <td class="col-plan">${p.planName}</td>
        <td class="col-num">${p.lineCount}</td>
        <td class="col-num">${fmtMoney(p.totalMonthly)}</td>
        <td class="col-num">${fmtMoney(p.perLine)}</td>
        <td class="col-num">${p.zeroUsageLines}</td>
        <td class="col-num" style="${hi ? 'color:#ef4444;font-weight:600' : ''}">${p.zeroUsagePercent.toFixed(0)}%</td>
      </tr>`;
    }
    html += `<tr style="background:rgba(34,197,94,0.08);font-weight:600">
      <td class="col-plan">TOTAL</td>
      <td class="col-num">${data.ratePlans.summary.totalLines}</td>
      <td class="col-num">${fmtMoney(data.ratePlans.summary.totalMonthly)}</td>
      <td class="col-num">${fmtMoney(data.ratePlans.summary.totalMonthly / Math.max(data.ratePlans.summary.totalLines, 1))}</td>
      <td class="col-num"></td>
      <td class="col-num"></td>
    </tr>`;
    html += '</tbody></table></div>';

    const stats = window.RatePlanLogger.getStats();
    html += `<div style="margin-top:20px;padding:14px;background:#1e1f2a;border-radius:10px;border:1px solid rgba(255,255,255,0.08)">
      <strong>Rate Plan Database</strong><br>
      <span style="color:#6b6b76;font-size:12px">${stats.totalPlans} unique plans logged across ${stats.clients.length} client(s)</span>
    </div>`;

    panel.innerHTML = html;
  }

  // ═══════════════════════════════════════════════════════
  // WIRE EXPORT BUTTONS
  // ═══════════════════════════════════════════════════════
  function wireExportButtons(data) {
    const pdfBtn = document.getElementById('btn-export-pdf');
    const xlsBtn = document.getElementById('btn-export-excel');
    const csvBtn = document.getElementById('btn-export-csv');
    const planBtn = document.getElementById('btn-export-plandb');

    if (pdfBtn) {
      pdfBtn.disabled = false;
      pdfBtn.onclick = () => {
        window.PDFReporter.download({
          carrier: data.carrier, clientName: data.clientName, billingPeriod: data.billingPeriod,
          zeroUsage: { results: data.zeroUsageResults, summary: data.zeroUsageSummary },
          usageReport: data.usageReport, ratePlans: data.ratePlans, meta: data.meta,
        });
      };
    }

    if (xlsBtn) {
      xlsBtn.disabled = false;
      xlsBtn.onclick = () => {
        window.ExcelReporter.download({
          carrier: data.carrier, clientName: data.clientName, billingPeriod: data.billingPeriod,
          zeroUsageResults: data.zeroUsageResults, usageReport: data.usageReport,
          ratePlans: data.ratePlans, profiles: data.profiles,
        });
      };
    }

    if (csvBtn) {
      csvBtn.disabled = false;
      csvBtn.onclick = () => {
        const rows = [
          ['Wireless','User Name','Device Type','Rate Plan','MRC','Action','Monthly Savings','Reason'].join(','),
          ...data.zeroUsageResults.map(r => [
            r.wireless, `"${r.userName}"`, r.deviceType||'', `"${r.ratePlan||''}"`,
            (r.mrc||0).toFixed(2), r.action, (r.monthlySavings||0).toFixed(2), `"${r.reason}"`
          ].join(','))
        ].join('\n');
        downloadBlob(rows, 'text/csv', `ZeroUsage_${data.clientName}_${dateStr()}.csv`);
      };
    }

    if (planBtn) {
      planBtn.disabled = false;
      planBtn.onclick = () => {
        downloadBlob(window.RatePlanLogger.exportCSV(), 'text/csv', `RatePlanDB_${dateStr()}.csv`);
      };
    }
  }

  function downloadBlob(content, type, filename) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  function dateStr() {
    return new Date().toISOString().split('T')[0];
  }

})();
