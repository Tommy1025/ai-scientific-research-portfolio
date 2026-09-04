import assert from 'node:assert/strict';
import test from 'node:test';
import { detectNtnuVpn } from '../src/network.js';
import {
  apiAccessRequirements, jobSummary, mainSuccessStatus, matchConfidence, normalizeRetrievalMode, normalizeRetryScope,
  retryModeForItem, selectReferenceNumbers, shouldCollectSupplementsWithMain,
  shouldInspectSupplementLandings, shouldStopSupplementHost, supplementFailureOutcome,
} from '../src/collector.js';
import { SI_STATUS, STATUS } from '../src/constants.js';

test('VPN 必須命中指定校內 IPv4，不以 F5 存在代替', () => {
  const disconnected = detectNtnuVpn({ Ethernet:[{ family:'IPv4', internal:false, address:'192.168.1.10' }] });
  assert.equal(disconnected.connected, false);
  const connected = detectNtnuVpn({ VPN:[{ family:'IPv4', internal:false, address:'140.122.57.42' }] });
  assert.equal(connected.connected, true);
  assert.equal(connected.campusAddress, '140.122.57.42');
});

test('repository local 候選必須驗證成功後才可跳過 landing discovery', () => {
  assert.equal(shouldInspectSupplementLandings([{ ok:true }]), false);
  assert.equal(shouldInspectSupplementLandings([{ ok:false, reason:'invalid_pdf' }]), true);
  assert.equal(shouldInspectSupplementLandings([]), true);
});

test('SI provider 連線失敗不可誤報未發現 SI', () => {
  const outcome = supplementFailureOutcome({ providerErrors:['Figshare API: timeout'] });
  assert.equal(outcome.status, SI_STATUS.DOWNLOAD_FAILED);
  assert.match(outcome.message, /provider.*失敗/i);
});

test('DOI 配對信心分級與全部蒐集到判定', () => {
  assert.equal(matchConfidence(.9), 'accepted');
  assert.equal(matchConfidence(.7), 'review');
  assert.equal(matchConfidence(.2), 'rejected');
  assert.equal(jobSummary([{status:STATUS.READY_OA},{status:STATUS.READY_VPN}]).allCollected, true);
  assert.equal(jobSummary([{status:STATUS.READY_OA},{status:STATUS.PAYWALL}]).allCollected, false);
  const withSi = jobSummary([{status:STATUS.READY_OA,siFiles:[{fileName:'si.pdf'}]}], { includeSupplements:true });
  assert.equal(withSi.siRefsCollected, 1);
  assert.equal(withSi.siFilesCollected, 1);
});

test('retrieval mode 預設只抓主文，並相容舊 includeSupplements', () => {
  assert.deepEqual(normalizeRetrievalMode(), { retrievalMode:'main_only', includeSupplements:false });
  assert.deepEqual(normalizeRetrievalMode({ includeSupplements:true }), { retrievalMode:'main_and_si', includeSupplements:true });
  assert.deepEqual(normalizeRetrievalMode({ includeSupplements:false }), { retrievalMode:'main_only', includeSupplements:false });
  assert.deepEqual(normalizeRetrievalMode({ retrievalMode:'main_and_si', includeSupplements:false }), {
    retrievalMode:'main_and_si', includeSupplements:true,
  });
  assert.throws(() => normalizeRetrievalMode({ retrievalMode:'invalid' }), /retrievalMode/);
});

test('retry scope 預設只重試主文，三種 scope 嚴格分流', () => {
  const item = { status:STATUS.READY_OA, siStatus:SI_STATUS.DOWNLOAD_FAILED, siFiles:[] };
  const summary = jobSummary([item], { includeSupplements:true });
  assert.equal(summary.allCollected, true);
  assert.equal(summary.siFailedRefs, 1);
  assert.equal(normalizeRetryScope(), 'main_failed');
  assert.equal(normalizeRetryScope('si_failed'), 'si_failed');
  assert.equal(normalizeRetryScope('all_failed'), 'all_failed');
  assert.throws(() => normalizeRetryScope('invalid'), /scope/);
  assert.equal(retryModeForItem(item, { retryOnly:true, includeSupplements:true }), null);
  assert.equal(retryModeForItem(item, { retryOnly:true, includeSupplements:true, retryScope:'si_failed' }), 'si_only');
  assert.equal(retryModeForItem(item, { retryOnly:true, includeSupplements:true, retryScope:'all_failed' }), 'si_only');
  assert.equal(item.status, STATUS.READY_OA);
  assert.equal(retryModeForItem(
    { status:STATUS.READY_VPN, siStatus:SI_STATUS.PENDING },
    { retryOnly:true, includeSupplements:true, retryScope:'si_failed' },
  ), 'si_only');
  assert.equal(retryModeForItem(
    { status:STATUS.PENDING, siStatus:SI_STATUS.PENDING },
    { retryOnly:true, includeSupplements:true, retryScope:'si_failed' },
  ), null);
  assert.equal(retryModeForItem(
    { status:STATUS.PENDING, siStatus:SI_STATUS.PENDING },
    { retryOnly:true, includeSupplements:true, retryScope:'main_failed' },
  ), 'main');
});

