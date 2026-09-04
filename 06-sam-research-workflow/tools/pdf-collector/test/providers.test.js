import assert from 'node:assert/strict';
import test from 'node:test';
import AdmZip from 'adm-zip';
import {
  authenticatedPublisherCandidates, candidatesFromCore, candidatesFromCrossref, candidatesFromHtml,
  candidatesFromDspaceBitstreams,
  classifySupplementLink,
  candidatesFromOpenAlex, candidatesFromOpenAlexContent, candidatesFromSemanticScholar, candidatesFromUnpaywall,
  directPublisherCandidates, directSupplementCandidates, publisherLabel, supplementCandidatesFromCrossref,
  supplementCandidatesFromEuropePmcArchive, supplementCandidatesFromFigshareRecords, supplementCandidatesFromHtml,
  supplementCandidatesFromJatsXml,
} from '../src/providers.js';

test('PDF 候選保留預期來源順序與去重', () => {
  const upw = candidatesFromUnpaywall({ best_oa_location:{ url_for_pdf:'https://repo.example/a.pdf' }, oa_locations:[{url_for_pdf:'https://repo.example/a.pdf'}] });
  assert.deepEqual(upw.map((item) => item.url), ['https://repo.example/a.pdf']);
  const cr = candidatesFromCrossref({ link:[{ URL:'https://publisher.example/a.pdf', 'content-type':'application/pdf' }] });
  assert.equal(cr[0].source, 'Crossref/TDM');
});

test('DSpace 7 bitstream enumeration 同時找主文與明確 SI，不把 Source Data 當 SI', () => {
  const candidates = candidatesFromDspaceBitstreams([
    { name:'accepted-manuscript.pdf', _links:{ content:{ href:'https://repo.example/server/api/core/bitstreams/main/content' } } },
    { name:'paper-s1.pdf', description:'Supplementary Information', _links:{ content:{ href:'https://repo.example/server/api/core/bitstreams/si/content' } } },
    { name:'source-data.pdf', description:'Source Data', _links:{ content:{ href:'https://repo.example/server/api/core/bitstreams/data/content' } } },
  ], 'ORIGINAL', 'https://repo.example/items/123');
  assert.equal(candidates.filter((candidate) => !candidate.supplement).length, 1);
  assert.equal(candidates.filter((candidate) => candidate.supplement).length, 1);
  assert.equal(candidates.find((candidate) => candidate.supplement).evidence, 'confirmed');
});

test('出版社 HTML metadata 與 adapter 標籤', () => {
  const candidates = candidatesFromHtml('<meta name="citation_pdf_url" content="/doi/pdf/10.1/x">', 'https://pubs.acs.org/doi/10.1/x');
  assert.equal(candidates[0].url, 'https://pubs.acs.org/doi/pdf/10.1/x');
  assert.equal(publisherLabel('https://onlinelibrary.wiley.com/x'), 'Wiley adapter');
});

