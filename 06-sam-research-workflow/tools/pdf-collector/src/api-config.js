import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './constants.js';
import { fetchWithPolicy } from './http.js';
import { parsePdfBuffer } from './pdf.js';

export const ENV_FILE = path.join(ROOT, '.env');

export const API_SERVICES = Object.freeze([
  {
    id: 'crossref', name: 'Crossref', envVars: [], required: true,
    purpose: 'DOI、題名與 reference 書目配對（公開 API，不需金鑰）',
    applyUrl: 'https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/',
  },
  {
    id: 'unpaywall', name: 'Unpaywall', envVars: [], required: true,
    purpose: '辨識 OA 狀態與公開全文位置（使用首頁聯絡 email）',
    applyUrl: 'https://unpaywall.org/products/api',
  },
  {
    id: 'openalex', name: 'OpenAlex', envVars: ['OPENALEX_API_KEY'], required: true,
    purpose: 'OA 位置與 OpenAlex Content 快取 PDF；最優先建議申請',
    applyUrl: 'https://openalex.org/settings/api',
  },
  {
    id: 'core', name: 'CORE', envVars: ['CORE_API_KEY'], required: false,
    purpose: '搜尋機構典藏與作者接受稿 PDF',
    applyUrl: 'https://core.ac.uk/services/api',
  },
  {
    id: 'openaire', name: 'OpenAIRE', envVars: [], required: false,
    purpose: '以 DOI 尋找機構典藏與作者接受稿；匿名額度足以處理小批次',
    applyUrl: 'https://graph.openaire.eu/docs/apis/graph-api/overview/',
  },
  {
    id: 'semantic_scholar', name: 'Semantic Scholar', envVars: ['SEMANTIC_SCHOLAR_API_KEY'], required: false,
    purpose: '補充 DOI 對應的公開 PDF 網址；無金鑰仍可低速使用',
    applyUrl: 'https://www.semanticscholar.org/product/api',
  },
  {
    id: 'wiley', name: 'Wiley TDM', envVars: ['WILEY_TDM_CLIENT_TOKEN'], required: false,
    purpose: '透過 Wiley 官方 TDM API 下載 Wiley PDF',
    applyUrl: 'https://onlinelibrary.wiley.com/library-info/resources/text-and-datamining',
  },
  {
    id: 'elsevier', name: 'Elsevier', envVars: ['ELSEVIER_API_KEY'],
    optionalEnvVars: ['ELSEVIER_INST_TOKEN', 'ELSEVIER_ENTITLEMENT_TEST_DOI'], required: false,
    purpose: '透過 Article Retrieval API 下載 Elsevier PDF；API key 與全文權限會分開檢查',
    applyUrl: 'https://dev.elsevier.com/api_key_settings.html',
  },
  {
    id: 'springer_nature', name: 'Springer Nature Full Text', envVars: ['SPRINGER_NATURE_API_KEY'], required: false,
    purpose: '透過 Springer Nature 官方 API 取得 OA 或已授權全文',
    applyUrl: 'https://dev.springernature.com/docs/api-endpoints/fulltext-api/',
  },
  {
    id: 'libkey', name: 'LibKey', envVars: ['LIBKEY_LIBRARY_ID', 'LIBKEY_API_KEY'], required: false,
    purpose: '使用圖書館授權的 DOI direct-to-PDF；需先確認 NTNU 是否訂購',
    applyUrl: 'https://support.thirdiron.com/support/solutions/articles/72000570248-libkey-link-technical-faq',
  },
  {
    id: 'getftr', name: 'GetFTR', envVars: ['GETFTR_API_KEY'], required: false,
    purpose: '查詢 DOI entitlement 與 smart link；不把 smart link 誤當成背景保存授權',
    applyUrl: 'https://docs.getfulltextresearch.com/latest/integrators/endpoints',
  },
  {
    id: 'browser_fallback', name: '瀏覽器最後備援', envVars: ['BROWSER_FALLBACK_ENABLED'], required: false,
    purpose: '只對指定失敗項目使用專案內 persistent profile；不繞過 CAPTCHA',
    applyUrl: 'https://playwright.dev/docs/auth',
  },
]);

