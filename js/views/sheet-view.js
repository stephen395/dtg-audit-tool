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

  // ─── Rendering (Tabulator editable grids) ──────────────────────────────────
  //
  // Each Sheet-View tab renders as an interactive Tabulator grid that feels
  // like Google Sheets: click a cell to edit, drag the column edge to resize,
  // type in the header filter to narrow rows, sort by clicking a header. Copy
  // in / copy out work with Ctrl+C / Ctrl+V against any external spreadsheet.
  // A "Download as Excel" button on each tab exports the current (possibly
  // edited) grid state as .xlsx via SheetJS.

  /**
   * Tabulator column definitions for the Usage Report tab.
   * Mirrors the Google Sheet's Usage Report tab layout & column order.
   * Every column is editable so the sheet feels live.
   */
  const USAGE_COLUMNS = [
    { title: 'Wireless Number', field: 'wirelessNumber', editor: 'input', headerFilter: 'input', width: 140 },
    { title: 'User Name',       field: 'userName',       editor: 'input', headerFilter: 'input', width: 200 },
    { title: 'Device Type',     field: 'deviceType',     editor: 'input', headerFilter: 'input', width: 140 },
    { title: '90-Day GB Total', field: 'gbTotal90',      editor: 'number', hozAlign: 'right',
      formatter: (c) => numFmt(c.getValue(), 4), bottomCalc: 'sum', bottomCalcFormatter: (c) => numFmt(c.getValue(), 2) },
    { title: '90-Day GB Avg',   field: 'gbAvg90',        editor: 'number', hozAlign: 'right',
      formatter: (c) => numFmt(c.getValue(), 4) },
    { title: '90-Day Min Total',field: 'minTotal90',     editor: 'number', hozAlign: 'right',
      formatter: (c) => numFmt(c.getValue(), 0), bottomCalc: 'sum' },
    { title: '90-Day Min Avg',  field: 'minAvg90',       editor: 'number', hozAlign: 'right',
      formatter: (c) => numFmt(c.getValue(), 1) },
    { title: '90-Day Msg Total',field: 'msgTotal90',     editor: 'number', hozAlign: 'right',
      formatter: (c) => numFmt(c.getValue(), 0), bottomCalc: 'sum' },
    { title: '90-Day Msg Avg',  field: 'msgAvg90',       editor: 'number', hozAlign: 'right',
      formatter: (c) => numFmt(c.getValue(), 1) },
    { title: 'MRC',             field: 'mrc',            editor: 'number', hozAlign: 'right',
      formatter: (c) => currencyFmt(c.getValue()),
      bottomCalc: 'sum', bottomCalcFormatter: (c) => currencyFmt(c.getValue()) },
    { title: 'Contract End',    field: 'contractEndDate',editor: 'input', headerFilter: 'input',
      formatter: (c) => {
        const raw = c.getValue();
        const d = parseDate(raw);
        return d ? formatDate(d) : (raw || '');
      } },
  ];

  const ZERO_COLUMNS = USAGE_COLUMNS.concat([
    { title: 'Out of Contract', field: 'isOutOfContract', hozAlign: 'center',
      formatter: 'tickCross', formatterParams: { allowEmpty: true }, editor: 'tickCross' },
    { title: 'In Savings',      field: 'inSavingsCalc',   hozAlign: 'center',
      formatter: 'tickCross', formatterParams: { allowEmpty: true }, editor: 'tickCross' },
  ]);

  function numFmt(v, decimals) {
    if (v === '' || v === null || v === undefined) return '';
    const n = parseFloat(v);
    if (isNaN(n)) return '';
    return n.toFixed(decimals);
  }
  function currencyFmt(v) {
    if (v === '' || v === null || v === undefined) return '';
    const n = parseFloat(v);
    if (isNaN(n)) return '';
    return '$' + n.toFixed(2);
  }

  // Track the live Tabulator instances so Download / re-render can reach them.
  const _tables = { usage: null, zero: null };

  /**
   * Render an editable Tabulator grid into `container`, with a Download-as-
   * Excel button pinned at the top.
   */
  function renderGrid(opts) {
    const { container, columns, data, tableKey, title, subtitle, summary, filename, sheetName } = opts;
    if (!container) return;
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'sheet-grid-wrapper';
    wrapper.style.cssText = 'display:flex;flex-direction:column;gap:8px;height:100%;';

    // Header: title + download button in one row
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;';

    const titleBlock = document.createElement('div');
    const h2 = document.createElement('h2');
    h2.textContent = title;
    h2.style.cssText = 'font-size:16px;font-weight:700;margin:0;color:var(--text);';
    titleBlock.appendChild(h2);
    if (subtitle) {
      const p = document.createElement('p');
      p.textContent = subtitle;
      p.style.cssText = 'font-size:12px;color:var(--text-secondary);margin:4px 0 0;';
      titleBlock.appendChild(p);
    }
    header.appendChild(titleBlock);

    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.textContent = '⬇ Download as Excel';
    dlBtn.style.cssText = 'background:var(--accent);color:#000;border:none;border-radius:6px;padding:8px 14px;font-weight:600;font-size:12px;cursor:pointer;white-space:nowrap;';
    dlBtn.addEventListener('click', () => {
      const t = _tables[tableKey];
      if (!t) return;
      t.download('xlsx', filename, { sheetName: sheetName });
    });
    header.appendChild(dlBtn);
    wrapper.appendChild(header);

    // Optional summary strip (savings etc.)
    if (summary) {
      const summaryEl = document.createElement('div');
      summaryEl.style.cssText = 'padding:10px 14px;background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);border-radius:6px;color:#22c55e;font-weight:600;font-size:13px;';
      summaryEl.textContent = summary;
      wrapper.appendChild(summaryEl);
    }

    // The grid itself
    const gridDiv = document.createElement('div');
    gridDiv.style.cssText = 'flex:1 1 auto;min-height:500px;';
    wrapper.appendChild(gridDiv);

    container.appendChild(wrapper);

    // Destroy any prior instance before re-rendering (prevents stale state when
    // the user re-runs an audit within the same session).
    if (_tables[tableKey]) {
      try { _tables[tableKey].destroy(); } catch (e) { /* ignore */ }
      _tables[tableKey] = null;
    }

    _tables[tableKey] = new Tabulator(gridDiv, {
      data: data,
      columns: columns,
      layout: 'fitDataStretch',          // each column sized to its content, last fills
      height: '600px',
      movableColumns: true,              // drag to reorder
      resizableColumns: true,            // drag edge to resize
      resizableRows: false,
      reactiveData: true,                // edits flow back to the data array
      clipboard: true,                   // Ctrl+C / Ctrl+V against the grid
      clipboardPasteAction: 'replace',   // paste into selected range overwrites
      selectable: true,                  // click + drag to select a range
      history: true,                     // Ctrl+Z / Ctrl+Y undo/redo
      pagination: false,                 // a single scrollable sheet feels more "Google Sheet"
    });
  }

  /** Public: render the Usage Report tab as an editable grid. */
  function renderSheetUsageReport(results, container) {
    renderGrid({
      container,
      columns: USAGE_COLUMNS,
      data: (results && results.usageLines) ? results.usageLines.slice() : [],
      tableKey: 'usage',
      title: 'Sheet View — Usage Report',
      subtitle: (results ? results.totalLines : 0) + ' lines · click any cell to edit · drag column edges to resize · sort and filter per column',
      filename: 'Usage_Report.xlsx',
      sheetName: 'Usage Report',
    });
  }

  /** Public: render the Zero Usage Report tab as an editable grid. */
  function renderSheetZeroUsageReport(results, container) {
    const count = results && results.zeroUsageLines ? results.zeroUsageLines.length : 0;
    const outOfContract = results && results.zeroUsageLines
      ? results.zeroUsageLines.filter(l => l.isOutOfContract).length : 0;
    const savings = results ? (results.totalSavings || 0) : 0;

    renderGrid({
      container,
      columns: ZERO_COLUMNS,
      data: (results && results.zeroUsageLines) ? results.zeroUsageLines.slice() : [],
      tableKey: 'zero',
      title: 'Sheet View — Zero Usage Report',
      subtitle: `${count} zero-usage lines · ${outOfContract} out of contract`,
      summary: `Cancelling out-of-contract lines could save → ${currencyFmt(savings)}/month`,
      filename: 'Zero_Usage_Report.xlsx',
      sheetName: 'Zero Usage',
    });
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
    getResults: getResults,
    getTables: () => _tables,
  };

})();