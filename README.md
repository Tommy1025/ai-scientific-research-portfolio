# AI Scientific Research Portfolio

A portfolio of selected projects combining **artificial intelligence, scientific workflows, and physics-oriented applications**.

The repository focuses on runnable implementations, project structure, usage instructions, reproducibility, and clear attribution of original, adapted, collaborative, and third-party work.

## Project Index

### 03 — RAG and Agentic AI

[`03-rag-and-adk/`](03-rag-and-adk/) contains Google Agent Development Kit (ADK) projects, including:

- **NTNUPHY multi-tool agent** — a small tool-calling agent with weather, New York time, and NTNU Physics information tools.
- **Physics agent workflows** — two physics-oriented orchestration patterns:
  - a sequential literature/PDF → analysis → experiment-suggestion pipeline;
  - an iterative experiment-design → review → revision loop.

### 04 — Generative AI Course

[`04-generative-ai-course/`](04-generative-ai-course/) contains selected work from the TAICA course **Generative AI: Text and Image Synthesis Principles and Practice** (生成式 AI：文字與圖像生成的原理與實務), including:

- **Homework** — submitted notebook/PDF assignments with a compact HW1–HW14 index and execution notes. Week 8 had no homework assignment.
- **AI Tutor final project** — **全能 AI 家教**, an interactive tutoring system using the Groq API, LangChain, FAISS, Google Colab, and Gradio. It supports question answering, follow-up quiz/feedback interaction, PDF-based learning material, and a web-search fallback.

Historical Colab / Drive links inside some original submissions may be expired; repository copies are used where available. Project-level README files document any remaining differences that affect reproduction.

### 05 — ML Reproduction and Scientific Interpretation

[`05-ml-reproduction/`](05-ml-reproduction/) reproduces and extends the open-source perovskite-solar-cell ML workflow from Roberts et al. (2024), based on the public [`linphotonicslab/ML_Pipeline`](https://github.com/linphotonicslab/ML_Pipeline) project.

The **original preprocessing/model pipeline is not my implementation**. My work is the environment adaptation, independent rerunning and verification of the GP / NN / XGBoost workflows, selected NN debugging/modification, and additional XGBoost diagnostics / scientific interpretation. The section includes independent Optuna reruns, comparison against published results, residual analysis, feature importance, SHAP, partial dependence analysis, and inverse scaling back to physical/process values.

The publication is cited but its PDF is not redistributed. A file-by-file authorship boundary is provided in [`05-ml-reproduction/README.md`](05-ml-reproduction/README.md).

### 06 — AI-Assisted SAM Research Workflow

[`06-sam-research-workflow/`](06-sam-research-workflow/) presents the workflow I developed for literature-derived SAM dataset construction: a deterministic **PDF Collector**, a reusable extraction **Agent Skill**, the deployed **Model Output Comparator**, quantitative **ground-truth validation**, and a three-stage preprocessing pipeline that converts reviewed literature data into ML-ready features.

## Repository Structure

```text
ai-scientific-research-portfolio/
├── README.md
├── CONTRIBUTIONS.md
├── THIRD_PARTY_NOTICES.md
├── LICENSE
├── .gitignore
├── 03-rag-and-adk/
│   └── adk/
│       ├── ntnuphy-tool/
│       └── physics-agent-workflows/
├── 04-generative-ai-course/
│   ├── README.md
│   ├── homework/
│   └── ai-tutor-final-project/
├── 05-ml-reproduction/
│   ├── README.md
│   ├── REPRODUCTION_RESULTS.md
│   ├── LICENSE
│   ├── requirements.txt
│   ├── notebooks/
│   ├── scripts/
│   └── data/
└── 06-sam-research-workflow/
    ├── README.md
    ├── tools/
    │   ├── model-compare/
    │   └── pdf-collector/
    └── workflow/
        ├── extraction/
        ├── validation/
        └── preprocessing/
```

## Reproducibility

Projects that require dependencies provide a `requirements.txt`, notebook setup cells, or project-specific setup instructions. Project READMEs describe the environment variables or external services needed for execution when applicable.

For setup and execution instructions, follow the `README.md` inside the project you want to run.

## Attribution

Authorship and contribution scope are summarized in [`CONTRIBUTIONS.md`](CONTRIBUTIONS.md). Third-party projects, examples, documentation, models, services, and licenses are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## License

Unless a subdirectory or file states otherwise, this repository is distributed under the **Apache License 2.0**. Third-party components remain subject to their respective licenses and notices. Files derived from the upstream ML pipeline under `05-ml-reproduction/` are covered by the MIT License preserved in that directory.
