import assert from 'node:assert/strict';
import test from 'node:test';
import { browserFallbackConfigured, selectBrowserPdfLink } from '../src/browser-fallback.js';

test('瀏覽器最後備援預設關閉，必須明確啟用', () => {
  assert.equal(browserFallbackConfigured({}), false);
  assert.equal(browserFallbackConfigured({ browserFallbackEnabled:true }), true);
  assert.equal(browserFallbackConfigured({ browserFallbackEnabled:'true' }), true);
});

test('已登入 landing 只選明確 PDF metadata 或連結', () => {
  const meta = selectBrowserPdfLink(
    '<meta name="citation_pdf_url" content="/doi/pdf/10.1/example"><a href="/account">Login</a>',
    'https://publisher.example/article',
  );
  assert.equal(meta, 'https://publisher.example/doi/pdf/10.1/example');
  const link = selectBrowserPdfLink(
    '<a href="/article/10.1/example.pdf">Download PDF</a>',
    'https://repository.example/item/1',
  );
  assert.equal(link, 'https://repository.example/article/10.1/example.pdf');
  assert.equal(selectBrowserPdfLink('<a href="/login">Login</a>', 'https://publisher.example/a'), null);
});
