const $ = (selector) => document.querySelector(selector);
let source = null;
let jobId = null;
let pollTimer = null;

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
  return body;
}

function toast(message) {
  const node = $('#toast'); node.textContent = message; node.classList.remove('hidden');
  setTimeout(() => node.classList.add('hidden'), 3500);
}

function busy(button, active, text) {
  if (active) { button.dataset.label = button.textContent; button.textContent = text; button.disabled = true; }
  else { button.textContent = button.dataset.label || button.textContent; button.disabled = false; }
}

async function loadSettings() {
  const settings = await api('/api/settings');
  $('#email').value = settings.email || '';
}

function apiStatusLabel(status) {
  return ({
    available: '可用', configured: '已設定／待檢查', missing: '缺少', invalid: '不可用',
    unavailable: '連線失敗', permission_required: '需開通全文權限', configured_unverified: '已設定／權限待驗證',
    anonymous: '匿名模式', unknown: '未知',
  })[status] || status;
}

function renderApiServices(data) {
  const services = data.services || [];
  const grid = $('#api-grid');
  grid.replaceChildren();
  const available = services.filter((service) => service.status === 'available').length;
  const needsAttention = services.filter((service) => ['missing', 'invalid', 'unavailable', 'permission_required'].includes(service.status)).length;
  $('#api-summary').textContent = `可用 ${available}/${services.length}；需要處理 ${needsAttention} 項。設定檔：${data.envFile || '.env'}`;
  for (const service of services) {
    const card = document.createElement('article');
    card.className = `api-service api-${service.status}`;
    const vars = [...(service.envVars || []), ...(service.optionalEnvVars || []).map((name) => `${name}（選用）`)];
    const capabilityText = service.id === 'elsevier' && service.capabilities
      ? [
          `Metadata ${service.capabilities.metadata ? '✓' : '✗'}`,
          `FULL view ${service.capabilities.fullView ? '✓' : '✗'}`,
          `Entitlement API ${service.capabilities.entitlementApi ? '✓' : '✗'}`,
          `PDF MIME ${service.capabilities.pdfMime ? '✓' : '✗'}`,
          `機構 IP／InstToken ${service.capabilities.institutionAuthenticated ? '✓' : '未成立'}`,
        ].join(' · ')
      : '';
    card.innerHTML = `
      <div class="api-service-head"><strong>${escapeHtml(service.name)}</strong><span class="api-badge">${escapeHtml(apiStatusLabel(service.status))}</span></div>
      <p>${escapeHtml(service.purpose)}</p>
      <p class="api-message">${escapeHtml(service.message || '')}</p>
      ${capabilityText ? `<p class="api-capabilities">${escapeHtml(capabilityText)}</p>` : ''}
      ${vars.length ? `<code>${escapeHtml(vars.join(' · '))}</code>` : '<code>不需要 API key</code>'}
      <a href="${escapeHtml(service.applyUrl)}" target="_blank" rel="noreferrer">申請／官方說明</a>`;
    grid.append(card);
  }
}

async function loadApiServices(check = false) {
  const button = $('#refresh-apis');
  if (check) busy(button, true, '檢查中…');
  try {
    const data = await api(check ? '/api/services/check' : '/api/services', check ? { method:'POST' } : {});
    renderApiServices(data);
  } catch (error) {
    $('#api-summary').textContent = `API 狀態讀取失敗：${error.message}`;
  } finally {
    if (check) busy(button, false);
  }
}

async function loadRecentJobs() {
  const jobs = await api('/api/jobs');
  const select = $('#recent-job');
  select.replaceChildren();
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = jobs.length ? '請選擇工作' : '尚無工作';
  select.append(empty);
  for (const job of jobs) {
    const option = document.createElement('option');
    option.value = job.id;
    const summary = job.summary || {};
    const time = new Date(job.updatedAt || job.createdAt).toLocaleString('zh-TW');
    option.textContent = `${time} · ${job.id} · ${summary.collected || 0}/${summary.selected || 0}`;
    select.append(option);
  }
  $('#open-job').disabled = true;
}

