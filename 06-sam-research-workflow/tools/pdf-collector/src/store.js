import fs from 'node:fs/promises';
import path from 'node:path';
import { CACHE_DIR, CONFIG_DIR, DATA_DIR, JOBS_DIR, LOCAL_CONFIG, SOURCES_DIR, TMP_DIR } from './constants.js';
import { cleanupAtomicTemps, ensureDir, readJson, writeJson } from './utils.js';

export async function initializeStore() {
  await Promise.all([DATA_DIR, SOURCES_DIR, JOBS_DIR, CACHE_DIR, TMP_DIR, CONFIG_DIR].map(ensureDir));
}

export async function getSettings() {
  return readJson(LOCAL_CONFIG, { email: '' });
}

export async function saveSettings(settings) {
  const email = String(settings?.email || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('聯絡 email 格式不正確');
  const value = { email, updatedAt: new Date().toISOString() };
  await writeJson(LOCAL_CONFIG, value);
  return value;
}

export function sourceDir(id) { return path.join(SOURCES_DIR, id); }
export function sourceManifest(id) { return path.join(sourceDir(id), 'source.json'); }
export function jobDir(id) { return path.join(JOBS_DIR, id); }
export function jobManifest(id) { return path.join(jobDir(id), 'manifest.json'); }

export async function saveSource(source) {
  await ensureDir(sourceDir(source.id));
  await writeJson(sourceManifest(source.id), source);
  return source;
}

export async function getSource(id) {
  return readJson(sourceManifest(id));
}

export async function saveJob(job) {
  await ensureDir(jobDir(job.id));
  await Promise.all([
    ensureDir(path.join(jobDir(job.id), 'pdfs')),
    ensureDir(path.join(jobDir(job.id), 'supplements')),
    ensureDir(path.join(jobDir(job.id), 'previews')),
    ensureDir(path.join(jobDir(job.id), 'source_documents')),
  ]);
  await writeJson(jobManifest(job.id), job);
  return job;
}

export async function getJob(id) {
  return readJson(jobManifest(id));
}

export async function listJobs() {
  const entries = await fs.readdir(JOBS_DIR, { withFileTypes: true }).catch(() => []);
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const job = await getJob(entry.name).catch(() => null);
    if (!job) continue;
    jobs.push({
      id: job.id,
      sourceId: job.sourceId,
      refSpec: job.refSpec,
      state: job.state,
      summary: job.summary,
      message: job.message,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  }
  return jobs.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}

export async function deleteJob(id) {
  const dir = jobDir(id);
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(JOBS_DIR) + path.sep)) throw new Error('不安全的工作路徑');
  await fs.rm(resolved, { recursive: true, force: true });
}

export async function clearCache() {
  const resolved = path.resolve(CACHE_DIR);
  if (resolved !== path.resolve(DATA_DIR, 'cache')) throw new Error('不安全的快取路徑');
  await fs.rm(resolved, { recursive: true, force: true });
  await ensureDir(resolved);
}

export async function recoverJobs() {
  const entries = await fs.readdir(JOBS_DIR, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await cleanupAtomicTemps(jobDir(entry.name));
    const job = await getJob(entry.name);
    if (job?.state === 'running') {
      job.state = 'interrupted';
      job.message = '程式上次執行中斷，可按「重試鎖定項目」繼續。';
      job.updatedAt = new Date().toISOString();
      await saveJob(job);
    }
  }
}
