import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('新工作預設只抓主文，UI 可選主文＋SI 並提供 main-only retry', async () => {
  const [html, app, server] = await Promise.all([
    fs.readFile(path.join(root, 'public/index.html'), 'utf8'),
    fs.readFile(path.join(root, 'public/app.js'), 'utf8'),
    fs.readFile(path.join(root, 'server.js'), 'utf8'),
  ]);
  assert.doesNotMatch(html, /id="include-si"/);
  assert.doesNotMatch(app, /#include-si/);
  assert.match(html, /id="retrieval-mode"/);
  assert.match(html, /option value="main_only" selected/);
  assert.match(html, /option value="main_and_si"/);
  assert.match(app, /retrievalMode:\s*\$\('#retrieval-mode'\)\.value/);
  assert.match(server, /retrievalMode:\s*request\.body\?\.retrievalMode/);
  assert.match(server, /includeSupplements:\s*request\.body\?\.includeSupplements/);
  assert.match(server, /scope:\s*request\.body\?\.scope/);
  assert.match(app, /body:JSON\.stringify\(\{ scope:'main_failed' \}\)/);
  assert.match(html, /只重試主文/);
  assert.match(html, /SI 檔案/);
  assert.match(html, /SI 下載失敗/);
  assert.match(app, /interrupted/);
  assert.match(app, /工作中斷，可重試/);
  assert.match(app, /上傳已下載 SI/);
  assert.match(server, /items\/:refNumber\/supplements/);
});
