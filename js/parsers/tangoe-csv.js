/**
 * Tangoe TCC CSV Parser
 * Parses Tangoe "Carrier Billing / Inventory Snapshot" CSV exports from Tangoe TCC portal.
 *
 * Supports two column naming styles exported by Tangoe:
 *   Prefixed:  "Inventory Snapshot International Number", "Line Bill Rebilled Primary Plan MRC"
 *   Bare:      "International Number", "Bill Cycle End Date", "Total Rebilled Charges"
 *
 * Auto-detected by presence of "Inventory Snapshot" prefix OR
 * "International Number" + billing marker columns.
 *
 * NOTE: Tangoe billing exports have charges only — no GB/minutes/messages.
 *       zeroUsage is always false (cannot determine without carrier usage data).
 */

window.TangoeParser = (function () {

  /**
   * Detect if a set of CSV headers belongs to a Tangoe TCC export.
   * Matches prefixed style ("Inventory Snapshot ...") or bare style
   * ("International Number" + billing column markers).
   */
  function detect(headers) {
    var h = headers.map(function(c) { return c.toLowerCase().trim(); });
    // Prefixed style
    if (h.some(function(c) { return c.startsWith('inventory snapshot'); })) return true;
    // Bare style: International Number + at least one billing/Tangoe marker
    var hasIntlNum = h.some(function(c) { return c === 'international number'; });
    var hasBillingMarker = h.some(function(c) {
      return c.includes('rebilled') || c === 'bill cycle end date' ||
             c === 'carrier account' || c === 'bill total charges';
    });
    return hasIntlNum && hasBillingMarker;
  }

  function parseMoney(val) {
    if (val == null || val === '') return 0;
    var s = String(val).trim();
    var negative = s.startsWith('(') || s.startsWith('-');
    s = s.replace(/[$,()]/g, '').trim();
    var v = parseFloat(s);
    if (isNaN(v)) return 0;
    return negative ? -v : v;
  }

  function cleanCol(str) {
    return String(str || '').trim().replace(/^"|"$/g, '');
  }

  /**
   * Normalize Tangoe international phone format (+1 XXX-XXX-XXXX) to (XXX) XXX-XXXX.
   * Also handles other common formats gracefully.
   */
  function normalizePhone(raw) {
    if (!raw) return '';
    var s = String(raw).trim();
    // Strip country code prefix (+1, 1)
    s = s.replace(/^\+?1[\s-]?/, '');
    // Extract digits only
    var digits = s.replace(/\D/g, '');
    if (digits.length === 10) {
      return '(' + digits.substring(0, 3) + ') ' + digits.substring(3, 6) + '-' + digits.substring(6);
    }
    // If we can't normalize, return cleaned original
    return s;
  }

  /**
   * Build column map from headers.
   * Each field lists candidates in priority order (prefixed first, bare fallbacks after).
   */
  function buildColMap(headers) {
    var mappings = {
      'ban':              ['inventory snapshot carrier account',     'carrier account', 'account number', 'ban'],
      'phone':            ['inventory snapshot international number', 'international number', 'phone number', 'wireless number'],
      'carrier':          ['inventory snapshot carrier',             'carrier'],
      'billCycleEnd':     ['inventory snapshot bill cycle end date', 'bill cycle end date', 'cycle end date', 'billing date'],
      'userName':         ['inventory snapshot person',              'person', 'user name', 'owner'],
      'carrierLabel':     ['inventory snapshot carrier label',       'carrier label', 'label'],
      'costCenter':       ['inventory snapshot cost center',         'cost center', 'cost center name'],
      'group':            ['inventory snapshot group',               'group', 'department'],
      'ratePlan':         ['inventory snapshot plan',                'plan', 'rate plan', 'plan name'],
      'dataPlan':         ['inventory snapshot data plan name',      'data plan name', 'data plan'],
      'deviceType':       ['ref device product category',            'product category', 'device category', 'device type'],
      'platform':         ['ref device platform',                    'platform'],
      'deviceModel':      ['inventory snapshot ref device',          'ref device', 'device model', 'device'],
      'status':           ['status',                                 'line status'],
      'totalCharges':     ['line bill total rebilled charges',       'total rebilled charges', 'total charges', 'bill total charges', 'total billed charges'],
      'planMRC':          ['line bill rebilled primary plan mrc',    'rebilled primary plan mrc', 'primary plan mrc', 'plan mrc'],
      'dataMRC':          ['line bill carrier data mrc',             'carrier data mrc', 'data mrc'],
      'textMRC':          ['line bill carrier text mrc',             'carrier text mrc', 'text mrc'],
      'featureCharges':   ['line bill carrier feature mrc',          'carrier feature mrc', 'feature mrc', 'feature charges'],
      'equipmentCharges': ['line bill equipment charges',            'equipment charges', 'equipment'],
      'taxes':            ['line bill taxes',                        'taxes'],
      'surcharges':       ['line bill surcharges',                   'surcharges', 'fees and surcharges'],
      'dataRoaming':      ['line bill data roaming charges',         'data roaming charges', 'data roaming'],
      'voiceRoaming':     ['line bill voice roaming charges',        'voice roaming charges', 'voice roaming']
    };

    var colMap = {};
    for (var field in mappings) {
      var candidates = mappings[field];
      for (var i = 0; i < candidates.length; i++) {
        var candidate = candidates[i];
        var found = headers.find(function(h) { return h.toLowerCase().trim() === candidate; });
        if (found) { colMap[field] = found; break; }
      }
    }
    return colMap;
  }

  /**
   * Parse Tangoe CSV rows (Papa Parse result) into the internal profile structure.
   * Returns { profiles: {}, meta: {} }
   */
  function parse(rows) {
    if (!rows || rows.length === 0) {
      return { profiles: {}, meta: { source: 'tangoe' } };
    }

    var headers = Object.keys(rows[0]);
    var colMap = buildColMap(headers);

    // Collect per-line data (may have multiple rows per phone when report spans cycles)
    var lineMap = {};
    var accountNumber = '';
    var cycleSet = {};

    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var rawPhone = cleanCol(row[colMap.phone]);
      if (!rawPhone || rawPhone.length < 7) continue;

      var phone = normalizePhone(rawPhone);
      if (!phone) continue;

      // Skip aggregate/total rows
      if (/^total|^subtotal|^grand/i.test(phone)) continue;

      // Grab BAN from first valid row
      if (!accountNumber && colMap.ban) {
        accountNumber = cleanCol(row[colMap.ban]);
      }

      var billCycleEnd = cleanCol(row[colMap.billCycleEnd]) || '';
      if (billCycleEnd) cycleSet[billCycleEnd] = true;

      if (!lineMap[phone]) {
        lineMap[phone] = {
          wireless: phone,
          userName: cleanCol(row[colMap.userName]) || cleanCol(row[colMap.carrierLabel]) || 'Unknown',
          carrier: cleanCol(row[colMap.carrier]) || '',
          carrierLabel: cleanCol(row[colMap.carrierLabel]) || '',
          costCenter: cleanCol(row[colMap.costCenter]) || '',
          group: cleanCol(row[colMap.group]) || '',
          ratePlan: cleanCol(row[colMap.ratePlan]) || cleanCol(row[colMap.dataPlan]) || 'Unknown',
          deviceType: cleanCol(row[colMap.deviceType]) || 'Unknown',
          platform: cleanCol(row[colMap.platform]) || '',
          deviceModel: cleanCol(row[colMap.deviceModel]) || '',
          status: cleanCol(row[colMap.status]) || 'Active',
          totalCharges: 0,
          planMRC: 0,
          featureCharges: 0,
          equipmentCharges: 0,
          taxes: 0,
          surcharges: 0,
          rowCount: 0,
          latestCycle: billCycleEnd
        };
      }

      var line = lineMap[phone];
      line.totalCharges += parseMoney(row[colMap.totalCharges]);
      line.planMRC += parseMoney(row[colMap.planMRC]);
      line.featureCharges += parseMoney(row[colMap.featureCharges]);
      line.equipmentCharges += parseMoney(row[colMap.equipmentCharges]);
      line.taxes += parseMoney(row[colMap.taxes]);
      line.surcharges += parseMoney(row[colMap.surcharges]);
      line.rowCount++;

      // Track the most recent cycle's data for "latest" fields
      if (billCycleEnd >= line.latestCycle) {
        line.latestCycle = billCycleEnd;
        if (cleanCol(row[colMap.userName])) line.userName = cleanCol(row[colMap.userName]);
        else if (cleanCol(row[colMap.carrierLabel])) line.userName = cleanCol(row[colMap.carrierLabel]);
        if (cleanCol(row[colMap.status])) line.status = cleanCol(row[colMap.status]);
        if (cleanCol(row[colMap.ratePlan])) line.ratePlan = cleanCol(row[colMap.ratePlan]);
        if (cleanCol(row[colMap.deviceModel])) line.deviceModel = cleanCol(row[colMap.deviceModel]);
        if (cleanCol(row[colMap.deviceType])) line.deviceType = cleanCol(row[colMap.deviceType]);
        line.latestTotal = parseMoney(row[colMap.totalCharges]);
        line.latestPlanMRC = parseMoney(row[colMap.planMRC]);
        line.latestTaxes = parseMoney(row[colMap.taxes]);
        line.latestSurcharges = parseMoney(row[colMap.surcharges]);
      }
    }

    var billingCycles = Object.keys(cycleSet).sort();

    // Build profiles in the internal format expected by analyzers
    var profiles = {};
    for (var phone in lineMap) {
      var line = lineMap[phone];

      // MRC = average monthly charge across all billing cycles
      var numCycles = Math.max(line.rowCount, 1);
      var mrc = line.totalCharges / numCycles;

      // "Latest" cycle values for display (fall back to averages if not tracked)
      var latestTotal   = line.latestTotal   !== undefined ? line.latestTotal   : line.totalCharges;
      var latestPlanMRC = line.latestPlanMRC !== undefined ? line.latestPlanMRC : line.planMRC;
      var latestTaxes   = line.latestTaxes   !== undefined ? line.latestTaxes   : line.taxes;
      var latestFees    = line.latestSurcharges !== undefined ? line.latestSurcharges : line.surcharges;

      // Normalize device type from Tangoe product category string
      var dt = line.deviceType.toLowerCase();
      var deviceType = 'Smartphone';
      if (dt.includes('tablet') || dt.includes('ipad') || dt.includes('galaxy tab')) deviceType = 'Tablet';
      else if (dt.includes('watch') || dt.includes('wearable') || dt.includes('smartwatch')) deviceType = 'Watch';
      else if (dt.includes('hotspot') || dt.includes('mifi') || dt.includes('jetpack') || dt.includes('router') || dt.includes('data card')) deviceType = 'Hotspot';
      else if (dt.includes('connected') || dt.includes('iot') || dt.includes('m2m') || dt.includes('machine')) deviceType = 'Connected Device';

      profiles[phone] = {
        wireless: phone,
        userName: line.userName,
        status: line.status || 'Active',
        deviceType: deviceType,
        deviceMake: line.platform,
        deviceModel: line.deviceModel,
        ratePlan: line.ratePlan,
        rateCode: '',
        billingCycles: {},
        cycleCount: numCycles,

        // Charges
        latestMonthly: latestPlanMRC,
        latestTotal: latestTotal,
        latestTaxes: latestTaxes,
        latestFees: latestFees,
        mrc: mrc,

        // Usage — Tangoe billing exports do not contain usage data
        totalKb90d: 0,
        totalMin90d: 0,
        totalMsg90d: 0,
        gbTotal: 0,
        gbAvg: 0,
        minTotal: 0,
        minAvg: 0,
        msgTotal: 0,
        msgAvg: 0,
        noUsageData: true,
        zeroUsage: false, // Cannot determine without carrier-level usage data

        // Contract — not present in Tangoe billing report
        contractType: 'None',
        contractEnd: '',
        contractEndDate: null,
        contractStatus: '',
        monthlyInstallment: line.equipmentCharges,
        remainingMonths: 0,
        hasActiveContract: line.equipmentCharges > 0,
        etf: 0,
        activationDate: '',

        doNotCancel: line.userName.toUpperCase().includes('DO NOT CANCEL') ||
                     line.userName.toUpperCase().includes('CAMERA'),

        // Tangoe-specific extras
        carrier: line.carrier,
        carrierLabel: line.carrierLabel,
        costCenter: line.costCenter,
        group: line.group,
        featureCharges: line.featureCharges,
        equipmentCharges: line.equipmentCharges,
        taxes: line.taxes,
        surcharges: line.surcharges
      };
    }

    var meta = {
      source: 'tangoe',
      accountNumber: accountNumber,
      accountName: '',
      foundationAccount: '',
      billingCycles: billingCycles,
      tangoeNote: 'Tangoe export: charges only — no usage data (GB/min/msg). Zero-usage tab unavailable.'
    };

    return { profiles: profiles, meta: meta };
  }

  return {
    detect: detect,
    isTangoeFormat: detect, // alias
    parse: parse,
    normalizePhone: normalizePhone
  };
})();
