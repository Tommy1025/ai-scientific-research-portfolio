import fs from 'node:fs/promises';
import path from 'node:path';
import { checkElsevierCapabilities, getApiCredentials } from './api-config.js';
import { downloadWithAuthenticatedBrowser } from './browser-fallback.js';
import {
  CACHE_DIR, FAILURE_CODE, JOBS_DIR, RETRYABLE_SI_STATUSES, RETRYABLE_STATUSES, SI_STATUS, STATUS,
  SUCCESS_STATUSES,
} from './constants.js';
import { classifyDownloadFailure, fetchWithPolicy } from './http.js';
import { getVpnStatus } from './network.js';
import { parsePdfBuffer } from './pdf.js';
import {
  authenticatedPublisherCandidates, candidatesFromCore, candidatesFromCrossref, candidatesFromHtml,
  candidatesFromOpenAire, candidatesFromOpenAlex, candidatesFromOpenAlexContent, candidatesFromSemanticScholar,
  candidatesFromUnpaywall,
  directPublisherCandidates, directSupplementCandidates, getCoreWorks, getCrossrefTdmSupplementCandidates, getCrossrefWork,
  getDspaceRepositoryCandidates, getEuropePmcMainCandidates, getEuropePmcSupplementCandidates,
  getFigshareSupplementCandidates, getHalCandidates, getOaiPmhCandidates, getOpenAirePublications, getOpenAlex,
  getSemanticScholar, getSignpostingCandidates, getUnpaywall, getZenodoCandidates, oaiRecordUrlsFromHtml,
  queryCrossref, supplementCandidatesFromCrossref,
  supplementCandidatesFromHtml,
} from './providers.js';
import {
  elsevierArticleCandidates, getGetFtrCandidates, getLibKeyCandidates,
  springerNatureStructuredCandidates,
} from './licensed-providers.js';
import { assessMainDocument } from './main-document.js';
import { scoreCrossrefCandidate } from './references.js';
import { getJob, getSettings, getSource, jobDir, saveJob } from './store.js';
import { reconstructStructuredPdf } from './structured-fulltext.js';
import {
  applyRelatedSupplementExclusions, extractEmbeddedSupplementPdf, rankSupplementCandidates, validateSupplementDocument,
  extractEmbeddedPdfAttachments,
} from './supplements.js';
import {
  HostLimiter, csvEscape, ensureDir, mapLimit, normalizeDoi, parseRefSpec, readJson,
  safeFilename, sha256, writeFileAtomic, writeJson,
} from './utils.js';

const runningJobs = new Set();
const hostLimiter = new HostLimiter();

function cacheKey(doi) { return safeFilename(doi.replaceAll('/', '__'), 180); }
function cachePdf(doi) { return path.join(CACHE_DIR, `${cacheKey(doi)}.pdf`); }
function cacheMeta(doi) { return path.join(CACHE_DIR, `${cacheKey(doi)}.json`); }

function nowIso() { return new Date().toISOString(); }

export function providerTraceFailureCode(status, provider = '') {
  const service = String(provider || '').toLowerCase();
  if (status === 429) return FAILURE_CODE.QUOTA_THROTTLED;
  if (status === 401) {
    return service.includes('elsevier')
      ? FAILURE_CODE.API_FEATURE_NOT_ENABLED
      : FAILURE_CODE.API_CREDENTIAL_INVALID;
  }
  if (status === 403) {
    return /elsevier|wiley|springer|libkey|getftr/.test(service)
      ? FAILURE_CODE.INSTITUTION_ENTITLEMENT_FALSE
      : FAILURE_CODE.PUBLISHER_AUTOMATION_BLOCKED;
  }
  return FAILURE_CODE.DOWNLOAD_FAILED;
}

export function failureCodeForContentResponse(status, statusCode = 0) {
  if (statusCode === 429) return FAILURE_CODE.QUOTA_THROTTLED;
  if (status === STATUS.LOGIN_REQUIRED) return FAILURE_CODE.AUTH_NETWORK_MISMATCH;
  if (status === STATUS.PAYWALL) return FAILURE_CODE.INSTITUTION_ENTITLEMENT_FALSE;
  if (status === STATUS.API_PERMISSION_REQUIRED) return FAILURE_CODE.API_FEATURE_NOT_ENABLED;
  if (status === STATUS.PUBLISHER_BLOCKED) return FAILURE_CODE.PUBLISHER_AUTOMATION_BLOCKED;
  return FAILURE_CODE.FORMAT_NOT_PERMITTED;
}

function traceError(provider, error, startedAt) {
  const status = Number(error?.status || error?.httpStatus) || null;
  return {
    provider,
    outcome:'error',
    httpStatus:status,
    failureCode:error?.failureCode || providerTraceFailureCode(status, provider),
    providerCode:error?.providerCode || null,
    durationMs:Date.now() - startedAt,
    message:error?.message || String(error),
  };
}

async function traceProvider(provider, providerTrace, task, count = (value) => {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return 1;
  return 0;
}) {
  const startedAt = Date.now();
  try {
    const value = await task();
    const resultCount = count(value);
    providerTrace.push({
      provider,
      outcome:resultCount > 0 ? 'success' : 'empty',
      httpStatus:resultCount > 0 ? 200 : null,
      durationMs:Date.now() - startedAt,
      resultCount,
    });
    return value;
  } catch (error) {
    providerTrace.push(traceError(provider, error, startedAt));
    throw error;
  }
}

function validationFailureCode(value) {
  const mapping = {
    main_preview:FAILURE_CODE.PREVIEW_ONLY,
    main_incomplete:FAILURE_CODE.INCOMPLETE_DOCUMENT,
    main_identity_conflict:FAILURE_CODE.IDENTITY_MISMATCH,
    main_identity_unverified:FAILURE_CODE.IDENTITY_UNVERIFIED,
    main_version_unverified:FAILURE_CODE.VERSION_UNVERIFIED,
    main_preprint_not_allowed:FAILURE_CODE.PREPRINT_NOT_ALLOWED,
  };
  return mapping[value] || FAILURE_CODE.DOWNLOAD_FAILED;
}

function documentFormat(candidate = {}) {
  if (candidate.reconstructed) return 'reconstructed_pdf';
  return candidate.repository || candidate.access === 'oa' ? 'repository_pdf' : 'publisher_pdf';
}

function sanitizedCandidate(candidate = {}) {
  return {
    url:redactCredentialUrl(candidate.url),
    source:candidate.source,
    access:candidate.access,
    stage:candidate.stage,
    documentVersion:candidate.documentVersion || null,
    documentFormat:candidate.documentFormat || documentFormat(candidate),
    license:candidate.license || null,
    repository:Boolean(candidate.repository),
    structured:Boolean(candidate.structured),
  };
}

export function matchConfidence(score) {
  if (score >= 0.82) return 'accepted';
  if (score >= 0.62) return 'review';
  return 'rejected';
}

async function resolveDoi(reference, email, endpoints) {
  if (reference.doi) return { doi: normalizeDoi(reference.doi), matchScore: 1, matchMethod: 'citation_exact' };
  if (!reference.rawCitation) return { doi: null, matchScore: 0, matchMethod: 'none' };
  const candidates = await queryCrossref(reference.rawCitation, email, endpoints).catch(() => []);
  let best = null;
  for (const candidate of candidates) {
    const score = scoreCrossrefCandidate(reference.rawCitation, candidate);
    if (!best || score > best.score) best = { candidate, score };
  }
  if (!best || matchConfidence(best.score) === 'rejected') return { doi: null, matchScore: best?.score || 0, matchMethod: 'crossref_rejected' };
  return {
    doi: normalizeDoi(best.candidate.DOI), matchScore: best.score,
    matchMethod: matchConfidence(best.score) === 'review' ? 'crossref_review' : 'crossref_query',
    matchedTitle: best.candidate.title?.[0] || null,
  };
}

async function findCandidatesLegacy(doi, email, endpoints, includeSupplements = false) {
  const candidates = [];
  const providerErrors = [];
  const credentials = getApiCredentials();
  const add = (candidate) => { if (candidate?.url && !candidates.some((item) => item.url === candidate.url)) candidates.push(candidate); };
  const cached = await readJson(cacheMeta(doi));
  try {
    const stat = await fs.stat(cachePdf(doi));
    if (cached && stat.size > 0) add({ url: `cache://${cacheKey(doi)}`, source: '本機快取', access: cached.access || 'oa', cache: true });
  } catch { /* no cache */ }

  const [unpaywallResult, openAlexResult, workResult, coreResult, semanticScholarResult, figshareSupplementResult, europePmcSupplementResult] = await Promise.allSettled([
    getUnpaywall(doi, email, endpoints),
    getOpenAlex(doi, email, endpoints, credentials.openAlexApiKey),
    getCrossrefWork(doi, email, endpoints),
    getCoreWorks(doi, credentials.coreApiKey, endpoints),
    getSemanticScholar(doi, credentials.semanticScholarApiKey, endpoints),
    includeSupplements ? getFigshareSupplementCandidates(doi, email, endpoints) : Promise.resolve([]),
    includeSupplements ? getEuropePmcSupplementCandidates(doi, email, endpoints) : Promise.resolve([]),
  ]);
  const unpaywall = unpaywallResult.status === 'fulfilled' ? unpaywallResult.value : null;
  const openAlex = openAlexResult.status === 'fulfilled' ? openAlexResult.value : null;
  const work = workResult.status === 'fulfilled' ? workResult.value : null;
  const coreWorks = coreResult.status === 'fulfilled' ? coreResult.value : [];
  const semanticScholar = semanticScholarResult.status === 'fulfilled' ? semanticScholarResult.value : null;
  const figshareSupplementCandidates = figshareSupplementResult.status === 'fulfilled' ? figshareSupplementResult.value : [];
  const europePmcSupplementCandidates = europePmcSupplementResult.status === 'fulfilled' ? europePmcSupplementResult.value : [];
  if (unpaywallResult.status === 'rejected') providerErrors.push(`Unpaywall: ${unpaywallResult.reason.message}`);
  if (openAlexResult.status === 'rejected') providerErrors.push(`OpenAlex: ${openAlexResult.reason.message}`);
  if (workResult.status === 'rejected') providerErrors.push(`Crossref: ${workResult.reason.message}`);
  if (coreResult.status === 'rejected') providerErrors.push(`CORE: ${coreResult.reason.message}`);
  if (semanticScholarResult.status === 'rejected') providerErrors.push(`Semantic Scholar: ${semanticScholarResult.reason.message}`);
  const siProviderErrors = [];
  if (figshareSupplementResult.status === 'rejected') siProviderErrors.push(`Figshare API: ${figshareSupplementResult.reason.message}`);
  if (europePmcSupplementResult.status === 'rejected') siProviderErrors.push(`Europe PMC: ${europePmcSupplementResult.reason.message}`);
  const repositoryCandidates = [
    ...candidatesFromCore(coreWorks), ...candidatesFromSemanticScholar(semanticScholar),
    ...candidatesFromUnpaywall(unpaywall), ...candidatesFromOpenAlex(openAlex),
  ];
  const [dspaceResult, crossrefTdmSiResult] = await Promise.allSettled([
    getDspaceRepositoryCandidates(repositoryCandidates.filter((candidate) => candidate.landing).map((candidate) => candidate.url), email),
    includeSupplements ? getCrossrefTdmSupplementCandidates(work, email) : Promise.resolve([]),
  ]);
  const dspace = dspaceResult.status === 'fulfilled' ? dspaceResult.value : { main:[], supplements:[] };
  const crossrefTdmSiCandidates = crossrefTdmSiResult.status === 'fulfilled' ? crossrefTdmSiResult.value : [];
  if (dspaceResult.status === 'rejected') providerErrors.push(`DSpace: ${dspaceResult.reason.message}`);
  candidatesFromOpenAlexContent(openAlex, credentials.openAlexApiKey).forEach(add);
  repositoryCandidates.forEach(add);
  dspace.main.forEach(add);
  authenticatedPublisherCandidates(doi, credentials).forEach(add);
  candidatesFromCrossref(work).forEach(add);
  const directCandidates = directPublisherCandidates(doi, work);
  directCandidates.forEach(add);

  const landingCandidates = candidates.filter((candidate) => candidate.landing);
  for (const candidate of landingCandidates) {
    const index = candidates.indexOf(candidate);
    if (index >= 0) candidates.splice(index, 1);
  }
  const landingUrls = [...new Set([
    ...(directCandidates.length ? [] : [work?.URL, `https://doi.org/${doi}`]),
    ...landingCandidates.map((candidate) => candidate.url),
  ].filter(Boolean))].slice(0, 10);
  const supplementLandingUrls = [...new Set([
    work?.URL,
    `https://doi.org/${doi}`,
    ...landingCandidates.map((candidate) => candidate.url),
  ].filter(Boolean))].slice(0, 10);
  await mapLimit(landingUrls, 3, async (landingUrl) => {
    try {
      const response = await fetchWithPolicy(landingUrl, { email, timeoutMs: 30000, retries: 0, accept: 'text/html,application/pdf;q=0.9' });
      const type = String(response.headers['content-type'] || '').toLowerCase();
      if (type.includes('pdf') || response.buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
        add({ url: response.finalUrl, source: 'DOI landing', access: 'publisher' });
      } else {
        candidatesFromHtml(response.buffer.toString('utf8'), response.finalUrl).forEach(add);
      }
    } catch { /* The direct DOI candidate remains useful for the report only when metadata yielded a PDF URL. */ }
  });
  const missingApis = [];
  if (!credentials.openAlexApiKey) missingApis.push('OpenAlex API key');
  if (!credentials.coreApiKey) missingApis.push('CORE API key');
  if (doi.startsWith('10.1002/') && !credentials.wileyTdmClientToken) missingApis.push('Wiley TDM token');
  if (doi.startsWith('10.1016/') && !credentials.elsevierApiKey) missingApis.push('Elsevier API key');
  const knownOa = Boolean(unpaywall?.is_oa || openAlex?.open_access?.is_oa);
  return {
    candidates, providerErrors, siProviderErrors, missingApis, knownOa, work, supplementLandingUrls,
    repositorySupplementCandidates:[
      ...figshareSupplementCandidates, ...europePmcSupplementCandidates, ...dspace.supplements, ...crossrefTdmSiCandidates,
    ],
  };
}

