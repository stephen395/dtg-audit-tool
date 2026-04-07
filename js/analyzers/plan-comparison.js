/**
 * Plan Comparison Module
 * Interactive rate plan comparison: current vs proposed plans per line.
 * Mirrors the Google Sheet "Rate Plan Comparison" tab logic.
 *
 * Usage:
 *   window.PlanComparison.populate(profiles)  — build the interactive table
 *   window.PlanComparison.getProposals()      — returns array of {wireless, userName, currentPlan, currentMRC, proposedPlan, proposedMRC, savings}
 *   window.PlanComparison.getSummary()        — returns {currentTotal, proposedTotal, monthlySavings, annualSavings}
 */

window.PlanComparison = (function () {

  let lines = []; // [{wireless, userName, currentPlan, currentMRC}]

  function fmtMoney(val) {
    if (val == null || isNaN(val)) return '$0.00';
    if (Math.abs(val) >= 1000) return '$' + Math.round(val).toLocaleString();
    return '$' + val.toFixed(2);
  }

  // ── Populate the table from audit profiles ──
  function populate(profiles) {
    lines = [];
    const sorted = Object.values(profiles).sort((a, b) => {
      const planA = (a.ratePlan || '').toLowerCase();
      const planB = (b.ratePlan || '').toLowerCase();
      if (planA < planB) return -1;
      if (planA > planB) return 1;
      return (b.mrc || b.latestMonthly || 0) - (a.mrc || a.latestMonthly || 0);
    });

    for (const p of sorted) {
      lines.push({
        wireless: p.wireless,
        userName: p.userName || '',
        currentPlan: p.ratePlan || '',
        currentMRC: p.mrc || p.latestMonthly || 0,
      });
    }

    renderTable();
    wireEvents();
    recalcTotals();
  }

  function renderTable() {
    const tbody = document.getElementById('plan-comp-tbody');
    const emptyEl = document.getElementById('plan-comp-empty');
    if (!tbody) return;

    if (lines.length === 0) {
      tbody.innerHTML = '';
      if (emptyEl) emptyEl.classList.remove('hidden');
      return;
    }
    if (emptyEl) emptyEl.classList.add('hidden');

    let html = '';
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      html += `<tr data-idx="${i}">
        <td style="text-align:center"><input type="checkbox" class="plan-comp-row-check" data-idx="${i}"></td>
        <td style="font-variant-numeric:tabular-nums">${l.wireless}</td>
        <td>${l.userName}</td>
        <td title="${l.currentPlan}" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l.currentPlan}</td>
        <td class="number" style="font-variant-numeric:tabular-nums">${fmtMoney(l.currentMRC)}</td>
        <td class="plan-comp-proposed-col"><input type="text" class="plan-comp-input plan-comp-prop-plan" data-idx="${i}" placeholder="New plan name"></td>
        <td class="plan-comp-proposed-col number"><input type="number" class="plan-comp-input plan-comp-prop-mrc" data-idx="${i}" placeholder="0.00" step="0.01" min="0"></td>
        <td class="number plan-comp-line-savings" data-idx="${i}" style="font-variant-numeric:tabular-nums">—</td>
      </tr>`;
    }

    tbody.innerHTML = html;
  }

  function wireEvents() {
    // MRC input change → recalc
    document.querySelectorAll('.plan-comp-prop-mrc').forEach(input => {
      input.addEventListener('input', recalcTotals);
    });

    // Select all checkbox
    const selectAll = document.getElementById('plan-comp-select-all');
    if (selectAll) {
      selectAll.addEventListener('change', () => {
        document.querySelectorAll('.plan-comp-row-check').forEach(cb => {
          cb.checked = selectAll.checked;
        });
      });
    }

    // Bulk apply to selected
    const bulkApplyBtn = document.getElementById('plan-comp-bulk-apply');
    if (bulkApplyBtn) {
      bulkApplyBtn.addEventListener('click', () => {
        const plan = document.getElementById('plan-comp-bulk-plan').value;
        const mrc = document.getElementById('plan-comp-bulk-mrc').value;
        applyToChecked(plan, mrc);
      });
    }

    // Bulk apply to all
    const bulkAllBtn = document.getElementById('plan-comp-bulk-all');
    if (bulkAllBtn) {
      bulkAllBtn.addEventListener('click', () => {
        const plan = document.getElementById('plan-comp-bulk-plan').value;
        const mrc = document.getElementById('plan-comp-bulk-mrc').value;
        applyToAll(plan, mrc);
      });
    }

    // Clear all
    const clearBtn = document.getElementById('plan-comp-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', clearAllProposals);
    }
  }

  function applyToChecked(plan, mrc) {
    document.querySelectorAll('.plan-comp-row-check:checked').forEach(cb => {
      const idx = cb.dataset.idx;
      if (plan) {
        const planInput = document.querySelector(`.plan-comp-prop-plan[data-idx="${idx}"]`);
        if (planInput) planInput.value = plan;
      }
      if (mrc !== '' && mrc != null) {
        const mrcInput = document.querySelector(`.plan-comp-prop-mrc[data-idx="${idx}"]`);
        if (mrcInput) mrcInput.value = mrc;
      }
    });
    recalcTotals();
  }

  function applyToAll(plan, mrc) {
    for (let i = 0; i < lines.length; i++) {
      if (plan) {
        const planInput = document.querySelector(`.plan-comp-prop-plan[data-idx="${i}"]`);
        if (planInput) planInput.value = plan;
      }
      if (mrc !== '' && mrc != null) {
        const mrcInput = document.querySelector(`.plan-comp-prop-mrc[data-idx="${i}"]`);
        if (mrcInput) mrcInput.value = mrc;
      }
    }
    recalcTotals();
  }

  function clearAllProposals() {
    document.querySelectorAll('.plan-comp-prop-plan').forEach(el => el.value = '');
    document.querySelectorAll('.plan-comp-prop-mrc').forEach(el => el.value = '');
    recalcTotals();
  }

  function recalcTotals() {
    let currentTotal = 0;
    let proposedTotal = 0;
    let proposedCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const currentMRC = lines[i].currentMRC || 0;
      currentTotal += currentMRC;

      const mrcInput = document.querySelector(`.plan-comp-prop-mrc[data-idx="${i}"]`);
      const savingsCell = document.querySelector(`.plan-comp-line-savings[data-idx="${i}"]`);
      const proposedMRC = mrcInput && mrcInput.value !== '' ? parseFloat(mrcInput.value) || 0 : null;

      if (proposedMRC !== null) {
        proposedTotal += proposedMRC;
        proposedCount++;
        const diff = currentMRC - proposedMRC;
        if (savingsCell) {
          savingsCell.textContent = fmtMoney(diff);
          savingsCell.className = 'number plan-comp-line-savings ' + (diff > 0 ? 'savings-positive' : diff < 0 ? 'savings-negative' : '');
        }
      } else {
        proposedTotal += currentMRC; // no change proposed
        if (savingsCell) {
          savingsCell.textContent = '—';
          savingsCell.className = 'number plan-comp-line-savings';
        }
      }
    }

    const monthlySavings = currentTotal - proposedTotal;
    const annualSavings = monthlySavings * 12;

    // Update banner
    const monthlyEl = document.getElementById('plan-comp-monthly-savings');
    const annualEl = document.getElementById('plan-comp-annual-savings');
    const currentEl = document.getElementById('plan-comp-current-total');
    const proposedEl = document.getElementById('plan-comp-proposed-total');

    if (monthlyEl) monthlyEl.textContent = fmtMoney(monthlySavings);
    if (annualEl) annualEl.textContent = fmtMoney(annualSavings);
    if (currentEl) currentEl.textContent = 'Current: ' + fmtMoney(currentTotal) + '/mo';
    if (proposedEl) proposedEl.textContent = 'Proposed: ' + fmtMoney(proposedTotal) + '/mo';

    // Update footer
    const footCurrent = document.getElementById('plan-comp-total-current-mrc');
    const footProposed = document.getElementById('plan-comp-total-proposed-mrc');
    const footSavings = document.getElementById('plan-comp-total-savings');

    if (footCurrent) footCurrent.textContent = fmtMoney(currentTotal);
    if (footProposed) footProposed.textContent = fmtMoney(proposedTotal);
    if (footSavings) {
      footSavings.textContent = fmtMoney(monthlySavings);
      footSavings.style.color = monthlySavings > 0 ? '#22c55e' : monthlySavings < 0 ? '#ef4444' : '';
    }
  }

  // ── Get proposals for export ──
  function getProposals() {
    const results = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const planInput = document.querySelector(`.plan-comp-prop-plan[data-idx="${i}"]`);
      const mrcInput = document.querySelector(`.plan-comp-prop-mrc[data-idx="${i}"]`);

      const proposedPlan = planInput ? planInput.value : '';
      const proposedMRC = mrcInput && mrcInput.value !== '' ? parseFloat(mrcInput.value) || 0 : null;

      results.push({
        wireless: l.wireless,
        userName: l.userName,
        currentPlan: l.currentPlan,
        currentMRC: l.currentMRC,
        proposedPlan: proposedPlan,
        proposedMRC: proposedMRC,
        savings: proposedMRC !== null ? l.currentMRC - proposedMRC : 0,
      });
    }
    return results;
  }

  function getSummary() {
    const proposals = getProposals();
    const currentTotal = proposals.reduce((s, p) => s + p.currentMRC, 0);
    const proposedTotal = proposals.reduce((s, p) => s + (p.proposedMRC !== null ? p.proposedMRC : p.currentMRC), 0);
    const monthlySavings = currentTotal - proposedTotal;
    return {
      currentTotal,
      proposedTotal,
      monthlySavings,
      annualSavings: monthlySavings * 12,
      linesChanged: proposals.filter(p => p.proposedMRC !== null).length,
      totalLines: proposals.length,
    };
  }

  return { populate, getProposals, getSummary };
})();
