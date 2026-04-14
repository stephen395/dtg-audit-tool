/**
 * DTG Audit Tool — Audit Log
 * Tracks audit runs and code updates in localStorage + in-memory.
 *
 * Exports: window.AuditLog = { logAuditRun, logCodeUpdate, getLog, getFilteredLog, exportLog, renderLogViewer, clearLog }
 */

(function () {
  'use strict';

  var STORAGE_KEY = 'dtg_audit_log';

  /** In-memory copy of the log for fast access */
  var _log = null;

  // ─── Internal helpers ──────────────────────────────────────────────

  function loadLog() {
    if (_log !== null) return _log;
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      _log = raw ? JSON.parse(raw) : [];
    } catch (e) {
      _log = [];
    }
    return _log;
  }

  function saveLog() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_log));
    } catch (e) {
      // localStorage full or unavailable — keep in-memory only
      console.warn('AuditLog: could not persist to localStorage', e);
    }
  }

  function isInRange(isoDate, start, end) {
    if (!isoDate) return false;
    var ts = new Date(isoDate).getTime();
    if (start && ts < new Date(start).getTime()) return false;
    if (end && ts > new Date(end + 'T23:59:59.999').getTime()) return false;
    return true;
  }

  function escapeCsv(str) {
    var s = String(str == null ? '' : str);
    if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /**
   * Log an audit run.
   *
   * @param {Object} auditResults — must include carrier, clientName, filesUploaded, results
   */
  function logAuditRun(auditResults) {
    var entry = {
      id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2, 10)),
      timestamp: new Date().toISOString(),
      type: 'audit_run',
      carrier: auditResults.carrier || '',
      clientName: auditResults.clientName || '',
      filesUploaded: Array.isArray(auditResults.filesUploaded) ? auditResults.filesUploaded.slice() : [],
      results: {
        totalLines: auditResults.results && auditResults.results.totalLines != null ? auditResults.results.totalLines : 0,
        zeroUsageLines: auditResults.results && auditResults.results.zeroUsageLines != null ? auditResults.results.zeroUsageLines : 0,
        totalMRC: auditResults.results && auditResults.results.totalMRC != null ? auditResults.results.totalMRC : 0,
        estimatedMonthlySavings: auditResults.results && auditResults.results.estimatedMonthlySavings != null ? auditResults.results.estimatedMonthlySavings : 0,
        toolView: auditResults.results && auditResults.results.toolView ? {
          zeroUsageCount: auditResults.results.toolView.zeroUsageCount || 0,
          cancelCount: auditResults.results.toolView.cancelCount || 0,
          suspendCount: auditResults.results.toolView.suspendCount || 0,
          keepCount: auditResults.results.toolView.keepCount || 0,
          totalSavings: auditResults.results.toolView.totalSavings || 0
        } : { zeroUsageCount: 0, cancelCount: 0, suspendCount: 0, keepCount: 0, totalSavings: 0 },
        sheetView: auditResults.results && auditResults.results.sheetView ? {
          zeroUsageCount: auditResults.results.sheetView.zeroUsageCount || 0,
          totalSavings: auditResults.results.sheetView.totalSavings || 0
        } : { zeroUsageCount: 0, totalSavings: 0 },
        discrepancyCount: auditResults.results && auditResults.results.discrepancyCount != null ? auditResults.results.discrepancyCount : 0,
        discrepancies: (auditResults.results && Array.isArray(auditResults.results.discrepancies))
          ? auditResults.results.discrepancies.map(function (d) {
              return { wirelessNumber: d.wirelessNumber, field: d.field, reason: d.reason || '' };
            })
          : []
      }
    };

    loadLog().unshift(entry); // newest first
    saveLog();
  }

  /**
   * Log a code update.
   *
   * @param {Object} update — { agent, summary, filesChanged, reason }
   */
  function logCodeUpdate(update) {
    var entry = {
      id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2, 10)),
      timestamp: new Date().toISOString(),
      type: 'code_update',
      agent: update.agent || '',
      summary: update.summary || '',
      filesChanged: Array.isArray(update.filesChanged) ? update.filesChanged.slice() : [],
      reason: update.reason || ''
    };

    loadLog().unshift(entry);
    saveLog();
  }

  /**
   * Return the full log array (newest first).
   * @returns {Object[]}
   */
  function getLog() {
    return loadLog().slice(); // return a copy
  }

  /**
   * Return a filtered subset of the log.
   *
   * @param {Object} filters — { type, startDate, endDate, carrier, client }
   * @returns {Object[]}
   */
  function getFilteredLog(filters) {
    if (!filters) return getLog();

    return loadLog().filter(function (entry) {
      if (filters.type && entry.type !== filters.type) return false;
      if (filters.startDate || filters.endDate) {
        if (!isInRange(entry.timestamp, filters.startDate, filters.endDate)) return false;
      }
      if (filters.carrier && entry.type === 'audit_run') {
        if ((entry.carrier || '').toLowerCase().indexOf(filters.carrier.toLowerCase()) === -1) return false;
      }
      if (filters.client && entry.type === 'audit_run') {
        if ((entry.clientName || '').toLowerCase().indexOf(filters.client.toLowerCase()) === -1) return false;
      }
      return true;
    });
  }

  /**
   * Export the log as JSON or CSV string.
   *
   * @param {'json'|'csv'} format
   * @returns {String}
   */
  function exportLog(format) {
    var log = loadLog();

    if (format === 'csv') {
      var headers = ['id', 'timestamp', 'type', 'carrier', 'clientName', 'agent', 'summary', 'reason',
        'totalLines', 'zeroUsageLines', 'totalMRC', 'estimatedMonthlySavings',
        'toolViewZeroUsageCount', 'toolViewCancelCount', 'toolViewSuspendCount', 'toolViewKeepCount', 'toolViewTotalSavings',
        'sheetViewZeroUsageCount', 'sheetViewTotalSavings', 'discrepancyCount'];

      var lines = [headers.map(escapeCsv).join(',')];

      log.forEach(function (entry) {
        var r = entry.results || {};
        var tv = r.toolView || {};
        var sv = r.sheetView || {};
        var row = [
          entry.id, entry.timestamp, entry.type,
          entry.carrier || '', entry.clientName || '', entry.agent || '',
          entry.summary || '', entry.reason || '',
          r.totalLines || '', r.zeroUsageLines || '', r.totalMRC || '', r.estimatedMonthlySavings || '',
          tv.zeroUsageCount || '', tv.cancelCount || '', tv.suspendCount || '', tv.keepCount || '', tv.totalSavings || '',
          sv.zeroUsageCount || '', sv.totalSavings || '',
          r.discrepancyCount || ''
        ];
        lines.push(row.map(escapeCsv).join(','));
      });

      return lines.join('\n');
    }

    // Default: JSON
    return JSON.stringify(log, null, 2);
  }

  /**
   * Render a log viewer panel into the given container.
   *
   * @param {HTMLElement} container
   * @param {Object} [filters] — initial filter state
   */
  function renderLogViewer(container, filters) {
    if (!container) return;
    container.innerHTML = '';

    // ── Filter Controls ──
    var filterBar = document.createElement('div');
    filterBar.className = 'audit-log-filters';
    filterBar.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px;padding:10px;background:#f8f9fa;border-radius:6px;';

    // Type dropdown
    var typeSelect = document.createElement('select');
    typeSelect.style.cssText = 'padding:4px 8px;border:1px solid #ccc;border-radius:4px;font-size:13px;';
    [{ value: '', label: 'All Types' }, { value: 'audit_run', label: 'Audit Runs' }, { value: 'code_update', label: 'Code Updates' }].forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (filters && filters.type === opt.value) o.selected = true;
      typeSelect.appendChild(o);
    });
    filterBar.appendChild(typeSelect);

    // Start date
    var startInput = document.createElement('input');
    startInput.type = 'date';
    startInput.placeholder = 'Start date';
    startInput.style.cssText = 'padding:4px 8px;border:1px solid #ccc;border-radius:4px;font-size:13px;';
    if (filters && filters.startDate) startInput.value = filters.startDate;
    filterBar.appendChild(startInput);

    // End date
    var endInput = document.createElement('input');
    endInput.type = 'date';
    endInput.placeholder = 'End date';
    endInput.style.cssText = 'padding:4px 8px;border:1px solid #ccc;border-radius:4px;font-size:13px;';
    if (filters && filters.endDate) endInput.value = filters.endDate;
    filterBar.appendChild(endInput);

    // Search box
    var searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search carrier / client / agent…';
    searchInput.style.cssText = 'padding:4px 8px;border:1px solid #ccc;border-radius:4px;font-size:13px;min-width:180px;';
    filterBar.appendChild(searchInput);

    // Apply button
    var applyBtn = document.createElement('button');
    applyBtn.textContent = 'Apply';
    applyBtn.style.cssText = 'padding:4px 14px;background:#007bff;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;';
    filterBar.appendChild(applyBtn);

    container.appendChild(filterBar);

    // ── Log List ──
    var logList = document.createElement('div');
    logList.className = 'audit-log-list';
    logList.style.cssText = 'max-height:500px;overflow-y:auto;';
    container.appendChild(logList);

    function renderEntries(activeFilters) {
      logList.innerHTML = '';

      var entries = getFilteredLog(activeFilters);

      // Also filter by search text
      var search = (searchInput.value || '').trim().toLowerCase();
      if (search) {
        entries = entries.filter(function (e) {
          return (e.carrier || '').toLowerCase().indexOf(search) !== -1 ||
                 (e.clientName || '').toLowerCase().indexOf(search) !== -1 ||
                 (e.agent || '').toLowerCase().indexOf(search) !== -1 ||
                 (e.summary || '').toLowerCase().indexOf(search) !== -1;
        });
      }

      if (entries.length === 0) {
        var empty = document.createElement('p');
        empty.textContent = 'No log entries found.';
        empty.style.cssText = 'color:#888;padding:20px;text-align:center;';
        logList.appendChild(empty);
        return;
      }

      entries.forEach(function (entry, idx) {
        var wrapper = document.createElement('div');
        wrapper.className = 'log-entry';
        var isCodeUpdate = entry.type === 'code_update';
        var hasDiscrepancy = entry.type === 'audit_run' && entry.results && entry.results.discrepancyCount > 0;
        var borderColor = isCodeUpdate ? '#2196F3' : (hasDiscrepancy ? '#ff9800' : '#dee2e6');
        var bgColor = hasDiscrepancy ? '#fff8e1' : '#ffffff';

        wrapper.style.cssText = 'border-left:4px solid ' + borderColor + ';background:' + bgColor +
          ';margin-bottom:6px;border-radius:0 6px 6px 0;padding:10px 14px;cursor:pointer;font-size:13px;transition:background .15s;';

        // ── One-line Summary ──
        var summaryLine = document.createElement('div');
        summaryLine.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';

        var leftPart = document.createElement('span');
        leftPart.style.cssText = 'font-weight:600;';
        if (entry.type === 'audit_run') {
          leftPart.textContent = '🔍 Audit: ' + (entry.carrier || 'Unknown') + ' — ' + (entry.clientName || 'Unknown') +
            ' | ' + (entry.results && entry.results.totalLines || 0) + ' lines' +
            (hasDiscrepancy ? ' | ⚠ ' + entry.results.discrepancyCount + ' discrepancies' : '');
        } else {
          leftPart.textContent = '🔧 Code Update: ' + (entry.agent || 'Unknown') + ' — ' + (entry.summary || 'No summary');
        }

        var rightPart = document.createElement('span');
        rightPart.style.cssText = 'color:#888;font-size:11px;white-space:nowrap;margin-left:12px;';
        try {
          rightPart.textContent = new Date(entry.timestamp).toLocaleString();
        } catch (e) {
          rightPart.textContent = entry.timestamp;
        }

        summaryLine.appendChild(leftPart);
        summaryLine.appendChild(rightPart);
        wrapper.appendChild(summaryLine);

        // ── Expandable Details ──
        var detailDiv = document.createElement('div');
        detailDiv.className = 'log-entry-detail';
        detailDiv.style.cssText = 'display:none;margin-top:10px;padding-top:10px;border-top:1px solid #eee;font-size:12px;line-height:1.6;color:#555;';

        if (entry.type === 'audit_run') {
          var r = entry.results || {};
          detailDiv.innerHTML =
            '<div><strong>Carrier:</strong> ' + escapeHtml(entry.carrier) + '</div>' +
            '<div><strong>Client:</strong> ' + escapeHtml(entry.clientName) + '</div>' +
            '<div><strong>Files Uploaded:</strong> ' + (entry.filesUploaded || []).map(escapeHtml).join(', ') + '</div>' +
            '<div><strong>Total Lines:</strong> ' + r.totalLines + '</div>' +
            '<div><strong>Zero Usage Lines:</strong> ' + r.zeroUsageLines + '</div>' +
            '<div><strong>Total MRC:</strong> $' + (r.totalMRC || 0).toFixed(2) + '</div>' +
            '<div><strong>Est. Monthly Savings:</strong> $' + (r.estimatedMonthlySavings || 0).toFixed(2) + '</div>' +
            '<div><strong>Tool View:</strong> ' + (r.toolView ? r.toolView.zeroUsageCount + ' zero-usage, ' + r.toolView.cancelCount + ' cancel, ' + r.toolView.suspendCount + ' suspend, ' + r.toolView.keepCount + ' keep | $' + (r.toolView.totalSavings || 0).toFixed(2) + ' savings' : 'N/A') + '</div>' +
            '<div><strong>Sheet View:</strong> ' + (r.sheetView ? r.sheetView.zeroUsageCount + ' zero-usage | $' + (r.sheetView.totalSavings || 0).toFixed(2) + ' savings' : 'N/A') + '</div>' +
            '<div><strong>Discrepancy Count:</strong> ' + r.discrepancyCount + '</div>' +
            '<div><strong>Discrepancies Summary:</strong> ' + (r.discrepancies && r.discrepancies.length > 0
              ? r.discrepancies.map(function (d) { return d.wirelessNumber + ' (' + d.field + ')'; }).join(', ')
              : 'None') + '</div>';
        } else {
          detailDiv.innerHTML =
            '<div><strong>Agent:</strong> ' + escapeHtml(entry.agent) + '</div>' +
            '<div><strong>Summary:</strong> ' + escapeHtml(entry.summary) + '</div>' +
            '<div><strong>Files Changed:</strong> ' + (entry.filesChanged || []).map(escapeHtml).join(', ') + '</div>' +
            '<div><strong>Reason:</strong> ' + escapeHtml(entry.reason) + '</div>';
        }

        wrapper.appendChild(detailDiv);

        // Toggle on click
        wrapper.addEventListener('click', function () {
          var visible = detailDiv.style.display !== 'none';
          detailDiv.style.display = visible ? 'none' : 'block';
        });

        logList.appendChild(wrapper);
      });
    }

    function escapeHtml(s) {
      var div = document.createElement('div');
      div.textContent = String(s == null ? '' : s);
      return div.innerHTML;
    }

    // Apply button handler
    applyBtn.addEventListener('click', function () {
      renderEntries({
        type: typeSelect.value || undefined,
        startDate: startInput.value || undefined,
        endDate: endInput.value || undefined
      });
    });

    // Initial render
    renderEntries(filters);
  }

  /**
   * Clear all log entries from both localStorage and in-memory.
   */
  function clearLog() {
    _log = [];
    saveLog();
  }

  // ─── Expose on window ──────────────────────────────────────────────

  window.AuditLog = {
    logAuditRun: logAuditRun,
    logCodeUpdate: logCodeUpdate,
    getLog: getLog,
    getFilteredLog: getFilteredLog,
    exportLog: exportLog,
    renderLogViewer: renderLogViewer,
    clearLog: clearLog
  };

})();