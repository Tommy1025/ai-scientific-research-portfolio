import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  assessMainBuffer, failureCodeForContentResponse, firstAcceptedMainCandidate,
  providerTraceFailureCode,
} from '../src/collector.js';
import { FAILURE_CODE, STATUS } from '../src/constants.js';

const DOI = '10.5555/complete.article';
const TITLE = 'A Complete Article for Main Document Validation';

async function articlePdf(pageCount, { ending = true } = {}) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.setTitle(TITLE);
  document.setAuthor('Wei Chen');
  for (let index = 0; index < pageCount; index += 1) {
    const page = document.addPage([612, 792]);
    if (index === 0) {
      page.drawText(TITLE, { x:40, y:740, size:14, font });
      page.drawText(`Wei Chen 2024 DOI ${DOI}`, { x:40, y:710, size:10, font });
    } else {
      page.drawText(`Article body page ${index + 1}`, { x:40, y:740, size:11, font });
    }
    if (ending && index === pageCount - 1) {
      page.drawText('References', { x:40, y:120, size:12, font });
      page.drawText('End of article', { x:40, y:90, size:10, font });
    }
  }
  return Buffer.from(await document.save());
}

test('23-page OA control remains accepted with identity and completeness evidence', async () => {
  const result = await assessMainBuffer(await articlePdf(23), {
    doi:DOI,
    work:{
      DOI,
      title:[TITLE],
      author:[{ family:'Chen' }],
      issued:{ 'date-parts':[[2024]] },
      page:'1-23',
    },
    candidate:{
      source:'OpenAlex Content API',
      access:'oa',
      repository:true,
      documentVersion:'aam',
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.pageCount, 23);
  assert.equal(result.documentVersion, 'aam');
  assert.equal(result.mainValidation.identity.method, 'doi');
  assert.equal(result.mainValidation.completeness.verified, true);
});

test('page range 136-145 plus one-page Elsevier response is preview even when HTTP was 200', async () => {
  const result = await assessMainBuffer(await articlePdf(1, { ending:false }), {
    doi:DOI,
    work:{ DOI, title:[TITLE], author:[{ family:'Chen' }], issued:{ 'date-parts':[[2024]] }, page:'136-145' },
    candidate:{ source:'Elsevier Article Retrieval API PDF', access:'publisher', documentVersion:'vor' },
    entitlement:{ httpStatus:401, entitled:false },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, STATUS.PREVIEW_ONLY);
  assert.equal(result.failureCode, FAILURE_CODE.PREVIEW_ONLY);
  assert.equal(result.expectedPageCount, 10);
});

test('provider trace distinguishes auth, entitlement, throttling and generic errors', () => {
  assert.equal(providerTraceFailureCode(401, 'Elsevier'), FAILURE_CODE.API_FEATURE_NOT_ENABLED);
  assert.equal(providerTraceFailureCode(401, 'CORE'), FAILURE_CODE.API_CREDENTIAL_INVALID);
  assert.equal(providerTraceFailureCode(403, 'Wiley'), FAILURE_CODE.INSTITUTION_ENTITLEMENT_FALSE);
  assert.equal(providerTraceFailureCode(403, 'RSC landing'), FAILURE_CODE.PUBLISHER_AUTOMATION_BLOCKED);
  assert.equal(providerTraceFailureCode(429, 'OpenAlex'), FAILURE_CODE.QUOTA_THROTTLED);
  assert.equal(providerTraceFailureCode(500, 'OpenAIRE'), FAILURE_CODE.DOWNLOAD_FAILED);
});

test('HTML/login responses receive actionable failure codes instead of a MIME error', () => {
  assert.equal(
    failureCodeForContentResponse(STATUS.LOGIN_REQUIRED, 200),
    FAILURE_CODE.AUTH_NETWORK_MISMATCH,
  );
  assert.equal(
    failureCodeForContentResponse(STATUS.PAYWALL, 200),
    FAILURE_CODE.INSTITUTION_ENTITLEMENT_FALSE,
  );
  assert.equal(
    failureCodeForContentResponse(STATUS.API_PERMISSION_REQUIRED, 200),
    FAILURE_CODE.API_FEATURE_NOT_ENABLED,
  );
  assert.equal(
    failureCodeForContentResponse(STATUS.PUBLISHER_BLOCKED, 403),
    FAILURE_CODE.PUBLISHER_AUTOMATION_BLOCKED,
  );
  assert.equal(
    failureCodeForContentResponse(STATUS.INVALID_PDF, 200),
    FAILURE_CODE.FORMAT_NOT_PERMITTED,
  );
  assert.equal(
    failureCodeForContentResponse(STATUS.LOGIN_REQUIRED, 429),
    FAILURE_CODE.QUOTA_THROTTLED,
  );
});

test('preview cache does not short-circuit a later repository full text', async () => {
  const candidates = [
    { url:'cache://doi', source:'Validated cache', cache:true },
    { url:'https://repository.example/article.pdf', source:'DSpace repository', repository:true },
  ];
  const calls = [];
  const accepted = await firstAcceptedMainCandidate(candidates, {}, {
    attempt:async (candidate) => {
      calls.push(candidate.source);
      return candidate.cache
        ? { ok:false, status:STATUS.PREVIEW_ONLY, failureCode:FAILURE_CODE.PREVIEW_ONLY }
        : { ok:true, documentVersion:'aam', mainValidation:{ verified:true } };
    },
  });
  assert.deepEqual(calls, ['Validated cache', 'DSpace repository']);
  assert.equal(accepted.candidate.source, 'DSpace repository');
  assert.equal(accepted.result.documentVersion, 'aam');
});

test('wrong repository document is rejected before the next identity-valid candidate', async () => {
  const wrong = await assessMainBuffer(await articlePdf(8), {
    doi:'10.5555/different.article',
    work:{ DOI:'10.5555/different.article', page:'1-8' },
    candidate:{ source:'Repository A', repository:true, documentVersion:'aam' },
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.failureCode, FAILURE_CODE.IDENTITY_MISMATCH);
  const accepted = await firstAcceptedMainCandidate([
    { source:'Repository A' },
    { source:'Repository B' },
  ], {}, {
    attempt:async (candidate) => candidate.source === 'Repository A'
      ? wrong
      : { ok:true, documentVersion:'aam', mainValidation:{ verified:true } },
  });
  assert.equal(accepted.candidate.source, 'Repository B');
});
