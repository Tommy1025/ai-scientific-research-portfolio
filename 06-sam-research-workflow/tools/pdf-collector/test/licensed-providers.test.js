import assert from 'node:assert/strict';
import test from 'node:test';
import {
  candidatesFromGetFtrResponse,
  candidatesFromLibKeyResponse,
  elsevierArticleCandidates,
  elsevierPdfArticleUrl,
  getGetFtrCandidates,
  getLibKeyCandidates,
  springerNatureStructuredCandidates,
} from '../src/licensed-providers.js';

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    buffer: Buffer.from(JSON.stringify(value)),
  };
}

test('Springer Nature JATS candidates are lazy and keep the API key out of public URLs', () => {
  assert.deepEqual(springerNatureStructuredCandidates('10.1007/example.1', {}), []);
  const candidates = springerNatureStructuredCandidates(
    'https://doi.org/10.1007/example.1',
    { springerNatureApiKey: 'springer-secret/metric' },
  );
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((candidate) => candidate.source), [
    'Springer Nature Full Text API',
    'Springer Nature Open Access API',
  ]);
  assert.equal(candidates.every((candidate) => candidate.structured), true);
  assert.equal(candidates.every((candidate) => candidate.documentVersion === 'vor'), true);
  assert.equal(candidates[1].openAccessDeclared, true);
  assert.equal(candidates[1].license, null);
  assert.equal(candidates.every((candidate) => new URL(candidate.url).searchParams.get('q') === 'doi:10.1007/example.1'), true);
  assert.equal(candidates.every((candidate) => !candidate.url.includes('springer-secret')), true);
  assert.equal(candidates.every((candidate) => new URL(candidate.requestUrl).searchParams.get('api_key') === 'springer-secret/metric'), true);
});

test('Elsevier helpers add amsRedirect/FULL and put credentials only in headers', () => {
  const directUrl = elsevierPdfArticleUrl('10.1016/j.example.2026.1');
  assert.equal(new URL(directUrl).searchParams.get('amsRedirect'), 'true');
  assert.equal(new URL(directUrl).searchParams.get('httpAccept'), 'application/pdf');

  assert.deepEqual(elsevierArticleCandidates('10.1016/j.example.2026.1', {}), []);
  assert.deepEqual(
    elsevierArticleCandidates('10.1002/adfm.202206585', { elsevierApiKey:'elsevier-secret' }),
    [],
  );
  const candidates = elsevierArticleCandidates(
    '10.1016/j.example.2026.1',
    { elsevierApiKey: 'elsevier-secret', elsevierInstToken: 'inst-secret' },
    {},
    { requestId: 'request-123' },
  );
  assert.equal(candidates.length, 2);
  assert.equal(new URL(candidates[0].url).searchParams.get('amsRedirect'), 'true');
  assert.equal(new URL(candidates[1].url).searchParams.get('view'), 'FULL');
  assert.equal(candidates[1].structured, true);
  assert.equal(candidates[0].headers['X-ELS-APIKey'], 'elsevier-secret');
  assert.equal(candidates[0].headers['X-ELS-Insttoken'], 'inst-secret');
  assert.equal(candidates[0].headers['X-ELS-ReqId'], 'request-123');
  assert.equal(candidates.every((candidate) => !candidate.url.includes('secret')), true);
  assert.equal(candidates.every((candidate) => !candidate.requestUrl.includes('secret')), true);
});

test('LibKey response yields documented smart links without pretending they are guaranteed background downloads', () => {
  const candidates = candidatesFromLibKeyResponse({
    data: {
      doi: '10.1186/example.1',
      openAccess: false,
      availableThroughBrowzine: true,
      fullTextFile: 'https://libkey.io/libraries/73/articles/1/full-text-file?allow_speedbump=true',
      contentLocation: 'https://libkey.io/libraries/73/articles/1/content-location',
      bestIntegratorLink: {
        bestLink: 'https://libkey.io/libraries/73/articles/1/full-text-file?allow_speedbump=true',
        linkType: 'fullTextFile',
      },
    },
  }, '10.1186/example.1');
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].linkType, 'fullTextFile');
  assert.equal(candidates[0].smartLink, true);
  assert.equal(candidates[0].backgroundDownloadGuaranteed, false);
  assert.equal(candidates[0].license, null);
  assert.match(candidates[0].accessLimitation, /不保證.*背景程序/);
  assert.equal(candidates[1].landing, true);
  assert.deepEqual(candidatesFromLibKeyResponse({ data:{ doi:'10.1186/wrong' } }, '10.1186/example.1'), []);
});

