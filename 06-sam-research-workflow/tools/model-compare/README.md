# SAM Model Output Comparator

Browser-based tool for comparing multiple SAM dataset extraction outputs and prioritizing records that need human review.

**Live site:** <https://sam-model-output-comparator.tommmmy1025.workers.dev>

## What it does

- imports multiple `.xlsx` / `.csv` outputs directly in the browser;
- compares records by reference, material identity, DOI, PCE, process and device fields;
- identifies missing records, numerical conflicts, DOI/identity conflicts and inclusion disagreements;
- applies rule-based checks and generates an adjudication queue for manual review.

Model agreement is a **review signal**, not ground truth. Accuracy still requires literature-based or manually verified reference data.

## Example outputs

`examples/reports/` contains representative CSV outputs from the comparison workflow:

- `skill-audit.csv` — rule-based audit findings;
- `record-gaps.csv` — records missing from one output;
- `ref-comparison-summary.csv` — reference-level comparison results;
- `adjudication-queue.csv` — conflicts prioritized for human review.

## Contribution

I designed and implemented the comparison, audit, and adjudication workflow as part of the SAM literature-data validation process.
