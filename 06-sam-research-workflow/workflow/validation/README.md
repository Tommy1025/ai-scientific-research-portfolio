# Ground-Truth Validation

Before expanding the SAM dataset, the AI-assisted literature extraction method was checked against the published dataset from Li et al., **“Machine Learning Accelerated Design of Self-Assembled Monolayers for High-Performance Perovskite Solar Cells”** (*J. Phys. Chem. Lett.*, 2026, DOI: [10.1021/acs.jpclett.6c00119](https://doi.org/10.1021/acs.jpclett.6c00119)). The published data are used here as ground truth for evaluating whether the extraction workflow can recover the same structured information.

The evaluation found **64 overlapping records** between the published data and the independently extracted data. Records were matched by the same paper and SAM material; repeated cases were resolved conservatively before field-level comparison.

## Result

Most structured process/device fields were recovered with high exact-match accuracy:

| Field group | Exact-match accuracy |
|---|---:|
| `NiO2` + `wash` | **100.0%** |
| 7 solvent fields | **99.8%** |
| B-site (`Pb`, `Sn`) | **100.0%** |
| X-site (`I`, `Br`, `CL`) | **100.0%** |
| ETL / interface fields | **97.5%** |
| A-site (`Cs`, `FA`, `MA`) | **93.8%** |

Therefore, the **95–100%** range applies to selected structured process/device field groups, not to every extracted field. A-site composition falls slightly below that range.

Several harder fields were substantially less reliable:

| Field | Precision | Recall | F1 |
|---|---:|---:|---:|
| SMILES | **69.2%** | **42.2%** | **52.4%** |
| `concentration(mg/ml)` | **35.1%** | **31.3%** | **33.1%** |
| `E` | **87.0%** | **33.3%** | **48.2%** |

For SMILES, molecular identity is compared after RDKit canonicalization rather than by raw text alone. These results show that the workflow is reliable for many structured fabrication/device fields, while molecular structure and some derived or sparsely reported quantities still require additional verification.

The evaluation logic is retained in [`evaluate_ground_truth.py`](evaluate_ground_truth.py).
