import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import express from 'express';
import multer from 'multer';
import { checkApiServices, getApiCredentials, publicApiConfiguration } from './src/api-config.js';
import { closeInteractiveBrowser, openInteractiveBrowser } from './src/browser-fallback.js';
import { filterSupplementArchiveEntries, mainArchiveFileNames } from './src/archive.js';
import {
  attachManualSupplement, createCollectionJob, isJobRunning, retryJob, retryMainWithBrowser,
} from './src/collector.js';
import { ROOT, TMP_DIR } from './src/constants.js';
import { fetchWithPolicy } from './src/http.js';
import { getVpnStatus } from './src/network.js';
import { createSourceFromUpload, createSourceFromUrl } from './src/source-service.js';
import {
  clearCache, deleteJob, getJob, getSettings, getSource, initializeStore, jobDir, listJobs,
  recoverJobs, saveJob, saveSettings,
} from './src/store.js';
import { validateExternalUrl } from './src/utils.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
await initializeStore();
await recoverJobs();

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => {
    const ok = file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf');
    callback(ok ? null : new Error('只接受 PDF 檔案'), ok);
  },
});

const supplementUpload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 120 * 1024 * 1024, files:1 },
  fileFilter: (_request, file, callback) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    const ok = ['.pdf', '.docx', '.doc'].includes(extension);
    callback(ok ? null : new Error('SI 人工上傳只接受 PDF、DOCX 或 legacy DOC'), ok);
  },
});

const app = express();
app.disable('x-powered-by');
app.use((request, response, next) => {
  const host = String(request.headers.host || '').toLowerCase();
  if (!host.match(/^(127\.0\.0\.1|localhost)(:\d+)?$/)) return response.status(403).json({ error: 'Host 不允許' });
  const origin = request.headers.origin;
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (!['127.0.0.1', 'localhost'].includes(originUrl.hostname)) return response.status(403).json({ error: 'Origin 不允許' });
    } catch { return response.status(403).json({ error: 'Origin 不正確' }); }
  }
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

app.get('/api/settings', async (_request, response) => response.json(await getSettings()));
app.put('/api/settings', async (request, response) => response.json(await saveSettings(request.body)));
app.get('/api/services', async (_request, response) => {
  const settings = await getSettings();
  response.json({ envFile: '.env', services: publicApiConfiguration({ email: settings.email }) });
});
app.post('/api/services/check', async (_request, response) => {
  const settings = await getSettings();
  response.json({ envFile: '.env', services: await checkApiServices({ email: settings.email }) });
});
app.get('/api/network', async (_request, response) => response.json(await getVpnStatus()));
app.post('/api/network/test', async (request, response) => {
  const url = (await validateExternalUrl(request.body?.url)).href;
  const settings = await getSettings();
  const result = await fetchWithPolicy(url, { email: settings.email, timeoutMs: 15000, maxRedirects: 5 });
  response.json({ ok: result.ok, status: result.status, finalUrl: result.finalUrl, contentType: result.headers['content-type'] || null });
});

app.post('/api/sources', upload.single('pdf'), async (request, response, next) => {
  try {
    const settings = await getSettings();
    if (!settings.email) throw new Error('第一次使用請先儲存聯絡 email');
    const type = request.body?.inputType;
    const source = type === 'upload'
      ? await createSourceFromUpload(request.file, settings.email)
      : type === 'url'
        ? await createSourceFromUrl(request.body?.url, settings.email)
        : (() => { throw new Error('輸入方式只能是上傳 PDF 或論文連結'); })();
    response.status(201).json(source);
  } catch (error) { next(error); }
  finally { if (request.file?.path) await fsPromises.unlink(request.file.path).catch(() => {}); }
});
app.get('/api/sources/:id', async (request, response) => {
  const source = await getSource(request.params.id);
  if (!source) return response.status(404).json({ error: '找不到來源論文' });
  response.json(source);
});