async function findCandidates(doi, email, endpoints, includeSupplements = false, options = {}) {
  const candidates = [];
  const providerErrors = [];
  const providerTrace = [];
  const credentials = getApiCredentials();
  const add = (candidate, stage = candidate?.stage ?? 7) => {
    if (!candidate?.url || candidates.some((item) => item.url === candidate.url)) return;
    candidates.push({ ...candidate, stage });
  };

  if (!options.skipCache) {
    const cached = await readJson(cacheMeta(doi));
    try {
      const stat = await fs.stat(cachePdf(doi));
      if (cached && stat.size > 0) {
        add({
          url:`cache://${cacheKey(doi)}`,
          source:cached.sourceProvider || cached.source || 'Validated cache',
          access:cached.access || 'unknown',
          cache:true,
          originalSourceUrl:cached.sourceUrl || null,
          documentVersion:cached.documentVersion,
          documentFormat:cached.documentFormat,
          license:cached.license,
          savedAt:cached.savedAt,
        }, 0);
        providerTrace.push({ provider:'cache', outcome:'success', httpStatus:null, durationMs:0, resultCount:1 });
      }
    } catch {
      providerTrace.push({ provider:'cache', outcome:'empty', httpStatus:null, durationMs:0, resultCount:0 });
    }
  }

  if (!options.skipOfficial) {
    for (const candidate of authenticatedPublisherCandidates(doi, credentials)
      .filter((entry) => entry.apiService !== 'elsevier')) {
      add(candidate, candidate.structured ? 2 : 1);
    }
    for (const candidate of elsevierArticleCandidates(doi, credentials, endpoints)) {
      add(candidate, candidate.structured ? 2 : 1);
    }
    for (const candidate of springerNatureStructuredCandidates(doi, credentials, endpoints)) {
      add(candidate, 2);
    }
  }
  if (options.onlyEarly) {
    candidates.sort((left, right) => (left.stage ?? 7) - (right.stage ?? 7));
    return {
      candidates,
      providerErrors,
      providerTrace,
      siProviderErrors:[],
      missingApis:[],
      knownOa:false,
      work:options.work ?? null,
      supplementLandingUrls:[],
      repositorySupplementCandidates:[],
    };
  }

  const calls = [
    ['Crossref', () => options.work !== undefined
      ? options.work
      : getCrossrefWork(doi, email, endpoints)],
    ['Unpaywall', () => getUnpaywall(doi, email, endpoints)],
    ['OpenAlex', () => getOpenAlex(doi, email, endpoints, credentials.openAlexApiKey)],
    ['OpenAIRE', () => getOpenAirePublications(doi, email, endpoints), (value) => value?.length || 0],
    ['CORE', () => getCoreWorks(doi, credentials.coreApiKey, endpoints), (value) => value?.length || 0],
    ['Semantic Scholar', () => getSemanticScholar(doi, credentials.semanticScholarApiKey, endpoints)],
    ['Europe PMC', () => getEuropePmcMainCandidates(doi, email, endpoints), (value) => value?.length || 0],
    ['Figshare SI', () => includeSupplements ? getFigshareSupplementCandidates(doi, email, endpoints) : [], (value) => value?.length || 0],
    ['Europe PMC SI', () => includeSupplements ? getEuropePmcSupplementCandidates(doi, email, endpoints) : [], (value) => value?.length || 0],
  ];
  const results = await Promise.allSettled(calls.map(([name, task, counter]) =>
    traceProvider(name, providerTrace, task, counter)));
  const fulfilled = (index, fallback) => results[index].status === 'fulfilled' ? results[index].value : fallback;
  const work = fulfilled(0, null);
  const unpaywall = fulfilled(1, null);
  const openAlex = fulfilled(2, null);
  const openAire = fulfilled(3, []);
  const coreWorks = fulfilled(4, []);
  const semanticScholar = fulfilled(5, null);
  const europePmcMain = fulfilled(6, []);
  const figshareSupplementCandidates = fulfilled(7, []);
  const europePmcSupplementCandidates = fulfilled(8, []);
  results.forEach((result, index) => {
    if (result.status === 'rejected') providerErrors.push(`${calls[index][0]}: ${result.reason.message}`);
  });
  const siProviderErrors = results
    .map((result, index) => ({ result, name:calls[index][0] }))
    .filter(({ result, name }) => result.status === 'rejected' && / SI$/.test(name))
    .map(({ result, name }) => `${name}: ${result.reason.message}`);

  candidatesFromOpenAlexContent(openAlex, credentials.openAlexApiKey)
    .forEach((candidate) => add(candidate, 3));
  const repositoryCandidates = [
    ...candidatesFromUnpaywall(unpaywall),
    ...candidatesFromOpenAlex(openAlex),
    ...candidatesFromOpenAire(openAire, doi),
    ...candidatesFromCore(coreWorks, credentials.coreApiKey),
    ...europePmcMain,
    ...candidatesFromSemanticScholar(semanticScholar),
  ];
  repositoryCandidates.filter((candidate) => !candidate.landing)
    .forEach((candidate) => add(candidate, 3));

  const landingCandidates = repositoryCandidates.filter((candidate) => candidate.landing);
  const landingUrls = [...new Set([
    ...landingCandidates.map((candidate) => candidate.url),
    work?.URL,
    `https://doi.org/${doi}`,
  ].filter(Boolean))].slice(0, 12);

  let dspace = { main:[], supplements:[], errors:[] };
  try {
    dspace = await traceProvider(
      'DSpace',
      providerTrace,
      () => getDspaceRepositoryCandidates(landingUrls, email, { doi }),
      (value) => (value?.main?.length || 0) + (value?.supplements?.length || 0),
    );
    for (const error of dspace.errors || []) {
      providerTrace.push({
        provider:'DSpace',
        outcome:'error',
        httpStatus:error.status || null,
        failureCode:providerTraceFailureCode(error.status, 'DSpace'),
        providerCode:error.providerCode || null,
        durationMs:0,
        message:error.message,
        url:redactCredentialUrl(error.url),
      });
      providerErrors.push(`DSpace: ${error.message}`);
    }
  } catch (error) {
    providerErrors.push(`DSpace: ${error.message}`);
  }
  dspace.main.forEach((candidate) => add(candidate, 4));

  const platformCalls = [
    ['HAL', () => getHalCandidates(doi, email, endpoints)],
    ['Zenodo', () => getZenodoCandidates(doi, email, endpoints)],
  ];
  const platformResults = await Promise.allSettled(platformCalls.map(([name, task]) =>
    traceProvider(name, providerTrace, task, (value) => value?.length || 0)));
  platformResults.forEach((result, index) => {
    if (result.status === 'fulfilled') result.value.forEach((candidate) => add(candidate, 4));
    else providerErrors.push(`${platformCalls[index][0]}: ${result.reason.message}`);
  });

  await mapLimit(landingUrls, 3, async (landingUrl) => {
    try {
      const signposting = await traceProvider(
        'FAIR Signposting',
        providerTrace,
        () => getSignpostingCandidates(landingUrl, email),
        (value) => value?.length || 0,
      );
      signposting.forEach((candidate) => add(candidate, 4));
    } catch { /* The HTML resolver below still gets a chance. */ }

    const startedAt = Date.now();
    try {
      const response = await fetchWithPolicy(landingUrl, {
        email, timeoutMs:30000, retries:0, accept:'text/html,application/pdf;q=0.9',
      });
      const type = String(response.headers['content-type'] || '').toLowerCase();
      if (type.includes('pdf') || response.buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
        add({ url:response.finalUrl, source:'Repository/DOI landing', access:'unknown' }, 4);
        providerTrace.push({
          provider:'landing-resolver', outcome:'success', httpStatus:response.status,
          durationMs:Date.now() - startedAt, resultCount:1,
        });
      } else {
        const html = response.buffer.toString('utf8');
        const found = candidatesFromHtml(html, response.finalUrl);
        found.forEach((candidate) => add(candidate, 4));
        const oaiUrls = oaiRecordUrlsFromHtml(html, response.finalUrl);
        if (oaiUrls.length) {
          try {
            const oaiCandidates = await traceProvider(
              'OAI-PMH',
              providerTrace,
              () => getOaiPmhCandidates(oaiUrls, doi, email),
              (value) => value?.length || 0,
            );
            oaiCandidates.forEach((candidate) => add(candidate, 4));
          } catch (error) {
            providerErrors.push(`OAI-PMH: ${error.message}`);
          }
        }
        providerTrace.push({
          provider:'landing-resolver', outcome:found.length ? 'success' : 'empty',
          httpStatus:response.status, durationMs:Date.now() - startedAt, resultCount:found.length,
        });
      }
    } catch (error) {
      providerTrace.push(traceError('landing-resolver', error, startedAt));
      providerErrors.push(`Landing resolver: ${error.message}`);
    }
  });

  const licensedCalls = [
    ['LibKey', () => getLibKeyCandidates(doi, credentials, { endpoints })],
    ['GetFTR', () => getGetFtrCandidates(doi, credentials, { endpoints })],
  ];
  const licensedResults = await Promise.allSettled(licensedCalls.map(([name, task]) =>
    traceProvider(name, providerTrace, task, (value) => value?.length || 0)));
  const licensedCandidates = [];
  licensedResults.forEach((result, index) => {
    if (result.status === 'fulfilled') licensedCandidates.push(...result.value);
    else providerErrors.push(`${licensedCalls[index][0]}: ${result.reason.message}`);
  });
  for (const candidate of licensedCandidates) {
    if (!candidate.landing) {
      add(candidate, 6);
      continue;
    }
    const startedAt = Date.now();
    try {
      const response = await fetchWithPolicy(candidate.url, {
        email, timeoutMs:30000, retries:0, accept:'text/html,application/pdf;q=0.9',
      });
      const type = String(response.headers['content-type'] || '').toLowerCase();
      if (type.includes('pdf') || response.buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
        add({ ...candidate, url:response.finalUrl, landing:false }, 6);
      } else {
        candidatesFromHtml(response.buffer.toString('utf8'), response.finalUrl)
          .forEach((found) => add({
            ...found,
            source:candidate.source,
            access:candidate.access,
            documentVersion:candidate.documentVersion,
            license:candidate.license,
          }, 6));
      }
      providerTrace.push({
        provider:`${candidate.source} landing`,
        outcome:'success',
        httpStatus:response.status,
        durationMs:Date.now() - startedAt,
        resultCount:1,
      });
    } catch (error) {
      providerTrace.push(traceError(`${candidate.source} landing`, error, startedAt));
    }
  }

  candidatesFromCrossref(work).forEach((candidate) => add(candidate, 7));
  directPublisherCandidates(doi, work).forEach((candidate) => add(candidate, 7));
  candidates.sort((left, right) => (left.stage ?? 7) - (right.stage ?? 7));

  let crossrefTdmSiCandidates = [];
  if (includeSupplements) {
    try {
      crossrefTdmSiCandidates = await traceProvider(
        'Crossref TDM SI',
        providerTrace,
        () => getCrossrefTdmSupplementCandidates(work, email),
        (value) => value?.length || 0,
      );
    } catch (error) {
      siProviderErrors.push(`Crossref TDM SI: ${error.message}`);
    }
  }

  const missingApis = [];
  if (!credentials.openAlexApiKey) missingApis.push('OpenAlex API key');
  if (!credentials.coreApiKey) missingApis.push('CORE API key');
  if (doi.startsWith('10.1002/') && !credentials.wileyTdmClientToken) missingApis.push('Wiley TDM token');
  if (doi.startsWith('10.1016/') && !credentials.elsevierApiKey) missingApis.push('Elsevier API key');
  const knownOa = Boolean(
    unpaywall?.is_oa
    || openAlex?.open_access?.is_oa
    || repositoryCandidates.some((candidate) => candidate.access === 'oa'),
  );
  return {
    candidates,
    providerErrors,
    providerTrace,
    siProviderErrors,
    missingApis,
    knownOa,
    work,
    supplementLandingUrls:landingUrls,
    repositorySupplementCandidates:[
      ...figshareSupplementCandidates,
      ...europePmcSupplementCandidates,
      ...dspace.supplements,
      ...crossrefTdmSiCandidates,
    ],
  };
}

