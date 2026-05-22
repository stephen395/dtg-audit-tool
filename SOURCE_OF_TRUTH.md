# Source-of-Truth Rule

This rule governs which uploaded file is authoritative for which data field. It is the most important data-handling principle in this tool and is enforced by `mergeProfiles()` in `js/app.js`.

## Required input

**The bill PDF is required to run an audit.** The Run Audit button is disabled until a bill PDF is uploaded, and `DTG.runAudit()` hard-stops if called without one. CSV alone is ~40% wrong/unknowable on financial detail (see "Why this exists" below) — running an audit without the bill would silently produce inaccurate output, so the tool refuses.

Usage / charges CSV is **recommended** (it's the authoritative source for usage and inventory — see the table below), but the audit will run on the bill PDF alone for small accounts.

**Up to 3 monthly bills can be uploaded** (one per cycle) for accurate **recurring vs one-time credit classification**:
- **3 cycles** → full cross-cycle classification: a credit description present in all 3 cycles is recurring; present in 1–2 is one-time. This is the highest-confidence mode.
- **2 cycles** → partial cross-cycle evidence; a credit must be in both to count as recurring.
- **1 cycle** → falls back to a description-pattern heuristic ("Credit for [plan name]" → recurring; "Discount for Plan Savings" → recurring; ad-hoc dollar credits → one-time). Less accurate but works with what's uploaded.

The **newest cycle** (by issue date) is used as the canonical bill for all financial values. Older cycles are read only to inform the credit recurrence classifier — they don't override the newest cycle's MRC, fees, or taxes.

## The Rule

When both a **bill PDF** and **CSV reports** are uploaded for the same account:

| Data category | Authoritative source | Why |
|---|---|---|
| MRC (Monthly Recurring Charge), plan name | **Bill PDF** | CSV plan/MRC heuristics are ~40% wrong (verified on Genserve 804-line Verizon Business account: 57% match, 10% silently wrong, 29% no parseable MRC at all — see `MY BIZ PLAN` trap). |
| Credits (per-line) — recurring AND one-time | **Bill PDF** | CSV typically shows only net `totalCurrent`; only the PDF breaks credits out by description with `Expires on` / `X of N` metadata. |
| Add-ons (5G UWB, Cloud, Mobile Protect, Hotspot, etc.) | **Bill PDF** | Same as credits — CSV merges these into the net total; the PDF itemizes them. |
| Promo details, expiration dates, "X of N" counters | **Bill PDF** | Only the PDF carries the installment counter and expiration metadata. |
| Equipment installment status, ETF, remaining balance | **Bill PDF** | The Device Promotion Credits table in the bill is the canonical source of installment counters and remaining balance. |
| Line status (Active / Suspended / Cancelled / Refund) | **Bill PDF** | CSV shows $0 monthly for any of these statuses with no way to distinguish; only the PDF has the explicit `Service suspended on <date>` notice and the `<plan> Refund` line item. |
| AutoPay / Paperless enrollment + unlock value | **Bill PDF** | The "Save $5.00 ... Auto Pay" notices and the account-level discount unlock total appear on the bill cover/summary, not the CSV. |
| Account-level credits, surcharges, taxes | **Bill PDF** | Bill is the legal artifact for these. |
| **Usage** — voice minutes, data MB/GB, SMS counts | **CSV** | CSV usage columns are the structured feed. The per-line usage logs in the bill PDF exist but are noisy and not meant to be the input to an audit. |
| Device inventory (make, model, IMEI, activation date) | **CSV** (device report) | The device report exposes this in one tabular dump. The bill PDF has it scattered across per-line detail pages. |
| Cost Center / UDL / Department Code at scale | **CSV** | Easier to filter for missing assignments across hundreds of lines. Use the bill PDF's "Charges by Cost Center" table as cross-check. |
| Carrier identity | **Bill PDF** (override) | If the PDF says AT&T but the user picked Verizon, the PDF wins. |

**Tie-break:** When PDF and CSV disagree on a financial figure → PDF wins. When they disagree on usage → CSV wins. Disagreements are logged so they surface in the Discrepancy view.

## What gets EXCLUDED from each source

Reading the bill PDF, **skip the per-line usage logs.** Those pages are noise for a financial audit and the CSV's structured usage columns are the authoritative source for usage data.

Reading the CSV, **everything except usage and inventory is second priority.** The CSV's plan, MRC, and credit columns are used to cross-check the bill, not to replace its figures.

## Why this exists (field-tested on Genserve)

Audit of a real 804-line Verizon Business account:

- **57%** of lines — CSV heuristic exactly matches PDF truth
- **10%** of lines — CSV heuristic gives a silently wrong breakdown (mixes credit vs add-on, misses proration, misclassifies suspended lines as zero-billed)
- **29%** of lines — CSV has no parseable MRC at all (e.g., `MY BIZ PLAN` says "Unlimited after allowance" — the $34 base rate is not in the CSV; only the bill PDF carries it)

The remaining 4% are edge cases (refund lines, cancelled mid-cycle, one-time-charge-only).

**Conclusion: for accurate per-line MRC/Credit/Add-on data, the bill PDF is required.** CSV alone is ~40% wrong or unknowable. This is the empirical basis for the rule above.

## How the merge is implemented

`mergeProfiles(csvProfiles, pdfProfiles)` in `js/app.js`:

1. For each wireless number present in both, copy PDF values for the financial fields and CSV values for the usage fields.
2. For PDF-only fields (not in CSV): copy from PDF.
3. For CSV-only fields (not in PDF): keep from CSV.
4. Tag each merged profile with `source: 'hybrid'` and attach `sourceMap: { fieldName: 'pdf' | 'csv' }`.
5. Detect discrepancies — e.g., PDF MRC=$50 but CSV MRC=$45 — and append to `meta.discrepancies` for the Discrepancy view to render.
6. The `zeroUsage` flag is recomputed from the CSV-authoritative usage fields after the merge (since the PDF's `zeroUsage` may have been derived from PDF's own usage extraction).

## Field-by-field source map (the contract)

Analyzers can read `profile.sourceMap[fieldName]` to know where a value came from. The expected source for each field, when both inputs are present:

```
mrc                     → pdf
ratePlan                → pdf
totalCharges            → pdf
activityCharges         → pdf
oneTimeCharges          → pdf
equipment               → pdf
equipmentName           → pdf
equipmentInstallment    → pdf (the "X of N" counter)
equipmentFinanced       → pdf
equipmentRemaining      → pdf
contractEnd             → pdf
contractType            → pdf
status                  → pdf  (Active/Suspended/Refund/Cancelled mid-cycle)
lineStatus              → pdf  (one of 7 patterns — see below)
hasActiveContract       → pdf
latestMrcItems          → pdf  (per-line credit/addon breakdown when available)
latestCreditsItemized   → pdf
latestAddonsItemized    → pdf
autoPay                 → pdf
paperless               → pdf

gbTotal                 → csv
minTotal                → csv
msgTotal                → csv
gbAvg, minAvg, msgAvg   → csv
zeroUsage               → csv  (recomputed from CSV usage after merge)
costCenter              → csv
userName                → csv (often) / pdf (fallback)
deviceType              → csv (often) / pdf (fallback)

ban                     → csv
carrier                 → pdf (overrides user selection if disagreement)
```

When only one source is present, that source supplies everything and `sourceMap` reflects it.

## Line status — 7 patterns (Genserve edge-case taxonomy)

`lineStatus` on each PDF profile is one of:

1. **`active-full-month`** — single Plan line item, full date range.
2. **`active-prorated`** — `New Plan` + `Month in Advance`, `(Includes proration)` flag.
3. **`active-with-credits`** — negative line items inside the Plan section (15% Off, recurring promo credits, etc.).
4. **`suspended`** — NO Monthly Charges section, just `Your Plan` + `Service suspended on <date>` notice. CSV shows $0 with no reason; only the PDF tells you.
5. **`refund`** — negative total, `<plan> Refund` line item, plan often "No Price Plan".
6. **`cancelled-mid-cycle`** — partial date range, line active only some days.
7. **`one-time-only`** — Monthly Charges $0 but Equipment Charges has activity.

A line classified as `suspended` with a known plan name participates in **plan-mode MRC substitution** for migration math (counts at peer rate, not $0).

## Validation checks (free, runs every audit)

1. **Sum-check vs Cost Center index.** The Charges by Cost Center table at the front of the bill states each line's Monthly Charges total. Parsed Plan + Credits + Add-ons must sum to it.
2. **Total Current Charges match.** Each per-line detail page ends with `Total Current Charges for <phone> $X.XX`. Parsed sub-sections must equal it.

Variance is reported per-line and aggregated in `meta.validation`. Lines with non-zero variance are flagged in the Discrepancy view.

## Adding a new analyzer

When adding a new analyzer:

- Declare which source you depend on at the top of the module: `// SOURCE: pdf-authoritative` or `// SOURCE: csv-authoritative` or `// SOURCE: hybrid`.
- Read the relevant fields directly off `profile.<field>`. The merge step already enforced the rule.
- If you need to defensively check, read `profile.sourceMap[field]` and assert.
- If you find yourself wanting CSV data for a financial figure when PDF is available — don't. The merge already picked the right value.
