# Reproduction Results

This note compares my reproduced XGBoost run with the results reported in Roberts et al., **“Machine Learning for Perovskite Solar Cells: An Open-Source Pipeline”** (*Advanced Physics Research*, 2024; DOI: [10.1002/apxr.202400060](https://doi.org/10.1002/apxr.202400060)).

## Contribution Boundary

The **paper values and original XGBoost/Optuna methodology are not my work**. They are used here as the reference baseline.

My work represented in this file is the independent rerun of the open-source workflow, recording the resulting hyperparameters and metrics, comparing them with the publication, and extending the reproduced model with additional diagnostic / interpretation analysis. The implementation provenance is described in [`README.md`](README.md).

## Hyperparameter Search

I reran the Optuna search instead of hard-coding the paper's final parameter set. The resulting best parameters therefore differ from the published set.

| Parameter | Published result | My reproduced run |
|---|---:|---:|
| `max_depth` | 8 | 14 |
| `learning_rate` | 0.325 | 0.0712 |
| `n_estimators` | 525 | 665 |
| `min_child_weight` | 6 | 5 |
| `gamma` | 6.15 × 10⁻⁵ | 1.10 × 10⁻⁷ |
| `subsample` | 0.89 | 0.710 |
| `colsample_bytree` | 0.73 | 0.707 |

The reproduced search used CMA-ES through Optuna for 50 trials. In the portfolio notebook, the sampler and XGBoost model use a fixed random seed where supported to make later reruns easier to audit; a fresh optimization can still return a different optimum.

## Prediction Metrics

### Test set

| Metric | Published result | My reproduced run |
|---|---:|---:|
| RMSE | 3.58 mA/cm² | 3.83 mA/cm² |
| R² | 0.35 | 0.36 |
| Adjusted MAPE | 9.49% | 9.00% |

The reproduced test-set metrics are close to the published values, especially R² and adjusted MAPE.

### Validation set

| Metric | Published result | My reproduced run |
|---|---:|---:|
| RMSE | 1.61 mA/cm² | 3.52 mA/cm² |
| R² | 0.87 | 0.36 |

The validation-set agreement is substantially weaker than the test-set agreement. I keep this discrepancy visible rather than presenting the exercise as an exact numerical replication.

## Reproduced Model Behavior

Using the reproduced model, I checked the prediction distribution, ordered predictions, parity behavior, and residual patterns. The main qualitative observations were:

- predicted values are less dispersed than the measured Jsc values;
- prediction error is larger toward the low and high ends of the Jsc range;
- the training set lies closer to the ideal prediction line than the test set;
- residual spread is largest in the low-Jsc region and smaller across much of the middle range.

These observations are reproduction findings from my rerun; the underlying model design remains the upstream implementation.

## My Additional Analysis

The main work that goes beyond rerunning the source workflow is concentrated in `notebooks/xg_optuna.ipynb`. I added:

- residual/error inspection beyond the basic performance metrics;
- XGBoost feature importance;
- SHAP-based feature interpretation;
- partial dependence plots (PDP) for important features;
- extraction of the highest-predicted test sample;
- inverse scaling from model-space standardized values back to physical/process values by using the scaler statistics exported during preprocessing.

For example, the inverse-scaling analysis allows quantities such as solvent ratios and annealing conditions to be reported in their original units rather than only as standardized Z-scores. This extension is intended to connect model interpretation back to experimentally meaningful variables; it is **not** part of the original paper's pipeline.

## Interpretation

The supported conclusion is narrower than “all published numbers were exactly recovered.” My independent XGBoost run produced comparable **test-set performance and similar broad prediction behavior**, while some validation metrics and optimized hyperparameters differed.

For this portfolio, the value of the exercise is therefore twofold: first, checking the reproducibility of an existing scientific ML pipeline; second, using the reproduced model as a basis for additional interpretation rather than presenting the upstream method as my own invention.