function redactCredentialUrl(value) {
  try {
    const url = new URL(value);
    for (const key of ['api_key', 'apikey', 'insttoken', 'access_token']) {
      if (url.searchParams.has(key)) url.searchParams.set(key, '[redacted]');
    }
    return url.href;
  } catch { return value; }
}

async function attemptCandidateLegacy(candidate, context) {
  let buffer;
  let finalUrl = candidate.url;
  let statusCode = 200;
  let contentType = 'application/pdf';
  if (candidate.cache) {
    buffer = await fs.readFile(cachePdf(context.doi));
  } else {
    const isOaCandidate = candidate.access === 'oa';
    const requestUrl = candidate.requestUrl || candidate.url;
    const response = await hostLimiter.run(candidate.url, () => fetchWithPolicy(requestUrl, {
      email: context.email,
      timeoutMs: isOaCandidate ? 90000 : 30000,
      maxRedirects: 8,
      retries: isOaCandidate ? 1 : 2,
      accept: 'application/pdf,text/html;q=0.7,*/*;q=0.4',
      headers: {
        ...(candidate.headers || {}),
        ...(candidate.referer ? { Referer: candidate.referer, 'Accept-Language': 'en-US,en;q=0.8' } : {}),
      },
    }));
    buffer = response.buffer;
    finalUrl = redactCredentialUrl(response.finalUrl);
    statusCode = response.status;
    contentType = String(response.headers['content-type'] || '').toLowerCase();
    if (!response.ok || (!contentType.includes('pdf') && !buffer.subarray(0, 1024).includes(Buffer.from('%PDF-')))) {
      const text = buffer.toString('utf8');
      const status = classifyDownloadFailure(text, statusCode, candidate.apiService);
      const error = status === STATUS.API_PERMISSION_REQUIRED
        ? `${candidate.source} 憑證已送出，但此 API 未授予目前文章的 PDF 全文權限。`
        : undefined;
      return { ok: false, status, httpStatus: statusCode, finalUrl, contentType, error };
    }
  }
  try {
    if (buffer.length < 500) throw new Error('檔案過小');
    const parsed = await parsePdfBuffer(buffer);
    if (parsed.pageCount < 1) throw new Error('PDF 沒有頁面');
    return { ok: true, buffer, finalUrl, contentType, pageCount: parsed.pageCount, size: buffer.length, sha256: sha256(buffer) };
  } catch (error) {
    return { ok: false, status: STATUS.INVALID_PDF, finalUrl, contentType, error: error.message };
  }
}

export async function assessMainBuffer(buffer, {
  doi,
  work = {},
  candidate = {},
  entitlement = undefined,
} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 500) {
    return {
      ok:false,
      status:STATUS.INVALID_PDF,
      failureCode:FAILURE_CODE.DOWNLOAD_FAILED,
      error:'主文檔案過小或不是二進位內容',
    };
  }
  try {
    const parsed = await parsePdfBuffer(buffer);
    const assessment = assessMainDocument({ parsed, candidate, doi, work, entitlement });
    return {
      ...assessment,
      parsed,
      status:assessment.ok ? null
        : assessment.classification === 'preview' ? STATUS.PREVIEW_ONLY : STATUS.INVALID_PDF,
      failureCode:assessment.ok ? null : validationFailureCode(assessment.failureCode),
      size:buffer.length,
      sha256:sha256(buffer),
    };
  } catch (error) {
    return {
      ok:false,
      status:STATUS.INVALID_PDF,
      failureCode:FAILURE_CODE.DOWNLOAD_FAILED,
      error:error.message,
    };
  }
}

function responseEvidence(response = {}) {
  const headers = response.headers || {};
  return {
    requestId:headers['x-els-reqid'] || headers['x-request-id'] || headers['request-id'] || null,
    rateLimitRemaining:headers['x-ratelimit-remaining'] || headers['x-rate-limit-remaining'] || null,
    rateLimitReset:headers['x-ratelimit-reset'] || headers['x-rate-limit-reset'] || null,
  };
}

export async function attemptCandidate(candidate, context) {
  let sourceBuffer;
  let buffer;
  let finalUrl = candidate.originalSourceUrl || candidate.url;
  let statusCode = 200;
  let contentType = 'application/pdf';
  let responseHeaders = {};
  let reconstructed = null;
  if (candidate.cache) {
    try {
      buffer = await fs.readFile(cachePdf(context.doi));
    } catch (error) {
      return {
        ok:false,
        status:STATUS.DOWNLOAD_FAILED,
        failureCode:FAILURE_CODE.OA_LOCATION_STALE,
        error:error.message,
        finalUrl,
      };
    }
  } else {
    const isOaCandidate = candidate.access === 'oa';
    const requestUrl = candidate.requestUrl || candidate.url;
    let response;
    try {
      response = await hostLimiter.run(candidate.url, () => fetchWithPolicy(requestUrl, {
        email:context.email,
        timeoutMs:isOaCandidate || candidate.structured ? 90000 : 30000,
        maxRedirects:8,
        retries:isOaCandidate ? 1 : 0,
        accept:candidate.structured
          ? 'application/xml,text/xml,application/jats+xml,text/html;q=0.8,*/*;q=0.2'
          : 'application/pdf,text/html;q=0.7,*/*;q=0.4',
        headers:{
          ...(candidate.headers || {}),
          ...(candidate.referer ? { Referer:candidate.referer, 'Accept-Language':'en-US,en;q=0.8' } : {}),
        },
      }));
    } catch (error) {
      return {
        ok:false,
        status:STATUS.DOWNLOAD_FAILED,
        failureCode:FAILURE_CODE.DOWNLOAD_FAILED,
        error:error.message,
        finalUrl:redactCredentialUrl(requestUrl),
      };
    }
    sourceBuffer = response.buffer;
    finalUrl = redactCredentialUrl(response.finalUrl);
    statusCode = response.status;
    responseHeaders = response.headers || {};
    contentType = String(response.headers['content-type'] || '').toLowerCase();
    if (!response.ok) {
      const text = sourceBuffer.toString('utf8');
      const status = classifyDownloadFailure(text, statusCode, candidate.apiService);
      return {
        ok:false,
        status,
        httpStatus:statusCode,
        finalUrl,
        contentType,
        failureCode:providerTraceFailureCode(statusCode, candidate.apiService || candidate.source),
        error:`${candidate.source} 回傳 HTTP ${statusCode}`,
        ...responseEvidence(response),
      };
    }
    if (candidate.structured) {
      reconstructed = await reconstructStructuredPdf({
        source:sourceBuffer,
        contentType,
        sourceUrl:finalUrl,
        doi:context.doi,
      });
      if (!reconstructed.ok) {
        return {
          ok:false,
          status:STATUS.INVALID_PDF,
          httpStatus:statusCode,
          finalUrl,
          contentType,
          failureCode:FAILURE_CODE.REPOSITORY_METADATA_ONLY,
          error:reconstructed.reason,
          ...responseEvidence(response),
        };
      }
      buffer = reconstructed.buffer;
      candidate = {
        ...candidate,
        reconstructed:true,
        documentVersion:'reconstructed',
        documentFormat:'reconstructed_pdf',
      };
      contentType = 'application/pdf';
    } else {
      buffer = sourceBuffer;
      if (!contentType.includes('pdf') && !buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
        const text = buffer.toString('utf8');
        const status = classifyDownloadFailure(text, statusCode, candidate.apiService);
        return {
          ok:false,
          status,
          httpStatus:statusCode,
          finalUrl,
          contentType,
          failureCode:failureCodeForContentResponse(status, statusCode),
          ...responseEvidence(response),
        };
      }
    }
  }

  let assessment = await assessMainBuffer(buffer, {
    doi:context.doi,
    work:context.work,
    candidate,
  });
  let entitlementCheck = null;
  if (!assessment.ok && candidate.apiService === 'elsevier' && context.credentials?.elsevierApiKey) {
    try {
      entitlementCheck = await checkElsevierCapabilities(context.credentials, {
        testDoi:context.doi,
        email:context.email,
      });
      const capabilities = entitlementCheck.capabilities || {};
      const entitlement = {
        httpStatus:entitlementCheck.entitlementStatus,
        entitled:capabilities.entitled === true
          || capabilities.fullView === true
          || capabilities.completePdf === true,
      };
      assessment = await assessMainBuffer(buffer, {
        doi:context.doi,
        work:context.work,
        candidate,
        entitlement,
      });
    } catch (error) {
      entitlementCheck = { error:error.message };
    }
  }
  if (!assessment.ok) {
    return {
      ...assessment,
      buffer:undefined,
      auditBuffer:assessment.status === STATUS.PREVIEW_ONLY ? buffer : undefined,
      finalUrl,
      contentType,
      httpStatus:statusCode,
      entitlementCheck,
      ...responseEvidence({ headers:responseHeaders }),
    };
  }
  return {
    ...assessment,
    ok:true,
    buffer,
    finalUrl,
    contentType,
    httpStatus:statusCode,
    pageCount:assessment.pageCount,
    size:buffer.length,
    sha256:sha256(buffer),
    documentVersion:assessment.documentVersion,
    documentFormat:candidate.documentFormat || documentFormat(candidate),
    license:candidate.license || null,
    sourceDocument:reconstructed ? {
      buffer:sourceBuffer,
      html:reconstructed.html,
      sourceHash:reconstructed.sourceHash,
      sourceExtension:reconstructed.sourceExtension,
      generator:reconstructed.generator,
      sourceUrl:finalUrl,
    } : null,
    entitlementCheck,
    ...responseEvidence({ headers:responseHeaders }),
  };
}

async function attemptSupplementCandidate(candidate, context) {
  if (Buffer.isBuffer(candidate.localBuffer)) {
    const contentType = candidate.contentType || 'application/pdf';
    const finalUrl = candidate.url;
    const validation = await validateSupplementDocument({ buffer:candidate.localBuffer, contentType, finalUrl, candidate });
    if (!validation.ok) return { ...validation, status:STATUS.INVALID_PDF, finalUrl, contentType };
    return { ...validation, buffer:candidate.localBuffer, finalUrl, contentType };
  }
  const response = await hostLimiter.run(candidate.url, () => fetchWithPolicy(candidate.requestUrl || candidate.url, {
    email: context.email,
    timeoutMs: 90000,
    maxRedirects: 8,
    retries: candidate.probe ? 0 : 1,
    maxBytes: 120 * 1024 * 1024,
    accept: 'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/octet-stream;q=0.8,text/html;q=0.3',
    headers: {
      ...(candidate.headers || {}),
      ...(candidate.referer ? { Referer: candidate.referer, 'Accept-Language': 'en-US,en;q=0.8' } : {}),
    },
  }));
  const buffer = response.buffer;
  const contentType = String(response.headers['content-type'] || '').toLowerCase();
  const finalUrl = redactCredentialUrl(response.finalUrl);
  if (!response.ok || contentType.includes('text/html') || /^\s*<(?:!doctype|html)/i.test(buffer.toString('utf8', 0, 500))) {
    const text = buffer.toString('utf8');
    return {
      ok: false, status: classifyDownloadFailure(text, response.status, candidate.apiService),
      httpStatus: response.status, finalUrl, contentType,
    };
  }
  const validation = await validateSupplementDocument({ buffer, contentType, finalUrl, candidate });
  if (!validation.ok) return { ...validation, status:STATUS.INVALID_PDF, finalUrl, contentType };
  return { ...validation, buffer, finalUrl, contentType };
}

function supplementBaseName(candidate, extension) {
  try {
    const raw = candidate.archiveEntryName
      || decodeURIComponent(new URL(candidate.url).pathname.split('/').filter(Boolean).at(-1) || 'supplement');
    const base = path.extname(raw) ? raw.slice(0, -path.extname(raw).length) : raw;
    return `${safeFilename(base, 90)}${extension}`;
  } catch { return `supplement${extension}`; }
}

