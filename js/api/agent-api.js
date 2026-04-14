/**
 * DTG Audit Tool — Agent API
 * Exposes window.dtgAudit namespace for AI agent programmatic access.
 *
 * Exports: window.dtgAudit = { getResults, getLog, getDiscrepancies, exportLog, logCodeUpdate }
 *
 * Also sets up: window.lastAuditResults = null (updated each audit run)
 */

(function () {
  'use strict';

  // ─── Global: last audit results ────────────────────────────────────

  window.lastAuditResults = null;

  // ─── Helper: safely access a namespace that may not exist yet ──────

  function safeCall(obj, method /*, ...args */) {
    if (obj && typeof obj[method] === 'function') {
      var args = Array.prototype.slice.call(arguments, 2);
      return obj[method].apply(obj, args);
    }
    return undefined;
  }

  // ─── API Methods ───────────────────────────────────────────────────

  /**
   * Get full audit results (both Tool View and Sheet View).
   * Returns window.DTG.auditData if available, otherwise falls back to
   * window.lastAuditResults.
   *
   * @returns {Object|null}
   */
  function getResults() {
    // Primary: DTG namespace
    if (window.DTG && window.DTG.auditData != null) {
      return window.DTG.auditData;
    }
    // Fallback: global last results
    if (window.lastAuditResults != null) {
      return window.lastAuditResults;
    }
    return null;
  }

  /**
   * Get the full audit log (newest first).
   * Delegates to window.AuditLog.getLog().
   *
   * @returns {Object[]}
   */
  function getLog() {
    return safeCall(window.AuditLog, 'getLog') || [];
  }

  /**
   * Get the last discrepancy comparison result.
   * Delegates to window.DiscrepancyEngine.getDiscrepancies().
   *
   * @returns {Object|null}
   */
  function getDiscrepancies() {
    return safeCall(window.DiscrepancyEngine, 'getDiscrepancies') || null;
  }

  /**
   * Export the audit log as JSON or CSV.
   * Delegates to window.AuditLog.exportLog(format).
   *
   * @param {'json'|'csv'} format
   * @returns {String}
   */
  function exportLog(format) {
    return safeCall(window.AuditLog, 'exportLog', format || 'json') || '';
  }

  /**
   * Log a code update performed by an AI agent or developer.
   * Delegates to window.AuditLog.logCodeUpdate(update).
   *
   * @param {Object} update — { agent, summary, filesChanged, reason }
   */
  function logCodeUpdate(update) {
    if (!update) return;
    safeCall(window.AuditLog, 'logCodeUpdate', update);
  }

  // ─── Expose on window ─────────────────────────────────────────────

  window.dtgAudit = {
    getResults: getResults,
    getLog: getLog,
    getDiscrepancies: getDiscrepancies,
    exportLog: exportLog,
    logCodeUpdate: logCodeUpdate
  };

})();