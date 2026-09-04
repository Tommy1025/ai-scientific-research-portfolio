import { extractDois, normalizeDoi } from './utils.js';

function cleanCitation(text) {
  return String(text || '')
    .replace(/([a-z])[-‐]\s*\n\s*([a-z])/g, '$1$2')
    .replace(/\bdoi\.\s+org\//gi, 'doi.org/')
    .replace(/https?:\/\/\s+/gi, (value) => value.replace(/\s+/g, ''))
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:)])/g, '$1')
    .trim();
}

export function parsePdfReferences(text) {
  const fullText = String(text || '').replace(/\r/g, '');
  const headings = [...fullText.matchAll(/(?:^|\n)\s*(references|bibliography|參考文獻)\s*(?:\n|$)/gi)];
  let section = headings.length ? fullText.slice(headings.at(-1).index + headings.at(-1)[0].length) : fullText;
  const ending = section.search(/(?:^|\n)\s*(?:supporting information|supplementary information|biographies|author biographies)\s*(?:\n|$)/i);
  if (ending >= 0) section = section.slice(0, ending);
  const lines = section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line
      && !/^\d+\s+of\s+\d+\b/i.test(line)
      && !/^Advanced Materials\b.*\b\d+\s+of\s+\d+$/i.test(line)
      && !/^15214095,\s*0,\s*Downloaded from\b/i.test(line));
  const refs = [];
  let current = null;
  for (const line of lines) {
    const match = line.match(/^(?:\[(\d{1,4})\]|\((\d{1,4})\)|(\d{1,4})\s*[.)])\s+(.+)$/);
    const number = match ? Number(match[1] || match[2] || match[3]) : null;
    if (match && ((!current && number === 1) || (current && number === current.refNumber + 1))) {
      if (current) refs.push(current);
      current = { refNumber: number, rawCitation: match[4] };
    } else if (current) {
      current.rawCitation += ` ${line}`;
    }
  }
  if (current) refs.push(current);

  if (!refs.length) {
    const paragraphs = normalized.split(/\n\s*\n/).map(cleanCitation).filter((value) => value.length >= 35);
    return paragraphs.map((rawCitation, index) => ({
      refNumber: index + 1,
      rawCitation,
      doi: extractDois(rawCitation)[0] || null,
      parseMethod: 'pdf_unnumbered',
    }));
  }
  return refs
    .map((ref) => ({
      ...ref,
      rawCitation: cleanCitation(ref.rawCitation),
      doi: extractDois(ref.rawCitation)[0] || null,
      parseMethod: 'pdf_numbered',
    }))
    .filter((ref) => ref.rawCitation.length >= 15);
}

export function crossrefReferences(work) {
  return (work?.reference || []).map((ref, index) => {
    const rawCitation = cleanCitation(ref.unstructured || [ref.author, ref.year, ref['article-title'], ref['journal-title'], ref.volume, ref['first-page']].filter(Boolean).join('. '));
    const keyMatch = String(ref.key || '').trim().match(/^(?:\[(\d{1,4})\]|\((\d{1,4})\)|(\d{1,4}))$/);
    const keyNumber = keyMatch ? Number(keyMatch[1] || keyMatch[2] || keyMatch[3]) : null;
    return {
      refNumber: Number.isFinite(keyNumber) && keyNumber > 0 ? keyNumber : index + 1,
      rawCitation,
      doi: normalizeDoi(ref.DOI),
      title: ref['article-title'] || null,
      author: ref.author || null,
      year: ref.year || null,
      parseMethod: 'crossref',
    };
  });
}

export function mergeReferenceLists(crossrefList, pdfList) {
  const byNumber = new Map();
  for (const ref of pdfList || []) byNumber.set(ref.refNumber, { ...ref });
  for (const ref of crossrefList || []) {
    const existing = byNumber.get(ref.refNumber) || {};
    byNumber.set(ref.refNumber, {
      ...ref,
      ...existing,
      doi: existing.doi || ref.doi || null,
      rawCitation: existing.rawCitation || ref.rawCitation || '',
      title: ref.title || existing.title || null,
      author: ref.author || existing.author || null,
      year: ref.year || existing.year || null,
      parseMethod: existing.parseMethod && ref.parseMethod ? `${ref.parseMethod}+${existing.parseMethod}` : existing.parseMethod || ref.parseMethod,
    });
  }
  return [...byNumber.values()].sort((a, b) => a.refNumber - b.refNumber);
}

function tokens(value) {
  return new Set(String(value || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/).filter((v) => v.length >= 3));
}

export function scoreCrossrefCandidate(rawCitation, candidate) {
  const rawTokens = tokens(rawCitation);
  const title = candidate?.title?.[0] || '';
  const titleTokens = tokens(title);
  let titleHits = 0;
  for (const token of titleTokens) if (rawTokens.has(token)) titleHits += 1;
  const titleScore = titleTokens.size ? titleHits / titleTokens.size : 0;
  const family = candidate?.author?.[0]?.family?.toLowerCase();
  const authorScore = family && rawCitation.toLowerCase().includes(family) ? 1 : 0;
  const year = candidate?.published?.['date-parts']?.[0]?.[0] || candidate?.issued?.['date-parts']?.[0]?.[0];
  const yearScore = year && rawCitation.includes(String(year)) ? 1 : 0;
  return Math.min(1, titleScore * 0.7 + authorScore * 0.18 + yearScore * 0.12);
}
