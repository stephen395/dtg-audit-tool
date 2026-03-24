/**
 * Bill PDF Parser — Full Line-Level Extraction
 * Uses pdf.js to extract text from carrier bill PDFs.
 * Auto-detects carrier from content.
 * NOT OCR — reads embedded text layer (like pdfplumber).
 *
 * Supports PDF-only audits for small accounts without CSVs.
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

  /**
   * Extract all text from a PDF file using pdf.js
   * Each page's text is extracted with line breaks preserved
   */
  async function extractText(file, progressCb) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();

      // Group items by Y position to reconstruct lines
      const items = textContent.items;
      if (items.length === 0) { pages.push(''); continue; }

      // Sort by Y (descending — PDF origin is bottom-left) then X
      const sorted = items.slice().sort((a, b) => {
        const dy = b.transform[5] - a.transform[5];
        if (Math.abs(dy) > 3) return dy > 0 ? 1 : -1; // different line
        return a.transform[4] - b.transform[4]; // same line, sort by X
      });

      // Group into lines (items within 3px Y are same line)
      const lines = [];
      let currentLine = [sorted[0]];
      for (let j = 1; j < sorted.length; j++) {
        if (Math.abs(sorted[j].transform[5] - currentLine[0].transform[5]) < 3) {
          currentLine.push(sorted[j]);
        } else {
          // Sort current line by X
          currentLine.sort((a, b) => a.transform[4] - b.transform[4]);
          lines.push(currentLine.map(it => it.str).join(' '));
          currentLine = [sorted[j]];
        }
      }
      currentLine.sort((a, b) => a.transform[4] - b.transform[4]);
      lines.push(currentLine.map(it => it.str).join(' '));

      pages.push(lines.join('\n'));
      if (progressCb && i % 50 === 0) progressCb(i, pdf.numPages);
    }

    const fullText = pages.join('\n\n');
    const carrier = detectCarrier(fullText);

    return { pages, fullText, carrier, pageCount: pdf.numPages };
  }

  function detectCarrier(text) {
    const t = text.toLowerCase();
    if (t.includes('at&t') || t.includes('att.com') || t.includes('premier.att')) return 'att';
    if (t.includes('verizon') || t.includes('vzw.com') || t.includes('verizon wireless')) return 'verizon';
    if (t.includes('t-mobile') || t.includes('tmobile') || t.includes('sprint')) return 'tmobile';
    return 'unknown';
  }

  function parseAccountInfo(pages) {
    const text = pages.slice(0, 5).join('\n');
    const info = {
      accountNumber: '',
      accountName: '',
      billingPeriod: '',
      totalDue: 0,
      dueDate: '',
    };

    const acctMatch = text.match(/Account\s*(?:Number|number|#)[\s:]*(\d[\d-]+)/);
    if (acctMatch) info.accountNumber = acctMatch[1].trim();

    const nameMatch = text.match(/^([A-Z][A-Z\s&,.]+(?:INC|LLC|CORP|CO|LTD|LP)?)\s/m);
    if (nameMatch) info.accountName = nameMatch[1].trim();

    const totalMatch = text.match(/(?:Total\s*due|total\s*amount\s*due)\s*\$?([\d,]+\.?\d*)/i);
    if (totalMatch) info.totalDue = parseFloat(totalMatch[1].replace(/,/g, ''));

    const dueMatch = text.match(/(?:scheduled\s*for|due\s*date)[:\s]*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    if (dueMatch) info.dueDate = dueMatch[1].trim();

    const periodMatch = text.match(/(?:Monthly\s*charges)\s+(\w{3}\s+\d{1,2})\s*-\s*(\w{3}\s+\d{1,2})/);
    if (periodMatch) info.billingPeriod = `${periodMatch[1]} - ${periodMatch[2]}`;

    return info;
  }

  function parseChargeSummary(pages) {
    const text = pages.slice(0, 15).join('\n');
    const charges = {
      monthlyCharges: 0,
      equipmentCharges: 0,
      surcharges: 0,
      taxes: 0,
      totalCurrentCharges: 0,
    };

    const totalMatch = text.match(/Total\s*(?:due|services)\s*\$?([\d,]+\.?\d*)/i);
    if (totalMatch) charges.totalCurrentCharges = parseFloat(totalMatch[1].replace(/,/g, ''));

    return charges;
  }

  // ═══════════════════════════════════════════════════════
  // AT&T FULL LINE EXTRACTION
  // ═══════════════════════════════════════════════════════

  /**
   * Extract all lines from AT&T bill PDF.
   *
   * Strategy: Each line has a detail page identified by the bracket pattern
   * [[XXXXbXXXXXX||... or ||XXXXXXXXXX]]
   *
   * From each detail page we extract:
   * - Phone number (from brackets)
   * - Device type (Ph = Phone, Ta = Tablet, Wa = Watch, etc.)
   * - User name (line after device type header)
   * - Rate plan (line starting with "1. Plan Name $XX.XX")
   * - Total charges ("Total for NNN.NNN.NNNN $XX.XX")
   * - Data usage (number appearing near plan name in Data Used section)
   * - Fees and taxes broken out
   */
  function parseATTDetailPages(pages) {
    const profiles = {};
    const bracketRe = /\|\|(\d{10})\]\]/;

    for (let i = 0; i < pages.length; i++) {
      const text = pages[i];
      if (!text || text.length < 80) continue;

      // Find phone number from closing bracket
      const bracketMatch = bracketRe.exec(text);
      if (!bracketMatch) continue;

      const wireless = bracketMatch[1];
      if (profiles[wireless]) continue; // Already processed

      const lines = text.split('\n');

      // Determine device type from header: "Ph[[..." "Ta[[..." "Wa[[..."
      let deviceType = 'Phone';
      for (const line of lines) {
        if (/^Ph\[\[/.test(line) || /Phone,/.test(line)) { deviceType = 'Phone'; break; }
        if (/^Ta\[\[/.test(line) || /Tablet,/.test(line) || /^Ta\b/.test(line)) { deviceType = 'Tablet'; break; }
        if (/^Wa\[\[/.test(line) || /Watch,/.test(line) || /Wearable,/.test(line)) { deviceType = 'Watch'; break; }
        if (/^Ho\[\[/.test(line) || /Hotspot,/.test(line)) { deviceType = 'Hotspot'; break; }
        if (/^La\[\[/.test(line) || /Laptop,/.test(line)) { deviceType = 'Laptop'; break; }
      }

      // User name: line immediately after the device header line
      let userName = '';
      for (let j = 0; j < lines.length; j++) {
        if (/\[\[/.test(lines[j]) && /ne,|let,|tch,|pot,|top,/.test(lines[j])) {
          // Next non-empty line is the user name
          for (let k = j + 1; k < Math.min(j + 3, lines.length); k++) {
            const candidate = lines[k].trim();
            if (candidate && !candidate.startsWith('Monthly') && !candidate.startsWith('Usage') && !candidate.startsWith('Company')) {
              userName = candidate.replace(/,?\s*INC$/i, '').trim().substring(0, 50);
              break;
            }
          }
          break;
        }
      }

      // Rate plan: first numbered item "1. Plan Name $XX.XX"
      let ratePlan = '';
      let planCharge = 0;
      for (const line of lines) {
        const planMatch = line.match(/^1\.\s+(.+?)\s+\$([\d,.]+)/);
        if (planMatch) {
          ratePlan = planMatch[1].trim();
          planCharge = parseMoney(planMatch[2]);
          break;
        }
      }

      // Total charges: "Total for NNN.NNN.NNNN $XX.XX"
      let totalCharges = 0;
      for (const line of lines) {
        const totalMatch = line.match(/Total for \d{3}\.\d{3}\.\d{4}\s+\$([\d,.]+)/);
        if (totalMatch) {
          totalCharges = parseMoney(totalMatch[1]);
          break;
        }
      }

      // Data usage: number next to plan name in "Data Used" section
      // AT&T format: "Data Used" appears then "Plan Name NNN,NNN" (in MB)
      // or "(X.XX GB) X.XX" for shared plans
      let dataMB = 0;
      let foundDataSection = false;
      for (const line of lines) {
        if (line.includes('Data Used')) foundDataSection = true;
        if (foundDataSection) {
          // Look for: "Plan Name NNN,NNN" or "Plan Name (unlimited MB)" with usage number
          const dataMatch = line.match(/(?:VVM|LTE|5G|Tablet|Wearable|unlimited\s*MB\)?)\s+([\d,]+)$/);
          if (dataMatch) {
            dataMB = parseInt(dataMatch[1].replace(/,/g, ''), 10);
            break;
          }
          // Shared plan: "(X.XX GB) X.XX"
          const sharedMatch = line.match(/\(([\d.]+)\s*GB\)\s+([\d.]+)/);
          if (sharedMatch) {
            dataMB = parseFloat(sharedMatch[2]) * 1024; // Convert GB to MB
            break;
          }
          // Simple number at end of line in data section
          const simpleMatch = line.match(/\b([\d,]+)\s*$/);
          if (simpleMatch && foundDataSection && !line.includes('$') && !line.includes('Fee') && !line.includes('Tax')) {
            const val = parseInt(simpleMatch[1].replace(/,/g, ''), 10);
            if (val >= 0 && val < 500000) { // Reasonable MB range
              dataMB = val;
              break;
            }
          }
        }
      }

      // Extract company fees subtotal
      let companyFees = 0;
      let govTaxes = 0;
      let inCompanyFees = false;
      let inGovTaxes = false;
      for (const line of lines) {
        if (line.includes('Company fees')) inCompanyFees = true;
        if (line.includes('Government fees')) { inCompanyFees = false; inGovTaxes = true; }
        if (line.includes('Total for')) { inGovTaxes = false; break; }

        const feeMatch = line.match(/\$([\d,.]+)$/);
        if (feeMatch) {
          const amt = parseMoney(feeMatch[1]);
          if (inCompanyFees) companyFees += amt;
          if (inGovTaxes) govTaxes += amt;
        }
      }

      // Equipment charges
      let equipment = 0;
      for (const line of lines) {
        if (/Installment|APPLE|Samsung|Galaxy/i.test(line)) {
          const eqMatch = line.match(/\$([\d,.]+)/);
          if (eqMatch) equipment += parseMoney(eqMatch[1]);
        }
        // Promo credits
        if (/Promo|Credit/i.test(line) && /Installment|device/i.test(text)) {
          const credMatch = line.match(/-\$([\d,.]+)/);
          if (credMatch) equipment -= parseMoney(credMatch[1]);
        }
      }

      const dataGB = dataMB / 1024;
      const isZeroUsage = dataMB === 0;

      profiles[wireless] = {
        wireless,
        userName: userName || 'Unknown',
        deviceType,
        ratePlan,
        mrc: totalCharges,
        monthlyCharges: planCharge,
        totalCharges,
        equipment: Math.max(0, equipment),
        taxes: govTaxes,
        fees: companyFees,
        latestTaxes: govTaxes,
        latestFees: companyFees,
        gbTotal: dataGB,
        kbTotal: dataMB * 1024,
        minTotal: 0, // Can't reliably extract from AT&T PDF
        msgTotal: 0,
        zeroUsage: isZeroUsage,
        hasActiveContract: false, // PDF doesn't have contract info
        contractEnd: null,
        contractType: '',
        source: 'pdf',
      };
    }

    return profiles;
  }

  /**
   * Also extract lines from summary pages (pages 4-30ish)
   * These have the charge breakdown table but less detail per line
   */
  function parseATTSummaryCharges(pages, profiles) {
    const phoneRe = /(\d{3})[.\-](\d{3})[.\-](\d{4})/g;

    for (let i = 3; i < Math.min(50, pages.length); i++) {
      const text = pages[i];
      if (!text.includes('Subtotal for Group')) continue;

      const textLines = text.split('\n');
      for (const line of textLines) {
        const phoneMatch = line.match(/(\d{3})[.\-](\d{3})[.\-](\d{4})/);
        if (!phoneMatch) continue;

        const wireless = phoneMatch[1] + phoneMatch[2] + phoneMatch[3];
        if (!profiles[wireless]) continue;

        // Try to get better user name from summary if current is Unknown
        if (profiles[wireless].userName === 'Unknown') {
          const afterPhone = line.substring(line.indexOf(phoneMatch[0]) + phoneMatch[0].length).trim();
          const nameMatch = afterPhone.match(/^([A-Z][A-Z\s.,'\-&/]+?)(?:\.\.\.|\.{3}|\d{2,})/);
          if (nameMatch) {
            profiles[wireless].userName = nameMatch[1].trim().replace(/\.+$/, '').substring(0, 50);
          }
        }
      }
    }
  }

  /**
   * Main parse function — enhanced for full line-level extraction
   */
  async function parse(file, progressCb) {
    const { pages, fullText, carrier, pageCount } = await extractText(file, progressCb);
    const accountInfo = parseAccountInfo(pages);
    const charges = parseChargeSummary(pages);

    let lineProfiles = null;
    if (carrier === 'att') {
      lineProfiles = parseATTDetailPages(pages);
      parseATTSummaryCharges(pages, lineProfiles);
      console.log('[PDF] AT&T extraction:', Object.keys(lineProfiles).length, 'lines from', pageCount, 'pages');
    }
    // TODO: Add verizon and tmobile PDF parsers

    return {
      carrier,
      pageCount,
      accountInfo,
      charges,
      lineProfiles,
      rawPages: pages,
    };
  }

  return {
    extractText,
    detectCarrier,
    parse,
    parseAccountInfo,
    parseChargeSummary,
  };
})();
