import * as cheerio from 'cheerio';
import { BROWSER_PROFILE_DIR, PLAYWRIGHT_BROWSERS_DIR } from './constants.js';
import { ensureDir } from './utils.js';

let interactiveContext = null;

function enabled(value) {
  return value === true || /^(?:1|true|yes|on)$/i.test(String(value || ''));
}

export function browserFallbackConfigured(credentials = {}) {
  return enabled(credentials.browserFallbackEnabled);
}

export function selectBrowserPdfLink(html, baseUrl) {
  const $ = cheerio.load(String(html || ''));
  const values = [
    $('meta[name="citation_pdf_url"]').attr('content'),
    $('meta[name="pdf_url"]').attr('content'),
    $('link[type="application/pdf"]').attr('href'),
    $('a[href*="/pdf/"]').first().attr('href'),
    $('a[href*="/epdf/"]').first().attr('href'),
    $('a[href$=".pdf"]').first().attr('href'),
  ].filter(Boolean);
  for (const value of values) {
    try {
      const url = new URL(value, baseUrl);
      if (['http:', 'https:'].includes(url.protocol)) return url.href;
    } catch { /* ignore malformed publisher markup */ }
  }
  return null;
}

async function playwrightChromium() {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= PLAYWRIGHT_BROWSERS_DIR;
  const { chromium } = await import('playwright');
  return chromium;
}

export async function openInteractiveBrowser(url, options = {}) {
  if (!browserFallbackConfigured({ browserFallbackEnabled:options.enabled })) {
    throw new Error('瀏覽器最後備援未啟用；請先設定 BROWSER_FALLBACK_ENABLED=true');
  }
  if (interactiveContext) {
    const page = await interactiveContext.newPage();
    await page.goto(url, { waitUntil:'domcontentloaded', timeout:options.timeoutMs || 60000 });
    return { opened:true, reused:true, profileDir:BROWSER_PROFILE_DIR };
  }
  await ensureDir(BROWSER_PROFILE_DIR);
  const chromium = await playwrightChromium();
  interactiveContext = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless:false,
    acceptDownloads:true,
    viewport:null,
  });
  interactiveContext.once('close', () => { interactiveContext = null; });
  const page = interactiveContext.pages()[0] || await interactiveContext.newPage();
  await page.goto(url, { waitUntil:'domcontentloaded', timeout:options.timeoutMs || 60000 });
  return { opened:true, reused:false, profileDir:BROWSER_PROFILE_DIR };
}

async function responsePdf(response) {
  if (!response) return null;
  const type = String(response.headers()['content-type'] || '').toLowerCase();
  if (!response.ok() || !type.includes('pdf')) return null;
  const buffer = Buffer.from(await response.body());
  if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return null;
  return { buffer, finalUrl:response.url(), contentType:type, httpStatus:response.status() };
}

export async function downloadWithAuthenticatedBrowser(url, options = {}) {
  if (!browserFallbackConfigured({ browserFallbackEnabled:options.enabled })) {
    return { ok:false, failureCode:'BROWSER_FALLBACK_DISABLED', error:'瀏覽器最後備援未啟用' };
  }
  await ensureDir(BROWSER_PROFILE_DIR);
  const chromium = await playwrightChromium();
  const ownsContext = !interactiveContext;
  const context = interactiveContext || await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless:options.headless ?? true,
    acceptDownloads:true,
  });
  try {
    const page = await context.newPage();
    try {
      const first = await page.goto(url, { waitUntil:'domcontentloaded', timeout:options.timeoutMs || 60000 });
      const direct = await responsePdf(first);
      if (direct) return { ok:true, ...direct };
      const html = await page.content();
      if (/hcaptcha|g-recaptcha|cf-chl-|verify you are human|just a moment/i.test(html)) {
        return { ok:false, failureCode:'PUBLISHER_AUTOMATION_BLOCKED', error:'頁面要求 CAPTCHA／Cloudflare 互動驗證' };
      }
      if (/institutional login|single sign.on|shibboleth|>\s*(?:sign in|log in)\s*</i.test(html)) {
        return { ok:false, failureCode:'AUTH_NETWORK_MISMATCH', error:'專用瀏覽器 profile 尚未完成出版社／機構登入' };
      }
      const pdfUrl = selectBrowserPdfLink(html, page.url());
      if (!pdfUrl) return { ok:false, failureCode:'REPOSITORY_METADATA_ONLY', error:'已登入頁面沒有可辨識的 PDF 連結' };
      const response = await page.goto(pdfUrl, { waitUntil:'commit', timeout:options.timeoutMs || 60000 });
      const pdf = await responsePdf(response);
      return pdf
        ? { ok:true, ...pdf }
        : { ok:false, failureCode:'PUBLISHER_AUTOMATION_BLOCKED', error:'PDF 導航未回傳可驗證 PDF' };
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    if (ownsContext) await context.close().catch(() => {});
  }
}

export async function closeInteractiveBrowser() {
  if (!interactiveContext) return false;
  const context = interactiveContext;
  interactiveContext = null;
  await context.close().catch(() => {});
  return true;
}
