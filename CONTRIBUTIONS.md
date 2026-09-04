# Contributions

This file distinguishes my own work from adapted examples, collaborative development, reproductions, and other third-party material included in this portfolio.

## 03 — RAG and Agentic AI

### NTNUPHY Multi-Tool Agent

**Type:** Adapted example / individual modification

**Starting point:** Google Agent Development Kit (ADK) Python quickstart / multi-tool example.

**My contribution:**

- added the `get_college()` tool for basic NTNU / NTNU Physics information;
- integrated the additional tool into the ADK agent's tool list.

The weather and New York time tools follow the structure of the Google ADK quickstart example and are not claimed as original implementations.

### Physics Agent Workflows

**Type:** Collaborative development

Two physics-oriented workflows are included:

1. **Sequential literature-to-experiment workflow** — a `SequentialAgent` pipeline that passes information through literature/PDF extraction, experimental analysis, and practical experiment suggestion stages.
2. **Iterative experiment-review workflow** — an initial experiment procedure is generated and then repeatedly reviewed and revised through a `LoopAgent`, with a stopping tool and iteration limit.

For the **sequential workflow**, my primary responsibility was the `PracticalSuggester` stage, which converts upstream analysis into practical experiment proposals. The other team members were primarily responsible for main-agent coordination/final aggregation, literature intake/search, and experimental-parameter analysis.

The physics workflow projects are presented as collaborative work rather than sole-authored implementations.

## 04 — Generative AI Course

### Course Homework

**Type:** Individual course submissions

The `homework/` directory contains the homework reports and, where relevant, notebooks that I submitted for the course. Not every assignment produced a notebook. Week 8 had no homework assignment.

Instructor lecture PDFs, third-party reference PDFs, and unmodified official / TA demonstration notebooks are not included as my work. HW11, for example, used the official Fooocus notebook as the image-generation environment; the portfolio includes my submitted result report rather than presenting that notebook as my implementation.

### AI Tutor Final Project

**Type:** Individual course final project

I developed **全能 AI 家教**, an interactive AI tutor that combines question answering with active assessment and feedback. The project uses the Groq API with LangChain and Gradio, supports PDF-based interaction, and includes a web-search fallback.

The implemented interaction includes learner question → AI explanation → AI-generated question → learner answer → AI evaluation / explanation. The project also supports uploaded PDFs as learning context.

Image generation was implemented and tested during development, then removed from the final tutoring workflow because the tested outputs were not sufficiently reliable for precise educational/scientific figures.

## 05 — Perovskite ML Reproduction and Analysis

**Type:** Individual reproduction and extension of an open-source research pipeline

**Starting point:** [`linphotonicslab/ML_Pipeline`](https://github.com/linphotonicslab/ML_Pipeline), associated with Roberts et al., *Machine Learning for Perovskite Solar Cells: An Open-Source Pipeline* (2024).

I did **not** create the original preprocessing/model pipeline. My work is the reproduction, environment adaptation, rerunning/verification of the GP, NN, and XGBoost workflows, plus selected modifications needed in the reproduced environment.

The main scientific extension is in **`xg_optuna.ipynb`**, where I added residual diagnostics, feature importance, SHAP, partial-dependence analysis, and inverse scaling back to physical/process values. Detailed file-by-file attribution is kept in [`05-ml-reproduction/README.md`](05-ml-reproduction/README.md) to avoid duplicating it here.

## 06 — AI-Assisted SAM Research Workflow

**Type:** Individual workflow/tooling contributions within a collaborative research project

My work includes:

- designing and iterating a reusable Agent Skill for structured SAM literature extraction;
- developing the browser-based **Model Output Comparator** for cross-model alignment, disagreement detection, rule-based audits, and adjudication;
- developing the non-LLM **PDF Collector** for reference-paper and Supporting Information retrieval;
- validating the AI-extracted data against a reference workbook, including a 64-record paired evaluation and field-level accuracy analysis;
- organizing the literature-to-ML pipeline into extraction, validation, and deterministic preprocessing stages;
- refining the three-stage preprocessing workflow used to convert reviewed extraction workbooks into ML-ready data.

Published literature and third-party reference datasets used by this workflow are cited in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Attribution Policy

For adapted, collaborative, reproduced, or course-based projects in this portfolio:

- upstream authors and sources are identified;
- upstream licenses are retained or referenced as required;
- modifications and extensions are distinguished from the original work;
- collaborative projects are not presented as sole-authored work;
- course-provided teaching material is separated from submitted student work.

See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for third-party sources and license information.
