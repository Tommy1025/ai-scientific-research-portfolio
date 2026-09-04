import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  buildReconstructedHtml, extractStructuredArticle, reconstructStructuredPdf,
} from '../src/structured-fulltext.js';

const paragraphs = Array.from({ length:6 }, (_, index) =>
  `<ce:para>Section ${index + 1}. ${'Complete scientific article body text '.repeat(12)}</ce:para>`).join('');
const fullXml = `<?xml version="1.0"?>
<xocs:doc xmlns:xocs="x" xmlns:ce="c" xmlns:prism="p">
  <ce:title>Verified structured full text</ce:title>
  <ce:doi>10.1016/j.example.2026.1</ce:doi>
  <ce:sections><ce:section>${paragraphs}</ce:section></ce:sections>
  <ce:bibliography>
    <ce:bib-reference>Author A. Example reference one.</ce:bib-reference>
    <ce:bib-reference>Author B. Example reference two.</ce:bib-reference>
  </ce:bibliography>
</xocs:doc>`;

async function syntheticRenderedPdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const label of ['Reconstructed full text', 'References']) {
    const page = pdf.addPage([595, 842]);
    page.drawText(label, { x:50, y:780, size:18, font });
  }
  return Buffer.from(await pdf.save());
}

test('FULL XML 必須同時有正文與 bibliography，META_ABS 不可重建', () => {
  const complete = extractStructuredArticle(fullXml, { contentType:'text/xml' });
  assert.equal(complete.complete, true);
  assert.equal(complete.doi, '10.1016/j.example.2026.1');
  const metadataOnly = extractStructuredArticle(
    '<article><article-title>Only metadata</article-title><abstract>Short abstract</abstract></article>',
    { contentType:'application/xml' },
  );
  assert.equal(metadataOnly.complete, false);
});

test('重建版首頁明確標示非出版社排版版並保存來源證據', () => {
  const article = extractStructuredArticle(fullXml, { contentType:'text/xml' });
  const html = buildReconstructedHtml(article, {
    sourceUrl:'https://api.example/article.xml',
    sourceHash:'abc123',
  });
  assert.match(html, /由完整結構化全文重建，非出版社排版版/);
  assert.match(html, /abc123/);
  assert.match(html, /sam-reference-pdf-collector\/0\.7\.0/);
});

test('完整 XML 可重建成多頁 PDF，DOI 不符時拒絕', async () => {
  const result = await reconstructStructuredPdf({
    source:Buffer.from(fullXml),
    contentType:'text/xml',
    sourceUrl:'https://api.example/article.xml',
    doi:'10.1016/j.example.2026.1',
    render:syntheticRenderedPdf,
  });
  assert.equal(result.ok, true);
  assert.equal(result.pageCount, 2);
  assert.equal(result.documentVersion, 'reconstructed');
  assert.equal(result.documentFormat, 'reconstructed_pdf');
  const mismatch = await reconstructStructuredPdf({
    source:Buffer.from(fullXml),
    contentType:'text/xml',
    doi:'10.1016/j.other',
    render:syntheticRenderedPdf,
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.reason, /DOI does not match/);
});
