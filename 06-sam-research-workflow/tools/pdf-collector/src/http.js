import { STATUS } from './constants.js';
import { sleep, validateExternalUrl } from './utils.js';

export function classifyHtml(text, statusCode = 200) {
  const sample = String(text || '').toLowerCase().slice(0, 200000);
  if (/cf-chl-|<title>\s*just a moment|cloudflare.*challenge/.test(sample)) return STATUS.PUBLISHER_BLOCKED;
  if (/hcaptcha|g-recaptcha|captcha-container|verify you are human|機器人驗證|人機驗證/.test(sample)) return STATUS.CAPTCHA;
  if (/sign in|log in|institutional login|single sign.on|shibboleth|登入|登錄|登入系統/.test(sample)) return STATUS.LOGIN_REQUIRED;
  if (/purchase|rent this article|subscribe to access|access denied|付費牆|購買此文章|訂閱/.test(sample)) return STATUS.PAYWALL;
  if (statusCode === 401) return STATUS.LOGIN_REQUIRED;
  if (statusCode === 402) return STATUS.PAYWALL;
  if (statusCode === 403) return STATUS.PUBLISHER_BLOCKED;
  return STATUS.INVALID_PDF;
}

export function classifyDownloadFailure(text, statusCode = 200, apiService = '') {
  const service = String(apiService || '').toLowerCase();
  const sample = String(text || '').toLowerCase().slice(0, 200000);
  if (service === 'elsevier' && [401, 403].includes(statusCode)) {
    if (/authentication_error|configuration settings.*insufficient|insufficient.*access to this resource/.test(sample) || statusCode === 403) {
      return STATUS.API_PERMISSION_REQUIRED;
    }
  }
  if (service === 'wiley' && [401, 403].includes(statusCode)) return STATUS.API_PERMISSION_REQUIRED;
  return classifyHtml(text, statusCode);
}

export async function fetchWithPolicy(input, options = {}) {
  const {
    email = '',
    timeoutMs = 30000,
    maxRedirects = 8,
    retries = 0,
    maxBytes = 120 * 1024 * 1024,
    allowPrivate = false,
    headers = {},
  } = options;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      let current = await validateExternalUrl(input, { allowPrivate });
      let requestHeaders = { ...headers };
      for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
        const response = await fetch(current, {
          method: options.method || 'GET',
          body: options.body,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            'User-Agent': `SAM-Reference-PDF-Collector/0.6 (${email || 'local-user'})`,
            Accept: options.accept || '*/*',
            ...requestHeaders,
          },
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) throw new Error('重新導向缺少 Location');
          const next = await validateExternalUrl(new URL(location, current).href, { allowPrivate });
          if (next.origin !== current.origin) {
            const sensitive = new Set([
              'authorization', 'proxy-authorization', 'cookie', 'cookie2',
              'wiley-tdm-client-token', 'x-els-apikey', 'x-els-insttoken', 'x-api-key',
            ]);
            requestHeaders = Object.fromEntries(Object.entries(requestHeaders)
              .filter(([name]) => !sensitive.has(name.toLowerCase())));
          }
          current = next;
          continue;
        }
        const contentLength = Number(response.headers.get('content-length') || 0);
        if (contentLength > maxBytes) {
          await response.body?.cancel().catch(() => {});
          throw new Error(`下載內容超過上限 ${Math.round(maxBytes / 1024 / 1024)} MB`);
        }
        const chunks = [];
        let total = 0;
        if (response.body) {
          const reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
              await reader.cancel().catch(() => {});
              throw new Error(`下載內容超過上限 ${Math.round(maxBytes / 1024 / 1024)} MB`);
            }
            chunks.push(Buffer.from(value));
          }
        }
        const buffer = Buffer.concat(chunks, total);
        return {
          status: response.status,
          ok: response.ok,
          finalUrl: current.href,
          headers: Object.fromEntries(response.headers.entries()),
          buffer,
        };
      }
      throw new Error(`重新導向超過 ${maxRedirects} 次`);
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(attempt === 0 ? 2000 : 5000);
    }
  }
  throw lastError;
}
