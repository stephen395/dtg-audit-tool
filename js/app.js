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
  // SOURCE-OF-TRUTH MERGE — see SOURCE_OF_TRUTH.md at repo root.
  //
  // When BOTH a bill PDF and CSV reports are uploaded, this merge runs
  // before any analyzer touches the data. The rule:
  //
  //   PDF wins on financial detail (MRC, credits, add-ons, promos,
  //   installments, line status, AutoPay/Paperless flags).
  //
  //   CSV wins on usage (voice/data/SMS) and device inventory.
  //
  // Field-by-field decisions live in PDF_AUTHORITATIVE_FIELDS and
  // CSV_AUTHORITATIVE_FIELDS below. Disagreements are recorded so the
  // Discrepancy view can surface them.
  // ═══════════════════════════════════════════════════════

  // The PDF carries the line-item breakdown (plan + credits + add-ons +
  // status) that the CSV either summarizes incorrectly or doesn't expose
  // at all. Field-tested on Genserve 804-line Verizon Business account:
  // CSV alone was ~40% wrong/unknowable for these.
  const PDF_AUTHORITATIVE_FIELDS = [
    'mrc', 'monthlyCharges', 'ratePlan',
    'totalCharges', 'activityCharges', 'oneTimeCharges',
    'equipment', 'equipmentName', 'equipmentInstallment',
    'equipmentFinanced', 'equipmentRemaining', 'equipmentEstablished',
    'equipmentIMEI',
    'contractEnd', 'contractEndDate', 'contractType', 'etf',
    'status', 'lineStatus', 'hasActiveContract',
    'latestMrcItems', 'latestCreditsItemized', 'latestAddonsItemized',
    'autoPay', 'paperless', 'autoPayUnlock', 'paperlessUnlock',
    'taxes', 'fees', 'latestTaxes', 'latestFees',
    'remainingMonths',
    // Net plan MRC + credit breakdown (Stephen May-22). Bill PDF is the
    // ONLY source for these — CSV doesn't itemize credits per line.
    'grossPlanMRC', 'netPlanMRC',
    'recurringCreditsTotal', 'oneTimeCreditsTotal',
    'monthlyBreakdown', 'addons',
  ];

  // CSV is authoritative for usage and inventory. The bill PDF's
  // per-line usage logs exist but are noisy; the CSV's structured
  // usage columns are the right input for an audit.
  const CSV_AUTHORITATIVE_FIELDS = [
    'gbTotal', 'gbAvg', 'kbTotal',
    'minTotal', 'minAvg', 'totalMin90d',
    'msgTotal', 'msgAvg', 'totalMsg90d',
    'costCenter', 'udl', 'ban',
  ];

  function _isNonEmpty(v) {
    return v !== undefined && v !== null && v !== '' &&
           !(typeof v === 'number' && isNaN(v));
  }

  function _fieldsDisagree(a, b) {
    if (!_isNonEmpty(a) || !_isNonEmpty(b)) return false;
    const an = Number(a), bn = Number(b);
    if (!isNaN(an) && !isNaN(bn)) return Math.abs(an - bn) > 0.01;
    return String(a) !== String(b);
  }

  /**
   * 7-pattern line-status classifier (Genserve edge-case taxonomy).
   * See SOURCE_OF_TRUTH.md → "Line status — 7 patterns".
   *
   * Lines that LOOK identical on the CSV (all $0) are actually one of:
   *   suspended | refund | cancelled-mid-cycle | one-time-only | inactive
   * Misclassifying them drives the wrong recommendation (cancel vs keep
   * vs migrate at peer rate).
   *
   * @param {Object} p - merged profile
   * @returns {string} one of: active-full-month | active-prorated |
   *   active-with-credits | suspended | refund | cancelled-mid-cycle |
   *   one-time-only | inactive
   */
  function classifyLineStatus(p) {
    if (!p) return 'inactive';

    const status = String(p.status || '').toLowerCase();
    const mrc = Number(p.mrc || p.latestMonthly || p.monthlyCharges || 0);
    const total = Number(p.totalCharges || p.latestTotal || 0);
    const oneTime = Number(p.activityCharges || p.latestActivity || 0) +
                    (Array.isArray(p.oneTimeCharges)
                      ? p.oneTimeCharges.reduce((s, o) => s + (Number(o.amount) || 0), 0)
                      : 0);
    const credits = Number(p.latestCreditTotal || 0);
    const hasItemizedCredits = Array.isArray(p.latestCreditsItemized) &&
                               p.latestCreditsItemized.length > 0;
    const ratePlan = String(p.ratePlan || '').toLowerCase();

    // 1. Refund — net total negative or explicit "No Price Plan" with negative MRC
    if (total < -0.01 || mrc < -0.01 || ratePlan.includes('no price plan')) {
      return 'refund';
    }

    // 2. Suspended — carrier-reported status OR known-suspended marker
    if (status === 'suspended' || status === 'vacation' || p.isSuspended === true) {
      return 'suspended';
    }

    // 3. Cancelled mid-cycle — flagged explicitly or partial-period proration
    //    with cancellation marker
    if (status === 'cancelled' || p.isCancelledMidCycle === true) {
      return 'cancelled-mid-cycle';
    }

    // 4. One-time-only — MRC is zero but the line has equipment / activation
    //    charges this cycle. Not really billable for monthly service.
    if (mrc <= 0.01 && oneTime > 0.01) {
      return 'one-time-only';
    }

    // 5. Active with credits — recurring credits are present on the plan
    //    section (recurring promo, 15% off, etc.). Effective monthly is
    //    lower than gross MRC — matters for migration math.
    if (hasItemizedCredits || credits < -0.01) {
      return 'active-with-credits';
    }

    // 6. Active prorated — proration flag or partial-period MRC
    if (p.hasProration === true || p.isProrated === true) {
      return 'active-prorated';
    }

    // 7. Active full-month — the default for a line with positive MRC and
    //    no other special markers
    if (mrc > 0.01) {
      return 'active-full-month';
    }

    // Fallback — line exists but has no monthly charges and no signals
    // pointing elsewhere. Could be a ghost line from Upgrade Eligibility
    // with no billing rows.
    return 'inactive';
  }

  window.DTG.classifyLineStatus = classifyLineStatus;

  /**
   * Merge CSV-parsed profiles with PDF-parsed profiles per the
   * Source-of-Truth Rule. Returns merged profiles + the list of
   * field-level disagreements (PDF vs CSV) for the Discrepancy view.
   *
   * Each returned profile carries:
   *   - source: 'hybrid' | 'pdf' | 'csv'
   *   - sourceMap: { [field]: 'pdf' | 'csv' | 'pdf-fallback' | 'csv-fallback' | 'csv-derived' }
   *
   * Analyzers should read fields directly; the merge already applied
   * the rule. If you need to defensively check, consult sourceMap.
   *
   * @param {Object} csvProfiles - { wirelessNumber: profileObj } from CSV parsers
   * @param {Object} pdfProfiles - { wirelessNumber: profileObj } from BillPDFParser
   * @returns {{ profiles: Object, discrepancies: Array, summary: Object }}
   */
  function mergeProfiles(csvProfiles, pdfProfiles) {
    const merged = {};
    const discrepancies = [];
    const allWireless = new Set([
      ...Object.keys(csvProfiles || {}),
      ...Object.keys(pdfProfiles || {}),
    ]);
    let bothCount = 0, csvOnlyCount = 0, pdfOnlyCount = 0;

    for (const wn of allWireless) {
      const csv = (csvProfiles && csvProfiles[wn]) || null;
      const pdf = (pdfProfiles && pdfProfiles[wn]) || null;

      // Start with CSV as the base, layer PDF on top of any matching keys.
      // PDF/CSV authoritative rules below will then re-apply the correct
      // value per field.
      const profile = { ...(csv || {}), ...(pdf || {}) };
      const sourceMap = {};
      if (csv) for (const k of Object.keys(csv)) sourceMap[k] = 'csv';
      if (pdf) for (const k of Object.keys(pdf)) sourceMap[k] = 'pdf';

      if (csv && pdf) {
        bothCount++;

        // PDF wins on financial fields
        for (const field of PDF_AUTHORITATIVE_FIELDS) {
          if (_isNonEmpty(pdf[field])) {
            if (_fieldsDisagree(csv[field], pdf[field])) {
              discrepancies.push({
                wireless: wn, field,
                csvValue: csv[field], pdfValue: pdf[field],
                winner: 'pdf',
                reason: 'PDF is authoritative for ' + field + ' (financial detail)',
              });
            }
            profile[field] = pdf[field];
            sourceMap[field] = 'pdf';
          } else if (_isNonEmpty(csv[field])) {
            profile[field] = csv[field];
            sourceMap[field] = 'csv-fallback';
          }
        }

        // CSV wins on usage + inventory fields
        for (const field of CSV_AUTHORITATIVE_FIELDS) {
          if (_isNonEmpty(csv[field])) {
            if (_fieldsDisagree(pdf[field], csv[field])) {
              discrepancies.push({
                wireless: wn, field,
                csvValue: csv[field], pdfValue: pdf[field],
                winner: 'csv',
                reason: 'CSV is authoritative for ' + field + ' (usage / inventory)',
              });
            }
            profile[field] = csv[field];
            sourceMap[field] = 'csv';
          } else if (_isNonEmpty(pdf[field])) {
            profile[field] = pdf[field];
            sourceMap[field] = 'pdf-fallback';
          }
        }

        // Recompute zeroUsage from the CSV-authoritative usage values
        // (the PDF may have set it from its own noisier usage extraction).
        const dt = String(profile.deviceType || '').toLowerCase();
        const isDataDevice = dt.includes('tablet') || dt.includes('hotspot') ||
                             dt.includes('mifi')   || dt.includes('jetpack') ||
                             dt.includes('connected') || dt.includes('broadband');
        const dataZero  = (Number(profile.gbTotal)  || 0) === 0;
        const voiceZero = (Number(profile.minTotal) || 0) === 0;
        const textZero  = (Number(profile.msgTotal) || 0) === 0;
        profile.zeroUsage = isDataDevice ? dataZero : (dataZero && voiceZero && textZero);
        sourceMap.zeroUsage = 'csv-derived';
      } else if (csv) {
        csvOnlyCount++;
      } else if (pdf) {
        pdfOnlyCount++;
      }

      profile.source = (csv && pdf) ? 'hybrid' : (pdf ? 'pdf' : 'csv');
      profile.sourceMap = sourceMap;

      // Classify into the 7-pattern Genserve taxonomy so analyzers can
      // tell suspended vs refund vs one-time-only apart (they all look
      // like $0 on the CSV).
      profile.lineStatus = classifyLineStatus(profile);

      merged[wn] = profile;
    }

    const summary = {
      totalLines: allWireless.size,
      hybridLines: bothCount,
      csvOnlyLines: csvOnlyCount,
      pdfOnlyLines: pdfOnlyCount,
      discrepancyCount: discrepancies.length,
    };

    return { profiles: merged, discrepancies, summary };
  }

  // Expose for tests / debugging
  window.DTG.mergeProfiles = mergeProfiles;

  // ═══════════════════════════════════════════════════════
  // MAIN AUDIT PIPELINE
  // ═══════════════════════════════════════════════════════
  window.DTG.runAudit = async function (uiState) {
    const DTG = window.DTG;

    // ── Source-of-Truth Rule gate ──
    // The bill PDF is the authoritative source for per-line MRC,
    // credits, add-ons, promos, installments, and line status. CSV
    // alone is ~40% wrong/unknowable on financial detail. Running an
    // audit without the bill produces silently-inaccurate output, so
    // we hard-stop here even if the UI gate was bypassed.
    // See SOURCE_OF_TRUTH.md.
    if (!uiState || !uiState.files || !uiState.files.pdf) {
      const msg = 'Bill PDF is required to run an audit. Upload the carrier ' +
                  'bill in PDF format — the audit reads per-line MRC, credits, ' +
                  'add-ons, promos, and line status from the bill (CSV alone ' +
                  'is ~40% wrong on financial detail). See SOURCE_OF_TRUTH.md.';
      console.error('[AUDIT] Blocked:', msg);
      if (typeof DTG.showProcessing === 'function') DTG.showProcessing(false);
      if (typeof alert === 'function') alert(msg);
      throw new Error('Bill PDF required (Source-of-Truth Rule)');
    }

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
        const ai = billData.accountInfo || {};
        meta = {
          source: 'pdf',
          accountNumber: ai.accountNumber,
          accountName: ai.accountName,
          foundationAccount: ai.foundationAccount,
          invoice: ai.invoice,
          issueDate: ai.issueDate,
          totalDue: ai.totalDue,
          lastBillAmount: bm.lastBillAmount || 0,
          autoPayDate: bm.autoPayDate || '',
          billingPeriods: bm.billingPeriod ? [bm.billingPeriod] : [],
          billingCycles: bm.billingPeriod ? [bm.billingPeriod] : [],
          pdfPages: billData.pageCount,
          // AutoPay / Paperless unlock data — see SOURCE_OF_TRUTH.md
          autoPay: ai.autoPay,
          paperless: ai.paperless,
          autoPayUnlockPerLine: ai.autoPayUnlockPerLine,
          autoPayUnlockTotal: ai.autoPayUnlockTotal,
          autoPayMessage: ai.autoPayMessage,
        };

        console.log('[AUDIT] PDF profiles built:', Object.keys(profiles).length);

      } else {
        // ── CSV/ZIP-BASED AUDIT (standard) ──
        // Verizon zip-mode short-circuits here — the user dropped 1–3 monthly
        // zips from MyVerizon (Raw Data Download) and we crack them in-browser.
        const verizonZips = (uiState.files.zips || []).filter(f => /\.zip$/i.test(f.name));
        const isVerizonZipMode = carrier === 'verizon' && verizonZips.length > 0;

        if (isVerizonZipMode) {
          DTG.updateProcessingStatus('Extracting ' + verizonZips.length + ' Verizon zip' +
                                     (verizonZips.length === 1 ? '' : 's') + '...');
          DTG.updateProcessingProgress(15);

          if (!window.VerizonZip) {
            throw new Error('Verizon zip handler not loaded — refresh the page and retry.');
          }
          const extracted = await window.VerizonZip.extractZips(verizonZips);
          console.log('[AUDIT] Verizon zip extract:', extracted.zipCount, 'zips,',
                       extracted.files.map(f => f.type + ':' + f.rows.length).join(' '),
                       extracted.missing.length ? '(missing: ' + extracted.missing.join(', ') + ')' : '');

          if (extracted.files.length === 0) {
            throw new Error('No recognised Verizon TXT files inside the uploaded zip(s). Make sure these came from MyVerizon → Reports → Raw Data Download.');
          }

          // Optional: Upgrade Eligibility / Device Report is a separate
          // export from MyVerizon. When uploaded alongside the zips, the
          // parser anchors the line universe on it — matching Stephen's
          // manual Sheet workflow. Without it, every billing line is in scope.
          const filesForParser = extracted.files.slice();
          if (uiState.files.upgrade) {
            DTG.updateProcessingStatus('Reading Upgrade Eligibility / Device Report...');
            const ueParsed = await parseFileAsync(uiState.files.upgrade);
            const detected = window.VerizonParser.detectFileType(ueParsed.headers) || 'upgradeEligibility';
            filesForParser.push({ type: detected, rows: ueParsed.rows });
            console.log('[AUDIT] Verizon Upgrade Eligibility:', ueParsed.rows.length, 'rows, detected:', detected);
          }

          DTG.updateProcessingProgress(35);
          DTG.updateProcessingStatus('Building line profiles from ' +
            extracted.files.find(f => f.type === 'wirelessSummary')?.rows.length || 0 + ' wireless rows...');

          const result = window.VerizonParser.parse(filesForParser);
          profiles = result.profiles;
          meta = result.meta || {};
          meta.zipCount = extracted.zipCount;
          meta.zipNames = extracted.zipNames;
          if (meta.usingUpgradeEligibility) {
            console.log('[AUDIT] Anchored on Upgrade Eligibility (' + meta.upgradeEligibilityCount + ' managed lines) → ' + Object.keys(profiles).length + ' profiles');
          }
        } else {
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
            // Legacy path: single TXT file dropped instead of zip. Less useful
            // (only one cycle of data) but keep it working for ad-hoc checks.
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

      // ── HYBRID MODE: parse the bill PDF and merge with CSV profiles ──
      // Per SOURCE_OF_TRUTH.md: when both inputs are present, PDF wins on
      // financial fields, CSV wins on usage. Runs BEFORE analyzers so every
      // downstream consumer sees the canonical merged profiles.
      let billData = null;
      if (uiState.files.pdf && !pdfOnlyMode) {
        DTG.updateProcessingProgress(55);
        DTG.updateProcessingStatus('Reading bill PDF for source-of-truth merge...');
        try {
          billData = await window.BillPDFParser.parse(uiState.files.pdf, (current, total) => {
            const pct = 55 + Math.round((current / total) * 8);
            DTG.updateProcessingProgress(pct);
            DTG.updateProcessingStatus(`Reading bill PDF... page ${current} of ${total}`);
          });
          console.log('[AUDIT] Hybrid PDF parsed:', billData.pageCount, 'pages, carrier:', billData.carrier,
                       '→', Object.keys(billData.lineProfiles || {}).length, 'PDF profiles');

          if (billData.lineProfiles && Object.keys(billData.lineProfiles).length > 0) {
            const mergeResult = mergeProfiles(profiles, billData.lineProfiles);
            profiles = mergeResult.profiles;

            // Hang the discrepancies + merge summary off meta for the
            // Discrepancy view / status indicators to pick up.
            meta.source = 'hybrid';
            meta.pdfCsvDiscrepancies = mergeResult.discrepancies;
            meta.mergeSummary = mergeResult.summary;
            meta.pdfPages = billData.pageCount;
            if (billData.billMeta) {
              meta.pdfBillingPeriod = billData.billMeta.billingPeriod;
              meta.pdfTotalDue = billData.billMeta.totalDue;
              meta.pdfAutoPayDate = billData.billMeta.autoPayDate;
            }
            // Surface the AutoPay / Paperless unlock data captured by
            // parseAccountInfo so the dashboard can render a "free money"
            // recommendation when the account isn't yet enrolled.
            if (billData.accountInfo) {
              meta.autoPay = billData.accountInfo.autoPay;
              meta.paperless = billData.accountInfo.paperless;
              meta.autoPayUnlockPerLine = billData.accountInfo.autoPayUnlockPerLine;
              meta.autoPayUnlockTotal = billData.accountInfo.autoPayUnlockTotal;
              meta.autoPayMessage = billData.accountInfo.autoPayMessage;
              if (billData.accountInfo.autoPayMessage) {
                console.log('[AUDIT] AutoPay unlock:', billData.accountInfo.autoPayMessage);
              }
            }
            console.log('[AUDIT] Hybrid merge:',
                         mergeResult.summary.hybridLines, 'lines on both,',
                         mergeResult.summary.csvOnlyLines, 'CSV-only,',
                         mergeResult.summary.pdfOnlyLines, 'PDF-only,',
                         mergeResult.summary.discrepancyCount, 'field-level discrepancies');
          } else {
            console.warn('[AUDIT] Hybrid PDF parsed but no line profiles extracted — keeping CSV-only data');
          }
        } catch (e) {
          console.warn('[AUDIT] Hybrid PDF parse failed, falling back to CSV-only:', e.message);
        }
      }

      // Apply the 7-pattern line-status classifier to every profile. In
      // hybrid mode mergeProfiles() already did this; in single-source
      // mode we still want every line tagged so analyzers can branch on
      // suspended / refund / one-time-only without ambiguity.
      for (const wn of Object.keys(profiles)) {
        if (!profiles[wn].lineStatus) {
          profiles[wn].lineStatus = classifyLineStatus(profiles[wn]);
        }
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

      // Add-on features (insurance, international, hotspot, cloud, etc.) —
      // pulled from the carrier's per-line charge detail. Reports per-category
      // line count and monthly cost so Stephen can spot bloat at a glance.
      const features = (window.FeatureAnalyzer && window.FeatureAnalyzer.analyze)
        ? window.FeatureAnalyzer.analyze(profiles, meta, carrier)
        : { features: [], categories: [], totalMonthly: 0, featureCount: 0, uniqueLineCount: 0 };
      console.log('[AUDIT] Features:', features.featureCount, 'distinct,', features.uniqueLineCount, 'lines,',
                   '$' + features.totalMonthly.toFixed(2), '/mo');
      console.log('[AUDIT] Rate plans:', ratePlans.summary.uniquePlans, 'unique plans');

      // Per-cycle snapshots + month-over-month deltas. Powers the latest-cycle
      // dashboard and the Trend tab.
      const trend = (window.CycleTrendAnalyzer && window.CycleTrendAnalyzer.analyze)
        ? window.CycleTrendAnalyzer.analyze(profiles, meta)
        : { snapshots: [], deltas: [], cycleCount: 0, byCycle: {} };
      console.log('[AUDIT] Cycle trend:', trend.cycleCount, 'cycles');

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

      // Bill PDF parsing now happens earlier (before analyzers) so the
      // Source-of-Truth merge can run on profiles BEFORE they're analyzed.
      // billData was populated in the hybrid block above; no late parse needed.

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

      // ── PDF-vs-CSV Source Conflicts (Source-of-Truth Rule output) ──
      // Surface the field-level disagreements mergeProfiles() recorded
      // when both bill PDF and CSV were uploaded. Conflicts were already
      // auto-resolved (PDF wins financials, CSV wins usage) — this panel
      // just lets the user spot bad data on either side.
      if (window.DiscrepancyEngine && window.DiscrepancyEngine.renderSourceConflicts) {
        const discEl = document.getElementById('discrepancy-content');
        if (discEl && (meta.pdfCsvDiscrepancies || meta.mergeSummary)) {
          try {
            window.DiscrepancyEngine.renderSourceConflicts(
              meta.pdfCsvDiscrepancies || [],
              meta.mergeSummary || {},
              discEl
            );
          } catch (e) {
            console.error('[AUDIT] Source-conflict render error:', e);
          }
        }
      }

      // Store for exports
      const auditData = {
        carrier, clientName,
        billingPeriod: meta.billingCycles ? meta.billingCycles.join(' → ') : (meta.billingPeriods ? meta.billingPeriods.join(' → ') : ''),
        profiles, meta, zeroUsageResults, zeroUsageSummary, usageReport, ratePlans, features, billData, trend,
        // Which cycle the dashboard is currently showing. Defaults to the latest
        // cycle; user can flip via the cycle selector in the dashboard header.
        activeCycle: trend && trend.snapshots && trend.snapshots.length > 0
          ? trend.snapshots[trend.snapshots.length - 1].cycle
          : null,
        // Multi-account scoping. allProfiles + allMeta are the unfiltered
        // baseline; profiles/meta get swapped to a single-BAN view when the
        // BAN selector changes. activeBan = 'ALL' means "show every BAN".
        allProfiles: profiles,
        allMeta: meta,
        activeBan: 'ALL',
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
      if (typeof populateRatePlanDetailTab === 'function') populateRatePlanDetailTab(auditData);
      populateFeaturesPanel(auditData);
      populatePlanComparison(auditData);
      populateTrendTab(auditData);
      populateContractsTab(auditData);
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
    const s = ur.summary;

    // ── Pick which cycle the dashboard is showing ────────────────────────────
    // Defaults to the latest cycle. The cycle selector (if rendered) lets the
    // user flip to any earlier cycle to see that month's bill snapshot.
    const snapshot = (data.trend && data.trend.byCycle && data.activeCycle)
      ? data.trend.byCycle[data.activeCycle]
      : (data.trend && data.trend.snapshots && data.trend.snapshots.length
          ? data.trend.snapshots[data.trend.snapshots.length - 1]
          : null);

    // Bill totals: prefer the active cycle's snapshot (all bill rows, including
    // account-level adjustments). Fall back to profile-summed values for
    // carriers without a per-cycle breakdown (Verizon, T-Mobile, PDF-only mode).
    const bill = snapshot ? snapshot.bill : null;
    const totalSpend  = bill ? bill.total      : (s.billTotal      || s.totalMRC || 0);
    const planTotal   = bill ? bill.plan       : (s.billPlan       || s.totalMRC || 0);
    const feesTotal   = bill ? bill.surcharges : (s.billSurcharges || 0);
    const taxesTotal  = bill ? bill.taxes      : (s.billTaxes      || 0);
    const activityVal = bill ? bill.activity   : (s.billActivity   || 0);
    const equipTotal  = s.billEquipment || s.totalEquipment || 0; // from inventory, not bill

    const lineCount = snapshot ? snapshot.lineCount : (s.totalLines || 0);
    const inv       = snapshot ? snapshot.inventory : ur.inventory;

    // Hero card
    setKPI('kpi-total-spend', fmtMoney(totalSpend));
    setKPI('kpi-avg-cost',    fmtMoney(lineCount ? totalSpend / lineCount : 0));
    setKPI('kpi-line-count',  lineCount);

    // Breakdown cards
    setKPI('kpi-plan-charges', fmtMoney(planTotal));
    setKPI('kpi-equipment',    fmtMoney(equipTotal));
    setKPI('kpi-surcharges',   fmtMoney(feesTotal));
    setKPI('kpi-taxes',        fmtMoney(taxesTotal));

    // Activity is often net-negative (credits). Render red/green accordingly.
    const activityEl = document.getElementById('kpi-activity');
    if (activityEl) {
      activityEl.textContent = (activityVal < 0 ? '-' : '') + fmtMoney(Math.abs(activityVal));
      activityEl.style.color = activityVal < 0 ? 'var(--success)' : '';
    }

    // Inventory cards — scoped to lines active in the selected cycle
    setKPI('kpi-total-lines',  inv.total);
    setKPI('kpi-smartphones',  inv.smartphones);
    setKPI('kpi-tablets',      inv.tablets + inv.hotspots);
    setKPI('kpi-wearables',    inv.watches);

    // Upgrade eligibility (inventory is a single snapshot so these don't vary
    // per cycle — they reflect the current Upgrade Eligibility file)
    setKPI('kpi-upgrade-eligible', ur.summary.upgradeEligible || 0);
    setKPI('kpi-in-contract', ur.summary.inContract || 0);

    // Populate the cycle selector + month label on the hero card
    renderCycleSelector(data);
    renderBanSelector(data);
    renderByBanBreakout(data);
    renderCycleLabel(snapshot);

    // Savings
    setKPI('kpi-total-savings', fmtMoney(zu.totalMonthlySavings));
    setKPI('kpi-zero-lines', zu.totalZeroUsage);
    setKPI('kpi-zero-cost', fmtMoney(zu.cancelSavings + zu.suspendSavings));
    setKPI('kpi-plan-opts', data.ratePlans.summary.highZeroUsagePlans);
    setKPI('kpi-plan-savings', fmtMoney(0)); // placeholder for plan optimization
    setKPI('kpi-annual-savings', fmtMoney(zu.totalMonthlySavings * 12));

    // ── REDESIGNED DASHBOARD: drive the new visual bits (Apr 2026) ────────
    // Breakdown bars, fleet stacked bar, in-contract donut, hero callout,
    // delta vs prior cycle, ranked recommendations.
    populateDashboardExtras(data, {
      totalSpend, lineCount, inv,
      planTotal, equipTotal, feesTotal, taxesTotal, activityVal,
      snapshot,
    });

    // ── AutoPay / Paperless unlock banner ──
    // Populated by parseAccountInfo() in bill-pdf.js when the bill cover
    // advertises a discount the account isn't yet claiming. Up to
    // $1,255/mo on the May Genserve bill — invisible to the CSV. The
    // banner is dashboard-prominent because it's free money the user
    // can act on immediately.
    renderAutoPayUnlockBanner(data);

    // Mark body so the empty-state CSS hides and the dashboard grid shows.
    document.body.classList.add('has-audit-data');
    document.body.classList.add('tabs-redesigned');

    // Populate redesigned summary bands on every other tab.
    populateTabBands(data, { totalSpend, lineCount, inv, snapshot });
  }

  /**
   * Inject (or update) an AutoPay / Paperless unlock banner above the
   * dashboard hero card. Reads from data.meta.autoPayMessage which was
   * set by parseAccountInfo() in bill-pdf.js. No-ops if message empty.
   */
  function renderAutoPayUnlockBanner(data) {
    const id = 'autopay-unlock-banner';
    let banner = document.getElementById(id);
    const meta = (data && data.meta) || {};
    const msg = meta.autoPayMessage;

    if (!msg) {
      if (banner) banner.style.display = 'none';
      return;
    }

    if (!banner) {
      banner = document.createElement('div');
      banner.id = id;
      banner.style.cssText =
        'margin:0 0 16px 0;padding:14px 18px;border-radius:8px;' +
        'background:linear-gradient(135deg,#fef3c7 0%,#fde68a 100%);' +
        'border:1px solid #f59e0b;color:#78350f;' +
        'display:flex;align-items:center;gap:12px;' +
        'font-size:14px;font-weight:500;' +
        'box-shadow:0 1px 3px rgba(0,0,0,0.08);';
      // Insert above the first hero card in the dashboard grid.
      const hero = document.querySelector('.dash-card.hero');
      if (hero && hero.parentNode) {
        hero.parentNode.insertBefore(banner, hero);
      } else {
        // Fallback — append to the dashboard tab container if the hero
        // isn't around (e.g., tab not yet rendered).
        const dashTab = document.getElementById('dashboard') ||
                        document.querySelector('.dash-grid');
        if (dashTab) dashTab.insertBefore(banner, dashTab.firstChild);
      }
    }

    banner.style.display = '';
    const icon = '<span style="font-size:22px;">$</span>';
    const label = '<strong>AutoPay unlock:</strong> ';
    banner.innerHTML = icon + '<div>' + label + msg + '</div>';
  }

  // ═══════════════════════════════════════════════════════
  // TAB REDESIGN — populate summary bands on Zero Usage,
  // Usage Report, Rate Plans, Plan Comparison, Discrepancies,
  // and Exports tabs. v=20260430-tabs-redesign
  // ═══════════════════════════════════════════════════════
  function populateTabBands(data, ctx) {
    const ur = data.usageReport;
    const zu = data.zeroUsageSummary;
    const rp = data.ratePlans && data.ratePlans.summary ? data.ratePlans.summary : {};
    const pc = data.planComparison || {};

    // ---- ZERO USAGE BAND ----
    try {
      const zuLines = (zu.lines || []);
      const total = zu.totalZeroUsage || zuLines.length || 0;
      const wastedMRC = zu.cancelSavings + zu.suspendSavings || zu.totalMonthlySavings || 0;
      const annual = (zu.totalMonthlySavings || wastedMRC) * 12;

      setText('zu-band-count', total);
      setText('zu-band-mrc', fmtMoney(wastedMRC) + '/mo');
      setText('zu-band-savings', fmtMoney(annual));

      // severity buckets
      let high = 0, med = 0, low = 0, etfRisk = 0;
      zuLines.forEach(l => {
        const oc = (l.action || '').toLowerCase().includes('suspend') ||
                   (l.action || '').toLowerCase().includes('cancel') ||
                   l.contractStatus === 'out-of-contract' ||
                   l.inContract === false;
        if (oc) high++;
        else {
          // contract end window
          const days = l.daysToContractEnd != null ? l.daysToContractEnd : 9999;
          if (days < 90) med++; else low++;
          etfRisk += (l.etf || 0);
        }
      });
      const max = Math.max(high, med, low, 1);
      setText('zu-dist-high', high);
      setText('zu-dist-med', med);
      setText('zu-dist-low', low);
      setText('zu-dist-etf', fmtMoney(etfRisk));
      setBar('zu-bar-high', (high / max) * 100);
      setBar('zu-bar-med', (med / max) * 100);
      setBar('zu-bar-low', (low / max) * 100);
      setBar('zu-bar-etf', etfRisk ? 60 : 0);

      // callout
      const co = document.getElementById('zu-callout');
      if (co) {
        if (total > 0) {
          setText('zu-callout-headline',
            `${high} line${high !== 1 ? 's' : ''} ready to suspend immediately.`);
          setText('zu-callout-detail',
            `Recoverable: ${fmtMoney(annual)}/yr if all out-of-contract zero-usage lines are suspended.`);
        } else if (total === 0) {
          co.classList.add('success');
          setText('zu-callout-headline', 'No zero-usage lines this cycle.');
          setText('zu-callout-detail', 'Every line had measurable activity. Nothing to suspend.');
        }
      }
    } catch (e) { console.warn('zu band', e); }

    // ---- USAGE REPORT BAND ----
    try {
      const lines = (ur.lines || []);
      const total = ur.summary.totalLines || lines.length || 0;
      const totalMB = lines.reduce((s, l) => s + (l.dataMB || l.data || 0), 0);
      const totalGB = (totalMB / 1024).toFixed(1);
      const overage = lines.filter(l => (l.flags || []).includes('overage') || l.overage).length;
      const zero = ur.summary.zeroUsageCount || zu.totalZeroUsage || 0;

      setText('ur-band-total', total);
      setText('ur-band-data', totalGB);
      setText('ur-band-overage', overage);
      setText('ur-band-zero', zero);

      // percentiles
      const sorted = lines.map(l => l.dataMB || l.data || 0).sort((a, b) => a - b);
      const pct = p => {
        if (!sorted.length) return 0;
        const idx = Math.floor(sorted.length * p);
        return sorted[Math.min(idx, sorted.length - 1)];
      };
      const fmtMB = v => v < 1024 ? `${Math.round(v)} MB` : `${(v / 1024).toFixed(1)} GB`;
      setText('ur-p50', fmtMB(pct(0.50)));
      setText('ur-p75', fmtMB(pct(0.75)));
      setText('ur-p90', fmtMB(pct(0.90)));
      setText('ur-p99', fmtMB(pct(0.99)));
      setText('ur-mean', fmtMB(sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0));

      // histogram (real data)
      const hist = document.getElementById('ur-hist');
      if (hist && sorted.length) {
        const bins = 15;
        const max = sorted[sorted.length - 1] || 1;
        const buckets = new Array(bins).fill(0);
        sorted.forEach(v => {
          const i = Math.min(bins - 1, Math.floor((v / max) * bins));
          buckets[i]++;
        });
        const maxBucket = Math.max(...buckets, 1);
        hist.innerHTML = buckets.map((b, i) => {
          const h = Math.max(2, (b / maxBucket) * 100);
          const cls = i === 0 ? 'col zero' : 'col';
          return `<div class="${cls}" style="height:${h}%" title="${b} lines"></div>`;
        }).join('');
      }
    } catch (e) { console.warn('ur band', e); }

    // ---- RATE PLANS BAND ----
    try {
      const plans = data.ratePlans && data.ratePlans.plans ? data.ratePlans.plans : [];
      const distinct = plans.length;
      const totalLines = plans.reduce((s, p) => s + (p.count || 0), 0);
      const totalCost = plans.reduce((s, p) => s + (p.totalCost || 0), 0);
      const avg = totalLines ? totalCost / totalLines : 0;
      const matched = plans.filter(p => p.matched).length;
      const matchPct = distinct ? Math.round((matched / distinct) * 100) : 0;

      setText('rp-band-plans', distinct);
      setText('rp-band-avg', fmtMoney(avg));
      setText('rp-band-match', matchPct + '%');

      // composition stack (top 5 + other)
      const sorted = plans.slice().sort((a, b) => (b.count || 0) - (a.count || 0));
      const top = sorted.slice(0, 4);
      const otherCount = sorted.slice(4).reduce((s, p) => s + (p.count || 0), 0);
      const palette = ['#6366f1', '#22c55e', '#f7931e', '#ef4444', '#a78bfa'];
      const segments = top.map((p, i) => ({
        name: p.plan || p.planName || 'Plan',
        count: p.count || 0,
        color: palette[i],
      }));
      if (otherCount) segments.push({ name: 'Other', count: otherCount, color: palette[4] });

      const stack = document.getElementById('rp-stack');
      const legend = document.getElementById('rp-legend');
      if (stack && totalLines) {
        stack.innerHTML = segments.map(s => {
          const w = (s.count / totalLines) * 100;
          return `<div style="background:${s.color};width:${w}%" title="${s.name}: ${s.count} lines">${w >= 8 ? Math.round(w) + '%' : ''}</div>`;
        }).join('');
      }
      if (legend && totalLines) {
        legend.innerHTML = segments.map(s =>
          `<div class="rp-legend-item"><span class="sw" style="background:${s.color}"></span>${s.name} <span class="ct">(${s.count})</span></div>`
        ).join('');
      }

      // insight
      if (distinct >= 5) {
        setText('rp-insight-headline', `${distinct} distinct plans across the fleet.`);
        setText('rp-insight-detail', 'Consolidating to 2-3 plans typically cuts admin overhead and unlocks volume pricing tiers.');
      } else if (distinct > 0) {
        setText('rp-insight-headline', `Plan portfolio is consolidated.`);
        setText('rp-insight-detail', `${distinct} plan${distinct !== 1 ? 's' : ''} in use — good baseline. Focus on right-sizing within each tier.`);
      }
    } catch (e) { console.warn('rp band', e); }

    // ---- PLAN COMPARISON BAND ----
    try {
      const monthly = pc.totalMonthlySavings || 0;
      const annual = monthly * 12;
      const curMRC = pc.currentTotal || 0;
      const propMRC = pc.proposedTotal || 0;
      const totalLines = (pc.lines || []).length;
      const proposedLines = (pc.lines || []).filter(l => l.proposedPlan).length;

      setText('pc-big-annual', fmtMoney(annual));
      setText('pc-big-monthly', fmtMoney(monthly));
      setText('pc-big-lines', proposedLines);
      setText('pc-cur-mrc', fmtMoney(curMRC) + '/mo');
      setText('pc-prop-mrc', fmtMoney(propMRC) + '/mo');
      setText('pc-coverage-pct', totalLines ? Math.round((proposedLines / totalLines) * 100) : 0);
      setText('pc-coverage-lines', `${proposedLines} of ${totalLines}`);
      const cut = curMRC ? ((curMRC - propMRC) / curMRC) * 100 : 0;
      setText('pc-pct-cut', cut > 0 ? `${cut.toFixed(1)}% reduction` : 'No reduction yet');

      // monthly/annual toggle
      document.querySelectorAll('[data-pc-view]').forEach(b => {
        b.onclick = () => {
          document.querySelectorAll('[data-pc-view]').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
          const isAnnual = b.dataset.pcView === 'annual';
          setText('pc-big-annual', fmtMoney(isAnnual ? annual : monthly));
          const eyebrow = b.closest('.pc-savings').querySelector('.pc-savings-cell .eyebrow');
          if (eyebrow) eyebrow.textContent = isAnnual ? 'Annual Savings if Adopted' : 'Monthly Savings if Adopted';
        };
      });
    } catch (e) { console.warn('pc band', e); }

    // ---- DISCREPANCIES BAND ----
    try {
      const ds = data.discrepancies || [];
      const open = ds.filter(d => !d.resolved && !d.inReview).length;
      const review = ds.filter(d => d.inReview).length;
      const resolved = ds.filter(d => d.resolved).length;
      setText('disc-band-open', open);
      setText('disc-band-review', review);
      setText('disc-band-resolved', resolved);
    } catch (e) { console.warn('disc band', e); }

    // ---- EXPORTS BAND ----
    try {
      const dt = new Date();
      const dateStr = dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      setText('exp-run-date', dateStr);
      setText('exp-run-client', data.clientName || 'Audit complete');
      setText('exp-lines', ctx.lineCount || ur.summary.totalLines || 0);
      const carriers = data.carriers ? data.carriers.length : 1;
      setText('exp-carriers', `${carriers} carrier${carriers !== 1 ? 's' : ''}`);
      const findings = (zu.totalZeroUsage || 0) + ((pc.lines || []).filter(l => l.proposedPlan).length);
      setText('exp-findings', findings);
      const totalSavings = ((zu.totalMonthlySavings || 0) + (pc.totalMonthlySavings || 0)) * 12;
      setText('exp-savings', fmtMoney(totalSavings));
    } catch (e) { console.warn('exp band', e); }
  }

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }
  function setBar(id, pct) {
    const el = document.getElementById(id);
    if (el) el.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }

  // ═══════════════════════════════════════════════════════
  // DASHBOARD REDESIGN — populate the new visual elements.
  // Legacy IDs are still set above; this fills in:
  //   - hero delta vs prior cycle
  //   - breakdown percent bars + sublabels
  //   - zero-usage callout under the hero
  //   - fleet stacked bar + segment widths
  //   - in-contract donut (CSS conic-gradient)
  //   - recommendation list (ranked by monthly savings)
  // ═══════════════════════════════════════════════════════
  function populateDashboardExtras(data, ctx) {
    const { totalSpend, lineCount, inv, planTotal, equipTotal, feesTotal, taxesTotal, activityVal, snapshot } = ctx;
    const ur = data.usageReport;
    const zu = data.zeroUsageSummary;

    // ── Hero delta vs prior cycle ─────────────────────────────────────────
    const deltaEl = document.getElementById('dash-hero-delta');
    if (deltaEl) {
      const snaps = (data.trend && data.trend.snapshots) || [];
      const idx = snapshot ? snaps.findIndex(s => s.cycle === snapshot.cycle) : -1;
      const prev = idx > 0 ? snaps[idx - 1] : null;
      if (prev && prev.bill && prev.bill.total) {
        const delta = totalSpend - prev.bill.total;
        const pct = (delta / prev.bill.total) * 100;
        const sign = delta > 0 ? '↑' : (delta < 0 ? '↓' : '→');
        deltaEl.textContent = `${sign} ${fmtMoney(Math.abs(delta))} (${Math.abs(pct).toFixed(1)}%)`;
        deltaEl.className = 'dash-delta ' + (delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat');
      } else {
        deltaEl.textContent = '— first cycle';
        deltaEl.className = 'dash-delta flat';
      }
    }

    // ── Breakdown percent bars ────────────────────────────────────────────
    // Activity (credits) treated as absolute for proportion math, otherwise
    // a negative slice would distort the bar widths.
    const breakdownTotal = Math.max(
      planTotal + equipTotal + feesTotal + taxesTotal + Math.abs(activityVal || 0),
      1
    );
    const setBar = (key, val) => {
      const bar = document.querySelector(`.dash-mini-bar > [data-bar="${key}"]`);
      const sub = document.querySelector(`.dash-mini-sub[data-pct="${key}"]`);
      const pct = (Math.abs(val) / breakdownTotal) * 100;
      if (bar) bar.style.width = pct.toFixed(1) + '%';
      if (sub) sub.textContent = pct.toFixed(0) + '% of bill';
    };
    setBar('plan',  planTotal);
    setBar('equip', equipTotal);
    setBar('surch', feesTotal);
    setBar('tax',   taxesTotal);
    setBar('act',   activityVal || 0);

    // ── Zero-usage callout (under hero) ───────────────────────────────────
    const calloutEl = document.getElementById('dash-callout');
    const headlineEl = document.getElementById('dash-callout-headline');
    const detailEl = document.getElementById('dash-callout-detail');
    if (calloutEl && headlineEl && detailEl) {
      const isTangoe = data.meta && data.meta.source === 'tangoe';
      if (isTangoe) {
        // Tangoe carries no usage metrics — different message, different deep link.
        headlineEl.textContent = `${ur.summary.upgradeEligible || 0} phones eligible for upgrade.`;
        detailEl.textContent = ' Tangoe exports lack usage data; review contract status instead.';
        calloutEl.style.display = (ur.summary.upgradeEligible || 0) > 0 ? '' : 'none';
      } else if (zu.cancelSavings > 0) {
        headlineEl.textContent = `${fmtMoney(zu.cancelSavings)}/mo leaking on idle lines.`;
        detailEl.textContent = ` ${zu.outOfContract || 0} zero-usage lines are out of contract — cancellable now.`;
        calloutEl.style.display = '';
      } else if (zu.totalZeroUsage > 0) {
        headlineEl.textContent = `${zu.totalZeroUsage} zero-usage lines under contract.`;
        detailEl.textContent = ' Suspending or downgrading these would reduce next cycle\'s bill.';
        calloutEl.style.display = '';
      } else {
        calloutEl.style.display = 'none';
      }
    }

    // ── Fleet stacked bar + segment widths ────────────────────────────────
    const phoneCount = inv.smartphones || 0;
    const tabCount   = (inv.tablets || 0) + (inv.hotspots || 0);
    const wearCount  = inv.watches || 0;
    const fleetTotal = Math.max(phoneCount + tabCount + wearCount, 1);
    const setSeg = (seg, n) => {
      const el = document.querySelector(`.dash-stack-bar > [data-seg="${seg}"]`);
      if (!el) return;
      const pct = (n / fleetTotal) * 100;
      el.style.width = pct.toFixed(1) + '%';
      const valEl = el.querySelector('.seg-val');
      if (valEl) valEl.textContent = n > 0 ? `${n} · ${pct.toFixed(0)}%` : '';
      el.style.display = n > 0 ? '' : 'none';
    };
    setSeg('phone', phoneCount);
    setSeg('tab',   tabCount);
    setSeg('wear',  wearCount);

    // ── In-contract donut (CSS conic-gradient) ────────────────────────────
    const donut = document.getElementById('dash-donut');
    const donutPctEl = document.getElementById('dash-donut-pct');
    const totalContractable = (ur.summary.upgradeEligible || 0) + (ur.summary.inContract || 0);
    const inContractPct = totalContractable > 0
      ? ((ur.summary.inContract || 0) / totalContractable) * 100
      : 0;
    if (donut) {
      donut.style.background =
        `conic-gradient(#f7931e 0 ${inContractPct.toFixed(1)}%, rgba(255,255,255,0.08) ${inContractPct.toFixed(1)}% 100%)`;
    }
    if (donutPctEl) donutPctEl.textContent = inContractPct.toFixed(0) + '%';

    // ── Ranked recommendations ────────────────────────────────────────────
    renderRecommendations(data);
  }

  // ═══════════════════════════════════════════════════════
  // RECOMMENDATIONS — top-N actions ranked by monthly savings.
  // ═══════════════════════════════════════════════════════
  function renderRecommendations(data) {
    const list = document.getElementById('dash-rec-list');
    const totalEl = document.getElementById('dash-rec-total');
    const doneEl = document.getElementById('dash-rec-done');
    if (!list) return;

    const zu = data.zeroUsageSummary;
    const ur = data.usageReport;
    const isTangoe = data.meta && data.meta.source === 'tangoe';

    // Build the candidate set, then sort by monthly $ saved and keep top 5.
    const recs = [];

    if (!isTangoe && zu.cancelSavings > 0) {
      recs.push({
        title: `Cancel ${zu.outOfContract || 0} idle out-of-contract lines`,
        savings: zu.cancelSavings,
        meta: 'Zero usage + no ETF — cancellable on next bill cycle.',
        deepLink: 'zero-usage',
        deepLinkLabel: 'Open Zero Usage tab',
      });
    }
    if (!isTangoe && zu.suspendSavings > 0) {
      recs.push({
        title: `Suspend ${zu.suspendCount || 0} idle in-contract lines`,
        savings: zu.suspendSavings,
        meta: 'Carrier seasonal-suspend keeps the line dormant at reduced MRC.',
        deepLink: 'zero-usage',
        deepLinkLabel: 'Open Zero Usage tab',
      });
    }
    const planOpts = (data.ratePlans && data.ratePlans.summary && data.ratePlans.summary.highZeroUsagePlans) || 0;
    if (planOpts > 0) {
      recs.push({
        title: `Re-rate ${planOpts} plans with low utilization`,
        savings: 0,
        meta: 'Quote a smaller plan tier — savings depend on carrier price book.',
        deepLink: 'rate-plans',
        deepLinkLabel: 'Open Rate Plans tab',
      });
    }
    const upgrade = ur.summary.upgradeEligible || 0;
    if (upgrade > 0) {
      recs.push({
        title: `Renegotiate ${upgrade} upgrade-eligible contracts`,
        savings: 0,
        meta: 'Out-of-contract phones — leverage for plan or device incentives.',
        deepLink: 'usage-report',
        deepLinkLabel: 'Open Usage Report tab',
      });
    }
    if (data.discrepancyReport && data.discrepancyReport.discrepancyCount > 0) {
      recs.push({
        title: `Resolve ${data.discrepancyReport.discrepancyCount} discrepancies`,
        savings: 0,
        meta: 'Mismatches between carrier file and audit ledger — review before client call.',
        deepLink: 'discrepancies',
        deepLinkLabel: 'Open Discrepancies tab',
      });
    }
    if (data.planComparison && data.planComparison.totalSavings > 0) {
      recs.push({
        title: 'Switch carriers based on plan comparison',
        savings: data.planComparison.totalSavings,
        meta: 'Modeled savings vs current carrier — verify with quote.',
        deepLink: 'plan-comparison',
        deepLinkLabel: 'Open Plan Comparison tab',
      });
    }

    // Sort: highest savings first; zero-savings recs follow in their natural order.
    recs.sort((a, b) => (b.savings || 0) - (a.savings || 0));
    const top = recs.slice(0, 5);

    if (top.length === 0) {
      list.innerHTML = '<div style="padding:32px 0;text-align:center;color:var(--text-secondary);font-size:12.5px;">No recommendations — this audit is clean.</div>';
      if (totalEl) totalEl.textContent = '0';
      if (doneEl)  doneEl.textContent  = '0';
      return;
    }

    list.innerHTML = top.map((r, i) => {
      const savingsLabel = r.savings > 0 ? `${fmtMoney(r.savings)} / mo` : 'Quote required';
      return `
        <div class="dash-rec-item" data-rec-idx="${i}">
          <div class="dash-rec-checkbox" data-rec-check="${i}" role="checkbox" aria-checked="false" tabindex="0"></div>
          <div class="dash-rec-rank">${i + 1}.</div>
          <div class="dash-rec-body">
            <div class="dash-rec-title-row">
              <span class="dash-rec-title-text">${escapeHtml(r.title)}</span>
              <span class="dash-rec-savings">${savingsLabel}</span>
            </div>
            <div class="dash-rec-meta">
              ${escapeHtml(r.meta)}
              ${r.deepLink ? ` <a data-deep-link="${r.deepLink}">${escapeHtml(r.deepLinkLabel)} →</a>` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');

    if (totalEl) totalEl.textContent = String(top.length);
    if (doneEl)  doneEl.textContent  = '0';

    // Wire checkboxes (purely visual — strikes through and decrements progress).
    list.querySelectorAll('.dash-rec-checkbox').forEach((box) => {
      box.addEventListener('click', () => {
        const item = box.closest('.dash-rec-item');
        const wasChecked = box.classList.toggle('checked');
        box.setAttribute('aria-checked', wasChecked ? 'true' : 'false');
        if (item) item.classList.toggle('checked', wasChecked);
        const checked = list.querySelectorAll('.dash-rec-checkbox.checked').length;
        if (doneEl) doneEl.textContent = String(checked);
      });
    });
  }

  // Tiny helper — avoids dragging in a full HTML escaper.
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ═══════════════════════════════════════════════════════
  // CYCLE SELECTOR + MONTH LABEL (dashboard header)
  // ═══════════════════════════════════════════════════════
  function renderCycleSelector(data) {
    const host = document.getElementById('cycle-selector');
    if (!host) return;
    const scopeBar = document.getElementById('audit-scope-bar');
    const snapshots = (data.trend && data.trend.snapshots) || [];
    if (snapshots.length < 1) {
      host.style.display = 'none';
      if (scopeBar) scopeBar.style.display = 'none';
      return;
    }
    host.style.display = '';
    if (scopeBar) scopeBar.style.display = 'flex';
    // Only rebuild the dropdown when cycles change, so the user's in-flight
    // selection isn't clobbered on tab switches.
    const sig = snapshots.map(s => s.cycle).join('|');
    if (host.dataset.cycleSig !== sig) {
      host.innerHTML = '';
      const label = document.createElement('label');
      label.textContent = 'Billing cycle:';
      label.style.cssText = 'font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.05em;';
      host.appendChild(label);
      const sel = document.createElement('select');
      sel.id = 'cycle-selector-input';
      sel.style.cssText = 'margin-left:8px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:13px;cursor:pointer;';
      for (const s of snapshots) {
        const opt = document.createElement('option');
        opt.value = s.cycle;
        opt.textContent = s.monthLabel + ' (' + s.rangeLabel + ')';
        sel.appendChild(opt);
      }
      sel.value = data.activeCycle || snapshots[snapshots.length - 1].cycle;
      sel.addEventListener('change', (e) => {
        data.activeCycle = e.target.value;
        // Re-populate KPIs for the newly selected cycle.
        populateDashboardKPIs(data);
      });
      host.appendChild(sel);
      host.dataset.cycleSig = sig;
    } else {
      const sel = document.getElementById('cycle-selector-input');
      if (sel) sel.value = data.activeCycle || snapshots[snapshots.length - 1].cycle;
    }
  }

  function renderCycleLabel(snapshot) {
    const el = document.getElementById('kpi-total-spend-sub');
    if (!el) return;
    if (!snapshot) { el.textContent = 'Current billing period'; return; }
    el.textContent = snapshot.monthLabel + ' · ' + snapshot.rangeLabel;
  }

  // ═══════════════════════════════════════════════════════
  // TREND TAB — month-over-month rollups and line-change lists
  // ═══════════════════════════════════════════════════════
  function populateTrendTab(data) {
    const host = document.getElementById('tab-trend-content');
    if (!host) return;
    const trend = data.trend;
    if (!trend || !trend.snapshots || trend.snapshots.length === 0) {
      host.innerHTML = '<p style="color:var(--text-secondary);padding:24px;">No cycle data available.</p>';
      return;
    }
    if (trend.snapshots.length < 2) {
      host.innerHTML = '<p style="color:var(--text-secondary);padding:24px;">Only one billing cycle in the uploaded data — trend comparisons need at least two cycles. Re-export with the last 3 months from Premier and re-run the audit.</p>';
      return;
    }

    const snaps = trend.snapshots;
    const deltas = trend.deltas;

    let html = '';

    // ── Per-cycle summary table ────────────────────────────────────────────
    html += `<div style="margin-bottom:16px;overflow-x:auto;">
      <table class="data-table" style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr style="background:#1a3a5c;color:#fff;text-transform:uppercase;font-size:11px;letter-spacing:0.03em;">
          <th style="padding:10px 14px;text-align:left;">Cycle</th>
          <th style="padding:10px 14px;text-align:right;">Bill Total</th>
          <th style="padding:10px 14px;text-align:right;">Plan</th>
          <th style="padding:10px 14px;text-align:right;">Surcharges</th>
          <th style="padding:10px 14px;text-align:right;">Taxes</th>
          <th style="padding:10px 14px;text-align:right;">Activity</th>
          <th style="padding:10px 14px;text-align:right;">Lines</th>
          <th style="padding:10px 14px;text-align:right;">Bill Δ vs prior</th>
          <th style="padding:10px 14px;text-align:right;">Lines Δ</th>
        </tr></thead><tbody>`;
    for (let i = 0; i < snaps.length; i++) {
      const s = snaps[i];
      const d = deltas[i];
      const billDelta = d && !d.isFirst ? d.billDelta : null;
      const lineDelta = d && !d.isFirst ? d.lineCountDelta : null;
      const billDeltaHtml = billDelta == null ? '—'
        : (billDelta >= 0
            ? `<span style="color:#ef4444;">+${fmtMoney(billDelta)}</span>`
            : `<span style="color:#22c55e;">-${fmtMoney(Math.abs(billDelta))}</span>`);
      const lineDeltaHtml = lineDelta == null ? '—'
        : (lineDelta > 0 ? `<span style="color:#22c55e;">+${lineDelta}</span>`
           : lineDelta < 0 ? `<span style="color:#ef4444;">${lineDelta}</span>`
           : '0');
      html += `<tr style="border-bottom:1px solid var(--border);">
        <td style="padding:10px 14px;"><strong>${s.monthLabel}</strong><br><span style="font-size:11px;color:var(--text-secondary);">${s.rangeLabel}</span></td>
        <td style="padding:10px 14px;text-align:right;font-weight:600;">${fmtMoney(s.bill.total)}</td>
        <td style="padding:10px 14px;text-align:right;">${fmtMoney(s.bill.plan)}</td>
        <td style="padding:10px 14px;text-align:right;">${fmtMoney(s.bill.surcharges)}</td>
        <td style="padding:10px 14px;text-align:right;">${fmtMoney(s.bill.taxes)}</td>
        <td style="padding:10px 14px;text-align:right;color:${s.bill.activity < 0 ? '#22c55e' : ''};">${s.bill.activity < 0 ? '-' : ''}${fmtMoney(Math.abs(s.bill.activity))}</td>
        <td style="padding:10px 14px;text-align:right;">${s.lineCount}</td>
        <td style="padding:10px 14px;text-align:right;">${billDeltaHtml}</td>
        <td style="padding:10px 14px;text-align:right;">${lineDeltaHtml}</td>
      </tr>`;
    }
    html += `</tbody></table></div>`;

    // ── Bill-trend chart ───────────────────────────────────────────────────
    html += `<div style="margin-bottom:16px;padding:16px;background:var(--card);border:1px solid var(--border);border-radius:8px;">
      <div style="font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Bill trend</div>
      <canvas id="chart-trend-bill" style="max-height:200px;"></canvas>
    </div>`;

    // ── Per-cycle line-change details ──────────────────────────────────────
    for (const d of deltas) {
      if (d.isFirst) continue;
      html += renderCycleDeltaBlock(d);
    }

    host.innerHTML = html;

    // Draw the chart after the canvas is in the DOM
    drawTrendChart(snaps);
  }

  function renderCycleDeltaBlock(d) {
    const section = (title, items, renderItem, emptyMsg, color) => {
      if (!items || items.length === 0) {
        return `<details style="margin:6px 0;"><summary style="cursor:pointer;padding:6px 10px;color:var(--text-secondary);font-size:12px;">${title}: <strong>0</strong></summary><p style="margin:8px 14px;color:var(--text-muted);font-size:12px;">${emptyMsg || 'None this cycle.'}</p></details>`;
      }
      const rows = items.map(renderItem).join('');
      return `<details style="margin:6px 0;" open><summary style="cursor:pointer;padding:6px 10px;color:${color || 'var(--text)'};font-weight:600;font-size:12px;">${title}: <strong>${items.length}</strong></summary>
        <div style="margin:6px 0;overflow-x:auto;"><table style="width:100%;font-size:12px;border-collapse:collapse;">
          ${rows}
        </table></div></details>`;
    };

    const addedRows    = section('🟢 Added',       d.added,       a => `<tr><td style="padding:4px 10px;font-variant-numeric:tabular-nums;">${a.wireless}</td><td style="padding:4px 10px;">${a.userName || ''}</td><td style="padding:4px 10px;color:var(--text-secondary);">${a.ratePlan || ''}</td><td style="padding:4px 10px;color:var(--text-muted);">${a.activationDate ? 'activated ' + a.activationDate : ''}</td></tr>`, null, '#22c55e');
    const cxlRows      = section('🔴 Cancelled',   d.cancelled,   c => `<tr><td style="padding:4px 10px;font-variant-numeric:tabular-nums;">${c.wireless}</td><td style="padding:4px 10px;">${c.userName || ''}</td><td style="padding:4px 10px;color:var(--text-secondary);">${c.deviceType || ''}</td><td style="padding:4px 10px;color:var(--text-muted);">${c.reason}</td></tr>`, null, '#ef4444');
    const suspRows     = section('🟡 Suspended',   d.suspended,   s => `<tr><td style="padding:4px 10px;font-variant-numeric:tabular-nums;">${s.wireless}</td><td style="padding:4px 10px;">${s.userName || ''}</td><td style="padding:4px 10px;color:var(--text-secondary);">${s.deviceType || ''}</td></tr>`, null, '#f59e0b');
    const upgradeRows  = section('📱 Device upgrades', d.upgrades, u => `<tr><td style="padding:4px 10px;font-variant-numeric:tabular-nums;">${u.wireless}</td><td style="padding:4px 10px;">${u.userName || ''}</td><td style="padding:4px 10px;color:var(--text-secondary);">${u.deviceMake} ${u.deviceModel}</td><td style="padding:4px 10px;color:var(--text-muted);">upgraded ${u.lastUpgradeDate}</td></tr>`);
    const planRows     = section('🔄 Rate-plan changes', d.planChanges, p => `<tr><td style="padding:4px 10px;font-variant-numeric:tabular-nums;">${p.wireless}</td><td style="padding:4px 10px;">${p.userName || ''}</td><td style="padding:4px 10px;font-size:11px;color:var(--text-secondary);">${p.fromPlan} → ${p.toPlan}</td></tr>`);
    const portRows     = section('🔁 Number changes (port-in)', d.portIns, p => `<tr><td style="padding:4px 10px;font-variant-numeric:tabular-nums;">${p.oldWireless} → ${p.newWireless}</td><td style="padding:4px 10px;">${p.userName || ''}</td><td style="padding:4px 10px;color:var(--text-muted);">${p.reason}</td></tr>`);
    const anomalyRows  = section('⚠ Charge anomalies', d.anomalies, a => `<tr><td style="padding:4px 10px;font-variant-numeric:tabular-nums;">${a.wireless}</td><td style="padding:4px 10px;">${a.userName || ''}</td><td style="padding:4px 10px;text-align:right;">${fmtMoney(a.prevTotal)} → ${fmtMoney(a.currTotal)}</td><td style="padding:4px 10px;color:${a.diff >= 0 ? '#ef4444' : '#22c55e'};">${a.diff >= 0 ? '+' : ''}${fmtMoney(a.diff)}</td></tr>`, null, '#f59e0b');

    // Rate-plan migration rollup
    let migrationHtml = '';
    if (d.planMigrations && d.planMigrations.length > 0) {
      migrationHtml = `<details style="margin:6px 0;" open><summary style="cursor:pointer;padding:6px 10px;color:var(--text);font-weight:600;font-size:12px;">📊 Rate-plan migration rollup</summary>
        <table style="width:100%;font-size:12px;border-collapse:collapse;margin-top:6px;">
        ${d.planMigrations.map(m => `<tr><td style="padding:4px 10px;">${m.fromPlan} → ${m.toPlan}</td><td style="padding:4px 10px;text-align:right;"><strong>${m.count}</strong> line${m.count === 1 ? '' : 's'}</td></tr>`).join('')}
        </table></details>`;
    }

    return `<div style="margin-bottom:20px;padding:16px;background:var(--card);border:1px solid var(--border);border-radius:8px;">
      <div style="font-size:14px;font-weight:700;margin-bottom:4px;">${d.monthLabel} vs ${d.prevMonthLabel}</div>
      <div style="font-size:12px;color:var(--text-secondary);margin-bottom:12px;">Bill Δ ${d.billDelta >= 0 ? '+' : '-'}${fmtMoney(Math.abs(d.billDelta))} · Lines Δ ${d.lineCountDelta >= 0 ? '+' : ''}${d.lineCountDelta}</div>
      ${addedRows}${cxlRows}${suspRows}${upgradeRows}${planRows}${portRows}${anomalyRows}${migrationHtml}
    </div>`;
  }

  let trendChart = null;
  function drawTrendChart(snaps) {
    const ctx = document.getElementById('chart-trend-bill');
    if (!ctx || typeof Chart === 'undefined') return;
    if (trendChart) trendChart.destroy();
    trendChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: snaps.map(s => s.monthLabel),
        datasets: [{
          label: 'Bill Total ($)',
          data: snaps.map(s => s.bill.total),
          backgroundColor: '#f7931e',
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#a1a1aa' }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { ticks: { color: '#a1a1aa', callback: (v) => '$' + v.toLocaleString() }, grid: { color: 'rgba(255,255,255,0.05)' } },
        },
      },
    });
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

    // ── Hero sparkline (new dashboard) ──────────────────────────────────
    // Uses cycle-trend snapshots so the auditor sees spend trajectory at a glance.
    drawDashSparkline(data);
  }

  // ═══════════════════════════════════════════════════════
  // HERO SPARKLINE — small spend-over-cycles strip on the dashboard hero.
  // Drawn manually (no Chart.js) so it stays crisp at 240×70 with no chrome.
  // ═══════════════════════════════════════════════════════
  function drawDashSparkline(data) {
    const cv = document.getElementById('dash-spark');
    if (!cv) return;
    const snaps = (data.trend && data.trend.snapshots) || [];
    const ctx2 = cv.getContext('2d');
    if (!ctx2) return;

    // Resize for HiDPI
    const cssW = cv.clientWidth || 240;
    const cssH = cv.clientHeight || 70;
    const dpr = window.devicePixelRatio || 1;
    cv.width  = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2.clearRect(0, 0, cssW, cssH);

    if (snaps.length < 2) {
      ctx2.fillStyle = 'rgba(255,255,255,0.35)';
      ctx2.font = '10px "JetBrains Mono", "SF Mono", Menlo, monospace';
      ctx2.textAlign = 'right';
      ctx2.textBaseline = 'middle';
      ctx2.fillText('Need 2+ cycles for trend', cssW - 4, cssH / 2);
      return;
    }

    const vals = snaps.map(s => s.bill && s.bill.total ? s.bill.total : 0);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const pad = 8;
    const range = (max - min) || 1;
    const xStep = (cssW - pad * 2) / (vals.length - 1);
    const points = vals.map((v, i) => ({
      x: pad + i * xStep,
      y: cssH - pad - ((v - min) / range) * (cssH - pad * 2),
    }));

    // Area fill (subtle)
    const grad = ctx2.createLinearGradient(0, 0, 0, cssH);
    grad.addColorStop(0, 'rgba(247,147,30,0.30)');
    grad.addColorStop(1, 'rgba(247,147,30,0.00)');
    ctx2.fillStyle = grad;
    ctx2.beginPath();
    ctx2.moveTo(points[0].x, cssH - pad);
    points.forEach(p => ctx2.lineTo(p.x, p.y));
    ctx2.lineTo(points[points.length - 1].x, cssH - pad);
    ctx2.closePath();
    ctx2.fill();

    // Line
    ctx2.strokeStyle = '#f7931e';
    ctx2.lineWidth = 1.5;
    ctx2.lineJoin = 'round';
    ctx2.beginPath();
    points.forEach((p, i) => i ? ctx2.lineTo(p.x, p.y) : ctx2.moveTo(p.x, p.y));
    ctx2.stroke();

    // Last-point dot
    const last = points[points.length - 1];
    ctx2.fillStyle = '#f7931e';
    ctx2.beginPath();
    ctx2.arc(last.x, last.y, 3, 0, Math.PI * 2);
    ctx2.fill();
    ctx2.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx2.lineWidth = 1;
    ctx2.stroke();
  }

  // ═══════════════════════════════════════════════════════
  // DEEP-LINK BUTTONS — clicks on [data-deep-link="<tab>"] switch to that tab.
  // Delegated listener so dynamically-rendered recommendations work too.
  // ═══════════════════════════════════════════════════════
  document.addEventListener('click', (ev) => {
    const trigger = ev.target.closest('[data-deep-link]');
    if (!trigger) return;
    const tabName = trigger.getAttribute('data-deep-link');
    if (!tabName) return;
    ev.preventDefault();
    const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
    if (btn && typeof btn.click === 'function') btn.click();
  });

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

      // Stephen May-22: 4-column savings breakdown so the client can see
      // Rate Plan + Device + Fees+Taxes separately, then Total. No more
      // single mystery savings number.
      const sPlan = r.savingsRatePlan || 0;
      const sDev  = r.savingsDevice || 0;
      const sFee  = r.savingsFeesAndTaxes || 0;
      const sTot  = r.savingsTotal || r.monthlySavings || 0;

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
        <td class="number" style="color:#22c55e">${fmtMoney(sPlan)}</td>
        <td class="number" style="color:#22c55e">${fmtMoney(sDev)}</td>
        <td class="number" style="color:#a1a1aa">${fmtMoney(sFee)}</td>
        <td class="number" style="color:#22c55e;font-weight:700">${fmtMoney(sTot)}</td>
      </tr>`;
    }

    // Total row
    const sumPlan = data.zeroUsageResults.reduce((s,r) => s + (r.savingsRatePlan || 0), 0);
    const sumDev  = data.zeroUsageResults.reduce((s,r) => s + (r.savingsDevice || 0), 0);
    const sumFee  = data.zeroUsageResults.reduce((s,r) => s + (r.savingsFeesAndTaxes || 0), 0);
    html += `<tr style="background:rgba(34,197,94,0.08);font-weight:600">
      <td colspan="4">TOTAL — ${data.zeroUsageResults.length} lines</td>
      <td class="number">${fmtMoney(data.zeroUsageResults.reduce((s,r) => s + (r.mrc||0), 0))}</td>
      <td colspan="4"></td>
      <td class="number" style="color:#22c55e">${fmtMoney(sumPlan)}</td>
      <td class="number" style="color:#22c55e">${fmtMoney(sumDev)}</td>
      <td class="number" style="color:#a1a1aa">${fmtMoney(sumFee)}</td>
      <td class="number" style="color:#22c55e;font-weight:700">${fmtMoney(zu.totalMonthlySavings)}</td>
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
        <th style="padding:8px 10px;text-align:right" title="Net plan MRC (gross plan - recurring credits)">Net MRC</th>
        <th style="padding:8px 10px;text-align:center">Contract?</th>
        <th style="padding:8px 10px">Contract End</th>
        <th style="padding:8px 10px">Action</th>
        <th style="padding:8px 10px">Reason</th>
        <th style="padding:8px 10px;text-align:right" title="Rate plan savings">Save: Plan</th>
        <th style="padding:8px 10px;text-align:right" title="Device installment savings">Save: Device</th>
        <th style="padding:8px 10px;text-align:right" title="Fees + taxes savings">Save: Fees+Taxes</th>
        <th style="padding:8px 10px;text-align:right" title="Total monthly savings">Save: Total</th>
      </tr></thead><tbody>`;

    for (const r of data.zeroUsageResults) {
      const actionColor = r.action.includes('CANCEL') ? '#ef4444' : (r.action === 'SUSPEND' ? '#f59e0b' : '#6b6b76');
      const contractBadge = r.hasActiveContract
        ? '<span style="background:rgba(239,68,68,0.15);color:#ef4444;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600">YES</span>'
        : '<span style="background:rgba(34,197,94,0.15);color:#22c55e;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600">NO</span>';

      const sPlan = r.savingsRatePlan || 0;
      const sDev  = r.savingsDevice || 0;
      const sFee  = r.savingsFeesAndTaxes || 0;
      const sTot  = r.savingsTotal || r.monthlySavings || 0;

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
        <td style="padding:6px 10px;text-align:right;color:#22c55e;font-variant-numeric:tabular-nums">${fmtMoney(sPlan)}</td>
        <td style="padding:6px 10px;text-align:right;color:#22c55e;font-variant-numeric:tabular-nums">${fmtMoney(sDev)}</td>
        <td style="padding:6px 10px;text-align:right;color:#a1a1aa;font-variant-numeric:tabular-nums">${fmtMoney(sFee)}</td>
        <td style="padding:6px 10px;text-align:right;color:#22c55e;font-weight:700;font-variant-numeric:tabular-nums">${fmtMoney(sTot)}</td>
      </tr>`;
    }

    // Total row
    const sumPlan = data.zeroUsageResults.reduce((s,r) => s + (r.savingsRatePlan || 0), 0);
    const sumDev  = data.zeroUsageResults.reduce((s,r) => s + (r.savingsDevice || 0), 0);
    const sumFee  = data.zeroUsageResults.reduce((s,r) => s + (r.savingsFeesAndTaxes || 0), 0);
    html += `<tr style="background:rgba(34,197,94,0.08);font-weight:600">
      <td style="padding:8px 10px" colspan="4">TOTAL — ${data.zeroUsageResults.length} lines</td>
      <td style="padding:8px 10px;text-align:right">${fmtMoney(data.zeroUsageResults.reduce((s,r) => s + (r.mrc||0), 0))}</td>
      <td colspan="4"></td>
      <td style="padding:8px 10px;text-align:right;color:#22c55e">${fmtMoney(sumPlan)}</td>
      <td style="padding:8px 10px;text-align:right;color:#22c55e">${fmtMoney(sumDev)}</td>
      <td style="padding:8px 10px;text-align:right;color:#a1a1aa">${fmtMoney(sumFee)}</td>
      <td style="padding:8px 10px;text-align:right;color:#22c55e;font-weight:700">${fmtMoney(zu.totalMonthlySavings)}</td>
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
    const suspendedCount = ur.summary.suspendedCount || 0;
    html += `<div style="margin-bottom:12px;font-size:13px;color:var(--text-secondary);display:flex;gap:16px;flex-wrap:wrap;align-items:center">
      <span>${ur.summary.totalLines} lines</span>
      <span>Total MRC: ${fmtMoney(ur.summary.totalMRC)}</span>
      <span>Avg: ${fmtMoney(ur.summary.avgChargesPerLine)}/line</span>
      <span style="color:#22c55e;font-weight:600">${upgradeCount} upgrade eligible</span>
      <span style="color:#ef4444">${contractCount} in contract</span>
      ${suspendedCount > 0 ? `<span style="color:#f59e0b;font-weight:600">${suspendedCount} suspended</span>` : ''}
    </div>
    <div style="overflow-x:auto"><table class="data-table" style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="background:#1a3a5c;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:0.03em">
        <th style="padding:8px 10px">Wireless</th>
        <th style="padding:8px 10px">User Name</th>
        <th style="padding:8px 10px;text-align:center">Status</th>
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

      // Status badge — Suspended lines stay on the roster but are visually
      // flagged so the user can decide cancel vs reactivate.
      const status = (l.status || 'Active');
      const statusKey = status.toLowerCase();
      const statusColor =
        statusKey === 'suspended' ? { bg: 'rgba(245,158,11,0.15)', fg: '#f59e0b' } :
        statusKey === 'cancelled' ? { bg: 'rgba(239,68,68,0.15)',  fg: '#ef4444' } :
                                    { bg: 'rgba(34,197,94,0.15)',  fg: '#22c55e' };
      const statusBadge = `<span style="background:${statusColor.bg};color:${statusColor.fg};padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600">${status.toUpperCase()}</span>`;
      const rowTint = statusKey === 'suspended' ? 'background:rgba(245,158,11,0.04);' : '';

      html += `<tr style="border-bottom:1px solid rgba(255,255,255,0.05);${rowTint}">
        <td style="padding:6px 10px;font-variant-numeric:tabular-nums">${l.wireless}</td>
        <td style="padding:6px 10px">${l.userName}</td>
        <td style="padding:6px 10px;text-align:center">${statusBadge}</td>
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

  // ═══════════════════════════════════════════════════════
  // ADD-ON FEATURES PANEL — renders the per-category and per-feature
  // breakdown that lives in the Rate Plans tab. Reads data.features which
  // FeatureAnalyzer fills in from chargesDetail (Verizon) or billingLines
  // (AT&T). Empty/missing features → empty-state message, no crash.
  // ═══════════════════════════════════════════════════════
  function populateFeaturesPanel(data) {
    const section   = document.getElementById('features-section');
    const body      = document.getElementById('features-body');
    const emptyEl   = document.getElementById('features-empty');
    const metaEl    = document.getElementById('features-meta');
    if (!section || !body) return;

    const f = data.features || { features: [], categories: [], totalMonthly: 0, featureCount: 0, uniqueLineCount: 0 };

    // Hide entire section for carriers we don't yet support (T-Mobile, Tangoe).
    if (data.carrier !== 'verizon' && data.carrier !== 'att') {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';

    if (!f.featureCount) {
      body.style.display = 'none';
      if (emptyEl) emptyEl.style.display = '';
      if (metaEl) metaEl.textContent = '0 features';
      return;
    }
    body.style.display = '';
    if (emptyEl) emptyEl.style.display = 'none';

    if (metaEl) {
      metaEl.textContent = f.featureCount + ' feature' + (f.featureCount === 1 ? '' : 's') +
                           ' · ' + fmtMoney(f.totalMonthly) + '/mo';
    }

    // Headline strip
    setText('features-total-monthly',  fmtMoney(f.totalMonthly));
    setText('features-total-annual',   fmtMoney(f.annualCost));
    setText('features-line-count',     f.uniqueLineCount);
    setText('features-distinct-count', f.featureCount);

    // Category roll-up table
    const catBody = document.getElementById('features-cat-body');
    if (catBody) {
      catBody.innerHTML = (f.categories || []).map(c => {
        // Highlight uncategorised so Stephen sees that the taxonomy needs a new bucket.
        const isUncat = c.category === 'Other / Uncategorized';
        return '<tr style="border-bottom:1px solid var(--border);' +
               (isUncat ? 'background:rgba(247,147,30,0.06);' : '') + '">' +
               '<td style="padding:8px 10px;">' +
                 (isUncat
                    ? '<span style="color:#f59e0b;font-weight:600;">' + escapeHtml(c.category) + '</span>'
                    : escapeHtml(c.category)) +
               '</td>' +
               '<td style="padding:8px 10px;text-align:right;font-variant-numeric:tabular-nums;">' + c.distinctFeatures + '</td>' +
               '<td style="padding:8px 10px;text-align:right;font-variant-numeric:tabular-nums;">' + c.lineCount + '</td>' +
               '<td style="padding:8px 10px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;">' + fmtMoney(c.totalMonthly) + '</td>' +
               '<td style="padding:8px 10px;text-align:right;font-variant-numeric:tabular-nums;color:var(--text-secondary);">' + fmtMoney(c.annualCost) + '</td>' +
               '</tr>';
      }).join('');
    }

    // Per-feature drill-down table — each row expandable to show the lines.
    const detailBody = document.getElementById('features-detail-body');
    if (detailBody) {
      detailBody.innerHTML = (f.features || []).map((fe, i) => {
        const isUncat = fe.category === 'Other / Uncategorized';
        const linesHtml = (fe.items || [])
          .slice()
          .sort((a, b) => b.cost - a.cost)
          .map(it =>
            '<tr style="border-bottom:1px solid rgba(255,255,255,0.05);">' +
            '<td style="padding:4px 10px;font-family:\'JetBrains Mono\',\'SF Mono\',Menlo,monospace;font-size:11px;">' + escapeHtml(it.wireless) + '</td>' +
            '<td style="padding:4px 10px;">' + escapeHtml(it.userName || '') + '</td>' +
            '<td style="padding:4px 10px;font-family:\'JetBrains Mono\',\'SF Mono\',Menlo,monospace;font-size:10.5px;color:var(--text-secondary);">' + escapeHtml(it.ban || '') + '</td>' +
            '<td style="padding:4px 10px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;">' + fmtMoney(it.cost) + '</td>' +
            '</tr>'
          ).join('');
        return (
          '<tr class="feature-row" data-feat-idx="' + i + '" style="border-bottom:1px solid var(--border);cursor:pointer;">' +
            '<td style="padding:6px 10px;text-align:center;color:var(--text-secondary);font-size:10px;"><span class="feat-chev" data-chev-for="' + i + '">▸</span></td>' +
            '<td style="padding:6px 10px;color:' + (isUncat ? '#f59e0b' : 'var(--text-secondary)') + ';font-size:11px;">' + escapeHtml(fe.category) + '</td>' +
            '<td style="padding:6px 10px;">' + escapeHtml(fe.description) + '</td>' +
            '<td style="padding:6px 10px;text-align:right;font-variant-numeric:tabular-nums;">' + fe.lineCount + '</td>' +
            '<td style="padding:6px 10px;text-align:right;font-variant-numeric:tabular-nums;color:var(--text-secondary);">' + fmtMoney(fe.avgPerLine) + '</td>' +
            '<td style="padding:6px 10px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;">' + fmtMoney(fe.totalMonthly) + '</td>' +
          '</tr>' +
          // Inline expansion row, hidden by default.
          '<tr class="feature-detail-row" data-feat-detail="' + i + '" style="display:none;background:rgba(0,0,0,0.18);">' +
            '<td colspan="6" style="padding:8px 10px 14px 36px;">' +
              '<div style="font-size:10.5px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">Lines paying for this:</div>' +
              '<table style="width:100%;border-collapse:collapse;font-size:11.5px;">' +
                '<thead><tr style="color:var(--text-secondary);text-transform:uppercase;font-size:9.5px;letter-spacing:0.05em;">' +
                  '<th style="padding:4px 10px;text-align:left;">Wireless</th>' +
                  '<th style="padding:4px 10px;text-align:left;">User</th>' +
                  '<th style="padding:4px 10px;text-align:left;">BAN</th>' +
                  '<th style="padding:4px 10px;text-align:right;">Cost / mo</th>' +
                '</tr></thead>' +
                '<tbody>' + linesHtml + '</tbody>' +
              '</table>' +
            '</td>' +
          '</tr>'
        );
      }).join('');

      // Wire row toggle — click a feature row to reveal/hide its line list.
      detailBody.querySelectorAll('tr.feature-row').forEach(row => {
        row.addEventListener('click', () => {
          const idx = row.dataset.featIdx;
          const detail = detailBody.querySelector('tr.feature-detail-row[data-feat-detail="' + idx + '"]');
          const chev = row.querySelector('.feat-chev');
          if (!detail) return;
          const isOpen = detail.style.display !== 'none';
          detail.style.display = isOpen ? 'none' : '';
          if (chev) chev.textContent = isOpen ? '▸' : '▾';
        });
      });
    }

    // ── By-line table ── one row per phone number that has any add-on,
    // sorted by total monthly add-on cost. Click a row to expand the
    // per-feature list for that line.
    const byLineBody = document.getElementById('features-by-line-body');
    const byLineMeta = document.getElementById('features-by-line-meta');
    const lineSpend = f.lineSpend || [];
    if (byLineMeta) {
      const top = lineSpend.slice(0, 5).reduce((s, l) => s + l.totalMonthly, 0);
      const pct = f.totalMonthly ? (top / f.totalMonthly) * 100 : 0;
      byLineMeta.textContent = lineSpend.length + ' line' + (lineSpend.length === 1 ? '' : 's') +
        ' have add-ons. Top 5 = ' + fmtMoney(top) + '/mo (' + pct.toFixed(0) + '% of total feature spend).';
    }
    if (byLineBody) {
      byLineBody.innerHTML = lineSpend.map((l, i) => {
        const innerRows = (l.features || []).map(ft =>
          '<tr style="border-bottom:1px solid rgba(255,255,255,0.05);">' +
          '<td style="padding:3px 10px;color:var(--text-secondary);font-size:10.5px;">' + escapeHtml(ft.category) + '</td>' +
          '<td style="padding:3px 10px;">' + escapeHtml(ft.description) + '</td>' +
          '<td style="padding:3px 10px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;">' + fmtMoney(ft.cost) + '</td>' +
          '</tr>'
        ).join('');
        return (
          '<tr class="byline-row" data-line-idx="' + i + '" style="border-bottom:1px solid var(--border);cursor:pointer;">' +
            '<td style="padding:6px 10px;text-align:center;color:var(--text-secondary);font-size:10px;"><span class="byline-chev" data-byline-chev="' + i + '">▸</span></td>' +
            '<td style="padding:6px 10px;font-family:\'JetBrains Mono\',\'SF Mono\',Menlo,monospace;font-size:11.5px;">' + escapeHtml(l.wireless) + '</td>' +
            '<td style="padding:6px 10px;">' + escapeHtml(l.userName || '') + '</td>' +
            '<td style="padding:6px 10px;font-family:\'JetBrains Mono\',\'SF Mono\',Menlo,monospace;font-size:10.5px;color:var(--text-secondary);">' + escapeHtml(l.ban || '') + '</td>' +
            '<td style="padding:6px 10px;text-align:right;font-variant-numeric:tabular-nums;">' + l.featureCount + '</td>' +
            '<td style="padding:6px 10px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;">' + fmtMoney(l.totalMonthly) + '</td>' +
            '<td style="padding:6px 10px;text-align:right;font-variant-numeric:tabular-nums;color:var(--text-secondary);">' + fmtMoney(l.totalMonthly * 12) + '</td>' +
          '</tr>' +
          '<tr class="byline-detail-row" data-byline-detail="' + i + '" style="display:none;background:rgba(0,0,0,0.18);">' +
            '<td colspan="7" style="padding:8px 10px 14px 36px;">' +
              '<div style="font-size:10.5px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">Add-ons on this line:</div>' +
              '<table style="width:100%;border-collapse:collapse;font-size:11.5px;">' +
                '<thead><tr style="color:var(--text-secondary);text-transform:uppercase;font-size:9.5px;letter-spacing:0.05em;">' +
                  '<th style="padding:4px 10px;text-align:left;">Category</th>' +
                  '<th style="padding:4px 10px;text-align:left;">Feature</th>' +
                  '<th style="padding:4px 10px;text-align:right;">Cost / mo</th>' +
                '</tr></thead>' +
                '<tbody>' + innerRows + '</tbody>' +
              '</table>' +
            '</td>' +
          '</tr>'
        );
      }).join('');

      byLineBody.querySelectorAll('tr.byline-row').forEach(row => {
        row.addEventListener('click', () => {
          const idx = row.dataset.lineIdx;
          const detail = byLineBody.querySelector('tr.byline-detail-row[data-byline-detail="' + idx + '"]');
          const chev = row.querySelector('.byline-chev');
          if (!detail) return;
          const isOpen = detail.style.display !== 'none';
          detail.style.display = isOpen ? 'none' : '';
          if (chev) chev.textContent = isOpen ? '▸' : '▾';
        });
      });
    }
  }

  // ═══════════════════════════════════════════════════════
  // MULTI-BAN SUPPORT — selector + breakout panel + filter.
  // Verizon and AT&T both produce meta.byBan keyed by sub-account number.
  // The dashboard scope dropdown lets the auditor pick "All BANs" or a single
  // sub-account; picking one re-runs the analyzers against only that BAN's
  // lines so every KPI/chart/table reflects that scope.
  // ═══════════════════════════════════════════════════════

  function getActiveBans(data) {
    const all = (data.allMeta && data.allMeta.byBan) || (data.meta && data.meta.byBan) || {};
    // meta.activeBans is set by both parsers (lines whose latest cycle had >$0).
    const activeList = (data.allMeta && data.allMeta.activeBans) ||
                       (data.meta && data.meta.activeBans) ||
                       Object.keys(all);
    return activeList.filter(b => all[b]);
  }

  function renderBanSelector(data) {
    const host = document.getElementById('ban-selector');
    if (!host) return;
    const bans = getActiveBans(data);
    // Hide entirely for single-BAN audits — the dropdown adds noise without it.
    if (bans.length < 2) {
      host.style.display = 'none';
      return;
    }
    host.style.display = '';

    // Only rebuild when the BAN list changes; otherwise the user's in-flight
    // selection survives tab/cycle switches.
    const sig = bans.join('|');
    if (host.dataset.banSig === sig) {
      const sel = host.querySelector('select');
      if (sel) sel.value = data.activeBan || 'ALL';
      return;
    }

    host.innerHTML = '';
    const label = document.createElement('label');
    label.textContent = 'Sub-account:';
    label.style.cssText = 'font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.05em;';
    host.appendChild(label);

    const sel = document.createElement('select');
    sel.id = 'ban-selector-input';
    sel.style.cssText = 'margin-left:8px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:13px;cursor:pointer;min-width:240px;';

    const optAll = document.createElement('option');
    optAll.value = 'ALL';
    optAll.textContent = 'All BANs (' + bans.length + ')';
    sel.appendChild(optAll);

    const allByBan = (data.allMeta && data.allMeta.byBan) || {};
    for (const ban of bans) {
      const info = allByBan[ban] || {};
      const opt = document.createElement('option');
      opt.value = ban;
      const lc = info.latestLineCount != null ? info.latestLineCount : info.lineCount || 0;
      opt.textContent = ban + '  ·  ' + lc + ' line' + (lc === 1 ? '' : 's');
      sel.appendChild(opt);
    }
    sel.value = data.activeBan || 'ALL';
    sel.addEventListener('change', (e) => {
      applyBanFilter(data, e.target.value);
    });
    host.appendChild(sel);
    host.dataset.banSig = sig;
  }

  function renderByBanBreakout(data) {
    const card = document.getElementById('dash-by-ban-card');
    const tbody = document.getElementById('dash-by-ban-rows');
    const metaEl = document.getElementById('dash-by-ban-meta');
    if (!card || !tbody) return;

    const bans = getActiveBans(data);
    if (bans.length < 2) {
      card.style.display = 'none';
      return;
    }
    card.style.display = '';

    const allByBan = (data.allMeta && data.allMeta.byBan) || {};
    const totalLatestBill = bans.reduce((s, b) => s + ((allByBan[b] && allByBan[b].billLatest) || 0), 0);
    if (metaEl) {
      metaEl.textContent = bans.length + ' active BAN' + (bans.length === 1 ? '' : 's') +
                           '  ·  ' + fmtMoney(totalLatestBill) + ' latest bill';
    }

    // Sort by latest-bill descending so the biggest BANs surface at the top.
    const sorted = bans.slice().sort((a, b) => (allByBan[b].billLatest || 0) - (allByBan[a].billLatest || 0));

    tbody.innerHTML = sorted.map(ban => {
      const info = allByBan[ban] || {};
      const isActive = data.activeBan === ban;
      const rowStyle = 'border-bottom:1px solid var(--border);' +
                       (isActive ? 'background:rgba(247,147,30,0.08);' : '');
      const banCell = '<span style="font-family:\'JetBrains Mono\',\'SF Mono\',Menlo,monospace;font-size:12px;">' +
                      escapeHtml(ban) + '</span>' +
                      (info.billName ? '<div style="color:var(--text-secondary);font-size:10.5px;margin-top:2px;">' + escapeHtml(info.billName) + '</div>' : '');
      return '<tr data-ban-row="' + escapeHtml(ban) + '" style="' + rowStyle + 'cursor:pointer;">' +
             '<td style="padding:8px 10px;text-align:left;">' + banCell + '</td>' +
             '<td style="padding:8px 10px;text-align:right;font-variant-numeric:tabular-nums;">' + (info.latestLineCount || 0) + '</td>' +
             '<td style="padding:8px 10px;text-align:right;font-variant-numeric:tabular-nums;">' + fmtMoney(info.billLatest || 0) + '</td>' +
             '<td style="padding:8px 10px;text-align:right;font-variant-numeric:tabular-nums;">' + fmtMoney(info.totalSpend90d || 0) + '</td>' +
             '<td style="padding:8px 10px;text-align:right;">' + (info.zeroUsageCount > 0
                ? '<span style="color:#f59e0b;font-weight:600;">' + info.zeroUsageCount + '</span>'
                : '<span style="color:var(--text-secondary);">0</span>') + '</td>' +
             '<td style="padding:8px 10px;text-align:right;">' +
               (isActive
                  ? '<span style="font-size:10.5px;color:var(--accent);font-weight:600;">VIEWING</span>'
                  : '<span style="font-size:10.5px;color:var(--text-secondary);">click to filter →</span>') +
             '</td></tr>';
    }).join('');

    // Wire row click → switch BAN selector
    tbody.querySelectorAll('tr[data-ban-row]').forEach(row => {
      row.addEventListener('click', () => {
        const ban = row.dataset.banRow;
        applyBanFilter(data, data.activeBan === ban ? 'ALL' : ban);
      });
    });
  }

  /**
   * Filter auditData to a single BAN (or 'ALL') and re-run the analyzers.
   * Mutates data in place so existing populate functions see the new view,
   * then re-renders all UI surfaces.
   */
  function applyBanFilter(data, ban) {
    if (!data || !data.allProfiles) return;
    data.activeBan = ban || 'ALL';

    // Build the filtered profiles + meta we'll feed to the analyzers.
    let filteredProfiles, filteredMeta;
    if (data.activeBan === 'ALL') {
      filteredProfiles = data.allProfiles;
      filteredMeta = data.allMeta;
    } else {
      filteredProfiles = {};
      for (const [wn, p] of Object.entries(data.allProfiles)) {
        if ((p.ban || '') === data.activeBan) filteredProfiles[wn] = p;
      }
      // Synthetic billByCycle scoped to just this sub-account. Use the BAN's
      // per-cycle totals from meta.byBan (carried from AccountSummary for VZ
      // and from billByCycle aggregation for AT&T) when available; otherwise
      // sum the line-level cycles as a fallback so the dashboard still works.
      const banInfo = (data.allMeta && data.allMeta.byBan && data.allMeta.byBan[data.activeBan]) || {};
      const billByCycle = {};
      const seedFromBanCycles = banInfo.cycles || {};
      for (const [cycle, c] of Object.entries(seedFromBanCycles)) {
        billByCycle[cycle] = {
          totalCurrent:   c.totalCurrent   || 0,
          monthlyCharges: c.monthlyCharges || 0,
          activity:       c.activity       || 0,
          taxes:          c.taxes          || 0,
          fees:           c.fees           || 0,
        };
      }
      // Fallback: derive from filtered profiles' billingCycles
      if (Object.keys(billByCycle).length === 0) {
        for (const p of Object.values(filteredProfiles)) {
          for (const [cycle, c] of Object.entries(p.billingCycles || {})) {
            if (!billByCycle[cycle]) {
              billByCycle[cycle] = { totalCurrent:0, monthlyCharges:0, activity:0, taxes:0, fees:0 };
            }
            billByCycle[cycle].totalCurrent   += c.totalCurrent   || 0;
            billByCycle[cycle].monthlyCharges += c.monthlyCharges || 0;
            billByCycle[cycle].activity       += c.activity       || 0;
            billByCycle[cycle].taxes          += c.taxes          || 0;
            billByCycle[cycle].fees           += c.fees           || 0;
          }
        }
      }
      filteredMeta = Object.assign({}, data.allMeta, {
        billByCycle,
        // byBan stays the same so the breakout still lists every BAN.
      });
    }

    // Re-run analyzers against the filtered set.
    const carrier = data.carrier;
    const zeroUsageResults = window.ZeroUsageAnalyzer.analyze(filteredProfiles, carrier);
    const zeroUsageSummary = window.ZeroUsageAnalyzer.summarize(zeroUsageResults);
    const usageReport = window.UsageReportAnalyzer.analyze(filteredProfiles);
    const ratePlans = window.RatePlanAnalyzer.analyze(filteredProfiles);
    const features = (window.FeatureAnalyzer && window.FeatureAnalyzer.analyze)
      ? window.FeatureAnalyzer.analyze(filteredProfiles, filteredMeta, carrier)
      : { features: [], categories: [], totalMonthly: 0, featureCount: 0, uniqueLineCount: 0 };
    const trend = (window.CycleTrendAnalyzer && window.CycleTrendAnalyzer.analyze)
      ? window.CycleTrendAnalyzer.analyze(filteredProfiles, filteredMeta)
      : { snapshots: [], deltas: [], cycleCount: 0, byCycle: {} };

    // Mutate in place so existing populate funcs that read data.X just work.
    data.profiles = filteredProfiles;
    data.meta = filteredMeta;
    data.zeroUsageResults = zeroUsageResults;
    data.zeroUsageSummary = zeroUsageSummary;
    data.usageReport = usageReport;
    data.ratePlans = ratePlans;
    data.features = features;
    data.trend = trend;
    // Reset active cycle to the latest of the filtered scope (avoids dangling
    // references to a cycle that no longer has data).
    data.activeCycle = trend.snapshots && trend.snapshots.length > 0
      ? trend.snapshots[trend.snapshots.length - 1].cycle
      : null;

    // Re-render every surface that reads data.*
    populateDashboardKPIs(data);
    if (typeof renderDashboardCharts === 'function') renderDashboardCharts(data);
    if (typeof populateZeroUsageTable === 'function') populateZeroUsageTable(data);
    if (typeof populateUsageTable === 'function') populateUsageTable(data);
    if (typeof populateRatePlanTable === 'function') populateRatePlanTable(data);
    if (typeof populateRatePlanDetailTab === 'function') populateRatePlanDetailTab(data);
    if (typeof populateFeaturesPanel === 'function') populateFeaturesPanel(data);
    if (typeof populatePlanComparison === 'function') populatePlanComparison(data);
    if (typeof populateTrendTab === 'function') populateTrendTab(data);
    if (typeof populateContractsTab === 'function') populateContractsTab(data);

    console.log('[BAN] Switched to', data.activeBan, '—', Object.keys(filteredProfiles).length, 'lines');
  }

  // ═══════════════════════════════════════════════════════
  // CONTRACTS TAB — time remaining on contracts + ETF exposure
  //
  // Pulls from each profile's already-computed:
  //   contractType, contractEnd, contractEndDate, contractStatus,
  //   monthlyInstallment, remainingMonths, hasActiveContract, etf,
  //   deviceMake, deviceModel, lastUpgradeDate.
  //
  // Adds three context bands:
  //   - Total ETF exposure across the account ("walk-away cost")
  //   - Active contracts vs out-of-contract counts
  //   - Lines expiring in the next 90 days (upgrade-soon flag)
  // Then a sortable table of every line that has a contract record.
  // ═══════════════════════════════════════════════════════
  function populateContractsTab(data) {
    const host = document.getElementById('tab-contracts-content');
    if (!host) return;

    const profiles = Object.values(data.profiles || {});
    if (profiles.length === 0) {
      host.innerHTML = '<p style="color:var(--text-secondary);padding:24px;">No audit data available.</p>';
      return;
    }

    // Only consider lines that have *any* contract info on file.
    // Lines without contract info (BYOD, no-contract, etc.) get a small
    // section at the bottom so Stephen can see them too.
    const withContract = profiles.filter(p => p.contractType && p.contractType !== 'None' && p.contractType !== '');
    const noContract   = profiles.filter(p => !p.contractType || p.contractType === 'None' || p.contractType === '');

    const activeContracts = withContract.filter(p => p.hasActiveContract);
    const completedContracts = withContract.filter(p => !p.hasActiveContract);

    const totalEtf = activeContracts.reduce((s, p) => s + (p.etf || 0), 0);
    const totalInstallment = activeContracts.reduce((s, p) => s + (p.monthlyInstallment || 0), 0);
    const expiringSoon = activeContracts.filter(p => p.remainingMonths > 0 && p.remainingMonths <= 3).length;

    // Update the tab badge with the active-contract count.
    const badge = document.getElementById('contracts-count-badge');
    if (badge) {
      badge.textContent = activeContracts.length;
      badge.style.display = activeContracts.length > 0 ? '' : 'none';
    }

    // ── Summary band: 4 KPI cards ──────────────────────────────────────────
    let html = `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px;">
      <div class="kpi-card" style="padding:14px 16px;">
        <div class="kpi-card-label" style="font-size:10px;">Total ETF Exposure</div>
        <div class="kpi-card-value" style="font-size:22px;color:#ef4444;">${fmtMoney(totalEtf)}</div>
        <div class="kpi-card-sub">Walk-away cost today</div>
      </div>
      <div class="kpi-card" style="padding:14px 16px;">
        <div class="kpi-card-label" style="font-size:10px;">Active Contracts</div>
        <div class="kpi-card-value" style="font-size:22px;">${activeContracts.length}</div>
        <div class="kpi-card-sub">${completedContracts.length} completed · ${noContract.length} no contract</div>
      </div>
      <div class="kpi-card" style="padding:14px 16px;">
        <div class="kpi-card-label" style="font-size:10px;">Monthly Installments</div>
        <div class="kpi-card-value" style="font-size:22px;">${fmtMoney(totalInstallment)}</div>
        <div class="kpi-card-sub">Sum of device payments</div>
      </div>
      <div class="kpi-card" style="padding:14px 16px;">
        <div class="kpi-card-label" style="font-size:10px;">Expiring Soon</div>
        <div class="kpi-card-value" style="font-size:22px;color:${expiringSoon > 0 ? '#f59e0b' : 'var(--text)'};">${expiringSoon}</div>
        <div class="kpi-card-sub">Lines ≤ 3 mo to upgrade</div>
      </div>
    </div>`;

    // ── Active contracts table (sorted by months remaining ascending) ──────
    const sorted = [...activeContracts].sort((a, b) => (a.remainingMonths || 0) - (b.remainingMonths || 0));

    // Compute per-line and total NET device charges (gross minus any
    // promotional/amortized credit). Credits aren't in the inventory CSV —
    // they only show up in the bill PDF's promotions section. When a bill
    // PDF is uploaded the parser populates p.deviceCredit; otherwise it
    // defaults to 0 and Net == Gross.
    const totalCredit  = activeContracts.reduce((s, p) => s + (p.deviceCredit || 0), 0);
    const totalNet     = totalInstallment - totalCredit;

    html += `<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);margin-bottom:6px;">Active contracts</div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">
        <strong>ETF</strong> = monthly device charge <em>before</em> credits × months remaining. Promotional credits do not reduce the early-termination fee.
      </div>
      <div style="overflow-x:auto;background:var(--card);border:1px solid var(--border);border-radius:8px;margin-bottom:20px;">
      <table class="data-table" style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="background:#1a3a5c;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:0.03em;">
          <th style="padding:10px 12px;text-align:left;">Wireless</th>
          <th style="padding:10px 12px;text-align:left;">User</th>
          <th style="padding:10px 12px;text-align:left;">Device</th>
          <th style="padding:10px 12px;text-align:left;">End Date</th>
          <th style="padding:10px 12px;text-align:right;">Time Left</th>
          <th style="padding:10px 12px;text-align:right;" title="Monthly device charge before any promotional/amortized credits">Device $/mo<br><span style="font-weight:400;font-size:10px;opacity:0.7;">(before credits)</span></th>
          <th style="padding:10px 12px;text-align:right;" title="Promotional / amortized credit applied each month">Credit $/mo<br><span style="font-weight:400;font-size:10px;opacity:0.7;">(if any)</span></th>
          <th style="padding:10px 12px;text-align:right;" title="What actually hits the bill each month">Net $/mo<br><span style="font-weight:400;font-size:10px;opacity:0.7;">(after credits)</span></th>
          <th style="padding:10px 12px;text-align:right;" title="Months left × device charge before credits">ETF<br><span style="font-weight:400;font-size:10px;opacity:0.7;">(gross × months)</span></th>
        </tr></thead><tbody>`;

    if (sorted.length === 0) {
      html += `<tr><td colspan="9" style="padding:20px;text-align:center;color:var(--text-muted);">No active contracts on this account.</td></tr>`;
    } else {
      for (const p of sorted) {
        const months = p.remainingMonths || 0;
        // Color the time-left cell — red ≤ 3mo, amber ≤ 6mo, green otherwise.
        const monthsColor = months <= 3 ? '#f59e0b' : (months <= 6 ? '#eab308' : '#22c55e');
        const monthsLabel = months === 0 ? 'Expires this cycle' : `${months} mo`;
        const device = [p.deviceMake, p.deviceModel].filter(Boolean).join(' ').trim() || (p.deviceType || '—');
        const deviceShort = device.length > 30 ? device.substring(0, 30) + '…' : device;

        const gross  = p.monthlyInstallment || 0;
        const credit = p.deviceCredit || 0;
        const net    = gross - credit;
        // ETF deliberately uses GROSS — credits don't reduce ETF.
        const etf    = gross * months;

        // Show "—" instead of "$0.00" for the credit column when no credit
        // is known (most AT&T/Verizon CSVs don't carry credits — those live
        // on the bill PDF). Keeps the column readable.
        const creditCell = credit > 0
          ? `<span style="color:#22c55e;">-${fmtMoney(credit)}</span>`
          : `<span style="color:var(--text-muted);">—</span>`;

        html += `<tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
          <td style="padding:8px 12px;font-variant-numeric:tabular-nums;">${p.wireless}</td>
          <td style="padding:8px 12px;">${p.userName || '—'}</td>
          <td style="padding:8px 12px;color:var(--text-secondary);" title="${device}">${deviceShort}</td>
          <td style="padding:8px 12px;color:var(--text-secondary);">${p.contractEnd || '—'}</td>
          <td style="padding:8px 12px;text-align:right;color:${monthsColor};font-weight:600;">${monthsLabel}</td>
          <td style="padding:8px 12px;text-align:right;font-variant-numeric:tabular-nums;">${fmtMoney(gross)}</td>
          <td style="padding:8px 12px;text-align:right;font-variant-numeric:tabular-nums;">${creditCell}</td>
          <td style="padding:8px 12px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;">${fmtMoney(net)}</td>
          <td style="padding:8px 12px;text-align:right;font-variant-numeric:tabular-nums;color:#ef4444;font-weight:600;">${fmtMoney(etf)}</td>
        </tr>`;
      }
      // Total row — sums each $/mo column independently.
      html += `<tr style="background:rgba(239,68,68,0.06);font-weight:700;">
        <td colspan="5" style="padding:10px 12px;">TOTAL — ${sorted.length} active contracts</td>
        <td style="padding:10px 12px;text-align:right;">${fmtMoney(totalInstallment)}/mo</td>
        <td style="padding:10px 12px;text-align:right;${totalCredit > 0 ? 'color:#22c55e;' : 'color:var(--text-muted);'}">${totalCredit > 0 ? '-' + fmtMoney(totalCredit) + '/mo' : '—'}</td>
        <td style="padding:10px 12px;text-align:right;">${fmtMoney(totalNet)}/mo</td>
        <td style="padding:10px 12px;text-align:right;color:#ef4444;">${fmtMoney(totalEtf)}</td>
      </tr>`;
    }
    html += `</tbody></table></div>`;

    // Note about where the credit data comes from. Helps Stephen understand
    // why the column is empty for CSV-only audits and what report would fill it.
    if (totalCredit === 0 && sorted.length > 0) {
      html += `<div style="font-size:11px;color:var(--text-muted);margin:-8px 0 16px;padding:10px 12px;background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.2);border-radius:6px;">
        💡 <strong>Credit column is empty</strong> — promotional credits aren't in the AT&T inventory or usage CSVs. Upload the bill PDF on the audit, or pull a Premier "Promotional Credits" report, to populate Net $/mo. ETF math doesn't change either way.
      </div>`;
    }

    // ── Completed contracts (shorter table, no ETF) ────────────────────────
    if (completedContracts.length > 0) {
      html += `<details style="margin-bottom:16px;">
        <summary style="cursor:pointer;padding:8px 12px;background:var(--card);border:1px solid var(--border);border-radius:8px;font-size:12px;font-weight:600;color:var(--text-secondary);">
          ✓ Completed contracts (${completedContracts.length}) — eligible to upgrade or BYOD
        </summary>
        <div style="margin-top:8px;overflow-x:auto;background:var(--card);border:1px solid var(--border);border-radius:8px;">
        <table class="data-table" style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead><tr style="background:rgba(34,197,94,0.08);color:#22c55e;font-size:11px;text-transform:uppercase;">
            <th style="padding:8px 12px;text-align:left;">Wireless</th>
            <th style="padding:8px 12px;text-align:left;">User</th>
            <th style="padding:8px 12px;text-align:left;">Device</th>
            <th style="padding:8px 12px;text-align:left;">Last Upgrade</th>
            <th style="padding:8px 12px;text-align:left;">Ended</th>
          </tr></thead><tbody>`;
      for (const p of completedContracts) {
        const device = [p.deviceMake, p.deviceModel].filter(Boolean).join(' ').trim() || (p.deviceType || '—');
        html += `<tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
          <td style="padding:6px 12px;font-variant-numeric:tabular-nums;">${p.wireless}</td>
          <td style="padding:6px 12px;">${p.userName || '—'}</td>
          <td style="padding:6px 12px;color:var(--text-secondary);">${device}</td>
          <td style="padding:6px 12px;color:var(--text-secondary);">${p.lastUpgradeDate || '—'}</td>
          <td style="padding:6px 12px;color:var(--text-secondary);">${p.contractEnd || '—'}</td>
        </tr>`;
      }
      html += `</tbody></table></div></details>`;
    }

    // ── No-contract / BYOD lines ───────────────────────────────────────────
    if (noContract.length > 0) {
      html += `<details>
        <summary style="cursor:pointer;padding:8px 12px;background:var(--card);border:1px solid var(--border);border-radius:8px;font-size:12px;font-weight:600;color:var(--text-secondary);">
          BYOD / No-contract lines (${noContract.length})
        </summary>
        <div style="margin-top:8px;padding:12px;color:var(--text-muted);font-size:12px;">
          ${noContract.length} line${noContract.length === 1 ? '' : 's'} without a contract — bring-your-own-device or already-paid-off equipment. No ETF exposure.
        </div>
      </details>`;
    }

    host.innerHTML = html;
  }

  // Expose so the BAN row click handler can see it (it lives outside the IIFE
  // scope chain via a fresh event listener; but renderByBanBreakout is inside
  // the IIFE so this is just for debugging/console use).
  window.DTG = window.DTG || {};
  window.DTG.applyBanFilter = applyBanFilter;

})();