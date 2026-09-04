import assert from 'node:assert/strict';
import test from 'node:test';
import { assessMainDocument } from '../src/main-document.js';

const DOI = '10.1234/example.2025.7';
const WORK = {
  DOI,
  title: ['A robust main-document identity test'],
  author: [{ family:'Chen', given:'Mei' }],
  published: { 'date-parts':[[2025]] },
  page: '136-145',
};

function parsed(pageTexts, metadata = {}) {
  return {
    pageCount: pageTexts.length,
    pages: pageTexts.map((flowing, index) => ({ pageNumber:index + 1, flowing })),
    text: pageTexts.join('\n\n'),
    metadata,
  };
}

function completePages(count = 10, doi = DOI) {
  return Array.from({ length:count }, (_, index) => {
    if (index === 0) return `A robust main-document identity test\nMei Chen\n2025\nDOI ${doi}\nIntroduction`;
    if (index === count - 1) return 'Conclusions\nReferences\n[1] Complete reference list';
    return `Results and discussion page ${index + 1}`;
  });
}

test('前三頁或 PDF metadata 的目標 DOI 可確認身分', () => {
  const fromFront = assessMainDocument({
    parsed:parsed(completePages()),
    candidate:{ access:'publisher', source:'Publisher direct PDF' },
    doi:DOI,
    work:WORK,
  });
  assert.equal(fromFront.ok, true);
  assert.equal(fromFront.mainValidation.identity.method, 'doi');
  assert.equal(fromFront.documentVersion, 'vor');

  const pages = completePages();
  pages[0] = 'A robust main-document identity test\nMei Chen\n2025\nIntroduction';
  const fromMetadata = assessMainDocument({
    parsed:parsed(pages, { DOI }),
    candidate:{ access:'publisher' },
    doi:DOI,
    work:WORK,
  });
  assert.equal(fromMetadata.ok, true);
  assert.deepEqual(fromMetadata.mainValidation.identity.metadataDois, [DOI]);
});

