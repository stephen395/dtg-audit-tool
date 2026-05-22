/**
 * Rate Plan Detail tab — per-line Monthly Charges breakdown.
 *
 * Surfaces the four headline fields the carrier bill shows for each line:
 *   MRC (plan)  +  Credits  +  Add-ons  =  Net Monthly
 *
 * Supports two upstream shapes:
 *
 *   1. Verizon RDD — `Acct & Wireless Charges Detail Summary Usage` file
 *      (parsed in verizon-txt.js → buildProfiles), which itemizes each
 *      Monthly Charges row by Share Description (Plan / Feature / credit).
 *      Profile fields: latestMrcItems / latestCreditsItemized /
 *      latestAddonsItemized / latestMrcGross / latestCreditTotal /
 *      latestAddonTotal / latestMonthly / mrcBreakdownValid.
 *
 *   2. AT&T (and any carrier where a bill PDF is uploaded) — bill-pdf.js
 *      parseLineChargesBreakdown() walks each per-line detail page and
 *      classifies every numbered item by section + description. Profile
 *      fields: monthlyBreakdown [{ description, amount, type, isRecurring,
 *      crossCycleEvidence }] / grossPlanMRC / recurringCreditsTotal /
 *      oneTimeCreditsTotal / netPlanMRC.
 *
 * extractBreakdown() normalizes the two into one shape so the rest of the
 * view doesn't need to branch.
 */
