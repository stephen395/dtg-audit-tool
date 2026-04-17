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

  /**
   * Sniff which carrier an uploaded CSV actually belongs to, based on its headers.
   * Returns 'att' | 'verizon' | 'tmobile' | null.
   * Used so the pipeline can fail fast with a helpful message when the user
   * picks the wrong carrier instead of silently building zero profiles.
   */
  function detectCarrierFromHeaders(headers) {
    if (!headers || !headers.length) return null;
    const h = headers.map(c => String(c || '').toLowerCase().trim());
    const has = (needle) => h.some(c => c.includes(needle));

    // AT&T Premier exports
    if (has('wireless number and descriptions') ||
        has('foundation account') ||
        has('billing account name')) return 'att';

    // Verizon ECPD / Tangoe TXT exports
    if (has('your calling plan') ||
        has('bill period') ||
        (has('wireless number') && has('data usage')) ||
        has('previous balance')) return 'verizon';

    // T-Mobile Business exports
    if (has('subscriber number') ||
        has('mobile number') ||
        has('equipment installment')) return 'tmobile';

    return null;
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

      // Determine if this is a PDF-only audit (no CSV files)
      const hasCsvFiles = !!uiState.files.usage;
      const hasPdf = !!uiState.files.pdf;
      const pdfOnlyMode = !hasCsvFiles && hasPdf;

      console.log('[AUDIT] Mode:', pdfOnlyMode ? 'PDF-ONLY' : 'CSV + optional PDF');

      let profiles, meta;
      // Declared in the outer scope so post-parse code (Sheet View, exports,
      // etc.) can still reference them after the PDF-vs-CSV branch closes.
      let parsedUsage = null;
      let parsedUpgrade = null;

      if (pdfOnlyMode) {
        // ── PDF-ONLY AUDIT (small accounts) ──
        DTG.updateProcessingStatus('Reading bill PDF (this may take a moment for large bills)...');
        DTG.updateProcessingProgress(15);

        const billData = await window.BillPDFParser.parse(uiState.files.pdf, (current, total) => {
          const pct = 15 + Math.round((current / total) * 50);
          DTG.updateProcessingProgress(pct);
          DTG.updateProcessingStatus(`Reading bill PDF... page ${current} of ${total}`);
        });

        console.log('[AUDIT] PDF parsed:', billData.pageCount, 'pages, carrier:', billData.carrier);

        if (!billData.lineProfiles || Object.keys(billData.lineProfiles).length === 0) {
          throw new Error('Could not extract line-level data from this PDF. Try uploading CSV reports instead.');
        }

        // Override carrier if detected from PDF
        if (billData.carrier !== 'unknown' && billData.carrier !== carrier) {
          console.log('[AUDIT] Carrier override from PDF:', billData.carrier);
        }

        profiles = billData.lineProfiles;
        const bm = billData.billMeta || {};
        meta = {
          source: 'pdf',
          accountNumber: billData.accountInfo.accountNumber,
          accountName: billData.accountInfo.accountName,
          foundationAccount: billData.accountInfo.foundationAccount,
          invoice: billData.accountInfo.invoice,
          issueDate: billData.accountInfo.issueDate,
          totalDue: billData.accountInfo.totalDue,
          lastBillAmount: bm.lastBillAmount || 0,
          autoPayDate: bm.autoPayDate || '',
          billingPeriods: bm.billingPeriod ? [bm.billingPeriod] : [],
          billingCycles: bm.billingPeriod ? [bm.billingPeriod] : [],
          pdfPages: billData.pageCount,
        };

        console.log('[AUDIT] PDF profiles built:', Object.keys(profiles).length);

      } else {
        // ── CSV-BASED AUDIT (standard) ──
        parsedUsage = uiState.files.usage ? await parseFileAsync(uiState.files.usage) : null;
        parsedUpgrade = uiState.files.upgrade ? await parseFileAsync(uiState.files.upgrade) : null;

        console.log('[AUDIT] Carrier:', carrier);
        console.log('[AUDIT] Usage file:', parsedUsage ? parsedUsage.rows.length + ' rows, headers: ' + parsedUsage.headers.slice(0, 5).join(', ') : 'none');
        console.log('[AUDIT] Upgrade file:', parsedUpgrade ? parsedUpgrade.rows.length + ' rows, headers: ' + parsedUpgrade.headers.slice(0, 5).join(', ') : 'none');

        // Auto-detect Tangoe TCC format regardless of selected carrier
        const isTangoe = carrier === 'tangoe' ||
          (parsedUsage && window.TangoeParser && window.TangoeParser.detect(parsedUsage.headers));
        if (isTangoe && carrier !== 'tangoe') {
          console.log('[AUDIT] Tangoe TCC format auto-detected from headers');
        }

        // Detect the carrier the headers actually belong to, and bail out with a
        // clear error if it disagrees with what the user selected.
        if (!isTangoe && parsedUsage) {
          const detected = detectCarrierFromHeaders(parsedUsage.headers);
          if (detected && detected !== carrier) {
            const pretty = { att: 'AT&T', verizon: 'Verizon', tmobile: 'T-Mobile' };
            throw new Error(
              `Carrier mismatch: you selected ${pretty[carrier] || carrier}, but the uploaded file looks like ${pretty[detected] || detected}. ` +
              `Click "New Audit" and choose ${pretty[detected] || detected}.`
            );
          }
        }

        DTG.updateProcessingProgress(25);
        DTG.updateProcessingStatus('Building line profiles...');

        let result;
        if (isTangoe) {
          result = window.TangoeParser.parse(parsedUsage ? parsedUsage.rows : []);
        } else if (carrier === 'att') {
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

        profiles = result.profiles;
        meta = result.meta || {};
      }

      const profileCount = Object.keys(profiles).length;
      console.log('[AUDIT] Profiles built:', profileCount);
      if (profileCount > 0) {
        const sample = Object.values(profiles)[0];
        console.log('[AUDIT] Sample:', JSON.stringify({ w: sample.wireless, u: sample.userName, plan: sample.ratePlan, mrc: sample.mrc, zu: sample.zeroUsage, gb: sample.gbTotal }));
      } else if (!pdfOnlyMode) {
        // The parser couldn't extract a single line. Bail out loudly instead of
        // silently rendering a dashboard full of zeroes — usually this means the
        // CSV format doesn't match the selected carrier.
        const pretty = { att: 'AT&T', verizon: 'Verizon', tmobile: 'T-Mobile', tangoe: 'Tangoe' };
        throw new Error(
          `No lines were parsed from the uploaded file(s). The columns don't match the ${pretty[carrier] || carrier} format. ` +
          `Double-check the carrier selection and the file you uploaded.`
        );
      }

      DTG.updateProcessingProgress(65);
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

      // Push rate plans to n8n (non-blocking)
      window.RatePlanLogger.pushAuditPlans(carrier, clientName, ratePlans.plans).then(result => {
        if (result.success && result.count > 0) {
          console.log(`[AUDIT] n8n: pushed ${result.count} rate plans`);
          const syncEl = document.getElementById('n8n-sync-status');
          if (syncEl) {
            syncEl.textContent = `Synced ${result.count} plans to n8n`;
            syncEl.style.color = '#22c55e';
          }
        } else if (!result.success) {
          console.warn('[AUDIT] n8n push failed:', result.error);
          const syncEl = document.getElementById('n8n-sync-status');
          if (syncEl) {
            syncEl.textContent = 'n8n sync failed — data saved locally';
            syncEl.style.color = '#f59e0b';
          }
        }
      });

      // Parse bill PDF if provided (for CSV+PDF mode, PDF was already parsed in PDF-only mode)
      let billData = null;
      if (uiState.files.pdf && !pdfOnlyMode) {
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

      // ── Sheet View Calculation (Google Sheet formula replica) ──
      let sheetViewResults = null;
      let discrepancyReport = null;
      if (carrier === 'att' && window.SheetView && parsedUsage) {
        try {
          sheetViewResults = window.SheetView.calculate(
            parsedUsage ? parsedUsage.rows : [],
            parsedUpgrade ? parsedUpgrade.rows : null
          );
          console.log('[AUDIT] Sheet View:', sheetViewResults.totalLines, 'lines,',
                       sheetViewResults.zeroUsageCount, 'zero usage,',
                       '$' + sheetViewResults.totalSavings.toFixed(2), 'savings');

          // Render Sheet View tabs
          const sheetUsageEl = document.getElementById('sheet-usage-content');
          const sheetZeroEl = document.getElementById('sheet-zero-usage-content');
          if (sheetUsageEl) window.SheetView.renderSheetUsageReport(sheetViewResults, sheetUsageEl);
          if (sheetZeroEl) window.SheetView.renderSheetZeroUsageReport(sheetViewResults, sheetZeroEl);

          // Update Sheet Zero Usage count badge
          const sheetBadge = document.getElementById('sheet-zero-usage-count');
          if (sheetBadge) sheetBadge.textContent = sheetViewResults.zeroUsageCount;
        } catch (e) {
          console.error('[AUDIT] Sheet View error:', e);
        }
      }

      // ── Discrepancy Detection ──
      if (sheetViewResults && window.DiscrepancyEngine) {
        try {
          discrepancyReport = window.DiscrepancyEngine.compare(
            { zeroUsageResults, zeroUsageSummary, usageReport },
            sheetViewResults
          );
          console.log('[AUDIT] Discrepancies:', discrepancyReport.discrepancyCount, 'of',
                       discrepancyReport.totalLines, 'lines',
                       '(' + discrepancyReport.accuracyScore.toFixed(1) + '% accuracy)');

          // Render Discrepancy tab
          const discEl = document.getElementById('discrepancy-content');
          if (discEl) window.DiscrepancyEngine.render(discrepancyReport, discEl);

          // Update discrepancy badge
          const discBadge = document.getElementById('discrepancy-count-badge');
          if (discBadge && discrepancyReport.discrepancyCount > 0) {
            discBadge.textContent = discrepancyReport.discrepancyCount;
            discBadge.style.display = '';
          }
        } catch (e) {
          console.error('[AUDIT] Discrepancy error:', e);
        }
      }

      // Store for exports
      const auditData = {
        carrier, clientName,
        billingPeriod: meta.billingCycles ? meta.billingCycles.join(' → ') : (meta.billingPeriods ? meta.billingPeriods.join(' → ') : ''),
        profiles, meta, zeroUsageResults, zeroUsageSummary, usageReport, ratePlans, billData,
        sheetViewResults, discrepancyReport,
      };
      window.DTG.auditData = auditData;
      window.lastAuditResults = auditData;

      // Populate all UI
      populateDashboardKPIs(auditData);
      renderDashboardCharts(auditData);
      populateZeroUsageTable(auditData);
      populateUsageTable(auditData);
      populateRatePlanTable(auditData);
      populatePlanComparison(auditData);
      wireExportButtons(auditData);

      // ── Status Indicators ──
      const statusEl = document.getElementById('status-indicators');
      if (statusEl) {
        statusEl.style.display = '';
        document.getElementById('status-last-audit').textContent = 'Last audit: ' + new Date().toLocaleString();
        document.getElementById('status-discrepancies').textContent = 'Discrepancies: ' + (discrepancyReport ? discrepancyReport.discrepancyCount : '--');
        document.getElementById('status-accuracy').textContent = 'Accuracy: ' + (discrepancyReport ? discrepancyReport.accuracyScore.toFixed(1) + '%' : '--');
        const logEntries = window.AuditLog ? window.AuditLog.getLog() : [];
        const codeUpdates = logEntries.filter(e => e.type === 'code_update').length;
        document.getElementById('status-code-updates').textContent = 'Code updates: ' + codeUpdates;
      }

      // Log to audit history
      if (typeof DTG.logAuditHistory === 'function') {
        DTG.logAuditHistory(auditData);
      }

      // ── Audit Log entry ──
      if (window.AuditLog) {
        try {
          window.AuditLog.logAuditRun({
            carrier, clientName,
            filesUploaded: Object.keys(uiState.files || {}).filter(k => uiState.files[k]),
            auditMode: billData ? 'pdf+csv' : 'csv',
            results: {
              totalLines: usageReport ? usageReport.summary.totalLines : 0,
              zeroUsageLines: zeroUsageSummary ? zeroUsageSummary.totalZeroUsage : 0,
              totalMRC: usageReport ? usageReport.summary.totalMRC : 0,
              estimatedMonthlySavings: zeroUsageSummary ? zeroUsageSummary.totalMonthlySavings : 0,
              toolView: {
                zeroUsageCount: zeroUsageSummary ? zeroUsageSummary.totalZeroUsage : 0,
                cancelCount: zeroUsageSummary ? zeroUsageSummary.cancelCount : 0,
                suspendCount: zeroUsageSummary ? zeroUsageSummary.suspendCount : 0,
                keepCount: zeroUsageSummary ? zeroUsageSummary.keepCount : 0,
                totalSavings: zeroUsageSummary ? zeroUsageSummary.totalMonthlySavings : 0,
              },
              sheetView: sheetViewResults ? {
                zeroUsageCount: sheetViewResults.zeroUsageCount,
                totalSavings: sheetViewResults.totalSavings,
              } : null,
              discrepancyCount: discrepancyReport ? discrepancyReport.discrepancyCount : 0,
              discrepancies: discrepancyReport ? discrepancyReport.discrepancies.slice(0, 10) : [],
            },
          });
        } catch (e) {
          console.error('[AUDIT] Log error:', e);
        }
      }

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
    const s = ur.summary;

    // Prefer parser-computed bill totals (sum of ALL rows in the billing cycle,
    // including group-level rows and account-wide adjustments). Those match the
    // carrier's "Current Charges" on the bill. Falls back to profile-summed
    // values — which miss the non-line rows — when only per-line data is
    // available (Verizon, T-Mobile, PDF-only mode).
    const cycles = (data.meta && data.meta.billByCycle) || {};
    const cycleKeys = Object.keys(cycles).sort();
    const bill = cycleKeys.length > 0 ? cycles[cycleKeys[cycleKeys.length - 1]] : null;

    const totalSpend  = bill ? bill.totalCurrent   : (s.billTotal      || s.totalMRC || 0);
    const planTotal   = bill ? bill.monthlyCharges : (s.billPlan       || s.totalMRC || 0);
    const feesTotal   = bill ? bill.fees           : (s.billSurcharges || 0);
    const taxesTotal  = bill ? bill.taxes          : (s.billTaxes      || 0);
    const activityVal = bill ? bill.activity       : (s.billActivity   || 0);
    // Equipment installments always come from the contract file, not bill rows.
    const equipTotal  = s.billEquipment || s.totalEquipment || 0;

    // Hero card: the real "Current Charges" on this month's bill.
    setKPI('kpi-total-spend', fmtMoney(totalSpend));
    setKPI('kpi-avg-cost',    fmtMoney(s.totalLines ? totalSpend / s.totalLines : 0));
    setKPI('kpi-line-count',  s.totalLines || 0);

    // Breakdown cards: each is a line-item from the carrier statement.
    setKPI('kpi-plan-charges', fmtMoney(planTotal));
    setKPI('kpi-equipment',    fmtMoney(equipTotal));
    setKPI('kpi-surcharges',   fmtMoney(feesTotal));
    setKPI('kpi-taxes',        fmtMoney(taxesTotal));

    // Activity is often net-negative (credits outweigh new charges). Render with
    // a minus sign + green so it reads as a credit on the dashboard.
    const activityEl = document.getElementById('kpi-activity');
    if (activityEl) {
      activityEl.textContent = (activityVal < 0 ? '-' : '') + fmtMoney(Math.abs(activityVal));
      activityEl.style.color = activityVal < 0 ? 'var(--success)' : '';
    }

    // Inventory
    setKPI('kpi-total-lines', inv.total);
    setKPI('kpi-smartphones', inv.smartphones);
    setKPI('kpi-tablets', inv.tablets + inv.hotspots);
    setKPI('kpi-wearables', inv.watches);

    // Upgrade eligibility
    setKPI('kpi-upgrade-eligible', ur.summary.upgradeEligible || 0);
    setKPI('kpi-in-contract', ur.summary.inContract || 0);

    // Savings
    setKPI('kpi-total-savings', fmtMoney(zu.totalMonthlySavings));
    setKPI('kpi-zero-lines', zu.totalZeroUsage);
    setKPI('kpi-zero-cost', fmtMoney(zu.cancelSavings + zu.suspendSavings));
    setKPI('kpi-plan-opts', data.ratePlans.summary.highZeroUsagePlans);
    setKPI('kpi-plan-savings', fmtMoney(0)); // placeholder for plan optimization
    setKPI('kpi-annual-savings', fmtMoney(zu.totalMonthlySavings * 12));
  }

  // ═══════════════════════════════════════════════════════
  // RENDER DASHBOARD CHARTS
  // ═══════════════════════════════════════════════════════
  let spendChart = null;
  let deviceChart = null;

  function renderDashboardCharts(data) {
    const ur = data.usageReport;
    const inv = ur.inventory;
    const totalTaxesFees = Object.values(data.profiles).reduce((s, p) => s + (p.taxes || p.latestTaxes || 0) + (p.fees || p.latestFees || 0), 0);
    const totalEquip = ur.summary.totalEquipment || 0;
    const totalMRC = ur.summary.totalMRC || 0;

    // Spend Breakdown Doughnut
    const spendCtx = document.getElementById('chart-spend-breakdown');
    if (spendCtx && typeof Chart !== 'undefined') {
      if (spendChart) spendChart.destroy();
      spendChart = new Chart(spendCtx, {
        type: 'doughnut',
        data: {
          labels: ['Plan Charges (MRC)', 'Equipment', 'Taxes & Fees'],
          datasets: [{
            data: [totalMRC, totalEquip, totalTaxesFees],
            backgroundColor: ['#3b82f6', '#f7931e', '#8b5cf6'],
            borderColor: '#1e1f2a',
            borderWidth: 2,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          cutout: '60%',
          plugins: {
            legend: { position: 'bottom', labels: { color: '#a1a1aa', font: { size: 11, family: 'Inter' }, padding: 12 } },
            title: { display: true, text: 'Spend Breakdown', color: '#e4e4e7', font: { size: 13, weight: 600, family: 'Inter' }, padding: { bottom: 8 } },
            tooltip: {
              callbacks: {
                label: function(ctx) {
                  const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                  const pct = total > 0 ? ((ctx.raw / total) * 100).toFixed(1) : 0;
                  return ` ${ctx.label}: ${fmtMoney(ctx.raw)} (${pct}%)`;
                }
              }
            }
          }
        }
      });
    }

    // Device Distribution Doughnut
    const deviceCtx = document.getElementById('chart-device-distribution');
    if (deviceCtx && typeof Chart !== 'undefined') {
      if (deviceChart) deviceChart.destroy();
      const labels = [];
      const values = [];
      const colors = [];
      if (inv.smartphones > 0) { labels.push('Smartphones'); values.push(inv.smartphones); colors.push('#22c55e'); }
      if ((inv.tablets + inv.hotspots) > 0) { labels.push('Tablets / Hotspots'); values.push(inv.tablets + inv.hotspots); colors.push('#3b82f6'); }
      if (inv.watches > 0) { labels.push('Wearables'); values.push(inv.watches); colors.push('#eab308'); }
      const other = inv.total - inv.smartphones - inv.tablets - inv.hotspots - inv.watches;
      if (other > 0) { labels.push('Other'); values.push(other); colors.push('#6b6b76'); }

      deviceChart = new Chart(deviceCtx, {
        type: 'doughnut',
        data: {
          labels: labels,
          datasets: [{
            data: values,
            backgroundColor: colors,
            borderColor: '#1e1f2a',
            borderWidth: 2,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          cutout: '60%',
          plugins: {
            legend: { position: 'bottom', labels: { color: '#a1a1aa', font: { size: 11, family: 'Inter' }, padding: 12 } },
            title: { display: true, text: 'Device Distribution', color: '#e4e4e7', font: { size: 13, weight: 600, family: 'Inter' }, padding: { bottom: 8 } },
            tooltip: {
              callbacks: {
                label: function(ctx) {
                  const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                  const pct = total > 0 ? ((ctx.raw / total) * 100).toFixed(1) : 0;
                  return ` ${ctx.label}: ${ctx.raw} lines (${pct}%)`;
                }
              }
            }
          }
        }
      });
    }
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

    // Tangoe: no usage data — show explanation instead of empty state
    if (data.meta && data.meta.source === 'tangoe' && data.zeroUsageResults.length === 0) {
      if (countEl) countEl.textContent = 'Not available — Tangoe exports contain charges only, no usage metrics';
      if (emptyEl) {
        emptyEl.innerHTML = '<p style="color:#a78bfa">Zero-usage analysis requires per-line usage data (GB / voice / text). Tangoe Inventory Snapshot exports do not include usage metrics — this tab is not available for Tangoe audits.</p>';
        emptyEl.classList.remove('hidden');
      }
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

    const ur = data.usageReport;
    const upgradeCount = ur.summary.upgradeEligible || 0;
    const contractCount = ur.summary.inContract || 0;
    const isTangoe = data.meta && data.meta.source === 'tangoe';

    let html = '';
    if (isTangoe) {
      html += `<div style="margin-bottom:12px;padding:10px 14px;background:rgba(124,58,237,0.12);border:1px solid rgba(124,58,237,0.3);border-radius:8px;color:#a78bfa;font-size:12px">
        <strong>Tangoe export:</strong> No usage data available (GB / voice / text). Data, Voice, and Text columns will show 0. Zero-usage detection is disabled for this source.
      </div>`;
    }
    html += `<div style="margin-bottom:12px;font-size:13px;color:var(--text-secondary);display:flex;gap:16px;flex-wrap:wrap;align-items:center">
      <span>${ur.summary.totalLines} lines</span>
      <span>Total MRC: ${fmtMoney(ur.summary.totalMRC)}</span>
      <span>Avg: ${fmtMoney(ur.summary.avgChargesPerLine)}/line</span>
      <span style="color:#22c55e;font-weight:600">${upgradeCount} upgrade eligible</span>
      <span style="color:#ef4444">${contractCount} in contract</span>
    </div>
    <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="background:#1a3a5c;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:0.03em">
        <th style="padding:8px 10px">Wireless</th>
        <th style="padding:8px 10px">User Name</th>
        <th style="padding:8px 10px">Device</th>
        <th style="padding:8px 10px">Rate Plan</th>
        <th style="padding:8px 10px;text-align:right">MRC</th>
        <th style="padding:8px 10px;text-align:right">Data (GB)</th>
        <th style="padding:8px 10px;text-align:right">Voice</th>
        <th style="padding:8px 10px;text-align:right">Text</th>
        <th style="padding:8px 10px;text-align:center">Contract?</th>
        <th style="padding:8px 10px">Installment</th>
        <th style="padding:8px 10px;text-align:right">Equip $/mo</th>
        <th style="padding:8px 10px">Zero?</th>
      </tr></thead><tbody>`;

    for (const l of ur.lines) {
      const contractBadge = l.hasActiveContract
        ? '<span style="background:rgba(239,68,68,0.15);color:#ef4444;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600">YES</span>'
        : '<span style="background:rgba(34,197,94,0.15);color:#22c55e;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600">NO</span>';

      html += `<tr style="border-bottom:1px solid rgba(255,255,255,0.05)">
        <td style="padding:6px 10px;font-variant-numeric:tabular-nums">${l.wireless}</td>
        <td style="padding:6px 10px">${l.userName}</td>
        <td style="padding:6px 10px">${l.deviceType || ''}</td>
        <td style="padding:6px 10px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${l.ratePlan}">${l.ratePlan || ''}</td>
        <td style="padding:6px 10px;text-align:right;font-variant-numeric:tabular-nums">${fmtMoney(l.mrc)}</td>
        <td style="padding:6px 10px;text-align:right;font-variant-numeric:tabular-nums">${l.gbTotal.toFixed(2)}</td>
        <td style="padding:6px 10px;text-align:right;font-variant-numeric:tabular-nums">${l.minTotal || 0}</td>
        <td style="padding:6px 10px;text-align:right;font-variant-numeric:tabular-nums">${l.msgTotal || 0}</td>
        <td style="padding:6px 10px;text-align:center">${contractBadge}</td>
        <td style="padding:6px 10px;font-size:11px">${l.equipmentInstallment || '-'}</td>
        <td style="padding:6px 10px;text-align:right;font-variant-numeric:tabular-nums">${l.equipmentCharges > 0 ? fmtMoney(l.equipmentCharges) : '-'}</td>
        <td style="padding:6px 10px;${l.zeroUsage ? 'color:#ef4444;font-weight:600' : ''}">${l.zeroUsage ? 'YES' : ''}</td>
      </tr>`;
    }
    html += '</tbody></table></div>';
    panel.innerHTML = html;
  }

  // ═══════════════════════════════════════════════════════
  // POPULATE RATE PLAN TABLE
  // ═══════════════════════════════════════════════════════
  function populateRatePlanTable(data) {
    // Populate the existing summary table
    const tbody = document.getElementById('rateplan-summary-tbody');
    const countEl = document.getElementById('rateplan-summary-count');
    const emptyEl = document.getElementById('rateplan-summary-empty');

    const gdCount = data.ratePlans.summary.groupDiscountPlans || 0;
    if (countEl) countEl.textContent = `${data.ratePlans.summary.uniquePlans} plans | ${data.ratePlans.summary.totalLines} lines${gdCount ? ` | ${gdCount} group discount` : ''}`;

    if (tbody) {
      let html = '';
      for (const p of data.ratePlans.plans) {
        // Check if plan exists in the rate plan database
        const allPlans = window.RatePlanLogger.getAllPlans();
        const dbMatch = allPlans.find(lp => lp.planName === p.planName && lp.carrier === data.carrier);
        const matchBadge = dbMatch
          ? `<span style="background:rgba(34,197,94,0.15);color:#22c55e;padding:2px 6px;border-radius:4px;font-size:10px">KNOWN</span>`
          : `<span style="background:rgba(247,147,30,0.15);color:#f7931e;padding:2px 6px;border-radius:4px;font-size:10px">NEW</span>`;

        // Group discount badge
        const gd = p.groupDiscount || {};
        const gdBadge = gd.detected
          ? `<span style="background:rgba(59,130,246,0.15);color:#3b82f6;padding:2px 6px;border-radius:4px;font-size:10px" title="${gd.tier}">${gd.tier}</span>`
          : '';

        html += `<tr>
          <td title="${p.planName}">${p.planName}</td>
          <td style="font-size:11px;color:var(--text-muted);font-family:monospace">${p.rateCode || ''}</td>
          <td class="number">${p.lineCount}</td>
          <td class="number">${fmtMoney(p.perLine)}</td>
          <td class="number">${fmtMoney(p.totalMonthly)}</td>
          <td style="text-align:center">${gdBadge}</td>
          <td style="text-align:center">${matchBadge}</td>
        </tr>`;
      }
      // Total row
      html += `<tr style="background:rgba(34,197,94,0.08);font-weight:600">
        <td>TOTAL</td>
        <td></td>
        <td class="number">${data.ratePlans.summary.totalLines}</td>
        <td class="number">${fmtMoney(data.ratePlans.summary.totalMonthly / Math.max(data.ratePlans.summary.totalLines, 1))}</td>
        <td class="number">${fmtMoney(data.ratePlans.summary.totalMonthly)}</td>
        <td></td>
        <td></td>
      </tr>`;
      tbody.innerHTML = html;
      if (emptyEl) emptyEl.classList.add('hidden');
    }

    // Populate the log viewer
    const logViewer = document.getElementById('rateplan-log-viewer');
    if (logViewer) {
      const now = new Date().toLocaleTimeString('en-US', { hour12: false });
      let logHtml = '';

      // Log each plan
      for (const p of data.ratePlans.plans) {
        const allPlans = window.RatePlanLogger.getAllPlans();
        const dbMatch = allPlans.find(lp => lp.planName === p.planName && lp.carrier === data.carrier);
        const type = dbMatch && dbMatch.occurrences > 1 ? 'match' : 'miss';
        const typeLabel = type === 'match' ? 'MATCH' : 'NEW';
        const typeClass = type === 'match' ? 'success' : 'warning';

        const codeStr = p.rateCode ? ` [${p.rateCode}]` : '';
        const gdStr = p.groupDiscount && p.groupDiscount.detected ? ` | ${p.groupDiscount.tier}` : '';

        logHtml += `<div class="log-entry">
          <span class="log-entry-time">${now}</span>
          <span class="log-entry-type ${typeClass}">${typeLabel}</span>
          <span class="log-entry-msg">${p.planName}${codeStr} — ${p.lineCount} lines @ ${fmtMoney(p.perLine)}/line${gdStr}${dbMatch ? ` (seen ${dbMatch.occurrences}x across ${dbMatch.clients.length} client(s))` : ' — first time seeing this plan'}</span>
        </div>`;
      }

      // Summary entry
      const stats = window.RatePlanLogger.getStats();
      logHtml += `<div class="log-entry">
        <span class="log-entry-time">${now}</span>
        <span class="log-entry-type info">INFO</span>
        <span class="log-entry-msg">Rate Plan Database: ${stats.totalPlans} unique plans logged across ${stats.clients.length} client(s). ${data.ratePlans.plans.length} plans processed this audit.</span>
      </div>`;

      logViewer.innerHTML = logHtml;
    }
  }

  // ═══════════════════════════════════════════════════════
  // POPULATE PLAN COMPARISON TABLE
  // ═══════════════════════════════════════════════════════
  function populatePlanComparison(data) {
    if (window.PlanComparison) {
      window.PlanComparison.populate(data.profiles);
    }
  }

  // ═══════════════════════════════════════════════════════
  // WIRE EXPORT BUTTONS
  // ═══════════════════════════════════════════════════════
  function wireExportButtons(data) {
    const pdfBtn = document.getElementById('btn-export-pdf');
    const xlsBtn = document.getElementById('btn-export-excel');
    const csvBtn = document.getElementById('btn-export-csv');
    const planBtn = document.getElementById('btn-export-ratedb');

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
          planComparison: window.PlanComparison ? window.PlanComparison.getProposals() : [],
          planComparisonSummary: window.PlanComparison ? window.PlanComparison.getSummary() : null,
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