async function refreshVpn() {
  const panel = $('#vpn-panel');
  panel.innerHTML = '<span class="dot neutral"></span><strong>正在檢查 VPN…</strong>';
  try {
    const vpn = await api('/api/network');
    if (vpn.connected) panel.innerHTML = `<span class="dot good"></span><div><strong>VPN 已連線</strong><div class="hint">校內 IP ${vpn.campusAddress} · ${vpn.interfaceName}</div></div>`;
    else panel.innerHTML = `<span class="dot bad"></span><div><strong>未偵測到校內 IP</strong><div class="hint">${vpn.f5Installed ? '已找到 F5 服務，但目前路由不是 140.122.*' : '未找到 F5 服務'} </div></div>`;
  } catch (error) { panel.textContent = error.message; }
}

document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((tab) => { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-selected', String(tab === button)); });
  const tab = button.dataset.tab;
  $('#input-type').value = tab;
  $('#upload-pane').classList.toggle('hidden', tab !== 'upload');
  $('#url-pane').classList.toggle('hidden', tab !== 'url');
}));

$('#pdf').addEventListener('change', (event) => { $('#file-name').textContent = event.target.files[0]?.name || '最大 100 MB'; });
$('#save-settings').addEventListener('click', async () => {
  try { await api('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ email:$('#email').value }) }); toast('聯絡 email 已保存在本機設定'); await loadApiServices(true); }
  catch (error) { toast(error.message); }
});
$('#refresh-apis').addEventListener('click', () => loadApiServices(true));
$('#refresh-vpn').addEventListener('click', refreshVpn);
$('#recent-job').addEventListener('change', () => { $('#open-job').disabled = !$('#recent-job').value; });
$('#open-job').addEventListener('click', async () => {
  const id = $('#recent-job').value;
  if (!id) return;
  try {
    const job = await api(`/api/jobs/${id}`);
    jobId = job.id;
    $('#job-section').classList.remove('hidden');
    renderJob(job);
    if (!['completed','failed','interrupted'].includes(job.state)) startPolling();
    $('#job-section').scrollIntoView({ behavior:'smooth' });
  } catch (error) { toast(error.message); }
});

$('#source-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#analyze-source');
  const message = $('#source-message');
  busy(button, true, '正在解析…'); message.classList.add('hidden');
  try {
    const form = new FormData(event.currentTarget);
    source = await api('/api/sources', { method:'POST', body:form });
    renderSource(source);
    message.classList.add('hidden');
  } catch (error) { message.textContent = error.message; message.classList.remove('hidden'); }
  finally { busy(button, false); }
});

function renderSource(data) {
  $('#references-section').classList.remove('hidden');
  $('#ref-count').textContent = `${data.references.length} 筆`;
  const meta = data.metadata || {};
  $('#paper-meta').innerHTML = `<strong>${escapeHtml(meta.title || meta.pdfTitle || '未取得標題')}</strong><span>${escapeHtml([meta.authors?.join(', '), meta.journal, meta.year, meta.doi && `DOI: ${meta.doi}`].filter(Boolean).join(' · '))}</span>`;
  const list = $('#reference-list'); list.replaceChildren();
  for (const ref of data.references) {
    const li = document.createElement('li'); li.value = ref.refNumber; li.textContent = `${ref.rawCitation || '（來源缺少文字）'}${ref.doi ? ` — DOI: ${ref.doi}` : ''}`; list.append(li);
  }
  $('#references-section').scrollIntoView({ behavior:'smooth', block:'start' });
}

