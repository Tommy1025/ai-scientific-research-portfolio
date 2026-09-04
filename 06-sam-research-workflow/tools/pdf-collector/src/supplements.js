import path from 'node:path';
import AdmZip from 'adm-zip';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import WordExtractor from 'word-extractor';
import { parsePdfBuffer } from './pdf.js';
import { sha256 } from './utils.js';

export const SI_EXTENSIONS = new Set(['.pdf', '.docx', '.doc']);

const EXCLUDED_PATTERNS = [
  ['source_data', /\bsource[_\s-]+data\b/i],
  ['reporting_summary', /\breporting\s+summary\b/i],
  ['peer_review', /\bpeer\s+review(?:\s+file)?\b|(?:^|[^a-z0-9])additional[_\s-]+review[_\s-]+material(?:[^a-z0-9]|$)/i],
  ['editorial_decision', /\beditorial\s+decision\b/i],
  ['author_response', /\bauthor\s+response\b/i],
  ['data_availability', /\bdata[_\s-]+availability\b/i],
  ['dataset', /\bdata\s*set\b|\bdata\s+table\b|\bspreadsheet\b/i],
  ['code', /\bcode\b|\bsoftware\b|\bscript\b|\bnotebook\b/i],
  ['media', /\bvideo\b|\bmovie\b|\baudio\b/i],
  ['image', /\bfigure\b|\bimage\b/i],
  ['crystal_structure', /\bcrystal\s+structure\b|\bcif\b/i],
];

const ACCEPT_PATTERNS = [
  ['supporting_information', /\bsupporting\s+information\b/i],
  ['supplementary_information', /\bsupplementary\s+information\b/i],
  ['electronic_supplementary_information', /\belectronic\s+supplementary\s+information\b/i],
  ['supplementary_material', /\bsupplementary\s+materials?\b/i],
  ['esi', /(?:^|[^a-z])esi(?:[^a-z]|$)/i],
];

function decoded(value) {
  try { return decodeURIComponent(String(value || '').replaceAll('+', ' ')); } catch { return String(value || ''); }
}