test('LibKey lookup uses Bearer auth, is lazy without credentials, and never exposes the key in a candidate', async () => {
  let calls = 0;
  const noCredentials = await getLibKeyCandidates('10.1186/example.1', {}, {
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({});
    },
  });
  assert.deepEqual(noCredentials, []);
  assert.equal(calls, 0);

  let captured;
  const candidates = await getLibKeyCandidates(
    '10.1186/example.1',
    { libkeyLibraryId:'73', libkeyApiKey:'libkey-secret' },
    {
      fetchImpl: async (url, options) => {
        calls += 1;
        captured = { url, options };
        return jsonResponse({
          data: {
            doi:'10.1186/example.1',
            openAccess:true,
            availableThroughBrowzine:true,
            fullTextFile:'https://libkey.io/libraries/73/articles/1/full-text-file',
          },
        });
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(captured.options.headers.Authorization, 'Bearer libkey-secret');
  assert.doesNotMatch(captured.url, /libkey-secret/);
  assert.equal(candidates.length, 1);
  assert.doesNotMatch(candidates[0].url, /libkey-secret/);
});

test('GetFTR response distinguishes VoR from an unverified alternative version and marks every URL as a smart link', () => {
  const candidates = candidatesFromGetFtrResponse({
    entitlements: [{
      doi:'10.1000/example.1',
      statusCode:200,
      entitled:'yes',
      accessType:'paid',
      source:'service_request',
      document:'https://publisher.example/article',
      vor:[
        { contentType:'application/pdf', url:'https://publisher.example/article.pdf' },
        { contentType:'text/html', url:'https://publisher.example/article' },
      ],
      av:[{ contentType:'application/pdf', url:'https://repository.example/manuscript.pdf' }],
      licenses:[{ type:'other', url:'https://publisher.example/license' }],
    }],
  }, '10.1000/example.1');
  assert.equal(candidates.length, 3);
  const vorPdf = candidates.find((candidate) => candidate.url.endsWith('article.pdf'));
  const alternate = candidates.find((candidate) => candidate.url.endsWith('manuscript.pdf'));
  assert.equal(vorPdf.documentVersion, 'vor');
  assert.equal(vorPdf.smartLink, true);
  assert.equal(vorPdf.backgroundDownloadGuaranteed, false);
  assert.equal(alternate.documentVersion, 'unknown');
  assert.equal(alternate.requiresVersionValidation, true);
  assert.match(alternate.versionEvidence, /未保證.*AAM/);
  assert.equal(candidates.every((candidate) => candidate.license === 'https://publisher.example/license'), true);
});

test('GetFTR v2.2 uses POST plus x-api-key and performs no call without an explicit API key', async () => {
  let calls = 0;
  assert.deepEqual(await getGetFtrCandidates('10.1000/example.1', {}, {
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({});
    },
  }), []);
  assert.equal(calls, 0);

  let captured;
  const candidates = await getGetFtrCandidates(
    '10.1000/example.1',
    { getftrApiKey:'getftr-secret' },
    {
      org:{ entityID:'https://idp.example/idp' },
      fetchImpl: async (url, options) => {
        calls += 1;
        captured = { url, options };
        return jsonResponse({
          entitlements:[{
            doi:'10.1000/example.1',
            entitled:'yes',
            accessType:'open',
            vor:[{ contentType:'application/pdf', url:'https://publisher.example/open.pdf' }],
          }],
        });
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(captured.url, 'https://entitlements.prod.getft.io/v2.2/entitlements');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers['x-api-key'], 'getftr-secret');
  assert.deepEqual(JSON.parse(captured.options.body), {
    dois:['10.1000/example.1'],
    org:{ entityID:'https://idp.example/idp' },
  });
  assert.doesNotMatch(captured.url, /getftr-secret/);
  assert.equal(candidates[0].access, 'oa');
});

test('licensed provider errors retain HTTP classification without leaking credentials', async () => {
  await assert.rejects(
    () => getLibKeyCandidates(
      '10.1186/example.1',
      { libkeyLibraryId:'73', libkeyApiKey:'test-libkey-token' },
      { fetchImpl:async () => jsonResponse({ error:'forbidden' }, 403) },
    ),
    (error) => {
      assert.equal(error.provider, 'libkey');
      assert.equal(error.status, 403);
      assert.equal(error.providerCode, 'http_403');
      assert.doesNotMatch(error.providerUrl, /test-libkey-token/);
      assert.doesNotMatch(error.message, /test-libkey-token/);
      return true;
    },
  );
});
