import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { attachManualSupplement, jobSummary } from '../src/collector.js';
import { SI_STATUS, STATUS, TMP_DIR } from '../src/constants.js';
import { deleteJob, getJob, initializeStore, saveJob } from '../src/store.js';

async function makeSiPdf() {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([500, 700]);
  page.drawText('Supporting Information', { x:50, y:650, size:18, font });
  page.drawText('Figure S1 and experimental details', { x:50, y:610, size:12, font });
  return Buffer.from(await document.save());
}

test('瀏覽器下載的 PDF 可上傳回指定 ref，驗證後納入 SI 與摘要', async () => {
  await initializeStore();
  const suffix = `${process.pid}_${Date.now()}`;
  const jobId = `test_manual_si_${suffix}`;
  const uploadPath = path.join(TMP_DIR, `manual_si_${suffix}.pdf`);
  const item = {
    refNumber:7, doi:'10.1000/manual', status:STATUS.READY_OA,
    siStatus:SI_STATUS.MANUAL_REQUIRED, siFiles:[], siManualLinks:['https://publisher.example/si.pdf'],
  };
  const job = {
    id:jobId, sourceId:'test', state:'completed', includeSupplements:true, items:[item],
    summary:jobSummary([item], { includeSupplements:true }), createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
  };
  try {
    await fs.writeFile(uploadPath, await makeSiPdf());
    await saveJob(job);
    const updated = await attachManualSupplement(jobId, 7, {
      path:uploadPath, originalname:'downloaded-si.pdf', mimetype:'application/pdf',
    });
    assert.equal(updated.items[0].siStatus, SI_STATUS.COLLECTED);
    assert.equal(updated.items[0].siFiles.length, 1);
    assert.equal(updated.items[0].siFiles[0].source, '人工瀏覽器上傳');
    assert.equal(updated.summary.siRefsCollected, 1);
    assert.equal(updated.summary.siManualRefs, 0);
    assert.ok(await fs.stat(path.join(path.dirname(path.dirname(uploadPath)), 'jobs', jobId, 'supplements', updated.items[0].siFiles[0].fileName)));
    const persisted = await getJob(jobId);
    assert.equal(persisted.items[0].siFiles[0].sha256, updated.items[0].siFiles[0].sha256);
  } finally {
    await fs.unlink(uploadPath).catch(() => {});
    await deleteJob(jobId).catch(() => {});
  }
});