(function () {
  'use strict';

  function fmt(n) {
    if (typeof window.fmtMoney === 'function') return window.fmtMoney(n);
    if (typeof n !== 'number' || isNaN(n)) return '$0.00';
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n);
    return sign + '$' + abs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Normalize a profile's per-line breakdown into the shape this view renders.
   * Returns null if no breakdown is available.
   *
   * Shape:
   *   {
   *     mrcItems:     [{ description, cost }],   // gross plan + plan-tier add-ons that are part of the rate plan
   *     creditsItems: [{ description, cost, isRecurring }],  // credits/discounts (cost < 0)
   *     addonsItems:  [{ description, cost }],   // monthly feature add-ons (5G UWB, Cloud, Protection, etc.)
   *     mrcGross:     number,
   *     creditsTotal: number,  // negative or 0
   *     addonsTotal:  number,
   *     netMonthly:   number,
   *     valid:        boolean,
   *     source:       'verizon-rdd' | 'bill-pdf' | 'none'
   *   }
   */
  function extractBreakdown(p) {
    // ── Verizon RDD shape ──
    if (Array.isArray(p.latestMrcItems) && p.latestMrcItems.length > 0) {
      return {
        mrcItems:     p.latestMrcItems,
        creditsItems: (p.latestCreditsItemized || []).map(it => ({ ...it, isRecurring: true })),
        addonsItems:  p.latestAddonsItemized || [],
        mrcGross:     Number(p.latestMrcGross   || 0),
        creditsTotal: Number(p.latestCreditTotal|| 0),
        addonsTotal:  Number(p.latestAddonTotal || 0),
        netMonthly:   Number(p.latestMonthly    || 0),
        valid:        p.mrcBreakdownValid !== false,
        source:       'verizon-rdd',
      };
    }

    // ── Bill PDF shape (AT&T today, any carrier with a bill PDF tomorrow) ──
    if (Array.isArray(p.monthlyBreakdown) && p.monthlyBreakdown.length > 0) {
      const mrcItems = [], creditsItems = [], addonsItems = [];
      for (const it of p.monthlyBreakdown) {
        const desc = it.description || '';
        const amt  = Number(it.amount) || 0;
        if (it.type === 'plan') {
          mrcItems.push({ description: desc, cost: amt });
        } else if (it.type === 'addon') {
          addonsItems.push({ description: desc, cost: amt });
        } else if (it.type === 'credit-recurring' || it.type === 'discount-recurring') {
          creditsItems.push({ description: desc, cost: amt, isRecurring: true,
                              crossCycleEvidence: it.crossCycleEvidence || null });
        } else if (it.type === 'credit-onetime') {
          creditsItems.push({ description: desc, cost: amt, isRecurring: false,
                              crossCycleEvidence: it.crossCycleEvidence || null });
        }
        // Skip company-fee / government-tax — those belong on the fees+taxes column elsewhere
      }
      // Sum from the breakdown (parser already provides these but recompute defensively)
      const mrcGross     = mrcItems.reduce((s, it) => s + it.cost, 0)
                          + addonsItems.reduce((s, it) => s + it.cost, 0);
      const creditsTotal = creditsItems.reduce((s, it) => s + it.cost, 0);
      const addonsTotal  = addonsItems.reduce((s, it) => s + it.cost, 0);
      const netMonthly   = Number(p.netPlanMRC) || (mrcGross + creditsTotal);
      // Validation: parser-computed components should reconstruct the bill total
      // within a cent. The parser fills computedLineTotal during parsing.
      const computedTotal = mrcGross + creditsTotal +
                            Number(p.oneTimeCreditsTotal || 0) +
                            Number(p.companyFees || p.latestFees || p.fees || 0) +
                            Number(p.govTaxes    || p.latestTaxes || p.taxes || 0);
      const billStated    = Number(p.totalCharges) || 0;
      const valid = billStated === 0 || Math.abs(computedTotal - billStated) < 0.02;
      return {
        mrcItems,
        creditsItems,
        addonsItems,
        mrcGross,
        creditsTotal,
        addonsTotal,
        netMonthly,
        valid,
        source: 'bill-pdf',
      };
    }

    return null;
  }

  function planName(p, breakdown) {
    if (breakdown && breakdown.mrcItems && breakdown.mrcItems.length > 0) {
      return breakdown.mrcItems[0].description;
    }
    if (p.latestMrcItems && p.latestMrcItems.length > 0) {
      return p.latestMrcItems[0].description;
    }
    return p.ratePlan || '—';
  }

  function itemList(items, opts) {
    opts = opts || {};
    if (!items || items.length === 0) return '';
    return items.map(it => {
      const sign = it.cost < 0 ? '-' : '';
      const abs = Math.abs(it.cost);
      const amt = sign + '$' + abs.toFixed(2);
      // For credits, surface recurring vs one-time when we know
      let badge = '';
      if (opts.showRecurrence && typeof it.isRecurring === 'boolean') {
        if (it.isRecurring) {
          const evid = it.crossCycleEvidence;
          const tip = evid
            ? `Seen in ${evid.cyclesSeen}/${evid.cyclesBilled} cycles — recurring with cross-cycle evidence`
            : 'Recurring (description pattern heuristic)';
          badge = `<span title="${tip}" style="font-size:9px;padding:1px 6px;border-radius:4px;background:rgba(34,197,94,0.15);color:#22c55e;text-transform:uppercase;letter-spacing:0.04em;margin-left:6px;">Recurring</span>`;
        } else {
          const evid = it.crossCycleEvidence;
          const tip = evid
            ? `Seen in only ${evid.cyclesSeen}/${evid.cyclesBilled} cycles — one-time`
            : 'One-time (description pattern heuristic)';
          badge = `<span title="${tip}" style="font-size:9px;padding:1px 6px;border-radius:4px;background:rgba(245,158,11,0.15);color:#f59e0b;text-transform:uppercase;letter-spacing:0.04em;margin-left:6px;">One-time</span>`;
        }
      }
      return `<div style="display:flex;justify-content:space-between;gap:12px;padding:2px 0;">
        <span style="color:var(--text-secondary);">${escapeHtml(it.description)}${badge}</span>
        <span style="font-variant-numeric:tabular-nums;color:${it.cost < 0 ? '#22c55e' : 'var(--text)'};">${amt}</span>
      </div>`;
    }).join('');
  }

  function populateRatePlanDetailTab(data) {
    const host = document.getElementById('tab-rate-plan-detail-content');
    if (!host) return;

    const profiles = Object.values(data.profiles || {});

    // Compute a breakdown per profile. Lines without a breakdown shape
    // (CSV-only carriers like Tangoe; AT&T audits run without the bill PDF —
    // which shouldn't happen post-Source-of-Truth gate, but be defensive)
    // get filtered out below with a clear empty-state message.
    const enriched = profiles.map(p => ({ profile: p, breakdown: extractBreakdown(p) }));

    const withBreakdown = enriched.filter(e => e.breakdown);
    if (withBreakdown.length === 0) {
      host.innerHTML = `<div class="tab-callout info" style="margin:8px 0;">
        <div class="ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg></div>
        <div class="txt"><strong>No per-line breakdown available for this audit.</strong> The Rate Plan Detail tab needs either (a) a Verizon RDD upload — the <em>Acct &amp; Wireless Charges Detail Summary Usage</em> file inside the monthly zip — or (b) a carrier bill PDF (AT&amp;T supported today; other carrier bill PDFs land as they're tested). Upload the bill and rerun the audit.</div>
      </div>`;
      return;
    }

    // Filter to lines that actually billed in the latest cycle. Suspended /
    // ghost lines have $0 monthly and contribute nothing here, so they're
    // pushed into a collapsed "no charges this cycle" section at the bottom.
    const billedEnriched   = withBreakdown.filter(e => !e.profile.isGhost && (e.breakdown.netMonthly || 0) > 0);
    const unbilledEnriched = enriched.filter(e => !e.breakdown || e.profile.isGhost || ((e.breakdown && e.breakdown.netMonthly) || 0) === 0);
    const billed   = billedEnriched.map(e => e.profile);
    const unbilled = unbilledEnriched.map(e => e.profile);

    if (billed.length === 0) {
      host.innerHTML = `<div class="tab-callout" style="margin:8px 0;">No billed lines in the latest cycle.</div>`;
      return;
    }

    // Aggregates across the billed set (use normalized breakdown).
    const totalMrcGross  = billedEnriched.reduce((s, e) => s + (e.breakdown.mrcGross     || 0), 0);
    const totalCredit    = billedEnriched.reduce((s, e) => s + (e.breakdown.creditsTotal || 0), 0);
    const totalAddon     = billedEnriched.reduce((s, e) => s + (e.breakdown.addonsTotal  || 0), 0);
    const totalNet       = billedEnriched.reduce((s, e) => s + (e.breakdown.netMonthly   || 0), 0);

    // Validation — how many lines' breakdown sum doesn't match the
    // wirelessSummary net.  Threshold of 5% is the request-doc spec.
    const invalidEnriched = billedEnriched.filter(e => !e.breakdown.valid);
    const invalid    = invalidEnriched.map(e => e.profile);
    const invalidPct = (invalid.length / billed.length) * 100;

    // Audit aggregates from the spec.
    const withCredits      = billedEnriched.filter(e => (e.breakdown.creditsTotal || 0) < 0).length;
    const stackedAddons    = billedEnriched.filter(e => (e.breakdown.addonsItems || []).filter(a => a.cost > 0).length >= 3).length;

    // Sources mix — show a small badge if data came from multiple shapes
    const sourceCounts = billedEnriched.reduce((acc, e) => {
      acc[e.breakdown.source] = (acc[e.breakdown.source] || 0) + 1;
      return acc;
    }, {});

    // ── KPI band — Total MRC, Credits, Add-ons, Net ───────────────────────
    let html = `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px;">
      <div class="kpi-card" style="padding:14px 16px;">
        <div class="kpi-card-label" style="font-size:10px;">Total MRC (gross)</div>
        <div class="kpi-card-value" style="font-size:22px;">${fmt(totalMrcGross)}</div>
        <div class="kpi-card-sub">Plan charges before credits</div>
      </div>
      <div class="kpi-card" style="padding:14px 16px;">
        <div class="kpi-card-label" style="font-size:10px;">Total Credits</div>
        <div class="kpi-card-value" style="font-size:22px;color:#22c55e;">${fmt(totalCredit)}</div>
        <div class="kpi-card-sub">${withCredits} line${withCredits === 1 ? '' : 's'} carrying credits</div>
      </div>
      <div class="kpi-card" style="padding:14px 16px;">
        <div class="kpi-card-label" style="font-size:10px;">Total Add-ons</div>
        <div class="kpi-card-value" style="font-size:22px;">${fmt(totalAddon)}</div>
        <div class="kpi-card-sub">${stackedAddons} line${stackedAddons === 1 ? '' : 's'} stacking 3+ paid add-ons</div>
      </div>
      <div class="kpi-card" style="padding:14px 16px;">
        <div class="kpi-card-label" style="font-size:10px;">Net Monthly</div>
        <div class="kpi-card-value" style="font-size:22px;">${fmt(totalNet)}</div>
        <div class="kpi-card-sub">${billed.length} billed lines</div>
      </div>
    </div>`;

    // ── Validation banner ────────────────────────────────────────────────
    if (invalid.length === 0) {
      html += `<div class="tab-callout success" style="margin:0 0 16px;">
        <div class="ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
        <div class="txt"><strong>All ${billed.length} lines validated.</strong> Computed (MRC + credits + add-ons) matches the bill-summary net to the cent for every line.</div>
      </div>`;
    } else {
      const sev = invalidPct > 5 ? 'danger' : 'warn';
      const headline = invalidPct > 5
        ? `Parser coverage gap on ${invalid.length} of ${billed.length} lines (${invalidPct.toFixed(1)}%).`
        : `Breakdown didn't validate for ${invalid.length} of ${billed.length} lines (${invalidPct.toFixed(1)}%).`;
      const detail = invalidPct > 5
        ? `Above the 5% threshold from the audit spec — flag this bill before publishing the breakdown. Most likely a Monthly Charges line item with an unexpected Share Description value.`
        : `Within tolerance, but the affected lines below show a yellow flag in the validation column. Spot-check before sending to the client.`;
      html += `<div class="tab-callout ${sev}" style="margin:0 0 16px;">
        <div class="ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
        <div class="txt"><strong>${headline}</strong> ${detail}</div>
      </div>`;
    }

    // ── Per-line breakdown table ─────────────────────────────────────────
    // Sort by net monthly desc, using the normalized breakdown so AT&T and
    // Verizon profiles sort by the same field.
    const sortedEnriched = [...billedEnriched].sort((a, b) =>
      (b.breakdown.netMonthly || 0) - (a.breakdown.netMonthly || 0));

    // Source badges — surface where the breakdown came from so the user knows
    // whether they're seeing CSV-derived (Verizon RDD) or PDF-derived (bill)
    // data. Both modes produce equivalent shape; the badge is just transparency.
    const sourceLabels = {
      'verizon-rdd': 'Verizon RDD (Charges Detail CSV)',
      'bill-pdf':    'Bill PDF (per-line detail page)',
    };
    const sourceBadges = Object.keys(sourceCounts).map(s =>
      `<span style="font-size:10px;padding:2px 8px;border-radius:4px;background:rgba(99,102,241,0.12);color:#a5b4fc;margin-right:6px;">${sourceCounts[s]} line${sourceCounts[s] === 1 ? '' : 's'} from ${sourceLabels[s] || s}</span>`
    ).join('');

    html += `<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);margin-bottom:6px;">Per-line breakdown (latest cycle)</div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
        <span>Click any row to see itemized credits and add-ons. Sorted by net monthly descending.</span>
        <span style="flex-basis:100%;margin-top:4px;">${sourceBadges}</span>
      </div>
      <div style="overflow-x:auto;background:var(--card);border:1px solid var(--border);border-radius:8px;margin-bottom:20px;">
      <table class="data-table" style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="background:#1a3a5c;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:0.03em;">
          <th style="padding:10px 12px;text-align:left;">Wireless</th>
          <th style="padding:10px 12px;text-align:left;">User</th>
          <th style="padding:10px 12px;text-align:left;">Plan</th>
          <th style="padding:10px 12px;text-align:right;" title="Plan monthly access charge before credits">MRC</th>
          <th style="padding:10px 12px;text-align:right;" title="Sum of recurring monthly credits">Credits</th>
          <th style="padding:10px 12px;text-align:right;" title="Sum of feature charges (5G UWB Access, Cloud, etc.)">Add-ons</th>
          <th style="padding:10px 12px;text-align:right;" title="MRC + Credits + Add-ons; must match the bill summary">Net</th>
          <th style="padding:10px 12px;text-align:center;" title="Did the breakdown sum match the bill summary?">Check</th>
        </tr></thead><tbody>`;

    for (const e of sortedEnriched) {
      const p        = e.profile;
      const bd       = e.breakdown;
      const credits  = bd.creditsItems || [];
      const addons   = bd.addonsItems  || [];
      const hasItems = credits.length + addons.length > 0;
      const detailId = 'rpd-detail-' + (p.wireless || '').replace(/\D/g, '');

      const planText = escapeHtml(planName(p, bd));
      const planTrim = planText.length > 38 ? planText.substring(0, 38) + '…' : planText;

      const creditCell = (bd.creditsTotal || 0) < 0
        ? `<span style="color:#22c55e;">${fmt(bd.creditsTotal)}</span>`
        : `<span style="color:var(--text-muted);">—</span>`;
      const addonCell  = (bd.addonsTotal || 0) > 0
        ? fmt(bd.addonsTotal)
        : `<span style="color:var(--text-muted);">—</span>`;
      const checkCell  = bd.valid
        ? `<span style="color:#22c55e;" title="Breakdown matches bill summary">✓</span>`
        : `<span style="color:#f59e0b;" title="Breakdown does NOT match bill summary — see net below">!</span>`;

      const rowAttr = hasItems
        ? ` style="border-bottom:1px solid rgba(255,255,255,0.05);cursor:pointer;" data-rpd-toggle="${detailId}"`
        : ' style="border-bottom:1px solid rgba(255,255,255,0.05);"';

      html += `<tr${rowAttr}>
        <td style="padding:8px 12px;font-variant-numeric:tabular-nums;">${escapeHtml(p.wireless)}</td>
        <td style="padding:8px 12px;">${escapeHtml(p.userName || '—')}</td>
        <td style="padding:8px 12px;color:var(--text-secondary);" title="${planText}">${planTrim}</td>
        <td style="padding:8px 12px;text-align:right;font-variant-numeric:tabular-nums;">${fmt(bd.mrcGross || 0)}</td>
        <td style="padding:8px 12px;text-align:right;font-variant-numeric:tabular-nums;">${creditCell}</td>
        <td style="padding:8px 12px;text-align:right;font-variant-numeric:tabular-nums;">${addonCell}</td>
        <td style="padding:8px 12px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;">${fmt(bd.netMonthly || 0)}</td>
        <td style="padding:8px 12px;text-align:center;">${checkCell}</td>
      </tr>`;

      if (hasItems) {
        // Show recurrence badges (Recurring / One-time) for credits when the
        // bill-pdf breakdown gave us that distinction. Verizon RDD credits
        // are all marked recurring by default — no badge clutter for those.
        const showRecurrence = bd.source === 'bill-pdf';
        let breakdownHtml = '';
        if (credits.length > 0) {
          breakdownHtml += `<div style="margin-bottom:6px;"><strong style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.05em;color:#22c55e;">Credits</strong>${itemList(credits, { showRecurrence })}</div>`;
        }
        if (addons.length > 0) {
          breakdownHtml += `<div><strong style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);">Add-ons</strong>${itemList(addons)}</div>`;
        }
        html += `<tr id="${detailId}" class="rpd-detail-row" style="display:none;background:rgba(99,102,241,0.04);">
          <td colspan="8" style="padding:10px 24px;font-size:11.5px;">${breakdownHtml}</td>
        </tr>`;
      }
    }

    // Total row.
    html += `<tr style="background:rgba(99,102,241,0.06);font-weight:700;">
      <td colspan="3" style="padding:10px 12px;">TOTAL — ${billed.length} billed lines</td>
      <td style="padding:10px 12px;text-align:right;">${fmt(totalMrcGross)}</td>
      <td style="padding:10px 12px;text-align:right;color:${totalCredit < 0 ? '#22c55e' : 'var(--text-muted)'};">${totalCredit < 0 ? fmt(totalCredit) : '—'}</td>
      <td style="padding:10px 12px;text-align:right;">${totalAddon > 0 ? fmt(totalAddon) : '—'}</td>
      <td style="padding:10px 12px;text-align:right;">${fmt(totalNet)}</td>
      <td style="padding:10px 12px;text-align:center;">${invalid.length === 0 ? '<span style="color:#22c55e;">✓</span>' : '<span style="color:#f59e0b;">' + invalid.length + ' flagged</span>'}</td>
    </tr>`;

    html += `</tbody></table></div>`;

    // ── Unbilled / suspended / ghost lines (collapsed) ─────────────────────
    if (unbilled.length > 0) {
      html += `<details style="margin-bottom:16px;">
        <summary style="cursor:pointer;padding:8px 12px;background:var(--card);border:1px solid var(--border);border-radius:8px;font-size:12px;font-weight:600;color:var(--text-secondary);">
          ${unbilled.length} line${unbilled.length === 1 ? '' : 's'} with no charges this cycle (suspended / pre-activation / ghost)
        </summary>
        <div style="margin-top:8px;padding:10px 12px;color:var(--text-muted);font-size:11.5px;">
          These lines have a Device Report entry but no Monthly Charges in the latest billing cycle. Review on the Zero Usage tab to decide cancel-vs-reactivate.
        </div>
      </details>`;
    }

    host.innerHTML = html;

    // Wire row click → toggle details row.  Delegated single handler.
    host.addEventListener('click', function (e) {
      const row = e.target.closest('tr[data-rpd-toggle]');
      if (!row) return;
      const target = document.getElementById(row.getAttribute('data-rpd-toggle'));
      if (!target) return;
      target.style.display = target.style.display === 'none' ? '' : 'none';
    });
  }

  window.populateRatePlanDetailTab = populateRatePlanDetailTab;
})();
