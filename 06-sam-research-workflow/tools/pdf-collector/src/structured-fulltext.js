import * as cheerio from 'cheerio';
import { PLAYWRIGHT_BROWSERS_DIR } from './constants.js';
import { parsePdfBuffer } from './pdf.js';
import { normalizeDoi, sha256 } from './utils.js';

export const RECONSTRUCTION_GENERATOR = 'sam-reference-pdf-collector/0.7.0';

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function uniqueText(values, minimumLength = 1) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = cleanText(value);
    const key = text.toLowerCase();
    if (text.length < minimumLength || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

/**
 * Extracts the semantic article body from publisher JATS/XOCS XML or complete HTML.
 * Abstract/metadata-only payloads intentionally fail the body + bibliography gate.
 */
export function extractStructuredArticle(source, { contentType = '', doi = '' } = {}) {
  const text = Buffer.isBuffer(source) ? source.toString('utf8') : String(source || '');
  const xmlMode = /xml|jats/i.test(contentType) || /^\s*<\?xml/i.test(text);
  const $ = cheerio.load(text, { xmlMode });
  const title = cleanText($('article-title, ce\\:title, dc\\:title, h1, head title').first().text());
  const authors = uniqueText(
    $('contrib[contrib-type="author"], ce\\:author, meta[name="citation_author"]')
      .map((_, node) => $(node).attr('content') || $(node).text()).get(),
  );
  const bodyNodes = xmlMode
    ? $('body p, body sec > p, ce\\:sections ce\\:para, ce\\:section > ce\\:para, ce\\:para')
    : $('article p, main p, section p');
  const paragraphs = uniqueText(bodyNodes.map((_, node) => $(node).text()).get(), 20);
  const headings = uniqueText(
    $('body title, body sec > title, ce\\:section > ce\\:section-title, ce\\:section-title, article h2, main h2, section h2')
      .map((_, node) => $(node).text()).get(),
  );
  const references = uniqueText(
    $('ref-list ref, ref-list mixed-citation, ce\\:bibliography ce\\:bib-reference, ce\\:bib-reference, ol.references li')
      .map((_, node) => $(node).text()).get(),
    8,
  );
  const tables = uniqueText(
    $('table-wrap, ce\\:table, figure[type="table"]').map((_, node) => $(node).text()).get(),
    8,
  );
  const figures = uniqueText(
    $('fig caption, ce\\:figure ce\\:caption, figure figcaption').map((_, node) => $(node).text()).get(),
    8,
  );
  const declaredDoi = normalizeDoi(
    $('article-id[pub-id-type="doi"], ce\\:doi, prism\\:doi, meta[name="citation_doi"]').first().attr('content')
      || $('article-id[pub-id-type="doi"], ce\\:doi, prism\\:doi').first().text()
      || doi,
  );
  const bodyText = paragraphs.join('\n\n');
  const complete = Boolean(title)
    && bodyText.length >= 1200
    && paragraphs.length >= 4
    && references.length >= 1;
  return {
    complete,
    title,
    authors,
    doi: declaredDoi,
    headings,
    paragraphs,
    references,
    tables,
    figures,
    bodyCharacterCount: bodyText.length,
    sourceHash: sha256(Buffer.from(text)),
    reason: complete ? null : 'FULL structured source must contain a title, substantive body, and bibliography',
  };
}

export function buildReconstructedHtml(article, { sourceUrl = '', doi = '', sourceHash = '' } = {}) {
  const targetDoi = normalizeDoi(article?.doi || doi);
  const sectionHtml = article.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('\n');
  const referenceHtml = article.references.map((reference) => `<li>${escapeHtml(reference)}</li>`).join('\n');
  const tableHtml = article.tables.length
    ? `<h2>Tables（文字擷取）</h2>${article.tables.map((table) => `<pre>${escapeHtml(table)}</pre>`).join('\n')}`
    : '';
  const figureHtml = article.figures.length
    ? `<h2>Figure captions</h2>${article.figures.map((caption) => `<p>${escapeHtml(caption)}</p>`).join('\n')}`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(article.title)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm 20mm; }
  body { color:#172033; font: 10.5pt/1.55 "Noto Serif", "Times New Roman", serif; }
  .notice { border:2px solid #9a3412; background:#fff7ed; padding:14px; margin:0 0 20px; }
  .notice strong { color:#9a3412; font-size:14pt; }
  h1 { font-size:19pt; line-height:1.25; margin:18px 0 8px; }
  h2 { font-size:13pt; margin-top:22px; break-after:avoid; }
  p { text-align:justify; orphans:3; widows:3; }
  li { margin:0 0 5px; }
  .meta { color:#475569; font-size:9pt; overflow-wrap:anywhere; }
  pre { white-space:pre-wrap; font:9pt/1.4 monospace; border:1px solid #cbd5e1; padding:8px; }
</style>
</head>
<body>
<div class="notice">
  <strong>由完整結構化全文重建，非出版社排版版</strong>
  <p>本 PDF 由出版社或典藏庫提供的完整 XML／HTML 自動排版，僅供內容閱讀與資料擷取。圖版、分頁及公式外觀可能與 Version of Record 不同。</p>
</div>
<h1>${escapeHtml(article.title)}</h1>
<p>${escapeHtml(article.authors.join(', '))}</p>
<div class="meta">
  <div>DOI: ${escapeHtml(targetDoi || '未提供')}</div>
  <div>來源: ${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}">${escapeHtml(sourceUrl)}</a>` : '未提供'}</div>
  <div>原始來源 SHA-256: ${escapeHtml(sourceHash || article.sourceHash || '')}</div>
  <div>Generator: ${RECONSTRUCTION_GENERATOR}</div>
</div>
<h2>Article body</h2>
${sectionHtml}
${tableHtml}
${figureHtml}
<h2>References</h2>
<ol>${referenceHtml}</ol>
</body>
</html>`;
}

export async function renderHtmlWithPlaywright(html, options = {}) {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= PLAYWRIGHT_BROWSERS_DIR;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless:true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil:'load' });
    return Buffer.from(await page.pdf({
      format:'A4',
      printBackground:true,
      displayHeaderFooter:true,
      headerTemplate:'<span></span>',
      footerTemplate:'<div style="font-size:8px;width:100%;text-align:center;color:#64748b"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      margin:{ top:'18mm', right:'16mm', bottom:'20mm', left:'16mm' },
      ...options.pdf,
    }));
  } finally {
    await browser.close();
  }
}

export async function reconstructStructuredPdf({
  source,
  contentType = '',
  sourceUrl = '',
  doi = '',
  render = renderHtmlWithPlaywright,
} = {}) {
  const sourceBuffer = Buffer.isBuffer(source) ? source : Buffer.from(String(source || ''));
  const article = extractStructuredArticle(sourceBuffer, { contentType, doi });
  if (!article.complete) return { ok:false, reason:article.reason, article };
  if (doi && article.doi && normalizeDoi(doi) !== article.doi) {
    return { ok:false, reason:'Structured source DOI does not match the requested DOI', article };
  }
  const html = buildReconstructedHtml(article, {
    sourceUrl,
    doi,
    sourceHash:sha256(sourceBuffer),
  });
  const pdfBuffer = Buffer.from(await render(html));
  const parsed = await parsePdfBuffer(pdfBuffer);
  if (parsed.pageCount < 2) return { ok:false, reason:'Reconstructed PDF is unexpectedly short', article };
  return {
    ok:true,
    buffer:pdfBuffer,
    html,
    article,
    pageCount:parsed.pageCount,
    size:pdfBuffer.length,
    sha256:sha256(pdfBuffer),
    sourceHash:sha256(sourceBuffer),
    sourceExtension:/html/i.test(contentType) ? '.html' : '.xml',
    documentVersion:'reconstructed',
    documentFormat:'reconstructed_pdf',
    generator:RECONSTRUCTION_GENERATOR,
  };
}
