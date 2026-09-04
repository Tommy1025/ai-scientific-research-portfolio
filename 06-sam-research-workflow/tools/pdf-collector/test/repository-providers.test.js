import assert from 'node:assert/strict';
import test from 'node:test';
import {
  candidatesFromDspace6Bitstreams,
  candidatesFromEuropePmcRecords,
  candidatesFromHalResponse,
  candidatesFromHtml,
  candidatesFromOaiPmhXml,
  candidatesFromOpenAire,
  candidatesFromSemanticScholar,
  candidatesFromSignposting,
  candidatesFromZenodoResponse,
  dspaceItemApiUrls,
  dspaceItemApiUrlsFromSearch,
  dspaceSearchApiUrls,
  getOpenAirePublications,
  oaiRecordUrlsFromHtml,
  parseSignpostingLinks,
} from '../src/providers.js';

test('OpenAIRE Graph 只保留相同 DOI 的 VoR/AAM，不納入 preprint', () => {
  const records = [{
    pids:[{ scheme:'doi', value:'10.1021/example.1' }],
    instances:[
      {
        type:'Accepted manuscript',
        accessRight:{ label:'OPEN' },
        license:'https://creativecommons.org/licenses/by/4.0/',
        urls:['https://repository.example/items/accepted'],
      },
      {
        type:'Preprint',
        accessRight:{ label:'OPEN' },
        urls:['https://preprints.example/example.pdf'],
      },
      {
        type:'Version of Record',
        accessRight:{ label:'OPEN' },
        urls:['https://repository.example/example.pdf'],
      },
    ],
  }, {
    pids:[{ scheme:'doi', value:'10.1021/wrong.2' }],
    instances:[{ type:'Accepted manuscript', urls:['https://repository.example/wrong.pdf'] }],
  }];

  const candidates = candidatesFromOpenAire(records, '10.1021/example.1');
  assert.deepEqual(candidates.map((candidate) => candidate.url), [
    'https://repository.example/items/accepted',
    'https://repository.example/example.pdf',
  ]);
  assert.equal(candidates[0].landing, true);
  assert.equal(candidates[0].documentVersion, 'aam');
  assert.equal(candidates[0].license, 'https://creativecommons.org/licenses/by/4.0/');
  assert.equal(candidates[1].landing, false);
  assert.equal(candidates[1].documentVersion, 'vor');
});

test('OpenAIRE legacy Search API 的 webresource 也能解析', () => {
  const candidates = candidatesFromOpenAire([{
    pid:{ '@classid':'doi', $:'10.1002/example.2' },
    children:{
      instance:{
        instancetype:{ classname:'Accepted manuscript' },
        accessright:{ classname:'Open Access' },
        webresource:{ url:{ $:'https://repo.example/handle/1/2' } },
      },
    },
  }], '10.1002/example.2');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].url, 'https://repo.example/handle/1/2');
  assert.equal(candidates[0].documentVersion, 'aam');
});

