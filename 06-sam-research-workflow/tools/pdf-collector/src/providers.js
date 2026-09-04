import * as cheerio from 'cheerio';
import AdmZip from 'adm-zip';
import { fetchWithPolicy } from './http.js';
import { classifySupplementDescriptor } from './supplements.js';
import { normalizeDoi, sleep } from './utils.js';

function createRateGate(intervalMs) {
  let queue = Promise.resolve();
  let nextAt = 0;
  return (task) => {
    const run = queue.then(async () => {
      const waitMs = Math.max(0, nextAt - Date.now());
      if (waitMs) await sleep(waitMs);
      nextAt = Date.now() + intervalMs;
      return task();
    });
    queue = run.catch(() => {});
    return run;
  };
}

const coreRateGate = createRateGate(2100);
const semanticScholarRateGate = createRateGate(1100);
const openAireRateGate = createRateGate(250);
const halRateGate = createRateGate(250);
const zenodoRateGate = createRateGate(250);

function apiUrl(base, email, params = {}) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, value);
  if (email) url.searchParams.set('mailto', email);
  return url.href;
}

async function jsonRequest(url, email, options = {}) {
  const response = await fetchWithPolicy(url, { email, timeoutMs: 30000, retries: 1, accept: 'application/json', ...options });
  if (!response.ok) {
    const error = new Error(`API 回應 HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return JSON.parse(response.buffer.toString('utf8'));
}

function providerError(error, provider, url) {
  const wrapped = error instanceof Error ? error : new Error(String(error || 'Provider request failed'));
  wrapped.provider = provider;
  wrapped.providerUrl = url;
  wrapped.providerCode = wrapped.status ? `http_${wrapped.status}` : 'request_failed';
  return wrapped;
}

function valueOf(value) {
  if (typeof value === 'string') return value;
  if (typeof value?.$ === 'string') return value.$;
  if (typeof value?.value === 'string') return value.value;
  return '';
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined ? [] : [value];
}

function looksLikePdfUrl(value = '') {
  try {
    const url = new URL(value);
    return /\.pdf$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export async function getCrossrefWork(doi, email, endpoints = {}) {
  const normalized = normalizeDoi(doi);
  if (!normalized) return null;
  const base = endpoints.crossref || 'https://api.crossref.org';
  const data = await jsonRequest(`${base}/works/${encodeURIComponent(normalized)}${email ? `?mailto=${encodeURIComponent(email)}` : ''}`, email);
  return data.message || null;
}

export async function queryCrossref(citation, email, endpoints = {}) {
  const base = endpoints.crossref || 'https://api.crossref.org';
  const url = apiUrl(`${base}/works`, email, { 'query.bibliographic': citation, rows: 3, select: 'DOI,title,author,published,issued,URL,type' });
  const data = await jsonRequest(url, email);
  return data.message?.items || [];
}

export async function getUnpaywall(doi, email, endpoints = {}) {
  const normalized = normalizeDoi(doi);
  if (!normalized || !email) return null;
  const base = endpoints.unpaywall || 'https://api.unpaywall.org/v2';
  try {
    return await jsonRequest(`${base}/${encodeURIComponent(normalized)}?email=${encodeURIComponent(email)}`, email);
  } catch (error) {
    if (error.status === 404) return null;
    throw providerError(error, 'unpaywall', `${base}/${encodeURIComponent(normalized)}`);
  }
}

export async function getOpenAlex(doi, email, endpoints = {}, apiKey = '') {
  const normalized = normalizeDoi(doi);
  if (!normalized) return null;
  const base = endpoints.openalex || 'https://api.openalex.org';
  try {
    const params = new URLSearchParams();
    if (apiKey) params.set('api_key', apiKey);
    const suffix = params.size ? `?${params}` : '';
    return await jsonRequest(`${base}/works/https://doi.org/${normalized}${suffix}`, email);
  } catch (error) {
    if (error.status === 404) return null;
    throw providerError(error, 'openalex', `${base}/works/https://doi.org/${normalized}`);
  }
}

function openAireResults(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  const legacy = data?.response?.results?.result;
  return asArray(legacy).map((entry) =>
    entry?.metadata?.['oaf:entity']?.['oaf:result']
      || entry?.metadata?.['oaf:entity']?.result
      || entry?.metadata
      || entry,
  );
}

/**
 * Query OpenAIRE by DOI.
 *
 * The current Graph v3 API is used by default.  A legacy
 * `/search/publications` endpoint may still be supplied by tests or local
 * configuration; both response shapes are normalized to an array here.
 * Non-404 errors retain HTTP status plus provider metadata so the collector
 * can write a useful provider trace instead of treating every failure as an
 * empty result.
 */
export async function getOpenAirePublications(doi, email, endpoints = {}) {
  const normalized = normalizeDoi(doi);
  if (!normalized) return [];
  const base = endpoints.openAire || endpoints.openaire
    || 'https://api.openaire.eu/graph/v3/research-products';
  const url = new URL(base);
  if (/\/search\/publications\/?$/i.test(url.pathname)) {
    url.searchParams.set('doi', normalized);
    url.searchParams.set('format', 'json');
    url.searchParams.set('size', '10');
  } else {
    url.searchParams.set('pid', normalized);
    url.searchParams.set('type', 'publication');
    url.searchParams.set('pageSize', '10');
  }
  try {
    const data = await openAireRateGate(() => jsonRequest(url.href, email, { retries:0 }));
    return openAireResults(data);
  } catch (error) {
    if (error.status === 404) return [];
    throw providerError(error, 'openaire', url.href);
  }
}

export async function getCoreWorks(doi, apiKey, endpoints = {}) {
  const normalized = normalizeDoi(doi);
  if (!normalized || !apiKey) return [];
  const base = endpoints.core || 'https://api.core.ac.uk/v3';
  const query = encodeURIComponent(`doi:${normalized}`);
  try {
    const data = await coreRateGate(() => jsonRequest(`${base}/search/works?q=${query}&limit=10`, '', { headers: { Authorization: `Bearer ${apiKey}` } }));
    const results = data.results || [];
    const exact = results.filter((record) => normalizeDoi(record?.doi) === normalized);
    const selected = (exact.length ? exact : results).slice(0, 3);
    const outputUrls = [...new Set(selected.flatMap((record) => record?.outputs || []).map((output) => {
      if (typeof output === 'string') return output;
      if (output?.id) return `${base}/outputs/${encodeURIComponent(output.id)}`;
      return output?.url || null;
    }).filter(Boolean))].slice(0, 5);
    const hydrated = [];
    for (const outputUrl of outputUrls) {
      try {
        const url = new URL(outputUrl, base);
        if (url.hostname !== new URL(base).hostname) continue;
        const output = await jsonRequest(url.href, '', { headers: { Authorization: `Bearer ${apiKey}` }, retries: 0 });
        hydrated.push({ ...output, coreOutput: true, apiDownloadUrl: `${url.href.replace(/\/$/, '')}/download` });
      } catch { /* CORE 的個別 output 失效時仍保留 work metadata。 */ }
    }
    return [...hydrated, ...selected];
  } catch (error) {
    if (error.status === 404) return [];
    throw providerError(error, 'core', `${base}/search/works`);
  }
}

export async function getSemanticScholar(doi, apiKey = '', endpoints = {}) {
  const normalized = normalizeDoi(doi);
  if (!normalized) return null;
  const base = endpoints.semanticScholar || 'https://api.semanticscholar.org/graph/v1';
  const headers = apiKey ? { 'x-api-key': apiKey } : {};
  try {
    return await semanticScholarRateGate(() => jsonRequest(
      `${base}/paper/DOI:${encodeURIComponent(normalized)}?fields=paperId,title,url,externalIds,openAccessPdf`,
      '', { headers, retries: 0 },
    ));
  } catch (error) {
    if (error.status === 404) return null;
    throw providerError(error, 'semantic_scholar', `${base}/paper/DOI:${normalized}`);
  }
}

export function supplementCandidatesFromFigshareRecords(records, doi) {
  const normalized = normalizeDoi(doi);
  const candidates = [];
  for (const record of records || []) {
    if (normalizeDoi(record?.resource_doi) !== normalized) continue;
    for (const file of record.files || []) {
      if (!/\.(?:pdf|docx?)$/i.test(file?.name || '')) continue;
      addCandidate(candidates, file.download_url, 'Figshare API', 'oa', {
        supplement:true,
        evidence:'confirmed',
        label:`Supporting Information ${file.name}`,
        contentType:file.name.toLowerCase().endsWith('.docx')
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : file.name.toLowerCase().endsWith('.doc') ? 'application/msword' : 'application/pdf',
        referer:record.url_public_html || undefined,
        apiService:'figshare',
      });
    }
  }
  return candidates;
}

export async function getFigshareSupplementCandidates(doi, email, endpoints = {}) {
  const normalized = normalizeDoi(doi);
  if (!normalized) return [];
  const base = endpoints.figshare || 'https://api.figshare.com/v2';
  try {
    const matches = await jsonRequest(`${base}/articles/search`, email, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({ resource_doi:normalized }),
      retries:0,
    });
    const exact = (matches || []).filter((record) => normalizeDoi(record?.resource_doi) === normalized).slice(0, 3);
    const details = [];
    for (const record of exact) {
      try {
        details.push(await jsonRequest(record.url_public_api || `${base}/articles/${record.id}`, email, { retries:0 }));
      } catch { /* 個別 Figshare 記錄失效時略過。 */ }
    }
    return supplementCandidatesFromFigshareRecords(details, normalized);
  } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }
}

