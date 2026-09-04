import pypdf


def read_pdf(pdf_path: str, max_pages: int = 5) -> str:
    """Read text from the first `max_pages` pages of a PDF file."""
    try:
        reader = pypdf.PdfReader(pdf_path)
        text = ""
        total_pages = len(reader.pages)
        pages_to_read = min(total_pages, max_pages)

        for i in range(pages_to_read):
            page_text = reader.pages[i].extract_text()
            if page_text:
                text += page_text + "\n"

        if total_pages > max_pages:
            text += (
                f"\n\n[...Content Truncated. Read {max_pages}/{total_pages} "
                "pages for efficiency...]"
            )

        return text
    except Exception as e:
        return f"Error reading PDF: {str(e)}"
