import assert from 'node:assert/strict';
import test from 'node:test';
import { getApiCredentials, publicApiConfiguration } from '../src/api-config.js';

test('API 公開狀態不回傳任何金鑰內容', () => {
  const previous = process.env.OPENALEX_API_KEY;
  process.env.OPENALEX_API_KEY = 'test-openalex-key';
  try {
    assert.equal(getApiCredentials().openAlexApiKey, 'test-openalex-key');
    const publicJson = JSON.stringify(publicApiConfiguration({ email:'researcher@example.org' }));
    assert.doesNotMatch(publicJson, /test-openalex-key/);
    assert.match(publicJson, /OPENALEX_API_KEY/);
  } finally {
    if (previous === undefined) delete process.env.OPENALEX_API_KEY;
    else process.env.OPENALEX_API_KEY = previous;
  }
});