$('#start-job').addEventListener('click', async () => {
  if (!source) return;
  const button = $('#start-job'); busy(button, true, '建立工作…');
  try {
    const job = await api('/api/jobs', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({
      sourceId:source.id, refSpec:$('#ref-spec').value, retrievalMode:$('#retrieval-mode').value,
    }) });
    jobId = job.id; $('#job-section').classList.remove('hidden'); renderJob(job); startPolling(); await loadRecentJobs(); $('#job-section').scrollIntoView({ behavior:'smooth' });
  } catch (error) { toast(error.message); }
  finally { busy(button, false); }
});
$('#retrieval-mode').addEventListener('change', () => {
  $('#start-job').textContent = $('#retrieval-mode').value === 'main_and_si' ? '開始蒐集主文＋SI' : '開始蒐集主文';
});

function escapeHtml(value) { const div=document.createElement('div'); div.textContent=String(value??''); return div.innerHTML; }
function successful(status) { return ['已取得_OA', '已取得_VPN', '已取得_來源未判定OA'].includes(status); }

function renderJob(job) {
  const summary = job.summary || { selected:job.items.length, collected:0, locked:job.items.length };
  $('#job-state').textContent = job.state === 'completed'
    ? (summary.allCollected ? '全部蒐集到' : '蒐集完成')
    : job.state === 'failed'
      ? '工作失敗，可重試'
      : job.state === 'interrupted'
        ? '工作中斷，可重試'
        : '蒐集中';
  $('#job-message').textContent = job.message || '';
  $('#stat-selected').textContent = summary.selected;
  $('#stat-collected').textContent = summary.collected;
  $('#stat-locked').textContent = summary.locked;
  $('#stat-si-refs').textContent = summary.siRefsCollected || 0;
  $('#stat-si-files').textContent = summary.siFilesCollected || 0;
  $('#stat-si-failed').textContent = summary.siFailedRefs || 0;
  $('#progress-bar').style.width = `${summary.selected ? Math.round((job.items.filter((item) => item.finishedAt || successful(item.status)).length / summary.selected) * 100) : 0}%`;
  const body = $('#result-body'); body.replaceChildren();
  for (const item of job.items) {
    const row = document.createElement('tr');
    const statusClass = successful(item.status) ? 'ok' : 'blocked';
    const siText = item.siStatus === '已取得SI' ? `${item.siStatus} (${item.siFiles?.length || 0})` : (item.siStatus || '未要求');
    const evidence = [
      item.documentVersion && `版本：${item.documentVersion}`,
      item.failureCode && `Failure code：${item.failureCode}`,
      item.nextAction,
    ].filter(Boolean).join(' · ');
    row.innerHTML = `<td>${item.refNumber}</td><td><span class="status ${statusClass}">${escapeHtml(item.status)}</span></td><td>${escapeHtml(siText)}</td><td>${item.doi ? `<a href="https://doi.org/${encodeURIComponent(item.doi)}" target="_blank" rel="noreferrer">${escapeHtml(item.doi)}</a>` : '—'}</td><td>${escapeHtml(item.sourceProvider || '—')}</td><td>${escapeHtml([[item.message, item.siMessage].filter(Boolean).join(' SI：'), evidence].filter(Boolean).join(' — '))}</td>`;
    if (item.siManualLinks?.length) {
      const links = document.createElement('div');
      links.className = 'manual-si-links';
      item.siManualLinks.forEach((url, index) => {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.target = '_blank';
        anchor.rel = 'noreferrer';
        anchor.textContent = `在瀏覽器開啟 SI 候選 ${index + 1}`;
        links.append(anchor);
      });
      row.cells[5].append(links);
    }
    if (job.includeSupplements && ['completed','failed','interrupted'].includes(job.state) && (item.siFiles?.length || 0) < 2 && item.doi) {
      const controls = document.createElement('div');
      controls.className = 'manual-si-upload';
      const input = document.createElement('input');
      input.type = 'file';
        input.accept = '.pdf,.docx,.doc,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword';
      input.className = 'hidden';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = '上傳已下載 SI';
      button.addEventListener('click', () => input.click());
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        button.disabled = true;
        button.textContent = '驗證並上傳中…';
        try {
          const form = new FormData();
          form.append('supplement', file);
          const updated = await api(`/api/jobs/${job.id}/items/${item.refNumber}/supplements`, { method:'POST', body:form });
          renderJob(updated);
          toast(`ref ${item.refNumber} SI 已通過驗證並保存`);
        } catch (error) {
          toast(error.message);
          button.disabled = false;
          button.textContent = '上傳已下載 SI';
        }
      });
      controls.append(button, input);
      row.cells[5].append(controls);
    }
    if (['completed','failed','interrupted'].includes(job.state) && !successful(item.status) && item.doi) {
      const controls = document.createElement('div');
      controls.className = 'browser-fallback-controls';
      const loginButton = document.createElement('button');
      loginButton.type = 'button';
      loginButton.className = 'secondary';
      loginButton.textContent = '開啟專用登入瀏覽器';
      loginButton.addEventListener('click', async () => {
        loginButton.disabled = true;
        try {
          await api('/api/browser/open', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({ url:`https://doi.org/${item.doi}` }),
          });
          toast('已開啟專用 profile；請完成合法的機構／出版社登入');
        } catch (error) {
          toast(error.message);
        } finally {
          loginButton.disabled = false;
        }
      });
      const retryButton = document.createElement('button');
      retryButton.type = 'button';
      retryButton.className = 'secondary';
      retryButton.textContent = '用已登入 profile 重試主文';
      retryButton.addEventListener('click', async () => {
        retryButton.disabled = true;
        try {
          const updated = await api(`/api/jobs/${job.id}/items/${item.refNumber}/browser-retry`, {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:'{}',
          });
          renderJob(updated);
        } catch (error) {
          toast(error.message);
        } finally {
          retryButton.disabled = false;
        }
      });
      controls.append(loginButton, retryButton);
      row.cells[5].append(controls);
    }
    if (item.missingApis?.length) {
      const hint = document.createElement('div');
      hint.className = 'missing-api-hint';
      hint.textContent = `建議設定：${item.missingApis.join('、')}`;
      row.cells[5].append(hint);
    }
    body.append(row);
  }
  const completed = job.state === 'completed';
  const retryableState = ['completed','failed','interrupted'].includes(job.state) && !job.processActive;
  for (const [selector, href] of [['#download-zip',`/api/jobs/${job.id}/archive`],['#download-report',`/api/jobs/${job.id}/report.csv`]]) {
    const link=$(selector); link.href=href; link.classList.toggle('disabled',!completed); link.setAttribute('aria-disabled',String(!completed));
  }
  $('#retry-job').disabled = !retryableState || summary.locked === 0;
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!jobId) return;
    try { const job=await api(`/api/jobs/${jobId}`); renderJob(job); if (['completed','failed','interrupted'].includes(job.state)) clearInterval(pollTimer); }
    catch (error) { clearInterval(pollTimer); toast(error.message); }
  },1000);
}

$('#retry-job').addEventListener('click', async () => {
  try {
    await refreshVpn();
    const job=await api(`/api/jobs/${jobId}/retry`,{
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ scope:'main_failed' }),
    });
    renderJob(job); startPolling();
  }
  catch(error){ toast(error.message); }
});
$('#delete-job').addEventListener('click', async () => {
  if (!jobId || !confirm('確定刪除這個工作、已下載 PDF 與報告？')) return;
  try { await api(`/api/jobs/${jobId}`,{method:'DELETE'}); clearInterval(pollTimer); jobId=null; $('#job-section').classList.add('hidden'); await loadRecentJobs(); toast('工作已刪除'); }
  catch(error){ toast(error.message); }
});
$('#clear-cache').addEventListener('click', async () => {
  if (!confirm('清除共用 PDF 快取？既有工作的 PDF 不受影響。')) return;
  try { await api('/api/cache',{method:'DELETE'}); toast('快取已清除'); } catch(error){ toast(error.message); }
});

await Promise.all([loadSettings(),refreshVpn(),loadRecentJobs(),loadApiServices(true)]);
