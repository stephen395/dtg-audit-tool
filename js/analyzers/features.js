/**
 * Add-on Features Analyzer
 *
 * Walks the carrier's per-line charge detail and pulls out everything that
 * ISN'T the phone plan, equipment installment, surcharge, or tax — the
 * recurring add-ons the client is paying for. Buckets each one into a
 * category (Insurance, International, Hotspot, etc.) and reports per-category
 * line count + monthly cost.
 *
 * Why this matters: a typical line costs $35–60/month for the plan, but
 * Mobile Insurance ($15/mo), International Day Pass, Cloud, Call Filter, etc
 * silently add another $10–30/mo per line. On a 200-line account that's
 * $20K–60K/year of optional spend the client may want to right-size.
 *
 * Carrier sources:
 *   - Verizon: meta.chargesDetail (Acct & Wireless Charges Detail TXT)
 *   - AT&T:    meta.billingLines (per-line rows of the billing CSV)
 */
window.FeatureAnalyzer = (function () {
  'use strict';

  // ─── Taxonomy ────────────────────────────────────────────────────────────
  // Ordered list — first match wins. Add/edit categories here as Stephen
  // surfaces new patterns from real audits.
  const TAXONOMY = [
    { category: 'Insurance / Mobile Protect', keywords: [
      /mobile\s*protect/i, /asurion/i, /\binsurance\b/i,
      /total\s*mobile\s*protection/i, /total\s*equipment/i,
      /protection\s*plan/i, /device\s*protection/i,
      /wireless\s*phone\s*protection/i, /phone\s*protection/i,
    ] },
    { category: 'International / Roaming', keywords: [
      /\binternational\b/i, /travel\s*pass/i, /travelpass/i, /\bglobal\b/i,
      /\broaming\b/i, /world\s*phone/i,
    ] },
    { category: 'Hotspot Add-on', keywords: [
      /hotspot/i, /jetpack\s*add/i, /\bmhs\b/i, /tethering/i,
    ] },
    { category: 'Mobile Internet Security', keywords: [
      /internet\s*security/i, /mobile\s*security/i, /security\s*suite/i,
      /\blookout\b/i, /\bmcafee\b/i, /\bnorton\b/i,
    ] },
    { category: 'Call Filter / Spam Block', keywords: [
      /call\s*filter/i, /call\s*protect/i, /robocall/i,
      /spam.*block/i, /spam.*shield/i,
    ] },
    { category: 'Cloud Storage', keywords: [
      /\bcloud\b/i, /\d+\s*gb\s*cloud/i, /verizon\s*cloud/i,
    ] },
    { category: 'Music / Streaming Bundle', keywords: [
      /apple\s*music/i, /spotify/i, /\bdisney\b/i, /\bhbo\b/i, /netflix/i,
      /paramount/i, /youtube/i, /pandora/i, /\bperks\b/i,
    ] },
    { category: 'Roadside Assistance', keywords: [
      /roadside/i,
    ] },
    { category: 'Visual Voicemail', keywords: [
      /visual\s*voicemail/i, /\bvvm\b/i,
    ] },
    { category: 'Number Share / Connected Device', keywords: [
      /number\s*share/i, /numbershare/i, /connected\s*device\s*access/i,
    ] },
    { category: 'Connected Watch / Wearable', keywords: [
      /wearable/i, /smartwatch/i, /apple\s*watch/i, /watch\s*plan/i,
    ] },
    { category: 'Networking / IoT', keywords: [
      /static\s*ip/i, /\bipv4\b/i, /\bipv6\b/i, /\bm2m\b/i,
      /machine\s*to\s*machine/i, /\bfwa\b/i, /\bapn\b/i, /private\s*network/i,
    ] },
  ];

  // Plan-name patterns. Anything matching is the line's recurring rate plan,
  // not an add-on. Order: most-specific first.
  const PLAN_PATTERNS = [
    /^\s*bus\s*unl/i,
    /^\s*business\s*unl/i,
    /^\s*business\s*unlimited/i,
    /^\s*my\s*biz\s*plan/i,
    /^\s*5g\s*business\s*internet/i,
    /^\s*the\s*new\s*verizon\s*plan/i,
    /verizon\s*plan\s*bus/i,
    /\bsmartphone\b/i,
    /\btablet(\s|$)/i,
    /\bdata\s*device\b/i,
    // AT&T plan name patterns
    /\bunlimited\s*(starter|elite|extra|premium|performance|advanced)/i,
    /^\s*att\s*unlimited/i,
    /^\s*mobility\s*(select|smart)/i,
    /^\s*smart\s*business/i,
    /\bnationwide\b/i,
  ];

  // Patterns indicating a non-feature charge: discount, credit, refund,
  // adjustment, or a one-time line item. Drop these from the feature roll-up.
  const NON_FEATURE_PATTERNS = [
    /\$\d+(\.\d+)?\s*off\b/i,
    /\d+%\s*off\b/i,
    /\bdiscount\b/i,
    /\bcredit\b/i,
    /\brefund\b/i,
    /\breversal\b/i,
    /\bprice\s*lock\b/i,
    /\badjustment\b/i,
    /\bpromo\b/i,
    /^\s*plan\s*rate/i,
    /^\s*connection\s*charge/i,
    /\bearly\s*termination/i,
    /economic\s*adjustment/i,
    /carryover/i,
    /^\s*overage\s*protection/i,
    /^\s*cellular\s*service\s*-\s*access/i,
  ];

  function isPhonePlan(desc, planForLine) {
    if (!desc) return false;
    if (planForLine) {
      const planLow = String(planForLine).toLowerCase();
      const descLow = String(desc).toLowerCase();
      // Most charge descriptions begin with the plan name. Match leading prefix.
      if (descLow.startsWith(planLow.slice(0, Math.min(20, planLow.length)))) return true;
    }
    return PLAN_PATTERNS.some(re => re.test(desc));
  }

  function isNonFeature(desc) {
    return NON_FEATURE_PATTERNS.some(re => re.test(desc));
  }

  function categorize(desc) {
    for (const t of TAXONOMY) {
      for (const re of t.keywords) {
        if (re.test(desc)) return t.category;
      }
    }
    return 'Other / Uncategorized';
  }

  /**
   * Normalise a charge description to a stable key — strip the cycle-specific
   * proration suffix ("$X per month / N days on plan", "(month in advance)"
   * "Refund $X per month / N days refunded ...") so the same feature shows up
   * as one row across cycles.
   */
  function normaliseDesc(desc) {
    return String(desc || '')
      .replace(/\$-?\d+(\.\d+)?\s*per\s*month.*$/i, '')
      .replace(/\(month\s*in\s*advance\)/i, '')
      .replace(/price\s*lock\s*guarantee\s*expires\d*/i, '')
      .trim();
  }

  /**
   * Verizon path. Walks chargesDetail rows and groups by description.
   * Restricts to LATEST cycle so the totals = current monthly, not 3-month sum.
   */
  function analyzeVerizon(profiles, meta) {
    const items = (meta && meta.chargesDetail) || [];
    if (!items.length) return emptyResult('verizon');

    // Pick the latest cycle string (already sorted chronologically).
    const cyclesSorted = (meta && meta.billingCycles) || [];
    const latestCycle = cyclesSorted[cyclesSorted.length - 1];

    // Map wireless → plan name for phone-plan matching.
    const planByLine = {};
    const banByLine = {};
    for (const p of Object.values(profiles)) {
      planByLine[p.wireless] = p.ratePlan || '';
      banByLine[p.wireless] = p.ban || '';
    }

    return collectFeatures(items, {
      cycleField: 'billCycleDate',
      cycleValue: latestCycle,
      descField: 'itemDescription',
      categoryField: 'itemCategory',
      acceptCategories: ['Monthly Charges', 'Other Charges and Credits'],
      costField: 'cost',
      lineField: 'wireless',
      userField: 'userName',
      planByLine,
      banByLine,
    });
  }

  /**
   * AT&T path. Walks billingLines (each row is a wireless × cycle × rate plan).
   * Same idea as Verizon: filter to latest cycle, drop plan-name rows, drop
   * negative / discount rows, classify the rest.
   */
  function analyzeATT(profiles, meta) {
    const items = (meta && meta.billingLines) || [];
    if (!items.length) return emptyResult('att');

    // Latest cycle by Date sort — AT&T cycle dates look like "11/22/2025".
    const cycleStrs = [...new Set(items.map(l => l.cycleDate))].filter(Boolean);
    cycleStrs.sort((a, b) => {
      const ta = new Date(a).getTime();
      const tb = new Date(b).getTime();
      return (isNaN(ta) ? 0 : ta) - (isNaN(tb) ? 0 : tb);
    });
    const latestCycle = cycleStrs[cycleStrs.length - 1];

    const planByLine = {};
    const banByLine = {};
    for (const p of Object.values(profiles)) {
      planByLine[p.wireless] = p.ratePlan || '';
      banByLine[p.wireless] = p.ban || '';
    }

    return collectFeatures(items, {
      cycleField: 'cycleDate',
      cycleValue: latestCycle,
      descField: 'ratePlan',
      categoryField: null,
      // No category field — every billing row is a candidate.
      costField: 'monthlyCharges',
      lineField: 'wireless',
      userField: 'userName',
      planByLine,
      banByLine,
    });
  }

  function collectFeatures(items, opts) {
    const featureMap = {};   // {category: {normDesc: {lines:Set, totalMonthly, items:[]}}}

    for (const item of items) {
      if (opts.cycleValue && item[opts.cycleField] !== opts.cycleValue) continue;
      if (opts.acceptCategories && !opts.acceptCategories.includes(item[opts.categoryField])) continue;
      const cost = Number(item[opts.costField]) || 0;
      if (!(cost > 0)) continue;
      const desc = String(item[opts.descField] || '').trim();
      if (!desc) continue;

      const wireless = item[opts.lineField];
      // Scope to the filtered profile set. planByLine is built from the
      // currently-active profiles (full set or single BAN). Items belonging
      // to lines not in that set get skipped — this is what makes the
      // features panel respect the BAN selector.
      if (!Object.prototype.hasOwnProperty.call(opts.planByLine, wireless)) continue;
      const planForLine = opts.planByLine[wireless] || '';
      if (isPhonePlan(desc, planForLine)) continue;
      if (isNonFeature(desc)) continue;

      const category = categorize(desc);
      const normDesc = normaliseDesc(desc);
      if (!featureMap[category]) featureMap[category] = {};
      if (!featureMap[category][normDesc]) {
        featureMap[category][normDesc] = {
          lines: new Set(),
          totalMonthly: 0,
          items: [],
        };
      }
      featureMap[category][normDesc].lines.add(wireless);
      featureMap[category][normDesc].totalMonthly += cost;
      featureMap[category][normDesc].items.push({
        wireless,
        userName: item[opts.userField] || '',
        ban: opts.banByLine[wireless] || '',
        cost,
      });
    }

    // Flatten to feature list.
    const features = [];
    for (const [category, byDesc] of Object.entries(featureMap)) {
      for (const [desc, info] of Object.entries(byDesc)) {
        features.push({
          category,
          description: desc,
          lineCount: info.lines.size,
          totalMonthly: info.totalMonthly,
          annualCost: info.totalMonthly * 12,
          avgPerLine: info.lines.size > 0 ? info.totalMonthly / info.lines.size : 0,
          lines: Array.from(info.lines),
          items: info.items,
        });
      }
    }
    features.sort((a, b) => b.totalMonthly - a.totalMonthly);

    // Category roll-up.
    const categoryMap = {};
    const allLines = new Set();
    for (const f of features) {
      if (!categoryMap[f.category]) {
        categoryMap[f.category] = {
          category: f.category,
          lineCount: 0,
          uniqueLines: new Set(),
          totalMonthly: 0,
          distinctFeatures: 0,
        };
      }
      categoryMap[f.category].totalMonthly += f.totalMonthly;
      categoryMap[f.category].distinctFeatures += 1;
      f.lines.forEach(l => {
        categoryMap[f.category].uniqueLines.add(l);
        allLines.add(l);
      });
    }
    const categories = Object.values(categoryMap)
      .map(c => ({
        category: c.category,
        lineCount: c.uniqueLines.size,
        distinctFeatures: c.distinctFeatures,
        totalMonthly: c.totalMonthly,
        annualCost: c.totalMonthly * 12,
      }))
      .sort((a, b) => b.totalMonthly - a.totalMonthly);

    const totalMonthly = features.reduce((s, f) => s + f.totalMonthly, 0);

    // ── Per-line roll-up — answers "which lines have add-ons and how much" so
    // Stephen can drill from a category total down to the actual phone numbers
    // and decide which to keep / cancel. Indexed by wireless, with the unique
    // features on each line (de-duped against the same feature being billed in
    // two parts in one cycle, e.g. full month + proration).
    const lineRollup = {};
    for (const f of features) {
      for (const it of f.items) {
        if (!lineRollup[it.wireless]) {
          lineRollup[it.wireless] = {
            wireless: it.wireless,
            userName: it.userName || '',
            ban: it.ban || '',
            totalMonthly: 0,
            featureMap: {},  // { description: {category, description, cost} }
          };
        }
        const r = lineRollup[it.wireless];
        r.totalMonthly += it.cost;
        if (!r.featureMap[f.description]) {
          r.featureMap[f.description] = { category: f.category, description: f.description, cost: 0 };
        }
        r.featureMap[f.description].cost += it.cost;
        if (!r.userName && it.userName) r.userName = it.userName;
        if (!r.ban && it.ban) r.ban = it.ban;
      }
    }
    // Materialise + sort.
    const lineSpend = Object.values(lineRollup).map(r => {
      const features = Object.values(r.featureMap).sort((a, b) => b.cost - a.cost);
      return {
        wireless: r.wireless,
        userName: r.userName,
        ban: r.ban,
        totalMonthly: r.totalMonthly,
        featureCount: features.length,
        features,
      };
    }).sort((a, b) => b.totalMonthly - a.totalMonthly);

    return {
      features,
      categories,
      lineSpend,
      totalMonthly,
      annualCost: totalMonthly * 12,
      uniqueLineCount: allLines.size,
      featureCount: features.length,
    };
  }

  function emptyResult(carrier) {
    return {
      features: [], categories: [], lineSpend: [],
      totalMonthly: 0, annualCost: 0,
      uniqueLineCount: 0, featureCount: 0, _empty: true, carrier,
    };
  }

  function analyze(profiles, meta, carrier) {
    if (carrier === 'verizon') return analyzeVerizon(profiles, meta);
    if (carrier === 'att')     return analyzeATT(profiles, meta);
    return emptyResult(carrier);
  }

  return {
    analyze,
    analyzeVerizon,
    analyzeATT,
    categorize,
    isPhonePlan,
    isNonFeature,
    normaliseDesc,
    TAXONOMY,
  };
})();
