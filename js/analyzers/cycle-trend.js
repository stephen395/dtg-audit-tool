/**
 * Cycle Trend Analyzer
 *
 * Takes the already-built profiles + parser meta and answers:
 *   "What changed between billing cycles?"
 *
 * Produces:
 *   - snapshots — one per cycle, with bill totals + line count + inventory mix,
 *     so the dashboard KPIs can reflect a single cycle instead of a 3-month blob.
 *   - deltas   — one per cycle-transition (cycle N vs cycle N-1), listing lines
 *     added / cancelled / suspended / device-upgraded / plan-changed / port-in,
 *     plus activity-anomaly flags.
 *
 * "Added"      : wireless number appears in this cycle but not the prior cycle,
 *                and its activationDate (if present) falls within this cycle.
 * "Cancelled"  : wireless number was billed last cycle but not this cycle,
 *                OR has status = Cancelled in the inventory snapshot.
 * "Suspended"  : profile.status === "Suspended".
 * "Upgrade"    : device IMEI differs vs prior cycle's record OR lastUpgradeDate
 *                falls within this cycle.
 * "Plan change": billingCycles[cycle].ratePlan !== billingCycles[prev].ratePlan.
 * "Port-in"    : an added line + a cancelled line share the same IMEI or User
 *                Name — treat as a single number-change event, not an add+cxl.
 * "Anomaly"    : absolute bill delta > 50% of prior cycle's charge for that line.
 */