const MANUAL_SI_ATTEMPT_STATUSES = new Set([
  STATUS.PUBLISHER_BLOCKED,
  STATUS.CAPTCHA,
  STATUS.LOGIN_REQUIRED,
  STATUS.PAYWALL,
  STATUS.API_PERMISSION_REQUIRED,
]);

export function shouldStopSupplementHost(attempt) {
  return Boolean(attempt && !attempt.ok && MANUAL_SI_ATTEMPT_STATUSES.has(attempt.status));
}

export function shouldInspectSupplementLandings(localValidationResults = []) {
  return !localValidationResults.some((result) => result?.ok);
}

function uniqueUrls(items = []) {
  return [...new Set(items.map((item) => item?.url).filter(Boolean))].slice(0, 8);
}

export function supplementFailureOutcome({ attempts = [], selected = [], excluded = [], landingAttempts = [], providerErrors = [] } = {}) {
  const unsupported = excluded.filter((candidate) => String(candidate.reason || '').startsWith('unsupported_format:'));
  const blockedAttempts = attempts.filter((attempt) => !attempt.ok && MANUAL_SI_ATTEMPT_STATUSES.has(attempt.status));
  const blockedLandings = landingAttempts.filter((attempt) => !attempt.ok && MANUAL_SI_ATTEMPT_STATUSES.has(attempt.status));
  const confirmedBlocked = blockedAttempts.filter((attempt) => attempt.evidence === 'confirmed');
  if (confirmedBlocked.length) {
    const preferredLandingLinks = blockedLandings.map((attempt) => ({ url:attempt.finalUrl || attempt.url }));
    return {
      status:SI_STATUS.MANUAL_REQUIRED,
      message:'已確認 SI 檔案網址，但出版社拒絕自動下載、要求登入或互動驗證；請使用下方 SI 候選在瀏覽器開啟。',
      manualLinks:uniqueUrls([...preferredLandingLinks, ...confirmedBlocked]),
    };
  }
  if (unsupported.length) {
    const formats = [...new Set(unsupported.map((candidate) => String(candidate.reason).split(':')[1]).filter(Boolean))].join('、');
    return {
      status:SI_STATUS.MANUAL_REQUIRED,
      message:`已發現 SI，但格式為 ${formats || '目前不支援的格式'}，未自動保存；請使用下方連結在瀏覽器下載。`,
      manualLinks:uniqueUrls(unsupported),
    };
  }
  if (blockedAttempts.length || blockedLandings.length) {
    return {
      status:SI_STATUS.DISCOVERY_BLOCKED,
      message:'出版社阻擋 SI discovery；目前只能確認檢查受阻，無法確認猜測路徑是否真的存在 SI。程式會在重試時繼續查官方 API 與典藏。',
      manualLinks:[],
    };
  }
  if (providerErrors.length) {
    return {
      status:SI_STATUS.DOWNLOAD_FAILED,
      message:`SI provider 連線或解析失敗，不能據此判定沒有 SI：${providerErrors.join('；')}`,
      manualLinks:[],
    };
  }
  const failedReliableCandidate = attempts.some((attempt, index) => !attempt.ok
    && !['excluded_content', 'not_si', 'unsupported_format'].includes(attempt.reason)
    && (attempt.evidence || selected[index]?.evidence) !== 'probe');
  return failedReliableCandidate
    ? { status:SI_STATUS.DOWNLOAD_FAILED, message:'已有明確 SI 候選，但下載或格式／內容驗證失敗。', manualLinks:[] }
    : { status:SI_STATUS.NOT_FOUND, message:'候選經格式或內容驗證後未發現可靠 SI；這不是主文下載錯誤。', manualLinks:[] };
}

async function collectSupplements(item, job, email, discovery) {
  if (!job.includeSupplements) {
    item.siStatus = SI_STATUS.NOT_REQUESTED;
    return;
  }
  if (!item.doi) {
    item.siStatus = SI_STATUS.NO_DOI;
    item.siMessage = '沒有 DOI，無法可靠尋找對應 SI。';
    return;
  }
  item.siStatus = SI_STATUS.PENDING;
  item.siFiles = [];
  item.siAttempts = [];
  item.siIgnoredCandidates = [];
  item.siManualLinks = [];
  const candidates = [];
  const add = (candidate) => {
    if (candidate?.url && !candidates.some((current) => current.url === candidate.url)) candidates.push(candidate);
  };
  let embeddedCandidate = null;
  if (item.fileName) {
    try {
      const mainBuffer = await fs.readFile(path.join(jobDir(job.id), 'pdfs', item.fileName));
      (await extractEmbeddedPdfAttachments(mainBuffer)).forEach(add);
      const embedded = await extractEmbeddedSupplementPdf(mainBuffer);
      if (embedded) {
        embeddedCandidate = {
          url:`embedded-main://ref${String(item.refNumber).padStart(4, '0')}/embedded-main.pdf`,
          source:'主文 PDF 內嵌 SI', access:'local', label:'Supplementary Materials',
          evidence:'confirmed',
          localBuffer:embedded.buffer, embeddedStartPage:embedded.startPage, embeddedPageCount:embedded.pageCount,
        };
        add(embeddedCandidate);
      }
    } catch (error) {
      item.siIgnoredCandidates.push({ source:'主文 PDF 內嵌 SI', reason:'embedded_si_inspection_failed', detail:error.message });
    }
  }
  (discovery.repositorySupplementCandidates || discovery.figshareSupplementCandidates || []).forEach(add);
  supplementCandidatesFromCrossref(discovery.work, { includeExcluded:true }).forEach(add);
  directSupplementCandidates(item.doi, discovery.work).forEach(add);
  const initialClassified = applyRelatedSupplementExclusions(candidates);
  const localCandidates = rankSupplementCandidates(initialClassified)
    .filter((candidate) => Buffer.isBuffer(candidate.localBuffer)).slice(0, 20);
  const localValidation = new Map();
  for (const candidate of localCandidates) {
    try {
      localValidation.set(candidate.url, await attemptSupplementCandidate(candidate, { email }));
    } catch (error) {
      localValidation.set(candidate.url, { ok:false, status:STATUS.DOWNLOAD_FAILED, error:error.message });
    }
  }
  const landingAttempts = [];
  for (const landingUrl of shouldInspectSupplementLandings([...localValidation.values()]) ? (discovery.supplementLandingUrls || []) : []) {
    try {
      const response = await hostLimiter.run(landingUrl, () => fetchWithPolicy(landingUrl, {
        email, timeoutMs: 30000, retries: 0, maxBytes: 10 * 1024 * 1024,
        accept: 'text/html,application/xhtml+xml;q=0.9',
      }));
      const contentType = String(response.headers['content-type'] || '').toLowerCase();
      if (!response.ok) {
        landingAttempts.push({
          url:landingUrl, finalUrl:response.finalUrl, ok:false, httpStatus:response.status,
          status:classifyDownloadFailure(response.buffer.toString('utf8'), response.status),
        });
        continue;
      }
      if (!contentType.includes('html')) {
        landingAttempts.push({ url:landingUrl, finalUrl:response.finalUrl, ok:false, httpStatus:response.status, status:STATUS.INVALID_PDF });
        continue;
      }
      landingAttempts.push({ url:landingUrl, finalUrl:response.finalUrl, ok:true, httpStatus:response.status });
      supplementCandidatesFromHtml(response.buffer.toString('utf8'), response.finalUrl, { includeExcluded:true }).forEach(add);
    } catch (error) {
      landingAttempts.push({ url:landingUrl, ok:false, status:STATUS.DOWNLOAD_FAILED, error:error.message });
    }
  }
  item.siLandingAttempts = landingAttempts;
  const classified = applyRelatedSupplementExclusions(candidates);
  const excluded = classified.filter((candidate) => candidate.classification === 'excluded_attachment');
  item.siIgnoredCandidates.push(...excluded.map((candidate) => ({
    url:candidate.url, source:candidate.source, label:candidate.label || '', reason:candidate.reason,
  })));
  const selected = rankSupplementCandidates(classified).slice(0, 20);
  item.siCandidates = selected.map(({ url, source, access, label, reason, evidence }) => ({ url, source, access, label, reason, evidence }));
  if (!selected.length) {
    const outcome = supplementFailureOutcome({ selected, excluded, landingAttempts, providerErrors:discovery.siProviderErrors });
    item.siStatus = outcome.status;
    item.siMessage = outcome.status === SI_STATUS.NOT_FOUND
      ? '目前 API、metadata 與出版社 adapter 未發現可靠 SI；這不是主文下載錯誤。'
      : outcome.message;
    item.siManualLinks = outcome.manualLinks;
    return;
  }
  const attempts = [];
  const files = [];
  const hashes = new Set();
  const blockedHosts = new Set();
  let localSupplementCollected = false;
  for (let candidateIndex = 0; candidateIndex < selected.length; candidateIndex += 1) {
    const candidate = selected[candidateIndex];
    if (localSupplementCollected && !candidate.localBuffer) {
      item.siIgnoredCandidates.push(...selected.slice(candidateIndex).map((remaining) => ({
        url:remaining.url, source:remaining.source, label:remaining.label || '', reason:'repository_si_collected',
      })));
      break;
    }
    let candidateHost = '';
    try { candidateHost = new URL(candidate.url).hostname.toLowerCase(); } catch { /* URL 已在 provider 層驗證。 */ }
    if (candidateHost && blockedHosts.has(candidateHost)) {
      item.siIgnoredCandidates.push({
        url:candidate.url, source:candidate.source, label:candidate.label || '', reason:'publisher_host_blocked_after_previous_attempt',
      });
      continue;
    }
    try {
      const result = localValidation.get(candidate.url) || await attemptSupplementCandidate(candidate, { email });
      attempts.push({ source: candidate.source, url: candidate.url, probe:Boolean(candidate.probe), evidence:candidate.evidence || 'unknown', ...result, buffer: undefined });
      if (candidateHost && shouldStopSupplementHost(result)) blockedHosts.add(candidateHost);
      if (!result.ok) {
        if (['excluded_content', 'not_si', 'unsupported_format'].includes(result.reason)) {
          item.siIgnoredCandidates.push({ url:candidate.url, source:candidate.source, label:candidate.label || '', reason:result.reason, detail:result.error });
        }
        continue;
      }
      if (hashes.has(result.sha256)) {
        item.siIgnoredCandidates.push({ url:candidate.url, source:candidate.source, label:candidate.label || '', reason:'duplicate_sha256' });
        continue;
      }
      hashes.add(result.sha256);
      const index = files.length + 1;
      const fileName = `ref${String(item.refNumber).padStart(4, '0')}_SI_${String(index).padStart(2, '0')}_${supplementBaseName(candidate, result.extension)}`;
      await writeFileAtomic(path.join(jobDir(job.id), 'supplements', fileName), result.buffer);
      files.push({
        fileName, source: candidate.source, downloadUrl: result.finalUrl, contentType: result.contentType,
        pageCount: result.pageCount, size: result.size, sha256: result.sha256,
        ...(candidate.embeddedStartPage ? { embeddedStartPage:candidate.embeddedStartPage } : {}),
      });
      if (candidate.localBuffer) localSupplementCollected = true;
      if (candidate.localBuffer) {
        if (!candidate.embeddedStartPage) {
          if (files.length < 2) continue;
          item.siIgnoredCandidates.push(...selected.slice(candidateIndex + 1).map((remaining) => ({
            url:remaining.url, source:remaining.source, label:remaining.label || '', reason:'maximum_two_reached',
          })));
          break;
        }
        item.siIgnoredCandidates.push(...selected.slice(candidateIndex + 1).map((remaining) => ({
          url:remaining.url, source:remaining.source, label:remaining.label || '', reason:'embedded_si_collected',
        })));
        break;
      }
      if (files.length === 2) {
        item.siIgnoredCandidates.push(...selected.slice(candidateIndex + 1).map((remaining) => ({
          url:remaining.url, source:remaining.source, label:remaining.label || '', reason:'maximum_two_reached',
        })));
        break;
      }
    } catch (error) {
      attempts.push({ source: candidate.source, url: candidate.url, probe:Boolean(candidate.probe), evidence:candidate.evidence || 'unknown', status: STATUS.DOWNLOAD_FAILED, error: error.message });
    }
  }
  item.siFiles = files;
  item.siAttempts = attempts;
  if (files.length) {
    item.siStatus = SI_STATUS.COLLECTED;
    item.siMessage = `已取得 ${files.length} 份 SI。`;
  } else {
    const outcome = supplementFailureOutcome({ attempts, selected, excluded, landingAttempts, providerErrors:discovery.siProviderErrors });
    item.siStatus = outcome.status;
    item.siMessage = outcome.message;
    item.siManualLinks = outcome.manualLinks;
  }
}

