import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cleanupAtomicTemps, extractDois, isPrivateIp, normalizeDoi, parseRefSpec, replaceFileWithRetry, sha256,
  validateExternalUrl, writeJson,
} from '../src/utils.js';

test('ref 範圍：全部、合併、單點與錯誤', () => {
  assert.deepEqual(parseRefSpec('全部', 4), [1, 2, 3, 4]);
  assert.deepEqual(parseRefSpec('1-3,2-4,7', 8), [1, 2, 3, 4, 7]);
  assert.throws(() => parseRefSpec('5-2', 8), /起點大於終點/);
  assert.throws(() => parseRefSpec('1-x', 8), /無法辨識/);
  assert.throws(() => parseRefSpec('9', 8), /1-8/);
});

test('DOI 正規化、擷取與雜湊穩定', () => {
  assert.equal(normalizeDoi('https://doi.org/10.1000/ABC.123.'), '10.1000/abc.123');
  assert.deepEqual(extractDois('doi:10.1000/ABC.123 and https://doi.org/10.2000/X-Y'), ['10.1000/abc.123', '10.2000/x-y']);
  assert.deepEqual(extractDois('https://doi.org/10.1021/acsaem. 9b02037.'), ['10.1021/acsaem.9b02037']);
  assert.deepEqual(extractDois('https://doi.org/10.1038/s41560-023- 01227-6.'), ['10.1038/s41560-023-01227-6']);
  assert.equal(sha256(Buffer.from('same')), sha256(Buffer.from('same')));
});

test('URL 安全：拒絕非 HTTP、localhost 與私有 IP', async () => {
  await assert.rejects(validateExternalUrl('file:///etc/passwd'), /http\/https/);
  await assert.rejects(validateExternalUrl('http://localhost:8080'), /本機或私有/);
  await assert.rejects(validateExternalUrl('http://192.168.1.2'), /本機或私有/);
  assert.equal(isPrivateIp('172.31.2.4'), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);
});

test('Windows 暫時鎖檔造成 EPERM 時會重試原子替換', async () => {
  let attempts = 0;
  const delays = [];
  await replaceFileWithRetry('manifest.tmp', 'manifest.json', {
    rename:async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('locked'), { code:'EPERM' });
    },
    wait:async (delay) => { delays.push(delay); },
    maxAttempts:4,
  });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [25, 50]);
});

test('同一路徑大量並行 writeJson 維持有效 JSON 且不殘留 tmp', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sam-write-json-'));
  const file = path.join(dir, 'manifest.json');
  try {
    await Promise.all(Array.from({ length:50 }, (_, index) => writeJson(file, { index, payload:'x'.repeat(1000) })));
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(saved.index, 49);
    assert.deepEqual((await fs.readdir(dir)).filter((name) => name.endsWith('.tmp')), []);
  } finally {
    await fs.rm(dir, { recursive:true, force:true });
  }
});

test('只清理符合 atomic writer 命名規則的舊 tmp', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sam-cleanup-tmp-'));
  try {
    await Promise.all([
      fs.writeFile(path.join(dir, 'manifest.json.18344.8129f53c.tmp'), 'stale'),
      fs.writeFile(path.join(dir, 'keep.tmp'), 'keep'),
      fs.writeFile(path.join(dir, 'manifest.json.not-ours.tmp'), 'keep'),
    ]);
    assert.deepEqual(await cleanupAtomicTemps(dir, { olderThanMs:0, now:Date.now() + 1000 }), ['manifest.json.18344.8129f53c.tmp']);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['keep.tmp', 'manifest.json.not-ours.tmp']);
  } finally {
    await fs.rm(dir, { recursive:true, force:true });
  }
});
