/**
 * DTG Wireless Audit Tool — Main Application
 * Routes between pages, orchestrates parsing + analysis, renders results.
 */

(function () {
  // ── STATE ──
  const state = {
    carrier: null,       // 'att' | 'verizon' | 'tmobile'
    files: {},           // { usage: File, contract: File, bill: File }
    parsedFiles: {},     // { usage: rows[], contract: rows[] }
    clientName: '',
    billingPeriod: '',
    profiles: null,
    zeroUsageResults: null,
    zeroUsageSummary: null,
    usageReport: null,
    ratePlans: null,
    billData: null,
  };

  // ── PASSWORD GATE ──
  const PASSWORD = 'Stellicalen152021!';

  function checkPassword() {
    if (sessionStorage.getItem('dtg_audit_auth') === 'true') {
      document.getElementById('password-gate').style.display = 'none';
      document.getElementById('app-content').style.display = 'block';
      return;
    }
    document.getElementById('password-gate').style.display = 'flex';
    document.getElementById('app-content').style.display = 'none';
  }

  window.unlockApp = function () {
    const input = document.getElementById('password-input');
    if (input.value === PASSWORD) {
      sessionStorage.setItem('dtg_audit_auth', 'true');
      document.getElementById('password-gate').style.display = 'none';
      document.getElementById('app-content').style.display = 'block';
    } else {
      input.style.borderColor = '#e74c3c';
      input.value = '';
      input.placeholder = 'Wrong password';
    }
  };

  // ── NAVIGATION ──
  function showPage(pageId) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const page = document.getElementById(pageId);
    if (page) page.classList.add('active');

    // Update nav
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    const stepMap = { 'page-carrier': 'step-1', 'page-upload': 'step-2', 'page-results': 'step-3' };
    const step = document.getElementById(stepMap[pageId]);
    if (step) step.classList.add('active');
  }

  window.selectCarrier = function (carrier) {
    state.carrier = carrier;
    state.files = {};
    state.parsedFiles = {};

    // Update upload page carrier indicator
    const names = { att: 'AT&T', verizon: 'Verizon', tmobile: 'T-Mobile' };
    const colors = { att: '#009fdb', verizon: '#cd040b', tmobile: '#e20074' };
    const indicator = document.getElementById('carrier-indicator');
    if (indicator) {
      indicator.textContent = names[carrier];
      indicator.style.color = colors[carrier];
    }

    // Update file type hints
    const hints = {
      att: { usage: 'CSV from AT&T Premier (All Wireless Charges & Usage)', contract: 'CSV (Upgrade Eligibility)' },
      verizon: { usage: 'TXT from ECPD/Tangoe (tab-delimited)', contract: 'TXT (Upgrade Eligibility)' },
      tmobile: { usage: 'CSV from T-Mobile Business portal', contract: 'CSV (Device/Contract report)' },
    };
    const hint = hints[carrier] || hints.att;
    const usageHint = document.getElementById('usage-file-hint');
    const contractHint = document.getElementById('contract-file-hint');
    if (usageHint) usageHint.textContent = hint.usage;
    if (contractHint) contractHint.textContent = hint.contract;

    showPage('page-upload');
  };

  window.goBack = function () {
    showPage('page-carrier');
  };

  window.startNewAudit = function () {
    state.carrier = null;
    state.files = {};
    state.parsedFiles = {};
    state.profiles = null;
    showPage('page-carrier');
  };

  // ── FILE HANDLING ──
  function setupDropZones() {
    ['usage', 'contract', 'bill'].forEach(type => {
      const zone = document.getElementById(`drop-${type}`);
      const input = document.getElementById(`file-${type}`);
      if (!zone || !input) return;

      zone.addEventListener('click', () => input.click());
      zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
      zone.addEventListener('drop', e => {
        e.preventDefault();
        zone.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) handleFile(type, e.dataTransfer.files[0]);
      });
      input.addEventListener('change', () => {
        if (input.files.length > 0) handleFile(type, input.files[0]);
      });
    });
  }

  function handleFile(type, file) {
    state.files[type] = file;
    const zone = document.getElementById(`drop-${type}`);
    const nameEl = zone.querySelector('.file-name');
    const iconEl = zone.querySelector('.drop-icon');

    nameEl.textContent = file.name;
    zone.classList.add('has-file');
    iconEl.textContent = '✓';

    // Parse immediately for CSV/TXT
    if (type !== 'bill') {
      parseFile(type, file);
    }

    updateRunButton();
  }

  function parseFile(type, file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;

      // Auto-detect delimiter
      const firstLine = text.split('\n')[0];
      const delimiter = firstLine.includes('\t') ? '\t' : ',';

      Papa.parse(text, {
        header: true,
        delimiter: delimiter,
        skipEmptyLines: true,
        complete: (results) => {
          if (results.data.length > 0) {
            // Detect file subtype
            const headers = Object.keys(results.data[0]);
            let fileType = null;

            if (state.carrier === 'att') {
              fileType = window.ATTParser.detectFileType(headers);
            } else if (state.carrier === 'verizon') {
              fileType = window.VerizonParser.detectFileType(headers);
            } else if (state.carrier === 'tmobile') {
              fileType = window.TMobileParser.detectFileType(headers);
            }

            state.parsedFiles[type] = { rows: results.data, headers, fileType, rowCount: results.data.length };

            // Show detected info
            const zone = document.getElementById(`drop-${type}`);
            const infoEl = zone.querySelector('.file-info');
            if (infoEl) {
              infoEl.textContent = `${results.data.length} rows | ${fileType || 'auto-detect'} | ${headers.length} columns`;
            }
          }
        }
      });
    };
    reader.readAsText(file);
  }

  function updateRunButton() {
    const btn = document.getElementById('btn-run-audit');
    if (btn) {
      btn.disabled = !state.files.usage;
    }
  }

  // ── AUDIT ENGINE ──
  window.runAudit = async function () {
    const btn = document.getElementById('btn-run-audit');
    const progress = document.getElementById('audit-progress');
    btn.disabled = true;
    btn.textContent = 'Running...';
    progress.style.display = 'block';

    state.clientName = document.getElementById('client-name').value || 'Client';

    try {
      updateProgress('Parsing files...', 10);

      // Parse based on carrier
      let result;
      if (state.carrier === 'att') {
        const billingRows = state.parsedFiles.usage?.rows || [];
        const contractRows = state.parsedFiles.contract?.rows || null;
        result = window.ATTParser.parse(billingRows, contractRows);
      } else if (state.carrier === 'verizon') {
        // Verizon can have multiple TXT files — detect each
        const files = [];
        for (const [key, parsed] of Object.entries(state.parsedFiles)) {
          if (parsed && parsed.fileType) {
            files.push({ type: parsed.fileType, rows: parsed.rows });
          }
        }
        result = window.VerizonParser.parse(files);
      } else if (state.carrier === 'tmobile') {
        const usageRows = state.parsedFiles.usage?.rows || [];
        result = window.TMobileParser.parse(usageRows);
      }

      state.profiles = result.profiles;
      state.meta = result.meta;
      state.billingPeriod = result.meta?.billingPeriods?.join(' - ') || '';

      updateProgress('Analyzing zero usage...', 30);
      const zeroResults = window.ZeroUsageAnalyzer.analyze(state.profiles, state.carrier);
      state.zeroUsageResults = zeroResults;
      state.zeroUsageSummary = window.ZeroUsageAnalyzer.summarize(zeroResults);

      updateProgress('Generating usage report...', 50);
      state.usageReport = window.UsageReportAnalyzer.analyze(state.profiles);

      updateProgress('Analyzing rate plans...', 70);
      state.ratePlans = window.RatePlanAnalyzer.analyze(state.profiles);

      // Log rate plans
      window.RatePlanLogger.logPlans(state.carrier, state.clientName, state.ratePlans.plans);

      // Parse bill PDF if provided
      if (state.files.bill) {
        updateProgress('Reading bill PDF...', 85);
        try {
          state.billData = await window.BillPDFParser.parse(state.files.bill);
        } catch (e) {
          console.warn('Bill PDF parse error:', e);
        }
      }

      updateProgress('Rendering results...', 95);
      renderResults();

      updateProgress('Complete!', 100);
      setTimeout(() => showPage('page-results'), 500);

    } catch (err) {
      console.error('Audit error:', err);
      alert('Audit failed: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Run Audit';
      setTimeout(() => { progress.style.display = 'none'; }, 1000);
    }
  };

  function updateProgress(text, pct) {
    const bar = document.getElementById('progress-bar');
    const label = document.getElementById('progress-label');
    if (bar) bar.style.width = pct + '%';
    if (label) label.textContent = text;
  }

  // ── RENDER RESULTS ──
  function renderResults() {
    renderDashboard();
    renderZeroUsageTable();
    renderUsageTable();
    renderRatePlanTable();
    renderExports();
  }

  function renderDashboard() {
    const container = document.getElementById('dashboard-content');
    if (!container) return;

    const zu = state.zeroUsageSummary;
    const ur = state.usageReport;
    const inv = ur.inventory;
    const rp = state.ratePlans;

    container.innerHTML = `
      <div class="kpi-section">
        <h3 class="section-title">Spend Overview</h3>
        <div class="kpi-row">
          ${kpiCard('Total Monthly', fmtMoney(ur.summary.totalCharges))}
          ${kpiCard('Rate Plan Charges', fmtMoney(ur.summary.totalMonthlyCharges))}
          ${kpiCard('Equipment (Net)', fmtMoney(ur.summary.totalEquipment))}
          ${kpiCard('Avg Per Line', fmtMoney(ur.summary.avgChargesPerLine))}
        </div>
      </div>

      <div class="kpi-section">
        <h3 class="section-title">Current Inventory</h3>
        <div class="kpi-row">
          ${kpiCard('Total Lines', inv.total)}
          ${kpiCard('Smartphones', inv.smartphones)}
          ${kpiCard('Tablets', inv.tablets)}
          ${kpiCard('Hotspots', inv.hotspots)}
          ${kpiCard('Watches', inv.watches)}
        </div>
      </div>

      <div class="kpi-section">
        <h3 class="section-title">Savings & Optimization</h3>
        <div class="kpi-row savings-grid">
          ${kpiCard('Zero Usage Lines', zu.totalZeroUsage, 'red', 'lines with no 90-day usage')}
          ${kpiCard('Suggest Cancel', zu.cancelCount, '', 'no contract')}
          ${kpiCard('Cancel Savings', fmtMoney(zu.cancelSavings), 'green', '/month')}
          ${kpiCard('Total Monthly Savings', fmtMoney(zu.totalMonthlySavings), 'green', 'if all acted on')}
        </div>
        <div class="kpi-row">
          ${kpiCard('Suggest Suspend', zu.suspendCount, 'orange', 'has contract')}
          ${kpiCard('Suspend Savings', fmtMoney(zu.suspendSavings), 'green', '/month')}
          ${kpiCard('Annual Savings', fmtMoney(zu.totalMonthlySavings * 12), 'green', 'projected')}
          ${kpiCard('One-Time Costs', fmtMoney(zu.totalOneTimeCost), '', 'ETF if canceling')}
        </div>
      </div>

      <div class="kpi-section">
        <h3 class="section-title">Rate Plans</h3>
        <div class="kpi-row">
          ${kpiCard('Unique Plans', rp.summary.uniquePlans)}
          ${kpiCard('Total Monthly', fmtMoney(rp.summary.totalMonthly))}
          ${kpiCard('High Zero-Usage Plans', rp.summary.highZeroUsagePlans, rp.summary.highZeroUsagePlans > 0 ? 'red' : '', '>30% zero usage')}
        </div>
      </div>
    `;
  }

  function kpiCard(label, value, color, sub) {
    const colorClass = color ? `kpi-${color}` : '';
    return `
      <div class="kpi-card ${colorClass}">
        <div class="kpi-label">${label}</div>
        <div class="kpi-value">${value}</div>
        ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
      </div>
    `;
  }

  function fmtMoney(val) {
    if (val == null) return '$0';
    if (Math.abs(val) >= 1000) return '$' + Math.round(val).toLocaleString();
    return '$' + val.toFixed(2);
  }

  function renderZeroUsageTable() {
    const container = document.getElementById('zero-usage-content');
    if (!container || !state.zeroUsageResults) return;

    const zu = state.zeroUsageSummary;
    let html = `
      <div class="table-summary">
        <span class="summary-stat green">Cancelling out-of-contract lines could save → <strong>${fmtMoney(zu.cancelSavings)}/month</strong></span>
        <span class="summary-stat">${zu.totalZeroUsage} zero usage lines found</span>
      </div>
      <div class="table-controls">
        <input type="text" id="zu-search" placeholder="Search..." class="table-search" oninput="window.filterTable('zu-table', this.value)">
      </div>
      <div class="table-wrapper">
        <table id="zu-table" class="data-table">
          <thead>
            <tr>
              <th>Wireless</th><th>User Name</th><th>Device Type</th><th>Rate Plan</th>
              <th>90d GB</th><th>90d Min</th><th>90d Msg</th>
              <th>MRC</th><th>Contract End</th><th>Action</th><th>Savings/mo</th>
            </tr>
          </thead>
          <tbody>
    `;

    for (const r of state.zeroUsageResults) {
      const actionClass = r.action.includes('CANCEL') ? 'action-cancel' : (r.action === 'SUSPEND' ? 'action-suspend' : 'action-keep');
      html += `
        <tr>
          <td>${r.wireless}</td>
          <td>${r.userName}</td>
          <td>${r.deviceType || ''}</td>
          <td title="${r.ratePlan}">${(r.ratePlan || '').substring(0, 30)}</td>
          <td class="num">${(r.gbTotal || 0).toFixed(2)}</td>
          <td class="num">${r.minTotal || r.totalMin90d || 0}</td>
          <td class="num">${r.msgTotal || r.totalMsg90d || 0}</td>
          <td class="num">${fmtMoney(r.mrc || 0)}</td>
          <td>${r.contractEnd || ''}</td>
          <td class="${actionClass}" title="${r.reason}">${r.action}</td>
          <td class="num green">${fmtMoney(r.monthlySavings || 0)}</td>
        </tr>
      `;
    }

    html += '</tbody></table></div>';
    container.innerHTML = html;
  }

  function renderUsageTable() {
    const container = document.getElementById('usage-content');
    if (!container || !state.usageReport) return;

    let html = `
      <div class="table-controls">
        <input type="text" id="usage-search" placeholder="Search..." class="table-search" oninput="window.filterTable('usage-table', this.value)">
        <select id="usage-filter-type" class="table-filter" onchange="window.filterTable('usage-table', document.getElementById('usage-search').value)">
          <option value="">All Device Types</option>
          <option value="Smartphone">Smartphones</option>
          <option value="Tablet">Tablets</option>
          <option value="Hotspot">Hotspots</option>
          <option value="Watch">Watches</option>
        </select>
      </div>
      <div class="table-wrapper">
        <table id="usage-table" class="data-table">
          <thead>
            <tr>
              <th>Wireless</th><th>User Name</th><th>Device Type</th><th>Rate Plan</th>
              <th>Data (GB)</th><th>Voice (min)</th><th>Messages</th>
              <th>Monthly</th><th>Total</th><th>Zero?</th>
            </tr>
          </thead>
          <tbody>
    `;

    for (const l of state.usageReport.lines) {
      html += `
        <tr data-device="${l.deviceType}">
          <td>${l.wireless}</td>
          <td>${l.userName}</td>
          <td>${l.deviceType}</td>
          <td title="${l.ratePlan}">${(l.ratePlan || '').substring(0, 30)}</td>
          <td class="num">${l.gbTotal.toFixed(2)}</td>
          <td class="num">${l.minTotal || 0}</td>
          <td class="num">${l.msgTotal || 0}</td>
          <td class="num">${fmtMoney(l.monthlyCharges)}</td>
          <td class="num">${fmtMoney(l.totalCharges)}</td>
          <td class="${l.zeroUsage ? 'flag-red' : ''}">${l.zeroUsage ? 'Yes' : ''}</td>
        </tr>
      `;
    }

    html += '</tbody></table></div>';
    container.innerHTML = html;
  }

  function renderRatePlanTable() {
    const container = document.getElementById('rateplan-content');
    if (!container || !state.ratePlans) return;

    let html = `
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Rate Plan</th><th># Lines</th><th>Total Monthly</th><th>Per Line</th>
              <th>Zero Usage</th><th>% Zero</th>
            </tr>
          </thead>
          <tbody>
    `;

    for (const p of state.ratePlans.plans) {
      const highZero = p.zeroUsagePercent > 30;
      html += `
        <tr>
          <td>${p.planName}</td>
          <td class="num">${p.lineCount}</td>
          <td class="num">${fmtMoney(p.totalMonthly)}</td>
          <td class="num">${fmtMoney(p.perLine)}</td>
          <td class="num">${p.zeroUsageLines}</td>
          <td class="num ${highZero ? 'flag-red' : ''}">${p.zeroUsagePercent.toFixed(0)}%</td>
        </tr>
      `;
    }

    // Total row
    html += `
        <tr class="total-row">
          <td><strong>TOTAL</strong></td>
          <td class="num"><strong>${state.ratePlans.summary.totalLines}</strong></td>
          <td class="num"><strong>${fmtMoney(state.ratePlans.summary.totalMonthly)}</strong></td>
          <td class="num"><strong>${fmtMoney(state.ratePlans.summary.totalMonthly / Math.max(state.ratePlans.summary.totalLines, 1))}</strong></td>
          <td></td><td></td>
        </tr>
      </tbody></table></div>
    `;

    // Rate Plan Database section
    const logStats = window.RatePlanLogger.getStats();
    html += `
      <div class="rateplan-db">
        <h3 class="section-title">Rate Plan Database</h3>
        <p class="text-muted">${logStats.totalPlans} unique plans logged across ${logStats.clients.length} clients</p>
        <button class="btn btn-sm" onclick="window.exportPlanDB('csv')">Export CSV</button>
        <button class="btn btn-sm" onclick="window.exportPlanDB('json')">Export JSON</button>
      </div>
    `;

    container.innerHTML = html;
  }

  function renderExports() {
    const container = document.getElementById('exports-content');
    if (!container) return;

    container.innerHTML = `
      <div class="export-cards">
        <div class="export-card" onclick="window.downloadPDF()">
          <div class="export-icon">📄</div>
          <h4>Download PDF Report</h4>
          <p>KPI dashboard with savings analysis</p>
        </div>
        <div class="export-card" onclick="window.downloadExcel()">
          <div class="export-icon">📊</div>
          <h4>Download Excel Detail</h4>
          <p>4-sheet workbook with line-level data</p>
        </div>
        <div class="export-card" onclick="window.downloadCSV()">
          <div class="export-icon">📋</div>
          <h4>Download CSV</h4>
          <p>Raw zero usage data as CSV</p>
        </div>
        <div class="export-card" onclick="window.exportPlanDB('csv')">
          <div class="export-icon">🗃️</div>
          <h4>Export Plan Database</h4>
          <p>All rate plans logged across audits</p>
        </div>
      </div>
    `;
  }

  // ── EXPORTS ──
  window.downloadPDF = function () {
    window.PDFReporter.download({
      carrier: state.carrier,
      clientName: state.clientName,
      billingPeriod: state.billingPeriod,
      zeroUsage: { results: state.zeroUsageResults, summary: state.zeroUsageSummary },
      usageReport: state.usageReport,
      ratePlans: state.ratePlans,
      meta: state.meta,
    });
  };

  window.downloadExcel = function () {
    window.ExcelReporter.download({
      carrier: state.carrier,
      clientName: state.clientName,
      billingPeriod: state.billingPeriod,
      zeroUsageResults: state.zeroUsageResults,
      usageReport: state.usageReport,
      ratePlans: state.ratePlans,
      profiles: state.profiles,
    });
  };

  window.downloadCSV = function () {
    const rows = [
      ['Wireless', 'User Name', 'Device Type', 'Rate Plan', 'MRC', 'Action', 'Monthly Savings', 'Reason'].join(','),
      ...state.zeroUsageResults.map(r => [
        r.wireless, `"${r.userName}"`, r.deviceType, `"${r.ratePlan}"`,
        (r.mrc || 0).toFixed(2), r.action, (r.monthlySavings || 0).toFixed(2), `"${r.reason}"`
      ].join(','))
    ].join('\n');

    const blob = new Blob([rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ZeroUsage_${state.clientName}_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  window.exportPlanDB = function (format) {
    const content = format === 'json' ? window.RatePlanLogger.exportJSON() : window.RatePlanLogger.exportCSV();
    const type = format === 'json' ? 'application/json' : 'text/csv';
    const ext = format === 'json' ? 'json' : 'csv';

    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `RatePlanDatabase_${new Date().toISOString().split('T')[0]}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── TABLE UTILITIES ──
  window.filterTable = function (tableId, query) {
    const table = document.getElementById(tableId);
    if (!table) return;
    const rows = table.querySelectorAll('tbody tr');
    const q = query.toLowerCase();

    rows.forEach(row => {
      const text = row.textContent.toLowerCase();
      row.style.display = text.includes(q) ? '' : 'none';
    });
  };

  // ── TAB SWITCHING ──
  window.switchTab = function (tabId) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

    document.querySelector(`[data-tab="${tabId}"]`)?.classList.add('active');
    document.getElementById(tabId)?.classList.add('active');
  };

  // ── INIT ──
  document.addEventListener('DOMContentLoaded', () => {
    checkPassword();
    setupDropZones();

    // Enter key on password
    const pwInput = document.getElementById('password-input');
    if (pwInput) {
      pwInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') window.unlockApp();
      });
    }
  });

})();
