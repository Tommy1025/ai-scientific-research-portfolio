# Third-Party Notices

This repository includes or adapts material from third-party open-source projects and documentation. Those components remain subject to their original licenses and terms.

## Google Agent Development Kit (ADK)

**Project:** Google Agent Development Kit for Python  
**Upstream:** https://github.com/google/adk-python  
**Documentation:** https://github.com/google/adk-docs  
**License:** Apache License 2.0

Google ADK provides the framework used by the projects under `03-rag-and-adk/adk/`.

The `ntnuphy-tool` project is adapted from the official Python quickstart / multi-tool example, including the basic weather and New York time tool pattern. The portfolio version adds an NTNU Physics information tool and related agent configuration changes.

Official quickstart documentation and examples:

- https://google.github.io/adk-docs/get-started/quickstart/
- https://github.com/google/adk-docs/tree/main/examples/python/snippets/get-started/multi_tool_agent

Google's ADK Python implementation and ADK documentation repositories are distributed under the Apache License 2.0. The full Apache License 2.0 text is provided in this repository's root `LICENSE` file.

## TAICA Generative AI Course

**Course:** 生成式 AI：文字與圖像生成的原理與實務  
**English title:** Generative AI: Text and Image Synthesis Principles and Practice  
**Lead institution:** National Chengchi University (NCCU)  
**Instructor:** Tsai Yen-Lung (蔡炎龍)  
**Official syllabus:** https://newdoc.nccu.edu.tw/teaschm/1132/schmPrv.jsp-yy=113&smt=2&num=701889&gop=00&s=1.html

The `04-generative-ai-course/` section contains my submitted homework and final-project work. Instructor lecture PDFs, unrelated third-party reference files, and unmodified official / TA demonstration notebooks are not redistributed as my work.

### Fooocus — HW11 execution environment

HW11 used the official Fooocus Colab / software environment to generate images.

**Upstream:** https://github.com/lllyasviel/Fooocus  
**License:** GNU General Public License v3.0 (GPL-3.0)

## AI Tutor Final Project Dependencies and Services

The AI Tutor project uses third-party models, services, and software including:

- Groq API / inference service;
- `llama-3.3-70b-versatile` in the original submitted project;
- `openai/gpt-oss-120b` in the current repository runtime;
- LangChain;
- Gradio;
- FAISS;
- `sentence-transformers/all-MiniLM-L6-v2`;
- Google Colab as the original notebook execution environment.

The submitted presentation/demo reflects the original Llama model, while the current notebook uses GPT-OSS 120B for reproduction. Third-party models and hosted services remain subject to their own licenses, usage policies, and service terms.

## Perovskite ML Pipeline

**Project:** [`linphotonicslab/ML_Pipeline`](https://github.com/linphotonicslab/ML_Pipeline)  
**Authors listed by upstream:** Nick Roberts and Dylan Jones  
**License:** MIT License

The material under `05-ml-reproduction/` reproduces and extends this public pipeline. The upstream project provides the preprocessing, dataset-splitting, GP, NN, XGBoost, and Optuna-based workflow used as the methodological/code basis of the portfolio reproduction.

The upstream MIT license is preserved as `05-ml-reproduction/LICENSE` and applies to files derived from the upstream implementation.

Associated publication:

- Roberts et al., **“Machine Learning for Perovskite Solar Cells: An Open-Source Pipeline”**, *Advanced Physics Research* (2024), DOI: [10.1002/apxr.202400060](https://doi.org/10.1002/apxr.202400060)

The source workflow uses data from the [Perovskite Database Project](https://www.perovskitedatabase.com/). Dataset access and reuse remain subject to the terms and citation requirements of the database and its associated publications.

## SAM Research Reference Data

**Reference repository:** [`Haifeng-Li-ML/SAM-ML`](https://github.com/Haifeng-Li-ML/SAM-ML)  
**Associated publication:** Li et al., **“Machine Learning Accelerated Design of Self-Assembled Monolayers for High-Performance Perovskite Solar Cells”**, *The Journal of Physical Chemistry Letters* (2026), DOI: [10.1021/acs.jpclett.6c00119](https://doi.org/10.1021/acs.jpclett.6c00119)

The published SAM data are used as reference ground truth for evaluating the literature-extraction workflow.

The Model Output Comparator uses third-party JavaScript/TypeScript packages including Next.js, React, SheetJS (`xlsx`), Tailwind CSS, and Cloudflare deployment tooling. Those dependencies remain subject to their respective upstream licenses and terms.

## PDF Collector Services and Dependencies

The PDF Collector can use third-party literature services and repositories including Crossref, Unpaywall, OpenAlex, CORE, Semantic Scholar, Europe PMC, and Figshare, with optional integrations for publisher/institutional services such as Wiley TDM, Elsevier, Springer Nature, LibKey, and GetFTR when valid access is available.

Its Node.js dependencies are listed in `06-sam-research-workflow/tools/pdf-collector/package.json`; they include Express, Playwright, Cheerio, PDF-processing/archive libraries, ExcelJS, and other supporting packages. Each external service and package remains subject to its own terms and license.

## SAM Preprocessing Dependencies

The preprocessing scripts under `06-sam-research-workflow/workflow/preprocessing/` use RDKit, pandas, NumPy, and openpyxl. RDKit provides molecular parsing, canonical SMILES generation, and the molecular descriptors used in the second and third preprocessing stages.

## Python Dependencies

Individual projects may depend on third-party Python packages such as Google ADK, Google Gen AI SDK, `pypdf`, `python-dotenv`, LangChain, Gradio, `aisuite`, FAISS, NumPy, pandas, SciPy, Matplotlib, scikit-learn, PyTorch, XGBoost, Optuna, SHAP, RDKit, and provider-specific SDKs. Installation through `requirements.txt` or notebook setup cells does not transfer ownership of those packages; each dependency remains governed by its own upstream license.