test('HTML 混合主文、SI 與附件時，只保留 PDF／DOCX SI', () => {
  const html = [
    '<a href="/article.pdf">Article PDF</a>',
    '<a href="/files/supporting-information.pdf" title="Supporting Information">Supporting Information</a>',
    '<a href="/files/source-data.xlsx">Source Data</a>',
    '<a href="/files/reporting-summary.pdf">Reporting Summary</a>',
    '<a href="/files/peer-review.pdf">Peer Review File</a>',
  ].join('');
  assert.deepEqual(candidatesFromHtml(html, 'https://publisher.example/paper').map((item) => item.url), ['https://publisher.example/article.pdf']);
  const supplements = supplementCandidatesFromHtml(html, 'https://publisher.example/paper');
  assert.deepEqual(supplements.map((item) => item.url), ['https://publisher.example/files/supporting-information.pdf']);
  assert.equal(supplements[0].label, 'Supporting Information Supporting Information');
  const classified = supplementCandidatesFromHtml(html, 'https://publisher.example/paper', { includeExcluded:true });
  assert.equal(classified.filter((item) => item.classification === 'excluded_attachment').length, 3);
  assert.equal(classifySupplementLink('/files/supplement.pdf', 'Reporting Summary').classification, 'excluded_attachment');
  assert.equal(candidatesFromCrossref({ link:[{ URL:'https://repo.example/si.pdf', 'content-type':'application/pdf', 'content-version':'Supporting Information' }] }).length, 0);
  assert.equal(supplementCandidatesFromCrossref({ link:[{ URL:'https://repo.example/supplement.zip', 'content-type':'application/zip' }] }).length, 0);
  assert.equal(supplementCandidatesFromCrossref({ link:[{ URL:'https://repo.example/si.docx', 'content-type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'content-version':'Supporting Information' }] }).length, 1);
  assert.match(directSupplementCandidates('10.1038/s41586-025-09333-z')[0].url, /MOESM1_ESM\.pdf/);
  assert.equal(directSupplementCandidates('10.1039/d0cs00573h')[0].url, 'https://www.rsc.org/suppdata/d0/cs/d0cs00573h/d0cs00573h1.pdf');
  assert.ok(directSupplementCandidates('10.1002/solr.202200355').some((candidate) => candidate.url === 'https://onlinelibrary.wiley.com/action/downloadSupplement?doi=10.1002%2Fsolr.202200355&file=solr202200355-sup-0001-SuppData-S1.pdf'));
});

test('使用者回報的 Wiley、Science 與 RSC DOI 產生出版社通用 SI 候選', () => {
  const wileyCases = [
    ['10.1002/adfm.202206585', 'adfm202206585-sup-0001-SuppMat.pdf'],
    ['10.1002/adma.201306217', 'adma201306217-sup-0001-S1.pdf'],
    ['10.1002/aenm.201801892', 'aenm201801892-sup-0001-S1.pdf'],
  ];
  for (const [doi, fileName] of wileyCases) {
    const urls = directSupplementCandidates(doi).map((candidate) => decodeURIComponent(candidate.url));
    assert.ok(urls.some((url) => url.includes(`file=${fileName}`)), `${doi} 缺少 ${fileName}`);
  }
  assert.ok(directSupplementCandidates('10.1126/science.abd4016')
    .some((candidate) => candidate.url.endsWith('/suppl_file/abd4016_data_s1.pdf')));
  assert.equal(directSupplementCandidates('10.1039/c9ee02268f')[0].url,
    'https://www.rsc.org/suppdata/c9/ee/c9ee02268f/c9ee02268f1.pdf');
  assert.equal(directSupplementCandidates('10.1002/adfm.202206585')[0].evidence, 'probe');
  assert.equal(directSupplementCandidates('10.1039/c9ee02268f')[0].evidence, 'derived');
  assert.ok(directSupplementCandidates('10.1038/srep00591', { published:{ 'date-parts':[[2012]] } })
    .some((candidate) => candidate.url.endsWith('41598_2012_BFsrep00591_MOESM1_ESM.doc')));
});

test('HTML discovery 可辨識 data attribute、嵌入 JSON 與舊式 DOC SI', () => {
  const html = [
    '<section><h2>Supporting Information</h2><a data-download-url="/files/paper-sup-0001-S1.pdf">Download</a></section>',
    '<script type="application/json">{"supplement":"https:\\/\\/cdn.example\\/doi\\/suppl\\/10.1\\/x\\/suppl_file\\/x_data_s1.pdf"}</script>',
    '<a href="/legacy/MOESM1_ESM.doc">Supplementary Information (download DOC)</a>',
  ].join('');
  const candidates = supplementCandidatesFromHtml(html, 'https://publisher.example/article', { includeExcluded:true });
  assert.ok(candidates.some((candidate) => candidate.url === 'https://publisher.example/files/paper-sup-0001-S1.pdf'));
  assert.ok(candidates.some((candidate) => candidate.url === 'https://cdn.example/doi/suppl/10.1/x/suppl_file/x_data_s1.pdf'));
  const legacy = candidates.find((candidate) => candidate.url.endsWith('/MOESM1_ESM.doc'));
  assert.equal(legacy.classification, 'si');
  assert.equal(legacy.evidence, 'confirmed');
});

test('OpenAlex OA 與出版社 direct PDF 候選', () => {
  const oa = candidatesFromOpenAlex({ best_oa_location:{ pdf_url:'https://repo.example/open.pdf', landing_page_url:'https://repo.example/item' } });
  assert.equal(oa[0].source, 'OpenAlex OA');
  assert.equal(oa[1].landing, true);
  assert.match(directPublisherCandidates('10.1002/aenm.201801892')[0].url, /wiley\.com\/doi\/pdfdirect/);
  assert.equal(directPublisherCandidates('10.1039/c9ee02268f')[0].url, 'https://pubs.rsc.org/en/content/articlepdf/2019/ee/c9ee02268f');
  assert.match(directPublisherCandidates('10.1126/science.abd4016')[0].url, /science\.org\/doi\/pdf/);
});

test('API 優先候選保留公開網址，憑證只存在請求欄位或 header', () => {
  const openAlex = candidatesFromOpenAlexContent({ id:'https://openalex.org/W123', has_content:{pdf:true} }, 'test-openalex-key');
  assert.equal(openAlex[0].url, 'https://content.openalex.org/works/W123.pdf');
  assert.match(openAlex[0].requestUrl, /api_key=test-openalex-key/);
  assert.doesNotMatch(openAlex[0].url, /test-openalex-key/);
  assert.equal(openAlex[0].access, 'unknown');
  assert.equal(candidatesFromOpenAlexContent({ id:'https://openalex.org/W124', has_content:{pdf:true}, open_access:{is_oa:true} }, 'key')[0].access, 'oa');

  const core = candidatesFromCore([{ downloadUrl:'https://repo.example/core.pdf', sourceFulltextUrls:['https://repo.example/manuscript.pdf'] }]);
  assert.deepEqual(core.map((item) => item.source), ['CORE repository', 'CORE API']);
  const hydratedCore = candidatesFromCore([{
    apiDownloadUrl:'https://api.core.ac.uk/v3/outputs/123/download',
    downloadUrl:'https://core.ac.uk/download/123.pdf',
    sourceFulltextUrls:['https://repo.example/item/123'],
  }], 'core-secret');
  assert.deepEqual(hydratedCore.map((item) => item.url), [
    'https://api.core.ac.uk/v3/outputs/123/download',
    'https://repo.example/item/123',
    'https://core.ac.uk/download/123.pdf',
  ]);
  assert.equal(hydratedCore[0].headers.Authorization, 'Bearer core-secret');
  assert.equal(hydratedCore[1].landing, true);
  assert.equal(candidatesFromSemanticScholar({ openAccessPdf:{url:'https://repo.example/s2.pdf'} })[0].source, 'Semantic Scholar API');

  const wiley = authenticatedPublisherCandidates('10.1002/test', { wileyTdmClientToken:'test-wiley-token' })[0];
  assert.equal(wiley.headers['Wiley-TDM-Client-Token'], 'test-wiley-token');
  assert.doesNotMatch(wiley.url, /test-wiley-token/);
  const elsevier = authenticatedPublisherCandidates('10.1016/j.test.1', { elsevierApiKey:'test-elsevier-key', elsevierInstToken:'test-inst-token' })[0];
  assert.equal(elsevier.headers['X-ELS-APIKey'], 'test-elsevier-key');
  assert.equal(elsevier.headers['X-ELS-Insttoken'], 'test-inst-token');
  assert.doesNotMatch(elsevier.url, /secret-/);
});

test('Figshare resource DOI 搜尋不限定 ACS，JATS 明確附件標成 confirmed', () => {
  const figshare = supplementCandidatesFromFigshareRecords([{
    resource_doi:'10.1002/example.1', url_public_html:'https://wiley.figshare.com/articles/1',
    files:[{ name:'example-supp.doc', download_url:'https://ndownloader.figshare.com/files/1' }],
  }], '10.1002/example.1');
  assert.equal(figshare.length, 1);
  assert.equal(figshare[0].source, 'Figshare API');
  assert.equal(figshare[0].evidence, 'confirmed');

  const xml = '<article xmlns:xlink="http://www.w3.org/1999/xlink"><supplementary-material><media xlink:href="files/paper-s1.pdf" content-type="application/pdf"/></supplementary-material></article>';
  const jats = supplementCandidatesFromJatsXml(xml, 'https://publisher.example/article.xml');
  assert.equal(jats[0].url, 'https://publisher.example/files/paper-s1.pdf');
  assert.equal(jats[0].evidence, 'confirmed');
});

test('ACS Figshare resource DOI 只產生該文章的 PDF／DOCX SI 候選', () => {
  const candidates = supplementCandidatesFromFigshareRecords([{
    resource_doi:'10.1021/acsnano.5c01479',
    url_public_html:'https://acs.figshare.com/articles/28745562',
    files:[
      { name:'nn5c01479_si_001.pdf', download_url:'https://ndownloader.figshare.com/files/53475117' },
      { name:'source-data.xlsx', download_url:'https://ndownloader.figshare.com/files/53475118' },
    ],
  }], '10.1021/acsnano.5c01479');
  assert.deepEqual(candidates.map((candidate) => candidate.url), ['https://ndownloader.figshare.com/files/53475117']);
  assert.equal(candidates[0].label, 'Supporting Information nn5c01479_si_001.pdf');
});

test('Europe PMC supplementaryFiles ZIP 轉成 PDF/DOCX/legacy DOC SI 候選', () => {
  const archive = new AdmZip();
  archive.addFile('paper-s1.pdf', Buffer.from('%PDF-1.7 supplement'));
  archive.addFile('paper-s2.docx', Buffer.from('PK docx'));
  archive.addFile('paper-s3.doc', Buffer.concat([Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]), Buffer.alloc(32)]));
  archive.addFile('source-data.pdf', Buffer.from('%PDF-1.7 data'));
  archive.addFile('figure-s1.jpg', Buffer.from('image'));
  const candidates = supplementCandidatesFromEuropePmcArchive(
    archive.toBuffer(), 'PMC123', 'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC123/supplementaryFiles',
  );
  assert.deepEqual(candidates.map((candidate) => candidate.url), [
    'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC123/supplementaryFiles#paper-s1.pdf',
    'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC123/supplementaryFiles#paper-s2.docx',
    'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC123/supplementaryFiles#paper-s3.doc',
  ]);
  assert.equal(candidates.every((candidate) => Buffer.isBuffer(candidate.localBuffer)), true);
  assert.equal(candidates.every((candidate) => candidate.access === 'oa'), true);
});
