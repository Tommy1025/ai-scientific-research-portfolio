import { fetchWithPolicy } from './http.js';
import { normalizeDoi } from './utils.js';

const SPRINGER_NATURE_BASE = 'https://api.springernature.com';
const LIBKEY_BASE = 'https://public-api.thirdiron.com/public/v1';
const GETFTR_ENDPOINT = 'https://entitlements.prod.getft.io/v2.2/entitlements';
const ELSEVIER_ARTICLE_BASE = 'https://api.elsevier.com/content/article/doi';

const SMART_LINK_LIMITATION = Object.freeze({
  smartLink: true,
  backgroundDownloadGuaranteed: false,
  accessLimitation: '此網址是授權導向（smart link），可能轉往機構 IdP 或格式選擇頁；不保證可由背景程序直接儲存 PDF。',
});

function candidateUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function addUnique(list, value, extra) {
  const url = candidateUrl(value);
  if (!url || list.some((candidate) => candidate.url === url)) return;
  list.push({ url, ...extra });
}

function endpointUrl(value, fallback) {
  const url = new URL(String(value || fallback));
  if (url.protocol !== 'https:') throw new Error('授權型 provider endpoint 必須使用 HTTPS');
  return url;
}

function providerError(provider, response, publicUrl) {
  const status = Number(response?.status || 0);
  const error = new Error(`${provider} API 請求失敗${status ? `（HTTP ${status}）` : ''}`);
  error.provider = provider;
  error.providerUrl = publicUrl;
  error.providerCode = status ? `http_${status}` : 'request_failed';
  error.status = status;
  return error;
}

function responseJson(response, provider, publicUrl) {
  if (!response?.ok) throw providerError(provider, response, publicUrl);
  try {
    return JSON.parse(response.buffer.toString('utf8'));
  } catch {
    const error = new Error(`${provider} API 回傳的不是有效 JSON`);
    error.provider = provider;
    error.providerUrl = publicUrl;
    error.providerCode = 'invalid_json';
    throw error;
  }
}

/**
 * Springer Nature exposes complete JATS through two documented collections:
 * the licensed Full Text API and the Open Access API.  Both require the
 * Springer Nature API key in the query string.  `url` deliberately omits the
 * key; only `requestUrl` carries it.
 */
export function springerNatureStructuredCandidates(doi, credentials = {}, endpoints = {}) {
  const normalized = normalizeDoi(doi);
  const apiKey = String(credentials.springerNatureApiKey || credentials.apiKey || '').trim();
  if (!normalized || !apiKey) return [];

  const base = endpointUrl(endpoints.springerNature || endpoints.base, SPRINGER_NATURE_BASE);
  const definitions = [
    {
      path: '/xmldata/jats',
      source: 'Springer Nature Full Text API',
      access: 'licensed',
      license: null,
    },
    {
      path: '/openaccess/jats',
      source: 'Springer Nature Open Access API',
      access: 'oa',
      license: null,
      openAccessDeclared: true,
    },
  ];

  return definitions.map((definition) => {
    const publicUrl = new URL(definition.path, base);
    publicUrl.searchParams.set('q', `doi:${normalized}`);
    publicUrl.searchParams.set('p', '1');
    const requestUrl = new URL(publicUrl);
    requestUrl.searchParams.set('api_key', apiKey);
    return {
      url: publicUrl.href,
      requestUrl: requestUrl.href,
      source: definition.source,
      access: definition.access,
      apiService: 'springer_nature',
      structured: true,
      structuredFormat: 'jats',
      contentType: 'application/xml',
      documentVersion: 'vor',
      documentFormat: 'structured_fulltext',
      license: definition.license,
      openAccessDeclared: Boolean(definition.openAccessDeclared),
    };
  });
}

export function elsevierPdfArticleUrl(doi, endpoints = {}) {
  const normalized = normalizeDoi(doi);
  if (!normalized) return null;
  const base = endpointUrl(endpoints.elsevierArticle || endpoints.base, ELSEVIER_ARTICLE_BASE);
  const url = new URL(`${base.pathname.replace(/\/$/, '')}/${encodeURIComponent(normalized)}`, base);
  url.searchParams.set('amsRedirect', 'true');
  url.searchParams.set('httpAccept', 'application/pdf');
  return url.href;
}

