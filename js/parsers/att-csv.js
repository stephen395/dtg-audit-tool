/**
 * AT&T Premier CSV Parser
 * Parses "All Wireless Charges and Usage" and "Upgrade Eligibility" CSV exports.
 * Ported from att_audit.py
 */

window.ATTParser = (function () {
  const SUSPENSION_FEE = 10.00;

  function parseMoney(val) {
    if (val == null || val === '') return 0;
    let s = String(val).trim();
    // Accounting-style negatives use parens: (7.23) -> -7.23. A leading "-"
    // already makes parseFloat return a negative, so do NOT flag those as
    // "negative" too — that would flip the sign twice and turn -7.23 into 7.23.
    const parensNegative = s.startsWith('(') && s.endsWith(')');
    s = s.replace(/[$,()]/g, '').trim();
    const v = parseFloat(s);
    if (isNaN(v)) return 0;
    return parensNegative ? -Math.abs(v) : v;
  }

  function parseInt2(val) {
    if (val == null || val === '') return 0;
    const s = String(val).trim().replace(/,/g, '');
    const v = parseInt(s, 10);
    return isNaN(v) ? 0 : v;
  }

  function parseDate(val) {
    if (!val || val === 'nan' || val === 'NaN') return null;
    const s = String(val).trim().replace(/"/g, '');
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  function cleanCol(str) {
    return String(str || '').trim().replace(/^"|"$/g, '');
  }

  /**
   * Detect if a CSV is the billing/usage report or the contract/eligibility report.
   * Returns 'billing' | 'contract' | null
   */
  function detectFileType(headers) {
    const h = headers.map(c => c.toLowerCase());
    if (h.some(c => c.includes('total current charges') || c.includes('total kb usage'))) {
      return 'billing';
    }
    if (h.some(c => c.includes('contract type') || c.includes('upgrade eligibility') || c.includes('contract end date'))) {
      return 'contract';
    }
    // Check for wireless number + status combo (AT&T eligibility)
    if (h.includes('wireless number') && h.some(c => c.includes('status'))) {
      return 'contract';
    }
    return null;
  }

  /**
   * Parse billing CSV data (Papa Parse result rows)
   */
  function parseBilling(rows) {
    const lines = [];
    const colMap = {};

    // Map flexible column names
    const mappings = {
      'wireless': ['wireless number and descriptions', 'wireless number', 'wireless'],
      'user_name': ['user name'],
      'rate_code': ['rate code'],
      'rate_plan': ['rate plan name', 'rate plan'],
      'cycle_date': ['market cycle end date', 'cycle date', 'bill date'],
      'total_current': ['total current charges'],
      'monthly_charges': ['total monthly charges', 'monthly charges'],
      'activity': ['total activity since last bill', 'activity charges'],
      'taxes': ['total taxes'],
      'fees': ['total company fees and surcharges', 'fees and surcharges'],
      'kb_usage': ['total kb usage', 'data usage (kb)'],
      'min_usage': ['total minutes usage', 'minutes usage'],
      'msg_usage': ['total messages', 'messages'],
      'adjustments': ['total adjustments'],
      'account_number': ['account number', 'ban'],
      'account_name': ['billing account name', 'account name'],
      'foundation_account': ['foundation account', 'fan'],
    };

    if (rows.length === 0) return { lines: [], meta: {} };

    // Build column map from first row's keys
    const headers = Object.keys(rows[0]);
    for (const [field, candidates] of Object.entries(mappings)) {
      for (const candidate of candidates) {
        const found = headers.find(h => h.toLowerCase().trim().replace(/"/g, '') === candidate);
        if (found) { colMap[field] = found; break; }
      }
    }

    // Extract metadata from first row
    const meta = {
      accountNumber: cleanCol(rows[0][colMap.account_number]),
      accountName: cleanCol(rows[0][colMap.account_name]),
      foundationAccount: cleanCol(rows[0][colMap.foundation_account]),
    };

    // ── Bill-level totals (per cycle), computed across ALL rows before filtering.
    // The carrier's "Current Charges" on the bill is the sum of EVERY row in the
    // export — phone lines plus Group-level rows and empty-wireless adjustment
    // rows (shared pool allocations, account-wide credits). If we only summed
    // phone rows we'd miss those, and the dashboard total wouldn't match the
    // real bill. Keyed by cycle date so downstream code can pick the cycle.
    const billByCycle = {};
    const bump = (cycle, field, val) => {
      if (!billByCycle[cycle]) {
        billByCycle[cycle] = { totalCurrent: 0, monthlyCharges: 0, activity: 0, taxes: 0, fees: 0 };
      }
      billByCycle[cycle][field] += val;
    };
    for (const row of rows) {
      const cycle = cleanCol(row[colMap.cycle_date]);
      if (!cycle || cycle === 'nan') continue;
      bump(cycle, 'totalCurrent',   parseMoney(row[colMap.total_current]));
      bump(cycle, 'monthlyCharges', parseMoney(row[colMap.monthly_charges]));
      bump(cycle, 'activity',       parseMoney(row[colMap.activity]));
      bump(cycle, 'taxes',          parseMoney(row[colMap.taxes]));
      bump(cycle, 'fees',           parseMoney(row[colMap.fees]));
    }
    meta.billByCycle = billByCycle;

    // Parse each row
    for (const row of rows) {
      const wireless = cleanCol(row[colMap.wireless]);
      if (!wireless || wireless === 'nan' || wireless.length < 7) continue;
      // Skip non-phone entries: Group IDs (start with G), account-level rows (0), discount lines
      if (/^[A-Za-z]/.test(wireless)) continue;
      if (wireless === '0') continue;
      const ratePlan = cleanCol(row[colMap.rate_plan]);
      if (ratePlan === 'NO CURRENT RATE PLAN' || ratePlan === 'NORATEPLAN') continue;

      lines.push({
        wireless,
        userName: cleanCol(row[colMap.user_name]),
        rateCode: cleanCol(row[colMap.rate_code]),
        ratePlan: cleanCol(row[colMap.rate_plan]),
        cycleDate: cleanCol(row[colMap.cycle_date]),
        totalCurrent: parseMoney(row[colMap.total_current]),
        monthlyCharges: parseMoney(row[colMap.monthly_charges]),
        activity: parseMoney(row[colMap.activity]),
        taxes: parseMoney(row[colMap.taxes]),
        fees: parseMoney(row[colMap.fees]),
        kbUsage: parseInt2(row[colMap.kb_usage]),
        minUsage: parseInt2(row[colMap.min_usage]),
        msgUsage: parseInt2(row[colMap.msg_usage]),
        adjustments: parseMoney(row[colMap.adjustments]),
      });
    }

    // Get billing cycles
    const cycles = [...new Set(lines.map(l => l.cycleDate))].filter(Boolean).sort();
    meta.billingCycles = cycles;

    return { lines, meta };
  }

  /**
   * Parse contract/eligibility CSV data
   */
  function parseContract(rows) {
    const lines = [];
    const colMap = {};

    const mappings = {
      'wireless': ['wireless number', 'wireless'],
      'user_name': ['wireless user name', 'user name'],
      'status': ['status'],
      'monthly_installment': ['monthly installment'],
      'contract_type': ['contract type'],
      'contract_start': ['contract start date'],
      'contract_end': ['contract end date'],
      'contract_term': ['contract term'],
      'contract_status': ['contract status'],
      'device_type': ['device type'],
      'device_make': ['device make'],
      'device_model': ['device model'],
      'device_imei': ['device imei', 'imei'],
      'activation_date': ['activation date'],
      'last_upgrade_date': ['last upgrade date', 'upgrade date'],
      'iphone_upgrade': ['iphone upgrade date'],
      'smartphone_upgrade': ['smartphone upgrade date'],
    };

    if (rows.length === 0) return lines;

    const headers = Object.keys(rows[0]);
    for (const [field, candidates] of Object.entries(mappings)) {
      for (const candidate of candidates) {
        const found = headers.find(h => h.toLowerCase().trim().replace(/"/g, '') === candidate);
        if (found) { colMap[field] = found; break; }
      }
    }

    for (const row of rows) {
      const wireless = cleanCol(row[colMap.wireless]);
      if (!wireless || wireless === 'nan' || wireless.length < 7) continue;

      const contractEnd = cleanCol(row[colMap.contract_end]);
      const endDate = parseDate(contractEnd);
      const today = new Date();
      const remainingDays = endDate ? Math.max(0, (endDate - today) / (1000 * 60 * 60 * 24)) : 0;
      const remainingMonths = Math.floor(remainingDays / 30);

      const contractType = cleanCol(row[colMap.contract_type]);
      const contractStatus = cleanCol(row[colMap.contract_status]);
      const installment = parseMoney(row[colMap.monthly_installment]);
      const hasActiveContract = contractType === 'Installment' && contractStatus === 'Active';

      lines.push({
        wireless,
        userName: cleanCol(row[colMap.user_name]),
        status: cleanCol(row[colMap.status]),
        monthlyInstallment: installment,
        contractType,
        contractStart: cleanCol(row[colMap.contract_start]),
        contractEnd,
        contractEndDate: endDate,
        contractTerm: parseInt2(row[colMap.contract_term]),
        contractStatus,
        deviceType: cleanCol(row[colMap.device_type]),
        deviceMake: cleanCol(row[colMap.device_make]),
        deviceModel: cleanCol(row[colMap.device_model]),
        deviceIMEI: cleanCol(row[colMap.device_imei]),
        activationDate: cleanCol(row[colMap.activation_date]),
        lastUpgradeDate: cleanCol(row[colMap.last_upgrade_date]),
        remainingMonths,
        hasActiveContract,
        etf: hasActiveContract ? installment * remainingMonths : 0,
      });
    }

    return lines;
  }

  /**
   * Build comprehensive line profiles by merging billing + contract data.
   * Returns { profiles: {}, meta: {} }
   */
  function buildProfiles(billingData, contractLines) {
    const { lines: billingLines, meta } = billingData;
    const profiles = {};
    const today = new Date();

    // Index contract data by wireless
    const contractMap = {};
    for (const c of contractLines) {
      contractMap[c.wireless] = c;
    }

    // Device report (contract file) is the source of truth for active lines
    const realLines = new Set(contractLines.map(c => c.wireless));

    // If we have a device report, use it as the primary line list
    // Lines in billing but NOT in device report are likely cancelled/removed
    const allWireless = realLines.size > 0
      ? new Set([...realLines, ...billingLines.filter(l => realLines.has(l.wireless)).map(l => l.wireless)])
      : new Set(billingLines.map(l => l.wireless));

    // Detect discount-only lines
    const discountLines = new Set();
    for (const l of billingLines) {
      if (l.ratePlan && l.ratePlan.toLowerCase().includes('discount for plan savings')) {
        discountLines.add(l.wireless);
      }
    }

    // Count billing cycles per wireless
    const lineCycleCounts = {};
    for (const l of billingLines) {
      lineCycleCounts[l.wireless] = (lineCycleCounts[l.wireless] || new Set()).add(l.cycleDate);
    }

    for (const wn of allWireless) {
      // Skip discount-only lines not in contract
      if (discountLines.has(wn) && !realLines.has(wn)) continue;

      const contract = contractMap[wn] || {};
      const bRows = billingLines.filter(l => l.wireless === wn);

      // Build billing cycles
      const billingCycles = {};
      for (const row of bRows) {
        billingCycles[row.cycleDate] = {
          rateCode: row.rateCode,
          ratePlan: row.ratePlan,
          totalCurrent: row.totalCurrent,
          monthlyCharges: row.monthlyCharges,
          activity: row.activity,
          taxes: row.taxes,
          fees: row.fees,
          kbUsage: row.kbUsage,
          minUsage: row.minUsage,
          msgUsage: row.msgUsage,
          adjustments: row.adjustments,
        };
      }

      // Latest cycle info
      const cycleKeys = Object.keys(billingCycles).sort();
      const latest = cycleKeys.length > 0 ? billingCycles[cycleKeys[cycleKeys.length - 1]] : {};

      // 90-day usage totals
      const totalKb = Object.values(billingCycles).reduce((s, c) => s + (c.kbUsage || 0), 0);
      const totalMin = Object.values(billingCycles).reduce((s, c) => s + (c.minUsage || 0), 0);
      const totalMsg = Object.values(billingCycles).reduce((s, c) => s + (c.msgUsage || 0), 0);

      // Zero usage check (device type aware)
      const deviceType = contract.deviceType || 'Unknown';
      let zeroUsage;
      if (['Connected Device', 'Tablet'].includes(deviceType)) {
        zeroUsage = totalKb === 0;
      } else {
        zeroUsage = totalKb === 0 && totalMin === 0 && totalMsg === 0;
      }

      // MRC = Total Current Charges from the FIRST (earliest) billing cycle.
      // Matches the convention Stephen's reference audits use — represents the
      // starting monthly charge for the line, including any activity that hit
      // in that cycle. Falls back to 0 if no cycles were parsed.
      const earliest = cycleKeys.length > 0 ? billingCycles[cycleKeys[0]] : {};
      const mrc = earliest.totalCurrent || 0;
      const numCycles = Math.max(cycleKeys.length, 1);

      // Do not cancel flag
      const userName = contract.userName || (bRows[0] && bRows[0].userName) || 'Unknown';
      const doNotCancel = userName.toUpperCase().includes('DO NOT CANCEL') ||
                          userName.toUpperCase().includes('CAMERA');

      profiles[wn] = {
        wireless: wn,
        userName,
        status: contract.status || 'Active',
        deviceType,
        deviceMake: contract.deviceMake || '',
        deviceModel: contract.deviceModel || '',
        deviceIMEI: contract.deviceIMEI || '',
        lastUpgradeDate: contract.lastUpgradeDate || '',
        ratePlan: latest.ratePlan || contract.ratePlan || 'Unknown',
        rateCode: latest.rateCode || '',
        billingCycles,
        cycleCount: cycleKeys.length,

        // Charges
        latestMonthly: latest.monthlyCharges || 0,
        latestTotal: latest.totalCurrent || 0,
        latestActivity: latest.activity || 0,
        latestTaxes: latest.taxes || 0,
        latestFees: latest.fees || 0,
        mrc,

        // Usage
        totalKb90d: totalKb,
        totalMin90d: totalMin,
        totalMsg90d: totalMsg,
        gbTotal: totalKb / 1024 / 1024,
        gbAvg: (totalKb / 1024 / 1024) / Math.max(numCycles, 1),
        minAvg: totalMin / Math.max(numCycles, 1),
        msgAvg: totalMsg / Math.max(numCycles, 1),
        zeroUsage,

        // Contract
        contractType: contract.contractType || 'None',
        contractEnd: contract.contractEnd || '',
        contractEndDate: contract.contractEndDate || null,
        contractStatus: contract.contractStatus || '',
        monthlyInstallment: contract.monthlyInstallment || 0,
        remainingMonths: contract.remainingMonths || 0,
        hasActiveContract: contract.hasActiveContract || false,
        etf: contract.etf || 0,
        activationDate: contract.activationDate || '',

        doNotCancel,
      };
    }

    return { profiles, meta };
  }

  /**
   * Main parse function. Takes Papa Parse results for billing + optional contract.
   * Returns { profiles, meta }
   */
  function parse(billingRows, contractRows) {
    const billingData = parseBilling(billingRows);
    const contractLines = contractRows ? parseContract(contractRows) : [];
    return buildProfiles(billingData, contractLines);
  }

  return {
    detectFileType,
    parse,
    parseBilling,
    parseContract,
    buildProfiles,
    SUSPENSION_FEE,
  };
})();