function extensionFromUrl(url) {
  try { return path.extname(new URL(url).pathname).toLowerCase(); } catch { return path.extname(String(url || '').split(/[?#]/)[0]).toLowerCase(); }
}

function formatHint(url, contentType = '') {
  const extension = extensionFromUrl(url);
  if (extension) return extension;
  const type = String(contentType).toLowerCase();
  if (type.includes('application/pdf')) return '.pdf';
  if (type.includes('wordprocessingml.document')) return '.docx';
  if (type.includes('application/msword')) return '.doc';
  return '';
}

export function classifySupplementDescriptor({ url = '', label = '', title = '', ariaLabel = '', contentType = '', source = '' } = {}) {
  const value = [decoded(url), label, title, ariaLabel, contentType, source].filter(Boolean).join(' ');
  const extension = formatHint(url, contentType);
  const excluded = EXCLUDED_PATTERNS.find(([, pattern]) => pattern.test(value));
  if (excluded) return { classification:'excluded_attachment', reason:excluded[0], extension };
  const accepted = ACCEPT_PATTERNS.find(([, pattern]) => pattern.test(value));
  const standardAdapter = /(?:^|[/_.-])moesm\d+_esm\.(?:pdf|docx?)(?:$|[?#])|\/suppdata\/[^\s]+\.pdf(?:$|[?#])|\/action\/downloadsupplement\b|\/doi\/suppl\/[^\s]+\/suppl_file\/[^\s]+\.(?:pdf|docx?)(?:$|[?#])|(?:^|[/_.-])sup-\d{4}(?:[/_.-]|$)|_sm_suppl\.(?:pdf|docx?)(?:$|[?#])/i.test(decoded(url));
  if (accepted || standardAdapter) {
    if (extension && !SI_EXTENSIONS.has(extension)) return { classification:'excluded_attachment', reason:`unsupported_format:${extension}`, extension };
    return {
      classification:'si', reason:accepted?.[0] || 'publisher_standard_si', extension,
      matchedBy: accepted ? (/\bsupporting\s+information\b|\bsupplementary\s+information\b/i.test(label) ? 'label' : 'descriptor') : 'publisher_adapter',
    };
  }
  return { classification:'unknown', reason:'no_reliable_si_label', extension };
}

function publisherSupplementToken(url) {
  const match = decoded(url).match(/(?:^|[/_.#-])(moesm\d+)(?:[_./?#-]|$)/i);
  return match?.[1]?.toLowerCase() || null;
}

export function applyRelatedSupplementExclusions(candidates = []) {
  const classified = candidates.map((candidate) => ({ ...candidate, ...classifySupplementDescriptor(candidate) }));
  const excludedTokens = new Map();
  for (const candidate of classified) {
    const token = publisherSupplementToken(candidate.url);
    const isConcreteDocument = SI_EXTENSIONS.has(candidate.extension);
    if (token && isConcreteDocument && candidate.classification === 'excluded_attachment') excludedTokens.set(token, candidate.reason);
  }
  return classified.map((candidate) => {
    const token = publisherSupplementToken(candidate.url);
    const relatedReason = token && excludedTokens.get(token);
    if (!relatedReason || candidate.classification === 'excluded_attachment') return candidate;
    return { ...candidate, classification:'excluded_attachment', reason:`related_excluded_label:${relatedReason}` };
  });
}

function candidatePriority(candidate) {
  const classification = classifySupplementDescriptor(candidate);
  const label = String(candidate.label || '');
  const extension = classification.extension || formatHint(candidate.url, candidate.contentType);
  const explicitLabel = /\bsupporting\s+information\b|\bsupplementary\s+information\b/i.test(label);
  if (Buffer.isBuffer(candidate.localBuffer)) return 0;
  if (explicitLabel && extension === '.pdf') return 1;
  if (explicitLabel && extension === '.docx') return 2;
  if (explicitLabel && extension === '.doc') return 2;
  if (classification.reason === 'publisher_standard_si' || /(?:^|[^a-z])esi(?:[^a-z]|$)/i.test(label)) return 3;
  return 4;
}

export function rankSupplementCandidates(candidates = []) {
  return candidates
    .map((candidate, index) => ({
      ...candidate,
      ...(candidate.classification ? {} : classifySupplementDescriptor(candidate)),
      _order:index,
    }))
    .filter((candidate) => candidate.classification === 'si')
    .sort((left, right) => candidatePriority(left) - candidatePriority(right) || left._order - right._order)
    .map(({ _order, ...candidate }) => candidate);
}

function hasZipMagic(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && (
    buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    || buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  );
}

function hasOleMagic(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
}

async function extractLegacyWordText(buffer) {
  const document = await new WordExtractor().extract(buffer);
  return [document.getBody(), document.getFootnotes(), document.getEndnotes(), document.getTextboxes()]
    .filter(Boolean).join('\n');
}

export async function extractEmbeddedPdfAttachments(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return [];
  const task = getDocument({
    data:new Uint8Array(buffer), useWorkerFetch:false, isEvalSupported:false, useSystemFonts:true,
  });
  let document;
  try {
    document = await task.promise;
    const attachments = await document.getAttachments().catch(() => null);
    const candidates = [];
    for (const [key, attachment] of Object.entries(attachments || {})) {
      const name = String(attachment?.filename || key || 'attachment');
      const description = String(attachment?.description || '');
      const likelySiName = /(?:^|[_ .-])(?:si|supp(?:lement(?:ary)?)?|s\d+)(?:[_ .-]|$)/i.test(name);
      const label = description || (likelySiName ? `Supplementary Information ${name}` : name);
      const classification = classifySupplementDescriptor({ url:name, label });
      if (classification.classification !== 'si') continue;
      const content = Buffer.from(attachment?.content || []);
      if (!content.length) continue;
      const extension = path.extname(name).toLowerCase();
      candidates.push({
        url:`embedded-file:///${encodeURIComponent(name)}`, source:'主文 PDF EmbeddedFiles', access:'local',
        supplement:true, evidence:'confirmed', label, localBuffer:content, archiveEntryName:name,
        contentType:extension === '.pdf' ? 'application/pdf'
          : extension === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : extension === '.doc' ? 'application/msword' : 'application/octet-stream',
      });
    }
    return candidates;
  } catch { return []; }
  finally { await document?.destroy?.().catch(() => {}); }
}

function xmlText(xml) {
  return String(xml || '')
    .replace(/<w:tab\b[^>]*\/>/gi, '\t')
    .replace(/<w:(?:br|cr)\b[^>]*\/>/gi, '\n')
    .replace(/<\/w:p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

function contentClassification(text) {
  const value = String(text || '').trim();
  const front = value.slice(0, 1500);
  const strongExclusions = EXCLUDED_PATTERNS.slice(0, 5).find(([, pattern]) => pattern.test(front));
  if (strongExclusions) return { classification:'excluded_attachment', reason:strongExclusions[0] };
  const accepted = ACCEPT_PATTERNS.find(([, pattern]) => pattern.test(front));
  if (accepted) return { classification:'si', reason:accepted[0] };
  const title = front.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 3).join(' ');
  const titleExclusion = /^(?:data\s+availability|data\s*set|data\s+table|spreadsheet|code|software|script|notebook|video|movie|audio|figure|image|crystal\s+structure|cif)\b/i.exec(title);
  if (titleExclusion) return { classification:'excluded_attachment', reason:'excluded_document_title' };
  return { classification:'unknown', reason:'no_reliable_si_content' };
}

function normalizedPageFront(page) {
  return String(page?.flowing || page?.layout || '')
    .slice(0, 2200)
    .replace(/\s+/g, ' ')
    .trim();
}

export function findEmbeddedSupplementStart(pages = []) {
  for (let index = 2; index < pages.length; index += 1) {
    const front = normalizedPageFront(pages[index]);
    if (!front) continue;
    const availabilityOnly = /\b(?:supporting|supplementary) information\s+(?:is|can be|may be)\b.{0,120}\b(?:available|found|obtained)\b/i.test(front.slice(0, 500));
    if (availabilityOnly) continue;
    if (/^(?:\d+\s+)?supplementary materials?\s+contents\b/i.test(front)) return index;
    if (/^(?:\d+\s+)?supplementary information\s+contents\b/i.test(front)) return index;

    const hasSiHeading = /^(?:\d+\s+)?(?:supporting|supplementary) information\b/i.test(front)
      || /^(?:\d+\s+)?copyright\b.{0,320}\bsupporting information\b/i.test(front);
    const hasSiBodySignal = /\b(?:general methods?|experimental (?:section|details?)|materials? and methods?|table of contents|figure\s+s1\b|table\s+s1\b|supporting references?)\b/i.test(front);
    if (hasSiHeading && hasSiBodySignal) return index;
  }
  return null;
}

export async function extractEmbeddedSupplementPdf(buffer) {
  const parsed = await parsePdfBuffer(buffer);
  const startIndex = findEmbeddedSupplementStart(parsed.pages);
  if (startIndex === null) return null;
  const source = await PDFDocument.load(buffer);
  const output = await PDFDocument.create();
  const pageIndexes = Array.from({ length:source.getPageCount() - startIndex }, (_, offset) => startIndex + offset);
  const copiedPages = await output.copyPages(source, pageIndexes);
  copiedPages.forEach((page) => output.addPage(page));
  const outputBuffer = Buffer.from(await output.save());
  return {
    buffer:outputBuffer,
    startPage:startIndex + 1,
    pageCount:copiedPages.length,
  };
}

export async function validateSupplementDocument({
  buffer, contentType = '', finalUrl = '', candidate = {}, legacyDocTextExtractor = extractLegacyWordText,
}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20) return { ok:false, reason:'invalid_file', error:'SI 檔案過小' };
  const isPdf = buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'));
  const descriptor = classifySupplementDescriptor({ ...candidate, url:finalUrl || candidate.url, contentType });
  if (isPdf) {
    try {
      const parsed = await parsePdfBuffer(buffer);
      if (parsed.pageCount < 1) throw new Error('SI PDF 沒有頁面');
      const frontText = parsed.pages.slice(0, 2).map((page) => page.flowing).join('\n');
      const metadataText = Object.values(parsed.metadata || {}).filter((value) => typeof value === 'string').join(' ');
      const content = contentClassification(`${frontText}\n${metadataText}`);
      if (content.classification === 'excluded_attachment') {
        return { ok:false, reason:'excluded_content', exclusionReason:content.reason, extension:'.pdf', error:`PDF 前兩頁或 metadata 顯示排除用途：${content.reason}` };
      }
      if (descriptor.classification !== 'si' && content.classification !== 'si') {
        return { ok:false, reason:'not_si', extension:'.pdf', error:'PDF 標籤與前兩頁均未能可靠判定為 SI' };
      }
      return { ok:true, extension:'.pdf', pageCount:parsed.pageCount, frontText, size:buffer.length, sha256:sha256(buffer), contentConfidence:content.classification === 'si' };
    } catch (error) {
      return { ok:false, reason:'invalid_pdf', extension:'.pdf', error:error.message };
    }
  }

  const looksDocx = hasZipMagic(buffer) && (formatHint(finalUrl || candidate.url, contentType) === '.docx' || String(contentType).toLowerCase().includes('zip'));
  if (looksDocx) {
    try {
      const zip = new AdmZip(buffer);
      const contentTypes = zip.getEntry('[Content_Types].xml');
      const document = zip.getEntry('word/document.xml');
      if (!contentTypes || !document) throw new Error('DOCX 缺少 [Content_Types].xml 或 word/document.xml');
      const frontText = xmlText(document.getData().toString('utf8')).slice(0, 20000);
      const content = contentClassification(frontText);
      if (content.classification === 'excluded_attachment') {
        return { ok:false, reason:'excluded_content', exclusionReason:content.reason, extension:'.docx', error:`DOCX 前段顯示排除用途：${content.reason}` };
      }
      if (descriptor.classification !== 'si' && content.classification !== 'si') {
        return { ok:false, reason:'not_si', extension:'.docx', error:'DOCX 標籤與前段文字均未能可靠判定為 SI' };
      }
      return { ok:true, extension:'.docx', pageCount:null, frontText, size:buffer.length, sha256:sha256(buffer), contentConfidence:content.classification === 'si' };
    } catch (error) {
      return { ok:false, reason:'invalid_docx', extension:'.docx', error:error.message };
    }
  }
  const looksLegacyDoc = hasOleMagic(buffer)
    && (formatHint(finalUrl || candidate.url, contentType) === '.doc' || String(contentType).toLowerCase().includes('msword'));
  if (looksLegacyDoc) {
    try {
      const frontText = String(await legacyDocTextExtractor(buffer)).slice(0, 20000);
      if (!frontText.trim()) throw new Error('DOC 沒有可讀文字');
      const content = contentClassification(frontText);
      if (content.classification === 'excluded_attachment') {
        return { ok:false, reason:'excluded_content', exclusionReason:content.reason, extension:'.doc', error:`DOC 前段顯示排除用途：${content.reason}` };
      }
      if (descriptor.classification !== 'si' && content.classification !== 'si') {
        return { ok:false, reason:'not_si', extension:'.doc', error:'DOC 標籤與前段文字均未能可靠判定為 SI' };
      }
      return { ok:true, extension:'.doc', pageCount:null, frontText, size:buffer.length, sha256:sha256(buffer), contentConfidence:content.classification === 'si' };
    } catch (error) {
      return { ok:false, reason:'invalid_doc', extension:'.doc', error:error.message };
    }
  }
  return { ok:false, reason:'unsupported_format', error:'SI 僅接受有效的 PDF、DOCX 或 legacy DOC' };
}

export function chooseSupplementFiles(attempted = [], limit = 2) {
  const selected = [];
  const ignored = [];
  const hashes = new Set();
  for (const entry of attempted) {
    if (!entry.result?.ok) {
      ignored.push({ ...entry, reason:entry.result?.reason || 'validation_failed' });
      continue;
    }
    if (hashes.has(entry.result.sha256)) {
      ignored.push({ ...entry, reason:'duplicate_sha256' });
      continue;
    }
    hashes.add(entry.result.sha256);
    if (selected.length >= limit) {
      ignored.push({ ...entry, reason:'limit_two' });
      continue;
    }
    selected.push(entry);
  }
  return { selected, ignored };
}
