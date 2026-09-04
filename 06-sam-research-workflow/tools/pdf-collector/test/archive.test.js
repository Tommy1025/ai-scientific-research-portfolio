import assert from 'node:assert/strict';
import test from 'node:test';
import { filterSupplementArchiveEntries, mainArchiveFileNames } from '../src/archive.js';
import { STATUS } from '../src/constants.js';

test('ZIP supplements 只收 PDF、DOCX 與 legacy DOC', () => {
  assert.deepEqual(filterSupplementArchiveEntries([
    'ref0001_SI_01_si.pdf', 'ref0001_SI_02_si.docx', 'ref0001_SI_03_si.doc', 'source-data.xlsx', 'data.csv',
    'bundle.zip', 'code.js', 'figure.png', 'nested/si.pdf',
  ]), ['ref0001_SI_01_si.pdf', 'ref0001_SI_02_si.docx', 'ref0001_SI_03_si.doc']);
});

test('ZIP 主文只收通過驗證且仍為成功狀態的 PDF', () => {
  assert.deepEqual(mainArchiveFileNames([
    { status:STATUS.READY_OA, fileName:'accepted.pdf' },
    { status:STATUS.PREVIEW_ONLY, fileName:null, previewFileName:'preview.pdf' },
    { status:STATUS.INVALID_PDF, fileName:'wrong.pdf' },
    { status:STATUS.READY_VPN, fileName:'nested/full.pdf' },
    { status:STATUS.READY_OTHER, fileName:'accepted.pdf' },
  ]), ['accepted.pdf', 'full.pdf']);
});