window.CycleTrendAnalyzer = (function () {
  'use strict';

  const MONTH_NAMES = ['January','February','March','April','May','June',
                       'July','August','September','October','November','December'];

  function parseCycleDate(str) {
    if (!str) return null;
    const s = String(str).trim();
    // ISO: 2026-04-01 or 2026-04-01 00:00:00
    const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
    // US: M/D/YYYY
    const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (us) return new Date(+us[3], +us[1] - 1, +us[2]);
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  function monthLabel(cycleStr) {
    const d = parseCycleDate(cycleStr);
    if (!d) return cycleStr;
    return MONTH_NAMES[d.getMonth()] + ' ' + d.getFullYear();
  }

  function rangeLabel(cycleStr) {
    // AT&T cycles end on ~the 22nd of each month, billing the prior 30 days.
    // Without exact cycle-start dates in the CSV we approximate by showing the
    // end date minus 30 days — accurate to within a day for reporting.
    const end = parseCycleDate(cycleStr);
    if (!end) return '';
    const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fmt = (d) => (d.getMonth() + 1) + '/' + d.getDate();
    return fmt(start) + ' – ' + fmt(end) + ', ' + end.getFullYear();
  }

  function classifyDeviceType(profile) {
    const dt = (profile.deviceType || '').toLowerCase();
    if (dt.includes('smartphone') || (dt.includes('phone') && !dt.includes('feature'))) return 'smartphones';
    if (dt.includes('tablet')) return 'tablets';
    if (dt.includes('hotspot') || dt.includes('jetpack') || dt.includes('data device') ||
        dt.includes('connected device') || dt.includes('broadband') || dt.includes('mifi')) return 'hotspots';
    if (dt.includes('watch') || dt.includes('wearable')) return 'watches';
    return 'other';
  }

  /**
   * Build per-cycle snapshots of totals + line counts + inventory mix.
   * @param {Object} profiles  — profile dict from ATTParser
   * @param {Object} billByCycle — {cycleDate: {totalCurrent, monthlyCharges, activity, taxes, fees}}
   */
  function buildSnapshots(profiles, billByCycle) {
    // Verizon cycle keys ("Jan 31, 2026") sort wrong alphabetically — Feb beats
    // Jan beats Mar. Sort by the parsed Date so cycles always run oldest→newest
    // regardless of label format.
    const cycleKeys = Object.keys(billByCycle || {}).sort((a, b) => {
      const da = parseCycleDate(a);
      const db = parseCycleDate(b);
      if (da && db) return da.getTime() - db.getTime();
      return String(a).localeCompare(String(b));
    });
    const snapshots = [];

    for (const cycle of cycleKeys) {
      const cycleTotals = billByCycle[cycle];
      // Count lines active in this cycle = lines that have a billing row in that cycle.
      const activeLines = [];
      const inventory = { smartphones: 0, tablets: 0, hotspots: 0, watches: 0, other: 0, total: 0 };

      for (const p of Object.values(profiles)) {
        if (p.billingCycles && p.billingCycles[cycle]) {
          activeLines.push(p);
          inventory[classifyDeviceType(p)]++;
          inventory.total++;
        }
      }

      snapshots.push({
        cycle,
        cycleDate: parseCycleDate(cycle),
        monthLabel: monthLabel(cycle),
        rangeLabel: rangeLabel(cycle),
        bill: {
          total:      cycleTotals.totalCurrent || 0,
          plan:       cycleTotals.monthlyCharges || 0,
          activity:   cycleTotals.activity || 0,
          taxes:      cycleTotals.taxes || 0,
          surcharges: cycleTotals.fees || 0,
        },
        lineCount: activeLines.length,
        inventory,
        activeWirelessSet: new Set(activeLines.map(p => p.wireless)),
      });
    }

    return snapshots;
  }

  /**
   * For each cycle transition (cycle N vs cycle N-1), build a delta report.
   * The earliest cycle has no prior so its delta is null.
   */
  function buildDeltas(profiles, snapshots) {
    const deltas = [];

    for (let i = 0; i < snapshots.length; i++) {
      const curr = snapshots[i];
      const prev = i > 0 ? snapshots[i - 1] : null;

      if (!prev) {
        deltas.push({ cycle: curr.cycle, monthLabel: curr.monthLabel, isFirst: true });
        continue;
      }

      // ── Line additions / cancellations based on set membership ────────────
      const rawAdded = [];
      const rawCancelled = [];

      for (const wn of curr.activeWirelessSet) {
        if (!prev.activeWirelessSet.has(wn)) rawAdded.push(profiles[wn]);
      }
      for (const wn of prev.activeWirelessSet) {
        if (!curr.activeWirelessSet.has(wn)) {
          const p = profiles[wn] || { wireless: wn };
          rawCancelled.push(p);
        }
      }
      // Also sweep: any profile marked Cancelled in the inventory snapshot that
      // WAS billed in the prior cycle but isn't now — treat as cancelled too.
      for (const p of Object.values(profiles)) {
        if ((p.status || '').toLowerCase() === 'cancelled' &&
            prev.activeWirelessSet.has(p.wireless) &&
            !curr.activeWirelessSet.has(p.wireless) &&
            !rawCancelled.find(x => x.wireless === p.wireless)) {
          rawCancelled.push(p);
        }
      }

      // ── Port-in detection ─────────────────────────────────────────────────
      // If an "added" line and a "cancelled" line share the same IMEI (best)
      // or the same User Name (fallback), it's almost certainly a number
      // change, not a pure add+cxl. Pull them out into a `portIns` bucket.
      const portIns = [];
      const added = [];
      const cancelled = rawCancelled.slice();

      for (const a of rawAdded) {
        let matchIdx = -1;
        if (a.deviceIMEI) {
          matchIdx = cancelled.findIndex(c => c.deviceIMEI && c.deviceIMEI === a.deviceIMEI);
        }
        if (matchIdx < 0 && a.userName) {
          matchIdx = cancelled.findIndex(c => c.userName && c.userName === a.userName);
        }
        if (matchIdx >= 0) {
          const c = cancelled.splice(matchIdx, 1)[0];
          portIns.push({
            oldWireless: c.wireless,
            newWireless: a.wireless,
            userName: a.userName || c.userName,
            deviceIMEI: a.deviceIMEI || c.deviceIMEI,
            reason: a.deviceIMEI && c.deviceIMEI && a.deviceIMEI === c.deviceIMEI
                      ? 'matching IMEI'
                      : 'matching user name',
          });
        } else {
          added.push({
            wireless: a.wireless,
            userName: a.userName || '',
            deviceType: a.deviceType || '',
            ratePlan: a.ratePlan || '',
            activationDate: a.activationDate || '',
          });
        }
      }

      const cancelledFinal = cancelled.map(p => ({
        wireless: p.wireless,
        userName: p.userName || '',
        deviceType: p.deviceType || '',
        status: p.status || '',
        reason: (p.status || '').toLowerCase() === 'cancelled'
                  ? 'marked Cancelled in inventory'
                  : 'billed last cycle, missing this cycle',
      }));

      // ── Suspended lines in this cycle ──────────────────────────────────────
      const suspended = [];
      for (const wn of curr.activeWirelessSet) {
        const p = profiles[wn];
        if (p && (p.status || '').toLowerCase() === 'suspended') {
          suspended.push({
            wireless: p.wireless,
            userName: p.userName || '',
            deviceType: p.deviceType || '',
          });
        }
      }

      // ── Device upgrades ───────────────────────────────────────────────────
      // AT&T inventory is a single snapshot so we can't compare IMEIs across
      // cycles. Instead: flag a line as "upgraded this cycle" when lastUpgradeDate
      // falls inside the cycle window (curr.cycleDate - 30d .. curr.cycleDate).
      const upgrades = [];
      if (curr.cycleDate) {
        const windowEnd = curr.cycleDate.getTime();
        const windowStart = windowEnd - 30 * 24 * 60 * 60 * 1000;
        for (const wn of curr.activeWirelessSet) {
          const p = profiles[wn];
          if (!p || !p.lastUpgradeDate) continue;
          const up = parseCycleDate(p.lastUpgradeDate);
          if (up && up.getTime() >= windowStart && up.getTime() <= windowEnd) {
            upgrades.push({
              wireless: p.wireless,
              userName: p.userName || '',
              lastUpgradeDate: p.lastUpgradeDate,
              deviceMake: p.deviceMake || '',
              deviceModel: p.deviceModel || '',
            });
          }
        }
      }

      // ── Rate plan changes ─────────────────────────────────────────────────
      const planChanges = [];
      for (const wn of curr.activeWirelessSet) {
        if (!prev.activeWirelessSet.has(wn)) continue; // only lines in both cycles
        const p = profiles[wn];
        if (!p || !p.billingCycles) continue;
        const currPlan = (p.billingCycles[curr.cycle] || {}).ratePlan;
        const prevPlan = (p.billingCycles[prev.cycle] || {}).ratePlan;
        if (currPlan && prevPlan && currPlan !== prevPlan) {
          planChanges.push({
            wireless: p.wireless,
            userName: p.userName || '',
            fromPlan: prevPlan,
            toPlan: currPlan,
          });
        }
      }

      // ── Activity / charge anomalies ───────────────────────────────────────
      // Flag lines whose total-charge delta between cycles exceeds 50% AND
      // $25 absolute. Hard threshold avoids noise on cheap lines but still
      // surfaces the $75 activity spike Stephen's Centric audit had.
      const anomalies = [];
      for (const wn of curr.activeWirelessSet) {
        if (!prev.activeWirelessSet.has(wn)) continue;
        const p = profiles[wn];
        if (!p || !p.billingCycles) continue;
        const currTotal = (p.billingCycles[curr.cycle] || {}).totalCurrent || 0;
        const prevTotal = (p.billingCycles[prev.cycle] || {}).totalCurrent || 0;
        const diff = currTotal - prevTotal;
        if (prevTotal > 0 && Math.abs(diff) >= 25 && Math.abs(diff) >= prevTotal * 0.5) {
          anomalies.push({
            wireless: p.wireless,
            userName: p.userName || '',
            prevTotal, currTotal, diff,
            direction: diff > 0 ? 'increase' : 'decrease',
          });
        }
      }

      // ── Rate plan migration rollup: count moves between plan names ────────
      const planMigrationMap = {};
      for (const pc of planChanges) {
        const key = pc.fromPlan + ' → ' + pc.toPlan;
        planMigrationMap[key] = (planMigrationMap[key] || 0) + 1;
      }
      const planMigrations = Object.entries(planMigrationMap)
        .map(([key, count]) => {
          const [fromPlan, toPlan] = key.split(' → ');
          return { fromPlan, toPlan, count };
        })
        .sort((a, b) => b.count - a.count);

      deltas.push({
        cycle: curr.cycle,
        monthLabel: curr.monthLabel,
        rangeLabel: curr.rangeLabel,
        prevCycle: prev.cycle,
        prevMonthLabel: prev.monthLabel,
        isFirst: false,
        billDelta: curr.bill.total - prev.bill.total,
        lineCountDelta: curr.lineCount - prev.lineCount,
        added,
        cancelled: cancelledFinal,
        suspended,
        upgrades,
        planChanges,
        planMigrations,
        portIns,
        anomalies,
      });
    }

    return deltas;
  }

  function analyze(profiles, meta) {
    const billByCycle = (meta && meta.billByCycle) || {};
    const snapshots = buildSnapshots(profiles, billByCycle);
    const deltas = buildDeltas(profiles, snapshots);
    return {
      snapshots,
      deltas,
      cycleCount: snapshots.length,
      // Helper: map cycle → snapshot for O(1) dashboard lookups.
      byCycle: Object.fromEntries(snapshots.map(s => [s.cycle, s])),
    };
  }

  return { analyze, monthLabel, rangeLabel, parseCycleDate };
})();
