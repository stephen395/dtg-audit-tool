/**
 * DTG Audit Tool — Discrepancy Engine
 * Compares Tool View results vs Sheet View results, highlights differences.
 *
 * Exports: window.DiscrepancyEngine = { compare, render, getDiscrepancies }
 */

(function () {
  'use strict';

  const NUMERIC_TOLERANCE = 0.01;

  /** Last comparison result, returned by getDiscrepancies() */
  let _lastReport = null;

  // ─── Helpers ────────────────────────────────────────────────────────

  /**
   * Returns true when the absolute difference exceeds the tolerance.
   * Non-numeric values are compared with strict equality.
   */
  function valuesDiffer(toolVal, sheetVal, tolerance) {
    if (tolerance == null) tolerance = NUMERIC_TOLERANCE;

    // Both numeric — use tolerance
    if (typeof toolVal === 'number' && typeof sheetVal === 'number') {
      return Math.abs(toolVal - sheetVal) > tolerance;
    }

    // Try coercing to numbers if possible
    const tNum = Number(toolVal);
    const sNum = Number(sheetVal);
    if (!isNaN(tNum) && !isNaN(sNum)) {
      return Math.abs(tNum - sNum) > tolerance;
    }

    // Fallback: string comparison (null / undefined friendly)
    return String(toolVal ?? '') !== String(sheetVal ?? '');
  }

  /**
   * Build a human-readable reason string for a field discrepancy.
   */
  function buildReason(field, toolVal, sheetVal) {
    const reasons = {
      mrc:            'MRC amounts differ between Tool View and Sheet View calculations.',
      gbTotal:        'Data (GB) total differs — likely due to rounding or aggregation method.',
      gbAvg:          'Data average (GB) differs — tolerance exceeded beyond ' + NUMERIC_TOLERANCE + '.',
      minuteTotal:    'Minute total differs between views.',
      minuteAvg:      'Minute average differs — tolerance exceeded beyond ' + NUMERIC_TOLERANCE + '.',
      msgTotal:       'Message total differs between views.',
      msgAvg:         'Message average differs — tolerance exceeded beyond ' + NUMERIC_TOLERANCE + '.',
      zeroUsageFlag:  'Zero-usage classification differs — one view flags this line as zero usage, the other does not.',
      contractEndDate:'Contract end date differs between views.',
      action:         'Recommended action differs — Tool View uses a cancel/suspend/ETF decision tree; Sheet View uses simple SUMIFS logic.',
      savings:        'Savings calculation differs — Tool View applies complex cancel/suspend/ETF logic; Sheet View uses SUMIFS.'
    };
    return reasons[field] || `Field "${field}" differs: Tool=${toolVal}, Sheet=${sheetVal}.`;
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /**
   * Compare Tool View results against Sheet View results.
   *
   * @param {Object[]} toolResults  — Array of line objects from Tool View
   * @param {Object[]} sheetResults — Array of line objects from Sheet View
   * @returns {Object} discrepancyReport
   */
  function compare(toolResults, sheetResults) {
    // Index sheet results by wireless number for fast lookup
    const sheetMap = {};
    (sheetResults || []).forEach(function (row) {
      const key = String(row.wirelessNumber || row.wireless_number || row.lineNumber || '').trim();
      if (key) sheetMap[key] = row;
    });

    const discrepancies = [];
    let matchingLines = 0;
    let totalLines = 0;
    const linesWithDiscrepancy = new Set();

    (toolResults || []).forEach(function (toolRow) {
      const key = String(toolRow.wirelessNumber || toolRow.wireless_number || toolRow.lineNumber || '').trim();
      if (!key) return;

      const sheetRow = sheetMap[key];
      if (!sheetRow) {
        // Line exists in Tool but not in Sheet
        discrepancies.push({
          wirelessNumber: key,
          field: 'missing',
          toolValue: '(present)',
          sheetValue: '(missing)',
          reason: 'Line found in Tool View but not in Sheet View.'
        });
        linesWithDiscrepancy.add(key);
        totalLines++;
        return;
      }

      totalLines++;
      let lineHasDiscrepancy = false;

      // Helper to check & record a single field
      function checkField(field, tVal, sVal) {
        if (valuesDiffer(tVal, sVal)) {
          lineHasDiscrepancy = true;
          discrepancies.push({
            wirelessNumber: key,
            field: field,
            toolValue: tVal,
            sheetValue: sVal,
            reason: buildReason(field, tVal, sVal)
          });
        }
      }

      // ── Core fields to compare for every line ──
      checkField('mrc',             toolRow.mrc,             sheetRow.mrc);
      checkField('gbTotal',         toolRow.gbTotal,         sheetRow.gbTotal);
      checkField('gbAvg',           toolRow.gbAvg,           sheetRow.gbAvg);
      checkField('minuteTotal',     toolRow.minuteTotal,     sheetRow.minuteTotal);
      checkField('minuteAvg',       toolRow.minuteAvg,       sheetRow.minuteAvg);
      checkField('msgTotal',        toolRow.msgTotal,        sheetRow.msgTotal);
      checkField('msgAvg',          toolRow.msgAvg,          sheetRow.msgAvg);
      checkField('zeroUsageFlag',   toolRow.zeroUsageFlag,   sheetRow.zeroUsageFlag);
      checkField('contractEndDate', toolRow.contractEndDate, sheetRow.contractEndDate);

      // ── For zero-usage lines, also compare action & savings ──
      const isZeroUsage =
        (toolRow.zeroUsageFlag === true || toolRow.zeroUsageFlag === 'Yes' || toolRow.zeroUsageFlag === 1) ||
        (sheetRow.zeroUsageFlag === true || sheetRow.zeroUsageFlag === 'Yes' || sheetRow.zeroUsageFlag === 1);

      if (isZeroUsage) {
        checkField('action',  toolRow.action,  sheetRow.action);
        checkField('savings', toolRow.savings, sheetRow.savings);
      }

      if (lineHasDiscrepancy) {
        linesWithDiscrepancy.add(key);
      } else {
        matchingLines++;
      }
    });

    // Also check for lines in Sheet but not in Tool
    const toolKeys = new Set(
      (toolResults || []).map(function (r) {
        return String(r.wirelessNumber || r.wireless_number || r.lineNumber || '').trim();
      }).filter(Boolean)
    );

    (sheetResults || []).forEach(function (sheetRow) {
      const key = String(sheetRow.wirelessNumber || sheetRow.wireless_number || sheetRow.lineNumber || '').trim();
      if (key && !toolKeys.has(key)) {
        totalLines++;
        discrepancies.push({
          wirelessNumber: key,
          field: 'missing',
          toolValue: '(missing)',
          sheetValue: '(present)',
          reason: 'Line found in Sheet View but not in Tool View.'
        });
        linesWithDiscrepancy.add(key);
      }
    });

    const discrepancyCount = linesWithDiscrepancy.size;
    const accuracyScore = totalLines > 0 ? (matchingLines / totalLines * 100) : 0;

    const report = {
      totalLines: totalLines,
      matchingLines: matchingLines,
      discrepancyCount: discrepancyCount,
      discrepancies: discrepancies,
      accuracyScore: Math.round(accuracyScore * 100) / 100
    };

    _lastReport = report;
    return report;
  }

  /**
   * Render a discrepancy report into a DOM container.
   *
   * @param {Object} report   — Output of compare()
   * @param {HTMLElement} container — DOM element to render into
   */
  function render(report, container) {
    if (!container) return;
    container.innerHTML = '';

    // ── Summary Banner ──
    const banner = document.createElement('div');
    banner.className = 'discrepancy-banner';
    banner.style.cssText = 'padding:12px 18px;margin-bottom:12px;border-radius:6px;font-size:15px;font-weight:600;' +
      'background:#fff3cd;border:1px solid #ffc107;color:#856404;';
    banner.textContent =
      report.discrepancyCount + ' of ' + report.totalLines +
      ' lines have discrepancies (' + report.accuracyScore + '% accuracy)';
    container.appendChild(banner);

    // ── Discrepancy Table ──
    if (report.discrepancies.length === 0) {
      const none = document.createElement('p');
      none.textContent = 'No discrepancies found — all fields match!';
      none.style.cssText = 'color:#155724;font-weight:600;';
      container.appendChild(none);
      return;
    }

    const tableWrap = document.createElement('div');
    tableWrap.style.cssText = 'overflow-x:auto;';

    const table = document.createElement('table');
    table.className = 'discrepancy-table';
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px;';

    // Table header
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    ['Line', 'Field', 'Tool Value', 'Sheet Value', 'Reason'].forEach(function (col) {
      const th = document.createElement('th');
      th.textContent = col;
      th.style.cssText = 'padding:8px 10px;border-bottom:2px solid #dee2e6;text-align:left;background:#f8f9fa;white-space:nowrap;';
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Table body
    const tbody = document.createElement('tbody');
    report.discrepancies.forEach(function (disc, idx) {
      const tr = document.createElement('tr');
      tr.className = 'discrepancy-row';
      tr.style.cssText = 'cursor:pointer;background:#fff8e1;border-bottom:1px solid #dee2e6;transition:background .15s;';
      tr.setAttribute('data-idx', idx);

      const tdLine = document.createElement('td');
      tdLine.textContent = disc.wirelessNumber;
      tdLine.style.cssText = 'padding:6px 10px;white-space:nowrap;';

      const tdField = document.createElement('td');
      tdField.textContent = disc.field;
      tdField.style.cssText = 'padding:6px 10px;white-space:nowrap;font-weight:600;';

      const tdTool = document.createElement('td');
      tdTool.textContent = disc.toolValue != null ? String(disc.toolValue) : '—';
      tdTool.style.cssText = 'padding:6px 10px;';

      const tdSheet = document.createElement('td');
      tdSheet.textContent = disc.sheetValue != null ? String(disc.sheetValue) : '—';
      tdSheet.style.cssText = 'padding:6px 10px;';

      const tdReason = document.createElement('td');
      tdReason.textContent = disc.reason;
      tdReason.style.cssText = 'padding:6px 10px;max-width:400px;';

      tr.appendChild(tdLine);
      tr.appendChild(tdField);
      tr.appendChild(tdTool);
      tr.appendChild(tdSheet);
      tr.appendChild(tdReason);

      // Expandable detail row
      const detailTr = document.createElement('tr');
      detailTr.className = 'discrepancy-detail';
      detailTr.style.cssText = 'display:none;background:#fffbeb;';
      detailTr.setAttribute('data-idx', idx);

      const detailTd = document.createElement('td');
      detailTd.colSpan = 5;
      detailTd.style.cssText = 'padding:12px 16px;border-bottom:1px solid #dee2e6;';

      const dl = document.createElement('div');
      dl.style.cssText = 'font-size:12px;color:#555;line-height:1.6;';

      const toolExplanation = document.createElement('div');
      toolExplanation.innerHTML = '<strong>Tool View logic:</strong> Uses a complex cancel/suspend/ETF decision tree. ' +
        'For zero-usage lines, evaluates contract status, ETF cost, and suspend-vs-cancel savings to determine recommended action and dollar savings.';

      const sheetExplanation = document.createElement('div');
      sheetExplanation.innerHTML = '<strong>Sheet View logic:</strong> Uses simple SUMIFS-based aggregation. ' +
        'Action and savings are derived from straightforward conditional sums on the raw data without contract/ETF evaluation.';

      const valuesDetail = document.createElement('div');
      valuesDetail.innerHTML = '<br><strong>This discrepancy:</strong> Field "' + disc.field +
        '" — Tool computed <code>' + (disc.toolValue != null ? disc.toolValue : 'N/A') + '</code>, ' +
        'Sheet computed <code>' + (disc.sheetValue != null ? disc.sheetValue : 'N/A') + '</code>. ' +
        disc.reason;

      dl.appendChild(toolExplanation);
      dl.appendChild(sheetExplanation);
      dl.appendChild(valuesDetail);
      detailTd.appendChild(dl);
      detailTr.appendChild(detailTd);

      // Click to toggle detail
      tr.addEventListener('click', function () {
        const isVisible = detailTr.style.display !== 'none';
        detailTr.style.display = isVisible ? 'none' : 'table-row';
      });

      tbody.appendChild(tr);
      tbody.appendChild(detailTr);
    });

    table.appendChild(tbody);
    tableWrap.appendChild(table);
    container.appendChild(tableWrap);
  }

  /**
   * Return the last comparison result (or null if never run).
   * @returns {Object|null}
   */
  function getDiscrepancies() {
    return _lastReport;
  }

  // ─── Expose on window ──────────────────────────────────────────────

  window.DiscrepancyEngine = {
    compare: compare,
    render: render,
    getDiscrepancies: getDiscrepancies
  };

})();