async function finishReference(item, job, email, discovery = {}, { includeSupplements = job.includeSupplements } = {}) {
  // main_only 與 main_failed retry 必須保留舊有 SI 狀態，且完全不進入 SI discovery。
  if (!includeSupplements) return item;
  try {
    await collectSupplements(item, job, email, discovery);
  } catch (error) {
    item.siStatus = SI_STATUS.DOWNLOAD_FAILED;
    item.siMessage = `SI 蒐集發生錯誤：${error.message}`;
  }
  return item;
}

function strongestFailure(attempts) {
  const priority = [STATUS.API_PERMISSION_REQUIRED, STATUS.LOGIN_REQUIRED, STATUS.PAYWALL, STATUS.PUBLISHER_BLOCKED, STATUS.CAPTCHA, STATUS.INVALID_PDF, STATUS.DOWNLOAD_FAILED];
  return priority.find((status) => attempts.some((attempt) => attempt.status === status)) || STATUS.NO_PDF;
}

export function mainSuccessStatus(candidate = {}, vpn = {}) {
  if (candidate.access === 'oa') return STATUS.READY_OA;
  if (vpn.connected) return STATUS.READY_VPN;
  return STATUS.READY_OTHER;
}

export function apiAccessRequirements(attempts = []) {
  const issues = [];
  const entitlements = [];
  for (const attempt of attempts) {
    if (attempt.status !== STATUS.API_PERMISSION_REQUIRED) continue;
    const source = String(attempt.source || '').toLowerCase();
    if (source.includes('elsevier')) {
      issues.push('Elsevier API key 已設定，但目前文章缺少 PDF 全文權限');
      entitlements.push('Elsevier Article Retrieval／ScienceDirect Full-Text entitlement（必要時依官方指示加 X-ELS-Insttoken）');
    } else if (source.includes('wiley')) {
      issues.push('Wiley TDM token 已設定，但目前文章缺少全文交付權限');
      entitlements.push('Wiley TDM article PDF entitlement；獨立 SI 不含在標準 TDM 交付，需另向 Wiley 詢問 SI machine access');
    } else {
      issues.push(`${attempt.source || '出版社 API'} 缺少目前文章的全文權限`);
      entitlements.push(`${attempt.source || '出版社 API'} full-text entitlement`);
    }
  }
  return { issues:[...new Set(issues)], entitlements:[...new Set(entitlements)] };
}

function recordApiAccessRequirements(item, attempts) {
  const requirements = apiAccessRequirements(attempts);
  item.apiAccessIssues = requirements.issues;
  item.requiredEntitlements = requirements.entitlements;
}

async function collectReferenceLegacy(item, job, email, vpn, endpoints, { includeSupplements = job.includeSupplements } = {}) {
  const resolution = await resolveDoi(item, email, endpoints);
  Object.assign(item, resolution);
  if (!item.doi) {
    if (/https?:\/\//i.test(item.rawCitation || '')) {
      item.status = STATUS.NON_ARTICLE;
      item.message = '此項是含網址但沒有 DOI 的非論文參考資料；已保留原始連結，不誤判為論文 PDF。';
      return finishReference(item, job, email, {}, { includeSupplements });
    }
    item.status = resolution.matchScore > 0 ? STATUS.UNRESOLVED : STATUS.UNRESOLVED;
    item.message = '無法以 citation 可靠配對 DOI，未猜測下載網址。';
    return finishReference(item, job, email, {}, { includeSupplements });
  }
  if (resolution.matchMethod === 'crossref_review') {
    item.status = STATUS.MATCH_REVIEW;
    item.message = `Crossref 配對分數 ${resolution.matchScore.toFixed(2)}，需人工確認 DOI。`;
    if (includeSupplements) {
      item.siStatus = SI_STATUS.NO_DOI;
      item.siMessage = 'DOI 尚待確認，因此未自動下載 SI。';
    }
    return item;
  }

  const discovery = await findCandidates(item.doi, email, endpoints, includeSupplements);
  const { candidates, providerErrors, missingApis, knownOa } = discovery;
  item.missingApis = missingApis;
  item.knownOa = knownOa;
  item.candidates = candidates.map(({ url, source, access }) => ({ url, source, access }));
  if (!candidates.length && missingApis.length) {
    item.status = STATUS.API_MISSING;
    item.message = `目前沒有 PDF 候選；建議先在 .env 設定 ${missingApis.join('、')} 後重試。`;
    return finishReference(item, job, email, discovery, { includeSupplements });
  }
  if (!candidates.length) {
    item.status = providerErrors.length ? STATUS.DOWNLOAD_FAILED : STATUS.NO_PDF;
    item.message = providerErrors.length
      ? `文獻服務連線失敗：${providerErrors.join('；')}`
      : 'Unpaywall、Crossref 與出版社 metadata 均未提供 PDF 候選。';
    return finishReference(item, job, email, discovery, { includeSupplements });
  }
  const attempts = [];
  for (const candidate of candidates) {
    try {
      const result = await attemptCandidate(candidate, { doi: item.doi, email });
      attempts.push({ source: candidate.source, url: candidate.url, ...result, buffer: undefined });
      if (!result.ok) continue;
      const fileName = `ref${String(item.refNumber).padStart(4, '0')}_${safeFilename(item.doi, 80)}.pdf`;
      const filePath = path.join(jobDir(job.id), 'pdfs', fileName);
      await fs.writeFile(filePath, result.buffer);
      await ensureDir(CACHE_DIR);
      await fs.writeFile(cachePdf(item.doi), result.buffer);
      await writeJson(cacheMeta(item.doi), { doi: item.doi, sha256: result.sha256, size: result.size, pageCount: result.pageCount, sourceUrl: result.finalUrl, access: candidate.access, savedAt: new Date().toISOString() });
      item.status = mainSuccessStatus(candidate, vpn);
      item.fileName = fileName;
      item.downloadUrl = result.finalUrl;
      item.sourceProvider = candidate.source;
      item.pageCount = result.pageCount;
      item.size = result.size;
      item.sha256 = result.sha256;
      item.message = candidate.cache ? '由本機快取取得並重新驗證。' : 'PDF 已通過格式、頁數與雜湊驗證。';
      item.attempts = attempts;
      recordApiAccessRequirements(item, attempts);
      return finishReference(item, job, email, discovery, { includeSupplements });
    } catch (error) {
      attempts.push({ source: candidate.source, url: candidate.url, status: STATUS.DOWNLOAD_FAILED, error: error.message });
    }
  }
  const failure = strongestFailure(attempts);
  item.status = knownOa ? STATUS.OA_DOWNLOAD_FAILED : failure;
  if (knownOa) {
    item.message = `API metadata 顯示此文為 OA，但公開網址尚未回傳有效 PDF。${failure === STATUS.API_PERMISSION_REQUIRED ? ' 出版社 API 另回報目前憑證缺少 PDF 全文權限。' : ''}`;
  } else if (failure === STATUS.API_PERMISSION_REQUIRED) {
    item.message = '官方出版社 API 已接受目前憑證，但沒有授予這些文章的 PDF 全文權限；這不是 CAPTCHA，也不代表網頁端一定需要付費。';
  } else if (failure === STATUS.PUBLISHER_BLOCKED) {
    item.message = '出版社 PDF 網址對本機程式回傳 403／Cloudflare challenge；這不等於付費牆，請用結果中的原論文連結在瀏覽器開啟。';
  } else if (failure === STATUS.LOGIN_REQUIRED) {
    item.message = '候選網址要求互動登入或機構 SSO，程式不保存瀏覽器 cookie。';
  } else if (failure === STATUS.PAYWALL) {
    item.message = '回應內容明確要求購買或訂閱全文。';
  } else {
    item.message = `所有 API／metadata 候選均未取得有效 PDF。${missingApis.length ? ` 建議設定 ${missingApis.join('、')} 後重試。` : ''}`;
  }
  item.attempts = attempts;
  recordApiAccessRequirements(item, attempts);
  return finishReference(item, job, email, discovery, { includeSupplements });
}

function attemptForManifest(candidate, result, durationMs) {
  return {
    source:candidate.source,
    url:redactCredentialUrl(candidate.url),
    stage:candidate.stage ?? null,
    outcome:result.ok ? 'success' : 'error',
    status:result.status || (result.ok ? 'validated' : STATUS.DOWNLOAD_FAILED),
    failureCode:result.failureCode || null,
    httpStatus:result.httpStatus ?? null,
    durationMs,
    finalUrl:redactCredentialUrl(result.finalUrl),
    contentType:result.contentType || null,
    pageCount:result.pageCount ?? null,
    expectedPageCount:result.expectedPageCount ?? null,
    requestId:result.requestId || null,
    rateLimitRemaining:result.rateLimitRemaining || null,
    rateLimitReset:result.rateLimitReset || null,
    entitlementCheck:result.entitlementCheck || null,
    error:result.error || result.message || null,
  };
}

function failureNextAction(code, candidate = {}) {
  const actions = {
    [FAILURE_CODE.PREVIEW_ONLY]:'已排除預覽；將繼續 repository／AAM fallback，必要時申請出版社完整全文權限。',
    [FAILURE_CODE.INCOMPLETE_DOCUMENT]:'改查其他 VoR 或 AAM repository 來源。',
    [FAILURE_CODE.IDENTITY_MISMATCH]:'來源回傳錯論文；請檢查 DOI 與 repository metadata。',
    [FAILURE_CODE.IDENTITY_UNVERIFIED]:'請取得含 DOI 的正式 PDF，或補齊題名、第一作者與年份證據。',
    [FAILURE_CODE.VERSION_UNVERIFIED]:'來源只標示 alternative version；需先證明是 AAM，不能當成 VoR。',
    [FAILURE_CODE.PREPRINT_NOT_ALLOWED]:'只接受 VoR 或 AAM；請改查期刊或 repository accepted manuscript。',
    [FAILURE_CODE.API_CREDENTIAL_INVALID]:'更新或重新申請該 provider API key。',
    [FAILURE_CODE.API_FEATURE_NOT_ENABLED]:'向 provider 申請 full-text／entitlement API capability。',
    [FAILURE_CODE.INSTITUTION_ENTITLEMENT_FALSE]:'確認機構 IP、InstToken 或訂閱 entitlement。',
    [FAILURE_CODE.AUTH_NETWORK_MISMATCH]:'連線至有授權的機構網路，或完成專用瀏覽器 profile 登入。',
    [FAILURE_CODE.FORMAT_NOT_PERMITTED]:'申請 PDF MIME，或使用完整 XML／HTML 重建。',
    [FAILURE_CODE.QUOTA_THROTTLED]:'等待 rate limit 重置後只重試失敗主文。',
    [FAILURE_CODE.OA_LOCATION_STALE]:'重新查詢 OA provider，以取得更新的簽名下載網址。',
    [FAILURE_CODE.REPOSITORY_METADATA_ONLY]:'沿 repository landing、Signposting 或 DSpace bitstream 繼續解析。',
    [FAILURE_CODE.PUBLISHER_AUTOMATION_BLOCKED]:'申請 machine access／TDM allowlisting；瀏覽器備援僅作最後選配。',
    [FAILURE_CODE.NO_CANDIDATE]:'申請 CORE／LibKey／GetFTR 或出版社 TDM 權限後重試。',
  };
  return actions[code] || `重試 ${candidate.source || '其他來源'}，並查看 provider trace。`;
}

async function savePreviewAudit(item, job, candidate, result) {
  if (!Buffer.isBuffer(result.auditBuffer)) return null;
  const hash = sha256(result.auditBuffer);
  const fileName = `ref${String(item.refNumber).padStart(4, '0')}_${safeFilename(item.doi, 70)}_preview_${hash.slice(0, 10)}.pdf`;
  const previewDir = path.join(jobDir(job.id), 'previews');
  await ensureDir(previewDir);
  await writeFileAtomic(path.join(previewDir, fileName), result.auditBuffer);
  item.previewFiles = [
    ...(item.previewFiles || []).filter((entry) => entry.sha256 !== hash),
    {
      fileName,
      source:candidate.source,
      sourceUrl:redactCredentialUrl(result.finalUrl || candidate.url),
      pageCount:result.pageCount || null,
      size:result.auditBuffer.length,
      sha256:hash,
      excludedFromSuccess:true,
      excludedFromArchive:true,
      savedAt:nowIso(),
    },
  ];
  return fileName;
}

