/**
 * Verizon ECPD/MyVerizon TXT Parser
 *
 * Parses tab-delimited TXT exports from Verizon's MyVerizon "Raw Data Download"
 * (the same files extracted from monthly zips by verizon-zip.js).
 *
 * Recognises 4 file kinds:
 *   - AccountSummary           — BAN-level totals (one row per sub-account per cycle)
 *   - WirelessSummary          — line-level summary (the audit's primary source)
 *   - ChargesDetail            — itemised charges per line (used to detect device payments)
 *   - UsageDetail              — call-by-call records (not consumed here)
 *
 * Multi-account behaviour:
 *   Verizon master BANs (e.g. 642350544) split into many sub-accounts that look
 *   like 642350544-00001, -00002, etc. Each sub-account has its own bill. We
 *   stamp the sub-account string on every line and surface a per-BAN summary
 *   (`meta.byBan`) so the dashboard can scope KPIs to a single sub-account.
 *
 *   "Dead" sub-accounts — ones with zero active wireless lines in the most
 *   recent cycle — are excluded from the result. Stephen recently consolidated
 *   to ~5 active BANs out of 15 total; this filter mirrors that reality so
 *   dormant accounts don't pollute the dashboard.
 *
 * MRC convention:
 *   MRC = the line's Total Charges in the EARLIEST cycle (matches AT&T's
 *   parser). Older versions of this file averaged across months; Stephen
 *   doesn't want averaging — it hides what the line actually starts at.
 */