test('main-only 與 main_failed retry 不隨主文流程發出 SI discovery', () => {
  assert.equal(shouldCollectSupplementsWithMain({ includeSupplements:false, retryOnly:false }), false);
  assert.equal(shouldCollectSupplementsWithMain({
    includeSupplements:true, retryOnly:true, retryScope:'main_failed',
  }), false);
  assert.equal(shouldCollectSupplementsWithMain({
    includeSupplements:true, retryOnly:true, retryScope:'all_failed',
    item:{ siStatus:SI_STATUS.DOWNLOAD_FAILED },
  }), true);
  assert.equal(shouldCollectSupplementsWithMain({
    includeSupplements:true, retryOnly:true, retryScope:'all_failed',
    item:{ siStatus:SI_STATUS.COLLECTED },
  }), false);
  assert.equal(shouldCollectSupplementsWithMain({ includeSupplements:true, retryOnly:false }), true);

  const oldJobItem = {
    status:STATUS.PUBLISHER_BLOCKED,
    siStatus:SI_STATUS.COLLECTED,
    siFiles:[{ fileName:'existing-si.pdf', sha256:'keep-me' }],
  };
  const before = structuredClone(oldJobItem);
  assert.equal(retryModeForItem(oldJobItem, {
    retryOnly:true, includeSupplements:true, retryScope:'main_failed',
  }), 'main');
  assert.deepEqual(oldJobItem, before);
});

test('SI 403 依候選證據分級，不把猜測網址誤報成已確認 SI', () => {
  const probeBlocked = supplementFailureOutcome({
    selected:[{ url:'https://publisher.example/guessed-si.pdf', evidence:'probe' }],
    attempts:[{ url:'https://publisher.example/guessed-si.pdf', evidence:'probe', ok:false, status:STATUS.PUBLISHER_BLOCKED }],
  });
  assert.equal(probeBlocked.status, SI_STATUS.DISCOVERY_BLOCKED);
  assert.doesNotMatch(probeBlocked.message, /已發現|已確認/);
  assert.deepEqual(probeBlocked.manualLinks, []);

  const confirmedBlocked = supplementFailureOutcome({
    selected:[{ url:'https://publisher.example/confirmed-si.pdf', evidence:'confirmed' }],
    attempts:[{ url:'https://publisher.example/confirmed-si.pdf', evidence:'confirmed', ok:false, status:STATUS.PUBLISHER_BLOCKED }],
  });
  assert.equal(confirmedBlocked.status, SI_STATUS.MANUAL_REQUIRED);
  assert.match(confirmedBlocked.message, /已確認/);
  assert.ok(confirmedBlocked.manualLinks.includes('https://publisher.example/confirmed-si.pdf'));
  assert.equal(shouldStopSupplementHost({ ok:false, status:STATUS.PUBLISHER_BLOCKED }), true);
  assert.equal(shouldStopSupplementHost({ ok:false, status:STATUS.INVALID_PDF }), false);

  const inaccessibleLanding = supplementFailureOutcome({
    landingAttempts:[{ url:'https://publisher.example/article', ok:false, status:STATUS.PUBLISHER_BLOCKED }],
  });
  assert.equal(inaccessibleLanding.status, SI_STATUS.DISCOVERY_BLOCKED);
  assert.match(inaccessibleLanding.message, /無法確認/);
});

test('主文成功狀態不把未知版權來源誤標 OA，API 權限問題可輸出申請項目', () => {
  assert.equal(mainSuccessStatus({ access:'oa' }, { connected:false }), STATUS.READY_OA);
  assert.equal(mainSuccessStatus({ access:'publisher' }, { connected:true }), STATUS.READY_VPN);
  assert.equal(mainSuccessStatus({ access:'unknown' }, { connected:false }), STATUS.READY_OTHER);
  const requirements = apiAccessRequirements([
    { source:'Elsevier Article API', status:STATUS.API_PERMISSION_REQUIRED },
    { source:'Wiley TDM API', status:STATUS.API_PERMISSION_REQUIRED },
  ]);
  assert.equal(requirements.issues.length, 2);
  assert.ok(requirements.entitlements.some((value) => /Elsevier.*Article Retrieval/i.test(value)));
  assert.ok(requirements.entitlements.some((value) => /Wiley.*SI/i.test(value)));
});

test('全部只選實際 ref，不以異常最大值展開工作', () => {
  assert.deepEqual(selectReferenceNumbers('全部', [{refNumber:1},{refNumber:2},{refNumber:2025}]), [1, 2, 2025]);
  assert.deepEqual(selectReferenceNumbers('1-2', [{refNumber:1},{refNumber:2},{refNumber:2025}]), [1, 2]);
});

test('1-187 與全部都只選出實際 187 筆', () => {
  const references = Array.from({ length:187 }, (_, index) => ({ refNumber:index + 1 }));
  assert.equal(selectReferenceNumbers('1-187', references).length, 187);
  assert.equal(selectReferenceNumbers('全部', references).length, 187);
});