async function persistValidatedMain(item, job, candidate, result, vpn) {
  const stamp = nowIso();
  const fileName = `ref${String(item.refNumber).padStart(4, '0')}_${safeFilename(item.doi, 80)}_main.pdf`;
  const filePath = path.join(jobDir(job.id), 'pdfs', fileName);
  await writeFileAtomic(filePath, result.buffer);

  let sourceDocument = null;
  if (result.sourceDocument?.buffer) {
    const sourceDir = path.join(jobDir(job.id), 'source_documents');
    await ensureDir(sourceDir);
    const sourceFileName = `ref${String(item.refNumber).padStart(4, '0')}_${safeFilename(item.doi, 70)}_structured${result.sourceDocument.sourceExtension || '.xml'}`;
    const htmlFileName = `ref${String(item.refNumber).padStart(4, '0')}_${safeFilename(item.doi, 70)}_reconstructed.html`;
    await writeFileAtomic(path.join(sourceDir, sourceFileName), result.sourceDocument.buffer);
    await writeFileAtomic(path.join(sourceDir, htmlFileName), result.sourceDocument.html, 'utf8');
    sourceDocument = {
      fileName:sourceFileName,
      renderedHtmlFileName:htmlFileName,
      sourceHash:result.sourceDocument.sourceHash,
      sourceUrl:result.sourceDocument.sourceUrl,
      generator:result.sourceDocument.generator,
    };
  }

  const sourceProvider = candidate.cache
    ? candidate.source || 'Validated cache'
    : candidate.source;
  const sourceUrl = candidate.cache
    ? candidate.originalSourceUrl || result.finalUrl
    : result.finalUrl;
  const existingCache = await readJson(cacheMeta(item.doi));
  await ensureDir(CACHE_DIR);
  await writeFileAtomic(cachePdf(item.doi), result.buffer);
  await writeJson(cacheMeta(item.doi), {
    doi:item.doi,
    sha256:result.sha256,
    size:result.size,
    pageCount:result.pageCount,
    sourceProvider,
    sourceUrl,
    access:candidate.access,
    license:result.license || candidate.license || null,
    documentVersion:result.documentVersion,
    documentFormat:result.documentFormat,
    mainValidation:result.mainValidation,
    firstSavedAt:existingCache?.firstSavedAt || existingCache?.savedAt || stamp,
    savedAt:stamp,
    lastValidatedAt:stamp,
  });

  item.status = mainSuccessStatus(candidate, vpn);
  item.failureCode = null;
  item.fileName = fileName;
  item.downloadUrl = sourceUrl;
  item.originalSourceUrl = sourceUrl;
  item.sourceProvider = sourceProvider;
  item.documentVersion = result.documentVersion;
  item.documentFormat = result.documentFormat;
  item.mainValidation = result.mainValidation;
  item.pageCount = result.pageCount;
  item.expectedPageCount = result.expectedPageCount;
  item.size = result.size;
  item.sha256 = result.sha256;
  item.license = result.license || candidate.license || null;
  item.firstSavedAt = item.firstSavedAt || stamp;
  item.lastValidatedAt = stamp;
  item.sourceDocument = sourceDocument;
  item.message = candidate.cache
    ? '快取通過 DOI 身分與全文完整性重驗證。'
    : '主文已通過 DOI 身分與全文完整性驗證。';
}

function strongestValidatedFailure(attempts = []) {
  const priorities = [
    FAILURE_CODE.PREVIEW_ONLY,
    FAILURE_CODE.IDENTITY_MISMATCH,
    FAILURE_CODE.INCOMPLETE_DOCUMENT,
    FAILURE_CODE.IDENTITY_UNVERIFIED,
    FAILURE_CODE.VERSION_UNVERIFIED,
    FAILURE_CODE.PREPRINT_NOT_ALLOWED,
    FAILURE_CODE.API_FEATURE_NOT_ENABLED,
    FAILURE_CODE.INSTITUTION_ENTITLEMENT_FALSE,
    FAILURE_CODE.AUTH_NETWORK_MISMATCH,
    FAILURE_CODE.PUBLISHER_AUTOMATION_BLOCKED,
    FAILURE_CODE.QUOTA_THROTTLED,
    FAILURE_CODE.FORMAT_NOT_PERMITTED,
    FAILURE_CODE.OA_LOCATION_STALE,
    FAILURE_CODE.REPOSITORY_METADATA_ONLY,
    FAILURE_CODE.DOWNLOAD_FAILED,
  ];
  for (const code of priorities) {
    const attempt = attempts.find((entry) => entry.failureCode === code);
    if (attempt) return attempt;
  }
  return attempts.at(-1) || null;
}

export async function firstAcceptedMainCandidate(candidates, context, options = {}) {
  const attempt = options.attempt || attemptCandidate;
  for (const candidate of candidates || []) {
    const startedAt = Date.now();
    let result;
    try {
      result = await attempt(candidate, context);
    } catch (error) {
      result = {
        ok:false,
        status:STATUS.DOWNLOAD_FAILED,
        failureCode:error.failureCode || FAILURE_CODE.DOWNLOAD_FAILED,
        httpStatus:error.status || null,
        finalUrl:candidate.url,
        error:error.message,
      };
    }
    const record = { candidate, result, durationMs:Date.now() - startedAt };
    if (options.onResult) await options.onResult(record);
    if (result.ok) return record;
  }
  return null;
}

async function collectReference(item, job, email, vpn, endpoints, { includeSupplements = job.includeSupplements } = {}) {
  const resolution = await resolveDoi(item, email, endpoints);
  Object.assign(item, resolution);
  item.lastValidatedAt = nowIso();
  if (!item.doi) {
    item.failureCode = FAILURE_CODE.NO_CANDIDATE;
    if (/https?:\/\//i.test(item.rawCitation || '')) {
      item.status = STATUS.NON_ARTICLE;
      item.message = '此筆不是可解析 DOI 的期刊論文，未嘗試主文下載。';
    } else {
      item.status = STATUS.UNRESOLVED;
      item.message = '無法從 citation 可靠解析 DOI。';
    }
    item.nextAction = failureNextAction(item.failureCode);
    return finishReference(item, job, email, {}, { includeSupplements });
  }
  if (resolution.matchMethod === 'crossref_review') {
    item.status = STATUS.MATCH_REVIEW;
    item.failureCode = FAILURE_CODE.IDENTITY_UNVERIFIED;
    item.message = `Crossref 配對分數 ${resolution.matchScore.toFixed(2)}，需先確認 DOI。`;
    item.nextAction = failureNextAction(item.failureCode);
    return item;
  }

  const attempts = [];
  const credentials = getApiCredentials();
  item.providerTrace = [];
  let work = null;
  try {
    work = await traceProvider(
      'Crossref',
      item.providerTrace,
      () => getCrossrefWork(item.doi, email, endpoints),
    );
  } catch { /* Identity can still be verified from the PDF itself. */ }

  const earlyDiscovery = await findCandidates(
    item.doi,
    email,
    endpoints,
    false,
    { onlyEarly:true, work },
  );
  item.providerTrace.push(...earlyDiscovery.providerTrace);
  const recordAttempt = async ({ candidate, result, durationMs }) => {
    const manifestAttempt = attemptForManifest(candidate, result, durationMs);
    attempts.push(manifestAttempt);
    item.providerTrace.push({
      provider:candidate.source,
      outcome:result.ok ? 'success' : 'error',
      httpStatus:result.httpStatus ?? null,
      durationMs,
      failureCode:result.failureCode || null,
      requestId:result.requestId || null,
      rateLimitRemaining:result.rateLimitRemaining || null,
      message:result.ok ? null : result.error || result.message || null,
    });
    if (!result.ok && result.failureCode === FAILURE_CODE.PREVIEW_ONLY) {
      await savePreviewAudit(item, job, candidate, result);
      item.mainValidation = result.mainValidation;
      item.expectedPageCount = result.expectedPageCount;
    }
  };
  const earlyAccepted = await firstAcceptedMainCandidate(earlyDiscovery.candidates, {
    doi:item.doi,
    email,
    work,
    credentials,
  }, { onResult:recordAttempt });
  if (earlyAccepted) {
    await persistValidatedMain(item, job, earlyAccepted.candidate, earlyAccepted.result, vpn);
    item.candidates = earlyDiscovery.candidates.map(sanitizedCandidate);
    item.attempts = attempts;
    recordApiAccessRequirements(item, attempts);
    if (!includeSupplements) {
      return finishReference(item, job, email, earlyDiscovery, { includeSupplements:false });
    }
    const siDiscovery = await findCandidates(
      item.doi,
      email,
      endpoints,
      true,
      { skipCache:true, skipOfficial:true, work },
    );
    item.providerTrace.push(...siDiscovery.providerTrace);
    return finishReference(item, job, email, siDiscovery, { includeSupplements:true });
  }

  const discovery = await findCandidates(
    item.doi,
    email,
    endpoints,
    includeSupplements,
    { skipCache:true, skipOfficial:true, work },
  );
  const {
    candidates, providerErrors, providerTrace, missingApis, knownOa,
  } = discovery;
  item.missingApis = missingApis;
  item.knownOa = knownOa;
  item.providerTrace.push(...providerTrace);
  item.candidates = [...earlyDiscovery.candidates, ...candidates].map(sanitizedCandidate);
  if (!candidates.length) {
    const strongest = strongestValidatedFailure(attempts);
    item.failureCode = strongest?.failureCode
      || providerTrace.find((entry) => entry.outcome === 'error')?.failureCode
      || FAILURE_CODE.NO_CANDIDATE;
    item.status = item.failureCode === FAILURE_CODE.PREVIEW_ONLY
      ? STATUS.PREVIEW_ONLY
      : missingApis.length ? STATUS.API_MISSING
        : providerErrors.length ? STATUS.DOWNLOAD_FAILED : STATUS.NO_PDF;
    item.message = item.failureCode === FAILURE_CODE.PREVIEW_ONLY
      ? '只取得預覽或不完整 PDF，已排除成功、ZIP 與成功快取；後續 fallback 亦未取得完整主文。'
      : providerErrors.length
        ? `來源查詢失敗：${providerErrors.join('；')}`
        : '目前來源未提供可驗證的 VoR 或 AAM 主文。';
    item.nextAction = failureNextAction(item.failureCode);
    item.attempts = attempts;
    return finishReference(item, job, email, discovery, { includeSupplements });
  }

  const accepted = await firstAcceptedMainCandidate(candidates, {
    doi:item.doi,
    email,
    work,
    credentials,
  }, { onResult:recordAttempt });
  if (accepted) {
    await persistValidatedMain(item, job, accepted.candidate, accepted.result, vpn);
    item.attempts = attempts;
    recordApiAccessRequirements(item, attempts);
    return finishReference(item, job, email, discovery, { includeSupplements });
  }

  const strongest = strongestValidatedFailure(attempts);
  item.failureCode = strongest?.failureCode || FAILURE_CODE.NO_CANDIDATE;
  item.status = item.failureCode === FAILURE_CODE.PREVIEW_ONLY
    ? STATUS.PREVIEW_ONLY
    : knownOa ? STATUS.OA_DOWNLOAD_FAILED
      : strongest?.status || STATUS.NO_PDF;
  item.message = item.failureCode === FAILURE_CODE.PREVIEW_ONLY
    ? '只取得預覽或不完整 PDF，已排除成功、ZIP 與成功快取；後續 fallback 亦未取得完整主文。'
    : `未取得通過身分與完整性驗證的 VoR／AAM 主文（${item.failureCode}）。`;
  item.nextAction = failureNextAction(item.failureCode, strongest);
  item.attempts = attempts;
  recordApiAccessRequirements(item, attempts);
  return finishReference(item, job, email, discovery, { includeSupplements });
}

export function normalizeRetrievalMode(options = {}) {
  const requested = options?.retrievalMode;
  const retrievalMode = requested == null || requested === ''
    ? (options?.includeSupplements === true ? 'main_and_si' : 'main_only')
    : requested;
  if (!['main_only', 'main_and_si'].includes(retrievalMode)) {
    throw new Error('retrievalMode 只能是 main_only 或 main_and_si');
  }
  return { retrievalMode, includeSupplements: retrievalMode === 'main_and_si' };
}

export function normalizeRetryScope(scope = 'main_failed') {
  const normalized = scope == null || scope === '' ? 'main_failed' : scope;
  if (!['main_failed', 'si_failed', 'all_failed'].includes(normalized)) {
    throw new Error('retry scope 只能是 main_failed、si_failed 或 all_failed');
  }
  return normalized;
}

export function shouldCollectSupplementsWithMain({
  includeSupplements = false, retryOnly = false, retryScope = 'main_failed', item = null,
} = {}) {
  if (!includeSupplements) return false;
  if (!retryOnly) return true;
  if (normalizeRetryScope(retryScope) !== 'all_failed') return false;
  return item ? RETRYABLE_SI_STATUSES.has(item.siStatus) : true;
}