test('OpenAIRE HTTP 錯誤保留 provider、HTTP status 與 trace code', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response('rate limited', {
    status:429,
    headers:{ 'content-type':'text/plain' },
  });
  try {
    await assert.rejects(
      getOpenAirePublications('10.1000/test', '', {
        openAire:'https://93.184.216.34/graph/v3/research-products',
      }),
      (error) => error.provider === 'openaire'
        && error.status === 429
        && error.providerCode === 'http_429'
        && /pid=10.1000%2Ftest/.test(error.providerUrl),
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('Semantic Scholar 非 .pdf URL 標為 landing，PDF 維持直接候選', () => {
  const landing = candidatesFromSemanticScholar({
    openAccessPdf:{ url:'https://repository.example/items/123' },
    url:'https://www.semanticscholar.org/paper/abc',
  });
  assert.equal(landing[0].landing, true);
  assert.equal(landing[0].repository, true);
  assert.equal(landing[1].landing, true);

  const pdf = candidatesFromSemanticScholar({
    openAccessPdf:{ url:'https://repository.example/files/paper.PDF?download=1' },
  });
  assert.equal(pdf[0].landing, false);
});

test('FAIR Signposting parser 正確處理 quoted comma、相對 URL 與 license', () => {
  const header = [
    '</files/article.pdf>; rel="item"; type="application/pdf"; title="Article, accepted"',
    '<https://creativecommons.org/licenses/by/4.0/>; rel="license"',
    '</metadata.xml>; rel="describedby"; type="application/vnd.crossref.unixref+xml"',
  ].join(', ');
  const links = parseSignpostingLinks(header, 'https://repo.example/items/123');
  assert.equal(links.length, 3);
  assert.equal(links[0].url, 'https://repo.example/files/article.pdf');
  assert.equal(links[0].params.title, 'Article, accepted');

  const candidates = candidatesFromSignposting(header, 'https://repo.example/items/123');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, 'FAIR Signposting');
  assert.equal(candidates[0].license, 'https://creativecommons.org/licenses/by/4.0/');
  assert.equal(candidates[0].url, 'https://repo.example/files/article.pdf');
});

test('DSpace item/entity URL、handle/DOI search 與 search response 均可解析', () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  assert.deepEqual(
    dspaceItemApiUrls(`https://repo.example/entities/publication/${uuid}`),
    [`https://repo.example/server/api/core/items/${uuid}`],
  );
  assert.deepEqual(
    dspaceItemApiUrls(`https://repo.example/items/${uuid}`),
    [`https://repo.example/server/api/core/items/${uuid}`],
  );

  const searches = dspaceSearchApiUrls(
    ['https://repo.example/handle/1234/5678'],
    '10.1021/example.1',
  );
  assert.equal(searches.length, 2);
  assert.ok(searches.some((url) => decodeURIComponent(url).includes('dc.identifier.doi:"10.1021/example.1"')));
  assert.ok(searches.some((url) => decodeURIComponent(url).includes('https://hdl.handle.net/1234/5678')));

  const itemApis = dspaceItemApiUrlsFromSearch({
    _embedded:{
      searchResult:{
        _embedded:{
          objects:[{
            _embedded:{ indexableObject:{ uuid } },
          }],
        },
      },
    },
  }, searches[0]);
  assert.deepEqual(itemApis, [`https://repo.example/server/api/core/items/${uuid}`]);
});

test('Europe PMC/PMC 主文候選接受 AAM、拒絕 preprint 與錯 DOI', () => {
  const candidates = candidatesFromEuropePmcRecords([
    {
      source:'MED',
      doi:'10.1126/science.example',
      pmcid:'PMC1234567',
      manuscriptId:'NIHMS123',
      license:'CC BY-NC',
    },
    {
      source:'PPR',
      doi:'10.1126/science.example',
      pmcid:'PMC7654321',
    },
    {
      source:'MED',
      doi:'10.1126/science.wrong',
      pmcid:'PMC9999999',
    },
  ], '10.1126/science.example');
  assert.deepEqual(candidates.map((candidate) => candidate.url), [
    'https://europepmc.org/articles/pmc1234567?pdf=render',
    'https://pmc.ncbi.nlm.nih.gov/articles/PMC1234567/pdf/',
  ]);
  assert.equal(candidates.every((candidate) => candidate.documentVersion === 'aam'), true);
  assert.equal(candidates.every((candidate) => candidate.license === 'CC BY-NC'), true);
});

test('Pure 與 EPrints HTML metadata 會保留 repository provenance', () => {
  const pure = candidatesFromHtml(
    '<meta name="generator" content="Pure"><meta name="citation_pdf_url" content="/files/aam.pdf">',
    'https://research.example/en/publications/article',
  );
  assert.equal(pure.length, 1);
  assert.equal(pure[0].source, 'Pure repository');
  assert.equal(pure[0].repository, true);
  assert.equal(pure[0].access, 'unknown');

  const eprints = candidatesFromHtml(
    '<meta name="generator" content="EPrints 3"><meta name="eprints.document_url" content="/123/article.pdf">',
    'https://eprints.example/123/',
  );
  assert.equal(eprints.length, 1);
  assert.equal(eprints[0].source, 'EPrints repository');
  assert.equal(eprints[0].repository, true);
});

test('HAL 與 Zenodo API fixtures 只產生 DOI 相符的 repository PDF', () => {
  const hal = candidatesFromHalResponse({
    response:{
      docs:[
        {
          doiId_s:['10.1021/example.1'],
          fileMain_s:'https://api.archives-ouvertes.fr/file/article.pdf',
          license_s:'CC-BY-4.0',
        },
        {
          doiId_s:['10.1021/wrong'],
          fileMain_s:'https://api.archives-ouvertes.fr/file/wrong.pdf',
        },
      ],
    },
  }, '10.1021/example.1');
  assert.deepEqual(hal.map((candidate) => candidate.url), [
    'https://api.archives-ouvertes.fr/file/article.pdf',
  ]);
  assert.equal(hal[0].documentVersion, 'aam');
  assert.equal(hal[0].license, 'CC-BY-4.0');

  const zenodo = candidatesFromZenodoResponse({
    hits:{
      hits:[{
        doi:'10.5281/zenodo.123',
        metadata:{
          related_identifiers:[{ identifier:'https://doi.org/10.1021/example.1' }],
          license:{ id:'cc-by-4.0' },
        },
        files:[
          { key:'accepted.pdf', links:{ content:'https://zenodo.org/api/records/123/files/accepted.pdf/content' } },
          { key:'data.csv', links:{ content:'https://zenodo.org/api/records/123/files/data.csv/content' } },
        ],
      }],
    },
  }, '10.1021/example.1');
  assert.equal(zenodo.length, 1);
  assert.equal(zenodo[0].source, 'Zenodo repository');
  assert.equal(zenodo[0].documentVersion, 'aam');
  assert.equal(zenodo[0].license, 'cc-by-4.0');
});

test('OAI-PMH discovery 與 GetRecord fixture 可解析 DOI 相符的 PDF resource', () => {
  const recordUrl = 'https://repo.example/oai?verb=GetRecord&metadataPrefix=oai_dc&identifier=oai:repo:123';
  const html = `<meta name="robots" OAIPMHrecord="${recordUrl}">`;
  assert.deepEqual(oaiRecordUrlsFromHtml(html, 'https://repo.example/items/123'), [recordUrl]);

  const xml = `<?xml version="1.0"?>
    <OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"
      xmlns:oai_dc="http://www.openarchives.org/OAI/2.0/oai_dc/"
      xmlns:dc="http://purl.org/dc/elements/1.1/">
      <GetRecord><record><metadata><oai_dc:dc>
        <dc:identifier>https://doi.org/10.1021/example.1</dc:identifier>
        <dc:identifier>https://repo.example/files/accepted.pdf</dc:identifier>
      </oai_dc:dc></metadata></record></GetRecord>
    </OAI-PMH>`;
  const candidates = candidatesFromOaiPmhXml(xml, recordUrl, '10.1021/example.1');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].url, 'https://repo.example/files/accepted.pdf');
  assert.equal(candidates[0].documentVersion, 'aam');
  assert.deepEqual(candidatesFromOaiPmhXml(xml, recordUrl, '10.1021/wrong'), []);
});

test('DSpace 6 bitstream fixture 列舉 ORIGINAL 主文及明確 SI', () => {
  const candidates = candidatesFromDspace6Bitstreams([
    {
      name:'accepted.pdf',
      bundleName:'ORIGINAL',
      retrieveLink:'/rest/bitstreams/main/retrieve',
    },
    {
      name:'supporting_information.pdf',
      bundleName:'ORIGINAL',
      retrieveLink:'/rest/bitstreams/si/retrieve',
    },
  ], 'https://repo.example', 'https://repo.example/handle/1/2');
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].source, 'DSpace 6 repository');
  assert.equal(candidates[0].supplement, undefined);
  assert.equal(candidates[1].source, 'DSpace 6 REST API');
  assert.equal(candidates[1].supplement, true);
});