window.VerizonParser = (function () {

  /**
   * Detect which Verizon file kind this is, by sniffing headers.
   * Returns 'accountSummary' | 'wirelessSummary' | 'chargesDetail' |
   *         'usageDetail' | 'upgradeEligibility' | null
   */
  function detectFileType(headers) {
    const h = headers.map(c => c.toLowerCase().trim());

    // upgradeEligibility — separate "Device Report" CSV/XLSX export from
    // MyVerizon. The "device manufacturer" + "upgrade eligibility date"
    // combo is distinctive and rules out the other 4 kinds.
    if (h.some(c => c.includes('upgrade eligibility date')) ||
        (h.some(c => c.includes('device manufacturer')) && h.some(c => c.includes('contract end date')))) {
      return 'upgradeEligibility';
    }
    // Order matters: usageDetail also has 'wireless number' but is uniquely
    // identified by per-call columns like 'origination'/'min'.
    if (h.some(c => c.includes('usage category')) && h.some(c => c.includes('origination'))) {
      return 'usageDetail';
    }
    if (h.some(c => c.includes('item category')) && h.some(c => c.includes('item description'))) {
      return 'chargesDetail';
    }
    if (h.some(c => c.includes('previous balance')) && h.some(c => c.includes('total amount due'))) {
      return 'accountSummary';
    }
    if (h.some(c => c.includes('your calling plan')) && h.some(c => c.includes('data usage'))) {
      return 'wirelessSummary';
    }
    return null;
  }

  function parseMoney(val) {
    if (val == null || val === '') return 0;
    let s = String(val).trim();
    const parensNegative = s.startsWith('(') && s.endsWith(')');
    s = s.replace(/[$,()]/g, '').trim();
    const v = parseFloat(s);
    if (isNaN(v)) return 0;
    return parensNegative ? -Math.abs(v) : v;
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
   * Parse AccountSummary TXT — one row per BAN per cycle.
   */
  function parseAccountSummary(rows) {
    const accounts = [];
    for (const row of rows) {
      const ban = clean(row['Account Number'] || row['account number']);
      if (!ban) continue;

      accounts.push({
        ban,
        billCycleDate: clean(row['Bill Cycle Date'] || row['bill cycle date']),
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
        usagePurchaseCharges: parseMoney(
          row['Usage and Purchase Charges'] || row['usage and purchase charges']
        ),
        accountChargesAndCredits: parseMoney(
          row['Account Charges and Credits'] || row['account charges and credits']
        ),
        totalCurrentCharges: parseMoney(row['Total Current Charges'] || row['total current charges']),
        totalAmountDue: parseMoney(row['Total Amount Due'] || row['total amount due']),
      });
    }
    return accounts;
  }

  /**
   * Parse Account & Wireless Summary — one row per wireless line per cycle.
   * Filters out the "N/A" wireless rows that represent BAN-level adjustments.
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
        billCycleDate: clean(row['Bill Cycle Date'] || row['bill cycle date']),
        billPeriod: clean(row['Bill Period'] || row['bill period']),
        userName: clean(row['User Name'] || row['user name']),
        costCenter: clean(row['Cost Center'] || row['cost center']),
        callingPlan: planName,
        deviceType: classifyDevice(planName),
        accountChargesAndCredits: parseMoney(
          row['Account Charges and Credits'] || row['account charges and credits']
        ),
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
   * Parse Verizon's Device Report / Upgrade Eligibility export. One row per
   * managed wireless line that has a registered device. Used to:
   *   1. Filter the audit's line universe — Stephen's manual workflow
   *      anchors on this report so only lines with managed devices count.
   *      Lines that bill but aren't in this file (M2M modules, FWA routers,
   *      cameras without registered IMEI) get excluded from zero-usage.
   *   2. Surface contract end dates + device info on every profile so the
   *      Zero Usage tab can show the contract column (matching the Sheet).
   */
  function parseUpgradeEligibility(rows) {
    const out = [];
    for (const row of rows) {
      const wn = clean(row['Wireless number'] || row['wireless number'] ||
                       row['Wireless Number'] || row['wireless_number']);
      if (!wn || wn === 'N/A' || wn.length < 7) continue;
      out.push({
        wireless: wn,
        ban: clean(row['Account number'] || row['Account Number'] || row['account number']),
        accountName: clean(row['Account name'] || row['account name']),
        userName: clean(row['User name'] || row['user name']),
        costCenter: clean(row['Cost center'] || row['cost center']),
        deviceId: clean(row['Current device ID - 4G only'] || row['Shipped device ID']),
        deviceMake: clean(row['Device manufacturer'] || row['device manufacturer']),
        deviceModel: clean(row['Device model'] || row['device model']),
        deviceType: clean(row['Device type'] || row['device type']),
        activationDate: clean(row['Activation date'] || row['activation date']),
        contractActivationDate: clean(row['Contract activation date']),
        contractEndDate: clean(row['Contract end date'] || row['contract end date']),
        upgradeEligibilityDate: clean(row['Upgrade eligibility date'] || row['upgrade eligibility date']),
      });
    }
    return out;
  }

  /**
   * Parse Charges Detail — itemised charges per line per cycle. We use this
   * mainly to detect Device Payment Agreement (installment) progress and
   * promo credits that don't show up in the line-summary file.
   */
  function parseChargesDetail(rows) {
    const items = [];
    for (const row of rows) {
      items.push({
        ban: clean(row['Account Number'] || row['account number']),
        wireless: clean(row['Wireless Number'] || row['wireless number']),
        billCycleDate: clean(row['Bill Cycle Date'] || row['bill cycle date']),
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
   * Parse a Verizon "Bill Cycle Date" string ("Jan 31, 2026") into a sortable
   * ISO-ish key. Falls back to the raw string if parsing fails so we never
   * lose a cycle silently.
   */
  function cycleSortKey(cycleStr) {
    const d = new Date(String(cycleStr));
    if (!isNaN(d.getTime())) {
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
             String(d.getDate()).padStart(2, '0');
    }
    return String(cycleStr || '');
  }

  /**
   * Build line profiles from the parsed file payloads.
   *
   * Profile shape mirrors what the rest of the audit pipeline (zero-usage
   * analyzer, cycle-trend analyzer, dashboard renderer) expects from AT&T:
   *   - billingCycles[cycleDate] = per-cycle row
   *   - mrc = earliest cycle's totalCharges
   *   - latestMonthly / latestTotal / etc. come from the most recent cycle
   *
   * Returns { profiles, meta } — meta.byBan is keyed by sub-account.
   */
  function buildProfiles(wirelessLines, chargesItems, accountSummaries, upgradeEligibility) {
    upgradeEligibility = upgradeEligibility || [];

    // ── Build the Upgrade Eligibility lookup ────────────────────────────────
    // When the user uploads MyVerizon's Device Report, we anchor the line
    // universe on it (matching Stephen's manual Sheet workflow). Lines that
    // bill but aren't in this file (M2M modules, FWA routers, lines without
    // registered IMEIs) get filtered out before zero-usage analysis.
    const ueByLine = {};
    for (const u of upgradeEligibility) {
      if (u.wireless) ueByLine[u.wireless] = u;
    }
    const hasUpgrade = upgradeEligibility.length > 0;

    // ── Group wireless rows by line ──────────────────────────────────────────
    const byWireless = {};
    for (const line of wirelessLines) {
      // If we have an Upgrade Eligibility report, skip lines that aren't in
      // it — they're real billing entries but not "managed phone lines" per
      // Stephen's audit conventions.
      if (hasUpgrade && !ueByLine[line.wireless]) continue;
      if (!byWireless[line.wireless]) byWireless[line.wireless] = [];
      byWireless[line.wireless].push(line);
    }
    // Sort each line's cycles chronologically so earliest/latest pick is reliable.
    for (const wn of Object.keys(byWireless)) {
      byWireless[wn].sort((a, b) => cycleSortKey(a.billCycleDate).localeCompare(cycleSortKey(b.billCycleDate)));
    }

    // ── Charges Detail index: per-line, per-cycle aggregates ─────────────────
    // Used to detect device payment agreement installments and promo credits,
    // plus the per-line Monthly Charges breakdown (MRC / credits / add-ons).
    const dpaByLineCycle = {};      // {wireless: {cycle: {installment, dpaProgress}}}
    const promoByLineCycle = {};    // {wireless: {cycle: amount}}
    // Monthly Charges breakdown — Verizon RDD's "Item Category = Monthly Charges"
    // rows tag every line by Share Description: "Plan" (the MRC), "Feature"
    // (an add-on like 5G UWB, Cloud, Detail Billing, etc.), or "NA"/blank
    // (in which case a negative cost is a recurring credit such as
    // "$10 Monthly Access Crdt 36 Mon"). Net of these three buckets must
    // match wirelessSummary's monthlyCharges per line — that's the validation.
    const monthlyByLineCycle = {};  // {wireless: {cycle: { mrcGross, mrcItems[], creditTotal, creditsItemized[], addonTotal, addonsItemized[] }}}
    if (chargesItems) {
      for (const item of chargesItems) {
        if (!item.wireless || item.wireless === 'N/A') continue;
        const desc = (item.itemDescription || '').toLowerCase();
        const cycle = item.billCycleDate;
        if (desc.includes('device payment agreement')) {
          if (!dpaByLineCycle[item.wireless]) dpaByLineCycle[item.wireless] = {};
          if (!dpaByLineCycle[item.wireless][cycle]) {
            dpaByLineCycle[item.wireless][cycle] = { installment: 0, dpaProgress: '' };
          }
          dpaByLineCycle[item.wireless][cycle].installment += item.cost;
          const m = item.itemDescription.match(/(\d+)\s+of\s+(\d+)/);
          if (m) dpaByLineCycle[item.wireless][cycle].dpaProgress = `${m[1]} of ${m[2]}`;
        }
        if (desc.includes('promo credit') || desc.includes('trade-in') || desc.includes('promotion credit')) {
          if (!promoByLineCycle[item.wireless]) promoByLineCycle[item.wireless] = {};
          promoByLineCycle[item.wireless][cycle] = (promoByLineCycle[item.wireless][cycle] || 0) + item.cost;
        }

        // Per-line Monthly Charges breakdown.
        if ((item.itemCategory || '').toLowerCase() === 'monthly charges') {
          if (!monthlyByLineCycle[item.wireless]) monthlyByLineCycle[item.wireless] = {};
          if (!monthlyByLineCycle[item.wireless][cycle]) {
            monthlyByLineCycle[item.wireless][cycle] = {
              mrcGross: 0, mrcItems: [],
              creditTotal: 0, creditsItemized: [],
              addonTotal: 0, addonsItemized: [],
            };
          }
          const bucket = monthlyByLineCycle[item.wireless][cycle];
          const tag = (item.shareDescription || '').toLowerCase();
          const lineItem = { description: (item.itemDescription || '').trim(), cost: item.cost };
          if (tag === 'plan') {
            bucket.mrcGross += item.cost;
            bucket.mrcItems.push(lineItem);
          } else if (tag === 'feature') {
            bucket.addonTotal += item.cost;
            bucket.addonsItemized.push(lineItem);
          } else if (item.cost < 0) {
            // Untagged ("NA"/blank) + negative = recurring monthly credit.
            bucket.creditTotal += item.cost;
            bucket.creditsItemized.push(lineItem);
          } else {
            // Untagged + non-negative = uncategorized monthly. Bucket as add-on
            // so the breakdown still totals to net; the line-item description
            // preserves what it actually was for the drill-down.
            bucket.addonTotal += item.cost;
            bucket.addonsItemized.push(lineItem);
          }
        }
      }
    }

    // ── Build profiles ───────────────────────────────────────────────────────
    const profiles = {};
    for (const [wn, entries] of Object.entries(byWireless)) {
      const earliest = entries[0];
      const latest = entries[entries.length - 1];

      // Per-cycle breakdown — mirrors AT&T's billingCycles shape so the trend
      // analyzer and dashboard cycle selector work without special-casing.
      const billingCycles = {};
      for (const e of entries) {
        billingCycles[e.billCycleDate] = {
          ratePlan: e.callingPlan,
          rateCode: '',
          totalCurrent: e.totalCharges,
          monthlyCharges: e.monthlyCharges,
          activity: e.usagePurchaseCharges,
          taxes: e.taxes,
          fees: e.surcharges,
          equipmentCharges: e.equipmentCharges,
          // KB so the existing AT&T-shaped consumers work; GB also kept.
          kbUsage: e.dataUsageKB,
          minUsage: e.voiceUsage,
          msgUsage: e.messagingUsage,
          dataGB: e.dataUsageGB,
          adjustments: e.accountChargesAndCredits,
        };
      }

      // 90-day usage totals (sum across all cycles in the upload).
      const totalGB = entries.reduce((s, e) => s + (e.dataUsageGB || 0), 0);
      const totalMin = entries.reduce((s, e) => s + (e.voiceUsage || 0), 0);
      const totalMsg = entries.reduce((s, e) => s + (e.messagingUsage || 0), 0);

      // Zero-usage check, device-type aware (matches AT&T parser logic).
      const deviceType = latest.deviceType;
      let zeroUsage;
      if (['Tablet', 'Hotspot'].includes(deviceType)) {
        zeroUsage = totalGB === 0;
      } else {
        zeroUsage = totalGB === 0 && totalMin === 0 && totalMsg === 0;
      }

      const userName = latest.userName || 'Unknown';
      const doNotCancel = userName.toUpperCase().includes('DO NOT CANCEL') ||
                          userName.toUpperCase().includes('CAMERA');

      // MRC convention: earliest cycle's Total Charges. NOT an average across
      // months — Stephen explicitly rejected averaging because it hides what
      // a new line actually costs.
      const mrc = earliest.totalCharges || 0;

      // Latest-cycle device payment / promo info for the contract panel.
      const latestDpa = (dpaByLineCycle[wn] && dpaByLineCycle[wn][latest.billCycleDate]) || null;
      const latestPromo = (promoByLineCycle[wn] && promoByLineCycle[wn][latest.billCycleDate]) || 0;

      // Latest-cycle Monthly Charges breakdown (MRC / credits / add-ons).
      // Validation: computed (mrcGross + creditTotal + addonTotal) must equal
      // wirelessSummary's monthlyCharges within a penny. When it doesn't, the
      // Rate Plan Detail view surfaces it as a parser-coverage warning rather
      // than silently presenting a wrong breakdown.
      const latestMonthlyBreakdown = (monthlyByLineCycle[wn] && monthlyByLineCycle[wn][latest.billCycleDate]) || null;
      const latestMrcGross         = latestMonthlyBreakdown ? latestMonthlyBreakdown.mrcGross : 0;
      const latestCreditTotal      = latestMonthlyBreakdown ? latestMonthlyBreakdown.creditTotal : 0;
      const latestAddonTotal       = latestMonthlyBreakdown ? latestMonthlyBreakdown.addonTotal : 0;
      const latestMrcItems         = latestMonthlyBreakdown ? latestMonthlyBreakdown.mrcItems : [];
      const latestCreditsItemized  = latestMonthlyBreakdown ? latestMonthlyBreakdown.creditsItemized : [];
      const latestAddonsItemized   = latestMonthlyBreakdown ? latestMonthlyBreakdown.addonsItemized : [];
      const latestNetMonthlyComputed = latestMrcGross + latestCreditTotal + latestAddonTotal;
      const mrcBreakdownValid = Math.abs(latestNetMonthlyComputed - (latest.monthlyCharges || 0)) < 0.01;

      // hasActiveContract is true if any cycle had an installment posting.
      const hasAnyDpa = !!dpaByLineCycle[wn];
      // Remaining months: parse "X of Y" from the latest cycle's DPA line.
      let remainingMonths = 0;
      if (latestDpa && latestDpa.dpaProgress) {
        const m = latestDpa.dpaProgress.match(/(\d+)\s+of\s+(\d+)/);
        if (m) remainingMonths = Math.max(0, parseInt(m[2]) - parseInt(m[1]));
      }

      // Pull device + contract info from the Upgrade Eligibility report (if uploaded).
      const ue = ueByLine[wn] || {};
      const ueDeviceType = ue.deviceType || deviceType;

      // BAN selection — when UE is provided, prefer the UE's BAN (the canonical
      // current sub-account assignment). Without UE, fall back to the last
      // cycle's row's BAN. This matters for lines that moved BANs mid-quarter:
      // their billing rows scatter across both old and new BANs (final
      // refund on the old BAN + actual charge on the new BAN), and naive
      // "last-row wins" sorting would assign them to the old (now-dead)
      // BAN, then the dead-BAN filter would drop them entirely.
      let lineBan = latest.ban;
      if (ue.ban) {
        lineBan = ue.ban;
      } else {
        // Without UE, pick the cycle/row with the largest positive totalCharges
        // — that's where the active service lives.
        let bestEntry = latest;
        let bestCharge = -Infinity;
        for (const e of entries) {
          if ((e.totalCharges || 0) > bestCharge) {
            bestCharge = e.totalCharges;
            bestEntry = e;
          }
        }
        if (bestEntry) lineBan = bestEntry.ban;
      }

      profiles[wn] = {
        wireless: wn,
        userName,
        ban: lineBan,
        costCenter: latest.costCenter,
        status: 'Active',
        deviceType: ueDeviceType,
        deviceMake: ue.deviceMake || '',
        deviceModel: ue.deviceModel || '',
        deviceIMEI: ue.deviceId || '',
        ratePlan: latest.callingPlan,
        rateCode: '',
        billingCycles,
        cycleCount: entries.length,

        // Charges (latest-cycle snapshot — used by the dashboard hero/breakdown).
        latestMonthly: latest.monthlyCharges,
        latestTotal: latest.totalCharges,
        latestActivity: latest.usagePurchaseCharges,
        latestTaxes: latest.taxes,
        latestFees: latest.surcharges,
        equipmentCharges: latest.equipmentCharges,
        usagePurchaseCharges: latest.usagePurchaseCharges,
        mrc,

        // Monthly-Charges breakdown (latest cycle).  Net of these three
        // buckets is computed below and validated against latestMonthly.
        latestMrcGross,
        latestCreditTotal,
        latestAddonTotal,
        latestMrcItems,
        latestCreditsItemized,
        latestAddonsItemized,
        latestNetMonthlyComputed,
        mrcBreakdownValid,

        // Usage totals (90-day window across cycles in the upload).
        gbTotal: totalGB,
        gbAvg: totalGB / Math.max(entries.length, 1),
        minTotal: totalMin,
        minAvg: totalMin / Math.max(entries.length, 1),
        msgTotal: totalMsg,
        msgAvg: totalMsg / Math.max(entries.length, 1),
        // AT&T-shaped aliases so existing consumers don't break.
        totalKb90d: entries.reduce((s, e) => s + (e.dataUsageKB || 0), 0),
        totalMin90d: totalMin,
        totalMsg90d: totalMsg,
        zeroUsage,

        // Contract / device-payment fields. Contract end / activation now
        // come from the Upgrade Eligibility report when uploaded; otherwise
        // they fall back to the DPA-derived state.
        contractType: hasAnyDpa ? 'Installment' : 'None',
        contractEnd: ue.contractEndDate || '',
        contractEndDate: ue.contractEndDate ? new Date(ue.contractEndDate) : null,
        contractStatus: hasAnyDpa ? 'Active' : '',
        monthlyInstallment: latestDpa ? latestDpa.installment : 0,
        dpaProgress: latestDpa ? latestDpa.dpaProgress : '',
        promoCredit: latestPromo,
        remainingMonths,
        hasActiveContract: !!(ue.contractEndDate && new Date(ue.contractEndDate) > new Date())
                           || (hasAnyDpa && remainingMonths > 0),
        etf: 0,
        activationDate: ue.activationDate || '',
        upgradeEligibilityDate: ue.upgradeEligibilityDate || '',

        doNotCancel,
        monthCount: entries.length,
        // Source-of-Truth tag — see SOURCE_OF_TRUTH.md. Verizon RDD exports
        // do already itemize MRC/credits/add-ons (latestMrcItems, etc.),
        // which is unusually rich for a CSV. The bill PDF still wins on
        // disagreement — Verizon's CSV is a feed off the bill, but the
        // bill is the legal artifact.
        source: 'csv',
      };
    }

    // ── Ghost profiles for UE lines with no billing rows ──────────────────────
    // The sheet's "Usage Report" formula SUMs Raw Data rows by wireless number.
    // When a wireless number is in Upgrade Eligibility but has no billing rows
    // (recently disconnected, pending first cycle, etc.), the sum is 0 and the
    // line gets flagged as zero-usage anyway. We mirror that — create a
    // zero-everything profile so the audit lands at the same line count.
    if (hasUpgrade) {
      for (const u of upgradeEligibility) {
        if (!u.wireless || profiles[u.wireless]) continue;
        profiles[u.wireless] = {
          wireless: u.wireless,
          userName: u.userName || 'Unknown',
          ban: u.ban || '',
          costCenter: u.costCenter || '',
          status: 'Active',
          deviceType: u.deviceType || 'Other',
          deviceMake: u.deviceMake || '',
          deviceModel: u.deviceModel || '',
          deviceIMEI: u.deviceId || '',
          ratePlan: '',
          rateCode: '',
          billingCycles: {},
          cycleCount: 0,

          latestMonthly: 0,
          latestTotal: 0,
          latestActivity: 0,
          latestTaxes: 0,
          latestFees: 0,
          equipmentCharges: 0,
          usagePurchaseCharges: 0,
          mrc: 0,

          // No Monthly Charges in the bill window for ghost lines — empty
          // breakdown matches the zero monthlyCharges, so it validates clean.
          latestMrcGross: 0,
          latestCreditTotal: 0,
          latestAddonTotal: 0,
          latestMrcItems: [],
          latestCreditsItemized: [],
          latestAddonsItemized: [],
          latestNetMonthlyComputed: 0,
          mrcBreakdownValid: true,

          gbTotal: 0,
          gbAvg: 0,
          minTotal: 0,
          minAvg: 0,
          msgTotal: 0,
          msgAvg: 0,
          totalKb90d: 0,
          totalMin90d: 0,
          totalMsg90d: 0,
          // No billing data → treat as zero-usage (matches Sheet behaviour).
          zeroUsage: true,

          contractType: 'None',
          contractEnd: u.contractEndDate || '',
          contractEndDate: u.contractEndDate ? new Date(u.contractEndDate) : null,
          contractStatus: '',
          monthlyInstallment: 0,
          dpaProgress: '',
          promoCredit: 0,
          remainingMonths: 0,
          hasActiveContract: !!(u.contractEndDate && new Date(u.contractEndDate) > new Date()),
          etf: 0,
          activationDate: u.activationDate || '',
          upgradeEligibilityDate: u.upgradeEligibilityDate || '',

          doNotCancel: false,
          monthCount: 0,
          isGhost: true,  // marker — line in UE but never billed in our 3-month window
          // Source-of-Truth tag — see SOURCE_OF_TRUTH.md
          source: 'csv',
        };
      }
    }

    // ── Per-cycle bill totals (drives dashboard cycle selector) ──────────────
    // Sums every AccountSummary row's Total Current Charges per cycle. Includes
    // all sub-accounts so it matches the carrier's invoice when "All BANs" is
    // selected. Per-BAN totals live in `meta.byBan`.
    const billByCycle = {};
    for (const a of accountSummaries) {
      const cycle = a.billCycleDate;
      if (!cycle) continue;
      if (!billByCycle[cycle]) {
        billByCycle[cycle] = {
          totalCurrent: 0, monthlyCharges: 0, activity: 0, taxes: 0, fees: 0, equipment: 0,
        };
      }
      billByCycle[cycle].totalCurrent   += a.totalCurrentCharges || 0;
      billByCycle[cycle].monthlyCharges += a.monthlyCharges || 0;
      billByCycle[cycle].activity       += a.usagePurchaseCharges || 0;
      billByCycle[cycle].taxes          += a.taxes || 0;
      billByCycle[cycle].fees           += a.surcharges || 0;
      billByCycle[cycle].equipment      += a.equipmentCharges || 0;
    }

    // ── Per-BAN summary (drives the dashboard BAN selector + breakout) ──────
    // For each sub-account, compute: line counts, latest-cycle bill totals,
    // 90-day spend, and zero-usage count. We use this for the dropdown and
    // the by-BAN panel — and to drop "dead" BANs (zero active lines in the
    // latest cycle).
    const cyclesSorted = Object.keys(billByCycle).sort(
      (a, b) => cycleSortKey(a).localeCompare(cycleSortKey(b))
    );
    const latestCycle = cyclesSorted[cyclesSorted.length - 1] || null;

    const byBan = {};
    // Seed every BAN we saw in AccountSummary so the dashboard can show
    // dead-BAN entries pre-filter if anyone wants them later.
    for (const a of accountSummaries) {
      if (!a.ban) continue;
      if (!byBan[a.ban]) {
        byBan[a.ban] = {
          ban: a.ban,
          billName: a.billName,
          lineCount: 0,
          latestLineCount: 0,
          zeroUsageCount: 0,
          billLatest: 0,
          billLatestPlan: 0,
          billLatestEquipment: 0,
          billLatestTaxes: 0,
          billLatestFees: 0,
          totalSpend90d: 0,
          cycles: {},   // {cycleDate: {totalCurrent, monthlyCharges, ...}}
          dead: true,    // flipped to false if any active line in latest cycle
        };
      }
      byBan[a.ban].cycles[a.billCycleDate] = {
        totalCurrent: a.totalCurrentCharges || 0,
        monthlyCharges: a.monthlyCharges || 0,
        equipment: a.equipmentCharges || 0,
        taxes: a.taxes || 0,
        fees: a.surcharges || 0,
        invoiceNumber: a.invoiceNumber,
        dateDue: a.dateDue,
      };
      if (latestCycle && a.billCycleDate === latestCycle) {
        byBan[a.ban].billLatest          += a.totalCurrentCharges || 0;
        byBan[a.ban].billLatestPlan      += a.monthlyCharges || 0;
        byBan[a.ban].billLatestEquipment += a.equipmentCharges || 0;
        byBan[a.ban].billLatestTaxes     += a.taxes || 0;
        byBan[a.ban].billLatestFees      += a.surcharges || 0;
      }
    }

    // Walk the profiles to populate per-BAN line counts and spend.
    for (const p of Object.values(profiles)) {
      if (!p.ban) continue;
      if (!byBan[p.ban]) {
        // Edge case: line exists with no AccountSummary row. Seed a minimal entry.
        byBan[p.ban] = {
          ban: p.ban, billName: '', lineCount: 0, latestLineCount: 0,
          zeroUsageCount: 0, billLatest: 0, billLatestPlan: 0,
          billLatestEquipment: 0, billLatestTaxes: 0, billLatestFees: 0,
          totalSpend90d: 0, cycles: {}, dead: true,
        };
      }
      byBan[p.ban].lineCount++;
      byBan[p.ban].totalSpend90d += Object.values(p.billingCycles).reduce(
        (s, c) => s + (c.totalCurrent || 0), 0
      );
      if (p.zeroUsage) byBan[p.ban].zeroUsageCount++;
      if (latestCycle && p.billingCycles[latestCycle]) {
        byBan[p.ban].latestLineCount++;
        if ((p.billingCycles[latestCycle].totalCurrent || 0) > 0) {
          byBan[p.ban].dead = false;
        }
      }
    }

    // ── Drop dead BANs (and their lines) ─────────────────────────────────────
    // A sub-account is "active" if it has ≥1 wireless line with positive total
    // charges in the LATEST cycle. Anything else is filtered out: the BAN
    // disappears from byBan, and any line whose ban is dead disappears from
    // profiles. This matches Stephen's "5 active out of 15" reality without
    // requiring him to list which BANs to keep.
    const activeBans = new Set();
    for (const [ban, info] of Object.entries(byBan)) {
      if (!info.dead) activeBans.add(ban);
    }
    const droppedBans = [];
    for (const ban of Object.keys(byBan)) {
      if (!activeBans.has(ban)) {
        droppedBans.push(ban);
        delete byBan[ban];
      }
    }
    const droppedLines = [];
    for (const wn of Object.keys(profiles)) {
      if (!activeBans.has(profiles[wn].ban)) {
        droppedLines.push(wn);
        delete profiles[wn];
      }
    }
    if (droppedBans.length) {
      console.log('[VerizonParser] Dropped', droppedBans.length, 'dead BANs:',
                   droppedBans.join(', '), '— and', droppedLines.length, 'lines on them');
    }

    return {
      profiles,
      meta: {
        carrier: 'verizon',
        source: 'verizon-zip',
        accountSummaries,
        billingCycles: cyclesSorted,
        billingPeriods: cyclesSorted,
        billByCycle,
        byBan,
        activeBans: Array.from(activeBans),
        droppedBans,
        totalLines: Object.keys(profiles).length,
        accountName: (accountSummaries[0] && accountSummaries[0].billName) || '',
        // Master BAN = the chunk before the dash, for display purposes.
        masterBan: (Array.from(activeBans)[0] || '').split('-')[0] || '',
        // Raw chargesDetail rows kept on meta so the features analyzer can
        // re-walk them looking for add-ons (insurance, international, etc).
        // Cycle filtering happens in features.js so it sees the latest cycle
        // only and reports current monthly cost (not 3-month sum).
        chargesDetail: chargesItems || [],
        // True only when the Upgrade Eligibility (Device Report) was
        // uploaded and used to anchor the line universe. Lets the dashboard
        // surface "anchored to N managed lines" vs "audit every billing line".
        usingUpgradeEligibility: hasUpgrade,
        upgradeEligibilityCount: upgradeEligibility.length,
      }
    };
  }

  /**
   * Top-level parse: takes an array of {type, rows} payloads (the shape
   * verizon-zip.js produces) and returns {profiles, meta}.
   */
  function parse(files) {
    let accountSummaries = [];
    let wirelessLines = [];
    let chargesItems = [];
    let upgradeEligibility = [];

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
        case 'upgradeEligibility':
          upgradeEligibility = parseUpgradeEligibility(rows);
          break;
        // usageDetail intentionally skipped — call records aren't used here.
      }
    }

    return buildProfiles(wirelessLines, chargesItems, accountSummaries, upgradeEligibility);
  }

  return {
    detectFileType,
    parse,
    parseAccountSummary,
    parseWirelessSummary,
    parseChargesDetail,
    parseUpgradeEligibility,
    buildProfiles,
    classifyDevice,
  };
})();
