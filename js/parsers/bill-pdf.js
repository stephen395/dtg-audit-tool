/**
 * Bill PDF Parser — Full Line-Level Extraction
 * Uses pdf.js to extract text from carrier bill PDFs.
 * NOT OCR — reads embedded text layer (like pdfplumber).
 *
 * Two extraction paths:
 *  1. Summary table (page 2 for small accounts) — charge breakdown per line + usage
 *  2. Detail pages (bracket markers) — rate plan, device, one-time charges, installments
 *
 * Merges both sources for maximum accuracy.
 */

window.BillPDFParser = (function () {

  function parseMoney(val) {
    if (val == null || val === '' || val === '-') return 0;
    let s = String(val).trim();
    const neg = s.startsWith('(') || s.startsWith('-');
    s = s.replace(/[$,()]/g, '').trim();
    const v = parseFloat(s);
    if (isNaN(v)) return 0;
    return neg ? -v : v;
  }

  // ═══════════════════════════════════════════════════════
  // TEXT EXTRACTION (pdf.js)
  // ═══════════════════════════════════════════════════════

  async function extractText(file, progressCb) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      // Simple join — sufficient for AT&T bills
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
    const text = pages.slice(0, 3).join('\n');
    const info = {
      accountNumber: '',
      foundationAccount: '',
      invoice: '',
      accountName: '',
      billingContact: '',
      billingAddress: '',
      issueDate: '',
      billingPeriod: '',
      totalDue: 0,
      autoPayDate: '',
      lastBillAmount: 0,
      lastPayment: 0,
    };

    // Account number (BAN)
    const acctMatch = text.match(/Account\s*(?:Number|number)[:\s]*(\d[\d-]+)/);
    if (acctMatch) info.accountNumber = acctMatch[1].trim();

    // Foundation Account (FAN)
    const fanMatch = text.match(/Foundation\s*Account[:\s]*(\d+)/);
    if (fanMatch) info.foundationAccount = fanMatch[1].trim();

    // Invoice
    const invMatch = text.match(/Invoice[:\s]*(\S+)/);
    if (invMatch) info.invoice = invMatch[1].trim();

    // Issue date
    const dateMatch = text.match(/Issue\s*Date[:\s]*([\w\s,]+?\d{4})/);
    if (dateMatch) info.issueDate = dateMatch[1].trim();

    // Company name — first line of the page (before ATTN or Page:)
    const nameMatch = text.match(/^([A-Z][A-Z\s&,.]+?)(?:\s+Page:|\s+ATTN)/m);
    if (nameMatch) info.accountName = nameMatch[1].trim();

    // ATTN contact
    const attnMatch = text.match(/ATTN[:\s]*([A-Z][A-Za-z\s]+)/);
    if (attnMatch) info.billingContact = attnMatch[1].trim();

    // Total due
    const totalMatch = text.match(/Total\s*due\s*\$?([\d,]+\.?\d*)/i);
    if (totalMatch) info.totalDue = parseFloat(totalMatch[1].replace(/,/g, ''));

    // AutoPay date
    const apMatch = text.match(/(?:AutoPay|scheduled\s*for)[:\s]*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4})/i);
    if (apMatch) info.autoPayDate = apMatch[1].trim();

    // Last bill
    const lastMatch = text.match(/(?:Your\s*)?last\s*bill\s*\$?([\d,]+\.?\d*)/i);
    if (lastMatch) info.lastBillAmount = parseFloat(lastMatch[1].replace(/,/g, ''));

    // Billing period from usage summary
    const periodMatch = text.match(/(?:Usage\s*summary|Monthly\s*charges)\s*\(?([\w]+\s+\d{1,2})\s*-\s*([\w]+\s+\d{1,2})/);
    if (periodMatch) info.billingPeriod = `${periodMatch[1]} - ${periodMatch[2]}`;

    return info;
  }

  // ═══════════════════════════════════════════════════════
  // AT&T SUMMARY TABLE (Page 2 typically)
  // Extracts charge breakdown + usage for ALL lines
  // ═══════════════════════════════════════════════════════

  function parseATTSummaryTable(pages) {
    const profiles = {};
    const phoneRe = /(\d{3})[.\-](\d{3})[.\-](\d{4})/g;

    for (let i = 1; i < Math.min(50, pages.length); i++) {
      const text = pages[i];

      // Look for the charge summary table (has "Subtotal" or "Total" row with dollar amounts)
      if (!text.includes('Plan') || !text.includes('Total')) continue;

      // Extract charge lines: "NNN.NNN.NNNN USER PAGE# amounts..."
      // AT&T format: Number User Page Activity Plan Equipment Add-ons CompanyFees GovTaxes Total
      const lines = text.split(/(?=\d{3}\.\d{3}\.\d{4})/);

      for (const line of lines) {
        const phoneMatch = line.match(/^(\d{3})\.(\d{3})\.(\d{4})\s+(.+)/);
        if (!phoneMatch) continue;

        const wireless = phoneMatch[1] + phoneMatch[2] + phoneMatch[3];
        const rest = phoneMatch[4];

        // Extract user name (text before the page number)
        const namePageMatch = rest.match(/^([A-Za-z][A-Za-z\s.,'\-&/]+?)\s+(\d{1,3})\s/);
        let userName = '';
        let afterName = rest;
        if (namePageMatch) {
          userName = namePageMatch[1].trim();
          afterName = rest.substring(namePageMatch[0].length);
        }

        // Extract all dollar amounts from the line
        const amounts = [];
        const moneyRe = /-?\$[\d,.]+|-(?=\s)/g;
        let m;
        while ((m = moneyRe.exec(afterName)) !== null) {
          if (m[0] === '-') amounts.push(0);
          else amounts.push(parseMoney(m[0]));
        }

        // AT&T column order: Activity, Plan, Equipment, (Add-ons), CompanyFees, GovTaxes, Total
        // Minimum 5 amounts expected
        if (amounts.length >= 5) {
          profiles[wireless] = {
            wireless,
            userName: userName || 'Unknown',
            activityCharges: amounts[0] || 0,
            planCharge: amounts[1] || 0,
            equipmentCharge: amounts[2] || 0,
            companyFees: amounts.length >= 6 ? amounts[amounts.length - 3] : amounts[3],
            govTaxes: amounts.length >= 6 ? amounts[amounts.length - 2] : amounts[4],
            totalCharges: amounts[amounts.length - 1] || 0,
          };
        } else if (amounts.length >= 2) {
          // Simpler line with fewer columns
          profiles[wireless] = {
            wireless,
            userName: userName || 'Unknown',
            activityCharges: 0,
            planCharge: amounts[0] || 0,
            equipmentCharge: 0,
            companyFees: amounts.length > 2 ? amounts[amounts.length - 3] : 0,
            govTaxes: amounts.length > 2 ? amounts[amounts.length - 2] : 0,
            totalCharges: amounts[amounts.length - 1] || 0,
          };
        }
      }

      // Extract totals row
      const totalRowMatch = text.match(/Total\s+((?:-?\$[\d,.]+\s*)+)/);

      // Extract usage summary section
      // Format: "NNN.NNN.NNNN USER X.XXGB (unlimited) NNN (unlimited) NNN (unlimited)"
      const usageSection = text.match(/Usage summary[\s\S]*/);
      if (usageSection) {
        const usageText = usageSection[0];
        const usageRe = /(\d{3})\.(\d{3})\.(\d{4})\s+([A-Za-z][A-Za-z\s.,'\-&/]+?)\s+([\d.]+)GB\s*\((\w+)\)\s+(\d[\d,]*)\s*\((\w+)\)\s+(\d[\d,]*)\s*\((\w+)\)/g;

        let um;
        while ((um = usageRe.exec(usageText)) !== null) {
          const wn = um[1] + um[2] + um[3];
          const dataGB = parseFloat(um[5]) || 0;
          const texts = parseInt((um[7] || '0').replace(/,/g, ''), 10) || 0;
          const talk = parseInt((um[9] || '0').replace(/,/g, ''), 10) || 0;

          if (profiles[wn]) {
            profiles[wn].dataGB = dataGB;
            profiles[wn].textCount = texts;
            profiles[wn].talkMinutes = talk;
          }
        }

        // Also extract billing period
        const periodMatch = usageText.match(/\((\w+\s+\d{1,2})\s*-\s*(\w+\s+\d{1,2})\)/);
        if (periodMatch) {
          profiles._billingPeriod = `${periodMatch[1]} - ${periodMatch[2]}`;
        }
      }

      if (Object.keys(profiles).length > 0) break; // Found the summary page
    }

    return profiles;
  }

  // ═══════════════════════════════════════════════════════
  // AT&T DETAIL PAGES (bracket markers)
  // Extracts: rate plan, device, one-time charges, installments, usage
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

      const detail = {
        deviceType: 'Phone',
        ratePlan: '',
        planCharge: 0,
        oneTimeCharges: [],
        oneTimeTotal: 0,
        equipmentName: '',
        equipmentIMEI: '',
        equipmentInstallment: '',
        equipmentCharge: 0,
        equipmentFinanced: 0,
        equipmentRemaining: 0,
        equipmentEstablished: '',
        companyFees: 0,
        govTaxes: 0,
        totalCharges: 0,
        dataGB: 0,
        dataAllowance: '',
        dataPlanName: '',
        talkMinutes: 0,
        textCount: 0,
        userName: '',
      };

      // Device type
      if (/Ph\[\[|Phone,/.test(text)) detail.deviceType = 'Phone';
      else if (/Ta\[\[|Tablet,|let,/.test(text)) detail.deviceType = 'Tablet';
      else if (/Wa\[\[|Watch,|Wearable,/.test(text)) detail.deviceType = 'Watch';
      else if (/Ho\[\[|Hotspot,/.test(text)) detail.deviceType = 'Hotspot';
      else if (/La\[\[|Laptop,/.test(text)) detail.deviceType = 'Laptop';

      // User name — after device header, before "Activity" or "Monthly"
      const nameMatch = text.match(/(?:ne,|let,|tch,|pot,|top,)\s*\d{3}\.\d{3}\.\d{4}\s+(.+?)(?:\s+Activity|\s+Monthly|$)/);
      if (nameMatch) {
        detail.userName = nameMatch[1].trim().replace(/,?\s*INC$/i, '').substring(0, 50);
      }

      // One-time charges (Activity since last bill)
      const otcRe = /\d+\.\s+(.+?)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(-?\$[\d,.]+)\s*<One-time/g;
      let otcMatch;
      while ((otcMatch = otcRe.exec(text)) !== null) {
        const amt = parseMoney(otcMatch[2]);
        detail.oneTimeCharges.push({
          description: otcMatch[1].trim(),
          amount: amt,
        });
        detail.oneTimeTotal += amt;
      }

      // Rate plan — first numbered monthly charge item
      // Pattern: "N. Plan Name $XX.XX" (under Monthly charges section)
      const planMatch = text.match(/Monthly charges[\s\S]*?\d+\.\s+([A-Z][^$\n]+?)\s+\$([\d,.]+)/);
      if (planMatch) {
        detail.ratePlan = planMatch[1].trim()
          .replace(/\s+Smartphone Line Discount/, '')
          .replace(/\s+Tablet Line Discount/, '')
          .trim();
        detail.planCharge = parseMoney(planMatch[2]);
      }

      // Equipment installment
      const eqMatch = text.match(/\d+\.\s+((?:APPLE|SAMSUNG|GOOGLE|MOTOROLA|LG)[^-\n]+?)\s*-\s*Installment\s+(\d+)\s+of\s+(\d+)\s*.*?\$([\d,.]+)/i);
      if (eqMatch) {
        detail.equipmentName = eqMatch[1].trim();
        detail.equipmentInstallment = `${eqMatch[2]} of ${eqMatch[3]}`;
        detail.equipmentCharge = parseMoney(eqMatch[4]);
      }

      // Equipment details box
      const eqDetailMatch = text.match(/(APPLE|SAMSUNG|GOOGLE|MOTOROLA|LG)[^\n]*?(\d{15})/i);
      if (eqDetailMatch) {
        if (!detail.equipmentName) detail.equipmentName = eqDetailMatch[0].substring(0, 60).trim();
        detail.equipmentIMEI = eqDetailMatch[2];
      }

      const estMatch = text.match(/Established\s*on\s+([\w\s,]+\d{4})/);
      if (estMatch) detail.equipmentEstablished = estMatch[1].trim();

      const finMatch = text.match(/Amount\s*financed\s*\$([\d,.]+)/);
      if (finMatch) detail.equipmentFinanced = parseMoney(finMatch[1]);

      const remMatch = text.match(/Balance\s*remaining[\s\S]*?\$([\d,.]+)/);
      if (remMatch) detail.equipmentRemaining = parseMoney(remMatch[1]);

      // Company fees total
      let inFees = false, inTaxes = false;
      const feeLines = text.split(/(?=\d+\.\s)/);
      for (const fl of feeLines) {
        if (/Company fees/i.test(fl)) inFees = true;
        if (/Government fees/i.test(fl)) { inFees = false; inTaxes = true; }
        if (/Total for/i.test(fl)) break;

        const amt = fl.match(/\$([\d,.]+)\s*$/);
        if (amt) {
          if (inFees) detail.companyFees += parseMoney(amt[1]);
          if (inTaxes) detail.govTaxes += parseMoney(amt[1]);
        }
      }

      // Total charges
      const totalMatch = text.match(/Total for \d{3}\.\d{3}\.\d{4}\s+\$([\d,.]+)/);
      if (totalMatch) detail.totalCharges = parseMoney(totalMatch[1]);

      // Usage — Data
      const dataMatch = text.match(/(?:DATA ALL|Tablet Plan|Standalone Tablet|Wearable)\s*(?:AAT)?\s*\(\s*(unlimited|\d[\d,.]*)\s*(?:GB|MB)\)\s*([\d,.]+)/i);
      if (dataMatch) {
        detail.dataAllowance = dataMatch[1];
        const rawData = parseFloat(dataMatch[2].replace(/,/g, ''));
        // If allowance is in MB, data value is in MB; if GB, it's in GB
        if (/MB\)/.test(text.substring(text.indexOf(dataMatch[0]) - 20, text.indexOf(dataMatch[0]) + dataMatch[0].length))) {
          detail.dataGB = rawData / 1024;
        } else {
          detail.dataGB = rawData;
        }
      }
      // Fallback: "UNLIMITED QCI8 - 75 5G DATA ALL XX.XX"
      if (detail.dataGB === 0) {
        const dataFallback = text.match(/(?:QCI\d|DATA ALL|5G DATA)\s*(?:AAT)?\s*(?:\(\s*unlimited\s*GB\s*\))?\s*([\d,.]+)/i);
        if (dataFallback) {
          detail.dataGB = parseFloat(dataFallback[1].replace(/,/g, ''));
        }
      }

      // Data plan name
      const dpnMatch = text.match(/(UNLIMITED QCI\d[^\n(]+|Unlimited Tablet Plan|UNL Standalone Tablet)/i);
      if (dpnMatch) detail.dataPlanName = dpnMatch[1].trim();

      // Usage — Talk
      const talkMatch = text.match(/Plan minutes\s*\(unlimited\)\s+([\d,]+)/);
      if (talkMatch) detail.talkMinutes = parseInt(talkMatch[1].replace(/,/g, ''), 10);

      // Usage — Text
      const textMatch2 = text.match(/Plan messages\s*\(unlimited\)\s+([\d,]+)/);
      if (textMatch2) detail.textCount = parseInt(textMatch2[1].replace(/,/g, ''), 10);

      details[wireless] = detail;
    }

    return details;
  }

  // ═══════════════════════════════════════════════════════
  // MERGE: Combine summary table + detail pages into profiles
  // ═══════════════════════════════════════════════════════

  function mergeATTData(summaryProfiles, detailPages, accountInfo) {
    const profiles = {};
    const allWireless = new Set([
      ...Object.keys(summaryProfiles).filter(k => k !== '_billingPeriod'),
      ...Object.keys(detailPages),
    ]);

    for (const wireless of allWireless) {
      if (!/^\d{10}$/.test(wireless)) continue;

      const summary = summaryProfiles[wireless] || {};
      const detail = detailPages[wireless] || {};

      const dataGB = detail.dataGB || summary.dataGB || 0;
      const talkMin = detail.talkMinutes || summary.talkMinutes || 0;
      const textCnt = detail.textCount || summary.textCount || 0;
      const isZeroUsage = dataGB === 0 && talkMin === 0 && textCnt === 0;

      // Device type: from detail page or guess from plan/name
      let deviceType = detail.deviceType || 'Phone';
      if (!detail.deviceType) {
        const hint = ((summary.userName || '') + ' ' + (detail.ratePlan || '')).toLowerCase();
        if (hint.includes('tablet') || hint.includes('ipad')) deviceType = 'Tablet';
        else if (hint.includes('watch') || hint.includes('wearable')) deviceType = 'Watch';
        else if (hint.includes('hotspot') || hint.includes('jetpack')) deviceType = 'Hotspot';
        else if (hint.includes('laptop')) deviceType = 'Laptop';
      }

      profiles[wireless] = {
        wireless,
        userName: detail.userName || summary.userName || 'Unknown',
        deviceType,
        ratePlan: detail.ratePlan || '',
        dataPlanName: detail.dataPlanName || '',
        mrc: summary.planCharge || detail.planCharge || 0,
        monthlyCharges: summary.planCharge || detail.planCharge || 0,
        totalCharges: summary.totalCharges || detail.totalCharges || 0,
        activityCharges: summary.activityCharges || detail.oneTimeTotal || 0,
        oneTimeCharges: detail.oneTimeCharges || [],
        equipment: summary.equipmentCharge || detail.equipmentCharge || 0,
        equipmentName: detail.equipmentName || '',
        equipmentIMEI: detail.equipmentIMEI || '',
        equipmentInstallment: detail.equipmentInstallment || '',
        equipmentFinanced: detail.equipmentFinanced || 0,
        equipmentRemaining: detail.equipmentRemaining || 0,
        equipmentEstablished: detail.equipmentEstablished || '',
        taxes: summary.govTaxes || detail.govTaxes || 0,
        fees: summary.companyFees || detail.companyFees || 0,
        latestTaxes: summary.govTaxes || detail.govTaxes || 0,
        latestFees: summary.companyFees || detail.companyFees || 0,
        gbTotal: dataGB,
        kbTotal: dataGB * 1024 * 1024,
        minTotal: talkMin,
        msgTotal: textCnt,
        zeroUsage: isZeroUsage,
        hasActiveContract: !!detail.equipmentInstallment,
        contractEnd: null, // Installment end can be calculated
        contractType: detail.equipmentInstallment ? 'Installment' : '',
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
      // Path 1: Summary table (works for all account sizes)
      const summaryProfiles = parseATTSummaryTable(pages);
      const billingPeriod = summaryProfiles._billingPeriod || accountInfo.billingPeriod || '';
      delete summaryProfiles._billingPeriod;

      console.log('[PDF] AT&T summary table:', Object.keys(summaryProfiles).length, 'lines');

      // Path 2: Detail pages (bracket markers)
      const detailPages = parseATTDetailPages(pages);
      console.log('[PDF] AT&T detail pages:', Object.keys(detailPages).length, 'lines');

      // Merge both sources
      lineProfiles = mergeATTData(summaryProfiles, detailPages, accountInfo);
      console.log('[PDF] AT&T merged profiles:', Object.keys(lineProfiles).length, 'lines');

      billMeta = {
        billingPeriod,
        totalDue: accountInfo.totalDue,
        lastBillAmount: accountInfo.lastBillAmount,
        issueDate: accountInfo.issueDate,
        autoPayDate: accountInfo.autoPayDate,
      };
    }
    // TODO: Verizon and T-Mobile PDF parsing

    return {
      carrier,
      pageCount,
      accountInfo,
      lineProfiles,
      billMeta,
      rawPages: pages,
    };
  }

  return {
    extractText,
    detectCarrier,
    parse,
    parseAccountInfo,
  };
})();
