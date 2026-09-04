import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { sourceDir, saveSource } from './store.js';
import { createId, extractDois, normalizeDoi, validateExternalUrl } from './utils.js';
import { fetchWithPolicy } from './http.js';
import { parsePdfBuffer } from './pdf.js';
import { crossrefReferences, mergeReferenceLists, parsePdfReferences } from './references.js';
import { crossrefMetadata, getCrossrefWork } from './providers.js';

function htmlMetadata(html, url) {
  const $ = cheerio.load(html);
  const one = (selector, attr = 'content') => $(selector).first().attr(attr) || null;
  const doi = normalizeDoi(one('meta[name="citation_doi"]') || one('meta[name="dc.identifier"]') || extractDois(html)[0]);
  return {
    doi,
    title: one('meta[name="citation_title"]') || $('title').text().trim() || null,
    authors: $('meta[name="citation_author"]').map((_, element) => $(element).attr('content')).get(),
    year: Number(String(one('meta[name="citation_publication_date"]') || '').match(/\d{4}/)?.[0]) || null,
    landingUrl: url,
    directPdf: one('meta[name="citation_pdf_url"]'),
  };
}

async function enrich(doi, email, endpoints) {
  if (!doi) return { work: null, metadata: {} };
  try {
    const work = await getCrossrefWork(doi, email, endpoints);
    return { work, metadata: crossrefMetadata(work) };
  } catch {
    return { work: null, metadata: { doi } };
  }
}

export async function createSourceFromUpload(file, email, endpoints = {}) {
  if (!file) throw new Error('請選擇 PDF 檔案');
  const buffer = await fs.readFile(file.path);
  const parsed = await parsePdfBuffer(buffer);
  const { work, metadata } = await enrich(parsed.likelyDoi, email, endpoints);
  const pdfRefs = parsePdfReferences(parsed.text);
  const references = mergeReferenceLists(crossrefReferences(work), pdfRefs);
  if (!references.length) throw new Error('找不到 References／Bibliography 區段');
  const id = createId('src');
  await fs.mkdir(sourceDir(id), { recursive: true });
  const originalName = 'source.pdf';
  await fs.copyFile(file.path, path.join(sourceDir(id), originalName));
  const source = {
    id, inputType: 'upload', originalFilename: file.originalname, originalPdf: originalName,
    metadata: { ...metadata, pdfTitle: parsed.metadata?.Title || null, pageCount: parsed.pageCount },
    references, createdAt: new Date().toISOString(),
  };
  await saveSource(source);
  return source;
}

export async function createSourceFromUrl(inputUrl, email, endpoints = {}) {
  const url = (await validateExternalUrl(inputUrl)).href;
  const response = await fetchWithPolicy(url, { email, retries: 1, accept: 'text/html,application/pdf;q=0.9,*/*;q=0.5' });
  if (!response.ok) throw new Error(`來源網址回應 HTTP ${response.status}`);
  const contentType = String(response.headers['content-type'] || '').toLowerCase();
  let parsed = null;
  let parsedPdfBuffer = null;
  let pageMetadata = {};
  if (contentType.includes('pdf') || response.buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
    parsed = await parsePdfBuffer(response.buffer);
    parsedPdfBuffer = response.buffer;
    pageMetadata = { doi: parsed.likelyDoi, title: parsed.metadata?.Title || null, landingUrl: response.finalUrl };
  } else {
    pageMetadata = htmlMetadata(response.buffer.toString('utf8'), response.finalUrl);
    if (pageMetadata.directPdf) {
      try {
        const pdfUrl = new URL(pageMetadata.directPdf, response.finalUrl).href;
        const pdfResponse = await fetchWithPolicy(pdfUrl, { email, retries: 1, accept: 'application/pdf' });
        parsed = await parsePdfBuffer(pdfResponse.buffer);
        parsedPdfBuffer = pdfResponse.buffer;
      } catch { /* Crossref references may still be enough */ }
    }
  }
  const doi = pageMetadata.doi || parsed?.likelyDoi || normalizeDoi(url);
  const { work, metadata } = await enrich(doi, email, endpoints);
  const pdfRefs = parsed ? parsePdfReferences(parsed.text) : [];
  const references = mergeReferenceLists(crossrefReferences(work), pdfRefs);
  if (!references.length) throw new Error('來源頁面與 Crossref 都沒有可用的參考文獻；請改以上傳 PDF。');
  const id = createId('src');
  await fs.mkdir(sourceDir(id), { recursive: true });
  if (parsedPdfBuffer) await fs.writeFile(path.join(sourceDir(id), 'source.pdf'), parsedPdfBuffer);
  const source = {
    id, inputType: 'url', inputUrl: url, originalPdf: parsed ? 'source.pdf' : null,
    metadata: { ...pageMetadata, ...metadata, pageCount: parsed?.pageCount || null },
    references, createdAt: new Date().toISOString(),
  };
  await saveSource(source);
  return source;
}
