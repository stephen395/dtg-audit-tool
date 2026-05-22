/**
 * Bill PDF Parser — Full Line-Level Extraction
 * Uses pdf.js to extract text from carrier bill PDFs.
 * NOT OCR — reads embedded text layer (like pdfplumber).
 *
 * Two extraction paths:
 *  1. Summary table (page 2) — charge breakdown + usage for ALL lines
 *  2. Detail pages (bracket markers) — rate plan, device, one-time charges, installments
 * Merges both sources. Summary usage is authoritative for zero-usage determination.
 */

window.BillPDFParser = (function () {

  function parseMoney(val) {
    if (val == null || val === '' || val === '-') return 0;
    let s = String(val).trim();
    // parens around the amount = negative (some carriers format that way).
    // A leading "-" is handled by parseFloat itself — don't double-negate.
    const negParens = s.startsWith('(');
    s = s.replace(/[$,()]/g, '').trim();
    const v = parseFloat(s);
    if (isNaN(v)) return 0;
    return negParens ? -Math.abs(v) : v;
  }

  // ═══════════════════════════════════════════════════════
  // LINE CHARGES BREAKDOWN — Genserve / Stephen May-22 ask
  //
  // AT&T per-line detail pages organize charges into 3 sections:
  //   Monthly charges        → plan + credits/discounts (NET = rate-plan MRC)
  //   Company fees & surcharges → administrative / regulatory / property tax / federal USF
  //   Government fees & taxes → 911 fee, state communications tax, sales tax
  //
  // Within Monthly charges, items are one of:
  //   plan / credit-recurring / credit-onetime / discount-recurring / addon
  //
  // The "Net plan MRC" (gross plan + recurring credits) is what analyzers
  // should use as the line's effective monthly rate — this is the figure
  // that survives month-to-month, not the gross or the cycle-only total.
  // ═══════════════════════════════════════════════════════

  // Section assignment based on each item's position relative to section headers
  function _whichSection(itemPos, hdr) {
    if (hdr.monthly >= 0 && (hdr.company < 0 || itemPos < hdr.company)) return 'monthly';
    if (hdr.company >= 0 && (hdr.govt    < 0 || itemPos < hdr.govt))    return 'company';
    if (hdr.govt    >= 0 && (hdr.total   < 0 || itemPos < hdr.total))   return 'govt';
    return 'monthly';
  }

  // Sub-classify a Monthly-charges item
  function _classifyMonthly(desc, planName) {
    const d = String(desc || '').trim();
    if (/^discount for\b/i.test(d)) return 'discount-recurring';
    if (/(smartphone|tablet|wearable|watch|hotspot|connected device)\s*line\s*discount/i.test(d)) return 'discount-recurring';
    if (/^credit for\b/i.test(d)) {
      // Recurring credit if it references the plan name (turnkey-style credit)
      if (planName && d.toLowerCase().includes(planName.toLowerCase().substring(0, 20))) {
        return 'credit-recurring';
      }
      // Or if it references any of the common AT&T plan families
      if (/credit for (business|bus enh|smartphone|tablet|mobile share|unlimited|att|at&t|connected|hotspot|wearable|smartwatch|watch)/i.test(d)) {
        return 'credit-recurring';
      }
      return 'credit-onetime';
    }
    if (/(business unlimited|business enhanced|bus enh|mobile share|unlimited.*line|att.*unlimited|at&t.*unlimited|connected device|wearable plan|hotspot|tablet plan|smartphone plan)/i.test(d)) {
      return 'plan';
    }
    // Anything else inside Monthly charges is treated as an add-on (e.g.,
    // 5G Ultra Wideband, Mobile Protection, Cloud, International) — feeds
    // the features tracker, not the rate-plan MRC.
    return 'addon';
  }

  /**
   * Parse one line's bracket-section detail into a structured breakdown.
   * Powers the "Net Plan MRC" calculation, recurring vs one-time credit
   * classification, and the Rate Plan / Device / Fees+Taxes column split
   * for the savings UI.
   *
   * @param {string} sectionText - text between [[<wn>|| ... ||<wn>]]
   * @returns {Object} { monthlyBreakdown, grossPlanMRC, recurringCreditsTotal,
   *                    oneTimeCreditsTotal, netPlanMRC, companyFees, govTaxes,
   *                    computedLineTotal, planName, addons }
   */
  function parseLineChargesBreakdown(sectionText) {
    const empty = {
      monthlyBreakdown: [], grossPlanMRC: 0, recurringCreditsTotal: 0,
      oneTimeCreditsTotal: 0, netPlanMRC: 0, companyFees: 0, govTaxes: 0,
      computedLineTotal: 0, planName: '', addons: [],
    };
    if (!sectionText) return empty;

    const flat = sectionText.replace(/\s+/g, ' ');

    // Dollar amounts in the order they appear in the column stream. Comes out
    // matching the numbered-item order because pdf.js linearizes column-by-column.
    const amts = [...sectionText.matchAll(/(-?\$[\d,]+\.?\d*)/g)].map(m => m[1]);

    // Section header positions
    const hdr = {
      monthly: flat.indexOf('Monthly charges'),
      company: flat.indexOf('Company fees'),
      govt:    flat.indexOf('Government fees'),
      total:   flat.indexOf('Total for'),
    };

    // Numbered items — allow descriptions starting with any non-space char
    // (e.g. "911 Service Fee" starts with a digit). Stop at next "N. ",
    // section header, Total for, or end-bracket.
    const itemRe = /\b(\d+)\.\s+(\S[^]+?)(?=\s+\d+\.\s+\S|\s+Company fees|\s+Government fees|\s+Total for|\|\|)/g;
    const items = [...flat.matchAll(itemRe)];
    if (items.length === 0) return empty;

    // Plan name = first non-credit Monthly item. Strip trailing column-bleed
    // ("$X.XX", "( unlimited MB)", "1 Gigabyte = ...", etc.).
    const cleanDesc = (raw) => raw.split(/\s+\$|\s+\(\s*unlimited|\s+1 Gigabyte|\s+\d{1,3}\s+\w+\s+\(/i)[0].trim();
    let planName = '';
    for (const m of items) {
      if (_whichSection(m.index, hdr) !== 'monthly') continue;
      const desc = cleanDesc(m[2]);
      if (!/^(credit for|discount for)/i.test(desc)) { planName = desc; break; }
    }

    // Pair amounts to items by index. The Nth dollar amount goes with the
    // Nth numbered item; any trailing amount(s) are the section's Total
    // and the bill-stated total. Validate the math at the bottom.
    const monthlyBreakdown = [];
    const addons = [];
    let grossPlanMRC = 0, recurringCreditsTotal = 0, oneTimeCreditsTotal = 0;
    let companyFees = 0, govTaxes = 0;

    items.forEach((m, i) => {
      const num = parseInt(m[1], 10);
      const desc = cleanDesc(m[2]);
      const rawAmt = amts[i] || '';
      const amt = parseMoney(rawAmt);
      const section = _whichSection(m.index, hdr);
      let type;
      if (section === 'company') type = 'company-fee';
      else if (section === 'govt') type = 'government-tax';
      else type = _classifyMonthly(desc, planName);

      const isRecurring = (type === 'plan' || type === 'addon' ||
                           type === 'credit-recurring' || type === 'discount-recurring');

      monthlyBreakdown.push({
        num, description: desc, amount: amt, type, section, isRecurring,
      });

      if (type === 'plan' || type === 'addon') grossPlanMRC += amt;
      else if (type === 'credit-recurring' || type === 'discount-recurring') recurringCreditsTotal += amt;
      else if (type === 'credit-onetime') oneTimeCreditsTotal += amt;
      else if (type === 'company-fee') companyFees += amt;
      else if (type === 'government-tax') govTaxes += amt;

      if (type === 'addon') addons.push({ description: desc, amount: amt });
    });

    // Net plan MRC = what the line is recurringly billed for the rate plan
    // after recurring credits. This is the figure analyzers should use.
    // One-time credits affect this cycle's bill but not the ongoing rate.
    const netPlanMRC = grossPlanMRC + recurringCreditsTotal;
    const computedLineTotal = netPlanMRC + oneTimeCreditsTotal + companyFees + govTaxes;

    return {
      monthlyBreakdown,
      grossPlanMRC,
      recurringCreditsTotal,
      oneTimeCreditsTotal,
      netPlanMRC,
      companyFees,
      govTaxes,
      computedLineTotal,
      planName,
      addons,
    };
  }

  // ═══════════════════════════════════════════════════════
  // TEXT EXTRACTION
  // ═══════════════════════════════════════════════════════

  async function extractText(file, progressCb) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const text = textContent.items.map(item => item.str).join(' ');
      pages.push(text);
      if (progressCb && i % 20 === 0) progressCb(i, pdf.numPages);
    }

    const fullText = pages.join('\n\n');
    const carrier = detectCarrier(fullText);
    return { pages, fullText, carrier, pageCount: pdf.numPages };
  }

  function detectCarrier(text) {
    const t = text.toLowerCase();
    if (t.includes('at&t') || t.includes('att.com') || t.includes('premier.att') || t.includes('myatt')) return 'att';
    if (t.includes('verizon') || t.includes('vzw.com') || t.includes('verizon wireless')) return 'verizon';
    if (t.includes('t-mobile') || t.includes('tmobile') || t.includes('sprint')) return 'tmobile';
    return 'unknown';
  }

  // ═══════════════════════════════════════════════════════
  // ACCOUNT INFO (Page 1)
  // ═══════════════════════════════════════════════════════

  function parseAccountInfo(pages) {
    // Account info typically lives on pages 1–3. AutoPay/Paperless prompts
    // may appear deeper (cover, payment stub, sometimes the back-of-bill
    // promotional pages) — widen the search to pages 1–6 for those.
    const text = pages.slice(0, 3).join('\n');
    const promoText = pages.slice(0, 6).join('\n');
    const info = {
      accountNumber: '', foundationAccount: '', invoice: '',
      accountName: '', billingContact: '', issueDate: '',
      billingPeriod: '', totalDue: 0, autoPayDate: '',
      lastBillAmount: 0,
      // Source-of-Truth: AutoPay/Paperless enrollment + unlock value.
      // From the Genserve audit — these discounts ($5/line on Verizon,
      // $5/mo on AT&T, sometimes account-level pools worth $1000+/mo)
      // are advertised on the bill cover but rarely flow into the CSV.
      autoPay: false,
      paperless: false,
      autoPayUnlockPerLine: 0,
      autoPayUnlockTotal: 0,
      autoPayMessage: '',
    };

    const m = (re) => { const r = text.match(re); return r ? r[1].trim() : ''; };

    info.accountNumber = m(/Account\s*(?:Number|number)[:\s]*(\d[\d-]+)/);
    info.foundationAccount = m(/Foundation\s*Account[:\s]*(\d+)/);
    info.invoice = m(/Invoice[:\s]*(\S+)/);
    info.issueDate = m(/Issue\s*Date[:\s]*([\w\s,]+?\d{4})/);
    info.accountName = m(/^([A-Z][A-Z\s&,.]+?)(?:\s+Page:|\s+ATTN)/m);

    const totalMatch = text.match(/Total\s*due\s*\$?([\d,]+\.?\d*)/i);
    if (totalMatch) info.totalDue = parseFloat(totalMatch[1].replace(/,/g, ''));

    const lastMatch = text.match(/last\s*bill\s*\$?([\d,]+\.?\d*)/i);
    if (lastMatch) info.lastBillAmount = parseFloat(lastMatch[1].replace(/,/g, ''));

    const apMatch = text.match(/scheduled\s*for[:\s]*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4})/i);
    if (apMatch) {
      info.autoPayDate = apMatch[1].trim();
      info.autoPay = true; // a scheduled date means the account IS enrolled
    }

    // Enrollment indicators — any of these mean AutoPay is already on.
    if (!info.autoPay) {
      const enrolledRe = /(?:enrolled\s+in\s+Auto\s*Pay|Auto\s*Pay\s+is\s+(?:on|active|enrolled))/i;
      if (enrolledRe.test(promoText)) info.autoPay = true;
    }

    // Paperless billing — usually called out by name on the cover or stub.
    if (/paper(?:less|-?free)\s+billing/i.test(promoText) ||
        /enrolled\s+in\s+paper(?:less|-?free)/i.test(promoText)) {
      info.paperless = true;
    }

    // Per-line unlock value — "Save $5.00 with AutoPay" style prompts.
    // Match the dollar amount nearest to the AutoPay phrase.
    const perLineRe = /Save\s*\$([\d.]+)(?:\s*\/\s*(?:line|mo))?[\s\w]*?(?:Auto\s*Pay|AutoPay|paper(?:less|-?free))/gi;
    let plm;
    while ((plm = perLineRe.exec(promoText)) !== null) {
      const val = parseFloat(plm[1]);
      if (!isNaN(val) && val > info.autoPayUnlockPerLine) {
        info.autoPayUnlockPerLine = val;
      }
    }

    // Account-level unlock total — "$X,XXX/mo if enrolled" big number on
    // the cover. Common on Verizon Business bills. Capture the largest
    // value mentioned next to an AutoPay phrase.
    const totalUnlockRe = /\$([\d,]+(?:\.\d+)?)\s*(?:\/\s*mo)?\s*(?:if|when)\s+enrolled\s+in\s+(?:Auto\s*Pay|AutoPay)/gi;
    let tum;
    while ((tum = totalUnlockRe.exec(promoText)) !== null) {
      const val = parseFloat(tum[1].replace(/,/g, ''));
      if (!isNaN(val) && val > info.autoPayUnlockTotal) {
        info.autoPayUnlockTotal = val;
      }
    }

    // Build a human-readable surfaced message for the dashboard.
    if (!info.autoPay && (info.autoPayUnlockPerLine > 0 || info.autoPayUnlockTotal > 0)) {
      const bits = [];
      if (info.autoPayUnlockPerLine > 0) bits.push('$' + info.autoPayUnlockPerLine.toFixed(2) + '/line');
      if (info.autoPayUnlockTotal > 0)   bits.push('$' + info.autoPayUnlockTotal.toLocaleString() + '/mo account-level');
      info.autoPayMessage = 'Enroll in AutoPay' + (info.paperless ? '' : ' + Paperless') +
                            ' to unlock: ' + bits.join(' + ');
    } else if (info.autoPay && !info.paperless && info.autoPayUnlockTotal > 0) {
      info.autoPayMessage = 'AutoPay on — adding Paperless may unlock additional $' +
                            info.autoPayUnlockTotal.toLocaleString() + '/mo';
    }

    return info;
  }

  // ═══════════════════════════════════════════════════════
  // AT&T SUMMARY TABLE (Page 2)
  // Extracts: charges per line + usage data
  // ═══════════════════════════════════════════════════════

  function parseATTSummaryTable(pages) {
    const profiles = {};
    let billingPeriod = '';

    for (let i = 1; i < Math.min(50, pages.length); i++) {
      const text = pages[i];
      if (!text.includes('Plan') || !text.includes('Total')) continue;

      console.log('[PDF-SUMMARY] Page', i + 1, 'text length:', text.length);
      console.log('[PDF-SUMMARY] First 500 chars:', text.substring(0, 500));

      // --- CHARGE LINES ---
      // Format: NNN.NNN.NNNN USER PAGE# Activity Plan Equipment CompFees GovTaxes Total
      const chargeRe = /(\d{3}\.\d{3}\.\d{4})\s+([A-Za-z][A-Za-z\s.,'\-&/]+?)\s+(\d{1,3})\s+(-?\$[\d,.]+|-)\s+\$([\d,.]+)\s+(-?\$[\d,.]+|-)\s+\$([\d,.]+)\s+(-?\$[\d,.]+|-)\s+\$([\d,.]+)/g;
      let cm;
      while ((cm = chargeRe.exec(text)) !== null) {
        const wireless = cm[1].replace(/\./g, '');
        profiles[wireless] = {
          wireless,
          userName: cm[2].trim(),
          activityCharges: parseMoney(cm[4]),
          planCharge: parseMoney(cm[5]),
          equipmentCharge: parseMoney(cm[6]),
          companyFees: parseMoney(cm[7]),
          govTaxes: parseMoney(cm[8]),
          totalCharges: parseMoney(cm[9]),
          dataGB: 0, textCount: 0, talkMinutes: 0,
        };
        console.log('[PDF-SUMMARY] Charge line:', wireless, cm[2].trim(), 'plan=$' + cm[5]);
      }

      // --- USAGE LINES ---
      // Primary: NNN.NNN.NNNN USER X.XXGB (unlimited) NNN (unlimited) NNN (unlimited)
      const usageRe = /(\d{3}\.\d{3}\.\d{4})\s+([A-Za-z][A-Za-z\s.,'\-&/]+?)\s+([\d.]+)GB\s*\((\w+)\)\s+([\d,]+)\s*\((\w+)\)\s+([\d,]+)\s*\((\w+)\)/g;
      let um;
      while ((um = usageRe.exec(text)) !== null) {
        const wireless = um[1].replace(/\./g, '');
        const dataGB = parseFloat(um[3]) || 0;
        const textCount = parseInt((um[5] || '0').replace(/,/g, ''), 10) || 0;
        const talkMin = parseInt((um[7] || '0').replace(/,/g, ''), 10) || 0;

        if (profiles[wireless]) {
          profiles[wireless].dataGB = dataGB;
          profiles[wireless].textCount = textCount;
          profiles[wireless].talkMinutes = talkMin;
        }
        console.log('[PDF-SUMMARY] Usage line:', wireless, 'data:', dataGB, 'GB, text:', textCount, ', talk:', talkMin);
      }

      // Fallback: if primary usage regex didn't match, try matching by bracket markers
      // [[XXXXXXXXXX||XXXXXXXXXX]] appear near usage lines in pdf.js output
      if (Object.keys(profiles).length > 0) {
        for (const wireless of Object.keys(profiles)) {
          if (profiles[wireless].dataGB > 0) continue; // already have usage
          // Try to find usage near the bracket marker for this number
          const dotNum = wireless.replace(/(\d{3})(\d{3})(\d{4})/, '$1.$2.$3');
          // Look for: X.XXGB near this number in the usage section
          const usageSection = text.substring(text.indexOf('Usage summary'));
          if (usageSection) {
            const numIdx = usageSection.indexOf(dotNum);
            if (numIdx >= 0) {
              const nearby = usageSection.substring(numIdx, numIdx + 200);
              const gbMatch = nearby.match(/([\d.]+)GB/);
              const txtMatch = nearby.match(/(\d[\d,]*)\s*\(unlimited\)/g);
              if (gbMatch) {
                profiles[wireless].dataGB = parseFloat(gbMatch[1]) || 0;
                console.log('[PDF-SUMMARY] Fallback usage for', wireless, ':', profiles[wireless].dataGB, 'GB');
              }
              if (txtMatch && txtMatch.length >= 2) {
                // First (unlimited) after GB is text, second is talk
                const textVal = txtMatch[0].match(/(\d[\d,]*)/);
                const talkVal = txtMatch[1].match(/(\d[\d,]*)/);
                if (textVal) profiles[wireless].textCount = parseInt(textVal[1].replace(/,/g, ''), 10) || 0;
                if (talkVal) profiles[wireless].talkMinutes = parseInt(talkVal[1].replace(/,/g, ''), 10) || 0;
              }
            }
          }
        }
      }

      // Billing period
      const periodMatch = text.match(/Usage summary\s*\((\w+\s+\d{1,2})\s*-\s*(\w+\s+\d{1,2})\)/);
      if (periodMatch) billingPeriod = `${periodMatch[1]} - ${periodMatch[2]}`;

      if (Object.keys(profiles).length > 0) break;
    }

    console.log('[PDF-SUMMARY] Final profiles:', Object.keys(profiles).length);
    for (const [wn, p] of Object.entries(profiles)) {
      console.log('[PDF-SUMMARY]', wn, '→ data:', p.dataGB, 'GB, text:', p.textCount, ', talk:', p.talkMinutes, ', plan$:', p.planCharge);
    }

    return { profiles, billingPeriod };
  }

  // ═══════════════════════════════════════════════════════
  // AT&T DETAIL PAGES (bracket markers)
  // Extracts: rate plan, device, one-time charges, installments
  // ═══════════════════════════════════════════════════════

  function parseATTDetailPages(pages) {
    const details = {};
    const bracketRe = /\|\|(\d{10})\]\]/;

    for (let i = 0; i < pages.length; i++) {
      const text = pages[i];
      if (!text || text.length < 100) continue;

      const bracketMatch = bracketRe.exec(text);
      if (!bracketMatch) continue;

      const wireless = bracketMatch[1];
      if (details[wireless]) continue;

      const d = {
        deviceType: 'Phone',
        ratePlan: '', planCharge: 0,
        oneTimeCharges: [], oneTimeTotal: 0,
        equipmentName: '', equipmentIMEI: '',
        equipmentInstallment: '', equipmentCharge: 0,
        equipmentFinanced: 0, equipmentRemaining: 0,
        equipmentEstablished: '',
        companyFees: 0, govTaxes: 0, totalCharges: 0,
        dataGB: 0, talkMinutes: 0, textCount: 0,
        userName: '',
        // Stephen May-22 ask — net plan MRC + credit breakdown
        monthlyBreakdown: [], addons: [],
        grossPlanMRC: 0, netPlanMRC: 0,
        recurringCreditsTotal: 0, oneTimeCreditsTotal: 0,
      };

      // Device type from header
      if (/Ph\[\[|Phone,/.test(text)) d.deviceType = 'Phone';
      else if (/Ta\[\[|Tablet,|let,/.test(text)) d.deviceType = 'Tablet';
      else if (/Wa\[\[|Watch,|Wearable/.test(text)) d.deviceType = 'Watch';
      else if (/Ho\[\[|Hotspot/.test(text)) d.deviceType = 'Hotspot';
      else if (/La\[\[|Laptop/.test(text)) d.deviceType = 'Laptop';

      // User name — right after "ne, NNN.NNN.NNNN" or "let, NNN.NNN.NNNN"
      const nameMatch = text.match(/(?:ne,|let,|tch,|pot,|top,)\s*\d{3}\.\d{3}\.\d{4}\s+(.+?)(?:\s+Activity|\s+Monthly)/);
      if (nameMatch) d.userName = nameMatch[1].trim().substring(0, 50);

      // One-time charges
      const otcRe = /\d+\.\s+(.+?)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(-?\$[\d,.]+)\s*<One-time/g;
      let otc;
      while ((otc = otcRe.exec(text)) !== null) {
        const amt = parseMoney(otc[2]);
        d.oneTimeCharges.push({ description: otc[1].trim(), amount: amt });
        d.oneTimeTotal += amt;
      }

      // Rate plan — first numbered item after "Monthly charges"
      // Match: "N. Business Unlimited Performance - 5+ Lines $55.00"
      const planMatch = text.match(/\d+\.\s+(Business [^$]+?|UNL [^$]+?|Unlimited [^$]+?|AT&T [^$]+?|Mobile Share[^$]+?|Bus Enh [^$]+?)\s+\$([\d,.]+)/);
      if (planMatch) {
        d.ratePlan = planMatch[1].trim()
          .replace(/\s+Smartphone Line Discount.*/, '')
          .replace(/\s+Tablet Line Discount.*/, '')
          .trim();
        d.planCharge = parseMoney(planMatch[2]);
      }

      // ── Full Monthly-Charges breakdown (Stephen May-22) ──
      // Parses every numbered item on this line's detail page into:
      //   monthlyBreakdown: per-item { description, amount, type, isRecurring }
      //   grossPlanMRC / recurringCreditsTotal / oneTimeCreditsTotal / netPlanMRC
      //   companyFees / govTaxes
      // Net plan MRC is what the analyzers should use as the line's effective
      // monthly rate — the figure that survives month-to-month.
      try {
        const breakdown = parseLineChargesBreakdown(text);
        if (breakdown.monthlyBreakdown.length > 0) {
          d.monthlyBreakdown          = breakdown.monthlyBreakdown;
          d.addons                    = breakdown.addons;
          d.grossPlanMRC              = breakdown.grossPlanMRC;
          d.recurringCreditsTotal     = breakdown.recurringCreditsTotal;
          d.oneTimeCreditsTotal       = breakdown.oneTimeCreditsTotal;
          d.netPlanMRC                = breakdown.netPlanMRC;
          // Backfill fees/taxes if the summary table didn't already provide them
          if (!d.companyFees) d.companyFees = breakdown.companyFees;
          if (!d.govTaxes)    d.govTaxes    = breakdown.govTaxes;
          // Prefer the breakdown's plan name when the planMatch regex above
          // didn't catch it (newer plan name patterns, etc.)
          if (!d.ratePlan && breakdown.planName) d.ratePlan = breakdown.planName;
          // Override planCharge with the gross — analyzers later swap to net.
          if (!d.planCharge && breakdown.grossPlanMRC) d.planCharge = breakdown.grossPlanMRC;
        }
      } catch (e) {
        console.warn('[PDF-DETAIL] parseLineChargesBreakdown failed for', wireless, ':', e.message);
      }

      // Equipment installment line
      // "APPLE IPHONE 17 PRO MAX 512GB DEEP BLUE - $58.34 ... Installment 3 of 24"
      const eqMatch = text.match(/(APPLE|SAMSUNG|GOOGLE|MOTOROLA|LG)[^$]+?-\s+\$([\d,.]+).*?Installment\s+(\d+)\s+of\s+(\d+)/i);
      if (eqMatch) {
        d.equipmentName = text.substring(text.indexOf(eqMatch[1]), text.indexOf(eqMatch[1]) + 60).replace(/-\s.*/, '').trim();
        d.equipmentCharge = parseMoney(eqMatch[2]);
        d.equipmentInstallment = `${eqMatch[3]} of ${eqMatch[4]}`;
      }

      // Equipment IMEI (15-digit number after device name)
      const imeiMatch = text.match(/(APPLE|SAMSUNG|GOOGLE|MOTOROLA|LG)[^\d]*?(\d{15})/i);
      if (imeiMatch) d.equipmentIMEI = imeiMatch[2];

      // Equipment financing details
      const estMatch = text.match(/Established\s*on\s+([\w\s,]+?\d{4})/);
      if (estMatch) d.equipmentEstablished = estMatch[1].trim();

      const finMatch = text.match(/Amount\s*financed\s+\$([\d,.]+)/);
      if (finMatch) d.equipmentFinanced = parseMoney(finMatch[1]);

      const remMatch = text.match(/Balance\s*remaining.*?\$([\d,.]+)/);
      if (remMatch) d.equipmentRemaining = parseMoney(remMatch[1]);

      // Total charges
      const totalMatch = text.match(/Total for [\d.]+\s+\$([\d,.]+)/);
      if (totalMatch) d.totalCharges = parseMoney(totalMatch[1]);

      // Usage — Data (from detail page)
      // Pattern 1: "DATA ALL 59.05" (number right after)
      // Pattern 2: "DATA ALL AAT ( unlimited GB) 59.05" (number after allowance)
      // Pattern 3: "unlimited GB) 59.05" (just the tail end)
      // Pattern 4: "Tablet Plan ( unlimited 0.50" or "Standalone Tablet (999.00 GB) 0.00"
      const dataPatterns = [
        /DATA ALL\s+([\d,.]+)(?!\d)/,
        /unlimited\s*GB\s*\)\s*([\d,.]+)/,
        /DATA ALL[\s\S]*?unlimited\s*(?:GB|MB)\s*\)\s*([\d,.]+)/,
        /(?:Tablet Plan|Standalone Tablet|Wearable)\s*\(\s*(?:unlimited|[\d.]+)\s*(?:GB)?\s*\)\s*([\d,.]+)/i,
      ];
      for (const pat of dataPatterns) {
        const dm = text.match(pat);
        if (dm) {
          const val = parseFloat(dm[1].replace(/,/g, ''));
          if (!isNaN(val)) { d.dataGB = val; break; }
        }
      }

      // Usage — Talk
      const talkMatch = text.match(/Plan minutes\s*\(unlimited\)\s+([\d,]+)/);
      if (talkMatch) d.talkMinutes = parseInt(talkMatch[1].replace(/,/g, ''), 10);

      // Usage — Text
      const txtMatch = text.match(/Plan messages\s*\(unlimited\)\s+([\d,]+)/);
      if (txtMatch) d.textCount = parseInt(txtMatch[1].replace(/,/g, ''), 10);

      details[wireless] = d;
    }

    return details;
  }

  // ─── AT&T equipment → contract field derivation (Stephen May-22) ───
  // The bill PDF gives us equipment data per line (installment "X of Y",
  // monthly charge, established date, balance remaining). The Contracts
  // tab reads contract fields with different names (monthlyInstallment,
  // remainingMonths, contractEnd, etf, deviceMake, deviceModel). This
  // helper bridges the two so the Contracts tab populates for every
  // line that has an installment plan on the bill — no Upgrade Eligibility
  // CSV required.
  //
  // Honest about the limits:
  //   - contractEnd is DERIVED from equipmentEstablished + term length, not
  //     stated on the bill. If the line has been on the plan past its term
  //     or was extended, the derivation can be off.
  //   - etf is plugged from equipmentRemaining (device balance). AT&T does
  //     NOT publish a real ETF on the bill — device balance is the closest
  //     proxy. A tooltip on the Contracts tab will note this for AT&T.

  function _parseEstablishedDate(s) {
    if (!s) return null;
    // Accept forms like "Apr 12, 2024", "April 12 2024", "Apr 2024"
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d;
    // Try month-only "Apr 2024"
    const m = String(s).match(/(\w+)\s+(\d{4})/);
    if (m) {
      const d2 = new Date(m[1] + ' 1, ' + m[2]);
      if (!isNaN(d2.getTime())) return d2;
    }
    return null;
  }

  function _splitDeviceName(name) {
    if (!name) return { make: '', model: '' };
    const known = ['APPLE', 'SAMSUNG', 'GOOGLE', 'MOTOROLA', 'LG', 'SONY', 'NOKIA', 'ONEPLUS', 'OPPO', 'XIAOMI', 'HUAWEI'];
    const upper = name.toUpperCase().trim();
    for (const k of known) {
      if (upper.startsWith(k)) {
        return { make: k, model: name.slice(k.length).trim() };
      }
    }
    // Fallback: first word = make
    const parts = name.trim().split(/\s+/);
    return { make: parts[0] || '', model: parts.slice(1).join(' ') };
  }

  /**
   * Derive contract fields from the bill PDF's equipment data so the
   * Contracts tab populates without needing the Upgrade Eligibility CSV.
   *
   * Inputs (from parseATTDetailPages):
   *   equipmentInstallment  "X of Y" string (e.g. "3 of 24")
   *   equipmentCharge       $/mo
   *   equipmentFinanced     $ originally financed
   *   equipmentRemaining    $ balance remaining
   *   equipmentEstablished  "Apr 12, 2024" or similar
   *   equipmentName         "APPLE IPHONE 17 PRO MAX 512GB DEEP BLUE"
   *
   * Outputs (mutates contract object in place):
   *   contractType, hasActiveContract
   *   monthlyInstallment
   *   remainingMonths
   *   contractEnd (string), contractEndDate (Date)
   *   etf  (= equipmentRemaining — labelled as device balance in the tab)
   *   deviceMake, deviceModel
   */
  function _deriveContractFromEquipment(d) {
    const result = {
      contractType:       d.equipmentInstallment ? 'Installment' : 'None',
      hasActiveContract:  false,
      monthlyInstallment: d.equipmentCharge || 0,
      remainingMonths:    0,
      contractEnd:        '',
      contractEndDate:    null,
      etf:                d.equipmentRemaining || 0,
      deviceMake:         '',
      deviceModel:        '',
    };

    if (!d.equipmentInstallment) return result;

    // Parse "X of Y"
    const m = String(d.equipmentInstallment).match(/(\d+)\s+of\s+(\d+)/i);
    if (m) {
      const elapsed = parseInt(m[1], 10);
      const term    = parseInt(m[2], 10);
      result.remainingMonths = Math.max(0, term - elapsed);
      result.hasActiveContract = result.remainingMonths > 0;

      // Derive contractEnd = established + term months
      const start = _parseEstablishedDate(d.equipmentEstablished);
      if (start) {
        const end = new Date(start.getTime());
        end.setMonth(end.getMonth() + term);
        result.contractEndDate = end;
        result.contractEnd = end.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });
      }
    }

    // Split device name into make / model
    const split = _splitDeviceName(d.equipmentName);
    result.deviceMake = split.make;
    result.deviceModel = split.model;

    return result;
  }

  // ═══════════════════════════════════════════════════════
  // MERGE: Summary + Detail → Final profiles
  // ═══════════════════════════════════════════════════════

  function mergeATTData(summaryData, detailPages, allPageTexts) {
    const profiles = {};
    const summary = summaryData.profiles;

    const allWireless = new Set([
      ...Object.keys(summary),
      ...Object.keys(detailPages),
    ]);

    // Build a full-text index for fallback usage extraction
    const fullText = (allPageTexts || []).join('\n\n');

    for (const wireless of allWireless) {
      if (!/^\d{10}$/.test(wireless)) continue;

      const s = summary[wireless] || {};
      const d = detailPages[wireless] || {};

      // Usage: try summary → detail → full-text scan fallback
      let dataGB = s.dataGB || d.dataGB || 0;
      let talkMin = s.talkMinutes || d.talkMinutes || 0;
      let textCnt = s.textCount || d.textCount || 0;

      // FALLBACK: If no usage found, scan ALL pages for this number + GB nearby
      if (dataGB === 0 && fullText) {
        const dotNum = wireless.replace(/(\d{3})(\d{3})(\d{4})/, '$1.$2.$3');
        // Look for the number followed eventually by X.XXGB within 300 chars
        const escapedDot = dotNum.replace(/\./g, '\\.');
        const nearbyRe = new RegExp(escapedDot + '[\\s\\S]{0,300}?([\\d.]+)GB', 'g');
        let fm;
        while ((fm = nearbyRe.exec(fullText)) !== null) {
          const val = parseFloat(fm[1]);
          if (!isNaN(val) && val > 0 && val < 9999) {
            dataGB = val;
            console.log('[MERGE] Fallback GB for', wireless, ':', dataGB);
            break;
          }
        }
        // Also try: bracket marker nearby
        if (dataGB === 0) {
          const bracketIdx = fullText.indexOf('||' + wireless + ']]');
          if (bracketIdx > 0) {
            // Search backwards from bracket for GB value on same page
            const before = fullText.substring(Math.max(0, bracketIdx - 2000), bracketIdx);
            const gbMatches = [...before.matchAll(/([\d.]+)\s*GB/g)];
            if (gbMatches.length > 0) {
              const lastGB = parseFloat(gbMatches[gbMatches.length - 1][1]);
              if (!isNaN(lastGB) && lastGB > 0) {
                dataGB = lastGB;
                console.log('[MERGE] Bracket-fallback GB for', wireless, ':', dataGB);
              }
            }
          }
        }
      }

      // FALLBACK for talk/text: scan detail page or full text
      if (talkMin === 0 && textCnt === 0 && fullText) {
        const bracketIdx = fullText.indexOf('||' + wireless + ']]');
        if (bracketIdx > 0) {
          const before = fullText.substring(Math.max(0, bracketIdx - 2000), bracketIdx);
          // Talk: "Plan minutes (unlimited) X,XXX"
          const talkMatch = before.match(/Plan minutes\s*\(unlimited\)\s+([\d,]+)/);
          if (talkMatch) talkMin = parseInt(talkMatch[1].replace(/,/g, ''), 10) || 0;
          // Text: "Plan messages (unlimited) XXX"
          const txtMatch = before.match(/Plan messages\s*\(unlimited\)\s+([\d,]+)/);
          if (txtMatch) textCnt = parseInt(txtMatch[1].replace(/,/g, ''), 10) || 0;
          if (talkMin > 0 || textCnt > 0) {
            console.log('[MERGE] Bracket-fallback talk/text for', wireless, ':', talkMin, '/', textCnt);
          }
        }
      }

      console.log('[MERGE]', wireless, '→ data:', dataGB, 'GB, talk:', talkMin, ', text:', textCnt,
        '(sources: s.data=', s.dataGB, 'd.data=', d.dataGB, ')');

      // Zero usage: per AT&T audit skill rules
      // Phone/Smartphone: 0 data + 0 voice + 0 messages
      // Tablet/Connected device: 0 data only
      const devType = d.deviceType || 'Phone';
      let isZeroUsage;
      if (devType === 'Tablet' || devType === 'Hotspot' || devType === 'Laptop') {
        isZeroUsage = dataGB === 0;
      } else {
        isZeroUsage = dataGB === 0 && talkMin === 0 && textCnt === 0;
      }
      console.log('[MERGE]', wireless, 'deviceType:', devType, 'zeroUsage:', isZeroUsage);

      // MRC = NET plan MRC (gross plan + recurring credits). This is what
      // analyzers should use as the line's effective monthly rate. See
      // SOURCE_OF_TRUTH.md → "Credit classification — Recurring vs One-Time".
      // Falls back to the summary table's planCharge when the detail-page
      // breakdown didn't extract (rare — older bill formats).
      const netMRC = d.netPlanMRC || s.planCharge || d.planCharge || 0;
      const grossMRC = d.grossPlanMRC || s.planCharge || d.planCharge || 0;

      // Derive Contracts-tab fields from the equipment data on the bill PDF.
      // Without this, the Contracts tab needs the Upgrade Eligibility CSV.
      const contract = _deriveContractFromEquipment(d);

      profiles[wireless] = {
        wireless,
        userName: d.userName || s.userName || 'Unknown',
        deviceType: devType,
        ratePlan: d.ratePlan || '',
        // Analyzers read `mrc` — set it to NET (post-recurring-credits) so
        // zero-usage / usage-report / rate-plan reflect the actual ongoing
        // rate, not the gross sticker price.
        mrc: netMRC,
        monthlyCharges: netMRC,
        // Gross + breakdown carried separately so the Rate Plan Detail tab
        // and the new Savings columns can show "Gross $40 − Credits $15 = Net $25".
        grossPlanMRC: grossMRC,
        netPlanMRC: netMRC,
        recurringCreditsTotal: d.recurringCreditsTotal || 0,
        oneTimeCreditsTotal: d.oneTimeCreditsTotal || 0,
        monthlyBreakdown: d.monthlyBreakdown || [],
        addons: d.addons || [],
        totalCharges: s.totalCharges || d.totalCharges || 0,
        activityCharges: s.activityCharges || d.oneTimeTotal || 0,
        oneTimeCharges: d.oneTimeCharges || [],
        equipment: s.equipmentCharge || d.equipmentCharge || 0,
        equipmentName: d.equipmentName || '',
        equipmentIMEI: d.equipmentIMEI || '',
        equipmentInstallment: d.equipmentInstallment || '',
        equipmentFinanced: d.equipmentFinanced || 0,
        equipmentRemaining: d.equipmentRemaining || 0,
        equipmentEstablished: d.equipmentEstablished || '',
        taxes: s.govTaxes || d.govTaxes || 0,
        fees: s.companyFees || d.companyFees || 0,
        latestTaxes: s.govTaxes || d.govTaxes || 0,
        latestFees: s.companyFees || d.companyFees || 0,
        gbTotal: dataGB,
        kbTotal: dataGB * 1024 * 1024,
        minTotal: talkMin,
        msgTotal: textCnt,
        zeroUsage: isZeroUsage,
        // ── Contract fields derived from the equipment data above ──
        // The Contracts tab reads these — they previously came only from
        // the optional Upgrade Eligibility CSV. Now any AT&T line with
        // an installment plan on the bill populates Contracts.
        contractType:       contract.contractType,
        hasActiveContract:  contract.hasActiveContract,
        monthlyInstallment: contract.monthlyInstallment,
        remainingMonths:    contract.remainingMonths,
        contractEnd:        contract.contractEnd,
        contractEndDate:    contract.contractEndDate,
        etf:                contract.etf, // device balance — see _deriveContractFromEquipment
        deviceMake:         contract.deviceMake,
        deviceModel:        contract.deviceModel,
        contractEndDerivedFromBill: true, // flag for the Contracts tab to show a tooltip
        source: 'pdf',
      };
    }

    return profiles;
  }

  // ═══════════════════════════════════════════════════════
  // MAIN PARSE
  // ═══════════════════════════════════════════════════════

  async function parse(file, progressCb) {
    const { pages, fullText, carrier, pageCount } = await extractText(file, progressCb);
    const accountInfo = parseAccountInfo(pages);

    let lineProfiles = null;
    let billMeta = {};

    if (carrier === 'att') {
      const summaryData = parseATTSummaryTable(pages);
      console.log('[PDF] Summary table:', Object.keys(summaryData.profiles).length, 'lines');

      const detailPages = parseATTDetailPages(pages);
      console.log('[PDF] Detail pages:', Object.keys(detailPages).length, 'lines');

      lineProfiles = mergeATTData(summaryData, detailPages, pages);
      console.log('[PDF] Merged profiles:', Object.keys(lineProfiles).length, 'lines');

      // Log extraction quality
      let withPlan = 0, withUsage = 0, zeroUsage = 0;
      for (const p of Object.values(lineProfiles)) {
        if (p.ratePlan) withPlan++;
        if (p.gbTotal > 0 || p.minTotal > 0 || p.msgTotal > 0) withUsage++;
        if (p.zeroUsage) zeroUsage++;
      }
      console.log(`[PDF] Quality: ${withPlan} with plan, ${withUsage} with usage, ${zeroUsage} zero usage`);

      billMeta = {
        billingPeriod: summaryData.billingPeriod,
        totalDue: accountInfo.totalDue,
        lastBillAmount: accountInfo.lastBillAmount,
        issueDate: accountInfo.issueDate,
        autoPayDate: accountInfo.autoPayDate,
      };
    }

    return { carrier, pageCount, accountInfo, lineProfiles, billMeta, rawPages: pages };
  }

  return { extractText, detectCarrier, parse, parseAccountInfo };
})();
