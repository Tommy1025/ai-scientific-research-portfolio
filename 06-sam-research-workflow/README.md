# AI-Assisted SAM Research Workflow

This section presents the end-to-end workflow I developed for building literature-derived SAM datasets for perovskite-solar-cell machine learning: paper retrieval, structured AI extraction, quantitative validation, and deterministic preprocessing.

The project is based on the data framework reported by Li et al., **“Machine Learning Accelerated Design of Self-Assembled Monolayers for High-Performance Perovskite Solar Cells”** (*J. Phys. Chem. Lett.*, 2026, DOI: [10.1021/acs.jpclett.6c00119](https://doi.org/10.1021/acs.jpclett.6c00119)). Their study collected 108 SAM-device data points and retained 99 after filtering, using molecular descriptors together with 26 device/process parameters for ML analysis. Our work extends this direction toward a larger literature-derived dataset and broader downstream analysis. Before scaling the data collection, the extraction workflow is first evaluated against the published Li et al. dataset as a reference ground truth.

## Workflow

```text
Paper / SI retrieval
      ↓
Structured AI extraction
      ↓
Source / status traceability
      ↓
Cross-model comparison + ground-truth validation
      ↓
Rule-based preprocessing
      ↓
ML-ready data
```

## Components

### 1. Literature retrieval — PDF Collector

[`tools/pdf-collector/`](tools/pdf-collector/) retrieves reference papers and Supporting Information through academic APIs, repositories, publisher services, and an optional controlled browser fallback. It validates document identity and completeness instead of counting metadata or previews as successful retrievals.

### 2. Structured extraction — SAM Dataset Builder Skill

[`workflow/extraction/sam-dataset-builder/SKILL.md`](workflow/extraction/sam-dataset-builder/SKILL.md) defines a reusable agent workflow for extracting 26 process/device features plus PCE from papers and SI. It specifies evidence hierarchy, field definitions, missing-value handling, source/status tracking, and final checks.

### 3. Validation — Model Output Comparator + ground truth

[`tools/model-compare/`](tools/model-compare/) is the browser-based comparator I developed for aligning multiple extraction outputs, finding missing or conflicting records, applying rule-based audits, and producing an adjudication queue.

**Live comparator:** <https://sam-model-output-comparator.tommmmy1025.workers.dev>

A separate ground-truth evaluation is documented in [`workflow/validation/`](workflow/validation/). The published Li et al. data are used to test the extraction method before larger-scale collection. The evaluation contains **64 overlapping records**. Selected structured process/device groups reached **97.5–100% exact-match accuracy**; A-site composition was **93.8%**, while SMILES, concentration, and `E` were substantially less reliable and are reported separately with precision, recall, and F1.

Model agreement is therefore used as a review signal; accuracy is assessed independently against trusted reference data.

### 4. Deterministic preprocessing

[`workflow/preprocessing/`](workflow/preprocessing/) contains the three-stage preprocessing pipeline:

1. reviewed XLSX → fixed 35-column table;
2. calculate 196 RDKit molecular descriptors → 224-column ML table;
3. merge outputs, canonicalize SMILES for molecular identity, remove exact duplicates, and report same-feature / different-PCE conflicts.

The preprocessing folder includes a 35-column Stage-1 schema reference and the final 224-column output schema.

## Repository structure

```text
06-sam-research-workflow/
├── README.md
├── tools/
│   ├── model-compare/
│   └── pdf-collector/
└── workflow/
    ├── extraction/
    │   └── sam-dataset-builder/
    │       └── SKILL.md
    ├── validation/
    │   ├── README.md
    │   └── evaluate_ground_truth.py
    └── preprocessing/
        ├── README.md
        ├── requirements.txt
        ├── reference.csv
        ├── first_preprocessed_csv/
        │   └── reference.xlsx
        ├── second_preprocessed_csv/
        └── third_preprocessed_csv/
```

## My contribution

My work in this section focuses on building and refining the AI-assisted research workflow: the reusable extraction Skill, the Model Output Comparator, the PDF Collector, quantitative ground-truth evaluation, and the preprocessing pipeline that connects reviewed literature data to later ML analysis.

Repository-wide contribution details are summarized in [`CONTRIBUTIONS.md`](../CONTRIBUTIONS.md).
