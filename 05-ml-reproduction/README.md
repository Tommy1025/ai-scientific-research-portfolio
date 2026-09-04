# Perovskite Solar Cell ML Reproduction and Analysis

This section reproduces and extends the open-source machine-learning workflow associated with:

> Roberts et al., **“Machine Learning for Perovskite Solar Cells: An Open-Source Pipeline”**, *Advanced Physics Research* (2024). DOI: [10.1002/apxr.202400060](https://doi.org/10.1002/apxr.202400060)

The starting implementation is the public [`linphotonicslab/ML_Pipeline`](https://github.com/linphotonicslab/ML_Pipeline) repository by Nick Roberts and Dylan Jones. The paper PDF itself is not copied into this portfolio.

## Scope and Contribution Boundary

This is a **reproduction and extension project**, not a claim that I designed the original preprocessing pipeline or ML architectures. I reproduced the GP, NN, and XGBoost workflows in my own environment, reran the model searches/evaluations, and compared the reproduced behavior with the publication.

The main extension work is in **`notebooks/xg_optuna.ipynb`**: after reproducing the XGBoost workflow, I added residual diagnostics, feature importance, SHAP, partial-dependence analysis, and inverse scaling from standardized features back to physical/process values so the model output could be connected to experimentally meaningful conditions.

### File-by-file attribution

| File | Upstream basis | My contribution / status |
|---|---|---|
| `scripts/create_data.py` | Derived from the upstream preprocessing script by Dylan Jones and Nick Roberts | I adapted project-relative path handling and added export of `scaler_info.csv` (`Feature`, `Mean`, `Std`) for later inverse scaling. The broader cleaning and feature-engineering pipeline remains upstream work. |
| `scripts/split_data.py` | Upstream train / validation / test splitting script | Used unchanged as part of the reproduction; I do **not** claim this script as my implementation. |
| `notebooks/gp_optuna.ipynb` | Upstream Gaussian Process + Optuna workflow | Independent rerun, environment adaptation, and evaluation. The GP method and search strategy remain upstream work. |
| `notebooks/nn_optuna.ipynb` | Derived from the upstream PyTorch NN + Optuna workflow | I modified the reproduced workflow for device handling, feature scaling, tensor-shape handling, training/search settings, and evaluation. The overall NN/Optuna design remains upstream. |
| `notebooks/xg_optuna.ipynb` | Derived from the upstream XGBoost + Optuna workflow | **Primary extension:** independent optimization/evaluation plus residual analysis, feature importance, SHAP, PDP, and conversion of standardized inputs back to physical/process values. |
| `REPRODUCTION_RESULTS.md` | Publication used as comparison baseline | My reproduction record; published and reproduced values are explicitly separated. |
| `LICENSE` | Upstream MIT License | Preserved from upstream; not my work. |

The portfolio notebooks are cleaned for readability and current execution, including removal of old outputs/metadata and selected runtime-facing compatibility changes. Those packaging edits are separate from the scientific contributions above.

## Repository Structure

```text
05-ml-reproduction/
├── README.md
├── REPRODUCTION_RESULTS.md
├── LICENSE
├── requirements.txt
├── notebooks/
│   ├── gp_optuna.ipynb
│   ├── nn_optuna.ipynb
│   └── xg_optuna.ipynb
├── scripts/
│   ├── create_data.py
│   └── split_data.py
└── data/
    ├── raw/
    ├── cleaned/
    └── predictions/
```

## Data

CSV datasets and generated prediction files are **not committed to this portfolio**. They are inputs/intermediate outputs of the reproduced pipeline rather than the main portfolio artifact.

To run the reproduced workflows, use the [`data.zip`](https://github.com/linphotonicslab/ML_Pipeline/blob/main/data.zip) supplied by the original authors in the upstream [`linphotonicslab/ML_Pipeline`](https://github.com/linphotonicslab/ML_Pipeline) repository, then extract the data into the corresponding `data/` directory structure used by this project.

## Setup

Python 3.10 is the baseline used for the portfolio notebooks.

```bash
python -m venv .venv
pip install -r requirements.txt
```

## Usage

If you want to rerun preprocessing, the upstream `split_data.py` uses paths relative to its current working directory, so run the preprocessing stage from `scripts/`:

```bash
cd 05-ml-reproduction/scripts
python create_data.py
python split_data.py
```

When `split_data.py` asks for the target column, use:

```text
JV_default_Jsc
```

Then execute the desired notebook under `notebooks/`:

- `gp_optuna.ipynb` — Gaussian Process reproduction;
- `nn_optuna.ipynb` — modified Neural Network reproduction;
- `xg_optuna.ipynb` — XGBoost reproduction plus the main diagnostic / scientific-interpretation extensions.

## Reproduction Interpretation

An independent Optuna run does not necessarily recover the same hyperparameters as the publication. I therefore compared both numerical metrics and qualitative model behavior rather than defining reproducibility as an identical parameter set.

The recorded XGBoost comparison is summarized in [`REPRODUCTION_RESULTS.md`](REPRODUCTION_RESULTS.md).

## License and Attribution

The upstream `ML_Pipeline` repository is distributed under the **MIT License**. Its license is preserved in this directory as [`LICENSE`](LICENSE), and files derived from that implementation remain subject to the upstream license.

Repository-wide contribution boundaries are summarized in [`CONTRIBUTIONS.md`](../CONTRIBUTIONS.md), with third-party sources and licensing information in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).
