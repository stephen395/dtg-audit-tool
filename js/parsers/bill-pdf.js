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
    const neg = s.startsWith('(') || s.startsWith('-');
    s = s.replace(/[$,()]/g, '').trim();
    const v = parseFloat(s);
    if (isNaN(v)) return 0;
    return neg ? -v : v;
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
    const text = pages.slice(0, 3).join('\n');
    const info = {
      accountNumber: '', foundationAccount: '', invoice: '',
      accountName: '', billingContact: '', issueDate: '',
      billingPeriod: '', totalDue: 0, autoPayDate: '',
      lastBillAmount: 0,
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
    if (apMatch) info.autoPayDate = apMatch[1].trim();

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
      const planMatch = text.match(/\d+\.\s+(Business [^$]+?|UNL [^$]+?|Unlimited [^$]+?|AT&T [^$]+?|Mobile Share[^$]+?)\s+\$([\d,.]+)/);
      if (planMatch) {
        d.ratePlan = planMatch[1].trim()
          .replace(/\s+Smartphone Line Discount.*/, '')
          .replace(/\s+Tablet Line Discount.*/, '')
          .trim();
        d.planCharge = parseMoney(planMatch[2]);
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

      // MRC = plan charge ONLY (not equipment, not one-time, not taxes)
      const mrc = s.planCharge || d.planCharge || 0;

      profiles[wireless] = {
        wireless,
        userName: d.userName || s.userName || 'Unknown',
        deviceType: devType,
        ratePlan: d.ratePlan || '',
        mrc,
        monthlyCharges: mrc,
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
        hasActiveContract: !!d.equipmentInstallment,
        contractEnd: null,
        contractType: d.equipmentInstallment ? 'Installment' : '',
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
