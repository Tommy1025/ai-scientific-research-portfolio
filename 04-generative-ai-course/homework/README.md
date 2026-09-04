# Homework

Homework submissions from the TAICA course **Generative AI: Text and Image Synthesis Principles and Practice**.

This directory contains my submitted PDF reports and, where applicable, the `.ipynb` notebooks used for the assignments. Not every homework produced a notebook. Instructor lecture files, third-party reference PDFs, and unmodified official / TA demo notebooks are excluded.

## Quick Index

| HW | Topic | Main tools / idea | Submission format |
|---|---|---|---|
| HW1 | Butterfly curve visualization | NumPy, Pandas, Matplotlib | Notebook + PDF |
| HW2 | Handwritten digit recognition | MNIST, TensorFlow/Keras, Gradio | Notebook + PDF |
| HW3 | Softmax visualization | Softmax behavior and interactive visualization | Notebook + PDF |
| HW4 | LLM response comparison | Compare ChatGPT, Claude, and Gemini on an ESR experimental-method writing task | PDF |
| HW5 | Prompt engineering | System, role, and contextual prompting for a Zeeman-effect experimental report | PDF |
| HW6 | Persona chatbot / “nonsense generator” | Mistral, `aisuite`, Gradio | Notebook + PDF |
| HW7 | Retrieval-Augmented Generation (RAG) | EmbeddingGemma, FAISS, LangChain, Groq | 2 notebooks + PDF |
| HW8 | No homework | Week 8 had no homework assignment | — |
| HW9 | Reflection-style AI agent | Code writer → reviewer → revision workflow | Notebook + PDF |
| HW10 | Bing image-generation prompts | Text-to-image prompt experiments | PDF |
| HW11 | Fooocus image generation | Image generation using the official Fooocus environment | PDF |
| HW12 | AI Tutor proposal | RAG, quiz flow, visualization, and calendar-integration concept | PDF |
| HW13 | Nano Banana + Fooocus | Physics-themed image generation and refinement | PDF |
| HW14 | NotebookLM for physics study | Multi-document, source-grounded study workflow | PDF |

## Setup and Usage

Most notebook assignments were developed in **Google Colab**. For homework that includes an `.ipynb`, open the repository copy in Colab, run the setup cells first, and then execute the remaining cells in order. Required packages are installed inside the individual notebooks; there is no shared course-level `requirements.txt`.

### API / Secret requirements

Add external API credentials through **Colab → Secrets** using the name expected by the notebook:

| HW | Colab Secret | Purpose |
|---|---|---|
| HW6 | `Mistral` | Mistral API used through `aisuite` |
| HW7 | `HuggingFace` | Hugging Face access for the embedding model |
| HW7 | `Groq` | Groq-hosted LLM used by the RAG application |
| HW9 | `Groq` | Groq-hosted model used by the writer/reviewer agents |

HW1–HW3 do not require an external API key. HW2 downloads MNIST through TensorFlow/Keras when needed.

### HW7 external files

HW7 is split into two notebooks:

- **RAG (1)** builds the vector database from user-supplied `.txt`, `.pdf`, or `.docx` files.
- **RAG (2)** loads the resulting FAISS database and runs the RAG application.

The original HW7 submission used a Google Drive shared archive for `faiss_db.zip`, but that shared file is no longer available. To run the repository version, first execute **RAG (1)** to generate `faiss_db.zip`, then upload that archive when **RAG (2)** requests it.

### Historical links in submitted PDFs

Some original submitted PDFs contain Colab / Google Drive sharing links that have since expired. The PDFs are preserved as the original submissions; use the `.ipynb` files in this repository when a notebook version is available.

### PDF-only assignments

HW4, HW5, and HW10–HW14 are primarily report / experiment submissions rather than standalone executable programs. Their PDFs are the primary artifacts.

HW11 used the **official Fooocus notebook** as the image-generation environment. That upstream notebook is not included as my implementation; the submitted PDF records my generated results.

## Attribution

These files are course submissions. Course context and third-party tools/models are documented in the repository-level [`CONTRIBUTIONS.md`](../../CONTRIBUTIONS.md) and [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md).