function parseEnv(text) {
  const values = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

export function getApiCredentials() {
  let fileValues = {};
  try { fileValues = parseEnv(fs.readFileSync(ENV_FILE, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const value = (name) => String(process.env[name] || fileValues[name] || '').trim();
  return {
    openAlexApiKey: value('OPENALEX_API_KEY'),
    coreApiKey: value('CORE_API_KEY'),
    semanticScholarApiKey: value('SEMANTIC_SCHOLAR_API_KEY'),
    wileyTdmClientToken: value('WILEY_TDM_CLIENT_TOKEN'),
    elsevierApiKey: value('ELSEVIER_API_KEY'),
    elsevierInstToken: value('ELSEVIER_INST_TOKEN'),
    elsevierEntitlementTestDoi: value('ELSEVIER_ENTITLEMENT_TEST_DOI'),
    springerNatureApiKey: value('SPRINGER_NATURE_API_KEY'),
    libkeyLibraryId: value('LIBKEY_LIBRARY_ID'),
    libkeyApiKey: value('LIBKEY_API_KEY'),
    getftrApiKey: value('GETFTR_API_KEY'),
    browserFallbackEnabled: /^(?:1|true|yes|on)$/i.test(value('BROWSER_FALLBACK_ENABLED')),
  };
}

function configuredFor(service, credentials) {
  const mapping = {
    OPENALEX_API_KEY: credentials.openAlexApiKey,
    CORE_API_KEY: credentials.coreApiKey,
    SEMANTIC_SCHOLAR_API_KEY: credentials.semanticScholarApiKey,
    WILEY_TDM_CLIENT_TOKEN: credentials.wileyTdmClientToken,
    ELSEVIER_API_KEY: credentials.elsevierApiKey,
    ELSEVIER_INST_TOKEN: credentials.elsevierInstToken,
    ELSEVIER_ENTITLEMENT_TEST_DOI: credentials.elsevierEntitlementTestDoi,
    SPRINGER_NATURE_API_KEY: credentials.springerNatureApiKey,
    LIBKEY_LIBRARY_ID: credentials.libkeyLibraryId,
    LIBKEY_API_KEY: credentials.libkeyApiKey,
    GETFTR_API_KEY: credentials.getftrApiKey,
    BROWSER_FALLBACK_ENABLED: credentials.browserFallbackEnabled,
  };
  return (service.envVars || []).every((name) => Boolean(mapping[name]));
}

export function publicApiConfiguration({ email = '' } = {}) {
  const credentials = getApiCredentials();
  return API_SERVICES.map((service) => {
    const configured = service.envVars.length ? configuredFor(service, credentials) : (service.id !== 'unpaywall' || Boolean(email));
    const anonymous = service.id === 'semantic_scholar' && !configured;
    return {
      ...service,
      configured,
      status: configured ? 'configured' : anonymous ? 'anonymous' : 'missing',
      message: configured
        ? '已設定，尚未驗證'
        : anonymous
          ? '未設定金鑰；仍可匿名低速查詢，建議申請'
          : service.envVars.length ? `請在 .env 設定 ${service.envVars.join('、')}` : '請先在首頁儲存聯絡 email',
    };
  });
}

function healthResult(service, status, message, extra = {}) {
  return { ...service, status, message, checkedAt: new Date().toISOString(), ...extra };
}

async function checkJson(url, options = {}) {
  const response = await fetchWithPolicy(url, { timeoutMs: 20000, retries: 0, accept: 'application/json', ...options });
  let body = null;
  try { body = JSON.parse(response.buffer.toString('utf8')); } catch { /* HTTP status is sufficient for the health result. */ }
  return { response, body };
}

function elsevierHeaders(credentials, suffix = '') {
  const headers = {
    'X-ELS-APIKey': credentials.elsevierApiKey,
    'X-ELS-ReqId': `sam-collector-${Date.now()}-${suffix || 'health'}`,
  };
  if (credentials.elsevierInstToken) headers['X-ELS-Insttoken'] = credentials.elsevierInstToken;
  return headers;
}

function elsevierResponseEvidence(response = {}) {
  const headers = response.headers || {};
  return {
    requestId:headers['x-els-reqid'] || headers['x-request-id'] || null,
    rateLimitRemaining:headers['x-ratelimit-remaining'] || null,
    rateLimitReset:headers['x-ratelimit-reset'] || null,
  };
}

export async function checkElsevierCapabilities(credentials, options = {}) {
  const testDoi = String(options.testDoi || credentials.elsevierEntitlementTestDoi || '').trim().toLowerCase();
  const capabilities = {
    metadata: false,
    fullView: false,
    entitlementApi: false,
    entitled: null,
    pdfMime: false,
    completePdf: false,
    institutionAuthenticated: Boolean(credentials.elsevierInstToken),
    instTokenConfigured: Boolean(credentials.elsevierInstToken),
    testDoi: testDoi || null,
  };
  const controlDoi = testDoi || '10.1016/j.esci.2024.100329';
  const metadata = await fetchWithPolicy(
    `https://api.elsevier.com/content/article/doi/${encodeURIComponent(controlDoi)}?view=META_ABS&httpAccept=application%2Fjson`,
    { timeoutMs:20000, retries:0, accept:'application/json', headers:elsevierHeaders(credentials, 'metadata') },
  );
  capabilities.metadata = metadata.ok;
  if (!metadata.ok) {
    return {
      capabilities,
      metadataStatus:metadata.status,
      requestEvidence:{ metadata:elsevierResponseEvidence(metadata) },
    };
  }
  if (!testDoi) {
    return {
      capabilities,
      metadataStatus:metadata.status,
      requestEvidence:{ metadata:elsevierResponseEvidence(metadata) },
      unverified:true,
    };
  }

  const [entitlement, fullXml, pdf] = await Promise.all([
    fetchWithPolicy(
      `https://api.elsevier.com/content/article/entitlement/doi/${encodeURIComponent(testDoi)}?httpAccept=text%2Fxml`,
      { timeoutMs:20000, retries:0, accept:'text/xml,application/xml;q=0.9', headers:elsevierHeaders(credentials, 'entitlement') },
    ).catch((error) => ({ ok:false, status:0, buffer:Buffer.from(error.message) })),
    fetchWithPolicy(
      `https://api.elsevier.com/content/article/doi/${encodeURIComponent(testDoi)}?view=FULL&httpAccept=text%2Fxml`,
      { timeoutMs:30000, retries:0, accept:'text/xml,application/xml;q=0.9', headers:elsevierHeaders(credentials, 'full-xml') },
    ).catch((error) => ({ ok:false, status:0, buffer:Buffer.from(error.message) })),
    fetchWithPolicy(
      `https://api.elsevier.com/content/article/doi/${encodeURIComponent(testDoi)}?amsRedirect=true&httpAccept=application%2Fpdf`,
      { timeoutMs:30000, retries:0, accept:'application/pdf,*/*;q=0.2', headers:elsevierHeaders(credentials, 'pdf') },
    ).catch((error) => ({ ok:false, status:0, headers:{}, buffer:Buffer.from(error.message) })),
  ]);

  const entitlementText = entitlement.buffer.toString('utf8');
  capabilities.entitlementApi = entitlement.ok;
  capabilities.entitled = entitlement.ok
    ? /(?:<[^>]*(?:entitled|entitlement)[^>]*>\s*(?:true|yes|1)\s*<)|(?:"entitled"\s*:\s*true)/i.test(entitlementText)
    : null;
  capabilities.institutionAuthenticated = capabilities.institutionAuthenticated || entitlement.ok;

  const xmlText = fullXml.buffer.toString('utf8');
  capabilities.fullView = fullXml.ok
    && /<(?:xocs:doc|ce:sections?|ce:section|ce:para)\b/i.test(xmlText)
    && /<(?:ce:bib-reference|ce:reference|ce:bibliography)\b/i.test(xmlText);

  const pdfType = String(pdf.headers?.['content-type'] || '').toLowerCase();
  capabilities.pdfMime = pdf.ok && (pdfType.includes('pdf') || pdf.buffer.subarray(0, 1024).includes(Buffer.from('%PDF-')));
  if (capabilities.pdfMime) {
    try {
      const parsed = await parsePdfBuffer(pdf.buffer);
      capabilities.pdfPageCount = parsed.pageCount;
      capabilities.completePdf = parsed.pageCount > 1;
    } catch {
      capabilities.completePdf = false;
    }
  }
  return {
    capabilities,
    metadataStatus:metadata.status,
    entitlementStatus:entitlement.status,
    fullViewStatus:fullXml.status,
    pdfStatus:pdf.status,
    requestEvidence:{
      metadata:elsevierResponseEvidence(metadata),
      entitlement:elsevierResponseEvidence(entitlement),
      fullView:elsevierResponseEvidence(fullXml),
      pdf:elsevierResponseEvidence(pdf),
    },
  };
}

export async function checkApiServices({ email = '' } = {}) {
  const credentials = getApiCredentials();
  const configured = publicApiConfiguration({ email });
  return Promise.all(configured.map(async (service) => {
    if (service.status === 'missing') return healthResult(service, 'missing', service.message);
    try {
      if (service.id === 'crossref') {
        const { response } = await checkJson(`https://api.crossref.org/works?rows=0${email ? `&mailto=${encodeURIComponent(email)}` : ''}`, { email });
        return healthResult(service, response.ok ? 'available' : 'invalid', response.ok ? '公開 API 可用' : `HTTP ${response.status}`);
      }
      if (service.id === 'unpaywall') {
        const { response } = await checkJson(`https://api.unpaywall.org/v2/10.1038/nature12373?email=${encodeURIComponent(email)}`, { email });
        return healthResult(service, response.ok ? 'available' : 'invalid', response.ok ? 'API 可用' : `HTTP ${response.status}`);
      }
      if (service.id === 'openalex') {
        const { response } = await checkJson(`https://api.openalex.org/works/doi:10.7717/peerj.4375?select=id&api_key=${encodeURIComponent(credentials.openAlexApiKey)}`);
        return healthResult(service, response.ok ? 'available' : 'invalid', response.ok ? 'API key 可用；可使用 Content PDF' : `API key 驗證失敗（HTTP ${response.status}）`);
      }
      if (service.id === 'core') {
        const { response } = await checkJson('https://api.core.ac.uk/v3/search/works?q=doi%3A10.7717%2Fpeerj.4375&limit=1', { headers: { Authorization: `Bearer ${credentials.coreApiKey}` } });
        return healthResult(service, response.ok ? 'available' : 'invalid', response.ok ? 'API key 可用' : `API key 驗證失敗（HTTP ${response.status}）`);
      }
      if (service.id === 'openaire') {
        const { response } = await checkJson('https://api.openaire.eu/search/publications?doi=10.7717%2Fpeerj.4375&format=json&size=1');
        return healthResult(service, response.ok ? 'available' : 'unavailable', response.ok ? '匿名 API 可用' : `HTTP ${response.status}`);
      }
      if (service.id === 'semantic_scholar') {
        const headers = credentials.semanticScholarApiKey ? { 'x-api-key': credentials.semanticScholarApiKey } : {};
        const { response } = await checkJson('https://api.semanticscholar.org/graph/v1/paper/DOI:10.7717/peerj.4375?fields=paperId,openAccessPdf', { headers });
        const suffix = credentials.semanticScholarApiKey ? 'API key 可用' : '匿名 API 可用；仍建議申請個人 key';
        return healthResult(service, response.ok ? 'available' : 'invalid', response.ok ? suffix : `API 無法使用（HTTP ${response.status}）`);
      }
      if (service.id === 'wiley') {
        const response = await fetchWithPolicy('https://api.wiley.com/onlinelibrary/tdm/v1/articles/10.1002%2Fidm2.12202', {
          timeoutMs: 30000, retries: 0, accept: 'application/pdf,*/*;q=0.5',
          headers: { 'Wiley-TDM-Client-Token': credentials.wileyTdmClientToken },
        });
        const isPdf = String(response.headers['content-type'] || '').toLowerCase().includes('pdf') || response.buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'));
        return healthResult(service, response.ok && isPdf ? 'available' : 'invalid', response.ok && isPdf ? 'TDM token 可下載測試 OA PDF' : `TDM token 無法使用（HTTP ${response.status}）`);
      }
      if (service.id === 'elsevier') {
        const result = await checkElsevierCapabilities(credentials);
        if (!result.capabilities.metadata) {
          return healthResult(service, 'invalid', `Elsevier API key／metadata 驗證失敗（HTTP ${result.metadataStatus || 0}）`, result);
        }
        if (result.unverified) {
          return healthResult(service, 'configured_unverified',
            'API key 可讀 metadata，但未設定 ELSEVIER_ENTITLEMENT_TEST_DOI；不能宣稱訂閱全文已啟用。', result);
        }
        if (result.capabilities.completePdf || result.capabilities.fullView) {
          return healthResult(service, 'available',
            `非 OA 測試文可取得${result.capabilities.completePdf ? '完整 PDF' : '完整結構化全文'}${result.capabilities.instTokenConfigured ? '；已設定 InstToken' : ''}`, result);
        }
        const code = [result.entitlementStatus, result.fullViewStatus].includes(401)
          ? 'Entitlement／FULL view 未對目前 key 啟用'
          : result.capabilities.pdfMime ? 'PDF MIME 可用，但只取得預覽' : 'PDF 全文格式未獲授權';
        return healthResult(service, 'permission_required',
          `${code}；請向 Elsevier API Support 確認 FULL Article Retrieval、PDF MIME 與機構 entitlement。`, result);
      }
      if (['springer_nature', 'libkey', 'getftr', 'browser_fallback'].includes(service.id)) {
        return healthResult(service, 'configured_unverified', '已設定；會在實際候選或明確手動操作時驗證');
      }
      return healthResult(service, 'unknown', '未執行檢查');
    } catch (error) {
      return healthResult(service, 'unavailable', `連線或驗證失敗：${error.message}`);
    }
  }));
}
