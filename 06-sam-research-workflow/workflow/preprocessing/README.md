# SAM Data Preprocessing

This folder contains the deterministic three-stage preprocessing pipeline used after literature extraction and validation.

| Stage | Script | Input → output |
|---|---|---|
| 1 | `first_preprocessed_csv/first_preprocess.py` | reviewed XLSX → fixed 35-column CSV |
| 2 | `second_preprocessed_csv/second_preprocess.py` | stage-1 data → add 196 RDKit descriptors → 224-column ML table |
| 3 | `third_preprocessed_csv/third_preprocess.py` | stage-2 CSVs → merged, molecule-sorted, deduplicated 224-column dataset |

## Environment

From this `preprocessing/` folder:

```powershell
py -3.12 -m venv .venv
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Each stage also includes a Windows `.cmd` launcher using `preprocessing/.venv`.

## Stage 1 — reviewed XLSX to 35 columns

The source workbook uses the **35-column input schema** documented in [`first_preprocessed_csv/reference.xlsx`](first_preprocessed_csv/reference.xlsx). The workbook contains both a readable column list and a copyable template header, so the full schema does not need to be repeated here.

Quick use:

```powershell
.\first_preprocessed_csv\執行第一次前處理.cmd
```

Stage 1 checks the expected fields and applies the project rules for required values, solvent representation, composition handling, and row filtering. The source XLSX is not modified.

## Stage 2 — generate RDKit descriptors

Stage 2 starts from the stage-1 data, which contains the original literature/process fields. It then **calculates 196 RDKit molecular descriptors from the `smile` column** and constructs the ML table:

```text
smile + 196 generated RDKit descriptors + 26 process/device features + PCE
= 224 columns
```

Quick use:

```powershell
.\second_preprocessed_csv\執行第二次前處理.cmd
```

[`reference.csv`](reference.csv) is the **header-only schema of the final 224-column ML output**. The 196 descriptor columns shown there are outputs generated during Stage 2; they are not expected to exist in the original 35-column input workbook.

## Stage 3 — merge and deduplicate

Place the formal stage-2 outputs in `second_preprocessed_csv/csv/`, then run:

```powershell
.\third_preprocessed_csv\執行第三次前處理.cmd
```

Stage 3 canonicalizes SMILES for molecular-identity comparison, merges the datasets, removes only exact duplicate records, and reports same-feature / different-PCE conflicts instead of silently collapsing them.

## Key checks

- missing values are not silently imputed;
- RDKit descriptor failures leave descriptor cells blank rather than deleting the full row;
- retained source fields are checked after the CSV round trip;
- exact duplicates are removed only after molecular-identity comparison.
