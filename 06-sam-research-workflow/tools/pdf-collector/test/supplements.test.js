import assert from 'node:assert/strict';
import test from 'node:test';
import AdmZip from 'adm-zip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  applyRelatedSupplementExclusions, chooseSupplementFiles, classifySupplementDescriptor, rankSupplementCandidates,
  extractEmbeddedPdfAttachments, extractEmbeddedSupplementPdf, findEmbeddedSupplementStart, validateSupplementDocument,
} from '../src/supplements.js';

function makeDocx(text, { document = true } = {}) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'));
  if (document) zip.addFile('word/document.xml', Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`));
  return zip.toBuffer();
}

async function makePdf(text, { title = '' } = {}) {
  const pdf = await PDFDocument.create();
  if (title) pdf.setTitle(title);
  const page = pdf.addPage([500, 700]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  if (text) page.drawText(text, { x:40, y:650, size:16, font });
  return Buffer.from(await pdf.save());
}

async function makePagedPdf(pageTexts) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of pageTexts) {
    const page = pdf.addPage([500, 700]);
    page.drawText(text, { x:40, y:650, size:14, font, maxWidth:420, lineHeight:18 });
  }
  return Buffer.from(await pdf.save());
}

test('SI 描述先排除附件用途，再接受明確 SI 詞與標準 adapter', () => {
  assert.equal(classifySupplementDescriptor({ url:'https://x/supplement.pdf', label:'Reporting Summary' }).classification, 'excluded_attachment');
  assert.equal(classifySupplementDescriptor({ url:'https://x/file.pdf', label:'Supporting Information' }).classification, 'si');
  assert.equal(classifySupplementDescriptor({ url:'https://x/file.docx', label:'Electronic Supplementary Information' }).classification, 'si');
  assert.equal(classifySupplementDescriptor({ url:'https://x/123_MOESM1_ESM.pdf', label:'' }).classification, 'si');
  assert.equal(classifySupplementDescriptor({ url:'https://x/supplement.pdf', label:'' }).classification, 'unknown');
  assert.equal(classifySupplementDescriptor({ url:'https://x/source-data.xlsx', label:'Supporting Information' }).classification, 'excluded_attachment');
  assert.equal(classifySupplementDescriptor({ url:'https://x/site.css', label:'text/css' }).classification, 'unknown');
});

test('頁面標成 Reporting Summary 的 MOESM 編號會排除對應 direct adapter PDF', () => {
  const candidates = applyRelatedSupplementExclusions([
    { url:'https://static.example/123_MOESM1_ESM.pdf', source:'Nature SI adapter' },
    { url:'https://static.example/123_MOESM2_ESM.pdf', source:'Nature SI adapter' },
    { url:'https://nature.example/files/123_MOESM2_ESM.pdf', label:'Nature Portfolio Reporting Summary', source:'Nature metadata' },
  ]);
  assert.equal(candidates[0].classification, 'si');
  assert.equal(candidates[1].classification, 'excluded_attachment');
  assert.match(candidates[1].reason, /reporting_summary/);
  assert.deepEqual(rankSupplementCandidates(candidates).map((candidate) => candidate.url), ['https://static.example/123_MOESM1_ESM.pdf']);
});

test('頁面導覽 anchor 沾到 Data Availability 不得排除同編號的明確 SI PDF', () => {
  const candidates = applyRelatedSupplementExclusions([
    { url:'https://static.example/123_MOESM1_ESM.pdf', label:'Supplementary Information', source:'Nature metadata' },
    { url:'https://nature.example/article#MOESM1', label:'Supplementary Information Data availability', source:'Nature navigation' },
  ]);
  assert.equal(candidates[0].classification, 'si');
  assert.equal(candidates[1].classification, 'excluded_attachment');
});

test('DOCX 必須有 OOXML 必要項目；一般 ZIP 偽裝 DOCX 會拒絕', async () => {
  const candidate = { url:'https://x/si.docx', label:'Supporting Information' };
  const valid = await validateSupplementDocument({ buffer:makeDocx('Supporting Information'), contentType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document', finalUrl:candidate.url, candidate });
  assert.equal(valid.ok, true);
  assert.equal(valid.extension, '.docx');
  const fake = await validateSupplementDocument({ buffer:makeDocx('Supporting Information', {document:false}), contentType:'application/zip', finalUrl:candidate.url, candidate });
  assert.equal(fake.ok, false);
  assert.match(fake.error, /DOCX/);
});

test('legacy DOC 必須有 OLE magic 且可抽出 SI 文字', async () => {
  const ole = Buffer.concat([Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]), Buffer.alloc(64)]);
  const valid = await validateSupplementDocument({
    buffer:ole, contentType:'application/msword', finalUrl:'https://x/MOESM1_ESM.doc',
    candidate:{ url:'https://x/MOESM1_ESM.doc', label:'Supplementary Information' },
    legacyDocTextExtractor:async () => 'Supplementary Information General methods Figure S1',
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.extension, '.doc');
  const fake = await validateSupplementDocument({
    buffer:Buffer.alloc(80), contentType:'application/msword', finalUrl:'https://x/MOESM1_ESM.doc',
    candidate:{ url:'https://x/MOESM1_ESM.doc', label:'Supplementary Information' },
    legacyDocTextExtractor:async () => 'Supplementary Information',
  });
  assert.equal(fake.ok, false);
});

test('主文 PDF 的 EmbeddedFiles 可抽出並交給 SI 驗證', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  await pdf.attach(Buffer.from('embedded payload'), 'paper-s1.doc', { description:'Supplementary Information' });
  const candidates = await extractEmbeddedPdfAttachments(Buffer.from(await pdf.save()));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].archiveEntryName, 'paper-s1.doc');
  assert.equal(candidates[0].evidence, 'confirmed');
});

test('SI PDF 前兩頁若顯示 Reporting Summary 必須排除', async () => {
  const result = await validateSupplementDocument({
    buffer:await makePdf('Reporting Summary'), contentType:'application/pdf', finalUrl:'https://x/MOESM1_ESM.pdf',
    candidate:{ url:'https://x/MOESM1_ESM.pdf', label:'Supporting Information' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'excluded_content');
});

test('無文字層 PDF 的 metadata 顯示 review material 時仍排除', async () => {
  const result = await validateSupplementDocument({
    buffer:await makePdf('', { title:'additional_review_material_4792557.pdf' }), contentType:'application/pdf',
    finalUrl:'https://x/MOESM2_ESM.pdf', candidate:{ url:'https://x/MOESM2_ESM.pdf' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'excluded_content');
});

test('真正 SI 內文出現 Figure S1 不會被誤判為圖片附件', async () => {
  const result = await validateSupplementDocument({
    buffer:await makePdf('Supporting Information - Figure S1 device structure'), contentType:'application/pdf',
    finalUrl:'https://x/supporting-information.pdf', candidate:{ url:'https://x/supporting-information.pdf', label:'Supporting Information' },
  });
  assert.equal(result.ok, true);
});

test('三個有效候選只選排名最高兩份，且相同 SHA-256 去重', () => {
  const candidates = rankSupplementCandidates([
    { url:'https://x/MOESM1_ESM.pdf', label:'', source:'Nature adapter' },
    { url:'https://x/si.docx', label:'Supplementary Information', source:'metadata' },
    { url:'https://x/si.pdf', label:'Supporting Information', source:'metadata' },
    { url:'https://mirror/si.pdf', label:'Supporting Information', source:'mirror' },
  ]);
  assert.deepEqual(candidates.map((item) => item.url), ['https://x/si.pdf', 'https://mirror/si.pdf', 'https://x/si.docx', 'https://x/MOESM1_ESM.pdf']);
  const chosen = chooseSupplementFiles(candidates.map((candidate, index) => ({
    candidate,
    result:{ ok:true, sha256:index === 1 ? 'hash-a' : `hash-${index === 0 ? 'a' : index}`, extension:candidate.url.endsWith('.docx') ? '.docx' : '.pdf' },
  })));
  assert.deepEqual(chosen.selected.map((entry) => entry.candidate.url), ['https://x/si.pdf', 'https://x/si.docx']);
  assert.equal(chosen.ignored.some((entry) => entry.reason === 'duplicate_sha256'), true);
  assert.equal(chosen.ignored.some((entry) => entry.reason === 'limit_two'), true);
});

test('偵測並拆出主文 PDF 後附的 Supplementary Materials', async () => {
  const buffer = await makePagedPdf([
    'Article title and abstract',
    'Results, discussion, and references',
    'Supplementary Materials Contents Methods Figure S1 Table S1',
    'Figure S1. Device structure and additional results',
  ]);
  const embedded = await extractEmbeddedSupplementPdf(buffer);
  assert.equal(embedded.startPage, 3);
  assert.equal(embedded.pageCount, 2);
  const validation = await validateSupplementDocument({
    buffer:embedded.buffer,
    contentType:'application/pdf',
    finalUrl:'embedded-main.pdf',
    candidate:{ url:'embedded-main.pdf', label:'Supplementary Materials' },
  });
  assert.equal(validation.ok, true);
  assert.equal(validation.pageCount, 2);
});

test('偵測 Wiley 版權頁型 Supporting Information，但不把正文中的可用性敘述切成 SI', () => {
  const wileyPages = [
    { flowing:'Article title and abstract' },
    { flowing:'Results and References' },
    { flowing:'25 Copyright WILEY-VCH 2019. Supporting Information Article title General methods and chemicals' },
  ];
  assert.equal(findEmbeddedSupplementStart(wileyPages), 2);
  assert.equal(findEmbeddedSupplementStart([
    { flowing:'Article title' },
    { flowing:'Supporting Information is available from the publisher website.' },
    { flowing:'References' },
  ]), null);
});

test('本機已取得的 repository SI 排在出版社網路候選之前', () => {
  const localBuffer = Buffer.from('%PDF-1.7 local supplement');
  const ranked = rankSupplementCandidates([
    { url:'https://publisher.example/si.pdf', label:'Supporting Information' },
    { url:'https://repository.example/archive#si.pdf', label:'Supporting Information', contentType:'application/pdf', localBuffer },
  ]);
  assert.equal(ranked[0].localBuffer, localBuffer);
});
