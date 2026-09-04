import path from 'node:path';
import { getApiCredentials } from '../src/api-config.js';
import {
  attemptCandidate, firstAcceptedMainCandidate, isJobRunning, retryJob, retryModeForItem,
} from '../src/collector.js';
import { DATA_DIR } from '../src/constants.js';
import {
  authenticatedPublisherCandidates, candidatesFromCore, candidatesFromOpenAlex,
  candidatesFromOpenAlexContent, getCoreWorks, getCrossrefWork, getOpenAlex,
} from '../src/providers.js';
import { elsevierArticleCandidates } from '../src/licensed-providers.js';
import { getJob, getSettings, initializeStore } from '../src/store.js';
import { ensureDir, writeFileAtomic } from '../src/utils.js';

const TARGETS = Object.freeze({
  job_mrx7c25r_931f3d62:[2, 5, 6, 7, 8, 9, 17, 18, 20, 23, 26, 27],
  job_mrx81lht_4c629d36:[31, 32, 34, 36, 38, 41, 42, 44, 45, 47, 49, 50],
});
const CONTROLS = Object.freeze([
  { jobId:'job_mrx7c25r_931f3d62', refNumber:22, provider:'elsevier' },
  { jobId:'job_mrx81lht_4c629d36', refNumber:35, provider:'wiley' },
  { jobId:'job_mrx81lht_4c629d36', refNumber:33, provider:'core' },
  { jobId:'job_mrx81lht_4c629d36', refNumber:48, provider:'openalex' },
]);

function siSnapshot(job) {
  return JSON.stringify(job.items.map((item) => ({
    refNumber:item.refNumber,
    siStatus:item.siStatus,
    siMessage:item.siMessage,
    siFiles:item.siFiles,
    siAttempts:item.siAttempts,
    siManualLinks:item.siManualLinks,
  })));
}

async function waitForJob(jobId, timeoutMs = 45 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await getJob(jobId);
    if (!isJobRunning(jobId) && ['completed', 'failed', 'interrupted'].includes(job?.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`等待 ${jobId} 超過 ${Math.round(timeoutMs / 60000)} 分鐘`);
}

function controlCandidates(provider, doi, credentials, data = {}) {
  if (provider === 'elsevier') return elsevierArticleCandidates(doi, credentials);
  if (provider === 'wiley') {
    return authenticatedPublisherCandidates(doi, credentials)
      .filter((candidate) => candidate.apiService === 'wiley');
  }
  if (provider === 'core') return candidatesFromCore(data.coreWorks, credentials.coreApiKey);
  if (provider === 'openalex') {
    return [
      ...candidatesFromOpenAlexContent(data.openAlex, credentials.openAlexApiKey),
      ...candidatesFromOpenAlex(data.openAlex).filter((candidate) => !candidate.landing),
    ];
  }
  return [];
}

async function runControl(control, email, credentials) {
  const job = await getJob(control.jobId);
  const item = job?.items.find((entry) => entry.refNumber === control.refNumber);
  if (!item?.doi) throw new Error(`控制稿 ref ${control.refNumber} 缺少 DOI`);
  const work = await getCrossrefWork(item.doi, email);
  const data = {};
  if (control.provider === 'core') {
    data.coreWorks = await getCoreWorks(item.doi, credentials.coreApiKey);
  }
  if (control.provider === 'openalex') {
    data.openAlex = await getOpenAlex(item.doi, email, {}, credentials.openAlexApiKey);
  }
  const candidates = controlCandidates(control.provider, item.doi, credentials, data);
  const attempts = [];
  const accepted = await firstAcceptedMainCandidate(candidates, {
    doi:item.doi,
    email,
    work,
    credentials,
  }, {
    onResult:({ candidate, result, durationMs }) => attempts.push({
      source:candidate.source,
      ok:result.ok,
      status:result.status || null,
      failureCode:result.failureCode || null,
      httpStatus:result.httpStatus || null,
      pageCount:result.pageCount || null,
      documentVersion:result.documentVersion || null,
      durationMs,
    }),
  });
  return {
    refNumber:control.refNumber,
    doi:item.doi,
    provider:control.provider,
    candidateCount:candidates.length,
    ok:Boolean(accepted),
    source:accepted?.candidate?.source || null,
    pageCount:accepted?.result?.pageCount || null,
    documentVersion:accepted?.result?.documentVersion || null,
    attempts,
  };
}

await initializeStore();
const settings = await getSettings();
const credentials = getApiCredentials();
const startedAt = new Date().toISOString();
const before = {};
const jobs = [];

for (const [jobId, expectedRefs] of Object.entries(TARGETS)) {
  const job = await getJob(jobId);
  if (!job) throw new Error(`找不到 smoke job ${jobId}`);
  const actualRefs = job.items
    .filter((item) => retryModeForItem(item, {
      retryOnly:true,
      includeSupplements:false,
      retryScope:'main_failed',
    }) === 'main')
    .map((item) => item.refNumber);
  if (JSON.stringify(actualRefs) !== JSON.stringify(expectedRefs)) {
    throw new Error(`${jobId} 的 main_failed refs 不符合核准清單：${actualRefs.join(',')}`);
  }
  before[jobId] = {
    si:siSnapshot(job),
    collected:job.summary?.collected || 0,
  };
  await retryJob(jobId, { scope:'main_failed' });
  const completed = await waitForJob(jobId);
  const afterSi = siSnapshot(completed);
  jobs.push({
    jobId,
    targetRefs:expectedRefs,
    collectedBefore:before[jobId].collected,
    collectedAfter:completed.summary?.collected || 0,
    siUnchanged:afterSi === before[jobId].si,
    results:completed.items
      .filter((item) => expectedRefs.includes(item.refNumber))
      .map((item) => ({
        refNumber:item.refNumber,
        doi:item.doi,
        status:item.status,
        failureCode:item.failureCode || null,
        sourceProvider:item.sourceProvider || null,
        documentVersion:item.documentVersion || null,
        documentFormat:item.documentFormat || null,
        pageCount:item.pageCount || null,
        validationVerified:Boolean(item.mainValidation?.verified),
        nextAction:item.nextAction || null,
      })),
  });
}

const controls = [];
for (const control of CONTROLS) {
  try {
    controls.push(await runControl(control, settings.email, credentials));
  } catch (error) {
    controls.push({
      refNumber:control.refNumber,
      provider:control.provider,
      ok:false,
      error:error.message,
    });
  }
}

const result = {
  version:'0.7.0',
  retrievalMode:'main_only',
  siRequestsExpected:0,
  startedAt,
  finishedAt:new Date().toISOString(),
  targetCount:Object.values(TARGETS).flat().length,
  jobs,
  controls,
};
const outputDir = path.join(DATA_DIR, 'smoke');
await ensureDir(outputDir);
const outputPath = path.join(outputDir, 'main-v0.7.0.json');
await writeFileAtomic(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  outputPath,
  jobs:jobs.map((job) => ({
    jobId:job.jobId,
    collectedBefore:job.collectedBefore,
    collectedAfter:job.collectedAfter,
    siUnchanged:job.siUnchanged,
  })),
  controls:controls.map(({ refNumber, provider, ok, source, error }) => ({
    refNumber, provider, ok, source, error,
  })),
}));
