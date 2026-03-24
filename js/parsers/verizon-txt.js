/**
 * Verizon ECPD/Tangoe TXT Parser
 * Parses tab-delimited TXT exports from Verizon's ECPD portal.
 * Supports 4 file types: AccountSummary, WirelessSummary, ChargesDetail, UsageDetail
 * Reference: verizon-billread SKILL.md
 */

window.VerizonParser = (function () {

  /**
   * Detect which of the 4 Verizon TXT file types this is.
   * Returns 'accountSummary' | 'wirelessSummary' | 'chargesDetail' | 'usageDetail' | null
   */
  function detectFileType(headers) {
    const h = headers.map(c => c.toLowerCase().trim());

    if (h.some(c => c.includes('previous balance')) && h.some(c => c.includes('total amount due'))) {
      return 'accountSummary';
    }
    if (h.some(c => c.includes('your calling plan')) && h.some(c => c.includes('data usage'))) {
      return 'wirelessSummary';
    }
    if (h.some(c => c.includes('item category')) && h.some(c => c.includes('item description'))) {
      return 'chargesDetail';
    }
    if (h.some(c => c.includes('usage category')) && h.some(c => c.includes('origination'))) {
      return 'usageDetail';
    }
    return null;
  }

  function parseMoney(val) {
    if (val == null || val === '') return 0;
    let s = String(val).trim();
    const negative = s.startsWith('(') || s.startsWith('-');
    s = s.replace(/[$,()]/g, '').trim();
    const v = parseFloat(s);
    return isNaN(v) ? 0 : (negative ? -v : v);
  }

  function parseFloat2(val) {
    if (val == null || val === '') return 0;
    const v = parseFloat(String(val).trim().replace(/,/g, ''));
    return isNaN(v) ? 0 : v;
  }

  function clean(val) {
    return String(val || '').trim().replace(/^"|"$/g, '');
  }

  /** Device type classification from plan name */
  function classifyDevice(planName) {
    const p = (planName || '').toUpperCase();
    if (p.includes('TABLET') || p.includes('TAB')) return 'Tablet';
    if (p.includes('DATA DEVICE') || p.includes('JETPACK') || p.includes('HOTSPOT') ||
        p.includes('MBB') || p.includes('CAMERA')) return 'Hotspot';
    if (p.includes('WATCH') || p.includes('WEARABLE') || p.includes('NUMBERSHARE')) return 'Watch';
    if (p.includes('SMARTPHONE') || p.includes('5G SMARTPHONE') || p.includes('PHONE')) return 'Smartphone';
    if (p.includes('MY BIZ PLAN')) return 'Smartphone';
    if (p.includes('BUSINESS UNLIMITED')) return 'Smartphone';
    return 'Other';
  }

  /**
   * Parse AccountSummary TXT — BAN-level totals
   */
  function parseAccountSummary(rows) {
    const accounts = [];
    for (const row of rows) {
      const ban = clean(row['Account Number'] || row['account number']);
      if (!ban) continue;

      accounts.push({
        ban,
        billPeriod: clean(row['Bill Period'] || row['bill period']),
        dateDue: clean(row['Date Due'] || row['date due']),
        invoiceNumber: clean(row['Invoice Number'] || row['invoice number']),
        billName: clean(row['Bill Name'] || row['bill name']),
        previousBalance: parseMoney(row['Previous Balance'] || row['previous balance']),
        payments: parseMoney(row['Payments'] || row['payments']),
        balanceForward: parseMoney(row['Balance Forward'] || row['balance forward']),
        monthlyCharges: parseMoney(row['Monthly Charges'] || row['monthly charges']),
        equipmentCharges: parseMoney(row['Equipment Charges'] || row['equipment charges']),
        surcharges: parseMoney(row['Surcharges and OC&Cs'] || row['surcharges and oc&cs']),
        taxes: parseMoney(row['Taxes, Governmental Surcharges, and Fees'] || row['taxes, governmental surcharges, and fees']),
        totalCurrentCharges: parseMoney(row['Total Current Charges'] || row['total current charges']),
        totalAmountDue: parseMoney(row['Total Amount Due'] || row['total amount due']),
      });
    }
    return accounts;
  }

  /**
   * Parse Account & Wireless Summary — line-level data
   */
  function parseWirelessSummary(rows) {
    const lines = [];
    for (const row of rows) {
      const wireless = clean(row['Wireless Number'] || row['wireless number']);
      if (!wireless || wireless === 'N/A' || wireless.length < 7) continue;

      const ban = clean(row['Account Number'] || row['account number']);
      const planName = clean(row['Your Calling Plan'] || row['your calling plan']);

      lines.push({
        ban,
        wireless,
        userName: clean(row['User Name'] || row['user name']),
        costCenter: clean(row['Cost Center'] || row['cost center']),
        callingPlan: planName,
        deviceType: classifyDevice(planName),
        monthlyCharges: parseMoney(row['Monthly Charges'] || row['monthly charges']),
        usagePurchaseCharges: parseMoney(row['Usage and Purchase Charges'] || row['usage and purchase charges']),
        equipmentCharges: parseMoney(row['Equipment Charges'] || row['equipment charges']),
        surcharges: parseMoney(row['Total Surcharges and Other Charges and Credits'] || row['total surcharges and other charges and credits']),
        taxes: parseMoney(row['Taxes, Governmental Surcharges and Fees'] || row['taxes, governmental surcharges and fees']),
        totalCharges: parseMoney(row['Total Charges'] || row['total charges']),
        voiceUsage: parseFloat2(row['Voice Plan Usage'] || row['voice plan usage']),
        messagingUsage: parseFloat2(row['Messaging Usage'] || row['messaging usage']),
        dataUsageKB: parseFloat2(row['Data Usage (KB)'] || row['data usage (kb)']),
        dataUsageMB: parseFloat2(row['Data Usage (MB)'] || row['data usage (mb)']),
        dataUsageGB: parseFloat2(row['Data Usage (GB)'] || row['data usage (gb)']),
      });
    }
    return lines;
  }

  /**
   * Parse Charges Detail — individual charge items per line
   */
  function parseChargesDetail(rows) {
    const items = [];
    for (const row of rows) {
      items.push({
        ban: clean(row['Account Number'] || row['account number']),
        wireless: clean(row['Wireless Number'] || row['wireless number']),
        userName: clean(row['User Name'] || row['user name']),
        itemCategory: clean(row['Item Category'] || row['item category']),
        itemDescription: clean(row['Item Description'] || row['item description']),
        shareDescription: clean(row['Share Description'] || row['share description']),
        cost: parseMoney(row['Cost'] || row['cost']),
      });
    }
    return items;
  }

  /**
   * Build profiles from Verizon data (similar to AT&T buildProfiles)
   * Takes wirelessSummary lines from potentially multiple months.
   */
  function buildProfiles(wirelessLines, chargesItems, accountSummaries) {
    const profiles = {};

    // Group wireless lines by wireless number
    const byWireless = {};
    for (const line of wirelessLines) {
      if (!byWireless[line.wireless]) byWireless[line.wireless] = [];
      byWireless[line.wireless].push(line);
    }

    // Get unique BANs/periods for month tracking
    const periods = [...new Set(accountSummaries.map(a => a.billPeriod))].sort();

    for (const [wn, entries] of Object.entries(byWireless)) {
      const latest = entries[entries.length - 1];

      // Sum usage across all months
      const totalGB = entries.reduce((s, e) => s + e.dataUsageGB, 0);
      const totalMin = entries.reduce((s, e) => s + e.voiceUsage, 0);
      const totalMsg = entries.reduce((s, e) => s + e.messagingUsage, 0);

      // MRC = average total charges across months
      const totalChargesSum = entries.reduce((s, e) => s + e.totalCharges, 0);
      const numMonths = Math.max(entries.length, 1);
      const mrc = totalChargesSum / numMonths;

      // Zero usage check
      const deviceType = latest.deviceType;
      let zeroUsage;
      if (['Tablet', 'Hotspot'].includes(deviceType)) {
        zeroUsage = totalGB === 0;
      } else {
        zeroUsage = totalGB === 0 && totalMin === 0 && totalMsg === 0;
      }

      profiles[wn] = {
        wireless: wn,
        userName: latest.userName,
        ban: latest.ban,
        costCenter: latest.costCenter,
        status: 'Active',
        deviceType,
        ratePlan: latest.callingPlan,
        mrc,

        // Charges
        latestMonthly: latest.monthlyCharges,
        latestTotal: latest.totalCharges,
        latestTaxes: latest.taxes,
        latestFees: latest.surcharges,
        equipmentCharges: latest.equipmentCharges,
        usagePurchaseCharges: latest.usagePurchaseCharges,

        // Usage (90-day totals)
        gbTotal: totalGB,
        gbAvg: totalGB / numMonths,
        minTotal: totalMin,
        minAvg: totalMin / numMonths,
        msgTotal: totalMsg,
        msgAvg: totalMsg / numMonths,
        zeroUsage,

        // Placeholders for contract info (from eligibility if provided)
        contractEnd: '',
        contractEndDate: null,
        hasActiveContract: false,
        monthlyInstallment: 0,
        remainingMonths: 0,
        etf: 0,

        doNotCancel: false,
        monthCount: numMonths,
      };
    }

    // Parse device payments from charges detail
    if (chargesItems && chargesItems.length > 0) {
      for (const item of chargesItems) {
        if (!item.wireless || !profiles[item.wireless]) continue;
        const desc = item.itemDescription.toLowerCase();

        if (desc.includes('device payment agreement')) {
          profiles[item.wireless].hasActiveContract = true;
          profiles[item.wireless].monthlyInstallment += item.cost;
          // Extract payment progress "X of Y"
          const match = item.itemDescription.match(/(\d+)\s+of\s+(\d+)/);
          if (match) {
            profiles[item.wireless].dpaProgress = `${match[1]} of ${match[2]}`;
            profiles[item.wireless].remainingMonths = parseInt(match[2]) - parseInt(match[1]);
          }
        }
        if (desc.includes('promo credit') || desc.includes('trade-in')) {
          profiles[item.wireless].promoCredit = (profiles[item.wireless].promoCredit || 0) + item.cost;
        }
      }
    }

    return {
      profiles,
      meta: {
        carrier: 'verizon',
        accountSummaries,
        billingPeriods: periods,
        totalLines: Object.keys(profiles).length,
      }
    };
  }

  /**
   * Main parse function. Takes arrays of Papa Parse results for each file type.
   */
  function parse(files) {
    let accountSummaries = [];
    let wirelessLines = [];
    let chargesItems = [];

    for (const { type, rows } of files) {
      switch (type) {
        case 'accountSummary':
          accountSummaries = parseAccountSummary(rows);
          break;
        case 'wirelessSummary':
          wirelessLines = parseWirelessSummary(rows);
          break;
        case 'chargesDetail':
          chargesItems = parseChargesDetail(rows);
          break;
        // usageDetail not needed for standard audit
      }
    }

    return buildProfiles(wirelessLines, chargesItems, accountSummaries);
  }

  return {
    detectFileType,
    parse,
    parseAccountSummary,
    parseWirelessSummary,
    parseChargesDetail,
    buildProfiles,
    classifyDevice,
  };
})();
