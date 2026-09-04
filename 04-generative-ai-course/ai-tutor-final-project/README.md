# AI Tutor — Final Project

**全能 AI 家教** is the final project for the TAICA course **Generative AI: Text and Image Synthesis Principles and Practice** (生成式 AI：文字與圖像生成的原理與實務).

The system is designed around an active tutoring loop rather than one-turn question answering:

```text
Learner asks
    ↓
AI explains / answers
    ↓
AI generates a question
    ↓
Learner answers
    ↓
AI checks the answer and explains
```

## Main Functions

- **Question answering** — answers learner questions using the available knowledge source or connected information path.
- **Active quiz and feedback** — generates a related question, checks the learner's answer, and provides correction / explanation.
- **PDF-based learning** — accepts an uploaded PDF and uses the document as learning context.
- **Web-search fallback** — when no uploaded-document context is available, the implementation can retrieve short web-search context before falling back to model knowledge.

## Technology Stack

- **Inference:** Groq API
- **Current repository runtime model:** `openai/gpt-oss-120b`
- **Original submitted-project model:** `llama-3.3-70b-versatile`
- **Framework:** LangChain
- **Retrieval:** FAISS + `sentence-transformers/all-MiniLM-L6-v2`
- **Interface:** Gradio
- **Original environment:** Google Colab

### Model note

The submitted presentation and demo reflect the original project using `llama-3.3-70b-versatile`. The current repository notebook uses `openai/gpt-oss-120b` because the original model is not available to the Groq project/API key currently used for reproduction. The same Groq credential path is used, and the tutoring workflow remains the same.

## Project Materials

- **Demo video:** https://youtu.be/cQB-2IwO-dI
- **Presentation:** [`全能 AI 家教.pdf`](./全能%20AI%20家教.pdf)

The original Colab sharing URL shown in the submitted presentation is no longer available, so it is not listed here. The repository contains the notebook source directly.

## Setup and Usage

1. Open the repository notebook in **Google Colab**.
2. Run the setup cell.
3. Add a Groq API key through **Colab → Secrets** using the name `Groq`.
4. Run the remaining cells in order.
5. Launch the Gradio application.
6. Ask a question, continue with the quiz/feedback flow, or upload a PDF for document-based interaction.

Do not place a real API key directly in the notebook or repository.

## Image-Generation Design Decision

Image generation was tested during development but removed from the final tutoring workflow. Tests with scientific and educational figures showed problems such as inaccurate graphs, unreliable scientific illustrations, and poor Chinese-text rendering, so generated instructional images were not retained in the final system.

## Limitations

- LLM-generated explanations and answer evaluation can contain factual or reasoning errors.
- PDF-based responses depend on the content successfully extracted from the uploaded document.
- Web-search context can be incomplete or noisy and should not be treated as a verified academic source.
- External API and model availability can affect execution.

## Attribution and License

This is an individual course final project. Course context and contribution scope are documented in [`CONTRIBUTIONS.md`](../../CONTRIBUTIONS.md), and third-party models, APIs, frameworks, and course references are listed in [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md).

Unless otherwise stated, my original project files are covered by the repository's Apache License 2.0. Third-party models, services, libraries, and other materials remain subject to their original licenses and terms.