/**
 * Construct Elsevier PDF and FULL XML candidates without performing a
 * network call.  Authentication is sent only in request headers.  The caller's
 * redirect policy must strip these headers when the origin changes.
 */
export function elsevierArticleCandidates(doi, credentials = {}, endpoints = {}, options = {}) {
  const normalized = normalizeDoi(doi);
  const apiKey = String(credentials.elsevierApiKey || credentials.apiKey || '').trim();
  // Elsevier's Article Retrieval API is not a cross-publisher resolver.
  // Restrict it to the Elsevier DOI prefix used by this corpus so an
  // Elsevier API key does not create noisy 404 traces for ACS/RSC/Wiley/etc.
  if (!normalized || !normalized.startsWith('10.1016/') || !apiKey) return [];
  const base = endpointUrl(endpoints.elsevierArticle || endpoints.base, ELSEVIER_ARTICLE_BASE);
  const articleUrl = new URL(`${base.pathname.replace(/\/$/, '')}/${encodeURIComponent(normalized)}`, base);
  const requestId = String(options.requestId || `sam-collector-${Date.now()}`);
  const headers = {
    'X-ELS-APIKey': apiKey,
    'X-ELS-ReqId': requestId,
  };
  const instToken = String(credentials.elsevierInstToken || '').trim();
  if (instToken) headers['X-ELS-Insttoken'] = instToken;

  const pdfUrl = new URL(articleUrl);
  pdfUrl.searchParams.set('amsRedirect', 'true');
  pdfUrl.searchParams.set('httpAccept', 'application/pdf');
  const xmlUrl = new URL(articleUrl);
  xmlUrl.searchParams.set('view', 'FULL');
  xmlUrl.searchParams.set('httpAccept', 'text/xml');

  return [
    {
      url: pdfUrl.href,
      requestUrl: pdfUrl.href,
      source: 'Elsevier Article Retrieval API PDF',
      access: 'licensed',
      apiService: 'elsevier',
      headers: { ...headers },
      contentType: 'application/pdf',
      documentVersion: 'vor',
      documentFormat: 'publisher_pdf',
      entitlementRequired: true,
    },
    {
      url: xmlUrl.href,
      requestUrl: xmlUrl.href,
      source: 'Elsevier Article Retrieval API FULL XML',
      access: 'licensed',
      apiService: 'elsevier',
      headers: { ...headers },
      structured: true,
      structuredFormat: 'elsevier_full_xml',
      contentType: 'text/xml',
      documentVersion: 'vor',
      documentFormat: 'structured_fulltext',
      entitlementRequired: true,
    },
  ];
}

export function candidatesFromLibKeyResponse(payload, doi = '') {
  const normalized = normalizeDoi(doi);
  const article = payload?.data;
  if (!article || (normalized && normalizeDoi(article.doi) !== normalized)) return [];
  const available = article.availableThroughBrowzine !== false;
  const access = article.openAccess ? 'oa' : available ? 'licensed' : 'unknown';
  const common = {
    access,
    apiService: 'libkey',
    documentVersion: 'vor',
    license: null,
    openAccessDeclared: Boolean(article.openAccess),
    entitlementEstablished: available,
    ...SMART_LINK_LIMITATION,
  };
  const candidates = [];

  if (available && article.fullTextFile) {
    addUnique(candidates, article.fullTextFile, {
      ...common,
      source: 'LibKey full-text smart link',
      expectedContentType: 'application/pdf',
      linkType: 'fullTextFile',
    });
  }
  if (available && article.contentLocation) {
    addUnique(candidates, article.contentLocation, {
      ...common,
      source: 'LibKey content-location smart link',
      landing: true,
      linkType: 'contentLocation',
    });
  }

  const best = article.bestIntegratorLink;
  if (best?.bestLink && !['fullTextFile', 'contentLocation'].includes(best.linkType)) {
    addUnique(candidates, best.bestLink, {
      ...common,
      source: 'LibKey best integrator link',
      landing: true,
      linkType: best.linkType || 'bestIntegratorLink',
    });
  }
  if (!candidates.length && article.linkResolverOpenUrl) {
    addUnique(candidates, article.linkResolverOpenUrl, {
      ...common,
      source: 'LibKey link resolver',
      landing: true,
      entitlementEstablished: false,
      linkType: 'linkResolverOpenUrl',
    });
  }
  return candidates;
}

