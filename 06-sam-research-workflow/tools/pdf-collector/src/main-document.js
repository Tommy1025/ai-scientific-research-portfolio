import { extractDois, normalizeDoi } from './utils.js';

const TITLE_THRESHOLD = 0.90;
const TERMINAL_SIGNAL = /\b(?:references|bibliography|acknowledg(?:e)?ments?|conclusions?|author contributions?|conflicts? of interest|data availability|received\s+\w+|accepted\s+\w+)\b/i;
const PREVIEW_SIGNAL = /\b(?:preview only|article preview|document preview|first[- ]page preview|one[- ]page preview|abstract only|sample copy)\b/i;
const PREPRINT_SIGNAL = /\b(?:pre[- ]?prints?|submitted manuscript|submitted version|working paper)\b/i;
const AAM_SIGNAL = /\b(?:author(?:'s)? accepted manuscript|accepted manuscript|accepted version|post[- ]?print|post[- ]?peer[- ]?review)\b/i;
const VOR_SIGNAL = /\b(?:version of record|published version|final published|publisher(?:'s)? version)\b/i;
const RECONSTRUCTED_SIGNAL = /\b(?:reconstructed|structured full[- ]?text|full[- ]?text xml|full[- ]?text html)\b/i;

function normalizedText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstPresent(object, names) {
  for (const name of names) {
    if (object?.[name] !== undefined && object?.[name] !== null && object?.[name] !== '') return object[name];
  }
  return null;
}

function metadataText(metadata = {}) {
  const values = [];
  const visit = (value, depth = 0) => {
    if (depth > 3 || value === null || value === undefined) return;
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      values.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value === 'object') Object.values(value).forEach((item) => visit(item, depth + 1));
  };
  visit(metadata);
  return values.join('\n');
}

function pageText(page) {
  return String(page?.flowing || page?.text || page?.layout || page?.layoutText || '');
}

function parsedPages(parsed = {}) {
  return Array.isArray(parsed.pages) ? parsed.pages.map(pageText) : [];
}

function beforeReferences(text) {
  const match = String(text || '').match(/(?:^|\n)\s*(?:references|bibliography)\s*(?:\n|$)/i);
  return match ? String(text).slice(0, match.index) : String(text || '');
}

function levenshteinSimilarity(left, right) {
  const a = normalizedText(left);
  const b = normalizedText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }
  return Math.max(0, 1 - previous[b.length] / Math.max(a.length, b.length));
}

function tokenCoverage(expected, actual) {
  const expectedTokens = [...new Set(normalizedText(expected).split(' ').filter(Boolean))];
  if (!expectedTokens.length) return 0;
  const actualTokens = new Set(normalizedText(actual).split(' ').filter(Boolean));
  const hits = expectedTokens.filter((token) => actualTokens.has(token)).length;
  return hits / expectedTokens.length;
}

function expectedTitle(work = {}, candidate = {}) {
  const workTitle = Array.isArray(work.title) ? work.title[0] : work.title;
  return String(workTitle || candidate.expectedTitle || candidate.title || '').trim();
}

function actualTitle(parsed = {}) {
  return String(firstPresent(parsed.metadata, ['Title', 'title', 'dc:title', 'dc.title']) || parsed.documentTitle || '').trim();
}

function authorFamily(author) {
  if (!author) return '';
  if (typeof author === 'object') return String(author.family || author.surname || author.lastName || '').trim();
  const text = String(author).trim();
  if (!text) return '';
  if (text.includes(',')) return text.split(',')[0].trim();
  return text.split(/\s+/).at(-1) || '';
}

function expectedAuthorFamily(work = {}, candidate = {}) {
  const author = Array.isArray(work.author) ? work.author[0] : work.author;
  return authorFamily(author || candidate.expectedAuthor || (Array.isArray(candidate.authors) ? candidate.authors[0] : candidate.author));
}

function datePartsYear(value) {
  const year = Number(value?.['date-parts']?.[0]?.[0]);
  return Number.isInteger(year) ? year : null;
}

function expectedYear(work = {}, candidate = {}) {
  const values = [
    work.year,
    datePartsYear(work.published),
    datePartsYear(work.issued),
    datePartsYear(work.created),
    candidate.expectedYear,
    candidate.year,
  ];
  for (const value of values) {
    const year = Number(value);
    if (Number.isInteger(year) && year >= 1600 && year <= 2200) return year;
  }
  return null;
}

function yearsIn(text) {
  const source = String(text || '');
  const values = [
    ...(source.match(/\b(?:16|17|18|19|20|21)\d{2}\b/g) || []),
    ...[...source.matchAll(/\bD:((?:16|17|18|19|20|21)\d{2})\d{4,}/g)].map((match) => match[1]),
  ];
  return [...new Set(values.map(Number))];
}

function isRelatedPublisherIdentifier(targetDoi, foundDoi) {
  if (!targetDoi || !foundDoi) return false;
  if (/^10\.1002\/\(issn\)/i.test(foundDoi)) return true;
  if (foundDoi.startsWith(`${targetDoi}.`)) return true;
  const targetWiley = targetDoi.match(/^10\.1002\/(anie|ange)\.(\d+)$/i);
  const foundWiley = foundDoi.match(/^10\.1002\/(anie|ange)\.(\d+)$/i);
  return Boolean(targetWiley && foundWiley
    && targetWiley[2] === foundWiley[2]
    && targetWiley[1].toLowerCase() !== foundWiley[1].toLowerCase());
}

function bibliographicIdentity({ parsed, work, candidate, firstPageText }) {
  const title = expectedTitle(work, candidate);
  const pdfTitle = actualTitle(parsed);
  const titleSimilarity = Math.max(
    levenshteinSimilarity(title, pdfTitle),
    tokenCoverage(title, firstPageText),
  );
  const family = expectedAuthorFamily(work, candidate);
  const normalizedFamily = normalizedText(family);
  const authorHaystack = normalizedText([
    firstPresent(parsed.metadata, ['Author', 'author', 'dc:creator', 'dc.creator']),
    firstPageText,
  ].filter(Boolean).join('\n'));
  const authorMatched = Boolean(normalizedFamily)
    && ` ${authorHaystack} `.includes(` ${normalizedFamily} `);
  const targetYear = expectedYear(work, candidate);
  const documentYears = yearsIn([
    metadataText(parsed.metadata),
    firstPageText,
  ].join('\n'));
  const yearMatched = Number.isInteger(targetYear)
    && documentYears.some((year) => Math.abs(year - targetYear) <= 1);
  return {
    title,
    documentTitle: pdfTitle || null,
    titleSimilarity,
    titleThreshold: TITLE_THRESHOLD,
    expectedAuthorFamily: family || null,
    authorMatched,
    expectedYear: targetYear,
    documentYears,
    yearMatched,
    verified: Boolean(title) && titleSimilarity >= TITLE_THRESHOLD && authorMatched && yearMatched,
  };
}

function parsePageRange(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const match = text.match(/(?:^|[^\d])(?:[a-z]+\s*)?(\d+)\s*[-\u2013\u2014]\s*(?:[a-z]+\s*)?(\d+)(?:[^\d]|$)/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return null;
  const count = end - start + 1;
  return count > 0 && count <= 5000 ? count : null;
}

function expectedPages(work = {}, candidate = {}) {
  const explicit = [
    ['candidate.expectedPageCount', candidate.expectedPageCount],
    ['candidate.pageCountExpected', candidate.pageCountExpected],
    ['work.number-of-pages', work['number-of-pages']],
    ['work.page-count', work['page-count']],
    ['work.pageCount', work.pageCount],
  ];
  for (const [source, value] of explicit) {
    const count = Number(value);
    if (Number.isInteger(count) && count > 0 && count <= 5000) return { count, source };
  }
  const range = parsePageRange(work.page || candidate.page);
  return range ? { count: range, source: work.page ? 'work.page' : 'candidate.page' } : { count: null, source: null };
}

function entitlementDenied(entitlement) {
  if (entitlement === false) return true;
  if (!entitlement || typeof entitlement !== 'object') return false;
  const status = Number(entitlement.httpStatus ?? entitlement.statusCode ?? entitlement.status);
  if (status === 401 || status === 403) return true;
  if ([
    entitlement.entitled,
    entitlement.allowed,
    entitlement.authorized,
    entitlement.fullText,
    entitlement.hasFullText,
  ].some((value) => value === false)) return true;
  return /\b(?:not[_ -]?entitled|unauthori[sz]ed|permission[_ -]?required|denied|forbidden)\b/i.test(
    String(entitlement.status || entitlement.code || entitlement.result || ''),
  );
}

function classifyVersion(candidate = {}) {
  const declaredVersions = [
    candidate.documentVersion,
    candidate.version,
    candidate.contentVersion,
  ].filter(Boolean).map((value) => normalizedText(value).replaceAll(' ', ''));
  const evidence = [
    ...declaredVersions,
    candidate.label,
    candidate.source,
    candidate.url,
  ].filter(Boolean).join(' ');
  if (candidate.requiresVersionValidation === true
      && declaredVersions.some((value) => ['unknown', 'alternativeversion', 'av'].includes(value))) {
    return { documentVersion: null, accepted: false, basis: 'version_unverified' };
  }
  if (candidate.reconstructed === true || declaredVersions.includes('reconstructed') || RECONSTRUCTED_SIGNAL.test(evidence)) {
    return { documentVersion: 'reconstructed', accepted: true, basis: 'explicit_reconstructed' };
  }
  if (declaredVersions.some((value) => ['preprint', 'submittedversion', 'submittedmanuscript'].includes(value)) || PREPRINT_SIGNAL.test(evidence)) {
    return { documentVersion: null, accepted: false, basis: 'explicit_preprint' };
  }
  if (declaredVersions.some((value) => ['aam', 'am', 'acceptedversion', 'acceptedmanuscript', 'postprint'].includes(value)) || AAM_SIGNAL.test(evidence)) {
    return { documentVersion: 'aam', accepted: true, basis: 'accepted_manuscript' };
  }
  if (declaredVersions.some((value) => ['vor', 'versionofrecord', 'publishedversion'].includes(value)) || VOR_SIGNAL.test(evidence)) {
    return { documentVersion: 'vor', accepted: true, basis: 'version_of_record' };
  }
  if (candidate.access === 'publisher' || /\b(?:publisher|article api|tdm|direct pdf|crossref)\b/i.test(evidence)) {
    return { documentVersion: 'vor', accepted: true, basis: 'publisher_inference' };
  }
  if (candidate.access === 'oa' || /\b(?:repository|openalex|unpaywall|core|semantic scholar|dspace|eprints|hal|zenodo)\b/i.test(evidence)) {
    return { documentVersion: 'aam', accepted: true, basis: 'repository_inference' };
  }
  return { documentVersion: 'vor', accepted: true, basis: 'unspecified_pdf_default' };
}

function completenessAssessment({ parsed, candidate, entitlement, lastPageText, expected }) {
  const pageCount = Number(parsed.pageCount) || 0;
  const terminalSignal = TERMINAL_SIGNAL.test(lastPageText);
  const previewEvidence = [
    candidate.preview === true ? 'candidate.preview' : null,
    candidate.isPreview === true ? 'candidate.isPreview' : null,
    PREVIEW_SIGNAL.test([
      candidate.label,
      candidate.source,
      candidate.version,
      metadataText(parsed.metadata),
      parsedPages(parsed)[0] || parsed.text?.slice(0, 2500),
    ].filter(Boolean).join('\n')) ? 'preview_text' : null,
    entitlementDenied(entitlement) ? 'entitlement_denied' : null,
  ].filter(Boolean);

  if (pageCount < 1) {
    return {
      verified: false, classification: 'incomplete', reason: 'no_pages',
      pageCount, expectedPageCount: expected.count, expectedPageSource: expected.source,
      terminalSignal, previewEvidence,
    };
  }
  if (previewEvidence.length) {
    return {
      verified: false, classification: 'preview', reason: previewEvidence[0],
      pageCount, expectedPageCount: expected.count, expectedPageSource: expected.source,
      terminalSignal, previewEvidence,
    };
  }
  if (pageCount === 1 && expected.count > 1) {
    return {
      verified: false, classification: 'preview', reason: 'crossref_multipage_but_single_page_pdf',
      pageCount, expectedPageCount: expected.count, expectedPageSource: expected.source,
      terminalSignal, previewEvidence,
    };
  }
  if (pageCount === 1) {
    const legalSinglePage = expected.count === 1 && terminalSignal;
    return {
      verified: legalSinglePage,
      classification: legalSinglePage ? 'complete' : 'preview',
      reason: legalSinglePage ? 'metadata_supported_complete_single_page' : 'single_page_not_supported_as_complete',
      pageCount, expectedPageCount: expected.count, expectedPageSource: expected.source,
      terminalSignal, previewEvidence,
    };
  }
  if (expected.count >= 4 && pageCount * 2 < expected.count && !terminalSignal) {
    return {
      verified: false, classification: 'incomplete', reason: 'less_than_half_expected_pages_without_terminal_signal',
      pageCount, expectedPageCount: expected.count, expectedPageSource: expected.source,
      terminalSignal, previewEvidence,
    };
  }
  return {
    verified: true, classification: 'complete', reason: 'page_and_terminal_checks_passed',
    pageCount, expectedPageCount: expected.count, expectedPageSource: expected.source,
    terminalSignal, previewEvidence,
  };
}

function resultFailure(identity, completeness, version) {
  if (!version.accepted && version.basis === 'version_unverified') {
    return ['main_version_unverified', 'version_unverified', '來源未能證明是 VoR 或 AAM'];
  }
  if (!version.accepted) return ['main_preprint_not_allowed', 'preprint', '預印本不在允許的主文版本內'];
  if (identity.conflictingDois.length) return ['main_identity_conflict', 'wrong_document', 'PDF 前文或 metadata 含有與目標不符的 DOI'];
  if (completeness.classification === 'preview') return ['main_preview', 'preview', 'PDF 是預覽或缺乏完整單頁文章證據'];
  if (!identity.verified) return ['main_identity_unverified', 'wrong_document', '無法以 DOI 或題名／作者／年份確認 PDF 身分'];
  if (!completeness.verified) return ['main_incomplete', 'incomplete', 'PDF 頁數或結尾訊號顯示內容不完整'];
  return [null, 'accepted', '主文身分與完整性驗證通過'];
}

/**
 * Assess an already parsed main-article PDF.
 *
 * `parsed` is the value returned by parsePdfBuffer(). `work` should be the
 * Crossref-style target metadata; `candidate` describes the download source.
 * The function is pure so callers can persist `mainValidation` verbatim.
 */
export function assessMainDocument({
  parsed = {},
  candidate = {},
  doi = null,
  work = {},
  entitlement = undefined,
} = {}) {
  const pages = parsedPages(parsed);
  const firstThreeText = beforeReferences(
    pages.length ? pages.slice(0, 3).join('\n') : parsed.firstPages || parsed.text || '',
  );
  const firstPageText = beforeReferences(pages[0] || parsed.firstPageText || parsed.text || '');
  const lastPageText = pages.length
    ? pages[Math.min(pages.length, Number(parsed.pageCount) || pages.length) - 1]
    : parsed.lastPageText || (Number(parsed.pageCount) === 1 ? parsed.text : String(parsed.text || '').slice(-8000));
  const targetDoi = normalizeDoi(doi || work.DOI || work.doi || candidate.expectedDoi || candidate.doi);
  const metadataDois = extractDois(metadataText(parsed.metadata));
  const frontDois = extractDois(firstThreeText);
  const candidateDoi = normalizeDoi(candidate.doi);
  const foundDois = [...new Set([...metadataDois, ...frontDois])];
  const conflictingDois = targetDoi
    ? [...new Set([
      ...metadataDois.filter((value) => value !== targetDoi && !isRelatedPublisherIdentifier(targetDoi, value)),
      ...frontDois.filter((value) => value !== targetDoi && !isRelatedPublisherIdentifier(targetDoi, value)),
      ...(candidateDoi && candidateDoi !== targetDoi ? [candidateDoi] : []),
    ])]
    : [];
  const doiMatched = Boolean(targetDoi) && foundDois.includes(targetDoi);
  const bibliographic = bibliographicIdentity({ parsed, work, candidate, firstPageText });
  const identity = {
    verified: conflictingDois.length === 0 && (doiMatched || (foundDois.length === 0 && bibliographic.verified)),
    method: doiMatched ? 'doi' : (foundDois.length === 0 && bibliographic.verified ? 'bibliographic' : 'none'),
    targetDoi,
    metadataDois,
    frontDois,
    foundDois,
    conflictingDois,
    doiMatched,
    bibliographic,
  };
  const expected = expectedPages(work, candidate);
  const completeness = completenessAssessment({
    parsed,
    candidate,
    entitlement: entitlement ?? candidate.entitlement,
    lastPageText,
    expected,
  });
  const version = classifyVersion(candidate);
  const [failureCode, classification, message] = resultFailure(identity, completeness, version);
  const mainValidation = {
    verified: failureCode === null,
    identity,
    completeness,
    version,
  };
  return {
    ok: mainValidation.verified,
    classification,
    failureCode,
    message,
    documentVersion: version.documentVersion,
    pageCount: completeness.pageCount,
    expectedPageCount: completeness.expectedPageCount,
    mainValidation,
  };
}
