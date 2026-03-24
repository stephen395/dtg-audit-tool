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
    setKPI('kpi-surcharges', fmtMoney(ur.summary.totalCharges - ur.summary.totalMonthlyCharges - ur.summary.totalEquipment));
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
    const tbody = document.querySelector('#tab-zero-usage .data-table tbody');
    if (!tbody) {
      console.warn('[AUDIT] Zero usage tbody not found, injecting table');
      injectZeroUsageTable(data);
      return;
    }

    tbody.innerHTML = '';
    for (const r of data.zeroUsageResults) {
      const tr = document.createElement('tr');
      const cls = r.action.includes('CANCEL') ? 'color:#ef4444;font-weight:600' : (r.action === 'SUSPEND' ? 'color:#f59e0b;font-weight:600' : '');
      tr.innerHTML = `
        <td>${r.wireless}</td>
        <td>${r.userName}</td>
        <td>${r.deviceType || ''}</td>
        <td title="${r.ratePlan}">${(r.ratePlan || '').substring(0, 35)}</td>
        <td style="text-align:right">${(r.gbTotal || 0).toFixed(2)}</td>
        <td style="text-align:right">${r.minTotal || r.totalMin90d || 0}</td>
        <td style="text-align:right">${r.msgTotal || r.totalMsg90d || 0}</td>
        <td style="text-align:right">${fmtMoney(r.mrc || 0)}</td>
        <td>${r.contractEnd || ''}</td>
        <td style="${cls}" title="${r.reason}">${r.action}</td>
        <td style="text-align:right;color:#22c55e">${fmtMoney(r.monthlySavings || 0)}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  function injectZeroUsageTable(data) {
    const panel = document.getElementById('tab-zero-usage');
    if (!panel) return;

    let html = `<div style="margin-bottom:12px;padding:12px 16px;background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);border-radius:8px;color:#22c55e;font-weight:600">
      Cancelling out-of-contract lines could save → ${fmtMoney(data.zeroUsageSummary.cancelSavings)}/month | ${data.zeroUsageSummary.totalZeroUsage} zero usage lines
    </div>
    <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="background:#1a3a5c;color:#fff">
        <th style="padding:8px">Wireless</th><th style="padding:8px">User Name</th><th style="padding:8px">Device</th><th style="padding:8px">Rate Plan</th>
        <th style="padding:8px">90d GB</th><th style="padding:8px">90d Min</th><th style="padding:8px">90d Msg</th>
        <th style="padding:8px">MRC</th><th style="padding:8px">Contract End</th><th style="padding:8px">Action</th><th style="padding:8px">Savings/mo</th>
      </tr></thead><tbody>`;

    for (const r of data.zeroUsageResults) {
      const cls = r.action.includes('CANCEL') ? 'color:#ef4444;font-weight:600' : (r.action === 'SUSPEND' ? 'color:#f59e0b;font-weight:600' : '');
      html += `<tr style="border-bottom:1px solid rgba(255,255,255,0.05)">
        <td style="padding:6px 8px">${r.wireless}</td>
        <td style="padding:6px 8px">${r.userName}</td>
        <td style="padding:6px 8px">${r.deviceType || ''}</td>
        <td style="padding:6px 8px" title="${r.ratePlan}">${(r.ratePlan || '').substring(0, 35)}</td>
        <td style="padding:6px 8px;text-align:right">${(r.gbTotal || 0).toFixed(2)}</td>
        <td style="padding:6px 8px;text-align:right">${r.minTotal || r.totalMin90d || 0}</td>
        <td style="padding:6px 8px;text-align:right">${r.msgTotal || r.totalMsg90d || 0}</td>
        <td style="padding:6px 8px;text-align:right">${fmtMoney(r.mrc || 0)}</td>
        <td style="padding:6px 8px">${r.contractEnd || ''}</td>
        <td style="padding:6px 8px;${cls}" title="${r.reason}">${r.action}</td>
        <td style="padding:6px 8px;text-align:right;color:#22c55e">${fmtMoney(r.monthlySavings || 0)}</td>
      </tr>`;
    }
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

    let html = `<div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="background:#1a3a5c;color:#fff">
        <th style="padding:8px">Rate Plan</th><th style="padding:8px"># Lines</th><th style="padding:8px">Total Monthly</th><th style="padding:8px">Per Line</th>
        <th style="padding:8px">Zero Usage</th><th style="padding:8px">% Zero</th>
      </tr></thead><tbody>`;

    for (const p of data.ratePlans.plans) {
      const hi = p.zeroUsagePercent > 30;
      html += `<tr style="border-bottom:1px solid rgba(255,255,255,0.05)">
        <td style="padding:6px 8px">${p.planName}</td>
        <td style="padding:6px 8px;text-align:right">${p.lineCount}</td>
        <td style="padding:6px 8px;text-align:right">${fmtMoney(p.totalMonthly)}</td>
        <td style="padding:6px 8px;text-align:right">${fmtMoney(p.perLine)}</td>
        <td style="padding:6px 8px;text-align:right">${p.zeroUsageLines}</td>
        <td style="padding:6px 8px;text-align:right;${hi ? 'color:#ef4444;font-weight:600' : ''}">${p.zeroUsagePercent.toFixed(0)}%</td>
      </tr>`;
    }
    html += `<tr style="background:rgba(34,197,94,0.1)">
      <td style="padding:8px"><strong>TOTAL</strong></td>
      <td style="padding:8px;text-align:right"><strong>${data.ratePlans.summary.totalLines}</strong></td>
      <td style="padding:8px;text-align:right"><strong>${fmtMoney(data.ratePlans.summary.totalMonthly)}</strong></td>
      <td style="padding:8px;text-align:right"><strong>${fmtMoney(data.ratePlans.summary.totalMonthly / Math.max(data.ratePlans.summary.totalLines, 1))}</strong></td>
      <td></td><td></td>
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
