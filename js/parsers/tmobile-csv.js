/**
 * T-Mobile Business CSV Parser
 * Placeholder — needs sample data from Stephen for exact column mapping.
 * Structure mirrors AT&T/Verizon parsers for consistency.
 */

window.TMobileParser = (function () {

  function detectFileType(headers) {
    const h = headers.map(c => c.toLowerCase().trim());
    // T-Mobile exports typically have these markers
    if (h.some(c => c.includes('subscriber number') || c.includes('mobile number')) &&
        h.some(c => c.includes('rate plan') || c.includes('plan name'))) {
      return 'usage';
    }
    if (h.some(c => c.includes('equipment installment') || c.includes('eip'))) {
      return 'device';
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

  function clean(val) {
    return String(val || '').trim().replace(/^"|"$/g, '');
  }

  /**
   * Parse T-Mobile usage CSV.
   * Column mapping will be refined once we have sample data.
   * For now, tries common T-Mobile column names.
   */
  function parseUsage(rows) {
    const lines = [];
    if (rows.length === 0) return lines;

    const headers = Object.keys(rows[0]);
    // Try to find columns flexibly
    const find = (candidates) => {
      for (const c of candidates) {
        const found = headers.find(h => h.toLowerCase().trim().includes(c));
        if (found) return found;
      }
      return null;
    };

    const colWireless = find(['subscriber number', 'mobile number', 'phone number', 'wireless']);
    const colName = find(['subscriber name', 'user name', 'name']);
    const colPlan = find(['rate plan', 'plan name', 'plan']);
    const colCharges = find(['total charges', 'monthly charges', 'charges']);
    const colData = find(['data usage', 'data (gb)', 'data gb']);
    const colVoice = find(['voice usage', 'voice minutes', 'minutes']);
    const colMessages = find(['message usage', 'messages', 'sms']);
    const colBAN = find(['account number', 'ban', 'account']);

    for (const row of rows) {
      const wireless = clean(row[colWireless]);
      if (!wireless || wireless.length < 7) continue;

      lines.push({
        wireless,
        userName: clean(row[colName]),
        ratePlan: clean(row[colPlan]),
        ban: clean(row[colBAN]),
        totalCharges: parseMoney(row[colCharges]),
        dataUsageGB: parseFloat(clean(row[colData])) || 0,
        voiceUsage: parseFloat(clean(row[colVoice])) || 0,
        messagingUsage: parseFloat(clean(row[colMessages])) || 0,
        deviceType: 'Smartphone', // Default — refine with sample data
      });
    }

    return lines;
  }

  /**
   * Build profiles from T-Mobile data
   */
  function buildProfiles(usageLines) {
    const profiles = {};

    for (const line of usageLines) {
      if (!profiles[line.wireless]) {
        profiles[line.wireless] = {
          wireless: line.wireless,
          userName: line.userName,
          ban: line.ban,
          status: 'Active',
          deviceType: line.deviceType,
          ratePlan: line.ratePlan,
          mrc: line.totalCharges,
          latestMonthly: line.totalCharges,
          latestTotal: line.totalCharges,
          latestTaxes: 0,
          latestFees: 0,
          gbTotal: line.dataUsageGB,
          gbAvg: line.dataUsageGB,
          minTotal: line.voiceUsage,
          minAvg: line.voiceUsage,
          msgTotal: line.messagingUsage,
          msgAvg: line.messagingUsage,
          zeroUsage: line.dataUsageGB === 0 && line.voiceUsage === 0 && line.messagingUsage === 0,
          contractEnd: '',
          contractEndDate: null,
          hasActiveContract: false,
          monthlyInstallment: 0,
          remainingMonths: 0,
          etf: 0,
          doNotCancel: false,
          monthCount: 1,
        };
      }
    }

    return {
      profiles,
      meta: {
        carrier: 'tmobile',
        totalLines: Object.keys(profiles).length,
        billingPeriods: [],
        note: 'T-Mobile parser uses placeholder column mapping. Provide sample export to refine.',
      }
    };
  }

  function parse(usageRows) {
    const usageLines = parseUsage(usageRows);
    return buildProfiles(usageLines);
  }

  return { detectFileType, parse, parseUsage, buildProfiles };
})();
