/**
 * SheetView — Independent calculation path replicating Google Sheet formulas EXACTLY.
 *
 * This module does NOT reuse Tool View logic. It builds its own data structures
 * from the raw billing and contract rows, mimicking spreadsheet VLOOKUP/SUMIF/UNIQUE
 * operations so the two calculation paths can be compared.
 *
 * Exports: window.SheetView = { calculate, renderSheetUsageReport, renderSheetZeroUsageReport, getResults }
 */
(function () {
  'use strict';

  // ─── Internal state ────────────────────────────────────────────────────────
  let _results = null;

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * VLOOKUP equivalent: find the FIRST row in `rows` where `rows[row][keyField] === lookupValue`,
   * then return `rows[row][valueField]`. Returns `fallback` if no match.
   */
  function vlookup(rows, keyField, lookupValue, valueField, fallback) {
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][keyField] === lookupValue) {
        const val = rows[i][valueField];
        return val !== undefined && val !== null ? val : fallback;
      }
    }
    return fallback;
  }

  /**
   * UNIQUE equivalent: return an array of unique values from `rows[row][field]`,
   * preserving first-occurrence order.
   */
  function unique(rows, field) {
    const seen = new Set();
    const result = [];
    for (let i = 0; i < rows.length; i++) {
      const val = rows[i][field];
      if (val !== undefined && val !== null && val !== '' && !seen.has(val)) {
        seen.add(val);
        result.push(val);
      }
    }
    return result;
  }

  /**
   * SUMIF equivalent: sum `rows[row][sumField]` for every row where
   * `rows[row][keyField] === criteria`.
   */
  function sumif(rows, keyField, criteria, sumField) {
    let total = 0;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][keyField] === criteria) {
        const val = parseFloat(rows[i][sumField]);
        if (!isNaN(val)) {
          total += val;
        }
      }
    }
    return total;
  }

  /**
   * Parse a date string into a Date object. Returns null if unparseable.
   * Handles common US date formats (MM/DD/YYYY, M/D/YYYY, YYYY-MM-DD, etc.)
   */
  function parseDate(str) {
    if (!str || typeof str !== 'string') return null;
    const trimmed = str.trim();
    if (trimmed === '') return null;

    // Try ISO format first (YYYY-MM-DD)
    const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (isoMatch) {
      const d = new Date(+isoMatch[1], +isoMatch[2] - 1, +isoMatch[3]);
      if (!isNaN(d.getTime())) return d;
    }

    // US slash format (M/D/YYYY or MM/DD/YYYY)
    const usMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (usMatch) {
      const d = new Date(+usMatch[3], +usMatch[1] - 1, +usMatch[2]);
      if (!isNaN(d.getTime())) return d;
    }

    // Fallback to native parser
    const d = new Date(trimmed);
    return isNaN(d.getTime()) ? null : d;
  }

  /**
   * Format a date as MM/DD/YYYY for display (matching Google Sheet formatting).
   */
  function formatDate(date) {
    if (!date || !(date instanceof Date) || isNaN(date.getTime())) return '';
    const m = date.getMonth() + 1;
    const d = date.getDate();
    const y = date.getFullYear();
    return m + '/' + d + '/' + y;
  }

  /**
   * Format a number for display — matches spreadsheet cell rendering.
   */
  function formatNum(val, decimals) {
    if (val === '' || val === null || val === undefined) return '';
    const n = parseFloat(val);
    if (isNaN(n)) return '';
    return n.toFixed(decimals);
  }

  /**
   * Format currency value.
   */
  function formatCurrency(val) {
    if (val === '' || val === null || val === undefined) return '';
    const n = parseFloat(val);
    if (isNaN(n)) return '';
    return '$' + n.toFixed(2);
  }

  // ─── Core Calculation ───────────────────────────────────────────────────────

  /**
   * Calculate results using Google Sheet formulas EXACTLY.
   *
   * @param {Array} billingRows  — raw parsed billing rows from ATTParser.parseBilling
   *   Each: { wireless, userName, rateCode, ratePlan, cycleDate, totalCurrent,
   *           monthlyCharges, activity, taxes, fees, kbUsage, minUsage, msgUsage, adjustments }
   *
   * @param {Array} contractRows — raw parsed contract rows from ATTParser.parseContract
   *   Each: { wireless, userName, status, monthlyInstallment, contractType,
   *           contractStart, contractEnd, contractEndDate, contractTerm,
   *           contractStatus, deviceType, deviceMake, deviceModel, activationDate,
   *           remainingMonths, hasActiveContract, etf }
   *
   * @returns {Object} results
   */
  function calculate(billingRows, contractRows) {
    billingRows = billingRows || [];
    contractRows = contractRows || [];

    // ── Column A: UNIQUE wireless numbers from CONTRACT data only ──
    // This is the fundamental difference from Tool View: the line list comes
    // from the upgrade eligibility file, not from billing.
    const wirelessNumbers = unique(contractRows, 'wireless');

    const usageLines = [];

    for (let i = 0; i < wirelessNumbers.length; i++) {
      const num = wirelessNumbers[i];

      // ── Column B: User Name — VLOOKUP into billing, FIRST match ──
      // =IFERROR(VLOOKUP(A, billingData col C:H, 6, 0), "")
      // Col C = wireless, col H = userName → offset 6 from C → field "userName"
      const userName = vlookup(billingRows, 'wireless', num, 'userName', '');

      // ── Column C: Device Type — VLOOKUP into contract, FIRST match ──
      // =IFERROR(VLOOKUP(A, contractData col D:Z, 23, 0), "")
      // Col D = wireless, col Z = deviceType → offset 23 from D → field "deviceType"
      const deviceType = vlookup(contractRows, 'wireless', num, 'deviceType', '');

      // ── Column D: 90 Day GB Total ──
      // =SUM(SUMIF(billingData col C, A, billingData col Q)) / 1048576
      // Col Q = kbUsage
      const kbTotal = sumif(billingRows, 'wireless', num, 'kbUsage');
      const gbTotal90 = kbTotal / 1048576;

      // ── Column E: 90 Day GB Avg ──
      // =D / 3 — HARDCODED divide by 3
      const gbAvg90 = gbTotal90 / 3;

      // ── Column F: 90 Day Minute Total ──
      // =SUM(SUMIF(billingData col C, A, billingData col R))
      // Col R = minUsage
      const minTotal90 = sumif(billingRows, 'wireless', num, 'minUsage');

      // ── Column G: 90 Day Minute Avg ──
      // =F / 3 — HARDCODED /3
      const minAvg90 = minTotal90 / 3;

      // ── Column H: 90 Day Message Total ──
      // =SUM(SUMIF(billingData col C, A, billingData col S))
      // Col S = msgUsage
      const msgTotal90 = sumif(billingRows, 'wireless', num, 'msgUsage');

      // ── Column I: 90 Day Message Avg ──
      // =H / 3 — HARDCODED /3
      const msgAvg90 = msgTotal90 / 3;

      // ── Column J: MRC — VLOOKUP into billing, FIRST match ──
      // =IFERROR(VLOOKUP(A, billingData col C:M, 10, 0), "")
      // Col C = wireless, col M = monthlyCharges → offset 10 from C → field "monthlyCharges"
      // KEY DIFFERENCE: Takes FIRST matching row's monthly charge only, NOT averaged.
      const mrcRaw = vlookup(billingRows, 'wireless', num, 'monthlyCharges', '');
      const mrc = mrcRaw !== '' ? parseFloat(mrcRaw) : 0;
      const mrcDisplay = isNaN(mrc) ? '' : mrc;

      // ── Column K: Contract End Date — VLOOKUP into contract, FIRST match ──
      // =IFERROR(VLOOKUP(A, contractData col D:W, 20, 0), "")
      // Col D = wireless, col W = contractEnd → offset 20 from D → field "contractEnd"
      const contractEndDateRaw = vlookup(contractRows, 'wireless', num, 'contractEnd', '');
      const contractEndDateParsed = parseDate(contractEndDateRaw);

      usageLines.push({
        wirelessNumber: num,
        userName: userName,
        deviceType: deviceType,
        gbTotal90: gbTotal90,
        gbAvg90: gbAvg90,
        minTotal90: minTotal90,
        minAvg90: minAvg90,
        msgTotal90: msgTotal90,
        msgAvg90: msgAvg90,
        mrc: mrcDisplay,
        contractEndDate: contractEndDateRaw,
        contractEndDateParsed: contractEndDateParsed
      });
    }

    // ── Zero Usage Report: filter where ALL three usage totals are zero/empty ──
    const zeroUsageLines = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    for (let i = 0; i < usageLines.length; i++) {
      const line = usageLines[i];
      const gbIsZero = !line.gbTotal90 || line.gbTotal90 === 0;
      const minIsZero = !line.minTotal90 || line.minTotal90 === 0;
      const msgIsZero = !line.msgTotal90 || line.msgTotal90 === 0;

      if (gbIsZero && minIsZero && msgIsZero) {
        // Determine out-of-contract status
        // Out of contract if: contract end date is blank, OR contract end date <= today
        const isOutOfContract = !line.contractEndDateParsed ||
          line.contractEndDateParsed.getTime() <= today.getTime();

        // Included in savings sum if out of contract
        // =SUMIFS(MRC, ContractEnd, "<="&TODAY(), ContractEnd, "<>"&TODAY()+1)
        //   + SUMIFS(MRC, ContractEnd, "")
        // First SUMIFS: contractEnd <= today AND contractEnd != tomorrow (i.e. strictly <= today)
        // Second SUMIFS: contractEnd is blank
        let inSavingsCalc = false;
        if (!line.contractEndDateParsed) {
          // Blank contract end date — second SUMIFS condition
          inSavingsCalc = true;
        } else if (line.contractEndDateParsed.getTime() <= today.getTime() &&
                   line.contractEndDateParsed.getTime() !== tomorrow.getTime()) {
          // <= today AND not tomorrow (tomorrow would be > today so this simplifies to just <= today)
          inSavingsCalc = true;
        }

        zeroUsageLines.push({
          wirelessNumber: line.wirelessNumber,
          userName: line.userName,
          deviceType: line.deviceType,
          gbTotal90: line.gbTotal90,
          gbAvg90: line.gbAvg90,
          minTotal90: line.minTotal90,
          minAvg90: line.minAvg90,
          msgTotal90: line.msgTotal90,
          msgAvg90: line.msgAvg90,
          mrc: line.mrc,
          contractEndDate: line.contractEndDate,
          contractEndDateParsed: line.contractEndDateParsed,
          isOutOfContract: isOutOfContract,
          inSavingsCalc: inSavingsCalc
        });
      }
    }

    // ── Total Savings: SUMIFS ──
    // =SUMIFS(MRC, ContractEnd, "<="&TODAY(), ContractEnd, "<>"&TODAY()+1)
    //   + SUMIFS(MRC, ContractEnd, "")
    let totalSavings = 0;
    for (let i = 0; i < zeroUsageLines.length; i++) {
      if (zeroUsageLines[i].inSavingsCalc) {
        const mrcVal = parseFloat(zeroUsageLines[i].mrc);
        if (!isNaN(mrcVal)) {
          totalSavings += mrcVal;
        }
      }
    }

    _results = {
      usageLines: usageLines,
      zeroUsageLines: zeroUsageLines,
      totalSavings: totalSavings,
      totalLines: usageLines.length,
      zeroUsageCount: zeroUsageLines.length
    };

    return _results;
  }

  // ─── Rendering ──────────────────────────────────────────────────────────────

  /**
   * Column headers matching the Google Sheet "Usage Report" tab exactly.
   */
  const USAGE_COLUMNS = [
    { key: 'wirelessNumber',   label: 'A — Wireless Number',        fmt: null },
    { key: 'userName',         label: 'B — User Name',               fmt: null },
    { key: 'deviceType',      label: 'C — Device Type',             fmt: null },
    { key: 'gbTotal90',       label: 'D — 90 Day GB Total',         fmt: 2 },
    { key: 'gbAvg90',         label: 'E — 90 Day GB Avg',           fmt: 2 },
    { key: 'minTotal90',      label: 'F — 90 Day Min Total',        fmt: 0 },
    { key: 'minAvg90',        label: 'G — 90 Day Min Avg',          fmt: 1 },
    { key: 'msgTotal90',      label: 'H — 90 Day Msg Total',        fmt: 0 },
    { key: 'msgAvg90',        label: 'I — 90 Day Msg Avg',          fmt: 1 },
    { key: 'mrc',             label: 'J — MRC',                     fmt: 'currency' },
    { key: 'contractEndDate', label: 'K — Contract End Date',       fmt: 'date' }
  ];

  const ZERO_COLUMNS = [
    { key: 'wirelessNumber',   label: 'A — Wireless Number',        fmt: null },
    { key: 'userName',         label: 'B — User Name',               fmt: null },
    { key: 'deviceType',      label: 'C — Device Type',             fmt: null },
    { key: 'gbTotal90',       label: 'D — 90 Day GB Total',         fmt: 2 },
    { key: 'gbAvg90',         label: 'E — 90 Day GB Avg',           fmt: 2 },
    { key: 'minTotal90',      label: 'F — 90 Day Min Total',        fmt: 0 },
    { key: 'minAvg90',        label: 'G — 90 Day Min Avg',          fmt: 1 },
    { key: 'msgTotal90',      label: 'H — 90 Day Msg Total',        fmt: 0 },
    { key: 'msgAvg90',        label: 'I — 90 Day Msg Avg',          fmt: 1 },
    { key: 'mrc',             label: 'J — MRC',                     fmt: 'currency' },
    { key: 'contractEndDate', label: 'K — Contract End Date',       fmt: 'date' },
    { key: 'isOutOfContract', label: 'Out of Contract',             fmt: 'bool' },
    { key: 'inSavingsCalc',   label: 'In Savings Calc',             fmt: 'bool' }
  ];

  /**
   * Format a cell value for display.
   */
  function formatCell(val, fmt) {
    if (val === '' || val === null || val === undefined) return '';
    if (fmt === 'currency') return formatCurrency(val);
    if (fmt === 'date') return formatDate(parseDate(val));
    if (fmt === 'bool') return val ? 'Yes' : 'No';
    if (typeof fmt === 'number') return formatNum(val, fmt);
    return String(val);
  }

  /**
   * Build a spreadsheet-style table from column definitions and row data.
   */
  function buildTable(columns, rows, tableClass) {
    const table = document.createElement('table');
    table.className = 'sheet-table ' + (tableClass || '');

    // Header row
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (let c = 0; c < columns.length; c++) {
      const th = document.createElement('th');
      th.textContent = columns[c].label;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Body rows
    const tbody = document.createElement('tbody');
    for (let r = 0; r < rows.length; r++) {
      const tr = document.createElement('tr');
      for (let c = 0; c < columns.length; c++) {
        const td = document.createElement('td');
        const rawVal = rows[r][columns[c].key];
        td.textContent = formatCell(rawVal, columns[c].fmt);

        // Add subtle styling classes for numeric columns
        if (columns[c].fmt === 'currency') {
          td.className = 'cell-currency';
        } else if (typeof columns[c].fmt === 'number') {
          td.className = 'cell-numeric';
        }

        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    return table;
  }

  /**
   * Render the Usage Report (Google Sheet "Usage Report" tab replica).
   *
   * @param {Object} results   — the results object from calculate()
   * @param {HTMLElement} container — DOM element to render into
   */
  function renderSheetUsageReport(results, container) {
    if (!container) return;
    container.innerHTML = '';

    // Title
    const title = document.createElement('h2');
    title.textContent = 'Sheet View — Usage Report';
    title.className = 'sheet-report-title';
    container.appendChild(title);

    // Subtitle
    const subtitle = document.createElement('p');
    subtitle.className = 'sheet-report-subtitle';
    subtitle.textContent = 'Replicates Google Sheet "Usage Report" tab formulas exactly. ' +
      'Line source: UNIQUE contract/upgrade eligibility wireless numbers. ' +
      'Averages: hardcoded /3. MRC: VLOOKUP first match (not averaged).';
    container.appendChild(subtitle);

    // Line count
    const countEl = document.createElement('p');
    countEl.className = 'sheet-report-count';
    countEl.textContent = 'Total lines: ' + (results ? results.totalLines : 0);
    container.appendChild(countEl);

    if (!results || !results.usageLines || results.usageLines.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'sheet-empty';
      empty.textContent = 'No usage data to display.';
      container.appendChild(empty);
      return;
    }

    // Build and append table
    const table = buildTable(USAGE_COLUMNS, results.usageLines, 'usage-report');
    container.appendChild(table);
  }

  /**
   * Render the Zero Usage Report (Google Sheet "Zero Usage Report" tab replica).
   *
   * @param {Object} results   — the results object from calculate()
   * @param {HTMLElement} container — DOM element to render into
   */
  function renderSheetZeroUsageReport(results, container) {
    if (!container) return;
    container.innerHTML = '';

    // Title
    const title = document.createElement('h2');
    title.textContent = 'Sheet View — Zero Usage Report';
    title.className = 'sheet-report-title';
    container.appendChild(title);

    // Subtitle
    const subtitle = document.createElement('p');
    subtitle.className = 'sheet-report-subtitle';
    subtitle.textContent = 'Replicates Google Sheet "Zero Usage Report" tab. ' +
      'Filters: all three usage totals = 0. ' +
      'Savings: SUMIFS MRC where out-of-contract or no contract date (simple sum, no cancel/suspend tree).';
    container.appendChild(subtitle);

    if (!results || !results.zeroUsageLines || results.zeroUsageLines.length === 0) {
      const countEl = document.createElement('p');
      countEl.className = 'sheet-report-count';
      countEl.textContent = 'Zero usage lines: 0 | Potential savings: $0.00';
      container.appendChild(countEl);

      const empty = document.createElement('p');
      empty.className = 'sheet-empty';
      empty.textContent = 'No zero-usage lines found.';
      container.appendChild(empty);
      return;
    }

    // Savings summary at top
    const savingsEl = document.createElement('div');
    savingsEl.className = 'sheet-savings-summary';

    const savingsLabel = document.createElement('span');
    savingsLabel.className = 'sheet-savings-label';
    savingsLabel.textContent = 'Potential Monthly Savings (Out-of-Contract Zero Usage): ';
    savingsEl.appendChild(savingsLabel);

    const savingsValue = document.createElement('span');
    savingsValue.className = 'sheet-savings-value';
    savingsValue.textContent = formatCurrency(results.totalSavings);
    savingsEl.appendChild(savingsValue);

    container.appendChild(savingsEl);

    // Counts
    const countEl = document.createElement('p');
    countEl.className = 'sheet-report-count';
    countEl.textContent =
      'Zero usage lines: ' + results.zeroUsageCount +
      ' | Out of contract: ' + results.zeroUsageLines.filter(function (l) { return l.isOutOfContract; }).length +
      ' | In savings calc: ' + results.zeroUsageLines.filter(function (l) { return l.inSavingsCalc; }).length;
    container.appendChild(countEl);

    // Build and append table
    const table = buildTable(ZERO_COLUMNS, results.zeroUsageLines, 'zero-usage-report');
    container.appendChild(table);
  }

  /**
   * Return the last calculated results object.
   */
  function getResults() {
    return _results;
  }

  // ─── Export ─────────────────────────────────────────────────────────────────
  window.SheetView = {
    calculate: calculate,
    renderSheetUsageReport: renderSheetUsageReport,
    renderSheetZeroUsageReport: renderSheetZeroUsageReport,
    getResults: getResults
  };

})();