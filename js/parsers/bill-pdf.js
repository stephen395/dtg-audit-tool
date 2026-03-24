/**
 * Bill PDF Parser
 * Uses pdf.js to extract text from carrier bill PDFs.
 * Auto-detects carrier from content.
 * NOT OCR — reads embedded text layer (like pdfplumber).
 */

window.BillPDFParser = (function () {

  /**
   * Extract all text from a PDF file
   * @param {File} file - PDF file from input
   * @returns {Promise<{pages: string[], fullText: string, carrier: string}>}
   */
  async function extractText(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const text = textContent.items.map(item => item.str).join(' ');
      pages.push(text);
    }

    const fullText = pages.join('\n\n');
    const carrier = detectCarrier(fullText);

    return { pages, fullText, carrier, pageCount: pdf.numPages };
  }

  /**
   * Detect carrier from PDF text
   */
  function detectCarrier(text) {
    const t = text.toLowerCase();
    if (t.includes('at&t') || t.includes('att.com') || t.includes('premier.att')) return 'att';
    if (t.includes('verizon') || t.includes('vzw.com') || t.includes('verizon wireless')) return 'verizon';
    if (t.includes('t-mobile') || t.includes('tmobile') || t.includes('sprint')) return 'tmobile';
    return 'unknown';
  }

  /**
   * Parse account info from first pages
   */
  function parseAccountInfo(pages, carrier) {
    const text = pages.slice(0, 3).join('\n');
    const info = {
      accountNumber: '',
      accountName: '',
      billingPeriod: '',
      totalDue: 0,
      dueDate: '',
    };

    // Generic patterns
    const acctMatch = text.match(/account\s*(?:number|#|no\.?)[\s:]*(\d[\d-]+)/i);
    if (acctMatch) info.accountNumber = acctMatch[1].trim();

    const totalMatch = text.match(/total\s*(?:amount\s*)?due[\s:]*\$?([\d,]+\.?\d*)/i);
    if (totalMatch) info.totalDue = parseFloat(totalMatch[1].replace(/,/g, ''));

    const dateMatch = text.match(/(?:due\s*date|payment\s*due)[\s:]*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    if (dateMatch) info.dueDate = dateMatch[1];

    const periodMatch = text.match(/(?:billing?\s*period|service\s*period)[\s:]*(.+?)(?:\n|$)/i);
    if (periodMatch) info.billingPeriod = periodMatch[1].trim().substring(0, 50);

    return info;
  }

  /**
   * Extract charge summary from bill
   * Returns categorized charges
   */
  function parseChargeSummary(pages, carrier) {
    const text = pages.slice(0, 5).join('\n');
    const charges = {
      monthlyCharges: 0,
      equipmentCharges: 0,
      surcharges: 0,
      taxes: 0,
      usageCharges: 0,
      totalCurrentCharges: 0,
    };

    // Try to extract charge categories
    const patterns = [
      [/monthly\s*(?:service\s*)?charges[\s:]*\$?([\d,]+\.?\d*)/i, 'monthlyCharges'],
      [/equipment\s*charges[\s:]*\$?([\d,]+\.?\d*)/i, 'equipmentCharges'],
      [/surcharges[\s:]*\$?([\d,]+\.?\d*)/i, 'surcharges'],
      [/tax(?:es)?[\s:]*\$?([\d,]+\.?\d*)/i, 'taxes'],
      [/usage\s*(?:and\s*purchase\s*)?charges[\s:]*\$?([\d,]+\.?\d*)/i, 'usageCharges'],
      [/total\s*current\s*charges[\s:]*\$?([\d,]+\.?\d*)/i, 'totalCurrentCharges'],
    ];

    for (const [pattern, field] of patterns) {
      const match = text.match(pattern);
      if (match) {
        charges[field] = parseFloat(match[1].replace(/,/g, ''));
      }
    }

    return charges;
  }

  /**
   * Extract rate plan information from bill text
   */
  function parseRatePlans(pages) {
    const plans = [];
    const fullText = pages.join('\n');

    // Look for plan-related sections
    const planPatterns = [
      /(?:plan|calling plan|rate plan)[\s:]+([^\n$]+?)(?:\s*\$)([\d,]+\.?\d*)/gi,
    ];

    for (const pattern of planPatterns) {
      let match;
      while ((match = pattern.exec(fullText)) !== null) {
        plans.push({
          name: match[1].trim(),
          cost: parseFloat(match[2].replace(/,/g, '')),
        });
      }
    }

    return plans;
  }

  /**
   * Main parse function
   * @param {File} file - PDF file
   * @returns {Promise<Object>} Parsed bill data
   */
  async function parse(file) {
    const { pages, fullText, carrier, pageCount } = await extractText(file);
    const accountInfo = parseAccountInfo(pages, carrier);
    const charges = parseChargeSummary(pages, carrier);
    const ratePlans = parseRatePlans(pages);

    return {
      carrier,
      pageCount,
      accountInfo,
      charges,
      ratePlans,
      rawPages: pages,
    };
  }

  return { extractText, detectCarrier, parse, parseAccountInfo, parseChargeSummary };
})();
