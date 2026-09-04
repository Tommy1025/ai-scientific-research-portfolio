import fs from 'node:fs/promises';
import path from 'node:path';
import { createCollectionJob, isJobRunning } from '../src/collector.js';
import { JOBS_DIR, SOURCES_DIR } from '../src/constants.js';
import {
  deleteJob, getJob, getSettings, initializeStore, saveSource, sourceDir,
} from '../src/store.js';
import { normalizeDoi, sleep } from '../src/utils.js';

const dois = process.argv.slice(2).map(normalizeDoi).filter(Boolean);
if (!dois.length) {
  console.error('用法：node --use-system-ca scripts/smoke-si.js <DOI> [DOI...]');
  process.exitCode = 2;
} else {
  await initializeStore();
  const settings = await getSettings();
  if (!settings.email) throw new Error('請先在 UI 儲存聯絡 email，再執行實網 smoke test。');

  const suffix = `${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
  const sourceId = `smoke_source_${suffix}`;
  const jobId = `smoke_job_${suffix}`;
  const sourcePath = path.resolve(sourceDir(sourceId));
  const safeSourceRoot = `${path.resolve(SOURCES_DIR)}${path.sep}`;
  if (!sourcePath.startsWith(safeSourceRoot)) throw new Error('不安全的 smoke source 路徑');

  try {
    await saveSource({
      id:sourceId,
      inputType:'smoke',
      metadata:{ title:'SI smoke test' },
      references:dois.map((doi, index) => ({ refNumber:index + 1, doi, rawCitation:`Smoke test DOI ${doi}`, parseMethod:'smoke_exact_doi' })),
      createdAt:new Date().toISOString(),
    });
    await createCollectionJob(sourceId, '全部', { id:jobId, retrievalMode:'main_and_si' });
    const deadline = Date.now() + 15 * 60 * 1000;
    let job;
    do {
      await sleep(1000);
      job = await getJob(jobId);
      if (['completed', 'failed'].includes(job?.state)) break;
      if (Date.now() >= deadline) throw new Error('Smoke test 超過 15 分鐘仍未完成');
    } while (true);

    const result = {
      jobId,
      state:job.state,
      summary:job.summary,
      items:job.items.map((item) => ({
        refNumber:item.refNumber,
        doi:item.doi,
        mainStatus:item.status,
        siStatus:item.siStatus,
        siFiles:(item.siFiles || []).map((file) => ({ fileName:file.fileName, source:file.source, pageCount:file.pageCount, size:file.size, sha256:file.sha256 })),
        ignoredRelevant:(item.siIgnoredCandidates || [])
          .filter((entry) => /reporting_summary|peer_review|source_data|related_excluded|excluded_content|duplicate|max/i.test(entry.reason || ''))
          .map(({ url, source, label, reason, detail }) => ({ url, source, label, reason, detail })),
        ignoredCount:(item.siIgnoredCandidates || []).length,
        failedAttempts:(item.siAttempts || []).filter((attempt) => !attempt.ok).map(({ source, url, status, httpStatus, reason, error }) => ({ source, url, status, httpStatus, reason, error })),
        manualLinks:item.siManualLinks || [],
        siMessage:item.siMessage,
      })),
    };
    console.log(JSON.stringify(result, null, 2));
    if (job.state !== 'completed') process.exitCode = 1;
  } finally {
    while (isJobRunning(jobId)) await sleep(250);
    const jobPath = path.resolve(JOBS_DIR, jobId);
    if (jobPath.startsWith(`${path.resolve(JOBS_DIR)}${path.sep}`)) await deleteJob(jobId).catch(() => {});
    await fs.rm(sourcePath, { recursive:true, force:true });
  }
}
