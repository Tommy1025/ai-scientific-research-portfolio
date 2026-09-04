import assert from 'node:assert/strict';
import test from 'node:test';
import { crossrefReferences, mergeReferenceLists, parsePdfReferences, scoreCrossrefCandidate } from '../src/references.js';

test('解析常見 reference 編號格式', () => {
  for (const marker of ['[1]', '(1)', '1.', '1 .']) {
    const refs = parsePdfReferences(`Introduction\nReferences\n${marker} A. Chen, A useful paper, Journal 2020. doi:10.1000/test\n[2] B. Lin, Another sufficiently long reference, 2021.`);
    assert.equal(refs.length, 2);
    assert.equal(refs[0].doi, '10.1000/test');
  }
});

test('連續序列不會把 DOI、卷期年份或表格數字誤認成 ref', () => {
  const refs = parsePdfReferences(`References\n1 . A. Chen, First paper, Journal 10 (2025): 12.\n10.1002/first\n2025) supplementary value\n2 . B. Lin, Second paper, Journal 4 (2024): 30.\n3 . C. Wu, Third paper, Journal 8 (2023): 44.\nSupporting Information\n2025. Not a reference`);
  assert.deepEqual(refs.map((ref) => ref.refNumber), [1, 2, 3]);
  assert.match(refs[0].rawCitation, /2025/);
});

test('Crossref 與 PDF refs 依編號合併，PDF 原文優先', () => {
  const crossref = crossrefReferences({ reference:[{ key:'1', DOI:'10.1000/a', unstructured:'Crossref citation' }] });
  const merged = mergeReferenceLists(crossref, [{ refNumber:1, rawCitation:'PDF citation with enough content', doi:null, parseMethod:'pdf_numbered' }]);
  assert.equal(merged[0].rawCitation, 'PDF citation with enough content');
  assert.equal(merged[0].doi, '10.1000/a');
});

test('Crossref 複雜 key 不當作 ref 編號，改採陣列順序', () => {
  const refs = crossrefReferences({ reference:[
    { key:'e_1_2_11_181_1', unstructured:'First citation' },
    { key:'e_1_2_11_182_1', unstructured:'Second citation' },
  ] });
  assert.deepEqual(refs.map((ref) => ref.refNumber), [1, 2]);
});

test('書目分數同時考慮標題、作者、年份', () => {
  const score = scoreCrossrefCandidate('Chen 2022 High efficiency solar cells', { title:['High efficiency solar cells'], author:[{family:'Chen'}], published:{'date-parts':[[2022]]} });
  assert.ok(score > 0.95);
});