export function jobSummary(items, { includeSupplements = false } = {}) {
  const selected = items.length;
  const collected = items.filter((item) => SUCCESS_STATUSES.has(item.status)).length;
  const siRefsCollected = includeSupplements ? items.filter((item) => (item.siFiles || []).length > 0).length : 0;
  const siFilesCollected = includeSupplements ? items.reduce((sum, item) => sum + (item.siFiles || []).length, 0) : 0;
  const siPending = includeSupplements ? items.filter((item) => item.siStatus === SI_STATUS.PENDING).length : 0;
  const siManualRefs = includeSupplements ? items.filter((item) => item.siStatus === SI_STATUS.MANUAL_REQUIRED).length : 0;
  const siDiscoveryBlockedRefs = includeSupplements ? items.filter((item) => item.siStatus === SI_STATUS.DISCOVERY_BLOCKED).length : 0;
  const siFailedRefs = includeSupplements ? items.filter((item) => [SI_STATUS.DOWNLOAD_FAILED, SI_STATUS.MANUAL_REQUIRED, SI_STATUS.DISCOVERY_BLOCKED].includes(item.siStatus)).length : 0;
  return {
    selected, collected, locked: selected - collected, allCollected: selected > 0 && selected === collected,
    includeSupplements, siRefsCollected, siFilesCollected, siPending, siFailedRefs, siManualRefs, siDiscoveryBlockedRefs,
  };
}

export function retryModeForItem(item, {
  retryOnly = false, includeSupplements = false, retryScope = 'main_failed',
} = {}) {
  if (!retryOnly) return 'main';
  const scope = normalizeRetryScope(retryScope);
  if (scope !== 'si_failed' && RETRYABLE_STATUSES.has(item.status)) return 'main';
  if (scope !== 'main_failed' && includeSupplements
      && RETRYABLE_SI_STATUSES.has(item.siStatus) && SUCCESS_STATUSES.has(item.status)) return 'si_only';
  return null;
}

export function selectReferenceNumbers(spec, references) {
  const available = [...new Set((references || []).map((reference) => reference.refNumber).filter((number) => Number.isInteger(number) && number > 0))].sort((a, b) => a - b);
  if (!available.length) throw new Error('來源論文沒有可選擇的 references');
  if (!String(spec || '').trim() || /^(all|全部)$/i.test(String(spec).trim())) return available;
  return parseRefSpec(spec, available.at(-1));
}

export async function writeJobReport(job) {
  const headers = [
    'ref_number', 'status', 'doi', 'match_score', 'citation', 'file_name', 'source_provider', 'download_url',
    'original_source_url', 'document_version', 'document_format', 'validation_verified', 'identity_method',
    'completeness_reason', 'expected_page_count', 'failure_code', 'provider_trace', 'license',
    'first_saved_at', 'last_validated_at', 'next_action',
    'page_count', 'size_bytes', 'sha256', 'si_status', 'si_file_count', 'si_files', 'si_source_urls', 'si_manual_urls',
    'missing_apis', 'api_access_issues', 'required_entitlements', 'message', 'si_message',
  ];
  const rows = job.items.map((item) => [
    item.refNumber, item.status, item.doi, item.matchScore, item.rawCitation, item.fileName,
    item.sourceProvider, item.downloadUrl, item.originalSourceUrl, item.documentVersion, item.documentFormat,
    item.mainValidation?.verified, item.mainValidation?.identity?.method,
    item.mainValidation?.completeness?.reason, item.expectedPageCount, item.failureCode,
    JSON.stringify(item.providerTrace || []), item.license, item.firstSavedAt, item.lastValidatedAt, item.nextAction,
    item.pageCount, item.size, item.sha256, item.siStatus,
    (item.siFiles || []).length, (item.siFiles || []).map((file) => file.fileName).join(' | '),
    (item.siFiles || []).map((file) => file.downloadUrl).join(' | '), (item.siManualLinks || []).join(' | '), (item.missingApis || []).join(' | '),
    (item.apiAccessIssues || []).join(' | '), (item.requiredEntitlements || []).join(' | '),
    item.message, item.siMessage,
  ]);
  const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n') + '\r\n';
  await writeFileAtomic(path.join(jobDir(job.id), 'report.csv'), `\ufeff${csv}`, 'utf8');
  const errors = job.items
    .filter((item) => (!SUCCESS_STATUSES.has(item.status) && item.status !== STATUS.PENDING) || [SI_STATUS.DOWNLOAD_FAILED, SI_STATUS.MANUAL_REQUIRED, SI_STATUS.DISCOVERY_BLOCKED].includes(item.siStatus))
    .map((item) => {
      const attempts = (item.attempts || []).map((attempt) => `  - ${attempt.source || 'unknown'} | ${attempt.status || attempt.httpStatus || 'error'} | ${attempt.url || ''} | ${attempt.error || ''}`).join('\n');
      const siAttempts = (item.siAttempts || []).filter((attempt) => !attempt.ok).map((attempt) => `  - ${attempt.source || 'unknown'} | ${attempt.status || attempt.httpStatus || 'error'} | ${attempt.url || ''} | ${attempt.error || ''}`).join('\n');
      return `[ref ${item.refNumber}] ${item.status}: ${item.message || ''}${attempts ? `\n${attempts}` : ''}${[SI_STATUS.DOWNLOAD_FAILED, SI_STATUS.MANUAL_REQUIRED, SI_STATUS.DISCOVERY_BLOCKED].includes(item.siStatus) ? `\n  SI: ${item.siMessage || ''}${siAttempts ? `\n${siAttempts}` : ''}${item.siManualLinks?.length ? `\n  Browser: ${item.siManualLinks.join(' | ')}` : ''}` : ''}`;
    })
    .join('\n\n');
  await writeFileAtomic(path.join(jobDir(job.id), 'errors.log'), errors ? `${errors}\n` : 'No errors.\n', 'utf8');
}

export async function attachManualSupplement(jobId, refNumber, uploadFile) {
  const job = await getJob(jobId);
  if (!job) throw new Error('找不到工作');
  if (runningJobs.has(jobId)) throw new Error('工作仍在執行中，請完成後再上傳 SI');
  const item = job.items.find((candidate) => candidate.refNumber === Number(refNumber));
  if (!item) throw new Error(`找不到 ref ${refNumber}`);
  if (!uploadFile?.path) throw new Error('未收到 SI 檔案');
  if ((item.siFiles || []).length >= 2) throw new Error('每篇 reference 最多保存兩份 SI');
  const originalName = safeFilename(uploadFile.originalname || 'manual-supplement', 100);
  const extension = path.extname(originalName).toLowerCase();
  if (!['.pdf', '.docx', '.doc'].includes(extension)) throw new Error('人工上傳只接受 PDF、DOCX 或 legacy DOC');
  const buffer = await fs.readFile(uploadFile.path);
  const validation = await validateSupplementDocument({
    buffer,
    contentType:uploadFile.mimetype || '',
    finalUrl:originalName,
    candidate:{ url:originalName, label:'Supporting Information manual upload', source:'人工瀏覽器上傳' },
  });
  if (!validation.ok) throw new Error(`SI 驗證失敗：${validation.error || validation.reason}`);
  if ((item.siFiles || []).some((file) => file.sha256 === validation.sha256)) throw new Error('這份 SI 已經上傳過（SHA-256 相同）');
  const index = (item.siFiles || []).length + 1;
  const fileName = `ref${String(item.refNumber).padStart(4, '0')}_SI_${String(index).padStart(2, '0')}_manual_${originalName}`;
  await writeFileAtomic(path.join(jobDir(job.id), 'supplements', fileName), buffer);
  item.siFiles = [...(item.siFiles || []), {
    fileName, source:'人工瀏覽器上傳', downloadUrl:null, originalName,
    contentType:uploadFile.mimetype || '', pageCount:validation.pageCount,
    size:validation.size, sha256:validation.sha256,
  }];
  item.siStatus = SI_STATUS.COLLECTED;
  item.siMessage = `已取得 ${item.siFiles.length} 份 SI（含人工瀏覽器上傳）。`;
  item.siManualUploadedAt = new Date().toISOString();
  job.summary = jobSummary(job.items, { includeSupplements:job.includeSupplements });
  job.updatedAt = new Date().toISOString();
  await saveJob(job);
  await writeJobReport(job);
  return job;
}

export async function retryMainWithBrowser(jobId, refNumber, options = {}) {
  const job = await getJob(jobId);
  if (!job) throw new Error('找不到工作');
  if (runningJobs.has(jobId)) throw new Error('工作執行中，不能同時啟動瀏覽器備援');
  const item = job.items.find((entry) => entry.refNumber === Number(refNumber));
  if (!item) throw new Error(`找不到 ref ${refNumber}`);
  if (!item.doi) throw new Error(`ref ${refNumber} 沒有可用 DOI`);
  const credentials = getApiCredentials();
  const result = await downloadWithAuthenticatedBrowser(
    options.url || `https://doi.org/${item.doi}`,
    { enabled:credentials.browserFallbackEnabled, ...options },
  );
  item.providerTrace = item.providerTrace || [];
  if (!result.ok) {
    item.failureCode = result.failureCode || FAILURE_CODE.PUBLISHER_AUTOMATION_BLOCKED;
    item.status = result.failureCode === FAILURE_CODE.AUTH_NETWORK_MISMATCH
      ? STATUS.LOGIN_REQUIRED : STATUS.PUBLISHER_BLOCKED;
    item.message = result.error;
    item.nextAction = failureNextAction(item.failureCode);
    item.providerTrace.push({
      provider:'authenticated-browser',
      outcome:'error',
      httpStatus:null,
      durationMs:null,
      failureCode:item.failureCode,
      message:result.error,
    });
  } else {
    const { email } = await getSettings();
    const work = await getCrossrefWork(item.doi, email, options.endpoints || {}).catch(() => null);
    const candidate = {
      url:result.finalUrl,
      source:'Authenticated browser fallback',
      access:'publisher',
      documentVersion:'vor',
      documentFormat:'publisher_pdf',
    };
    const validation = await assessMainBuffer(result.buffer, {
      doi:item.doi,
      work,
      candidate,
    });
    if (!validation.ok) {
      item.failureCode = validation.failureCode;
      item.status = validation.classification === 'preview' ? STATUS.PREVIEW_ONLY : STATUS.INVALID_PDF;
      item.mainValidation = validation.mainValidation;
      item.message = validation.message || validation.error;
      item.nextAction = failureNextAction(item.failureCode);
      await savePreviewAudit(item, job, candidate, {
        ...validation,
        finalUrl:result.finalUrl,
        auditBuffer:validation.classification === 'preview' ? result.buffer : undefined,
      });
      item.providerTrace.push({
        provider:'authenticated-browser',
        outcome:'error',
        httpStatus:200,
        durationMs:null,
        failureCode:item.failureCode,
        message:item.message,
      });
    } else {
      const vpn = await getVpnStatus();
      await persistValidatedMain(item, job, candidate, {
        ...validation,
        buffer:result.buffer,
        finalUrl:result.finalUrl,
        contentType:'application/pdf',
        documentFormat:'publisher_pdf',
      }, vpn);
      item.providerTrace.push({
        provider:'authenticated-browser',
        outcome:'success',
        httpStatus:200,
        durationMs:null,
        failureCode:null,
      });
    }
  }
  item.lastValidatedAt = nowIso();
  item.finishedAt = nowIso();
  job.summary = jobSummary(job.items, { includeSupplements:job.includeSupplements });
  job.updatedAt = nowIso();
  await saveJob(job);
  await writeJobReport(job);
  return job;
}

async function historicalProvenance(doi, sha = '') {
  const entries = await fs.readdir(JOBS_DIR, { withFileTypes:true }).catch(() => []);
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = await readJson(path.join(JOBS_DIR, entry.name, 'manifest.json'));
    for (const item of manifest?.items || []) {
      if (normalizeDoi(item.doi) !== normalizeDoi(doi)) continue;
      const sourceUrl = [item.originalSourceUrl, item.downloadUrl]
        .find((value) => /^https?:\/\//i.test(String(value || '')));
      if (!sourceUrl || /cache|快取/i.test(String(item.sourceProvider || ''))) continue;
      const shaMatched = Boolean(sha && item.sha256 && item.sha256 === sha);
      matches.push({
        sourceUrl,
        sourceProvider:item.sourceProvider || 'Historical provider',
        license:item.license || null,
        documentVersion:item.documentVersion || null,
        documentFormat:item.documentFormat || null,
        jobId:manifest.id || entry.name,
        shaMatched,
        savedAt:item.firstSavedAt || item.finishedAt || manifest.createdAt || null,
      });
    }
  }
  return matches.sort((left, right) =>
    Number(right.shaMatched) - Number(left.shaMatched)
    || String(left.savedAt || '').localeCompare(String(right.savedAt || '')))[0] || null;
}