test('前文或 metadata 出現衝突 DOI 時拒絕錯論文', () => {
  const pages = completePages();
  pages[0] = 'A different article\nDOI 10.9999/wrong.article\n2025';
  const result = assessMainDocument({
    parsed:parsed(pages),
    candidate:{ access:'oa', source:'Repository PDF' },
    doi:DOI,
    work:WORK,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureCode, 'main_identity_conflict');
  assert.deepEqual(result.mainValidation.identity.conflictingDois, ['10.9999/wrong.article']);
});

test('References 內的其他 DOI 不視為前文衝突', () => {
  const pages = completePages(1);
  pages[0] = `A robust main-document identity test\nMei Chen\n2025\nDOI ${DOI}\nReferences\n[1] DOI 10.9999/cited.paper`;
  const result = assessMainDocument({
    parsed:parsed(pages),
    candidate:{ access:'publisher' },
    doi:DOI,
    work:{ ...WORK, page:'1-1' },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.mainValidation.identity.conflictingDois, []);
});

test('沒有 DOI 時必須同時符合題名 0.90、第一作者姓氏及年份 ±1', () => {
  const pages = completePages();
  pages[0] = 'A robust main document identity test\nMei Chen\nPublished 2024\nIntroduction';
  const accepted = assessMainDocument({
    parsed:parsed(pages),
    candidate:{ access:'oa', source:'Institutional repository' },
    doi:DOI,
    work:WORK,
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.mainValidation.identity.method, 'bibliographic');
  assert.ok(accepted.mainValidation.identity.bibliographic.titleSimilarity >= 0.90);
  assert.equal(accepted.documentVersion, 'aam');

  const wrongAuthor = [...pages];
  wrongAuthor[0] = 'A robust main document identity test\nMei Lin\nPublished 2024\nIntroduction';
  const rejected = assessMainDocument({
    parsed:parsed(wrongAuthor),
    candidate:{ access:'oa', source:'Institutional repository' },
    doi:DOI,
    work:WORK,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.failureCode, 'main_identity_unverified');
  assert.equal(rejected.mainValidation.identity.bibliographic.authorMatched, false);
});

test('Crossref 顯示多頁但實際只有一頁時判為 preview', () => {
  const result = assessMainDocument({
    parsed:parsed([`A robust main-document identity test\nMei Chen\n2025\nDOI ${DOI}\nReferences`]),
    candidate:{ access:'publisher', source:'Elsevier Article API' },
    doi:DOI,
    work:WORK,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureCode, 'main_preview');
  assert.equal(result.classification, 'preview');
  assert.equal(result.expectedPageCount, 10);
  assert.equal(result.mainValidation.completeness.reason, 'crossref_multipage_but_single_page_pdf');
});

test('預期至少四頁、實際不足一半且沒有結尾訊號時判為不完整', () => {
  const pages = completePages(4);
  pages[3] = 'Results continue on the next page';
  const result = assessMainDocument({
    parsed:parsed(pages),
    candidate:{ access:'publisher' },
    doi:DOI,
    work:WORK,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureCode, 'main_incomplete');
  assert.equal(result.mainValidation.completeness.reason, 'less_than_half_expected_pages_without_terminal_signal');
});

test('不足一半但末頁有可靠結尾訊號時不套用截斷規則', () => {
  const result = assessMainDocument({
    parsed:parsed(completePages(4)),
    candidate:{ access:'publisher' },
    doi:DOI,
    work:WORK,
  });
  assert.equal(result.ok, true);
  assert.equal(result.mainValidation.completeness.terminalSignal, true);
});

test('合法單頁文章需由 metadata 支持且含完整結尾', () => {
  const text = `A robust main-document identity test\nMei Chen\n2025\nDOI ${DOI}\nConclusions\nReferences`;
  const accepted = assessMainDocument({
    parsed:parsed([text]),
    candidate:{ access:'publisher' },
    doi:DOI,
    work:{ ...WORK, page:'1-1' },
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.mainValidation.completeness.reason, 'metadata_supported_complete_single_page');

  const unsupported = assessMainDocument({
    parsed:parsed([text]),
    candidate:{ access:'publisher' },
    doi:DOI,
    work:{ ...WORK, page:null },
  });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.failureCode, 'main_preview');
});

test('未成立 entitlement 或明示 preview 時，即使 PDF 可解析也拒絕', () => {
  const denied = assessMainDocument({
    parsed:parsed(completePages()),
    candidate:{ access:'publisher', source:'Elsevier Article API' },
    doi:DOI,
    work:WORK,
    entitlement:{ status:401, entitled:false },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.failureCode, 'main_preview');
  assert.ok(denied.mainValidation.completeness.previewEvidence.includes('entitlement_denied'));

  const explicit = assessMainDocument({
    parsed:parsed(completePages()),
    candidate:{ access:'publisher', preview:true },
    doi:DOI,
    work:WORK,
  });
  assert.equal(explicit.ok, false);
  assert.ok(explicit.mainValidation.completeness.previewEvidence.includes('candidate.preview'));
});

test('版本只接受 VoR、AAM、reconstructed，明示 preprint 時拒絕', () => {
  const aam = assessMainDocument({
    parsed:parsed(completePages()),
    candidate:{ documentVersion:'aam' },
    doi:DOI,
    work:WORK,
  });
  assert.equal(aam.ok, true);
  assert.equal(aam.documentVersion, 'aam');

  const reconstructed = assessMainDocument({
    parsed:parsed(completePages()),
    candidate:{ reconstructed:true },
    doi:DOI,
    work:WORK,
  });
  assert.equal(reconstructed.ok, true);
  assert.equal(reconstructed.documentVersion, 'reconstructed');

  const preprint = assessMainDocument({
    parsed:parsed(completePages()),
    candidate:{ contentVersion:'submittedVersion' },
    doi:DOI,
    work:WORK,
  });
  assert.equal(preprint.ok, false);
  assert.equal(preprint.failureCode, 'main_preprint_not_allowed');
  assert.equal(preprint.documentVersion, null);
});

test('GetFTR alternative version 未證明為 AAM 前不可當成完整主文', () => {
  const result = assessMainDocument({
    parsed: parsed([
        `${WORK.title[0]}\nMei Chen\n2025\nDOI ${DOI}`,
        'Methods',
        'Results',
        'Discussion',
        'Conclusion',
        'References',
        'Bibliography',
        'End of article',
      ]),
    doi:DOI,
    work: WORK,
    candidate:{
      source:'GetFTR alternative-version smart link',
      documentVersion:'unknown',
      requiresVersionValidation:true,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureCode, 'main_version_unverified');
  assert.equal(result.documentVersion, null);
});
