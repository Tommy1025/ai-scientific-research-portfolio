import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { classifyDownloadFailure, classifyHtml, fetchWithPolicy } from '../src/http.js';
import { STATUS } from '../src/constants.js';

test('登入、付費牆與 CAPTCHA 狀態可區分', () => {
  assert.equal(classifyHtml('<form>Institutional login</form>'), STATUS.LOGIN_REQUIRED);
  assert.equal(classifyHtml('Purchase this article'), STATUS.PAYWALL);
  assert.equal(classifyHtml('Verify you are human CAPTCHA'), STATUS.CAPTCHA);
  assert.equal(classifyHtml('<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform"></script>', 403), STATUS.PUBLISHER_BLOCKED);
  assert.equal(classifyHtml('generic forbidden', 403), STATUS.PUBLISHER_BLOCKED);
  assert.equal(classifyHtml('payment required', 402), STATUS.PAYWALL);
});

test('出版社 API 權限不足不誤判為 CAPTCHA 或一般 403', () => {
  assert.equal(classifyDownloadFailure('{"statusCode":"AUTHENTICATION_ERROR","statusText":"Requestor configuration settings insufficient for access to this resource."}', 403, 'elsevier'), STATUS.API_PERMISSION_REQUIRED);
  assert.equal(classifyDownloadFailure('', 403, 'wiley'), STATUS.API_PERMISSION_REQUIRED);
  assert.equal(classifyDownloadFailure('<title>Just a moment...</title>', 403, ''), STATUS.PUBLISHER_BLOCKED);
});

test('mock server：redirect 與二進位回應', async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url === '/start') { response.writeHead(302, { Location:'/file' }); response.end(); return; }
    response.writeHead(200, { 'Content-Type':'application/pdf' }); response.end('%PDF-1.7 mock');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const result = await fetchWithPolicy(`http://127.0.0.1:${port}/start`, { allowPrivate:true });
  assert.equal(result.status, 200);
  assert.match(result.finalUrl, /\/file$/);
  assert.equal(result.buffer.subarray(0, 5).toString(), '%PDF-');
});

test('跨 origin redirect 不轉送 API token、Authorization 或 Cookie', async (t) => {
  let received;
  const destination = http.createServer((request, response) => {
    received = request.headers;
    response.writeHead(200, { 'Content-Type':'application/pdf' });
    response.end('%PDF-1.7 mock destination');
  });
  await new Promise((resolve) => destination.listen(0, '127.0.0.1', resolve));
  t.after(() => destination.close());
  const source = http.createServer((_request, response) => {
    response.writeHead(302, { Location:`http://127.0.0.1:${destination.address().port}/file` });
    response.end();
  });
  await new Promise((resolve) => source.listen(0, '127.0.0.1', resolve));
  t.after(() => source.close());
  await fetchWithPolicy(`http://127.0.0.1:${source.address().port}/start`, {
    allowPrivate:true,
    headers:{
      Authorization:'Bearer secret', Cookie:'session=secret',
      'Wiley-TDM-Client-Token':'wiley-secret', 'X-ELS-APIKey':'elsevier-secret', 'X-ELS-Insttoken':'inst-secret',
      'X-Harmless':'kept',
    },
  });
  assert.equal(received.authorization, undefined);
  assert.equal(received.cookie, undefined);
  assert.equal(received['wiley-tdm-client-token'], undefined);
  assert.equal(received['x-els-apikey'], undefined);
  assert.equal(received['x-els-insttoken'], undefined);
  assert.equal(received['x-harmless'], 'kept');
});
