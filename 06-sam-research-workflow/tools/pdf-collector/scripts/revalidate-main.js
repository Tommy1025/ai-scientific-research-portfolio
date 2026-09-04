import { revalidateJobMainDocuments } from '../src/collector.js';
import { initializeStore } from '../src/store.js';

const jobIds = process.argv.slice(2).filter(Boolean);
if (!jobIds.length) {
  throw new Error('請明確提供要重驗證的 job ID；本腳本不會自動列舉或批次處理全部工作。');
}
if (jobIds.length > 10) {
  throw new Error('一次最多重驗證 10 個明確指定的工作。');
}

await initializeStore();
for (const jobId of jobIds) {
  const job = await revalidateJobMainDocuments(jobId);
  const summary = job.revalidation || {};
  console.log(JSON.stringify({
    jobId,
    checked:summary.checked,
    accepted:summary.accepted,
    rejected:summary.rejected,
    rejectedRefs:(summary.results || []).filter((entry) => !entry.ok).map((entry) => entry.refNumber),
  }));
}
