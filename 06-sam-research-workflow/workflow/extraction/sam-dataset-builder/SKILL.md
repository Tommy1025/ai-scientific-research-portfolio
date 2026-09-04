---
name: sam-dataset-builder
description: Extract structured p-i-n perovskite SAM device records from papers and Supporting Information for later validation and machine-learning use.
---

# SAM Dataset Builder

This Skill defines the literature-to-dataset procedure used in the SAM research workflow. The goal is to extract reproducible device records rather than produce free-form paper summaries.

## Core principles

1. **Do not guess.** If a value cannot be verified from the paper or SI, leave it missing and record the reason.
2. **Use source evidence.** Device values are tied to the paper, SI, table, figure, or method section from which they were extracted.
3. **One experimental configuration per row.** Controls, champion devices, different compositions, and different process conditions are kept as separate records when they represent distinct experiments.
4. **Preserve traceability.** Each record carries reference identity, extraction status, and notes used during review.
5. **Validate before downstream use.** Structured extraction is followed by rule-based checks, cross-model comparison, and ground-truth validation when reference data are available.

## Extraction workflow

```text
Reference / DOI identification
          ↓
Main paper + SI retrieval
          ↓
Study relevance screening
          ↓
Experimental-row definition
          ↓
Targeted evidence extraction
          ↓
Source / status / note recording
          ↓
Workbook checks
```

### 1. Identify and verify the source

Confirm the paper identity from DOI, title, authors, and publication metadata. The main paper and Supporting Information are treated as separate evidence sources and are matched back to the same publication before extraction.

### 2. Screen for usable device data

Extract only records relevant to the intended p-i-n perovskite device scope. A review article can be used to locate candidate papers, but experimental values are checked against the cited original paper or SI whenever possible.

### 3. Decide how many rows the paper contributes

Create separate rows for experimentally distinct configurations, such as:

- control versus SAM-treated devices;
- different SAM / HTL materials;
- different perovskite compositions;
- different concentrations or deposition conditions;
- other process changes that alter the modeled input features.

Do not duplicate a record simply because the same paper appears in more than one review source.

### 4. Extract the modeled fields

The workflow targets 26 process/device features plus PCE:

```text
NiO2
ethanol, toluene, IPA, THF, chlorobenzene, 2-Methoxyethanol, CH2CL2
concentration(mg/ml), wash, E
Cs, FA, MA, Pb, Sn, I, Br, CL
C60, BCP, PC60BM, PCBM, PC61BM, PEAI, ALD-SnO2
PCE
```

Additional columns such as material name, SMILES, DOI, author, journal, status, and notes are retained for traceability and validation.

`E` is defined as:

```text
E = HOMO_SAM - VBM_perovskite
```

Values based on a different physical definition are not substituted into this field.

### 5. Use targeted evidence retrieval

Search the relevant Methods, Experimental, device-fabrication, table, and figure sections first. If a process value is absent from the main text, check the SI. Numerical values taken from figures or derived from explicitly reported quantities are flagged so they can be distinguished from directly reported values.

### 6. Keep uncertainty explicit

A missing value is preferable to an unsupported estimate. Notes and status fields record why a value is missing, derived, inferred from an explicit process description, or requires later review.

## Composition and process rules

- Solvent columns describe the SAM / HTL deposition solution, not antisolvents or solvents used in unrelated device layers.
- Explicit solvent-mixture ratios are converted to fractions of the complete mixture.
- A-site and B-site values preserve the reported composition basis.
- X-site values are represented on the workflow's common I / Br / Cl basis and are not silently renormalized when the publication reports excess or deficient halide.
- Binary process fields are filled only when the fabrication description supports the state.

## Output and checks

The primary extraction artifact is an XLSX workbook because it can preserve source/status notes and review information. A CSV can be generated later for deterministic preprocessing.

Before an extraction batch is treated as complete, check:

- required column names and order;
- duplicate record identifiers;
- impossible or out-of-range values;
- solvent and composition consistency;
- PCE and binary-field validity;
- source/status completeness;
- accidental value changes outside the intended records.

The resulting workbook can then be compared across model outputs and evaluated against trusted reference data when available.