export async function revalidateJobMainDocuments(jobId, options = {}) {
  const job = await getJob(jobId);
  if (!job) throw new Error(`找不到工作 ${jobId}`);
  if (runningJobs.has(jobId)) throw new Error(`工作 ${jobId} 執行中，不能重驗證`);
  const settings = await getSettings();
  const email = options.email || settings.email;
  const stamp = nowIso();
  const results = [];
  for (const item of job.items) {
    const wasPreviouslyRevalidated = (item.providerTrace || [])
      .some((entry) => entry.provider === 'existing-job-revalidation');
    const currentFileName = item.fileName || item.previewFileName;
    if (!currentFileName || (!SUCCESS_STATUSES.has(item.status) && !wasPreviouslyRevalidated)) continue;
    item.revalidationPreviousStatus ||= SUCCESS_STATUSES.has(item.status) ? item.status : null;
    const fileName = path.basename(currentFileName);
    const filePath = path.join(jobDir(job.id), 'pdfs', fileName);
    const buffer = await fs.readFile(filePath).catch(() => null);
    if (!buffer) {
      item.status = STATUS.DOWNLOAD_FAILED;
      item.failureCode = FAILURE_CODE.OA_LOCATION_STALE;
      item.message = 'Manifest 指向的主文檔案不存在。';
      item.nextAction = failureNextAction(item.failureCode);
      results.push({ refNumber:item.refNumber, ok:false, failureCode:item.failureCode });
      continue;
    }
    const fileHash = sha256(buffer);
    const provenance = await historicalProvenance(item.doi, fileHash);
    if (provenance && (
      !/^https?:\/\//i.test(String(item.originalSourceUrl || item.downloadUrl || ''))
      || /cache|快取/i.test(String(item.sourceProvider || ''))
    )) {
      item.originalSourceUrl = provenance.sourceUrl;
      item.downloadUrl = provenance.sourceUrl;
      item.sourceProvider = provenance.sourceProvider;
      item.license ||= provenance.license;
      item.provenanceRecoveredFromJob = provenance.jobId;
    }
    const work = await getCrossrefWork(item.doi, email, options.endpoints || {}).catch(() => null);
    const source = item.sourceProvider || 'Existing job file';
    const repository = /core|openalex|unpaywall|repository|dspace|eprints|hal|zenodo/i.test(source);
    const candidate = {
      url:item.originalSourceUrl || item.downloadUrl || `https://doi.org/${item.doi}`,
      source,
      access:repository || item.status === STATUS.READY_OA ? 'oa' : 'publisher',
      repository,
      documentVersion:item.documentVersion || (repository ? 'aam' : 'vor'),
      documentFormat:item.documentFormat || (repository ? 'repository_pdf' : 'publisher_pdf'),
      license:item.license || null,
    };
    const validation = await assessMainBuffer(buffer, { doi:item.doi, work, candidate });
    item.providerTrace = [
      ...(item.providerTrace || []),
      {
        provider:'existing-job-revalidation',
        outcome:validation.ok ? 'success' : 'error',
        httpStatus:null,
        durationMs:null,
        failureCode:validation.failureCode || null,
        message:validation.message || validation.error || null,
      },
    ];
    item.lastValidatedAt = stamp;
    item.mainValidation = validation.mainValidation || null;
    item.expectedPageCount = validation.expectedPageCount || null;
    if (!validation.ok) {
      if (validation.classification === 'preview') {
        item.previewFileName = fileName;
        item.previewFiles = [
          ...(item.previewFiles || []).filter((entry) => entry.fileName !== fileName),
          {
            fileName,
            directory:'pdfs',
            source,
            sourceUrl:item.downloadUrl || null,
            pageCount:validation.pageCount || item.pageCount || null,
            size:buffer.length,
            sha256:fileHash,
            excludedFromSuccess:true,
            excludedFromArchive:true,
            savedAt:item.firstSavedAt || item.finishedAt || job.createdAt || stamp,
          },
        ];
        item.fileName = null;
        item.status = STATUS.PREVIEW_ONLY;
      } else {
        item.status = STATUS.INVALID_PDF;
      }
      item.failureCode = validation.failureCode;
      item.message = validation.message || validation.error;
      item.nextAction = failureNextAction(item.failureCode);
      const cached = await readJson(cacheMeta(item.doi));
      if (cached?.sha256 === fileHash) {
        await writeJson(cacheMeta(item.doi), {
          ...cached,
          sourceProvider:item.sourceProvider,
          sourceUrl:item.originalSourceUrl || item.downloadUrl || cached.sourceUrl,
          license:item.license || cached.license || null,
          mainValidation:validation.mainValidation || null,
          validationRejected:true,
          failureCode:item.failureCode,
          lastValidatedAt:stamp,
        });
      }
      results.push({
        refNumber:item.refNumber,
        ok:false,
        status:item.status,
        failureCode:item.failureCode,
        pageCount:validation.pageCount,
        expectedPageCount:validation.expectedPageCount,
      });
      continue;
    }
    const stats = await fs.stat(filePath).catch(() => null);
    item.failureCode = null;
    item.status = item.revalidationPreviousStatus
      || (item.knownOa ? STATUS.READY_OA : mainSuccessStatus(candidate, job.vpnAtStart || {}));
    item.fileName = fileName;
    item.previewFileName = null;
    item.documentVersion = validation.documentVersion;
    item.documentFormat = candidate.documentFormat;
    item.originalSourceUrl = item.originalSourceUrl || item.downloadUrl || null;
    item.firstSavedAt = item.firstSavedAt || stats?.birthtime?.toISOString?.() || item.finishedAt || job.createdAt || stamp;
    item.pageCount = validation.pageCount;
    item.size = buffer.length;
    item.sha256 = fileHash;
    item.message = '既有主文已通過 DOI 身分與全文完整性重驗證。';
    const cached = await readJson(cacheMeta(item.doi));
    if (cached?.sha256 === fileHash) {
      await writeJson(cacheMeta(item.doi), {
        ...cached,
        sourceProvider:item.sourceProvider,
        sourceUrl:item.originalSourceUrl || item.downloadUrl || cached.sourceUrl,
        license:item.license || cached.license || null,
        documentVersion:item.documentVersion,
        documentFormat:item.documentFormat,
        mainValidation:item.mainValidation,
        validationRejected:false,
        failureCode:null,
        firstSavedAt:cached.firstSavedAt || cached.savedAt || item.firstSavedAt,
        lastValidatedAt:stamp,
      });
    }
    results.push({
      refNumber:item.refNumber,
      ok:true,
      pageCount:validation.pageCount,
      documentVersion:validation.documentVersion,
    });
  }
  job.retrievalMode = 'main_only';
  job.includeSupplements = false;
  job.revalidatedAt = stamp;
  job.revalidation = {
    checked:results.length,
    accepted:results.filter((entry) => entry.ok).length,
    rejected:results.filter((entry) => !entry.ok).length,
    results,
  };
  job.summary = jobSummary(job.items, { includeSupplements:false });
  job.updatedAt = stamp;
  await saveJob(job);
  await writeJobReport(job);
  return job;
}

async function executeJob(jobId, { retryOnly = false, retryScope = 'main_failed', endpoints = {} } = {}) {
  if (runningJobs.has(jobId)) return;
  runningJobs.add(jobId);
  try {
    const job = await getJob(jobId);
    if (!job) return;
    const normalizedRetryScope = normalizeRetryScope(retryScope);
    const storedMode = normalizeRetrievalMode(job.retrievalMode
      ? { retrievalMode:job.retrievalMode }
      : { includeSupplements:job.includeSupplements !== false });
    job.retrievalMode = storedMode.retrievalMode;
    job.includeSupplements = storedMode.includeSupplements;
    const { email } = await getSettings();
    const vpn = await getVpnStatus();
    job.state = 'running';
    job.vpnAtStart = vpn;
    job.message = vpn.connected ? `已偵測校內 IP ${vpn.campusAddress}` : '未偵測校內 IP；仍會先嘗試 OA 來源。';
    job.updatedAt = new Date().toISOString();
    await saveJob(job);
    const retryOptions = {
      retryOnly, includeSupplements:job.includeSupplements, retryScope:normalizedRetryScope,
    };
    const targets = job.items.filter((item) => retryModeForItem(item, retryOptions));
    await mapLimit(targets, 3, async (item) => {
      const retryMode = retryModeForItem(item, retryOptions);
      if (retryMode === 'main') item.status = STATUS.PENDING;
      else item.siStatus = SI_STATUS.PENDING;
      item.startedAt = new Date().toISOString();
      await saveJob(job);
      if (retryMode === 'si_only') {
        const discovery = await findCandidates(item.doi, email, endpoints, job.includeSupplements);
        await finishReference(item, job, email, discovery);
      } else {
        await collectReference(item, job, email, vpn, endpoints, {
          includeSupplements:shouldCollectSupplementsWithMain({ ...retryOptions, item }),
        });
      }
      if (item.status === STATUS.OA_DOWNLOAD_FAILED && !item.message) {
        item.message = `API metadata 顯示此文為 OA，但自動下載尚未成功。${item.missingApis?.length ? ` 建議設定 ${item.missingApis.join('、')} 後重試。` : ''}`;
      } else if (item.missingApis?.length && !SUCCESS_STATUSES.has(item.status) && item.status !== STATUS.NON_ARTICLE) {
        item.message = `${item.message || '尚未取得有效 PDF。'} 建議設定：${item.missingApis.join('、')}。`;
      }
      item.finishedAt = new Date().toISOString();
      job.siIgnoredCandidates = job.items.flatMap((current) => (current.siIgnoredCandidates || []).map((ignored) => ({ refNumber:current.refNumber, ...ignored })));
      job.summary = jobSummary(job.items, { includeSupplements: job.includeSupplements });
      job.updatedAt = new Date().toISOString();
      await saveJob(job);
      await writeJobReport(job);
    });
    job.summary = jobSummary(job.items, { includeSupplements: job.includeSupplements });
    job.state = 'completed';
    const mainMessage = job.summary.allCollected ? '主文 PDF 全部蒐集到' : `主文 PDF 已取得 ${job.summary.collected}/${job.summary.selected}；${job.summary.locked} 筆仍鎖定或無法解析。`;
    const siMessage = job.includeSupplements
      ? ` 含 SI 的 reference ${job.summary.siRefsCollected} 篇，共 ${job.summary.siFilesCollected} 份 SI；SI 待處理 ${job.summary.siFailedRefs} 篇（已確認需瀏覽器 ${job.summary.siManualRefs || 0} 篇、discovery 受阻 ${job.summary.siDiscoveryBlockedRefs || 0} 篇）。`
      : '';
    job.message = `${mainMessage}${siMessage}`;
    job.updatedAt = new Date().toISOString();
    await saveJob(job);
    await writeJobReport(job);
  } catch (error) {
    const job = await getJob(jobId);
    if (job) {
      job.state = 'failed';
      job.message = error.message;
      job.updatedAt = new Date().toISOString();
      await saveJob(job);
      await writeJobReport(job).catch(() => {});
    }
  } finally {
    runningJobs.delete(jobId);
  }
}

export async function createCollectionJob(sourceId, refSpec, options = {}) {
  const source = await getSource(sourceId);
  if (!source) throw new Error('找不到來源論文');
  const numbers = selectReferenceNumbers(refSpec, source.references);
  const byNumber = new Map(source.references.map((reference) => [reference.refNumber, reference]));
  const { retrievalMode, includeSupplements } = normalizeRetrievalMode(options);
  const id = options.id || `job_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
  const items = numbers.map((refNumber) => ({
    ...(byNumber.get(refNumber) || { refNumber, rawCitation: '', parseMethod: 'missing' }),
    status: byNumber.has(refNumber) ? STATUS.PENDING : STATUS.UNRESOLVED,
    message: byNumber.has(refNumber) ? '等待蒐集' : '來源中缺少此 ref 編號。',
    siStatus: includeSupplements ? SI_STATUS.PENDING : SI_STATUS.NOT_REQUESTED,
    siFiles: [],
  }));
  const job = {
    id, sourceId, refSpec: String(refSpec || '全部'), selectedNumbers: numbers, state: 'queued',
    retrievalMode, includeSupplements, siIgnoredCandidates:[], summary: jobSummary(items, { includeSupplements }), items,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await saveJob(job);
  await writeJobReport(job);
  setImmediate(() => executeJob(id, { endpoints: options.endpoints }));
  return job;
}

export async function retryJob(jobId, options = {}) {
  const job = await getJob(jobId);
  if (!job) throw new Error('找不到工作');
  if (runningJobs.has(jobId)) throw new Error('工作仍在執行中');
  const scope = normalizeRetryScope(options.scope);
  const storedMode = normalizeRetrievalMode(job.retrievalMode
    ? { retrievalMode:job.retrievalMode }
    : { includeSupplements:job.includeSupplements !== false });
  job.retrievalMode = storedMode.retrievalMode;
  job.includeSupplements = storedMode.includeSupplements;
  job.state = 'queued';
  job.lastRetryScope = scope;
  job.message = scope === 'main_failed'
    ? '已排入主文失敗項目重試'
    : scope === 'si_failed' ? '已排入 SI 失敗項目重試' : '已排入所有失敗項目重試';
  await saveJob(job);
  setImmediate(() => executeJob(jobId, { retryOnly: true, retryScope:scope, endpoints: options.endpoints }));
  return job;
}

export function isJobRunning(jobId) { return runningJobs.has(jobId); }