/**
 * Look up one DOI through the documented LibKey Article DOI endpoint.
 * Authentication uses an Authorization header, keeping the key out of both
 * the public candidate URL and the request URL.
 */
export async function getLibKeyCandidates(doi, credentials = {}, options = {}) {
  const normalized = normalizeDoi(doi);
  const libraryId = String(credentials.libkeyLibraryId || credentials.libraryId || '').trim();
  const apiKey = String(credentials.libkeyApiKey || credentials.apiKey || '').trim();
  if (!normalized || !libraryId || !apiKey) return [];

  const base = endpointUrl(options.endpoints?.libkey || options.endpoint, LIBKEY_BASE);
  const publicUrl = new URL(
    `${base.pathname.replace(/\/$/, '')}/libraries/${encodeURIComponent(libraryId)}/articles/doi/${encodeURIComponent(normalized)}`,
    base,
  );
  const fetchImpl = options.fetchImpl || fetchWithPolicy;
  const response = await fetchImpl(publicUrl.href, {
    timeoutMs: options.timeoutMs || 30000,
    retries: options.retries ?? 0,
    accept: 'application/json',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return candidatesFromLibKeyResponse(responseJson(response, 'libkey', publicUrl.href), normalized);
}

function getFtrLicense(entitlement) {
  const license = Array.isArray(entitlement?.licenses) ? entitlement.licenses[0] : null;
  return license?.url || license?.type || null;
}

export function candidatesFromGetFtrResponse(payload, doi = '') {
  const normalized = normalizeDoi(doi);
  const entitlements = Array.isArray(payload?.entitlements) ? payload.entitlements : [];
  const candidates = [];
  for (const entitlement of entitlements) {
    if (normalized && normalizeDoi(entitlement?.doi) !== normalized) continue;
    const entitlementValue = String(entitlement?.entitled || '').toLowerCase();
    if (!['yes', 'maybe'].includes(entitlementValue)) continue;
    const access = ['open', 'free', 'permfree'].includes(String(entitlement.accessType || '').toLowerCase())
      ? 'oa'
      : 'licensed';
    const common = {
      access,
      apiService: 'getftr',
      entitlement: entitlementValue,
      entitlementSource: entitlement.source || null,
      entitlementEstablished: entitlementValue === 'yes',
      license: getFtrLicense(entitlement),
      ...SMART_LINK_LIMITATION,
    };

    for (const document of Array.isArray(entitlement.vor) ? entitlement.vor : []) {
      addUnique(candidates, document?.url, {
        ...common,
        source: 'GetFTR VoR smart link',
        contentType: document?.contentType || null,
        landing: document?.contentType !== 'application/pdf',
        documentVersion: 'vor',
      });
    }
    for (const document of Array.isArray(entitlement.av) ? entitlement.av : []) {
      addUnique(candidates, document?.url, {
        ...common,
        source: 'GetFTR alternative-version smart link',
        contentType: document?.contentType || null,
        landing: document?.contentType !== 'application/pdf',
        documentVersion: 'unknown',
        requiresVersionValidation: true,
        versionEvidence: 'GetFTR av 只表示 alternative version，官方回應未保證它是 AAM。',
      });
    }
    addUnique(candidates, entitlement.document, {
      ...common,
      source: 'GetFTR document landing',
      landing: true,
      documentVersion: 'vor',
    });
  }
  return candidates;
}

/**
 * Query the GetFTR v2.2 Entitlements API.  Its current official contract uses
 * one API key in `x-api-key`; client-id/client-secret credentials are not
 * inferred or repurposed.
 */
export async function getGetFtrCandidates(doi, credentials = {}, options = {}) {
  const normalized = normalizeDoi(doi);
  const apiKey = String(credentials.getftrApiKey || credentials.apiKey || '').trim();
  if (!normalized || !apiKey) return [];
  const endpoint = endpointUrl(options.endpoints?.getftr || options.endpoint, GETFTR_ENDPOINT);
  const body = { dois: [normalized] };
  if (options.org && typeof options.org === 'object' && Object.keys(options.org).length) body.org = options.org;
  const fetchImpl = options.fetchImpl || fetchWithPolicy;
  const response = await fetchImpl(endpoint.href, {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: options.timeoutMs || 30000,
    retries: options.retries ?? 0,
    accept: 'application/json',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
  });
  return candidatesFromGetFtrResponse(responseJson(response, 'getftr', endpoint.href), normalized);
}
