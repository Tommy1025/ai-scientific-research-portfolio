import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const fileWriteQueues = new Map();
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function replaceFileWithRetry(tmp, file, options = {}) {
  const rename = options.rename || fs.rename;
  const wait = options.wait || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const maxAttempts = options.maxAttempts || 8;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await rename(tmp, file);
      return;
    } catch (error) {
      if (!TRANSIENT_RENAME_CODES.has(error.code) || attempt === maxAttempts - 1) throw error;
      await wait(Math.min(25 * (2 ** attempt), 1000));
    }
  }
}

function fileQueueKey(file) {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function enqueueFileWrite(file, task) {
  const key = fileQueueKey(file);
  const previous = fileWriteQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  fileWriteQueues.set(key, current);
  try {
    return await current;
  } finally {
    if (fileWriteQueues.get(key) === current) fileWriteQueues.delete(key);
  }
}

export async function writeFileAtomic(file, data, encoding = 'utf8') {
  const payload = Buffer.isBuffer(data) ? Buffer.from(data) : String(data);
  return enqueueFileWrite(file, async () => {
    await ensureDir(path.dirname(file));
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, payload, encoding);
      await replaceFileWithRetry(tmp, file);
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  });
}

export async function writeJson(file, value) {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  await writeFileAtomic(file, json, 'utf8');
}

export async function cleanupAtomicTemps(dir, options = {}) {
  const olderThanMs = options.olderThanMs ?? 60_000;
  const now = options.now ?? Date.now();
  const entries = await fs.readdir(dir, { withFileTypes:true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const candidates = entries
    .filter((entry) => entry.isFile() && /^.+\.\d+\.[0-9a-f]{8}\.tmp$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const stale = [];
  for (const name of candidates) {
    const stats = await fs.stat(path.join(dir, name)).catch(() => null);
    if (stats && now - stats.mtimeMs >= olderThanMs) stale.push(name);
  }
  await Promise.all(stale.map((name) => fs.unlink(path.join(dir, name)).catch(() => {})));
  return stale;
}

export function createId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix}_${stamp}_${crypto.randomBytes(4).toString('hex')}`;
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function safeFilename(value, max = 100) {
  return String(value || 'unknown')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max) || 'unknown';
}

export function normalizeDoi(input) {
  if (!input) return null;
  const decoded = (() => {
    try { return decodeURIComponent(String(input)); } catch { return String(input); }
  })();
  const match = decoded.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  if (!match) return null;
  return match[0].replace(/[\s\]>)}.,;]+$/g, '').toLowerCase();
}

export function extractDois(text) {
  let prepared = String(text || '')
    .replace(/\bdoi\.\s+org\//gi, 'doi.org/')
    .replace(/https?:\/\/\s+/gi, (value) => value.replace(/\s+/g, ''));
  // PDF 換行常把 DOI 拆在 `/`、`.` 或 `-` 後面。只在這些明確邊界移除空白，
  // 避免把 DOI 後方的一般句子一起吞入。
  let previous;
  do {
    previous = prepared;
    prepared = prepared.replace(/(10\.\d{4,9}\/[-._;()/:A-Z0-9]*[\/._-])\s+(?=[-._;()/:A-Z0-9])/gi, '$1');
  } while (prepared !== previous);
  const matches = prepared.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi) || [];
  return [...new Set(matches.map(normalizeDoi).filter(Boolean))];
}

export function parseRefSpec(spec, maxRef) {
  const raw = String(spec || '').trim();
  if (!Number.isInteger(maxRef) || maxRef < 1) throw new Error('尚未取得可選擇的 references');
  if (!raw || /^(all|全部)$/i.test(raw)) return Array.from({ length: maxRef }, (_, i) => i + 1);
  const selected = new Set();
  for (const token of raw.replace(/[～~]/g, '-').split(',').map((v) => v.trim()).filter(Boolean)) {
    if (/^\d+$/.test(token)) {
      selected.add(Number(token));
      continue;
    }
    const range = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!range) throw new Error(`無法辨識 ref 範圍：${token}`);
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (start > end) throw new Error(`ref 範圍起點大於終點：${token}`);
    for (let value = start; value <= end; value += 1) selected.add(value);
  }
  const result = [...selected].sort((a, b) => a - b);
  if (!result.length) throw new Error('請至少選擇一個 ref');
  if (result[0] < 1 || result.at(-1) > maxRef) throw new Error(`ref 必須介於 1-${maxRef}`);
  return result;
}

export function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isPrivateIp(ip) {
  if (!net.isIP(ip)) return false;
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('169.254.')) return true;
  const match172 = ip.match(/^172\.(\d+)\./);
  if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) return true;
  return ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:');
}

export async function validateExternalUrl(input, { allowPrivate = false } = {}) {
  let url;
  try { url = new URL(input); } catch { throw new Error('網址格式不正確'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只接受 http/https 論文網址');
  if (url.username || url.password) throw new Error('網址不可包含帳號或密碼');
  const host = url.hostname.toLowerCase();
  if (!allowPrivate && (host === 'localhost' || isPrivateIp(host))) throw new Error('不接受本機或私有網路網址');
  if (!allowPrivate) {
    const addresses = await dns.lookup(host, { all: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) throw new Error('網址解析至私有網路，已拒絕');
  }
  return url;
}

export async function mapLimit(values, limit, worker) {
  const results = new Array(values.length);
  let cursor = 0;
  async function run() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
  return results;
}

export class HostLimiter {
  #tails = new Map();

  async run(url, task) {
    const host = new URL(url).host;
    const previous = this.#tails.get(host) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => current);
    this.#tails.set(host, tail);
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      release();
      if (this.#tails.get(host) === tail) this.#tails.delete(host);
    }
  }
}