export function supplementCandidatesFromEuropePmcArchive(buffer, pmcid, archiveUrl) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return [];
  const candidates = [];
  try {
    const zip = new AdmZip(buffer);
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const name = String(entry.entryName || '').split('/').at(-1) || '';
      const extension = name.toLowerCase().match(/\.(pdf|docx?)$/)?.[1];
      if (!extension) continue;
      const classification = classifySupplementDescriptor({ url:name, label:`Supplementary Information ${name}` });
      if (classification.classification === 'excluded_attachment') continue;
      const localBuffer = entry.getData();
      if (!localBuffer.length) continue;
      candidates.push({
        url:`${archiveUrl}#${encodeURIComponent(name)}`,
        source:'Europe PMC supplementaryFiles API', access:'oa', supplement:true,
        evidence:'confirmed',
        label:`Supplementary Information ${name}`,
        contentType:extension === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : extension === 'doc' ? 'application/msword' : 'application/pdf',
        localBuffer, archiveEntryName:name, pmcid,
      });
    }
  } catch { return []; }
  return candidates;
}

export async function getEuropePmcSupplementCandidates(doi, email, endpoints = {}) {
  const normalized = normalizeDoi(doi);
  if (!normalized) return [];
  const base = endpoints.europePmc || 'https://www.ebi.ac.uk/europepmc/webservices/rest';
  try {
    const search = apiUrl(`${base}/search`, '', {
      query:`DOI:"${normalized}"`, resultType:'core', format:'json', pageSize:5,
    });
    const data = await jsonRequest(search, email, { retries:0 });
    const record = (data.resultList?.result || []).find((entry) => normalizeDoi(entry?.doi) === normalized && entry?.pmcid);
    if (!record) return [];
    const archiveUrl = `${base}/${encodeURIComponent(record.pmcid)}/supplementaryFiles`;
    const response = await fetchWithPolicy(archiveUrl, {
      email, timeoutMs:60000, retries:1, maxBytes:120 * 1024 * 1024,
      accept:'application/zip,application/octet-stream;q=0.9',
    });
    if (!response.ok) {
      if (response.status === 404) return [];
      const error = new Error(`Europe PMC supplementaryFiles 回應 HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return supplementCandidatesFromEuropePmcArchive(response.buffer, record.pmcid, archiveUrl);
  } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }
}

export function candidatesFromEuropePmcRecords(records, doi = '') {
  const normalized = normalizeDoi(doi);
  const candidates = [];
  for (const record of records || []) {
    if (String(record?.source || '').toUpperCase() === 'PPR') continue;
    const recordDoi = normalizeDoi(record?.doi);
    if (normalized && recordDoi && recordDoi !== normalized) continue;
    const pmcid = String(record?.pmcid || '').toUpperCase();
    if (!/^PMC\d+$/.test(pmcid)) continue;
    const manuscript = Boolean(
      record?.manuscriptId
      || /author\s+(?:accepted\s+)?manuscript/i.test(String(record?.pubType || record?.publicationType || '')),
    );
    const common = {
      apiService:'europe_pmc',
      documentVersion:manuscript ? 'aam' : 'vor',
      license:record?.license || undefined,
      pmcid,
    };
    addCandidate(
      candidates,
      `https://europepmc.org/articles/${pmcid.toLowerCase()}?pdf=render`,
      'Europe PMC main PDF',
      'oa',
      common,
    );
    addCandidate(
      candidates,
      `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/pdf/`,
      'PubMed Central main PDF',
      'oa',
      common,
    );
  }
  return candidates;
}

export async function getEuropePmcMainCandidates(doi, email, endpoints = {}) {
  const normalized = normalizeDoi(doi);
  if (!normalized) return [];
  const base = endpoints.europePmc || 'https://www.ebi.ac.uk/europepmc/webservices/rest';
  const search = apiUrl(`${base}/search`, '', {
    query:`DOI:"${normalized}"`, resultType:'core', format:'json', pageSize:5,
  });
  try {
    const data = await jsonRequest(search, email, { retries:0 });
    return candidatesFromEuropePmcRecords(data.resultList?.result || [], normalized);
  } catch (error) {
    if (error.status === 404) return [];
    throw providerError(error, 'europe_pmc', search);
  }
}

function addCandidate(list, url, source, access = 'unknown', extra = {}) {
  if (!url) return;
  try {
    const href = new URL(url).href;
    if (!list.some((candidate) => candidate.url === href)) list.push({ url: href, source, access, ...extra });
  } catch { /* 忽略不完整 URL */ }
}

export function classifySupplementLink(url = '', label = '', extra = {}) {
  return classifySupplementDescriptor({ url, label, ...extra });
}

export function isSupplementLink(url = '', label = '') {
  return classifySupplementLink(url, label).classification === 'si';
}

export function candidatesFromCrossref(work) {
  const candidates = [];
  for (const link of work?.link || []) {
    const type = String(link['content-type'] || '').toLowerCase();
    const label = [link['content-version'], link.intended_application, link.label].filter(Boolean).join(' ');
    if (classifySupplementLink(link.URL, label, { contentType:type }).classification !== 'unknown') continue;
    if (type.includes('pdf') || /\.pdf(?:$|[?#])/i.test(link.URL || '')) addCandidate(candidates, link.URL, 'Crossref/TDM', 'unknown');
  }
  return candidates;
}

export function supplementCandidatesFromCrossref(work, { includeExcluded = false } = {}) {
  const candidates = [];
  for (const link of work?.link || []) {
    const label = [link['content-version'], link.intended_application, link.label].filter(Boolean).join(' ');
    const contentType = String(link['content-type'] || '');
    const classification = classifySupplementLink(link.URL, label, { contentType });
    if (classification.classification === 'si' || (includeExcluded && classification.classification === 'excluded_attachment')) {
      const previousLength = candidates.length;
      addCandidate(candidates, link.URL, 'Crossref supplementary metadata', 'unknown', { supplement: true });
      if (candidates.length > previousLength) Object.assign(candidates.at(-1), { label, contentType, evidence:'confirmed', ...classification });
    }
  }
  return candidates;
}

export function candidatesFromUnpaywall(record) {
  const candidates = [];
  const locations = [record?.best_oa_location, ...(record?.oa_locations || [])].filter(Boolean);
  for (const location of locations) {
    addCandidate(candidates, location.url_for_pdf, 'Unpaywall OA', 'oa');
    if (location.url) addCandidate(candidates, location.url, 'Unpaywall landing', 'oa', { landing: true });
  }
  return candidates;
}

export function candidatesFromOpenAlex(record) {
  const candidates = [];
  const locations = [record?.best_oa_location, record?.primary_location, ...(record?.locations || [])].filter(Boolean);
  for (const location of locations) {
    addCandidate(candidates, location.pdf_url, 'OpenAlex OA', 'oa');
    if (location.landing_page_url) addCandidate(candidates, location.landing_page_url, 'OpenAlex landing', 'oa', { landing: true });
  }
  return candidates;
}

export function candidatesFromOpenAlexContent(record, apiKey) {
  const candidates = [];
  const workId = String(record?.id || '').split('/').pop();
  if (!apiKey || !workId || !record?.has_content?.pdf) return candidates;
  const publicUrl = `https://content.openalex.org/works/${encodeURIComponent(workId)}.pdf`;
  addCandidate(candidates, publicUrl, 'OpenAlex Content API', record?.open_access?.is_oa ? 'oa' : 'unknown', {
    requestUrl: `${publicUrl}?api_key=${encodeURIComponent(apiKey)}`,
    apiService: 'openalex',
  });
  return candidates;
}

function openAireVersion(value = '') {
  const label = String(value).toLowerCase();
  if (/pre[- ]?print|submitted|working paper|draft/.test(label)) return 'preprint';
  if (/accepted|post[- ]?print|author manuscript|\baam\b/.test(label)) return 'aam';
  if (/version of record|published version|publisher version/.test(label)) return 'vor';
  return null;
}

function openAireAccess(value) {
  const label = String(
    value?.label || value?.classname || value?.['@classname'] || value?.$ || value || '',
  ).toLowerCase();
  return /open|free|public/.test(label) ? 'oa' : 'unknown';
}

function modernOpenAireInstances(record) {
  return asArray(record?.instances).flatMap((entry) => Array.isArray(entry) ? entry : [entry]);
}

function legacyOpenAireInstances(record) {
  const children = record?.children || record?.['oaf:result']?.children;
  return asArray(children?.instance);
}

function openAireRecordDois(record) {
  return [
    ...asArray(record?.pids).filter((pid) => String(pid?.scheme || '').toLowerCase() === 'doi').map((pid) => pid?.value),
    ...asArray(record?.originalIds),
    ...asArray(record?.pid).filter((pid) => String(pid?.['@classid'] || pid?.classid || '').toLowerCase() === 'doi').map(valueOf),
  ].map(normalizeDoi).filter(Boolean);
}

export function candidatesFromOpenAire(records, doi = '') {
  const normalized = normalizeDoi(doi);
  const candidates = [];
  for (const wrapper of records || []) {
    const record = wrapper?.metadata?.['oaf:entity']?.['oaf:result']
      || wrapper?.['oaf:result']
      || wrapper;
    const recordDois = openAireRecordDois(record);
    if (normalized && recordDois.length && !recordDois.includes(normalized)) continue;

    for (const instance of [...modernOpenAireInstances(record), ...legacyOpenAireInstances(record)]) {
      const type = valueOf(instance?.type) || valueOf(instance?.instancetype)
        || valueOf(instance?.instancetype?.classname)
        || valueOf(instance?.instancetype?.['@classname']);
      const version = openAireVersion(type);
      if (version === 'preprint') continue;
      const access = openAireAccess(instance?.accessRight || instance?.accessright || record?.bestAccessRight);
      const license = valueOf(instance?.license) || undefined;
      const urls = [
        ...asArray(instance?.urls),
        ...asArray(instance?.webresource).flatMap((resource) => asArray(resource?.url)),
      ].map(valueOf).filter(Boolean);
      for (const url of urls) {
        addCandidate(candidates, url, 'OpenAIRE Graph', access, {
          apiService:'openaire',
          landing:!looksLikePdfUrl(url),
          repository:true,
          license,
          documentVersion:version || undefined,
        });
      }
    }
  }
  return candidates;
}

export function candidatesFromCore(records, apiKey = '') {
  const candidates = [];
  for (const record of records || []) {
    if (record.apiDownloadUrl) {
      addCandidate(candidates, record.apiDownloadUrl, 'CORE API download', 'oa', {
        apiService:'core',
        landing:false,
        repository:true,
        ...(apiKey ? { headers:{ Authorization:`Bearer ${apiKey}` } } : {}),
      });
    }
    for (const url of record.sourceFulltextUrls || []) {
      addCandidate(candidates, url, 'CORE repository', 'oa', {
        apiService: 'core',
        landing: !/\.pdf(?:$|[?#])/i.test(url),
        repository:true,
      });
    }
    if (record.fullTextUrl) addCandidate(candidates, record.fullTextUrl, 'CORE API', 'oa', {
      apiService: 'core', landing: !looksLikePdfUrl(record.fullTextUrl), repository:true,
    });
    if (record.downloadUrl) {
      addCandidate(candidates, record.downloadUrl, 'CORE API', 'oa', {
        apiService:'core',
        landing:false,
        repository:true,
      });
    }
  }
  return candidates;
}

export function candidatesFromSemanticScholar(record) {
  const candidates = [];
  const pdfUrl = record?.openAccessPdf?.url;
  if (pdfUrl) {
    addCandidate(candidates, pdfUrl, 'Semantic Scholar API', 'oa', {
      apiService:'semantic_scholar',
      landing:!looksLikePdfUrl(pdfUrl),
      repository:true,
    });
  }
  if (record?.url) {
    addCandidate(candidates, record.url, 'Semantic Scholar landing', 'unknown', {
      apiService:'semantic_scholar',
      landing:true,
    });
  }
  return candidates;
}

export function authenticatedPublisherCandidates(doi, credentials = {}) {
  const normalized = normalizeDoi(doi);
  const candidates = [];
  if (!normalized) return candidates;
  if (normalized.startsWith('10.1002/') && credentials.wileyTdmClientToken) {
    addCandidate(candidates, `https://api.wiley.com/onlinelibrary/tdm/v1/articles/${encodeURIComponent(normalized)}`, 'Wiley TDM API', 'publisher', {
      apiService: 'wiley', headers: { 'Wiley-TDM-Client-Token': credentials.wileyTdmClientToken },
    });
  }
  if (normalized.startsWith('10.1016/') && credentials.elsevierApiKey) {
    const headers = { 'X-ELS-APIKey': credentials.elsevierApiKey };
    if (credentials.elsevierInstToken) headers['X-ELS-Insttoken'] = credentials.elsevierInstToken;
    addCandidate(candidates, `https://api.elsevier.com/content/article/doi/${encodeURIComponent(normalized)}?amsRedirect=true&httpAccept=application%2Fpdf`, 'Elsevier Article API', 'publisher', {
      apiService: 'elsevier', headers,
    });
  }
  return candidates;
}

function splitHttpList(value, separator) {
  const items = [];
  let current = '';
  let quoted = false;
  let angleDepth = 0;
  let escaped = false;
  for (const character of String(value || '')) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      current += character;
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === '<') angleDepth += 1;
    else if (!quoted && character === '>') angleDepth = Math.max(0, angleDepth - 1);
    if (!quoted && angleDepth === 0 && character === separator) {
      if (current.trim()) items.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

export function parseSignpostingLinks(header, baseUrl = '') {
  const values = Array.isArray(header) ? header : [header];
  const links = [];
  for (const value of values.filter(Boolean)) {
    for (const entry of splitHttpList(value, ',')) {
      const target = entry.match(/^\s*<([^>]+)>/)?.[1];
      if (!target) continue;
      let url;
      try { url = new URL(target, baseUrl || undefined).href; } catch { continue; }
      const params = {};
      const remainder = entry.slice(entry.indexOf('>') + 1);
      for (const segment of splitHttpList(remainder, ';')) {
        const match = segment.match(/^\s*([^=\s]+)\s*=\s*(?:"((?:\\.|[^"])*)"|([^;\s]+))\s*$/);
        if (!match) continue;
        const key = match[1].toLowerCase();
        params[key] = (match[2] ?? match[3] ?? '').replace(/\\"/g, '"');
      }
      const rel = String(params.rel || '').toLowerCase().split(/\s+/).filter(Boolean);
      links.push({
        url,
        rel,
        type:params.type || '',
        anchor:params.anchor || '',
        profile:params.profile || '',
        params,
      });
    }
  }
  return links;
}

export function candidatesFromSignposting(header, baseUrl) {
  const links = parseSignpostingLinks(header, baseUrl);
  const candidates = [];
  const license = links.find((link) => link.rel.includes('license'))?.url;
  for (const link of links) {
    if (!link.rel.some((rel) => rel === 'item' || rel === 'alternate')) continue;
    if (!/application\/pdf/i.test(link.type) && !looksLikePdfUrl(link.url)) continue;
    addCandidate(candidates, link.url, 'FAIR Signposting', 'unknown', {
      apiService:'signposting',
      referer:baseUrl,
      repository:true,
      license,
      contentType:link.type || 'application/pdf',
    });
  }
  return candidates;
}

export async function getSignpostingCandidates(landingUrl, email = '') {
  let response;
  try {
    response = await fetchWithPolicy(landingUrl, {
      email,
      method:'HEAD',
      timeoutMs:30000,
      retries:0,
      maxBytes:1024,
      accept:'text/html,application/pdf;q=0.8,*/*;q=0.1',
    });
  } catch (error) {
    throw providerError(error, 'signposting', landingUrl);
  }
  if (!response.ok) {
    const error = new Error(`FAIR Signposting 回應 HTTP ${response.status}`);
    error.status = response.status;
    throw providerError(error, 'signposting', landingUrl);
  }
  return candidatesFromSignposting(response.headers.link, response.finalUrl || landingUrl);
}

function repositoryPlatformLabel($, baseUrl) {
  const url = new URL(baseUrl);
  const host = url.hostname.toLowerCase();
  const generator = [
    $('meta[name="generator"]').attr('content'),
    $('meta[name="application-name"]').attr('content'),
    $('body').attr('class'),
  ].filter(Boolean).join(' ');
  if (host === 'zenodo.org' || host.endsWith('.zenodo.org') || /\bzenodo\b/i.test(generator)) return 'Zenodo repository';
  if (host.includes('archives-ouvertes.fr') || host === 'hal.science' || host.endsWith('.hal.science')) return 'HAL repository';
  if (/\beprints\b/i.test(generator) || $('meta[name="eprints.document_url"]').length) return 'EPrints repository';
  if (/\bpure\b/i.test(generator) || /\/(?:en\/)?publications?\//i.test(url.pathname)) return 'Pure repository';
  if (/\bdspace\b/i.test(generator) || /\/(?:handle|items|entities\/publication)\//i.test(url.pathname)) return 'DSpace repository';
  return null;
}

export function candidatesFromHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  const candidates = [];
  let platform = null;
  try { platform = repositoryPlatformLabel($, baseUrl); } catch { /* malformed base URL */ }
  const selectors = [
    ['meta[name="citation_pdf_url"]', 'content'],
    ['meta[name="eprints.document_url"]', 'content'],
    ['meta[property="og:pdf"]', 'content'],
    ['meta[name="pdf_url"]', 'content'],
    ['meta[name="wkhealth_pdf_url"]', 'content'],
    ['link[type="application/pdf"]', 'href'],
    ['a[href$=".pdf"]', 'href'],
    ['a[href*="/pdf/"]', 'href'],
    ['a[href*="/epdf/"]', 'href'],
    ['a[href*="articlepdf"]', 'href'],
    ['a[href*="download=true"]', 'href'],
    ['a[href*="type=printable"]', 'href'],
  ];
  for (const [selector, attribute] of selectors) {
    $(selector).each((_, element) => {
      const value = $(element).attr(attribute);
      if (!value) return;
      const label = [$(element).text(), $(element).attr('title'), $(element).attr('aria-label')].filter(Boolean).join(' ');
      if (classifySupplementLink(value, label).classification !== 'unknown') return;
      try {
        addCandidate(
          candidates,
          new URL(value, baseUrl).href,
          platform || publisherLabel(baseUrl),
          platform ? 'unknown' : 'publisher',
          { referer:baseUrl, ...(platform ? { repository:true } : {}) },
        );
      } catch { /* noop */ }
    });
  }
  return candidates;
}

export function oaiRecordUrlsFromHtml(html, baseUrl) {
  const $ = cheerio.load(String(html || ''));
  const urls = [];
  const add = (value) => {
    if (!value) return;
    try {
      const href = new URL(value, baseUrl).href;
      if (!urls.includes(href)) urls.push(href);
    } catch { /* ignore malformed discovery link */ }
  };
  $('meta').each((_, element) => {
    for (const [name, value] of Object.entries(element.attribs || {})) {
      if (/^oaipmhrecord$/i.test(name)) add(value);
    }
    const name = String($(element).attr('name') || '');
    const content = String($(element).attr('content') || '');
    if (/oaipmhrecord/i.test(name) || /[?&]verb=GetRecord(?:&|$)/i.test(content)) add(content);
  });
  $('link[rel~="alternate"], a[href*="verb=GetRecord"]').each((_, element) => {
    const type = String($(element).attr('type') || '');
    const href = String($(element).attr('href') || '');
    if (/oai/i.test(type) || /[?&]verb=GetRecord(?:&|$)/i.test(href)) add(href);
  });
  return urls.slice(0, 3);
}

function doisInText(value) {
  return [...String(value || '').matchAll(/10\.\d{4,9}\/[^\s"'<>,;]+/gi)]
    .map((match) => normalizeDoi(match[0]))
    .filter(Boolean);
}

export function candidatesFromOaiPmhXml(xml, baseUrl, doi = '') {
  const $ = cheerio.load(String(xml || ''), { xmlMode:true });
  const metadata = $('metadata').first();
  if (!metadata.length || $('error').length) return [];
  const normalized = normalizeDoi(doi);
  const foundDois = [...new Set(doisInText(metadata.text()))];
  if (normalized && foundDois.length && !foundDois.includes(normalized)) return [];
  const candidates = [];
  metadata.find('*').each((_, element) => {
    const tag = String(element.name || '').split(':').pop().toLowerCase();
    if (!['identifier', 'relation', 'format', 'resource', 'file', 'distribution', 'accessurl', 'downloadurl'].includes(tag)) return;
    const values = [
      $(element).text(),
      $(element).attr('href'),
      $(element).attr('xlink:href'),
      $(element).attr('resource'),
      $(element).attr('rdf:resource'),
    ].filter(Boolean);
    for (const value of values) {
      for (const match of String(value).matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
        const url = match[0].replace(/[).,;]+$/, '');
        const type = [
          $(element).attr('type'),
          $(element).attr('format'),
          $(element).attr('mimetype'),
        ].filter(Boolean).join(' ');
        if (!looksLikePdfUrl(url) && !/application\/pdf/i.test(type)) continue;
        addCandidate(candidates, url, 'OAI-PMH repository', 'unknown', {
          repository:true,
          documentVersion:'aam',
          referer:baseUrl,
        });
      }
    }
  });
  return candidates;
}

export async function getOaiPmhCandidates(recordUrls = [], doi = '', email = '') {
  const candidates = [];
  for (const recordUrl of [...new Set(recordUrls)].slice(0, 3)) {
    let response;
    try {
      response = await fetchWithPolicy(recordUrl, {
        email,
        timeoutMs:30000,
        retries:0,
        maxBytes:10 * 1024 * 1024,
        accept:'application/xml,text/xml;q=0.9,*/*;q=0.1',
      });
    } catch (error) {
      throw providerError(error, 'oai-pmh', recordUrl);
    }
    if (!response.ok) {
      const error = new Error(`OAI-PMH 回應 HTTP ${response.status}`);
      error.status = response.status;
      throw providerError(error, 'oai-pmh', recordUrl);
    }
    for (const candidate of candidatesFromOaiPmhXml(response.buffer.toString('utf8'), response.finalUrl, doi)) {
      if (!candidates.some((current) => current.url === candidate.url)) candidates.push(candidate);
    }
  }
  return candidates;
}

export function candidatesFromHalResponse(payload, doi = '') {
  const normalized = normalizeDoi(doi);
  const candidates = [];
  for (const record of asArray(payload?.response?.docs || payload?.docs)) {
    const recordDois = [
      ...asArray(record?.doiId_s),
      ...asArray(record?.doi_s),
    ].map(normalizeDoi).filter(Boolean);
    if (normalized && recordDois.length && !recordDois.includes(normalized)) continue;
    const values = [
      ...asArray(record?.fileMain_s),
      ...asArray(record?.files_s),
    ].filter((value) => typeof value === 'string');
    for (const value of values) {
      for (const match of value.matchAll(/https?:\/\/[^\s,;]+/gi)) {
        addCandidate(candidates, match[0], 'HAL repository', 'oa', {
          apiService:'hal',
          repository:true,
          documentVersion:/preprint/i.test(String(record?.docType_s || '')) ? 'preprint' : 'aam',
          license:asArray(record?.license_s)[0] || undefined,
        });
      }
    }
  }
  return candidates;
}

export async function getHalCandidates(doi, email = '', endpoints = {}) {
  const normalized = normalizeDoi(doi);
  if (!normalized) return [];
  const base = endpoints.hal || 'https://api.archives-ouvertes.fr/search/';
  const url = new URL(base);
  url.searchParams.set('q', `doiId_s:"${normalized}"`);
  url.searchParams.set('fl', 'doiId_s,doi_s,fileMain_s,files_s,docType_s,license_s');
  url.searchParams.set('rows', '10');
  url.searchParams.set('wt', 'json');
  try {
    const data = await halRateGate(() => jsonRequest(url.href, email, { retries:0 }));
    return candidatesFromHalResponse(data, normalized);
  } catch (error) {
    if (error.status === 404) return [];
    throw providerError(error, 'hal', url.href);
  }
}

function zenodoRecordDois(record) {
  const identifiers = [
    record?.doi,
    record?.metadata?.doi,
    record?.pids?.doi?.identifier,
    ...asArray(record?.metadata?.related_identifiers).map((entry) => entry?.identifier),
  ];
  return [...new Set(identifiers.map(normalizeDoi).filter(Boolean))];
}

export function candidatesFromZenodoResponse(payload, doi = '') {
  const normalized = normalizeDoi(doi);
  const records = asArray(payload?.hits?.hits || payload?.records || payload);
  const candidates = [];
  for (const record of records) {
    const recordDois = zenodoRecordDois(record);
    if (normalized && recordDois.length && !recordDois.includes(normalized)) continue;
    const license = record?.metadata?.license?.id || record?.metadata?.license || undefined;
    const versionEvidence = [
      record?.metadata?.resource_type?.title,
      record?.metadata?.description,
      record?.metadata?.notes,
    ].filter(Boolean).join(' ');
    const documentVersion = /preprint|submitted manuscript/i.test(versionEvidence) ? 'preprint' : 'aam';
    for (const file of asArray(record?.files)) {
      const name = String(file?.key || file?.filename || '');
      const type = String(file?.type || file?.mimetype || '');
      if (!/\.pdf$/i.test(name) && !/application\/pdf/i.test(type)) continue;
      const url = file?.links?.content || file?.links?.download || file?.links?.self || file?.download;
      addCandidate(candidates, url, 'Zenodo repository', 'oa', {
        apiService:'zenodo',
        repository:true,
        documentVersion,
        license,
      });
    }
  }
  return candidates;
}

export async function getZenodoCandidates(doi, email = '', endpoints = {}) {
  const normalized = normalizeDoi(doi);
  if (!normalized) return [];
  const base = endpoints.zenodo || 'https://zenodo.org/api/records';
  const url = new URL(base);
  url.searchParams.set('q', `doi:"${normalized}" OR related_identifiers.identifier:"${normalized}"`);
  url.searchParams.set('size', '10');
  try {
    const data = await zenodoRateGate(() => jsonRequest(url.href, email, { retries:0 }));
    return candidatesFromZenodoResponse(data, normalized);
  } catch (error) {
    if (error.status === 404) return [];
    throw providerError(error, 'zenodo', url.href);
  }
}

export function supplementCandidatesFromHtml(html, baseUrl, { includeExcluded = false } = {}) {
  const $ = cheerio.load(html);
  const candidates = [];
  const addValue = (value, label = '', element = null) => {
    if (!value) return;
    const contentType = element ? ($(element).attr('type') || '') : '';
    const classification = classifySupplementLink(value, label, { contentType });
    if (classification.classification !== 'si' && !(includeExcluded && classification.classification === 'excluded_attachment')) return;
    try {
      addCandidate(candidates, new URL(value, baseUrl).href, `${publisherLabel(baseUrl)} SI`, 'publisher', {
        referer: baseUrl, supplement: true, evidence:'confirmed', label, title:element ? ($(element).attr('title') || '') : '',
        ariaLabel:element ? ($(element).attr('aria-label') || '') : '', contentType, ...classification,
      });
    } catch { /* 忽略不完整 URL。 */ }
  };
  const attributes = ['href', 'content', 'data-url', 'data-download-url', 'data-file', 'data-link', 'data-supplementary-material-url'];
  $(attributes.map((attribute) => `[${attribute}]`).join(',')).each((_, element) => {
    const contextHeading = $(element).closest('section,li,tr,article').find('h1,h2,h3,h4,th').first().text().trim();
    const label = [$(element).text(), $(element).attr('title'), $(element).attr('aria-label'), $(element).attr('type'), contextHeading]
      .filter(Boolean).join(' ').slice(0, 1000);
    for (const attribute of attributes) addValue($(element).attr(attribute), label, element);
  });
  const embedded = String(html || '')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/');
  for (const match of embedded.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)) addValue(match[0], match[0]);
  return candidates;
}

export function supplementCandidatesFromJatsXml(xml, baseUrl) {
  const $ = cheerio.load(String(xml || ''), { xmlMode:true });
  const candidates = [];
  $('supplementary-material, supplementary-data, media, related-object').each((_, element) => {
    const node = $(element);
    const context = node.closest('supplementary-material, supplementary-data');
    const value = node.attr('xlink:href') || node.attr('href') || node.attr('url')
      || context.attr('xlink:href') || context.attr('href');
    if (!value) return;
    const label = [context.attr('content-type'), context.find('label,title,caption').first().text(), node.attr('content-type'), value]
      .filter(Boolean).join(' ');
    const explicitContext = context.length > 0;
    const classification = classifySupplementLink(value, explicitContext ? `Supplementary Information ${label}` : label, {
      contentType:node.attr('mimetype') || node.attr('content-type') || '',
    });
    if (classification.classification !== 'si') return;
    try {
      addCandidate(candidates, new URL(value, baseUrl).href, 'Crossref/JATS supplementary metadata', 'unknown', {
        supplement:true, evidence:'confirmed', label:`Supplementary Information ${label}`, referer:baseUrl, ...classification,
      });
    } catch { /* 略過不完整的 XML URL。 */ }
  });
  return candidates;
}

export async function getCrossrefTdmSupplementCandidates(work, email) {
  const candidates = [];
  const xmlLinks = (work?.link || []).filter((link) => {
    const type = String(link?.['content-type'] || '').toLowerCase();
    return type.includes('xml') || /\.xml(?:$|[?#])/i.test(link?.URL || '');
  }).slice(0, 3);
  for (const link of xmlLinks) {
    try {
      const response = await fetchWithPolicy(link.URL, {
        email, timeoutMs:45000, retries:0, maxBytes:25 * 1024 * 1024,
        accept:'application/xml,text/xml,application/jats+xml;q=0.9,*/*;q=0.2',
      });
      const type = String(response.headers['content-type'] || '').toLowerCase();
      if (!response.ok || type.includes('html')) continue;
      for (const candidate of supplementCandidatesFromJatsXml(response.buffer.toString('utf8'), response.finalUrl)) {
        if (!candidates.some((current) => current.url === candidate.url)) candidates.push(candidate);
      }
    } catch { /* 單一 TDM XML 失效時不阻塞其他 provider。 */ }
  }
  return candidates;
}

export function candidatesFromDspaceBitstreams(records = [], bundleName = '', landingUrl = '') {
  const candidates = [];
  const supplementalBundle = /supplement|support/i.test(bundleName);
  for (const record of records) {
    const name = String(record?.name || record?.metadata?.['dc.title']?.[0]?.value || 'bitstream');
    const description = String(record?.description || record?.metadata?.['dc.description']?.[0]?.value || '');
    const extension = name.toLowerCase().match(/\.(pdf|docx?)$/)?.[1];
    if (!extension) continue;
    const likelySiName = /(?:^|[_ .-])(?:si|supp(?:lement(?:ary)?)?|support(?:ing)?|s\d+)(?:[_ .-]|$)/i.test(name);
    const label = [supplementalBundle || likelySiName ? 'Supplementary Information' : '', bundleName, name, description]
      .filter(Boolean).join(' ');
    const classification = classifySupplementDescriptor({ url:name, label });
    if (classification.classification === 'excluded_attachment') continue;
    const contentUrl = record?._links?.content?.href || record?.downloadUrl;
    if (!contentUrl) continue;
    if (classification.classification === 'si') {
      addCandidate(candidates, contentUrl, 'DSpace 7 REST API', 'oa', {
        supplement:true, evidence:'confirmed', label, referer:landingUrl,
        contentType:extension === 'pdf' ? 'application/pdf'
          : extension === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/msword',
      });
    } else if (extension === 'pdf' && /^original$/i.test(bundleName)) {
      addCandidate(candidates, contentUrl, 'DSpace 7 repository', 'oa', { referer:landingUrl });
    }
  }
  return candidates;
}

export function candidatesFromDspace6Bitstreams(records = [], origin = '', landingUrl = '') {
  const candidates = [];
  for (const record of records || []) {
    const retrieve = record?.retrieveLink
      || record?._links?.content?.href
      || (record?.uuid ? `/rest/bitstreams/${record.uuid}/retrieve` : null);
    if (!retrieve) continue;
    let downloadUrl;
    try { downloadUrl = new URL(retrieve, origin).href; } catch { continue; }
    const bundleName = String(record?.bundleName || record?.bundle || 'ORIGINAL');
    const found = candidatesFromDspaceBitstreams(
      [{ ...record, downloadUrl }],
      bundleName,
      landingUrl,
    );
    for (const candidate of found) {
      candidate.source = candidate.supplement ? 'DSpace 6 REST API' : 'DSpace 6 repository';
      if (!candidates.some((current) => current.url === candidate.url)) candidates.push(candidate);
    }
  }
  return candidates;
}

export function dspaceItemApiUrls(value) {
  try {
    const url = new URL(value);
    const paths = [
      /(?:\/server\/api\/core)?\/items\/([0-9a-f]{8}-[0-9a-f-]{27,})/i,
      /\/entities\/publication\/([0-9a-f]{8}-[0-9a-f-]{27,})/i,
    ];
    const uuid = paths.map((pattern) => url.pathname.match(pattern)?.[1]).find(Boolean);
    return uuid ? [`${url.origin}/server/api/core/items/${uuid}`] : [];
  } catch {
    return [];
  }
}

function dspaceRepositoryOrigin(value) {
  try {
    const url = new URL(value);
    if (['doi.org', 'dx.doi.org', 'hdl.handle.net'].includes(url.hostname.toLowerCase())) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function handleIdentifier(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/handle\/(.+?)\/?$/i);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function dspace6RepositoryOrigins(landingUrls = []) {
  const origins = [];
  for (const landingUrl of landingUrls || []) {
    try {
      const url = new URL(landingUrl);
      if (!/\/(?:handle|xmlui|jspui)\//i.test(url.pathname)) continue;
      if (!origins.includes(url.origin)) origins.push(url.origin);
    } catch { /* ignore malformed landing URL */ }
  }
  return origins.slice(0, 6);
}

export function dspaceSearchApiUrls(landingUrls = [], doi = '') {
  const normalized = normalizeDoi(doi);
  const searches = [];
  const seen = new Set();
  for (const landingUrl of landingUrls || []) {
    const origin = dspaceRepositoryOrigin(landingUrl);
    if (!origin) continue;
    const queries = [];
    if (normalized) queries.push(`dc.identifier.doi:"${normalized}"`);
    const handle = handleIdentifier(landingUrl);
    if (handle) queries.push(`dc.identifier.uri:"https://hdl.handle.net/${handle}"`);
    for (const query of queries) {
      const url = new URL('/server/api/discover/search/objects', origin);
      url.searchParams.set('query', query);
      url.searchParams.set('size', '10');
      if (!seen.has(url.href)) {
        seen.add(url.href);
        searches.push(url.href);
      }
    }
  }
  return searches.slice(0, 10);
}

export function dspaceItemApiUrlsFromSearch(data, searchUrl) {
  let origin;
  try { origin = new URL(searchUrl).origin; } catch { return []; }
  const objects = [
    ...asArray(data?._embedded?.searchResult?._embedded?.objects),
    ...asArray(data?._embedded?.objects),
    ...asArray(data?._embedded?.items),
    ...asArray(data?.results),
  ];
  const urls = [];
  for (const entry of objects) {
    const item = entry?._embedded?.indexableObject || entry?.indexableObject || entry?.object || entry;
    const self = item?._links?.self?.href;
    for (const apiUrl of dspaceItemApiUrls(self || '')) {
      if (!urls.includes(apiUrl)) urls.push(apiUrl);
    }
    const uuid = String(item?.uuid || item?.id || '');
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(uuid)) {
      const apiUrl = `${origin}/server/api/core/items/${uuid}`;
      if (!urls.includes(apiUrl)) urls.push(apiUrl);
    }
  }
  return urls;
}

export async function getDspaceRepositoryCandidates(landingUrls = [], email = '', options = {}) {
  const settings = typeof options === 'string' ? { doi:options } : (options || {});
  const main = [];
  const supplements = [];
  const errors = [];
  const itemApis = [...new Set((landingUrls || []).flatMap(dspaceItemApiUrls))].slice(0, 10);
  for (const searchUrl of dspaceSearchApiUrls(landingUrls, settings.doi)) {
    try {
      const data = await jsonRequest(searchUrl, email, { retries:0 });
      for (const itemApi of dspaceItemApiUrlsFromSearch(data, searchUrl)) {
        if (!itemApis.includes(itemApi) && itemApis.length < 10) itemApis.push(itemApi);
      }
    } catch (error) {
      if (error.status !== 404) {
        errors.push({
          provider:'dspace',
          providerCode:error.status ? `http_${error.status}` : 'request_failed',
          status:error.status || null,
          url:searchUrl,
          message:error.message,
        });
      }
    }
  }
  for (const itemApi of itemApis) {
    try {
      const bundles = await jsonRequest(`${itemApi}/bundles?size=50`, email, { retries:0 });
      for (const bundle of bundles?._embedded?.bundles || []) {
        const bundleName = String(bundle?.name || '');
        if (/thumbnail|license|text/i.test(bundleName)) continue;
        let bitstreams = bundle?._embedded?.bitstreams || [];
        if (!bitstreams.length && bundle?._links?.bitstreams?.href) {
          const data = await jsonRequest(bundle._links.bitstreams.href, email, { retries:0 });
          bitstreams = data?._embedded?.bitstreams || [];
        }
        const found = candidatesFromDspaceBitstreams(bitstreams, bundleName, itemApi.replace('/server/api/core/items/', '/items/'));
        for (const candidate of found) {
          const target = candidate.supplement ? supplements : main;
          if (!target.some((current) => current.url === candidate.url)) target.push(candidate);
        }
      }
    } catch (error) {
      if (error.status !== 404) {
        errors.push({
          provider:'dspace',
          providerCode:error.status ? `http_${error.status}` : 'request_failed',
          status:error.status || null,
          url:itemApi,
          message:error.message,
        });
      }
    }
  }
  const normalized = normalizeDoi(settings.doi);
  if (normalized) {
    for (const origin of dspace6RepositoryOrigins(landingUrls)) {
      const searchUrl = `${origin}/rest/items/find-by-metadata-field`;
      try {
        const items = await jsonRequest(searchUrl, email, {
          method:'POST',
          retries:0,
          headers:{ 'content-type':'application/json' },
          body:JSON.stringify({ key:'dc.identifier.doi', value:normalized }),
        });
        for (const item of asArray(items).slice(0, 10)) {
          const uuid = String(item?.uuid || item?.id || '');
          if (!uuid) continue;
          const bitstreamUrl = `${origin}/rest/items/${encodeURIComponent(uuid)}/bitstreams`;
          const bitstreams = await jsonRequest(bitstreamUrl, email, { retries:0 });
          for (const candidate of candidatesFromDspace6Bitstreams(
            asArray(bitstreams),
            origin,
            item?.handle ? `${origin}/handle/${item.handle}` : origin,
          )) {
            const target = candidate.supplement ? supplements : main;
            if (!target.some((current) => current.url === candidate.url)) target.push(candidate);
          }
        }
      } catch (error) {
        if (![404, 405].includes(error.status)) {
          errors.push({
            provider:'dspace6',
            providerCode:error.status ? `http_${error.status}` : 'request_failed',
            status:error.status || null,
            url:searchUrl,
            message:error.message,
          });
        }
      }
    }
  }
  return { main, supplements, errors };
}

function crossrefYear(work) {
  for (const field of ['published', 'published-print', 'published-online', 'issued', 'created']) {
    const year = Number(work?.[field]?.['date-parts']?.[0]?.[0]);
    if (year >= 1900 && year <= 2100) return year;
  }
  return null;
}

export function directSupplementCandidates(doi, work = null) {
  const normalized = normalizeDoi(doi);
  const candidates = [];
  if (!normalized) return candidates;
  const add = (url, source, label = '', evidence = 'derived') => addCandidate(candidates, url, source, 'publisher', {
    referer: `https://doi.org/${normalized}`, supplement: true, probe:evidence === 'probe', evidence, label,
  });
  const wiley = normalized.match(/^10\.1002\/([a-z0-9]+)\.(\d+)$/i);
  if (wiley) {
    const stem = `${wiley[1]}${wiley[2]}`.toLowerCase();
    const commonSuffixes = ['SuppMat.pdf', 'S1.pdf', 'SuppData-S1.pdf'];
    for (let index = 1; index <= 2; index += 1) {
      for (const suffix of commonSuffixes) {
        const file = `${stem}-sup-${String(index).padStart(4, '0')}-${suffix}`;
        add(`https://onlinelibrary.wiley.com/action/downloadSupplement?doi=${encodeURIComponent(normalized)}&file=${encodeURIComponent(file)}`, 'Wiley SI adapter', 'Supporting Information', 'probe');
      }
    }
    const legacyFile = `${wiley[1].toLowerCase()}_${wiley[2]}_sm_suppl.pdf`;
    add(`https://onlinelibrary.wiley.com/action/downloadSupplement?doi=${encodeURIComponent(normalized)}&file=${encodeURIComponent(legacyFile)}`, 'Wiley legacy SI adapter', 'Supporting Information', 'probe');
  }
  const legacyNature = normalized.match(/^10\.1038\/(srep\d{5})$/i);
  const legacyYear = crossrefYear(work);
  if (legacyNature && legacyYear) {
    for (let index = 1; index <= 2; index += 1) {
      add(`https://static-content.springer.com/esm/art%3A${normalized.replace('/', '%2F')}/MediaObjects/41598_${legacyYear}_BF${legacyNature[1]}_MOESM${index}_ESM.doc`, 'Springer/Nature legacy SI adapter');
    }
  }
  const nature = normalized.match(/^10\.1038\/s(\d{5})-(\d{3,4})-(\d+)(?:-[a-z])?$/i);
  if (nature) {
    const [, journal, yearRaw, articleRaw] = nature;
    const year = yearRaw.length === 3 ? String(2000 + Number(yearRaw)) : yearRaw;
    const article = String(Number(articleRaw));
    for (let index = 1; index <= 3; index += 1) {
      add(`https://static-content.springer.com/esm/art%3A${normalized.replace('/', '%2F')}/MediaObjects/${journal}_${year}_${article}_MOESM${index}_ESM.pdf`, 'Springer/Nature SI adapter');
    }
  }
  const rsc = normalized.match(/^10\.1039\/([a-d]\d)([a-z]{2})([a-z0-9]+)$/i);
  if (rsc) {
    const suffix = normalized.slice('10.1039/'.length).toLowerCase();
    add(`https://www.rsc.org/suppdata/${rsc[1].toLowerCase()}/${rsc[2].toLowerCase()}/${suffix}/${suffix}1.pdf`, 'RSC SI adapter');
  }
  const science = normalized.match(/^10\.1126\/(?:science\.)?([a-z0-9]+)$/i);
  if (science) {
    const article = science[1].toLowerCase();
    for (let index = 1; index <= 2; index += 1) {
      add(`https://www.science.org/doi/suppl/${normalized}/suppl_file/${article}_data_s${index}.pdf`, 'Science SI adapter', 'Supplementary Materials');
    }
  }
  return candidates;
}

export function directPublisherCandidates(doi, work = null) {
  const normalized = normalizeDoi(doi);
  const candidates = [];
  if (!normalized) return candidates;
  const add = (url, source) => addCandidate(candidates, url, source, 'publisher', { referer: `https://doi.org/${normalized}` });
  if (normalized.startsWith('10.1002/')) {
    add(`https://onlinelibrary.wiley.com/doi/pdfdirect/${normalized}`, 'Wiley direct PDF');
    add(`https://onlinelibrary.wiley.com/doi/pdf/${normalized}`, 'Wiley direct PDF');
  } else if (normalized.startsWith('10.1021/')) {
    add(`https://pubs.acs.org/doi/pdf/${normalized}`, 'ACS direct PDF');
    add(`https://pubs.acs.org/doi/epdf/${normalized}`, 'ACS direct PDF');
  } else if (normalized.startsWith('10.1126/')) {
    add(`https://www.science.org/doi/pdf/${normalized}`, 'Science direct PDF');
    add(`https://www.science.org/doi/epdf/${normalized}`, 'Science direct PDF');
  } else if (normalized.startsWith('10.1039/')) {
    const suffix = normalized.slice('10.1039/'.length);
    const match = suffix.match(/^([a-d])(\d)([a-z]{2})/i);
    if (match) {
      const decade = ({ a: 1990, b: 2000, c: 2010, d: 2020 })[match[1].toLowerCase()];
      if (decade) add(`https://pubs.rsc.org/en/content/articlepdf/${decade + Number(match[2])}/${match[3].toLowerCase()}/${suffix.toLowerCase()}`, 'RSC direct PDF');
    }
  } else if (normalized.startsWith('10.1016/')) {
    const pii = (work?.['alternative-id'] || []).find((value) => /^S\d{10,}$/i.test(value));
    if (pii) add(`https://www.sciencedirect.com/science/article/pii/${pii}/pdfft?isDTMRedir=true&download=true`, 'Elsevier direct PDF');
  }
  return candidates;
}

export function publisherLabel(url) {
  const host = new URL(url).hostname.toLowerCase();
  if (host.includes('acs.org')) return 'ACS adapter';
  if (host.includes('wiley.com')) return 'Wiley adapter';
  if (host.includes('sciencedirect.com') || host.includes('elsevier.com')) return 'Elsevier adapter';
  if (host.includes('rsc.org')) return 'RSC adapter';
  if (host.includes('science.org')) return 'Science adapter';
  if (host.includes('springer.com') || host.includes('nature.com')) return 'Springer/Nature adapter';
  return 'Publisher metadata';
}

export function crossrefMetadata(work) {
  if (!work) return {};
  return {
    doi: normalizeDoi(work.DOI),
    title: work.title?.[0] || null,
    authors: (work.author || []).map((author) => [author.given, author.family].filter(Boolean).join(' ')),
    year: work.published?.['date-parts']?.[0]?.[0] || work.issued?.['date-parts']?.[0]?.[0] || null,
    journal: work['container-title']?.[0] || null,
    landingUrl: work.URL || null,
  };
}
