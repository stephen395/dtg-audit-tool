/**
 * Verizon ZIP handler.
 *
 * MyVerizon's "Raw Data Download" hands you a .zip per billing month containing
 * 4 tab-delimited TXT files. Stephen's workflow is to download 3 months at once
 * and drop all 3 zips into the audit tool. This module extracts the TXTs from
 * those zips, papa-parses them, classifies each by content, and returns a
 * single combined payload that the parser can consume.
 *
 * Depends on JSZip (loaded from CDN) and Papa (already in the page).
 */
(function () {
  'use strict';

  // The 4 file kinds we expect inside a MyVerizon monthly zip. Filenames vary
  // slightly per export, so we sniff by header content too.
  const FILENAME_HINTS = {
    accountSummary: ['accountsummary'],
    wirelessSummary: ['account & wireless summary', 'account and wireless summary'],
    chargesDetail: ['charges detail', 'wireless charges detail'],
    usageDetail: ['wireless usage detail', 'usage detail'],
  };

  function classifyByFilename(name) {
    const n = String(name || '').toLowerCase();
    for (const [kind, hints] of Object.entries(FILENAME_HINTS)) {
      for (const h of hints) {
        if (n.includes(h)) return kind;
      }
    }
    return null;
  }

  function classifyByHeaders(headers) {
    if (window.VerizonParser && typeof window.VerizonParser.detectFileType === 'function') {
      return window.VerizonParser.detectFileType(headers);
    }
    return null;
  }

  function parseTxtToRows(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    // MyVerizon TXTs ship with mixed line endings: one CRLF after the header
    // and bare LF between data rows. Papa Parse auto-detects newline from the
    // first occurrence (CRLF), then never splits the data rows — the entire
    // file ends up as a single row with everything stuffed into __parsed_extra.
    // Normalising to LF up front kills that footgun.
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const firstLine = text.split('\n')[0];
    const delimiter = firstLine.includes('\t') ? '\t' : ',';
    return new Promise((resolve, reject) => {
      Papa.parse(text, {
        header: true,
        delimiter,
        newline: '\n',
        skipEmptyLines: true,
        transformHeader: (h) => h.replace(/^"|"$/g, '').trim(),
        complete: (results) => {
          const rows = results.data.map(row => {
            const r = {};
            for (const [k, v] of Object.entries(row)) {
              const ck = k.replace(/^"|"$/g, '').trim();
              r[ck] = typeof v === 'string' ? v.replace(/^"|"$/g, '').trim() : v;
            }
            return r;
          });
          const headers = (results.meta.fields || []).map(h => h.replace(/^"|"$/g, '').trim());
          resolve({ rows, headers });
        },
        error: reject,
      });
    });
  }

  /**
   * Extract one MyVerizon zip into 4 classified file payloads.
   * Returns { accountSummary, wirelessSummary, chargesDetail, usageDetail },
   * each value either { rows, headers, sourceName } or null if not present.
   */
  async function extractOneZip(file) {
    if (typeof JSZip === 'undefined') {
      throw new Error('JSZip not loaded — the zip handler script is missing');
    }
    const zip = await JSZip.loadAsync(file);
    const buckets = {
      accountSummary: null,
      wirelessSummary: null,
      chargesDetail: null,
      usageDetail: null,
    };

    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const name = entry.name;
      if (!/\.txt$/i.test(name)) continue;

      const text = await entry.async('string');
      const parsed = await parseTxtToRows(text);

      // Filename-based classification first (fast + reliable for MyVerizon's
      // canonical names). Fall back to header sniffing if filename is renamed.
      let kind = classifyByFilename(name) || classifyByHeaders(parsed.headers);
      if (!kind) {
        console.warn('[VerizonZip] Could not classify file:', name, 'headers:', parsed.headers.slice(0, 5));
        continue;
      }

      buckets[kind] = {
        rows: parsed.rows,
        headers: parsed.headers,
        sourceName: name,
        sourceZip: file.name,
      };
    }

    return buckets;
  }

  /**
   * Extract a list of zip files and merge their per-kind rows together. Each
   * month's data is preserved (rows are concatenated; the parser keys off
   * Bill Cycle Date / Bill Period to separate cycles).
   *
   * Returns:
   *   {
   *     files: [{ type, rows }, ...],   // shape verizon-txt.js expects
   *     zipCount, zipNames,
   *     missing: ['accountSummary', ...] // zips that lacked a given kind
   *   }
   */
  async function extractZips(zipFiles) {
    const merged = {
      accountSummary: { rows: [], headers: null },
      wirelessSummary: { rows: [], headers: null },
      chargesDetail: { rows: [], headers: null },
      usageDetail: { rows: [], headers: null },
    };
    const zipNames = [];

    for (const f of zipFiles) {
      zipNames.push(f.name);
      const buckets = await extractOneZip(f);
      for (const [kind, payload] of Object.entries(buckets)) {
        if (!payload) continue;
        if (!merged[kind].headers) merged[kind].headers = payload.headers;
        merged[kind].rows.push(...payload.rows);
      }
    }

    const missing = Object.keys(merged).filter(k => merged[k].rows.length === 0);

    // Map to the {type, rows} array verizon-txt.js parse() takes. Skip the
    // usageDetail file — it's call-by-call records that the audit doesn't use,
    // would just bloat memory.
    const files = [];
    for (const kind of ['accountSummary', 'wirelessSummary', 'chargesDetail']) {
      if (merged[kind].rows.length > 0) {
        files.push({ type: kind, rows: merged[kind].rows });
      }
    }

    return {
      files,
      zipCount: zipFiles.length,
      zipNames,
      missing,
    };
  }

  /**
   * Sniff a File to see if it's a zip. We look at extension — for browser-File
   * objects the .type field is unreliable across OSes.
   */
  function isZip(file) {
    return /\.zip$/i.test(file.name);
  }

  window.VerizonZip = {
    extractOneZip,
    extractZips,
    isZip,
  };
})();