app.post('/api/jobs', async (request, response) => response.status(202).json(await createCollectionJob(
  request.body?.sourceId,
  request.body?.refSpec,
  {
    retrievalMode: request.body?.retrievalMode,
    includeSupplements: request.body?.includeSupplements,
  },
)));
app.get('/api/jobs', async (_request, response) => response.json(await listJobs()));
app.get('/api/jobs/:id', async (request, response) => {
  const job = await getJob(request.params.id);
  if (!job) return response.status(404).json({ error: '找不到工作' });
  const processActive = isJobRunning(job.id);
  if (job.state === 'running' && !processActive) {
    job.state = 'interrupted';
    job.message = '工作程序已停止，可按「重試鎖定項目」繼續。';
    job.updatedAt = new Date().toISOString();
    await saveJob(job);
  }
  response.json({ ...job, processActive });
});
app.post('/api/jobs/:id/retry', async (request, response) => response.status(202).json(await retryJob(
  request.params.id,
  { scope: request.body?.scope },
)));
app.post('/api/browser/open', async (request, response) => {
  const url = (await validateExternalUrl(request.body?.url)).href;
  const credentials = getApiCredentials();
  response.json(await openInteractiveBrowser(url, { enabled:credentials.browserFallbackEnabled }));
});
app.post('/api/browser/close', async (_request, response) => {
  response.json({ closed:await closeInteractiveBrowser() });
});
app.post('/api/jobs/:id/items/:refNumber/browser-retry', async (request, response) => {
  const target = request.body?.url
    ? (await validateExternalUrl(request.body.url)).href
    : undefined;
  response.json(await retryMainWithBrowser(
    request.params.id,
    request.params.refNumber,
    target ? { url:target } : {},
  ));
});
app.post('/api/jobs/:id/items/:refNumber/supplements', supplementUpload.single('supplement'), async (request, response, next) => {
  try {
    response.json(await attachManualSupplement(request.params.id, request.params.refNumber, request.file));
  } catch (error) { next(error); }
  finally { if (request.file?.path) await fsPromises.unlink(request.file.path).catch(() => {}); }
});
app.get('/api/jobs/:id/report.csv', async (request, response) => {
  const job = await getJob(request.params.id);
  if (!job) return response.status(404).json({ error: '找不到工作' });
  response.download(path.join(jobDir(job.id), 'report.csv'), `${job.id}_report.csv`);
});
app.get('/api/jobs/:id/archive', async (request, response, next) => {
  try {
    const job = await getJob(request.params.id);
    if (!job) return response.status(404).json({ error: '找不到工作' });
    response.attachment(`${job.id}.zip`);
    const archive = archiver('zip', { zlib: { level: 8 } });
    archive.on('error', next);
    archive.pipe(response);
    const dir = jobDir(job.id);
    const mainFiles = mainArchiveFileNames(job.items);
    for (const fileName of mainFiles) {
      archive.file(path.join(dir, 'pdfs', fileName), { name:`pdfs/${fileName}` });
    }
    const supplementDir = path.join(dir, 'supplements');
    const supplementEntries = await fsPromises.readdir(supplementDir, { withFileTypes:true }).catch(() => []);
    const supplementFiles = filterSupplementArchiveEntries(supplementEntries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    for (const fileName of supplementFiles) archive.file(path.join(supplementDir, fileName), { name:`supplements/${fileName}` });
    archive.file(path.join(dir, 'manifest.json'), { name: 'manifest.json' });
    archive.file(path.join(dir, 'report.csv'), { name: 'report.csv' });
    archive.file(path.join(dir, 'errors.log'), { name: 'errors.log' });
    await archive.finalize();
  } catch (error) { next(error); }
});
app.delete('/api/jobs/:id', async (request, response) => {
  if (isJobRunning(request.params.id)) return response.status(409).json({ error: '工作執行中，暫時不能刪除' });
  await deleteJob(request.params.id);
  response.status(204).end();
});
app.delete('/api/cache', async (_request, response) => { await clearCache(); response.status(204).end(); });

app.use('/api', (_request, response) => response.status(404).json({ error: 'API 不存在' }));
app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(error instanceof multer.MulterError ? 400 : 422).json({ error: error.message || '處理失敗' });
});

app.listen(PORT, HOST, () => console.log(`SAM Reference PDF Collector: http://${HOST}:${PORT}`));
